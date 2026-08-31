// A run adopts a project config that exists (ADR-0061): the replay precedence,
// the engine's own refusals, the console route through the daemon, and what a
// restart derives. The launch record is never edited, so every one of these
// reads `run-launched` afterwards and finds it as it was written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { writeControlCommand } from '../src/daemon/control.mjs';
import { deriveRunState } from '../src/engine/replay.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { loadProjectConfig } from '../src/lanes/shared.mjs';
import {
  tempDir,
  removeDir,
  waitFor,
  initOriginRepo,
  commitTree,
  projectConfigJson,
  gitSync,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';

// -- the replay ---------------------------------------------------------------

function line(seq, event, fields) {
  return { seq, ts: `2026-08-31T00:00:0${seq}Z`, event, ...fields };
}

test('replay applies the newest reconfigure over the launch pin', () => {
  const state = deriveRunState([
    line(1, 'run-launched', {
      project: 'p',
      lane: 'story',
      configBlob: 'aaa',
      worktree: '/w',
      baseSha: 'base1',
    }),
    line(2, 'stage-entered', { stage: 'one' }),
    line(3, 'run-reconfigured', { configBlob: 'bbb', from: 'aaa', reason: 'first' }),
    line(4, 'run-reconfigured', { configBlob: 'ccc', from: 'bbb', reason: 'second' }),
  ]);
  assert.equal(state.payload.configBlob, 'ccc');
  // Only the pin moves. Every other launch value is a fact about the launch.
  assert.equal(state.payload.worktree, '/w');
  assert.equal(state.payload.baseSha, 'base1');
  assert.equal(state.stage, 'one');
});

test('a ledger with no reconfigure derives the pin the launch recorded', () => {
  const state = deriveRunState([
    line(1, 'run-launched', { project: 'p', lane: 'story', configBlob: 'aaa' }),
  ]);
  assert.equal(state.payload.configBlob, 'aaa');
});

// -- the engine ---------------------------------------------------------------

function engineFixture(t, { lanes }) {
  const root = tempDir();
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson({ conventions: ['first'], stack: null }),
  });
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { proj: { repoUrl: origin, slotCap: 2 } } }) + '\n',
  );
  const daemon = new Daemon(join(root, 'home'), { lanes });
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  return { root, origin, paths, daemon };
}

/** A lane that parks on entry and re-reads its project config every time. */
function parkingLane(seen) {
  return {
    stages: ['gate'],
    handlers: {
      gate: async (ctx) => {
        seen.push((await loadProjectConfig(ctx)).conventions[0]);
        return {
          park: { type: 'provisioning-gate', question: 'The world says no.', options: ['retry'] },
        };
      },
    },
  };
}

test('a reconfigure repins an open run, and the stage after it reads the new config', async (t) => {
  const seen = [];
  const fx = engineFixture(t, { lanes: { solo: parkingLane(seen) } });
  await fx.daemon.start();
  const { runId } = await fx.daemon.launchRun({ project: 'proj', lane: 'solo' });
  await waitFor(() => seen.length === 1, { label: 'first config read' });
  assert.deepEqual(seen, ['first']);
  const launched = readEvents(runLedgerPath(fx.paths, runId)).find(
    (e) => e.event === 'run-launched',
  );

  // The config the launch could not have seen.
  commitTree(fx.origin, { [CONFIG_PATH]: projectConfigJson({ conventions: ['second'], stack: null }) }, 'config');
  writeControlCommand(fx.paths, {
    command: 'reconfigure',
    actor: 'console:test',
    runId,
    reason: 'the launch pinned a config that named a retired surface',
  });
  const stamp = await waitFor(
    () => readEvents(runLedgerPath(fx.paths, runId)).find((e) => e.event === 'run-reconfigured'),
    { label: 'reconfigure stamp' },
  );
  assert.equal(stamp.actor, 'console:test');
  assert.equal(stamp.source, 'branch');
  assert.equal(stamp.from, launched.configBlob);
  assert.notEqual(stamp.configBlob, launched.configBlob);
  assert.equal(stamp.parked, true);
  assert.equal(stamp.stage, 'gate');
  assert.match(stamp.reason, /retired surface/);
  // The run did not re-enter its stage on the repin alone.
  assert.deepEqual(seen, ['first']);

  // The launch record still says what the launch did.
  const relaunched = readEvents(runLedgerPath(fx.paths, runId)).find(
    (e) => e.event === 'run-launched',
  );
  assert.equal(relaunched.configBlob, launched.configBlob);

  // The answer that follows meets the new config.
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'retry' });
  await waitFor(() => seen.length === 2, { label: 'second config read' });
  assert.deepEqual(seen, ['first', 'second']);
});

test('a reconfigure is refused without a reason, and refused onto the pin the run holds', async (t) => {
  const seen = [];
  const fx = engineFixture(t, { lanes: { solo: parkingLane(seen) } });
  await fx.daemon.start();
  const { runId } = await fx.daemon.launchRun({ project: 'proj', lane: 'solo' });
  await waitFor(() => seen.length === 1, { label: 'config read' });
  const blob = readEvents(runLedgerPath(fx.paths, runId)).find(
    (e) => e.event === 'run-launched',
  ).configBlob;
  assert.throws(
    () => fx.daemon.engine.reconfigure({ runId, actor: 'a', configBlob: 'x', reason: '  ' }),
    /carries the reason for it/,
  );
  assert.throws(
    () => fx.daemon.engine.reconfigure({ runId, actor: 'a', configBlob: blob, reason: 'no move' }),
    new RegExp(`already reads config blob ${blob}`),
  );
  assert.throws(
    () => fx.daemon.engine.reconfigure({ runId: 'nobody', actor: 'a', configBlob: 'x', reason: 'r' }),
    /no open run: nobody/,
  );
  assert.ok(!readEvents(runLedgerPath(fx.paths, runId)).some((e) => e.event === 'run-reconfigured'));
});

test('a reconfigure onto a config that does not validate is refused before it is stamped', async (t) => {
  const seen = [];
  const fx = engineFixture(t, { lanes: { solo: parkingLane(seen) } });
  await fx.daemon.start();
  const { runId } = await fx.daemon.launchRun({ project: 'proj', lane: 'solo' });
  await waitFor(() => seen.length === 1, { label: 'config read' });
  // A config on the branch that no stage could load. A run pinned to it would
  // fail at every stage instead of at this command.
  commitTree(fx.origin, { [CONFIG_PATH]: '{ "version": 1, "gates": 4 }\n' }, 'bad config');
  await assert.rejects(
    fx.daemon.reconfigureCommand({ actor: 'console:test', runId, reason: 'adopt the branch' }),
    /project config invalid/,
  );
  assert.ok(!readEvents(runLedgerPath(fx.paths, runId)).some((e) => e.event === 'run-reconfigured'));
  // And a blob the clone does not hold is refused the same way.
  await assert.rejects(
    fx.daemon.reconfigureCommand({
      actor: 'console:test',
      runId,
      blob: '0000000000000000000000000000000000000000',
      reason: 'a blob nobody has',
    }),
  );
  assert.ok(!readEvents(runLedgerPath(fx.paths, runId)).some((e) => e.event === 'run-reconfigured'));
});

test('a named blob pins that config, and a restart resumes on the pin the ledger holds', async (t) => {
  const seen = [];
  const fx = engineFixture(t, { lanes: { solo: parkingLane(seen) } });
  await fx.daemon.start();
  const { runId } = await fx.daemon.launchRun({ project: 'proj', lane: 'solo' });
  await waitFor(() => seen.length === 1, { label: 'config read' });
  // A config that exists on the branch, named by its blob rather than found.
  commitTree(fx.origin, { [CONFIG_PATH]: projectConfigJson({ conventions: ['named'], stack: null }) }, 'config');
  const blob = gitSync(['rev-parse', `HEAD:${CONFIG_PATH}`], fx.origin).trim();
  // The clone has to hold it: the run's stages read the blob out of the clone.
  await fx.daemon.isolation.withClone('proj', async () => {
    gitSync(['fetch', '--prune', 'origin'], join(fx.paths.clones, 'proj.git'));
  });
  await fx.daemon.reconfigureCommand({
    actor: 'console:test',
    runId,
    blob,
    reason: 'the config the operator read',
  });
  const stamp = readEvents(runLedgerPath(fx.paths, runId)).find(
    (e) => e.event === 'run-reconfigured',
  );
  assert.equal(stamp.configBlob, blob);
  assert.equal(stamp.source, 'named');
  await fx.daemon.stop();

  // The restart derives the pin from the ledger, not from the launch.
  const second = new Daemon(join(fx.root, 'home'), { lanes: { solo: parkingLane(seen) } });
  t.after(async () => second.stop());
  await second.start();
  assert.equal(second.engine.runs.get(runId).payload.configBlob, blob);
  second.engine.answer({ runId, actor: 'operator', option: 'retry' });
  await waitFor(() => seen.length === 2, { label: 'config read after the restart' });
  assert.deepEqual(seen, ['first', 'named']);
});
