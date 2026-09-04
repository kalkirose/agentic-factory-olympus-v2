// The spec lint: the deterministic bookend on the story spec. Every rule is
// exercised on a spec that holds it and one that breaks it, against a fixture
// card and a fixture worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIntentCard } from '../src/lanes/card.mjs';
import {
  amendedSections,
  componentIndex,
  lintSpec,
  frozenExclusions,
  SPEC_LINE_CAP,
} from '../src/lanes/speclint.mjs';
import { specLintDefects } from '../src/lanes/story.mjs';
import { parseTouchedBlock, parseTouchedPaths } from '../src/seats/diffpolicy.mjs';
import { tempDir, removeDir, gitSync, initOriginRepo } from './helpers.mjs';

const CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Provide f(x) that doubles x.

## Acceptance criteria

**AC-1** f(x) returns 2*x for every number x.

AC-2: f throws on a value that is not a number.
`;

// Both legal line shapes in one card: the bold id real cards write, and the
// bare id. Rule (a) is exercised against the set they parse to.
const { card } = parseIntentCard(CARD);
const CARD_PATH = '.olympus/cards/alpha-1.md';

const TIER = {
  declaredPaths: ['**/package.json'],
  forbiddenPatterns: ['-win32\\.'],
};

function spec({
  header = '# alpha-1 spec',
  sections,
  touched,
  components = ['None.'],
  environment = '## Environment\n\nNone.',
} = {}) {
  const body =
    sections ??
    [
      section('AC-1', ['tests/feature.test.mjs — f(2) is 4']),
      section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
    ].join('\n');
  const block =
    touched ??
    ['```touched-paths', 'src/feature.mjs — dev', 'tests/feature.test.mjs — suite', '```'].join('\n');
  const named =
    components === null
      ? []
      : ['## Components', '', ...components.map((c) => `- ${c}`), ''];
  return [header, '', body, '', block, '', ...named, environment, ''].join('\n');
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
  // A route tree of the shape a web framework builds: a group directory in
  // parentheses, a parameter directory in brackets.
  mkdirSync(join(dir, 'tests', 'routes', '(shop)', '[step]'), { recursive: true });
  writeFileSync(join(dir, 'tests', 'routes', '(shop)', '[step]', 'page.test.mjs'), 'export {};\n');
  t.after(() => removeDir(dir));
  return dir;
}

function lint(
  t,
  text,
  {
    tier = null,
    testPaths = ['tests'],
    worktree = fixtureTree(t),
    on = card,
    baseFiles = null,
    ground = null,
  } = {},
) {
  return lintSpec(text, { card: on, cardPath: CARD_PATH, worktree, testPaths, tier, baseFiles, ground });
}

/** The tree the fixture spec is written against, as the lane hands it over. */
function groundOf({
  files = TREE_FILES,
  pins = new Map(),
  routesRoot = 'routes',
  componentsRoot = 'ui',
} = {}) {
  return {
    files,
    pins,
    routesRoot,
    componentsRoot,
    components: componentIndex(files, componentsRoot),
  };
}

const TREE_FILES = [
  'src/feature.mjs',
  'src/base.mjs',
  'tests/feature.test.mjs',
  'tests/layout.test.mjs',
  'routes/[lang=lang]/shop/+page.svelte',
  'routes/[lang=lang]/(account)/orders/+page.svelte',
  // A design system read as folder-per-component, one at the root of it and
  // one nested, so the rule is proved against both shapes.
  'ui/PriceTag/PriceTag.svelte',
  'ui/PriceTag/index.ts',
  'ui/forms/QuantityStepper/QuantityStepper.svelte',
];

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

test('(a) a renumbered section title is answered with the ids the card carries', (t) => {
  // The failure a positional renumbering produces: every card id missing, every
  // written id unknown. Each message carries the list the seat needed.
  const sections = [
    section('AC-3', ['tests/feature.test.mjs — f(2) is 4']),
    section('AC-4', ['tests/feature.test.mjs — f("x") throws']),
  ].join('\n');
  const defects = lint(t, spec({ sections }));
  assert.equal(defects.length, 4);
  for (const defect of defects) {
    assert.ok(
      defect.includes('expected sections, in card order: AC-1, AC-2'),
      defect,
    );
  }
  assert.ok(defects.some((d) => /no section for acceptance criterion AC-1/.test(d)));
  assert.ok(defects.some((d) => /section AC-3 answers no acceptance criterion/.test(d)));
});

test('(a) a card that yields no criterion is one message, never one per section', (t) => {
  const { card: empty } = parseIntentCard(
    '---\nkey: alpha-1\n---\n\n## Acceptance criteria\n\nThe goal above states them.\n',
  );
  // Nothing to compare against: every section would answer no criterion and
  // the expected-id list would render empty. One message says what happened,
  // names the card, and names the heading the parse read.
  const defects = lint(t, spec(), { on: empty });
  assert.equal(defects.length, 1);
  assert.ok(defects[0].includes('yields no acceptance criterion'), defects[0]);
  assert.ok(defects[0].includes(CARD_PATH), defects[0]);
  assert.ok(defects[0].includes('acceptance heading'), defects[0]);
  assert.ok(!defects[0].includes('answers no acceptance criterion'), defects[0]);
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
    ['./src/feature.mjs — dev', /carries a "\." segment/],
    ['src/ — dev', /ends in a slash/],
    ['src/*.mjs — dev', /is a glob/],
    ['src/feature?.mjs — dev', /is a glob/],
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

test('(c) a route path written with brackets, parentheses and spaces is a path', (t) => {
  // Only `*` and `?` mark a pattern. Everything else here is a character the
  // path carries, and a spec that had to drop such a file to pass the lint
  // would be a spec the lint distorted.
  const touched = [
    '```touched-paths',
    'src/routes/(shop)/checkout/[step]/+page.server.ts — dev',
    'src/routes/(shop)/checkout/+page.svelte — dev',
    'src/lib/{brand}/logo asset.svg — dev',
    'tests/feature.test.mjs — suite',
    '```',
  ].join('\n');
  assert.deepEqual(lint(t, spec({ touched })), []);
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

// -- (i) a mapping is one bullet on one line ---------------------------------

test('(i) a rewrapped mapping bullet is one shape defect, never a path defect', (t) => {
  // The shape a line-cap compression produces: the path holds the bullet line,
  // the behavior wraps under it. Read word by word, every wrapped line opens a
  // mapping that names an English word as a test file.
  const sections = [
    [
      '## AC-1',
      '',
      'The behavior the criterion names.',
      '',
      'Test mapping:',
      '- tests/feature.test.mjs —',
      '  after the doubling, f(2) is 4 and the call took',
      '  each argument the criterion names.',
      '',
      'Named constants:',
      '- FACTOR = 2',
      '',
      'Supersedes:',
      '- None',
      '',
    ].join('\n'),
    section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
  ].join('\n');
  const defects = lint(t, spec({ sections }));
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(defects[0], /the test mapping is rewrapped or malformed at AC-1 line 8:/);
  assert.match(defects[0], /a mapping is one bullet on one line/);
  assert.ok(!/not under an acceptance test path/.test(defects[0]), defects[0]);
});

test('(i) a list nested under a mapping bullet is the same defect', (t) => {
  // The other compression: one path, and the behaviors regrouped under it.
  const sections = [
    [
      '## AC-1',
      '',
      'The behavior the criterion names.',
      '',
      'Test mapping:',
      '- tests/feature.test.mjs',
      '  - f(2) is 4',
      '  - each number doubles',
      '',
      'Supersedes:',
      '- None',
      '',
    ].join('\n'),
    section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
  ].join('\n');
  const defects = lint(t, spec({ sections }));
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(defects[0], /rewrapped or malformed at AC-1 line 8/);
});

test('(i) every criterion that lost the shape is named in the one defect', (t) => {
  const wrapped = (id) =>
    [
      `## ${id}`,
      '',
      'The behavior the criterion names.',
      '',
      'Test mapping:',
      '- tests/feature.test.mjs —',
      '  the behavior wraps to this line.',
      '- tests/feature.test.mjs —',
      '  and this one wraps too.',
      '',
      'Supersedes:',
      '- None',
      '',
    ].join('\n');
  const defects = lint(t, spec({ sections: [wrapped('AC-1'), wrapped('AC-2')].join('\n') }));
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(defects[0], /at AC-1 lines 8, 10; AC-2 lines 21, 23:/);
});

test('(i) a well-formed bullet with a bad path is still a path defect', (t) => {
  // Rule (i) never covers for rule (e): the shape is right, the path is wrong,
  // and the message is the one the lint always gave.
  const sections = [
    section('AC-1', ['src/feature.spec.mjs — f(2) is 4']),
    section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
  ].join('\n');
  const defects = lint(t, spec({ sections }));
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(defects[0], /the test mapping of AC-1 names src\/feature\.spec\.mjs/);
});

test('(i) a wrapped bullet no longer swallows the mappings under it', (t) => {
  // The silent half of the same defect: the list ended at the first wrapped
  // line, so every rule stopped reading there. The bullets after it are read.
  const sections = [
    [
      '## AC-1',
      '',
      'The behavior the criterion names.',
      '',
      'Test mapping:',
      '- tests/feature.test.mjs —',
      '  the behavior wraps to this line.',
      '- src/late.spec.mjs — f(3) is 6',
      '',
      'Supersedes:',
      '- None',
      '',
    ].join('\n'),
    section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
  ].join('\n');
  const defects = lint(t, spec({ sections }));
  assert.equal(defects.length, 2, defects.join(' | '));
  assert.match(defects[0], /the test mapping of AC-1 names src\/late\.spec\.mjs/);
  assert.match(defects[1], /rewrapped or malformed at AC-1 line 8/);
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

test('(f) a supersede of a file the run itself deleted holds against the base sha', (t) => {
  // The candidate's own implement commit deletes what the criterion supersedes:
  // the worktree has no such file, the base sha does, and the clause is right.
  const gone = section('AC-1', ['tests/feature.test.mjs — f(2) is 4'], {
    supersedes: ['tests/legacy.test.mjs — supersede — AC-1 replaces it'],
  });
  const tail = section('AC-2', ['tests/feature.test.mjs — f("x") throws']);
  const text = spec({ sections: [gone, tail].join('\n') });
  assert.deepEqual(lint(t, text, { baseFiles: ['tests/legacy.test.mjs'] }), []);
});

test('(f) a supersede of a file that never existed still refuses', (t) => {
  const never = section('AC-1', ['tests/feature.test.mjs — f(2) is 4'], {
    supersedes: ['tests/gone.test.mjs — supersede — AC-1 replaces it'],
  });
  const tail = section('AC-2', ['tests/feature.test.mjs — f("x") throws']);
  const text = spec({ sections: [never, tail].join('\n') });
  const defects = lint(t, text, { baseFiles: ['tests/legacy.test.mjs'] });
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(
    defects[0],
    /AC-1 supersedes tests\/gone\.test\.mjs; no such file exists in the worktree or at the spec's base sha\./,
  );
});

test('(f) the lane asks git for the base sha, not the worktree it lints in', async (t) => {
  // The wiring the rule stands on, against a real repository: the run's own
  // commit deletes what the criterion supersedes, and the clause still holds.
  const dir = tempDir('olympus-speclint-base-');
  t.after(() => removeDir(dir));
  initOriginRepo(dir, {
    'src/feature.mjs': 'export {};\n',
    'tests/feature.test.mjs': 'export {};\n',
    'tests/legacy.test.mjs': 'export {};\n',
  });
  const baseSha = gitSync(['rev-parse', 'HEAD'], dir).trim();
  gitSync(['rm', '-q', 'tests/legacy.test.mjs'], dir);
  gitSync(['-c', 'commit.gpgsign=false', 'commit', '-m', 'implement'], dir);
  const specPath = join(dir, 'spec.md');
  const sections = [
    section('AC-1', ['tests/feature.test.mjs — f(2) is 4'], {
      supersedes: ['tests/legacy.test.mjs — supersede — AC-1 replaces it'],
    }),
    section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
  ].join('\n');
  writeFileSync(specPath, spec({ sections }));
  const base = { card, cardPath: CARD_PATH, worktree: dir, testPaths: ['tests'], tier: null, specPath };
  assert.deepEqual(await specLintDefects({ ...base, baseSha }), []);
  // A run with no base sha to read falls back to the worktree, as the rule
  // always did.
  const fallback = await specLintDefects({ ...base, baseSha: null });
  assert.equal(fallback.length, 1, fallback.join(' | '));
  assert.match(fallback[0], /supersedes tests\/legacy\.test\.mjs; no such file exists in the worktree\./);
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
  // Nothing at the path yet is a file the story creates, whatever it is named.
  // The worktree is the only thing here that knows a directory from a file.
  const nameless = [
    '```touched-paths',
    'tests/support/fixtures — dev',
    'tests/feature.test.mjs — suite',
    '```',
  ].join('\n');
  assert.deepEqual(lint(t, spec({ touched: nameless })), []);
});

test('(g) a bracketed route file passes; the directory above it does not', (t) => {
  const file = [
    '```touched-paths',
    'tests/routes/(shop)/[step]/page.test.mjs — dev',
    'tests/feature.test.mjs — suite',
    '```',
  ].join('\n');
  assert.deepEqual(lint(t, spec({ touched: file })), []);
  // A bracketed file the story still has to write passes on its shape alone.
  const fresh = [
    '```touched-paths',
    'tests/routes/(shop)/[slug]/page.test.mjs — dev',
    'tests/feature.test.mjs — suite',
    '```',
  ].join('\n');
  assert.deepEqual(lint(t, spec({ touched: fresh })), []);
  // The rule still holds where it always held.
  const cases = [
    ['tests/routes/(shop)/[step] — dev', /it names a directory in the worktree/],
    ['tests/routes/(shop)/[step]/ — dev', /it ends in a slash/],
    ['tests/routes/(shop)/*/page.test.mjs — dev', /it is a glob/],
    ['tests/routes/(shop)/?/page.test.mjs — dev', /it is a glob/],
  ];
  for (const [line, pattern] of cases) {
    const defects = lint(t, spec({ touched: ['```touched-paths', line, '```'].join('\n') }));
    assert.ok(
      defects.some((d) => pattern.test(d)),
      `${line}: ${defects.join(' | ')}`,
    );
  }
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

// -- (j) every touched path is in the tree, or marked new --------------------

test('(j) a touched path the tree holds passes; one it does not is named with the marker to write', (t) => {
  assert.deepEqual(lint(t, spec(), { ground: groundOf() }), []);
  const touched = ['```touched-paths', 'src/ghost.mjs — dev', 'tests/feature.test.mjs — suite', '```'].join('\n');
  const defects = lint(t, spec({ touched }), { ground: groundOf() });
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(defects[0], /entry src\/ghost\.mjs names no path in the tree at the spec's base sha/);
  assert.match(defects[0], /"src\/ghost\.mjs \(new\) — dev"/);
});

test('(j) the (new) marker admits a path the story creates, and is refused on one that exists', (t) => {
  const created = ['```touched-paths', 'src/ghost.mjs (new) — dev', 'tests/feature.test.mjs — suite', '```'].join('\n');
  assert.deepEqual(lint(t, spec({ touched: created }), { ground: groundOf() }), []);
  const stale = ['```touched-paths', 'src/feature.mjs (new) — dev', 'tests/feature.test.mjs — suite', '```'].join('\n');
  const defects = lint(t, spec({ touched: stale }), { ground: groundOf() });
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(
    defects[0],
    /src\/feature\.mjs \(new\) is marked \(new\), and the tree at the spec's base sha already holds that path; drop the marker/,
  );
});

test('(j) a directory entry resolves through the files under it, and no tree turns the rule off', (t) => {
  const dir = ['```touched-paths', 'src — dev', 'tests/feature.test.mjs — suite', '```'].join('\n');
  assert.deepEqual(lint(t, spec({ touched: dir }), { ground: groundOf() }), []);
  const ghost = ['```touched-paths', 'src/ghost.mjs — dev', 'tests/feature.test.mjs — suite', '```'].join('\n');
  assert.deepEqual(lint(t, spec({ touched: ghost }), { ground: groundOf({ files: null }) }), []);
  assert.deepEqual(lint(t, spec({ touched: ghost })), []);
});

// -- (k) every pin on a touched path is declared, or superseded --------------

test('(k) a test file that mentions a touched path is a pin the spec has to declare or supersede', (t) => {
  const pins = new Map([['src/feature.mjs', ['tests/layout.test.mjs', 'tests/feature.test.mjs']]]);
  const defects = lint(t, spec(), { ground: groundOf({ pins }) });
  // tests/feature.test.mjs is in the block; tests/layout.test.mjs is not.
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(
    defects[0],
    /the spec touches src\/feature\.mjs; the test file tests\/layout\.test\.mjs mentions that path, and the spec neither lists tests\/layout\.test\.mjs in the touched-paths block nor names it in a Supersedes clause\. Declare the pin, or state the supersede\./,
  );
  // Declared in the block: clean.
  const declared = [
    '```touched-paths',
    'src/feature.mjs — dev',
    'tests/feature.test.mjs — suite',
    'tests/layout.test.mjs — suite',
    '```',
  ].join('\n');
  assert.deepEqual(lint(t, spec({ touched: declared }), { ground: groundOf({ pins }) }), []);
  // Named as a supersede target: clean.
  const sections = [
    section('AC-1', ['tests/feature.test.mjs — f(2) is 4'], {
      supersedes: ['tests/layout.test.mjs — supersede — AC-1 moves the module'],
    }),
    section('AC-2', ['tests/feature.test.mjs — f("x") throws']),
  ].join('\n');
  assert.deepEqual(
    lint(t, spec({ sections }), { ground: groundOf({ pins }), baseFiles: ['tests/layout.test.mjs'] }),
    [],
  );
  // No pin map turns the rule off.
  assert.deepEqual(lint(t, spec(), { ground: groundOf({ pins: null }) }), []);
});

// -- (l) every route id resolves under the routes root, or is marked new -----

test('(l) a route id in prose resolves to a directory under the routes root', (t) => {
  const held = spec({
    environment:
      '## Environment\n\nThe shop lives at `/[lang=lang]/shop` and orders at /[lang=lang]/(account)/orders.',
  });
  assert.deepEqual(lint(t, held, { ground: groundOf() }), []);
  const phantom = spec({
    environment: '## Environment\n\nThe cart lives at `/[lang=lang]/cart` (see `/[lang=lang]/cart`).',
  });
  const defects = lint(t, phantom, { ground: groundOf() });
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(
    defects[0],
    /the spec names the route \/\[lang=lang\]\/cart, and no such path exists under routes at the spec's base sha; a route the story creates is written `\/\[lang=lang\]\/cart` \(new\)\./,
  );
});

test('(l) the (new) marker admits a route the story creates, and is refused on one that exists', (t) => {
  const created = spec({ environment: '## Environment\n\nThe cart lives at `/[lang=lang]/cart` (new).' });
  assert.deepEqual(lint(t, created, { ground: groundOf() }), []);
  const stale = spec({ environment: '## Environment\n\nThe shop lives at `/[lang=lang]/shop` (new).' });
  const defects = lint(t, stale, { ground: groundOf() });
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(
    defects[0],
    /marks the route \/\[lang=lang\]\/shop \(new\), and routes\/\[lang=lang\]\/shop already exists/,
  );
});

test('(l) a repository path through the routes root is not a route id, and a missing root turns the rule off', (t) => {
  const path = spec({
    environment:
      '## Environment\n\nThe file routes/[lang=lang]/cart/+page.svelte is new; see also apps/routes/[x]/y.',
  });
  assert.deepEqual(lint(t, path, { ground: groundOf() }), []);
  const phantom = spec({ environment: '## Environment\n\nThe cart lives at `/[lang=lang]/cart`.' });
  assert.deepEqual(lint(t, phantom, { ground: groundOf({ routesRoot: null }) }), []);
  assert.deepEqual(lint(t, phantom, { ground: groundOf({ routesRoot: 'web/routes' }) }), []);
});

test('(j)(k)(l) the lane reads the tree at the base sha, the pins under the test paths, and the routes root', async (t) => {
  // The wiring the three rules stand on, against a real repository.
  const dir = tempDir('olympus-speclint-ground-');
  t.after(() => removeDir(dir));
  initOriginRepo(dir, {
    'src/feature.mjs': 'export {};\n',
    'tests/feature.test.mjs': 'export {};\n',
    'tests/layout.test.mjs': "import { existsSync } from 'node:fs';\nexistsSync('src/feature.mjs');\n",
    'routes/[lang=lang]/shop/+page.svelte': '<h1>shop</h1>\n',
  });
  const baseSha = gitSync(['rev-parse', 'HEAD'], dir).trim();
  // The run's own commit adds the file the spec calls new and removes the
  // pin: the rules read the base sha, not the worktree.
  writeFileSync(join(dir, 'src', 'ghost.mjs'), 'export {};\n');
  gitSync(['rm', '-q', 'tests/layout.test.mjs'], dir);
  gitSync(['add', '-A'], dir);
  gitSync(['-c', 'commit.gpgsign=false', 'commit', '-m', 'implement'], dir);
  const specPath = join(dir, 'spec.md');
  const touched = [
    '```touched-paths',
    'src/feature.mjs — dev',
    'src/ghost.mjs (new) — dev',
    'tests/feature.test.mjs — suite',
    '```',
  ].join('\n');
  const environment =
    '## Environment\n\nThe shop is `/[lang=lang]/shop`; the cart `/[lang=lang]/cart` (new).';
  writeFileSync(specPath, spec({ touched, environment }));
  const base = {
    card,
    cardPath: CARD_PATH,
    worktree: dir,
    testPaths: ['tests'],
    tier: null,
    specPath,
    routesRoot: 'routes',
  };
  const defects = await specLintDefects({ ...base, baseSha });
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(defects[0], /the test file tests\/layout\.test\.mjs mentions that path/);
  // Declared, the spec is clean against the same tree.
  const declared = touched.replace('\n```', '\ntests/layout.test.mjs — suite\n```');
  writeFileSync(specPath, spec({ touched: declared, environment }));
  assert.deepEqual(await specLintDefects({ ...base, baseSha }), []);
  // No base sha reads the worktree's index: the ghost exists there and the pin
  // is gone, so the marker is stale and the declared pin names no path.
  const fallback = await specLintDefects({ ...base, baseSha: null });
  assert.equal(fallback.length, 2, fallback.join(' | '));
  assert.match(fallback[0], /src\/ghost\.mjs \(new\) is marked \(new\), and the tree/);
  assert.match(fallback[1], /entry tests\/layout\.test\.mjs names no path in the tree/);
  // A worktree that is no repository turns the three rules off.
  const plain = tempDir('olympus-speclint-plain-');
  t.after(() => removeDir(plain));
  writeFileSync(join(plain, 'spec.md'), spec({ touched, environment }));
  assert.deepEqual(
    await specLintDefects({ ...base, worktree: plain, specPath: join(plain, 'spec.md'), baseSha: null }),
    [],
  );
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

// -- the amended set ---------------------------------------------------------

const AMEND_BASE = spec();

test('the amended set names the criterion section whose text moved', () => {
  const moved = AMEND_BASE.replace(
    'The behavior the criterion names.\n\nTest mapping:\n- tests/feature.test.mjs — f(2) is 4',
    'The behavior the criterion names, grounded in src/feature.mjs.\n\nTest mapping:\n- tests/feature.test.mjs — f(2) is 4',
  );
  assert.notEqual(moved, AMEND_BASE);
  assert.deepEqual(amendedSections(AMEND_BASE, moved, { card }), ['AC-1']);
});

test('the amended set names the touched-paths block and the environment section', () => {
  const touched = AMEND_BASE.replace('src/feature.mjs — dev', 'src/doubler.mjs — dev');
  assert.deepEqual(amendedSections(AMEND_BASE, touched, { card }), ['touched-paths']);
  const environment = AMEND_BASE.replace(
    '## Environment\n\nNone.',
    '## Environment\n\nFACTOR_MODE, which the card names.',
  );
  assert.deepEqual(amendedSections(AMEND_BASE, environment, { card }), ['environment']);
});

test('an untouched part is absent from the amended set', () => {
  assert.deepEqual(amendedSections(AMEND_BASE, AMEND_BASE, { card }), []);
  // Blank lines and trailing whitespace are not an amendment.
  const reflowed = AMEND_BASE.replaceAll('\n\n', '\n\n\n').replaceAll(
    'Named constants:',
    'Named constants:   ',
  );
  assert.deepEqual(amendedSections(AMEND_BASE, reflowed, { card }), []);
});

test('the amended set runs in card order, then touched paths, then environment', () => {
  const moved = spec({
    sections: [
      section('AC-1', ['tests/feature.test.mjs — f(2) is 4.0']),
      section('AC-2', ['tests/feature.test.mjs — f("x") raises']),
    ].join('\n'),
    touched: ['```touched-paths', 'src/doubler.mjs — dev', '```'].join('\n'),
    environment: '## Environment\n\nFACTOR_MODE.',
  });
  assert.deepEqual(amendedSections(AMEND_BASE, moved, { card }), [
    'AC-1',
    'AC-2',
    'touched-paths',
    'environment',
  ]);
});

test('a part only one version carries counts as moved', () => {
  const dropped = spec({ sections: section('AC-1', ['tests/feature.test.mjs — f(2) is 4']) });
  assert.deepEqual(amendedSections(AMEND_BASE, dropped, { card }), ['AC-2']);
  const blockless = AMEND_BASE.replace(
    ['```touched-paths', 'src/feature.mjs — dev', 'tests/feature.test.mjs — suite', '```'].join('\n'),
    '',
  );
  assert.deepEqual(amendedSections(AMEND_BASE, blockless, { card }), ['touched-paths']);
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

// -- (m) every component the spec names exists, or is marked new -------------

test('(m) the components root is read as folder-per-component', () => {
  const held = componentIndex(TREE_FILES, 'ui');
  assert.deepEqual([...held].sort(), ['PriceTag', 'QuantityStepper']);
  // A file that is not its directory's namesake is not a component, and a
  // root the caller turns off answers nothing at all.
  assert.deepEqual([...componentIndex(['ui/PriceTag/helpers.ts'], 'ui')], []);
  assert.equal(componentIndex(TREE_FILES, null), null);
});

test('(m) a component the design system does not hold is named', (t) => {
  const held = spec({ components: ['`PriceTag`', '`QuantityStepper`'] });
  assert.deepEqual(lint(t, held, { ground: groundOf() }), []);
  const phantom = spec({ components: ['`PriceTag`', '`RadioField`'] });
  const defects = lint(t, phantom, { ground: groundOf() });
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(
    defects[0],
    /the spec's Components section names RadioField, and no component of that name exists under ui at the spec's base sha; a component the story creates is written `RadioField` \(new\)\./,
  );
});

test('(m) the (new) marker admits a component the story creates, and is refused on one that exists', (t) => {
  const created = spec({ components: ['`RadioField` (new)'] });
  assert.deepEqual(lint(t, created, { ground: groundOf() }), []);
  const stale = spec({ components: ['`PriceTag` (new)'] });
  const defects = lint(t, stale, { ground: groundOf() });
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(defects[0], /marks the component PriceTag \(new\), and ui already holds it/);
});

test('(m) "None" answers the section, and no components root turns the rule off', (t) => {
  // A story that renders nothing writes the section as None. A project that
  // names no root, or names one its tree does not hold, gets no rule at all —
  // and then the section is not required either.
  assert.deepEqual(lint(t, spec({ components: ['None.'] }), { ground: groundOf() }), []);
  const phantom = spec({ components: ['`RadioField`'] });
  assert.deepEqual(lint(t, phantom, { ground: groundOf({ componentsRoot: null }) }), []);
  assert.deepEqual(lint(t, phantom, { ground: groundOf({ componentsRoot: 'web/ui' }) }), []);
  assert.deepEqual(lint(t, spec({ components: null }), { ground: groundOf({ componentsRoot: null }) }), []);
});

test('(m) a spec with no Components section, or an empty one, has not made the claim', (t) => {
  // The section carries a rule and it carries "- None." for the empty case, so
  // silence is not an answer: a rule that read an absent section as "renders
  // nothing" would be a rule every spec could skip.
  const absent = lint(t, spec({ components: null }), { ground: groundOf() });
  assert.equal(absent.length, 1, absent.join(' | '));
  assert.match(absent[0], /the spec has no Components section; the template takes one/);
  const empty = lint(t, spec({ components: [] }), { ground: groundOf() });
  assert.equal(empty.length, 1, empty.join(' | '));
  assert.match(empty[0], /Components section lists nothing; write one item per design-system/);
});

test('(m) a bullet the entry shape does not fit is a defect naming the line', (t) => {
  // The three shapes that would otherwise pass a rule that skipped what it
  // could not parse: a path, two names on one line, and a dotted name.
  const bad = spec({ components: ['`forms/RadioField`', '`PriceTag` `QuantityStepper`', 'ui.RadioField'] });
  const defects = lint(t, bad, { ground: groundOf() });
  assert.equal(defects.length, 3, defects.join(' | '));
  assert.match(defects[0], /carries "`forms\/RadioField`" on line \d+, which is not a component entry/);
  assert.match(defects[1], /carries "`PriceTag` `QuantityStepper`" on line \d+/);
  assert.match(defects[2], /carries "ui\.RadioField" on line \d+/);
  // Every message states the shape the template asks for.
  for (const defect of defects) assert.match(defect, /one component name on one line/);
});

test('(m) the lane reads the components root from the tree at the base sha', async (t) => {
  const dir = tempDir('olympus-speclint-components-');
  t.after(() => removeDir(dir));
  initOriginRepo(dir, {
    'src/feature.mjs': 'export {};\n',
    'tests/feature.test.mjs': 'export {};\n',
    'ui/PriceTag/PriceTag.svelte': '<span />\n',
  });
  const baseSha = gitSync(['rev-parse', 'HEAD'], dir).trim();
  const specPath = join(dir, 'spec.md');
  const base = {
    card,
    cardPath: CARD_PATH,
    worktree: dir,
    testPaths: ['tests'],
    tier: null,
    specPath,
    routesRoot: null,
    componentsRoot: 'ui',
    baseSha,
  };
  writeFileSync(specPath, spec({ components: ['`PriceTag`', '`RadioField`'] }));
  const defects = await specLintDefects(base);
  assert.equal(defects.length, 1, defects.join(' | '));
  assert.match(defects[0], /names RadioField, and no component of that name exists under ui/);
  writeFileSync(specPath, spec({ components: ['`PriceTag`', '`RadioField` (new)'] }));
  assert.deepEqual(await specLintDefects(base), []);
  // A project that names no components root gets no rule (m), section or no
  // section.
  writeFileSync(specPath, spec({ components: null }));
  assert.deepEqual(await specLintDefects({ ...base, componentsRoot: null }), []);
});

test('the components section is an amended part of its own', () => {
  const before = spec({ components: ['`PriceTag`'] });
  const after = spec({ components: ['`PriceTag`', '`RadioField` (new)'] });
  assert.deepEqual(amendedSections(before, after, { card }), ['components']);
});
