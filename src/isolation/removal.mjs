// The retry ladder under every workspace removal. A run workspace is a
// checked-out application tree, and on Windows a file inside it can still be
// held when the release reaches it: a build watcher the process sweep did not
// match, an indexer, a scanner. The hold belongs to another process and it
// passes on its own, so a removal waits and asks again instead of reporting a
// workspace it never really tried twice to delete (ADR-0004).
import { rmSync } from 'node:fs';

// Five attempts, with a backoff that grows by 250 ms per attempt: two and a
// half seconds in all. That is the whole budget a close spends on a hold. A
// hold that outlives it becomes a leftover the sweep retries later, never a
// longer wait on the close path.
const ATTEMPTS = 5;
const DELAY_MS = 250;

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
 * Deletes a directory tree through the ladder above.
 * @param {string} path
 * @param {{remove?: Function, attempts?: number, delayMs?: number,
 *   sleep?: (ms: number) => Promise<void>}} [io]
 */
export function removeTree(path, io = {}) {
  const remove = io.remove ?? rmSync;
  return removeWithRetry(() => remove(path, { recursive: true, force: true }), io);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
