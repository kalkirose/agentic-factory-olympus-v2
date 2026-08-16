// Liveness for the stages that run no seat: the heartbeat a polling stage
// stamps, the duration history the ledgers hold, and the tripwire that reads
// one against the other. The tripwire tests drive the watcher over fixture
// ledgers, because what is under test is a reading — no forge, no worktree, no
// run engine, and by construction nothing the watcher could write to a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { openInstanceStore, openRunStore } from '../src/telemetry/stores.mjs';
import { openStreamItems } from '../src/telemetry/readers.mjs';
import { escalationQueue } from '../src/telemetry/queue.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { BEATS_PER_STAMP, stageHeartbeat } from '../src/telemetry/heartbeat.mjs';
import {
  BAND_FACTOR,
  MIN_SAMPLES,
  durationBand,
  stageDurations,
  stageVisits,
} from '../src/tripwires/duration.mjs';
import { TripwireWatcher } from '../src/tripwires/watcher.mjs';
import { tempDir, removeDir } from './helpers.mjs';

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

test('an instance-ledger append carries no run, and keys no stage reading', async (t) => {
  const paths = home(t);
  const { ledger, watcher } = watcherOver(t, paths);
  ledger.append('launch', { actor: 'daemon', runId: 'live', project: 'p', lane: 'story' });
  assert.equal(watcher.notify('p', { event: 'stage-entered', stage: 'ship' }, 'instance'), undefined);
  assert.deepEqual(overruns(paths), []);
});
