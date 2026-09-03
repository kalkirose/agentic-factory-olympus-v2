// Scenario 4: a ship classifies what it collides with, and only a real choice
// reaches the owner. One story ships through the assembled binaries and freezes
// a suite that pins a published set. Its close-out sweep looks ahead at two
// later cards and classifies each collision: the card whose own criteria mandate
// the change gets a foreseen-amendment note, and the card that leaves a choice
// open gets a question addressed to the owner.
//
// The proof is what happens next. The noted card launches without parking, and
// the collision it was always going to have is settled at build time on the
// card's own words, quoted verbatim. The questioned card is held, and holding it
// stops nothing else.
//
// This scenario builds its own project and its own stub seat: it runs two
// stories through one home, and every behavior is keyed on the story
// (ADR-0052, ADR-0053).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PROJECT,
  REPO_ROOT,
  REPO_URL,
  assertNoWiringFailure,
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

const SEAT_STUB = join(REPO_ROOT, 'e2e', 'stub', 'seat-cards.mjs');
const GH_STUB = join(REPO_ROOT, 'e2e', 'stub', 'gh.mjs');
const REQUIRED_CHECK = 'ci';

const ALPHA_CARD_PATH = '.olympus/cards/alpha-1.md';
const BETA_CARD_PATH = '.olympus/cards/beta-1.md';
const GAMMA_CARD_PATH = '.olympus/cards/gamma-1.md';

// -- the project -------------------------------------------------------------

const PROJECT_CONFIG = {
  version: 1,
  repo: { testPaths: ['tests'], uiPaths: [] },
  commands: {
    suite: ['node', '.olympus/gates/suite.mjs'],
    cardlint: ['node', '.olympus/gates/cardlint.mjs'],
  },
  gates: { tier1: [{ name: 'suite', command: 'suite' }] },
  lanes: { story: { suiteCommand: 'suite', lintCommand: 'cardlint' } },
  conventions: ['One exported function per module.'],
  stack: null,
  graph: { cardsDir: '.olympus/cards' },
  tripwires: [],
  diffPolicy: {
    story: { deniedPaths: ['.olympus/gates'], declaredPaths: ['src'] },
    repair: { declaredPaths: ['src'] },
  },
  budgets: { story: 50, repair: 50 },
  constitutionPath: '.olympus/constitution.md',
};

const CONSTITUTION = `# Constitution

- A module exports one function per behavior it names.
- A test asserts behavior, never an implementation detail.
`;

const ALPHA_CARD = `---
key: alpha-1
title: Doubling helper
---

## Goal

Provide f(x) in src/feature.mjs, which doubles the number it is given.

## Scope boundary

src/feature.mjs and its test only.

## Acceptance criteria

**AC-1** f(x) returns 2*x for every number x, and the module publishes f alone.
`;

// The later card whose own criteria mandate the collision. It never names a
// test file, which is the whole point: a card states what the story must do.
const BETA_CARD = `---
key: beta-1
title: Halving helper
blocked-by: ["alpha-1"]
---

## Goal

Publish g(x) beside f(x) in src/feature.mjs.

## Scope boundary

src/feature.mjs and its test only.

## Acceptance criteria

**AC-1** The module publishes g beside f, so the published set is exactly f and g.
`;

// The later card that leaves a choice open. Nothing about the shipped work
// settles it, so it is the owner's.
const GAMMA_CARD = `---
key: gamma-1
title: Read me banner
---

## Goal

Put the project banner at the top of README.md.

## Acceptance criteria

**AC-1** README.md opens with the project banner.
`;

const BETA_NOTE =
  'Foreseen amendment: tests/exports.test.mjs pins the published set to f alone; AC-1 of this ' +
  'card mandates g beside f.';

const BETA_NOTED = `${BETA_CARD}
## Foreseen amendments

- ${BETA_NOTE}
`;

const GAMMA_QUESTION = 'Does the banner carry the version number?';

const SUITE_GATE = `import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = readdirSync('tests')
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => \`tests/\${name}\`);
if (files.length === 0) {
  console.error('suite: no test file under tests/');
  process.exit(1);
}
const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(run.status ?? 1);
`;

const CARD_LINT_GATE = `import { readdirSync, readFileSync } from 'node:fs';

let checked = 0;
for (const name of readdirSync('.olympus/cards')) {
  if (!name.endsWith('.md')) continue;
  if (!readFileSync(\`.olympus/cards/\${name}\`, 'utf8').startsWith('---')) {
    console.error(\`card lint: \${name} carries no frontmatter\`);
    process.exit(1);
  }
  checked++;
}
console.log(\`card lint: \${checked} card(s)\`);
`;

function projectTree() {
  return {
    '.olympus/project.json': JSON.stringify(PROJECT_CONFIG, null, 2) + '\n',
    '.olympus/constitution.md': CONSTITUTION,
    [ALPHA_CARD_PATH]: ALPHA_CARD,
    [BETA_CARD_PATH]: BETA_CARD,
    [GAMMA_CARD_PATH]: GAMMA_CARD,
    '.olympus/gates/suite.mjs': SUITE_GATE,
    '.olympus/gates/cardlint.mjs': CARD_LINT_GATE,
    'src/base.mjs': 'export const FACTOR = 2;\n',
    'tests/.keep': 'The acceptance suite lives here.\n',
    'README.md': '# Fixture project\n',
  };
}

// -- what the seats produce --------------------------------------------------

const ALPHA_SUITE = `import test from 'node:test';
import assert from 'node:assert/strict';

test('the module publishes f alone', async () => {
  const mod = await import('../src/feature.mjs');
  assert.deepEqual(Object.keys(mod).sort(), ['f']);
  assert.equal(mod.f(2), 4);
});
`;

const BETA_SUITE = `import test from 'node:test';
import assert from 'node:assert/strict';

test('the module publishes f and g', async () => {
  const mod = await import('../src/feature.mjs');
  assert.deepEqual(Object.keys(mod).sort(), ['f', 'g']);
  assert.equal(mod.f(2), 4);
  assert.equal(mod.g(4), 2);
});
`;

const ALPHA_SPEC = `# alpha-1 spec

Base sha: the launch base. Scope exclusions: none beyond the card boundary.

## AC-1

f(x) answers twice the number it is given, and the module publishes f alone.

Test mapping:
- tests/exports.test.mjs - f(2) is 4 and the published set is exactly f

Named constants:
- FACTOR = 2

Supersedes:
- None

## Touched paths

\`\`\`touched-paths
src/feature.mjs (new) - dev
tests/exports.test.mjs (new) - suite
\`\`\`

## Environment

None; the card names none.
`;

// Beta launches after alpha shipped, so both files exist at its base and its
// block carries no marker; the pin alpha left on src/feature.mjs is declared.
const BETA_SPEC = `# beta-1 spec

Base sha: the launch base. Scope exclusions: none beyond the card boundary.

## AC-1

The module publishes g beside f. The suite asserts the published set.

Test mapping:
- tests/exports.test.mjs - the published set is exactly f and g

Named constants:
- FACTOR = 2

Supersedes:
- None

## Touched paths

\`\`\`touched-paths
src/feature.mjs - dev
tests/exports.test.mjs - suite
\`\`\`

## Environment

None; the card names none.
`;

// What the amendment writes: the guarantee the pin protected, restated in the
// form the card mandates, and the file it lives in named in the clause.
const BETA_SPEC_AMENDED = BETA_SPEC.replace(
  'Supersedes:\n- None',
  'Supersedes:\n- tests/exports.test.mjs - supersede - the published set is exactly f and g',
);

function scenarioFor(callDir, memoDir) {
  return {
    callDir,
    memoDir,
    stories: {
      'alpha-1': {
        spec: ALPHA_SPEC,
        suiteFiles: { 'tests/exports.test.mjs': ALPHA_SUITE },
        suiteReds: [{ test: 'the module publishes f alone', class: 'feature-absence' }],
        adversaryFiles: { 'src/feature.mjs': 'export const f = (x) => x + 1;\n' },
        devFiles: { 'src/feature.mjs': 'export function f(x) {\n  return x * 2;\n}\n' },
        // The close-out classification: one note, one question.
        sweep: {
          files: { [BETA_CARD_PATH]: BETA_NOTED },
          report: {
            updatedCards: [BETA_CARD_PATH],
            invalidated: [],
            foreseen: [
              {
                card: BETA_CARD_PATH,
                clause: 'the published set is exactly f',
                file: 'tests/exports.test.mjs',
                mandate: 'AC-1 of beta-1 mandates g beside f',
              },
            ],
            decisions: [{ card: GAMMA_CARD_PATH, question: GAMMA_QUESTION }],
            summary: 'one foreseen amendment, one question',
          },
        },
      },
      'beta-1': {
        spec: BETA_SPEC,
        specAmendment: BETA_SPEC_AMENDED,
        gateConflict: {
          detail: 'the frozen surface pins the published set to f alone, and AC-1 mandates g beside f',
          supersedes: 'tests/exports.test.mjs',
          supersedeAssertion: 'the published set is exactly f, and becomes exactly f and g',
          supersedeQuote: BETA_NOTE,
          supersedeClause: 'foreseen',
        },
        suiteFiles: { 'tests/exports.test.mjs': BETA_SUITE },
        suiteReds: [{ test: 'the module publishes f and g', class: 'feature-absence' }],
        adversaryFiles: { 'src/feature.mjs': 'export const f = (x) => 2 * x;\n' },
        devFiles: {
          'src/feature.mjs': 'export function f(x) {\n  return x * 2;\n}\n\nexport function g(x) {\n  return x / 2;\n}\n',
        },
      },
    },
  };
}

// -- the fixture -------------------------------------------------------------

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function writeTree(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** One file of a ref in the fixture origin. */
function originFile(fx, ref, path) {
  return git(['show', `${ref}:${path}`], fx.origin);
}

function buildCardsFixture() {
  const root = mkdtempSync(join(tmpdir(), 'olympus-e2e-cards-'));
  const seed = join(root, 'seed');
  const origin = join(root, 'origin.git');
  const home = join(root, 'home');
  const calls = join(root, 'seat-calls');
  const memo = join(root, 'seat-memo');

  mkdirSync(seed, { recursive: true });
  git(['init', '-b', 'main', '.'], seed);
  git(['config', 'user.email', 'fixture@olympus.invalid'], seed);
  git(['config', 'user.name', 'Olympus Fixture'], seed);
  writeTree(seed, projectTree());
  git(['add', '-A'], seed);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], seed);
  git(['clone', '--bare', '--quiet', seed, origin]);

  mkdirSync(home, { recursive: true });
  mkdirSync(calls, { recursive: true });
  mkdirSync(memo, { recursive: true });
  writeFileSync(
    join(home, 'instance.json'),
    JSON.stringify(
      {
        version: 1,
        logLevel: 'info',
        semaphores: { 'claude-opus-5': 2, 'claude-fable-5-1': 2 },
        claudeCommand: ['node', SEAT_STUB],
        ghCommand: ['node', GH_STUB],
        projects: {
          [PROJECT]: {
            repoUrl: REPO_URL,
            defaultBranch: 'main',
            projectConfigPath: '.olympus/project.json',
            slotCap: 1,
          },
        },
      },
      null,
      2,
    ) + '\n',
  );

  const scenarioPath = join(root, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenarioFor(calls, memo), null, 2) + '\n');
  const forgeState = join(root, 'forge.json');
  writeFileSync(
    forgeState,
    JSON.stringify(
      {
        origin,
        base: 'main',
        check: REQUIRED_CHECK,
        head: null,
        armed: false,
        merged: false,
        mergeSha: null,
        prStateCalls: 0,
        checkCalls: 0,
      },
      null,
      2,
    ) + '\n',
  );

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.OLYMPUSD_HOME;
  Object.assign(env, {
    OLYMPUS_E2E_SCENARIO: scenarioPath,
    OLYMPUS_E2E_FORGE: forgeState,
    OLYMPUS_E2E_FORGE_LOG: join(root, 'forge-calls.jsonl'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${origin.replaceAll('\\', '/')}.insteadOf`,
    GIT_CONFIG_VALUE_0: REPO_URL,
  });

  // The shape the fixture helpers read: the home they talk to, the call
  // directory they list, the environment every child inherits, and the daemon
  // handle the start fills in.
  return { root, seed, origin, home, calls, env, daemon: null };
}

// -- the scenario ------------------------------------------------------------

test('a ship classifies what it collides with, and only a real choice is asked', async (t) => {
  const fx = buildCardsFixture();
  t.after(() => cleanup(fx));
  await startDaemon(fx);

  // -- the first story ships, and its close-out sweep classifies -------------
  ctl(fx, ['launch', '--project', PROJECT, '--card', ALPHA_CARD_PATH]);
  const alpha = await pollFor(
    'the first launch stamp',
    () => instanceEvents(fx).find((e) => e.event === 'launch')?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  await pollFor(
    'the first run to close',
    () => runEvents(fx, alpha).find((e) => e.event === 'run-closed'),
    { attempts: 900, abort: () => stalled(fx, alpha), diagnose: () => diagnostics(fx, alpha) },
  );
  const alphaEvents = runEvents(fx, alpha);
  assert.equal(alphaEvents.find((e) => e.event === 'run-closed').state, 'shipped');
  assertNoWiringFailure(assert, fx, alpha);
  const sweep = alphaEvents.find((e) => e.event === 'card-sweep');
  assert.equal(sweep.ok, true);
  assert.equal(sweep.pushed, true);
  assert.equal(sweep.foreseen, 1);
  assert.equal(sweep.decisions, 1);

  // -- the mandated collision is a note on the card, and nothing waits on it --
  const betaCard = originFile(fx, 'refs/heads/main', BETA_CARD_PATH);
  assert.match(betaCard, /## Foreseen amendments/);
  assert.ok(betaCard.includes(BETA_NOTE), 'the note is not on the card the sweep wrote it for');
  // The card that leaves a choice open is the only thing that reached a human,
  // and the question holds that card rather than the run that shipped.
  const parks = instanceEvents(fx).filter((e) => e.event === 'park');
  assert.deepEqual(
    parks.map((p) => [p.type, p.card]),
    [['card-decision', GAMMA_CARD_PATH]],
  );
  assert.ok(parks[0].question.includes(GAMMA_QUESTION));
  assert.ok(
    !(parks[0].answers.options ?? []).includes('abandon'),
    'a card park offered to close a run',
  );
  assert.match(ctl(fx, ['queue']), /card-decision/);
  // The frontier holds the questioned card and nothing else.
  const frontier = ctl(fx, ['frontier', '--project', PROJECT]);
  assert.match(frontier, /parked\s+gamma-1/, `the frontier did not hold the card:\n${frontier}`);
  assert.match(frontier, /launchable\s+beta-1/, `the frontier held a card it should not:\n${frontier}`);

  // -- the noted card launches without parking, and the card settles it ------
  ctl(fx, ['launch', '--project', PROJECT, '--card', BETA_CARD_PATH]);
  const beta = await pollFor(
    'the second launch stamp',
    () => instanceEvents(fx).filter((e) => e.event === 'launch')[1]?.runId,
    { abort: () => stalled(fx), diagnose: () => diagnostics(fx) },
  );
  const stamp = await pollFor(
    'the supersede the card authorized',
    () => runEvents(fx, beta).find((e) => e.event === 'supersede-authorized'),
    { attempts: 900, abort: () => stalled(fx, beta), diagnose: () => diagnostics(fx, beta) },
  );
  assert.equal(stamp.site, 'spec-gate');
  assert.equal(stamp.clause, 'foreseen');
  assert.equal(stamp.test, 'tests/exports.test.mjs');
  assert.equal(stamp.cardQuote, BETA_NOTE);
  assert.equal(stamp.card, BETA_CARD_PATH);
  // Nothing parked: not the note at the launch gate, not the collision at the
  // spec gate. The owner was asked once, about the card that left a choice.
  assert.deepEqual(
    runEvents(fx, beta)
      .filter((e) => e.event === 'park')
      .map((e) => e.type),
    [],
  );
  // The amendment ran on the card's own words, and it was told to keep the
  // guarantee the pin protected.
  const amend = await pollFor(
    'the amendment brief',
    () =>
      seatCalls(fx)
        .filter((c) => c.seat === 'spec-birth')
        .find((c) => c.prompt.includes('Amend the born spec')),
    { abort: () => stalled(fx, beta), diagnose: () => diagnostics(fx, beta) },
  );
  assert.ok(amend.prompt.includes(BETA_NOTE), 'the amendment was not handed the card line');
  assert.ok(amend.prompt.includes('tests/exports.test.mjs'));
  assert.ok(amend.prompt.includes('a pin is amended, never deleted'));
  // The gate seat was briefed on the necessity test, not on naming.
  const gate = seatCalls(fx).find((c) => c.seat === 'spec-gate' && c.story === 'beta-1');
  assert.ok(
    gate.prompt.includes('The test is necessity, not naming'),
    'the gate seat was briefed on the old covered test',
  );
  assert.ok(gate.prompt.includes('Foreseen amendments'));

  // The run has proved what this scenario asks of it; the rest is the ladder
  // the other scenarios already walk.
  ctl(fx, ['kill', '--run', beta]);
  await pollFor('the second run to close', () =>
    runEvents(fx, beta).find((e) => e.event === 'run-closed'),
  );
  await stopDaemon(fx);
});
