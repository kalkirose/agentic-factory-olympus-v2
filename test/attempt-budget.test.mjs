// The attempt budget of the lane contract loop (ADR-0067): one corrective round
// on a work-product defect, and a bought retry that keeps that round when the
// seat crashed instead of answering. The two budgets are told apart by the
// stamp the contract loop leaves before its park, and by nothing else. The loop
// itself is here too: what it returns, and what it keys on when one seat runs
// once per record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attemptLimit, boughtRetry, failureBrief, seatWithChecks } from '../src/lanes/shared.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { tempDir, removeDir } from './helpers.mjs';

let seq = 0;
const line = (event, fields = {}) => ({ seq: ++seq, event, ...fields });

/** A ledger up to and including an answered seat-failure park for `seat`. */
function parkedAndAnswered(seat, { failure, answer = { option: 'retry' } }) {
  seq = 0;
  const events = [line('seat-spawned', { seat, attempt: 1 })];
  if (failure) events.push(line('seat-failure', { seat, ...failure }));
  const park = line('park', { type: 'seat-failure', reason: 'seat-failure', detail: { seat } });
  events.push(park, line('answer', { parkSeq: park.seq, ...answer }));
  return events;
}

test('with no answered park the loop has its corrective round and nothing is bought', () => {
  const events = [line('seat-spawned', { seat: 'dev', attempt: 1 })];
  assert.equal(attemptLimit(events, 'dev'), 2);
  assert.equal(boughtRetry(events, 'dev'), false);
});

test('a retry bought after the corrective round is one invocation', () => {
  const events = parkedAndAnswered('dev', {
    failure: { reason: 'work-product-defect', defects: ['src/x.mjs: the diff policy denies this path'] },
  });
  assert.equal(boughtRetry(events, 'dev'), true);
  assert.equal(attemptLimit(events, 'dev'), 1);
  assert.deepEqual(failureBrief(events, 'dev'), ['src/x.mjs: the diff policy denies this path']);
});

test('a retry bought after a crash keeps its corrective round, and still carries the evidence', () => {
  for (const failure of [
    { reason: 'spawn', error: 'ENOENT' },
    { reason: 'exit', cause: 'exit 1' },
    { reason: 'model-unavailable', cause: 'overloaded' },
    { reason: 'report-invalid', errors: ['summary: is required'] },
    { reason: 'silence' },
  ]) {
    const events = parkedAndAnswered('verdict-triage', { failure });
    assert.equal(boughtRetry(events, 'verdict-triage'), true, failure.reason);
    assert.equal(attemptLimit(events, 'verdict-triage'), 2, failure.reason);
    assert.ok(failureBrief(events, 'verdict-triage').length > 0, failure.reason);
  }
});

test('a crash with no stamp at all is a crash retry', () => {
  const events = parkedAndAnswered('suite', { failure: null });
  assert.equal(attemptLimit(events, 'suite'), 2);
  assert.equal(boughtRetry(events, 'suite'), true);
});

test('the corrective stamp of another seat does not spend this seat\'s round', () => {
  const events = parkedAndAnswered('dev', { failure: null });
  events.splice(1, 0, {
    seq: 1.5,
    event: 'seat-failure',
    seat: 'suite',
    reason: 'suite-defect',
    defects: ['no suite files declared'],
  });
  assert.equal(attemptLimit(events, 'dev'), 2);
});

test('once the bought invocation spawned, the budget is whole again and nothing is bought', () => {
  const events = parkedAndAnswered('dev', {
    failure: { reason: 'work-product-defect', defects: ['x'] },
  });
  events.push(line('seat-spawned', { seat: 'dev', attempt: 1 }));
  assert.equal(boughtRetry(events, 'dev'), false);
  assert.equal(attemptLimit(events, 'dev'), 2);
});

// Decision 7 of fix plan 35: the budget is two, for every checked seat, and a
// bought defect retry is the one invocation the park promised.
test('the budget is two attempts, and a bought defect retry is one', () => {
  seq = 0;
  assert.equal(attemptLimit([], 'record-author'), 2);
  for (const seat of ['dev', 'suite', 'reconcile-write:1', 'record-review:4']) {
    assert.equal(attemptLimit([line('seat-spawned', { seat, attempt: 1 })], seat), 2, seat);
    const spent = parkedAndAnswered(seat, {
      failure: { reason: 'work-product-defect', defects: ['U3 has no entry'] },
    });
    assert.equal(attemptLimit(spent, seat), 1, seat);
  }
});

// A stage that dispatches one seat per record holds one budget per slot. The
// key is the whole seat name, so a peer slot spends nothing of this slot's.
test('two slots of one seat hold two budgets and two failure briefs', () => {
  seq = 0;
  const events = [
    line('seat-spawned', { seat: 'reconcile-write:1', attempt: 1 }),
    line('seat-failure', {
      seat: 'reconcile-write:1',
      reason: 'work-product-defect',
      defects: ['U2 is reported as fails'],
    }),
  ];
  const park = line('park', {
    type: 'seat-failure',
    reason: 'seat-failure',
    detail: { seat: 'reconcile-write:1' },
  });
  events.push(park, line('answer', { parkSeq: park.seq, option: 'retry' }));
  assert.equal(boughtRetry(events, 'reconcile-write:1'), true);
  assert.equal(attemptLimit(events, 'reconcile-write:1'), 1);
  assert.deepEqual(failureBrief(events, 'reconcile-write:1'), ['U2 is reported as fails']);
  // The peer slot is a seat of its own: no park of its own, so a whole budget
  // and no brief.
  assert.equal(boughtRetry(events, 'reconcile-write:2'), false);
  assert.equal(attemptLimit(events, 'reconcile-write:2'), 2);
  assert.equal(failureBrief(events, 'reconcile-write:2'), null);
  // The base name is not a slot and holds nothing either.
  assert.equal(boughtRetry(events, 'reconcile-write'), false);
  assert.equal(attemptLimit(events, 'reconcile-write'), 2);
});

// The record review fans out in parallel, so a peer seat can spawn between the
// answer and this seat's own re-dispatch. The retry the human bought is still
// this seat's, and it still carries the evidence.
test('a peer slot that spawns after the answer leaves the bought retry standing', () => {
  const events = parkedAndAnswered('record-review:2', {
    failure: { reason: 'work-product-defect', defects: ['U7 has no entry'] },
  });
  events.push(line('seat-spawned', { seat: 'record-review:1', attempt: 1 }));
  assert.equal(boughtRetry(events, 'record-review:2'), true);
  assert.equal(attemptLimit(events, 'record-review:2'), 1);
  // Its own spawn is what spends it.
  events.push(line('seat-spawned', { seat: 'record-review:2', attempt: 1 }));
  assert.equal(boughtRetry(events, 'record-review:2'), false);
  assert.equal(attemptLimit(events, 'record-review:2'), 2);
});

test('an unanswered park, or a park of another seat or type, buys nothing', () => {
  seq = 0;
  const unanswered = [
    line('seat-spawned', { seat: 'dev', attempt: 1 }),
    line('seat-failure', { seat: 'dev', reason: 'work-product-defect', defects: ['x'] }),
    line('park', { type: 'seat-failure', detail: { seat: 'dev' } }),
  ];
  assert.equal(attemptLimit(unanswered, 'dev'), 2);
  const other = parkedAndAnswered('suite', {
    failure: { reason: 'suite-defect', defects: ['x'] },
  });
  assert.equal(attemptLimit(other, 'dev'), 2);
  seq = 0;
  const blocked = [line('park', { type: 'stage-blocked', reason: 'ticket-missing' })];
  blocked.push(line('answer', { parkSeq: 1, answer: 'C:/tickets/x.md' }));
  assert.equal(attemptLimit(blocked, 'dev'), 2);
});

// -- what the loop returns ----------------------------------------------------

/** A run context over a real ledger, with a scripted seat runner. */
function harness(t, answers) {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const store = openRunStore(paths, 'r1');
  t.after(() => {
    store.close();
    removeDir(home);
  });
  const calls = [];
  const ctx = {
    paths,
    runId: 'r1',
    store,
    runSeat: async (opts) => {
      calls.push(opts);
      store.append('seat-spawned', { actor: 'daemon', seat: opts.seat, attempt: 1 });
      return answers[calls.length - 1];
    },
  };
  return { ctx, calls, events: () => readEvents(runLedgerPath(paths, 'r1')) };
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { summary: { type: 'string' } },
  required: ['summary'],
};

const opts = (over = {}) => ({
  seat: 'reconcile-write',
  schema: REPORT_SCHEMA,
  buildRole: () => 'ROLE',
  checks: () => [],
  ...over,
});

// The stage stamps one entry per record with what that dispatch spent, and the
// ledger's per-seat total cannot say which slot spent what. So the loop hands
// the cost back beside the report.
test('the loop returns the report and the cost of the invocation that stood', async (t) => {
  const { ctx } = harness(t, [{ ok: true, report: { summary: 'done' }, cost: 1.25 }]);
  const out = await seatWithChecks(ctx, opts());
  assert.deepEqual(out.report, { summary: 'done' });
  assert.equal(out.cost, 1.25);
  assert.equal(out.fail, undefined);
});

test('a corrective round returns the cost of the attempt that passed the checks', async (t) => {
  let round = 0;
  const { ctx, calls } = harness(t, [
    { ok: true, report: { summary: 'first' }, cost: 2 },
    { ok: true, report: { summary: 'second' }, cost: 3 },
  ]);
  const out = await seatWithChecks(
    ctx,
    opts({ checks: () => (++round === 1 ? ['U4 has no entry'] : []) }),
  );
  assert.equal(calls.length, 2);
  assert.equal(out.report.summary, 'second');
  assert.equal(out.cost, 3);
  // The second brief carries the defect the first one left.
  assert.deepEqual(calls[1].roleBlock, 'ROLE');
});

// The slot suffix is a colon, which a Windows path reads as a stream
// separator. The ledger keeps the identity whole and the report file flattens
// it, so a fan-out writes one readable report per slot.
test('a slotted seat keys the ledger by its identity and its report file by a flat name', async (t) => {
  const { ctx, calls, events } = harness(t, [
    { ok: true, report: { summary: 'done' }, cost: 0.5 },
  ]);
  await seatWithChecks(ctx, opts({ seat: 'record-review:2' }));
  assert.equal(calls[0].seat, 'record-review:2');
  assert.ok(calls[0].reportPath.endsWith('record-review-2-1.json'), calls[0].reportPath);
  assert.ok(!calls[0].reportPath.slice(2).includes(':'), calls[0].reportPath);
  assert.equal(events().at(-1).seat, 'record-review:2');
});

test('a spent budget stamps the defects under the whole seat name and parks', async (t) => {
  const { ctx, calls, events } = harness(t, [
    { ok: true, report: { summary: 'first' }, cost: 1 },
    { ok: true, report: { summary: 'second' }, cost: 1 },
  ]);
  const out = await seatWithChecks(
    ctx,
    opts({ seat: 'reconcile-write:3', checks: () => ['U1 is reported as fails'] }),
  );
  assert.equal(calls.length, 2);
  assert.equal(out.report, undefined);
  assert.equal(out.fail.park.detail.seat, 'reconcile-write:3');
  const failure = events().find((e) => e.event === 'seat-failure');
  assert.equal(failure.seat, 'reconcile-write:3');
  assert.deepEqual(failure.defects, ['U1 is reported as fails']);
});

// The style files ride where the constitution rides: the loop passes both, and
// a caller that names neither changes nothing.
test('the loop carries the style files to the seat, and omits them where none are named', async (t) => {
  const { ctx, calls } = harness(t, [
    { ok: true, report: { summary: 'a' }, cost: 0 },
    { ok: true, report: { summary: 'b' }, cost: 0 },
  ]);
  await seatWithChecks(ctx, opts({ styleFiles: ['docs/style/asd-ste100.md'] }));
  assert.deepEqual(calls[0].styleFiles, ['docs/style/asd-ste100.md']);
  await seatWithChecks(ctx, opts());
  assert.equal('styleFiles' in calls[1], false);
});
