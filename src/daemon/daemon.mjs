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
import { ensureBareClone, readBlobFromBranch } from '../isolation/clones.mjs';
import { parseIntentCard } from '../lanes/card.mjs';
import { FrontierLauncher } from '../frontier/autolaunch.mjs';
import { scaffoldHome, homePaths, runLedgerPath } from './home.mjs';
import { acquireLock } from './lock.mjs';

const ACTOR = 'daemon';
const CONFIG_DEBOUNCE_MS = 150; // collapses editor multi-writes; not a detector

export class Daemon {
  /**
   * @param {string} home
   * @param {{handleSignals?: boolean, lanes?: Record<string, object>,
   *   composeRunner?: Function}} opts
   *   lanes: lane name → {stages, handlers}, registered on the run engine at
   *   start. Concrete lanes land with their milestones. composeRunner
   *   substitutes the compose child process (tests only).
   */
  constructor(home, { handleSignals = false, lanes = {}, composeRunner } = {}) {
    this.paths = homePaths(home);
    this.handleSignals = handleSignals;
    this.lanes = lanes;
    this.composeRunner = composeRunner;
    this.running = false;
    this.config = null;
    this.lock = null;
    this.ledger = null;
    this.engine = null;
    this.semaphores = null;
    this.isolation = null;
    this.frontier = null;
    this.pendingTeardowns = new Set();
    this.launchCounter = 0;
    this.watchers = [];
    this.commands = new Map();
    this.configTimer = null;
    this.stopPromise = null;
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
    this.lock = acquireLock(this.paths.lock);
    try {
      this.config = loadInstanceConfig(this.paths.home);
      this.ledger = openInstanceStore(this.paths);
      this.isolation = new RunIsolation(this.paths, {
        composeCommand: () => this.config.composeCommand,
        composeRunner: this.composeRunner,
      });
      this.semaphores = new ModelSemaphores(this.config.semaphores);
      this.engine = new RunEngine(this.paths, {
        instanceStore: this.ledger,
        getSlotCap: (project) => this.config.projects[project]?.slotCap,
        onClosed: (info) => {
          this.scheduleWorkspaceRelease(info);
          this.frontier.queueSweep(info.project);
        },
        onParked: (info) => this.frontier.queueSweep(info.project),
        semaphores: this.semaphores,
        seatDefaults: () => ({ claudeCommand: this.config.claudeCommand }),
      });
      for (const [name, lane] of Object.entries(this.lanes)) {
        this.engine.registerLane(name, lane);
      }
      this.frontier = new FrontierLauncher(this);
      this.frontier.replayArming();
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
   * @param {{project: string, lane: string, runId?: string, [k: string]: unknown}} opts
   */
  async launchRun({ project, lane, runId, ...payload }) {
    if (!this.running) throw new Error('daemon not running');
    const entry = this.config.projects[project];
    if (!entry) throw new Error(`unknown project: ${project}`);
    if (!this.engine.lanes.has(lane)) throw new Error(`unknown lane: ${lane}`);
    if (!this.engine.hasFreeSlot(project)) throw new Error(`no free slot for project ${project}`);
    runId = runId ?? `${project}-${Date.now().toString(36)}-${++this.launchCounter}`;
    if (this.engine.runs.has(runId)) throw new Error(`run ${runId} is already live`);
    if (readEvents(runLedgerPath(this.paths, runId)).length > 0) {
      throw new Error(`run ${runId} already has a ledger`);
    }
    const ws = await this.isolation.provision({
      runId,
      project,
      repoUrl: entry.repoUrl,
      defaultBranch: entry.defaultBranch,
      configPath: entry.projectConfigPath,
    });
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
  }

  /**
   * A console launch: `{project, lane?, card?}`. A story launch reads the
   * card from the clone for its key, so the frontier's run history matches;
   * an unreadable card launches anyway — readiness fails it with evidence.
   */
  async launchCommand({ actor, project, lane = 'story', card }) {
    if (typeof actor !== 'string' || actor.length === 0) throw new Error('launch requires an actor');
    const payload = {};
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

  /** Tears a closed run's workspace down and stamps the outcome. Async. */
  scheduleWorkspaceRelease({ runId, project }) {
    const task = this.releaseWorkspace(runId, { project })
      .catch(() => {})
      .finally(() => {
        this.pendingTeardowns.delete(task);
      });
    this.pendingTeardowns.add(task);
  }

  async releaseWorkspace(runId, { project, orphan = false } = {}) {
    let errors;
    try {
      ({ errors } = await this.isolation.release(runId, { project }));
    } catch (error) {
      errors = [error.message];
    }
    this.ledger.append('workspace-released', {
      actor: ACTOR,
      runId,
      ok: errors.length === 0,
      ...(orphan && { orphan }),
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
      await this.releaseWorkspace(runId, { orphan: true });
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
        }
      }
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

  installSignalHandlers() {
    this.signalHandler = () => {
      this.stop({ trigger: 'signal', actor: ACTOR }).then(() => process.exit(0));
    };
    process.on('SIGINT', this.signalHandler);
    process.on('SIGTERM', this.signalHandler);
  }

  async stop({ trigger, actor } = { trigger: 'api', actor: ACTOR }) {
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
      this.ledger.append('daemon-stopped', { actor: actor ?? ACTOR, trigger });
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
      process.off('SIGINT', this.signalHandler);
      process.off('SIGTERM', this.signalHandler);
      this.signalHandler = null;
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
