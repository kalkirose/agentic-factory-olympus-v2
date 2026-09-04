// Scenario 6: the spec gate has a progress rule and no round cap (ADR-0020).
//
// Two gates through the assembled binaries. One closes a finding every round
// and runs to its own pass at round five, with nobody asked for anything. One
// converges for two rounds and then closes nothing, and that is the single
// gate park: `spec-gate-stalled`, with both counts in the question.
//
// Neither scenario runs past the gate: what happens after a freeze is scenario
// 1's business, and a gate that has answered is what these came to read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_PATH,
  PROJECT,
  buildFixture,
  cleanup,
  ctl,
  diagnostics,
  instanceEvents,
  pollFor,
  runEvents,
  seatCalls,
  stalled,
  startDaemon,
  stopDaemon,
} from './fixture.mjs';

// The spec the birth seat writes, and rewrites at every amendment. It holds
// the template the lint checks, so every round is spent on the gate rather
// than on the document's shape.
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
src/feature.mjs (new) — dev
tests/feature.test.mjs (new) — suite
\`\`\`

## Components

- None.

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

/** The scenario every gate run shares, minus the rounds it is about. */
function gateScenario(gateRounds) {
  return {
    spec: SPEC,
    gateRounds,
    suiteFiles: { 'tests/feature.test.mjs': SUITE },
    suiteReds: [{ test: 'f doubles its input', class: 'feature-absence' }],
    adversaryFiles: { 'src/feature.mjs': 'export const f = (x) => x + x + 1;\n' },
    devFiles: { 'src/feature.mjs': 'export function f(x) {\n  return x * 2;\n}\n' },
  };
}

/** Launches the fixture card and answers the open decision it parks on. */
async function launchToGate(fx) {
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
  return runId;
}

function rounds(fx, runId) {
  return runEvents(fx, runId).filter((e) => e.event === 'spec-gate-round');
}

/** Ends the run this scenario has finished reading. */
async function endRun(fx, runId) {
  ctl(fx, ['kill', '--run', runId]);
  await pollFor('the run to close', () =>
    runEvents(fx, runId).find((e) => e.event === 'run-closed'),
  );
  await stopDaemon(fx);
}

test('a gate that closes a finding a round runs to its pass, and nobody is asked', async (t) => {
  // Four findings, one closed every round, none opened: the identity rule sees
  // progress every time and the count falls across every two rounds. Under the
  // cap this gate parked at round two and the owner bought the rest, fourteen
  // times in fifteen on the ledger this rule replaces.
  const fx = buildFixture({
    prefix: 'olympus-e2e-gate-pass-',
    scenario: gateScenario([
      ['ungrounded claim 1', 'ungrounded claim 2', 'ungrounded claim 3', 'ungrounded claim 4'],
      ['ungrounded claim 1', 'ungrounded claim 2', 'ungrounded claim 3'],
      ['ungrounded claim 1', 'ungrounded claim 2'],
      ['ungrounded claim 1'],
      [],
    ]),
  });
  t.after(() => cleanup(fx));
  await startDaemon(fx);
  const runId = await launchToGate(fx);

  await pollFor('the gate to pass', () => rounds(fx, runId).some((e) => e.verdict === 'pass'), {
    attempts: 900,
    abort: () => stalled(fx, runId),
    diagnose: () => diagnostics(fx, runId),
  });
  assert.deepEqual(
    rounds(fx, runId).map((e) => [e.round, e.verdict, e.findings]),
    [
      [1, 'findings', 4],
      [2, 'findings', 3],
      [3, 'findings', 2],
      [4, 'findings', 1],
      [5, 'pass', 0],
    ],
  );
  // The only park was the card's own open decision: no cap, no stall.
  assert.deepEqual(
    runEvents(fx, runId)
      .filter((e) => e.event === 'park')
      .map((e) => e.type),
    ['open-decisions'],
  );
  // Every round past the first was an amendment plus a re-check, and the
  // re-check carried the previous round's findings verbatim.
  const calls = seatCalls(fx);
  assert.equal(calls.filter((c) => c.seat === 'spec-gate').length, 5);
  assert.equal(calls.filter((c) => c.seat === 'spec-birth').length, 5);
  const fifth = calls.find((c) => c.reportPath.includes('spec-gate-5'));
  assert.ok(fifth.prompt.includes('This is a re-check, not a fresh review'));
  assert.ok(fifth.prompt.includes('ungrounded claim 1'));

  await endRun(fx, runId);
});

test('a gate that stops closing findings parks stalled, with both counts', async (t) => {
  // Three findings, one closed at round two, none at round three. The
  // identity rule is what stops it: the count is the same either way, and the
  // question says which round it is compared against.
  const fx = buildFixture({
    prefix: 'olympus-e2e-gate-stall-',
    scenario: gateScenario([
      ['ungrounded claim 1', 'ungrounded claim 2', 'ungrounded claim 3'],
      ['ungrounded claim 1', 'ungrounded claim 2'],
      ['ungrounded claim 1', 'ungrounded claim 2'],
    ]),
  });
  t.after(() => cleanup(fx));
  await startDaemon(fx);
  const runId = await launchToGate(fx);

  const park = await pollFor(
    'the stall park',
    () =>
      runEvents(fx, runId).find((e) => e.event === 'park' && e.type === 'spec-gate-stalled'),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  assert.deepEqual(park.answers.options, ['round', 'abandon']);
  assert.ok(park.question.includes('2 blocking findings against 2 in round 2'));
  assert.ok(park.question.includes('closed none of them'));
  assert.equal(rounds(fx, runId).length, 3);
  // The queue renders it with the forms it declared.
  const queue = ctl(fx, ['queue']);
  assert.match(queue, /spec-gate-stalled/);
  assert.match(queue, /options: round \| abandon/);

  await endRun(fx, runId);
});
