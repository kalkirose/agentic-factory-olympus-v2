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
import { workspaceRoot } from '../src/isolation/worktrees.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import {
  tempDir,
  removeDir,
  waitFor,
  initOriginRepo,
  commitTree,
  projectConfigJson,
  fakeComposeRunner,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';

function fixture(t, { lanes, composeRunner }) {
  const root = tempDir();
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson(),
    'compose.harness.yml': 'services: {}\n',
  });
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { alpha: { repoUrl: origin, slotCap: 2 } } }) + '\n',
  );
  const daemon = new Daemon(join(root, 'home'), { lanes, composeRunner });
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
    /ticket applies to the repair lane only \(lane: story\)/,
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
