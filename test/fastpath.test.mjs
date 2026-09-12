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
  codeCertification,
  declarationDigest,
  declarationSources,
  declaredGround,
  fastPathDecision,
  fastPathFacts,
  fastPathVerdict,
  groundVerdict,
  parseRawDiff,
} from '../src/lanes/fastpath.mjs';
import { priorStatus } from '../src/lanes/spectrum.mjs';
import { groundEntry } from '../src/config/project.mjs';

// One raw-diff record, in the shape `git diff --raw -z` writes it.
const raw = (path, { srcMode = '100644', dstMode = '100644', status = 'M' } = {}) =>
  `:${srcMode} ${dstMode} aaaaaaa bbbbbbb ${status}\0${path}\0`;

const layer = (name, command = name) => ({ name, command });

/** A standing green `layer-result` carrying the parts its command declared. */
const result = (parts) => ({ event: 'layer-result', status: 'green', parts });

const part = (name, inputs) => ({ name, status: 'green', ...(inputs && { inputs }) });

const CERTIFICATION = { cycle: 3, sha: 'c'.repeat(40), record: '/runs/r1/verdict-3.json' };

/** A reader over an in-memory tree, in the shape the walk consumes. */
const sourceTree = (files) => (path) => (path in files ? files[path] : null);

/** The gate script of the decision that fires: one file, no imports. */
const GATE = { '.olympus/gates/unit.mjs': "console.log('::olympus part api');\n" };

/** The inputs of a decision that fires, so each test moves one of them. */
function inputs(overrides = {}) {
  return {
    certification: CERTIFICATION,
    layers: [layer('unit')],
    prior: new Map([['unit', result([part('api', ['src/api'])])]]),
    commands: { unit: ['node', '.olympus/gates/unit.mjs'] },
    readSource: sourceTree(GATE),
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
  // Its own word, because the repair is not the repair a groundless layer
  // needs: this one is a layer with no green result to carry at all, and a
  // count that mixed the two would be a count of nothing (ADR-0008).
  const ground = declaredGround([layer('unit')], new Map());
  assert.equal(ground.taken, false);
  assert.equal(ground.refusal, 'no-standing-green');
  assert.match(ground.detail, /no green result stands for layer unit/);
});

test('a layer whose ground neither source declares refuses', () => {
  const ground = declaredGround([layer('unit')], new Map([['unit', result([])]]));
  assert.equal(ground.refusal, 'undeclared-suite');
  assert.match(ground.detail, /no source declares the ground of layer unit/);
});

test('a layer the config alone describes declares a ground the path can use', () => {
  // The command printed no part of its own. The project states what it reads,
  // and that is the whole of this layer's ground.
  const ground = declaredGround(
    [{ name: 'deps', command: 'deps', ground: ['scripts/check-deps.mjs', './manifest.json'] }],
    new Map([['deps', result([])]]),
  );
  assert.equal(ground.ok, true);
  assert.deepEqual(ground.entries, ['manifest.json', 'scripts/check-deps.mjs']);
  assert.deepEqual(ground.suites, []);
  assert.deepEqual(ground.counts, { declared: 0, config: 1 });
  assert.deepEqual(ground.selfDeclaring, []);
  assert.deepEqual(ground.ground, ['deps manifest.json', 'deps scripts/check-deps.mjs']);
});

test('the breadth list joins every layer ground the path reads', () => {
  const ground = declaredGround([layer('unit')], new Map([['unit', result([part('api', ['src/api'])])]]), {
    breadth: ['package-lock.json'],
  });
  assert.deepEqual(ground.entries, ['package-lock.json', 'src/api']);
});

test('a certified verdict naming no Tier-1 layer carries nothing', () => {
  const ground = declaredGround([], new Map());
  assert.equal(ground.refusal, 'undeclared-suite');
  assert.match(ground.detail, /names no Tier-1 layer/);
});

test('one suite without a declaration refuses for the whole verdict', () => {
  // A sibling part's declaration is a statement about that sibling. The floor
  // a silent part stands on is the config list and the breadth list, and this
  // layer has neither.
  const ground = declaredGround(
    [layer('unit')],
    new Map([['unit', result([part('api', ['src/api']), part('core')])]]),
  );
  assert.equal(ground.refusal, 'undeclared-suite');
  assert.match(ground.detail, /unit\/core declared no inputs/);
});

test('a config ground answers for a part that declared none', () => {
  // The one shape on the reference project that this repairs: a layer that
  // declares six parts of which two are prerequisites and state nothing.
  const ground = declaredGround(
    [{ name: 'unit', command: 'unit', ground: ['src'] }],
    new Map([['unit', result([part('api', ['src/api']), part('core')])]]),
  );
  assert.equal(ground.ok, true);
  assert.deepEqual(ground.entries, ['src', 'src/api']);
  assert.deepEqual(ground.suites, ['unit/api', 'unit/core']);
  assert.deepEqual(ground.counts, { declared: 1, config: 1 });
});

test('a red layer standing behind the certification refuses', () => {
  const red = { event: 'layer-result', status: 'red', parts: [part('api', ['src/api'])] };
  assert.equal(
    declaredGround([layer('unit')], new Map([['unit', red]])).refusal,
    'no-standing-green',
  );
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

test('one spelling of a path is every spelling of it', () => {
  // Declarations, argv words and git output name the same file in different
  // hands. A comparison of two spellings is not a comparison of two paths, so
  // there is one canonical form and everything meets it.
  for (const [written, canonical] of [
    ['./docs/fixtures', 'docs/fixtures'],
    ['.\\docs\\fixtures', 'docs/fixtures'],
    ['docs//fixtures///', 'docs/fixtures'],
    ['./docs/./fixtures', 'docs/fixtures'],
    ['  ./src  ', 'src'],
    ['./gate.mjs', 'gate.mjs'],
  ]) {
    assert.equal(groundEntry(written), canonical, written);
  }
});

test('a dot-slash declaration claims the ground it reads like', () => {
  // `./docs/fixtures` passed the declared-suite check and matched no file, so
  // the branch could move under a declared input and the ground question would
  // call it disjoint. The canonical form is what closes it.
  const ground = declaredGround(
    [layer('unit')],
    new Map([['unit', result([part('api', ['./docs/fixtures'])])]]),
  );
  assert.deepEqual(ground.entries, ['docs/fixtures']);
  const out = fastPathVerdict(
    inputs({
      prior: new Map([['unit', result([part('api', ['./docs/fixtures'])])]]),
      mainChanged: { files: ['docs/fixtures/data.json'], unclassifiable: [] },
    }),
  );
  assert.equal(out.taken, false);
  assert.equal(out.refusal, 'ground-intersects');
  assert.match(out.detail, /a declared suite input/);
});

test('a dot-slash argv word still names the file it names', () => {
  const sources = declarationSources(
    [layer('unit', 'suite')],
    { suite: ['node', './scripts/gate.mjs'] },
    sourceTree({ 'scripts/gate.mjs': 'console.log(1);\n' }),
  );
  assert.equal(sources.ok, true);
  assert.deepEqual(sources.entries, ['scripts', 'scripts/gate.mjs']);
  // A script at the repository root, written the only way it can be written.
  const root = declarationSources(
    [layer('unit', 'suite')],
    { suite: ['node', './gate.mjs'] },
    sourceTree({ 'gate.mjs': 'console.log(1);\n' }),
  );
  assert.equal(root.ok, true);
  assert.deepEqual(root.entries, ['gate.mjs']);
});

// -- the ground the declarations themselves come from -------------------------

test('a declaration source is the command file and the directory it sits in', () => {
  const sources = declarationSources(
    [layer('unit', 'suite'), layer('lint', 'lint')],
    { suite: ['node', '.olympus/gates/suite.mjs'], lint: ['node', 'tools/lint.mjs'] },
    sourceTree({
      '.olympus/gates/suite.mjs': 'console.log(1);\n',
      'tools/lint.mjs': 'console.log(2);\n',
    }),
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
  const sources = declarationSources(
    [layer('unit', 'suite')],
    { suite: ['npm', 'test'] },
    sourceTree({}),
  );
  assert.equal(sources.refusal, 'self-declared-ground');
  assert.match(sources.detail, /names no file of this repository/);
});

// -- the modules a gate reaches -----------------------------------------------

test('a module the gate imports is a declaration source of its own', () => {
  // The markers are printed where the code that prints them lives. A helper the
  // gate imports produces the declarations as much as the gate does, and a
  // guard that stopped at the gate's own directory would watch the wrong file.
  const sources = declarationSources(
    [layer('unit', 'suite')],
    { suite: ['node', 'scripts/gate.mjs'] },
    sourceTree({
      'scripts/gate.mjs': "import { parts } from '../lib/parts.mjs';\nparts();\n",
      'lib/parts.mjs': "import './shared.mjs';\nexport const parts = () => {};\n",
      'lib/shared.mjs': 'export const shared = 1;\n',
    }),
  );
  assert.equal(sources.ok, true);
  assert.deepEqual(sources.entries, [
    'lib',
    'lib/parts.mjs',
    'lib/shared.mjs',
    'scripts',
    'scripts/gate.mjs',
  ]);
});

test('a story that edits a module the gate imports refuses', () => {
  const out = fastPathVerdict(
    inputs({
      commands: { unit: ['node', 'scripts/gate.mjs'] },
      readSource: sourceTree({
        'scripts/gate.mjs': "import { parts } from '../lib/parts.mjs';\nparts();\n",
        'lib/parts.mjs': 'export const parts = () => {};\n',
      }),
      storyChanged: ['lib/parts.mjs'],
    }),
  );
  assert.equal(out.refusal, 'self-declared-ground');
  assert.match(out.detail, /lib\/parts\.mjs/);
});

test('a bare specifier is a dependency and is not followed', () => {
  const sources = declarationSources(
    [layer('unit', 'suite')],
    { suite: ['node', 'scripts/gate.mjs'] },
    sourceTree({ 'scripts/gate.mjs': "import { test } from 'node:test';\nimport 'left-pad';\n" }),
  );
  assert.equal(sources.ok, true);
  assert.deepEqual(sources.entries, ['scripts', 'scripts/gate.mjs']);
});

test('every edge the walk cannot read refuses', () => {
  const walk = (files, argv = ['node', 'scripts/gate.mjs']) =>
    declarationSources([layer('unit', 'suite')], { suite: argv }, sourceTree(files));
  // A file that is not there.
  assert.match(walk({}).detail, /scripts\/gate\.mjs will not read/);
  // A relative specifier that resolves to nothing.
  assert.match(
    walk({ 'scripts/gate.mjs': "import './missing.mjs';\n" }).detail,
    /resolves to no file this check can read/,
  );
  // A specifier the source names at run time.
  assert.match(
    walk({ 'scripts/gate.mjs': 'const m = await import(name);\n' }).detail,
    /names at run time/,
  );
  assert.match(
    walk({ 'scripts/gate.mjs': 'const m = require(name);\n' }).detail,
    /names at run time/,
  );
  // A glob names a set of files, and a set of files has no imports to read.
  assert.match(
    walk({}, ['node', '--test', 'tests/*.test.mjs']).detail,
    /names a set of files by pattern/,
  );
  for (const files of [
    {},
    { 'scripts/gate.mjs': "import './missing.mjs';\n" },
    { 'scripts/gate.mjs': 'await import(name);\n' },
  ]) {
    assert.equal(walk(files).refusal, 'self-declared-ground');
  }
});

test('a load the walk cannot prove is a literal refuses, whatever it starts with', () => {
  // The hole this closes: a call whose argument BEGINS with a quote read as
  // neither a specifier to follow nor an expression to refuse, so the module it
  // reached was missed in silence. The two readings have to partition the space.
  const walk = (source) =>
    declarationSources(
      [layer('unit', 'suite')],
      { suite: ['node', 'scripts/gate.mjs'] },
      sourceTree({ 'scripts/gate.mjs': source, 'scripts/p.mjs': 'export const p = 1;\n' }),
    );
  for (const source of [
    "await import('./dir/' + name);\n",
    "const m = require('./p' + x);\n",
    'await import(`./${dir}/p.mjs`);\n',
    'await import(`./p.mjs`);\n',
    "await import('./p' , '/x');\n".replace(' ,', ''),
    'const m = require(paths[0]);\n',
    'await import(cond ? a : b);\n',
    "await import('./p.mjs'.trim());\n",
  ]) {
    const out = walk(source);
    assert.equal(out.refusal, 'self-declared-ground', source);
    assert.match(out.detail, /names at run time/, source);
  }
  // What still passes: a plain literal, and a literal with import attributes
  // after it, which is a load of exactly the module it names.
  for (const source of [
    "await import('./p.mjs');\n",
    "await import( './p.mjs' );\n",
    "await import('./p.mjs', { with: { type: 'json' } });\n",
    "const m = require('./p.mjs');\n",
  ]) {
    const out = walk(source);
    assert.equal(out.ok, true, source);
    assert.ok(out.entries.includes('scripts/p.mjs'), source);
  }
  // A method that happens to be called `import` is not a module load.
  const method = walk("db.import('./p.mjs');\nconst q = obj.require(x);\n");
  assert.equal(method.ok, true);
  assert.ok(!method.entries.includes('scripts/p.mjs'));
});

test('a specifier that could be more than one file is not resolved by guessing', () => {
  // Which of `x.mjs`, `x.js` and `x/index.js` a runtime loads depends on the
  // module kind and the package around it. A probe that took the first hit
  // would record a file the gate never loads and leave the real one outside
  // the guard, so more than one candidate is a refusal.
  const walk = (files) =>
    declarationSources(
      [layer('unit', 'suite')],
      { suite: ['node', 'scripts/gate.mjs'] },
      sourceTree(files),
    );
  const ambiguous = walk({
    'scripts/gate.mjs': "import './helper';\n",
    'scripts/helper.mjs': 'export const h = 1;\n',
    'scripts/helper.js': 'module.exports = {};\n',
  });
  assert.equal(ambiguous.refusal, 'self-declared-ground');
  assert.match(ambiguous.detail, /resolves to more than one file/);
  // A directory index beside a file of the same name is the same ambiguity.
  const both = walk({
    'scripts/gate.mjs': "import './dir';\n",
    'scripts/dir.mjs': 'export const d = 1;\n',
    'scripts/dir/index.js': 'module.exports = {};\n',
  });
  assert.match(both.detail, /resolves to more than one file/);
});

test('a specifier with exactly one candidate resolves to it', () => {
  const sources = declarationSources(
    [layer('unit', 'suite')],
    { suite: ['node', 'scripts/gate.mjs'] },
    sourceTree({
      'scripts/gate.mjs': "import './helper';\nimport './dir';\nimport './exact.mjs';\n",
      'scripts/helper.mjs': 'export const h = 1;\n',
      'scripts/dir/index.mjs': 'export const d = 1;\n',
      'scripts/exact.mjs': 'export const e = 1;\n',
    }),
  );
  assert.equal(sources.ok, true);
  assert.ok(sources.entries.includes('scripts/helper.mjs'));
  assert.ok(sources.entries.includes('scripts/dir/index.mjs'));
  assert.ok(sources.entries.includes('scripts/exact.mjs'));
});

test('a declaration source reached through a link is not the file it names', () => {
  // The guard compares names. A link's name is not its content: the story's
  // diff and the branch's diff both name the target, and a set holding the link
  // would watch a path neither of them ever touches.
  const files = {
    'scripts/gate.mjs': "import './lib/parts.mjs';\n",
    'scripts/lib/parts.mjs': 'export const parts = () => {};\n',
  };
  const links = new Set(['scripts/lib']);
  const walk = (isLink) =>
    declarationSources(
      [layer('unit', 'suite')],
      { suite: ['node', 'scripts/gate.mjs'] },
      sourceTree(files),
      isLink,
    );
  // A link at a segment of the path, not the file at the end of it.
  const out = walk((path) => links.has(path));
  assert.equal(out.refusal, 'self-declared-ground');
  assert.match(out.detail, /reaches its content through a symlink/);
  // The file itself as the link.
  const leaf = walk((path) => path === 'scripts/lib/parts.mjs');
  assert.match(leaf.detail, /reaches its content through a symlink/);
  // The other direction: no link, and the same tree walks clean.
  const clean = walk(() => false);
  assert.equal(clean.ok, true);
  assert.ok(clean.entries.includes('scripts/lib/parts.mjs'));
});

test('an import cycle ends the walk rather than running it forever', () => {
  const sources = declarationSources(
    [layer('unit', 'suite')],
    { suite: ['node', 'scripts/gate.mjs'] },
    sourceTree({
      'scripts/gate.mjs': "import './a.mjs';\n",
      'scripts/a.mjs': "import './gate.mjs';\nexport const a = 1;\n",
    }),
  );
  assert.equal(sources.ok, true);
  assert.deepEqual(sources.entries, ['scripts', 'scripts/a.mjs', 'scripts/gate.mjs']);
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

/** The code half alone, as a lane with one certification asks it. */
const codeOf = (incoming, over = GROUND) => groundVerdict(incoming, { code: over }).code;

test('ground the project declared inert is disjoint', () => {
  assert.deepEqual(codeOf(changed('docs/note.md')), { answer: 'kept', files: [] });
});

test('ground no claim in the project reaches is re-judged', () => {
  // The part machinery's own rule (parts.mjs): a changed path no input set
  // claims makes every part affected, because nothing said what depends on it.
  // Reading that silence as safety is the one thing this check may never do.
  const out = codeOf(changed('ops/deploy.sh'));
  assert.equal(out.answer, 'rejudge');
  assert.equal(out.reason, 'unclaimed-ground');
  assert.deepEqual(out.files, ['ops/deploy.sh']);
  assert.match(out.detail, /ops\/deploy\.sh/);
});

test('a project that declares no inert ground re-judges every moved file', () => {
  const out = codeOf(changed('docs/note.md'), { ...GROUND, inert: [] });
  assert.equal(out.reason, 'unclaimed-ground');
});

test('a declaration source is an intersection', () => {
  // The declarations decide the skip. The branch moving under them is the one
  // thing the ground question must never let through as inert.
  const out = codeOf(changed('.olympus/gates/unit.mjs'));
  assert.equal(out.reason, 'ground-intersects');
  assert.match(out.detail, /a declaration source/);
});

test('a claimed file is re-judged even where the inert list also names it', () => {
  const out = codeOf(changed('src/api/other.mjs'), { ...GROUND, inert: ['src'] });
  assert.equal(out.reason, 'ground-intersects');
});

test('a file the story itself changed is an intersection', () => {
  const out = codeOf(changed('src/api/f.mjs'));
  assert.equal(out.reason, 'ground-intersects');
  assert.match(out.detail, /the story's own diff/);
});

test('a declared suite input is an intersection', () => {
  const out = codeOf(changed('src/api/other.mjs'));
  assert.equal(out.reason, 'ground-intersects');
  assert.match(out.detail, /a declared suite input/);
});

test('a suite file is an intersection', () => {
  const out = codeOf(changed('tests/api.test.mjs'));
  assert.equal(out.reason, 'ground-intersects');
  assert.match(out.detail, /a suite file/);
});

test('the shared breadth list is an intersection whatever any suite declared', () => {
  const out = codeOf(changed('db/migrations/0007.sql'));
  assert.equal(out.reason, 'ground-intersects');
  assert.match(out.detail, /the shared breadth list/);
});

test('a glob input reaches the files it matches', () => {
  // The path vocabulary is the config's own (project.mjs): a plain entry is a
  // prefix, and a glob entry matches whole paths.
  const reached = codeOf(changed('packages/two/src/index.mjs'), {
    ...GROUND,
    entries: ['packages/*/src/**'],
  });
  assert.equal(reached.reason, 'ground-intersects');
  assert.deepEqual(
    codeOf(changed('packages/two/docs/index.mjs'), {
      ...GROUND,
      entries: ['packages/*/src/**'],
      inert: ['packages/*/docs/**'],
    }),
    { answer: 'kept', files: [] },
  );
});

test('ground the check cannot read is re-judged before any intersection is looked for', () => {
  const out = codeOf({ files: ['docs/note.md'], unclassifiable: ['vendor/lib'] });
  assert.equal(out.reason, 'unclassifiable-change');
  assert.match(out.detail, /vendor\/lib/);
});

// -- the two questions off one list of files ----------------------------------
//
// The six rows of the point 13 table. The code verdict's ground is what the
// suites declare; the reconciliation's ground is the run's own records and
// their neighbourhood. Each answer is kept or redone on its own.

const RECORDS = {
  neighbourhood: ['docs/adr/adr-020-x.md', 'docs/adr/adr-021-y.md'],
  recordPaths: ['docs/adr', '!docs/adr/TEMPLATE.md'],
  own: ['docs/adr/adr-030-mine.md'],
};

const both = (incoming, over = {}) =>
  groundVerdict(incoming, {
    code: { ...GROUND, storyChanged: [...GROUND.storyChanged, ...RECORDS.own], ...over.code },
    records: { ...RECORDS, ...over.records },
  });

test('incoming work in neither ground keeps both answers', () => {
  const out = both(changed('docs/note.md'));
  assert.equal(out.code.answer, 'kept');
  assert.equal(out.records.answer, 'kept');
});

test('incoming code ground alone re-judges the code and keeps the records', () => {
  const out = both(changed('src/api/other.mjs'));
  assert.equal(out.code.answer, 'rejudge');
  assert.equal(out.code.reason, 'ground-intersects');
  assert.equal(out.records.answer, 'kept');
});

test('a record of the neighbourhood alone re-runs the records and keeps the code', () => {
  const out = both(changed('docs/adr/adr-021-y.md'));
  assert.equal(out.code.answer, 'kept');
  assert.equal(out.records.answer, 'rerun');
  assert.equal(out.records.reason, 'neighbourhood');
  assert.deepEqual(out.records.files, ['docs/adr/adr-021-y.md']);
});

test('incoming work in both grounds re-judges the code and re-runs the records', () => {
  const out = both(changed('src/api/other.mjs', 'docs/adr/adr-021-y.md'));
  assert.equal(out.code.answer, 'rejudge');
  assert.equal(out.records.answer, 'rerun');
});

test('a record outside the neighbourhood keeps both answers', () => {
  // The reconciliation never rested on it, and no suite reads it: a record is
  // in no code set at all, whatever ground a record layer declares.
  const out = both(changed('docs/adr/adr-099-elsewhere.md'), {
    code: { entries: ['src/api', 'docs/adr/**'] },
  });
  assert.equal(out.code.answer, 'kept');
  assert.equal(out.records.answer, 'kept');
});

test('a record the run itself wrote re-runs the records and is never a refusal', () => {
  // The first set of the code question is the run's own diff, and a record in
  // it would otherwise read as an intersection. The stage that wrote the
  // record answers the conflict, so the answer is a re-run.
  const out = both(changed('docs/adr/adr-030-mine.md'));
  assert.equal(out.code.answer, 'kept');
  assert.equal(out.records.answer, 'rerun');
  assert.equal(out.records.reason, 'own-record');
  assert.deepEqual(out.records.files, ['docs/adr/adr-030-mine.md']);
});

test('a record path the exclusion names is a file like any other', () => {
  // `!docs/adr/TEMPLATE.md` leaves the record tree, so the code question asks
  // about it and the records question does not.
  const out = both(changed('docs/adr/TEMPLATE.md'), {
    code: { entries: ['src/api', 'docs/adr/**'] },
  });
  assert.equal(out.code.answer, 'rejudge');
  assert.equal(out.code.reason, 'ground-intersects');
  assert.equal(out.records.answer, 'kept');
});

test('a lane with one certification is asked one question', () => {
  const codeOnly = groundVerdict(changed('docs/note.md'), { code: GROUND });
  assert.equal(codeOnly.records, null);
  assert.equal(codeOnly.code.answer, 'kept');
  const recordsOnly = groundVerdict(changed('docs/adr/adr-020-x.md'), { records: RECORDS });
  assert.equal(recordsOnly.code, null);
  assert.equal(recordsOnly.records.answer, 'rerun');
});

test('a record moved by a change the check cannot read still re-runs the records', () => {
  // A symlink or a mode flip on a record is that record moving. The code
  // question refuses on it as it always did.
  const out = both({ files: [], unclassifiable: ['docs/adr/adr-020-x.md'] });
  assert.equal(out.code.answer, 'rejudge');
  assert.equal(out.code.reason, 'unclassifiable-change');
  assert.equal(out.records.answer, 'rerun');
});

// -- the whole decision -------------------------------------------------------

test('a disjoint merge over declared ground carries its certification', () => {
  const out = fastPathVerdict(inputs());
  assert.equal(out.taken, true);
  assert.deepEqual(out.certification, CERTIFICATION);
  assert.equal(out.declaration.sha, CERTIFICATION.sha);
  assert.deepEqual(out.declaration.suites, ['unit/api']);
  // The declared ground of a layer is the union of what the config states,
  // what its parts stated, and the shared breadth list, so the count covers
  // the two breadth entries beside the one input the part named.
  assert.equal(out.declaration.entries, 3);
  assert.deepEqual(out.declaration.ground, { declared: 1, config: 0 });
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

test('a certification carrying a groundless review finding is not carried', () => {
  // A finding that names no ground answers the question for nothing, so no
  // claim in this project can say the branch left its ground alone. Every
  // record written before a finding carried its ground reads this way.
  const out = fastPathVerdict(inputs({ lensFindings: [{ id: 'architecture/F-1', ground: [] }] }));
  assert.equal(out.refusal, 'lens-ground');
  assert.match(out.detail, /architecture\/F-1/);
});

test('a review finding stands where the branch moved none of its ground', () => {
  // The incoming change is a document the project declares inert, and the
  // finding rests on the payment module. The two cannot interact, so the
  // certification the finding rides is carried.
  const out = fastPathVerdict(
    inputs({ lensFindings: [{ id: 'operational/F-1', ground: ['src/api/pay.mjs'] }] }),
  );
  assert.equal(out.taken, true, out.detail);
});

test('a review finding whose ground the branch moved refuses, naming the file and the finding', () => {
  const out = fastPathVerdict(
    inputs({
      lensFindings: [{ id: 'operational/F-1', ground: ['src/api'] }],
      mainChanged: { files: ['src/api/other.mjs'], unclassifiable: [] },
    }),
  );
  assert.equal(out.refusal, 'lens-ground');
  assert.match(out.detail, /src\/api\/other\.mjs/);
  assert.match(out.detail, /operational\/F-1/);
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
    'deferred-proof',
    'diff-changed',
    'ground-intersects',
    'internal-error',
    'lens-ground',
    'no-breadth-ground',
    'no-certification',
    'no-standing-green',
    'no-suite-ground',
    'records-rerun',
    'self-declared-ground',
    'unclaimed-ground',
    'unclassifiable-change',
    'undeclared-suite',
  ]);
});

// -- two certifications, two grounds, two answers -----------------------------

/** The reconciliation's ground, as the ship computes it at the merge. */
const NEIGHBOURHOOD = {
  neighbourhood: ['docs/adr/adr-020-x.md', 'docs/adr/adr-021-y.md'],
  recordPaths: ['docs/adr'],
};

test('a record of the neighbourhood re-runs the reconciliation and keeps the code', () => {
  const out = fastPathVerdict(
    inputs({
      records: NEIGHBOURHOOD,
      mainChanged: { files: ['docs/adr/adr-021-y.md'], unclassifiable: [] },
    }),
  );
  // The code certification stands: no suite reads a record, so the tree the
  // verdict judged is the tree that ships.
  assert.equal(out.code.answer, 'kept');
  assert.equal(out.records.answer, 'rerun');
  // The run does not go straight to the request. It goes to the stage that
  // owns the records, and the word says which of the two sent it.
  assert.equal(out.taken, false);
  assert.equal(out.refusal, 'records-rerun');
});

test('a moved base outside both grounds carries both certifications', () => {
  const out = fastPathVerdict(inputs({ records: NEIGHBOURHOOD }));
  assert.equal(out.taken, true, out.detail);
  assert.equal(out.code.answer, 'kept');
  assert.equal(out.records.answer, 'kept');
  // The records answer says why it stands, so a reader of a half-carry can
  // tell a reconciliation that was carried from one that was never asked.
  assert.equal(out.records.reason, 'no-record-moved');
});

test('a ground hit is the code\'s refusal alone, and the records answer on their own evidence', () => {
  // A finding is a reading of the code. The reconciliation never rested on
  // it, so copying this refusal onto the records answer would send the run to
  // the record round for a fact about the code.
  const out = fastPathVerdict(
    inputs({
      records: NEIGHBOURHOOD,
      lensFindings: [{ id: 'operational/F-1', ground: ['src/api'] }],
      mainChanged: { files: ['src/api/other.mjs'], unclassifiable: [] },
    }),
  );
  assert.equal(out.taken, false);
  assert.equal(out.refusal, 'lens-ground');
  assert.equal(out.code.answer, 'rejudge');
  assert.equal(out.records.answer, 'kept');
  assert.equal(out.records.reason, 'no-record-moved');

  // And the records answer is the records' own: a neighbour of the run moving
  // beside the ground hit re-runs the reconciliation as well.
  const both = fastPathVerdict(
    inputs({
      records: NEIGHBOURHOOD,
      lensFindings: [{ id: 'operational/F-1', ground: ['src/api'] }],
      mainChanged: { files: ['src/api/other.mjs', 'docs/adr/adr-021-y.md'], unclassifiable: [] },
    }),
  );
  assert.equal(both.code.answer, 'rejudge');
  assert.equal(both.records.answer, 'rerun');
  assert.equal(both.records.reason, 'neighbourhood');
});

test('a record the run itself wrote reaches the records answer of a ground hit', () => {
  // The `own` list rides the answer computed beside a code refusal, exactly as
  // it rides the answer computed for a clean base. Without it a merge that
  // moved a record this run wrote would read `kept`.
  const out = fastPathVerdict(
    inputs({
      records: NEIGHBOURHOOD,
      lensFindings: [{ id: 'operational/F-1', ground: ['src/api'] }],
      storyChanged: ['src/api/f.mjs', 'docs/adr/adr-030-mine.md'],
      mainChanged: {
        files: ['src/api/other.mjs', 'docs/adr/adr-030-mine.md'],
        unclassifiable: [],
      },
    }),
  );
  assert.equal(out.records.answer, 'rerun');
  assert.equal(out.records.reason, 'own-record');
});

test('every refusal but the two one-sided ones is copied onto both answers', () => {
  // The rule and its two exceptions in one reading. A refusal is a
  // certification this check could not carry, and it says the same thing to
  // every certification in scope unless it belongs to one of them.
  const both = [
    ['diff-changed', { storyDiffAfter: 'diff --git a/src/api/f.mjs\n+moved\n' }],
    ['no-breadth-ground', { breadth: [] }],
    ['no-suite-ground', { testPaths: [] }],
    ['undeclared-suite', { prior: new Map([['unit', result([part('api')])]]) }],
    ['self-declared-ground', { storyChanged: ['.olympus/gates/unit.mjs'] }],
  ];
  for (const [refused, over] of both) {
    const out = fastPathVerdict(inputs({ records: NEIGHBOURHOOD, ...over }));
    assert.equal(out.refusal, refused);
    assert.equal(out.code.answer, 'rejudge', refused);
    assert.equal(out.records.answer, 'rerun', refused);
    assert.equal(out.records.reason, refused);
  }
});

test('a records lane is judged on its records alone', () => {
  // No code verdict, so no declared suite ground, no lens findings, and no
  // suite files to ask about. Asking anyway would refuse every ship the lane
  // takes.
  const lane = inputs({
    certification: null,
    records: NEIGHBOURHOOD,
    layers: [],
    prior: new Map(),
    breadth: [],
    testPaths: [],
    storyChanged: ['docs/adr/adr-030-mine.md'],
    mainChanged: { files: ['src/api/other.mjs'], unclassifiable: [] },
  });
  const out = fastPathVerdict(lane);
  assert.equal(out.taken, true, out.detail);
  assert.equal(out.code, null);
  assert.equal(out.records.answer, 'kept');
  // Its own record moving on the branch is the one thing that re-runs it.
  const conflicted = fastPathVerdict({
    ...lane,
    mainChanged: { files: ['docs/adr/adr-030-mine.md'], unclassifiable: [] },
  });
  assert.equal(conflicted.records.answer, 'rerun');
  assert.equal(conflicted.records.reason, 'own-record');
  assert.equal(conflicted.refusal, 'records-rerun');
});

test('a reconciliation the lane cannot show leaves the code question to the code', () => {
  // A records fact says nothing about the code. Copying it onto the code
  // answer sends the run back to the verdict for something the verdict never
  // decided, which is the same class as a code refusal copied onto the
  // records answer.
  const settled = {
    answer: 'rerun',
    reason: 'no-certification',
    detail: 'no green reconciliation stands for this tree',
    files: [],
  };
  const out = fastPathVerdict(inputs({ records: NEIGHBOURHOOD, recordsSettled: settled }));
  assert.equal(out.taken, false);
  assert.equal(out.refusal, 'no-certification');
  assert.equal(out.code.answer, 'kept');
  assert.deepEqual(out.records, settled);

  // The settled answer survives a code refusal beside it: each side keeps the
  // reason that is its own.
  const refused = fastPathVerdict(
    inputs({
      records: NEIGHBOURHOOD,
      recordsSettled: settled,
      mainChanged: changed('src/api/other.mjs'),
    }),
  );
  assert.equal(refused.refusal, 'ground-intersects');
  assert.equal(refused.code.answer, 'rejudge');
  assert.equal(refused.records.reason, 'no-certification');
});

test('a lane that certifies nothing carries nothing', () => {
  const out = fastPathVerdict(inputs({ certification: null, records: null }));
  assert.equal(out.taken, false);
  assert.equal(out.refusal, 'no-certification');
});

test('a refusal carries the answer for every certification in scope', () => {
  const out = fastPathVerdict(
    inputs({ records: NEIGHBOURHOOD, storyDiffAfter: 'diff --git a/src/api/f.mjs\n+moved\n' }),
  );
  assert.equal(out.refusal, 'diff-changed');
  assert.equal(out.code.answer, 'rejudge');
  assert.equal(out.records.answer, 'rerun');
  assert.equal(out.records.reason, 'diff-changed');
});

test('the standing green of a layer comes from the last cycle that ran it', () => {
  // A record-only cycle runs the record layers and skips the rest, so the code
  // layers hold no result of their own under it. The declaration comes off the
  // cycle that earned the green, however many cycles ago that was.
  const ledger = [
    { event: 'layer-result', cycle: 1, layer: 'unit', status: 'green', parts: [part('api', ['src/api'])] },
    { event: 'layer-result', cycle: 1, layer: 'form', status: 'green', parts: [part('form', ['docs/adr'])] },
    { event: 'layer-result', cycle: 2, layer: 'form', status: 'green', parts: [part('form', ['docs/adr'])] },
  ];
  const out = declaredGround([layer('unit'), layer('form')], priorStatus(ledger, 3), {
    breadth: ['package-lock.json'],
  });
  assert.equal(out.ok, true, out.detail);
  assert.deepEqual(out.suites, ['form/form', 'unit/api']);
});

test('the certification a lane names is the render at that sha', () => {
  const ledger = [
    { event: 'verdict-rendered', cycle: 2, verdict: 'green', sha: 'aaa', record: '/r/v2.json' },
    { event: 'verdict-rendered', cycle: 4, verdict: 'red', sha: 'bbb', record: '/r/v4.json' },
  ];
  // A caller that names no lane reads the last render and takes it only where
  // it is green, exactly as it did before a run held two certifications.
  assert.equal(codeCertification(ledger, undefined), null);
  assert.deepEqual(codeCertification(ledger.slice(0, 1), undefined), {
    cycle: 2,
    sha: 'aaa',
    record: '/r/v2.json',
  });
  // A lane that names the code tree it certified is answered from the render
  // at that sha, whatever was rendered after it.
  assert.deepEqual(codeCertification(ledger, { ok: true, sha: 'aaa' }), {
    cycle: 2,
    sha: 'aaa',
    record: '/r/v2.json',
  });
  // A lane that holds a certification the ledger cannot show, and a lane whose
  // certification is not green, each carry nothing.
  assert.equal(codeCertification(ledger, { ok: true, sha: 'ccc' }), null);
  assert.equal(codeCertification(ledger, { ok: false, sha: 'aaa' }), null);
  assert.equal(codeCertification(ledger, null), null);
});

test('no-certification is refused for a certification the lane has and for no other', async () => {
  // Each of these ends before the first git read, so the routes are decided
  // from the lane's own statement and the ledger alone.
  const base = { worktree: '/nowhere', config: { gates: {} } };
  const shas = { fromSha: 'f', toSha: 't', mainSha: 'm' };
  const none = await fastPathDecision(base, [], shas, {
    certification: { code: null, records: null },
  });
  assert.equal(none.refusal, 'no-certification');
  // A lane that holds a code certification the ledger cannot show.
  const unshown = await fastPathDecision(base, [], shas, {
    certification: { code: { ok: true, sha: 'aaa' }, records: null },
  });
  assert.equal(unshown.refusal, 'no-certification');
  assert.equal(unshown.code.answer, 'rejudge');
  assert.equal(unshown.records, null);
  // A records lane whose reconciliation is not green. The code certification
  // it does not hold is asked about nowhere.
  const red = await fastPathDecision(base, [], shas, {
    certification: { code: null, records: { ok: false, sha: 'bbb' } },
  });
  assert.equal(red.refusal, 'no-certification');
  assert.equal(red.records.answer, 'rerun');
  assert.equal(red.code, null);
});

// -- a spectrum of forty layers, most of them silent --------------------------
//
// The shape a real project has: a few layers whose runner prints the part
// protocol, and many more that are single-purpose gate scripts running one
// check and exiting. The silent ones declare nothing about themselves, so
// before the config ground the first of them refused every ship of that
// project, for ever, and the only sign of it was one word in a ledger.

/** The runner the self-declaring layers share, and the helper it prints from. */
const SUITE_TREE = {
  'scripts/run-suite.mjs': "import { families } from './lib/inputs.mjs';\nconsole.log(families);\n",
  'scripts/lib/inputs.mjs': 'export const families = [];\n',
};

/**
 * Forty Tier-1 layers, each with a config ground, and a standing green for
 * each. Thirty-two run a bare command and print no part of their own. Eight
 * run the shared runner and declare their parts, and the last of those holds
 * two prerequisite steps that declare no inputs at all.
 */
function spectrumOfForty() {
  const layers = [];
  const prior = new Map();
  const commands = {};
  for (let i = 1; i <= 40; i++) {
    const name = `gate-${String(i).padStart(2, '0')}`;
    const declares = i > 32;
    layers.push({ name, command: name, ground: [`src/mod-${String(i).padStart(2, '0')}`] });
    commands[name] = declares
      ? ['node', 'scripts/run-suite.mjs', name]
      : ['pnpm', `check:${name}`];
    const parts = !declares
      ? []
      : i === 40
        ? [
            // The two prerequisites: they are not suites, so the runner states
            // no family for them and they print no inputs.
            part('path-budget'),
            part('compile'),
            part('suite-a', [`src/mod-${i}/a`]),
            part('suite-b', [`src/mod-${i}/b`]),
            part('suite-c', [`src/mod-${i}/c`]),
            part('suite-d', [`src/mod-${i}/d`]),
          ]
        : [part(`suite-${i}`, [`src/mod-${i}`])];
    prior.set(name, result(parts));
  }
  return { layers, prior, commands };
}

/** Eleven planning cards, which is ground the project declares inert. */
const ELEVEN_CARDS = Array.from({ length: 11 }, (_, i) => `.olympus/cards/story-${i + 1}.md`);

function fortyLayerInputs(overrides = {}) {
  const { layers, prior, commands } = spectrumOfForty();
  return {
    certification: CERTIFICATION,
    layers,
    prior,
    commands,
    readSource: sourceTree(SUITE_TREE),
    testPaths: ['tests'],
    breadth: ['package-lock.json', 'db/migrations'],
    inert: ['.olympus/cards', '.olympus/constitution.md'],
    lensFindings: [],
    storyDiffBefore: 'diff --git a/src/mod-05/f.mjs b/src/mod-05/f.mjs\n',
    storyDiffAfter: 'diff --git a/src/mod-05/f.mjs b/src/mod-05/f.mjs\n',
    mainChanged: { files: [...ELEVEN_CARDS], unclassifiable: [] },
    storyChanged: ['src/mod-05/f.mjs'],
    ...overrides,
  };
}

test('a spectrum whose silent layers carry a config ground ships over inert ground', () => {
  // The refusal this repairs, replayed from facts. Every layer is green, the
  // story's patch is unchanged, and the default branch gained eleven planning
  // cards, which the project declares inert. Before the config ground, the
  // first silent layer refused the whole check on a fact about itself that had
  // nothing to do with the merge.
  const out = fastPathVerdict(fortyLayerInputs());
  assert.equal(out.taken, true, out.detail);
  // Eight layers answered for themselves and forty were answered for by the
  // config. A reading that moves to seven declared says a runner stopped
  // printing its markers, and nothing else in the record says so.
  assert.deepEqual(out.declaration.ground, { declared: 8, config: 40 });
  // Seven single-part layers and the six steps of the last one, two of which
  // declared no inputs and stand on that layer's config ground.
  assert.equal(out.declaration.suites.length, 13);
  assert.ok(out.declaration.suites.includes('gate-40/path-budget'));
  assert.deepEqual(out.certification, CERTIFICATION);
});

test('the same spectrum refuses when the branch moves real source', () => {
  // The proof the mechanism still refuses when it should. One card of the
  // eleven becomes a source file under a layer's ground, and the detail names
  // the file.
  const files = [...ELEVEN_CARDS.slice(0, 10), 'src/mod-05/api.mjs'];
  const out = fastPathVerdict(fortyLayerInputs({ mainChanged: { files, unclassifiable: [] } }));
  assert.equal(out.taken, false);
  assert.equal(out.refusal, 'ground-intersects');
  assert.match(out.detail, /src\/mod-05\/api\.mjs/);
});

test('the same spectrum refuses when the branch moves the config the run pinned', () => {
  // The config now carries the ground of forty layers. A run judges against the
  // blob it pinned at its launch, so a branch that has widened a layer's ground
  // since decided nothing this run may stand on.
  const files = [...ELEVEN_CARDS.slice(0, 10), '.olympus/project.json'];
  const out = fastPathVerdict(fortyLayerInputs({ mainChanged: { files, unclassifiable: [] } }));
  assert.equal(out.taken, false);
  assert.equal(out.refusal, 'ground-intersects');
  assert.match(out.detail, /\.olympus\/project\.json is the project config the run pinned/);
  // A project that pins its config elsewhere is judged against the file it
  // pinned, and the default path claims nothing for it.
  const moved = fastPathVerdict(
    fortyLayerInputs({
      configPath: 'ops/olympus.json',
      mainChanged: { files, unclassifiable: [] },
    }),
  );
  assert.equal(moved.refusal, 'unclaimed-ground');
});

test('the declaration walk covers the self-reporting layers and no others', () => {
  // A layer whose ground is config-only is produced in no tree, so a story
  // cannot narrow it and there is nothing to bound. Thirty-two of the forty
  // run `pnpm check:<name>`, which names no file of this repository, and the
  // check takes the fast path anyway.
  assert.equal(fastPathVerdict(fortyLayerInputs()).taken, true);
  // A layer that DOES declare its parts is walked, and a command of the same
  // shape refuses there.
  const { layers, prior, commands } = spectrumOfForty();
  commands['gate-33'] = ['pnpm', 'check:gate-33'];
  const out = fastPathVerdict(fortyLayerInputs({ layers, prior, commands }));
  assert.equal(out.taken, false);
  assert.equal(out.refusal, 'self-declared-ground');
  assert.match(out.detail, /gate-33 runs a command that names no file/);
});

test('a spectrum no command declares at all still bounds nothing and still ships', () => {
  // Every layer config-ground only: no marker of the run's tree decides this
  // skip, so the declaration surface is empty and refuses nothing.
  const { layers, commands } = spectrumOfForty();
  const prior = new Map(layers.map((l) => [l.name, result([])]));
  const out = fastPathVerdict(fortyLayerInputs({ layers, prior, commands }));
  assert.equal(out.taken, true, out.detail);
  assert.deepEqual(out.declaration.ground, { declared: 0, config: 40 });
  assert.deepEqual(out.declaration.suites, []);
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
    ground: ['unit src/api'],
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
  // The config ground is a claim like any other, so the version moves when one
  // entry of one layer's list moves.
  assert.notEqual(declarationDigest({ ...base, ground: ['unit src/core'] }), declarationDigest(base));
  assert.notEqual(
    declarationDigest({ ...base, ground: ['unit src/api', 'lint src/api'] }),
    declarationDigest(base),
  );
  // And a layer's name is part of the line: the same entry under another layer
  // is another claim.
  assert.notEqual(declarationDigest({ ...base, ground: ['lint src/api'] }), declarationDigest(base));
});

// -- a layer that carried the branch's own certification ---------------------

/** The standing result of a layer that carried a base certification. */
const carriedResult = (baseSha = 'b'.repeat(40)) => ({
  event: 'layer-result',
  status: 'green',
  mode: 'carried',
  carriedFrom: 'base',
  baseSha,
  certifiedSeq: 12,
});

test('a carried layer is a standing green, and the config ground is what it rests on', () => {
  const out = fastPathVerdict(
    inputs({
      layers: [{ name: 'unit', command: 'unit', ground: ['src/api'] }],
      prior: new Map([['unit', carriedResult()]]),
    }),
  );
  assert.equal(out.taken, true, `the fast path refused: ${out.refusal} (${out.detail})`);
  // The layer ran nothing here, so it names no suite of its own, and the claim
  // it rests on is the project's config ground for it.
  assert.deepEqual(out.declaration.suites, []);
  assert.deepEqual(out.declaration.ground, { declared: 0, config: 1 });
  // And the tree the green was earned at is named per layer, because one
  // certification now rests on more than one sha.
  assert.deepEqual(out.declaration.carried, [{ layer: 'unit', sha: 'b'.repeat(40) }]);
  assert.equal(out.declaration.sha, CERTIFICATION.sha);
});

test('a carried layer with no config ground refuses, because nothing declares it', () => {
  // Its own command declared nothing here and the project declares nothing for
  // it, so no claim in this project says the branch left its ground alone.
  const out = fastPathVerdict(
    inputs({
      layers: [layer('unit')],
      prior: new Map([['unit', carriedResult()]]),
    }),
  );
  assert.equal(out.taken, false);
  assert.equal(out.refusal, 'undeclared-suite');
});

test('a carried layer whose ground the branch moved refuses on that ground', () => {
  const out = fastPathVerdict(
    inputs({
      layers: [{ name: 'unit', command: 'unit', ground: ['src/api'] }],
      prior: new Map([['unit', carriedResult()]]),
      mainChanged: { files: ['src/api/other.mjs'], unclassifiable: [] },
    }),
  );
  assert.equal(out.taken, false);
  assert.equal(out.refusal, 'ground-intersects');
});

test('a layer the run itself ran names no carried tree', () => {
  const out = fastPathVerdict(inputs());
  assert.equal(out.declaration.carried, undefined);
});
