// The Tier-1 full-spectrum runner: not-runnable attribution follows the
// needs chain to the root red; the flake filter re-runs red layers once and
// stamps flakes instead of findings; stamped layers are never re-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { runSpectrum, persistentReds } from '../src/lanes/spectrum.mjs';
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
    results.map((r) => [r.layer, r.status, r.attributedTo]),
    [
      ['a', 'red', undefined],
      ['b', 'not-runnable', 'a'],
      ['c', 'not-runnable', 'a'],
      ['d', 'green', undefined],
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
  assert.deepEqual(results, [{ layer: 'flaky', status: 'green' }]);
  const flakes = events(ctx).filter((e) => e.event === 'flake');
  assert.equal(flakes.length, 1);
  assert.equal(flakes[0].layer, 'flaky');
  assert.equal(flakes[0].cycle, 1);
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
  assert.deepEqual(results, [{ layer: 'a', status: 'green' }]);
  assert.ok(!existsSync(boom), 'the stamped layer ran again');
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
