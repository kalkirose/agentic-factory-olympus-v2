// Scenario 1: one card ships. The daemon binary is started as a child
// process, the console binary launches the run, answers its open decision, and
// reads status while the run is in flight; the run walks the whole story lane
// against a real git remote, real gate commands and a real acceptance suite,
// and closes `shipped` with its workspace released.
//
// Nothing in this file reaches into the harness: every fact it asserts is read
// from the ledgers, the run artifacts and the fixture repository afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCost } from '../src/ledger/cost.mjs';
import {
  CARD_PATH,
  PROJECT,
  PROJECT_CONFIG,
  SMOKE_CEILING_MB,
  SMOKE_HELD_MB,
  assertMilestones,
  assertNoWiringFailure,
  assertSeatArgv,
  assertStatusRenders,
  buildFixture,
  cleanup,
  ctl,
  diagnostics,
  forgeCalls,
  gateMarks,
  instanceEvents,
  originFile,
  originSha,
  originTree,
  pollFor,
  runDir,
  runEvents,
  seatCalls,
  stalled,
  startDaemon,
  stopDaemon,
} from './fixture.mjs';

// The spec the stub seat authors. It holds the template the spec lint checks:
// one section per card criterion, a test mapping, named constants, supersedes,
// exactly one touched-paths block, a components section, an environment
// section.
const SPEC = `# alpha-1 spec

Base sha: the launch base. Scope exclusions: none beyond the card boundary.

## AC-1

f(x) answers twice the number it is given. The suite asserts it on one value.

Test mapping:
- tests/feature.test.mjs — f(2) is 4
- tests/feature-guard.test.mjs — f is a function

Named constants:
- FACTOR = 2

Supersedes:
- None

## Touched paths

\`\`\`touched-paths
src/feature.mjs (new) — dev
tests/feature.test.mjs (new) — suite
tests/feature-guard.test.mjs (new) — suite
\`\`\`

## Components

- \`PriceTag\`

## Environment

None; the card names none.
`;

const SUITE = `import test from 'node:test';
import assert from 'node:assert/strict';

test('f doubles its input', async () => {
  const { f } = await import('../src/feature.mjs');
  assert.equal(f(2), 4);
});
`;

// The second file of the same part. The first implementation pass answers it
// and fails the one above, so the layer's red names one file of two and the
// flake filter's re-run buys that one file.
const GUARD = `import test from 'node:test';
import assert from 'node:assert/strict';

test('f is a function', async () => {
  const { f } = await import('../src/feature.mjs');
  assert.equal(typeof f, 'function');
});
`;

// The first draft the birth seat writes, with the four mistakes a script can
// see planted in it (ADR-0067): a touched path the tree does not hold and the
// spec does not mark new, a touched path a frozen test pins by name with the
// pin declared nowhere, a route id under no directory of the routes root, and
// a component the design system does not hold. The lint refuses it on the
// birth seat's own check; the corrective round carries the four rules, and the
// seat writes the spec above.
const SPEC_FIRST_DRAFT = SPEC.replace(
  'src/feature.mjs (new) — dev\n',
  'src/feature.mjs — dev\nsrc/base.mjs — dev\n',
)
  .replace('- `PriceTag`', '- `PriceTag`\n- `RadioField`')
  .replace(
    'None; the card names none.',
    'None; the card names none. The storefront serves the result at `/[lang=lang]/cart`.',
  );

const SCENARIO = {
  spec: SPEC,
  specFirstDraft: SPEC_FIRST_DRAFT,
  suiteFiles: { 'tests/feature.test.mjs': SUITE, 'tests/feature-guard.test.mjs': GUARD },
  suiteReds: [
    { test: 'f doubles its input', class: 'feature-absence' },
    { test: 'f is a function', class: 'feature-absence' },
  ],
  // The first pass is off by one, so the suite layer is red and the layer that
  // needs it is not runnable. The repair round turns both green.
  devFiles: { 'src/feature.mjs': 'export function f(x) {\n  return x * 2 + 1;\n}\n' },
  repairFiles: { 'src/feature.mjs': 'export function f(x) {\n  return x * 2;\n}\n' },
};

test('the story lane ships a card through the assembled binaries', async (t) => {
  const fx = buildFixture({ prefix: 'olympus-e2e-story-', scenario: SCENARIO });
  t.after(() => cleanup(fx));

  await startDaemon(fx);
  // The stamp and the banner are two independent writes: the start returns on
  // the ledger stamp, and the line on the child's stdout can still be in
  // flight. Polling the buffer keeps this an assertion about what the binary
  // prints rather than about which write lands first.
  await pollFor('the start banner on stdout', () => /olympusd: started \(pid \d+/.test(fx.stdout), {
    attempts: 60,
    intervalMs: 50,
    abort: () => stalled(fx),
    diagnose: () => diagnostics(fx),
  });

  ctl(fx, ['launch', '--project', PROJECT, '--card', CARD_PATH]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );

  // Readiness parks on the card's open decision, and the console answers it.
  await pollFor(
    'the open-decisions park',
    () => runEvents(fx, runId).some((e) => e.event === 'park' && e.type === 'open-decisions'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  assertStatusRenders(assert, ctl(fx, ['status']));
  const queue = ctl(fx, ['queue']);
  assert.match(queue, /open-decisions/);
  // The queue prints the forms the park declared, abandon included, and the
  // command line that takes them (ADR-0029).
  assert.match(queue, /options: abandon/);
  assert.match(queue, /text: the decisions, resolved/);
  assert.match(
    queue,
    new RegExp(`answer: olympusctl answer --run ${runId} --option <option> \\| --text`),
  );
  ctl(fx, ['answer', '--run', runId, '--text', 'No; f trusts the value it is given.']);

  await pollFor('the freeze', () => runEvents(fx, runId).some((e) => e.event === 'freeze'), {
    abort: () => stalled(fx, runId),
    diagnose: () => diagnostics(fx, runId),
  });
  assertStatusRenders(assert, ctl(fx, ['status']));

  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).find((e) => e.event === 'run-closed'),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  await pollFor(
    'the workspace release',
    () => instanceEvents(fx).some((e) => e.event === 'workspace-released' && e.runId === runId),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );

  const events = runEvents(fx, runId);
  assertNoWiringFailure(assert, fx, runId);

  // -- the milestone sequence, in ledger order ------------------------------
  assertMilestones(assert, events, [
    'run-launched',
    'stage-entered',
    'park',
    'answer',
    'resume',
    'spec-born',
    'spec-gate-round',
    'suite-committed',
    'red-state-check',
    'freeze',
    'implementation-committed',
    'layer-result',
    'finding',
    'verdict-rendered',
    'repair-round',
    'verdict-rendered',
    // The reconciliation judgment sits in front of the ship token, so the
    // records an owed story writes ride its own request (ADR-0026).
    'reconciliation-judged',
    'pr-opened',
    'check-transition',
    'merged',
    'merge-commit-check',
    'card-sweep',
    'run-closed',
  ]);

  // -- pre-freeze ------------------------------------------------------------
  const gate = events.filter((e) => e.event === 'spec-gate-round');
  assert.deepEqual(
    gate.map((e) => [e.round, e.verdict, e.findings]),
    [[1, 'pass', 0]],
    'the spec gate did not pass in one clean round',
  );
  assert.equal(events.find((e) => e.event === 'red-state-check').result, 'red');
  assert.ok(events.some((e) => e.event === 'freeze'));
  const record = JSON.parse(readFileSync(join(runDir(fx, runId), 'freeze.json'), 'utf8'));
  assert.equal(record.storyKey, 'alpha-1');
  assert.ok(record.suiteFiles.includes('tests/feature.test.mjs'));
  assert.deepEqual(record.frozenExclusions, []);

  // -- the verdict: a full cycle, a repair round, a targeted cycle ----------
  const cycle1 = events.filter((e) => e.event === 'layer-result' && e.cycle === 1);
  assert.deepEqual(
    cycle1.map((e) => [e.layer, e.status]),
    [
      ['lint', 'green'],
      ['suite', 'red'],
      ['smoke', 'not-runnable'],
    ],
    'the first cycle did not run the full spectrum against the tree',
  );
  assert.equal(cycle1[2].attributedTo, 'suite');
  const cycle2 = events.filter((e) => e.event === 'layer-result' && e.cycle === 2);
  assert.deepEqual(
    cycle2.map((e) => [e.layer, e.status, e.confirmation === true]),
    [
      ['suite', 'green', false],
      ['smoke', 'green', false],
      ['lint', 'green', true],
      ['suite', 'green', true],
    ],
    'the targeted cycle and its confirmation sweep did not run the layers they owe',
  );
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.equal(renders.length, 2);
  // The first cycle would scope itself to the footprint of the run's own diff,
  // and on a fresh origin nothing has certified the tree it branched from. So it
  // runs every layer and the record says which condition was not met.
  assert.deepEqual(
    [renders[0].verdict, renders[0].sweep, renders[0].reason],
    ['red', 'full', 'no-base-certification'],
  );
  assert.deepEqual(
    [renders[1].verdict, renders[1].sweep, renders[1].confirmation],
    ['green', 'targeted', true],
  );

  // -- a cycle buys the failure, and never what it has already proven -------
  // The first cycle's suite layer failed one file of one part. Its re-run was
  // asked for that part and that file, and the part that had passed rode the
  // record as the green of the attempt that earned it.
  const suite1 = cycle1.find((e) => e.layer === 'suite');
  assert.deepEqual(
    suite1.narrowedTo,
    { parts: ['feature'], files: 1 },
    'the flake re-run of a red layer was not narrowed to what failed',
  );
  assert.deepEqual(
    suite1.parts.map((p) => [p.name, p.status, p.attempt]),
    [
      ['feature', 'red', 2],
      ['base', 'green', 1],
    ],
  );
  // The second cycle judged a diff under the feature part alone, so it carried
  // the base part; the confirmation sweep then bought that carried part and
  // kept the one the cycle had already run at this sha.
  const narrowed = cycle2.find((e) => e.layer === 'suite' && !e.confirmation);
  assert.deepEqual(
    narrowed.parts.map((p) => [p.name, p.carriedFrom]),
    [
      ['feature', undefined],
      ['base', 1],
    ],
  );
  const swept = cycle2.find((e) => e.layer === 'suite' && e.confirmation);
  assert.deepEqual(
    swept.parts.map((p) => [p.name, p.carriedFrom, p.confirmation === true]),
    [
      ['base', undefined, true],
      ['feature', undefined, false],
    ],
    'the shipped record rests on a part nothing ran at this sha',
  );
  assert.equal(swept.parts[1].seq, narrowed.seq);
  assert.deepEqual(renders[1].confirmationParts, { ran: 1, kept: 1 });
  const triage = events.filter((e) => e.event === 'finding' && e.source === 'triage');
  assert.equal(triage.length, 1);
  assert.deepEqual(triage[0].layers, ['suite']);
  assert.equal(events.filter((e) => e.event === 'repair-round').length, 1);
  for (const cycle of [1, 2]) {
    assert.ok(
      existsSync(join(runDir(fx, runId), `verdict-${cycle}.json`)),
      `no verdict record for cycle ${cycle}`,
    );
  }

  // -- what the layers cost the machine (ADR-0045) --------------------------
  // The assembled binaries, the fixture's own gate commands, the ledger the
  // daemon wrote: a green layer that held 48 MB is on the record as having held
  // it, with the ceiling its project declared and the sampling floor beside it.
  // That record is the whole input of the memory forecast, so a chain that
  // measures nothing here forecasts nothing at all.
  if (process.platform === 'win32' || process.platform === 'linux') {
    const smoke = cycle2.find((e) => e.layer === 'smoke');
    assert.ok(smoke.resources, 'the layer that held memory recorded nothing');
    assert.ok(
      smoke.resources.peakRssMb > SMOKE_HELD_MB,
      `smoke held ${SMOKE_HELD_MB} MB and recorded ${smoke.resources.peakRssMb} MB`,
    );
    assert.ok(smoke.resources.samples > 0);
    assert.equal(smoke.resources.ceilingMb, SMOKE_CEILING_MB);
    assert.equal(typeof smoke.resources.intervalMs, 'number');
    // Nothing died of memory, so nothing said anything did.
    assert.deepEqual(
      events.filter((e) => e.event === 'gate-integrity' && e.kind === 'resource-exhaustion'),
      [],
    );
  }

  // -- ship and close-out ----------------------------------------------------
  const opened = events.find((e) => e.event === 'pr-opened');
  assert.deepEqual(opened.required, ['ci']);
  assert.equal(opened.autoMerge, 'squash');
  assert.deepEqual(
    events.filter((e) => e.event === 'check-transition').map((e) => [e.check, e.status, e.required]),
    [
      ['ci', 'in_progress', true],
      ['ci', 'success', true],
    ],
  );
  const merged = events.find((e) => e.event === 'merged');
  assert.equal(merged.red, false);
  assert.notEqual(merged.mergeSha, merged.sha, 'the merge commit is the head commit');
  assert.equal(events.find((e) => e.event === 'merge-commit-check').status, 'success');
  assert.equal(events.find((e) => e.event === 'card-sweep').ok, true);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'shipped');
  assert.equal(closed.pr, 1);
  // The merge is a real ref update in the fixture origin, not a claim.
  assert.equal(originSha(fx, 'refs/heads/main'), merged.mergeSha);
  assert.ok(
    events.some((e) => e.event === 'red-merge-breach') === false,
    'a green merge recorded a breach',
  );

  // -- every configured command really spawned ------------------------------
  const marks = gateMarks(fx);
  assert.ok(marks.includes('cardlint'), 'the readiness lint command never ran');
  assert.ok(marks.includes('lint'), 'the lint layer never ran');
  assert.ok(marks.includes('smoke'), 'the smoke layer never ran');
  // The red-state check, the first cycle with its flake re-run, the targeted
  // cycle: the suite command is the busiest of them.
  assert.ok(
    marks.filter((m) => m === 'suite').length >= 3,
    `the suite command ran ${marks.filter((m) => m === 'suite').length} times`,
  );
  // The run's cache directory reached the gate commands, kept what one of them
  // left in it, and never reached the tree that shipped (ADR-0048).
  assert.ok(!marks.includes('cache-absent'), 'a gate command was offered no cache directory');
  assert.equal(marks.filter((m) => m === 'cache-cold').length, 1, 'the cache did not survive');
  assert.ok(marks.includes('cache-warm'), 'the second execution found a cold cache');
  assert.deepEqual(
    originTree(fx, 'refs/heads/main').filter((path) => path.startsWith('.olympus-cache')),
    [],
    'the run cache was committed',
  );
  // What the run spent before it existed, on the stamp that is about the
  // launch (ADR-0049). Measurement only, and nothing reads it.
  const setup = events.find((e) => e.event === 'run-launched').setup;
  for (const step of ['lockMs', 'cloneMs', 'configMs', 'worktreeMs', 'totalMs']) {
    assert.equal(typeof setup[step], 'number', `the setup record holds no ${step}`);
  }

  // -- what the run spent, and what its seats were handed -------------------
  assert.ok(runCost(events) > 0, 'no cost reached the ledger from the seat stream');
  const calls = seatCalls(fx);
  for (const call of calls) assertSeatArgv(assert, call);
  const seats = calls.map((c) => c.seat);

  // -- the spec lint refused the first draft on the birth seat's own check --
  // Four planted mistakes, four rules named, one corrective round, and no
  // gate round spent on any of them (ADR-0067).
  const births = calls.filter((c) => c.seat === 'spec-birth');
  assert.equal(births.length, 2, 'the birth seat did not get exactly one corrective round');
  assert.ok(!births[0].prompt.includes('Correction brief'));
  assert.ok(births[1].prompt.includes('Correction brief'), 'the second birth carried no brief');
  assert.match(
    births[1].prompt,
    /the touched-paths entry src\/feature\.mjs names no path in the tree at the spec's base sha; a path the story creates carries the marker \(new\)/,
  );
  assert.match(
    births[1].prompt,
    /the spec touches src\/base\.mjs; the test file tests\/base\.test\.mjs mentions that path, and the spec neither lists tests\/base\.test\.mjs in the touched-paths block nor names it in a Supersedes clause/,
  );
  assert.match(
    births[1].prompt,
    /the spec names the route \/\[lang=lang\]\/cart, and no such path exists under routes at the spec's base sha/,
  );
  assert.match(
    births[1].prompt,
    /the spec's Components section names RadioField, and no component of that name exists under components at the spec's base sha/,
  );
  assert.ok(!births[1].prompt.includes('/[lang=lang]/shop'), 'a route the tree holds was refused');
  assert.ok(!births[1].prompt.includes('names PriceTag'), 'a component the tree holds was refused');
  assert.equal(events.filter((e) => e.event === 'spec-born').length, 1);
  assert.ok(!events.some((e) => e.event === 'seat-failure' && e.seat === 'spec-birth'));
  // The seat that writes the block was told the marker and the two rules.
  assert.ok(births[0].prompt.includes('with the marker (new) between the path and the owner'));
  assert.ok(births[0].prompt.includes('is a pin on it'));
  assert.ok(births[0].prompt.includes('names a directory under the routes root'));
  assert.ok(births[0].prompt.includes('every design-system component the story renders'));
  for (const seat of [
    'spec-birth',
    'spec-gate',
    'suite',
    'dev',
    'verdict-triage',
    'repair-dev',
    'generalist-review',
    'card-sweep',
    'reconcile-judge',
    'fury-spec',
    'fury-operational',
  ]) {
    assert.ok(seats.includes(seat), `the ${seat} seat never ran`);
  }
  assert.ok(!seats.includes('fury-interface'), 'the interface seat ran on a diff with no UI path');
  // The default panel holds neither cut lens, so the seat that carries them
  // never spawns and the security lens rides the operational seat.
  assert.ok(!seats.includes('fury-code-shape'), 'the cut lenses spawned a seat');
  assert.ok(!seats.includes('fury-security'), 'a standalone security seat ran');
  // Every seat that writes code is bounded to the layers its own work reaches,
  // and told whose job the rest is. One stage judges a tree, and it is the
  // verdict.
  for (const seat of ['dev', 'repair-dev']) {
    const brief = calls.find((c) => c.seat === seat).prompt;
    assert.ok(
      brief.includes('The Tier-1 gate commands your work is bounded to:'),
      `the ${seat} seat was not told its bound`,
    );
    assert.ok(
      brief.includes('A refused layer is not yours to run and not a defect to work around'),
      `the ${seat} seat was not told whose job a refused layer is`,
    );
  }
  // The bound the seat actually ran inside, and the hook's own answer beside
  // its first command: a settings file the CLI refuses is ignored without a
  // word, so the load is proven from the stream and never from the write.
  for (const seat of ['dev', 'repair-dev']) {
    const stamp = events.find((e) => e.event === 'seat-bound' && e.seat === seat);
    assert.ok(stamp, `the ${seat} seat carried no bound`);
    assert.deepEqual(
      stamp.layers,
      ['lint', 'suite', 'smoke'],
      `the ${seat} bound named other layers`,
    );
    const bound = JSON.parse(
      readFileSync(join(runDir(fx, runId), 'seats', `${seat}-1.bound.json`), 'utf8'),
    );
    assert.equal(bound.seat, seat);
    assert.equal(bound.suite, 'suite');
    assert.ok(bound.declared.includes('src/feature.mjs'));
    assert.ok(
      !events.some((e) => e.event === 'seat-failure' && e.reason === 'bound-not-loaded'),
      'a seat ran a command with no answer from its bound hook',
    );
  }
  const operational = calls.find((c) => c.seat === 'fury-operational').prompt;
  assert.ok(operational.includes('- security: authorization on every entry point'));
  // The suite brief carries the same dimensions, because the map it asks for
  // is enumerated along them.
  const suite = calls.find((c) => c.seat === 'suite').prompt;
  assert.ok(suite.includes('- authorization on every entry point'));
  assert.ok(suite.includes('- trust boundaries'));

  // The machine's credential follows suite execution and nothing else.
  assert.equal(calls.find((c) => c.seat === 'dev').secret, true);
  assert.equal(calls.find((c) => c.seat === 'spec-gate').secret, false);
  const spawned = events.filter((e) => e.event === 'seat-spawned');
  assert.ok(spawned.find((e) => e.seat === 'spec-gate').envStripped >= 1);
  assert.equal(spawned.find((e) => e.seat === 'dev').envStripped, undefined);
  // The Fury panel against one model slot: the fan-out queues, never fails.
  assert.ok(
    events.some((e) => e.event === 'semaphore-wait'),
    'the model semaphore never queued a seat',
  );

  // -- the forge saw the calls the ship step owes ---------------------------
  const handled = forgeCalls(fx).map((c) => c.handled);
  assert.ok(!handled.includes('unknown'), `the ship step made an unhandled forge call: ${handled}`);
  for (const call of [
    'preflight-auto-merge',
    'preflight-protection',
    'pr-create',
    'pr-view-open',
    'pr-arm-auto-merge',
    'pr-state-open',
    'pr-state-merged',
  ]) {
    assert.ok(handled.includes(call), `the ship step never made the ${call} call`);
  }

  await stopDaemon(fx);
  assert.equal(fx.daemon.exitCode, 0, 'the daemon did not exit cleanly');
  const instance = instanceEvents(fx);
  assert.equal(instance.at(-1).event, 'daemon-stopped');
  assert.equal(instance.at(-1).trigger, 'control');
  assert.equal(
    instance.find((e) => e.event === 'workspace-released' && e.runId === runId).ok,
    true,
  );
});

// -- the record track on the story lane (ADR-0080) ---------------------------

const RECORD = 'docs/adr/adr-0001-double-the-input.md';

// The record the card decides. Every claim names a path the tree holds.
const RECORD_TEXT = [
  '# ADR-0001: Double the input',
  '',
  '**Status:** Accepted',
  '',
  '## Decision',
  '',
  'The module src/feature.mjs answers twice the number it is given.',
  '',
  '## Consequences',
  '',
  'The suite asserts the doubling on one value.',
  '',
].join('\n');

/** The project the record cases run against: one corrective round, no more. */
const ONE_ROUND =
  JSON.stringify(
    { ...PROJECT_CONFIG, gates: { ...PROJECT_CONFIG.gates, reconcileRounds: 1 } },
    null,
    2,
  ) + '\n';

/** The story run that reaches a close, with whatever the record keys add. */
async function shipStory(t, { prefix, scenario }) {
  const fx = buildFixture({
    prefix,
    scenario: { ...SCENARIO, ...scenario },
    tree: { '.olympus/project.json': ONE_ROUND },
  });
  t.after(() => cleanup(fx));
  await startDaemon(fx);
  ctl(fx, ['launch', '--project', PROJECT, '--card', CARD_PATH]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  await pollFor(
    'the open-decisions park',
    () => runEvents(fx, runId).some((e) => e.event === 'park' && e.type === 'open-decisions'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  ctl(fx, ['answer', '--run', runId, '--text', 'No; f trusts the value it is given.']);
  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).some((e) => e.event === 'run-closed'),
    { attempts: 1800, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  return { fx, events: runEvents(fx, runId) };
}

// A finding no round closes, on a lane that ships code beside the record. The
// run spends its one round, stalls loud and merges with the finding named. The
// code ships: a record blocks no run (ADR-0080).
test('a story run at its record cap ships the code with the finding named', async (t) => {
  const { fx, events } = await shipStory(t, {
    prefix: 'olympus-e2e-story-cap-',
    scenario: {
      bornRecords: { [RECORD]: RECORD_TEXT },
      reconcileJudge: {
        owed: false,
        records: [],
        reason: 'the record this run wrote states what the tree holds',
      },
      recordFindings: {
        [RECORD]: { summary: 'the record states a module the tree does not hold', reads: 9 },
      },
      confirmFindings: true,
    },
  });

  // The one park is the card's own decision; nothing else asked anybody.
  assert.deepEqual(events.filter((e) => e.event === 'park').map((e) => e.type), ['open-decisions']);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'shipped');
  // One round, then the stall and the fallback on this lane too.
  assert.equal(events.filter((e) => e.event === 'reconcile-round').length, 1);
  const stall = events.find((e) => e.event === 'reconcile-stall');
  assert.equal(stall.stream, 'loud');
  const written = events.filter((e) => e.event === 'reconciliation-written').at(-1);
  assert.equal(written.ok, false);
  assert.equal(written.cause, 'record-cap');
  // The finding rode the close stamp and the request body.
  assert.deepEqual(closed.remarks, stall.open);
  const create = forgeCalls(fx).find((c) => c.handled === 'pr-create');
  assert.match(create.body, /## Findings not answered/);
  // The code and the record both rode the merge.
  const tree = originTree(fx, 'main');
  assert.ok(tree.includes('src/feature.mjs'), 'the code did not ride the merge');
  assert.ok(tree.includes(RECORD), 'the record did not ride the merge');
  // No ticket: the round wrote the record, and the finding rides the close.
  assert.ok(!events.some((e) => e.event === 'reconciliation-judged' && e.ticket));
  assert.equal(seatCalls(fx).filter((c) => c.seat.endsWith('-verifier')).length, 0);

  await stopDaemon(fx);
});

// A birth that spends its ladder on a lane that ships code. The stage stamps the
// failure and the run goes on to its freeze; the judge names the record late,
// and the reconcile stage writes it before the request (ADR-0074, ADR-0080).
test('a story birth that spends its ladder ships, and the judge names the record late', async (t) => {
  const { fx, events } = await shipStory(t, {
    prefix: 'olympus-e2e-story-birth-',
    scenario: {
      birthInvalid: true,
      reconcileJudge: {
        owed: true,
        records: [RECORD],
        reason: 'the diff decides what no record states',
      },
      reconcileWrites: { [RECORD]: RECORD_TEXT },
    },
  });

  // The birth failed and stamped it; no park, and the run reached its freeze.
  const born = events.find((e) => e.event === 'records-committed');
  assert.equal(born.birthFailed, true);
  assert.equal(born.decided, false);
  assert.equal(born.cause, 'seat-failure');
  assert.deepEqual(events.filter((e) => e.event === 'park').map((e) => e.type), ['open-decisions']);
  assert.ok(born.seq < events.find((e) => e.event === 'freeze').seq);

  // The judge named the record late, and the stage wrote it before the request.
  const judged = events.find((e) => e.event === 'reconciliation-judged');
  assert.equal(judged.owed, true);
  assert.deepEqual(judged.records, [RECORD]);
  const write = events.find((e) => e.event === 'record-written');
  assert.equal(write.record, RECORD);
  assert.equal(write.failed, undefined);
  assert.ok(write.seq < events.find((e) => e.event === 'pr-opened').seq);

  // The run shipped, and the record rode the merge with the code.
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const tree = originTree(fx, 'main');
  assert.ok(tree.includes(RECORD), 'the record did not ride the merge');
  assert.ok(tree.includes('src/feature.mjs'), 'the code did not ride the merge');
  assert.ok(!events.some((e) => e.event === 'reconciliation-judged' && e.ticket));

  await stopDaemon(fx);
});

// A birth that needs a package the card does not name asks the owner once.
// The approve answer writes the dependency onto the card on the default
// branch, refreshes the run tree onto that head, and a fresh birth seat reads
// the amended card and writes the spec. The run then ships as any other.
test('a dependency the card does not name is approved onto the card and the story ships', async (t) => {
  const fx = buildFixture({
    prefix: 'olympus-e2e-dependency-',
    scenario: {
      ...SCENARIO,
      specDependencies: [{ importer: '.', name: 'left-pad', reason: 'AC-1 pads the answer' }],
      // A story that adds a dependency writes the importer's manifest, and the
      // spec lint holds the spec to declaring it.
      spec: SPEC.replace(
        'src/feature.mjs (new) — dev\n',
        'src/feature.mjs (new) — dev\npackage.json (new) — dev\n',
      ),
    },
    tree: { '.olympus/project.json': ONE_ROUND },
  });
  t.after(() => cleanup(fx));
  await startDaemon(fx);
  ctl(fx, ['launch', '--project', PROJECT, '--card', CARD_PATH]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  await pollFor(
    'the open-decisions park',
    () => runEvents(fx, runId).some((e) => e.event === 'park' && e.type === 'open-decisions'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  ctl(fx, ['answer', '--run', runId, '--text', 'No; f trusts the value it is given.']);
  await pollFor(
    'the dependency-decision park',
    () => runEvents(fx, runId).some((e) => e.event === 'park' && e.type === 'dependency-decision'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  ctl(fx, ['answer', '--run', runId, '--option', 'approve']);
  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).some((e) => e.event === 'run-closed'),
    { attempts: 1800, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  const events = runEvents(fx, runId);

  // The park was raised before any spec was born, and answered once.
  const park = events.find((e) => e.event === 'park' && e.type === 'dependency-decision');
  assert.ok(park.seq < events.find((e) => e.event === 'spec-born').seq);
  const amended = events.find((e) => e.event === 'card-amended');
  assert.equal(amended.card, CARD_PATH);
  assert.equal(amended.pushed, true);
  assert.deepEqual(
    amended.dependencies.map((d) => `${d.importer}: ${d.name}`),
    ['.: left-pad'],
  );
  const refreshed = events.find((e) => e.event === 'tree-refreshed' && e.seq > amended.seq);
  assert.ok(refreshed, 'the run tree was not refreshed onto the amended head');

  // The amendment is a commit on the default branch of the origin, and the
  // story shipped behind it.
  const card = originFile(fx, 'main', CARD_PATH);
  assert.ok(/^## Dependencies\s*$/m.test(card), 'the card on main carries no Dependencies section');
  assert.ok(card.includes('- .: left-pad'), 'the card on main does not name the package');
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');

  await stopDaemon(fx);
});

// A settings file the CLI refuses is ignored in print mode with nothing said
// about it, so a seat can run the whole battery while the harness believes it is
// bounded. The proof is the hook's own answer in the stream, and a seat that ran
// a command without one is a seat nobody bounded: the run parks rather than
// judge a tree on an unbounded pass.
test('a seat whose bound never loaded parks the run', async (t) => {
  const fx = buildFixture({
    prefix: 'olympus-e2e-story-unbound-',
    scenario: { ...SCENARIO, unboundSeat: 'dev' },
  });
  t.after(() => cleanup(fx));
  await startDaemon(fx);
  ctl(fx, ['launch', '--project', PROJECT, '--card', CARD_PATH]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  await pollFor(
    'the open-decisions park',
    () => runEvents(fx, runId).some((e) => e.event === 'park' && e.type === 'open-decisions'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  ctl(fx, ['answer', '--run', runId, '--text', 'No; f trusts the value it is given.']);

  const park = await pollFor(
    'the seat-failure park',
    () =>
      runEvents(fx, runId).find(
        (e) => e.event === 'park' && e.type === 'seat-failure' && e.cause === 'bound-not-loaded',
      ),
    // The park is what this waits for, so the abort watches the daemon and the
    // launch alone: a run-scoped abort reads this very park as a stall.
    { attempts: 600, abort: () => stalled(fx), diagnose: () => diagnostics(fx, runId) },
  );
  assert.match(park.question, /The dev seat failed \(bound-not-loaded\)/);
  const events = runEvents(fx, runId);
  // The seat was bounded at the spawn: the file was written and stamped, and
  // what failed is the load the CLI never reported.
  assert.ok(events.some((e) => e.event === 'seat-bound' && e.seat === 'dev'));
  assert.equal(
    events.filter((e) => e.event === 'seat-spawned' && e.seat === 'dev').length,
    1,
    'the run bought a second child on a settings file the CLI had already ignored',
  );
  // Nothing was judged on the pass: no verdict, and no commit of the seat work.
  assert.ok(!events.some((e) => e.event === 'implementation-committed'));
  assert.ok(!events.some((e) => e.event === 'verdict-rendered'));

  ctl(fx, ['kill', '--run', runId]);
  await pollFor('the run to close', () =>
    runEvents(fx, runId).find((e) => e.event === 'run-closed'),
  );
  await stopDaemon(fx);
});
