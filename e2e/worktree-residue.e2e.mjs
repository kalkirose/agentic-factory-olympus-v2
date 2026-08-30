// Scenario 4: a stage step crashes between creating its worktree and using
// it, and the retry is clean (ADR-0051).
//
// The crash is staged where it really happens. A seat that never answers holds
// the run still at the one moment that matters: the stage has created its
// worktree and nothing has read it. The daemon is then ended the way a crash
// ends it, with nothing stamped and everything left on disk.
//
// What the restart finds is the residue in its worst shape: the registration
// git holds, with the directory gone. That is what a removal git refused and
// the harness performed leaves behind (ADR-0004), and it is the shape a step
// that only looks for a directory cannot see. The claim of this scenario is
// that the retry creates the worktree anyway and the run carries on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
  adversaryFiles: { 'src/feature.mjs': 'export const f = (x) => x + x + 1;\n' },
  devFiles: { 'src/feature.mjs': 'export function f(x) {\n  return x * 2;\n}\n' },
  // The seat that holds the run still at the moment after the worktree of its
  // own stage was created.
  stallSeat: 'adversary',
};

const WAVE_TAG = 'adversary-r1-w1';

/** Every worktree path the project clone has a registration for. */
function registrations(fx) {
  const clone = join(fx.home, 'clones', `${PROJECT}.git`);
  return execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: clone,
    encoding: 'utf8',
    windowsHide: true,
  })
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim().replaceAll('\\', '/').toLowerCase());
}

test('a stage that crashed before it used its worktree retries clean', async (t) => {
  const fx = buildFixture({ prefix: 'olympus-e2e-residue-', scenario: SCENARIO });
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

  // The stall marker is written by the seat the stage spawns, and the stage
  // spawns it after it creates the worktree. So a marker on disk is the state
  // this scenario needs: the worktree exists and nothing has read it.
  const stallPid = Number(
    await pollFor(
      'the stage to reach its worktree and stall',
      () => existsSync(fx.stallMarker) && readFileSync(fx.stallMarker, 'utf8').trim(),
      { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
    ),
  );
  const waveTree = join(fx.home, 'worktrees', runId, WAVE_TAG);
  assert.ok(existsSync(waveTree), 'the stage did not create its worktree before the seat ran');
  assert.ok(
    registrations(fx).includes(waveTree.replaceAll('\\', '/').toLowerCase()),
    'git holds no registration for the wave worktree',
  );

  // The crash, and the seat it orphaned.
  await crashDaemon(fx);
  await endProcess(stallPid);

  // The half-cleared shape: the directory is gone the way a removal the
  // harness performed leaves it, and the registration git holds outlives it.
  rmSync(waveTree, { recursive: true, force: true, maxRetries: 5 });
  assert.equal(existsSync(waveTree), false);
  assert.ok(
    registrations(fx).includes(waveTree.replaceAll('\\', '/').toLowerCase()),
    'the registration went with the directory, so there is no residue to retry over',
  );

  // The retry: the seat answers this time.
  updateScenario(fx, { stallSeat: null });
  await startDaemon(fx);
  assert.ok(
    instanceEvents(fx).some((e) => e.event === 'daemon-crash-detected'),
    'the restart did not notice the crash',
  );

  const wave = await pollFor(
    'the wave the crashed stage owes',
    () => runEvents(fx, runId).find((e) => e.event === 'adversary-wave'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  assert.equal(wave.result, 'killed');
  await pollFor('the freeze', () => runEvents(fx, runId).some((e) => e.event === 'freeze'), {
    abort: () => stalled(fx, runId),
    diagnose: () => diagnostics(fx, runId),
  });

  // Nothing about the residue reached a person or a failure record.
  const events = runEvents(fx, runId);
  assert.deepEqual(
    events.filter((e) => e.event === 'park' && ['stage-blocked', 'command-error'].includes(e.type)),
    [],
    'the retry parked on its own residue',
  );
  assert.deepEqual(
    events.filter((e) => e.event === 'seat-failure').map((e) => e.seat),
    [],
    'a seat failed after the restart',
  );

  // The run has nothing left to prove here; the scenario ends it rather than
  // paying for a whole verdict and ship.
  ctl(fx, ['kill', '--run', runId]);
  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).some((e) => e.event === 'run-closed'),
    { diagnose: () => diagnostics(fx, runId) },
  );
  await pollFor(
    'the workspace release',
    () => instanceEvents(fx).some((e) => e.event === 'workspace-released' && e.runId === runId),
    { diagnose: () => diagnostics(fx, runId) },
  );
  await stopDaemon(fx);
});
