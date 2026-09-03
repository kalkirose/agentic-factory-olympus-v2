// Working-tree operations the lanes use: change detection, commits,
// restore-from-sha, evidence diffs. Commits carry a fixed daemon identity so
// a run never depends on machine-level git config.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_DIFF_EXCLUSIONS,
  DEFAULT_EXCERPT_CHARS,
  isGlobEntry,
  underEntry,
} from '../config/project.mjs';
import { MAX_DIFF_BYTES, git, gitCapped } from './git.mjs';
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
 * Carries one commit's version of a path set onto the tree as it stands: the
 * files `sha` changed since it last shared a commit with HEAD, and only those.
 *
 * A restore answers "what did `sha` hold?" for every path under the entries,
 * so it decides the content of files `sha` never touched. Where the tree is on
 * `sha`'s own line of history that is the same answer either way. Where it is
 * not — a tree reset onto a default branch that moved under it — the restore
 * reverts everything that branch advanced under the entries, silently and over
 * source files the reset left current (ADR-0033). So this carries the
 * difference `sha` authored instead of the tree `sha` had: a file `sha` added
 * or changed takes `sha`'s version, a file `sha` deleted goes, and a file `sha`
 * never touched keeps the version the tree holds.
 *
 * `except` names files the carry leaves alone — the freeze's exclusions
 * (ADR-0019), exactly as a restore leaves them.
 *
 * This composes; it does not void. Untracked files under the entries stay,
 * because the caller that composes is the one that just reset the tree and has
 * nothing to void.
 */
export async function carryPaths(tree, sha, entries, { except = [] } = {}) {
  const exempt = new Set((except ?? []).map((file) => file.replaceAll('\\', '/')));
  const base = (await git(['merge-base', 'HEAD', sha], { cwd: tree })).trim();
  // `--no-renames` keeps every record two fields wide: a rename reads as the
  // deletion and the addition it is, and the parse below stays a pair walk.
  const out = await git(['diff', '--name-status', '--no-renames', '-z', base, sha], { cwd: tree });
  const fields = out.split('\0').filter((field) => field.length > 0);
  const take = [];
  const drop = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const file = fields[i + 1];
    if (exempt.has(file)) continue;
    if (!entries.some((entry) => underEntry(file, entry))) continue;
    (fields[i] === 'D' ? drop : take).push(file);
  }
  if (take.length > 0) {
    // `:(literal)` for the same reason the exclusions carry it: a bare
    // pathspec is wildmatched, and a file whose name holds `[` would reach
    // its siblings.
    await git(['checkout', sha, '--', ...take.map((file) => `:(literal)${file}`)], { cwd: tree });
  }
  for (const file of drop) rmSync(longPath(join(tree, file)), { force: true });
}

/**
 * The working tree's full divergence from HEAD as a patch, new files
 * included, truncated to `limit` characters. Evidence for suite amendment
 * rounds; the tree is disposable, so staging new files is fine.
 *
 * The read carries the diff cap, so a tree holding a lockfile or a build
 * artifact answers short instead of throwing at the caller.
 */
export async function evidenceDiff(tree, { limit = 8000 } = {}) {
  await git(['add', '-A'], { cwd: tree });
  const read = await gitCapped(['diff', '--cached'], { cwd: tree });
  return read.text.length > limit ? read.text.slice(0, limit) + '\n[truncated]' : read.text;
}

/**
 * The committed diff between two shas, written whole to `path` and excerpted
 * for the brief that goes with it.
 *
 * Four things separate this from a plain range diff, and each is a rule about
 * what a judgment seat should be reading.
 *
 * The whole diff goes to a file. A story's diff is larger than a prompt, and a
 * seat handed the first `excerptChars` of one judges the work it can see and
 * says nothing about the rest. So the file is the diff and the brief is the
 * way in: the caller names the file to the seat, and the seat reads it. The
 * write happens here, before the caller can spawn anything, so no seat is ever
 * pointed at a file that does not exist yet.
 *
 * The patch leaves out the paths in `exclude` — lockfiles and generated files
 * by default (see DEFAULT_DIFF_EXCLUSIONS). Those files are named to the seat
 * instead, one `git diff --stat` line each, so the seat knows they changed and
 * by how much without spending its window on them. The file holds the filtered
 * diff, not the raw one: the excerpt and the file are the same text. Name-status
 * reads answer about every path and are untouched by this: what a file set is
 * derived from stays the whole file set.
 *
 * The read carries the diff cap (`cap`), so a patch larger than the runner's
 * default is a short answer rather than a throw at the caller. A throw here is
 * a throw in a stage handler, which the engine reads as a liveness violation,
 * which leaves a run inert over the size of a file.
 *
 * `truncated` is that cap and nothing else: the file itself is short, and the
 * work past it is nowhere. The caller takes it out to the ledger, because a
 * seat that could not reach the end of a diff and a seat that could read the
 * same afterwards otherwise. An excerpt shorter than the diff is not
 * truncation. The rest is in the file, and `partial` is the word for it.
 *
 * @returns {Promise<{text: string, path: string, bytes: number, files: number,
 *   chars: number, partial: boolean, truncated: boolean, excluded: string[]}>}
 */
export async function reviewDiff(
  tree,
  from,
  to,
  {
    path,
    excerptChars = DEFAULT_EXCERPT_CHARS,
    cap = MAX_DIFF_BYTES,
    exclude = DEFAULT_DIFF_EXCLUSIONS,
  } = {},
) {
  // The file is the diff. A caller with nowhere to put it would get an excerpt
  // and a brief that could only point at itself, which is the defect this
  // function exists to close, so it is refused at the call instead.
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('reviewDiff needs a path to write the whole diff to');
  }
  const range = `${from}..${to}`;
  const changed = await changedInRange(tree, from, to);
  const entries = exclude ?? DEFAULT_DIFF_EXCLUSIONS;
  const { pathspec, excluded } = await exclusions(tree, range, changed, entries);
  const read = await gitCapped(['diff', range, ...pathspec], { cwd: tree, maxBuffer: cap });
  const whole = read.text;
  mkdirSync(dirname(path), { recursive: true });
  // The patch text and nothing else. A note appended here would be a note
  // inside a file the seat reads as a patch, and so does every other reader:
  // an operator, an editor, `git apply`.
  writeFileSync(path, whole);
  const partial = whole.length > excerptChars;
  const excerpt = partial ? whole.slice(0, excerptChars) : whole;
  const parts = [excerpt];
  if (partial) parts.push(excerptEndLine(excerpt, path));
  if (read.truncated) parts.push(capLine(whole, changed, excluded, cap));
  if (excluded.length > 0) parts.push(await excludedStat(tree, range, excluded));
  return {
    text: parts.join('\n'),
    path,
    bytes: Buffer.byteLength(whole),
    // The files whose patch text is in the file: what changed, minus what the
    // exclusions held back. The excluded paths are named below the excerpt
    // under their own heading, and counting them here would tell the seat to
    // look in the file for text that is not in it.
    files: changed.length - excluded.length,
    chars: excerpt.length,
    partial,
    truncated: read.truncated,
    excluded,
  };
}

/** How many unshown file names the cap line prints before it stops. */
const TRUNCATION_NAMES = 20;

/**
 * The characters one exclusion list may spend on the command line. The
 * smallest limit the harness runs under is Windows' 32767 per command line,
 * and the rest of the argv needs room inside it.
 */
const PATHSPEC_BUDGET = 24_000;

/**
 * The pathspec that keeps the excluded paths out of the patch, and the paths
 * it keeps out. A list that is all exclusions means the whole tree minus them.
 *
 * Naming the concrete paths is the exact form: they are matched here, in the
 * harness's own glob vocabulary, so a project writes one entry and every reader
 * of it gives the same answer. A set large enough to overrun the command line
 * would make the read throw, and a throw in a stage handler is the defect this
 * whole function exists to close, so past the budget the entries go to git as
 * patterns and git does the matching. The names then come back from git as
 * well, off a `--name-only` read under the same pathspec: what the seat is told
 * is missing is exactly what git held back, in either form.
 */
async function exclusions(tree, range, changed, entries) {
  const excluded = changed.filter((file) => entries.some((entry) => underEntry(file, entry)));
  if (excluded.length === 0) return { pathspec: [], excluded };
  const literal = excluded.map((file) => `:(exclude,literal)${file}`);
  if (literal.join(' ').length <= PATHSPEC_BUDGET) {
    return { pathspec: ['--', ...literal], excluded };
  }
  const patterns = entries.map((entry) =>
    isGlobEntry(entry)
      ? `:(exclude,glob)${entry}`
      : `:(exclude,literal)${entry.replace(/\/+$/, '')}`,
  );
  const pathspec = ['--', ...patterns];
  const kept = new Set(
    (await git(['diff', '--name-only', range, ...pathspec], { cwd: tree, maxBuffer: MAX_DIFF_BYTES }))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  return { pathspec, excluded: changed.filter((file) => !kept.has(file)) };
}

/**
 * The one line an excerpt ends on: where the brief stops, and where the diff
 * carries on. It repeats the path the brief already named, because this is the
 * end of the text the seat is reading and a reader who has arrived here is
 * looking for the next thing to read.
 */
function excerptEndLine(excerpt, path) {
  return `[excerpt ends at ${excerpt.length} characters; the whole diff is at ${path}]`;
}

/**
 * The one line a cut diff file ends on: where the read stopped, and which
 * files are therefore in neither the file nor the excerpt. A file counts as
 * present when its own patch header is in the text that survived; the header
 * is what a reader of the patch would look for, so this counts exactly what
 * the seat can find.
 */
function capLine(whole, changed, excluded, cap) {
  const held = new Set(excluded);
  const missing = changed.filter(
    (file) => !held.has(file) && !whole.includes(`diff --git a/${file} `),
  );
  const names = missing.slice(0, TRUNCATION_NAMES).join(', ');
  const more = missing.length > TRUNCATION_NAMES ? ', ...' : '';
  return (
    `[the diff file stopped at the ${cap}-byte read cap, ${whole.length} bytes in; ` +
    `${missing.length} files are in neither it nor this excerpt: ${names}${more}]`
  );
}

/**
 * The `--stat` lines of the excluded paths alone, under the seat's heading.
 *
 * The paths are asked for in batches, because a list long enough to overrun
 * the command line would throw and this runs inside a stage handler. A batch
 * of positive pathspecs is a subset of the answer, so the batches concatenate.
 */
async function excludedStat(tree, range, excluded) {
  const lines = [];
  for (const batch of batched(excluded, PATHSPEC_BUDGET)) {
    const out = await git(
      ['diff', '--stat', range, '--', ...batch.map((file) => `:(literal)${file}`)],
      { cwd: tree, maxBuffer: MAX_DIFF_BYTES },
    );
    // git closes a `--stat` with its own summary line; the per-file lines are
    // the ones that name a path, and the summary would read as a file that
    // changed.
    for (const line of out.split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed.includes('|')) lines.push(trimmed);
    }
  }
  return ['Changed, and not shown above (lockfiles and generated files):', ...lines].join('\n');
}

/** Splits paths into runs no wider than `budget` characters of pathspec. */
function* batched(paths, budget) {
  let batch = [];
  let width = 0;
  for (const path of paths) {
    const cost = path.length + 12;
    if (batch.length > 0 && width + cost > budget) {
      yield batch;
      batch = [];
      width = 0;
    }
    batch.push(path);
    width += cost;
  }
  if (batch.length > 0) yield batch;
}

/**
 * File paths changed between two shas. The read carries the diff cap for the
 * reason every read here does: its size follows the work, and a name list past
 * the runner's default would throw inside the stage handler that asked for it.
 */
export async function changedInRange(tree, from, to) {
  const out = await git(['diff', '--name-only', `${from}..${to}`], {
    cwd: tree,
    maxBuffer: MAX_DIFF_BYTES,
  });
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
  const out = await git(['diff', '--name-only', `${base}...HEAD`], {
    cwd: tree,
    maxBuffer: MAX_DIFF_BYTES,
  });
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

/**
 * Replays one commit onto the current head, three-way. Returns the new head on
 * a clean replay; on anything else, the conflicted paths and git's own reason,
 * with the replay backed out and the tree left where it was.
 *
 * Three-way rather than a checkout of the commit's own file versions: the
 * caller replays machine edits onto a head somebody else just wrote, and a
 * checkout would silently take that person's work back. A conflict is the
 * honest answer to two edits of one file, and the caller records it as the miss
 * it is (ADR-0063).
 * @returns {Promise<{ok: true, sha: string} | {ok: false, conflicts: string[], cause: string}>}
 */
export async function cherryPick(tree, sha) {
  try {
    await git([...IDENTITY, 'cherry-pick', sha], { cwd: tree });
    return { ok: true, sha: await headSha(tree) };
  } catch (error) {
    const conflicts = await conflictedFiles(tree).catch(() => []);
    await git(['cherry-pick', '--abort'], { cwd: tree }).catch(() => {});
    return {
      ok: false,
      conflicts,
      cause:
        conflicts.length > 0
          ? `the replay conflicts in ${conflicts.join(', ')}`
          : error.message,
    };
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

/**
 * Every tracked path at a sha, or in the working tree's index when the sha is
 * null. The spec lint reads it to tell a path the tree holds from one the spec
 * invented (ADR-0067). NUL-separated, so a bracket or a parenthesis in a route
 * directory arrives as itself and not as a quoted escape.
 */
export async function treeFiles(tree, sha) {
  const args = sha ? ['ls-tree', '-r', '--name-only', '-z', sha] : ['ls-files', '-z'];
  const out = await git(args, { cwd: tree, maxBuffer: MAX_DIFF_BYTES });
  return out.split('\0').filter((line) => line.length > 0);
}

/**
 * The tracked files under the given path entries that hold a literal string,
 * at a sha or in the working tree when the sha is null. A glob entry rides
 * git's `:(glob)` pathspec magic like every other read here; a plain prefix
 * stays a bare pathspec. Binary files are skipped, and "nothing found" is the
 * empty list, which git reports as exit status 1 rather than as output.
 */
export async function filesMentioning(tree, sha, needle, entries) {
  const pathspecs = entries.map((e) => (isGlobEntry(e) ? `:(glob)${e}` : e));
  const args = ['grep', '-l', '-F', '-I', '-z', '-e', needle, ...(sha ? [sha] : []), '--', ...pathspecs];
  let out;
  try {
    out = await git(args, { cwd: tree, maxBuffer: MAX_DIFF_BYTES });
  } catch (error) {
    if (error.exitCode === 1) return [];
    throw error;
  }
  return out
    .split('\0')
    .filter((line) => line.length > 0)
    .map((line) => (sha && line.startsWith(`${sha}:`) ? line.slice(sha.length + 1) : line));
}

function unquote(path) {
  const match = /^"(.*)"$/.exec(path);
  return match ? match[1] : path;
}
