import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONSTITUTION_PATH,
  DEFAULT_DIFF_EXCLUSIONS,
  DEFAULT_EXCERPT_CHARS,
  DEFAULT_RECONCILE_ROUNDS,
  DEFAULT_RECORD_LIFECYCLE,
  RECORD_LIFECYCLES,
  validateProjectConfig,
  withProjectDefaults,
  parseProjectConfig,
  isGlobEntry,
  recordPathIncludes,
  underEntry,
} from '../src/config/project.mjs';

function valid() {
  return {
    version: 1,
    repo: { testPaths: ['test/'], uiPaths: ['src/ui/'] },
    commands: { lint: ['run-lint'], test: ['node', '--test'] },
    gates: {
      tier1: [
        { name: 'lint', command: 'lint' },
        { name: 'test', command: 'test', needs: ['lint'] },
      ],
    },
    conventions: ['write to the ledger'],
    lanes: { story: { suiteCommand: 'test', greenTarget: 1 } },
    stack: { composeFile: 'compose.harness.yml', env: { NODE_ENV: 'test' } },
    tripwires: [
      {
        id: 'escapes',
        metric: 'escapes-window',
        window: 10,
        breach: { op: '>', value: 0.5 },
        answer: 'restore the cut',
      },
    ],
  };
}

function errorPaths(config) {
  return validateProjectConfig(config).map((e) => e.path);
}

test('a full config validates clean', () => {
  assert.deepEqual(validateProjectConfig(valid()), []);
});

// The tree a project keeps its decision records in. It decides which review
// findings are record findings and which diffs the record lens reads, and
// nothing else: neither the reconciliation judge nor the write seat's
// containment check reads it (ADR-0026).
test('repo.recordPaths is an optional path list, defaulted to the common record tree', () => {
  assert.deepEqual(withProjectDefaults({ version: 1 }).repo.recordPaths, ['docs/adr']);
  assert.deepEqual(
    withProjectDefaults({ version: 1, repo: { recordPaths: ['decisions/**'] } }).repo.recordPaths,
    ['decisions/**'],
  );
  const declared = valid();
  declared.repo.recordPaths = ['docs/decisions', 'packages/*/docs/adr'];
  assert.deepEqual(validateProjectConfig(declared), []);
  // An empty list turns the path rule off. The reconciliation cycle still
  // raises record findings: that rule reads the phase, not a path.
  const none = valid();
  none.repo.recordPaths = [];
  assert.deepEqual(validateProjectConfig(none), []);
  const wrong = valid();
  wrong.repo.recordPaths = 'docs/adr';
  assert.deepEqual(errorPaths(wrong), ['repo.recordPaths']);
});

// The one path list that carries exclusions. A record tree holds a file that is
// not a record, and the template is that file: it is out of the enumeration,
// out of the neighbourhood and out of the scope by one entry (ADR-0026).
test('a repo.recordPaths entry may exclude a file with !', () => {
  const declared = valid();
  declared.repo.recordPaths = ['docs/adr', '!docs/adr/TEMPLATE.md'];
  assert.deepEqual(validateProjectConfig(declared), []);
  assert.equal(recordPathIncludes('docs/adr/adr-001-first.md', declared.repo.recordPaths), true);
  assert.equal(recordPathIncludes('docs/adr/TEMPLATE.md', declared.repo.recordPaths), false);
  // An exclusion wins over every entry that includes the file, in any order.
  assert.equal(recordPathIncludes('docs/adr/TEMPLATE.md', ['!docs/adr/TEMPLATE.md', 'docs/adr']), false);
  assert.equal(recordPathIncludes('docs/adr/adr-001.md', ['!docs/adr/**']), false);
  // A file no entry names is not a record.
  assert.equal(recordPathIncludes('src/feature.mjs', ['docs/adr']), false);
  assert.equal(recordPathIncludes('docs/adr/adr-001.md', []), false);
  // A glob entry includes and excludes under the same path vocabulary.
  assert.equal(
    recordPathIncludes('packages/ui/docs/adr/adr-001.md', ['packages/*/docs/adr/**']),
    true,
  );
  assert.equal(
    recordPathIncludes('packages/ui/docs/adr/TEMPLATE.md', [
      'packages/*/docs/adr/**',
      '!packages/*/docs/adr/TEMPLATE.md',
    ]),
    false,
  );
  // `!` alone excludes nothing and reads like an exclusion, so it is refused.
  const bare = valid();
  bare.repo.recordPaths = ['docs/adr', '!'];
  assert.deepEqual(errorPaths(bare), ['repo.recordPaths[1]']);
});

// How a change to an accepted record is made. Two words, and a third value is
// refused rather than read as `rewrite`: a project that asked for `supersede`
// and misspelled it would keep the lifecycle it asked to leave (ADR-0026).
test('repo.recordLifecycle is rewrite or supersede, and defaults to rewrite', () => {
  assert.deepEqual(RECORD_LIFECYCLES, ['rewrite', 'supersede']);
  assert.equal(DEFAULT_RECORD_LIFECYCLE, 'rewrite');
  assert.equal(withProjectDefaults({ version: 1 }).repo.recordLifecycle, 'rewrite');
  for (const word of RECORD_LIFECYCLES) {
    const config = valid();
    config.repo.recordLifecycle = word;
    assert.deepEqual(validateProjectConfig(config), [], word);
    assert.equal(withProjectDefaults(config).repo.recordLifecycle, word);
  }
  for (const value of ['Supersede', 'immutable', '', 1, null]) {
    const bad = valid();
    bad.repo.recordLifecycle = value;
    assert.deepEqual(errorPaths(bad), ['repo.recordLifecycle'], String(value));
  }
});

// The style rule files a record seat reads beside the constitution: a list of
// repo-relative paths, empty by default.
test('repo.styleFiles is a string list and defaults to empty', () => {
  assert.deepEqual(withProjectDefaults({ version: 1 }).repo.styleFiles, []);
  const config = valid();
  config.repo.styleFiles = ['docs/style/asd-ste100.md', 'docs/style/anti-slop.md'];
  assert.deepEqual(validateProjectConfig(config), []);
  assert.deepEqual(withProjectDefaults(config).repo.styleFiles, config.repo.styleFiles);
  const bad = valid();
  bad.repo.styleFiles = 'docs/style/asd-ste100.md';
  assert.deepEqual(errorPaths(bad), ['repo.styleFiles']);
});

// The Tier-1 layers a changed record path is attributed to. A typo turns record
// attribution into no layers at all, and a record-only render then greens with
// nothing run, so the name is validated against the layer list (ADR-0026).
test('gates.recordLayers names gates.tier1 layers, and defaults to none', () => {
  assert.deepEqual(withProjectDefaults({ version: 1 }).gates.recordLayers, []);
  const declared = valid();
  declared.gates.recordLayers = ['lint'];
  assert.deepEqual(validateProjectConfig(declared), []);
  const two = valid();
  two.gates.recordLayers = ['lint', 'test'];
  assert.deepEqual(validateProjectConfig(two), []);
  const unknown = valid();
  unknown.gates.recordLayers = ['adr-form'];
  assert.deepEqual(errorPaths(unknown), ['gates.recordLayers[0]']);
  const wrong = valid();
  wrong.gates.recordLayers = 'lint';
  assert.deepEqual(errorPaths(wrong), ['gates.recordLayers']);
});

// The reconciliation's own round cap. It is not the code repair cap and it
// never moves it: the two work products have different seats and different
// costs (ADR-0007).
test('gates.reconcileRounds is an optional positive integer', () => {
  // Five. A record round is one seat and the layers a record diff reaches; the
  // route behind the cap is a whole repair run with a full spectrum.
  assert.equal(DEFAULT_RECONCILE_ROUNDS, 5);
  const declared = valid();
  declared.gates.reconcileRounds = 2;
  assert.deepEqual(validateProjectConfig(declared), []);
  for (const value of [0, -1, 2.5, '5']) {
    const bad = valid();
    bad.gates.reconcileRounds = value;
    assert.deepEqual(errorPaths(bad), ['gates.reconcileRounds'], String(value));
  }
});

test('repo.routesRoot is a plain repo-relative path, or null to turn the route rule off', () => {
  // The default stands for a project that names none, and a project's own
  // value replaces it. Null is the explicit "no routes root".
  assert.equal(withProjectDefaults({ version: 1 }).repo.routesRoot, 'apps/storefront/src/routes');
  assert.equal(
    withProjectDefaults({ version: 1, repo: { routesRoot: 'web/routes' } }).repo.routesRoot,
    'web/routes',
  );
  assert.equal(withProjectDefaults({ version: 1, repo: { routesRoot: null } }).repo.routesRoot, null);
  for (const routesRoot of ['web/routes', null]) {
    const config = valid();
    config.repo.routesRoot = routesRoot;
    assert.deepEqual(validateProjectConfig(config), []);
  }
  for (const routesRoot of ['', 7, '/abs/routes', 'C:\\routes', 'apps/*/routes']) {
    const config = valid();
    config.repo.routesRoot = routesRoot;
    assert.deepEqual(errorPaths(config), ['repo.routesRoot'], String(routesRoot));
  }
});

test('repo.componentsRoot is a plain repo-relative path, or null to turn rule (m) off', () => {
  assert.equal(
    withProjectDefaults({ version: 1 }).repo.componentsRoot,
    'apps/storefront/src/lib/components',
  );
  assert.equal(
    withProjectDefaults({ version: 1, repo: { componentsRoot: 'web/ui' } }).repo.componentsRoot,
    'web/ui',
  );
  assert.equal(
    withProjectDefaults({ version: 1, repo: { componentsRoot: null } }).repo.componentsRoot,
    null,
  );
  for (const componentsRoot of ['web/ui', null]) {
    const config = valid();
    config.repo.componentsRoot = componentsRoot;
    assert.deepEqual(validateProjectConfig(config), []);
  }
  for (const componentsRoot of ['', 7, '/abs/ui', 'C:\\ui', 'apps/*/ui']) {
    const config = valid();
    config.repo.componentsRoot = componentsRoot;
    assert.deepEqual(errorPaths(config), ['repo.componentsRoot'], String(componentsRoot));
  }
});

test('gates.allowlistPaths is a list of path entries', () => {
  const config = valid();
  config.gates.allowlistPaths = ['apps/storefront/src/lib/allowlists/**'];
  assert.deepEqual(validateProjectConfig(config), []);
  for (const bad of ['one', [7], [''], {}]) {
    const wrong = valid();
    wrong.gates.allowlistPaths = bad;
    assert.deepEqual(errorPaths(wrong), ['gates.allowlistPaths'], JSON.stringify(bad));
  }
});

test('version must be 1', () => {
  assert.deepEqual(errorPaths({ ...valid(), version: 2 }), ['version']);
});

test('commands must be non-empty argv arrays of strings', () => {
  const config = valid();
  config.commands.empty = [];
  config.commands.notArgv = 'run-lint';
  const paths = errorPaths(config);
  assert.ok(paths.includes('commands.empty'));
  assert.ok(paths.includes('commands.notArgv'));
});

test('a gate layer must name a key in commands', () => {
  const config = valid();
  config.gates.tier1.push({ name: 'build', command: 'missing' });
  assert.deepEqual(errorPaths(config), ['gates.tier1[2].command']);
});

test('a gate prerequisite must name an earlier layer', () => {
  const config = valid();
  config.gates.tier1[0].needs = ['test']; // later layer — order violation
  assert.deepEqual(errorPaths(config), ['gates.tier1[0].needs']);
});

test('a gate layer may declare what its process tree is allowed to hold', () => {
  // Optional, and a statement rather than a limit (ADR-0045): a layer that
  // declares one is watched as a fraction of it, and a layer that declares
  // nothing is watched for a climb alone. A figure that is not an amount of
  // memory would read as a ceiling and set none, which is the direction a
  // typo here must not be allowed to be wrong in.
  const config = valid();
  config.gates.tier1[0].memoryCeilingMb = 4096;
  assert.deepEqual(validateProjectConfig(config), []);
  for (const bad of [0, -1, 'lots', null, NaN]) {
    const wrong = valid();
    wrong.gates.tier1[1].memoryCeilingMb = bad;
    assert.deepEqual(errorPaths(wrong), ['gates.tier1[1].memoryCeilingMb'], String(bad));
  }
  // A config that declares none is exactly the config it was before the field
  // existed: no default is filled in, so nothing is watched against a guess.
  assert.equal(withProjectDefaults(valid()).gates.tier1[0].memoryCeilingMb, undefined);
});

test('a project may turn part-level carrying off, and only with a boolean', () => {
  // The fallback path of ADR-0046. Absent is the decision — the harness
  // carries a part a diff cannot reach — and `false` returns every layer to a
  // whole re-run per cycle. A value that is not a boolean would read as a
  // switch and be one, so it is refused.
  const off = valid();
  off.gates.partTargeting = false;
  assert.deepEqual(validateProjectConfig(off), []);
  assert.equal(withProjectDefaults(off).gates.partTargeting, false);
  for (const bad of ['no', 0, null]) {
    const wrong = valid();
    wrong.gates.partTargeting = bad;
    assert.deepEqual(errorPaths(wrong), ['gates.partTargeting'], String(bad));
  }
  assert.equal(withProjectDefaults(valid()).gates.partTargeting, undefined);
});

test('a project may send the flake re-run back over the whole layer, by name', () => {
  // Absent is the decision — the re-run asks for the parts and the files that
  // failed — and `whole` is the one-line revert to the re-run every project
  // ran before the key existed. A word outside the pair is refused: a
  // misspelling that read as "narrowed" would be a saving nobody asked for.
  assert.equal(withProjectDefaults(valid()).gates.flakeRerun, undefined);
  for (const word of ['narrowed', 'whole']) {
    const set = valid();
    set.gates.flakeRerun = word;
    assert.deepEqual(validateProjectConfig(set), [], word);
    assert.equal(withProjectDefaults(set).gates.flakeRerun, word);
  }
  for (const bad of ['none', false, 1, null]) {
    const wrong = valid();
    wrong.gates.flakeRerun = bad;
    assert.deepEqual(errorPaths(wrong), ['gates.flakeRerun'], String(bad));
  }
});

test('a layer ground is a list of path entries wherever the config is read', () => {
  // The shape is checked like every other field. The presence is not: see the
  // launch rule below.
  const config = valid();
  config.gates.tier1[0].ground = ['src/lint', 'scripts/lint.mjs'];
  assert.deepEqual(validateProjectConfig(config), []);
  for (const bad of ['src', [], [''], [2], {}]) {
    const wrong = valid();
    wrong.gates.tier1[1].ground = bad;
    assert.deepEqual(errorPaths(wrong), ['gates.tier1[1].ground'], JSON.stringify(bad));
  }
});

test('a launch under the fast path refuses a layer whose ground nothing declares', () => {
  // The refusal the whole plan exists for, moved to the config. A layer with no
  // ground refuses every ship of that project, every time, and the only sign of
  // it is one word in a ledger. Here it is one error naming the layer, before a
  // run exists (ADR-0056).
  const config = valid();
  config.gates.fastPathShip = true;
  config.gates.breadthGround = ['package-lock.json'];
  const errors = validateProjectConfig(config, { launch: true });
  assert.deepEqual(
    errors.map((e) => e.path),
    ['gates.tier1[0].ground', 'gates.tier1[1].ground'],
  );
  assert.match(errors[0].message, /layer lint declares no ground/);
  assert.match(errors[0].message, /refuses every ship/);
  // Every layer with a ground, and the launch is clean.
  config.gates.tier1[0].ground = ['src'];
  config.gates.tier1[1].ground = ['src', 'test'];
  assert.deepEqual(validateProjectConfig(config, { launch: true }), []);
});

test('a launch under the fast path refuses a ground entry that can match no path', () => {
  // `.` reads like a declaration of the whole repository and matches no file,
  // because the path vocabulary compares a plain entry as a prefix. It is
  // refused at the config rather than at the ship.
  const config = valid();
  config.gates.fastPathShip = true;
  config.gates.tier1[0].ground = ['src'];
  config.gates.tier1[1].ground = ['src', '.', '/etc/passwd', 'a/../b'];
  assert.deepEqual(
    validateProjectConfig(config, { launch: true }).map((e) => e.path),
    ['gates.tier1[1].ground[1]', 'gates.tier1[1].ground[2]', 'gates.tier1[1].ground[3]'],
  );
});

test('the ground rule is armed by the fast-path flag and by nothing else', () => {
  // A project that has not opted in is validated exactly as it was before this
  // field existed, at the launch and everywhere else. That is the whole answer
  // to the wedge risk: `gates.fastPathShip: false` disarms the rule with the
  // feature, and it is the same line the revert uses.
  const off = valid();
  assert.deepEqual(validateProjectConfig(off, { launch: true }), []);
  off.gates.fastPathShip = false;
  assert.deepEqual(validateProjectConfig(off, { launch: true }), []);
  // And the rule binds the launch alone: a live run re-parses the blob it
  // pinned at every lane stage, and a rule born after that pin would fault the
  // run mid-flight.
  const on = valid();
  on.gates.fastPathShip = true;
  assert.deepEqual(validateProjectConfig(on), []);
});

test('the fast path is off unless a project says otherwise, in a boolean', () => {
  // ADR-0056. Absent is the decision: a moved base costs the full re-verdict
  // it always cost, and the one-line revert is this flag going back to false.
  assert.equal(withProjectDefaults(valid()).gates.fastPathShip, undefined);
  const on = valid();
  on.gates.fastPathShip = true;
  on.gates.breadthGround = ['package-lock.json', 'db/migrations'];
  on.gates.inertGround = ['docs'];
  assert.deepEqual(validateProjectConfig(on), []);
  assert.equal(withProjectDefaults(on).gates.fastPathShip, true);
  for (const bad of ['yes', 1, null]) {
    const wrong = valid();
    wrong.gates.fastPathShip = bad;
    assert.deepEqual(errorPaths(wrong), ['gates.fastPathShip'], String(bad));
  }
  // The breadth list is path entries, in the same vocabulary as every other
  // path section. A list of something else would be read as ground and be none.
  for (const bad of ['src', [''], [2], {}]) {
    const wrong = valid();
    wrong.gates.breadthGround = bad;
    assert.deepEqual(errorPaths(wrong), ['gates.breadthGround'], JSON.stringify(bad));
  }
  // The inert list is the other side of the same claim and takes the same
  // vocabulary: the ground the project states no suite of it can reach.
  for (const bad of ['docs', [''], [2], {}]) {
    const wrong = valid();
    wrong.gates.inertGround = bad;
    assert.deepEqual(errorPaths(wrong), ['gates.inertGround'], JSON.stringify(bad));
  }
});

test('a project may declare the ground no suite of it reads', () => {
  // ADR-0059. A third list, and a third claim. Absent is the empty list, which
  // is the behaviour every project had before the field existed.
  assert.equal(withProjectDefaults(valid()).gates.groundlessPaths, undefined);
  const declared = valid();
  declared.gates.groundlessPaths = ['docs', '.olympus/cards/**'];
  assert.deepEqual(validateProjectConfig(declared), []);
  assert.deepEqual(withProjectDefaults(declared).gates.groundlessPaths, [
    'docs',
    '.olympus/cards/**',
  ]);
  // Path entries, in the same vocabulary as every other path section.
  for (const bad of ['docs', [''], [2], {}]) {
    const wrong = valid();
    wrong.gates.groundlessPaths = bad;
    assert.deepEqual(errorPaths(wrong), ['gates.groundlessPaths'], JSON.stringify(bad));
  }
  // It is its own field and not the ship path's. Declaring one says nothing
  // about the other, and the two readers never consult each other's list.
  const one = valid();
  one.gates.groundlessPaths = ['docs'];
  assert.equal(withProjectDefaults(one).gates.inertGround, undefined);
});

test('duplicate layer names and tripwire ids are refused', () => {
  const config = valid();
  config.gates.tier1.push({ name: 'lint', command: 'lint' });
  config.tripwires.push({ id: 'escapes', metric: 'other' });
  const paths = errorPaths(config);
  assert.ok(paths.includes('gates.tier1[2].name'));
  assert.ok(paths.includes('tripwires[1].id'));
});

test('a tripwire requires an id and a metric', () => {
  const config = valid();
  config.tripwires = [{ id: 'x' }];
  assert.deepEqual(errorPaths(config), ['tripwires[0].metric']);
});

test('stack: composeFile must be repo-relative, env values strings', () => {
  const absolute = valid();
  absolute.stack.composeFile = '/etc/compose.yml';
  assert.deepEqual(errorPaths(absolute), ['stack.composeFile']);
  const winAbsolute = valid();
  winAbsolute.stack.composeFile = 'C:\\compose.yml';
  assert.deepEqual(errorPaths(winAbsolute), ['stack.composeFile']);
  const badEnv = valid();
  badEnv.stack.env = { PORT: 5432 };
  assert.deepEqual(errorPaths(badEnv), ['stack.env.PORT']);
});

test('defaults fill every missing section', () => {
  const filled = withProjectDefaults({ version: 1 });
  assert.deepEqual(filled.repo, {
    testPaths: [],
    uiPaths: [],
    // A project that declares no record tree gets the common one, so the record
    // rule runs with no config line at all (ADR-0026).
    recordPaths: ['docs/adr'],
    // And it keeps the lifecycle every project had before the key existed.
    recordLifecycle: 'rewrite',
    routesRoot: 'apps/storefront/src/routes',
    componentsRoot: 'apps/storefront/src/lib/components',
  });
  assert.deepEqual(filled.commands, {});
  assert.deepEqual(filled.gates, { tier1: [], recordLayers: [] });
  assert.deepEqual(filled.conventions, []);
  assert.deepEqual(filled.review, {
    lenses: ['spec', 'operational', 'security', 'interface'],
    excludeFromDiff: DEFAULT_DIFF_EXCLUSIONS,
    excerptChars: DEFAULT_EXCERPT_CHARS,
  });
  assert.deepEqual(filled.lanes, {});
  assert.equal(filled.stack, null);
  assert.deepEqual(filled.tripwires, []);
  assert.equal(filled.constitutionPath, DEFAULT_CONSTITUTION_PATH);
  assert.deepEqual(filled.credentials, []);
  assert.equal(filled.closeout, null);
});

// The panel a project declares replaces the default one, which is how a cut
// lens comes back. A name outside the vocabulary is refused rather than
// dropped: dropping it shrinks the panel, and a shrunk panel judges less and
// still says green.
test('the review panel takes lens names from the closed set, and a declared set replaces the default', () => {
  const restored = ['spec', 'architecture', 'minimality', 'operational', 'security', 'interface'];
  assert.deepEqual(validateProjectConfig({ ...valid(), review: { lenses: restored } }), []);
  assert.deepEqual(withProjectDefaults({ version: 1, review: { lenses: restored } }).review.lenses, restored);
  assert.deepEqual(errorPaths({ ...valid(), review: { lenses: ['spec', 'style'] } }), [
    'review.lenses[1]',
  ]);
  assert.deepEqual(errorPaths({ ...valid(), review: { lenses: ['spec', 'spec'] } }), [
    'review.lenses[1]',
  ]);
  assert.deepEqual(errorPaths({ ...valid(), review: { lenses: [] } }), ['review.lenses']);
  assert.deepEqual(errorPaths({ ...valid(), review: { lens: ['spec'] } }), ['review.lens']);
  assert.deepEqual(errorPaths({ ...valid(), review: ['spec'] }), ['review']);
});

// The paths whose content the review seat is not given. A value that is not a
// list of path entries is refused rather than ignored: an ignored filter hands
// the seat the diff the project meant to keep out of it, and the round still
// says green.
test('the review diff exclusions take a path list, and refuse anything else', () => {
  const excludeFromDiff = ['**/pnpm-lock.yaml', 'build/**'];
  assert.deepEqual(validateProjectConfig({ ...valid(), review: { excludeFromDiff } }), []);
  assert.deepEqual(
    withProjectDefaults({ version: 1, review: { excludeFromDiff } }).review.excludeFromDiff,
    excludeFromDiff,
  );
  // An empty list is a project that filters nothing, and it is legal.
  assert.deepEqual(validateProjectConfig({ ...valid(), review: { excludeFromDiff: [] } }), []);
  assert.deepEqual(errorPaths({ ...valid(), review: { excludeFromDiff: 'pnpm-lock.yaml' } }), [
    'review.excludeFromDiff',
  ]);
  assert.deepEqual(errorPaths({ ...valid(), review: { excludeFromDiff: { '0': 'a' } } }), [
    'review.excludeFromDiff',
  ]);
  assert.deepEqual(errorPaths({ ...valid(), review: { excludeFromDiff: ['a', ''] } }), [
    'review.excludeFromDiff',
  ]);
});

// How much of the candidate diff the brief carries inline. It bounds the brief
// and nothing else: the whole diff is a file the brief names at every value.
test('the review excerpt takes a positive integer of characters', () => {
  assert.deepEqual(validateProjectConfig({ ...valid(), review: { excerptChars: 40_000 } }), []);
  assert.equal(
    withProjectDefaults({ version: 1, review: { excerptChars: 40_000 } }).review.excerptChars,
    40_000,
  );
  assert.equal(withProjectDefaults({ version: 1 }).review.excerptChars, DEFAULT_EXCERPT_CHARS);
  for (const excerptChars of [0, -1, 1.5, '12000', null]) {
    assert.deepEqual(
      errorPaths({ ...valid(), review: { excerptChars } }),
      ['review.excerptChars'],
      `${excerptChars} passed validation`,
    );
  }
});

test('the close-out learning block takes two absolute paths, or is absent', () => {
  const learning = { instructions: '/skills/teach.md', workspace: '/home/learning' };
  assert.deepEqual(validateProjectConfig({ ...valid(), closeout: { learning } }), []);
  assert.deepEqual(
    validateProjectConfig({
      ...valid(),
      closeout: { learning: { instructions: 'C:\\skills\\teach.md', workspace: 'D:/learning' } },
    }),
    [],
  );
  // Absent is the off switch and validates clean; an empty section is inert.
  assert.deepEqual(validateProjectConfig({ ...valid(), closeout: {} }), []);
  assert.deepEqual(errorPaths({ ...valid(), closeout: [] }), ['closeout']);
  assert.deepEqual(errorPaths({ ...valid(), closeout: { lessons: learning } }), ['closeout.lessons']);
  assert.deepEqual(errorPaths({ ...valid(), closeout: { learning: 'on' } }), ['closeout.learning']);
  assert.deepEqual(errorPaths({ ...valid(), closeout: { learning: { ...learning, mood: 'x' } } }), [
    'closeout.learning.mood',
  ]);
  // Both paths are required, and a repo-relative one would reach a tree that
  // is removed at close.
  assert.deepEqual(errorPaths({ ...valid(), closeout: { learning: {} } }), [
    'closeout.learning.instructions',
    'closeout.learning.workspace',
  ]);
  for (const bad of ['docs/teach.md', '', 7]) {
    assert.deepEqual(
      errorPaths({ ...valid(), closeout: { learning: { ...learning, instructions: bad } } }),
      ['closeout.learning.instructions'],
    );
  }
  assert.deepEqual(
    errorPaths({ ...valid(), closeout: { learning: { ...learning, workspace: 'var/learning' } } }),
    ['closeout.learning.workspace'],
  );
  const parsed = parseProjectConfig(JSON.stringify({ version: 1, closeout: { learning } }), 'fixture');
  assert.deepEqual(parsed.closeout.learning, learning);
});

test('a credential names one variable and a probe command', () => {
  const config = valid();
  config.credentials = [{ name: 'payments', env: 'PAY_SECRET_KEY', probe: 'lint' }];
  assert.deepEqual(validateProjectConfig(config), []);
  assert.deepEqual(errorPaths({ ...valid(), credentials: {} }), ['credentials']);
  assert.deepEqual(errorPaths({ ...valid(), credentials: ['payments'] }), ['credentials[0]']);
  assert.deepEqual(
    errorPaths({ ...valid(), credentials: [{ name: 'payments', env: 'PAY_SECRET_KEY' }] }),
    ['credentials[0].probe'],
  );
  assert.deepEqual(
    errorPaths({ ...valid(), credentials: [{ name: 'payments', env: 'PAY_SECRET_KEY', probe: 'absent' }] }),
    ['credentials[0].probe'],
  );
  // One name, never a pattern, and never a value.
  for (const env of ['PAY_SECRET_*', '2FA_TOKEN', 'PAY KEY', '', 7]) {
    assert.deepEqual(errorPaths({ ...valid(), credentials: [{ name: 'payments', env, probe: 'lint' }] }), [
      'credentials[0].env',
    ]);
  }
  assert.deepEqual(
    errorPaths({
      ...valid(),
      credentials: [
        { name: 'payments', env: 'PAY_SECRET_KEY', probe: 'lint' },
        { name: 'payments', env: 'PAY_OTHER_KEY', probe: 'lint' },
      ],
    }),
    ['credentials[1].name'],
  );
});

test('a credential CI surface names one secret and the workflows that read it', () => {
  const ci = { secret: 'PAY_SECRET_KEY', workflows: ['.github/workflows/pr.yml'] };
  const entry = { name: 'payments', env: 'PAY_SECRET_KEY', probe: 'lint' };
  assert.deepEqual(validateProjectConfig({ ...valid(), credentials: [{ ...entry, ci }] }), []);
  // No block at all is the statement that the credential has no CI surface.
  assert.deepEqual(validateProjectConfig({ ...valid(), credentials: [entry] }), []);
  assert.deepEqual(errorPaths({ ...valid(), credentials: [{ ...entry, ci: 'yes' }] }), [
    'credentials[0].ci',
  ]);
  // Either half alone still leaves a job running without the value.
  assert.deepEqual(
    errorPaths({ ...valid(), credentials: [{ ...entry, ci: { secret: 'PAY_SECRET_KEY' } }] }),
    ['credentials[0].ci.workflows'],
  );
  assert.deepEqual(
    errorPaths({ ...valid(), credentials: [{ ...entry, ci: { workflows: ['pr.yml'] } }] }),
    ['credentials[0].ci.secret'],
  );
  for (const secret of ['PAY_*', '2FA', 'PAY KEY', '', 7]) {
    assert.deepEqual(
      errorPaths({ ...valid(), credentials: [{ ...entry, ci: { ...ci, secret } }] }),
      ['credentials[0].ci.secret'],
    );
  }
  assert.deepEqual(errorPaths({ ...valid(), credentials: [{ ...entry, ci: { ...ci, workflows: [] } }] }), [
    'credentials[0].ci.workflows',
  ]);
  // A workflow is read out of the repository, so the path is repo-relative.
  assert.deepEqual(
    errorPaths({ ...valid(), credentials: [{ ...entry, ci: { ...ci, workflows: ['/etc/pr.yml'] } }] }),
    ['credentials[0].ci.workflows[0]'],
  );
  assert.deepEqual(errorPaths({ ...valid(), credentials: [{ ...entry, ci: { ...ci, host: 'x' } }] }), [
    'credentials[0].ci.host',
  ]);
});

test('a label rule names one label and the paths that require it', () => {
  const config = valid();
  config.labels = [
    { label: 'migration', paths: ['db/migrations'] },
    { label: 'ui', paths: ['src/ui/**', 'assets'] },
  ];
  assert.deepEqual(validateProjectConfig(config), []);
  assert.deepEqual(errorPaths({ ...valid(), labels: {} }), ['labels']);
  assert.deepEqual(errorPaths({ ...valid(), labels: ['migration'] }), ['labels[0]']);
  // A label with no paths behind it would fire on nothing and read as covered.
  assert.deepEqual(errorPaths({ ...valid(), labels: [{ label: 'migration' }] }), [
    'labels[0].paths',
  ]);
  assert.deepEqual(errorPaths({ ...valid(), labels: [{ label: 'migration', paths: [] }] }), [
    'labels[0].paths',
  ]);
  assert.deepEqual(errorPaths({ ...valid(), labels: [{ paths: ['db'] }] }), ['labels[0].label']);
  assert.deepEqual(
    errorPaths({
      ...valid(),
      labels: [
        { label: 'migration', paths: ['db'] },
        { label: 'migration', paths: ['sql'] },
      ],
    }),
    ['labels[1].label'],
  );
  const parsed = parseProjectConfig(JSON.stringify({ version: 1 }), 'fixture');
  assert.deepEqual(parsed.labels, []);
});

test('constitutionPath defaults, and an absolute path is refused', () => {
  assert.deepEqual(validateProjectConfig({ ...valid(), constitutionPath: 'docs/policy.md' }), []);
  assert.deepEqual(errorPaths({ ...valid(), constitutionPath: '/etc/policy.md' }), [
    'constitutionPath',
  ]);
  assert.deepEqual(errorPaths({ ...valid(), constitutionPath: 'C:\\policy.md' }), [
    'constitutionPath',
  ]);
  assert.deepEqual(errorPaths({ ...valid(), constitutionPath: '' }), ['constitutionPath']);
  assert.deepEqual(errorPaths({ ...valid(), constitutionPath: 7 }), ['constitutionPath']);
  const config = parseProjectConfig(JSON.stringify({ version: 1 }), 'fixture');
  assert.equal(config.constitutionPath, DEFAULT_CONSTITUTION_PATH);
  const named = parseProjectConfig(
    JSON.stringify({ version: 1, constitutionPath: 'docs/policy.md' }),
    'fixture',
  );
  assert.equal(named.constitutionPath, 'docs/policy.md');
});

test('parseProjectConfig names every validation error', () => {
  assert.throws(
    () => parseProjectConfig(JSON.stringify({ version: 2, commands: { x: [] } }), 'fixture'),
    /version: must be 1.*commands\.x/s,
  );
});

test('parseProjectConfig rejects broken JSON with the source named', () => {
  assert.throws(() => parseProjectConfig('{not json', 'alpha main:.olympus/project.json'), {
    message: /not valid JSON.*alpha main/,
  });
});

test('parseProjectConfig returns a defaults-filled config', () => {
  const config = parseProjectConfig(JSON.stringify({ version: 1 }), 'fixture');
  assert.equal(config.stack, null);
  assert.deepEqual(config.gates.tier1, []);
});

test('the story lane names its commands and requires test paths', () => {
  const noSuite = valid();
  delete noSuite.lanes.story.suiteCommand;
  assert.deepEqual(errorPaths(noSuite), ['lanes.story.suiteCommand']);
  const badLint = valid();
  badLint.lanes.story.lintCommand = 'nope';
  assert.deepEqual(errorPaths(badLint), ['lanes.story.lintCommand']);
  const noTests = valid();
  noTests.repo.testPaths = [];
  assert.deepEqual(errorPaths(noTests), ['repo.testPaths']);
  const okLint = valid();
  okLint.lanes.story.lintCommand = 'lint';
  assert.deepEqual(validateProjectConfig(okLint), []);
});

test('the story suite command must be carried by a Tier-1 layer at launch', () => {
  // The verdict runs the Tier-1 layers alone, so a suite no layer runs is a
  // suite that never meets the implemented tree.
  const ungated = valid();
  ungated.gates.tier1 = [{ name: 'lint', command: 'lint' }];
  assert.deepEqual(
    validateProjectConfig(ungated, { launch: true }).map((e) => e.path),
    ['lanes.story.suiteCommand'],
  );
  // The rule binds launches only: a live run re-parses the blob it pinned at
  // launch, and a rule born after that pin must not fault it mid-flight.
  assert.deepEqual(validateProjectConfig(ungated), []);
  // The layer may name the suite anything; the command is what runs.
  const renamed = valid();
  renamed.gates.tier1 = [{ name: 'acceptance', command: 'test' }];
  assert.deepEqual(validateProjectConfig(renamed, { launch: true }), []);
  // An empty gate list is a project that declares no Tier-1 layer at all, and
  // the run refuses on that ground; this rule adds nothing to it.
  const noGates = valid();
  noGates.gates.tier1 = [];
  assert.deepEqual(validateProjectConfig(noGates, { launch: true }), []);
});

test('the story lane names its suite checks in order, each one a command it holds', () => {
  // The list the pre-freeze chain and the re-freeze run over every suite write
  // (ADR-0071). The order is the project's, and it carries every dependency
  // between the checks.
  const ordered = valid();
  ordered.lanes.story.suiteChecks = ['lint', 'test'];
  assert.deepEqual(validateProjectConfig(ordered), []);
  // An empty list is a project that wants no check, which is what every project
  // had before the field existed.
  const none = valid();
  none.lanes.story.suiteChecks = [];
  assert.deepEqual(validateProjectConfig(none), []);
  // A name the command table does not hold would reach the seat as a check
  // nothing can run, so it is refused at the door instead.
  const unknown = valid();
  unknown.lanes.story.suiteChecks = ['lint', 'nope'];
  assert.deepEqual(errorPaths(unknown), ['lanes.story.suiteChecks[1]']);
  for (const value of ['lint', {}, null]) {
    const bad = valid();
    bad.lanes.story.suiteChecks = value;
    assert.deepEqual(errorPaths(bad), ['lanes.story.suiteChecks'], String(value));
  }
  // A check named twice runs twice and buys nothing the first run did not.
  const twice = valid();
  twice.lanes.story.suiteChecks = ['lint', 'lint'];
  assert.deepEqual(errorPaths(twice), ['lanes.story.suiteChecks[1]']);
});

test('the one-entry check field is read alone and must agree with the list', () => {
  // `groundCommand` is the field `suiteChecks` replaced. A config that still
  // names it alone keeps exactly the check it had.
  const alone = valid();
  alone.lanes.story.groundCommand = 'lint';
  assert.deepEqual(validateProjectConfig(alone), []);
  const unknown = valid();
  unknown.lanes.story.groundCommand = 'nope';
  assert.deepEqual(errorPaths(unknown), ['lanes.story.groundCommand']);
  // While both fields are read, by two daemons on two versions, a check only
  // one of them runs is a difference no project declared.
  const agreed = valid();
  agreed.lanes.story.suiteChecks = ['lint', 'test'];
  agreed.lanes.story.groundCommand = 'lint';
  assert.deepEqual(validateProjectConfig(agreed), []);
  const split = valid();
  split.lanes.story.suiteChecks = ['test'];
  split.lanes.story.groundCommand = 'lint';
  assert.deepEqual(errorPaths(split), ['lanes.story.groundCommand']);
});

test('a raised adversary wave count is a positive integer or an error', () => {
  const raised = valid();
  raised.lanes.story.adversaryWaves = 3;
  assert.deepEqual(validateProjectConfig(raised), []);
  for (const value of [0, -1, 1.5, '3']) {
    const bad = valid();
    bad.lanes.story.adversaryWaves = value;
    assert.deepEqual(errorPaths(bad), ['lanes.story.adversaryWaves'], String(value));
  }
});

test('the card-authorized supersede switch is a boolean or an error', () => {
  // The fallback path of ADR-0044: `false` returns every frozen-surface
  // collision to the owner. Absent is the decision itself.
  for (const value of [true, false]) {
    const config = valid();
    config.lanes.story.cardAuthorizedSupersede = value;
    assert.deepEqual(validateProjectConfig(config), []);
  }
  for (const value of ['false', 0, null]) {
    const bad = valid();
    bad.lanes.story.cardAuthorizedSupersede = value;
    assert.deepEqual(errorPaths(bad), ['lanes.story.cardAuthorizedSupersede'], String(value));
  }
});

test('glob test paths validate clean', () => {
  const config = valid();
  config.repo.testPaths = ['test/', 'src/**/*.test.ts', '**/*.spec.ts'];
  assert.deepEqual(validateProjectConfig(config), []);
});

test('isGlobEntry: metacharacters make a glob; plain prefixes stay prefixes', () => {
  assert.equal(isGlobEntry('tests'), false);
  assert.equal(isGlobEntry('e2e/'), false);
  assert.equal(isGlobEntry('src/**/*.test.ts'), true);
  assert.equal(isGlobEntry('**/*.spec.ts'), true);
  assert.equal(isGlobEntry('a/b?.mjs'), true);
  assert.equal(isGlobEntry('a/[ab].mjs'), true);
});

test('underEntry: a prefix contains its subtree and itself only', () => {
  assert.ok(underEntry('tests/a.test.mjs', 'tests'));
  assert.ok(underEntry('tests/deep/a.test.mjs', 'tests/'));
  assert.ok(underEntry('tests', 'tests'));
  assert.ok(!underEntry('tests2/a.test.mjs', 'tests'));
  assert.ok(underEntry('tests\\deep\\a.test.mjs', 'tests'));
});

test('underEntry: glob semantics match git :(glob) pathspec magic', () => {
  // `*` never crosses a slash.
  assert.ok(underEntry('src/a.test.ts', 'src/*.test.ts'));
  assert.ok(!underEntry('src/deep/a.test.ts', 'src/*.test.ts'));
  // `/**/` matches zero or more directories.
  assert.ok(underEntry('src/a.test.ts', 'src/**/*.test.ts'));
  assert.ok(underEntry('src/deep/nest/a.test.ts', 'src/**/*.test.ts'));
  assert.ok(!underEntry('src/deep/a.ts', 'src/**/*.test.ts'));
  assert.ok(!underEntry('other/a.test.ts', 'src/**/*.test.ts'));
  // A leading `**/` matches at the root too.
  assert.ok(underEntry('a.spec.ts', '**/*.spec.ts'));
  assert.ok(underEntry('deep/nest/a.spec.ts', '**/*.spec.ts'));
  assert.ok(!underEntry('deep/a.spec.ts.bak', '**/*.spec.ts'));
  // A trailing `/**` matches everything inside, not the directory itself.
  assert.ok(underEntry('e2e/deep/a.mjs', 'e2e/**'));
  assert.ok(!underEntry('e2e', 'e2e/**'));
  // `?` matches one character inside a segment; `[...]` is a class.
  assert.ok(underEntry('src/a1.mjs', 'src/a?.mjs'));
  assert.ok(!underEntry('src/a/b.mjs', 'src/a?.mjs'));
  assert.ok(underEntry('src/ab.mjs', 'src/a[bc].mjs'));
  assert.ok(!underEntry('src/ad.mjs', 'src/a[bc].mjs'));
  // Asterisks not slash-bounded act as regular asterisks.
  assert.ok(underEntry('src/axxb.mjs', 'src/a**b.mjs'));
  assert.ok(!underEntry('src/ax/xb.mjs', 'src/a**b.mjs'));
  // Literal dots never widen the match.
  assert.ok(!underEntry('src/aXtest.ts', 'src/a.test.ts'));
});

// -- concurrency groups and the run cache ------------------------------------

test('a project may let gate layers hold the machine together', () => {
  // ADR-0047. Absent is the strict sequence, and a group is the project
  // saying which of its own layers may run at the same time. The arming, the
  // tuning and the revert are edits of this one field.
  const config = valid();
  config.commands.smoke = ['run-smoke'];
  config.gates.tier1.push({ name: 'smoke', command: 'smoke' });
  config.gates.concurrencyGroups = [['test', 'smoke']];
  assert.deepEqual(validateProjectConfig(config), []);
  assert.deepEqual(withProjectDefaults(config).gates.concurrencyGroups, [['test', 'smoke']]);
  // A project that says nothing keeps the sequence and gets no default.
  assert.equal(withProjectDefaults(valid()).gates.concurrencyGroups, undefined);
});

test('a concurrency group is refused when it would mean nothing or two things', () => {
  const at = (mutate) => {
    const config = valid();
    config.commands.smoke = ['run-smoke'];
    config.gates.tier1.push({ name: 'smoke', command: 'smoke' });
    mutate(config.gates);
    return errorPaths(config);
  };
  // Not a list of groups at all.
  assert.deepEqual(at((g) => (g.concurrencyGroups = 'lint,test')), ['gates.concurrencyGroups']);
  assert.deepEqual(at((g) => (g.concurrencyGroups = [['lint'], 5])), [
    'gates.concurrencyGroups[0]',
    'gates.concurrencyGroups[1]',
  ]);
  // A layer nothing declares: the group would silently never form.
  assert.deepEqual(at((g) => (g.concurrencyGroups = [['test', 'ghost']])), [
    'gates.concurrencyGroups[0][1]',
  ]);
  // One layer, two groups: no answer to which group it runs in. The same
  // rule catches a name repeated inside one group.
  assert.deepEqual(at((g) => (g.concurrencyGroups = [['test', 'smoke'], ['smoke', 'lint']])), [
    'gates.concurrencyGroups[1][0]',
  ]);
  assert.deepEqual(at((g) => (g.concurrencyGroups = [['smoke', 'smoke']])), [
    'gates.concurrencyGroups[0][1]',
  ]);
  // A prerequisite cannot run beside the layer that needs it.
  assert.deepEqual(at((g) => (g.concurrencyGroups = [['lint', 'test']])), [
    'gates.concurrencyGroups[0][1]',
  ]);
});

test('a project may turn the per-run cache off, and only with a boolean', () => {
  // The fallback path of ADR-0048: `false` offers a run's commands no cache
  // directory, and every one of them transforms and builds from zero.
  const off = valid();
  off.runCache = false;
  assert.deepEqual(validateProjectConfig(off), []);
  assert.equal(withProjectDefaults(off).runCache, false);
  for (const bad of ['no', 0, null]) {
    const wrong = valid();
    wrong.runCache = bad;
    assert.deepEqual(errorPaths(wrong), ['runCache'], String(bad));
  }
  // A project that says nothing gets the cache.
  assert.equal(withProjectDefaults(valid()).runCache, true);
});
