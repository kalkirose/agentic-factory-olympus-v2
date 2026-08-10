// Working-tree operations the lanes use: change detection, commits,
// restore-from-sha, evidence diffs. Commits carry a fixed daemon identity so
// a run never depends on machine-level git config.
import { git } from './git.mjs';

const IDENTITY = [
  '-c',
  'user.name=olympus-daemon',
  '-c',
  'user.email=daemon@olympus.invalid',
  '-c',
  'commit.gpgsign=false',
];

/** Paths changed in the working tree relative to HEAD (staged or not, untracked included). */
export async function changedFiles(tree) {
  const out = await git(['status', '--porcelain'], { cwd: tree });
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let path = line.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4);
    files.push(unquote(path));
  }
  return files;
}

/**
 * Commits every working-tree change. Returns the new sha, or the current
 * HEAD when the tree is clean.
 */
export async function commitAll(tree, message) {
  const changed = await changedFiles(tree);
  if (changed.length > 0) {
    await git(['add', '-A'], { cwd: tree });
    await git([...IDENTITY, 'commit', '-m', message], { cwd: tree });
  }
  return headSha(tree);
}

export async function headSha(tree) {
  return (await git(['rev-parse', 'HEAD'], { cwd: tree })).trim();
}

/**
 * Restores the given path prefixes to their state at `sha`: tracked files
 * checked out, untracked files under the prefixes removed. A prefix with no
 * entries at the sha is tolerated.
 */
export async function restorePaths(tree, sha, prefixes) {
  for (const prefix of prefixes) {
    try {
      await git(['checkout', sha, '--', prefix], { cwd: tree });
    } catch {
      // The sha holds nothing under this prefix; clean still applies.
    }
    await git(['clean', '-fd', '--', prefix], { cwd: tree });
  }
}

/**
 * The working tree's full divergence from HEAD as a patch, new files
 * included, truncated to `limit` characters. Evidence for suite amendment
 * rounds; the tree is disposable, so staging new files is fine.
 */
export async function evidenceDiff(tree, { limit = 8000 } = {}) {
  await git(['add', '-A'], { cwd: tree });
  const out = await git(['diff', '--cached'], { cwd: tree });
  return out.length > limit ? out.slice(0, limit) + '\n[truncated]' : out;
}

/** Files under the given prefixes at a sha. */
export async function filesAt(tree, sha, prefixes) {
  const out = await git(['ls-tree', '-r', '--name-only', sha, '--', ...prefixes], { cwd: tree });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function unquote(path) {
  const match = /^"(.*)"$/.exec(path);
  return match ? match[1] : path;
}
