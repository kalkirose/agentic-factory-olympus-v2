// The orchestrator daemon core: home scaffold, single-instance lock,
// instance config with live edit pickup, instance ledger, control inbox.
// Run ownership (state machines, supervision, liveness) builds on this in
// later milestones.
import { watch, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { Ledger, readEvents } from '../ledger/ledger.mjs';
import { INSTANCE_EVENTS } from '../ledger/registry.mjs';
import { loadInstanceConfig, INSTANCE_CONFIG_FILE } from '../config/instance.mjs';
import { scaffoldHome, homePaths, runLedgerPath } from './home.mjs';
import { acquireLock } from './lock.mjs';

const ACTOR = 'daemon';
const CONFIG_DEBOUNCE_MS = 150; // collapses editor multi-writes; not a detector

export class Daemon {
  /** @param {string} home @param {{handleSignals?: boolean}} opts */
  constructor(home, { handleSignals = false } = {}) {
    this.paths = homePaths(home);
    this.handleSignals = handleSignals;
    this.running = false;
    this.config = null;
    this.lock = null;
    this.ledger = null;
    this.watchers = [];
    this.commands = new Map();
    this.configTimer = null;
    this.stopPromise = null;
    this.onStopped = null;
    this.registerCommand('stop', async (command) => {
      await this.stop({ trigger: 'control', actor: command.actor });
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
      this.ledger = new Ledger(this.paths.instanceLedger, { allowedEvents: INSTANCE_EVENTS });
      const runsResumed = this.openRuns();
      this.ledger.append('daemon-started', {
        actor: ACTOR,
        pid: process.pid,
        runsResumed,
      });
      this.archiveStaleControlFiles();
      this.watchConfig();
      this.watchControl();
      if (this.handleSignals) this.installSignalHandlers();
      this.running = true;
      return { runsResumed };
    } catch (error) {
      this.teardown();
      throw error;
    }
  }

  /** Scans runs/ for ledgers without a run-closed stamp. */
  openRuns() {
    let entries;
    try {
      entries = readdirSync(this.paths.runs, { withFileTypes: true });
    } catch {
      return [];
    }
    const open = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const events = readEvents(runLedgerPath(this.paths, entry.name));
      if (events.length === 0) continue;
      if (!events.some((e) => e.event === 'run-closed')) open.push(entry.name);
    }
    return open;
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
    this.ledger.append('config-changed', { actor: ACTOR, accepted: true, changedKeys });
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
        await handler(command);
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
    this.ledger.append('daemon-stopped', { actor: actor ?? ACTOR, trigger });
    this.teardown();
    if (this.onStopped) this.onStopped();
    return (this.stopPromise = Promise.resolve());
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
