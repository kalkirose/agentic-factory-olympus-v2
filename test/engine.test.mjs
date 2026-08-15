import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RunEngine } from '../src/engine/engine.mjs';
import { scaffoldHome, runLedgerPath, archivedRunLedgerPath } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { openInstanceStore } from '../src/telemetry/stores.mjs';
import { openLoud, openStreamItems } from '../src/telemetry/readers.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

function setup(t, { slotCaps = { proj: 3 }, instance = false, archiveIo } = {}) {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const instanceStore = instance ? openInstanceStore(paths) : null;
  const engine = new RunEngine(paths, {
    getSlotCap: (project) => slotCaps[project],
    ...(instanceStore !== null && { instanceStore }),
    ...(archiveIo !== undefined && { archiveIo }),
  });
  t.after(async () => {
    await engine.stop();
    instanceStore?.close();
    removeDir(home);
  });
  return { paths, engine, instanceStore };
}

// A move nothing can complete: the handle an external reader holds, in the
// only form a test can stage on every platform.
function blockedMove() {
  throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
}

const closingLane = {
  stages: ['only'],
  handlers: { only: () => ({ close: { state: 'shipped' } }) },
};

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

  // Every refusal quotes the forms the record declared, and the declaration
  // holds the abandon the site never named (ADR-0029).
  assert.throws(
    () => engine.answer({ runId: 'r1', actor: 'operator', option: 'reboot' }),
    /not offered by the escalation record: reboot — this park accepts --option created\|skip\|abandon$/,
  );
  assert.throws(() => engine.answer({ runId: 'r1', actor: '', option: 'created' }), /actor/);
  assert.throws(
    () => engine.answer({ runId: 'r1', actor: 'operator' }),
    /an answer is required — this park accepts --option created\|skip\|abandon$/,
  );
  // The park declared no text slot, so text is refused with the same line.
  assert.throws(
    () => engine.answer({ runId: 'r1', actor: 'operator', answer: 'done it' }),
    /takes no answer text/,
  );

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

// -- a blocked archive --------------------------------------------------------

test('an archive nothing can move stamps loud, and the engine runs on', async (t) => {
  const { paths, engine } = setup(t, {
    instance: true,
    archiveIo: { rename: blockedMove, copy: blockedMove, sleep: () => {} },
  });
  engine.registerLane('story', closingLane);
  engine.launch({ runId: 'r-blocked', project: 'proj', lane: 'story' });
  const failure = await waitFor(
    () => readEvents(paths.instanceLedger).find((e) => e.event === 'archive-failed'),
    { label: 'archive failure stamped' },
  );
  assert.equal(failure.runId, 'r-blocked');
  assert.match(failure.reason, /EPERM/);
  assert.equal(failure.stream, 'loud');
  assert.ok(failure.gist.includes('r-blocked'));
  // The close itself stood. The run closed shipped, in place, and let go of
  // its slot; only the directory is where it should not be.
  const events = readEvents(runLedgerPath(paths, 'r-blocked'));
  assert.equal(events.at(-1).event, 'run-closed');
  assert.equal(events.at(-1).state, 'shipped');
  assert.equal(engine.activeCount('proj'), 0);
  // And the engine takes the next run, which archives the ordinary way.
  engine.archiveIo = {};
  engine.launch({ runId: 'r-next', project: 'proj', lane: 'story' });
  await waitFor(() => archivedEvents(paths, 'r-next').some((e) => e.event === 'run-closed'), {
    label: 'the next run archived',
  });
  // A different run reaching the archive says nothing about the blocked one.
  assert.deepEqual(
    openLoud(paths).map((e) => e.event),
    ['archive-failed'],
  );
});

test('a start clears the copy source a delete could not take, and stays quiet', async (t) => {
  const { paths, engine, instanceStore } = setup(t, {
    instance: true,
    // The delete after the copy is the one call that fails: the archive gets
    // the run, and the live directory stays where it was.
    archiveIo: {
      rename: blockedMove,
      remove: () => {
        throw new Error('EBUSY: resource busy or locked');
      },
      sleep: () => {},
    },
  });
  engine.registerLane('story', closingLane);
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  const archived = await waitFor(
    () => readEvents(paths.instanceLedger).find((e) => e.event === 'run-archived'),
    { label: 'run archived by copy' },
  );
  assert.equal(archived.method, 'copy');
  assert.equal(archived.leftover, join(paths.runs, 'r1'));
  assert.ok(existsSync(join(paths.runs, 'r1')));
  assert.deepEqual(openLoud(paths), []);
  await engine.stop();

  const revived = new RunEngine(paths, { instanceStore, getSlotCap: () => 3 });
  t.after(async () => revived.stop());
  assert.deepEqual(revived.resumeOpenRuns(), []);
  // The archive already held the run, so the leftover goes and nothing is
  // stamped: there was never anything for the owner to decide.
  assert.ok(!existsSync(join(paths.runs, 'r1')));
  assert.deepEqual(openLoud(paths), []);
  assert.equal(readEvents(paths.instanceLedger).filter((e) => e.event === 'run-archived').length, 1);
});

test('a start archives what a blocked move left behind, and the record resolves', async (t) => {
  const { paths, engine, instanceStore } = setup(t, {
    instance: true,
    archiveIo: { rename: blockedMove, copy: blockedMove, sleep: () => {} },
  });
  engine.registerLane('story', closingLane);
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  const failure = await waitFor(
    () => readEvents(paths.instanceLedger).find((e) => e.event === 'archive-failed'),
    { label: 'archive failure stamped' },
  );
  await engine.stop();
  assert.equal(openLoud(paths).length, 1);

  // The next daemon over the same home. The handle went with the process that
  // held it, so the start sweeps up the closed run the last one left in place.
  const revived = new RunEngine(paths, { instanceStore, getSlotCap: () => 3 });
  revived.registerLane('story', closingLane);
  t.after(async () => revived.stop());
  assert.deepEqual(revived.resumeOpenRuns(), []);
  assert.ok(!existsSync(join(paths.runs, 'r1')));
  assert.equal(archivedEvents(paths, 'r1').at(-1).state, 'shipped');

  const instance = readEvents(paths.instanceLedger);
  const archived = instance.find((e) => e.event === 'run-archived');
  assert.equal(archived.runId, 'r1');
  assert.equal(archived.method, 'rename');
  const resolution = instance.find((e) => e.event === 'resolved');
  assert.equal(resolution.resolves, failure.seq);
  assert.equal(resolution.resolvedEvent, 'archive-failed');
  assert.equal(resolution.runId, 'r1');
  assert.deepEqual(openLoud(paths), []);
});
