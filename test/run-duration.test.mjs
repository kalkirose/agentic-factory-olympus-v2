import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runDuration, inactiveSpans, inactiveMs } from '../src/ledger/durations.mjs';
import { RunEngine } from '../src/engine/engine.mjs';
import { scaffoldHome, runLedgerPath, archivedRunLedgerPath } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { buildSnapshot } from '../src/center/snapshot.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-08-22T00:00:00.000Z');

function at(hours) {
  return new Date(T0 + hours * HOUR).toISOString();
}

function line(seq, hours, event, extra = {}) {
  return { seq, ts: at(hours), event, actor: 'daemon', ...extra };
}

// A run that never waited on anyone: launch, one stage, close.
function parklessRun() {
  return [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 0.5, 'stage-entered', { stage: 'implementation' }),
    line(3, 6, 'run-closed', { state: 'shipped' }),
  ];
}

test('a parkless run spends all of its wall clock active', () => {
  const d = runDuration(parklessRun());
  assert.equal(d.wallMs, 6 * HOUR);
  assert.equal(d.activeMs, 6 * HOUR);
  assert.equal(d.parkedMs, 0);
  assert.equal(d.launchedAt, at(0));
  assert.equal(d.endedAt, at(6));
  assert.deepEqual(inactiveSpans(parklessRun()), []);
});

test('a park-and-resume run reads wall above active by the exact span', () => {
  const events = [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 1, 'park', { type: 'open-decisions', question: 'ship it?' }),
    line(3, 4, 'answer', { actor: 'human', parkSeq: 2, option: 'proceed' }),
    line(4, 4, 'resume', { stage: 'readiness' }),
    line(5, 6, 'run-closed', { state: 'shipped' }),
  ];
  const d = runDuration(events);
  assert.equal(d.wallMs, 6 * HOUR);
  assert.equal(d.parkedMs, 3 * HOUR);
  assert.equal(d.activeMs, 3 * HOUR);
  assert.ok(d.wallMs > d.activeMs);
  assert.deepEqual(inactiveSpans(events), [{ from: at(1), to: at(4) }]);
});

test('the answer ends the wait, and a resume alone ends it too', () => {
  // A ledger whose answer stamp is missing still closes the wait at the
  // resume behind it; the daemon never runs a stage while a park is open.
  const events = [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 1, 'park', { type: 'seat-failure', question: 'retry?' }),
    line(3, 2, 'resume', { stage: 'implementation' }),
    line(4, 3, 'run-closed', { state: 'shipped' }),
  ];
  assert.deepEqual(inactiveSpans(events), [{ from: at(1), to: at(2) }]);
  assert.equal(runDuration(events).activeMs, 2 * HOUR);
});

test('multiple parks sum', () => {
  const events = [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 1, 'park', { type: 'open-decisions' }),
    line(3, 3, 'answer', { actor: 'human', parkSeq: 2 }),
    line(4, 3, 'resume', { stage: 'readiness' }),
    line(5, 5, 'park', { type: 'cycle-repeat' }),
    line(6, 9, 'answer', { actor: 'human', parkSeq: 5 }),
    line(7, 9, 'resume', { stage: 'verdict' }),
    line(8, 10, 'run-closed', { state: 'shipped' }),
  ];
  const d = runDuration(events);
  assert.equal(d.wallMs, 10 * HOUR);
  assert.equal(d.parkedMs, 6 * HOUR);
  assert.equal(d.activeMs, 4 * HOUR);
  assert.deepEqual(inactiveSpans(events), [
    { from: at(1), to: at(3) },
    { from: at(5), to: at(9) },
  ]);
});

test('an unanswered park at the close counts up to the close stamp', () => {
  const events = [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 2, 'park', { type: 'provisioning-gate' }),
    line(3, 8, 'run-closed', { state: 'killed' }),
  ];
  const d = runDuration(events);
  assert.equal(d.wallMs, 8 * HOUR);
  assert.equal(d.activeMs, 2 * HOUR);
  assert.deepEqual(inactiveSpans(events), [{ from: at(2), to: at(8) }]);
});

test('an inert span counts as parked', () => {
  const events = [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 1, 'liveness-violation', { stage: 'verdict', detail: 'no in-flight child' }),
    line(3, 5, 'resolved', { actor: 'human', resolves: 2 }),
    line(4, 6, 'run-closed', { state: 'shipped' }),
  ];
  const d = runDuration(events);
  assert.equal(d.wallMs, 6 * HOUR);
  assert.equal(d.parkedMs, 4 * HOUR);
  assert.equal(d.activeMs, 2 * HOUR);
  assert.deepEqual(inactiveSpans(events), [{ from: at(1), to: at(5) }]);
});

test('a violation nobody resolved runs to the close', () => {
  const events = [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 3, 'liveness-violation', { stage: 'ship', detail: 'inert' }),
    line(3, 7, 'run-closed', { state: 'killed' }),
  ];
  assert.equal(runDuration(events).activeMs, 3 * HOUR);
});

test('a park inside an open violation is counted once', () => {
  const events = [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 1, 'liveness-violation', { stage: 'verdict', detail: 'inert' }),
    line(3, 2, 'park', { type: 'stage-blocked' }),
    line(4, 4, 'answer', { actor: 'human', parkSeq: 3 }),
    line(5, 4, 'resume', { stage: 'verdict' }),
    line(6, 5, 'resolved', { actor: 'human', resolves: 2 }),
    line(7, 8, 'run-closed', { state: 'shipped' }),
  ];
  const d = runDuration(events);
  assert.equal(d.parkedMs, 4 * HOUR);
  assert.equal(d.activeMs, 4 * HOUR);
  assert.deepEqual(inactiveSpans(events), [{ from: at(1), to: at(5) }]);
});

test('a re-derivation from the same ledger answers the same numbers', () => {
  const events = [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 1, 'park', { type: 'open-decisions' }),
    line(3, 5, 'answer', { actor: 'human', parkSeq: 2 }),
    line(4, 5, 'resume', { stage: 'readiness' }),
    line(5, 6, 'liveness-violation', { stage: 'ship', detail: 'inert' }),
    line(6, 9, 'run-closed', { state: 'killed' }),
  ];
  const first = runDuration(events);
  const second = runDuration(events);
  assert.deepEqual(first, second);
  // And the close stamp is the anchor, so passing it changes nothing.
  assert.deepEqual(runDuration(events, { end: at(9) }), first);
  assert.equal(first.wallMs, 9 * HOUR);
  assert.equal(first.activeMs, 2 * HOUR);
});

test('an explicit end stops the reading, and later events say nothing', () => {
  const events = [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 1, 'park', { type: 'open-decisions' }),
    line(3, 2, 'answer', { actor: 'human', parkSeq: 2 }),
    line(4, 2, 'resume', { stage: 'ship' }),
    line(5, 5, 'merged', { sha: 'a'.repeat(7) }),
    line(6, 6, 'park', { type: 'card-invalidated' }),
    line(7, 9, 'answer', { actor: 'human', parkSeq: 6 }),
    line(8, 10, 'run-closed', { state: 'shipped' }),
  ];
  const toMerge = runDuration(events, { end: at(5) });
  assert.equal(toMerge.wallMs, 5 * HOUR);
  assert.equal(toMerge.activeMs, 4 * HOUR);
  const toClose = runDuration(events);
  assert.equal(toClose.wallMs, 10 * HOUR);
  assert.equal(toClose.activeMs, 6 * HOUR);
});

test('a park still open at an explicit end is clamped to that end', () => {
  const events = [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 2, 'park', { type: 'open-decisions' }),
    line(3, 9, 'answer', { actor: 'human', parkSeq: 2 }),
    line(4, 10, 'run-closed', { state: 'shipped' }),
  ];
  const d = runDuration(events, { end: at(4) });
  assert.equal(d.wallMs, 4 * HOUR);
  assert.equal(d.activeMs, 2 * HOUR);
  assert.deepEqual(inactiveSpans(events, { end: at(4) }), [{ from: at(2), to: at(4) }]);
});

test('the close stamps both durations, and the archive re-derives them', async (t) => {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const engine = new RunEngine(paths, { getSlotCap: () => 1 });
  t.after(async () => {
    await engine.stop();
    removeDir(home);
  });
  engine.registerLane('story', {
    stages: ['hold'],
    handlers: {
      hold: (ctx) => ({
        park: { type: 'open-decisions', question: 'ship it?', options: ['proceed'] },
        ...ctx,
      }),
    },
  });
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => readEvents(runLedgerPath(paths, 'r1')).some((e) => e.event === 'park'), {
    label: 'park stamped',
  });
  // The wait has to be long enough to read, and a human's is hours.
  await new Promise((resolve) => setTimeout(resolve, 60));
  engine.killRun('r1', { actor: 'operator' });

  const events = readEvents(archivedRunLedgerPath(paths, 'r1'));
  const closed = events.at(-1);
  assert.equal(closed.event, 'run-closed');
  assert.ok(Number.isInteger(closed.wallMs));
  assert.ok(Number.isInteger(closed.activeMs));
  assert.ok(closed.wallMs > closed.activeMs, 'the parked wait is not active time');
  // The run closed on a park nobody answered, so the parked span and the wall
  // end on the same stamp and active time does not depend on which end the
  // reader anchors: the archived ledger answers exactly what the close wrote.
  const rederived = runDuration(events);
  assert.equal(rederived.activeMs, closed.activeMs);
  assert.deepEqual(runDuration(events), rederived);
});

test('the center reads a ship in active hours and carries the wall beside it', async (t) => {
  const home = tempDir();
  const paths = scaffoldHome(home);
  t.after(() => removeDir(home));
  const path = runLedgerPath(paths, 'r-ship');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      line(1, 0, 'run-launched', { project: 'alpha', lane: 'story', storyKey: 's-1' }),
      line(2, 1, 'park', { type: 'open-decisions' }),
      line(3, 7, 'answer', { actor: 'human', parkSeq: 2 }),
      line(4, 7, 'resume', { stage: 'ship' }),
      line(5, 9, 'merged', { pr: 1, sha: 'c1', mergeSha: 'm1', red: false }),
      line(6, 9.5, 'run-closed', { state: 'shipped' }),
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
  const snapshot = await buildSnapshot(paths, { now: new Date(T0 + 12 * HOUR) });
  assert.deepEqual(snapshot.stats.ships.map((s) => [s.storyKey, s.hours, s.wallHours]), [
    ['s-1', 3, 9],
  ]);
  assert.equal(snapshot.stats.medianHours, 3);
  assert.equal(snapshot.stats.medianWallHours, 9);
});

// -- the queue class ----------------------------------------------------------

function queuedRun() {
  return [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 1, 'stage-entered', { stage: 'update' }),
    line(3, 1, 'ship-token', { state: 'waiting', holder: 'other', ahead: 0 }),
    line(4, 4, 'ship-token', { state: 'acquired' }),
    line(5, 6, 'run-closed', { state: 'shipped' }),
  ];
}

test('a ship-token wait is a span of the queue class', () => {
  assert.deepEqual(inactiveSpans(queuedRun(), { classes: ['queue'] }), [
    { from: at(1), to: at(4) },
  ]);
  assert.equal(inactiveMs(queuedRun(), { classes: ['queue'] }), 3 * HOUR);
});

test('a token nobody handed over runs to the end of the reading', () => {
  const events = [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 2, 'ship-token', { state: 'waiting', holder: 'other', ahead: 1 }),
    line(3, 9, 'run-closed', { state: 'killed' }),
  ];
  assert.deepEqual(inactiveSpans(events, { classes: ['queue'] }), [{ from: at(2), to: at(9) }]);
});

test('a queue wait is the harness waiting on itself, so it stays active time', () => {
  // ADR-0036 measures what the humans owed. A run waiting for another run of
  // its own project is the harness's own pace, and it belongs in the harness's
  // own number — the band is where the queue is taken out (ADR-0039).
  const d = runDuration(queuedRun());
  assert.equal(d.wallMs, 6 * HOUR);
  assert.equal(d.activeMs, 6 * HOUR);
  assert.equal(d.parkedMs, 0);
  assert.deepEqual(inactiveSpans(queuedRun()), []);
});

test('a park inside a queue wait is one stretch of waiting, not two', () => {
  const events = [
    line(1, 0, 'run-launched', { project: 'alpha', lane: 'story' }),
    line(2, 1, 'ship-token', { state: 'waiting', holder: 'other', ahead: 0 }),
    line(3, 2, 'park', { type: 'provisioning-gate' }),
    line(4, 3, 'answer', { actor: 'human', parkSeq: 3 }),
    line(5, 3, 'resume', { stage: 'update' }),
    line(6, 4, 'ship-token', { state: 'acquired' }),
    line(7, 5, 'run-closed', { state: 'shipped' }),
  ];
  assert.deepEqual(inactiveSpans(events, { classes: ['human', 'queue'] }), [
    { from: at(1), to: at(4) },
  ]);
});

test('a stated window needs no launch stamp, and clamps the spans to itself', () => {
  const events = queuedRun();
  assert.deepEqual(inactiveSpans(events, { start: at(2), end: at(3), classes: ['queue'] }), [
    { from: at(2), to: at(3) },
  ]);
  const stageOnly = events.filter((e) => e.event !== 'run-launched');
  assert.equal(inactiveMs(stageOnly, { start: at(1), end: at(6), classes: ['queue'] }), 3 * HOUR);
});

test('an unmeasurable ledger reads as no duration, never a negative one', () => {
  assert.equal(runDuration([]), null);
  assert.equal(runDuration([line(1, 0, 'run-closed', { state: 'shipped' })]), null);
  // Open run, no end given: nothing to measure against.
  assert.equal(runDuration([line(1, 0, 'run-launched', { lane: 'story' })]), null);
  // A close stamped before the launch is clock skew, not a duration.
  assert.equal(
    runDuration([
      line(1, 5, 'run-launched', { lane: 'story' }),
      line(2, 1, 'run-closed', { state: 'shipped' }),
    ]),
    null,
  );
});
