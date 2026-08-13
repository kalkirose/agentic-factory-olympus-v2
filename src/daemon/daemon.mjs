// The orchestrator daemon core: home scaffold, single-instance lock,
// instance config with live edit pickup, instance ledger, control inbox,
// and the run engine that owns every open run.
import { watch, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { openInstanceStore, resolveClosedRun } from '../telemetry/stores.mjs';
import { loadInstanceConfig, INSTANCE_CONFIG_FILE } from '../config/instance.mjs';
import { RunEngine } from '../engine/engine.mjs';
import { ModelSemaphores } from '../seats/semaphore.mjs';
import { RunIsolation } from '../isolation/isolation.mjs';
import { readEvents } from '../ledger/ledger.mjs';
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
import { readGraphSource } from '../frontier/source.mjs';
import { TripwireWatcher } from '../tripwires/watcher.mjs';
import { EvalScheduler } from '../eval/review.mjs';
import { scaffoldHome, homePaths, runLedgerPath } from './home.mjs';
import { acquireLock } from './lock.mjs';

const ACTOR = 'daemon';
const CONFIG_DEBOUNCE_MS = 150; // collapses editor multi-writes; not a detector
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

export class Daemon {
  /**
   * @param {string} home
   * @param {{handleSignals?: boolean, lanes?: Record<string, object>,
   *   composeRunner?: Function, evalSeatDefaults?: () => object}} opts
   *   lanes: lane name → {stages, handlers}, registered on the run engine at
   *   start; `lanes/assemble.mjs` builds the graph the daemon binary passes,
   *   and a fixture graph substitutes it in tests. composeRunner
   *   substitutes the compose child process (tests only); evalSeatDefaults
   *   substitutes the eval seat's dispatch defaults (tests only).
   */
  constructor(
    home,
    { handleSignals = false, lanes = {}, composeRunner, evalSeatDefaults } = {},
  ) {
    this.paths = homePaths(home);
    this.handleSignals = handleSignals;
    this.lanes = lanes;
    this.composeRunner = composeRunner;
    this.evalSeatDefaults = evalSeatDefaults;
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
    this.pendingTeardowns = new Set();
    this.launchCounter = 0;
    this.watchers = [];
    this.commands = new Map();
    this.configTimer = null;
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
    scaffoldHome(this.paths.home);
    this.stopStamped = false;
    this.lock = acquireLock(this.paths.lock);
    try {
      this.config = loadInstanceConfig(this.paths.home);
      // The watcher exists before any store opens with its hook; the hooks
      // read `this.tripwires` late so construction order stays simple.
      this.ledger = openInstanceStore(this.paths, {
        onAppend: (line) => this.tripwires?.notify(line.project, line),
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
        seatDefaults: this.evalSeatDefaults ?? (() => ({ claudeCommand: this.config.claudeCommand })),
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
        seatDefaults: () => ({ claudeCommand: this.config.claudeCommand }),
        onEvent: (project, line) => this.tripwires?.notify(project, line),
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
      await this.sweepOrphanWorkspaces();
      this.archiveStaleControlFiles();
      this.watchConfig();
      this.watchControl();
      if (this.handleSignals) this.installSignalHandlers();
      this.running = true;
      this.frontier.queueSweepAll();
      // One start-time check fires a review owed from before a restart.
      this.evals.notify();
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
    // rejection stamp names the run that would have existed.
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
   * @param {{actor: string, project: string, lane?: string, card?: string,
   *   ticket?: string, resumeFrom?: string}} command
   */
  async launchCommand({ actor, project, lane = 'story', card, ticket, resumeFrom }) {
    if (typeof actor !== 'string' || actor.length === 0) throw new Error('launch requires an actor');
    if (resumeFrom !== undefined) {
      if (lane !== 'story') {
        throw new Error(`a resume applies to the story lane only (lane: ${lane})`);
      }
      if (card !== undefined) {
        throw new Error('a resume takes its card from the prior run; name no card');
      }
    }
    if (lane === 'repair') {
      if (typeof ticket !== 'string' || ticket.length === 0) {
        throw new Error('a repair launch requires a ticket path');
      }
    } else if (ticket !== undefined) {
      throw new Error(`a ticket applies to the repair lane only (lane: ${lane})`);
    }
    const payload = {};
    if (ticket !== undefined) payload.ticket = ticket;
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
    if (option !== undefined) {
      if (!Array.isArray(target.options) || !target.options.includes(option)) {
        throw new Error(`option not offered by the escalation record: ${option}`);
      }
    } else if (typeof answer !== 'string' || answer.length === 0) {
      throw new Error('answer requires an option or answer text');
    }
    this.ledger.append('answer', {
      actor,
      parkSeq: seq,
      ...(option !== undefined && { option }),
      ...(answer !== undefined && { answer }),
      ...(target.card !== undefined && { card: target.card }),
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
    let errors;
    let swept;
    try {
      ({ errors, swept } = await this.isolation.release(runId, { project, keepBranch }));
    } catch (error) {
      errors = [error.message];
    }
    this.ledger.append('workspace-released', {
      actor: ACTOR,
      runId,
      ok: errors.length === 0,
      ...(orphan && { orphan }),
      ...(keepBranch && { keptBranch: true }),
      // What the release had to end before it could delete anything. Silent
      // when the workspace held nothing, which is the ordinary case.
      ...(swept?.count > 0 && { swept: { count: swept.count, names: swept.names } }),
      ...(errors.length > 0 && { errors }),
    });
  }

  /**
   * Releases workspaces whose run is not open — a daemon that died between
   * run close and teardown leaves these behind. Runs at start.
   */
  async sweepOrphanWorkspaces() {
    const open = new Set(this.engine.runs.keys());
    for (const runId of this.isolation.orphanRunIds(open)) {
      // Same branch rule as a normal close; a workspace with no ledger at all
      // reads as not shipped, which is the safe side of the guess.
      await this.releaseWorkspace(runId, {
        orphan: true,
        keepBranch: closeState(this.paths, runId) !== 'shipped',
      });
    }
  }

  // -- instance config ------------------------------------------------------

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
    this.config = next;
    this.semaphores.setLimits(this.config.semaphores);
    this.ledger.append('config-changed', { actor: ACTOR, accepted: true, changedKeys });
    // A raised slot cap or a new project may free launchable work.
    this.frontier.queueSweepAll();
  }

  // -- control channel ------------------------------------------------------

  archiveStaleControlFiles() {
    for (const file of this.inboxFiles()) {
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

  async drainControlInbox() {
    if (!this.running) return;
    for (const file of this.inboxFiles()) {
      let command;
      try {
        command = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        this.rejectControlFile(file, 'not valid JSON');
        continue;
      }
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
      this.stampStop({ actor: actor ?? ACTOR, trigger, ...(signal && { signal }) });
      this.teardown();
      if (this.onStopped) this.onStopped();
    })();
    return this.stopPromise;
  }

  teardown() {
    clearTimeout(this.configTimer);
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
