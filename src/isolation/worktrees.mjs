// Run worktrees off the bare clone. Layout under the daemon home:
//   worktrees/<runId>/tree     — the run worktree, on branch run/<runId>
//   worktrees/<runId>/<tag>    — disposable worktrees (adversary waves),
//                                detached at a named sha
// Seats receive absolute paths. The whole <runId> root goes away at run
// close; a disposable goes away when its wave reaches verdict.
import { rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { git } from './git.mjs';

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

/** Creates the run worktree on a fresh run branch off the given base branch. */
export async function addRunWorktree(clone, paths, runId, baseBranch) {
  const path = runWorktreePath(paths, runId);
  await git(['worktree', 'add', '-b', runBranch(runId), path, baseBranch], { cwd: clone });
  return { path, branch: runBranch(runId) };
}

/** Creates a disposable worktree, detached at a sha. */
export async function addDisposableWorktree(clone, paths, runId, tag, sha) {
  const path = join(workspaceRoot(paths, runId), tag);
  await git(['worktree', 'add', '--detach', path, sha], { cwd: clone });
  return path;
}

/** Removes one worktree by path. */
export async function removeWorktree(clone, path) {
  await git(['worktree', 'remove', '--force', path], { cwd: clone });
}

/**
 * Removes every worktree under the run's root, the run branch, and the root
 * directory itself. The run branch dies with the workspace: shipped work
 * lives on the remote, and the archived ledger records the base sha.
 */
export async function removeRunWorktrees(clone, paths, runId) {
  const root = workspaceRoot(paths, runId);
  for (const path of await listWorktrees(clone)) {
    if (isUnder(root, path)) await removeWorktree(clone, path);
  }
  await git(['worktree', 'prune'], { cwd: clone });
  try {
    await git(['branch', '-D', runBranch(runId)], { cwd: clone });
  } catch {
    // The branch may not exist (disposables only, or a partial provision).
  }
  rmSync(root, { recursive: true, force: true });
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
