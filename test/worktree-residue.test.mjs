// A worktree a run creates for itself is created over whatever that run left
// at the same path before (ADR-0051). A stage step that crashed between the
// creation and the first use leaves a directory, a registration, or both, and
// none of the three is work: the retry of that step owns all of them.
//
// The three residue shapes below are the three a crash actually leaves, and
// each one is staged the way a crash leaves it rather than described.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldHome } from '../src/daemon/home.mjs';
import { ensureBareClone } from '../src/isolation/clones.mjs';
import {
  addDisposableWorktree,
  addRunWorktree,
  assertInRunWorkspace,
  clearWorktreeResidue,
  isRegisteredWorktree,
  isWorktreeResidue,
  listWorktrees,
  runWorktreePath,
  workspaceRoot,
} from '../src/isolation/worktrees.mjs';
import { removeTree } from '../src/isolation/removal.mjs';
import { tempDir, removeDir, gitSync, initOriginRepo, projectConfigJson } from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';

function fixture(t) {
  const root = tempDir();
  t.after(() => removeDir(root));
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson(),
    'src/app.txt': 'v1\n',
  });
  const paths = scaffoldHome(join(root, 'home'));
  return { root, origin, paths };
}

// -- one creation site ---------------------------------------------------------

/** Every `.mjs` file under `src/`, named from the repository root. */
function sourceFiles(dir) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith('.mjs')) files.push(path);
  }
  return files;
}

test('nothing outside the isolation primitive creates a worktree', () => {
  // The property is carried by the primitive, so a second creation site is a
  // second place that has to remember it. The scan is the enforcement.
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sites = sourceFiles('src').filter((file) =>
    /'worktree',\s*'add'/.test(readFileSync(join(root, file), 'utf8')),
  );
  assert.deepEqual(sites, ['src/isolation/worktrees.mjs']);
});

// -- the bound ----------------------------------------------------------------

test('only a path inside the run workspace may be cleared', (t) => {
  const { root, paths } = fixture(t);
  const runId = 'r1';
  const workspace = workspaceRoot(paths, runId);
  // What a run is allowed to clear: its own worktree and its own disposables.
  assert.equal(assertInRunWorkspace(paths, runId, runWorktreePath(paths, runId)), runWorktreePath(paths, runId));
  assert.doesNotThrow(() => assertInRunWorkspace(paths, runId, join(workspace, 'adversary-r1-w1')));
  // What it is not: the workspace root itself, the root of every workspace,
  // another run's workspace, the clone store, and anywhere else on the disk.
  for (const outside of [
    workspace,
    paths.worktrees,
    workspaceRoot(paths, 'r2'),
    paths.clones,
    paths.home,
    root,
    join(workspace, '..', 'r2', 'tree'),
    join(root, 'origin'),
  ]) {
    assert.throws(
      () => assertInRunWorkspace(paths, runId, outside),
      /not inside the run workspace/,
      `${outside} was accepted`,
    );
  }
});

test('a clearing outside the run workspace deletes nothing', async (t) => {
  const { root, origin, paths } = fixture(t);
  const clone = await ensureBareClone(paths, 'alpha', origin, 'main');
  const bystander = join(root, 'bystander');
  mkdirSync(bystander, { recursive: true });
  writeFileSync(join(bystander, 'keep.txt'), 'kept\n');
  await assert.rejects(
    () => clearWorktreeResidue(clone, paths, 'r1', bystander),
    /not inside the run workspace/,
  );
  assert.ok(existsSync(join(bystander, 'keep.txt')), 'a path outside the workspace was cleared');
});

// -- what counts as residue ---------------------------------------------------

test('residue is told apart from a request git refused on its merits', () => {
  for (const message of [
    "fatal: 'C:\\h\\worktrees\\r1\\tree' already exists",
    // The wording measured on the host for a registration whose directory is
    // gone, which is the shape a step that looks only for a directory misses.
    "fatal: '/h/worktrees/r1/tree' is a missing but already registered worktree",
    "fatal: '/h/worktrees/r1/tree' is already registered",
    "fatal: '/h/worktrees/r1/adv' is already used by worktree at '/h/worktrees/r1/adv'",
    "fatal: 'run/r1' is already checked out at '/h/worktrees/r1/tree'",
    "fatal: '/h/worktrees/r1/tree' is a missing but locked worktree",
  ]) {
    assert.equal(isWorktreeResidue(new Error(message)), true, message);
  }
  for (const message of [
    "fatal: invalid reference: nosuchsha",
    "fatal: not a git repository",
    "error: could not lock config file",
  ]) {
    assert.equal(isWorktreeResidue(new Error(message)), false, message);
  }
  assert.equal(isWorktreeResidue(undefined), false);
});

// -- the three shapes a crash leaves ------------------------------------------

/** The tree of a wave the run created and never used. */
async function stageWave(clone, paths, runId, sha) {
  const path = await addDisposableWorktree(clone, paths, runId, 'adversary-r1-w1', sha);
  // The crash: something was written into the tree and nothing read it.
  writeFileSync(join(path, 'src', 'app.txt'), 'half a run\n');
  return path;
}

test('a worktree is created over the directory and the registration a crash left', async (t) => {
  const { origin, paths } = fixture(t);
  const clone = await ensureBareClone(paths, 'alpha', origin, 'main');
  const sha = gitSync(['rev-parse', 'main'], origin).trim();
  const path = await stageWave(clone, paths, 'r1', sha);
  assert.equal(await isRegisteredWorktree(clone, path), true);

  // The retry of the crashed step.
  assert.equal(await addDisposableWorktree(clone, paths, 'r1', 'adversary-r1-w1', sha), path);
  assert.equal(readFileSync(join(path, 'src', 'app.txt'), 'utf8').trim(), 'v1');
  // One registration, not two. git reports a worktree path in its own
  // separator form, so the comparison is on the resolved path.
  const registrations = (await listWorktrees(clone)).filter(
    (held) => resolve(held).toLowerCase() === resolve(path).toLowerCase(),
  );
  assert.equal(registrations.length, 1, JSON.stringify(await listWorktrees(clone)));
});

test('a worktree is created over a registration whose directory is gone', async (t) => {
  const { origin, paths } = fixture(t);
  const clone = await ensureBareClone(paths, 'alpha', origin, 'main');
  const sha = gitSync(['rev-parse', 'main'], origin).trim();
  const path = await stageWave(clone, paths, 'r1', sha);
  // The shape a removal that git refused leaves behind: the harness deleted
  // the tree itself and the registration outlived it (ADR-0004).
  await removeTree(path);
  assert.equal(existsSync(path), false);
  assert.equal(await isRegisteredWorktree(clone, path), true);

  assert.equal(await addDisposableWorktree(clone, paths, 'r1', 'adversary-r1-w1', sha), path);
  assert.equal(readFileSync(join(path, 'src', 'app.txt'), 'utf8').trim(), 'v1');
});

test('a worktree is created over a directory git no longer knows about', async (t) => {
  const { origin, paths } = fixture(t);
  const clone = await ensureBareClone(paths, 'alpha', origin, 'main');
  const sha = gitSync(['rev-parse', 'main'], origin).trim();
  const path = await stageWave(clone, paths, 'r1', sha);
  // The other half of the same accident: the registration was pruned and the
  // directory stayed.
  removeTree(join(path, '.git'));
  gitSync(['worktree', 'prune'], clone);
  assert.equal(await isRegisteredWorktree(clone, path), false);
  assert.ok(existsSync(join(path, 'src', 'app.txt')));

  assert.equal(await addDisposableWorktree(clone, paths, 'r1', 'adversary-r1-w1', sha), path);
  assert.equal(readFileSync(join(path, 'src', 'app.txt'), 'utf8').trim(), 'v1');
});

test('the run worktree is created over its own residue, branch included', async (t) => {
  const { origin, paths } = fixture(t);
  const clone = await ensureBareClone(paths, 'alpha', origin, 'main');
  const base = gitSync(['rev-parse', 'main'], origin).trim();
  const first = await addRunWorktree(clone, paths, 'r1', 'main');
  // A crash after the branch moved: the residue carries a commit as well as a
  // directory, and `worktree add -b` refuses a branch that exists.
  writeFileSync(join(first.path, 'src', 'app.txt'), 'half a run\n');
  gitSync(['add', '-A'], first.path);
  gitSync(['-c', 'commit.gpgsign=false', 'commit', '-m', 'half a run'], first.path);
  assert.notEqual(gitSync(['rev-parse', 'run/r1'], clone).trim(), base);

  const again = await addRunWorktree(clone, paths, 'r1', 'main');
  assert.deepEqual([again.path, again.branch], [first.path, 'run/r1']);
  assert.equal(readFileSync(join(again.path, 'src', 'app.txt'), 'utf8').trim(), 'v1');
  assert.equal(gitSync(['rev-parse', 'run/r1'], clone).trim(), base);
});

test('a residue clearing leaves the rest of the run workspace alone', async (t) => {
  const { origin, paths } = fixture(t);
  const clone = await ensureBareClone(paths, 'alpha', origin, 'main');
  const sha = gitSync(['rev-parse', 'main'], origin).trim();
  const tree = (await addRunWorktree(clone, paths, 'r1', 'main')).path;
  const wave = await stageWave(clone, paths, 'r1', sha);
  await clearWorktreeResidue(clone, paths, 'r1', wave);
  assert.equal(existsSync(wave), false);
  assert.ok(existsSync(join(tree, 'src', 'app.txt')), 'the run worktree went with the wave tree');
  assert.equal(await isRegisteredWorktree(clone, tree), true);
});
