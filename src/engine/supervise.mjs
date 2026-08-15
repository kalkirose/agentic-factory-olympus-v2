// Child supervision for seat processes. The child's stdout carries JSON
// progress lines; `cost` on a line is the cumulative cost to date. The cost
// ceiling is a guardrail, never a liveness detector: a generous limit that
// terminates the child and records a seat-failure event on breach.
//
// Stamp semantics:
//   seat-failure    — the seat failed: nonzero exit, spawn error, or a cost
//                     ceiling breach. Every one carries a bounded tail of what
//                     the child last emitted, so the cause is readable from the
//                     run's own evidence without re-running anything by hand.
//   seat-terminated — the orchestrator ended the seat deliberately (run kill,
//                     daemon stop); not a failure of the seat.
//
// One outcome stamps nothing here: a child whose stream said the model is
// unavailable resolves with reason `model-unavailable` and leaves the stamp to
// the runner, which owns the choice between a degrade and a failure. Only the
// runner supplies a parser that can raise `meta.unavailable`, so no other
// caller can reach that path.
import { spawn } from 'node:child_process';
import { resolveArgv } from './executable.mjs';
import { seatSpawnOptions, terminateTree } from './processes.mjs';
import { seatExecutesSuite } from '../seats/seatmap.mjs';

// Bounds for the failure evidence. A ledger records what a reader needs to
// name the cause, not the transcript: the last stderr and the tail of stdout,
// both clipped. Stream-json lines run to kilobytes; the leading characters
// carry the event type and the start of its payload, which is the part that
// identifies what happened.
const STDERR_TAIL_CHARS = 600;
const STDOUT_TAIL_LINES = 3;
const STDOUT_LINE_CHARS = 200;

/**
 * Spawns and supervises one seat child.
 *
 * `parseLine` adapts a child's stdout dialect: it maps one line to
 * `{cost?, note?, meta?}` or null. Only `cost` and `note` stamp the ledger;
 * `meta` fields accumulate into the resolved result for the caller (actual
 * model, session id). `spawnFields` adds caller fields (model, effort,
 * attempt) to the seat-spawned stamp. `secretEnv` is the instance config's
 * secret name patterns, stripped from every seat that does not execute the
 * suite.
 * @param {import('../telemetry/stores.mjs').TelemetryStore} store
 * @param {{seat: string, cmd: string, args?: string[], cwd?: string,
 *   env?: object, secretEnv?: string[], costCeiling?: number,
 *   parseLine?: (line: string) => object|null, spawnFields?: object}} opts
 * @returns {{done: Promise<object>, terminate: (reason: string) => void}}
 */
export function superviseSeat(
  store,
  {
    seat,
    cmd,
    args = [],
    cwd,
    env,
    secretEnv,
    costCeiling,
    parseLine = parseProgress,
    spawnFields = {},
  },
) {
  if (typeof seat !== 'string' || seat.length === 0) throw new Error('supervise requires a seat id');
  if (typeof cmd !== 'string' || cmd.length === 0) throw new Error('supervise requires a cmd');
  const { env: childEnv, stripped } = seatEnv(seat, env, secretEnv);
  store.append('seat-spawned', {
    ...spawnFields,
    actor: 'daemon',
    seat,
    ...(costCeiling != null && { costCeiling }),
    // The count, never the names: a ledger a reader outside this machine may
    // hold says how much was withheld, not what the machine holds.
    ...(stripped > 0 && { envStripped: stripped }),
  });
  // The seat command (`claudeCommand`) names a tool; the host decides which
  // file that is. A resolution refusal is a spawn failure like any other.
  let spec;
  try {
    spec = resolveArgv([cmd, ...args], { env: childEnv });
  } catch (error) {
    const failure = { failed: true, reason: 'spawn', error: error.message, cost: 0, meta: {} };
    store.append('seat-failure', { actor: 'daemon', seat, reason: 'spawn', error: error.message });
    return { done: Promise.resolve(failure), terminate() {} };
  }
  const child = spawn(spec.file, spec.args, {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    // A seat runs on a console of its own that has no window, so nothing it
    // starts can put one on the operator's screen and nothing aimed at a seat
    // reaches the daemon through it (ADR-0016).
    ...seatSpawnOptions(),
    ...(spec.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
  });
  let cost = 0;
  let buffer = '';
  let terminatedReason = null;
  let ceilingHit = false;
  let stderrTail = '';
  const stdoutTail = [];
  const meta = {};
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) {
        stdoutTail.push(clip(line, STDOUT_LINE_CHARS));
        if (stdoutTail.length > STDOUT_TAIL_LINES) stdoutTail.shift();
      }
      let progress;
      try {
        progress = parseLine(line);
      } catch {
        continue; // a parser must never take the seat down
      }
      if (!progress) continue;
      if (progress.meta) Object.assign(meta, progress.meta);
      const hasCost = typeof progress.cost === 'number';
      if (hasCost) cost = progress.cost;
      const hasNote = typeof progress.note === 'string';
      if (!hasCost && !hasNote) continue;
      store.append('seat-progress', {
        actor: seat,
        cost,
        ...(hasNote && { note: progress.note }),
      });
      if (costCeiling != null && cost > costCeiling && !ceilingHit && !terminatedReason) {
        ceilingHit = true;
        void terminateTree(child);
      }
    }
  });
  // The stream is consumed, not discarded: an unread pipe fills and stalls the
  // child, and the last of it is the evidence a failed seat leaves behind.
  child.stderr.on('data', (chunk) => {
    stderrTail = clipHead(stderrTail + chunk, STDERR_TAIL_CHARS);
  });
  let settled = false;
  const done = new Promise((resolve) => {
    // 'close' (not 'exit'): stdout is fully drained first, so every progress
    // stamp lands before the seat resolves and the run store can close.
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      const tail = evidence(stderrTail, stdoutTail);
      if (terminatedReason) {
        store.append('seat-terminated', { actor: 'daemon', seat, reason: terminatedReason, cost });
        resolve({ terminated: true, reason: terminatedReason, cost, meta });
      } else if (ceilingHit) {
        store.append('seat-failure', {
          actor: 'daemon',
          seat,
          reason: 'cost-ceiling',
          cost,
          costCeiling,
          ...tail,
        });
        resolve({ failed: true, reason: 'cost-ceiling', cost, meta, ...tail });
      } else if (meta.unavailable) {
        // The exit code is not consulted. The same rejection was measured
        // exiting 0 and 1 depending on how the CLI was invoked; the stream
        // said the model refused the work, and that is the whole signal.
        resolve({
          failed: true,
          reason: 'model-unavailable',
          unavailable: meta.unavailable,
          ...(typeof meta.resetsAt === 'number' && { resetsAt: meta.resetsAt }),
          code,
          cost,
          meta,
          ...tail,
        });
      } else if (code === 0) {
        resolve({ failed: false, code, cost, meta });
      } else {
        store.append('seat-failure', {
          actor: 'daemon',
          seat,
          reason: 'exit',
          code,
          signal,
          cost,
          ...tail,
        });
        resolve({ failed: true, reason: 'exit', code, signal, cost, meta, ...tail });
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      const tail = evidence(stderrTail, stdoutTail);
      store.append('seat-failure', {
        actor: 'daemon',
        seat,
        reason: 'spawn',
        error: error.message,
        ...tail,
      });
      resolve({ failed: true, reason: 'spawn', error: error.message, cost, meta, ...tail });
    });
  });
  return {
    done,
    terminate(reason) {
      if (terminatedReason || ceilingHit) return;
      terminatedReason = reason;
      // The reason is recorded before the kill lands, so the stamp the child's
      // close writes is the same one whether the tree kill is quick or slow.
      void terminateTree(child);
    },
  };
}

/**
 * The seat's environment, and how many variables the strip removed.
 *
 * The machine's secrets follow the ability to execute the project's suite and
 * nothing else. A seat that never runs a gate command has no use for a payment
 * or auth credential, and a throwaway adversary tree or a read-only review seat
 * is the last place one should be readable. So every variable whose name
 * matches a configured `secretEnv` pattern is removed before the spawn, for
 * every seat the seat map does not mark `executesSuite`. Only those names go:
 * the CLI still needs its own auth and system environment to run at all, so
 * this is a strip, never an allowlist. Without patterns the environment is
 * exactly what it was before the feature existed, for every seat.
 */
function seatEnv(seat, env, patterns) {
  const base = env ? { ...process.env, ...env } : process.env;
  if (!Array.isArray(patterns) || patterns.length === 0) return { env: base, stripped: 0 };
  if (seatExecutesSuite(seat)) return { env: base, stripped: 0 };
  const kept = {};
  let stripped = 0;
  for (const [name, value] of Object.entries(base)) {
    if (matchesSecret(name, patterns)) stripped++;
    else kept[name] = value;
  }
  return { env: kept, stripped };
}

// A pattern is an environment-variable name: exact (`DATABASE_URL`), or one
// `*` at an end (`STRIPE_*`, `*_TOKEN`), or `*` alone for every name.
// Case-sensitive, because the names are. The instance config refuses any other
// shape, so nothing here can silently match nothing.
function matchesSecret(name, patterns) {
  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
    if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
    return name === pattern;
  });
}

// The failure evidence, omitted whole when the child emitted nothing.
function evidence(stderrTail, stdoutTail) {
  const stderr = stderrTail.trim();
  return {
    ...(stderr.length > 0 && { stderrTail: stderr }),
    ...(stdoutTail.length > 0 && { stdoutTail: [...stdoutTail] }),
  };
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// Keeps the end, not the start: the last thing a dying child says is the part
// that names the cause.
function clipHead(text, max) {
  return text.length > max ? '…' + text.slice(text.length - max + 1) : text;
}

// Only `cost` and `note` cross from a child line into the ledger — a child
// must not be able to shadow envelope fields or invent event payloads.
function parseProgress(line) {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return { cost: parsed.cost, note: parsed.note };
  } catch {
    return null;
  }
}
