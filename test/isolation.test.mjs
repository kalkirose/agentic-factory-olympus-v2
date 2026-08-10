import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldHome } from '../src/daemon/home.mjs';
import { ensureBareClone, fetchClone, branchSha, readBlobFromBranch } from '../src/isolation/clones.mjs';
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
  const clone = join(paths.clones, 'alpha.git');
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
