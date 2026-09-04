// Scenario 7: the daemon goes down in the middle of the verdict stage, three
// times, and comes back to a run that owes a step rather than a judgment
// (ADR-0070).
//
// Every stop here is the operator's own `olympusd stop`, which is the shape the
// incident had: a restart taken deliberately, with a seat in flight. What the
// stop leaves is a tree with no implementation of the step that was running on
// it, and the claim of this scenario is that the next instance dispatches that
// step again before it judges anything.
//
// The hold is the same question at the other end: a hold that stands while the
// daemon is down has to govern the entry the start makes, or the restart is the
// one boundary an operator hold does not cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import {
  CARD_PATH,
  PROJECT,
  buildFixture,
  cleanup,
  crashDaemon,
  ctl,
  diagnostics,
  endProcess,
  instanceEvents,
  pollFor,
  runEvents,
  stalled,
  startDaemon,
  stopDaemon,
  updateScenario,
} from './fixture.mjs';

const SPEC = `# alpha-1 spec

Base sha: the launch base. Scope exclusions: none beyond the card boundary.

## AC-1

f(x) answers twice the number it is given. The suite asserts it on one value.

Test mapping:
- tests/feature.test.mjs - f(2) is 4

Named constants:
- FACTOR = 2

Supersedes:
- None

## Touched paths

\`\`\`touched-paths
src/feature.mjs (new) - dev
tests/feature.test.mjs (new) - suite
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

const RIGHT = 'export function f(x) {\n  return x * 2;\n}\n';

const SCENARIO = {
  spec: SPEC,
  suiteFiles: { 'tests/feature.test.mjs': SUITE },
  suiteReds: [{ test: 'f doubles its input', class: 'feature-absence' }],
  adversaryFiles: { 'src/feature.mjs': 'export const f = (x) => x + x + 1;\n' },
  // The first pass is off by one, and the repair round that follows it moves
  // the answer without fixing it: the render behind the round closes nothing,
  // which is what buys the fresh pass.
  devFiles: { 'src/feature.mjs': 'export function f(x) {\n  return x * 2 + 1;\n}\n' },
  repairFiles: { 'src/feature.mjs': 'export function f(x) {\n  return x * 2 + 2;\n}\n' },
  // The repair seat holds the run still inside the step, so the stop lands
  // where the incident landed.
  stallSeat: 'repair-dev',
};

/** The seq of the newest event of a kind, or 0. */
function lastSeq(events, kind) {
  return [...events].reverse().find((e) => e.event === kind)?.seq ?? 0;
}

/** The events of one kind after a seq. */
function after(events, seq, kind) {
  return events.filter((e) => e.seq > seq && e.event === kind);
}

/** The pid of the seat that is standing still, once it says so. */
async function stalledSeat(fx, runId) {
  rmSyncQuiet(fx.stallMarker);
  return Number(
    await pollFor(
      'the seat to stall',
      () => existsSync(fx.stallMarker) && readFileSync(fx.stallMarker, 'utf8').trim(),
      { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
    ),
  );
}

function rmSyncQuiet(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // The marker is written by a process this suite does not own; a file that
    // will not go is not a failure of the scenario.
  }
}

test('a restart inside the verdict stage finishes the step, and a hold governs the start', async (t) => {
  const fx = buildFixture({ prefix: 'olympus-e2e-restart-', scenario: SCENARIO });
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

  // -- a stop inside the layers, under a hold -------------------------------
  // The implementation is committed and the spectrum is running: what the stop
  // interrupts is a judgment, and a judgment is what the resume owes.
  await pollFor(
    'the first layer of the first cycle',
    () => runEvents(fx, runId).some((e) => e.event === 'layer-started'),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  const committed = runEvents(fx, runId).find((e) => e.event === 'implementation-committed');
  assert.ok(committed, 'the layers ran before the implementation was committed');
  ctl(fx, ['hold', '--all']);
  await pollFor(
    'the hold stamp',
    () => instanceEvents(fx).some((e) => e.event === 'hold-changed' && e.held === true),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  await stopDaemon(fx);
  const stopped = runEvents(fx, runId);
  assert.ok(
    !stopped.some((e) => e.event === 'verdict-rendered'),
    'the cycle finished before the stop; the scenario stopped between steps',
  );

  // The start under the hold: the run comes back standing where it stood, and
  // it spends nothing until a person releases it.
  await startDaemon(fx);
  const held = await pollFor(
    'the hold the start took',
    () => runEvents(fx, runId).find((e) => e.event === 'stage-held' && e.resumed === true),
    { attempts: 900, diagnose: () => diagnostics(fx, runId) },
  );
  assert.equal(held.stage, 'verdict');
  assert.equal(held.next, 'verdict');
  assert.match(ctl(fx, ['status']), new RegExp(`${runId} story @ verdict .*\\[held:verdict\\]`));
  assert.deepEqual(
    after(runEvents(fx, runId), held.seq, 'layer-started'),
    [],
    'the start under a hold ran a layer',
  );
  assert.deepEqual(
    after(runEvents(fx, runId), held.seq, 'seat-spawned'),
    [],
    'the start under a hold spawned a seat',
  );

  // The release runs the stage the hold stopped, and the stage owes its layers:
  // the seat before them answered, so there is no step to finish.
  ctl(fx, ['release', '--all']);
  const released = await pollFor(
    'the release stamp',
    () => runEvents(fx, runId).find((e) => e.event === 'stage-released'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  await pollFor(
    'the layers the released stage owes',
    () => after(runEvents(fx, runId), released.seq, 'layer-started').length > 0,
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );

  // -- a stop inside the repair seat ----------------------------------------
  const repairPid = await stalledSeat(fx, runId);
  const beforeRepairStop = runEvents(fx, runId);
  assert.ok(
    beforeRepairStop.some((e) => e.event === 'verdict-rendered' && e.verdict === 'red'),
    'the repair seat ran with no red verdict behind it',
  );
  await stopDaemon(fx);
  await endProcess(repairPid);
  const terminated = runEvents(fx, runId).filter(
    (e) => e.event === 'seat-terminated' && e.reason === 'daemon-stopped',
  );
  assert.deepEqual(
    terminated.map((e) => e.seat),
    ['repair-dev'],
    'the stop did not end the repair seat',
  );

  // The next instance re-dispatches the seat, and judges nothing first.
  updateScenario(fx, { stallSeat: 'dev' });
  await startDaemon(fx);
  const repairEntry = await pollFor(
    'the resumed verdict stage',
    () =>
      runEvents(fx, runId).find(
        (e) => e.event === 'stage-entered' && e.stage === 'verdict' && e.resumed === true,
      ),
    { attempts: 900, diagnose: () => diagnostics(fx, runId) },
  );
  await pollFor(
    'the repair seat, dispatched again',
    () =>
      after(runEvents(fx, runId), repairEntry.seq, 'seat-spawned').some(
        (e) => e.seat === 'repair-dev',
      ),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  const resumedRepair = runEvents(fx, runId);
  const repairSpawn = after(resumedRepair, repairEntry.seq, 'seat-spawned').find(
    (e) => e.seat === 'repair-dev',
  );
  assert.deepEqual(
    resumedRepair
      .filter((e) => e.seq > repairEntry.seq && e.seq < repairSpawn.seq && e.event === 'layer-started')
      .map((e) => e.layer),
    [],
    'the resumed stage judged a tree the interrupted repair never touched',
  );

  // -- a crash between the fresh pass and its dev report ---------------------
  // The repair round closed nothing, so the run stalls and the stall buys the
  // one fresh pass. This ending is a crash rather than a stop: nothing is
  // stamped, no seat is terminated, and what the ledger holds is a dev seat
  // that was spawned and never answered.
  const devPid = await stalledSeat(fx, runId);
  const beforeDevStop = runEvents(fx, runId);
  const fresh = beforeDevStop.find((e) => e.event === 'fresh-pass');
  assert.ok(fresh, 'the run reached the dev seat without a fresh pass');
  assert.equal(beforeDevStop.find((e) => e.event === 'stall').reason, 'no-progress');
  assert.ok(
    !beforeDevStop.some((e) => e.event === 'implementation-committed' && e.seq > fresh.seq),
    'the pass was implemented before the stop',
  );
  const cutSeat = [...beforeDevStop]
    .reverse()
    .find((e) => e.event === 'seat-spawned' && e.seat === 'dev');
  await crashDaemon(fx);
  await endProcess(devPid);
  assert.deepEqual(
    runEvents(fx, runId)
      .filter((e) => e.seq > cutSeat.seq && e.event === 'seat-terminated')
      .map((e) => e.seat),
    [],
    'the crash stamped an ending for the seat it took',
  );

  updateScenario(fx, { stallSeat: null, devFiles: { 'src/feature.mjs': RIGHT } });
  await startDaemon(fx);
  const devEntry = await pollFor(
    'the resumed verdict stage',
    () =>
      [...runEvents(fx, runId)]
        .reverse()
        .find((e) => e.event === 'stage-entered' && e.stage === 'verdict' && e.resumed === true),
    { attempts: 900, diagnose: () => diagnostics(fx, runId) },
  );
  await pollFor(
    'the dev seat of the fresh pass, dispatched again',
    () =>
      after(runEvents(fx, runId), devEntry.seq, 'seat-spawned').some((e) => e.seat === 'dev'),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  const resumedDev = runEvents(fx, runId);
  const devSpawn = after(resumedDev, devEntry.seq, 'seat-spawned').find((e) => e.seat === 'dev');
  assert.deepEqual(
    resumedDev
      .filter((e) => e.seq > devEntry.seq && e.seq < devSpawn.seq && e.event === 'layer-started')
      .map((e) => e.layer),
    [],
    'the resumed stage ran a layer over a pass with no implementation on it',
  );
  // One pass, born once, whatever the stop cost.
  assert.equal(resumedDev.filter((e) => e.event === 'fresh-pass').length, 1);

  // The pass the restart finished is the pass that judges next: the run has
  // nothing left to prove here, and the scenario ends it rather than paying
  // for a whole verdict and ship.
  await pollFor(
    'the implementation of the fresh pass',
    () =>
      runEvents(fx, runId).some(
        (e) => e.event === 'implementation-committed' && e.phase === 'fresh',
      ),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  const events = runEvents(fx, runId);
  assert.ok(
    lastSeq(events, 'fresh-pass') < lastSeq(events, 'implementation-committed'),
    'the implementation of the fresh pass is not the newest of the two stamps',
  );
  // Three stops inside three steps, and not one of them cost a person a
  // question: every seat the stop ended is a seat the next instance ran again.
  assert.deepEqual(
    events.filter((e) => e.event === 'seat-failure').map((e) => [e.seat, e.reason]),
    [],
    'a seat the stop ended reached a park',
  );
  assert.deepEqual(
    events.filter((e) => e.event === 'liveness-violation'),
    [],
    'the run went inert across a restart',
  );

  ctl(fx, ['kill', '--run', runId]);
  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).some((e) => e.event === 'run-closed'),
    { diagnose: () => diagnostics(fx, runId) },
  );
  await stopDaemon(fx);
});
