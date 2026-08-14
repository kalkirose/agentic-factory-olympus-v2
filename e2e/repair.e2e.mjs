// Scenario 2: a ticketed defect is repaired and shipped. The repair lane has
// no spec birth, no adversary and no card sweep; the intake ticket the console
// hands over is the lane's spec, and the console binary is the only thing that
// can hand it over. The run walks fix, verdict and ship against the same real
// git remote and the same real gate commands as the story scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT,
  TICKET_PATH,
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
  pollFor,
  runEvents,
  seatCalls,
  stalled,
  startDaemon,
  stopDaemon,
} from './fixture.mjs';

const REGRESSION = `import test from 'node:test';
import assert from 'node:assert/strict';

test('greet answers hello', async () => {
  const { greet } = await import('../src/greeting.mjs');
  assert.equal(greet(), 'hello');
});
`;

const SCENARIO = {
  fixFiles: {
    'src/greeting.mjs': "export const greet = () => 'hello';\n",
    'tests/greeting.test.mjs': REGRESSION,
  },
};

test('the repair lane ships a ticketed fix through the assembled binaries', async (t) => {
  const fx = buildFixture({ prefix: 'olympus-e2e-repair-', scenario: SCENARIO });
  t.after(() => cleanup(fx));

  await startDaemon(fx);

  // The ticket is the lane's spec, so the console settles the pairing before
  // anything is provisioned.
  const refused = ctlRefused(fx, ['launch', '--project', PROJECT, '--lane', 'repair']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--lane repair requires --ticket/);

  ctl(fx, ['launch', '--project', PROJECT, '--lane', 'repair', '--ticket', TICKET_PATH]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  assertStatusRenders(assert, ctl(fx, ['status']));

  await pollFor(
    'the green verdict',
    () =>
      runEvents(fx, runId).some((e) => e.event === 'verdict-rendered' && e.verdict === 'green'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  assertStatusRenders(assert, ctl(fx, ['status']));

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
    'seat-report',
    'implementation-committed',
    'layer-result',
    'verdict-rendered',
    'pr-opened',
    'check-transition',
    'merged',
    'merge-commit-check',
    'run-closed',
  ]);

  const launched = events.find((e) => e.event === 'run-launched');
  assert.equal(launched.lane, 'repair');
  assert.equal(launched.ticket, TICKET_PATH, 'the console did not pass the ticket through');
  assert.equal(events.find((e) => e.event === 'stage-entered').stage, 'fix');

  // The repair lane runs the deterministic gates in full and collapses
  // judgment to one review seat.
  const layers = events.filter((e) => e.event === 'layer-result');
  assert.deepEqual(
    layers.map((e) => [e.layer, e.status, e.cycle]),
    [
      ['lint', 'green', 1],
      ['suite', 'green', 1],
      ['smoke', 'green', 1],
    ],
  );
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.equal(renders.length, 1);
  assert.deepEqual([renders[0].verdict, renders[0].sweep], ['green', 'full']);
  assert.deepEqual(
    events.filter((e) => e.event === 'finding'),
    [],
  );

  // The repair lane runs the same command table, without the card lint the
  // story lane's readiness owns.
  assert.deepEqual(gateMarks(fx), ['lint', 'suite', 'smoke']);

  const seats = seatCalls(fx);
  for (const call of seats) assertSeatArgv(assert, call);
  assert.deepEqual(
    seats.map((c) => c.seat),
    ['dev', 'generalist-review'],
    'the repair lane spawned seats it does not owe',
  );
  assert.ok(
    seats[0].prompt.includes('Fix the defect described by the intake ticket'),
    'the fix seat was briefed as a story implementation',
  );

  const merged = events.find((e) => e.event === 'merged');
  assert.equal(merged.red, false);
  assert.equal(originSha(fx, 'refs/heads/main'), merged.mergeSha);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'shipped');
  assert.deepEqual(
    events.filter((e) => e.event === 'card-sweep'),
    [],
    'the repair lane swept cards it does not own',
  );

  const handled = forgeCalls(fx).map((c) => c.handled);
  assert.ok(!handled.includes('unknown'), `the ship step made an unhandled forge call: ${handled}`);
  assert.ok(handled.includes('pr-state-merged'));

  await stopDaemon(fx);
  assert.equal(fx.daemon.exitCode, 0, 'the daemon did not exit cleanly');
  assert.equal(instanceEvents(fx).at(-1).event, 'daemon-stopped');
});
