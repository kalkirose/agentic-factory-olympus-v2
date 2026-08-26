// The retry ladder under every workspace removal, and the path form the
// removals take. A run workspace is a checked-out application tree, and on
// Windows a file inside it can still be held when the release reaches it: a
// build watcher the process sweep did not match, an indexer, a scanner. The
// hold belongs to another process and it passes on its own, so a removal waits
// and asks again instead of reporting a workspace it never really tried twice
// to delete (ADR-0004).
import { rmSync } from 'node:fs';
import { win32 } from 'node:path';

// Five attempts, with a backoff that grows by 250 ms per attempt: two and a
// half seconds of waiting between whole-tree attempts. A hold that outlives the
// ladder becomes a leftover the sweep retries later, never a longer wait on the
// close path.
const ATTEMPTS = 5;
const DELAY_MS = 250;

// The same idea one level down. `rm -r` walks the tree itself and gives up at
// the first entry it cannot take, so without a budget of its own a hold on one
// file throws away a walk of a whole checked-out application — a run worktree
// carries a node_modules — and the ladder above starts that walk again from the
// top. These two retries are spent on the one entry that refused, which is
// where a hold that passes actually passes. Node grows the wait between them
// the way this module does, so a refused entry adds 300 ms to each attempt of
// the ladder above, and a close spends about four seconds on a hold in all.
const WALK_RETRIES = 2;
const WALK_DELAY_MS = 100;

// What a passing hold answers with. Windows names one hold any of several
// ways, depending on which layer refused it, and git reports the same
// conditions in prose, because a failed `worktree remove` reaches the caller as
// git's stderr rather than as an errno. Every other answer — a path that is no
// worktree, a repository that is not there — is one a second attempt cannot
// change, and spending the ladder on it would only delay the report.
const RETRYABLE = [
  'eperm',
  'eacces',
  'ebusy',
  'enotempty',
  'access is denied',
  'permission denied',
  'directory not empty',
  'used by another process',
  'resource busy',
];

// A fully qualified Windows path: a drive, or a UNC share. Only those two take
// the extended-length prefix; a rooted path with no drive on it (`\tree`) is
// resolved against the current drive by the OS and cannot carry one.
const DRIVE = /^[a-zA-Z]:[\\/]/;
const UNC = /^[\\/]{2}[^\\/?.]/;

/**
 * The form a path is handed to the filesystem in. On Windows a removal of a
 * path over 260 characters is refused before it reaches the disk, and a run
 * worktree nests a run id, a workspace and a project's own tree under the
 * daemon home — node_modules alone clears the ceiling. The extended-length
 * prefix lifts it, and `rm -r` inherits it for every path it builds below the
 * one it is given, so the whole tree is removable from the root down.
 *
 * The harness's git already carries `core.longPaths` at every invocation, and
 * this is the same statement for the removals the harness performs itself: a
 * deletion the OS can do must not fail on the length of its own path.
 *
 * Off Windows, and for a path that is already prefixed or is not fully
 * qualified, the answer is the path that came in.
 * @param {string} path
 * @param {string} [platform]
 * @returns {string}
 */
export function longPath(path, platform = process.platform) {
  if (platform !== 'win32' || typeof path !== 'string') return path;
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\')) return path;
  if (!DRIVE.test(path) && !UNC.test(path)) return path;
  // The prefix turns off path parsing, so the path must already be in the form
  // the filesystem takes: backslashes, no `.` and no `..` left in it.
  const full = win32.normalize(path);
  return UNC.test(full) ? `\\\\?\\UNC\\${full.slice(2)}` : `\\\\?\\${full}`;
}

/**
 * Whether a failed removal is worth asking again.
 * @param {unknown} error
 */
export function isRetryableRemoval(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? error ?? ''}`.toLowerCase();
  return RETRYABLE.some((phrase) => text.includes(phrase));
}

/**
 * Runs a removal until it lands, until an answer arrives that a retry cannot
 * change, or until the attempts are spent. The caller sees the last failure.
 * @param {() => Promise<unknown>|unknown} remove
 * @param {{attempts?: number, delayMs?: number,
 *   sleep?: (ms: number) => Promise<void>}} [io] the ladder's seam. A held file
 *   is a real condition no portable test can stage, so the wait and the call
 *   the hold breaks are injectable.
 * @returns {Promise<{attempts: number}>}
 */
export async function removeWithRetry(remove, io = {}) {
  const { attempts = ATTEMPTS, delayMs = DELAY_MS, sleep = wait } = io;
  for (let attempt = 1; ; attempt++) {
    try {
      await remove();
      return { attempts: attempt };
    } catch (error) {
      if (attempt >= attempts || !isRetryableRemoval(error)) throw error;
      await sleep(delayMs * attempt);
    }
  }
}

/**
 * Deletes a directory tree through the ladder above, in the path form the
 * platform accepts, and with a retry budget inside the walk as well as around
 * it.
 * @param {string} path
 * @param {{remove?: Function, platform?: string, attempts?: number,
 *   delayMs?: number, sleep?: (ms: number) => Promise<void>}} [io]
 */
export function removeTree(path, io = {}) {
  const remove = io.remove ?? rmSync;
  const target = longPath(path, io.platform ?? process.platform);
  return removeWithRetry(
    () =>
      remove(target, {
        recursive: true,
        force: true,
        maxRetries: WALK_RETRIES,
        retryDelay: WALK_DELAY_MS,
      }),
    io,
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
