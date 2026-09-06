import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_LENSES,
  DEFAULT_LENSES,
  LENS_CRITERIA,
  RECORD_CRITERIA,
  RECORD_CRITERION_KEYS,
  RECORD_LENS,
  SECURITY_DIMENSIONS,
  furyPanel,
  panelLenses,
  recordCriteriaLines,
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

// The record lens is not a panel choice. A project cannot name it in
// `review.lenses`, no seat spawns for it, and the diff is what puts it on a
// review: the whole diff is records, or the finding's own file is one.
test('the record lens is outside the panel vocabulary and rides no seat', () => {
  assert.ok(!ALL_LENSES.includes(RECORD_LENS));
  assert.ok(!DEFAULT_LENSES.includes(RECORD_LENS));
  assert.equal(LENS_CRITERIA[RECORD_LENS], undefined);
  assert.deepEqual(furyPanel([RECORD_LENS]), {});
  assert.deepEqual(furyPanel([...DEFAULT_LENSES, RECORD_LENS]), furyPanel([...DEFAULT_LENSES]));
});

test('the record criteria are six keyed lines, and each line opens with its key', () => {
  assert.deepEqual(RECORD_CRITERION_KEYS, [
    'fact',
    'truth',
    'open',
    'divergence',
    'reference',
    'whole',
  ]);
  for (const key of RECORD_CRITERION_KEYS) {
    assert.ok(RECORD_CRITERIA[key].startsWith(`${key}: `), key);
  }
  const lines = recordCriteriaLines();
  assert.equal(lines.length, RECORD_CRITERION_KEYS.length);
  for (const line of lines) assert.ok(line.startsWith('- '), line);
});
