// Seat-prompt assembly: the constitution block, the authority order, and the
// guarantee a project without a constitution keeps its old prompts byte for
// byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleSeatPrompt,
  AUTHORITY_ORDER,
  AUTHORITY_SEATS,
  CONSTITUTION_SEATS,
  VERIFIER_AUTHORITY,
} from '../src/seats/prompt.mjs';
import { SEATS, seatDef } from '../src/seats/seatmap.mjs';

const SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
const POLICY = '# Constitution\n\nNo file is a deliverable unless the spec names it.\n';

function prompt(seat, constitution, styleFiles) {
  return assembleSeatPrompt({
    seat,
    def: seatDef(seat),
    reportPath: '/home/runs/r1/report.json',
    schema: SCHEMA,
    roleBlock: `role block for ${seat}`,
    ...(constitution !== undefined && { constitution }),
    ...(styleFiles !== undefined && { styleFiles }),
  });
}

test('no constitution leaves every seat prompt byte for byte what it was', () => {
  for (const seat of Object.keys(SEATS)) {
    const bare = prompt(seat);
    assert.equal(prompt(seat, null), bare, seat);
    assert.equal(prompt(seat, ''), bare, seat);
    assert.equal(prompt(seat, '   \n\n'), bare, seat);
    assert.ok(!bare.includes('constitution'), seat);
    assert.ok(!bare.includes(AUTHORITY_ORDER), seat);
  }
});

test('the constitution rides as its own delimited block, between core and role block', () => {
  const text = prompt('dev', POLICY);
  const open = text.indexOf('--- constitution ---');
  const close = text.indexOf('--- end constitution ---');
  assert.ok(open > text.indexOf('You are the dev seat'));
  assert.ok(close > open);
  assert.ok(text.indexOf('role block for dev') > close);
  assert.ok(text.includes('No file is a deliverable unless the spec names it.'));
});

test('every seat set member takes the text; the card sweep never does', () => {
  for (const seat of Object.keys(SEATS)) {
    const carries = prompt(seat, POLICY).includes('No file is a deliverable unless the spec names it.');
    assert.equal(carries, CONSTITUTION_SEATS.has(seat), seat);
  }
  assert.ok(!CONSTITUTION_SEATS.has('card-sweep'));
  assert.ok(!prompt('card-sweep', POLICY).includes('constitution'));
});

test('one seat per group carries the text', () => {
  for (const seat of ['spec-birth', 'spec-gate', 'suite', 'dev', 'repair-dev', 'fury-spec', 'generalist-review', 'fury-verifier', 'verdict-triage']) {
    assert.ok(prompt(seat, POLICY).includes(POLICY.trim()), seat);
  }
});

test('the authority order reaches exactly the judging seats', () => {
  const judging = new Set([
    'spec-gate',
    'fury-spec',
    'fury-code-shape',
    'fury-operational',
    'fury-interface',
    'fury-verifier',
    'generalist-review',
    'verdict-triage',
    'reconcile-judge',
  ]);
  assert.deepEqual([...AUTHORITY_SEATS].sort(), [...judging].sort());
  for (const seat of Object.keys(SEATS)) {
    assert.equal(prompt(seat, POLICY).includes(AUTHORITY_ORDER), judging.has(seat), seat);
  }
});

test('the authority order names the ranking and refuses enforcement of a beaten clause', () => {
  const text = prompt('fury-spec', POLICY);
  assert.match(text, /constitution above, then the intent card, then this run's spec/);
  assert.match(text, /Do not enforce such a clause against the tree/);
  assert.match(text, /blocking finding against the spec/);
});

// The one verifier takes it. A record round spawns none (ADR-0080).
test('only the verifier is told what the order means for confirming a finding', () => {
  const verifiers = new Set(['fury-verifier']);
  for (const seat of Object.keys(SEATS)) {
    assert.equal(prompt(seat, POLICY).includes(VERIFIER_AUTHORITY), verifiers.has(seat), seat);
  }
  assert.match(VERIFIER_AUTHORITY, /Refute a finding that enforces an illegitimate clause/);
});

test('both seat sets name known seats only, and the judging set is a subset', () => {
  for (const seat of CONSTITUTION_SEATS) assert.ok(SEATS[seat], seat);
  for (const seat of AUTHORITY_SEATS) assert.ok(CONSTITUTION_SEATS.has(seat), seat);
});

// The constitution is where the project writes the standard its decision
// records are held to. A writer that never read it wrote to nothing, so every
// seat that writes or judges a record is in the set.
test('all four record seats read the constitution, and the record judge judges under it', () => {
  for (const seat of ['record-author', 'record-review', 'reconcile-write', 'reconcile-judge']) {
    assert.ok(CONSTITUTION_SEATS.has(seat), seat);
    assert.ok(prompt(seat, POLICY).includes(POLICY.trim()), seat);
  }
  assert.ok(AUTHORITY_SEATS.has('reconcile-judge'));
  assert.ok(prompt('reconcile-judge', POLICY).includes(AUTHORITY_ORDER));
  // The record review judges a record against the code, and neither of the two
  // is an authority over the other.
  assert.ok(!AUTHORITY_SEATS.has('record-review'));
  assert.ok(!prompt('record-review', POLICY).includes(AUTHORITY_ORDER));
});

// A slotted dispatch is one invocation of its seat, so it takes the policy its
// seat takes. The sets are read by the base name and never by the identity.
test('a slotted seat name takes the blocks of its seat', () => {
  assert.equal(
    prompt('record-review:3', POLICY).replaceAll('record-review:3', 'record-review'),
    prompt('record-review', POLICY),
  );
  assert.ok(prompt('reconcile-judge:2', POLICY).includes(AUTHORITY_ORDER));
  assert.ok(!prompt('card-sweep:2', POLICY).includes('constitution'));
});

// The seat is told the path and never the rules: a copy of a rule set inside a
// prompt is a second rule set the day the first one changes.
test('the style files ride as binding text, one line each, after the constitution', () => {
  const text = prompt('record-author', POLICY, ['docs/style/asd-ste100.md', 'docs/style/anti-slop.md']);
  const close = text.indexOf('--- end constitution ---');
  const first = text.indexOf('The rules in docs/style/asd-ste100.md bind every sentence you write.');
  const second = text.indexOf('The rules in docs/style/anti-slop.md bind every sentence you write.');
  assert.ok(close > 0);
  assert.ok(first > close);
  assert.ok(second > first);
  assert.ok(text.indexOf('role block for record-author') > second);
  // One line per file, and no rule text of its own.
  assert.equal(text.split('bind every sentence you write.').length - 1, 2);
});

test('no style file leaves every seat prompt byte for byte what it was', () => {
  for (const seat of Object.keys(SEATS)) {
    const bare = prompt(seat, POLICY);
    assert.equal(prompt(seat, POLICY, null), bare, seat);
    assert.equal(prompt(seat, POLICY, []), bare, seat);
    assert.equal(prompt(seat, POLICY, ['  ']), bare, seat);
  }
});

test('a seat outside the constitution set is bound by no style file', () => {
  const files = ['docs/style/asd-ste100.md'];
  assert.ok(prompt('record-review:2', undefined, files).includes('The rules in docs/style/asd-ste100.md'));
  for (const seat of Object.keys(SEATS)) {
    assert.equal(
      prompt(seat, POLICY, files).includes('bind every sentence you write.'),
      CONSTITUTION_SEATS.has(seat),
      seat,
    );
  }
});
