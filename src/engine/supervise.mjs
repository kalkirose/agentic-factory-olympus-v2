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
 * attempt) to the seat-spawned stamp.
 * @param {import('../telemetry/stores.mjs').TelemetryStore} store
 * @param {{seat: string, cmd: string, args?: string[], cwd?: string,
 *   env?: object, costCeiling?: number, parseLine?: (line: string) => object|null,
 *   spawnFields?: object}} opts
 * @returns {{done: Promise<object>, terminate: (reason: string) => void}}
 */
export function superviseSeat(
  store,
  { seat, cmd, args = [], cwd, env, costCeiling, parseLine = parseProgress, spawnFields = {} },
) {
  if (typeof seat !== 'string' || seat.length === 0) throw new Error('supervise requires a seat id');
  if (typeof cmd !== 'string' || cmd.length === 0) throw new Error('supervise requires a cmd');
  store.append('seat-spawned', {
    ...spawnFields,
    actor: 'daemon',
    seat,
    ...(costCeiling != null && { costCeiling }),
  });
  const childEnv = env ? { ...process.env, ...env } : process.env;
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
    // A seat runs in its own process group wherever it can, so nothing aimed
    // at a seat can reach the daemon through it. `windowsVerbatimArguments` is
    // set by the resolver for exactly the commands that run under `cmd.exe`,
    // which are the ones that cannot take it.
    ...seatSpawnOptions({ viaShim: spec.windowsVerbatimArguments === true }),
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
