// Run worktrees off the bare clone. Layout under the daemon home:
//   worktrees/<runId>/tree     — the run worktree, on branch run/<runId>
//   worktrees/<runId>/<tag>    — disposable worktrees (adversary waves),
//                                detached at a named sha
// Seats receive absolute paths. The whole <runId> root goes away at run
// close; a disposable goes away when its wave reaches verdict.
import { join, resolve, sep } from 'node:path';
import { git } from './git.mjs';
import { removeTree } from './removal.mjs';

/** @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths */
export function workspaceRoot(paths, runId) {
  return join(paths.worktrees, runId);
}

/** @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths */
export function runWorktreePath(paths, runId) {
  return join(workspaceRoot(paths, runId), 'tree');
}

export function runBranch(runId) {
  return `run/${runId}`;
}

/**
 * Creates the run worktree on a fresh run branch off `base` — the default
 * branch at launch, or the frozen commit a resumed run inherits.
 */
export async function addRunWorktree(clone, paths, runId, base) {
  const path = runWorktreePath(paths, runId);
  await git(['worktree', 'add', '-b', runBranch(runId), path, base], { cwd: clone });
  return { path, branch: runBranch(runId) };
}

/** Creates a disposable worktree, detached at a sha. */
export async function addDisposableWorktree(clone, paths, runId, tag, sha) {
  const path = join(workspaceRoot(paths, runId), tag);
  await git(['worktree', 'add', '--detach', path, sha], { cwd: clone });
  return path;
}

/**
 * Removes one worktree by path, and then by hand if git will not.
 *
 * git deletes the tree with its own path handling, and it reports conditions
 * the operating system does not have: "Filename too long" on a tree the
 * extended-length form removes without complaint, "Directory not empty" on a
 * file that was released a moment later. Measured: three closes failed on the
 * first and eight on the second, and in every one of the eight the harness's
 * own delete of the same tree, moments later, succeeded. A removal the OS can
 * perform must not be refused by the tool that asked for it — so a git that
 * will not delete the tree is followed by the harness deleting it, and the
 * `worktree prune` behind the caller drops the registration that leaves.
 *
 * One direct attempt: the caller owns the retry ladder, and a second one
 * nested inside it would multiply the wait a close spends on a hold.
 * @param {string} clone
 * @param {string} path
 * @param {object} [io] the removal seam (see removal.mjs)
 */
export async function removeWorktree(clone, path, io = {}) {
  let refused;
  try {
    await git(['worktree', 'remove', '--force', path], { cwd: clone });
    return;
  } catch (error) {
    refused = error;
  }
  try {
    await removeTree(path, { ...io, attempts: 1 });
  } catch (error) {
    throw new Error(`${refused.message}; direct removal: ${error.message}`);
  }
}

/**
 * Removes every worktree under the run's root, the root directory itself,
 * and — unless `keepBranch` — the run branch. A shipped run's work lives on
 * the remote, so its branch dies with the workspace. A run that closed any
 * other way pushed nothing: its branch holds the only copy of its frozen
 * suite, and a later launch can inherit that freeze.
 */
export async function removeRunWorktrees(
  clone,
  paths,
  runId,
  { keepBranch = false, io = {} } = {},
) {
  const root = workspaceRoot(paths, runId);
  for (const path of await listWorktrees(clone)) {
    if (isUnder(root, path)) await removeWorktree(clone, path, io);
  }
  // Runs whether or not a removal above went by hand: a tree git did not take
  // itself leaves a registration only the prune clears, and the branch delete
  // below is refused for as long as a registration claims it.
  await git(['worktree', 'prune'], { cwd: clone });
  if (!keepBranch) {
    try {
      await git(['branch', '-D', runBranch(runId)], { cwd: clone });
    } catch {
      // The branch may not exist (disposables only, or a partial provision).
    }
  }
  await removeTree(root, { ...io, attempts: 1 });
}

/** Lists registered worktree paths, the bare repo itself included. */
export async function listWorktrees(clone) {
  const out = await git(['worktree', 'list', '--porcelain'], { cwd: clone });
  return out
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
}

function isUnder(root, path) {
  let base = resolve(root);
  let candidate = resolve(path);
  if (process.platform === 'win32') {
    base = base.toLowerCase();
    candidate = candidate.toLowerCase();
  }
  return candidate === base || candidate.startsWith(base + sep);
}
