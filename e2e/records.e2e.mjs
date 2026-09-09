// Scenario 8: a record-only ticket is a run of its own. The records lane has no
// fix seat, no suite and no code verdict: readiness reads the ticket, the birth
// seat writes the records the ticket decides, the reconcile stage judges them
// against the tree, and the ship stages carry them to the merge (ADR-0074,
// ADR-0075).
//
// It runs against the same real remote, the same real console binary and the
// same real gate commands as every other scenario. What it proves that no unit
// test can is that the lane exists end to end: the console admits it, the daemon
// registers it, the two record seats reach the enumerator on disk, and the
// records land on the default branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  PROJECT,
  PROJECT_CONFIG,
  assertMilestones,
  assertNoWiringFailure,
  assertSeatArgv,
  assertStatusRenders,
  buildFixture,
  cleanup,
  ctl,
  ctlRefused,
  diagnostics,
  forgeCalls,
  gateMarks,
  instanceEvents,
  originSha,
  originTree,
  pollFor,
  runEvents,
  seatCalls,
  stalled,
  startDaemon,
  stopDaemon,
  updateScenario,
} from './fixture.mjs';

const RECORD = 'docs/adr/adr-0001-double-the-base.md';
const TICKET = '.olympus/tickets/record-only.md';

// The record the ticket decides. Every claim in it names a path the tree holds,
// because a claim's evidence has to resolve in the worktree (ADR-0073).
const RECORD_TEXT = [
  '# ADR-0001: Double the base',
  '',
  '**Status:** Accepted',
  '',
  '## Decision',
  '',
  'The module src/base.mjs holds the factor the shop route reads.',
  '',
  '## Consequences',
  '',
  'The doubling of the route output is not yet implemented.',
  '',
].join('\n');

// The record as the reconciliation leaves it: the same decision, stated against
// the tree the run is about to merge.
const RECORD_RECONCILED = RECORD_TEXT.replace(
  'The doubling of the route output is not yet implemented.',
  'The module routes/[lang=lang]/shop/+page.mjs states the page it serves.',
);

// A ticket that names decision records and nothing else. The lane is chosen by
// the fenced block, and the same block is what the repair lane refuses.
const RECORD_TICKET = `# Record ticket: state the doubling decision

## The work

The decision record tree does not state what src/base.mjs decides. Write it.

## Touched paths

\`\`\`touched-paths
${RECORD}
\`\`\`
`;

// The live shape of a records-lane judgment. The whole diff of the run is the
// birth write. The judge leaves out a born record that still stands, so it owes
// nothing. The born set is the run's record set all the same, and the stage
// reads it (ADR-0077).
const SCENARIO = {
  bornRecords: { [RECORD]: RECORD_TEXT },
  reconcileJudge: {
    owed: false,
    records: [],
    reason: 'the record this run wrote states what the tree holds',
  },
};

// The other shape: a judge that owes the record. The stage then writes it
// against the tree before it reviews it.
const SCENARIO_OWED = {
  bornRecords: { [RECORD]: RECORD_TEXT },
  reconcileJudge: {
    owed: true,
    records: [RECORD],
    reason: 'the run writes the record this ticket decides',
  },
  reconcileWrites: { [RECORD]: RECORD_RECONCILED },
};

test('a record-only ticket ships through the records lane', async (t) => {
  const fx = buildFixture({
    prefix: 'olympus-e2e-records-',
    scenario: SCENARIO,
    tree: { [TICKET]: RECORD_TICKET },
  });
  t.after(() => cleanup(fx));

  await startDaemon(fx);
  // The tree every record seat of this run judges against: the default branch
  // as it stands at the launch, which is the merge base of the run branch.
  const launchBase = originSha(fx, 'refs/heads/main');

  // The lane takes a ticket, exactly as the repair lane does, and the console
  // settles that pairing before anything is provisioned.
  const refused = ctlRefused(fx, ['launch', '--project', PROJECT, '--lane', 'records']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--lane records requires --ticket/);

  ctl(fx, ['launch', '--project', PROJECT, '--lane', 'records', '--ticket', TICKET]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  assertStatusRenders(assert, ctl(fx, ['status']));

  await pollFor(
    'the record commit',
    () => runEvents(fx, runId).some((e) => e.event === 'records-committed'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  await pollFor(
    'the green reconciliation',
    () =>
      runEvents(fx, runId).some((e) => e.event === 'reconcile-rendered' && e.verdict === 'green'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).some((e) => e.event === 'run-closed'),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  await pollFor(
    'the workspace release',
    () => instanceEvents(fx).some((e) => e.event === 'workspace-released' && e.runId === runId),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );

  const events = runEvents(fx, runId);
  assertNoWiringFailure(assert, fx, runId);

  assertMilestones(assert, events, [
    'run-launched',
    'stage-entered',
    'records-committed',
    'reconciliation-judged',
    'reconcile-rendered',
    'pr-opened',
    'check-transition',
    'merged',
    'run-closed',
  ]);

  const launched = events.find((e) => e.event === 'run-launched');
  assert.equal(launched.lane, 'records');
  assert.equal(launched.ticket, TICKET, 'the console did not pass the ticket through');

  // The stages the lane holds, in order, and none of the ones it does not: no
  // fix seat, no suite, no adversary, no code verdict.
  const stages = events.filter((e) => e.event === 'stage-entered').map((e) => e.stage);
  assert.deepEqual(
    [...new Set(stages)],
    ['readiness', 'records', 'reconcile', 'update', 'ship', 'close-out'],
  );
  assert.ok(!events.some((e) => e.event === 'verdict-rendered'));
  assert.ok(!events.some((e) => e.event === 'implementation-committed'));
  assert.ok(!events.some((e) => e.event === 'freeze'));

  // The birth wrote the record and committed it before anything judged it.
  const born = events.find((e) => e.event === 'records-committed');
  assert.equal(born.decided, true);
  assert.deepEqual(born.paths, [RECORD]);

  // The judge found the record born in this run, so nothing was late.
  const judged = events.find((e) => e.event === 'reconciliation-judged');
  assert.deepEqual(judged.born, [RECORD]);
  assert.deepEqual(judged.late, []);

  // Nothing was written. The judge owed no record, and no writer ran over the
  // one the birth wrote.
  assert.ok(!events.some((e) => e.event === 'reconciliation-written'));

  // Every record seat answered every unit of the record it was given.
  const unitStamps = events.filter((e) => e.event === 'record-units');
  assert.deepEqual(
    [...new Set(unitStamps.map((e) => e.record))],
    [RECORD],
    'a record seat answered a record it was not given',
  );
  assert.ok(unitStamps.every((e) => e.units.length > 0));
  assert.ok(unitStamps.some((e) => e.seat === 'record-author'));
  assert.ok(unitStamps.some((e) => e.seat.startsWith('record-review')));

  // The stage's own render, at the record commit's own sha, and no finding.
  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].verdict, 'green');
  assert.deepEqual(rendered[0].open, []);
  assert.deepEqual(rendered[0].records, [RECORD]);
  assert.deepEqual(
    events.filter((e) => e.event === 'finding'),
    [],
  );

  // The record diff selects the record layers and no other. The project names
  // `lint`, so the whole lane spends that one gate and never the code suite
  // (ADR-0075). The cache mark rides the lint gate's own reading.
  assert.deepEqual(gateMarks(fx), ['lint', 'cache-cold']);
  assert.deepEqual(
    events.filter((e) => e.event === 'layer-result').map((e) => [e.layer, e.status]),
    [['lint', 'green']],
  );
  assert.deepEqual(rendered[0].layers, [{ layer: 'lint', status: 'green' }]);
  // And the wall clock of the record diff's gates is a fact the eval reads.
  assert.ok(
    events.filter((e) => e.event === 'layer-result').every((e) => typeof e.elapsedMs === 'number'),
  );

  // The seats the lane spends: the birth, the judge and one review.
  const seats = seatCalls(fx);
  for (const call of seats) assertSeatArgv(assert, call);
  assert.deepEqual(
    seats.map((c) => c.seat),
    ['record-author', 'reconcile-judge', 'record-review'],
    'the records lane spawned seats it does not owe',
  );
  // The brief names what reads the form of the born files and when. The seat
  // environment carries the base the layer judges against at the render: the
  // merge base, which is the base CI reads the request at (ADR-0079).
  const author = seats.find((c) => c.seat === 'record-author');
  assert.equal(author.baseSha, launchBase);
  assert.match(author.prompt, /These layers read your files after the commit, at the render: lint\./);
  assert.match(author.prompt, /check your own files before you report/);
  // Every record seat reads the harness's own enumerator by absolute path, and
  // the review seat is given the record and no diff.
  const review = seats.find((c) => c.seat === 'record-review');
  assert.match(review.prompt, /^Review one decision record: /m);
  assert.ok(!review.prompt.includes('git diff'), 'the record review was given a diff');
  assert.match(review.prompt, /olympus-units\.mjs/);
  assert.equal(review.named, 'record-review:1');

  // The request names the lane that opened it. The records lane used to
  // borrow the repair word (ADR-0077).
  const create = forgeCalls(fx).find((c) => c.handled === 'pr-create');
  assert.equal(create.argv[create.argv.indexOf('--title') + 1], `records: ${runId}`);

  // The records rode the merge, and the default branch holds them.
  const merged = events.find((e) => e.event === 'merged');
  assert.equal(merged.red, false);
  assert.equal(merged.reconciled, true);
  assert.equal(originSha(fx, 'refs/heads/main'), merged.mergeSha);
  assert.ok(originTree(fx, 'main').includes(RECORD), 'the record did not ride the merge');

  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'shipped');
  // Nothing is owed behind it: the records shipped with the run that wrote them.
  assert.ok(!events.some((e) => e.event === 'reconciliation-judged' && e.ticket));

  await stopDaemon(fx);
});

test('a judge that owes the born record writes it, and the write rides the merge', async (t) => {
  // The other shape of the same lane. The judge names the born record, so the
  // stage writes it before the review reads it. The write stamp is the anchor
  // of that cycle, as it always was (ADR-0075).
  const fx = buildFixture({
    prefix: 'olympus-e2e-records-owed-',
    scenario: SCENARIO_OWED,
    tree: { [TICKET]: RECORD_TICKET },
  });
  t.after(() => cleanup(fx));

  await startDaemon(fx);
  ctl(fx, ['launch', '--project', PROJECT, '--lane', 'records', '--ticket', TICKET]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).some((e) => e.event === 'run-closed'),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );

  const events = runEvents(fx, runId);
  assertNoWiringFailure(assert, fx, runId);
  assertMilestones(assert, events, [
    'records-committed',
    'reconciliation-judged',
    'reconciliation-written',
    'reconcile-rendered',
    'pr-opened',
    'merged',
    'run-closed',
  ]);

  // One writer, with its own slot identity, and the per-record entry behind it.
  const written = events.find((e) => e.event === 'reconciliation-written');
  assert.equal(written.ok, true);
  assert.deepEqual(written.rewritten, [RECORD]);
  assert.equal(written.records.length, 1);
  assert.equal(written.records[0].seat, 'reconcile-write:1');
  assert.ok(written.records[0].unitsAnswered > 0);

  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.at(-1).verdict, 'green');
  assert.deepEqual(rendered.at(-1).records, [RECORD]);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The rewritten record is what the default branch holds.
  assert.ok(originTree(fx, 'main').includes(RECORD), 'the record did not ride the merge');

  await stopDaemon(fx);
});

test('a record-only ticket is refused on the repair lane, with the lane to use', async (t) => {
  const fx = buildFixture({
    prefix: 'olympus-e2e-records-lane-',
    scenario: SCENARIO,
    tree: { [TICKET]: RECORD_TICKET },
  });
  t.after(() => cleanup(fx));
  await startDaemon(fx);

  ctl(fx, ['launch', '--project', PROJECT, '--lane', 'repair', '--ticket', TICKET]);
  const rejected = await pollFor(
    'the refusal stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch-rejected'),
    { diagnose: () => diagnostics(fx) },
  );
  assert.equal(rejected.lane, 'repair');
  assert.equal(rejected.ticket, TICKET);
  assert.match(rejected.reason, /records/);
  // Nothing was spent on it, and the console's own feedback names the lane.
  assert.ok(!instanceEvents(fx).some((e) => e.event === 'launch'));
  assertStatusRenders(assert, ctl(fx, ['status']));

  await stopDaemon(fx);
});

// -- the supersede lifecycle (ADR-0078) ---------------------------------------
//
// The project that never edits an accepted record. A write closes the old
// record on its status line and adds the record that states the tree. The
// closed record owes no unit, and a seat that answers its units all the same is
// not refused for it.

/** The project config with the lifecycle this scenario is about. */
const SUPERSEDE_PROJECT =
  JSON.stringify(
    { ...PROJECT_CONFIG, repo: { ...PROJECT_CONFIG.repo, recordLifecycle: 'supersede' } },
    null,
    2,
  ) + '\n';

const HEIRS = ['docs/adr/adr-0002-name-the-base.md', 'docs/adr/adr-0003-read-the-base.md'];

/** The record as the write closes it: nothing changed but the status line. */
const RECORD_CLOSED = RECORD_TEXT.replace(
  '**Status:** Accepted',
  '**Status:** Superseded by ADR-0002 and ADR-0003 (2026-09-08)',
);

/** One record that replaces another, naming it back under its status line. */
function heir(id, title, decision) {
  return [
    `# ADR-${id}: ${title}`,
    '',
    '**Status:** Accepted',
    '**Supersedes:** ADR-0001',
    '',
    '## Decision',
    '',
    decision,
    '',
  ].join('\n');
}

const HEIR_TEXT = {
  [HEIRS[0]]: heir('0002', 'Name the base', 'The module src/base.mjs names the factor.'),
  [HEIRS[1]]: heir('0003', 'Read the base', 'The route routes/[lang=lang]/shop/+page.mjs reads it.'),
};

const SUPERSEDE_TICKET = `# Record ticket: split the doubling decision

## The work

The decision this record states is two decisions. Write them, and close the
record they replace.

## Touched paths

\`\`\`touched-paths
${RECORD}
${HEIRS[0]}
${HEIRS[1]}
\`\`\`
`;

// The birth writes all three files and reports all three in "rewritten",
// answering every unit of every one of them. The harness drops the answers
// about the record the write closed, and refuses nothing.
const SCENARIO_SUPERSEDE = {
  bornRecords: {
    [RECORD]: RECORD_CLOSED,
    [HEIRS[0]]: HEIR_TEXT[HEIRS[0]],
    [HEIRS[1]]: HEIR_TEXT[HEIRS[1]],
  },
  recordSiblings: true,
  reconcileJudge: {
    owed: false,
    records: [],
    reason: 'the records this run wrote state what the tree holds',
  },
};

// The reconcile stage's own supersession: the birth decides nothing, the judge
// owes the accepted record, and the write closes it and adds its replacement.
const SCENARIO_WRITE_SUPERSEDE = {
  recordSiblings: true,
  reconcileJudge: {
    owed: true,
    records: [RECORD],
    reason: 'the diff moved past what this record states',
  },
  reconcileSupersedes: {
    [RECORD]: {
      closed: RECORD_TEXT.replace(
        '**Status:** Accepted',
        '**Status:** Superseded by ADR-0002 (2026-09-08)',
      ),
      added: HEIRS[0],
      text: HEIR_TEXT[HEIRS[0]],
    },
  },
};

test('a birth that supersedes one record with two ships on one attempt', async (t) => {
  const fx = buildFixture({
    prefix: 'olympus-e2e-records-supersede-',
    scenario: SCENARIO_SUPERSEDE,
    tree: {
      '.olympus/project.json': SUPERSEDE_PROJECT,
      [TICKET]: SUPERSEDE_TICKET,
      [RECORD]: RECORD_TEXT,
    },
  });
  t.after(() => cleanup(fx));

  await startDaemon(fx);
  ctl(fx, ['launch', '--project', PROJECT, '--lane', 'records', '--ticket', TICKET]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).some((e) => e.event === 'run-closed'),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );

  const events = runEvents(fx, runId);
  assertNoWiringFailure(assert, fx, runId);
  assertMilestones(assert, events, [
    'records-committed',
    'reconciliation-judged',
    'reconcile-review-set',
    'reconcile-rendered',
    'pr-opened',
    'merged',
    'run-closed',
  ]);

  // One birth attempt. The seat answered the closed record's units as well, and
  // the harness dropped them rather than refusing the report.
  const author = seatCalls(fx).filter((c) => c.seat === 'record-author');
  assert.equal(author.length, 1, 'the birth was refused and dispatched again');
  assert.ok(!events.some((e) => e.event === 'seat-failure'));
  assert.match(author[0].prompt, /A status-line change of an old record is not a rewrite\./);

  // The birth commit holds all three files, and the unit stamps name the two
  // records the write added.
  const born = events.find((e) => e.event === 'records-committed');
  assert.deepEqual(born.paths.slice().sort(), [RECORD, ...HEIRS].sort());
  assert.deepEqual(
    events
      .filter((e) => e.event === 'record-units' && e.seat === 'record-author')
      .map((e) => e.record)
      .sort(),
    HEIRS.slice().sort(),
  );

  // One review seat per active record, and none for the record the write
  // closed.
  const dispatched = events.filter((e) => e.event === 'reconcile-review-set');
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].records.slice().sort(), HEIRS.slice().sort());
  const reviews = seatCalls(fx).filter((c) => c.seat === 'record-review');
  assert.equal(reviews.length, 2);
  for (const call of reviews) {
    assert.ok(!call.prompt.includes(`Review one decision record: ${RECORD}`), call.prompt);
  }

  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].verdict, 'green');
  assert.deepEqual(rendered[0].records.slice().sort(), HEIRS.slice().sort());
  // The record layers still read the whole record diff.
  assert.deepEqual(
    events.filter((e) => e.event === 'layer-result').map((e) => [e.layer, e.status]),
    [['lint', 'green']],
  );

  // The supersession rode the merge: the closed record and both heirs stand on
  // the default branch.
  const merged = events.find((e) => e.event === 'merged');
  assert.equal(merged.reconciled, true);
  const tree = originTree(fx, 'main');
  for (const path of [RECORD, ...HEIRS]) assert.ok(tree.includes(path), path);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');

  await stopDaemon(fx);
});

test('a judged write supersedes its record and answers the replacement', async (t) => {
  const fx = buildFixture({
    prefix: 'olympus-e2e-records-write-supersede-',
    scenario: SCENARIO_WRITE_SUPERSEDE,
    tree: {
      '.olympus/project.json': SUPERSEDE_PROJECT,
      [TICKET]: RECORD_TICKET,
      [RECORD]: RECORD_TEXT,
    },
  });
  t.after(() => cleanup(fx));

  await startDaemon(fx);
  ctl(fx, ['launch', '--project', PROJECT, '--lane', 'records', '--ticket', TICKET]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).some((e) => e.event === 'run-closed'),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );

  const events = runEvents(fx, runId);
  assertNoWiringFailure(assert, fx, runId);
  assertMilestones(assert, events, [
    'reconciliation-judged',
    'reconcile-write-set',
    'reconciliation-written',
    'reconcile-rendered',
    'merged',
    'run-closed',
  ]);

  // The round stamped the set it dispatched, and the one writer of it closed
  // the record it was given.
  const dispatched = events.find((e) => e.event === 'reconcile-write-set');
  assert.deepEqual(dispatched.records, [RECORD]);
  assert.deepEqual(dispatched.skipped, []);
  const writers = seatCalls(fx).filter((c) => c.seat === 'reconcile-write');
  assert.equal(writers.length, 1);
  assert.equal(writers[0].named, 'reconcile-write:1');

  const written = events.find((e) => e.event === 'reconciliation-written');
  assert.equal(written.ok, true);
  assert.deepEqual(written.rewritten, [HEIRS[0]]);
  assert.deepEqual(
    written.records.map((r) => [r.record, r.seat]),
    [[RECORD, 'reconcile-write:1']],
  );
  assert.ok(written.records[0].unitsAnswered > 0);
  // The write answered the closed record's units too, and the stamp holds the
  // record it added and no other.
  assert.deepEqual(
    events
      .filter((e) => e.event === 'record-units' && e.seat.startsWith('reconcile-write'))
      .map((e) => e.record),
    [HEIRS[0]],
  );

  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.at(-1).verdict, 'green');
  assert.deepEqual(rendered.at(-1).records, [HEIRS[0]]);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const tree = originTree(fx, 'main');
  for (const path of [RECORD, HEIRS[0]]) assert.ok(tree.includes(path), path);

  await stopDaemon(fx);
});

// -- the corrective round (ADR-0079) ------------------------------------------
//
// The shape the run this plan comes from met: a born supersession, a red
// render over it, and a corrective round in which one seat spends its budget.
// The parent of every replacement closed in the birth commit, one commit before
// the round opened (W11, W14).

const SCENARIO_CORRECTIVE = {
  bornRecords: {
    [RECORD]: RECORD_CLOSED,
    [HEIRS[0]]: HEIR_TEXT[HEIRS[0]],
    [HEIRS[1]]: HEIR_TEXT[HEIRS[1]],
  },
  recordSiblings: true,
  reconcileJudge: {
    owed: false,
    records: [],
    reason: 'the records this run wrote state what the tree holds',
  },
  // A finding on each heir. The first is answered in one round; the second
  // holds a seat that spends its budget before it writes.
  recordFindings: {
    [HEIRS[0]]: { summary: 'the record states a module the tree does not hold', reads: 1 },
    [HEIRS[1]]: { summary: 'the record names a route the tree does not serve', reads: 2 },
  },
  recordRefusals: { [HEIRS[1]]: 2 },
  confirmFindings: true,
};

test('a corrective round over a born supersession survives a refused seat', async (t) => {
  const fx = buildFixture({
    prefix: 'olympus-e2e-records-corrective-',
    scenario: SCENARIO_CORRECTIVE,
    tree: {
      '.olympus/project.json': SUPERSEDE_PROJECT,
      [TICKET]: SUPERSEDE_TICKET,
      [RECORD]: RECORD_TEXT,
    },
  });
  t.after(() => cleanup(fx));

  await startDaemon(fx);
  ctl(fx, ['launch', '--project', PROJECT, '--lane', 'records', '--ticket', TICKET]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).some((e) => e.event === 'run-closed'),
    { attempts: 1800, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );

  const events = runEvents(fx, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The birth wrote the supersession, and no seat was refused over the pairing:
  // the parent closed in the birth commit, and the window reads it.
  const author = seatCalls(fx).filter((c) => c.seat === 'record-author');
  assert.equal(author.length, 1);
  assert.match(author[0].baseSha ?? '', /^[0-9a-f]{40}$/);

  // One round dispatched both heirs; one wrote, and one spent its budget.
  const rounds = events.filter((e) => e.event === 'reconcile-round');
  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds[0].records.slice().sort(), HEIRS.slice().sort());
  assert.deepEqual(rounds[0].failed, [HEIRS[1]]);
  const written = events.filter((e) => e.event === 'reconciliation-written');
  const failed = written[0].records.find((r) => r.record === HEIRS[1]);
  assert.equal(failed.failed, true);
  assert.equal(failed.attempts, 2);
  assert.ok(failed.defects.length > 0);
  // The only seat failure is that dispatch, and the run neither closed nor
  // parked on it.
  assert.deepEqual(
    events.filter((e) => e.event === 'seat-failure').map((e) => e.reason),
    ['work-product-defect'],
  );
  assert.ok(!events.some((e) => e.event === 'park'));

  // The render that followed named the record no write answered, and the next
  // round dispatched that record alone.
  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.ok(rendered[1].open.includes(`unwritten:${HEIRS[1]}`), rendered[1].open.join(', '));
  assert.deepEqual(rounds[1].records, [HEIRS[1]]);
  assert.equal(rendered.at(-1).verdict, 'green');

  // The third cycle read the record that moved and kept the one that did not.
  const cycles = events.filter((e) => e.event === 'reconcile-review-set');
  assert.equal(cycles.length, 3);
  assert.deepEqual(cycles[2].records, [HEIRS[1]]);
  assert.deepEqual(
    (cycles[2].kept ?? []).map((k) => k.record),
    [HEIRS[0]],
  );

  // The supersession rode the merge.
  const tree = originTree(fx, 'main');
  for (const path of [RECORD, ...HEIRS]) assert.ok(tree.includes(path), path);

  await stopDaemon(fx);
});

// -- a moved default branch (ADR-0079) ----------------------------------------

/** One commit on the default branch of the fixture origin, from the seed. */
function pushToMain(fx, path, content, message) {
  const full = join(fx.seed, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  execFileSync('git', ['add', '-A'], { cwd: fx.seed, encoding: 'utf8', windowsHide: true });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', message], {
    cwd: fx.seed,
    encoding: 'utf8',
    windowsHide: true,
  });
  execFileSync('git', ['push', '--quiet', fx.origin, 'main'], {
    cwd: fx.seed,
    encoding: 'utf8',
    windowsHide: true,
  });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fx.seed,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

/** A record the default branch gains while the run works. */
const INCOMING = 'docs/adr/adr-0009-hold-the-route.md';
const INCOMING_TEXT = [
  '# ADR-0009: Hold the route',
  '',
  '**Status:** Accepted',
  '',
  '## Decision',
  '',
  'The module src/base.mjs holds the factor this route reads.',
  '',
].join('\n');

test('a moved default branch re-runs the reconciliation on the run own set', async (t) => {
  const fx = buildFixture({
    prefix: 'olympus-e2e-records-moved-',
    // The judge holds the run inside the reconcile stage while the default
    // branch moves. The birth has committed by then, and the update is two
    // stages away, so the push lands before anything reads the branch.
    scenario: { ...SCENARIO, stallSeat: 'reconcile-judge' },
    tree: { [TICKET]: RECORD_TICKET },
  });
  t.after(() => cleanup(fx));

  await startDaemon(fx);
  ctl(fx, ['launch', '--project', PROJECT, '--lane', 'records', '--ticket', TICKET]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  await pollFor(
    'the judge to reach its hold',
    () => existsSync(fx.stallMarker),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  // The competing work: a record on the default branch, which the update merges
  // in. It is nobody's in this run, and the re-run reads the run's own set.
  const moved = pushToMain(fx, INCOMING, INCOMING_TEXT, 'records: main states one more decision');
  updateScenario(fx, { stallSeat: null });
  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).some((e) => e.event === 'run-closed'),
    { attempts: 1800, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );

  const events = runEvents(fx, runId);
  assertNoWiringFailure(assert, fx, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The update merged the moved branch and asked the reconciliation again.
  const update = events.find((e) => e.event === 'pre-verdict-update' && e.ran);
  assert.equal(update.mainSha, moved);
  assert.equal(update.records.answer, 'rerun');
  // The re-run read the run's own record and never the one main gained.
  const cycles = events.filter((e) => e.event === 'reconcile-review-set');
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles[1].records, [RECORD]);
  assert.equal(cycles[1].kept, undefined);
  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.length, 2);
  assert.deepEqual(rendered[1].records, [RECORD]);
  assert.equal(rendered[1].verdict, 'green');
  // Both records stand on the default branch, and the run wrote one of them.
  const tree = originTree(fx, 'main');
  assert.ok(tree.includes(RECORD), RECORD);
  assert.ok(tree.includes(INCOMING), INCOMING);

  await stopDaemon(fx);
});

// -- the cap park (ADR-0079) --------------------------------------------------

/** The project with one corrective round, so the cap is one round away. */
const ONE_ROUND_PROJECT =
  JSON.stringify(
    { ...PROJECT_CONFIG, gates: { ...PROJECT_CONFIG.gates, reconcileRounds: 1 } },
    null,
    2,
  ) + '\n';

// A finding the first round does not close: the review raises it on the first
// two reads, so the run reaches its cap with the finding still open.
const SCENARIO_CAP = {
  bornRecords: { [RECORD]: RECORD_TEXT },
  reconcileJudge: {
    owed: false,
    records: [],
    reason: 'the record this run wrote states what the tree holds',
  },
  recordFindings: {
    [RECORD]: { summary: 'the record states a module the tree does not hold', reads: 2 },
  },
  confirmFindings: true,
};

test('a records-lane run at its cap parks, takes a bought round, and ships', async (t) => {
  const fx = buildFixture({
    prefix: 'olympus-e2e-records-cap-',
    scenario: SCENARIO_CAP,
    tree: { '.olympus/project.json': ONE_ROUND_PROJECT, [TICKET]: RECORD_TICKET },
  });
  t.after(() => cleanup(fx));

  await startDaemon(fx);
  ctl(fx, ['launch', '--project', PROJECT, '--lane', 'records', '--ticket', TICKET]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  const park = await pollFor(
    'the cap park',
    () => runEvents(fx, runId).find((e) => e.event === 'park' && e.type === 'reconcile-cap'),
    { attempts: 1800, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  // The work is on the origin before anybody is asked, and the ticket states
  // the rest of it.
  assert.equal(originSha(fx, `refs/heads/run/${runId}`).length, 40);
  assert.deepEqual(park.answers.options, ['rounds', 'abandon']);
  const ticket = readFileSync(park.detail.ticket, 'utf8');
  assert.ok(ticket.includes('## The branch on origin'));
  assert.ok(ticket.includes(RECORD));
  // The console buys one more round, and the run finishes on it.
  ctl(fx, ['answer', '--run', runId, '--option', 'rounds', '--text', '1']);
  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).some((e) => e.event === 'run-closed'),
    { attempts: 1800, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );

  const events = runEvents(fx, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const extended = events.find((e) => e.event === 'reconcile-cap-extended');
  assert.equal(extended.parkSeq, park.seq);
  assert.equal(extended.rounds, 1);
  assert.equal(extended.cap, 2);
  assert.equal(events.filter((e) => e.event === 'reconcile-round').length, 2);
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').at(-1).verdict, 'green');
  assert.ok(events.some((e) => e.event === 'reconcile-stall'));
  // The record rode the merge after the bought round.
  assert.ok(originTree(fx, 'main').includes(RECORD), 'the record did not ride the merge');
  // The ticket the cap wrote describes work that shipped, so the close-out
  // takes it out of the directory a person launches from.
  assert.ok(!existsSync(park.detail.ticket), 'the cap ticket is still owed');
  assert.ok(existsSync(join(fx.home, 'tickets', 'absorbed', basename(park.detail.ticket))));
  const last = events.filter((e) => e.event === 'reconciliation-judged').at(-1);
  assert.equal(last.owed, false);
  assert.match(last.absorbed, /absorbed/);

  await stopDaemon(fx);
});
