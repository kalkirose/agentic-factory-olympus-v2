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

// The panel judges the candidate diff and every suite write maps the story's
// surface, so the two surfaces state the same dimensions or one of them stops
// covering what the other assumes it does.
test('the security criteria and the surface-map dimensions come from one list', () => {
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

test('the record criteria are three keyed lines, and each line opens with its key', () => {
  // Three, because a criterion a seat cannot decide from the record and the
  // tree is a criterion nobody can answer. The old `open`, `divergence` and
  // `reference` keys are readings of the truth of a record, and the truth
  // criterion states all three; `fact` and `whole` are form, and the project
  // gate reads the form it can read (ADR-0080).
  assert.deepEqual(RECORD_CRITERION_KEYS, ['truth', 'consistent', 'form']);
  for (const key of RECORD_CRITERION_KEYS) {
    assert.ok(RECORD_CRITERIA[key].startsWith(`${key}: `), key);
  }
  // The rule opens the table and the keyed lines follow it.
  const lines = recordCriteriaLines();
  assert.equal(lines[0], RECORD_RULE);
  assert.equal(lines.length, RECORD_CRITERION_KEYS.length + 1);
  for (const line of lines.slice(1)) assert.ok(line.startsWith('- '), line);
});

// The rule the criteria serve. A seat given the keys and no rule grades each
// sentence against the nearest key; the rule is what says a sentence about work
// nobody has done yet is legal, and that the same sentence as present fact is
// not (ADR-0038).
test('the criteria open with the rule that a record never conflicts with the code', () => {
  assert.ok(RECORD_RULE.includes('A record never conflicts with the code.'));
  assert.ok(RECORD_RULE.includes('true of the tree now, or marked as not yet built'));
  assert.ok(RECORD_RULE.includes('There is no third kind of claim.'));
  // And the rule names the sentences that claim nothing.
  assert.ok(
    RECORD_RULE.includes(
      'A sentence that states why, or what was rejected, or what would trigger a reversal, ' +
        'is rationale and is neither.',
    ),
    RECORD_RULE,
  );
  // `truth` is about the present tense, and it holds over the whole record: an
  // unchanged sentence the tree contradicts fails it exactly as a changed one
  // does (ADR-0026). It states the three readings that used to be keys of their
  // own: a part not built, a divergence named, and a name that means what the
  // record says it means (ADR-0080).
  assert.ok(RECORD_CRITERIA.truth.includes('every present-tense claim'));
  assert.ok(
    RECORD_CRITERIA.truth.includes('whether the sentence changed in this diff or not'),
    RECORD_CRITERIA.truth,
  );
  assert.ok(RECORD_CRITERIA.truth.includes('stated as not built'), RECORD_CRITERIA.truth);
  assert.ok(RECORD_CRITERIA.truth.includes('divergence'), RECORD_CRITERIA.truth);
  assert.ok(RECORD_CRITERIA.truth.includes('means what the record says'), RECORD_CRITERIA.truth);
});

// The second criterion. The tree settles what is built and settles nothing
// about what is not, so two active records can decide one unbuilt part two
// ways, and no code check can see it (ADR-0026).
test('the second criterion holds a record against its neighbourhood', () => {
  assert.equal(RECORD_CRITERION_KEYS[1], 'consistent');
  assert.ok(RECORD_CRITERIA.consistent.includes('does not contradict an open part'));
  assert.ok(RECORD_CRITERIA.consistent.includes('active record in its neighbourhood'));
});

// The third. What is left of form once the project's own gate has read every
// rule a gate can read: a defect of the standard the gate cannot see, named by
// its rule number (ADR-0080).
test('the third criterion is the form the project gate cannot read', () => {
  assert.equal(RECORD_CRITERION_KEYS[2], 'form');
  assert.ok(RECORD_CRITERIA.form.includes('rule number'), RECORD_CRITERIA.form);
  assert.ok(RECORD_CRITERIA.form.includes('at every render'), RECORD_CRITERIA.form);
  // It rides every brief and every schema, because the keys are one list.
  const lines = recordCriteriaLines();
  assert.equal(lines[lines.length - 1], `- ${RECORD_CRITERIA.form}`);
});
