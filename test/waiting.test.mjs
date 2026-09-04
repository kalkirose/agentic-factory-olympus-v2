// The one wait mechanism (ADR-0069): the pair it stamps, the ladders it
// climbs, and what every reader of a run makes of it — the slot count, the
// heartbeat, the kill, the operator hold, the duration split, the status page
// and the cycle fingerprint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunEngine } from '../src/engine/engine.mjs';
import { deriveRunState } from '../src/engine/replay.mjs';
import { scaffoldHome, runLedgerPath, archivedRunLedgerPath } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { runDuration, inactiveMs } from '../src/ledger/durations.mjs';
import { cycleFingerprint } from '../src/ledger/cycles.mjs';
import { renderStatus } from '../src/console/status.mjs';
import {
  LAYER_LADDER,
  SEAT_LADDER,
  WaitCancelled,
  ladderStep,
  openWait,
  recoverOpenWaits,
  waitAttempt,
  waitFor,
  waitHistory,
} from '../src/lanes/waiting.mjs';
import { tempDir, removeDir, waitFor as until, NO_WAIT } from './helpers.mjs';

function setup(t, runId = 'r1') {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const store = openRunStore(paths, runId);
  t.after(() => {
    store.close();
    removeDir(home);
  });
  return { paths, store, home };
}

const events = (paths, runId = 'r1') => readEvents(runLedgerPath(paths, runId));

// -- the pair ----------------------------------------------------------------

test('a wait stamps the span it opened and the span it closed', async (t) => {
  const { paths, store } = setup(t);
  const slept = [];
  const out = await waitFor(
    { store, sleep: (ms) => slept.push(ms) },
    { kind: 'layer', reason: 'ECONNRESET', ms: LAYER_LADDER[0], attempt: 1, detail: { layers: ['unit'] } },
  );
  assert.equal(out.outcome, 'elapsed');
  assert.deepEqual(slept, [LAYER_LADDER[0]]);
  const [opened, closed] = events(paths).filter((e) => e.event.startsWith('waiting'));
  assert.equal(opened.event, 'waiting');
  assert.equal(opened.kind, 'layer');
  assert.equal(opened.reason, 'ECONNRESET');
  assert.equal(opened.attempt, 1);
  assert.deepEqual(opened.detail, { layers: ['unit'] });
  assert.ok(Date.parse(opened.until) > Date.parse(opened.ts) - 1000);
  assert.equal(closed.event, 'waiting-ended');
  assert.equal(closed.kind, 'layer');
  assert.equal(closed.outcome, 'elapsed');
  assert.equal(closed.waitSeq, opened.seq);
});

test('a kind outside the closed set, and a span that is no span, are refused', async (t) => {
  const { store } = setup(t);
  await assert.rejects(
    () => waitFor({ store, sleep: NO_WAIT }, { kind: 'weather', reason: 'x', ms: 1 }),
    /unknown wait kind/,
  );
  await assert.rejects(
    () => waitFor({ store, sleep: NO_WAIT }, { kind: 'seat', reason: 'x', ms: 0 }),
    /positive span/,
  );
});

test('the two ladders are the numbers the design names, and they end', () => {
  assert.deepEqual(SEAT_LADDER, [5, 15, 45].map((m) => m * 60_000));
  assert.deepEqual(LAYER_LADDER, [1, 5, 15].map((m) => m * 60_000));
  assert.equal(ladderStep(SEAT_LADDER, 1), 5 * 60_000);
  assert.equal(ladderStep(SEAT_LADDER, 3), 45 * 60_000);
  assert.equal(ladderStep(SEAT_LADDER, 4), null);
  assert.equal(ladderStep(LAYER_LADDER, 0), null);
});

test('a polled wait asks on its cadence and ends on the answer', async (t) => {
  const { paths, store } = setup(t);
  let asks = 0;
  const out = await waitFor(
    { store, sleep: NO_WAIT },
    {
      kind: 'external',
      reason: 'sanity',
      ms: 30_000,
      pollMs: 10_000,
      freesSlot: true,
      poll: async () => ++asks === 2,
    },
  );
  assert.equal(out.outcome, 'probe-green');
  assert.equal(asks, 2);
  assert.equal(events(paths).find((e) => e.event === 'waiting').freesSlot, true);
});

test('a poll that never gets its answer spends the wait and says so', async (t) => {
  const { paths, store } = setup(t);
  let asks = 0;
  const out = await waitFor(
    { store, sleep: NO_WAIT },
    { kind: 'external', reason: 'sanity', ms: 30_000, pollMs: 10_000, poll: async () => !!(asks++ & 0) && false },
  );
  assert.equal(out.outcome, 'spent');
  // Three polls: the bound is the step count and never a clock the caller is
  // not driving.
  assert.equal(asks, 3);
  assert.equal(events(paths).find((e) => e.event === 'waiting-ended').outcome, 'spent');
});

test('a cancelled wait closes its span and throws into the handler', async (t) => {
  const { paths, store } = setup(t);
  let entry = null;
  const waits = { register: (e) => ((entry = e), () => {}) };
  const pending = waitFor(
    { store, waits, sleep: () => new Promise(() => {}) },
    { kind: 'seat', reason: 'exit', ms: SEAT_LADDER[0] },
  );
  await until(() => entry !== null, { label: 'the wait to register' });
  entry.cancel('killed');
  await assert.rejects(() => pending, (error) => error instanceof WaitCancelled && error.outcome === 'killed');
  assert.equal(events(paths).find((e) => e.event === 'waiting-ended').outcome, 'killed');
});

test('the re-dispatch a wait bought stands behind an operator hold', async (t) => {
  const { store } = setup(t);
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  let through = false;
  const pending = waitFor(
    { store, sleep: NO_WAIT, waits: { register: () => () => {}, holdBarrier: () => held } },
    { kind: 'layer', reason: 'ECONNRESET', ms: 1000 },
  ).then(() => (through = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(through, false, 'the wait must not return while the hold stands');
  release();
  await pending;
  assert.equal(through, true);
});

// -- what the ledger says afterwards -----------------------------------------

test('an open span a dead instance left is closed by the next start', async (t) => {
  const { paths, store } = setup(t);
  store.append('waiting', { actor: 'daemon', kind: 'layer', reason: 'ECONNRESET', attempt: 1 });
  assert.equal(openWait(events(paths)).kind, 'layer');
  assert.equal(recoverOpenWaits(store, { trigger: 'daemon-start' }), 1);
  assert.equal(openWait(events(paths)), null);
  const closed = events(paths).at(-1);
  assert.equal(closed.outcome, 'daemon-stopped');
  assert.equal(closed.trigger, 'daemon-start');
  // Idempotent: a second start closes nothing.
  assert.equal(recoverOpenWaits(store), 0);
});

test('the ladder position is read from the ledger, and an answer resets it', async (t) => {
  const { paths, store } = setup(t);
  assert.equal(waitAttempt(events(paths), 'layer'), 1);
  for (const attempt of [1, 2, 3]) {
    const opened = store.append('waiting', { actor: 'daemon', kind: 'layer', reason: 'x', attempt });
    store.append('waiting-ended', {
      actor: 'daemon',
      kind: 'layer',
      outcome: 'elapsed',
      waitSeq: opened.seq,
    });
  }
  assert.equal(waitAttempt(events(paths), 'layer'), 4);
  assert.equal(ladderStep(LAYER_LADDER, waitAttempt(events(paths), 'layer')), null);
  const answer = store.append('answer', { actor: 'operator', parkSeq: 1, option: 'retry' });
  // A human's answer is a grant: the ladder starts again rather than standing
  // spent for the rest of the run.
  assert.equal(waitAttempt(events(paths), 'layer', { since: answer.seq }), 1);
  // Another kind's ladder is its own.
  assert.equal(waitAttempt(events(paths), 'substrate'), 1);
  const history = waitHistory(events(paths), 'layer');
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((h) => h.outcome), ['elapsed', 'elapsed', 'elapsed']);
});

test('a waiting run reads as waiting, and its span leaves the run its work', async (t) => {
  const { paths, store } = setup(t);
  store.append('run-launched', { actor: 'daemon', project: 'proj', lane: 'story' });
  store.append('stage-entered', { actor: 'daemon', stage: 'verdict' });
  const opened = store.append('waiting', {
    actor: 'daemon',
    kind: 'external',
    reason: 'sanity',
    until: '2026-09-05T00:00:00.000Z',
    attempt: 1,
    freesSlot: true,
  });
  const state = deriveRunState(events(paths));
  assert.equal(state.waiting.kind, 'external');
  assert.equal(state.waiting.freesSlot, true);
  store.append('waiting-ended', { actor: 'daemon', kind: 'external', outcome: 'probe-green', waitSeq: opened.seq });
  assert.equal(deriveRunState(events(paths)).waiting, null);
});

test('the duration split takes a wait out of the work', async (t) => {
  const ledger = [
    { seq: 1, ts: '2026-09-04T10:00:00.000Z', event: 'run-launched' },
    { seq: 2, ts: '2026-09-04T10:10:00.000Z', event: 'waiting', kind: 'layer' },
    { seq: 3, ts: '2026-09-04T10:25:00.000Z', event: 'waiting-ended', kind: 'layer', waitSeq: 2 },
    { seq: 4, ts: '2026-09-04T10:30:00.000Z', event: 'run-closed', state: 'shipped' },
  ];
  const duration = runDuration(ledger);
  assert.equal(duration.wallMs, 30 * 60_000);
  assert.equal(duration.activeMs, 15 * 60_000);
  assert.equal(duration.waitedMs, 15 * 60_000);
  assert.equal(inactiveMs(ledger, { classes: ['wait'] }), 15 * 60_000);
});

test('a cycle after a wait is a new cycle by construction', () => {
  const render = { seq: 10, cycle: 1, pass: 1, sha: 'abc', suiteSha: 's1', open: [] };
  const before = cycleFingerprint([render], render);
  const after = cycleFingerprint(
    [{ seq: 5, event: 'waiting', kind: 'layer' }, render],
    render,
  );
  assert.notEqual(before, after);
});

// -- the engine --------------------------------------------------------------

function engineSetup(t, { slotCaps = { proj: 1 }, isHeld = () => false } = {}) {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const engine = new RunEngine(paths, {
    getSlotCap: (project) => slotCaps[project],
    isHeld,
    heartbeatMs: 30,
  });
  t.after(async () => {
    await engine.stop();
    removeDir(home);
  });
  return { paths, engine };
}

/** A lane whose one stage waits, with the kind and span the test names. */
function waitingLane(opts, done = () => {}) {
  return {
    stages: ['only'],
    handlers: {
      only: async (ctx) => {
        await waitFor({ store: ctx.store, waits: ctx.waits, sleep: opts.sleep }, opts.wait);
        done();
        return { close: { state: 'shipped' } };
      },
    },
  };
}

test('an external wait frees the slot; every other wait keeps it', async (t) => {
  const { engine } = engineSetup(t, { slotCaps: { proj: 1 } });
  let freed = null;
  engine.onWaiting = (info) => (freed = info);
  let go = () => {};
  const held = new Promise((resolve) => (go = resolve));
  engine.registerLane('story', waitingLane({
    sleep: () => held,
    wait: { kind: 'external', reason: 'sanity', ms: 1000, freesSlot: true },
  }));
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await until(() => engine.activeCount('proj') === 0, { label: 'the slot to free' });
  assert.equal(engine.hasFreeSlot('proj'), true);
  assert.deepEqual(freed, { runId: 'r1', project: 'proj', lane: 'story', kind: 'external' });
  go();
});

test('a mid-stage wait holds the slot and beats what it is waiting on', async (t) => {
  const { paths, engine } = engineSetup(t);
  let go = () => {};
  const held = new Promise((resolve) => (go = resolve));
  engine.registerLane('story', waitingLane({
    sleep: () => held,
    wait: { kind: 'layer', reason: 'ECONNRESET', ms: 60_000, attempt: 2 },
  }));
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await until(
    () => events(paths).some((e) => e.event === 'stage-heartbeat' && e.waitingOn === 'layer'),
    { label: 'the beat to say what the run waits on' },
  );
  assert.equal(engine.activeCount('proj'), 1);
  const beat = events(paths).find((e) => e.event === 'stage-heartbeat' && e.waitingOn === 'layer');
  assert.equal(beat.detail.attempt, 2);
  assert.equal(beat.detail.reason, 'ECONNRESET');
  assert.ok(beat.detail.until);
  go();
});

test('a kill ends a wait, and the run closes on it', async (t) => {
  const { paths, engine } = engineSetup(t);
  engine.registerLane('story', waitingLane({
    sleep: () => new Promise(() => {}),
    wait: { kind: 'seat', reason: 'exit', ms: 60_000 },
  }));
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await until(() => events(paths).some((e) => e.event === 'waiting'), { label: 'the wait' });
  engine.killRun('r1', { actor: 'operator' });
  // The kill closes the run, so the ledger it wrote to is the archived one.
  const ended = readEvents(archivedRunLedgerPath(paths, 'r1')).find(
    (e) => e.event === 'waiting-ended',
  );
  assert.equal(ended.outcome, 'killed');
});

test('a hold taken while a run waits holds the re-dispatch behind it', async (t) => {
  let held = true;
  const { paths, engine } = engineSetup(t, { isHeld: () => held });
  let through = false;
  engine.registerLane('story', waitingLane(
    { sleep: NO_WAIT, wait: { kind: 'layer', reason: 'ECONNRESET', ms: 1000 } },
    () => (through = true),
  ));
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await until(() => events(paths).some((e) => e.event === 'waiting-ended'), { label: 'the wait to end' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(through, false, 'the run must not spend anything while the hold stands');
  held = false;
  engine.releaseHeldRuns();
  await until(() => through, { label: 'the re-dispatch after the release' });
});

test('a poll that throws closes its own span with the error on the record', async (t) => {
  const { paths, store } = setup(t);
  await assert.rejects(
    () =>
      waitFor(
        { store, sleep: NO_WAIT },
        {
          kind: 'external',
          reason: 'sanity',
          ms: 30_000,
          pollMs: 10_000,
          poll: async () => {
            throw new Error('the probe command could not run');
          },
        },
      ),
    /could not run/,
  );
  // The span is closed, so the next start has nothing to repair and the
  // handler's own violation is the only record of the fault (ADR-0069).
  const ended = events(paths).find((e) => e.event === 'waiting-ended');
  assert.equal(ended.outcome, 'error');
  assert.match(ended.error, /could not run/);
  assert.equal(openWait(events(paths)), null);
});

test('a kill while a wait is held at its re-dispatch dispatches nothing', async (t) => {
  const { paths, engine } = engineSetup(t, { isHeld: () => true });
  let through = false;
  engine.registerLane('story', waitingLane(
    { sleep: NO_WAIT, wait: { kind: 'layer', reason: 'ECONNRESET', ms: 1000 } },
    () => (through = true),
  ));
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await until(() => events(paths).some((e) => e.event === 'waiting-ended'), {
    label: 'the wait to end under the hold',
  });
  engine.killRun('r1', { actor: 'operator' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(through, false, 'a run that is over does not re-dispatch');
  assert.equal(
    readEvents(archivedRunLedgerPath(paths, 'r1')).find((e) => e.event === 'run-closed').state,
    'killed',
  );
});

test('a stop while a wait is held at its re-dispatch dispatches nothing', async (t) => {
  const { paths, engine } = engineSetup(t, { isHeld: () => true });
  let through = false;
  engine.registerLane('story', waitingLane(
    { sleep: NO_WAIT, wait: { kind: 'layer', reason: 'ECONNRESET', ms: 1000 } },
    () => (through = true),
  ));
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await until(() => events(paths).some((e) => e.event === 'waiting-ended'), {
    label: 'the wait to end under the hold',
  });
  await engine.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(through, false, 'a stopping instance does not re-dispatch');
});

// -- the console -------------------------------------------------------------

test('status prints what a run waits on, and counts it apart from the active', async (t) => {
  const { paths, store, home } = setup(t);
  store.append('run-launched', { actor: 'daemon', project: 'proj', lane: 'story' });
  store.append('stage-entered', { actor: 'daemon', stage: 'verdict' });
  store.append('waiting', {
    actor: 'daemon',
    kind: 'external',
    reason: 'sanity at api.sanity.io',
    until: '2026-09-05T00:00:00.000Z',
    attempt: 1,
  });
  const page = renderStatus(paths);
  assert.match(page, /runs 0 active \/ 0 parked \/ 0 held \/ 1 waiting/);
  assert.match(page, /waiting: external sanity at api\.sanity\.io until 2026-09-05T00:00:00\.000Z/);
  assert.ok(home);
});
