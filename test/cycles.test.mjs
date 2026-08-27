// Progress-keyed cycling over synthetic ledgers: what a cycle fingerprint is
// made of, which changes make a cycle a new one, and where a repeat spends its
// retry and where it parks. The repair ladder's progress rule reads the same
// identity set and asks a different question, so its cases and the boundary
// between the two guards are pinned here beside it. The flake reading a check
// spends its re-runs on is the third derivation of the same kind, so its cases
// sit here too. The lane wiring has its own suites; this one pins the
// derivations, which are pure over the ledger and therefore restart-safe by
// construction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cycleFingerprint,
  cycleRepeat,
  ciFlakes,
  deterministicRed,
  FLAKE_LIMIT,
  RERUN_BUDGET,
} from '../src/ledger/cycles.mjs';
import { repairStalled } from '../src/lanes/verdict.mjs';

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

// -- the repair ladder's progress rule ---------------------------------------

/** A triage finding on the candidate tree. */
function finding(log, id, summary) {
  log.append('finding', { id, source: 'triage', class: 'code-defect', summary, evidence: 'unit' });
}

/** The round a repair-dev seat committed, and the render that judges it. */
function repairCycle(log, { open, pass = 1, sha = SHA }) {
  log.append('repair-round', { pass, round: renders(log).length, sha, openBefore: open });
  return localRender(log, { open, pass, sha });
}

function localRender(log, { open, pass = 1, sha = SHA }) {
  const cycle = renders(log).length + 1;
  return log.append('verdict-rendered', {
    cycle,
    pass,
    sha,
    suiteSha: 'suite-1',
    verdict: 'red',
    open,
    record: `verdict-${cycle}.json`,
  });
}

/** The call the ladder makes on the last render. */
function stalled(log) {
  const all = renders(log);
  return repairStalled(log.events, all, all[all.length - 1]);
}

test('a repair round that closes one finding and surfaces another is progress', () => {
  const log = ledger();
  finding(log, 'F1', 'the paginator is off by one');
  localRender(log, { open: ['F1'] });
  // The round fixed what it was given; the review named the next thing. One
  // against one on the count, and the run is moving.
  finding(log, 'F2', 'the sort key ignores case');
  repairCycle(log, { open: ['F2'] });
  assert.equal(stalled(log), false);
  // A round that closes nothing and raises one more: the count grew, and so
  // did the evidence that the tree is not moving.
  finding(log, 'F3', 'the empty page renders a null row');
  repairCycle(log, { open: ['F2', 'F3'] });
  assert.equal(stalled(log), true);
  // Two open again, one of them closed: enough, whatever came in beside it.
  finding(log, 'F4', 'the cursor skips the last item');
  repairCycle(log, { open: ['F3', 'F4'] });
  assert.equal(stalled(log), false);
});

test('a repair round that closes nothing is a stall, whatever the ids and the count say', () => {
  const log = ledger();
  finding(log, 'F1', 'the paginator is off by one');
  localRender(log, { open: ['F1'] });
  // Triage raises the same defect under a fresh id, exactly as it does every
  // cycle. The count held and the id moved; the defect did neither.
  finding(log, 'F2', 'the paginator is off by one');
  repairCycle(log, { open: ['F2'] });
  assert.equal(stalled(log), true);
  // The shape of the one live stall on the record: the count grew and nothing
  // closed. True under the old key and true under this one — the rule change
  // is about the other case.
  finding(log, 'F3', 'the sort key ignores case');
  repairCycle(log, { open: ['F2', 'F3'] });
  assert.equal(stalled(log), true);
});

test('two findings that reach one identity are two findings to the progress rule', () => {
  // The digest normalizes the numerals out, so four layers failing as m1 to m4
  // carry one identity between them. Closing three of them is three closed
  // findings, and a membership test would read it as none.
  const log = ledger();
  for (const n of [1, 2, 3, 4]) finding(log, `F${n}`, `layer m${n} is red`);
  localRender(log, { open: ['F1', 'F2', 'F3', 'F4'] });
  repairCycle(log, { open: ['F2', 'F3', 'F4'] });
  assert.equal(stalled(log), false);
  // The same set back again, under the same one identity, closed nothing.
  repairCycle(log, { open: ['F2', 'F3', 'F4'] });
  assert.equal(stalled(log), true);
});

test('a render with no repair round behind it, or a fresh pass, is never a stall', () => {
  const log = ledger();
  finding(log, 'F1', 'the paginator is off by one');
  localRender(log, { open: ['F1'] });
  // A cycle the ladder reached by another route — a re-freeze, an operational
  // fix — judges no repair round and spends nothing.
  localRender(log, { open: ['F1'] });
  assert.equal(stalled(log), false);
  // The first cycle of a fresh pass judges a tree the previous render never
  // saw, so the comparison does not apply.
  log.append('fresh-pass', { pass: 2, trigger: 'no-progress' });
  repairCycle(log, { open: ['F1'], pass: 2 });
  assert.equal(stalled(log), false);
});

test('the two guards divide the failure shapes: no progress takes the pass, repeated inputs park', () => {
  // A repair round that closes one and surfaces another is progress to the
  // ladder and a new fingerprint to the cycle guard: neither fires.
  const moving = ledger();
  finding(moving, 'F1', 'the paginator is off by one');
  localRender(moving, { open: ['F1'] });
  finding(moving, 'F2', 'the sort key ignores case');
  repairCycle(moving, { open: ['F2'] });
  assert.equal(stalled(moving), false);
  assert.equal(decide(moving).action, 'proceed');

  // A round that commits nothing leaves the tree, the suite and the findings
  // where they were. The ladder calls it a stall and takes the fresh pass; the
  // cycle guard sees identical inputs and buys one retry, then parks.
  const stuck = ledger();
  finding(stuck, 'F1', 'the paginator is off by one');
  localRender(stuck, { open: ['F1'] });
  finding(stuck, 'F2', 'the paginator is off by one');
  repairCycle(stuck, { open: ['F2'] });
  assert.equal(stalled(stuck), true);
  const repeat = decide(stuck);
  assert.equal(repeat.action, 'retry');
  grant(stuck, repeat);
  finding(stuck, 'F3', 'the paginator is off by one');
  repairCycle(stuck, { open: ['F3'] });
  assert.equal(stalled(stuck), true);
  assert.equal(decide(stuck).action, 'park');
});

test('a local verdict rests on no check state, so the checks never reach it', () => {
  const log = ledger();
  log.append('finding', { id: 'F1', class: 'code-defect', summary: 'wrong', evidence: 'unit' });
  const render = { seq: 50, cycle: 1, sha: SHA, open: ['F1'], record: 'r1' };
  const before = cycleFingerprint(log.events, render);
  log.append('check-transition', { sha: SHA, check: 'ci', status: 'failure' });
  assert.equal(cycleFingerprint(log.events, { ...render, seq: 99 }), before);
});

// -- the flake reading and where it is withdrawn ------------------------------

/** One red, one re-run, one green on a check: the flake the ledger records. */
function flake(log, { sha = SHA, check = 'ci' } = {}) {
  log.append('check-transition', { sha, check, status: 'failure' });
  log.append('check-transition', { sha, check, status: 'rerun-requested' });
  log.append('check-transition', { sha, check, status: 'success' });
  return log.append('ci-flake', { pr: 7, sha, check });
}

test('a check is a flake twice on one head sha and deterministic-red at the third', () => {
  const log = ledger();
  flake(log);
  assert.equal(ciFlakes(log.events, SHA, 'ci'), 1);
  assert.equal(deterministicRed(log.events, SHA, 'ci'), false);
  flake(log);
  assert.equal(deterministicRed(log.events, SHA, 'ci'), false);
  flake(log);
  assert.equal(ciFlakes(log.events, SHA, 'ci'), FLAKE_LIMIT);
  assert.equal(deterministicRed(log.events, SHA, 'ci'), true);
});

test('two head shas on one check are two trees: both stay flakes', () => {
  // The pair is the key. Four flakes here, and neither sha carries the three
  // that say a check answers both ways about one tree.
  const log = ledger();
  flake(log, { sha: SHA });
  flake(log, { sha: NEXT_SHA });
  flake(log, { sha: SHA });
  flake(log, { sha: NEXT_SHA });
  assert.equal(deterministicRed(log.events, SHA, 'ci'), false);
  assert.equal(deterministicRed(log.events, NEXT_SHA, 'ci'), false);
});

test('two checks on one head sha are two questions: both stay flakes', () => {
  const log = ledger();
  flake(log, { check: 'ci' });
  flake(log, { check: 'lint' });
  flake(log, { check: 'ci' });
  flake(log, { check: 'lint' });
  assert.equal(deterministicRed(log.events, SHA, 'ci'), false);
  assert.equal(deterministicRed(log.events, SHA, 'lint'), false);
  // The third on one of them classifies that one and leaves the other alone.
  flake(log, { check: 'lint' });
  assert.equal(deterministicRed(log.events, SHA, 'lint'), true);
  assert.equal(deterministicRed(log.events, SHA, 'ci'), false);
});

test('a cancel and the green behind it are no part of the count', () => {
  // The generator of the flood: a cancel is terminal and it is not green, so
  // reading it as a red made every cancel-then-green cycle look like a flake.
  // One head sha carried 36 of them. The count is of `ci-flake` records, and
  // the watcher mints none for a cancel, so nothing here follows the cycle
  // (ADR-0041).
  const log = ledger();
  for (let i = 0; i < FLAKE_LIMIT * 4; i++) {
    log.append('check-transition', { sha: SHA, check: 'ci', status: 'cancelled' });
    log.append('check-transition', { sha: SHA, check: 'ci', status: 'success' });
  }
  assert.equal(ciFlakes(log.events, SHA, 'ci'), 0);
  assert.equal(deterministicRed(log.events, SHA, 'ci'), false);
});

test('the count is of the check and the tree, whatever attempt answered', () => {
  // The identity of an attempt keys the evidence and the classification; it
  // does not key this. Two attempts at one check on one tree are the same
  // question asked twice, and the third green over that tree is the answer
  // this rule is about, whichever check run produced it.
  const log = ledger();
  const attempts = ['41', '42', '43'];
  for (const checkRunId of attempts) {
    log.append('check-transition', { sha: SHA, check: 'ci', status: 'failure', checkRunId, attempt: 1 });
    log.append('check-transition', { sha: SHA, check: 'ci', status: 'rerun-requested', checkRunId });
    log.append('check-transition', { sha: SHA, check: 'ci', status: 'success', checkRunId, attempt: 2 });
    log.append('ci-flake', { pr: 7, sha: SHA, check: 'ci', checkRunId });
  }
  assert.equal(ciFlakes(log.events, SHA, 'ci'), FLAKE_LIMIT);
  assert.equal(deterministicRed(log.events, SHA, 'ci'), true);
});

test('the evidence stamps of a check are no part of its flake count', () => {
  // `ci-evidence` lands beside the transitions of every red attempt, and a
  // check that is captured twice is not a check that flaked twice.
  const log = ledger();
  flake(log);
  for (const checkRunId of ['41', '42', '43', '44']) {
    log.append('ci-evidence', { sha: SHA, check: 'ci', checkRunId, log: 'captured' });
  }
  assert.equal(ciFlakes(log.events, SHA, 'ci'), 1);
  assert.equal(deterministicRed(log.events, SHA, 'ci'), false);
});
