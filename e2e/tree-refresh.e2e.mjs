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
src/feature.mjs - dev
tests/feature.test.mjs - suite
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
};

// The second card of the project, in the two states this scenario needs: the
// one the project's card lint refuses, and the repair.
const BROKEN_CARD_PATH = '.olympus/cards/beta-1.md';

const BROKEN_CARD = `# Halving helper

This card carries no frontmatter, and the card lint of the project refuses it.
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
function pushToBranch(fx, path, content, message) {
  writeFileSync(join(fx.seed, path), content);
  git(['add', '-A'], fx.seed);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', message], fx.seed);
  git(['push', '--quiet', fx.origin, 'main'], fx.seed);
  return git(['rev-parse', 'HEAD'], fx.seed).trim();
}

test('a retry runs against the branch head, so a repair on it is met', async (t) => {
  const fx = buildFixture({ prefix: 'olympus-e2e-refresh-', scenario: SCENARIO });
  t.after(() => cleanup(fx));

  // The block: a card the project's own lint refuses, on the default branch.
  const blocked = pushToBranch(fx, BROKEN_CARD_PATH, BROKEN_CARD, 'cards: a second card');

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
  assert.ok(park.question.includes('carries no frontmatter'), park.question);
  assert.ok(gateMarks(fx).includes('cardlint'), 'the project card lint never ran');
  // The run parked on the branch as it stood at the launch.
  const launched = runEvents(fx, runId).find((e) => e.event === 'run-launched');
  assert.equal(launched.baseSha, blocked);

  // The operator repairs the card where it lives, then answers.
  const repaired = pushToBranch(fx, BROKEN_CARD_PATH, REPAIRED_CARD, 'cards: repair the second card');
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
