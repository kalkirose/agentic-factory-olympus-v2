import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunEngine } from '../src/engine/engine.mjs';
import { scaffoldHome, runLedgerPath, archivedRunLedgerPath } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { openLoud, openStreamItems } from '../src/telemetry/readers.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

function setup(t, { slotCaps = { proj: 3 } } = {}) {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const engine = new RunEngine(paths, { getSlotCap: (project) => slotCaps[project] });
  t.after(async () => {
    await engine.stop();
    removeDir(home);
  });
  return { paths, engine };
}

function archivedEvents(paths, runId) {
  return readEvents(archivedRunLedgerPath(paths, runId));
}

test('a scripted dummy run walks all stages and closes', async (t) => {
  const { paths, engine } = setup(t);
  const visited = [];
  engine.registerLane('story', {
    stages: ['prep', 'work', 'wrap'],
    handlers: {
      prep: (ctx) => {
        visited.push(ctx.stage);
        return { next: 'work' };
      },
      work: (ctx) => {
        visited.push(ctx.stage);
        return { next: 'wrap' };
      },
      wrap: (ctx) => {
        visited.push(ctx.stage);
        return { close: { state: 'shipped' } };
      },
    },
  });
  const runId = engine.launch({ runId: 'r1', project: 'proj', lane: 'story', card: '9-9' });
  await waitFor(() => archivedEvents(paths, runId).some((e) => e.event === 'run-closed'), {
    label: 'run closed and archived',
  });
  const events = archivedEvents(paths, runId);
  assert.deepEqual(
    events.map((e) => e.event),
    ['run-launched', 'stage-entered', 'stage-entered', 'stage-entered', 'run-closed'],
  );
  assert.deepEqual(
    events.filter((e) => e.event === 'stage-entered').map((e) => e.stage),
    ['prep', 'work', 'wrap'],
  );
  assert.equal(events[0].card, '9-9');
  assert.equal(events.at(-1).state, 'shipped');
  assert.deepEqual(visited, ['prep', 'work', 'wrap']);
});

test('park frees the slot; a validated answer resumes at the parked stage', async (t) => {
  const { paths, engine } = setup(t);
  engine.registerLane('story', {
    stages: ['decide', 'finish'],
    handlers: {
      decide: (ctx) =>
        ctx.lastAnswer
          ? { next: 'finish' }
          : {
              park: {
                type: 'provisioning-gate',
                question: 'Create the deploy token?',
                options: ['created', 'skip'],
              },
            },
      finish: () => ({ close: { state: 'shipped' } }),
    },
  });
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => readEvents(runLedgerPath(paths, 'r1')).some((e) => e.event === 'park'), {
    label: 'run parked',
  });
  assert.equal(engine.activeCount('proj'), 0);
  assert.ok(engine.hasFreeSlot('proj'));
  const queued = openStreamItems(paths, 'queued');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].event, 'park');
  assert.equal(queued[0].ledger, 'run:r1');

  assert.throws(() => engine.answer({ runId: 'r1', actor: 'operator', option: 'reboot' }), /not offered/);
  assert.throws(() => engine.answer({ runId: 'r1', actor: '', option: 'created' }), /actor/);
  assert.throws(() => engine.answer({ runId: 'r1', actor: 'operator' }), /option or answer/);

  engine.answer({ runId: 'r1', actor: 'operator', option: 'created' });
  await waitFor(() => archivedEvents(paths, 'r1').some((e) => e.event === 'run-closed'), {
    label: 'run closed after answer',
  });
  const events = archivedEvents(paths, 'r1');
  const park = events.find((e) => e.event === 'park');
  assert.equal(park.stream, 'queued');
  assert.ok(park.gist.includes('provisioning-gate'));
  const answer = events.find((e) => e.event === 'answer');
  assert.equal(answer.actor, 'operator');
  assert.equal(answer.option, 'created');
  assert.equal(answer.parkSeq, park.seq);
  assert.ok(answer.ts);
  assert.equal(events.find((e) => e.event === 'resume').stage, 'decide');
  assert.equal(events.at(-1).state, 'shipped');
  assert.throws(() => engine.answer({ runId: 'r1', actor: 'operator', answer: 'again' }), /no open run/);
});

test('slot accounting is per project, lane-agnostic, and gates launch only', async (t) => {
  const { engine } = setup(t, { slotCaps: { alpha: 1, beta: 1 } });
  const hold = {
    stages: ['hold'],
    handlers: { hold: () => new Promise(() => {}) },
  };
  engine.registerLane('story', hold);
  engine.registerLane('repair', hold);
  engine.launch({ runId: 'a1', project: 'alpha', lane: 'story' });
  assert.equal(engine.activeCount('alpha'), 1);
  assert.ok(!engine.hasFreeSlot('alpha'));
  assert.throws(() => engine.launch({ project: 'alpha', lane: 'repair' }), /no free slot/);
  assert.ok(engine.hasFreeSlot('beta'));
  engine.launch({ runId: 'b1', project: 'beta', lane: 'repair' });
  assert.equal(engine.activeCount('beta'), 1);
  assert.throws(() => engine.launch({ project: 'gamma', lane: 'story' }), /unknown project/);
  assert.throws(() => engine.launch({ project: 'alpha', lane: 'nope' }), /unknown lane/);
  assert.deepEqual(engine.checkLiveness(), []);
});

test('a stage that returns no directive is a loud liveness violation', async (t) => {
  const { paths, engine } = setup(t);
  engine.registerLane('broken', {
    stages: ['only'],
    handlers: { only: () => undefined },
  });
  engine.launch({ runId: 'r1', project: 'proj', lane: 'broken' });
  const violation = await waitFor(
    () => readEvents(runLedgerPath(paths, 'r1')).find((e) => e.event === 'liveness-violation'),
    { label: 'liveness violation stamped' },
  );
  assert.equal(violation.stream, 'loud');
  assert.ok(violation.gist.includes('r1'));
  const loud = openLoud(paths);
  assert.equal(loud.length, 1);
  assert.equal(loud[0].ledger, 'run:r1');
  // Alert, never auto-kill: the run stays open and holds its slot.
  assert.equal(archivedEvents(paths, 'r1').length, 0);
  assert.equal(engine.activeCount('proj'), 1);
  // The console kills it.
  engine.killRun('r1', { actor: 'operator' });
  const closed = archivedEvents(paths, 'r1').at(-1);
  assert.equal(closed.event, 'run-closed');
  assert.equal(closed.state, 'killed');
  assert.equal(closed.actor, 'operator');
});

test('a handler error and an off-catalog park both violate loud', async (t) => {
  const { paths, engine } = setup(t);
  engine.registerLane('throws', {
    stages: ['only'],
    handlers: {
      only: () => {
        throw new Error('handler bug');
      },
    },
  });
  engine.registerLane('bad-park', {
    stages: ['only'],
    handlers: { only: () => ({ park: { type: 'coffee-break', question: 'Espresso?' } }) },
  });
  engine.launch({ runId: 'r-throw', project: 'proj', lane: 'throws' });
  engine.launch({ runId: 'r-park', project: 'proj', lane: 'bad-park' });
  const thrown = await waitFor(
    () => readEvents(runLedgerPath(paths, 'r-throw')).find((e) => e.event === 'liveness-violation'),
    { label: 'handler error violation' },
  );
  assert.match(thrown.detail, /handler bug/);
  const badPark = await waitFor(
    () => readEvents(runLedgerPath(paths, 'r-park')).find((e) => e.event === 'liveness-violation'),
    { label: 'off-catalog park violation' },
  );
  assert.match(badPark.detail, /not in the catalog/);
  assert.ok(!readEvents(runLedgerPath(paths, 'r-park')).some((e) => e.event === 'park'));
  assert.equal(openLoud(paths).length, 2);
});
