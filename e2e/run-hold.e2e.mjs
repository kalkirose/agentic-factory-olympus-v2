// Scenario 8: the hold over one run, through the assembled binaries. An
// operator wants to stagger a queue: several runs are standing at the same
// boundary, and releasing the project would send all of them on at once. So
// each run is held by name, the project hold is lifted, and the runs are let
// out one at a time. Nothing here imports the engine. What is under test is
// that the third scope reaches the stage chain from the console, that a project
// release leaves a run held by name held, and that the release order is the
// operator's and not the queue's (ADR-0057).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROJECT,
  TICKET_PATH,
  buildFixture,
  cleanup,
  ctl,
  ctlRefused,
  diagnostics,
  instanceEvents,
  pollFor,
  rejectedControlFiles,
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

/** Whether this run has entered the stage its hold deferred. */
function entered(fx, runId) {
  return runEvents(fx, runId).some((e) => e.event === 'stage-entered' && e.stage === 'verdict');
}

/** Launches one repair run and waits for it to stop at its first boundary. */
async function heldRun(fx, seen) {
  ctl(fx, ['launch', '--project', PROJECT, '--lane', 'repair', '--ticket', TICKET_PATH]);
  const runId = await pollFor(
    'a launch stamp',
    () =>
      instanceEvents(fx)
        .filter((e) => e.event === 'launch')
        .map((e) => e.runId)
        .find((id) => !seen.has(id)),
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  seen.add(runId);
  await pollFor(
    `run ${runId} to reach a boundary and hold`,
    () => runEvents(fx, runId).find((e) => e.event === 'stage-held'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  return runId;
}

/** Ends a run the scenario has finished with, and waits for the close. */
async function killRun(fx, runId) {
  ctl(fx, ['kill', '--run', runId]);
  await pollFor(
    `run ${runId} to close`,
    () => runEvents(fx, runId).some((e) => e.event === 'run-closed'),
    { diagnose: () => diagnostics(fx, runId) },
  );
}

/** The refusal texts the daemon has written for rejected console commands. */
function refusals(fx) {
  return rejectedControlFiles(fx)
    .filter((name) => name.endsWith('.reason.txt'))
    .map((name) => readFileSync(join(fx.home, 'control', 'rejected', name), 'utf8'));
}

test('runs held one at a time are released one at a time, in either order', async (t) => {
  // Two slots, because the whole scenario is about two runs standing side by
  // side at the same boundary.
  const fx = buildFixture({ prefix: 'olympus-e2e-run-hold-', scenario: SCENARIO, slotCap: 2 });
  t.after(() => cleanup(fx));

  await startDaemon(fx);

  // A scope is settled at the console, before anything reaches the inbox.
  const mixed = ctlRefused(fx, ['hold', '--run', 'r1', '--project', PROJECT]);
  assert.equal(mixed.status, 2);
  assert.match(mixed.stderr, /--run holds one run; drop --project and --all/);

  // Both runs launch into a project hold, so both reach the same boundary and
  // neither one races the other there.
  const seen = new Set();
  ctl(fx, ['hold', '--project', PROJECT]);
  await pollFor(
    'the project hold',
    () => instanceEvents(fx).some((e) => e.event === 'hold-changed' && e.held === true),
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  const first = await heldRun(fx, seen);
  const second = await heldRun(fx, seen);

  // The refusal: the project hold is what is stopping this run, and the
  // message says so rather than letting a release look like a release.
  ctl(fx, ['release', '--run', first]);
  const refusal = await pollFor(
    'the refusal',
    () => refusals(fx).find((text) => text.includes(first)),
    { diagnose: () => diagnostics(fx, first) },
  );
  assert.match(refusal, new RegExp(`release --project ${PROJECT} before this run`));

  // Each run takes a hold of its own, and the project hold is then lifted.
  // Nothing moves: the project release ended the project's statement only.
  for (const runId of [first, second]) {
    ctl(fx, ['hold', '--run', runId]);
    const stamp = await pollFor(
      `the hold stamp on ${runId}`,
      () => runEvents(fx, runId).find((e) => e.event === 'run-hold-changed'),
      { diagnose: () => diagnostics(fx, runId) },
    );
    assert.equal(stamp.held, true);
    assert.match(ctl(fx, ['status']), new RegExp(`${runId} repair @ fix .*\\[held:verdict by `));
  }
  ctl(fx, ['release', '--project', PROJECT]);
  await pollFor(
    'the project release',
    () => instanceEvents(fx).some((e) => e.event === 'hold-changed' && e.held === false),
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );

  // The later of the two goes first: the order is the operator's.
  ctl(fx, ['release', '--run', second]);
  await pollFor(`${second} to enter the stage it did not enter`, () => entered(fx, second), {
    abort: () => stalled(fx, second),
    diagnose: () => diagnostics(fx, second),
  });
  assert.equal(entered(fx, first), false, 'the run nobody released moved');
  assert.equal(runEvents(fx, first).filter((e) => e.event === 'stage-released').length, 0);

  // The run that moved has nothing left to prove here; the scenario ends it
  // rather than paying for a whole verdict and ship.
  await killRun(fx, second);

  // The same pair shape again, with the release order the other way round: the
  // earlier of the two held runs goes first this time.
  ctl(fx, ['hold', '--project', PROJECT]);
  await pollFor(
    'the second project hold',
    () => instanceEvents(fx).filter((e) => e.event === 'hold-changed').at(-1).held === true,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  const third = await heldRun(fx, seen);
  ctl(fx, ['hold', '--run', third]);
  await pollFor(
    `the hold stamp on ${third}`,
    () => runEvents(fx, third).some((e) => e.event === 'run-hold-changed'),
    { diagnose: () => diagnostics(fx, third) },
  );
  ctl(fx, ['release', '--project', PROJECT]);
  await pollFor(
    'the second project release',
    () => instanceEvents(fx).filter((e) => e.event === 'hold-changed').at(-1).held === false,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  assert.equal(entered(fx, first), false, 'a project release freed a run held by name');
  assert.equal(entered(fx, third), false, 'a project release freed a run held by name');

  ctl(fx, ['release', '--run', first]);
  await pollFor(`${first} to enter the stage it did not enter`, () => entered(fx, first), {
    abort: () => stalled(fx, first),
    diagnose: () => diagnostics(fx, first),
  });
  assert.equal(entered(fx, third), false, 'the run nobody released moved');

  ctl(fx, ['release', '--run', third]);
  await pollFor(`${third} to enter the stage it did not enter`, () => entered(fx, third), {
    abort: () => stalled(fx, third),
    diagnose: () => diagnostics(fx, third),
  });

  await killRun(fx, first);
  await killRun(fx, third);
  await stopDaemon(fx);
});
