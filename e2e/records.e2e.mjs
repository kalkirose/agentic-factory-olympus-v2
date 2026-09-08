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
