// The attempt budget of the lane contract loop (ADR-0067): one corrective round
// on a work-product defect, and a bought retry that keeps that round when the
// seat crashed instead of answering. The two budgets are told apart by the
// stamp the contract loop leaves before its park, and by nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attemptLimit, boughtRetry, failureBrief } from '../src/lanes/shared.mjs';

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
