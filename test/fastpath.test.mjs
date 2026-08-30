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
  COMMIT_LIMIT,
  FAST_PATH_REFUSALS,
  GIT_TIMEOUT_MS,
  assertFastPathRefusal,
  declarationDigest,
  declarationSources,
  declaredGround,
  fastPathFacts,
  fastPathVerdict,
  groundEntry,
  groundVerdict,
  parseRawDiff,
} from '../src/lanes/fastpath.mjs';

// One raw-diff record, in the shape `git diff --raw -z` writes it.
const raw = (path, { srcMode = '100644', dstMode = '100644', status = 'M' } = {}) =>
  `:${srcMode} ${dstMode} aaaaaaa bbbbbbb ${status}\0${path}\0`;

const layer = (name, command = name) => ({ name, command });

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
    commands: { unit: ['node', '.olympus/gates/unit.mjs'] },
    testPaths: ['tests'],
    breadth: ['package-lock.json', 'db/migrations'],
    inert: ['docs'],
    lensFindings: [],
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

test('a symlink is ground this check cannot read', () => {
  // The record names the link; a declaration that names what it points at says
  // nothing about the link, and the other way round.
  const parsed = parseRawDiff(raw('bin/node', { srcMode: '120000', dstMode: '120000' }));
  assert.deepEqual(parsed.files, []);
  assert.deepEqual(parsed.unclassifiable, ['bin/node']);
});

test('a file that became a symlink is ground this check cannot read', () => {
  const parsed = parseRawDiff(raw('bin/node', { srcMode: '100644', dstMode: '120000', status: 'T' }));
  assert.deepEqual(parsed.unclassifiable, ['bin/node']);
});

test('a mode-only change is ground this check cannot read', () => {
  // A declaration names a path's content. Nothing in this project claims the
  // bit that says a file is executable.
  const parsed = parseRawDiff(raw('scripts/run.sh', { srcMode: '100644', dstMode: '100755' }));
  assert.deepEqual(parsed.files, []);
  assert.deepEqual(parsed.unclassifiable, ['scripts/run.sh']);
});

test('an addition and a deletion are ordinary files', () => {
  // One side is absent, which is a change of content and not of kind.
  const parsed = parseRawDiff(
    raw('src/new.mjs', { srcMode: '000000', status: 'A' }) +
      raw('src/gone.mjs', { dstMode: '000000', status: 'D' }),
  );
  assert.deepEqual(parsed.files, ['src/new.mjs', 'src/gone.mjs']);
  assert.deepEqual(parsed.unclassifiable, []);
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

test('an input entry that can match no path is no declaration at all', () => {
  // `.` reads like the whole repository and claims nothing: the path
  // vocabulary compares a plain entry as a prefix, and no repo-relative path
  // is `.` or begins `./`. A suite that declares it has declared nothing, and
  // nothing is the case that always re-runs.
  for (const entry of ['.', './', '', '   ', '/etc', '../outside']) {
    const ground = declaredGround(
      [layer('unit')],
      new Map([['unit', result([part('api', [entry])])]]),
    );
    assert.equal(ground.refusal, 'undeclared-suite', entry);
    assert.match(ground.detail, /declared no inputs/);
  }
});

test('an entry that matches nothing drops out beside one that does', () => {
  const ground = declaredGround(
    [layer('unit')],
    new Map([['unit', result([part('api', ['.', 'src/api/'])])]]),
  );
  assert.equal(ground.ok, true);
  assert.deepEqual(ground.entries, ['src/api']);
});

test('a ground entry is a repo-relative path or nothing', () => {
  assert.equal(groundEntry('src/api/'), 'src/api');
  assert.equal(groundEntry('packages/*/src/**'), 'packages/*/src/**');
  for (const bad of ['.', './', '', '/abs', 'C:/abs', 'a/../b', 3, null]) {
    assert.equal(groundEntry(bad), null, String(bad));
  }
});

// -- the ground the declarations themselves come from -------------------------

test('a declaration source is the command file and the directory it sits in', () => {
  const sources = declarationSources(
    [layer('unit', 'suite'), layer('lint', 'lint')],
    { suite: ['node', '.olympus/gates/suite.mjs'], lint: ['node', 'tools/lint.mjs'] },
  );
  assert.equal(sources.ok, true);
  assert.deepEqual(sources.entries, [
    '.olympus/gates',
    '.olympus/gates/suite.mjs',
    'tools',
    'tools/lint.mjs',
  ]);
});

test('a command that names no file of the repository cannot be bounded', () => {
  const sources = declarationSources([layer('unit', 'suite')], { suite: ['npm', 'test'] });
  assert.equal(sources.refusal, 'self-declared-ground');
  assert.match(sources.detail, /names no file of this repository/);
});

test('a story that moves the ground its own declarations come from refuses', () => {
  // The declarations are printed by the layer commands, and those commands run
  // in the run's own worktree. A story that narrowed its inputs would be judged
  // against the narrowing it wrote.
  const out = fastPathVerdict(
    inputs({ storyChanged: ['src/api/f.mjs', '.olympus/gates/unit.mjs'] }),
  );
  assert.equal(out.refusal, 'self-declared-ground');
  assert.match(out.detail, /moves the declarations/);
});

test('a story that edits a helper beside the gate refuses too', () => {
  const out = fastPathVerdict(inputs({ storyChanged: ['.olympus/gates/mark.mjs'] }));
  assert.equal(out.refusal, 'self-declared-ground');
});

// -- the ground question ------------------------------------------------------

const GROUND = {
  storyChanged: ['src/api/f.mjs'],
  entries: ['src/api'],
  testPaths: ['tests'],
  breadth: ['package-lock.json', 'db/migrations'],
  sources: ['.olympus/gates'],
  inert: ['docs'],
};

const changed = (...files) => ({ files, unclassifiable: [] });

test('ground the project declared inert is disjoint', () => {
  assert.equal(groundVerdict({ ...GROUND, mainChanged: changed('docs/note.md') }), null);
});

test('ground no claim in the project reaches refuses', () => {
  // The part machinery's own rule (parts.mjs): a changed path no input set
  // claims makes every part affected, because nothing said what depends on it.
  // Reading that silence as safety is the one thing this check may never do.
  const out = groundVerdict({ ...GROUND, mainChanged: changed('ops/deploy.sh') });
  assert.equal(out.refusal, 'unclaimed-ground');
  assert.match(out.detail, /ops\/deploy\.sh/);
});

test('a project that declares no inert ground refuses every moved file', () => {
  const out = groundVerdict({ ...GROUND, inert: [], mainChanged: changed('docs/note.md') });
  assert.equal(out.refusal, 'unclaimed-ground');
});

test('a declaration source is an intersection', () => {
  // The declarations decide the skip. The branch moving under them is the one
  // thing the ground question must never let through as inert.
  const out = groundVerdict({ ...GROUND, mainChanged: changed('.olympus/gates/unit.mjs') });
  assert.equal(out.refusal, 'ground-intersects');
  assert.match(out.detail, /a declaration source/);
});

test('a claimed file refuses even where the inert list also names it', () => {
  const out = groundVerdict({
    ...GROUND,
    inert: ['src'],
    mainChanged: changed('src/api/other.mjs'),
  });
  assert.equal(out.refusal, 'ground-intersects');
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
      inert: ['packages/*/docs/**'],
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

test('a project that names no suite files never fast-paths', () => {
  // One of the five sets the ground question asks would be an empty list, and
  // the record would read like a whole answer.
  assert.equal(fastPathVerdict(inputs({ testPaths: [] })).refusal, 'no-suite-ground');
});

test('a certification carrying a review-lens finding is not carried', () => {
  // A lens declares no inputs and reads the whole repository around the diff,
  // so no claim in this project can say the branch left its ground alone.
  const out = fastPathVerdict(inputs({ lensFindings: ['architecture/F-1'] }));
  assert.equal(out.refusal, 'lens-ground');
  assert.match(out.detail, /architecture\/F-1/);
});

test('main-side ground no claim reaches takes the full re-verdict', () => {
  const out = fastPathVerdict(
    inputs({ mainChanged: { files: ['ops/deploy.sh'], unclassifiable: [] } }),
  );
  assert.equal(out.refusal, 'unclaimed-ground');
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
    'lens-ground',
    'no-breadth-ground',
    'no-certification',
    'no-suite-ground',
    'self-declared-ground',
    'unclaimed-ground',
    'unclassifiable-change',
    'undeclared-suite',
  ]);
});

// -- the git reads ------------------------------------------------------------

/** A git runner that answers what a test states and records how it was called. */
function fakeGit(answers) {
  const calls = [];
  const run = async (args, opts) => {
    calls.push({ args, opts });
    for (const [head, answer] of Object.entries(answers)) {
      if (args[0] === head) return answer;
    }
    return '';
  };
  return { run, calls };
}

test('every read the check takes is bounded in time', async () => {
  // The check runs inside the ship token. A git that never returns would hold
  // the token for every run waiting behind it, and a hold is not one of this
  // module's endings.
  const { run, calls } = fakeGit({ 'merge-base': 'b'.repeat(40) + '\n' });
  await fastPathFacts('/tree', { fromSha: 'f', toSha: 't', mainSha: 'm' }, { run });
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(call.opts.timeout, GIT_TIMEOUT_MS, call.args.join(' '));
    assert.equal(call.opts.cwd, '/tree');
  }
});

test('a commit list the record had to cut says so', async () => {
  const revs = Array.from({ length: COMMIT_LIMIT + 7 }, (_, i) => String(i).padStart(40, '0'));
  const { run } = fakeGit({ 'merge-base': 'b'.repeat(40), 'rev-list': revs.join('\n') });
  const facts = await fastPathFacts('/tree', { fromSha: 'f', toSha: 't', mainSha: 'm' }, { run });
  assert.equal(facts.commits.length, COMMIT_LIMIT);
  assert.equal(facts.commitCount, revs.length);
  assert.equal(facts.truncated, true);
  assert.equal(facts.commitLimit, COMMIT_LIMIT);
});

test('a commit list that fits claims no cut', async () => {
  const { run } = fakeGit({ 'merge-base': 'b'.repeat(40), 'rev-list': 'a\nb\nc' });
  const facts = await fastPathFacts('/tree', { fromSha: 'f', toSha: 't', mainSha: 'm' }, { run });
  assert.equal(facts.commitCount, 3);
  assert.equal(facts.truncated, undefined);
});

// -- the declaration version --------------------------------------------------

test('the digest moves when a declaration moves and at no other time', () => {
  const base = {
    suites: ['unit/api'],
    entries: ['src/api'],
    testPaths: ['tests'],
    breadth: ['package-lock.json'],
    inert: ['docs'],
    sources: ['.olympus/gates'],
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
  assert.notEqual(declarationDigest({ ...base, inert: ['docs', 'ops'] }), declarationDigest(base));
  assert.notEqual(declarationDigest({ ...base, sources: ['tools'] }), declarationDigest(base));
});
