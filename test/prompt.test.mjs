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

function prompt(seat, constitution) {
  return assembleSeatPrompt({
    seat,
    def: seatDef(seat),
    reportPath: '/home/runs/r1/report.json',
    schema: SCHEMA,
    roleBlock: `role block for ${seat}`,
    ...(constitution !== undefined && { constitution }),
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

test('every seat set member takes the text; the adversary and the card sweep never do', () => {
  for (const seat of Object.keys(SEATS)) {
    const carries = prompt(seat, POLICY).includes('No file is a deliverable unless the spec names it.');
    assert.equal(carries, CONSTITUTION_SEATS.has(seat), seat);
  }
  assert.ok(!CONSTITUTION_SEATS.has('adversary'));
  assert.ok(!CONSTITUTION_SEATS.has('card-sweep'));
  assert.ok(!prompt('adversary', POLICY).includes('constitution'));
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

test('only the verifier is told what the order means for confirming a finding', () => {
  for (const seat of Object.keys(SEATS)) {
    assert.equal(prompt(seat, POLICY).includes(VERIFIER_AUTHORITY), seat === 'fury-verifier', seat);
  }
  assert.match(VERIFIER_AUTHORITY, /Refute a finding that enforces an illegitimate clause/);
});

test('both seat sets name known seats only, and the judging set is a subset', () => {
  for (const seat of CONSTITUTION_SEATS) assert.ok(SEATS[seat], seat);
  for (const seat of AUTHORITY_SEATS) assert.ok(CONSTITUTION_SEATS.has(seat), seat);
});
