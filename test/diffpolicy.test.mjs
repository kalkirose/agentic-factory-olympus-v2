// The diff-policy gate's judgment, apart from the lane that runs it: the
// touched-paths contract, the three tiers, and the config that declares them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureGist,
  diffPolicyViolations,
  laneDiffPolicy,
  parseTouchedPaths,
  violationLine,
} from '../src/seats/diffpolicy.mjs';
import { validateProjectConfig, withProjectDefaults } from '../src/config/project.mjs';
import { LOUD_EVENTS, RUN_EVENTS } from '../src/ledger/registry.mjs';
import { RESOLVABLE_EVENTS } from '../src/telemetry/stores.mjs';
import { deriveRunState } from '../src/engine/replay.mjs';

const SPEC = `# Story

Some prose naming packages/contracts/prose-only.ts, which declares nothing.

\`\`\`touched-paths
apps/web/src/checkout.ts — dev
packages/contracts/order.ts
# a comment line

apps/web/package.json
\`\`\`

Closing prose.
`;

function errorPaths(config) {
  return validateProjectConfig(config).map((e) => e.path);
}

function baseConfig(extra) {
  return {
    version: 1,
    commands: { test: ['node', '--test'] },
    gates: { tier1: [{ name: 'unit', command: 'test' }] },
    ...extra,
  };
}

// -- the touched-paths contract ----------------------------------------------

test('the touched-paths block declares its paths, and prose declares nothing', () => {
  assert.deepEqual(parseTouchedPaths(SPEC), [
    'apps/web/src/checkout.ts',
    'packages/contracts/order.ts',
    'apps/web/package.json',
  ]);
});

test('an absent block declares nothing', () => {
  assert.deepEqual(parseTouchedPaths('# Story\n\nNo block here.\n'), []);
  assert.deepEqual(parseTouchedPaths(''), []);
  assert.deepEqual(parseTouchedPaths(undefined), []);
});

test('a block left unterminated declares nothing', () => {
  const malformed = '# Story\n\n```touched-paths\napps/web/src/checkout.ts\n\nNo closing fence.\n';
  assert.deepEqual(parseTouchedPaths(malformed), []);
});

test('a second block adds to the first, and CRLF text parses the same', () => {
  const two = SPEC + '\n```touched-paths\napps/api/handler.ts\n```\n';
  assert.deepEqual(parseTouchedPaths(two).at(-1), 'apps/api/handler.ts');
  assert.deepEqual(parseTouchedPaths(SPEC.replaceAll('\n', '\r\n')), parseTouchedPaths(SPEC));
});

test('a backslash path normalizes, and an owner suffix drops', () => {
  const text = '```touched-paths\napps\\web\\src\\a.ts — platform\n```\n';
  assert.deepEqual(parseTouchedPaths(text), ['apps/web/src/a.ts']);
});

// -- the tiers ---------------------------------------------------------------

const TIER = {
  deniedPaths: ['.github/**', '.npmrc', 'scripts/**', '**/vitest*.config.*'],
  declaredPaths: ['**/package.json', 'packages/contracts/**'],
  forbiddenPatterns: ['-win32\\.', '\\.env'],
};

const declares = (path) => parseTouchedPaths(SPEC).includes(path);

test('no tier admits every change: the feature is off', () => {
  const changed = ['.npmrc', '.github/workflows/pr.yml', 'apps/web/a-win32.png'];
  assert.deepEqual(diffPolicyViolations(changed, null, declares), []);
  assert.deepEqual(diffPolicyViolations(changed, undefined), []);
});

test('deniedPaths blocks a path the lane may never ship', () => {
  const v = diffPolicyViolations(
    ['.npmrc', '.github/workflows/pr.yml', 'scripts/gate.mjs', 'apps/web/vitest.config.ts'],
    TIER,
    declares,
  );
  assert.deepEqual(
    v.map((x) => [x.path, x.rule]),
    [
      ['.npmrc', 'denied'],
      ['.github/workflows/pr.yml', 'denied'],
      ['scripts/gate.mjs', 'denied'],
      ['apps/web/vitest.config.ts', 'denied'],
    ],
  );
  assert.match(violationLine(v[0]), /denies this path to this lane \(deniedPaths: \.npmrc\)/);
});

test('deniedPaths passes an ordinary source path', () => {
  assert.deepEqual(diffPolicyViolations(['apps/web/src/checkout.ts'], TIER, declares), []);
});

test('declaredPaths passes a declared path and blocks an undeclared one', () => {
  assert.deepEqual(diffPolicyViolations(['apps/web/package.json'], TIER, declares), []);
  assert.deepEqual(diffPolicyViolations(['packages/contracts/order.ts'], TIER, declares), []);
  const v = diffPolicyViolations(['apps/api/package.json', 'packages/contracts/other.ts'], TIER, declares);
  assert.deepEqual(
    v.map((x) => [x.path, x.rule, x.pattern]),
    [
      ['apps/api/package.json', 'undeclared', '**/package.json'],
      ['packages/contracts/other.ts', 'undeclared', 'packages/contracts/**'],
    ],
  );
  assert.match(violationLine(v[0]), /only when the spec declares it/);
});

test('a path named in prose only stays undeclared', () => {
  const v = diffPolicyViolations(['packages/contracts/prose-only.ts'], TIER, declares);
  assert.deepEqual(v.map((x) => x.rule), ['undeclared']);
});

test('the repair lane declares by verbatim ticket text', () => {
  const ticket = '## Defect\n\nThe order total is wrong in packages/contracts/order.ts.\n';
  const names = (path) => ticket.includes(path);
  assert.deepEqual(diffPolicyViolations(['packages/contracts/order.ts'], TIER, names), []);
  assert.deepEqual(
    diffPolicyViolations(['packages/contracts/other.ts'], TIER, names).map((x) => x.rule),
    ['undeclared'],
  );
});

test('forbiddenPatterns blocks a path shape always, declared or not', () => {
  const v = diffPolicyViolations(
    ['apps/web/tests/shot-win32.png', 'apps/web/.env.local', 'packages/contracts/.env'],
    TIER,
    () => true,
  );
  assert.deepEqual(
    v.map((x) => [x.path, x.rule]),
    [
      ['apps/web/tests/shot-win32.png', 'forbidden'],
      ['apps/web/.env.local', 'forbidden'],
      ['packages/contracts/.env', 'forbidden'],
    ],
  );
  assert.match(violationLine(v[0]), /forbids this path shape/);
});

test('a denied path reports as denied even when another tier also matches', () => {
  const tier = { deniedPaths: ['scripts/**'], forbiddenPatterns: ['\\.env'] };
  assert.deepEqual(diffPolicyViolations(['scripts/.env'], tier).map((x) => x.rule), ['denied']);
});

test('a backslash path is judged as its slash form', () => {
  assert.deepEqual(diffPolicyViolations(['.github\\workflows\\pr.yml'], TIER).map((x) => x.rule), [
    'denied',
  ]);
});

test('the gist names the count and the first paths', () => {
  const gist = captureGist({
    violations: [{ path: '.npmrc' }, { path: 'scripts/a.mjs' }],
    dropped: ['tests/a.test.mjs'],
  });
  assert.match(gist, /2 path\(s\) the diff policy blocks and 1 path\(s\) the capture took back/);
  assert.match(gist, /\.npmrc, scripts\/a\.mjs, tests\/a\.test\.mjs/);
});

// -- the project-config block ------------------------------------------------

test('laneDiffPolicy reads the lane, and an absent block reads null', () => {
  const config = withProjectDefaults(baseConfig({ diffPolicy: { story: TIER } }));
  assert.equal(laneDiffPolicy(config, 'story'), TIER);
  assert.equal(laneDiffPolicy(config, 'repair'), null);
  assert.equal(laneDiffPolicy(withProjectDefaults(baseConfig()), 'story'), null);
});

test('an absent diffPolicy block is valid and defaults to no lanes', () => {
  assert.deepEqual(validateProjectConfig(baseConfig()), []);
  assert.deepEqual(withProjectDefaults(baseConfig()).diffPolicy, {});
});

test('a well-formed diffPolicy block validates', () => {
  const config = baseConfig({
    diffPolicy: { story: TIER, repair: { deniedPaths: ['.olympus/**'], forbiddenPatterns: ['\\.env'] } },
  });
  assert.deepEqual(validateProjectConfig(config), []);
  assert.deepEqual(withProjectDefaults(config).diffPolicy.repair.deniedPaths, ['.olympus/**']);
});

test('diffPolicy rejects an unknown lane, an unknown tier, and a bad shape', () => {
  assert.deepEqual(errorPaths(baseConfig({ diffPolicy: [] })), ['diffPolicy']);
  assert.deepEqual(errorPaths(baseConfig({ diffPolicy: { ship: {} } })), ['diffPolicy.ship']);
  assert.deepEqual(errorPaths(baseConfig({ diffPolicy: { story: 'no' } })), ['diffPolicy.story']);
  assert.deepEqual(errorPaths(baseConfig({ diffPolicy: { story: { deniedPath: ['a'] } } })), [
    'diffPolicy.story.deniedPath',
  ]);
  assert.deepEqual(errorPaths(baseConfig({ diffPolicy: { story: { deniedPaths: [''] } } })), [
    'diffPolicy.story.deniedPaths',
  ]);
  assert.deepEqual(errorPaths(baseConfig({ diffPolicy: { story: { declaredPaths: 'x' } } })), [
    'diffPolicy.story.declaredPaths',
  ]);
});

test('diffPolicy rejects a forbiddenPatterns entry that is not a regular expression', () => {
  assert.deepEqual(errorPaths(baseConfig({ diffPolicy: { story: { forbiddenPatterns: ['(['] } } })), [
    'diffPolicy.story.forbiddenPatterns[0]',
  ]);
  assert.deepEqual(errorPaths(baseConfig({ diffPolicy: { story: { forbiddenPatterns: [3] } } })), [
    'diffPolicy.story.forbiddenPatterns',
  ]);
});

// -- the ledger record -------------------------------------------------------

test('the capture record is a known run event, loud, and resolvable', () => {
  assert.ok(RUN_EVENTS.has('diff-policy-violation'));
  assert.ok(LOUD_EVENTS.has('diff-policy-violation'));
  assert.ok(RESOLVABLE_EVENTS.has('diff-policy-violation'));
});

test('replay ignores the capture record: a blocked capture is not a run violation', () => {
  const events = [
    { seq: 1, event: 'run-launched', project: 'p', lane: 'story', worktree: '/w' },
    { seq: 2, event: 'stage-entered', stage: 'implementation' },
    { seq: 3, event: 'diff-policy-violation', seat: 'dev', violations: [], dropped: ['tests/a.mjs'] },
  ];
  const state = deriveRunState(events);
  assert.equal(state.violated, false);
  assert.equal(state.stage, 'implementation');
  assert.equal(state.closed, null);
  // An unresolved liveness violation still reads as one; the two never mix.
  const live = deriveRunState([...events, { seq: 4, event: 'liveness-violation' }]);
  assert.equal(live.violated, true);
});
