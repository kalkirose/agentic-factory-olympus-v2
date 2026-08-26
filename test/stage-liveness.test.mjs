// Liveness for a stage in progress: the poll beat a polling handler stamps,
// the stage beat the engine runs over every handler, the duration history the
// ledgers hold, and the tripwire that reads one against the other. The
// tripwire tests drive the watcher over fixture ledgers, because what is under
// test is a reading — no forge, no worktree, and by construction nothing the
// watcher could write to a run. The stage-beat tests drive a real engine over
// a fixture lane, because what is under test is the wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RunEngine } from '../src/engine/engine.mjs';
import { scaffoldHome, runLedgerPath, archivedRunLedgerPath } from '../src/daemon/home.mjs';
import { openInstanceStore, openRunStore } from '../src/telemetry/stores.mjs';
import { openStreamItems } from '../src/telemetry/readers.mjs';
import { escalationQueue } from '../src/telemetry/queue.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { BEATS_PER_STAMP, stageHeartbeat } from '../src/telemetry/heartbeat.mjs';
import {
  BAND_FACTOR,
  MIN_SAMPLES,
  activeMs,
  durationBand,
  stageDurations,
  stageVisits,
} from '../src/tripwires/duration.mjs';
import { TripwireWatcher } from '../src/tripwires/watcher.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

const MINUTE = 60000;

function home(t) {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  return scaffoldHome(dir);
}

/** A stage context with a real run store behind it. */
function stageCtx(t, paths, stage) {
  const store = openRunStore(paths, 'r1');
  t.after(() => store.close());
  store.append('run-launched', { actor: 'daemon', project: 'p', lane: 'story' });
  return { stage, store, paths, runId: 'r1' };
}

function beats(paths, runId = 'r1') {
  return readEvents(runLedgerPath(paths, runId)).filter((e) => e.event === 'stage-heartbeat');
}

// -- the heartbeat ------------------------------------------------------------

test('a silent stage stamps one heartbeat per batch of poll outcomes', (t) => {
  const paths = home(t);
  const ctx = stageCtx(t, paths, 'ship');
  let clock = 0;
  const heart = stageHeartbeat(ctx, { every: 4, now: () => clock });
  for (let i = 0; i < 3; i++) {
    clock += 1000;
    assert.equal(heart.beat('checks'), null);
  }
  assert.deepEqual(beats(paths), []); // a stage that settles in its first batch says nothing
  clock += 1000;
  const stamp = heart.beat('checks');
  assert.equal(stamp.event, 'stage-heartbeat');
  assert.equal(stamp.stage, 'ship');
  assert.equal(stamp.waitingOn, 'checks');
  assert.equal(stamp.polls, 4);
  assert.equal(stamp.elapsed, 4000);
  for (let i = 0; i < 8; i++) {
    clock += 1000;
    heart.beat('checks');
  }
  assert.deepEqual(
    beats(paths).map((e) => e.polls),
    [4, 8, 12],
  );
  assert.deepEqual(
    beats(paths).map((e) => e.elapsed),
    [4000, 8000, 12000],
  );
});

test('a long wait coalesces: the stamps are the polls over the batch', (t) => {
  const paths = home(t);
  const ctx = stageCtx(t, paths, 'ship');
  const heart = stageHeartbeat(ctx);
  const polls = BEATS_PER_STAMP * 50;
  for (let i = 0; i < polls; i++) heart.beat('checks');
  assert.equal(heart.polls(), polls);
  assert.equal(beats(paths).length, 50);
});

test('a heartbeat carries the evidence of the wait it stands for', (t) => {
  const paths = home(t);
  const ctx = stageCtx(t, paths, 'close-out');
  const heart = stageHeartbeat(ctx, { every: 1 });
  heart.beat('merge-commit-checks', { sha: 'abc1234' });
  heart.beat('ship-token');
  const [first, second] = beats(paths);
  assert.equal(first.stage, 'close-out');
  assert.deepEqual(first.detail, { sha: 'abc1234' });
  assert.equal(second.waitingOn, 'ship-token');
  assert.equal(second.detail, undefined);
});

// -- the stage beat -----------------------------------------------------------

const PULSE = 40;

/** An engine whose stage beat runs fast enough for a test to watch it. */
function engineOver(t, paths, { instanceStore, onEvent } = {}) {
  const engine = new RunEngine(paths, {
    getSlotCap: () => 3,
    heartbeatMs: PULSE,
    ...(instanceStore !== undefined && { instanceStore }),
    ...(onEvent !== undefined && { onEvent }),
  });
  t.after(() => engine.stop());
  return engine;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function beatsIn(events, stage) {
  return events.filter((e) => e.event === 'stage-heartbeat' && e.stage === stage);
}

test('every stage of a run beats, whatever the stage is holding', async (t) => {
  const paths = home(t);
  const engine = engineOver(t, paths);
  engine.registerLane('story', {
    stages: ['think', 'work', 'wrap'],
    handlers: {
      // A handler with no child at all: the stage the invariant sees as a
      // transition in progress and nothing else.
      think: async () => {
        await pause(PULSE * 4);
        return { next: 'work' };
      },
      // A handler holding a seat that says nothing — the shape that went four
      // hours without a stamp before the stage beat existed.
      work: async (ctx) => {
        await ctx.supervise({
          seat: 'dev',
          cmd: process.execPath,
          args: ['-e', `setTimeout(() => process.exit(0), ${PULSE * 4})`],
        });
        return { next: 'wrap' };
      },
      wrap: async () => {
        await pause(PULSE * 4);
        return { close: { state: 'shipped' } };
      },
    },
  });
  engine.launch({ runId: 'r1', project: 'p', lane: 'story' });
  await waitFor(
    () => readEvents(archivedRunLedgerPath(paths, 'r1')).some((e) => e.event === 'run-closed'),
    { label: 'run closed', attempts: 200, intervalMs: 25 },
  );
  const events = readEvents(archivedRunLedgerPath(paths, 'r1'));
  for (const stage of ['think', 'work', 'wrap']) {
    assert.ok(beatsIn(events, stage).length >= 1, `${stage} stamped no heartbeat`);
  }
  // The beat says what the stage is waiting on in the terms the stage has.
  const held = beatsIn(events, 'work')[0];
  assert.equal(held.waitingOn, 'seat');
  assert.deepEqual(held.detail, { seats: ['dev'] });
  assert.ok(held.elapsed > 0);
  assert.equal(held.beats, 1);
  assert.equal(beatsIn(events, 'think')[0].waitingOn, 'handler');
  // The beat records and decides nothing: the run walked its stages and closed
  // exactly as it would have.
  assert.equal(events.at(-1).state, 'shipped');
});

test('a stage that settles inside its first interval says nothing at all', async (t) => {
  const paths = home(t);
  const engine = engineOver(t, paths);
  engine.registerLane('story', {
    stages: ['only'],
    handlers: { only: () => ({ close: { state: 'shipped' } }) },
  });
  engine.launch({ runId: 'r1', project: 'p', lane: 'story' });
  await waitFor(
    () => readEvents(archivedRunLedgerPath(paths, 'r1')).some((e) => e.event === 'run-closed'),
    { label: 'run closed', attempts: 200, intervalMs: 25 },
  );
  await pause(PULSE * 3);
  const events = readEvents(archivedRunLedgerPath(paths, 'r1'));
  assert.deepEqual(
    events.map((e) => e.event),
    ['run-launched', 'stage-entered', 'run-closed'],
  );
});

test('the stage beat stands down while a polling handler speaks for the stage', async (t) => {
  const paths = home(t);
  const engine = engineOver(t, paths);
  engine.registerLane('story', {
    stages: ['poll'],
    handlers: {
      poll: async (ctx) => {
        const heart = stageHeartbeat(ctx, { every: 1 });
        for (let i = 0; i < 30; i++) {
          await pause(PULSE / 4);
          heart.beat('checks', { pr: 7 });
        }
        return { close: { state: 'shipped' } };
      },
    },
  });
  engine.launch({ runId: 'r1', project: 'p', lane: 'story' });
  await waitFor(
    () => readEvents(archivedRunLedgerPath(paths, 'r1')).some((e) => e.event === 'run-closed'),
    { label: 'run closed', attempts: 200, intervalMs: 25 },
  );
  const stamps = beatsIn(readEvents(archivedRunLedgerPath(paths, 'r1')), 'poll');
  assert.equal(stamps.length, 30);
  // Every one of them is the handler's own, with the evidence of the wait. The
  // stage beat had nothing to add and added nothing.
  assert.ok(stamps.every((e) => e.polls !== undefined && e.beats === undefined));
  assert.deepEqual(stamps[0].detail, { pr: 7 });
});

// -- duration history ---------------------------------------------------------

const at = (minute) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

test('a visit runs from the entry, or from the resume behind an answer', () => {
  const visits = stageVisits([
    { event: 'stage-entered', stage: 'ship', ts: at(0) },
    { event: 'park', ts: at(1) },
    // The human took nine minutes. The stage did not.
    { event: 'answer', ts: at(10) },
    { event: 'resume', ts: at(10) },
    { event: 'stage-entered', stage: 'close-out', ts: at(12) },
    { event: 'run-closed', ts: at(15) },
  ]);
  assert.deepEqual(
    visits.map((v) => v.stage),
    ['ship', 'close-out'],
  );
  assert.deepEqual(stageDurations(
    [
      { event: 'stage-entered', stage: 'ship', ts: at(0) },
      { event: 'resume', ts: at(10) },
      { event: 'stage-entered', stage: 'close-out', ts: at(12) },
      { event: 'run-closed', ts: at(15) },
    ],
    'ship',
  ), [2 * MINUTE]);
});

test('a resumed entry ends no visit, and an open visit is no sample at all', () => {
  const events = [
    { event: 'stage-entered', stage: 'ship', ts: at(0) },
    // The daemon stopped here and started again. The gap is the daemon's.
    { event: 'stage-entered', stage: 'ship', ts: at(40), resumed: true },
    { event: 'stage-entered', stage: 'close-out', ts: at(45) },
  ];
  assert.deepEqual(stageDurations(events, 'ship'), [5 * MINUTE]);
  assert.deepEqual(stageDurations(events, 'close-out'), []);
});

// -- work versus waiting ------------------------------------------------------

const launched = { seq: 1, ts: at(0), event: 'run-launched', actor: 'daemon', project: 'p', lane: 'story' };

test('a parked hour inside a visit is no part of the sample', () => {
  // The park nobody answered before the run closed: the visit ran to the close
  // stamp, and every minute of it used to be a sample of the stage.
  const events = [
    launched,
    { event: 'stage-entered', stage: 'verdict', ts: at(0) },
    { event: 'park', type: 'provisioning-gate', ts: at(1) },
    { event: 'run-closed', state: 'killed', ts: at(9) },
  ];
  assert.deepEqual(stageDurations(events, 'verdict'), [MINUTE]);
});

test('a ship-token wait is no part of an update sample', () => {
  const events = [
    launched,
    { event: 'stage-entered', stage: 'update', ts: at(0) },
    { event: 'ship-token', state: 'waiting', holder: 'other', ts: at(0) },
    { event: 'ship-token', state: 'acquired', ts: at(5) },
    { event: 'stage-entered', stage: 'ship', ts: at(7) },
    { event: 'run-closed', state: 'shipped', ts: at(9) },
  ];
  // Five minutes queued, two minutes of work. Only the work is a sample, so a
  // queue wait can never widen the band that is supposed to flag one.
  assert.deepEqual(stageDurations(events, 'update'), [2 * MINUTE]);
  assert.equal(activeMs(events, at(0), at(7)), 2 * MINUTE);
});

test('a band needs a history, and its top is never below the slowest visit', () => {
  const thin = Array(MIN_SAMPLES - 1).fill(MINUTE);
  assert.equal(durationBand(thin), null);
  const tight = Array(MIN_SAMPLES).fill(MINUTE);
  assert.deepEqual(durationBand(tight), {
    samples: MIN_SAMPLES,
    median: MINUTE,
    max: MINUTE,
    upper: BAND_FACTOR * MINUTE,
  });
  // One slow visit widens the band it belongs to: the top is what has happened.
  const withOutlier = [MINUTE, MINUTE, MINUTE, MINUTE, 90 * MINUTE];
  assert.equal(durationBand(withOutlier).upper, 90 * MINUTE);
});

// -- the stage-duration tripwire ----------------------------------------------

function writeLedger(path, lines) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** A shipped run whose `ship` stage took `ms`. The band is built from these. */
function historyRun(paths, runId, ms, { project = 'p', lane = 'story' } = {}) {
  const start = Date.parse(at(0));
  const iso = (offset) => new Date(start + offset).toISOString();
  writeLedger(runLedgerPath(paths, runId), [
    { seq: 1, ts: iso(0), event: 'run-launched', actor: 'daemon', project, lane },
    { seq: 2, ts: iso(0), event: 'stage-entered', actor: 'daemon', stage: 'ship' },
    { seq: 3, ts: iso(ms), event: 'stage-entered', actor: 'daemon', stage: 'close-out' },
    { seq: 4, ts: iso(ms), event: 'run-closed', actor: 'daemon', state: 'shipped' },
  ]);
}

/** The run under the tripwire: launched, in `ship`, and nothing else. */
function openRun(paths, runId, { project = 'p', lane = 'story' } = {}) {
  writeLedger(runLedgerPath(paths, runId), [
    { seq: 1, ts: at(0), event: 'run-launched', actor: 'daemon', project, lane },
    { seq: 2, ts: at(0), event: 'stage-entered', actor: 'daemon', stage: 'ship' },
  ]);
}

function heartbeat(elapsed, extra = {}) {
  return {
    seq: 3,
    ts: at(1),
    event: 'stage-heartbeat',
    stage: 'ship',
    waitingOn: 'checks',
    polls: BEATS_PER_STAMP,
    elapsed,
    ...extra,
  };
}

function watcherOver(t, paths) {
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const watcher = new TripwireWatcher({ paths, ledger });
  // An empty registry: the stage key is the harness's own, and no project
  // configures it.
  watcher.setRegistry('p', []);
  return { ledger, watcher };
}

function overruns(paths) {
  return readEvents(paths.instanceLedger).filter((e) => e.event === 'stage-overrun');
}

test('a stage past its band opens one queued record, whatever the heartbeat count', async (t) => {
  const paths = home(t);
  for (let i = 0; i < MIN_SAMPLES; i++) historyRun(paths, `past-${i}`, 10 * MINUTE);
  openRun(paths, 'live');
  const { watcher } = watcherOver(t, paths);
  await watcher.notify('p', heartbeat(150 * MINUTE), 'run:live');
  const records = overruns(paths);
  assert.equal(records.length, 1);
  assert.equal(records[0].runId, 'live');
  assert.equal(records[0].lane, 'story');
  assert.equal(records[0].stage, 'ship');
  assert.equal(records[0].waitingOn, 'checks');
  assert.equal(records[0].elapsed, 150 * MINUTE);
  assert.deepEqual(records[0].band, {
    samples: MIN_SAMPLES,
    median: 10 * MINUTE,
    max: 10 * MINUTE,
    upper: BAND_FACTOR * 10 * MINUTE,
  });
  assert.match(records[0].gist, /has been in ship/);
  // The operator's surface holds it, once, with its evidence.
  assert.equal(openStreamItems(paths, 'queued').length, 1);
  assert.equal(escalationQueue(paths).length, 1);
  // Every later heartbeat of the same stage reports the same condition, and
  // the record was already opened.
  await watcher.notify('p', heartbeat(160 * MINUTE, { seq: 4 }), 'run:live');
  await watcher.notify('p', heartbeat(170 * MINUTE, { seq: 5 }), 'run:live');
  assert.equal(overruns(paths).length, 1);
});

test('a stage inside its band opens nothing', async (t) => {
  const paths = home(t);
  for (let i = 0; i < MIN_SAMPLES; i++) historyRun(paths, `past-${i}`, 10 * MINUTE);
  openRun(paths, 'live');
  const { watcher } = watcherOver(t, paths);
  await watcher.notify('p', heartbeat(BAND_FACTOR * 10 * MINUTE), 'run:live');
  assert.deepEqual(overruns(paths), []);
});

test('no history is no band, and a cold start is quiet', async (t) => {
  const paths = home(t);
  for (let i = 0; i < MIN_SAMPLES - 1; i++) historyRun(paths, `past-${i}`, 10 * MINUTE);
  // Another lane's stage of the same name is another stage: it never fills
  // this history.
  for (let i = 0; i < MIN_SAMPLES; i++) {
    historyRun(paths, `repair-${i}`, MINUTE, { lane: 'repair' });
  }
  openRun(paths, 'live');
  const { watcher } = watcherOver(t, paths);
  await watcher.notify('p', heartbeat(500 * MINUTE), 'run:live');
  assert.deepEqual(overruns(paths), []);
  assert.deepEqual(openStreamItems(paths, 'queued'), []);
});

test('the tripwire writes nothing to the run it reports on', async (t) => {
  const paths = home(t);
  for (let i = 0; i < MIN_SAMPLES; i++) historyRun(paths, `past-${i}`, 10 * MINUTE);
  openRun(paths, 'live');
  const before = readFileSync(runLedgerPath(paths, 'live'), 'utf8');
  const { watcher } = watcherOver(t, paths);
  await watcher.notify('p', heartbeat(150 * MINUTE), 'run:live');
  assert.equal(overruns(paths).length, 1);
  // The run's own ledger is the run's state. The tripwire detects and reports;
  // it never moves a run, closes one, or asks one to stop.
  assert.equal(readFileSync(runLedgerPath(paths, 'live'), 'utf8'), before);
});

test('the record closes when the stage moves on; a resumed stage keeps it open', async (t) => {
  const paths = home(t);
  for (let i = 0; i < MIN_SAMPLES; i++) historyRun(paths, `past-${i}`, 10 * MINUTE);
  openRun(paths, 'live');
  const { watcher } = watcherOver(t, paths);
  await watcher.notify('p', heartbeat(150 * MINUTE), 'run:live');
  assert.equal(openStreamItems(paths, 'queued').length, 1);
  // A daemon that restarted re-enters the stage the run never left.
  await watcher.notify(
    'p',
    { seq: 4, ts: at(2), event: 'stage-entered', stage: 'ship', resumed: true },
    'run:live',
  );
  assert.equal(openStreamItems(paths, 'queued').length, 1);
  // The stage ended: the record asked the operator to look at a stage that is
  // over.
  await watcher.notify(
    'p',
    { seq: 5, ts: at(3), event: 'stage-entered', stage: 'close-out' },
    'run:live',
  );
  assert.deepEqual(openStreamItems(paths, 'queued'), []);
  const resolved = readEvents(paths.instanceLedger).filter((e) => e.event === 'resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].resolvedEvent, 'stage-overrun');
});

/** A shipped run whose visit to `stage` took `ms`. */
function historyStage(paths, runId, stage, ms, { project = 'p', lane = 'story' } = {}) {
  const start = Date.parse(at(0));
  const iso = (offset) => new Date(start + offset).toISOString();
  writeLedger(runLedgerPath(paths, runId), [
    { seq: 1, ts: iso(0), event: 'run-launched', actor: 'daemon', project, lane },
    { seq: 2, ts: iso(0), event: 'stage-entered', actor: 'daemon', stage },
    { seq: 3, ts: iso(ms), event: 'stage-entered', actor: 'daemon', stage: 'done' },
    { seq: 4, ts: iso(ms), event: 'run-closed', actor: 'daemon', state: 'shipped' },
  ]);
}

// The whole net, over the shape that got through it: a stage holding a seat
// that says nothing. Before the stage beat, the run appended nothing for four
// hours, the watcher had no key, and the record was never opened.
test('a stage holding a silent seat opens the record the silent hours never did', async (t) => {
  const paths = home(t);
  for (let i = 0; i < MIN_SAMPLES; i++) historyStage(paths, `past-${i}`, 'work', 0);
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const watcher = new TripwireWatcher({ paths, ledger });
  watcher.setRegistry('p', []);
  t.after(() => watcher.stop());
  const engine = engineOver(t, paths, {
    instanceStore: ledger,
    onEvent: (project, line, source) => watcher.notify(project, line, source),
  });
  engine.registerLane('story', {
    stages: ['work', 'done'],
    handlers: {
      work: async (ctx) => {
        await ctx.supervise({
          seat: 'repair-dev',
          cmd: process.execPath,
          args: ['-e', `setTimeout(() => process.exit(0), ${PULSE * 10})`],
        });
        return { next: 'done' };
      },
      done: () => ({ close: { state: 'shipped' } }),
    },
  });
  engine.launch({ runId: 'live', project: 'p', lane: 'story' });
  const records = await waitFor(
    () => {
      const open = overruns(paths);
      return open.length > 0 ? open : null;
    },
    { label: 'the stage overrun', attempts: 200, intervalMs: 25 },
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].runId, 'live');
  assert.equal(records[0].stage, 'work');
  // The record names what the stage was holding when it overran, which is the
  // first thing an operator wants to know.
  assert.equal(records[0].waitingOn, 'seat');
  assert.deepEqual(records[0].detail, { seats: ['repair-dev'] });
  assert.ok(records[0].beats >= 1);
  assert.equal(records[0].band.upper, 0);
  assert.match(records[0].gist, /has been in work/);
  assert.equal(openStreamItems(paths, 'queued').length, 1);
  // And it stops being a request the moment the stage it named ends.
  await waitFor(
    () => readEvents(archivedRunLedgerPath(paths, 'live')).some((e) => e.event === 'run-closed'),
    { label: 'run closed', attempts: 200, intervalMs: 25 },
  );
  assert.deepEqual(openStreamItems(paths, 'queued'), []);
  assert.equal(overruns(paths).length, 1);
});

/** A run in `update`, queued behind another run's ship token since `since`. */
function queuedRun(paths, runId, { since = at(0), acquired = null } = {}) {
  writeLedger(runLedgerPath(paths, runId), [
    { seq: 1, ts: at(0), event: 'run-launched', actor: 'daemon', project: 'p', lane: 'story' },
    { seq: 2, ts: at(0), event: 'stage-entered', actor: 'daemon', stage: 'update' },
    { seq: 3, ts: since, event: 'ship-token', actor: 'daemon', state: 'waiting', holder: 'other' },
    ...(acquired === null
      ? []
      : [{ seq: 4, ts: acquired, event: 'ship-token', actor: 'daemon', state: 'acquired' }]),
  ]);
}

function updateBeat(elapsed, extra = {}) {
  return {
    seq: 9,
    ts: at(50),
    event: 'stage-heartbeat',
    stage: 'update',
    waitingOn: 'ship-token',
    polls: BEATS_PER_STAMP,
    elapsed,
    ...extra,
  };
}

test('a run standing in the ship-token queue is not a run past its band', async (t) => {
  const paths = home(t);
  for (let i = 0; i < MIN_SAMPLES; i++) historyStage(paths, `past-${i}`, 'update', MINUTE);
  queuedRun(paths, 'live');
  const { watcher } = watcherOver(t, paths);
  // Fifty minutes in the stage against a band whose top is four. Every one of
  // them was the queue's, so the stage has done nothing unusual at all — and a
  // record here is how the band came to learn a queue wait as a stage's work.
  await watcher.notify('p', updateBeat(50 * MINUTE), 'run:live');
  assert.deepEqual(overruns(paths), []);
});

test('the record splits the elapsed into the work and the wait behind it', async (t) => {
  const paths = home(t);
  for (let i = 0; i < MIN_SAMPLES; i++) historyStage(paths, `past-${i}`, 'update', MINUTE);
  queuedRun(paths, 'live', { acquired: at(2) });
  const { watcher } = watcherOver(t, paths);
  await watcher.notify('p', updateBeat(50 * MINUTE, { waitingOn: 'handler' }), 'run:live');
  const [record] = overruns(paths);
  assert.equal(record.stage, 'update');
  assert.equal(record.elapsed, 50 * MINUTE);
  assert.equal(record.work, 48 * MINUTE);
  assert.equal(record.waited, 2 * MINUTE);
  assert.match(record.gist, /48 min of work/);
});

test('a stage that never waited carries the work alone', async (t) => {
  const paths = home(t);
  for (let i = 0; i < MIN_SAMPLES; i++) historyRun(paths, `past-${i}`, 10 * MINUTE);
  openRun(paths, 'live');
  const { watcher } = watcherOver(t, paths);
  await watcher.notify('p', heartbeat(150 * MINUTE), 'run:live');
  const [record] = overruns(paths);
  assert.equal(record.work, 150 * MINUTE);
  assert.equal(record.waited, undefined);
});

test('an instance-ledger append carries no run, and keys no stage reading', async (t) => {
  const paths = home(t);
  const { ledger, watcher } = watcherOver(t, paths);
  ledger.append('launch', { actor: 'daemon', runId: 'live', project: 'p', lane: 'story' });
  assert.equal(watcher.notify('p', { event: 'stage-entered', stage: 'ship' }, 'instance'), undefined);
  assert.deepEqual(overruns(paths), []);
});
