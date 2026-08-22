// The push edge of the notification streams. Every console surface is pull:
// a park nobody reads is a slot standing idle for as long as nobody runs
// status. The notifier pushes the events that wait on a human — a park, every
// loud record, and a run close — out of the daemon to one target the instance
// config names, and does nothing else (ADR-0028).
//
// Three rules hold this module small. It carries a fixed projection of each
// event, never the ledger line, so no field the harness later adds can leak
// through it. It is fire-and-forget: the delivery is not awaited by anything
// that appends, and a failure stamps `notify-failed` rather than surfacing
// anywhere a lane can see it. And it is off unless configured, in which case
// nothing in the daemon behaves differently at all.
import { spawn } from 'node:child_process';
import { LOUD_EVENTS } from '../ledger/registry.mjs';
import { resolveArgv } from '../engine/executable.mjs';

const ACTOR = 'notifier';
const DEFAULT_TIMEOUT_MS = 5000;
const REASON_MAX = 200;

/**
 * The events a target is told about: the park that holds a slot until a human
 * answers, the close that answers the only question an absent owner has, and
 * the loud set entire. Derived from the loud registry rather than listed
 * beside it, so a loud record the harness learns to raise is pushed the day it
 * is raised — a strip nobody is looking at is the case push exists for.
 */
export const NOTIFIED_EVENTS = new Set(['park', 'run-closed', ...LOUD_EVENTS]);

// The payload, per event, beyond the envelope below. An allowlist rather than
// a spread: the ledger line is the harness's own record and holds whatever a
// stamp site put in it, and a webhook is somebody else's machine.
const CARRIED_FIELDS = {
  park: ['type', 'gist'],
  'budget-breach': ['threshold', 'cost', 'stage', 'gist'],
  'run-closed': ['state'],
};

// The fallback for a loud record the table does not name. Every stream-classed
// append carries a gist by construction — the store refuses one without it —
// so a loud event says what it is about without an entry of its own, and a
// loud event that needs more than a gist earns one.
const LOUD_FIELDS = ['gist'];

function carriedFields(event) {
  return CARRIED_FIELDS[event] ?? (LOUD_EVENTS.has(event) ? LOUD_FIELDS : []);
}

export class Notifier {
  /**
   * @param {{ledger: import('../telemetry/stores.mjs').TelemetryStore,
   *   config: () => object|undefined, fetchImpl?: Function,
   *   spawnImpl?: Function, resolveImpl?: Function}} opts
   *   ledger: the instance store a failure stamps to. config: reads the live
   *   `notifier` section, so a config edit reaches the next event.
   *   resolveImpl: the executable resolver. Injected because a Windows shim is
   *   a host condition no test on another platform can stage.
   */
  constructor({ ledger, config, fetchImpl, spawnImpl, resolveImpl }) {
    this.ledger = ledger;
    this.readConfig = config ?? (() => undefined);
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.spawnImpl = spawnImpl ?? spawn;
    this.resolveImpl = resolveImpl ?? resolveArgv;
    this.inflight = new Set();
    this.stopped = false;
  }

  /**
   * The event key: every store append lands here (via the store hooks). An
   * event outside the notified set, and an instance with no notifier
   * configured, both return before anything is built.
   * @param {{ledger: string, project?: string, line: object}} event
   */
  notify({ ledger, project, line }) {
    if (this.stopped || !NOTIFIED_EVENTS.has(line?.event)) return;
    const config = this.readConfig();
    if (!config) return;
    const payload = project === undefined
      ? this.payloadOf(ledger, line)
      : { ...this.payloadOf(ledger, line), project };
    const task = this.deliver(config, payload)
      .catch(() => {})
      .finally(() => this.inflight.delete(task));
    this.inflight.add(task);
    return task;
  }

  /** The envelope every target sees, plus the event's own allowlisted fields. */
  payloadOf(ledger, line) {
    const payload = { event: line.event, ts: line.ts, seq: line.seq, ledger };
    if (ledger?.startsWith('run:')) payload.runId = ledger.slice('run:'.length);
    for (const key of carriedFields(line.event)) {
      if (line[key] !== undefined) payload[key] = line[key];
    }
    return payload;
  }

  /** Awaited by daemon stop, so a late failure stamp lands before the close. */
  async stop() {
    this.stopped = true;
    await this.drain();
  }

  /** Settles whatever is in flight. The tests' seam, and stop's. */
  async drain() {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  async deliver(config, payload) {
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let failure = null;
    try {
      failure = config.url
        ? await this.post(config, payload, timeoutMs)
        : await this.run(config, payload, timeoutMs);
    } catch (error) {
      failure = String(error?.message ?? error);
    }
    if (failure !== null) this.stampFailure(config, payload, failure);
  }

  /** @returns {Promise<string|null>} the failure reason, or null for delivered */
  async post(config, payload, timeoutMs) {
    const response = await this.fetchImpl(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? null : `http ${response.status}`;
  }

  /**
   * The command form. The payload arrives on stdin as one JSON line: an argv
   * the operator writes stays an argv, and nothing about the event has to
   * survive a shell's quoting rules.
   *
   * The argv goes through the executable resolver, like every other command
   * the instance config names. The notify tool on a Windows host is typically
   * a `.cmd` shim, which CreateProcess cannot run: a bare spawn of the name
   * the operator wired would answer ENOENT at the first park and stamp a
   * failure for a target that is installed and working (ADR-0013).
   * @returns {Promise<string|null>}
   */
  run(config, payload, timeoutMs) {
    return new Promise((resolve) => {
      let child;
      try {
        const spec = this.resolveImpl(config.command);
        child = this.spawnImpl(spec.file, spec.args, {
          windowsHide: true,
          stdio: ['pipe', 'ignore', 'ignore'],
          ...(spec.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
        });
      } catch (error) {
        resolve(String(error?.message ?? error));
        return;
      }
      let settled = false;
      const done = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(reason);
      };
      const timer = setTimeout(() => {
        child.kill();
        done(`timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      child.on('error', (error) => done(String(error?.message ?? error)));
      child.on('close', (code) => done(code === 0 ? null : `exit ${code}`));
      child.stdin.on('error', () => {}); // a target that never reads stdin
      child.stdin.end(JSON.stringify(payload) + '\n');
    });
  }

  /**
   * Records a push that did not arrive. The stamp names the event and the
   * kind of target, never the target itself: a webhook URL and a command argv
   * are both places an operator keeps a token.
   */
  stampFailure(config, payload, reason) {
    try {
      this.ledger.append('notify-failed', {
        actor: ACTOR,
        // `event` and `seq` belong to the envelope, so the event this stamp is
        // about carries its own names.
        notifiedEvent: payload.event,
        notifiedSeq: payload.seq,
        ledger: payload.ledger,
        ...(payload.runId !== undefined && { runId: payload.runId }),
        ...(payload.project !== undefined && { project: payload.project }),
        target: config.url ? 'webhook' : 'command',
        reason: redact(reason, config.url),
      });
    } catch {
      // A ledger that cannot be written is not a reason to fail a notification
      // that already failed.
    }
  }
}

function redact(reason, url) {
  let text = String(reason);
  if (url) text = text.split(url).join('<target>');
  return text.length > REASON_MAX ? text.slice(0, REASON_MAX - 1) + '…' : text;
}
