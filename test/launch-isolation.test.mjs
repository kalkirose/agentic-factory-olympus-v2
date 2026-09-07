// Daemon-level M4 loop: launch provisions clone + config + worktree + stack,
// close tears the workspace down and stamps the outcome, a config change on
// main applies at the next launch, orphaned workspaces are swept at start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, archivedRunLedgerPath } from '../src/daemon/home.mjs';
import { writeControlCommand } from '../src/daemon/control.mjs';
import {
  RUN_CACHE_ENV,
  runCacheDir,
  workspaceRoot,
} from '../src/isolation/worktrees.mjs';
import { changedFiles, commitAll, filesAt } from '../src/isolation/tree.mjs';
import { BASE_SHA_ENV, runEnv } from '../src/lanes/shared.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import {
  tempDir,
  removeDir,
  waitFor,
  initOriginRepo,
  commitTree,
  gitSync,
  projectConfigJson,
  fakeComposeRunner,
  NO_WAIT,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';

function fixture(t, { lanes, composeRunner, worktreeRoot }) {
  const root = tempDir();
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson(),
    'compose.harness.yml': 'services: {}\n',
  });
  const paths = scaffoldHome(join(root, 'home'), { worktreeRoot });
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({
      version: 1,
      ...(worktreeRoot !== undefined && { worktreeRoot }),
      projects: { alpha: { repoUrl: origin, slotCap: 2 } },
    }) + '\n',
  );
  const daemon = new Daemon(join(root, 'home'), { waitSleep: NO_WAIT, lanes, composeRunner });
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  return { root, origin, paths, daemon };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test('launch provisions worktree + stack, close releases both', async (t) => {
  const gate = deferred();
  let seenCtx = null;
  const lanes = {
    solo: {
      stages: ['work'],
      handlers: {
        work: async (ctx) => {
          seenCtx = ctx;
          await gate.promise;
          return { close: { state: 'shipped' } };
        },
      },
    },
  };
  const runner = fakeComposeRunner();
  const { paths, daemon } = fixture(t, { lanes, composeRunner: runner });
  await daemon.start();
  const { runId, worktree, baseSha, projectConfig } = await daemon.launchRun({
    project: 'alpha',
    lane: 'solo',
  });
  assert.ok(existsSync(worktree));
  assert.equal(projectConfig.stack.composeFile, 'compose.harness.yml');
  assert.ok(runner.calls.some((c) => c.args.includes('up')));
  await waitFor(() => seenCtx, { label: 'stage handler entered' });
  assert.equal(seenCtx.payload.worktree, worktree);
  assert.equal(seenCtx.payload.baseSha, baseSha);
  assert.match(seenCtx.payload.stack, /^oly-/);
  gate.resolve();
  await waitFor(() => existsSync(archivedRunLedgerPath(paths, runId)), { label: 'run archived' });
  await waitFor(() => !existsSync(workspaceRoot(paths, runId)), { label: 'worktree removed' });
  assert.ok(runner.calls.some((c) => c.args.includes('down')));
  const released = await waitFor(
    () => readEvents(paths.instanceLedger).find((e) => e.event === 'workspace-released'),
    { label: 'workspace-released stamped' },
  );
  assert.equal(released.runId, runId);
  assert.equal(released.ok, true);
  // The workspace record archived with the run — release evidence.
  const record = JSON.parse(
    readFileSync(join(paths.archivedRuns, runId, 'workspace.json'), 'utf8'),
  );
  assert.equal(record.baseSha, baseSha);
  const launched = readEvents(archivedRunLedgerPath(paths, runId)).find(
    (e) => e.event === 'run-launched',
  );
  assert.equal(launched.worktree, worktree);
  assert.match(launched.stack, /^oly-/);
});

test('a config change on main applies at the next launch', async (t) => {
  const payloads = [];
  const lanes = {
    solo: {
      stages: ['work'],
      handlers: {
        work: async (ctx) => {
          payloads.push(ctx.payload);
          return { close: { state: 'shipped' } };
        },
      },
    },
  };
  const { origin, paths, daemon } = fixture(t, { lanes, composeRunner: fakeComposeRunner() });
  await daemon.start();
  const first = await daemon.launchRun({ project: 'alpha', lane: 'solo' });
  await waitFor(() => !existsSync(workspaceRoot(paths, first.runId)), { label: 'first released' });
  assert.deepEqual(first.projectConfig.conventions, []);
  commitTree(origin, { [CONFIG_PATH]: projectConfigJson({ conventions: ['v2'] }) }, 'config v2');
  const second = await daemon.launchRun({ project: 'alpha', lane: 'solo' });
  assert.deepEqual(second.projectConfig.conventions, ['v2']);
  assert.equal(payloads.length, 2);
  assert.notEqual(payloads[1].configBlob, payloads[0].configBlob);
});

test('an invalid config on main fails the launch and no run starts', async (t) => {
  const lanes = {
    solo: { stages: ['work'], handlers: { work: async () => ({ close: { state: 'shipped' } }) } },
  };
  const { origin, paths, daemon } = fixture(t, { lanes, composeRunner: fakeComposeRunner() });
  await daemon.start();
  commitTree(origin, { [CONFIG_PATH]: projectConfigJson({ version: 3 }) }, 'break config');
  await assert.rejects(
    () => daemon.launchRun({ project: 'alpha', lane: 'solo' }),
    /project config invalid/,
  );
  assert.ok(!readEvents(paths.instanceLedger).some((e) => e.event === 'launch'));
  assert.equal(daemon.engine.runs.size, 0);
  // Unknown project and unknown lane are refused before provisioning.
  await assert.rejects(() => daemon.launchRun({ project: 'beta', lane: 'solo' }), /unknown project/);
  await assert.rejects(() => daemon.launchRun({ project: 'alpha', lane: 'nope' }), /unknown lane/);
});

test('a console launch carries the ticket into the repair payload', async (t) => {
  const payloads = [];
  const lane = {
    stages: ['work'],
    handlers: {
      work: async (ctx) => {
        payloads.push(ctx.payload);
        return { close: { state: 'shipped' } };
      },
    },
  };
  const { daemon } = fixture(t, {
    lanes: { story: lane, repair: lane },
    composeRunner: fakeComposeRunner(),
  });
  await daemon.start();
  await daemon.launchCommand({
    actor: 'console:tester',
    project: 'alpha',
    lane: 'repair',
    ticket: 'tickets/t1.md',
  });
  await waitFor(() => payloads.length === 1, { label: 'repair stage handler entered' });
  assert.equal(payloads[0].ticket, 'tickets/t1.md');
  // The ticket is the repair lane's spec: a mismatch is refused before the
  // launch provisions anything.
  await assert.rejects(
    () => daemon.launchCommand({ actor: 'console:tester', project: 'alpha', lane: 'repair' }),
    /repair launch requires a ticket/,
  );
  await assert.rejects(
    () =>
      daemon.launchCommand({
        actor: 'console:tester',
        project: 'alpha',
        ticket: 'tickets/t1.md',
      }),
    /ticket applies to the repair and records lanes only \(lane: story\)/,
  );
  assert.equal(payloads.length, 1);
});

test('orphaned workspaces are swept and stamped at daemon start', async (t) => {
  const { paths, daemon } = fixture(t, { lanes: {}, composeRunner: fakeComposeRunner() });
  mkdirSync(join(workspaceRoot(paths, 'dead-run'), 'tree'), { recursive: true });
  await daemon.start();
  await waitFor(() => !existsSync(workspaceRoot(paths, 'dead-run')), { label: 'orphan removed' });
  const released = readEvents(paths.instanceLedger).find((e) => e.event === 'workspace-released');
  assert.equal(released.runId, 'dead-run');
  assert.equal(released.orphan, true);
  assert.equal(released.ok, true);
});

test('the configured worktree root is where the daemon provisions and sweeps', async (t) => {
  const worktreeRoot = tempDir('olympus-worktrees-');
  t.after(() => removeDir(worktreeRoot));
  const lanes = {
    solo: { stages: ['work'], handlers: { work: async () => ({ close: { state: 'shipped' } }) } },
  };
  const { paths, daemon } = fixture(t, {
    lanes,
    composeRunner: fakeComposeRunner(),
    worktreeRoot,
  });
  // The config reaches the layout: the start-time sweep looks in the
  // configured root, and the home never grows a worktrees directory.
  mkdirSync(join(worktreeRoot, 'dead-run', 'tree'), { recursive: true });
  await daemon.start();
  assert.equal(daemon.paths.worktrees, worktreeRoot);
  await waitFor(() => !existsSync(join(worktreeRoot, 'dead-run')), { label: 'orphan removed' });
  const { runId, worktree } = await daemon.launchRun({ project: 'alpha', lane: 'solo' });
  assert.equal(worktree, join(worktreeRoot, runId, 'tree'));
  await waitFor(() => existsSync(archivedRunLedgerPath(paths, runId)), { label: 'run archived' });
  await waitFor(() => !existsSync(join(worktreeRoot, runId)), { label: 'workspace released' });
  assert.ok(!existsSync(join(paths.home, 'worktrees')));
});

test('a launch the daemon refuses is stamped, not only left in a reason file', async (t) => {
  const lanes = { solo: { stages: ['work'], handlers: { work: async () => ({ close: { state: 'shipped' } }) } } };
  const { origin, paths, daemon } = fixture(t, { lanes, composeRunner: fakeComposeRunner() });
  await daemon.start();
  // The config on main no longer parses, so provisioning refuses the launch
  // after the run already has a name — the state the console cannot see.
  commitTree(origin, { [CONFIG_PATH]: projectConfigJson({ version: 2 }) }, 'break config');
  const name = writeControlCommand(paths, {
    actor: 'operator',
    command: 'launch',
    project: 'alpha',
    lane: 'solo',
  });
  const stamped = await waitFor(
    () => readEvents(paths.instanceLedger).find((e) => e.event === 'launch-rejected'),
    { label: 'the refusal to be stamped' },
  );
  assert.equal(stamped.requestedBy, 'operator');
  assert.equal(stamped.project, 'alpha');
  assert.equal(stamped.lane, 'solo');
  assert.match(stamped.reason, /project config invalid.*version/);
  // The run that would have existed is named, so the refusal can be tied to
  // the workspace and ledger a reader goes looking for.
  assert.match(stamped.runId, /^alpha-/);
  assert.ok(!existsSync(join(paths.runs, stamped.runId)));
  // The console's own feedback is untouched.
  assert.ok(readdirSync(paths.controlRejected).some((f) => f.endsWith(`${name}.reason.txt`)));
  assert.ok(!readEvents(paths.instanceLedger).some((e) => e.event === 'launch'));
});

// ADR-0076. A project whose default branch declares no LF rule commits
// carriage returns. No setting the harness carries can undo that. The door
// refuses it before a slot, a workspace or a seat is spent.
test('a project that declares no line-ending rule does not launch', async (t) => {
  const lanes = {
    solo: { stages: ['work'], handlers: { work: async () => ({ close: { state: 'shipped' } }) } },
  };
  const { origin, paths, daemon } = fixture(t, { lanes, composeRunner: fakeComposeRunner() });
  await daemon.start();

  // An attributes file that normalises nothing: `text=auto` alone leaves the
  // working tree to the host's own `core.autocrlf`.
  commitTree(origin, { '.gitattributes': '* text=auto\n' }, 'drop the lf rule');
  await assert.rejects(
    () => daemon.launchRun({ project: 'alpha', lane: 'solo' }),
    /declares no line-ending rule on main.*holds no line that gives \* the attribute eol=lf/s,
  );

  // No attributes file at all reads the same way, and says which fact it found.
  gitSync(['rm', '--quiet', '.gitattributes'], origin);
  gitSync(['-c', 'commit.gpgsign=false', 'commit', '-m', 'no attributes'], origin);
  writeControlCommand(paths, {
    actor: 'operator',
    command: 'launch',
    project: 'alpha',
    lane: 'solo',
  });
  const stamped = await waitFor(
    () => readEvents(paths.instanceLedger).find((e) => e.event === 'launch-rejected'),
    { label: 'the refusal to be stamped' },
  );
  assert.match(stamped.reason, /\.gitattributes is not on main/);
  assert.match(stamped.reason, /Add the line "\* text=auto eol=lf" to \.gitattributes/);
  assert.equal(stamped.detail.path, '.gitattributes');

  // Nothing was provisioned by either refusal.
  assert.ok(!readEvents(paths.instanceLedger).some((e) => e.event === 'launch'));
  assert.equal(daemon.engine.runs.size, 0);
  assert.deepEqual(existsSync(paths.worktrees) ? readdirSync(paths.worktrees) : [], []);
});

// Git applies the last `eol` a path matches. A rule a later line overrides is
// no rule, and the door reads the file the way git reads it.
test('a line-ending rule a later line overrides does not launch', async (t) => {
  const lanes = {
    solo: { stages: ['work'], handlers: { work: async () => ({ close: { state: 'shipped' } }) } },
  };
  const { origin, daemon } = fixture(t, { lanes, composeRunner: fakeComposeRunner() });
  await daemon.start();
  commitTree(origin, { '.gitattributes': '* text=auto eol=lf\n* eol=crlf\n' }, 'override the rule');
  await assert.rejects(
    () => daemon.launchRun({ project: 'alpha', lane: 'solo' }),
    /declares no line-ending rule on main/,
  );
  // `-text` turns every conversion off, so the rule above it holds nothing.
  commitTree(origin, { '.gitattributes': '* text=auto eol=lf\n* -text\n' }, 'unset text');
  await assert.rejects(
    () => daemon.launchRun({ project: 'alpha', lane: 'solo' }),
    /declares no line-ending rule on main/,
  );
  // `binary` is git's own macro for `-diff -merge -text`, and reads the same.
  commitTree(origin, { '.gitattributes': '* text=auto eol=lf\n*.png binary\n* binary\n' }, 'binary');
  await assert.rejects(
    () => daemon.launchRun({ project: 'alpha', lane: 'solo' }),
    /declares no line-ending rule on main/,
  );
  // The same two lines the other way round is a project that declares the rule.
  // The value is read without case, as git reads its own.
  commitTree(origin, { '.gitattributes': '* eol=crlf\n* text=auto EOL=LF\n' }, 'restore the rule');
  const { runId } = await daemon.launchRun({ project: 'alpha', lane: 'solo' });
  assert.match(runId, /^alpha-/);
});

// The door judges the project on two files of the default branch, and asks the
// world for them once. A refusal with a fetch of its own would make every
// launch pay twice for one read.
test('the door reads the project config and the attributes in one clone pass', async (t) => {
  const { daemon } = fixture(t, { lanes: {}, composeRunner: fakeComposeRunner() });
  await daemon.start();
  let passes = 0;
  const withClone = daemon.isolation.withClone.bind(daemon.isolation);
  daemon.isolation.withClone = (project, read) => {
    passes += 1;
    return withClone(project, read);
  };
  const entry = daemon.config.projects.alpha;
  const door = await daemon.readDoorFiles('alpha', entry);
  assert.equal(passes, 1, 'the door took more than one clone pass');
  assert.equal(door['.gitattributes'].text, '* text=auto eol=lf\n');
  assert.equal(JSON.parse(door[entry.projectConfigPath].text).version, 1);
});

// -- the run cache and the setup measurement ---------------------------------

test('a run gets a cache directory git cannot see, and its commands are told where', async (t) => {
  // ADR-0048. The cache lives in the worktree so it survives every cycle of
  // the run and dies with it, and the candidate capture commits that worktree
  // with `git add -A`: a cache git could see would be committed to the run
  // branch and pushed in the request.
  const gate = deferred();
  let seenCtx = null;
  const lanes = {
    solo: {
      stages: ['work'],
      handlers: {
        work: async (ctx) => {
          seenCtx = ctx;
          await gate.promise;
          return { close: { state: 'shipped' } };
        },
      },
    },
  };
  const { paths, daemon } = fixture(t, { lanes, composeRunner: fakeComposeRunner() });
  await daemon.start();
  const { runId, worktree, projectConfig } = await daemon.launchRun({
    project: 'alpha',
    lane: 'solo',
  });
  const cache = runCacheDir(worktree);
  assert.ok(existsSync(cache), 'the run cache directory was not created');
  await waitFor(() => seenCtx, { label: 'stage handler entered' });
  // Every command and every seat of the run is told where it is.
  assert.equal(runEnv(seenCtx, projectConfig)[RUN_CACHE_ENV], cache);
  // What a cycle leaves in it is invisible to the tree the capture commits.
  writeFileSync(join(cache, 'transform-abc'), 'cached');
  assert.deepEqual(await changedFiles(worktree), []);
  const sha = await commitAll(worktree, 'nothing to commit');
  assert.equal(
    (await filesAt(worktree, sha, [])).filter((f) => f.startsWith('.olympus-cache')).length,
    0,
    'the cache reached a commit',
  );
  gate.resolve();
  await waitFor(() => !existsSync(workspaceRoot(paths, runId)), { label: 'worktree removed' });
  // The next run starts cold: the cache went with the workspace.
  assert.ok(!existsSync(cache));
});

test('a project may refuse the cache, and then nothing offers one', async (t) => {
  const lanes = {
    solo: { stages: ['work'], handlers: { work: async () => ({ close: { state: 'shipped' } }) } },
  };
  const { origin, daemon } = fixture(t, { lanes, composeRunner: fakeComposeRunner() });
  await daemon.start();
  commitTree(origin, { [CONFIG_PATH]: projectConfigJson({ runCache: false }) }, 'no cache');
  const { worktree, projectConfig } = await daemon.launchRun({ project: 'alpha', lane: 'solo' });
  assert.ok(!existsSync(runCacheDir(worktree)));
  const env = runEnv({ runId: 'r', payload: { worktree } }, projectConfig);
  assert.equal(env[RUN_CACHE_ENV], undefined);
});

// A gate command that judges a diff needs the two ends of it. Inside a run
// neither end is a branch a CI variable names, so the harness exports the
// pass's opening sha and the command reads it there.
test('the pass opening sha rides the environment where the base names one', () => {
  const ctx = { runId: 'r', payload: { worktree: null } };
  const config = { runCache: false };
  // No range: the environment is what it was, which is nothing at all here.
  assert.equal(runEnv(ctx, config), undefined);
  assert.equal(runEnv(ctx, config, {}), undefined);
  assert.equal(runEnv(ctx, config, { rangeFrom: '' }), undefined);
  assert.deepEqual(runEnv(ctx, config, { rangeFrom: 'abc1234' }), { [BASE_SHA_ENV]: 'abc1234' });
  assert.equal(BASE_SHA_ENV, 'OLYMPUS_BASE_SHA');
});

test('the launch stamp carries what every step of the setup cost', async (t) => {
  // ADR-0049. Measurement only: nothing reads these figures to decide
  // anything, and every step provisioning performs is one of them.
  const lanes = {
    solo: { stages: ['work'], handlers: { work: async () => ({ close: { state: 'shipped' } }) } },
  };
  const { paths, daemon } = fixture(t, { lanes, composeRunner: fakeComposeRunner() });
  await daemon.start();
  const { runId } = await daemon.launchRun({ project: 'alpha', lane: 'solo' });
  await waitFor(() => existsSync(archivedRunLedgerPath(paths, runId)), { label: 'run archived' });
  const launched = readEvents(archivedRunLedgerPath(paths, runId)).find(
    (e) => e.event === 'run-launched',
  );
  for (const step of ['lockMs', 'cloneMs', 'configMs', 'worktreeMs', 'stackMs', 'totalMs']) {
    assert.equal(typeof launched.setup[step], 'number', step);
    assert.ok(launched.setup[step] >= 0, step);
  }
  // The whole is at least the sum of the parts it holds.
  const steps = ['lockMs', 'cloneMs', 'configMs', 'worktreeMs', 'stackMs'];
  const sum = steps.reduce((total, step) => total + launched.setup[step], 0);
  assert.ok(launched.setup.totalMs >= sum, `${launched.setup.totalMs} < ${sum}`);
  // The workspace record keeps the same reading, so a run whose ledger is
  // archived and a run whose workspace is read answer alike.
  const record = JSON.parse(
    readFileSync(join(paths.archivedRuns, runId, 'workspace.json'), 'utf8'),
  );
  assert.deepEqual(record.setup, launched.setup);
});

test('a project with no stack stamps no stack duration', async (t) => {
  const lanes = {
    solo: { stages: ['work'], handlers: { work: async () => ({ close: { state: 'shipped' } }) } },
  };
  const { origin, paths, daemon } = fixture(t, { lanes, composeRunner: fakeComposeRunner() });
  await daemon.start();
  commitTree(origin, { [CONFIG_PATH]: projectConfigJson({ stack: null }) }, 'no stack');
  const { runId } = await daemon.launchRun({ project: 'alpha', lane: 'solo' });
  await waitFor(() => existsSync(archivedRunLedgerPath(paths, runId)), { label: 'run archived' });
  const launched = readEvents(archivedRunLedgerPath(paths, runId)).find(
    (e) => e.event === 'run-launched',
  );
  assert.equal(launched.setup.stackMs, undefined);
  assert.equal(typeof launched.setup.worktreeMs, 'number');
});
