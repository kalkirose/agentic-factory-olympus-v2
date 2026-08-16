import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homePaths, scaffoldHome } from '../src/daemon/home.mjs';
import { cloneDir, ensureBareClone, fetchClone, branchSha, readBlobFromBranch } from '../src/isolation/clones.mjs';
import {
  addRunWorktree,
  addDisposableWorktree,
  removeRunWorktrees,
  listWorktrees,
  runWorktreePath,
  workspaceRoot,
} from '../src/isolation/worktrees.mjs';
import { RunIsolation } from '../src/isolation/isolation.mjs';
import {
  tempDir,
  removeDir,
  gitSync,
  initOriginRepo,
  commitTree,
  projectConfigJson,
  fakeComposeRunner,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';

function fixture(t) {
  const root = tempDir();
  t.after(() => removeDir(root));
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson(),
    'compose.harness.yml': 'services: {}\n',
    'src/app.txt': 'v1\n',
  });
  const paths = scaffoldHome(join(root, 'home'));
  return { origin, paths };
}

test('fetch discipline: a change on main applies only after fetch', async (t) => {
  const { origin, paths } = fixture(t);
  const clone = await ensureBareClone(paths, 'alpha', origin, 'main');
  const before = await readBlobFromBranch(clone, 'main', CONFIG_PATH);
  commitTree(origin, { [CONFIG_PATH]: projectConfigJson({ conventions: ['v2'] }) }, 'config v2');
  // The clone reads its own refs — nothing changes until fetch.
  const stale = await readBlobFromBranch(clone, 'main', CONFIG_PATH);
  assert.equal(stale.blob, before.blob);
  await fetchClone(clone);
  const fresh = await readBlobFromBranch(clone, 'main', CONFIG_PATH);
  assert.notEqual(fresh.blob, before.blob);
  assert.deepEqual(JSON.parse(fresh.text).conventions, ['v2']);
  // Idempotent: a second ensure returns the same clone untouched.
  assert.equal(await ensureBareClone(paths, 'alpha', origin, 'main'), clone);
});

test('fetch with prune never deletes a live run branch', async (t) => {
  const { origin, paths } = fixture(t);
  const clone = await ensureBareClone(paths, 'alpha', origin, 'main');
  const { path } = await addRunWorktree(clone, paths, 'r9', 'main');
  // The run branch exists only locally; a wide refspec would prune it here.
  commitTree(origin, { 'src/app.txt': 'v2\n' }, 'app v2');
  await fetchClone(clone);
  assert.equal(await branchSha(clone, 'run/r9'), gitSync(['rev-parse', 'HEAD'], path).trim());
  assert.equal(await branchSha(clone, 'main'), gitSync(['rev-parse', 'main'], origin).trim());
  await removeRunWorktrees(clone, paths, 'r9');
});

test('run worktree: fresh run branch at launch, everything gone at release', async (t) => {
  const { origin, paths } = fixture(t);
  const clone = await ensureBareClone(paths, 'alpha', origin, 'main');
  const { path, branch } = await addRunWorktree(clone, paths, 'r1', 'main');
  assert.equal(path, runWorktreePath(paths, 'r1'));
  assert.ok(existsSync(join(path, 'compose.harness.yml')));
  assert.equal(branch, 'run/r1');
  assert.match(gitSync(['branch', '--list', 'run/r1'], clone), /run\/r1/);
  assert.equal(gitSync(['rev-parse', 'HEAD'], path).trim(), await branchSha(clone, 'main'));
  await removeRunWorktrees(clone, paths, 'r1');
  assert.ok(!existsSync(workspaceRoot(paths, 'r1')));
  assert.equal(gitSync(['branch', '--list', 'run/r1'], clone).trim(), '');
  assert.equal((await listWorktrees(clone)).length, 1); // the bare repo only
});

test('disposable worktrees pin a sha and die with the run root', async (t) => {
  const { origin, paths } = fixture(t);
  const clone = await ensureBareClone(paths, 'alpha', origin, 'main');
  const oldSha = await branchSha(clone, 'main');
  commitTree(origin, { 'src/app.txt': 'v2\n' }, 'app v2');
  await fetchClone(clone);
  const disposable = await addDisposableWorktree(clone, paths, 'r2', 'adv-1', oldSha);
  const { path: tree } = await addRunWorktree(clone, paths, 'r2', 'main');
  // trim(): autocrlf checkouts may rewrite line endings; content is the point.
  assert.equal(readFileSync(join(disposable, 'src/app.txt'), 'utf8').trim(), 'v1');
  assert.equal(readFileSync(join(tree, 'src/app.txt'), 'utf8').trim(), 'v2');
  await removeRunWorktrees(clone, paths, 'r2');
  assert.ok(!existsSync(workspaceRoot(paths, 'r2')));
  assert.equal((await listWorktrees(clone)).length, 1);
});

test('provision + release round-trip with a stack', async (t) => {
  const { origin, paths } = fixture(t);
  const runner = fakeComposeRunner();
  const isolation = new RunIsolation(paths, { composeRunner: runner });
  const ws = await isolation.provision({
    runId: 'r3',
    project: 'alpha',
    repoUrl: origin,
    defaultBranch: 'main',
    configPath: CONFIG_PATH,
  });
  assert.ok(existsSync(ws.worktree));
  assert.equal(ws.stack.name, 'oly-r3');
  assert.equal(ws.projectConfig.stack.composeFile, 'compose.harness.yml');
  assert.ok(ws.configBlob.length >= 40);
  assert.ok(runner.calls[0].args.includes('up'));
  assert.equal(runner.calls[0].env.OLYMPUS_RUN_ID, 'r3');
  const record = JSON.parse(readFileSync(join(paths.runs, 'r3', 'workspace.json'), 'utf8'));
  assert.equal(record.baseSha, ws.baseSha);
  assert.equal(record.stack.name, 'oly-r3');
  const { errors } = await isolation.release('r3');
  assert.deepEqual(errors, []);
  assert.ok(runner.calls.at(-1).args.includes('down'));
  assert.ok(!existsSync(workspaceRoot(paths, 'r3')));
  // The launch never happened — no ledger, so the run dir goes too.
  assert.ok(!existsSync(join(paths.runs, 'r3')));
});

test('a failed stack up fails the provision and leaves nothing behind', async (t) => {
  const { origin, paths } = fixture(t);
  const runner = fakeComposeRunner({ failOn: 'up' });
  const isolation = new RunIsolation(paths, { composeRunner: runner });
  await assert.rejects(
    () =>
      isolation.provision({
        runId: 'r4',
        project: 'alpha',
        repoUrl: origin,
        defaultBranch: 'main',
        configPath: CONFIG_PATH,
      }),
    /compose up failed/,
  );
  assert.ok(!existsSync(workspaceRoot(paths, 'r4')));
  assert.ok(!existsSync(join(paths.runs, 'r4')));
  const clone = cloneDir(paths, 'alpha');
  assert.equal((await listWorktrees(clone)).length, 1);
});

test('an invalid config on main fails the provision before any worktree', async (t) => {
  const { origin, paths } = fixture(t);
  commitTree(origin, { [CONFIG_PATH]: projectConfigJson({ version: 2 }) }, 'break config');
  const isolation = new RunIsolation(paths, { composeRunner: fakeComposeRunner() });
  await assert.rejects(
    () =>
      isolation.provision({
        runId: 'r5',
        project: 'alpha',
        repoUrl: origin,
        defaultBranch: 'main',
        configPath: CONFIG_PATH,
      }),
    /project config invalid.*version/,
  );
  assert.ok(!existsSync(workspaceRoot(paths, 'r5')));
});

test('orphan run ids: workspace dirs without an open run', (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const paths = scaffoldHome(join(root, 'home'));
  mkdirSync(join(paths.worktrees, 'dead-run'), { recursive: true });
  mkdirSync(join(paths.worktrees, 'live-run'), { recursive: true });
  const isolation = new RunIsolation(paths, {});
  assert.deepEqual(isolation.orphanRunIds(new Set(['live-run'])), ['dead-run']);
});

// -- where workspaces provision ----------------------------------------------

test('without a configured root the layout is the home\'s own', (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const home = join(root, 'home');
  assert.equal(scaffoldHome(home).worktrees, join(home, 'worktrees'));
  // An absent field and no config at all describe the same layout.
  assert.deepEqual(homePaths(home, {}), homePaths(home));
  assert.deepEqual(homePaths(home, { worktreeRoot: undefined }), homePaths(home));
});

test('a configured worktree root carries provision, release and the orphan sweep', async (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson(),
    'compose.harness.yml': 'services: {}\n',
  });
  const home = join(root, 'home');
  const worktreeRoot = join(root, 'w');
  const paths = scaffoldHome(home, { worktreeRoot });
  // Only the workspace root moves; every other store stays in the home, and
  // the home keeps no empty worktrees directory to mislead an operator.
  assert.equal(paths.worktrees, worktreeRoot);
  assert.equal(paths.runs, join(home, 'runs'));
  assert.ok(existsSync(worktreeRoot));
  assert.ok(!existsSync(join(home, 'worktrees')));

  const isolation = new RunIsolation(paths, { composeRunner: fakeComposeRunner() });
  const ws = await isolation.provision({
    runId: 'r20',
    project: 'alpha',
    repoUrl: origin,
    defaultBranch: 'main',
    configPath: CONFIG_PATH,
  });
  assert.equal(ws.worktree, join(worktreeRoot, 'r20', 'tree'));
  assert.ok(existsSync(join(ws.worktree, 'compose.harness.yml')));
  const disposable = await addDisposableWorktree(
    cloneDir(paths, 'alpha'),
    paths,
    'r20',
    'adv-1',
    ws.baseSha,
  );
  assert.equal(disposable, join(worktreeRoot, 'r20', 'adv-1'));

  // The sweep reads the configured root, not the home.
  mkdirSync(join(worktreeRoot, 'dead-run'), { recursive: true });
  assert.deepEqual(isolation.orphanRunIds(new Set(['r20'])), ['dead-run']);

  const { errors } = await isolation.release('r20');
  assert.deepEqual(errors, []);
  assert.ok(!existsSync(join(worktreeRoot, 'r20')));
  assert.equal((await listWorktrees(cloneDir(paths, 'alpha'))).length, 1);
});

// -- the process sweep that precedes every removal ---------------------------

/** Records sweeps instead of ending anything. */
function fakeSweep(result = { count: 0, names: [] }) {
  const roots = [];
  const sweep = async (root) => {
    roots.push(root);
    return result;
  };
  sweep.roots = roots;
  return sweep;
}

test('release sweeps the workspace before it tries to remove anything', async (t) => {
  const { origin, paths } = fixture(t);
  // The sweep runs while the workspace is still there to hold processes, and
  // the paths it is given name that workspace and nothing wider.
  const seen = [];
  const sweepProcesses = async (root) => {
    seen.push({ root, workspaceStillThere: existsSync(root) });
    return { count: 2, names: ['esbuild.exe', 'node.exe'] };
  };
  const isolation = new RunIsolation(paths, {
    composeRunner: fakeComposeRunner(),
    sweepProcesses,
  });
  await isolation.provision({
    runId: 'r10',
    project: 'alpha',
    repoUrl: origin,
    defaultBranch: 'main',
    configPath: CONFIG_PATH,
  });
  const { errors, swept } = await isolation.release('r10');
  assert.deepEqual(errors, []);
  assert.deepEqual(seen, [{ root: workspaceRoot(paths, 'r10'), workspaceStillThere: true }]);
  // What it ended travels back to the caller, which is what stamps it.
  assert.deepEqual(swept, { count: 2, names: ['esbuild.exe', 'node.exe'] });
  assert.ok(!existsSync(workspaceRoot(paths, 'r10')));
});

test('a workspace that is already gone is not swept at all', async (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const paths = scaffoldHome(join(root, 'home'));
  const sweep = fakeSweep();
  const isolation = new RunIsolation(paths, { sweepProcesses: sweep });
  const { errors, swept } = await isolation.release('never-provisioned');
  assert.deepEqual(errors, []);
  assert.equal(swept, null);
  assert.deepEqual(sweep.roots, []);
});

// -- the retry ladder under every removal ------------------------------------
// A run workspace is a checked-out application, and a hold on one file in it
// refuses the whole removal. The hold is another process's and no portable
// test can stage one, so the delete call is the seam.

/** A delete a hold refuses for its first `holds` calls, then lets through. */
function heldRemove(holds) {
  const remove = (path, options) => {
    remove.calls++;
    if (remove.calls <= holds) {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return rmSync(path, options);
  };
  remove.calls = 0;
  return remove;
}

/** A daemon home with one workspace under it and no run behind it. */
function stagedWorkspace(t, runId) {
  const root = tempDir();
  t.after(() => removeDir(root));
  const paths = scaffoldHome(join(root, 'home'));
  mkdirSync(join(workspaceRoot(paths, runId), 'tree'), { recursive: true });
  return paths;
}

test('a workspace a hold refuses is asked again, and the release lands', async (t) => {
  const paths = stagedWorkspace(t, 'r30');
  const remove = heldRemove(2);
  const isolation = new RunIsolation(paths, {
    sweepProcesses: fakeSweep(),
    removalIo: { remove, sleep: async () => {} },
  });
  const { errors, leftover } = await isolation.release('r30');
  assert.deepEqual(errors, []);
  assert.equal(leftover, null);
  assert.equal(remove.calls, 3);
  assert.ok(!existsSync(workspaceRoot(paths, 'r30')));
});

test('a workspace nothing will delete comes back named', async (t) => {
  const paths = stagedWorkspace(t, 'r31');
  const remove = heldRemove(Infinity);
  const isolation = new RunIsolation(paths, {
    sweepProcesses: fakeSweep(),
    removalIo: { remove, sleep: async () => {}, attempts: 3 },
  });
  const { errors, leftover } = await isolation.release('r31');
  assert.equal(remove.calls, 3);
  // The workspace is where it was, the release says why, and it names the
  // directory — nothing else in the harness would ever come back to it.
  assert.equal(leftover, workspaceRoot(paths, 'r31'));
  assert.ok(existsSync(workspaceRoot(paths, 'r31')));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^workspace root: .*EBUSY/);
});

test('a removal a second attempt cannot change is reported at once', async (t) => {
  const paths = stagedWorkspace(t, 'r32');
  const remove = () => {
    remove.calls++;
    throw new Error('ENOSPC: no space left on device');
  };
  remove.calls = 0;
  const isolation = new RunIsolation(paths, {
    sweepProcesses: fakeSweep(),
    removalIo: { remove, sleep: async () => {} },
  });
  const { errors, leftover } = await isolation.release('r32');
  assert.equal(remove.calls, 1);
  assert.equal(leftover, workspaceRoot(paths, 'r32'));
  assert.match(errors[0], /ENOSPC/);
});

test('a sweep that could not run is reported and the release goes on', async (t) => {
  const { origin, paths } = fixture(t);
  const isolation = new RunIsolation(paths, {
    composeRunner: fakeComposeRunner(),
    sweepProcesses: async () => ({ count: 0, names: [], error: 'could not enumerate: no CIM' }),
  });
  await isolation.provision({
    runId: 'r11',
    project: 'alpha',
    repoUrl: origin,
    defaultBranch: 'main',
    configPath: CONFIG_PATH,
  });
  const { errors } = await isolation.release('r11');
  assert.deepEqual(errors, ['sweep: could not enumerate: no CIM']);
  // Reported, not fatal: everything the release could still do, it did.
  assert.ok(!existsSync(workspaceRoot(paths, 'r11')));
});
