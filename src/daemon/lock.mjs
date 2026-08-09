// Single-instance lock. One daemon per home, enforced by a lock file that
// names a live pid. A stale lock (dead pid) is replaced silently — a crash
// must not require manual cleanup.
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

export class LockHeldError extends Error {
  constructor(path, holder) {
    super(`daemon already running (pid ${holder.pid}, lock ${path})`);
    this.holder = holder;
  }
}

export function acquireLock(path, meta = {}) {
  const holder = readLock(path);
  if (holder && pidAlive(holder.pid)) throw new LockHeldError(path, holder);
  const record = { pid: process.pid, startedAt: new Date().toISOString(), ...meta };
  writeFileSync(path, JSON.stringify(record) + '\n');
  return {
    record,
    release() {
      const current = readLock(path);
      if (current && current.pid === process.pid) unlinkSync(path);
    },
  };
}

export function readLock(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // unreadable lock counts as stale
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
