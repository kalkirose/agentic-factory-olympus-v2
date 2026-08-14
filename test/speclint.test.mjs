// The spec lint: the deterministic bookend on the story spec. Every rule is
// exercised on a spec that holds it and one that breaks it, against a fixture
// card and a fixture worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIntentCard } from '../src/lanes/card.mjs';
import { lintSpec, frozenExclusions, SPEC_LINE_CAP } from '../src/lanes/speclint.mjs';
import { parseTouchedBlock, parseTouchedPaths } from '../src/seats/diffpolicy.mjs';
import { tempDir, removeDir } from './helpers.mjs';

const CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Provide f(x) that doubles x.

## Acceptance criteria

- AC-1: f(x) returns 2*x for every number x.
- AC-2: f throws on a value that is not a number.
`;

const { card } = parseIntentCard(CARD);

const TIER = {
  declaredPaths: ['**/package.json'],
  forbiddenPatterns: ['-win32\\.'],
};

function spec({ header = '# alpha-1 spec', sections, touched, environment = '## Environment\n\nNone.' } = {}) {
  const body =
    sections ??
    [
      section('AC-1', ['tests/feature.test.mjs — f(2) is 4']),
      section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
    ].join('\n');
  const block =
    touched ??
    ['```touched-paths', 'src/feature.mjs — dev', 'tests/feature.test.mjs — suite', '```'].join('\n');
  return [header, '', body, '', block, '', environment, ''].join('\n');
}

function section(id, mappings, { supersedes = ['None'] } = {}) {
  return [
    `## ${id}`,
    '',
    'The behavior the criterion names.',
    '',
    'Test mapping:',
    ...mappings.map((m) => `- ${m}`),
    '',
    'Named constants:',
    '- FACTOR = 2',
    '',
    'Supersedes:',
    ...supersedes.map((s) => `- ${s}`),
    '',
  ].join('\n');
}

function fixtureTree(t) {
  const dir = tempDir('olympus-speclint-');
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'tests', 'feature.test.mjs'), 'export {};\n');
  mkdirSync(join(dir, 'tests', 'support'), { recursive: true });
  writeFileSync(join(dir, 'tests', 'support', 'harness.mjs'), 'export {};\n');
  t.after(() => removeDir(dir));
  return dir;
}

function lint(t, text, { tier = null, testPaths = ['tests'], worktree = fixtureTree(t) } = {}) {
  return lintSpec(text, { card, worktree, testPaths, tier });
}

// -- the clean spec ----------------------------------------------------------

test('a spec that holds the template lints clean', (t) => {
  assert.deepEqual(lint(t, spec(), { tier: TIER }), []);
});

// -- (a) one section per card criterion, in card order -----------------------

test('(a) a missing criterion section is named', (t) => {
  const defects = lint(t, spec({ sections: section('AC-1', ['tests/feature.test.mjs — f(2) is 4']) }));
  assert.equal(defects.length, 1);
  assert.match(defects[0], /no section for acceptance criterion AC-2/);
});

test('(a) a repeated criterion section is named', (t) => {
  const sections = [
    section('AC-1', ['tests/feature.test.mjs — f(2) is 4']),
    section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
    section('AC-2', ['tests/feature.test.mjs — f(null) throws']),
  ].join('\n');
  assert.match(lint(t, spec({ sections }))[0], /2 sections titled AC-2; the template takes exactly one/);
});

test('(a) a section that answers no criterion is a defect', (t) => {
  const sections = [
    section('AC-1', ['tests/feature.test.mjs — f(2) is 4']),
    section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
    section('AC-9', ['tests/feature.test.mjs — the cache warms']),
  ].join('\n');
  assert.match(lint(t, spec({ sections }))[0], /AC-9 answers no acceptance criterion on the card/);
});

test('(a) sections out of card order are named', (t) => {
  const sections = [
    section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
    section('AC-1', ['tests/feature.test.mjs — f(2) is 4']),
  ].join('\n');
  assert.match(lint(t, spec({ sections }))[0], /orders its criterion sections AC-2, AC-1/);
});

test('(a) the header may name the card key without becoming a section', (t) => {
  assert.deepEqual(lint(t, spec({ header: '# alpha-1' })), []);
});

// -- (b) the hard cap --------------------------------------------------------

test('(b) a spec past the cap is named with its length', (t) => {
  const padding = Array.from({ length: SPEC_LINE_CAP }, (_, i) => `Line ${i}.`).join('\n');
  const defects = lint(t, spec({ environment: `## Environment\n\n${padding}` }));
  assert.equal(defects.length, 1);
  assert.match(defects[0], new RegExp(`the template caps it at ${SPEC_LINE_CAP}`));
});

// -- (c) the touched-paths block ---------------------------------------------

test('(c) a missing block, a second block, and an unterminated block each fail', (t) => {
  assert.match(lint(t, spec({ touched: '' }))[0], /declares no ```touched-paths block/);
  const twice = [
    '```touched-paths',
    'src/feature.mjs — dev',
    '```',
    '',
    '```touched-paths',
    'src/other.mjs — dev',
    '```',
  ].join('\n');
  assert.match(lint(t, spec({ touched: twice }))[0], /declares 2 touched-paths blocks/);
  const open = ['```touched-paths', 'src/feature.mjs — dev'].join('\n');
  assert.match(lint(t, spec({ touched: open }))[0], /never closed by a fence/);
});

test('(c) an unclean path and a bad owner tag are each named', (t) => {
  const cases = [
    ['/src/feature.mjs — dev', /is not relative to the repository root/],
    ['src\\feature.mjs — dev', /carries a backslash/],
    ['../outside.mjs — dev', /walks out of the repository/],
    ['src/ — dev', /ends in a slash/],
    ['src/*.mjs — dev', /is a glob/],
    ['src/feature.mjs', /names no owner/],
    ['src/feature.mjs — author', /names the owner "author"/],
  ];
  for (const [line, pattern] of cases) {
    const defects = lint(t, spec({ touched: ['```touched-paths', line, '```'].join('\n') }));
    assert.ok(
      defects.some((d) => pattern.test(d)),
      `${line}: ${defects.join(' | ')}`,
    );
  }
});

// -- (d) declared-tier coverage ----------------------------------------------

test('(d) a declared-tier path the spec plans but never declares is named', (t) => {
  const sections = [
    section('AC-1', ['tests/feature.test.mjs — f(2) is 4', 'package.json — the script exists']),
    section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
  ].join('\n');
  const defects = lint(t, spec({ sections }), { tier: TIER });
  assert.ok(defects.some((d) => /the spec plans to touch package\.json/.test(d)));
  const declared = ['```touched-paths', 'package.json — dev', 'tests/feature.test.mjs — suite', '```'].join(
    '\n',
  );
  assert.ok(
    !lint(t, spec({ sections, touched: declared }), { tier: TIER }).some((d) =>
      /plans to touch package\.json/.test(d),
    ),
  );
});

// -- (e) test mappings live under the acceptance test paths ------------------

test('(e) a test file outside the test paths is named with its criterion', (t) => {
  const sections = [
    section('AC-1', ['src/feature.spec.mjs — f(2) is 4']),
    section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
  ].join('\n');
  const defects = lint(t, spec({ sections }));
  assert.match(defects[0], /the test mapping of AC-1 names src\/feature\.spec\.mjs/);
});

// -- (f) a superseded test exists --------------------------------------------

test('(f) a supersede that names no file in the worktree is named', (t) => {
  const held = section('AC-1', ['tests/feature.test.mjs — f(2) is 4'], {
    supersedes: ['tests/feature.test.mjs — supersede — AC-1 replaces the shape assertion'],
  });
  const broken = section('AC-1', ['tests/feature.test.mjs — f(2) is 4'], {
    supersedes: ['tests/gone.test.mjs — supersede — AC-1 replaces it'],
  });
  const tail = section('AC-2', ['tests/feature.test.mjs — f("x") throws']);
  assert.deepEqual(lint(t, spec({ sections: [held, tail].join('\n') })), []);
  assert.match(
    lint(t, spec({ sections: [broken, tail].join('\n') }))[0],
    /AC-1 supersedes tests\/gone\.test\.mjs; no such file exists/,
  );
});

// -- (g) a dev-owned test-path entry names one file --------------------------

test('(g) a dev-owned test path must name a file, never a directory', (t) => {
  const dir = ['```touched-paths', 'tests/support — dev', 'tests/feature.test.mjs — suite', '```'].join(
    '\n',
  );
  assert.match(
    lint(t, spec({ touched: dir }))[0],
    /owned by dev and sits under a test path, so it must name one file: it names a directory/,
  );
  const file = [
    '```touched-paths',
    'tests/support/harness.mjs — dev',
    'tests/feature.test.mjs — suite',
    '```',
  ].join('\n');
  assert.deepEqual(lint(t, spec({ touched: file })), []);
  // A file the work still has to create passes on its shape alone.
  const fresh = [
    '```touched-paths',
    'tests/support/fixtures.mjs — dev',
    'tests/feature.test.mjs — suite',
    '```',
  ].join('\n');
  assert.deepEqual(lint(t, spec({ touched: fresh })), []);
  const nameless = ['```touched-paths', 'tests/support/fixtures — dev', '```'].join('\n');
  assert.match(lint(t, spec({ touched: nameless }))[0], /carries no file extension/);
});

test('(g) a suite-owned directory entry is not the lint\'s business', (t) => {
  const touched = ['```touched-paths', 'tests/support — suite', '```'].join('\n');
  assert.deepEqual(lint(t, spec({ touched })), []);
});

// -- (h) forbidden path shapes -----------------------------------------------

test('(h) a forbidden shape fails in the block and in a test mapping', (t) => {
  const touched = [
    '```touched-paths',
    'src/loader-win32.mjs — dev',
    'tests/feature.test.mjs — suite',
    '```',
  ].join('\n');
  assert.match(lint(t, spec({ touched }), { tier: TIER })[0], /matches a path shape the diff policy forbids/);
  const sections = [
    section('AC-1', ['tests/feature-win32.test.mjs — f(2) is 4']),
    section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
  ].join('\n');
  assert.ok(
    lint(t, spec({ sections }), { tier: TIER }).some((d) => /feature-win32\.test\.mjs matches a path shape/.test(d)),
  );
  // Prose is never scanned: the same shape in a sentence says nothing.
  const prose = spec({ environment: '## Environment\n\nThe old src/loader-win32.mjs is gone.' });
  assert.deepEqual(lint(t, prose, { tier: TIER }), []);
});

// -- the freeze's exclusions -------------------------------------------------

test('the exclusions are the dev-owned test-path entries, and nothing else', () => {
  const text = spec({
    touched: [
      '```touched-paths',
      'src/feature.mjs — dev',
      'tests/support/harness.mjs — dev',
      'tests/feature.test.mjs — suite',
      '```',
    ].join('\n'),
  });
  assert.deepEqual(frozenExclusions(text, ['tests']), ['tests/support/harness.mjs']);
  assert.deepEqual(frozenExclusions(text, []), []);
  assert.deepEqual(frozenExclusions('# no block', ['tests']), []);
});

test('the touched-paths parse carries the owner and still answers the gate', () => {
  const text = spec();
  assert.deepEqual(parseTouchedPaths(text), ['src/feature.mjs', 'tests/feature.test.mjs']);
  assert.deepEqual(
    parseTouchedBlock(text).entries.map((e) => [e.path, e.owner]),
    [
      ['src/feature.mjs', 'dev'],
      ['tests/feature.test.mjs', 'suite'],
    ],
  );
});

// -- card criteria -----------------------------------------------------------

test('a criterion takes its own id, or its position when it carries none', () => {
  assert.deepEqual(
    card.acceptance.map((c) => c.id),
    ['AC-1', 'AC-2'],
  );
  const { card: positional } = parseIntentCard(
    '---\nkey: a-1\n---\n\n## Acceptance criteria\n\n- The widget renders.\n- The widget closes.\n',
  );
  assert.deepEqual(
    positional.acceptance.map((c) => c.id),
    ['AC-1', 'AC-2'],
  );
  const { card: none } = parseIntentCard('---\nkey: a-1\n---\n\n## Goal\n\nDo the thing.\n');
  assert.deepEqual(none.acceptance, []);
});
