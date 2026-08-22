// Process lifecycle across platforms. Windows has no process groups a signal
// can address and no parent-child kill semantics, so three POSIX assumptions
// the harness would otherwise make are wrong there. All three corrections live
// here, behind one platform branch, the way `resolveArgv` owns the executable
// branch: off Windows every function below is the behaviour that shipped
// before it existed.
//
// 1. A spawned child joins its parent's console and its parent's console
//    process group. A console control event addressed to the child is
//    delivered to the whole group, the daemon included, and a daemon with no
//    handler for it dies on the spot (measured: exit 0xC000013A,
//    STATUS_CONTROL_C_EXIT). So a seat is given a console of its own that has
//    no window. `windowsHide` is CREATE_NO_WINDOW, the seat's whole descendant
//    tree inherits that console, and neither a window nor a console event can
//    leave it. `detached` is not taken: it is DETACHED_PROCESS, which leaves
//    the seat with no console at all, and every console descendant of a
//    console-less process opens a visible one of its own (ADR-0016).
// 2. `child.kill()` is TerminateProcess on the one process the handle names.
//    A seat is usually `cmd.exe` running a shim (ADR-0013), so the tool itself
//    is a grandchild and survives the kill along with everything it spawned.
//    A deliberate termination therefore kills the tree, not the handle.
// 3. A seat that exits on its own leaves no signal behind for its own
//    descendants. Survivors keep a handle or a working directory inside the
//    run worktree, and Windows refuses to delete a directory anything is
//    sitting in — the `git worktree remove` that follows fails EBUSY. So the
//    workspace release enumerates what is still standing in the workspace and
//    ends it first. The same enumeration, without the kill, is what names the
//    holder in the record of a workspace that survived the release anyway.
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { resolveArgv } from './executable.mjs';

// A sweep root names one run's workspace. Anything shorter or relative would
// match paths outside it, and the sweep kills what it matches — so a root that
// broad is refused rather than run.
const MIN_ROOT_LENGTH = 4;

// How many holders a record names. A leftover with more than a handful of
// processes in it is one story, not ten, and the record is read by a human.
const HOLDER_LIMIT = 10;

/**
 * Spawn options for a seat child, on top of what the caller sets. One shape for
 * every seat: a shim under `cmd.exe` and a directly spawned tool take the same.
 * @param {{platform?: string}} [opts]
 * @returns {object} empty off Windows
 */
export function seatSpawnOptions({ platform = process.platform } = {}) {
  if (platform !== 'win32') return {};
  // CREATE_NO_WINDOW. The seat gets a console of its own with no window on it,
  // the descendants inherit that console instead of opening a visible one, and
  // a console control event stays inside it. The child is not detached and not
  // unref'd: the daemon still waits on it exactly as before.
  return { windowsHide: true };
}

/**
 * Ends a seat the daemon decided to end, and everything it spawned.
 * @param {import('node:child_process').ChildProcess} child
 * @param {{platform?: string, run?: Function}} [opts] injection points for tests
 * @returns {Promise<void>}
 */
export async function terminateTree(child, { platform = process.platform, run = execAsync } = {}) {
  if (platform !== 'win32' || !child.pid) {
    child.kill();
    return;
  }
  // /T takes the descendants with it; /F is required because a console
  // process with no message pump refuses the graceful stop.
  let code = null;
  try {
    ({ code } = await run(...spawnSpec(['taskkill', '/PID', String(child.pid), '/T', '/F'])));
  } catch {
    // taskkill itself could not run; the direct kill still has to happen.
  }
  // taskkill exits nonzero when the pid is already gone, which the direct
  // kill then finds too. Either way the child does not outlive this call.
  if (code !== 0) child.kill();
}

/**
 * Ends every process standing inside a workspace, so the directory can be
 * removed. Best effort by design: what it cannot enumerate or cannot kill
 * surfaces as a failed removal, which the caller already reports.
 * @param {string} root the workspace directory, absolute
 * @param {{platform?: string, run?: Function, self?: number}} [opts]
 * @returns {Promise<{count: number, names: string[], error?: string}>}
 */
export async function sweepPathHolders(
  root,
  { platform = process.platform, run = execAsync, self = process.pid } = {},
) {
  const empty = { count: 0, names: [] };
  const { holders, error } = await pathHolders(root, {
    platform,
    run,
    self,
    limit: Infinity,
    refusal: 'refusing to sweep on an unsafe root',
  });
  if (error) return { ...empty, error };
  if (holders.length === 0) return empty;
  for (const holder of holders) {
    // A tree kill of one holder often takes the next one with it; taskkill
    // then reports a pid it cannot find, which is the intended outcome.
    await run(...spawnSpec(['taskkill', '/PID', String(holder.pid), '/T', '/F'])).catch(() => {});
  }
  return { count: holders.length, names: [...new Set(holders.map((h) => h.name))].sort() };
}

/**
 * The processes standing inside a path, named rather than ended. Same
 * enumeration the sweep runs on, and it kills nothing: this is what a record
 * about a directory nothing would delete is written from.
 *
 * A leftover workspace is the sweep's own failure, so a bare errno on it says
 * only that the condition the sweep exists for is still true. What the
 * operator does next is decided by which process is sitting in the tree — a
 * seat's surviving child, an editor, a scanner — and that is a pid and an
 * image name (ADR-0016). Never throws: a record about a directory is not worth
 * a second failure.
 * @param {string} root the directory, absolute
 * @param {{platform?: string, run?: Function, self?: number, limit?: number,
 *   refusal?: string}} [opts]
 * @returns {Promise<{holders: Array<{pid: number, name: string}>, error?: string}>}
 */
export async function pathHolders(
  root,
  {
    platform = process.platform,
    run = execAsync,
    self = process.pid,
    limit = HOLDER_LIMIT,
    refusal = 'refusing to read the holders of an unsafe root',
  } = {},
) {
  if (platform !== 'win32') return { holders: [] };
  // The Windows rule, whatever host is asking: the branch is what decides,
  // never the platform the check happens to run on.
  if (typeof root !== 'string' || root.length < MIN_ROOT_LENGTH || !win32.isAbsolute(root)) {
    return { holders: [], error: `${refusal}: ${JSON.stringify(root)}` };
  }
  try {
    return { holders: (await listPathHolders(root, { run, self })).slice(0, limit) };
  } catch (error) {
    return { holders: [], error: `could not enumerate: ${error.message}` };
  }
}

/**
 * Processes whose command line or image path sits inside `root`. The path is
 * handed over in the environment, never interpolated into the script, so no
 * path can be read as script.
 */
async function listPathHolders(root, { run, self }) {
  const script = [
    '$root = $env:OLYMPUS_SWEEP_ROOT.ToLowerInvariant()',
    '$self = [int]$env:OLYMPUS_SWEEP_SELF',
    'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne $self -and ((' +
      '$_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($root)) -or (' +
      '$_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().Contains($root))) } | ' +
      'ForEach-Object { "$($_.ProcessId) $($_.Name)" }',
  ].join('; ');
  const spec = spawnSpec(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]);
  const { code, stdout, stderr } = await run(spec[0], spec[1], {
    env: { ...process.env, OLYMPUS_SWEEP_ROOT: root, OLYMPUS_SWEEP_SELF: String(self) },
  });
  if (code !== 0) throw new Error(String(stderr).trim() || `exit ${code}`);
  const holders = [];
  for (const line of String(stdout).split('\n')) {
    const match = /^(\d+)\s+(.+)$/.exec(line.trim());
    if (match) holders.push({ pid: Number(match[1]), name: match[2].trim() });
  }
  return holders;
}

// The host decides which file a tool name stands for here as everywhere else.
function spawnSpec([command, ...args]) {
  const spec = resolveArgv([command, ...args]);
  return [spec.file, spec.args];
}

// Resolves on the exit code rather than rejecting on it: a nonzero taskkill is
// an answer ("no such pid"), not a fault.
function execAsync(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // `windowsHide` is last: no caller can drop it and put a window on screen.
    execFile(file, args, { ...opts, windowsHide: true }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}
