import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLock, readLock, LockHeldError } from '../src/daemon/lock.mjs';
import { tempDir, removeDir } from './helpers.mjs';

test('acquire, refuse second, release', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const path = join(dir, 'daemon.lock');
  const lock = acquireLock(path);
  assert.equal(readLock(path).pid, process.pid);
  assert.throws(() => acquireLock(path), LockHeldError);
  lock.release();
  assert.ok(!existsSync(path));
});

test('a stale lock from a dead pid is replaced', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const path = join(dir, 'daemon.lock');
  // A short-lived child gives a pid that is certainly dead.
  const child = spawnSync(process.execPath, ['-e', '']);
  writeFileSync(path, JSON.stringify({ pid: child.pid ?? 999999999, startedAt: 'x' }));
  const lock = acquireLock(path);
  assert.equal(readLock(path).pid, process.pid);
  lock.release();
});

test('an unreadable lock counts as stale', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const path = join(dir, 'daemon.lock');
  writeFileSync(path, 'garbage');
  const lock = acquireLock(path);
  assert.equal(readLock(path).pid, process.pid);
  lock.release();
});
