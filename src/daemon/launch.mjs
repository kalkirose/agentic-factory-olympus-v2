// The detached start. A daemon a console started must outlive that console:
// an operator closing the terminal, a task runner ending the job the command
// was given in, a tree kill aimed at the shell. All three reach the children
// of that shell, so the daemon may not be one of them (ADR-0050).
//
// `start` therefore spawns the daemon and returns. Off Windows the daemon
// leads a session of its own; on Windows it holds one windowless console of
// its own, which its whole descendant tree inherits (see daemonSpawnOptions
// for why it must not be console-less). Its starting process is gone a moment
// later, so a tree kill of the shell has nothing left to walk to. The two
// streams a foreground daemon writes to the terminal go to files under the
// home instead, which is where a failed start reports from.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive, readLock } from './lock.mjs';

/** The daemon's own two output files, under the home's log directory. */
export function daemonLogPaths(paths) {
  return {
    dir: paths.logs,
    out: join(paths.logs, 'daemon.out.log'),
    err: join(paths.logs, 'daemon.err.log'),
  };
}

/**
 * The spawn shape of the daemon process itself, and the one shape in the
 * harness that leaves the starting shell behind. A seat takes the opposite
 * shape for the opposite reason (ADR-0016): a seat stays attached, because
 * the daemon waits on it and ends it as a tree, while the daemon separates,
 * because nothing that ends the shell may reach it.
 *
 * On Windows this is `CREATE_NO_WINDOW` (`windowsHide`) WITHOUT
 * `DETACHED_PROCESS`. The distinction is load-bearing and was learned live
 * (2026-08-30): a `DETACHED_PROCESS` daemon holds no console, so every
 * console-subsystem descendant that starts without the hide flag makes the
 * system allocate a fresh console session, and a desktop whose default
 * terminal is a windowed host puts each one ON SCREEN. `CREATE_NO_WINDOW`
 * instead gives the daemon one console of its own with no window on it, and
 * every descendant INHERITS that windowless console, so no depth of the tree
 * can put a window on a screen. The shell-survival property is kept either
 * way: the daemon's console is its own, not the shell's, so closing the
 * starting terminal delivers no console control event to it, and the
 * starting process exits a moment later, so a tree kill of the shell has
 * nothing left to walk to. Off Windows it is `setsid` via `detached`: a new
 * session and a new process group, so a signal addressed to the shell's
 * group does not name the daemon.
 */
export function daemonSpawnOptions(platform = process.platform) {
  if (platform === 'win32') return { windowsHide: true };
  return { detached: true };
}

/**
 * Starts the daemon as a detached process and answers with its pid. The
 * caller still has to establish that it came up; `awaitDaemonStart` does that.
 * @param {string} entry the olympusd entry point
 * @param {string} home an absolute daemon home
 * @param {ReturnType<import('./home.mjs').homePaths>} paths
 * @param {{spawnImpl?: Function, env?: object, execPath?: string}} [io]
 */
export function spawnDetachedDaemon(entry, home, paths, io = {}) {
  const { spawnImpl = spawn, env = process.env, execPath = process.execPath } = io;
  const logs = daemonLogPaths(paths);
  mkdirSync(logs.dir, { recursive: true });
  // Appended, never truncated: the log of the instance before this one is the
  // record of how that one ended.
  const out = openSync(logs.out, 'a');
  const err = openSync(logs.err, 'a');
  try {
    // `cwd` is the home and not the caller's directory, so the daemon holds
    // no handle on wherever the command was typed.
    const child = spawnImpl(execPath, [entry, 'run', '--home', home], {
      env,
      cwd: home,
      stdio: ['ignore', out, err],
      ...daemonSpawnOptions(),
    });
    child.unref();
    return { pid: child.pid, logs };
  } finally {
    // The child holds copies of its own; these two would otherwise keep the
    // starting process alive.
    closeSync(out);
    closeSync(err);
  }
}

/**
 * Waits until the started daemon holds the home's lock, or until it is clear
 * that it never will. The lock is the daemon's own statement that it is up,
 * so a start that reports success reports a daemon that took it.
 * @param {{lockPath: string, pid: number}} target
 * @param {object} [io] the seam the unit tests drive
 */
export async function awaitDaemonStart({ lockPath, pid }, io = {}) {
  const { attempts = 300, intervalMs = 100, sleep = wait, alive = pidAlive, read = readLock } = io;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const holder = read(lockPath);
    if (holder && holder.pid === pid) return { ok: true, pid, holder };
    // A daemon that exited without taking the lock refused the start: another
    // instance holds the home, the config is invalid, the entry point threw.
    // Its reason is in the error log, which the caller prints.
    if (!alive(pid)) {
      return { ok: false, pid, holder, reason: 'it exited before it took the lock' };
    }
    await sleep(intervalMs);
  }
  return { ok: false, pid, holder: read(lockPath), reason: 'it did not take the lock in time' };
}

/** The last lines of a log file, for the message of a failed start. */
export function logTail(path, lines = 20) {
  try {
    const text = readFileSync(path, 'utf8').trimEnd();
    return text === '' ? '' : text.split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
