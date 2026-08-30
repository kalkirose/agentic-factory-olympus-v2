// Run worktrees off the bare clone. Layout under the daemon home:
//   worktrees/<runId>/tree     — the run worktree, on branch run/<runId>
//   worktrees/<runId>/<tag>    — disposable worktrees (adversary waves),
//                                detached at a named sha
// Seats receive absolute paths. The whole <runId> root goes away at run
// close; a disposable goes away when its wave reaches verdict.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { git } from './git.mjs';
import { removeTree } from './removal.mjs';

/**
 * The directory a run's commands keep a cache in, at the top of the run
 * worktree (ADR-0048). One per run, so a cycle reuses what the cycle before it
 * built and a new run starts cold: the worktree is created at provision and
 * deleted at close, and the cache has exactly that life without anything
 * sweeping it.
 */
export const RUN_CACHE_DIRNAME = '.olympus-cache';

/** The environment variable the commands of a run read that directory from. */
export const RUN_CACHE_ENV = 'OLYMPUS_CACHE_DIR';

/** @param {string} worktree the run worktree */
export function runCacheDir(worktree) {
  return join(worktree, RUN_CACHE_DIRNAME);
}

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
export async function addRunWorktree(clone, paths, runId, base, { io = {} } = {}) {
  const path = runWorktreePath(paths, runId);
  const branch = runBranch(runId);
  await addWorktree(clone, paths, runId, path, {
    add: ['worktree', 'add', '-b', branch, path, base],
    // Residue of this run's own crash carries the branch as well as the
    // directory, and `-b` refuses a branch that exists. `-B` resets it to the
    // base, which is what a recreation means.
    recreate: ['worktree', 'add', '-B', branch, path, base],
    io,
  });
  return { path, branch };
}

/** Creates a disposable worktree, detached at a sha. */
export async function addDisposableWorktree(clone, paths, runId, tag, sha, { io = {} } = {}) {
  const path = join(workspaceRoot(paths, runId), tag);
  const argv = ['worktree', 'add', '--detach', path, sha];
  await addWorktree(clone, paths, runId, path, { add: argv, recreate: argv, io });
  return path;
}

// The line the clone's own exclude file carries, anchored at the top of a
// worktree so it can only ever name the harness's own directory.
const CACHE_EXCLUDE = `/${RUN_CACHE_DIRNAME}/`;

/**
 * Makes the run cache invisible to git, and creates it (ADR-0048).
 *
 * The cache lives inside the worktree, and the candidate capture commits that
 * worktree with `git add -A`: without this the first cycle's cache would be
 * committed to the run branch and pushed in the request. The exclusion goes in
 * the clone's own `info/exclude`, which every worktree of that clone reads and
 * which is the harness's file in the harness's clone, so nothing in the
 * project repository is touched and no commit is needed to hold it. Idempotent,
 * and the caller holds the clone lock.
 *
 * @param {string} clone the bare clone
 * @param {string} worktree the run worktree
 */
export function excludeRunCache(clone, worktree) {
  const exclude = join(clone, 'info', 'exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  let held = '';
  try {
    held = readFileSync(exclude, 'utf8');
  } catch {
    // No exclude file yet: the append below writes the first line of one.
  }
  if (!held.split(/\r?\n/).includes(CACHE_EXCLUDE)) {
    appendFileSync(exclude, (held === '' || held.endsWith('\n') ? '' : '\n') + CACHE_EXCLUDE + '\n');
  }
  mkdirSync(runCacheDir(worktree), { recursive: true });
  return runCacheDir(worktree);
}

// -- creating a worktree over this run's own crash residue --------------------

/**
 * The bound on everything below. A recreation deletes a directory, so the only
 * directory it may ever be pointed at is one this run made for itself: a path
 * strictly inside the run's own workspace root. The shared checkout, the bare
 * clone, another run's workspace and the workspace root itself are all outside
 * that, and a caller that names one of them is refused before anything is read
 * or deleted.
 *
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {string} runId
 * @param {string} path
 * @returns {string} the path, so callers can guard and use in one expression
 */
export function assertInRunWorkspace(paths, runId, path) {
  const root = workspaceRoot(paths, runId);
  if (!isStrictlyUnder(root, path)) {
    throw new Error(`refusing to touch ${path}: it is not inside the run workspace ${root}`);
  }
  return path;
}

// What git answers with when the path or the branch of a worktree it is asked
// to create is already spoken for. Every one of them is a statement about
// residue rather than about the request, and every one of them is cleared by
// removing the directory and pruning the registration.
const RESIDUE = [
  'already exists',
  'already registered',
  'already used by worktree',
  'already checked out',
  'missing but locked worktree',
];

/**
 * Whether a failed `worktree add` failed on residue rather than on the request
 * itself.
 * @param {unknown} error
 */
export function isWorktreeResidue(error) {
  const text = String(error?.message ?? error ?? '').toLowerCase();
  return RESIDUE.some((phrase) => text.includes(phrase));
}

/**
 * Deletes one of this run's worktree paths and every trace git holds of it:
 * the directory, and the registration that outlives a directory git did not
 * remove itself. Bounded by `assertInRunWorkspace`.
 */
export async function clearWorktreeResidue(clone, paths, runId, path, io = {}) {
  assertInRunWorkspace(paths, runId, path);
  try {
    await git(['worktree', 'remove', '--force', path], { cwd: clone });
  } catch {
    // git refuses a path it never registered, and it refuses removals the
    // operating system performs without complaint (ADR-0004). The delete
    // below is the answer to both, and the prune drops what git leaves.
  }
  await removeTree(path, io);
  await git(['worktree', 'prune'], { cwd: clone });
}

/**
 * Creates a worktree at a path inside the run's workspace, over whatever the
 * run left there before.
 *
 * A stage step that crashed between creating its worktree and using it leaves
 * a directory, a registration, or both. Neither is work: the tree was never
 * read and nothing was written to it. So the retry of that step treats them as
 * its own residue and clears them, and a crash stops being a wedge that only a
 * person can clear. The clearing runs before the add as well as after a failed
 * one: the state is readable, so the ordinary case never depends on matching
 * the words of an error message, and the message match stays as the answer to
 * a state that changed between the read and the add.
 *
 * Nothing outside the run's own workspace root can be reached from here.
 */
async function addWorktree(clone, paths, runId, path, { add, recreate, io = {} }) {
  assertInRunWorkspace(paths, runId, path);
  if (existsSync(path) || (await isRegisteredWorktree(clone, path))) {
    await clearWorktreeResidue(clone, paths, runId, path, io);
    await git(recreate, { cwd: clone });
    return path;
  }
  try {
    await git(add, { cwd: clone });
  } catch (error) {
    if (!isWorktreeResidue(error)) throw error;
    await clearWorktreeResidue(clone, paths, runId, path, io);
    await git(recreate, { cwd: clone });
  }
  return path;
}

/** Whether the clone holds a worktree registration for this exact path. */
export async function isRegisteredWorktree(clone, path) {
  const registered = await listWorktrees(clone);
  return registered.some((held) => samePath(held, path));
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

// Path comparison the way the host compares paths: Windows is case
// insensitive, and git reports a worktree path in its own separator form.
function comparable(path) {
  const full = resolve(path);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function samePath(a, b) {
  return comparable(a) === comparable(b);
}

function isUnder(root, path) {
  const base = comparable(root);
  const candidate = comparable(path);
  return candidate === base || candidate.startsWith(base + sep);
}

function isStrictlyUnder(root, path) {
  const base = comparable(root);
  const candidate = comparable(path);
  return candidate !== base && candidate.startsWith(base + sep);
}
