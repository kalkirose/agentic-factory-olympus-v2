// The orchestrator daemon core: home scaffold, single-instance lock,
// instance config with live edit pickup, instance ledger, control inbox,
// and the run engine that owns every open run.
import {
  watch,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, basename, isAbsolute } from 'node:path';
import {
  openEscapesStore,
  openInstanceStore,
  openRunStore,
  resolveClosedRun,
} from '../telemetry/stores.mjs';
import { openWorkspaceLeftovers, fastPathShipOf } from '../telemetry/readers.mjs';
import {
  FAST_PATH_ESCAPE_KIND,
  markEscapeFixed as appendFixedMark,
  readEscapeSet,
  recordEscape as appendEscape,
  ticketEscape,
} from '../telemetry/escapes.mjs';
import { settleBreachOf } from '../telemetry/breaches.mjs';
import { loadInstanceConfig, INSTANCE_CONFIG_FILE } from '../config/instance.mjs';
import { RunEngine } from '../engine/engine.mjs';
import { ModelSemaphores } from '../seats/semaphore.mjs';
import { RunIsolation } from '../isolation/isolation.mjs';
import { readEvents } from '../ledger/ledger.mjs';
import { checkAnswer } from '../ledger/parks.mjs';
import { escapesRevokeCloses } from '../ledger/resolution.mjs';
import { recoverOpenAttempts } from '../ledger/attempts.mjs';
import { ACK_OPTION, standingAcksFor } from '../ledger/acks.mjs';
import {
  cloneDir,
  ensureBareClone,
  fetchClone,
  hasBranch,
  hasCommit,
  readBlobFromBranch,
  readBranchFile,
} from '../isolation/clones.mjs';
import { git } from '../isolation/git.mjs';
import { parseProjectConfig } from '../config/project.mjs';
import { diffPolicyViolations, laneDiffPolicy, parseTouchedBlock } from '../seats/diffpolicy.mjs';
import { parseIntentCard } from '../lanes/card.mjs';
import { credentialRefusal, probeCredentials } from '../lanes/probes.mjs';
import { readInheritance, closeState } from '../lanes/resume.mjs';
import { FrontierLauncher } from '../frontier/autolaunch.mjs';
import { launchEscape } from '../frontier/repairs.mjs';
import { readGraphSource } from '../frontier/source.mjs';
import { TripwireWatcher } from '../tripwires/watcher.mjs';
import { armedTripwires } from '../tripwires/registry.mjs';
import { WorkflowWatcher } from '../ship/workflows.mjs';
import { ProofDebtWatcher, narrowEnv } from '../lanes/proofdebt.mjs';
import { askDeclaredProbe } from '../lanes/probes.mjs';
import { runCommand } from '../lanes/exec.mjs';
import { PARTS_ENV, FAILED_FILES_ENV } from '../lanes/parts.mjs';
import { runEnv } from '../lanes/shared.mjs';
import { projectForge } from '../lanes/assemble.mjs';
import { EvalScheduler } from '../eval/review.mjs';
import { Notifier } from './notifier.mjs';
import { OperatorHold } from './hold.mjs';
import { checkSeatEnvironment } from './environment.mjs';
import { declaredNames, readCredentials } from './credentials.mjs';
import { scaffoldHome, homePaths, runLedgerPath, repairTicketPath } from './home.mjs';
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
// The refusals a door raises name the errors a reader can act on and stop
// there. A parser that found nine faults in one card is describing one badly
// written card, and a console line that carries all nine is a wall of text
// nobody reads to the end.
const CARD_ERRORS_NAMED = 3;
const CONTROL_READS = 2;
const CONTROL_REREAD_MS = 50;

export class Daemon {
  /**
   * @param {string} home
   * @param {{handleSignals?: boolean, lanes?: Record<string, object>,
   *   composeRunner?: Function, evalSeatDefaults?: () => object,
   *   workspaceSweepMs?: number, workflowWatchMs?: number, proofDebtMs?: number,
   *   waitSleep?: (ms: number) => Promise<void>,
   *   forgeFor?: (project: string) => object,
   *   notifierTransport?: {fetchImpl?: Function, spawnImpl?: Function}}} opts
   *   lanes: lane name → {stages, handlers}, registered on the run engine at
   *   start; `lanes/assemble.mjs` builds the graph the daemon binary passes,
   *   and a fixture graph substitutes it in tests. composeRunner
   *   substitutes the compose child process (tests only); evalSeatDefaults
   *   substitutes the eval seat's dispatch defaults (tests only);
   *   workspaceSweepMs shortens the orphan-sweep period (tests only);
   *   workflowWatchMs shortens the watched-workflow poll (tests only);
   *   proofDebtMs shortens the deferred-proof poll (tests only);
   *   waitSleep substitutes the wait mechanism's clock (tests only);
   *   forgeFor substitutes the forge the workflow watcher reads through
   *   (tests only); notifierTransport substitutes the push transport
   *   (tests only).
   */
  constructor(
    home,
    {
      handleSignals = false,
      lanes = {},
      composeRunner,
      evalSeatDefaults,
      workspaceSweepMs = WORKSPACE_SWEEP_MS,
      workflowWatchMs,
      proofDebtMs,
      waitSleep,
      forgeFor,
      notifierTransport,
    } = {},
  ) {
    this.paths = homePaths(home);
    this.handleSignals = handleSignals;
    this.lanes = lanes;
    this.composeRunner = composeRunner;
    this.evalSeatDefaults = evalSeatDefaults;
    this.workspaceSweepMs = workspaceSweepMs;
    this.workflowWatchMs = workflowWatchMs;
    this.proofDebtMs = proofDebtMs;
    // Whether anything this instance has seen arms the deferred-proof trade: a
    // launch under the flag, or a run of any age opening a debt. It is a hint
    // for the watcher and never a gate on anything.
    this.proofDebtDeclared = false;
    this.waitSleep = waitSleep;
    this.forgeFor = forgeFor ?? ((project) => projectForge(this.config, project));
    this.notifierTransport = notifierTransport;
    this.running = false;
    this.config = null;
    this.lock = null;
    this.ledger = null;
    this.engine = null;
    this.semaphores = null;
    this.isolation = null;
    this.frontier = null;
    this.hold = null;
    this.tripwires = null;
    this.workflows = null;
    this.proofDebts = null;
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
    // A run adopts a project config that exists. The blob is resolved and
    // parsed here, before anything is stamped: a run pinned to a config no
    // stage can read would fail at every stage instead of at this command
    // (ADR-0061).
    this.registerCommand('reconfigure', async (command) => {
      await this.reconfigureCommand(command);
    });
    this.registerCommand('arm', async (command) => {
      this.frontier.setArmed(command.project, true, command.actor);
    });
    this.registerCommand('pause', async (command) => {
      this.frontier.setArmed(command.project, false, command.actor);
    });
    // The hold and the release: the operator's moment with no live seats. A
    // hold ends nothing that is running and blocks nothing that launches — it
    // stops the stage chain, and the runs drain themselves to their boundaries.
    // Auto-launch is the other lever and stays independent of this one: pause
    // governs entry, a hold governs progression (ADR-0040).
    // A hold names one run, one project or the instance, and the widest one
    // standing governs: a project release never lifts a hold an operator took
    // over one run by hand (ADR-0057).
    this.registerCommand('hold', async (command) => {
      this.hold.set(
        { runId: command.runId, project: command.project, all: command.all },
        true,
        command.actor,
      );
    });
    this.registerCommand('release', async (command) => {
      this.hold.set(
        { runId: command.runId, project: command.project, all: command.all },
        false,
        command.actor,
      );
      // Every run this release frees, and no other: a run any hold the release
      // did not name still covers stays where it is.
      this.engine.releaseHeldRuns();
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
    // A defect somebody found in the product after it shipped. The record is
    // the intake: the repair launches from a ticket, and the ticket is written
    // against the escape this stamps (ADR-0024).
    this.registerCommand('escape', async (command) => {
      this.recordEscapeReport(command);
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
          this.tripwires?.notify(line.project, line, ledger);
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
      // The workflow runs no request path covers: a job on a schedule of its
      // own, on the default branch, that nothing in the harness would
      // otherwise read (ADR-0035).
      this.workflows = new WorkflowWatcher({
        ledger: this.ledger,
        projects: () => this.watchedProjects(),
        forgeFor: (project) => this.forgeFor(project),
        readWatched: (project) => this.readWatchedWorkflows(project),
        ...(this.workflowWatchMs !== undefined && { intervalMs: this.workflowWatchMs }),
      });
      // The proofs a ship went out without, where an owner took that trade.
      // The watcher asks the service and settles the debt; it holds no run and
      // it is not there for a project that never defers one (ADR-0069).
      this.proofDebts = new ProofDebtWatcher({
        ledger: this.ledger,
        paths: this.paths,
        probe: (debt) => this.probeDeferred(debt),
        settle: (debt) => this.settleProofDebt(debt),
        // A project arms the trade in its own config, and the launch is where
        // this daemon reads one. Until a launch says so, and with no debt
        // open, the watcher reads no ledger at all.
        declared: () => this.proofDebtDeclared,
        ...(this.proofDebtMs !== undefined && { intervalMs: this.proofDebtMs }),
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
        // Read at every stage chain, never cached in the engine: an operator
        // who holds a project mid-run holds the very next boundary.
        isHeld: (project) => this.hold?.isHeld(project) === true,
        onClosed: (info) => {
          this.scheduleWorkspaceRelease(info);
          this.frontier.queueSweep(info.project);
          // Any lane: a repair that merged is a ship the review reads.
          if (info.state === 'shipped') this.evals.notify();
        },
        onParked: (info) => this.frontier.queueSweep(info.project),
        // An external wait gives its slot up the way a park does, so the
        // frontier fills it the same way (ADR-0069).
        onWaiting: (info) => this.frontier.queueSweep(info.project),
        semaphores: this.semaphores,
        seatDefaults: () => this.seatDefaults(),
        composeCommand: () => this.config.composeCommand,
        // The machine's own statement about its credentials, read live like
        // every other machine-scoped value: an operator who takes a name off
        // the eligible list takes it off the next probe (ADR-0042).
        probePolicy: () => ({
          credentials: this.config.probeCredentials ?? [],
          secretEnv: this.config.secretEnv ?? [],
        }),
        // The wait mechanism's clock. Absent is the real one; a test drives
        // the ladders through it, because a ladder is measured in minutes.
        ...(this.waitSleep && { waitSleep: this.waitSleep }),
        onEvent: (project, line, ledger) => {
          this.noticeRunEvent(line);
          this.tripwires?.notify(project, line, ledger);
          this.notifier?.notify({ ledger, project, line });
        },
      });
      for (const [name, lane] of Object.entries(this.lanes)) {
        this.engine.registerLane(name, lane);
      }
      this.frontier = new FrontierLauncher(this);
      this.frontier.replayArming();
      // Before any run resumes: a run that is held has to come back held, and
      // the state that says so is the ledger this fold reads (ADR-0040).
      this.hold = new OperatorHold(this);
      this.hold.replay();
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
      await this.stampCredentialFingerprints();
      await this.sweepOrphanWorkspaces();
      this.archiveStaleControlFiles(queuedWhileDown);
      this.watchConfig();
      this.watchControl();
      this.armWorkspaceSweep();
      this.workflows.start();
      this.proofDebts.start();
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

  /**
   * What this instance holds for each project's declared credentials, stamped
   * once behind the start.
   *
   * The record is what makes a stale copy visible before a story tries the
   * door: a variable whose source reads `inherited` is one the machine's store
   * could not answer for, and the status page counts them. It is also the
   * baseline a later read compares against, so the first read that finds a
   * different value can say a password changed rather than only that a probe
   * failed (ADR-0064).
   *
   * A home that declares no store stamps nothing, because it holds no store to
   * be right or wrong about. A project whose clone this host does not hold yet
   * declares nothing this start can read, and the start after its first launch
   * records it.
   */
  async stampCredentialFingerprints() {
    const store = this.config.credentialStore;
    if (!store) return;
    for (const project of Object.keys(this.config.projects)) {
      let names;
      try {
        names = await this.readDeclaredCredentials(project);
      } catch {
        continue;
      }
      if (names.length === 0) continue;
      const { records } = readCredentials(store, names);
      this.ledger.append('credential-fingerprints', {
        actor: ACTOR,
        project,
        store: store.kind,
        variables: records,
      });
    }
  }

  /**
   * The credential variables a project declares, read from the bare clone as it
   * stands, without fetching — this reader never advances the clone either.
   * No clone yet = no launch happened = throws.
   */
  async readDeclaredCredentials(project) {
    const entry = this.config.projects[project];
    if (!entry) return [];
    return this.isolation.withClone(project, async () => {
      const dir = cloneDir(this.paths, project);
      const { text } = await readBlobFromBranch(dir, entry.defaultBranch, entry.projectConfigPath);
      const source = `${entry.defaultBranch}:${entry.projectConfigPath}`;
      return declaredNames(parseProjectConfig(text, source));
    });
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
   *
   * Every input this launch will be judged on is read here, from the default
   * branch, before a slot, a workspace or a stack exists: the intent card of a
   * story, the touched-paths block of a repair ticket, and the credentials the
   * project declares (ADR-0067, ADR-0068). A refusal costs nothing and leaves
   * nothing behind, and the console fixes the input and launches again.
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
      if (lane === 'story') await this.refuseUnreadableCard(project, entry, payload.card);
      if (lane === 'repair' && typeof payload.ticket === 'string') {
        await this.refuseForbiddenTicket(project, entry, payload.ticket);
      }
      await this.refuseUnprovenCredentials(project, entry);
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
      this.tripwires.setRegistry(project, armedTripwires(ws.projectConfig));
      if (ws.projectConfig.gates?.proofDebt === true) this.proofDebtDeclared = true;
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
          // Where that blob lives on the default branch. A stage whose
          // question is about the world rather than about the tree this run
          // holds re-reads it from there (ADR-0068); a ledger from before this
          // field carries none, and every such stage falls back to the blob.
          configPath: entry.projectConfigPath,
          // The lane's budget rides the launch stamp, so the run carries the
          // threshold it was launched under through every resume.
          ...(typeof ws.projectConfig.budgets?.[lane] === 'number' && {
            budget: ws.projectConfig.budgets[lane],
          }),
          ...(ws.stack && { stack: ws.stack.name }),
          // What the run spent before it existed: the clone lock, the fetch,
          // the config read, the worktree, the stack. Measurement only, on the
          // one stamp that is already about the launch (ADR-0049).
          ...(ws.setup && { setup: ws.setup }),
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
   * A story launch whose intent card the default branch does not hold, or does
   * not hold in a shape the parser reads, is refused here — before a slot, a
   * workspace, a stack or a seat is spent on it (ADR-0068). The card is the
   * spec of everything the story lane does, and a launch without one reached
   * readiness, took the whole workspace with it and parked `stage-blocked` on
   * an input nobody could fix from a park.
   *
   * The refusal names the path and the first errors the parser reported. The
   * lane's own card checks stay where they are: they guard a card that moves
   * between this read and readiness, which is the one thing a door cannot see.
   *
   * A resume takes its card from the prior run's record before this runs
   * (`resolveResume`), so an inherited freeze is judged on the card it was
   * born for and not on whatever the payload named.
   *
   * The read fetches first, because the card sweep pushes to the default
   * branch and a card written minutes ago is only there afterwards.
   */
  async refuseUnreadableCard(project, entry, card) {
    if (typeof card !== 'string' || card.length === 0) {
      throw new Error(
        'a story launch is a card and everything derived from it; this launch names no ' +
          'intent card. Name one with --card.',
      );
    }
    const read = await this.readFromDefaultBranch(project, entry, card);
    if (read.error) {
      const error = new Error(
        `the intent card ${card} is not on ${entry.defaultBranch} in ${project}: ${read.error}. ` +
          'Push the card, or name the path it is at.',
      );
      error.detail = { card };
      throw error;
    }
    const { errors } = parseIntentCard(read.text);
    if (errors.length === 0) return;
    const named = errors.slice(0, CARD_ERRORS_NAMED);
    const rest = errors.length - named.length;
    const error = new Error(
      `the intent card ${card} does not parse: ${named.join('; ')}` +
        (rest > 0 ? `; and ${rest} more` : '') +
        '. Fix the card and launch again.',
    );
    error.detail = { card, errors };
    throw error;
  }

  /**
   * One file of this project's default branch, read the way every door reader
   * reads one: the clone lock, the clone made on first use, a fetch that must
   * succeed, and the blob. `{text}` or `{error}`.
   */
  readFromDefaultBranch(project, entry, path) {
    return readBranchFile(this.paths, project, {
      branch: entry.defaultBranch,
      path,
      repoUrl: entry.repoUrl,
      withClone: (read) => this.isolation.withClone(project, read),
    });
  }

  /**
   * The credentials the project declares, proven at the door: every declared
   * surface wired, and every declared value answered yes by the command the
   * project names for it. A gate that is not yes refuses the launch with the
   * evidence and the value's fingerprint, and nothing is provisioned
   * (ADR-0068).
   *
   * Three facts make this cheap enough to run on every launch. The declaration
   * is read from the default branch, so a surface the world retired is not a
   * gap and one it added is. A green probe is cached on the instance ledger
   * per value fingerprint for a day, so a burst of launches asks each service
   * once and a value that moved misses the cache. And the probe runs in the
   * bare clone rather than in a worktree, because there is no worktree yet: a
   * probe is a read-only question to a service, and a project whose probe
   * command needs a working tree names an absolute one.
   *
   * A config the branch does not hold or does not parse is left to
   * provisioning, which reads the same blob next and refuses with the config
   * error itself.
   */
  async refuseUnprovenCredentials(project, entry) {
    const config = await this.readLaunchConfig(project, entry);
    if (!config || (config.credentials ?? []).length === 0) return;
    const directive = await probeCredentials(
      {
        paths: this.paths,
        project,
        store: this.ledger,
        instanceStore: this.ledger,
        payload: { configPath: entry.projectConfigPath },
      },
      config,
      {
        phase: 'launch',
        cwd: cloneDir(this.paths, project),
        forge: this.launchForge(project),
        defaultBranch: entry.defaultBranch,
        // The config this gate holds is the default branch's own, so the
        // parity half is reading the world and the stamp says which
        // declaration it judged (ADR-0068).
        surfaceCredentials: config.credentials ?? [],
        // The door is the one reader of the probe cache. A gate inside a run
        // exists to catch a value that moved under it, and this one exists to
        // keep a burst of launches from asking every service the same question.
        readCache: true,
      },
    );
    if (!directive) return;
    const refused = credentialRefusal(directive);
    const error = new Error(refused.message);
    error.detail = refused.detail;
    throw error;
  }

  /**
   * The forge the door asks about the CI surface, or null. A resolver that
   * refuses — a project the instance holds no repository for — answers null
   * rather than failing the launch: an unreadable secret list reads as
   * unproven and the gate says so, which is the same answer readiness gave.
   */
  launchForge(project) {
    try {
      return this.forgeFor(project) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A repair ticket whose touched-paths block names ground the repair lane may
   * never ship is refused here, before a slot, a workspace or a seat is spent
   * on it (ADR-0067). The block is judged against the lane's `deniedPaths` and
   * `forbiddenPatterns` exactly as the capture gate judges the diff; the
   * `declaredPaths` tier does not apply, because the block is the declaration.
   * The refusal names every offending entry and the rule it broke.
   *
   * A ticket with no block is accepted, as it always was: the capture gate and
   * the review seat still read the whole ticket. A ticket the clone cannot
   * read is accepted too — the lane parks `ticket-missing` with the path, and
   * that park is where a wrong path is answered. A project config that does
   * not parse is left to provisioning, which refuses the launch with the
   * config error itself.
   */
  async refuseForbiddenTicket(project, entry, ticket) {
    const text = await this.readTicketText(project, entry, ticket);
    const block = parseTouchedBlock(text);
    if (block.entries.length === 0) return;
    const tier = laneDiffPolicy(await this.readLaunchConfig(project, entry), 'repair');
    if (!tier) return;
    const violations = diffPolicyViolations(
      block.entries.map((e) => e.path),
      tier,
      () => true,
    );
    if (violations.length === 0) return;
    const named = violations.map((v) =>
      v.rule === 'denied'
        ? `${v.path} (deniedPaths: ${v.pattern})`
        : `${v.path} (forbiddenPatterns: ${v.pattern})`,
    );
    throw new Error(
      `the ticket ${ticket} names ground the repair lane may not touch: ${named.join('; ')}. ` +
        "Remove those entries from the ticket's touched-paths block, or take the change " +
        'through a lane the diff policy admits it in.',
    );
  }

  /**
   * The ticket text, read from where the run would read it: an absolute path
   * from the daemon home, a repo-relative one from the default branch of the
   * clone after a fetch. Null when it cannot be read, which leaves that
   * failure to the stage that owns it.
   */
  async readTicketText(project, entry, ticket) {
    if (isAbsolute(ticket)) {
      try {
        return readFileSync(ticket, 'utf8');
      } catch {
        return null;
      }
    }
    const read = await this.readFromDefaultBranch(project, entry, ticket);
    return read.error === undefined ? read.text : null;
  }

  /**
   * The project config as the default branch holds it, parsed as a launch
   * parses it, or null when it does not parse: provisioning reads the same
   * blob next and refuses the launch with the config error itself.
   */
  async readLaunchConfig(project, entry) {
    const read = await this.readFromDefaultBranch(project, entry, entry.projectConfigPath);
    if (read.error !== undefined) return null;
    try {
      return parseProjectConfig(read.text, `${entry.defaultBranch}:${entry.projectConfigPath}`, {
        launch: true,
      });
    } catch {
      return null;
    }
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
        // The one reader of the default branch, with the door's own three
        // choices: the clone made on first use, the project's clone lock
        // taken, and a fetch that must succeed (ADR-0068). The card the door
        // is about to refuse the launch over is the same read.
        const read = await this.readFromDefaultBranch(project, entry, card);
        payload.storyKey =
          read.error === undefined ? (parseIntentCard(read.text).card.key ?? undefined) : undefined;
        // No key: the run still launches; it just matches no card history.
        if (payload.storyKey === undefined) delete payload.storyKey;
      }
    }
    return this.launchRun({ project, lane, ...payload });
  }

  /**
   * What this daemon takes from one run-ledger append for itself.
   *
   * A debt is opened by a run answering `defer-proof`, and that run may be one
   * this instance resumed rather than launched — a restart, a resume, an
   * answer, and no launch anywhere near it. The launch is therefore not the
   * only place the trade is declared, and a hint that only a launch could set
   * would leave the watcher asleep over a debt it is holding (ADR-0069).
   */
  noticeRunEvent(line) {
    if (line?.event === 'proof-deferred') this.proofDebtDeclared = true;
  }

  /**
   * Whether the service one deferred proof waits on is back. It is the
   * project's own probe command, run in the bare clone as the launch door runs
   * it: a probe is a read-only question to a service, and there is no
   * workspace at this point (ADR-0069).
   */
  async probeDeferred(debt) {
    const entry = this.config.projects[debt.project];
    if (!entry) return false;
    const config = await this.readLaunchConfig(debt.project, entry);
    if (!config) return false;
    const answer = await askDeclaredProbe(this.paths, config, debt.credential, {
      cwd: cloneDir(this.paths, debt.project),
    });
    return answer.ok === true;
  }

  /**
   * Runs one deferred proof against the default branch, in a workspace of its
   * own. The workspace is provisioned and released like a run's, and it is
   * held off the orphan sweep while it stands, because a directory whose run
   * has not reached the engine is not an orphan.
   *
   * The layers are the default branch's own, not the ones the run judged: the
   * question is whether main holds the defect, and main's config is what says
   * how to ask.
   */
  async settleProofDebt(debt) {
    const entry = this.config.projects[debt.project];
    if (!entry) return { ok: false, detail: `unknown project ${debt.project}` };
    const settleId = `proof-${debt.runId}-${debt.seq}`;
    this.provisioning.add(settleId);
    try {
      const ws = await this.isolation.provision({
        runId: settleId,
        project: debt.project,
        repoUrl: entry.repoUrl,
        defaultBranch: entry.defaultBranch,
        configPath: entry.projectConfigPath,
      });
      const config = ws.projectConfig;
      const env = runEnv(
        { runId: settleId, paths: this.paths, payload: { worktree: ws.worktree } },
        config,
      );
      for (const part of debt.parts) {
        const layer = (config.gates?.tier1 ?? []).find((l) => l.name === part.layer);
        const argv = layer ? config.commands?.[layer.command] : null;
        if (!Array.isArray(argv) || argv.length === 0) {
          // The default branch no longer runs that layer. Nothing here can
          // prove or disprove the defect, and a settle that cannot ask is not
          // a red: the debt closes with the reason on the record.
          return { ok: false, detail: `the default branch runs no layer ${part.layer}` };
        }
        const run = await runCommand(argv, {
          cwd: ws.worktree,
          env: {
            ...env,
            ...narrowEnv(part, { partsEnv: PARTS_ENV, filesEnv: FAILED_FILES_ENV }),
          },
          log: false,
        });
        if (run.code !== 0) {
          return {
            ok: false,
            detail: `${part.layer} exited ${run.code ?? 'without an answer'}`,
          };
        }
      }
      return { ok: true };
    } finally {
      this.provisioning.delete(settleId);
      await this.isolation.release(settleId, { project: debt.project }).catch(() => {});
    }
  }

  /**
   * Validates and stamps a human answer to an instance-ledger park (a card a
   * ship-time sweep invalidated, or a decision it found the card leaves open).
   * Mirrors the engine's run-park validation; the paired `answer` unblocks the
   * card.
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

  /**
   * Records one post-merge defect an operator reports, and attributes it where
   * the ledgers can.
   *
   * The attribution the harness owes itself is the fast path (ADR-0056): a
   * defect that came in through a ship which carried its certification over a
   * moved base is recorded under the closed `fast-path-escape` kind, with the
   * run, the request and the merge that carried it. That word is what turns
   * the owner's trade into a counted number, and the standing tripwire over a
   * rolling window of it is what proposes switching the flag back off. The
   * merge is named by its request number or by its commit; a defect that names
   * neither, or names a ship that took the full re-verdict, is the ordinary
   * escape it has always been.
   *
   * Every record carries refs, and every record carries a ticket. The refs name
   * the project, because the escapes ledger is instance-scoped and nothing else
   * in a record says which repository the defect is in. Without it the repair
   * sweep cannot launch, and the per-project metrics count another project's
   * defects as this one's. The ticket is what makes the escape owed: the
   * owed-repairs set is ticketed-and-not-fixed, so an escape with no ticket is
   * recorded, counted, and repaired by nobody. Both are what the red-merge
   * route already does, and a defect a person found is owed exactly as much as
   * one the harness found.
   * @param {{actor: string, project?: string, defectLine: string,
   *   category?: string, detectionSource?: string, pr?: number,
   *   mergeSha?: string, note?: string}} cmd
   */
  recordEscapeReport({
    actor,
    project,
    defectLine,
    category = 'product-escape',
    detectionSource = 'human-report',
    pr,
    mergeSha,
    note,
  }) {
    if (typeof actor !== 'string' || actor.length === 0) {
      throw new Error('an escape record requires an actor');
    }
    if (typeof defectLine !== 'string' || defectLine.trim().length === 0) {
      throw new Error('an escape record requires the defect line (--defect)');
    }
    // The repository the defect is in, and it is required. The escapes ledger
    // is instance-scoped: without it a request number matches whatever project
    // opened a request of that number, and the record it writes belongs to no
    // project, so every per-project metric counts it for none and the repair
    // sweep has nowhere to launch. The console route already requires it; this
    // is the same rule at the API the console goes through.
    if (typeof project !== 'string' || project.trim().length === 0) {
      throw new Error('an escape record requires the project it is in (--project)');
    }
    const ship = fastPathShipOf(this.paths, { project, pr, mergeSha });
    const refs = {
      project,
      ...(Number.isInteger(pr) && { pr }),
      ...(typeof mergeSha === 'string' && mergeSha.length > 0 && { mergeSha }),
      ...(ship && {
        runId: ship.runId,
        fastPathSeq: ship.seq,
        ...(ship.pr !== null && { pr: ship.pr }),
        ...(ship.mergeSha !== null && { mergeSha: ship.mergeSha }),
      }),
    };
    const store = openEscapesStore(this.paths, {
      // The same hook the run-side store carries: a tripwire that counts these
      // reads the append rather than a sweep that happens to come later.
      onAppend: (line, ledger) => this.tripwires?.notify(project, line, ledger),
    });
    try {
      const line = appendEscape(store, {
        actor,
        category,
        defectLine,
        detectionSource,
        ...(ship && { kind: FAST_PATH_ESCAPE_KIND, attribution: ship.runId }),
        refs,
        ...(note !== undefined && { note }),
      });
      // The ticket file first, then the stamp that names it: a ticketed escape
      // always has a ticket to repair from (ADR-0024).
      const ticket = repairTicketPath(this.paths, line.seq);
      writeFileSync(ticket, reportTicket({ escape: line, ship, refs, note }));
      ticketEscape(store, { actor, escape: line.seq, ticket, refs });
      return line;
    } finally {
      store.close();
    }
  }

  // -- the config a run reads (ADR-0061) ------------------------------------

  /**
   * Repins one open run's project config. The blob is settled before the run
   * hears about it: without `--blob` it is the config on the project's default
   * branch at the moment of the command, fetched first, and with one it is the
   * blob the operator named. Either way it is read and parsed here, so a config
   * that does not exist or does not validate is refused at the console instead
   * of failing every stage of the run afterwards.
   * @param {{actor: string, runId: string, blob?: string, reason: string}} cmd
   */
  async reconfigureCommand({ actor, runId, blob, reason }) {
    const run = this.engine.runs.get(runId);
    if (!run || run.closed) throw new Error(`no open run: ${runId}`);
    const entry = this.config.projects[run.project];
    if (!entry) throw new Error(`unknown project: ${run.project}`);
    const resolved = await this.resolveProjectConfigBlob(run.project, entry, blob);
    return this.engine.reconfigure({
      runId,
      actor,
      configBlob: resolved.blob,
      reason,
      source: resolved.source,
    });
  }

  /**
   * The config blob a reconfigure pins, proven readable and valid.
   *
   * A named blob is read out of the project's bare clone: the run's stages read
   * it from there with `git cat-file`, so a blob that clone does not hold is a
   * pin no stage could load. An unnamed one is the default branch's config at
   * command time, and the clone is fetched first — the point of the command is
   * to reach a config that landed after the launch.
   */
  async resolveProjectConfigBlob(project, entry, blob) {
    return this.isolation.withClone(project, async () => {
      const dir = await ensureBareClone(this.paths, project, entry.repoUrl, entry.defaultBranch);
      if (typeof blob === 'string' && blob.length > 0) {
        const text = await git(['cat-file', '-p', blob], { cwd: dir });
        parseProjectConfig(text, `${project}#${blob}`);
        return { blob, source: 'named' };
      }
      await fetchClone(dir);
      const read = await readBlobFromBranch(dir, entry.defaultBranch, entry.projectConfigPath);
      parseProjectConfig(read.text, `${project}@${entry.defaultBranch}`);
      return { blob: read.blob, source: 'branch' };
    });
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
    const revoked = this.ledger.append('finding-ack-revoked', {
      actor,
      project,
      fingerprint,
      fix,
      ackSeq: ack.seq,
      ...(note !== undefined && { note }),
    });
    this.closeAckedDefects({ actor, project, fingerprint, fix, note });
    return revoked;
  }

  /**
   * Closes the counted defect an ack was holding open. A harness finding that
   * reached a provisioning gate is recorded on the escapes ledger under the
   * kind `harness`, and it stays open for as long as the acknowledgment
   * stands: the count is the answer to "how much is the harness costing the
   * runs it judges" (ADR-0068). The revoke is the statement that the defect is
   * gone and the evidence it stands on, which is exactly what an operator's
   * fix mark is, so that is what it writes.
   *
   * A revoke that names a fingerprint no escape carries writes nothing: an ack
   * is older than this record, and a defect nobody counted needs no closing.
   */
  closeAckedDefects({ actor, project, fingerprint, fix, note }) {
    const store = openEscapesStore(this.paths);
    try {
      for (const escape of escapesRevokeCloses(readEscapeSet(this.paths.escapesLedger), {
        project,
        fingerprint,
      })) {
        appendFixedMark(store, {
          actor,
          fixes: escape.seq,
          evidence: fix,
          ...(note !== undefined && { note }),
        });
      }
    } finally {
      store.close();
    }
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
      return armedTripwires(parseProjectConfig(text, source));
    });
  }

  // -- watched-workflow reads ------------------------------------------------

  /** The projects this instance holds, each with the branch a watch reads. */
  watchedProjects() {
    return Object.entries(this.config.projects).map(([project, entry]) => ({
      project,
      defaultBranch: entry.defaultBranch,
    }));
  }

  /**
   * The project's watched-workflow list, read from the bare clone as it
   * stands, without fetching — this observer never advances the clone either.
   * No clone yet = no launch happened = throws, and the next poll asks again.
   */
  async readWatchedWorkflows(project) {
    const entry = this.config.projects[project];
    if (!entry) return [];
    return this.isolation.withClone(project, async () => {
      const dir = cloneDir(this.paths, project);
      const { text } = await readBlobFromBranch(dir, entry.defaultBranch, entry.projectConfigPath);
      const source = `${entry.defaultBranch}:${entry.projectConfigPath}`;
      return parseProjectConfig(text, source).watchedWorkflows;
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
    const holders = released?.holders ?? [];
    // The project the workspace belonged to, from the workspace record when the
    // caller did not say — a sweep names a run id and nothing else. It is what
    // attributes the release to a project's tripwires, so a release the
    // watcher cannot key is one it never counts.
    const owner = released?.record?.project ?? project ?? null;
    this.ledger.append('workspace-released', {
      actor: ACTOR,
      runId,
      ...(owner && { project: owner }),
      ok: errors.length === 0,
      ...(orphan && { orphan }),
      ...(keepBranch && { keptBranch: true }),
      // What the release had to end before it could delete anything. Silent
      // when the workspace held nothing, which is the ordinary case.
      ...(swept?.count > 0 && { swept: { count: swept.count, names: swept.names } }),
      ...(released?.leftover && { leftover: released.leftover }),
      ...(holders.length > 0 && { holders }),
      ...(errors.length > 0 && { errors }),
    });
    if (released === null) return;
    if (released.leftover !== null) {
      this.recordWorkspaceLeftover(runId, released.leftover, { errors, holders, project: owner });
    } else {
      this.settleWorkspaceLeftover(runId);
    }
  }

  /**
   * Records a workspace the release could not delete, and never fails its
   * caller. The run is over and it closed as it closed; a directory nothing
   * would delete is housekeeping the harness owes itself, so the record is
   * quiet and the daemon carries on (ADR-0004). One open record per run: a
   * sweep that tries again and is blocked again reports the same directory.
   *
   * The record names the processes standing in the directory, because that is
   * the operator's next move: an errno says the sweep failed, a pid and an
   * image name say what to end.
   */
  recordWorkspaceLeftover(runId, path, { errors, holders = [], project = null } = {}) {
    try {
      if (openWorkspaceLeftovers(this.paths).has(runId)) return;
      this.ledger.append('workspace-leftover', {
        actor: ACTOR,
        runId,
        ...(project && { project }),
        path,
        reason: errors.join('; '),
        ...(holders.length > 0 && { holders }),
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
      // A run the engine does not hold has nobody left to stamp the ending of
      // a gate-layer attempt it started, so the sweep stamps it (ADR-0034).
      this.recoverAttemptsOf(runId);
      // Same branch rule as a normal close; a workspace with no ledger at all
      // reads as not shipped, which is the safe side of the guess.
      await this.releaseWorkspace(runId, {
        orphan: true,
        keepBranch: closeState(this.paths, runId) !== 'shipped',
      });
    }
  }

  /**
   * Closes the gate-layer attempts one unheld run ledger left open. The live
   * ledger only, and only while the run is still open: a closed run has said
   * its last word at `run-closed` and every reader treats it as such
   * (ADR-0015), so an attempt left open behind that close stays as the ledger
   * recorded it.
   *
   * The store is opened for this write and closed again, so the sweep never
   * holds a handle on a run directory it is about to move.
   */
  recoverAttemptsOf(runId) {
    if (this.engine?.runs.has(runId)) return;
    const path = runLedgerPath(this.paths, runId);
    if (!existsSync(path)) return;
    const events = readEvents(path);
    if (events.length === 0 || events.some((e) => e.event === 'run-closed')) return;
    const store = openRunStore(this.paths, runId);
    try {
      recoverOpenAttempts(store, { actor: ACTOR, trigger: 'orphan-sweep' });
    } finally {
      store.close();
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
   * edit reaches the next seat: which tool the seat runs as, which environment
   * names hold this host's credentials, and how long a child of this host may
   * say nothing before it is taken to be dead.
   */
  seatDefaults() {
    return {
      claudeCommand: this.config.claudeCommand,
      ...(this.config.secretEnv !== undefined && { secretEnv: this.config.secretEnv }),
      ...(this.config.seatSilenceMs !== undefined && { silenceMs: this.config.seatSilenceMs }),
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
        ...(command.ticket !== undefined && { ticket: command.ticket }),
        // What the check that refused had in its hands: the parser's errors,
        // the surfaces that were not wired, the credential and the fingerprint
        // of the value a service would not take (ADR-0068). The reason is the
        // sentence; this is the evidence behind it.
        ...(error.detail && { detail: error.detail }),
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
      if (this.workflows) await this.workflows.stop();
      if (this.proofDebts) await this.proofDebts.stop();
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

/**
 * The repair ticket of one reported escape. The repair run reads it from a
 * fresh worktree of the default branch and can see nothing else, so the ticket
 * carries every fact the repair has: the defect as it was reported, where it
 * came in, and the escape it closes.
 */
function reportTicket({ escape, ship, refs, note }) {
  return [
    `# Repair ticket: escape ${escape.seq}`,
    '',
    'A defect was reported in the product after a merge. This ticket is the',
    'spec of the repair run: fix the defect below and leave a regression test',
    'that fails without the fix.',
    '',
    '## The defect',
    '',
    escape.defectLine,
    ...(note ? ['', note] : []),
    '',
    '## Facts',
    '',
    `- escape: seq ${escape.seq} in the escapes ledger`,
    `- category (a routing hint, not a verdict): ${escape.category}`,
    `- reported by: ${escape.actor}`,
    `- detection source: ${escape.detectionSource}`,
    ...(escape.kind ? [`- kind (the harness named this one): ${escape.kind}`] : []),
    `- attributed to: ${escape.attribution}`,
    ...(refs.project ? [`- project: ${refs.project}`] : []),
    ...(refs.pr !== undefined ? [`- merged PR: #${refs.pr}`] : []),
    ...(refs.mergeSha ? [`- merge commit: ${refs.mergeSha}`] : []),
    ...(ship ? [`- the run that shipped it: ${ship.runId}`] : []),
    '',
    '## Scope',
    '',
    'Stay inside the defect above. The merge it came in on is on the default',
    'branch already; repair it forward, never revert it here.',
    '',
  ].join('\n');
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
