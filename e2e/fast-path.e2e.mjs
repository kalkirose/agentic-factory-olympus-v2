// Scenario 6: a ship carries the certification it already earned (ADR-0056).
//
// The default branch moves while the run works, on ground no suite of the
// certified verdict declares. Before this scenario's flag existed, that merge
// cost the run a second full certification and cost every run behind it in the
// ship queue the whole of that wait. Here the run merges the branch, proves
// mechanically that the two sides cannot interact, and opens its request on
// the certification it holds.
//
// The claim has three halves and this file asserts all three through the
// assembled binaries: the fast path fires and says exactly what it examined;
// the run reaches the merge with one green verdict and no second one; and the
// escape kind that measures the trade works end to end, up to the tripwire
// that proposes turning the flag back off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CARD_PATH,
  PROJECT,
  PROJECT_CONFIG,
  buildFixture,
  cleanup,
  ctl,
  diagnostics,
  escapeEvents,
  instanceEvents,
  originTree,
  pollFor,
  runEvents,
  stalled,
  startDaemon,
  stopDaemon,
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
  // Right first time: the certification this run carries is earned in one
  // cycle, so a second render in the ledger can only be the re-verdict this
  // scenario says nothing takes.
  devFiles: { 'src/feature.mjs': 'export function f(x) {\n  return x * 2;\n}\n' },
};

// The three gate layers, each saying what it depends on in the marker protocol
// the harness already reads (ADR-0046). Undeclared, every one of them refuses
// the fast path, which is the default the flag is turned on against.
const DECLARE = (name, inputs) =>
  `console.log('::olympus part ${name}');\nconsole.log('::olympus part-inputs ${inputs}');\n`;

const LINT_GATE = `import { readdirSync } from 'node:fs';
import { mark } from './mark.mjs';

mark('lint');
${DECLARE('sources', 'src')}
const files = readdirSync('src').filter((name) => name.endsWith('.mjs'));
console.log(\`lint: \${files.length} source file(s)\`);
`;

const SUITE_GATE = `import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mark } from './mark.mjs';

mark('suite');
${DECLARE('acceptance', 'src tests')}
const files = readdirSync('tests')
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => \`tests/\${name}\`);
if (files.length === 0) {
  console.error('suite: no test file under tests/');
  process.exit(1);
}
const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
console.log(run.status === 0 ? '::olympus part-ok acceptance' : '::olympus part-failed acceptance');
process.exit(run.status ?? 1);
`;

const SMOKE_GATE = `import { mark } from './mark.mjs';

mark('smoke');
${DECLARE('boot', 'src')}
console.log('smoke: ok');
`;

// The standing tripwire over the trade the flag makes, in the project's own
// registry: two fast-path escapes in a window of ten ships, and the answer is
// the config line that turns the flag off.
const TRIPWIRE = {
  id: 'fast-path-escapes',
  metric: 'fast-path-escapes',
  window: 10,
  breach: { op: '>', value: 1 },
  answer: 'set gates.fastPathShip to false: the trade it was turned on for is losing',
};

const CONFIG = {
  ...PROJECT_CONFIG,
  gates: {
    ...PROJECT_CONFIG.gates,
    fastPathShip: true,
    breadthGround: ['package-lock.json', 'db/migrations'],
    // The ground this project states no suite of it can reach. A change the
    // branch gains outside this list is ground nobody described, and the check
    // refuses rather than reading silence as safety (ADR-0056).
    inertGround: ['docs'],
  },
  tripwires: [TRIPWIRE],
};

const TREE = {
  '.olympus/project.json': JSON.stringify(CONFIG, null, 2) + '\n',
  '.olympus/gates/lint.mjs': LINT_GATE,
  '.olympus/gates/suite.mjs': SUITE_GATE,
  '.olympus/gates/smoke.mjs': SMOKE_GATE,
};

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

/** One commit on the default branch of the fixture origin. Returns its sha. */
function pushToBranch(fx, path, content, message) {
  const full = join(fx.seed, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  git(['add', '-A'], fx.seed);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', message], fx.seed);
  git(['push', '--quiet', fx.origin, 'main'], fx.seed);
  return git(['rev-parse', 'HEAD'], fx.seed).trim();
}

/** Drives a run to its freeze and answers the card's open decision. */
async function toFreeze(fx) {
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
  await pollFor('the freeze', () => runEvents(fx, runId).some((e) => e.event === 'freeze'), {
    attempts: 900,
    abort: () => stalled(fx, runId),
    diagnose: () => diagnostics(fx, runId),
  });
  return runId;
}

test('a merge onto declared ground earns the verdict again', async (t) => {
  // The other half of the claim. The same project, the same flag, a merge one
  // line away from the first scenario's: this one lands under `src`, which
  // every layer of the certified verdict declared, so the certification does
  // not carry and the merged tree is judged before it ships.
  const fx = buildFixture({ prefix: 'olympus-e2e-fastpath-no-', scenario: SCENARIO, tree: TREE });
  t.after(() => cleanup(fx));

  const runId = await toFreeze(fx);
  pushToBranch(fx, 'src/base.mjs', 'export const FACTOR = 3;\n', 'src: a competing edit');

  const fast = await pollFor(
    'the fast-path record',
    () => runEvents(fx, runId).find((e) => e.event === 'fast-path-ship'),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  assert.equal(fast.taken, false);
  assert.equal(fast.refusal, 'ground-intersects');
  assert.match(fast.detail, /src\/base\.mjs is a declared suite input/);

  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).find((e) => e.event === 'run-closed'),
    { attempts: 1800, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  const events = runEvents(fx, runId);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'shipped');
  // The refusal cost the run exactly what a run without the flag pays: one
  // more verdict, over the tree that lands, and no mark on the close.
  assert.equal(closed.fastPath, undefined);
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.equal(renders.length, 2);
  assert.equal(renders.at(-1).verdict, 'green');
  const update = events.find((e) => e.event === 'pre-verdict-update' && e.ran);
  assert.equal(renders.at(-1).sha, update.toSha);
  assert.ok(renders.at(-1).seq > fast.seq);
  // No escape kind was earned, because no fast path carried anything.
  assert.deepEqual(escapeEvents(fx), []);

  await stopDaemon(fx);
});

test('a ship over a disjoint merge keeps the certification it earned', async (t) => {
  const fx = buildFixture({ prefix: 'olympus-e2e-fastpath-', scenario: SCENARIO, tree: TREE });
  t.after(() => cleanup(fx));

  const runId = await toFreeze(fx);

  // The competing work: a document. No suite of this project declares it, the
  // suite files do not hold it, and the breadth list does not name it.
  const moved = pushToBranch(fx, 'docs/note.md', 'unrelated main work\n', 'docs: a note');

  const fast = await pollFor(
    'the fast-path record',
    () => runEvents(fx, runId).find((e) => e.event === 'fast-path-ship'),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  assert.equal(fast.taken, true, `the fast path refused: ${fast.refusal} (${fast.detail})`);
  // What it examined, and what it was checked against.
  assert.deepEqual(fast.commits, [moved]);
  assert.equal(fast.commitCount, 1);
  assert.equal(fast.mainSha, moved);
  assert.match(fast.declaration.digest, /^[0-9a-f]{12}$/);
  assert.deepEqual(fast.declaration.suites, [
    'lint/sources',
    'smoke/boot',
    'suite/acceptance',
  ]);
  // The certification it reuses is the one green verdict this run rendered.
  const render = runEvents(fx, runId).find((e) => e.event === 'verdict-rendered');
  assert.equal(render.verdict, 'green');
  assert.equal(fast.certification.cycle, render.cycle);
  assert.equal(fast.certification.record, render.record);
  assert.equal(fast.declaration.sha, render.sha);

  await pollFor(
    'the run to close',
    () => runEvents(fx, runId).find((e) => e.event === 'run-closed'),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  const events = runEvents(fx, runId);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'shipped');
  assert.equal(closed.fastPath, true);
  // The whole claim in one number: the moved tree was never judged again.
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 1);
  const update = events.find((e) => e.event === 'pre-verdict-update' && e.ran);
  assert.equal(events.find((e) => e.event === 'pr-opened').sha, update.toSha);
  // Both sides of the merge are on the branch.
  const tree = originTree(fx, 'main');
  assert.ok(tree.includes('src/feature.mjs'), 'the story did not land');
  assert.ok(tree.includes('docs/note.md'), 'the competing merge did not survive');

  // -- the cost of the trade, measured ---------------------------------------
  // Two defects an operator finds afterwards, each named by the request it came
  // in on. Neither report mentions the fast path: the attribution comes off the
  // ledgers, and the word is what the tripwire counts.
  const merged = events.find((e) => e.event === 'merged');
  for (const line of ['the total is off by one', 'the second row is lost']) {
    ctl(fx, [
      'escape',
      '--project',
      PROJECT,
      '--defect',
      line,
      '--pr',
      String(merged.pr),
    ]);
  }
  await pollFor(
    'both escape records',
    () => escapeEvents(fx).filter((e) => e.event === 'escape-recorded').length === 2,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  for (const recorded of escapeEvents(fx).filter((e) => e.event === 'escape-recorded')) {
    assert.equal(recorded.kind, 'fast-path-escape');
    assert.equal(recorded.attribution, runId);
    assert.equal(recorded.refs.project, PROJECT);
    assert.equal(recorded.refs.pr, merged.pr);
    assert.equal(recorded.refs.fastPathSeq, fast.seq);
    // Ticketed as well as recorded: the owed-repairs set is ticketed and not
    // fixed, so an escape with no ticket is repaired by nobody.
    const ticketed = escapeEvents(fx).find(
      (e) => e.event === 'escape-ticketed' && e.escape === recorded.seq,
    );
    assert.ok(ticketed, `escape ${recorded.seq} carries no ticket`);
  }
  const breach = await pollFor(
    'the tripwire that proposes turning the flag off',
    () => instanceEvents(fx).find((e) => e.event === 'tripwire-breach'),
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  assert.equal(breach.tripwire, 'fast-path-escapes');
  assert.equal(breach.value, 2);
  assert.match(breach.answer, /gates\.fastPathShip to false/);

  await stopDaemon(fx);
});
