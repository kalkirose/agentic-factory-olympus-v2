// Child supervision for seat processes. The child's stdout carries JSON
// progress lines; `cost` on a line is the cumulative cost to date. The cost
// ceiling is a guardrail, never a liveness detector: a generous limit that
// terminates the child and records a seat-failure event on breach.
//
// Stamp semantics:
//   seat-failure    — the seat failed: nonzero exit, spawn error, or a cost
//                     ceiling breach.
//   seat-terminated — the orchestrator ended the seat deliberately (run kill,
//                     daemon stop); not a failure of the seat.
import { spawn } from 'node:child_process';
import { resolveArgv } from './executable.mjs';

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
    ...(spec.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
  });
  let cost = 0;
  let buffer = '';
  let terminatedReason = null;
  let ceilingHit = false;
  const meta = {};
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
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
        child.kill();
      }
    }
  });
  child.stderr.resume();
  let settled = false;
  const done = new Promise((resolve) => {
    // 'close' (not 'exit'): stdout is fully drained first, so every progress
    // stamp lands before the seat resolves and the run store can close.
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
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
        });
        resolve({ failed: true, reason: 'cost-ceiling', cost, meta });
      } else if (code === 0) {
        resolve({ failed: false, code, cost, meta });
      } else {
        store.append('seat-failure', { actor: 'daemon', seat, reason: 'exit', code, signal, cost });
        resolve({ failed: true, reason: 'exit', code, signal, cost, meta });
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      store.append('seat-failure', { actor: 'daemon', seat, reason: 'spawn', error: error.message });
      resolve({ failed: true, reason: 'spawn', error: error.message, cost, meta });
    });
  });
  return {
    done,
    terminate(reason) {
      if (terminatedReason || ceilingHit) return;
      terminatedReason = reason;
      child.kill();
    },
  };
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
