// Working-tree operations the lanes use: change detection, commits,
// restore-from-sha, evidence diffs. Commits carry a fixed daemon identity so
// a run never depends on machine-level git config.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { isGlobEntry, underEntry } from '../config/project.mjs';
import { git } from './git.mjs';
import { longPath } from './removal.mjs';

const IDENTITY = [
  '-c',
  'user.name=olympus-daemon',
  '-c',
  'user.email=daemon@olympus.invalid',
  '-c',
  'commit.gpgsign=false',
];

/**
 * Paths changed in the working tree relative to HEAD (staged or not,
 * untracked included). `-uall` is load-bearing: git's default collapses a
 * wholly untracked directory to the directory itself, and every caller here
 * judges paths — a gate that sees `scripts/` instead of `scripts/gate.mjs`
 * matches no rule and passes the change through.
 */
export async function changedFiles(tree) {
  const out = await git(['status', '--porcelain', '-uall'], { cwd: tree });
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
 * Restores the given path entries to their state at `sha`: tracked files
 * checked out, untracked files under the entries removed. A glob entry
 * rides git's `:(glob)` pathspec magic; a plain prefix stays a bare
 * pathspec. An entry with nothing at the sha is tolerated.
 *
 * `except` names files the restore leaves alone — the freeze's exclusions
 * (ADR-0019). They ride as `:(exclude,literal)` pathspecs, so an exempt file
 * keeps both its edits and its existence: an untracked one survives the clean.
 * The `literal` magic is what keeps the exclusion to the one file it names: a
 * bare pathspec is also wildmatched, so an exclusion for a path holding `[`
 * would spare every sibling the character class happens to match, and the
 * suite restore would stop covering them.
 */
export async function restorePaths(tree, sha, entries, { except = [] } = {}) {
  const exempt = new Set((except ?? []).map((file) => file.replaceAll('\\', '/')));
  const excludes = [...exempt].map((file) => `:(exclude,literal)${file}`);
  for (const entry of entries) {
    const pathspec = isGlobEntry(entry) ? `:(glob)${entry}` : entry;
    try {
      await git(['checkout', sha, '--', pathspec, ...excludes], { cwd: tree });
    } catch {
      // The sha holds nothing under this entry; the clean still applies.
    }
    if (exempt.size === 0) {
      await git(['clean', '-fd', '--', pathspec], { cwd: tree });
      continue;
    }
    // `clean -d` collapses a wholly untracked directory to the directory
    // itself, and an exclude pathspec inside it does not save its contents —
    // an exempt file in a new directory would go with the directory. So the
    // untracked files are listed and removed one by one instead.
    const others = await git(
      ['ls-files', '--others', '--exclude-standard', '-z', '--', pathspec, ...excludes],
      { cwd: tree },
    );
    for (const file of others.split('\0')) {
      const path = file.trim();
      if (path.length === 0 || exempt.has(path)) continue;
      // git listed this file and git's own clean would have taken it; the
      // delete the restore does instead has to reach as far, so it goes in the
      // extended-length form on Windows exactly as git goes with core.longPaths.
      rmSync(longPath(join(tree, path)), { force: true });
    }
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

/** The committed diff between two shas as a patch, truncated to `limit`. */
export async function diffRange(tree, from, to, { limit = 12000 } = {}) {
  const out = await git(['diff', `${from}..${to}`], { cwd: tree });
  return out.length > limit ? out.slice(0, limit) + '\n[truncated]' : out;
}

/** File paths changed between two shas. */
export async function changedInRange(tree, from, to) {
  const out = await git(['diff', '--name-only', `${from}..${to}`], { cwd: tree });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * File paths the tree's HEAD changes against a base ref, counted from the
 * commit the two last shared. That is the set the forge shows on a request:
 * what the base gained after the branch left it belongs to the base, not to
 * the work under review, so the two-dot range would answer a wider question
 * than the one a request is judged on.
 */
export async function changedAgainstBase(tree, base) {
  const out = await git(['diff', '--name-only', `${base}...HEAD`], { cwd: tree });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Pushes a ref to a remote. `ref` may be `branch` or `HEAD:branch`. `lease`
 * names the sha the remote ref is expected to hold — the push then forces
 * only over that exact value. Never use the bare `--force-with-lease` here:
 * in a bare clone whose fetch refspec writes to `refs/heads/*`, git derives
 * the lease from the local branch itself and rejects every later push.
 */
export async function push(tree, remote, ref, { lease = null } = {}) {
  const flags = lease ? [`--force-with-lease=${ref}:${lease}`] : [];
  await git(['push', ...flags, remote, ref], { cwd: tree });
}

/**
 * Merges a commit into the current branch. Returns the new head on a clean
 * merge; on textual conflicts, the conflicted paths with the merge left in
 * progress (resolve and conclude, or abort).
 * @returns {Promise<{ok: true, sha: string} | {ok: false, conflicts: string[]}>}
 */
export async function mergeIntoTree(tree, sha, message) {
  try {
    await git([...IDENTITY, 'merge', '-m', message, sha], { cwd: tree });
    return { ok: true, sha: await headSha(tree) };
  } catch {
    const conflicts = await conflictedFiles(tree);
    if (conflicts.length === 0) {
      await abortMerge(tree).catch(() => {});
      throw new Error('merge failed without conflicts');
    }
    return { ok: false, conflicts };
  }
}

/** Paths with unmerged index entries. */
export async function conflictedFiles(tree) {
  const out = await git(['diff', '--name-only', '--diff-filter=U'], { cwd: tree });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Concludes an in-progress merge: stage everything, commit. */
export async function concludeMerge(tree, message) {
  await git(['add', '-A'], { cwd: tree });
  await git([...IDENTITY, 'commit', '-m', message], { cwd: tree });
  return headSha(tree);
}

export async function abortMerge(tree) {
  await git(['merge', '--abort'], { cwd: tree });
}

/** Hard-resets the working tree and branch to a sha; untracked files removed. */
export async function resetHard(tree, sha) {
  await git(['reset', '--hard', sha], { cwd: tree });
  await git(['clean', '-fd'], { cwd: tree });
}

/** Files under the given path entries at a sha. */
export async function filesAt(tree, sha, entries) {
  // `ls-tree` takes no glob pathspec magic: with a glob entry present, list
  // the whole tree and filter.
  const paths = entries.some((e) => isGlobEntry(e)) ? [] : entries;
  const out = await git(['ls-tree', '-r', '--name-only', sha, '--', ...paths], { cwd: tree });
  const files = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (paths === entries) return files;
  return files.filter((file) => entries.some((entry) => underEntry(file, entry)));
}

function unquote(path) {
  const match = /^"(.*)"$/.exec(path);
  return match ? match[1] : path;
}
