// Bare clone management. The daemon keeps one bare clone per project under
// the daemon home; every run worktree hangs off it. Fetch discipline: the
// refspec covers the default branch only, fetched with prune at every run
// launch and branch update — the launch reads project config and the branch
// head as they stand on the remote, or it fails. No launch runs on silently
// stale refs. The refspec must never widen to `refs/heads/*`: with prune,
// a wide refspec deletes the local run/* branches of every live run.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.mjs';

/** @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths */
export function cloneDir(paths, project) {
  return join(paths.clones, `${project}.git`);
}

/**
 * Clones the project bare on first use and pins the fetch refspec to the
 * default branch. The refspec is re-pinned on every call, so a clone made
 * under an older (wider) refspec heals itself.
 */
export async function ensureBareClone(paths, project, repoUrl, defaultBranch) {
  if (typeof defaultBranch !== 'string' || defaultBranch.length === 0) {
    throw new Error('ensureBareClone requires the default branch');
  }
  const dir = cloneDir(paths, project);
  if (!existsSync(dir)) {
    // `clone --bare` sets no fetch refspec; without one, fetch updates nothing.
    await git(['clone', '--bare', repoUrl, dir]);
  }
  const refspec = `+refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`;
  await git(['config', 'remote.origin.fetch', refspec], { cwd: dir });
  return dir;
}

/** Fetches branch heads with prune. Failure fails the launch that asked. */
export async function fetchClone(dir) {
  await git(['fetch', '--prune', 'origin'], { cwd: dir });
}

/** Resolves a branch head to its commit sha. */
export async function branchSha(dir, branch) {
  const out = await git(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: dir });
  return out.trim();
}

/**
 * Lists the entry names of one tree (non-recursive) at a branch head in the
 * bare clone. Subdirectories appear as bare names; the frontier reads only
 * the `.md` files at the top level, so an archive subdirectory stays out.
 */
export async function listTreeFiles(dir, branch, path) {
  const out = await git(['ls-tree', '--name-only', `${branch}:${path}`], { cwd: dir });
  return out.split('\n').filter((name) => name.length > 0);
}

/**
 * Reads one file from a branch head in the bare clone. Returns the file text
 * and its git blob id — the blob id names the exact config a run launched
 * with.
 */
export async function readBlobFromBranch(dir, branch, path) {
  const blob = (await git(['rev-parse', `${branch}:${path}`], { cwd: dir })).trim();
  const text = await git(['show', `${branch}:${path}`], { cwd: dir });
  return { blob, text };
}
