// The daemon survives the console that started it (ADR-0050).
//
// The unit half drives the two seams of the start with fakes. The host half
// stages the accident itself: a stand-in shell runs `olympusd start`, the
// whole shell tree is ended the way a console cleanup ends one, and the
// daemon is asked whether it is still there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  awaitDaemonStart,
  daemonLogPaths,
  daemonSpawnOptions,
  logTail,
} from '../src/daemon/launch.mjs';
import { homePaths } from '../src/daemon/home.mjs';
import { pidAlive, readLock } from '../src/daemon/lock.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OLYMPUSD = join(ROOT, 'bin', 'olympusd.mjs');
const ON_WINDOWS = process.platform === 'win32';

// -- the start shape ----------------------------------------------------------

test('the daemon spawn detaches and shows nothing on screen', () => {
  assert.deepEqual(daemonSpawnOptions(), { detached: true, windowsHide: true });
});

// -- what a start waits for ---------------------------------------------------

const noWait = () => Promise.resolve();

test('a start reports success only once the daemon holds the lock', async () => {
  let reads = 0;
  const result = await awaitDaemonStart(
    { lockPath: 'lock', pid: 77 },
    {
      sleep: noWait,
      alive: () => true,
      read: () => (++reads < 3 ? null : { pid: 77, startedAt: 'then' }),
    },
  );
  assert.deepEqual(result, { ok: true, pid: 77, holder: { pid: 77, startedAt: 'then' } });
  assert.equal(reads, 3);
});

test('a lock another instance holds is not this start succeeding', async () => {
  const result = await awaitDaemonStart(
    { lockPath: 'lock', pid: 77 },
    { attempts: 2, sleep: noWait, alive: () => true, read: () => ({ pid: 12 }) },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /did not take the lock/);
});

test('a daemon that exits before the lock ends the wait at once', async () => {
  let asked = 0;
  const result = await awaitDaemonStart(
    { lockPath: 'lock', pid: 77 },
    {
      attempts: 500,
      sleep: noWait,
      alive: () => {
        asked++;
        return false;
      },
      read: () => null,
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /exited before/);
  // No waiting out an attempt count for an answer that was already in.
  assert.equal(asked, 1);
});

test('the log tail answers for a file that is missing or empty', () => {
  const dir = tempDir();
  try {
    assert.equal(logTail(join(dir, 'absent.log')), '');
    writeFileSync(join(dir, 'empty.log'), '\n\n');
    assert.equal(logTail(join(dir, 'empty.log')), '');
    writeFileSync(join(dir, 'full.log'), 'one\ntwo\nthree\n');
    assert.equal(logTail(join(dir, 'full.log'), 2), 'two\nthree');
  } finally {
    removeDir(dir);
  }
});

// -- the accident, on the host ------------------------------------------------

/** A stand-in for the console: it runs one command and then stays open. */
function writeShell(dir) {
  const path = join(dir, 'shell.mjs');
  writeFileSync(
    path,
    `import { spawn } from 'node:child_process';
const [entry, home] = process.argv.slice(2);
spawn(process.execPath, [entry, 'start', '--home', home], { stdio: 'inherit' });
setInterval(() => {}, 1 << 30);
`,
  );
  return path;
}

/**
 * Ends a shell the way a console cleanup ends one, or answers with the reason
 * this host cannot express the accident.
 *
 * Windows records a parent for every process and `taskkill /T` walks it, so
 * the tree is the unit there. Elsewhere the unit is the process group, which
 * the shell leads because the test started it detached.
 */
function killShellTree(child) {
  if (ON_WINDOWS) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      return null;
    } catch (error) {
      return `taskkill did not run: ${error.message}`;
    }
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
    return null;
  } catch (error) {
    return `no process group to signal: ${error.message}`;
  }
}

test('killing the shell that started the daemon leaves the daemon running', async (t) => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const paths = homePaths(home);
  let daemonPid = null;
  t.after(() => {
    // However the assertions went, this test may not leave a daemon behind.
    if (daemonPid !== null && pidAlive(daemonPid)) {
      try {
        process.kill(daemonPid, 'SIGKILL');
      } catch {
        // It went between the question and the signal.
      }
    }
    removeDir(dir);
  });

  const shellPath = writeShell(dir);
  const shell = spawn(process.execPath, [shellPath, OLYMPUSD, home], {
    // Off Windows the shell leads a group of its own, so the kill below
    // addresses a group the daemon has to have left. On Windows the tree is
    // what a cleanup ends, and the kernel records that tree either way.
    ...(ON_WINDOWS ? {} : { detached: true }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const lock = await waitFor(() => readLock(paths.lock), {
    attempts: 300,
    intervalMs: 100,
    label: 'the daemon to take the lock',
  });
  daemonPid = lock.pid;
  assert.ok(pidAlive(daemonPid), 'the daemon should be running before the kill');
  assert.notEqual(daemonPid, shell.pid, 'the start ran the daemon in the shell itself');

  const refused = killShellTree(shell);
  if (refused !== null) {
    t.skip(`this host cannot express a shell-tree kill: ${refused}`);
    return;
  }
  // The shell is this process's own child, so its exit is read from the child
  // handle. A pid check would answer for an unreaped child as if it were live.
  await waitFor(() => shell.exitCode !== null || shell.signalCode !== null, {
    attempts: 100,
    intervalMs: 100,
    label: 'the shell to die',
  });

  // The claim: the daemon outlives the console that started it. Asked more
  // than once, because a process that is going takes a moment to go.
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal(
      pidAlive(daemonPid),
      true,
      `the daemon died with the shell\n${logTail(daemonLogPaths(paths).err)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // And it is a daemon, not a husk: it still holds the lock, and its banner
  // reached the log file the start named instead of the dead console.
  assert.equal(readLock(paths.lock).pid, daemonPid);
  const logs = daemonLogPaths(paths);
  assert.ok(existsSync(logs.out), 'the daemon wrote no output file');
  await waitFor(() => readFileSync(logs.out, 'utf8').includes('olympusd: started'), {
    attempts: 50,
    intervalMs: 100,
    label: 'the daemon banner in the log file',
  });

  // The stop path still reaches it through the control inbox, from a process
  // that had nothing to do with the start.
  execFileSync(process.execPath, [OLYMPUSD, 'stop', '--home', home], { windowsHide: true });
  await waitFor(() => !pidAlive(daemonPid), {
    attempts: 200,
    intervalMs: 100,
    label: 'the daemon to stop on the control command',
  });
});
