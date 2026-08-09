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

/**
 * Spawns and supervises one seat child.
 * @param {import('../telemetry/stores.mjs').TelemetryStore} store
 * @param {{seat: string, cmd: string, args?: string[], cwd?: string,
 *   env?: object, costCeiling?: number}} opts
 * @returns {{done: Promise<object>, terminate: (reason: string) => void}}
 */
export function superviseSeat(store, { seat, cmd, args = [], cwd, env, costCeiling }) {
  if (typeof seat !== 'string' || seat.length === 0) throw new Error('supervise requires a seat id');
  if (typeof cmd !== 'string' || cmd.length === 0) throw new Error('supervise requires a cmd');
  store.append('seat-spawned', { actor: 'daemon', seat, ...(costCeiling != null && { costCeiling }) });
  const child = spawn(cmd, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let cost = 0;
  let buffer = '';
  let terminatedReason = null;
  let ceilingHit = false;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const progress = parseProgress(line);
      if (!progress) continue;
      if (typeof progress.cost === 'number') cost = progress.cost;
      store.append('seat-progress', {
        actor: seat,
        cost,
        ...(typeof progress.note === 'string' && { note: progress.note }),
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
        resolve({ terminated: true, reason: terminatedReason, cost });
      } else if (ceilingHit) {
        store.append('seat-failure', {
          actor: 'daemon',
          seat,
          reason: 'cost-ceiling',
          cost,
          costCeiling,
        });
        resolve({ failed: true, reason: 'cost-ceiling', cost });
      } else if (code === 0) {
        resolve({ failed: false, code, cost });
      } else {
        store.append('seat-failure', { actor: 'daemon', seat, reason: 'exit', code, signal, cost });
        resolve({ failed: true, reason: 'exit', code, signal, cost });
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      store.append('seat-failure', { actor: 'daemon', seat, reason: 'spawn', error: error.message });
      resolve({ failed: true, reason: 'spawn', error: error.message, cost });
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
