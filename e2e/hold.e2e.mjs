// Scenario 3: the operator hold, through the assembled binaries. A maintainer
// asks for a moment with no live seat: the console holds the project, the run
// in flight finishes the stage it is in and stops at the boundary, the daemon
// stops with nothing to terminate, the next instance comes back still held,
// and the release enters the stage the run did not enter. Nothing here imports
// the engine — what is under test is that the console command reaches the stage
// chain at all, and that the hold outlives the process that took it (ADR-0040).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT,
  TICKET_PATH,
  assertStatusRenders,
  buildFixture,
  cleanup,
  ctl,
  ctlRefused,
  diagnostics,
  instanceEvents,
  pollFor,
  runEvents,
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

test('an operator hold stops the stage chain and survives a restart', async (t) => {
  const fx = buildFixture({ prefix: 'olympus-e2e-hold-', scenario: SCENARIO });
  t.after(() => cleanup(fx));

  await startDaemon(fx);

  // A scope is settled at the console, before anything reaches the inbox.
  const refused = ctlRefused(fx, ['hold']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /hold takes --run <id>, --project <name> or --all/);
  const both = ctlRefused(fx, ['hold', '--project', PROJECT, '--all']);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /--all holds the instance; drop --project/);

  ctl(fx, ['hold', '--project', PROJECT]);
  const change = await pollFor(
    'the hold stamp',
    () => instanceEvents(fx).find((e) => e.event === 'hold-changed'),
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  assert.equal(change.held, true);
  assert.equal(change.project, PROJECT);
  assert.match(ctl(fx, ['status']), new RegExp(`${PROJECT}: paused, held, slot cap 1`));

  // A launch still launches: a pause governs entry, and a hold governs
  // progression. The fix stage runs its seat and the chain stops behind it.
  ctl(fx, ['launch', '--project', PROJECT, '--lane', 'repair', '--ticket', TICKET_PATH]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  const held = await pollFor(
    'the run to reach a boundary and hold',
    () => runEvents(fx, runId).find((e) => e.event === 'stage-held'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  assert.equal(held.stage, 'fix');
  assert.equal(held.next, 'verdict');
  const beforeStop = runEvents(fx, runId);
  assert.ok(
    !beforeStop.some((e) => e.event === 'stage-entered' && e.stage === 'verdict'),
    'the run entered the stage the hold deferred',
  );
  const status = ctl(fx, ['status']);
  assertStatusRenders(assert, status);
  assert.match(status, /runs 0 active \/ 0 parked \/ 1 held/);
  assert.match(status, new RegExp(`${runId} repair @ fix .*\\[held:verdict\\]`));

  // The stop the hold was taken for: no seat is in flight, so the stop ends
  // none and the run loses nothing it earned.
  await stopDaemon(fx);
  const afterStop = runEvents(fx, runId);
  assert.deepEqual(
    afterStop.filter((e) => e.event === 'seat-terminated').map((e) => e.seat),
    [],
    'the stop cut a seat off',
  );
  assert.deepEqual(
    afterStop.filter((e) => e.event === 'seat-failure').map((e) => e.seat),
    [],
    'a seat failed at the stop',
  );
  assert.equal(afterStop.at(-1).event, 'stage-held');

  // The next instance reads the hold off the ledger and comes back holding it.
  await startDaemon(fx);
  const resumed = instanceEvents(fx).filter((e) => e.event === 'daemon-started').at(-1);
  assert.deepEqual(resumed.runsResumed, [runId]);
  assert.equal(
    runEvents(fx, runId).length,
    afterStop.length,
    'the resumed run wrote something while the hold still stood',
  );
  assert.match(ctl(fx, ['status']), new RegExp(`${runId} repair @ fix .*\\[held:verdict\\]`));

  ctl(fx, ['release', '--project', PROJECT]);
  await pollFor(
    'the deferred stage to be entered',
    () => runEvents(fx, runId).some((e) => e.event === 'stage-entered' && e.stage === 'verdict'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  const events = runEvents(fx, runId);
  assert.equal(events.filter((e) => e.event === 'stage-released').length, 1);
  assert.equal(events.filter((e) => e.event === 'stage-entered' && e.stage === 'verdict').length, 1);
  assert.equal(
    instanceEvents(fx).filter((e) => e.event === 'hold-changed').at(-1).held,
    false,
  );

  // The run is under way again; it has nothing left to prove here, and the
  // scenario ends it rather than paying for a whole verdict and ship.
  ctl(fx, ['kill', '--run', runId]);
  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).some((e) => e.event === 'run-closed'),
    { diagnose: () => diagnostics(fx, runId) },
  );
  await stopDaemon(fx);
});
