// Part-level targeting inside one gate layer (ADR-0046): the mapping that
// decides which parts of a layer a diff could have reached, the marker
// protocol a command declares that mapping with, and what the spectrum does
// with the answer — narrow the command, carry the rest with provenance, and
// refuse the carry in the confirmation sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { runCommand } from '../src/lanes/exec.mjs';
import { PARTS_ENV, partPlan, carriedParts, mergeCarried } from '../src/lanes/parts.mjs';
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

// -- the mapping -------------------------------------------------------------

test('a part runs when the diff reaches its inputs, and carries when it does not', () => {
  const plan = partPlan(prior(1, [ALPHA, BETA]), ['apps/alpha/mail.tsx']);
  assert.deepEqual(plan.run, ['alpha']);
  assert.deepEqual(plan.carry, [
    { name: 'beta', status: 'green', inputs: BETA.inputs, carriedFrom: 1 },
  ]);
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
    assert.equal(plan, null, `${blind} narrowed the layer`);
  }
});

test('a part that declared no input set is reached by everything', () => {
  const bare = { name: 'gamma', status: 'green' };
  const plan = partPlan(prior(1, [ALPHA, bare]), ['apps/alpha/mail.tsx']);
  assert.equal(plan, null, 'a part nothing maps was allowed to carry');
  // Beside a part that does map, the bare one runs and the mapped one carries
  // — the bare part's own reach is total, not the layer's.
  const mixed = partPlan(prior(1, [ALPHA, BETA, bare]), ['apps/alpha/mail.tsx']);
  assert.deepEqual(mixed.run, ['alpha', 'gamma']);
  assert.deepEqual(mixed.carry.map((p) => p.name), ['beta']);
});

test('a part that was not proven green never carries, whatever the diff says', () => {
  for (const status of ['red', 'unknown', undefined]) {
    const plan = partPlan(prior(1, [{ ...ALPHA, status }, BETA]), ['apps/alpha/mail.tsx']);
    assert.ok(plan.run.includes('alpha'), `a ${status} part carried`);
    assert.deepEqual(plan.carry.map((p) => p.name), ['beta']);
  }
});

test('a layer with nothing to carry, or nothing to run, runs whole', () => {
  // Every part reached: the narrowing would name every part, which is the
  // command's own default, so there is no plan to make.
  assert.equal(partPlan(prior(1, [ALPHA, BETA]), ['apps/alpha/a', 'apps/beta/b']), null);
  // Every part carried: nothing left to run, so the layer runs as it did.
  assert.equal(partPlan(prior(1, [ALPHA, BETA]), []), null);
  // No part table at all.
  assert.equal(partPlan(prior(1, []), ['apps/alpha/a']), null);
  assert.equal(partPlan(null, ['apps/alpha/a']), null);
});

test('provenance names the cycle that ran the part, not the cycle that carried it', () => {
  const first = partPlan(prior(1, [ALPHA, BETA]), ['apps/alpha/mail.tsx']);
  const carried = first.carry[0];
  assert.equal(carried.carriedFrom, 1);
  // The next cycle carries the same green again. It is still cycle 1's proof.
  const second = partPlan(prior(2, [{ ...ALPHA, status: 'green' }, carried]), [
    'apps/alpha/other.tsx',
  ]);
  assert.deepEqual(second.carry, [carried]);
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
  assert.equal(partPlan({ cycle: 1, parts: results[0].parts }, []), null);
});

test('a narrowed layer runs the parts it was given and carries the rest, marked', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await spectrum(ctx, {
    parts: new Map([
      [
        'acceptance',
        { run: ['alpha'], carry: [{ name: 'beta', status: 'green', inputs: ['apps/beta'], carriedFrom: 1 }] },
      ],
    ]),
  });
  assert.equal(results[0].status, 'green');
  assert.deepEqual(
    results[0].parts.map((p) => [p.name, p.status, p.carriedFrom]),
    [
      ['alpha', 'green', undefined],
      ['beta', 'green', 1],
    ],
  );
  // The stamp says the same thing, so a reader of the ledger sees the carry.
  const stamped = events(ctx).find((e) => e.event === 'layer-result');
  assert.deepEqual(stamped.parts, results[0].parts);
  assert.deepEqual(carriedParts(stamped).map((p) => p.name), ['beta']);
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
    parts: new Map([
      ['acceptance', { run: ['alpha'], carry: [{ name: 'beta', status: 'green', carriedFrom: 1 }] }],
    ]),
  });
  assert.deepEqual(
    results[0].parts.map((p) => [p.name, p.carriedFrom]),
    [
      ['alpha', undefined],
      ['beta', undefined],
    ],
  );
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
  assert.deepEqual(targets.get('acceptance').run, ['alpha']);
  assert.deepEqual(targets.get('acceptance').carry.map((p) => p.name), ['beta']);
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
  assert.equal(targets, null);
});

test('a re-freeze invalidates every carry', async (t) => {
  const { worktree, from, to } = tree(t, { 'apps/alpha/mail.tsx': 'two\n' });
  const plan = targetPlan(from);
  // The amendment lands after the result whose parts would be carried: the
  // suite those parts were judged against is not the suite that runs now.
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
  assert.deepEqual(before.get('acceptance').run, ['alpha']);
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
  await spectrum(ctx, { parts: new Map([['acceptance', { run: ['alpha'], carry }]]) });
  const { results } = await spectrum(ctx, {
    confirmation: true,
    parts: new Map([['acceptance', { run: ['alpha'], carry }]]),
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
