// Scenario 5: a retry meets the repair the branch carries (ADR-0055).
//
// The block is the one an operator is asked to repair: a card in the project
// refuses the project's own card lint, so the launch gate of every card is red
// and the run parks. The repair belongs on the default branch, because that is
// where the card lives and where a person can write.
//
// The claim is that the answer is answerable. The operator pushes the repair,
// answers "retry", and the run brings its tree to the branch head before it
// runs the blocked step again. Without the refresh the retry re-runs against
// the tree the launch pinned, which cannot hold a repair made after it, and
// the same park comes back for ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CARD_PATH,
  PROJECT,
  buildFixture,
  cleanup,
  ctl,
  diagnostics,
  gateMarks,
  instanceEvents,
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

const SCENARIO = {
  spec: SPEC,
  suiteFiles: { 'tests/feature.test.mjs': SUITE },
  suiteReds: [{ test: 'f doubles its input', class: 'feature-absence' }],
  devFiles: { 'src/feature.mjs': 'export function f(x) {\n  return x * 2;\n}\n' },
};

// The second card of the project, in the two states this scenario needs: the
// one the project's card lint refuses, and the repair. It carries its key, so
// the closure of a card blocked by it reaches it; what it does not carry is
// the goal the lint demands.
const BROKEN_CARD_PATH = '.olympus/cards/beta-1.md';

const BROKEN_CARD = `---
key: beta-1
title: Halving helper
---

Provide g(x) in src/feature.mjs, stated here under no heading at all.
`;

// The card lint of the project, asked about the cards of one launch. It
// refuses a card it was asked about and reports the rest in one block at the
// end of its output, where the harness reads them off a green exit.
const CARD_LINT_GATE = `import { readdirSync, readFileSync } from 'node:fs';
import { mark } from './mark.mjs';

mark('cardlint');
const named = process.argv.filter((token, i) => process.argv[i - 1] === '--card');
const errors = [];
let cards = 0;
for (const name of readdirSync('.olympus/cards').sort()) {
  if (!name.endsWith('.md')) continue;
  cards++;
  const path = \`.olympus/cards/\${name}\`;
  const text = readFileSync(path, 'utf8');
  if (!text.startsWith('---')) errors.push({ path, line: \`\${path}: F1: no frontmatter\` });
  else if (!/^## Goal\\s*$/m.test(text)) errors.push({ path, line: \`\${path}: F2: no goal\` });
}
const reported = errors.filter((e) => named.length === 0 || named.includes(e.path));
if (reported.length > 0) {
  console.error(reported.map((e) => e.line).join('\\n'));
  process.exit(1);
}
console.log(\`card lint: reporting \${named.length} of \${cards} cards: \${named.join(' ')}\`);
const beyond = errors.filter((e) => !reported.includes(e));
if (beyond.length > 0) {
  process.stdout.write(\`beyond the card:\\n\${beyond.map((e) => e.line).join('\\n')}\\n\`);
}
process.exit(0);
`;

const REPAIRED_CARD = `---
key: beta-1
title: Halving helper
---

## Goal

Provide g(x) in src/feature.mjs, which halves the number it is given.

## Acceptance criteria

**AC-1** g(x) returns x/2 for every number x.
`;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

/** One commit on the default branch of the fixture origin. Returns its sha. */
function pushToBranch(fx, files, message) {
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(fx.seed, path), content);
  }
  git(['add', '-A'], fx.seed);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', message], fx.seed);
  git(['push', '--quiet', fx.origin, 'main'], fx.seed);
  return git(['rev-parse', 'HEAD'], fx.seed).trim();
}

/** The launched card of the fixture, blocked by one key it names. */
function blockedOn(fx, key) {
  const text = readFileSync(join(fx.seed, CARD_PATH), 'utf8');
  return text.replace(/^---\r?\n/, `---\nblocked-by: ["${key}"]\n`);
}

test('a retry runs against the branch head, so a repair on it is met', async (t) => {
  const fx = buildFixture({ prefix: 'olympus-e2e-refresh-', scenario: SCENARIO });
  t.after(() => cleanup(fx));

  // The block: a card the project's own lint refuses, inside the closure of
  // the card being launched, on the default branch.
  const blocked = pushToBranch(
    fx,
    {
      '.olympus/gates/cardlint.mjs': CARD_LINT_GATE,
      [CARD_PATH]: blockedOn(fx, 'beta-1'),
      [BROKEN_CARD_PATH]: BROKEN_CARD,
    },
    'cards: a second card, and the card that waits on it',
  );

  await startDaemon(fx);
  ctl(fx, ['launch', '--project', PROJECT, '--card', CARD_PATH]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  const park = await pollFor(
    'the readiness park the card lint earns',
    () => runEvents(fx, runId).find((e) => e.event === 'park' && e.type === 'stage-blocked'),
    { diagnose: () => diagnostics(fx, runId) },
  );
  assert.equal(park.reason, 'readiness-lint');
  assert.ok(park.question.includes(`${BROKEN_CARD_PATH}: F2: no goal`), park.question);
  assert.ok(gateMarks(fx).includes('cardlint'), 'the project card lint never ran');
  // The run parked on the branch as it stood at the launch.
  const launched = runEvents(fx, runId).find((e) => e.event === 'run-launched');
  assert.equal(launched.baseSha, blocked);

  // The operator repairs the card where it lives, then answers.
  const repaired = pushToBranch(
    fx,
    { [BROKEN_CARD_PATH]: REPAIRED_CARD },
    'cards: repair the second card',
  );
  assert.notEqual(repaired, blocked);
  ctl(fx, ['answer', '--run', runId, '--option', 'retry']);

  const refresh = await pollFor(
    'the tree refresh the retry is owed',
    () => runEvents(fx, runId).find((e) => e.event === 'tree-refreshed'),
    { diagnose: () => diagnostics(fx, runId) },
  );
  assert.equal(refresh.park, park.seq);
  assert.equal(refresh.branch, 'main');
  assert.equal(refresh.moved, true);
  assert.equal(refresh.from, blocked);
  assert.equal(refresh.to, repaired);

  // The refreshed tree holds the repair, and the blocked step then passed:
  // readiness went on to the card's own open decision.
  const worktree = join(fx.home, 'worktrees', runId, 'tree');
  assert.ok(existsSync(worktree), 'the run worktree is not where the harness puts it');
  assert.ok(
    readFileSync(join(worktree, BROKEN_CARD_PATH), 'utf8').includes('key: beta-1'),
    'the refreshed tree does not hold the repair',
  );
  await pollFor(
    'readiness to pass the lint it parked on',
    () => runEvents(fx, runId).some((e) => e.event === 'park' && e.type === 'open-decisions'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  ctl(fx, ['answer', '--run', runId, '--text', 'No; f trusts the value it is given.']);
  await pollFor(
    'the spec the run was launched to write',
    () => runEvents(fx, runId).some((e) => e.event === 'spec-born'),
    { attempts: 900, abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );

  // One park, one refresh: the lint was red once, and the retry that met the
  // repair never came back to the same question.
  const events = runEvents(fx, runId);
  assert.equal(events.filter((e) => e.event === 'park' && e.type === 'stage-blocked').length, 1);
  assert.equal(events.filter((e) => e.event === 'tree-refreshed').length, 1);

  // The run has proved what this scenario asks of it; the rest is the ladder
  // the other scenarios already walk.
  ctl(fx, ['kill', '--run', runId]);
  await pollFor('the run to close', () =>
    runEvents(fx, runId).find((e) => e.event === 'run-closed'),
  );
  await stopDaemon(fx);
});

test('a card red outside the closure is reported, and the launch goes on', async (t) => {
  const fx = buildFixture({ prefix: 'olympus-e2e-beyond-', scenario: SCENARIO });
  t.after(() => cleanup(fx));

  // The launched card waits on nothing, so the closure is the card itself and
  // the second card's red is beyond it. Nothing about that card can make this
  // story wrong, and holding the launch on it is what this replaces.
  pushToBranch(
    fx,
    { '.olympus/gates/cardlint.mjs': CARD_LINT_GATE, [BROKEN_CARD_PATH]: BROKEN_CARD },
    'cards: a second card the launch does not wait on',
  );

  await startDaemon(fx);
  ctl(fx, ['launch', '--project', PROJECT, '--card', CARD_PATH]);
  const runId = await pollFor(
    'the launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  const reported = await pollFor(
    'the record of the card errors beyond the launched card',
    () => runEvents(fx, runId).find((e) => e.event === 'readiness-lint-beyond'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  assert.deepEqual(reported.cards, [CARD_PATH]);
  assert.deepEqual(reported.errors, [`${BROKEN_CARD_PATH}: F2: no goal`]);
  assert.equal(reported.gist, '1 errors beyond the card');
  // Readiness went past it. The next question is the card's own open decision,
  // and no step of the run is blocked on another card.
  await pollFor(
    'readiness to reach the open decision of the launched card',
    () => runEvents(fx, runId).some((e) => e.event === 'park' && e.type === 'open-decisions'),
    { abort: () => stalled(fx, runId), diagnose: () => diagnostics(fx, runId) },
  );
  assert.ok(!runEvents(fx, runId).some((e) => e.event === 'park' && e.type === 'stage-blocked'));

  ctl(fx, ['kill', '--run', runId]);
  await pollFor('the run to close', () =>
    runEvents(fx, runId).find((e) => e.event === 'run-closed'),
  );
  await stopDaemon(fx);
});
