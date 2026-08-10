// Bare clone management. The daemon keeps one bare clone per project under
// the daemon home; every run worktree hangs off it. Fetch discipline: a
// heads-only refspec with prune, fetched at every run launch — the launch
// reads project config and branch heads as they stand on the remote, or it
// fails. No launch runs on silently stale refs.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.mjs';

/** @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths */
export function cloneDir(paths, project) {
  return join(paths.clones, `${project}.git`);
}

/**
 * Clones the project bare on first use and pins the fetch refspec to branch
 * heads. Idempotent; an existing clone is returned as is.
 */
export async function ensureBareClone(paths, project, repoUrl) {
  const dir = cloneDir(paths, project);
  if (!existsSync(dir)) {
    await git(['clone', '--bare', repoUrl, dir]);
    // `clone --bare` sets no fetch refspec; without one, fetch updates nothing.
    await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'], { cwd: dir });
  }
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
 * Reads one file from a branch head in the bare clone. Returns the file text
 * and its git blob id — the blob id names the exact config a run launched
 * with.
 */
export async function readBlobFromBranch(dir, branch, path) {
  const blob = (await git(['rev-parse', `${branch}:${path}`], { cwd: dir })).trim();
  const text = await git(['show', `${branch}:${path}`], { cwd: dir });
  return { blob, text };
}
