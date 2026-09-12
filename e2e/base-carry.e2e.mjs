// Scenario 12: a ship certifies the branch, and the next run carries it.
//
// The first cycle of a run proves nothing of its own. Before this it ran every
// Tier-1 layer of the project, whatever the run had changed, so a one-file
// repair paid for the whole battery. Now the ship's close-out records what stood
// green at the sha the default branch became, and the next run runs the
// footprint of its own diff against that record: the layers whose ground it
// touched, their dependents, and every setup layer. The rest carry.
//
// This file asserts the whole chain through the assembled binaries. One ship
// writes the certification; the next run reads it, runs three layers and carries
// one, and the carried layer's record names the tree its green was earned at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PROJECT,
  TICKET_PATH,
  buildFixture,
  cleanup,
  ctl,
  diagnostics,
  instanceEvents,
  pollFor,
  runEvents,
  stalled,
  startDaemon,
  stopDaemon,
  updateScenario,
} from './fixture.mjs';

const REGRESSION = `import test from 'node:test';
import assert from 'node:assert/strict';

test('greet answers hello', async () => {
  const { greet } = await import('../src/greeting.mjs');
  assert.equal(greet(), 'hello');
});
`;

// The second repair adds one test and touches no source file, which is what
// makes the footprint readable end to end: the layer that reads the sources
// alone has nothing in this diff to read.
const FACTOR_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';

test('the factor is two', async () => {
  const { FACTOR } = await import('../src/base.mjs');
  assert.equal(FACTOR, 2);
});
`;

const SECOND_TICKET_PATH = '.olympus/tickets/factor.md';
const SECOND_TICKET = `# Repair ticket: the factor is untested

## The defect

src/base.mjs exports FACTOR and no test asserts it.

## Scope

Add a regression test under tests/ and change no source file.
`;

const SCENARIO = {
  fixFiles: {
    'src/greeting.mjs': "export const greet = () => 'hello';\n",
    'tests/greeting.test.mjs': REGRESSION,
  },
};

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

/**
 * One commit on the default branch of the fixture origin, on top of whatever is
 * there. The seed tree is behind by one ship by the time this runs, so it takes
 * the branch as it stands before it adds to it.
 */
function pushToBranch(fx, path, content, message) {
  git(['fetch', '--quiet', fx.origin, 'main'], fx.seed);
  git(['reset', '--hard', '--quiet', 'FETCH_HEAD'], fx.seed);
  const full = join(fx.seed, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  git(['add', '-A'], fx.seed);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', message], fx.seed);
  git(['push', '--quiet', fx.origin, 'main'], fx.seed);
}

/** Launches one repair run on the named ticket and waits for it to close. */
async function ship(fx, ticket) {
  const before = instanceEvents(fx).filter((e) => e.event === 'launch').length;
  ctl(fx, ['launch', '--project', PROJECT, '--lane', 'repair', '--ticket', ticket]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).filter((e) => e.event === 'launch')[before]?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  await pollFor('the run to close', () => runEvents(fx, runId).find((e) => e.event === 'run-closed'), {
    attempts: 1800,
    abort: () => stalled(fx, runId),
    diagnose: () => diagnostics(fx, runId),
  });
  const events = runEvents(fx, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped', `run ${runId}`);
  return { runId, events };
}

test('a ship certifies the branch, and the run behind it carries what its diff never touched', async (t) => {
  const fx = buildFixture({ prefix: 'olympus-e2e-base-carry-', scenario: SCENARIO });
  t.after(() => cleanup(fx));
  await startDaemon(fx);

  // -- the first ship, which has nothing to carry ---------------------------
  const first = await ship(fx, TICKET_PATH);
  const firstRender = first.events.find((e) => e.event === 'verdict-rendered');
  assert.deepEqual(
    [firstRender.sweep, firstRender.reason],
    ['full', 'no-base-certification'],
    'the first run had a certification to carry',
  );
  const merged = first.events.find((e) => e.event === 'merged');
  const certified = instanceEvents(fx).filter((e) => e.event === 'base-certified');
  assert.equal(certified.length, 1);
  assert.equal(certified[0].project, PROJECT);
  assert.equal(certified[0].runId, first.runId);
  // The sha the default branch became, and every layer that stood green at it,
  // each naming the record it was decided in.
  assert.equal(certified[0].sha, merged.mergeSha);
  assert.deepEqual(
    certified[0].layers.map((row) => [row.name, row.status, row.mode, row.verdict]),
    [
      ['lint', 'green', 'run', 'verdict-1.json'],
      ['suite', 'green', 'run', 'verdict-1.json'],
      ['smoke', 'green', 'run', 'verdict-1.json'],
    ],
  );
  for (const row of certified[0].layers) {
    assert.ok(row.elapsedMs > 0, `${row.name} carries no duration`);
  }

  // -- the second ship, which carries one layer -----------------------------
  // A ticket for it on the default branch, and a repair that adds a test and
  // changes no source file.
  pushToBranch(fx, SECOND_TICKET_PATH, SECOND_TICKET, 'a ticket for the untested factor');
  updateScenario(fx, { fixFiles: { 'tests/base.test.mjs': FACTOR_TEST } });

  const second = await ship(fx, SECOND_TICKET_PATH);
  const render = second.events.find((e) => e.event === 'verdict-rendered');
  assert.equal(render.verdict, 'green');
  assert.equal(render.sweep, 'footprint');
  assert.equal(render.reason, undefined);
  // The suite reads the tests, so it ran; the smoke layer is the project's setup
  // layer and runs whatever the diff says; the lint layer reads the sources
  // alone, and this diff holds none, so it carried.
  // A layer that ran stamps no mode: the stamp is a result of an execution, and
  // only a carry has to say that it was not one.
  const results = second.events.filter((e) => e.event === 'layer-result' && e.cycle === 1);
  assert.deepEqual(
    results.map((e) => [e.layer, e.status, e.mode ?? 'run']),
    [
      ['lint', 'green', 'carried'],
      ['suite', 'green', 'run'],
      ['smoke', 'green', 'run'],
    ],
  );
  const carried = results.find((e) => e.layer === 'lint');
  assert.equal(carried.carriedFrom, 'base');
  assert.equal(carried.baseSha, merged.mergeSha);
  assert.equal(carried.certifiedSeq, certified[0].seq);
  // A carry spent no wall clock, so it measures none, and its command never ran.
  assert.equal(carried.elapsedMs, undefined);
  assert.ok(!second.events.some((e) => e.event === 'layer-started' && e.layer === 'lint'));
  // And the second ship certifies the branch it moved in its turn, with the
  // carried layer recorded as carried.
  const again = instanceEvents(fx).filter((e) => e.event === 'base-certified');
  assert.equal(again.length, 2);
  assert.deepEqual(
    again[1].layers.map((row) => [row.name, row.mode, row.elapsedMs === null]),
    [
      ['lint', 'carried', true],
      ['suite', 'run', false],
      ['smoke', 'run', false],
    ],
  );

  await stopDaemon(fx);
});
