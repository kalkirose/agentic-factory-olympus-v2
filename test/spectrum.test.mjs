// The Tier-1 spectrum runner: not-runnable attribution follows the needs
// chain to the root red; the flake filter re-runs red layers once and stamps
// flakes instead of findings; stamped layers are never re-run. The cycle plan
// decides what a cycle runs and what it carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import {
  runSpectrum,
  persistentReds,
  cyclePlan,
  priorStatus,
  targetedLayers,
} from '../src/lanes/spectrum.mjs';
import { tempDir, removeDir } from './helpers.mjs';

const GREEN = ['node', '-e', 'process.exit(0)'];
const RED = ['node', '-e', 'process.exit(1)'];

function fixture(t) {
  const root = tempDir();
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

test('a not-runnable layer attributes to the root red through the needs chain', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, {
    layers: [
      { name: 'a', command: 'red' },
      { name: 'b', command: 'green', needs: ['a'] },
      { name: 'c', command: 'green', needs: ['b'] },
      { name: 'd', command: 'green' },
    ],
    commands: { red: RED, green: GREEN },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  });
  assert.deepEqual(
    results.map((r) => [r.layer, r.status, r.mode, r.attributedTo]),
    [
      ['a', 'red', 'run', undefined],
      ['b', 'not-runnable', 'run', 'a'],
      ['c', 'not-runnable', 'run', 'a'],
      ['d', 'green', 'run', undefined],
    ],
  );
  assert.deepEqual(persistentReds(results).map((r) => r.layer), ['a']);
  // The red layer carries its output tail; the re-run confirmed the red.
  const stamped = events(ctx).filter((e) => e.event === 'layer-result');
  assert.equal(stamped.length, 4);
  assert.ok(!events(ctx).some((e) => e.event === 'flake'));
});

test('a red that turns green on the re-run stamps a flake, never a finding', async (t) => {
  const { root, ctx } = fixture(t);
  const marker = join(root, 'flake-marker');
  const flaky = [
    'node',
    '-e',
    `const fs=require('fs');const p=${JSON.stringify(marker)};` +
      `if(fs.existsSync(p))process.exit(0);fs.writeFileSync(p,'x');process.exit(1);`,
  ];
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'flaky', command: 'flaky' }],
    commands: { flaky },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  });
  assert.deepEqual(results, [{ layer: 'flaky', status: 'green', mode: 'run' }]);
  const flakes = events(ctx).filter((e) => e.event === 'flake');
  assert.equal(flakes.length, 1);
  assert.equal(flakes[0].layer, 'flaky');
  assert.equal(flakes[0].cycle, 1);
});

test('every layer execution says when it started, the flake re-run included', async (t) => {
  const { root, ctx } = fixture(t);
  const marker = join(root, 'started-marker');
  const flaky = [
    'node',
    '-e',
    `const fs=require('fs');const p=${JSON.stringify(marker)};` +
      `if(fs.existsSync(p))process.exit(0);fs.writeFileSync(p,'x');process.exit(1);`,
  ];
  await runSpectrum(ctx, {
    layers: [
      { name: 'flaky', command: 'flaky' },
      { name: 'green', command: 'green' },
      { name: 'blocked', command: 'green', needs: ['flaky'] },
    ],
    commands: { flaky, green: GREEN },
    cwd: process.cwd(),
    cycle: 3,
    sha: 'sha3',
  });
  const started = events(ctx).filter((e) => e.event === 'layer-started');
  assert.deepEqual(
    started.map((e) => [e.layer, e.attempt, e.cycle, e.sha]),
    [
      ['flaky', 1, 3, 'sha3'],
      ['flaky', 2, 3, 'sha3'],
      ['green', 1, 3, 'sha3'],
      ['blocked', 1, 3, 'sha3'],
    ],
  );
  // The stamp says when, and it lands before the result it belongs to.
  assert.ok(started.every((e) => typeof e.ts === 'string' && e.ts.endsWith('Z')));
  const flakyResult = events(ctx).find((e) => e.event === 'layer-result' && e.layer === 'flaky');
  assert.ok(started[1].seq < flakyResult.seq);
});

test('a layer nothing executes stamps no start: carried greens and stamped layers', async (t) => {
  const { ctx } = fixture(t);
  ctx.store.append('layer-result', { actor: 'daemon', cycle: 1, layer: 'a', status: 'green', sha: 's' });
  const prior = new Map([['b', { layer: 'b', status: 'green', cycle: 1, sha: 's' }]]);
  await runSpectrum(ctx, {
    layers: [
      { name: 'a', command: 'green' },
      { name: 'b', command: 'green' },
      { name: 'c', command: 'green' },
    ],
    commands: { green: GREEN },
    cwd: process.cwd(),
    cycle: 1,
    sha: 's',
    run: new Set(['c']),
    prior,
  });
  assert.deepEqual(
    events(ctx)
      .filter((e) => e.event === 'layer-started')
      .map((e) => e.layer),
    ['c'],
  );
});

test('a stamped layer is never re-run in the same cycle', async (t) => {
  const { root, ctx } = fixture(t);
  ctx.store.append('layer-result', { actor: 'daemon', cycle: 1, layer: 'a', status: 'green', sha: 's' });
  const boom = join(root, 'boom-marker');
  const tattling = [
    'node',
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(boom)},'x');process.exit(1);`,
  ];
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'a', command: 'tattling' }],
    commands: { tattling },
    cwd: process.cwd(),
    cycle: 1,
    sha: 's',
  });
  assert.deepEqual(results, [{ layer: 'a', status: 'green', mode: 'run' }]);
  assert.ok(!existsSync(boom), 'the stamped layer ran again');
});

test('the run env reaches every layer command', async (t) => {
  const { root, ctx } = fixture(t);
  const capture = join(root, 'layer-env.json');
  const probe = [
    'node',
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(capture)},` +
      `JSON.stringify({p:process.env.COMPOSE_PROJECT_NAME,s:process.env.OLY_STATIC}));process.exit(0)`,
  ];
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'a', command: 'probe' }],
    commands: { probe },
    cwd: process.cwd(),
    env: { COMPOSE_PROJECT_NAME: 'oly-r1', OLY_STATIC: 'static-1' },
    cycle: 1,
    sha: 's',
  });
  assert.deepEqual(results, [{ layer: 'a', status: 'green', mode: 'run' }]);
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), { p: 'oly-r1', s: 'static-1' });
});

// -- the cycle plan ----------------------------------------------------------

const CHAIN = [
  { name: 'a', command: 'green' },
  { name: 'b', command: 'green', needs: ['a'] },
  { name: 'c', command: 'green', needs: ['b'] },
  { name: 'd', command: 'green' },
];

function priorOf(entries) {
  return new Map(Object.entries(entries).map(([layer, status]) => [layer, { layer, status }]));
}

test('the targeted set takes a red and everything downstream of it, transitively', () => {
  const target = targetedLayers(
    CHAIN,
    priorOf({ a: 'red', b: 'not-runnable', c: 'not-runnable', d: 'green' }),
  );
  assert.deepEqual([...target].sort(), ['a', 'b', 'c']);
});

test('a red reaches its transitive dependents even where they were judged green', () => {
  // b and c ran green against the a of an earlier cycle. That a has changed,
  // so their greens judge a tree that no longer exists.
  const target = targetedLayers(CHAIN, priorOf({ a: 'red', b: 'green', c: 'green', d: 'green' }));
  assert.deepEqual([...target].sort(), ['a', 'b', 'c']);
});

test('a green with no red upstream stays out of the targeted set; an unjudged layer never does', () => {
  assert.deepEqual([...targetedLayers(CHAIN, priorOf({ a: 'green', b: 'green', c: 'green', d: 'red' }))], ['d']);
  // A layer the ledger has never judged has no green to carry.
  assert.deepEqual(
    [...targetedLayers(CHAIN, priorOf({ a: 'green', b: 'green', c: 'green' }))].sort(),
    ['d'],
  );
});

test('the standing status of a layer is its last stamp, however many cycles ago', () => {
  const events = [
    { event: 'layer-result', cycle: 1, layer: 'a', status: 'green' },
    { event: 'layer-result', cycle: 1, layer: 'b', status: 'red' },
    { event: 'layer-result', cycle: 2, layer: 'b', status: 'green' },
    { event: 'layer-result', cycle: 3, layer: 'b', status: 'red' },
  ];
  const prior = priorStatus(events, 3);
  assert.equal(prior.get('a').status, 'green');
  assert.equal(prior.get('b').status, 'green');
  // The stamps of the cycle being planned never reach the plan.
  assert.equal(priorStatus(events, 4).get('b').status, 'red');
});

test('a pass runs its first cycle full and its later cycles targeted', () => {
  const events = [
    { event: 'implementation-committed', pass: 1 },
    { event: 'layer-result', cycle: 1, layer: 'a', status: 'red' },
    { event: 'layer-result', cycle: 1, layer: 'b', status: 'not-runnable' },
    { event: 'layer-result', cycle: 1, layer: 'c', status: 'not-runnable' },
    { event: 'layer-result', cycle: 1, layer: 'd', status: 'green' },
  ];
  // Cycle 1: no render behind it, so nothing is proven.
  assert.deepEqual(cyclePlan(events, { cycle: 1, pass: 1, layers: CHAIN }), { sweep: 'full' });
  const rendered = [...events, { event: 'verdict-rendered', cycle: 1, pass: 1, verdict: 'red' }];
  const plan = cyclePlan(rendered, { cycle: 2, pass: 1, layers: CHAIN });
  assert.equal(plan.sweep, 'targeted');
  assert.deepEqual([...plan.run].sort(), ['a', 'b', 'c']);
  // A fresh pass judges a tree the run has never seen.
  assert.deepEqual(cyclePlan(rendered, { cycle: 2, pass: 2, layers: CHAIN }), { sweep: 'full' });
  // A CI red names no Tier-1 layer of this tree, so it targets nothing.
  const ci = [...rendered, { event: 'verdict-rendered', cycle: 2, pass: 1, source: 'ci', verdict: 'red' }];
  assert.deepEqual(cyclePlan(ci, { cycle: 3, pass: 1, layers: CHAIN }), { sweep: 'full' });
});

test('a restart mid-cycle derives the same targeted set', () => {
  const events = [
    { event: 'implementation-committed', pass: 1 },
    { event: 'layer-result', cycle: 1, layer: 'a', status: 'red' },
    { event: 'layer-result', cycle: 1, layer: 'b', status: 'not-runnable' },
    { event: 'layer-result', cycle: 1, layer: 'c', status: 'not-runnable' },
    { event: 'layer-result', cycle: 1, layer: 'd', status: 'green' },
    { event: 'verdict-rendered', cycle: 1, pass: 1, verdict: 'red' },
  ];
  const before = cyclePlan(events, { cycle: 2, pass: 1, layers: CHAIN });
  // The daemon died after cycle 2 judged a green and a red of its own.
  const midCycle = [
    ...events,
    { event: 'layer-result', cycle: 2, layer: 'a', status: 'green' },
    { event: 'layer-result', cycle: 2, layer: 'b', status: 'red' },
  ];
  const after = cyclePlan(midCycle, { cycle: 2, pass: 1, layers: CHAIN });
  assert.equal(after.sweep, before.sweep);
  assert.deepEqual([...after.run].sort(), [...before.run].sort());
});

test('a layer outside the run set carries its green forward without running', async (t) => {
  const { root, ctx } = fixture(t);
  const boom = join(root, 'carried-marker');
  const tattling = [
    'node',
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(boom)},'x');process.exit(1);`,
  ];
  const { results } = await runSpectrum(ctx, {
    layers: [
      { name: 'a', command: 'green' },
      { name: 'carried', command: 'tattling' },
      { name: 'unjudged', command: 'green' },
    ],
    commands: { green: GREEN, tattling },
    cwd: process.cwd(),
    cycle: 2,
    sha: 'sha2',
    run: new Set(['a']),
    prior: priorOf({ a: 'red', carried: 'green' }),
  });
  assert.deepEqual(
    results.map((r) => [r.layer, r.status, r.mode]),
    [
      ['a', 'green', 'run'],
      ['carried', 'green', 'carried'],
      // Outside the run set, but with no proven green to carry: it runs.
      ['unjudged', 'green', 'run'],
    ],
  );
  assert.ok(!existsSync(boom), 'the carried layer ran');
  // A carried result stamps nothing: the cycle that earned the green owns it.
  assert.deepEqual(
    events(ctx)
      .filter((e) => e.event === 'layer-result')
      .map((e) => e.layer),
    ['a', 'unjudged'],
  );
});

test('a layer stamped in this cycle reports run whatever the plan left out', async (t) => {
  const { ctx } = fixture(t);
  ctx.store.append('layer-result', {
    actor: 'daemon',
    cycle: 2,
    layer: 'confirmed',
    status: 'red',
    sha: 's',
    confirmation: true,
  });
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'confirmed', command: 'green' }],
    commands: { green: GREEN },
    cwd: process.cwd(),
    cycle: 2,
    sha: 's',
    run: new Set(),
    prior: priorOf({ confirmed: 'green' }),
  });
  assert.deepEqual(results, [{ layer: 'confirmed', status: 'red', mode: 'run' }]);
});

test('the confirmation sweep runs what the cycle carried and marks its stamps', async (t) => {
  const { ctx } = fixture(t);
  const layers = [
    { name: 'a', command: 'green' },
    { name: 'b', command: 'green' },
  ];
  const gates = { layers, commands: { green: GREEN }, cwd: process.cwd(), cycle: 2, sha: 'sha2' };
  await runSpectrum(ctx, { ...gates, run: new Set(['a']), prior: priorOf({ a: 'red', b: 'green' }) });
  const { results } = await runSpectrum(ctx, { ...gates, confirmation: true });
  assert.deepEqual(
    results.map((r) => [r.layer, r.status, r.mode]),
    [
      ['a', 'green', 'run'],
      ['b', 'green', 'run'],
    ],
  );
  assert.deepEqual(
    events(ctx)
      .filter((e) => e.event === 'layer-result')
      .map((e) => [e.layer, e.confirmation]),
    [
      ['a', undefined],
      ['b', true],
    ],
  );
});

test('a layer command that cannot run at all reports an error, not a verdict', async (t) => {
  const { ctx } = fixture(t);
  const outcome = await runSpectrum(ctx, {
    layers: [{ name: 'a', command: 'missing' }],
    commands: { missing: ['definitely-not-a-real-binary-xyz'] },
    cwd: process.cwd(),
    cycle: 1,
    sha: 's',
  });
  assert.ok(outcome.error);
  assert.equal(outcome.results, undefined);
  assert.ok(!events(ctx).some((e) => e.event === 'layer-result'));
});
