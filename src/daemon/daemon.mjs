// The orchestrator daemon core: home scaffold, single-instance lock,
// instance config with live edit pickup, instance ledger, control inbox,
// and the run engine that owns every open run.
import { watch, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { openEscapesStore, openInstanceStore, resolveClosedRun } from '../telemetry/stores.mjs';
import { openWorkspaceLeftovers } from '../telemetry/readers.mjs';
import { markEscapeFixed as appendFixedMark, readEscapeSet } from '../telemetry/escapes.mjs';
import { settleBreachOf } from '../telemetry/breaches.mjs';
import { loadInstanceConfig, INSTANCE_CONFIG_FILE } from '../config/instance.mjs';
import { RunEngine } from '../engine/engine.mjs';
import { ModelSemaphores } from '../seats/semaphore.mjs';
import { RunIsolation } from '../isolation/isolation.mjs';
import { readEvents } from '../ledger/ledger.mjs';
import { checkAnswer } from '../ledger/parks.mjs';
import { ACK_OPTION, standingAcksFor } from '../ledger/acks.mjs';
import {
  cloneDir,
  ensureBareClone,
  hasBranch,
  hasCommit,
  readBlobFromBranch,
} from '../isolation/clones.mjs';
import { parseProjectConfig } from '../config/project.mjs';
import { parseIntentCard } from '../lanes/card.mjs';
import { readInheritance, closeState } from '../lanes/resume.mjs';
import { FrontierLauncher } from '../frontier/autolaunch.mjs';
import { launchEscape } from '../frontier/repairs.mjs';
import { readGraphSource } from '../frontier/source.mjs';
import { TripwireWatcher } from '../tripwires/watcher.mjs';
import { EvalScheduler } from '../eval/review.mjs';
import { Notifier } from './notifier.mjs';
import { checkSeatEnvironment } from './environment.mjs';
import { scaffoldHome, homePaths, runLedgerPath } from './home.mjs';
import { acquireLock } from './lock.mjs';

const ACTOR = 'daemon';
const CONFIG_DEBOUNCE_MS = 150; // collapses editor multi-writes; not a detector
// The period of the orphan-workspace sweep. Low by design: it exists so a
// leftover clears without a restart, and nothing in the harness waits on it
// (ADR-0004). Every tick that finds nothing writes nothing.
const WORKSPACE_SWEEP_MS = 15 * 60 * 1000;
// The events that bound one instance's life. A tail that is not a clean stop
// is a death nothing recorded.
const LIFECYCLE_EVENTS = new Set(['daemon-started', 'daemon-stopped']);
// The signals that mean this daemon: a console interrupt at its own console, a
// service manager's stop, a console going away under it. SIGHUP is Windows's
// console-close and needs a handler of its own, because unhandled it kills the
// process with nothing written.
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// Windows delivers a console control event to a whole process group and says
// nothing about which member it was meant for, so a break aimed at a seat
// arrives here as well. Unhandled it is fatal; handled and ignored it is what
// it should always have been — somebody else's business. The daemon's own stop
// is the control inbox, and SIGINT still works at its console.
const IGNORED_SIGNALS = ['SIGBREAK'];
const EXIT_SIGNALS = [...STOP_SIGNALS, ...IGNORED_SIGNALS];
const FAULT_MAX = 600; // a stamp carries the head of a stack, not the stack
// How often one control file is read before the intake judges it, and the
// pause between those reads. Two reads and 50 ms: a file caught mid-write is
// whole by the second read, and a file that is really corrupt is refused
// while the console that wrote it is still watching. Not a detector — the
// verdict comes from the read, never from the wait running out.
const CONTROL_READS = 2;
const CONTROL_REREAD_MS = 50;

export class Daemon {
  /**
   * @param {string} home
   * @param {{handleSignals?: boolean, lanes?: Record<string, object>,
   *   composeRunner?: Function, evalSeatDefaults?: () => object,
   *   workspaceSweepMs?: number,
   *   notifierTransport?: {fetchImpl?: Function, spawnImpl?: Function}}} opts
   *   lanes: lane name → {stages, handlers}, registered on the run engine at
   *   start; `lanes/assemble.mjs` builds the graph the daemon binary passes,
   *   and a fixture graph substitutes it in tests. composeRunner
   *   substitutes the compose child process (tests only); evalSeatDefaults
   *   substitutes the eval seat's dispatch defaults (tests only);
   *   workspaceSweepMs shortens the orphan-sweep period (tests only);
   *   notifierTransport substitutes the push transport (tests only).
   */
  constructor(
    home,
    {
      handleSignals = false,
      lanes = {},
      composeRunner,
      evalSeatDefaults,
      workspaceSweepMs = WORKSPACE_SWEEP_MS,
      notifierTransport,
    } = {},
  ) {
    this.paths = homePaths(home);
    this.handleSignals = handleSignals;
    this.lanes = lanes;
    this.composeRunner = composeRunner;
    this.evalSeatDefaults = evalSeatDefaults;
    this.workspaceSweepMs = workspaceSweepMs;
    this.notifierTransport = notifierTransport;
    this.running = false;
    this.config = null;
    this.lock = null;
    this.ledger = null;
    this.engine = null;
    this.semaphores = null;
    this.isolation = null;
    this.frontier = null;
    this.tripwires = null;
    this.evals = null;
    this.notifier = null;
    this.pendingTeardowns = new Set();
    // The run ids a release holds and the run ids a provision holds. Both keep
    // the periodic sweep off a workspace somebody else is already working on:
    // a second delete of one tree reports the first one's failures, and a
    // workspace whose run has not reached the engine yet is not an orphan.
    this.releasing = new Set();
    this.provisioning = new Set();
    this.launchCounter = 0;
    this.watchers = [];
    this.commands = new Map();
    this.configTimer = null;
    this.sweepTimer = null;
    this.sweeping = false;
    this.stopPromise = null;
    this.stopStamped = false;
    this.signalHandler = null;
    this.exitHandler = null;
    this.faultHandler = null;
    this.onStopped = null;
    this.registerCommand('stop', async (command) => {
      await this.stop({ trigger: 'control', actor: command.actor });
    });
    // An answer targets a run park (runId) or an instance park (seq).
    this.registerCommand('answer', async (command) => {
      if (command.runId !== undefined) {
        // An `ack` answer records its acknowledgments before the run resumes
        // on it: the run's next step reads the standing set, and the acks
        // outlive the run either way.
        this.recordAcks(command);
        this.engine.answer({
          runId: command.runId,
          actor: command.actor,
          answer: command.answer,
          option: command.option,
        });
      } else {
        this.answerInstancePark(command);
      }
      this.frontier.queueSweepAll();
    });
    // A revoke ends one standing acknowledgment: the fingerprint it names and
    // no other. An unsolved harness defect stays acknowledged while its
    // neighbour is fixed, so nothing here clears a set (ADR-0032).
    this.registerCommand('revoke', async (command) => {
      this.revokeAck(command);
    });
    this.registerCommand('kill', async (command) => {
      this.engine.killRun(command.runId, { actor: command.actor });
    });
    this.registerCommand('arm', async (command) => {
      this.frontier.setArmed(command.project, true, command.actor);
    });
    this.registerCommand('pause', async (command) => {
      this.frontier.setArmed(command.project, false, command.actor);
    });
    this.registerCommand('launch', async (command) => {
      await this.launchCommand(command);
      this.frontier.queueSweepAll();
    });
    // An escape somebody fixed outside the factory. The mark ends the escape
    // the way a repair run's close-out does, and the sweep that follows it
    // retires the owed repair and the loud item that named it (ADR-0024).
    this.registerCommand('fixed', async (command) => {
      this.markEscapeFixed(command);
      this.frontier.queueSweepAll();
    });
    // A resolve targets a loud item: an open run (through the engine, with
    // liveness recovery), a closed run's ledger, or the instance ledger.
    this.registerCommand('resolve', async (command) => {
      const { actor, runId, seq, note } = command;
      if (!Number.isInteger(seq)) throw new Error('resolve requires an integer seq');
      if (runId !== undefined) {
        if (this.engine.runs.has(runId)) {
          this.engine.resolve({ runId, actor, resolves: seq, note });
        } else {
          resolveClosedRun(this.paths, runId, {
            actor,
            resolves: seq,
            ...(note !== undefined && { note }),
          });
        }
      } else {
        this.ledger.resolve({ actor, resolves: seq, ...(note !== undefined && { note }) });
      }
      this.frontier.queueSweepAll();
    });
  }

  registerCommand(name, handler) {
    this.commands.set(name, handler);
  }

  async start() {
    if (this.running) throw new Error('daemon already started');
    // The home itself first: the config file and the lock both live in it. The
    // rest of the tree waits for the config, because the config is what says
    // where run workspaces provision.
    mkdirSync(this.paths.home, { recursive: true });
    this.stopStamped = false;
    this.lock = acquireLock(this.paths.lock);
    try {
      this.config = loadInstanceConfig(this.paths.home);
      this.paths = scaffoldHome(this.paths.home, this.config);
      // The stale set is fixed here, before this instance stamps its start and
      // before the first start step that can take time. Whatever waits in the
      // inbox at this moment was written while nothing was reading it. Reading
      // the inbox later instead would sweep a command a console queued against
      // the live daemon: the start still has an orphan-workspace sweep in front
      // of it, and one `git worktree remove` can hold it for half a minute.
      const queuedWhileDown = this.inboxFiles();
      // The watcher and the notifier exist before any store opens with its
      // hook; the hooks read `this.tripwires` and `this.notifier` late so
      // construction order stays simple.
      this.ledger = openInstanceStore(this.paths, {
        onAppend: (line, ledger) => {
          this.tripwires?.notify(line.project, line);
          this.notifier?.notify({ ledger, project: line.project, line });
        },
      });
      this.notifier = new Notifier({
        ledger: this.ledger,
        // Read live, like every other machine-scoped value: a target the
        // operator wires while the daemon runs takes the next event.
        config: () => this.config.notifier,
        ...(this.notifierTransport ?? {}),
      });
      this.isolation = new RunIsolation(this.paths, {
        composeCommand: () => this.config.composeCommand,
        composeRunner: this.composeRunner,
      });
      this.semaphores = new ModelSemaphores(this.config.semaphores);
      this.tripwires = new TripwireWatcher({
        paths: this.paths,
        ledger: this.ledger,
        readRegistry: (project) => this.readTripwireRegistry(project),
        readSource: (project) => this.readGraphSourceFor(project),
      });
      this.evals = new EvalScheduler({
        paths: this.paths,
        ledger: this.ledger,
        semaphores: this.semaphores,
        seatDefaults: this.evalSeatDefaults ?? (() => this.seatDefaults()),
      });
      this.engine = new RunEngine(this.paths, {
        instanceStore: this.ledger,
        getSlotCap: (project) => this.config.projects[project]?.slotCap,
        onClosed: (info) => {
          this.scheduleWorkspaceRelease(info);
          this.frontier.queueSweep(info.project);
          if (info.lane === 'story' && info.state === 'shipped') this.evals.notify();
        },
        onParked: (info) => this.frontier.queueSweep(info.project),
        semaphores: this.semaphores,
        seatDefaults: () => this.seatDefaults(),
        onEvent: (project, line, ledger) => {
          this.tripwires?.notify(project, line);
          this.notifier?.notify({ ledger, project, line });
        },
      });
      for (const [name, lane] of Object.entries(this.lanes)) {
        this.engine.registerLane(name, lane);
      }
      this.frontier = new FrontierLauncher(this);
      this.frontier.replayArming();
      // Before this instance writes anything of its own: whatever the last
      // one left behind is still the tail, and a tail that is not a clean
      // stop is the only trace an unstamped death leaves.
      this.stampCrashIfUnstopped();
      const runsResumed = this.engine.resumeOpenRuns();
      this.ledger.append('daemon-started', {
        actor: ACTOR,
        pid: process.pid,
        runsResumed,
      });
      await this.stampSeatEnvironment();
      await this.sweepOrphanWorkspaces();
      this.archiveStaleControlFiles(queuedWhileDown);
      this.watchConfig();
      this.watchControl();
      this.armWorkspaceSweep();
      if (this.handleSignals) this.installSignalHandlers();
      this.running = true;
      this.frontier.queueSweepAll();
      // One start-time check fires a review owed from before a restart.
      this.evals.notify();
      // The watcher reports changes from its own registration on, and a drain
      // before `running` returns early, so a command that arrived during the
      // start waits for an unrelated write to be noticed. One drain here claims
      // it. Not awaited: a launch command owns a whole provisioning, and the
      // start does not stand behind it.
      this.drainControlInbox().catch(() => {});
      return { runsResumed };
    } catch (error) {
      if (this.engine) {
        await this.engine.stop();
        this.engine = null;
      }
      this.teardown();
      throw error;
    }
  }

  /**
   * Stamps what this host's seat environment is missing: one quiet event per
   * defect, once per instance, right behind the start it belongs to. A clean
   * host stamps nothing, and no finding stops the start — the daemon runs
   * degraded and says so, rather than refusing work over a condition a human
   * may already know about (ADR-0030).
   */
  async stampSeatEnvironment() {
    let findings;
    try {
      findings = await checkSeatEnvironment({ paths: this.paths, config: this.config });
    } catch (error) {
      // The check itself is the only thing that can fail here, and a check
      // that failed is a check nobody ran: say so instead of reading as clean.
      findings = [
        {
          check: 'seat-environment',
          severity: 'degraded',
          reason: 'check-failed',
          gist: `the seat-environment check did not complete: ${error.message}`,
        },
      ];
    }
    for (const finding of findings) {
      this.ledger.append('seat-environment', { actor: ACTOR, ...finding });
    }
  }

  // -- run launch + workspace teardown --------------------------------------

  /**
   * Launches a run with full isolation: fetch the project's bare clone, read
   * project config from the default branch, create the run worktree, bring
   * the per-run stack up, then hand the run to the engine. A provisioning
   * failure leaves nothing behind and no run starts.
   *
   * `resumeFrom` names a prior run whose freeze this launch inherits. Every
   * fact that would otherwise be guessed is settled here, before anything is
   * provisioned: the prior run's own record supplies the card, and the clone
   * must still hold the branch and the frozen commit.
   * @param {{project: string, lane: string, runId?: string, [k: string]: unknown}} opts
   */
  async launchRun({ project, lane, runId, ...payload }) {
    if (!this.running) throw new Error('daemon not running');
    const entry = this.config.projects[project];
    if (!entry) throw new Error(`unknown project: ${project}`);
    if (!this.engine.lanes.has(lane)) throw new Error(`unknown lane: ${lane}`);
    if (!this.engine.hasFreeSlot(project)) throw new Error(`no free slot for project ${project}`);
    const inherit =
      payload.resumeFrom !== undefined ? this.resolveResume(project, lane, payload) : null;
    runId = runId ?? `${project}-${Date.now().toString(36)}-${++this.launchCounter}`;
    // Past this point the run has a name, and every refusal carries it: the
    // rejection stamp names the run that would have existed. The name is also
    // what holds the orphan sweep off the workspace this launch is about to
    // create: until the engine holds the run, nothing else says it is alive.
    this.provisioning.add(runId);
    try {
      if (this.engine.runs.has(runId)) throw new Error(`run ${runId} is already live`);
      if (readEvents(runLedgerPath(this.paths, runId)).length > 0) {
        throw new Error(`run ${runId} already has a ledger`);
      }
      if (inherit) await this.requireFrozenTree(project, entry, inherit);
      const ws = await this.isolation.provision({
        runId,
        project,
        repoUrl: entry.repoUrl,
        defaultBranch: entry.defaultBranch,
        configPath: entry.projectConfigPath,
        ...(inherit && { baseCommit: inherit.frozenSha }),
      });
      // The launch read the config fresh from the default branch; the tripwire
      // registry the watcher evaluates is the registry that just shipped.
      this.tripwires.setRegistry(project, ws.projectConfig.tripwires);
      try {
        this.engine.launch({
          runId,
          project,
          lane,
          worktree: ws.worktree,
          branch: ws.branch,
          baseSha: ws.baseSha,
          defaultBranch: entry.defaultBranch,
          configBlob: ws.configBlob,
          // The lane's budget rides the launch stamp, so the run carries the
          // threshold it was launched under through every resume.
          ...(typeof ws.projectConfig.budgets?.[lane] === 'number' && {
            budget: ws.projectConfig.budgets[lane],
          }),
          ...(ws.stack && { stack: ws.stack.name }),
          ...payload,
        });
      } catch (error) {
        await this.isolation.release(runId, { project }).catch(() => {});
        throw error;
      }
      return { runId, worktree: ws.worktree, baseSha: ws.baseSha, projectConfig: ws.projectConfig };
    } catch (error) {
      if (error instanceof Error) error.runId ??= runId;
      throw error;
    } finally {
      this.provisioning.delete(runId);
    }
  }

  /**
   * Validates a resume and fills the payload from the prior run's own record.
   * The card is never taken from the caller: a resume that inherits one run's
   * freeze while naming another run's card would apply a spec to a story it
   * was not born for.
   */
  resolveResume(project, lane, payload) {
    if (lane !== 'story') {
      throw new Error(`a resume applies to the story lane only (lane: ${lane})`);
    }
    const inherit = readInheritance(this.paths, payload.resumeFrom);
    if (inherit.project !== project) {
      throw new Error(
        `run ${inherit.runId} belongs to project ${inherit.project}, not ${project}`,
      );
    }
    if (payload.card !== undefined && payload.card !== inherit.card) {
      throw new Error(`a resume takes its card from run ${inherit.runId} (${inherit.card})`);
    }
    payload.card = inherit.card;
    if (inherit.storyKey !== null) payload.storyKey = inherit.storyKey;
    return inherit;
  }

  /**
   * The frozen tree must still be in the clone. The branch is what keeps the
   * frozen commit reachable, so a missing branch is a refusal even when the
   * commit still happens to resolve.
   */
  async requireFrozenTree(project, entry, inherit) {
    await this.isolation.withClone(project, async () => {
      const dir = await ensureBareClone(this.paths, project, entry.repoUrl, entry.defaultBranch);
      if (!(await hasBranch(dir, inherit.branch))) {
        throw new Error(
          `the branch of run ${inherit.runId} (${inherit.branch}) is gone from the clone`,
        );
      }
      if (!(await hasCommit(dir, inherit.frozenSha))) {
        throw new Error(
          `the frozen commit of run ${inherit.runId} (${inherit.frozenSha}) is gone from the clone`,
        );
      }
    });
  }

  /**
   * A console launch: `{project, lane?, card?, ticket?, resumeFrom?}`. A
   * story launch reads the card from the clone for its key, so the frontier's
   * run history matches; an unreadable card launches anyway — readiness fails
   * it with evidence. The repair lane's intake ticket is its spec, so lane and ticket
   * must agree: the mismatch is refused here, before any provisioning, rather
   * than at the fix seat of a run that already holds a slot and a workspace.
   * A resume names the run whose freeze it inherits. It belongs to the story
   * lane, and the prior run supplies the card, so both mismatches are refused
   * here as well.
   * A repair launch carries the escape it repairs, from the number the
   * operator named or from the ticket path when an open escape names that
   * file. The payload is the only place the close-out fix-back looks, so the
   * console route stamps the escapes ledger exactly as the sweep's does.
   * @param {{actor: string, project: string, lane?: string, card?: string,
   *   ticket?: string, escape?: number, resumeFrom?: string}} command
   */
  async launchCommand({ actor, project, lane = 'story', card, ticket, escape, resumeFrom }) {
    if (typeof actor !== 'string' || actor.length === 0) throw new Error('launch requires an actor');
    if (resumeFrom !== undefined) {
      if (lane !== 'story') {
        throw new Error(`a resume applies to the story lane only (lane: ${lane})`);
      }
      if (card !== undefined) {
        throw new Error('a resume takes its card from the prior run; name no card');
      }
    }
    let carried = null;
    if (lane === 'repair') {
      if (typeof ticket !== 'string' || ticket.length === 0) {
        throw new Error('a repair launch requires a ticket path');
      }
      carried = launchEscape(this.paths, { ticket, escape });
    } else {
      if (ticket !== undefined) {
        throw new Error(`a ticket applies to the repair lane only (lane: ${lane})`);
      }
      if (escape !== undefined) {
        throw new Error(`an escape applies to the repair lane only (lane: ${lane})`);
      }
    }
    const payload = {};
    if (ticket !== undefined) payload.ticket = ticket;
    if (carried) {
      payload.escapeSeq = carried.seq;
      payload.attribution = carried.attribution;
    }
    if (resumeFrom !== undefined) payload.resumeFrom = resumeFrom;
    if (card !== undefined) {
      payload.card = card;
      const entry = this.config.projects[project];
      if (entry && lane === 'story') {
        try {
          payload.storyKey = await this.isolation.withClone(project, async () => {
            const dir = await ensureBareClone(
              this.paths,
              project,
              entry.repoUrl,
              entry.defaultBranch,
            );
            const { text } = await readBlobFromBranch(dir, entry.defaultBranch, card);
            return parseIntentCard(text).card.key ?? undefined;
          });
          if (payload.storyKey === undefined) delete payload.storyKey;
        } catch {
          delete payload.storyKey;
          // no key: the run still launches; it just matches no card history
        }
      }
    }
    return this.launchRun({ project, lane, ...payload });
  }

  /**
   * Validates and stamps a human answer to an instance-ledger park (a
   * card-invalidated card from a ship-time sweep). Mirrors the engine's
   * run-park validation; the paired `answer` unblocks the card.
   * @param {{actor: string, seq: number, option?: string, answer?: string}} cmd
   */
  answerInstancePark({ actor, seq, option, answer }) {
    if (typeof actor !== 'string' || actor.length === 0) throw new Error('answer requires an actor');
    if (!Number.isInteger(seq)) throw new Error('an instance answer requires the park seq');
    const events = readEvents(this.paths.instanceLedger);
    const target = events.find((e) => e.seq === seq);
    if (!target || target.event !== 'park') {
      throw new Error(`no park at seq ${seq} in the instance ledger`);
    }
    if (events.some((e) => e.event === 'answer' && e.parkSeq === seq)) {
      throw new Error(`park at seq ${seq} is already answered`);
    }
    checkAnswer(target, { option, answer });
    this.ledger.append('answer', {
      actor,
      parkSeq: seq,
      ...(option !== undefined && { option }),
      ...(answer !== undefined && { answer }),
      ...(target.card !== undefined && { card: target.card }),
    });
  }

  /**
   * Records that an escape was fixed outside the factory: a merge nobody ran
   * through the harness, a defect that turned out to be gone. The mark is its
   * own event, so no reader takes an operator's statement for a repair run's
   * fix-back, and the evidence is required — a mark with nothing behind it
   * retires a defect on somebody's memory. The breach the escape belonged to
   * settles with it, exactly as it does behind a shipped repair (ADR-0024).
   * @param {{actor: string, escape: number, evidence: string, note?: string}} cmd
   */
  markEscapeFixed({ actor, escape, evidence, note }) {
    if (typeof actor !== 'string' || actor.length === 0) {
      throw new Error('a fixed-mark requires an actor');
    }
    if (!Number.isInteger(escape)) {
      throw new Error('a fixed-mark names the escape seq it closes (--escape)');
    }
    if (typeof evidence !== 'string' || evidence.trim().length === 0) {
      throw new Error('a fixed-mark carries the evidence it stands on (--evidence)');
    }
    const store = openEscapesStore(this.paths);
    let line;
    try {
      line = appendFixedMark(store, {
        actor,
        fixes: escape,
        evidence,
        ...(note !== undefined && { note }),
      });
    } finally {
      store.close();
    }
    const entry = readEscapeSet(this.paths.escapesLedger).find((e) => e.seq === escape);
    if (entry) settleBreachOf(this.paths, entry);
    return line;
  }

  // -- finding acknowledgments (ADR-0032) -----------------------------------

  /**
   * Records the standing acknowledgments an `ack` answer buys, from the park
   * record and from nothing else. A park that does not offer the option is
   * refused by the engine, in the one refusal that quotes the forms, and
   * nothing is written on the way there.
   * @param {{runId: string, actor: string, option?: string}} cmd
   */
  recordAcks({ runId, actor, option }) {
    if (option !== ACK_OPTION) return;
    const run = this.engine.runs.get(runId);
    const record = run?.parked ? run.parkRecord : null;
    if (!record?.answers?.options?.includes(ACK_OPTION) || !Array.isArray(record.acks)) return;
    for (const ack of record.acks) {
      this.ledger.append('finding-ack', {
        actor,
        project: run.project,
        fingerprint: ack.fingerprint,
        class: ack.class,
        summary: ack.summary,
        runId,
        parkSeq: record.seq,
      });
    }
  }

  /**
   * Ends one standing acknowledgment. The fingerprint says which, and the fix
   * says what the revoke stands on — a harness commit, a PR, the repair that
   * armed. Every other ack keeps standing: an unsolved harness defect is
   * unsolved whatever was fixed beside it.
   * @param {{actor: string, project: string, fingerprint: string, fix: string,
   *   note?: string}} cmd
   */
  revokeAck({ actor, project, fingerprint, fix, note }) {
    if (typeof actor !== 'string' || actor.length === 0) throw new Error('a revoke requires an actor');
    if (typeof project !== 'string' || project.length === 0) {
      throw new Error('a revoke requires the project the acknowledgment is scoped to');
    }
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
      throw new Error('a revoke names the one fingerprint it ends');
    }
    if (typeof fix !== 'string' || fix.length === 0) {
      throw new Error('a revoke carries the fix it stands on (--fix)');
    }
    const standing = standingAcksFor(this.paths, project);
    const ack = standing.get(fingerprint);
    if (!ack) {
      throw new Error(
        `no acknowledgment stands for ${fingerprint} in ${project}` +
          (standing.size > 0 ? ` — standing: ${[...standing.keys()].join(', ')}` : ''),
      );
    }
    return this.ledger.append('finding-ack-revoked', {
      actor,
      project,
      fingerprint,
      fix,
      ackSeq: ack.seq,
      ...(note !== undefined && { note }),
    });
  }

  // -- tripwire watcher reads ------------------------------------------------

  /**
   * The watcher's registry fallback between launches: read the project
   * config from the bare clone as it stands, without fetching — the observer
   * never advances the clone. No clone yet = no launch happened = throws,
   * and the watcher retries on the next matching append.
   */
  async readTripwireRegistry(project) {
    const entry = this.config.projects[project];
    if (!entry) return [];
    return this.isolation.withClone(project, async () => {
      const dir = cloneDir(this.paths, project);
      const { text } = await readBlobFromBranch(dir, entry.defaultBranch, entry.projectConfigPath);
      const source = `${entry.defaultBranch}:${entry.projectConfigPath}`;
      return parseProjectConfig(text, source).tripwires;
    });
  }

  /** The width metric's graph source, read from the clone without fetching. */
  async readGraphSourceFor(project) {
    const entry = this.config.projects[project];
    if (!entry) return null;
    return this.isolation.withClone(project, () =>
      readGraphSource(this.paths, project, entry, { fetch: false }),
    );
  }

  /**
   * Tears a closed run's workspace down and stamps the outcome. Async.
   * A run that did not ship keeps its branch: nothing of it reached the
   * remote, so that branch is the only copy of whatever it derived, and a
   * later launch can inherit its freeze.
   */
  scheduleWorkspaceRelease({ runId, project, state }) {
    const task = this.releaseWorkspace(runId, { project, keepBranch: state !== 'shipped' })
      .catch(() => {})
      .finally(() => {
        this.pendingTeardowns.delete(task);
      });
    this.pendingTeardowns.add(task);
  }

  async releaseWorkspace(runId, { project, orphan = false, keepBranch = false } = {}) {
    // One release per run at a time. The close-time teardown and a sweep tick
    // can name the same workspace, and the second delete of one tree reports
    // the first one's work as its own failure.
    if (this.releasing.has(runId)) return;
    this.releasing.add(runId);
    let released = null;
    let errors;
    try {
      released = await this.isolation.release(runId, { project, keepBranch });
      errors = released.errors;
    } catch (error) {
      // The release collects the errors of its own steps, so a throw is the
      // release failing as a whole — and it says nothing about what is on disk.
      errors = [error.message];
    } finally {
      this.releasing.delete(runId);
    }
    const swept = released?.swept;
    this.ledger.append('workspace-released', {
      actor: ACTOR,
      runId,
      ok: errors.length === 0,
      ...(orphan && { orphan }),
      ...(keepBranch && { keptBranch: true }),
      // What the release had to end before it could delete anything. Silent
      // when the workspace held nothing, which is the ordinary case.
      ...(swept?.count > 0 && { swept: { count: swept.count, names: swept.names } }),
      ...(released?.leftover && { leftover: released.leftover }),
      ...(errors.length > 0 && { errors }),
    });
    if (released === null) return;
    if (released.leftover !== null) this.recordWorkspaceLeftover(runId, released.leftover, errors);
    else this.settleWorkspaceLeftover(runId);
  }

  /**
   * Records a workspace the release could not delete, and never fails its
   * caller. The run is over and it closed as it closed; a directory nothing
   * would delete is housekeeping the harness owes itself, so the record is
   * quiet and the daemon carries on (ADR-0004). One open record per run: a
   * sweep that tries again and is blocked again reports the same directory.
   */
  recordWorkspaceLeftover(runId, path, errors) {
    try {
      if (openWorkspaceLeftovers(this.paths).has(runId)) return;
      this.ledger.append('workspace-leftover', {
        actor: ACTOR,
        runId,
        path,
        reason: errors.join('; '),
      });
    } catch {
      // A record of a directory is never worth a second failure.
    }
  }

  /** Answers the open leftover record of a run whose workspace is now gone. */
  settleWorkspaceLeftover(runId) {
    try {
      const open = openWorkspaceLeftovers(this.paths).get(runId);
      if (open) this.ledger.resolve({ actor: ACTOR, resolves: open.seq, runId, path: open.path });
    } catch {
      // The workspace is gone. No bookkeeping behind that brings it back.
    }
  }

  /**
   * Releases workspaces whose run is not open — a daemon that died between
   * run close and teardown leaves these behind — and retries every leftover a
   * release could not delete. Runs at start and on the periodic timer.
   *
   * A run that is provisioning owns its workspace as much as an open run does:
   * its directory exists before the engine holds the run, and a sweep that
   * read it as an orphan would delete a live checkout.
   */
  async sweepOrphanWorkspaces() {
    const open = new Set([...this.engine.runs.keys(), ...this.provisioning]);
    const ids = new Set(this.isolation.orphanRunIds(open));
    // A recorded leftover is swept whether or not its directory is still
    // there. One somebody deleted by hand leaves a record that only a release
    // answers, and a release of a workspace that is gone is the answer.
    for (const runId of openWorkspaceLeftovers(this.paths).keys()) {
      if (!open.has(runId)) ids.add(runId);
    }
    for (const runId of ids) {
      // Same branch rule as a normal close; a workspace with no ledger at all
      // reads as not shipped, which is the safe side of the guess.
      await this.releaseWorkspace(runId, {
        orphan: true,
        keepBranch: closeState(this.paths, runId) !== 'shipped',
      });
    }
  }

  /**
   * Arms the periodic orphan sweep. A leftover is a retry the harness owes
   * itself, and a restart is too long to wait for one: the hold that blocked
   * the release is another process's, and most of them let go within minutes.
   * The tick stamps only what it acts on, so an instance with nothing left
   * behind writes nothing for as long as it runs.
   */
  armWorkspaceSweep() {
    this.sweepTimer = setInterval(() => this.sweepWorkspacesOnTick(), this.workspaceSweepMs);
    // Housekeeping never holds the process open on its own.
    this.sweepTimer.unref();
  }

  sweepWorkspacesOnTick() {
    if (!this.running || this.sweeping) return;
    this.sweeping = true;
    const task = this.sweepOrphanWorkspaces()
      .catch(() => {})
      .finally(() => {
        this.sweeping = false;
        this.pendingTeardowns.delete(task);
      });
    this.pendingTeardowns.add(task);
  }

  // -- instance config ------------------------------------------------------

  /**
   * The machine-scoped seat options, read fresh per dispatch so a live config
   * edit reaches the next seat: which tool the seat runs as, and which
   * environment names hold this host's credentials.
   */
  seatDefaults() {
    return {
      claudeCommand: this.config.claudeCommand,
      ...(this.config.secretEnv !== undefined && { secretEnv: this.config.secretEnv }),
    };
  }

  watchConfig() {
    const watcher = watch(this.paths.home, (kind, filename) => {
      if (filename !== INSTANCE_CONFIG_FILE) return;
      clearTimeout(this.configTimer);
      this.configTimer = setTimeout(() => this.reloadConfig(), CONFIG_DEBOUNCE_MS);
    });
    watcher.on('error', () => {});
    this.watchers.push(watcher);
  }

  reloadConfig() {
    if (!this.running) return;
    let next;
    try {
      next = loadInstanceConfig(this.paths.home);
    } catch (error) {
      this.ledger.append('config-changed', {
        actor: ACTOR,
        accepted: false,
        error: error.message,
      });
      return; // the old config stays live
    }
    const changedKeys = diffKeys(this.config, next);
    if (changedKeys.length === 0) return;
    // The home layout stays as this instance started it. A live `worktreeRoot`
    // edit is recorded here and takes effect at the next start: every open run
    // owns a workspace under the root it provisioned from, and moving the root
    // under them would strand it.
    this.config = next;
    this.semaphores.setLimits(this.config.semaphores);
    this.ledger.append('config-changed', { actor: ACTOR, accepted: true, changedKeys });
    // A raised slot cap or a new project may free launchable work.
    this.frontier.queueSweepAll();
  }

  // -- control channel ------------------------------------------------------

  /**
   * Archives the commands that were already waiting when this instance took
   * its home. The list is the one the start captured, never a fresh read of
   * the inbox: a command written after that moment belongs to this instance,
   * however long the rest of the start takes, and drains like any other.
   * @param {string[]} queuedWhileDown
   */
  archiveStaleControlFiles(queuedWhileDown) {
    for (const file of queuedWhileDown) {
      this.rejectControlFile(file, 'stale: written while the daemon was down');
    }
  }

  inboxFiles() {
    return readdirSync(this.paths.control)
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(this.paths.control, name));
  }

  watchControl() {
    const watcher = watch(this.paths.control, () => this.drainControlInbox());
    watcher.on('error', () => {});
    this.watchers.push(watcher);
  }

  /**
   * Reads one command file, and reads it a second time when the first read
   * gives back no command. The inbox is a directory, and a directory takes
   * writes from any process: a writer that does not publish by rename leaves
   * its file readable while it is still being written, and the drain that
   * lands in that window refuses a command nothing is wrong with. The harness
   * writers all rename (`control.mjs`), so the second read is the tolerance
   * the intake extends to the writers it does not own — one short pause, then
   * the same verdict as before. A file that is corrupt is corrupt twice.
   *
   * @param {string} file
   * @returns {Promise<{command: object}|{reason: string}|{gone: true}>}
   */
  async readControlFile(file) {
    for (let read = 1; ; read++) {
      const result = readCommandFile(file);
      if (result.command !== undefined || result.gone || read === CONTROL_READS) return result;
      await this.pauseBeforeReread();
    }
  }

  /**
   * The wait between the two reads of one command file. Long enough for a
   * small write to finish, short enough that a corrupt file is still refused
   * while the console that wrote it is looking. A method because a file
   * caught mid-write is a race no portable test can stage: a test replaces
   * this to say what happens in the window.
   */
  pauseBeforeReread() {
    return new Promise((resolve) => setTimeout(resolve, CONTROL_REREAD_MS));
  }

  async drainControlInbox() {
    if (!this.running) return;
    for (const file of this.inboxFiles()) {
      const read = await this.readControlFile(file);
      // Gone between the listing and the read: another drain claimed it and
      // owns what happens to it. This one has nothing to refuse.
      if (read.gone) continue;
      if (read.reason !== undefined) {
        this.rejectControlFile(file, read.reason);
        continue;
      }
      const command = read.command;
      if (typeof command.command !== 'string' || typeof command.actor !== 'string') {
        this.rejectControlFile(file, 'command and actor are required strings');
        continue;
      }
      const handler = this.commands.get(command.command);
      if (!handler) {
        this.rejectControlFile(file, `unknown command: ${command.command}`);
        continue;
      }
      // Claim before execute: the drain that wins the rename runs the
      // handler; a competing drain skips. Prevents double execution.
      if (this.finishControlFile(file, this.paths.controlDone)) {
        try {
          await handler(command);
        } catch (error) {
          // The command was claimed; the reason file is the console's feedback.
          writeFileSync(
            join(this.paths.controlRejected, basename(file) + '.reason.txt'),
            error.message + '\n',
          );
          this.stampRejectedLaunch(command, error);
        }
      }
    }
  }

  /**
   * Stamps a refused launch. A reason file alone reaches only the console that
   * wrote the command; a run that never started is otherwise absent from every
   * ledger, and the instance ledger is where a reader looks for what the
   * factory did with its slots.
   */
  stampRejectedLaunch(command, error) {
    if (command.command !== 'launch') return;
    try {
      this.ledger.append('launch-rejected', {
        actor: ACTOR,
        requestedBy: command.actor,
        project: command.project,
        lane: command.lane ?? 'story',
        ...(error.runId !== undefined && { runId: error.runId }),
        ...(command.card !== undefined && { card: command.card }),
        reason: error.message,
      });
    } catch {
      // A stamp never changes how the control file itself is handled.
    }
  }

  rejectControlFile(file, reason) {
    writeFileSync(join(this.paths.controlRejected, basename(file) + '.reason.txt'), reason + '\n');
    this.finishControlFile(file, this.paths.controlRejected);
  }

  finishControlFile(file, dir) {
    try {
      renameSync(file, join(dir, `${Date.now()}-${basename(file)}`));
      return true;
    } catch {
      return false; // a competing drain already moved it
    }
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * The exit paths. Every one of them ends at a `daemon-stopped` stamp, so a
   * start that finds none knows the previous instance died where no path saw
   * it (ADR-0016).
   *
   * Every signal the host can deliver is handled, including the one the daemon
   * refuses to act on: an unhandled console signal has a default action, and
   * the default action tears the process down mid-write with nothing recorded.
   *
   * The `exit` stamp is the floor under all of them. It is a synchronous
   * append to an already-open descriptor, which is the only kind of work an
   * exit handler can still do.
   */
  installSignalHandlers() {
    this.signalHandler = (signal) => {
      // Only the signals that mean this daemon end it. Anything else is
      // listened for so it has no default action, and then dropped.
      if (!STOP_SIGNALS.includes(signal)) return;
      this.stop({ trigger: 'signal', actor: ACTOR, signal }).then(() => process.exit(0));
    };
    for (const signal of EXIT_SIGNALS) process.on(signal, this.signalHandler);
    this.exitHandler = () => this.stampStop({ trigger: 'exit' });
    process.on('exit', this.exitHandler);
    // A fault is a stop the daemon did not choose: stamp it, then leave with a
    // code the service manager reads as a failure rather than a clean end.
    this.faultHandler = (error) => {
      this.stampStop({ trigger: 'fault', error: String(error?.stack ?? error).slice(0, FAULT_MAX) });
      process.exit(1);
    };
    process.on('uncaughtException', this.faultHandler);
    process.on('unhandledRejection', this.faultHandler);
  }

  /**
   * Appends `daemon-stopped` unless this instance already has. Safe to call
   * from an exit handler: it throws nothing and writes at most once.
   */
  stampStop(fields) {
    if (this.stopStamped || !this.ledger) return;
    this.stopStamped = true;
    try {
      this.ledger.append('daemon-stopped', { actor: ACTOR, ...fields });
    } catch {
      // A ledger that cannot be written is not a reason to fail an exit.
    }
  }

  /**
   * Stamps `daemon-crash-detected` when the tail of the instance ledger is not
   * a clean stop. The seq it carries is the last thing the dead instance
   * managed to write — where a reader starts looking.
   */
  stampCrashIfUnstopped() {
    const events = readEvents(this.paths.instanceLedger);
    const last = events.at(-1);
    if (!last) return; // a home with no history has nothing to have crashed
    const lifecycle = events.filter((e) => LIFECYCLE_EVENTS.has(e.event)).at(-1);
    if (lifecycle?.event === 'daemon-stopped') return;
    this.ledger.append('daemon-crash-detected', {
      actor: ACTOR,
      lastSeq: last.seq,
      lastEvent: last.event,
      ...(lifecycle && { startedSeq: lifecycle.seq }),
    });
  }

  async stop({ trigger, actor, signal } = { trigger: 'api', actor: ACTOR }) {
    if (!this.running) return this.stopPromise;
    this.running = false;
    this.stopPromise = (async () => {
      // Engine first: in-flight seats get their seat-terminated stamps while
      // the run stores are still open.
      if (this.engine) {
        await this.engine.stop();
        this.engine = null;
      }
      // In-flight workspace teardowns and sweeps stamp to the instance
      // ledger; let them land before the ledger closes.
      await Promise.allSettled([...this.pendingTeardowns]);
      if (this.frontier) await this.frontier.drain();
      if (this.tripwires) await this.tripwires.stop();
      if (this.evals) await this.evals.stop();
      // Last of the observers: a push in flight may still owe a failure stamp,
      // and the ledger closes right after this.
      if (this.notifier) await this.notifier.stop();
      this.stampStop({ actor: actor ?? ACTOR, trigger, ...(signal && { signal }) });
      this.teardown();
      if (this.onStopped) this.onStopped();
    })();
    return this.stopPromise;
  }

  teardown() {
    clearTimeout(this.configTimer);
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (this.signalHandler) {
      for (const signal of EXIT_SIGNALS) process.off(signal, this.signalHandler);
      this.signalHandler = null;
    }
    if (this.exitHandler) {
      process.off('exit', this.exitHandler);
      this.exitHandler = null;
    }
    if (this.faultHandler) {
      process.off('uncaughtException', this.faultHandler);
      process.off('unhandledRejection', this.faultHandler);
      this.faultHandler = null;
    }
    this.notifier = null;
    if (this.ledger) {
      this.ledger.close();
      this.ledger = null;
    }
    if (this.lock) {
      this.lock.release();
      this.lock = null;
    }
  }
}

/**
 * One read of one command file: the command it holds, the reason it holds
 * none, or that it is no longer there. A missing file is its own answer and
 * never a reason: the drain lists the inbox and reads a moment later, and a
 * competing drain claims by rename in between. Refusing on that read files a
 * refusal against a command that ran.
 * @param {string} file
 * @returns {{command: object}|{reason: string}|{gone: true}}
 */
function readCommandFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { gone: true };
    return { reason: `unreadable: ${error.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: 'not valid JSON' };
  }
  // Valid JSON that is not an object carries no fields at all, and the drain
  // reads `command` and `actor` off whatever this hands back.
  if (parsed === null || typeof parsed !== 'object') {
    return { reason: 'command and actor are required strings' };
  }
  return { command: parsed };
}

function diffKeys(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const changed = [];
  for (const key of keys) {
    if (stableStringify(a?.[key]) !== stableStringify(b?.[key])) changed.push(key);
  }
  return changed.sort();
}

function stableStringify(value) {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
