// The diff-policy gate's judgment, apart from the lane that runs it: the
// touched-paths contract, the three tiers, and the config that declares them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DROP_NOTE,
  RECAPTURE_NOTE,
  captureGist,
  classifyTakeBacks,
  diffPolicyViolations,
  dropLine,
  laneDiffPolicy,
  namesOnlyRecapturable,
  parseTouchedPaths,
  pathTokens,
  recaptureGist,
  recaptureLine,
  SWEEP_NOTE,
  SWEPT_PATHS,
  sweepCandidates,
  sweepGist,
  sweptTakeBacks,
  violationLine,
} from '../src/seats/diffpolicy.mjs';
import { validateProjectConfig, withProjectDefaults } from '../src/config/project.mjs';
import { CLOSE_RESOLVED_EVENTS, LOUD_EVENTS, RUN_EVENTS } from '../src/ledger/registry.mjs';
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

test('a declared route path matches the changed file literally, tier globs still glob', () => {
  const routes = `\`\`\`touched-paths
apps/web/src/routes/(shop)/checkout/[step]/+page.server.ts — dev
\`\`\`
`;
  const declaredHere = (path) => parseTouchedPaths(routes).includes(path);
  const tier = { deniedPaths: ['**/*.snap'], declaredPaths: ['apps/web/src/routes/**'] };
  assert.deepEqual(
    diffPolicyViolations(
      ['apps/web/src/routes/(shop)/checkout/[step]/+page.server.ts'],
      tier,
      declaredHere,
    ),
    [],
  );
  // The entry is a path, not a character class: a sibling the entry would
  // match as a glob is still undeclared.
  assert.deepEqual(
    diffPolicyViolations(
      ['apps/web/src/routes/(shop)/checkout/s/+page.server.ts'],
      tier,
      declaredHere,
    ).map((v) => v.rule),
    ['undeclared'],
  );
  // The config tier keeps its glob reading over the same bracketed path.
  assert.deepEqual(
    diffPolicyViolations(
      ['apps/web/src/routes/(shop)/checkout/[step]/page.snap'],
      tier,
      declaredHere,
    ).map((v) => [v.rule, v.pattern]),
    [['denied', '**/*.snap']],
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
  assert.match(
    gist,
    /2 path\(s\) the diff policy blocks and 1 frozen path\(s\) the capture reverted/,
  );
  assert.match(gist, /\.npmrc, scripts\/a\.mjs, tests\/a\.test\.mjs/);
});

test('the take-back line states the freeze, the revert, and the re-freeze route', () => {
  const line = dropLine('tests/visual/checkout.png');
  assert.match(line, /^tests\/visual\/checkout\.png: this path is frozen for this lane\./);
  assert.match(line, /The capture reverted the write, and it ships from no implementation seat\./);
  assert.match(line, /the verdict routes that change through a re-freeze/);
  assert.match(line, /do not write the file again\./);
  // The old wording told the seat its work was still owed, which is the one
  // thing a frozen path never asks of the seat that wrote it.
  assert.doesNotMatch(line, /unfixed/);
  assert.doesNotMatch(line, /meant to fix/);
  assert.match(DROP_NOTE, /never\s+through an implementation seat/);
  assert.doesNotMatch(DROP_NOTE, /unfixed/);
});

// -- the re-capturable class -------------------------------------------------

const SHOT = 'apps/web/tests/visual/__screenshots__/checkout.png';
const RECAP = { recapturablePaths: ['**/__screenshots__/**', 'tests/fixtures/recorded'] };

test('a declared re-capturable take-back is the quiet class, everything else is held', () => {
  const split = classifyTakeBacks([SHOT, 'tests/fixtures/recorded/cart.json', 'tests/cart.test.mjs'], RECAP);
  assert.deepEqual(split.recaptured, [
    { path: SHOT, pattern: '**/__screenshots__/**' },
    { path: 'tests/fixtures/recorded/cart.json', pattern: 'tests/fixtures/recorded' },
  ]);
  assert.deepEqual(split.held, ['tests/cart.test.mjs']);
});

test('an undeclared class quiets nothing: no entries, no tier at all', () => {
  const dropped = [SHOT, 'tests/cart.test.mjs'];
  for (const tier of [null, undefined, {}, { deniedPaths: ['scripts/**'] }]) {
    const split = classifyTakeBacks(dropped, tier);
    assert.deepEqual(split.recaptured, []);
    assert.deepEqual(split.held, dropped);
  }
});

test('the hard tiers outrank the class: a denied or forbidden take-back stays loud', () => {
  // Tamper protection is the reason the gate exists. A project that widens its
  // re-capturable glob over a path it also denies quiets nothing.
  const tier = {
    deniedPaths: ['**/vitest*.config.*'],
    forbiddenPatterns: ['-win32\\.'],
    recapturablePaths: ['**/__screenshots__/**', 'tests/**'],
  };
  const split = classifyTakeBacks(
    ['tests/vitest.config.ts', 'apps/web/tests/visual/__screenshots__/shot-win32.png', SHOT],
    tier,
  );
  assert.deepEqual(split.recaptured.map((r) => r.path), [SHOT]);
  assert.deepEqual(split.held, [
    'tests/vitest.config.ts',
    'apps/web/tests/visual/__screenshots__/shot-win32.png',
  ]);
});

test('a backslash take-back is classed as its slash form', () => {
  const split = classifyTakeBacks([SHOT.replaceAll('/', '\\')], RECAP);
  assert.deepEqual(split.recaptured.map((r) => r.path), [SHOT]);
});

test('the re-capturable line names the class, the revert, and the re-freeze', () => {
  const line = recaptureLine({ path: SHOT, pattern: '**/__screenshots__/**' });
  assert.match(line, /^apps\/web\/tests\/visual\/__screenshots__\/checkout\.png: a re-capturable frozen path/);
  assert.match(line, /recapturablePaths: \*\*\/__screenshots__\/\*\*/);
  assert.match(line, /the verdict's re-freeze re-takes this artifact/);
  // It asks the seat for nothing, exactly like the loud take-back line.
  assert.doesNotMatch(line, /unfixed/);
  assert.doesNotMatch(line, /Restore it/);
  assert.match(RECAPTURE_NOTE, /a record and not an open item/);
  assert.match(recaptureGist([{ path: SHOT }]), /1 re-capturable frozen path\(s\) the capture reverted/);
});

// -- the sweep ---------------------------------------------------------------

test('a generated file the freeze never held is swept; a frozen baseline is not', () => {
  // The two halves of the rule. The glob says where a runner drops output; the
  // freeze says whether the file under it is an artifact or committed work.
  const dropped = [SHOT, 'tests/cart.test.mjs'];
  assert.deepEqual(sweptTakeBacks(dropped, RECAP, []), [SHOT]);
  assert.deepEqual(sweptTakeBacks(dropped, RECAP, [SHOT]), []);
  assert.deepEqual(sweptTakeBacks(dropped, RECAP, new Set([SHOT])), []);
});

test('the sweep default holds where a lane declares nothing, and an empty list turns it off', () => {
  assert.deepEqual(SWEPT_PATHS, ['**/__screenshots__/**']);
  for (const tier of [null, undefined, {}, RECAP]) {
    assert.deepEqual(sweptTakeBacks([SHOT, 'tests/cart.test.mjs'], tier, []), [SHOT]);
  }
  assert.deepEqual(sweptTakeBacks([SHOT], { sweptPaths: [] }, []), []);
  // A lane that names its own directories replaces the default outright.
  assert.deepEqual(sweptTakeBacks([SHOT, 'tests/out/run.json'], { sweptPaths: ['tests/out'] }, []), [
    'tests/out/run.json',
  ]);
});

test('the hard tiers outrank the sweep, exactly as they outrank the quiet class', () => {
  const tier = {
    deniedPaths: ['**/vitest*.config.*'],
    forbiddenPatterns: ['-win32\\.'],
    sweptPaths: ['**/__screenshots__/**', 'tests/**'],
  };
  const dropped = [
    'tests/vitest.config.ts',
    'apps/web/tests/visual/__screenshots__/shot-win32.png',
    SHOT,
  ];
  assert.deepEqual(sweptTakeBacks(dropped, tier, []), [SHOT]);
  // The candidate list answers the same way before the freeze is consulted.
  assert.deepEqual(sweepCandidates(dropped, tier), [SHOT]);
});

test('a backslash path is swept as its slash form', () => {
  const windows = SHOT.replaceAll('/', '\\');
  assert.deepEqual(sweptTakeBacks([windows], RECAP, []), [windows]);
  assert.deepEqual(sweptTakeBacks([windows], RECAP, [SHOT]), []);
});

test('the sweep record states what it cleared and asks for nothing', () => {
  assert.match(SWEEP_NOTE, /Generated artifacts cleared from frozen paths/);
  assert.match(SWEEP_NOTE, /took nothing back by removing them/);
  assert.doesNotMatch(SWEEP_NOTE, /Restore it/);
  assert.match(sweepGist([SHOT]), /^1 generated file\(s\) the capture swept from frozen paths: /);
});

// -- reading the class back out of prose -------------------------------------

const SHOT_DIR = 'apps/web/tests/visual/__screenshots__';
const TAKEN = {
  recaptured: [
    { path: `${SHOT_DIR}/checkout-1.png`, pattern: '**/__screenshots__/**' },
    { path: `${SHOT_DIR}/checkout-2.png`, pattern: '**/__screenshots__/**' },
  ],
  held: [],
};

test('a sentence names the paths it is about, and nothing that only looks like one', () => {
  assert.deepEqual(pathTokens(`the write to ${SHOT}, reverted`), [SHOT]);
  assert.deepEqual(pathTokens(`windows wrote apps\\web\\shot.png`), ['apps/web/shot.png']);
  // A rule name and a fraction have a separator in them and no path around it;
  // a bare separator between two words is not a path at all.
  assert.deepEqual(pathTokens('constitution 5 / ADR-041 asks for 2 / 3 of it'), []);
  assert.deepEqual(pathTokens('@typescript-eslint/no-unused-vars fired'), [
    '@typescript-eslint/no-unused-vars',
  ]);
  assert.deepEqual(pathTokens(undefined), []);
});

test('a finding about the quiet class reads as the quiet class, named whole or by folder', () => {
  // The seat names the directory the files sit in far more often than it names
  // the files, and both readings answer to the same surface.
  assert.equal(namesOnlyRecapturable(`stale PNGs under ${SHOT_DIR} churn the capture`, TAKEN), true);
  assert.equal(namesOnlyRecapturable(`the write to ${TAKEN.recaptured[0].path} came back`, TAKEN), true);
  // A path beside the recaptured ones, in a directory of its own, is nobody's
  // take-back and settles nothing on its own.
  assert.equal(namesOnlyRecapturable(`${SHOT_DIR} and apps/web/src/checkout.ts`, TAKEN), true);
});

test('a held take-back in the same sentence keeps the loud reading', () => {
  const mixed = { ...TAKEN, held: ['tests/cart.test.mjs'] };
  assert.equal(
    namesOnlyRecapturable(`${SHOT_DIR} churned, and tests/cart.test.mjs was relaxed`, mixed),
    false,
  );
  assert.equal(namesOnlyRecapturable(`${SHOT_DIR} churned`, mixed), true);
});

test('prose that names no take-back of this run is not about a take-back', () => {
  assert.equal(namesOnlyRecapturable('the PR misses its migration label', TAKEN), false);
  assert.equal(namesOnlyRecapturable(`stale PNGs under ${SHOT_DIR}`, { recaptured: [], held: [] }), false);
  assert.equal(namesOnlyRecapturable(`stale PNGs under ${SHOT_DIR}`), false);
  // A near-miss is a miss: the surface is a sibling directory, not this one.
  assert.equal(
    namesOnlyRecapturable('apps/web/tests/visual/__snapshots__ churned', TAKEN),
    false,
  );
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

test('a lane declares the re-capturable class in the same block, and alone', () => {
  const config = baseConfig({ diffPolicy: { story: { recapturablePaths: ['**/__screenshots__/**'] } } });
  assert.deepEqual(validateProjectConfig(config), []);
  assert.deepEqual(withProjectDefaults(config).diffPolicy.story, {
    recapturablePaths: ['**/__screenshots__/**'],
  });
  assert.deepEqual(errorPaths(baseConfig({ diffPolicy: { story: { recapturablePaths: 'x' } } })), [
    'diffPolicy.story.recapturablePaths',
  ]);
  assert.deepEqual(errorPaths(baseConfig({ diffPolicy: { story: { recapturablePath: ['a'] } } })), [
    'diffPolicy.story.recapturablePath',
  ]);
});

test('a lane declares where a test run drops its output, in the same block', () => {
  const config = baseConfig({ diffPolicy: { story: { sweptPaths: ['**/__screenshots__/**'] } } });
  assert.deepEqual(validateProjectConfig(config), []);
  assert.deepEqual(withProjectDefaults(config).diffPolicy.story, {
    sweptPaths: ['**/__screenshots__/**'],
  });
  // An empty list is the lane saying it sweeps nothing, and validates.
  assert.deepEqual(validateProjectConfig(baseConfig({ diffPolicy: { story: { sweptPaths: [] } } })), []);
  assert.deepEqual(errorPaths(baseConfig({ diffPolicy: { story: { sweptPaths: 'x' } } })), [
    'diffPolicy.story.sweptPaths',
  ]);
  assert.deepEqual(errorPaths(baseConfig({ diffPolicy: { story: { sweptPath: ['a'] } } })), [
    'diffPolicy.story.sweptPath',
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

test('the re-capturable record is a known run event, and it is quiet', () => {
  assert.ok(RUN_EVENTS.has('diff-policy-recapture'));
  // Quiet is the whole point: no loud stream, so nothing to resolve and
  // nothing for the run to pair at close.
  assert.ok(!LOUD_EVENTS.has('diff-policy-recapture'));
  assert.ok(!RESOLVABLE_EVENTS.has('diff-policy-recapture'));
  assert.ok(!CLOSE_RESOLVED_EVENTS.has('diff-policy-recapture'));
});

test('the capture record pairs its resolution at close, like a budget breach', () => {
  assert.ok(CLOSE_RESOLVED_EVENTS.has('diff-policy-violation'));
  assert.ok(CLOSE_RESOLVED_EVENTS.has('budget-breach'));
  // Only loud items a run can close on its own. A liveness violation is not
  // one: it says the run stopped being a run.
  for (const event of CLOSE_RESOLVED_EVENTS) assert.ok(RESOLVABLE_EVENTS.has(event));
  assert.ok(!CLOSE_RESOLVED_EVENTS.has('liveness-violation'));
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

test('replay of a take-back that shipped resumes past the commit it rode', () => {
  // The take-back does not stop the capture, so the commit stamp follows it in
  // the same stage. Replay reads the stage from the stamps, and the take-back
  // record carries no state of its own to reconstruct.
  const events = [
    { seq: 1, event: 'run-launched', project: 'p', lane: 'story', worktree: '/w' },
    { seq: 2, event: 'stage-entered', stage: 'implementation' },
    { seq: 3, event: 'diff-policy-violation', seat: 'dev', violations: [], dropped: ['tests/a.mjs'] },
    { seq: 4, event: 'implementation-committed', pass: 1, phase: 'initial', dropped: ['tests/a.mjs'] },
    { seq: 5, event: 'stage-entered', stage: 'verdict' },
  ];
  const state = deriveRunState(events);
  assert.equal(state.violated, false);
  assert.equal(state.stage, 'verdict');
  assert.equal(state.closed, null);
});
