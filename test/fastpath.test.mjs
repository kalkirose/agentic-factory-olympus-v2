// The clean-rebase fast path's derivation (ADR-0056). Every route the check
// can take is decided from facts here, with no repository behind it: the git
// reads are the caller's, so the refusals are testable one at a time.
//
// The lane wiring (the flag, the stamp, the fall-through to the full
// re-verdict) is proven against real repositories in ship.test.mjs, and the
// whole path through the assembled binaries in the e2e suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAST_PATH_REFUSALS,
  assertFastPathRefusal,
  declarationDigest,
  declaredGround,
  fastPathVerdict,
  groundVerdict,
  parseRawDiff,
} from '../src/lanes/fastpath.mjs';

// One raw-diff record, in the shape `git diff --raw -z` writes it.
const raw = (path, { srcMode = '100644', dstMode = '100644', status = 'M' } = {}) =>
  `:${srcMode} ${dstMode} aaaaaaa bbbbbbb ${status}\0${path}\0`;

const layer = (name) => ({ name });

/** A standing green `layer-result` carrying the parts its command declared. */
const result = (parts) => ({ event: 'layer-result', status: 'green', parts });

const part = (name, inputs) => ({ name, status: 'green', ...(inputs && { inputs }) });

const CERTIFICATION = { cycle: 3, sha: 'c'.repeat(40), record: '/runs/r1/verdict-3.json' };

/** The inputs of a decision that fires, so each test moves one of them. */
function inputs(overrides = {}) {
  return {
    certification: CERTIFICATION,
    layers: [layer('unit')],
    prior: new Map([['unit', result([part('api', ['src/api'])])]]),
    testPaths: ['tests'],
    breadth: ['package-lock.json', 'db/migrations'],
    storyDiffBefore: 'diff --git a/src/api/f.mjs b/src/api/f.mjs\n',
    storyDiffAfter: 'diff --git a/src/api/f.mjs b/src/api/f.mjs\n',
    mainChanged: { files: ['docs/note.md'], unclassifiable: [] },
    storyChanged: ['src/api/f.mjs'],
    ...overrides,
  };
}

// -- the raw diff parse -------------------------------------------------------

test('a raw diff reads as the files it names', () => {
  const parsed = parseRawDiff(raw('src/a.mjs') + raw('docs/b.md', { status: 'A' }));
  assert.deepEqual(parsed.files, ['src/a.mjs', 'docs/b.md']);
  assert.deepEqual(parsed.unclassifiable, []);
});

test('a submodule bump is ground this check cannot read', () => {
  // The content it points at is in another repository, so no declaration in
  // this one can name it, and no disjointness proof covers it.
  const parsed = parseRawDiff(raw('vendor/lib', { srcMode: '160000', dstMode: '160000' }));
  assert.deepEqual(parsed.files, []);
  assert.deepEqual(parsed.unclassifiable, ['vendor/lib']);
});

test('a path the check will not compare is unclassifiable, not a file', () => {
  const parsed = parseRawDiff(
    raw('/etc/passwd') + raw('../outside.mjs') + raw('C:/tmp/x.mjs') + raw('src/ok.mjs'),
  );
  assert.deepEqual(parsed.files, ['src/ok.mjs']);
  assert.deepEqual(parsed.unclassifiable, ['/etc/passwd', '../outside.mjs', 'C:/tmp/x.mjs']);
});

test('a record the pairing cannot close is unclassifiable', () => {
  const parsed = parseRawDiff(raw('src/a.mjs') + ':100644 100644 aaa bbb M\0');
  assert.deepEqual(parsed.files, ['src/a.mjs']);
  assert.equal(parsed.unclassifiable.length, 1);
});

test('a metadata field the parse does not recognise is unclassifiable', () => {
  const parsed = parseRawDiff('not-a-record\0src/a.mjs\0');
  assert.deepEqual(parsed.files, []);
  assert.deepEqual(parsed.unclassifiable, ['src/a.mjs']);
});

test('an empty diff names nothing at all', () => {
  assert.deepEqual(parseRawDiff(''), { files: [], unclassifiable: [] });
});

// -- the declarations ---------------------------------------------------------

test('the declared ground is every input of every suite of every layer', () => {
  const ground = declaredGround(
    [layer('unit'), layer('http')],
    new Map([
      ['unit', result([part('api', ['src/api']), part('core', ['src/core', 'src/shared'])])],
      ['http', result([part('routes', ['src/routes'])])],
    ]),
  );
  assert.equal(ground.ok, true);
  assert.deepEqual(ground.suites, ['http/routes', 'unit/api', 'unit/core']);
  assert.deepEqual(ground.entries, ['src/api', 'src/core', 'src/routes', 'src/shared']);
});

test('a layer with no standing green declares nothing the path can use', () => {
  const ground = declaredGround([layer('unit')], new Map());
  assert.equal(ground.taken, false);
  assert.equal(ground.refusal, 'undeclared-suite');
  assert.match(ground.detail, /no green result stands for layer unit/);
});

test('a layer that reported no suite of its own refuses', () => {
  const ground = declaredGround([layer('unit')], new Map([['unit', result([])]]));
  assert.equal(ground.refusal, 'undeclared-suite');
  assert.match(ground.detail, /reported no suite/);
});

test('one suite without a declaration refuses for the whole verdict', () => {
  const ground = declaredGround(
    [layer('unit')],
    new Map([['unit', result([part('api', ['src/api']), part('core')])]]),
  );
  assert.equal(ground.refusal, 'undeclared-suite');
  assert.match(ground.detail, /unit\/core declared no inputs/);
});

test('a red layer standing behind the certification refuses', () => {
  const red = { event: 'layer-result', status: 'red', parts: [part('api', ['src/api'])] };
  assert.equal(declaredGround([layer('unit')], new Map([['unit', red]])).refusal, 'undeclared-suite');
});

// -- the ground question ------------------------------------------------------

const GROUND = {
  storyChanged: ['src/api/f.mjs'],
  entries: ['src/api'],
  testPaths: ['tests'],
  breadth: ['package-lock.json', 'db/migrations'],
};

const changed = (...files) => ({ files, unclassifiable: [] });

test('ground nothing claims is disjoint', () => {
  assert.equal(groundVerdict({ ...GROUND, mainChanged: changed('docs/note.md') }), null);
});

test('a file the story itself changed is an intersection', () => {
  const out = groundVerdict({ ...GROUND, mainChanged: changed('src/api/f.mjs') });
  assert.equal(out.refusal, 'ground-intersects');
  assert.match(out.detail, /the story's own diff/);
});

test('a declared suite input is an intersection', () => {
  const out = groundVerdict({ ...GROUND, mainChanged: changed('src/api/other.mjs') });
  assert.equal(out.refusal, 'ground-intersects');
  assert.match(out.detail, /a declared suite input/);
});

test('a suite file is an intersection', () => {
  const out = groundVerdict({ ...GROUND, mainChanged: changed('tests/api.test.mjs') });
  assert.equal(out.refusal, 'ground-intersects');
  assert.match(out.detail, /a suite file/);
});

test('the shared breadth list is an intersection whatever any suite declared', () => {
  const out = groundVerdict({ ...GROUND, mainChanged: changed('db/migrations/0007.sql') });
  assert.equal(out.refusal, 'ground-intersects');
  assert.match(out.detail, /the shared breadth list/);
});

test('a glob input reaches the files it matches', () => {
  // The path vocabulary is the config's own (project.mjs): a plain entry is a
  // prefix, and a glob entry matches whole paths.
  const out = groundVerdict({
    ...GROUND,
    entries: ['packages/*/src/**'],
    mainChanged: changed('packages/two/src/index.mjs'),
  });
  assert.equal(out.refusal, 'ground-intersects');
  assert.equal(
    groundVerdict({
      ...GROUND,
      entries: ['packages/*/src/**'],
      mainChanged: changed('packages/two/docs/index.mjs'),
    }),
    null,
  );
});

test('ground the check cannot read refuses before any intersection is looked for', () => {
  const out = groundVerdict({
    ...GROUND,
    mainChanged: { files: ['docs/note.md'], unclassifiable: ['vendor/lib'] },
  });
  assert.equal(out.refusal, 'unclassifiable-change');
  assert.match(out.detail, /vendor\/lib/);
});

// -- the whole decision -------------------------------------------------------

test('a disjoint merge over declared ground carries its certification', () => {
  const out = fastPathVerdict(inputs());
  assert.equal(out.taken, true);
  assert.deepEqual(out.certification, CERTIFICATION);
  assert.equal(out.declaration.sha, CERTIFICATION.sha);
  assert.deepEqual(out.declaration.suites, ['unit/api']);
  assert.equal(out.declaration.entries, 1);
  assert.match(out.declaration.digest, /^[0-9a-f]{12}$/);
});

test('a tree with no green verdict behind it carries nothing', () => {
  const out = fastPathVerdict(inputs({ certification: null }));
  assert.equal(out.taken, false);
  assert.equal(out.refusal, 'no-certification');
});

test("a story diff the update changed refuses, whatever the ground says", () => {
  // The tree that ships is then not the branch plus the story's own patch, and
  // no declaration can make that tree one a verdict certified.
  const out = fastPathVerdict(inputs({ storyDiffAfter: 'diff --git a/src/api/f.mjs\n+moved\n' }));
  assert.equal(out.refusal, 'diff-changed');
});

test('a project that declares no breadth ground never fast-paths', () => {
  assert.equal(fastPathVerdict(inputs({ breadth: [] })).refusal, 'no-breadth-ground');
});

test('one undeclared suite takes the full re-verdict', () => {
  const out = fastPathVerdict(
    inputs({ prior: new Map([['unit', result([part('api')])]]) }),
  );
  assert.equal(out.refusal, 'undeclared-suite');
});

test('an overlapping file takes the full re-verdict', () => {
  const out = fastPathVerdict(inputs({ mainChanged: changed('src/api/other.mjs') }));
  assert.equal(out.refusal, 'ground-intersects');
});

test('every refusal the module can return is in the closed set', () => {
  for (const refusal of FAST_PATH_REFUSALS) assert.equal(assertFastPathRefusal(refusal), refusal);
  assert.throws(() => assertFastPathRefusal('too-slow'), /unknown fast-path refusal/);
  // Every route above named one of them, and the internal-error route is the
  // lane's own; nothing else may reach a stamp.
  assert.deepEqual([...FAST_PATH_REFUSALS].sort(), [
    'diff-changed',
    'ground-intersects',
    'internal-error',
    'no-breadth-ground',
    'no-certification',
    'unclassifiable-change',
    'undeclared-suite',
  ]);
});

// -- the declaration version --------------------------------------------------

test('the digest moves when a declaration moves and at no other time', () => {
  const base = {
    suites: ['unit/api'],
    entries: ['src/api'],
    testPaths: ['tests'],
    breadth: ['package-lock.json'],
  };
  assert.equal(declarationDigest(base), declarationDigest({ ...base }));
  // The order the sets arrive in is not a version.
  assert.equal(
    declarationDigest({ ...base, breadth: ['package-lock.json'] }),
    declarationDigest(base),
  );
  assert.notEqual(declarationDigest({ ...base, entries: ['src/api', 'src/core'] }), declarationDigest(base));
  assert.notEqual(declarationDigest({ ...base, breadth: ['package-lock.json', 'db'] }), declarationDigest(base));
  assert.notEqual(declarationDigest({ ...base, testPaths: ['spec'] }), declarationDigest(base));
  assert.notEqual(declarationDigest({ ...base, suites: ['unit/core'] }), declarationDigest(base));
});
