// How a cycle's gate layers are ordered into batches (ADR-0047): a project
// that names no group runs the sequence it always ran, a group merges the
// neighbours it names, and no batching ever moves a layer past a layer it
// needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerBatches, configuredGroups } from '../src/lanes/schedule.mjs';

const LAYERS = [
  { name: 'lint', command: 'lint' },
  { name: 'integration', command: 'integration' },
  { name: 'substrate', command: 'substrate' },
  { name: 'acceptance', command: 'acceptance', needs: ['lint'] },
];

const names = (batches) => batches.map((batch) => batch.map((layer) => layer.name));

test('a project that names no group runs one layer per batch, in declared order', () => {
  for (const groups of [null, undefined, []]) {
    assert.deepEqual(names(layerBatches(LAYERS, groups)), [
      ['lint'],
      ['integration'],
      ['substrate'],
      ['acceptance'],
    ]);
  }
});

test('a group merges the layers it names, and the groups stay in order', () => {
  const batches = layerBatches(LAYERS, [['integration', 'substrate']]);
  assert.deepEqual(names(batches), [['lint'], ['integration', 'substrate'], ['acceptance']]);
});

test('every layer keeps its declared position: a group never moves one', () => {
  // `lint` and `substrate` have `integration` between them, so the group can
  // only ever be what the declared order allows: each of them runs alone. The
  // degradation is toward the sequence, never toward a reorder.
  const batches = layerBatches(LAYERS, [['lint', 'substrate']]);
  assert.deepEqual(names(batches), [['lint'], ['integration'], ['substrate'], ['acceptance']]);
});

test('a layer never shares a batch with a layer it needs', () => {
  const layers = [
    { name: 'a', command: 'a' },
    { name: 'b', command: 'b', needs: ['a'] },
    { name: 'c', command: 'c' },
  ];
  // The config check refuses this config; the runner is safe on it anyway.
  assert.deepEqual(names(layerBatches(layers, [['a', 'b', 'c']])), [['a'], ['b', 'c']]);
});

test('a prerequisite reached through another layer cannot batch either', () => {
  // `needs` may only name an earlier layer, so the layer in between is in
  // between: two layers with a transitive dependency between them are never
  // neighbours, and the direct check is the whole check.
  const layers = [
    { name: 'x', command: 'x' },
    { name: 'z', command: 'z', needs: ['x'] },
    { name: 'y', command: 'y', needs: ['z'] },
  ];
  assert.deepEqual(names(layerBatches(layers, [['x', 'y']])), [['x'], ['z'], ['y']]);
});

test('a layer belongs to the first group that names it', () => {
  const batches = layerBatches(LAYERS, [['integration', 'substrate'], ['substrate', 'acceptance']]);
  assert.deepEqual(names(batches), [['lint'], ['integration', 'substrate'], ['acceptance']]);
});

test('a group that names nothing this cycle holds changes nothing', () => {
  assert.deepEqual(names(layerBatches(LAYERS, [['ghost', 'phantom']])), [
    ['lint'],
    ['integration'],
    ['substrate'],
    ['acceptance'],
  ]);
});

test('the config read answers null for every shape that is not a group list', () => {
  assert.equal(configuredGroups(undefined), null);
  assert.equal(configuredGroups({}), null);
  assert.equal(configuredGroups({ gates: {} }), null);
  assert.equal(configuredGroups({ gates: { concurrencyGroups: [] } }), null);
  assert.equal(configuredGroups({ gates: { concurrencyGroups: 'both' } }), null);
  assert.deepEqual(configuredGroups({ gates: { concurrencyGroups: [['a', 'b']] } }), [['a', 'b']]);
});
