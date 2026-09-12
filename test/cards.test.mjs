// The card writer against fixture repositories: what it stages, what it
// refuses, and what one lost race costs. The close-out sweep that sits on top
// of it is proven end to end in `ship.test.mjs`; these are the writer's own
// rules, which the spec birth answers to as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldHome } from '../src/daemon/home.mjs';
import { ensureBareClone } from '../src/isolation/clones.mjs';
import { pushCardPaths } from '../src/lanes/cards.mjs';
import {
  commitTree,
  gitSync,
  initOriginRepo,
  projectConfigJson,
  removeDir,
  tempDir,
  writeTree,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';

const ALPHA_CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Provide f(x) that doubles x.
`;

/** A card lint that records the argv it was given and says the cards are good. */
const LINT_RECORDING = `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(join(process.cwd(), '..', 'lint-argv.txt'), process.argv.slice(2).join(' ') + '\\n');
console.log('card lint: ok');
`;

/** A card lint that refuses whatever it is given. */
const LINT_RED = `console.error('card lint: the card carries no frontmatter');
process.exit(1);
`;

/**
 * A card lint that lands a commit on the origin while it runs, so the push
 * that follows it meets a branch that moved a second time.
 */
const LINT_RACING = `import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
execFileSync(
  'git',
  ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'a person edits a card'],
  { cwd: join(process.cwd(), '..', 'origin') },
);
console.log('card lint: ok');
`;

async function cardsFixture(t, { lint = LINT_RECORDING, files = {} } = {}) {
  const root = tempDir();
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson({
      repo: { testPaths: ['tests'] },
      gates: { tier1: [{ name: 'unit', command: 'suite' }] },
      lanes: { story: { suiteCommand: 'suite', lintCommand: 'cardlint' } },
      stack: null,
      commands: {
        suite: ['node', '--test', 'tests/*.test.mjs'],
        cardlint: ['node', 'scripts/cardlint.mjs'],
      },
    }),
    'stories/alpha.md': ALPHA_CARD,
    'scripts/cardlint.mjs': lint,
    'src/base.mjs': 'export const base = 1;\n',
    ...files,
  });
  // The writer pushes straight to the default branch; the fixture accepts it.
  gitSync(['config', 'receive.denyCurrentBranch', 'updateInstead'], origin);
  const paths = scaffoldHome(join(root, 'home'));
  const clone = await ensureBareClone(paths, 'proj', origin, 'main');
  // The run worktree hangs off the bare clone, as it does in a run: a fetch
  // into the clone is what makes the moved head an object the worktree holds.
  const worktree = join(root, 'work');
  gitSync(['worktree', 'add', '-b', 'run/run-1', worktree, 'main'], clone);
  const ctx = {
    runId: 'run-1',
    project: 'proj',
    paths,
    payload: {
      worktree,
      card: 'stories/alpha.md',
      defaultBranch: 'main',
      configBlob: gitSync(['rev-parse', `HEAD:${CONFIG_PATH}`], origin).trim(),
    },
  };
  t.after(() => removeDir(root));
  return {
    root,
    origin,
    worktree,
    ctx,
    /** Moves the default branch under the writer, as a person landing a card does. */
    race(tree) {
      return commitTree(origin, tree, 'a person edits a card');
    },
    lintArgv() {
      const file = join(root, 'lint-argv.txt');
      return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
    },
    onMain(path) {
      return gitSync(['show', `main:${path}`], origin);
    },
  };
}

const SWEPT = `${ALPHA_CARD}\n<!-- swept -->\n`;

test('the push carries the named paths and leaves the rest of the tree behind', async (t) => {
  const fx = await cardsFixture(t);
  writeTree(fx.worktree, { 'stories/alpha.md': SWEPT, 'src/stray.mjs': 'export const stray = 1;\n' });
  const landed = await pushCardPaths({
    ctx: fx.ctx,
    paths: ['stories/alpha.md'],
    message: 'cards: amend',
  });
  assert.equal(landed.ok, true);
  assert.equal(landed.pushed, true);
  assert.equal(landed.attempts, 1);
  assert.match(fx.onMain('stories/alpha.md'), /<!-- swept -->/);
  // The file nobody named is on no branch, and it is still where it was
  // written: the writer commits a set, it does not clean a tree.
  assert.throws(() => fx.onMain('src/stray.mjs'));
  assert.ok(existsSync(join(fx.worktree, 'src/stray.mjs')));
});

test('a path outside the card directory is refused and nothing is pushed', async (t) => {
  const fx = await cardsFixture(t);
  writeTree(fx.worktree, { 'src/stray.mjs': 'export const stray = 1;\n' });
  const head = gitSync(['rev-parse', 'HEAD'], fx.worktree).trim();
  const landed = await pushCardPaths({
    ctx: fx.ctx,
    paths: ['stories/alpha.md', 'src/stray.mjs'],
    message: 'cards: amend',
  });
  assert.equal(landed.ok, false);
  assert.equal(landed.pushed, false);
  assert.equal(landed.reason, 'outside-cards');
  assert.equal(landed.attempts, 0);
  assert.match(landed.error, /src\/stray\.mjs/);
  // Nothing was committed either: a refusal leaves the run branch clean.
  assert.equal(gitSync(['rev-parse', 'HEAD'], fx.worktree).trim(), head);
  assert.throws(() => fx.onMain('src/stray.mjs'));
});

test('a push that loses a race is replayed onto the new head and lands', async (t) => {
  const fx = await cardsFixture(t);
  fx.race({ 'stories/beta.md': '---\nkey: beta-1\ntitle: Beta\n---\n' });
  writeTree(fx.worktree, { 'stories/alpha.md': SWEPT });
  const landed = await pushCardPaths({
    ctx: fx.ctx,
    paths: ['stories/alpha.md'],
    message: 'cards: amend',
    lintCards: ['stories/alpha.md'],
  });
  assert.equal(landed.ok, true);
  assert.equal(landed.pushed, true);
  assert.equal(landed.attempts, 2);
  assert.equal(landed.replay.ok, true);
  assert.equal(landed.replay.lint, 'green');
  // Both edits stand: the writer's card, and the one that beat it there.
  assert.match(fx.onMain('stories/alpha.md'), /<!-- swept -->/);
  assert.ok(fx.onMain('stories/beta.md').includes('beta-1'));
});

test('the replay lint is asked about the cards it is given and no others', async (t) => {
  const fx = await cardsFixture(t, { files: { 'stories/gamma.md': '---\nkey: gamma-1\ntitle: G\n---\n' } });
  fx.race({ 'stories/beta.md': '---\nkey: beta-1\ntitle: Beta\n---\n' });
  writeTree(fx.worktree, { 'stories/alpha.md': SWEPT, 'stories/gamma.md': '---\nkey: gamma-1\ntitle: G2\n---\n' });
  const landed = await pushCardPaths({
    ctx: fx.ctx,
    paths: ['stories/alpha.md', 'stories/gamma.md'],
    message: 'cards: amend',
    lintCards: ['stories/alpha.md', 'stories/gamma.md'],
  });
  assert.equal(landed.ok, true);
  assert.deepEqual(fx.lintArgv(), ['--card stories/alpha.md --card stories/gamma.md']);
});

test('a replayed result the project lint refuses is a lint-red, and nothing is pushed', async (t) => {
  const fx = await cardsFixture(t, { lint: LINT_RED });
  fx.race({ 'stories/beta.md': '---\nkey: beta-1\ntitle: Beta\n---\n' });
  writeTree(fx.worktree, { 'stories/alpha.md': SWEPT });
  const landed = await pushCardPaths({
    ctx: fx.ctx,
    paths: ['stories/alpha.md'],
    message: 'cards: amend',
    lintCards: ['stories/alpha.md'],
  });
  assert.equal(landed.ok, false);
  assert.equal(landed.pushed, false);
  assert.equal(landed.reason, 'lint-red');
  assert.equal(landed.attempts, 2);
  assert.equal(landed.replay.lint, 'red');
  assert.match(landed.replay.cause, /the card lint of this project is red/);
  assert.ok(!fx.onMain('stories/alpha.md').includes('<!-- swept -->'));
});

test('a push that loses the race twice is a push-lost, and there is no third attempt', async (t) => {
  const fx = await cardsFixture(t, { lint: LINT_RACING });
  fx.race({ 'stories/beta.md': '---\nkey: beta-1\ntitle: Beta\n---\n' });
  writeTree(fx.worktree, { 'stories/alpha.md': SWEPT });
  const landed = await pushCardPaths({
    ctx: fx.ctx,
    paths: ['stories/alpha.md'],
    message: 'cards: amend',
    lintCards: ['stories/alpha.md'],
  });
  assert.equal(landed.ok, false);
  assert.equal(landed.pushed, false);
  assert.equal(landed.reason, 'push-lost');
  assert.equal(landed.attempts, 2);
  assert.equal(landed.replay.ok, false);
  assert.match(landed.error, /the replay onto \w+ did not land/);
  assert.ok(!fx.onMain('stories/alpha.md').includes('<!-- swept -->'));
});

test('a replay that conflicts with the edit that beat it reports the conflict', async (t) => {
  const fx = await cardsFixture(t);
  fx.race({ 'stories/alpha.md': `${ALPHA_CARD}\n<!-- a person wrote this -->\n` });
  writeTree(fx.worktree, { 'stories/alpha.md': SWEPT });
  const landed = await pushCardPaths({
    ctx: fx.ctx,
    paths: ['stories/alpha.md'],
    message: 'cards: amend',
    lintCards: ['stories/alpha.md'],
  });
  assert.equal(landed.ok, false);
  assert.equal(landed.reason, 'push-lost');
  assert.match(landed.replay.cause, /conflicts in stories\/alpha\.md/);
  // The person's card stands whole: a three-way replay never takes an edit back.
  assert.match(fx.onMain('stories/alpha.md'), /a person wrote this/);
});

test('a run that names no card has no card directory, so the writer refuses', async (t) => {
  const fx = await cardsFixture(t);
  const ctx = { ...fx.ctx, payload: { ...fx.ctx.payload, card: undefined } };
  writeFileSync(join(fx.worktree, 'stories/alpha.md'), SWEPT);
  const landed = await pushCardPaths({ ctx, paths: ['stories/alpha.md'], message: 'cards: amend' });
  assert.equal(landed.ok, false);
  assert.equal(landed.reason, 'outside-cards');
  assert.ok(!fx.onMain('stories/alpha.md').includes('<!-- swept -->'));
});
