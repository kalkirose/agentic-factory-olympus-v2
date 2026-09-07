import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_LENSES,
  DEFAULT_LENSES,
  LENS_CRITERIA,
  RECORD_CRITERIA,
  RECORD_CRITERION_KEYS,
  RECORD_LENS,
  RECORD_RULE,
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

test('the record criteria are seven keyed lines, and each line opens with its key', () => {
  assert.deepEqual(RECORD_CRITERION_KEYS, [
    'fact',
    'truth',
    'open',
    'divergence',
    'reference',
    'whole',
    'consistent',
  ]);
  for (const key of RECORD_CRITERION_KEYS) {
    assert.ok(RECORD_CRITERIA[key].startsWith(`${key}: `), key);
  }
  // The rule opens the table and the six keyed lines follow it.
  const lines = recordCriteriaLines();
  assert.equal(lines[0], RECORD_RULE);
  assert.equal(lines.length, RECORD_CRITERION_KEYS.length + 1);
  for (const line of lines.slice(1)) assert.ok(line.startsWith('- '), line);
});

// The rule the criteria serve. A seat given six keys and no rule grades each
// sentence against the nearest key; the rule is what says a sentence about work
// nobody has done yet is legal, and that the same sentence as present fact is
// not (ADR-0038).
test('the criteria open with the rule that a record never conflicts with the code', () => {
  assert.ok(RECORD_RULE.includes('A record never conflicts with the code.'));
  assert.ok(RECORD_RULE.includes('true of the tree now, or marked as not yet built'));
  assert.ok(RECORD_RULE.includes('There is no third kind of claim.'));
  // And the rule names the sentences that claim nothing, so it and the unit
  // schema's `rationale` kind state one thing.
  assert.ok(
    RECORD_RULE.includes(
      'A sentence that states why, or what was rejected, or what would trigger a reversal, ' +
        'is rationale and is neither.',
    ),
    RECORD_RULE,
  );
  // `truth` is about the present tense, and it holds over the whole record: an
  // unchanged sentence the tree contradicts fails it exactly as a changed one
  // does (ADR-0026).
  assert.ok(RECORD_CRITERIA.truth.includes('every present-tense claim'));
  assert.ok(
    RECORD_CRITERIA.truth.includes('whether the sentence changed in this diff or not'),
    RECORD_CRITERIA.truth,
  );
  // And `open` is the other half of the rule: a future part is stated as one,
  // and a future part written as present fact is a `truth` defect.
  assert.ok(RECORD_CRITERIA.open.includes('stated as not implemented'));
  assert.ok(RECORD_CRITERIA.open.includes('fails truth, not open'), RECORD_CRITERIA.open);
});

// The seventh criterion. The tree settles what is built and settles nothing
// about what is not, so two active records can decide one unbuilt part two
// ways, and no code check can see it (ADR-0026).
test('the seventh criterion holds a record against its neighbourhood', () => {
  assert.equal(RECORD_CRITERION_KEYS[6], 'consistent');
  assert.ok(RECORD_CRITERIA.consistent.includes('does not contradict an open part'));
  assert.ok(RECORD_CRITERIA.consistent.includes('active record in its neighbourhood'));
  // It rides every brief and every schema, because the keys are one list.
  const lines = recordCriteriaLines();
  assert.equal(lines[lines.length - 1], `- ${RECORD_CRITERIA.consistent}`);
  // The six texts before it are unchanged by the seventh.
  assert.ok(RECORD_CRITERIA.fact.startsWith('fact: implemented parts read as standalone'));
  assert.ok(RECORD_CRITERIA.whole.endsWith('not as a trail of amendments.'));
});
