import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homePaths, scaffoldHome } from '../src/daemon/home.mjs';
import { cloneDir, ensureBareClone, fetchClone, branchSha, readBlobFromBranch } from '../src/isolation/clones.mjs';
import {
  addRunWorktree,
  addDisposableWorktree,
  removeRunWorktrees,
  removeWorktree,
  listWorktrees,
  runWorktreePath,
  workspaceRoot,
} from '../src/isolation/worktrees.mjs';
import { longPath, removeTree } from '../src/isolation/removal.mjs';
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
const WINDOWS_ONLY = process.platform === 'win32' ? false : 'runs on Windows only';

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

test('a launch-only rule arms at provision: an ungated suite refuses to launch', async (t) => {
  const { origin, paths } = fixture(t);
  // Permissively valid — a live run's re-parse accepts it — but no Tier-1
  // layer carries the suite command, so the launch is where it must fail.
  const ungated = projectConfigJson({
    repo: { testPaths: ['test/'] },
    commands: { test: ['node', '--test'], lint: ['run-lint'] },
    gates: { tier1: [{ name: 'lint', command: 'lint' }] },
    lanes: { story: { suiteCommand: 'test' } },
  });
  commitTree(origin, { [CONFIG_PATH]: ungated }, 'ungate the suite');
  const isolation = new RunIsolation(paths, { composeRunner: fakeComposeRunner() });
  await assert.rejects(
    () =>
      isolation.provision({
        runId: 'r6',
        project: 'alpha',
        repoUrl: origin,
        defaultBranch: 'main',
        configPath: CONFIG_PATH,
      }),
    /lanes\.story\.suiteCommand/,
  );
  assert.ok(!existsSync(workspaceRoot(paths, 'r6')));
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

// -- the path a removal is handed --------------------------------------------
// The platform is the injected branch, never the host the test runs on
// (ADR-0013), so the Windows form is asserted from Linux and the other way
// round.

test('on Windows a removal is handed the extended-length path, and nowhere else', () => {
  const win = (path) => longPath(path, 'win32');
  const extended = '\\\\?\\C:\\home\\worktrees\\run-1\\tree';
  assert.equal(win('C:\\home\\worktrees\\run-1\\tree'), extended);
  // The prefix turns path parsing off, so the path goes in the form the
  // filesystem takes: separators converted, `.` and `..` already resolved.
  assert.equal(win('C:/home/worktrees/run-1/./tree'), extended);
  assert.equal(win('C:\\home\\worktrees\\run-1\\adv\\..\\tree'), extended);
  assert.equal(win('\\\\srv\\share\\worktrees\\run-1'), '\\\\?\\UNC\\srv\\share\\worktrees\\run-1');
  // Already extended, or a device path: handed on untouched.
  assert.equal(win(extended), extended);
  assert.equal(win('\\\\.\\C:\\home'), '\\\\.\\C:\\home');
  // A path with no drive and no share on it is resolved by the OS against
  // state this module does not have; the prefix would make it unresolvable.
  assert.equal(win('worktrees\\run-1\\tree'), 'worktrees\\run-1\\tree');
  assert.equal(win('\\worktrees\\run-1'), '\\worktrees\\run-1');
});

test('off Windows every path a removal is handed is the path that came in', () => {
  for (const path of [
    '/home/worktrees/run-1/tree',
    'C:\\home\\worktrees\\run-1\\tree',
    '\\\\srv\\share\\worktrees\\run-1',
    'worktrees/run-1/./tree',
  ]) {
    assert.equal(longPath(path, 'linux'), path);
  }
});

test('the tree removal takes the platform form, and rm -r carries it down', async (t) => {
  const paths = stagedWorkspace(t, 'r33');
  const root = workspaceRoot(paths, 'r33');
  const seen = [];
  const remove = (path, options) => {
    seen.push(path);
    return rmSync(path, options);
  };
  await removeTree(root, { remove, platform: 'linux' });
  assert.deepEqual(seen, [root]);
  assert.ok(!existsSync(root));

  // The Windows branch hands the same removal the extended-length root. One
  // call, because `rm -r` builds every path below the one it is given from it.
  mkdirSync(join(root, 'tree'), { recursive: true });
  const winSeen = [];
  await removeTree(root, {
    platform: 'win32',
    remove: (path, options) => {
      winSeen.push(path);
      return rmSync(path.replace(/^\\\\\?\\/, ''), options);
    },
  });
  assert.deepEqual(winSeen, [longPath(root, 'win32')]);
});

test(
  'a tree past the Windows path ceiling is removed',
  { skip: WINDOWS_ONLY },
  async (t) => {
    const paths = stagedWorkspace(t, 'r34');
    const root = workspaceRoot(paths, 'r34');
    // A run worktree nests a project's own tree under the daemon home, and a
    // node_modules path in it clears 260 characters on its own. The tree is
    // built through the extended-length form, which every Windows takes; the
    // removal is asked for in the plain form the harness holds.
    const segments = Array.from({ length: 12 }, (_, i) => `segment-${i}`.padEnd(24, 'x'));
    const deep = join(root, 'tree', ...segments);
    assert.ok(deep.length > 260);
    mkdirSync(longPath(deep, 'win32'), { recursive: true });
    writeFileSync(longPath(join(deep, 'held.txt'), 'win32'), 'x');
    await removeTree(root);
    assert.ok(!existsSync(root));
  },
);

// -- a removal git refuses ----------------------------------------------------
// Measured over five ships: three releases failed on "Filename too long" and
// eight on "Directory not empty", both of them git's answer about a tree the
// operating system deletes without complaint.

test('a worktree git will not remove is removed by hand, and the release lands', async (t) => {
  const { origin, paths } = fixture(t);
  const isolation = new RunIsolation(paths, { composeRunner: fakeComposeRunner() });
  const ws = await isolation.provision({
    runId: 'r40',
    project: 'alpha',
    repoUrl: origin,
    defaultBranch: 'main',
    configPath: CONFIG_PATH,
  });
  // git's own refusal, on a real registered worktree full of real files: with
  // its `.git` link gone the tree is no longer one git will delete, exactly as
  // a tree past the path ceiling is not one git will delete.
  rmSync(join(ws.worktree, '.git'));
  await assert.rejects(() =>
    removeWorktree(cloneDir(paths, 'alpha'), ws.worktree, { attempts: 1, remove: blockedRemove }),
  );
  assert.ok(existsSync(ws.worktree));

  const { errors, leftover } = await isolation.release('r40');
  assert.deepEqual(errors, []);
  assert.equal(leftover, null);
  assert.ok(!existsSync(workspaceRoot(paths, 'r40')));
  // The direct delete leaves a registration behind; the prune in the same pass
  // is what stops it outliving the run, and the branch delete needs it gone.
  // One left: the bare clone itself.
  assert.equal((await listWorktrees(cloneDir(paths, 'alpha'))).length, 1);
  const branches = gitSync(['branch', '--list', 'run/r40'], cloneDir(paths, 'alpha'));
  assert.equal(branches.trim(), '');
});

test('a removal that git and the harness both refuse names both refusals', async (t) => {
  const { origin, paths } = fixture(t);
  const isolation = new RunIsolation(paths, { composeRunner: fakeComposeRunner() });
  const ws = await isolation.provision({
    runId: 'r41',
    project: 'alpha',
    repoUrl: origin,
    defaultBranch: 'main',
    configPath: CONFIG_PATH,
  });
  rmSync(join(ws.worktree, '.git'));
  await assert.rejects(
    () =>
      removeWorktree(cloneDir(paths, 'alpha'), ws.worktree, {
        attempts: 1,
        remove: blockedRemove,
      }),
    // Both halves, because the two say different things: git would not, and
    // then the operating system could not. The wording of git's own half is
    // git's; the command it failed at is what the harness put in front of it.
    /git worktree remove[\s\S]*direct removal: EBUSY/,
  );
});

/** A delete nothing will let through. */
function blockedRemove() {
  throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
}

// -- who is holding a workspace nothing will delete --------------------------

test('a leftover workspace comes back with the processes standing in it', async (t) => {
  const paths = stagedWorkspace(t, 'r42');
  const asked = [];
  const isolation = new RunIsolation(paths, {
    sweepProcesses: fakeSweep({ count: 1, names: ['node.exe'] }),
    listHolders: async (path) => {
      asked.push(path);
      return { holders: [{ pid: 4242, name: 'node.exe' }] };
    },
    removalIo: { remove: blockedRemove, sleep: async () => {}, attempts: 2 },
  });
  const { leftover, holders } = await isolation.release('r42');
  assert.equal(leftover, workspaceRoot(paths, 'r42'));
  // Read after every removal was tried, on the directory that survived: the
  // sweep already ended what it could find, so this is what outlived it.
  assert.deepEqual(asked, [leftover]);
  assert.deepEqual(holders, [{ pid: 4242, name: 'node.exe' }]);
});

test('a workspace the release cleared is not asked who holds it', async (t) => {
  const paths = stagedWorkspace(t, 'r43');
  const asked = [];
  const isolation = new RunIsolation(paths, {
    sweepProcesses: fakeSweep(),
    listHolders: async (path) => {
      asked.push(path);
      return { holders: [] };
    },
  });
  const { leftover, holders } = await isolation.release('r43');
  assert.equal(leftover, null);
  assert.deepEqual(holders, []);
  assert.deepEqual(asked, []);
});

test('a holder query that cannot run leaves the release reported anyway', async (t) => {
  const paths = stagedWorkspace(t, 'r44');
  const isolation = new RunIsolation(paths, {
    sweepProcesses: fakeSweep(),
    listHolders: async () => {
      throw new Error('CIM is unavailable');
    },
    removalIo: { remove: blockedRemove, sleep: async () => {}, attempts: 2 },
  });
  const { leftover, holders, errors } = await isolation.release('r44');
  assert.equal(leftover, workspaceRoot(paths, 'r44'));
  assert.deepEqual(holders, []);
  assert.match(errors[0], /EBUSY/);
});
