// Progress-keyed cycling over synthetic ledgers: what a cycle fingerprint is
// made of, which changes make a cycle a new one, and where a repeat spends its
// retry and where it parks. The lane wiring has its own suites; this one pins
// the derivation, which is pure over the ledger and therefore restart-safe by
// construction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleFingerprint, cycleRepeat, RERUN_BUDGET } from '../src/ledger/cycles.mjs';

const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const NEXT_SHA = '9988776655443322119988776655443322119988';

/** A ledger builder: appends in seq order, exactly as the store does. */
function ledger() {
  const events = [];
  let seq = 0;
  return {
    events,
    append(event, fields) {
      const line = { seq: ++seq, event, ...fields };
      events.push(line);
      return line;
    },
  };
}

/**
 * One CI cycle of the observed shape: triage raises a fresh id for the same
 * defect, the checks are replayed red on the same head, and the render carries
 * the new id.
 */
function ciCycle(log, { id, sha = SHA, summary = 'stale credential', status = 'failure' }) {
  log.append('check-transition', { sha, check: 'ci', status: 'rerun-requested' });
  log.append('check-transition', { sha, check: 'ci', status });
  log.append('finding', {
    id,
    source: 'triage',
    class: 'env',
    summary,
    evidence: 'red output of ci:ci',
  });
  return log.append('verdict-rendered', {
    cycle: log.events.filter((e) => e.event === 'verdict-rendered').length + 1,
    sha,
    source: 'ci',
    verdict: 'red',
    open: [id],
    record: `verdict-${id}.json`,
  });
}

function renders(log) {
  return log.events.filter((e) => e.event === 'verdict-rendered');
}

/** The decision the ladder would take on the last render. */
function decide(log) {
  const all = renders(log);
  return cycleRepeat(log.events, all, all[all.length - 1]);
}

/** Grants the retry the decision asks for, exactly as the ladder does. */
function grant(log, decision) {
  const last = renders(log).at(-1);
  log.append('cycle-retry', {
    fingerprint: decision.fingerprint,
    render: last.seq,
    cycles: decision.occurrences.map((o) => o.cycle),
  });
}

test('a cycle fingerprint is the sha, the suite, the open identities and the checks', () => {
  const log = ledger();
  log.append('finding', { id: 'F1', class: 'code-defect', summary: 'wrong', evidence: 'unit' });
  const base = { cycle: 1, sha: SHA, suiteSha: 'suite-1', open: ['F1'], record: 'r1' };
  const one = cycleFingerprint(log.events, { seq: 10, ...base });
  // Every component moves the fingerprint, and nothing else does.
  assert.notEqual(one, cycleFingerprint(log.events, { seq: 10, ...base, sha: NEXT_SHA }));
  assert.notEqual(one, cycleFingerprint(log.events, { seq: 10, ...base, suiteSha: 'suite-2' }));
  assert.notEqual(one, cycleFingerprint(log.events, { seq: 10, ...base, open: [] }));
  assert.equal(one, cycleFingerprint(log.events, { seq: 99, ...base, cycle: 7, record: 'r7' }));
});

test('a fresh pass that rebuilds the same tree at the same sha is a new cycle', () => {
  // Two implementation passes can commit a byte-identical tree onto the same
  // parent inside one second and reach one sha. The run has spent its fresh
  // pass, not looped, and the ladder's second stall is the ceiling that owns
  // the case — so the guard must leave it alone.
  const log = ledger();
  log.append('finding', { id: 'F1', class: 'code-defect', summary: 'wrong', evidence: 'unit' });
  const render = { seq: 30, cycle: 2, sha: SHA, open: ['F1'] };
  assert.notEqual(
    cycleFingerprint(log.events, { ...render, pass: 1 }),
    cycleFingerprint(log.events, { ...render, pass: 2 }),
  );
});

test('the open set enters by identity, not by id or by order', () => {
  const log = ledger();
  log.append('finding', { id: 'F1', class: 'env', summary: 'stale key', evidence: 'ci log' });
  log.append('finding', { id: 'F2', class: 'env', summary: 'stale key', evidence: 'ci log' });
  log.append('finding', { id: 'F3', class: 'code-defect', summary: 'wrong', evidence: 'unit' });
  const of = (open) => cycleFingerprint(log.events, { seq: 20, sha: SHA, open });
  // Same defect, fresh id: the same cycle by identity.
  assert.equal(of(['F1']), of(['F2']));
  // Order is not identity either.
  assert.equal(of(['F1', 'F3']), of(['F3', 'F1']));
  assert.notEqual(of(['F1']), of(['F3']));
});

test('six identical cycles park at the second repeat, after one spent retry', () => {
  // The observed shape: same candidate sha, the same finding by identity
  // under a fresh id each time, the same replayed check state, six cycles
  // over — ended only by a human pushing an empty commit.
  const log = ledger();
  ciCycle(log, { id: 'F1' });
  assert.equal(decide(log).action, 'proceed');
  ciCycle(log, { id: 'F2' });
  const repeat = decide(log);
  assert.equal(repeat.action, 'retry');
  assert.equal(repeat.occurrences.length, 2);
  grant(log, repeat);
  // The granted retry is not re-granted and not re-judged on a second read of
  // the same render: the ladder re-derives its position at every entry.
  assert.equal(decide(log).action, 'proceed');
  ciCycle(log, { id: 'F3' });
  const parked = decide(log);
  assert.equal(parked.action, 'park');
  // Both occurrences that made the case are on the record, with the third.
  assert.deepEqual(
    parked.occurrences.map((o) => o.cycle),
    [1, 2, 3],
  );
  assert.equal(parked.fingerprint, repeat.fingerprint);
  // One retry, and exactly one: the budget is the automatic re-run's.
  assert.equal(log.events.filter((e) => e.event === 'cycle-retry').length, RERUN_BUDGET);
});

test('the park is re-derived from the ledger, so a restart reaches it again', () => {
  const log = ledger();
  ciCycle(log, { id: 'F1' });
  const first = decide(log);
  ciCycle(log, { id: 'F2' });
  grant(log, decide(log));
  ciCycle(log, { id: 'F3' });
  const parked = decide(log);
  // A second derivation over the same ledger — a restart reads no more and no
  // less — reaches the same fingerprint and the same decision.
  assert.deepEqual(decide(log), parked);
  assert.equal(parked.action, 'park');
  assert.equal(first.fingerprint, parked.fingerprint);
});

test('a repair that commits a new sha is a new cycle, however often it repeats', () => {
  const log = ledger();
  ciCycle(log, { id: 'F1' });
  ciCycle(log, { id: 'F2', sha: NEXT_SHA });
  assert.equal(decide(log).action, 'proceed');
});

test('a finding that closes is a new cycle', () => {
  const log = ledger();
  ciCycle(log, { id: 'F1' });
  log.append('finding', { id: 'F2', class: 'env', summary: 'stale credential', evidence: 'x' });
  log.append('verdict-rendered', { cycle: 2, sha: SHA, source: 'ci', verdict: 'red', open: [] });
  assert.equal(decide(log).action, 'proceed');
});

test('a finding that appears is a new cycle', () => {
  const log = ledger();
  const first = ciCycle(log, { id: 'F1' });
  log.append('finding', { id: 'F2', class: 'code-defect', summary: 'wrong', evidence: 'unit' });
  log.append('verdict-rendered', {
    cycle: 2,
    sha: SHA,
    source: 'ci',
    verdict: 'red',
    open: [...first.open, 'F2'],
  });
  assert.equal(decide(log).action, 'proceed');
});

test('a check conclusion that changes is a new cycle', () => {
  const log = ledger();
  ciCycle(log, { id: 'F1' });
  ciCycle(log, { id: 'F2', status: 'timed_out' });
  assert.equal(decide(log).action, 'proceed');
});

test('ten productive cycles never meet the guard', () => {
  const log = ledger();
  for (let i = 1; i <= 10; i++) {
    ciCycle(log, { id: `F${i}`, sha: `${i}`.repeat(40) });
    assert.equal(decide(log).action, 'proceed', `cycle ${i}`);
  }
  assert.ok(!log.events.some((e) => e.event === 'cycle-retry'));
});

test('an answered retry grants exactly one more cycle, then parks again', () => {
  const log = ledger();
  ciCycle(log, { id: 'F1' });
  ciCycle(log, { id: 'F2' });
  grant(log, decide(log));
  ciCycle(log, { id: 'F3' });
  const parked = decide(log);
  assert.equal(parked.action, 'park');
  const park = log.append('park', {
    type: 'cycle-repeat',
    detail: { fingerprint: parked.fingerprint, occurrences: parked.occurrences },
  });
  log.append('answer', { parkSeq: park.seq, option: 'retry', actor: 'operator' });
  // The answer buys the cycle it was asked about, and one.
  const bought = decide(log);
  assert.equal(bought.action, 'retry');
  grant(log, bought);
  ciCycle(log, { id: 'F4' });
  assert.equal(decide(log).action, 'park');
});

test('an answered gate grants the next cycle: the human repaired what the ledger cannot see', () => {
  // The route the ack and the provisioning gate take re-runs the same layers
  // against the same tree, and what changed between the two cycles is the
  // substrate a human just repaired. The answer is that change, on the record.
  const log = ledger();
  ciCycle(log, { id: 'F1' });
  ciCycle(log, { id: 'F2' });
  grant(log, decide(log));
  const park = log.append('park', { type: 'provisioning-gate' });
  log.append('answer', { parkSeq: park.seq, option: 'retry', actor: 'operator' });
  ciCycle(log, { id: 'F3' });
  assert.equal(decide(log).action, 'retry');
});

test('an answer older than the retry it would refresh grants nothing', () => {
  const log = ledger();
  const park = log.append('park', { type: 'intent-conflict' });
  log.append('answer', { parkSeq: park.seq, answer: 'round half up', actor: 'operator' });
  ciCycle(log, { id: 'F1' });
  ciCycle(log, { id: 'F2' });
  grant(log, decide(log));
  ciCycle(log, { id: 'F3' });
  assert.equal(decide(log).action, 'park');
});

test('a local verdict rests on no check state, so the checks never reach it', () => {
  const log = ledger();
  log.append('finding', { id: 'F1', class: 'code-defect', summary: 'wrong', evidence: 'unit' });
  const render = { seq: 50, cycle: 1, sha: SHA, open: ['F1'], record: 'r1' };
  const before = cycleFingerprint(log.events, render);
  log.append('check-transition', { sha: SHA, check: 'ci', status: 'failure' });
  assert.equal(cycleFingerprint(log.events, { ...render, seq: 99 }), before);
});
