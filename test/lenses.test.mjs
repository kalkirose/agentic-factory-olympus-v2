import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_LENSES,
  DEFAULT_LENSES,
  LENS_CRITERIA,
  SECURITY_DIMENSIONS,
  furyPanel,
  panelLenses,
} from '../src/lanes/lenses.mjs';

test('the default panel drops architecture and minimality and keeps security', () => {
  assert.deepEqual(panelLenses({}), ['spec', 'operational', 'security', 'interface']);
  assert.deepEqual(panelLenses(undefined), [...DEFAULT_LENSES]);
  assert.deepEqual(furyPanel(panelLenses({})), {
    'fury-spec': ['spec'],
    'fury-operational': ['operational', 'security'],
    'fury-interface': ['interface'],
  });
});

test('a declared panel replaces the default, in vocabulary order', () => {
  const config = { review: { lenses: ['interface', 'minimality', 'spec'] } };
  assert.deepEqual(panelLenses(config), ['spec', 'minimality', 'interface']);
  // A seat carries the lenses the panel kept and no others, so restoring one
  // of a seat's two lenses spawns that seat for that lens alone.
  assert.deepEqual(furyPanel(panelLenses(config)), {
    'fury-spec': ['spec'],
    'fury-code-shape': ['minimality'],
    'fury-interface': ['interface'],
  });
  assert.deepEqual(Object.keys(furyPanel(panelLenses({ review: { lenses: ALL_LENSES } }))), [
    'fury-spec',
    'fury-code-shape',
    'fury-operational',
    'fury-interface',
  ]);
});

// The panel judges the candidate diff and the adversary probes the suite, so
// the two surfaces state the same dimensions or one of them stops covering
// what the other assumes it does.
test('the security criteria and the adversary dimensions come from one list', () => {
  for (const dimension of SECURITY_DIMENSIONS) {
    assert.ok(LENS_CRITERIA.security.includes(dimension), dimension);
  }
  assert.ok(LENS_CRITERIA.security.startsWith('security: '));
  for (const lens of ALL_LENSES) assert.ok(LENS_CRITERIA[lens], lens);
});
