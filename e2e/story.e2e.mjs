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
  originSha,
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
// exactly one touched-paths block, an environment section.
const SPEC = `# alpha-1 spec

Base sha: the launch base. Scope exclusions: none beyond the card boundary.

## AC-1

f(x) answers twice the number it is given. The suite asserts it on one value.

Test mapping:
- tests/feature.test.mjs — f(2) is 4

Named constants:
- FACTOR = 2

Supersedes:
- None

## Touched paths

\`\`\`touched-paths
src/feature.mjs — dev
tests/feature.test.mjs — suite
\`\`\`

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

const SCENARIO = {
  spec: SPEC,
  suiteFiles: { 'tests/feature.test.mjs': SUITE },
  suiteReds: [{ test: 'f doubles its input', class: 'feature-absence' }],
  // A wrong implementation the frozen suite kills: the wave is a kill.
  adversaryFiles: { 'src/feature.mjs': 'export const f = (x) => x + x + 1;\n' },
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
    'adversary-wave',
    'red-state-check',
    'freeze',
    'implementation-committed',
    'layer-result',
    'finding',
    'verdict-rendered',
    'repair-round',
    'verdict-rendered',
    'pr-opened',
    'check-transition',
    'merged',
    'merge-commit-check',
    'card-sweep',
    'reconciliation-judged',
    'run-closed',
  ]);

  // -- pre-freeze ------------------------------------------------------------
  const gate = events.filter((e) => e.event === 'spec-gate-round');
  assert.deepEqual(
    gate.map((e) => [e.round, e.verdict, e.findings]),
    [[1, 'pass', 0]],
    'the spec gate did not pass in one clean round',
  );
  const waves = events.filter((e) => e.event === 'adversary-wave');
  assert.equal(waves.length, 1);
  assert.ok(
    waves.every((w) => w.phase === 'initial' && w.result === 'killed'),
    'the frozen suite did not kill every wave',
  );
  assert.equal(events.find((e) => e.event === 'red-state-check').result, 'red');
  const freeze = events.find((e) => e.event === 'freeze');
  assert.equal(freeze.killCount, 1);
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
    ],
    'the targeted cycle and its confirmation sweep did not run the layers they owe',
  );
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.equal(renders.length, 2);
  assert.deepEqual(
    [renders[0].verdict, renders[0].sweep],
    ['red', 'full'],
  );
  assert.deepEqual(
    [renders[1].verdict, renders[1].sweep, renders[1].confirmation],
    ['green', 'targeted', true],
  );
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
  // The adversary wave, the red-state check, the first cycle with its flake
  // re-run, the targeted cycle: the suite command is the busiest of them.
  assert.ok(
    marks.filter((m) => m === 'suite').length >= 4,
    `the suite command ran ${marks.filter((m) => m === 'suite').length} times`,
  );

  // -- what the run spent, and what its seats were handed -------------------
  assert.ok(runCost(events) > 0, 'no cost reached the ledger from the seat stream');
  const calls = seatCalls(fx);
  for (const call of calls) assertSeatArgv(assert, call);
  const seats = calls.map((c) => c.seat);
  for (const seat of [
    'spec-birth',
    'spec-gate',
    'suite',
    'adversary',
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
  const operational = calls.find((c) => c.seat === 'fury-operational').prompt;
  assert.ok(operational.includes('- security: authorization on every entry point'));
  // The adversary waves carry the same dimensions into the suite.
  const adversary = calls.find((c) => c.seat === 'adversary').prompt;
  assert.ok(adversary.includes('- authorization on every entry point'));
  assert.ok(adversary.includes('- trust boundaries'));

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
