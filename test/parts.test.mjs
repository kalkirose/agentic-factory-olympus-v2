// Part-level targeting inside one gate layer (ADR-0046): the mapping that
// decides which parts of a layer a diff could have reached, the marker
// protocol a command declares that mapping with, and what the spectrum does
// with the answer — narrow the command, carry the rest with provenance, and
// refuse the carry in the confirmation sweep.
//
// And the record of the decision (ADR-0058): the reason every part that ran
// was run for, the paths the mapping could attribute to nothing, and the share
// of the cycle's part work the cycle did not have to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { runCommand } from '../src/lanes/exec.mjs';
import {
  PARTS_ENV,
  PART_REASONS,
  partPlan,
  partReasons,
  carriedParts,
  carryTally,
  mergeCarried,
  withPartReasons,
} from '../src/lanes/parts.mjs';
import { runSpectrum } from '../src/lanes/spectrum.mjs';
import { partTargets } from '../src/lanes/verdict.mjs';
import { tempDir, removeDir, initOriginRepo, commitTree, gitSync } from './helpers.mjs';

function fixture(t) {
  const root = tempDir('olympus-parts-');
  const paths = scaffoldHome(join(root, 'home'));
  mkdirSync(join(paths.runs, 'r1'), { recursive: true });
  const store = openRunStore(paths, 'r1');
  t.after(() => {
    store.close();
    removeDir(root);
  });
  return { root, ctx: { store, paths, runId: 'r1' } };
}

function events(ctx) {
  return readEvents(runLedgerPath(ctx.paths, ctx.runId));
}

/** A standing result with a part table, as a layer stamps one. */
function prior(cycle, parts) {
  return { cycle, sha: `sha${cycle}`, seq: cycle, status: 'red', parts };
}

const ALPHA = { name: 'alpha', status: 'green', inputs: ['apps/alpha', 'tests/alpha'] };
const BETA = { name: 'beta', status: 'green', inputs: ['apps/beta', 'tests/beta'] };

/**
 * The reasons of a plan, as a plain object, for comparison alone. The
 * derivation keys them in a Map because a part name is whatever a command
 * printed, and a name like `constructor` or `__proto__` on a plain object
 * either reads a reason it never had or silently keeps none.
 */
const asObject = (reasons) => Object.fromEntries(reasons);

// -- the mapping -------------------------------------------------------------

test('a part runs when the diff reaches its inputs, and carries when it does not', () => {
  const plan = partPlan(prior(1, [ALPHA, BETA]), ['apps/alpha/mail.tsx']);
  assert.deepEqual(plan.narrow.run, ['alpha']);
  assert.deepEqual(plan.narrow.carry, [
    { name: 'beta', status: 'green', inputs: BETA.inputs, carriedFrom: 1 },
  ]);
  // The part that ran says why, and the part that carried says nothing: a
  // carry has a provenance, not a reason.
  assert.deepEqual(asObject(plan.reasons), { alpha: 'touched' });
});

test('a path no part claims re-runs every part: doubt always re-runs', () => {
  // The classes the plan names — a lockfile, a shared package, a migration, a
  // config file — are one class to this derivation: nothing declared them.
  for (const blind of [
    'package-lock.json',
    'packages/shared/index.ts',
    'db/migrations/0001.sql',
    '.olympus/project.json',
  ]) {
    const plan = partPlan(prior(1, [ALPHA, BETA]), ['apps/alpha/mail.tsx', blind]);
    assert.equal(plan.narrow, null, `${blind} narrowed the layer`);
    // The layer runs whole, and the record says which path made it. Every
    // part reads `blind`, including the one the diff also touched: the cycle
    // could attribute nothing, so nothing about a single part explains it.
    assert.deepEqual(asObject(plan.reasons), { alpha: 'blind', beta: 'blind' });
    assert.deepEqual(plan.blindPaths, [blind]);
  }
});

test('a blind record names three paths and no more', () => {
  const unclaimed = ['a.lock', 'b.lock', 'c.lock', 'd.lock', 'e.lock'];
  const plan = partPlan(prior(1, [ALPHA, BETA]), unclaimed);
  // The record is a diagnosis, not a diff. Three name the class; four hundred
  // would ride every layer stamp of every cycle.
  assert.deepEqual(plan.blindPaths, ['a.lock', 'b.lock', 'c.lock']);
});

test('a part that declared no input set is reached by everything', () => {
  const bare = { name: 'gamma', status: 'green' };
  const plan = partPlan(prior(1, [ALPHA, bare]), ['apps/alpha/mail.tsx']);
  assert.equal(plan.narrow, null, 'a part nothing maps was allowed to carry');
  assert.deepEqual(asObject(plan.reasons), { alpha: 'touched', gamma: 'undeclared' });
  // Beside a part that does map, the bare one runs and the mapped one carries
  // — the bare part's own reach is total, not the layer's.
  const mixed = partPlan(prior(1, [ALPHA, BETA, bare]), ['apps/alpha/mail.tsx']);
  assert.deepEqual(mixed.narrow.run, ['alpha', 'gamma']);
  assert.deepEqual(mixed.narrow.carry.map((p) => p.name), ['beta']);
  assert.deepEqual(asObject(mixed.reasons), { alpha: 'touched', gamma: 'undeclared' });
});

test('a part that was not proven green never carries, whatever the diff says', () => {
  for (const status of ['red', 'unknown', undefined]) {
    const plan = partPlan(prior(1, [{ ...ALPHA, status }, BETA]), ['apps/alpha/mail.tsx']);
    assert.ok(plan.narrow.run.includes('alpha'), `a ${status} part carried`);
    assert.deepEqual(plan.narrow.carry.map((p) => p.name), ['beta']);
  }
});

test('a layer with nothing to carry, or nothing to run, runs whole', () => {
  // Every part reached: the narrowing would name every part, which is the
  // command's own default, so there is no plan to make.
  const reached = partPlan(prior(1, [ALPHA, BETA]), ['apps/alpha/a', 'apps/beta/b']);
  assert.equal(reached.narrow, null);
  assert.deepEqual(asObject(reached.reasons), { alpha: 'touched', beta: 'touched' });
  // Every part carried: nothing left to run, so the layer runs as it did.
  const untouched = partPlan(prior(1, [ALPHA, BETA]), []);
  assert.equal(untouched.narrow, null);
  assert.deepEqual(asObject(untouched.reasons), {});
  // No part table at all: nothing is known, so nothing is claimed. The parts
  // answer for themselves where the execution names them.
  for (const empty of [partPlan(prior(1, []), ['apps/alpha/a']), partPlan(null, ['a'])]) {
    assert.equal(empty.narrow, null);
    assert.deepEqual(asObject(empty.reasons), {});
    assert.deepEqual(empty.blindPaths, []);
  }
});

test('provenance names the cycle that ran the part, not the cycle that carried it', () => {
  const first = partPlan(prior(1, [ALPHA, BETA]), ['apps/alpha/mail.tsx']);
  const carried = first.narrow.carry[0];
  assert.equal(carried.carriedFrom, 1);
  // The next cycle carries the same green again. It is still cycle 1's proof.
  const second = partPlan(prior(2, [{ ...ALPHA, status: 'green' }, carried]), [
    'apps/alpha/other.tsx',
  ]);
  assert.deepEqual(second.narrow.carry, [carried]);
});

// -- the reasons -------------------------------------------------------------

test('the reason set is exactly five words', () => {
  // Closed on purpose: a vocabulary that grows a word per case is a log line,
  // and the value of the field is that a reader can count it.
  assert.deepEqual(
    [...PART_REASONS].sort(),
    ['blind', 'no-record', 'not-green', 'touched', 'undeclared'],
  );
});

test('each of the five reasons is derived from the state that earns it', () => {
  const cases = [
    // touched: green, declared, and the diff reached its ground
    [prior(1, [ALPHA, BETA]), ['apps/alpha/mail.tsx'], { alpha: 'touched' }],
    // undeclared: the part declared nothing, so everything reaches it
    [
      prior(1, [ALPHA, { name: 'gamma', status: 'green' }]),
      ['apps/alpha/mail.tsx'],
      { alpha: 'touched', gamma: 'undeclared' },
    ],
    // blind: a changed path is under no part's ground
    [prior(1, [ALPHA, BETA]), ['package-lock.json'], { alpha: 'blind', beta: 'blind' }],
    // not-green: the standing result for the part was not a proven green
    [
      prior(1, [{ ...ALPHA, status: 'red' }, BETA]),
      ['apps/beta/api.ts'],
      { alpha: 'not-green', beta: 'touched' },
    ],
  ];
  for (const [record, changed, expected] of cases) {
    assert.deepEqual(asObject(partReasons(record, changed).reasons), expected);
  }
  // no-record is the fifth, and it is derived where the names are known: the
  // plan holds no opinion about a part the standing result did not hold.
  assert.deepEqual(
    withPartReasons([{ name: 'delta', status: 'green' }], new Map([['alpha', 'touched']])),
    [{ name: 'delta', status: 'green', reason: 'no-record' }],
  );
});

test('a part named after an object key is decided like any other part', () => {
  // A part name is whatever a command printed after `::olympus part`. Keyed in
  // a plain object, `constructor` reads a reason off the prototype and
  // `__proto__` keeps none at all, and the second of those carries a part that
  // has to run. Both are green here and neither is touched, so both carry.
  const hostile = [
    { name: 'constructor', status: 'green', inputs: ['apps/ctor'] },
    { name: '__proto__', status: 'green', inputs: ['apps/proto'] },
    { name: 'alpha', status: 'green', inputs: ['apps/alpha'] },
  ];
  const plan = partPlan(prior(1, hostile), ['apps/alpha/mail.tsx']);
  assert.deepEqual(plan.narrow.run, ['alpha']);
  assert.deepEqual(plan.narrow.carry.map((p) => p.name), ['constructor', '__proto__']);
  // And both re-run when the diff reaches them.
  const reached = partPlan(prior(1, hostile), ['apps/ctor/x', 'apps/proto/y']);
  assert.deepEqual(reached.narrow.run, ['constructor', '__proto__']);
  // Compared as entries, because an object literal cannot hold the second key
  // either: `{ __proto__: 'touched' }` sets no property at all. That is the
  // whole reason the derivation keys these in a Map.
  assert.deepEqual(
    [...reached.reasons],
    [
      ['constructor', 'touched'],
      ['__proto__', 'touched'],
    ],
  );
});

test('a part that is both touched and not green reads not-green', () => {
  // Both clauses hold. The record names the state of the part before the diff,
  // because a red part re-runs whatever the diff says and the reader who is
  // asking why the carry fell is asking about the greens.
  const record = prior(1, [{ ...ALPHA, status: 'red' }, BETA]);
  assert.equal(partReasons(record, ['apps/alpha/mail.tsx']).reasons.get('alpha'), 'not-green');
});

test('a defect of the mapping outranks an honest reason', () => {
  // undeclared beats blind, blind beats not-green, not-green beats touched.
  // The honest reason is read and forgotten; a missing declaration that hides
  // behind one is repaired by nobody, and it is the condition this record
  // exists to name.
  const bare = { name: 'gamma', status: 'red' };
  const blindDiff = ['package-lock.json', 'apps/alpha/mail.tsx'];
  const { reasons } = partReasons(prior(1, [{ ...ALPHA, status: 'red' }, BETA, bare]), blindDiff);
  assert.deepEqual(asObject(reasons), { alpha: 'blind', beta: 'blind', gamma: 'undeclared' });
});

test('a carried part is given no reason, and a reason is never invented', () => {
  const table = [
    { name: 'alpha', status: 'green' },
    { name: 'beta', status: 'green', carriedFrom: 1 },
  ];
  assert.deepEqual(withPartReasons(table, new Map([['alpha', 'touched']])), [
    { name: 'alpha', status: 'green', reason: 'touched' },
    { name: 'beta', status: 'green', carriedFrom: 1 },
  ]);
  // No plan for this layer at all: a confirmation sweep, or a full spectrum.
  // The table is untouched. Stamping `no-record` on a record nothing
  // consulted would report a hole that is not there.
  assert.deepEqual(withPartReasons(table, undefined), table);
  assert.throws(
    () => withPartReasons([{ name: 'alpha' }], new Map([['alpha', 'nearly']])),
    /unknown part/,
  );
});

// -- ground no suite reads ---------------------------------------------------

test('a groundless path leaves the diff before anything is attributed', () => {
  const groundless = ['docs', 'README.md'];
  // Alone in the diff it would have blinded the cycle. Filtered out, the diff
  // is empty and every part carries.
  const only = partPlan(prior(1, [ALPHA, BETA]), ['docs/adr/0001.md', 'README.md'], { groundless });
  assert.deepEqual(asObject(only.reasons), {});
  assert.deepEqual(only.blindPaths, []);
  assert.equal(only.narrow, null, 'a layer with nothing to run narrows nothing');
  // Beside a real change it neither blinds the cycle nor reaches a part.
  const beside = partPlan(prior(1, [ALPHA, BETA]), ['docs/adr/0001.md', 'apps/alpha/mail.tsx'], {
    groundless,
  });
  assert.deepEqual(beside.narrow.run, ['alpha']);
  assert.deepEqual(beside.blindPaths, []);
  // Without the declaration the same diff is blind, which is the whole cost
  // the list buys back.
  assert.deepEqual(
    partPlan(prior(1, [ALPHA, BETA]), ['docs/adr/0001.md', 'apps/alpha/mail.tsx']).blindPaths,
    ['docs/adr/0001.md'],
  );
});

test('groundless ground is matched in the vocabulary every path entry uses', () => {
  const groundless = ['docs/**/*.md'];
  const plan = partPlan(prior(1, [ALPHA, BETA]), ['docs/adr/0001.md'], { groundless });
  assert.deepEqual(plan.blindPaths, []);
  // The glob is anchored, so a path outside it is unaffected.
  assert.deepEqual(
    partPlan(prior(1, [ALPHA, BETA]), ['notes/adr/0001.md'], { groundless }).blindPaths,
    ['notes/adr/0001.md'],
  );
});

// -- the share ---------------------------------------------------------------

test('the carry share counts every part of a cycle, carried layers included', () => {
  const results = [
    // one layer that ran two parts and carried two
    {
      layer: 'acceptance',
      mode: 'run',
      parts: [
        { name: 'a', status: 'green' },
        { name: 'b', status: 'green' },
        { name: 'c', status: 'green', carriedFrom: 1 },
        { name: 'd', status: 'green', carriedFrom: 1 },
      ],
    },
    // a layer the cycle carried whole carried every part in it, whatever the
    // part's own line says: the layer's mode is the fact about this cycle.
    { layer: 'lint', mode: 'carried', parts: [{ name: 'e', status: 'green' }] },
    // a layer with no parts contributes nothing either way
    { layer: 'build', mode: 'run' },
  ];
  assert.deepEqual(carryTally(results), { partsRun: 2, partsCarried: 3, carryShare: 0.6 });
});

test('a cycle that recorded no part has no share at all', () => {
  // Nought over nought is not a share, and a metric that read it as zero would
  // report a decay in a project that runs no layer in parts.
  assert.equal(carryTally([{ layer: 'lint', mode: 'run' }]), null);
  assert.equal(carryTally([]), null);
});

test('the parts an execution stated beat the parts a plan would have carried', () => {
  const ran = [{ name: 'beta', status: 'red', output: 'it failed after all' }];
  const merged = mergeCarried(ran, [{ name: 'beta', status: 'green', carriedFrom: 1 }]);
  assert.deepEqual(merged, ran);
  assert.deepEqual(carriedParts({ parts: merged }), []);
});

// -- the marker protocol -----------------------------------------------------

/** A command that runs the parts it was asked for, in the marker protocol. */
function partsCmd(table) {
  const body = [
    `const table = ${JSON.stringify(table)};`,
    `const only = (process.env.${PARTS_ENV} || '').split(',').filter(Boolean);`,
    'let bad = 0;',
    'for (const part of table) {',
    '  if (only.length > 0 && !only.includes(part.name)) continue;',
    "  console.log('::olympus part ' + part.name);",
    "  console.log('::olympus part-inputs ' + part.inputs.join(' '));",
    '  console.log(part.name + ((part.red) ? " failed" : " passed"));',
    "  console.log('::olympus part-' + (part.red ? 'failed' : 'ok') + ' ' + part.name);",
    '  if (part.red) bad = 1;',
    '}',
    'process.exitCode = bad;',
  ].join('\n');
  return ['node', '-e', body];
}

test('a part states its own outcome and its own input set', async () => {
  const run = await runCommand(
    partsCmd([
      { name: 'alpha', inputs: ['apps/alpha', 'tests/alpha'], red: false },
      { name: 'beta', inputs: ['apps/beta'], red: true },
    ]),
  );
  assert.deepEqual(
    run.parts.map((p) => [p.name, p.ok, p.failed, p.inputs]),
    [
      ['alpha', true, false, ['apps/alpha', 'tests/alpha']],
      ['beta', false, true, ['apps/beta']],
    ],
  );
  assert.ok(!run.output.includes('::olympus'), 'a marker reached the tail');
});

test('an input line with no part open belongs to nothing', async () => {
  const run = await runCommand([
    'node',
    '-e',
    "console.log('::olympus part-inputs apps/orphan');console.log('::olympus part alpha');" +
      "console.log('::olympus part-ok alpha');",
  ]);
  assert.deepEqual(run.parts.map((p) => [p.name, p.inputs]), [['alpha', []]]);
});

// -- the spectrum ------------------------------------------------------------

const TABLE = [
  { name: 'alpha', inputs: ['apps/alpha'], red: false },
  { name: 'beta', inputs: ['apps/beta'], red: false },
];

async function spectrum(ctx, opts) {
  return runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'parts' }],
    commands: { parts: partsCmd(TABLE) },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
    ...opts,
  });
}

test('a green layer records its whole part table, with no output on it', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await spectrum(ctx);
  assert.deepEqual(
    results[0].parts.map((p) => [p.name, p.status, p.inputs, p.output]),
    [
      ['alpha', 'green', ['apps/alpha'], undefined],
      ['beta', 'green', ['apps/beta'], undefined],
    ],
  );
});

test('a red layer carries only the parts that passed on their own word', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await spectrum(ctx, {
    commands: {
      parts: partsCmd([TABLE[0], { name: 'beta', inputs: ['apps/beta'], red: true }]),
    },
  });
  assert.equal(results[0].status, 'red');
  assert.deepEqual(
    results[0].parts.map((p) => [p.name, p.status]),
    [
      ['alpha', 'green'],
      ['beta', 'red'],
    ],
  );
  // The red part is the evidence; the passed one prints nothing here.
  assert.equal(results[0].parts[0].output, undefined);
  assert.match(results[0].parts[1].output, /beta failed/);
});

test('a part inside a failure that said nothing about itself is unknown, and never carries', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await spectrum(ctx, {
    commands: {
      parts: [
        'node',
        '-e',
        "console.log('::olympus part alpha');console.log('::olympus part-inputs apps/alpha');" +
          "console.log('the runner died here');process.exitCode = 1;",
      ],
    },
  });
  assert.equal(results[0].parts[0].status, 'unknown');
  assert.equal(partPlan({ cycle: 1, parts: results[0].parts }, []).narrow, null);
});

/** A layer plan as `partTargets` builds one. `reasons` is stated as an object. */
function layerPlan({ run, carry, reasons = {}, blindPaths = [] }) {
  const plan = {
    narrow: run ? { run, carry } : null,
    reasons: new Map(Object.entries(reasons)),
    blindPaths,
  };
  return new Map([['acceptance', plan]]);
}

test('a narrowed layer runs the parts it was given and carries the rest, marked', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await spectrum(ctx, {
    parts: layerPlan({
      run: ['alpha'],
      carry: [{ name: 'beta', status: 'green', inputs: ['apps/beta'], carriedFrom: 1 }],
      reasons: { alpha: 'touched' },
    }),
  });
  assert.equal(results[0].status, 'green');
  assert.deepEqual(
    results[0].parts.map((p) => [p.name, p.status, p.carriedFrom, p.reason]),
    [
      ['alpha', 'green', undefined, 'touched'],
      ['beta', 'green', 1, undefined],
    ],
  );
  // The stamp says the same thing, so a reader of the ledger sees the carry.
  const stamped = events(ctx).find((e) => e.event === 'layer-result');
  assert.deepEqual(stamped.parts, results[0].parts);
  assert.deepEqual(carriedParts(stamped).map((p) => p.name), ['beta']);
});

test('a layer that runs whole records the reason every part of it ran', async (t) => {
  const { ctx } = fixture(t);
  // A blind cycle: every part runs, so nothing narrows and the record is the
  // only place the cost shows. The paths ride the result, not a part.
  const { results } = await spectrum(ctx, {
    parts: layerPlan({
      reasons: { alpha: 'blind', beta: 'blind' },
      blindPaths: ['package-lock.json'],
    }),
  });
  assert.deepEqual(
    results[0].parts.map((p) => [p.name, p.reason]),
    [
      ['alpha', 'blind'],
      ['beta', 'blind'],
    ],
  );
  assert.deepEqual(results[0].blindPaths, ['package-lock.json']);
  const stamped = events(ctx).find((e) => e.event === 'layer-result');
  assert.deepEqual(stamped.blindPaths, ['package-lock.json']);
});

test('a part the standing record did not hold reads no-record', async (t) => {
  const { ctx } = fixture(t);
  // The plan speaks for alpha alone. Beta is a part the last execution's table
  // did not hold: the command opened it new, or PART_LIMIT evicted it.
  const { results } = await spectrum(ctx, {
    parts: layerPlan({ reasons: { alpha: 'touched' } }),
  });
  assert.deepEqual(
    results[0].parts.map((p) => [p.name, p.reason]),
    [
      ['alpha', 'touched'],
      ['beta', 'no-record'],
    ],
  );
});

test('a layer the cycle planned nothing for records no reason at all', async (t) => {
  const { ctx } = fixture(t);
  // A full spectrum, and the confirmation sweep after it. Both run every part
  // by design, so no part of either owes a word about why.
  const { results } = await spectrum(ctx);
  assert.deepEqual(results[0].parts.map((p) => p.reason), [undefined, undefined]);
  const swept = await spectrum(ctx, {
    cycle: 2,
    confirmation: true,
    parts: layerPlan({ reasons: { alpha: 'touched' } }),
  });
  assert.deepEqual(swept.results[0].parts.map((p) => p.reason), [undefined, undefined]);
});

test('a command that ignores the narrowing is recorded for everything it ran', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await spectrum(ctx, {
    commands: {
      // No reading of the variable at all: the parts protocol without the
      // caller's half of it, which is every command that has not adopted it.
      parts: [
        'node',
        '-e',
        "for (const n of ['alpha','beta']) { console.log('::olympus part ' + n);" +
          "console.log('::olympus part-inputs apps/' + n);console.log('::olympus part-ok ' + n); }",
      ],
    },
    parts: layerPlan({
      run: ['alpha'],
      carry: [{ name: 'beta', status: 'green', carriedFrom: 1 }],
      reasons: { alpha: 'touched' },
    }),
  });
  assert.deepEqual(
    results[0].parts.map((p) => [p.name, p.carriedFrom]),
    [
      ['alpha', undefined],
      ['beta', undefined],
    ],
  );
  // The part the plan meant to carry ran anyway, so the record owes a reason
  // for it, and the plan holds none: the execution beat the plan.
  assert.deepEqual(results[0].parts.map((p) => p.reason), ['touched', 'no-record']);
});

// -- the cycle's targets -----------------------------------------------------
//
// What the verdict cycle derives before it runs a layer: the diff since that
// layer's standing result, read off the run's own worktree.

const LAYERS = [{ name: 'acceptance', command: 'acceptance' }];

function tree(t, second) {
  const root = tempDir('olympus-parts-tree-');
  t.after(() => removeDir(root));
  const dir = initOriginRepo(join(root, 'repo'), {
    'apps/alpha/mail.tsx': 'one\n',
    'apps/beta/api.ts': 'one\n',
    'package-lock.json': 'one\n',
  });
  const from = gitSync(['rev-parse', 'HEAD'], dir).trim();
  const to = commitTree(dir, second, 'the repair');
  return { worktree: dir, from, to };
}

function targetBase(worktree, config = {}) {
  return { worktree, layers: LAYERS, config: { gates: {}, ...config } };
}

function targetPlan(sha) {
  return {
    sweep: 'targeted',
    run: new Set(['acceptance']),
    prior: new Map([
      [
        'acceptance',
        { cycle: 1, seq: 10, sha, status: 'red', parts: [{ ...ALPHA, status: 'red' }, BETA] },
      ],
    ]),
  };
}

test('a cycle narrows a layer to the parts its own diff reached', async (t) => {
  const { worktree, from, to } = tree(t, { 'apps/alpha/mail.tsx': 'two\n' });
  const targets = await partTargets(targetBase(worktree), [], {
    plan: targetPlan(from),
    sha: to,
  });
  const plan = targets.get('acceptance');
  assert.deepEqual(plan.narrow.run, ['alpha']);
  assert.deepEqual(plan.narrow.carry.map((p) => p.name), ['beta']);
  assert.deepEqual(asObject(plan.reasons), { alpha: 'not-green' });
});

test('a diff that touches a lockfile re-runs every part of every layer', async (t) => {
  const { worktree, from, to } = tree(t, {
    'apps/alpha/mail.tsx': 'two\n',
    'package-lock.json': 'two\n',
  });
  const targets = await partTargets(targetBase(worktree), [], {
    plan: targetPlan(from),
    sha: to,
  });
  // The layer runs whole, and the plan that could not narrow it says which
  // path stopped it. Before this record the saving vanished with no trace.
  const plan = targets.get('acceptance');
  assert.equal(plan.narrow, null);
  assert.deepEqual(plan.blindPaths, ['package-lock.json']);
  assert.deepEqual(asObject(plan.reasons), { alpha: 'blind', beta: 'blind' });
});

test('the project may declare ground no suite of it reads', async (t) => {
  const { worktree, from, to } = tree(t, {
    'apps/alpha/mail.tsx': 'two\n',
    'package-lock.json': 'two\n',
  });
  // The same diff, with the lockfile sworn unread. The cycle attributes what
  // is left and narrows to it (ADR-0059).
  const base = targetBase(worktree, { gates: { groundlessPaths: ['package-lock.json'] } });
  const targets = await partTargets(base, [], { plan: targetPlan(from), sha: to });
  const plan = targets.get('acceptance');
  assert.deepEqual(plan.blindPaths, []);
  assert.deepEqual(plan.narrow.run, ['alpha']);
  assert.deepEqual(plan.narrow.carry.map((p) => p.name), ['beta']);
});

test('a re-freeze invalidates every carry', async (t) => {
  const { worktree, from, to } = tree(t, { 'apps/alpha/mail.tsx': 'two\n' });
  const plan = targetPlan(from);
  // The amendment lands after the result whose parts would be carried: the
  // suite those parts were judged against is not the suite that runs now. The
  // layer drops out of the map altogether, so no part of it is given a reason
  // it did not earn. It ran for a reason that is not about its parts.
  const after = await partTargets(targetBase(worktree), [{ event: 're-freeze', seq: 11 }], {
    plan,
    sha: to,
  });
  assert.equal(after, null);
  // An amendment older than the result carries as it always would.
  const before = await partTargets(targetBase(worktree), [{ event: 're-freeze', seq: 9 }], {
    plan,
    sha: to,
  });
  assert.deepEqual(before.get('acceptance').narrow.run, ['alpha']);
});

test('a layer whose standing result held no part table stays in the map', async (t) => {
  const { worktree, from, to } = tree(t, { 'apps/alpha/mail.tsx': 'two\n' });
  const plan = targetPlan(from);
  plan.prior.get('acceptance').parts = [];
  const targets = await partTargets(targetBase(worktree), [], { plan, sha: to });
  // Nothing to narrow and nothing to be blind against. The layer is planned
  // all the same, so every part its command opens is recorded as a part the
  // standing result did not hold.
  const derived = targets.get('acceptance');
  assert.equal(derived.narrow, null);
  assert.deepEqual(asObject(derived.reasons), {});
  assert.deepEqual(derived.blindPaths, []);
});

test('gates.partTargeting false restores the whole-layer re-run', async (t) => {
  const { worktree, from, to } = tree(t, { 'apps/alpha/mail.tsx': 'two\n' });
  const off = targetBase(worktree, { gates: { partTargeting: false } });
  assert.equal(await partTargets(off, [], { plan: targetPlan(from), sha: to }), null);
});

test('a cycle that runs the full spectrum narrows nothing', async (t) => {
  const { worktree, from, to } = tree(t, { 'apps/alpha/mail.tsx': 'two\n' });
  const full = { ...targetPlan(from), sweep: 'full', run: undefined, prior: undefined };
  assert.equal(await partTargets(targetBase(worktree), [], { plan: full, sha: to }), null);
});

test('a range git cannot answer runs the layer whole', async (t) => {
  const { worktree, to } = tree(t, { 'apps/alpha/mail.tsx': 'two\n' });
  const targets = await partTargets(targetBase(worktree), [], {
    plan: targetPlan('0000000000000000000000000000000000000000'),
    sha: to,
  });
  assert.equal(targets, null);
});

test('the confirmation sweep refuses a result that carried a part, and runs the layer whole', async (t) => {
  const { ctx } = fixture(t);
  const carry = [{ name: 'beta', status: 'green', inputs: ['apps/beta'], carriedFrom: 1 }];
  const narrowed = layerPlan({ run: ['alpha'], carry, reasons: { alpha: 'touched' } });
  await spectrum(ctx, { parts: narrowed });
  const { results } = await spectrum(ctx, {
    confirmation: true,
    parts: narrowed,
  });
  // Every part ran at this sha, and nothing on the result is carried.
  assert.deepEqual(
    results[0].parts.map((p) => [p.name, p.status, p.carriedFrom]),
    [
      ['alpha', 'green', undefined],
      ['beta', 'green', undefined],
    ],
  );
  const stamps = events(ctx).filter((e) => e.event === 'layer-result');
  assert.equal(stamps.length, 2);
  assert.equal(carriedParts(stamps[1]).length, 0);
  assert.equal(stamps[1].confirmation, true);
  // Re-entering the sweep is idempotent: the second stamp carries nothing, so
  // a daemon that comes back reads a full result and runs no layer again.
  const again = await spectrum(ctx, { confirmation: true });
  assert.equal(again.results[0].mode, 'run');
  assert.equal(events(ctx).filter((e) => e.event === 'layer-result').length, 2);
});
