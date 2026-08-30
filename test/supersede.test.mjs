// The mechanical half of a card-authorized supersede: which claim is a claim,
// which section of the card a clause reads, and every check that turns a claim
// into a park instead of an authorization (ADR-0044).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORESEEN_HEADING, cardSections } from '../src/lanes/card.mjs';
import {
  MIN_QUOTE_CHARS,
  OWNER_PIN_MARKER,
  SUPERSEDE_BRIEF_LINES,
  SUPERSEDE_CLAUSES,
  SUPERSEDE_REFUSALS,
  authorizedSupersedes,
  ownerPinned,
  ownerPinnedFiles,
  refusalLine,
  supersedeClaim,
  supersedeLines,
  supersedeRefusal,
  supersedeRuling,
} from '../src/lanes/supersede.mjs';
import { tempDir, removeDir } from './helpers.mjs';

const CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Publish g beside f.

## Scope boundary

This story adds a second published export to the feature module; the export
set an earlier story closed is extended here, not replaced.

### A deeper heading stays inside

Still the scope boundary.

## Open decisions

- The extension keeps the closed-set shape.

## Acceptance Criteria

**AC-1** g is published.
`;

// The line, as a seat copies it out of the card: one line where the card wraps
// it over two.
const COVERING_LINE =
  'This story adds a second published export to the feature module; the export ' +
  'set an earlier story closed is extended here, not replaced.';

function claimOf(overrides = {}) {
  return supersedeClaim({
    supersedes: 'tests/pinned.test.mjs',
    supersedeAssertion: 'the export set is exactly ["f"]',
    supersedeQuote: COVERING_LINE,
    supersedeClause: 'scope-boundary',
    ...overrides,
  });
}

function refusalFor(t, { claim, cardText = CARD, files = {}, ...rest } = {}) {
  const root = tempDir();
  t.after(() => removeDir(root));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return supersedeRefusal({
    claim: claim === undefined ? claimOf() : claim,
    cardText,
    worktree: root,
    testPaths: ['tests'],
    frozen: ['tests/pinned.test.mjs'],
    ...rest,
  });
}

const PLAIN_TEST = "import test from 'node:test';\ntest('pinned', () => {});\n";
const PINNED_TEST = `// ${OWNER_PIN_MARKER}: the closed set is the owner's call.\n${PLAIN_TEST}`;

test('a card section is read whole, and every section a clause names is read', () => {
  const [scope] = cardSections(CARD, /scope boundary/i);
  assert.ok(scope.includes('not replaced'));
  // A deeper heading is inside the section; the next same-level heading ends it.
  assert.ok(scope.includes('A deeper heading stays inside'));
  assert.ok(!scope.includes('Open decisions'));
  // Both spellings of the decisions section answer to one clause.
  assert.equal(cardSections(CARD, /decisions/i).length, 1);
  assert.equal(cardSections(CARD, /nothing here/i).length, 0);
});

test('a claim is four facts or it is nothing', () => {
  assert.ok(claimOf());
  assert.equal(claimOf({ supersedes: '' }), null);
  assert.equal(claimOf({ supersedeAssertion: '   ' }), null);
  assert.equal(claimOf({ supersedeQuote: undefined }), null);
  assert.equal(claimOf({ supersedeClause: 'goal' }), null);
  assert.equal(supersedeClaim(null), null);
  assert.equal(supersedeClaim({ conflict: true, detail: 'no claim here' }), null);
  // A windows-shaped path is one path.
  assert.equal(claimOf({ supersedes: 'tests\\pinned.test.mjs' }).test, 'tests/pinned.test.mjs');
});

test('a claim whose quote is in the named section, on a frozen test, stands', (t) => {
  assert.equal(refusalFor(t, { files: { 'tests/pinned.test.mjs': PLAIN_TEST } }), null);
});

test('the quote is matched across the card\'s own line wrapping, and nowhere else', (t) => {
  const files = { 'tests/pinned.test.mjs': PLAIN_TEST };
  // The card wraps the sentence; the claim states it on one line. Whitespace is
  // the only thing normalized, so every other character has to match.
  assert.equal(refusalFor(t, { files }), null);
  assert.equal(
    refusalFor(t, { files, claim: claimOf({ supersedeQuote: COVERING_LINE.replace('second', 'third') }) }),
    'quote-not-in-card',
  );
  // The right words, the wrong section: an authorization rests on the section
  // it names, not on the card at large.
  assert.equal(
    refusalFor(t, { files, claim: claimOf({ supersedeClause: 'decisions' }) }),
    'quote-not-in-card',
  );
  // A fragment matches everywhere and says nothing.
  assert.equal(
    refusalFor(t, { files, claim: claimOf({ supersedeQuote: 'This story' }) }),
    'quote-too-short',
  );
  assert.ok('This story'.length < MIN_QUOTE_CHARS);
});

test('silence, a pin, an unfrozen test, a repeat and the config flag each park', (t) => {
  const files = { 'tests/pinned.test.mjs': PLAIN_TEST };
  assert.equal(refusalFor(t, { files, claim: null }), 'silent');
  assert.equal(
    refusalFor(t, { files: { 'tests/pinned.test.mjs': PINNED_TEST } }),
    'owner-pinned',
  );
  assert.equal(
    refusalFor(t, { files, claim: claimOf({ supersedes: 'tests/other.test.mjs' }) }),
    'test-not-frozen',
  );
  assert.equal(
    refusalFor(t, { files, authorized: ['tests/pinned.test.mjs'] }),
    'already-authorized',
  );
  assert.equal(refusalFor(t, { files, enabled: false }), 'disabled');
  // Every refusal has a sentence, and the park question carries it.
  for (const key of Object.keys(SUPERSEDE_REFUSALS)) {
    assert.equal(typeof SUPERSEDE_REFUSALS[key], 'string');
  }
  assert.ok(refusalLine('silent', claimOf()).includes('tests/pinned.test.mjs'));
});

test('a pin the check cannot read counts as a pin', (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  assert.equal(ownerPinned(root, 'tests/gone.test.mjs'), true);
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests/plain.test.mjs'), PLAIN_TEST);
  writeFileSync(join(root, 'tests/pinned.test.mjs'), PINNED_TEST);
  assert.equal(ownerPinned(root, 'tests/plain.test.mjs'), false);
  assert.equal(ownerPinned(root, 'tests/pinned.test.mjs'), true);
  // The freeze's own record pins too, for a file whose marker moved since.
  assert.equal(ownerPinned(root, 'tests/plain.test.mjs', ['tests/plain.test.mjs']), true);
  assert.deepEqual(
    ownerPinnedFiles(root, ['tests/plain.test.mjs', 'tests/pinned.test.mjs', 'tests/gone.test.mjs']),
    ['tests/pinned.test.mjs'],
  );
});

test('a set of authorized supersedes is one ruling, anchored on the last of them', () => {
  const events = [
    { seq: 1, event: 'verdict-rendered' },
    {
      seq: 4,
      event: 'supersede-authorized',
      test: 'tests/pinned.test.mjs',
      assertion: 'the export set is exactly ["f"]',
      cardQuote: COVERING_LINE,
      clause: 'scope-boundary',
    },
  ];
  assert.equal(authorizedSupersedes(events).length, 1);
  assert.equal(authorizedSupersedes(events, { after: 4 }).length, 0);
  const ruling = supersedeRuling(authorizedSupersedes(events));
  assert.equal(ruling.seq, 4);
  assert.equal(ruling.source, 'card');
  assert.equal(ruling.actor, 'card');
  assert.equal(ruling.parkSeq, null);
  // The ruling names the file, which is how the re-freeze route finds it.
  assert.ok(ruling.answer.includes('tests/pinned.test.mjs'));
  assert.ok(ruling.answer.includes(COVERING_LINE));
  assert.equal(supersedeRuling([]), null);
  assert.ok(supersedeLines(authorizedSupersedes(events))[0].includes('scope-boundary'));
});

// -- covered is a test of necessity, not of naming (ADR-0053) ----------------

const MANDATE_CARD = `---
key: alpha-2
title: Alpha extension
---

## Scope boundary

The feature module only.

## Foreseen amendments

- Foreseen amendment: tests/pinned.test.mjs pins the closed export set; AC-2 mandates the second export.

## Acceptance criteria

**AC-2** The module publishes g beside f, so the published set is f and g.
`;

// The two lines a claim on this card can rest on: the criterion that mandates
// the behavior, and the note a close-out sweep wrote about the same mandate.
const MANDATE_LINE = 'The module publishes g beside f, so the published set is f and g.';
const NOTE_LINE =
  'Foreseen amendment: tests/pinned.test.mjs pins the closed export set; AC-2 mandates the ' +
  'second export.';

test('a mandate in the criteria authorizes, and so does the note written about it', (t) => {
  const files = { 'tests/pinned.test.mjs': PLAIN_TEST };
  const on = (clause, quote) =>
    refusalFor(t, {
      files,
      cardText: MANDATE_CARD,
      claim: claimOf({ supersedeClause: clause, supersedeQuote: quote }),
    });
  // The card never names the test file. The criterion mandates the second
  // export, and no implementation of it leaves the closed set true.
  assert.equal(on('acceptance', MANDATE_LINE), null);
  // The note a close-out sweep wrote is quotable evidence of the same mandate.
  assert.equal(on('foreseen', NOTE_LINE), null);
  // Each clause still reads its own section, and nothing else: the quote check
  // is the guard it always was.
  assert.equal(on('scope-boundary', MANDATE_LINE), 'quote-not-in-card');
  assert.equal(on('acceptance', NOTE_LINE), 'quote-not-in-card');
  assert.deepEqual(
    [...SUPERSEDE_CLAUSES],
    ['acceptance', 'scope-boundary', 'decisions', 'foreseen'],
  );
});

test('the classification brief states the necessity test and the restatement duty', () => {
  const brief = SUPERSEDE_BRIEF_LINES.join('\n');
  assert.ok(brief.includes('necessarily changes what the pinned clause asserts'));
  assert.ok(brief.includes('The test is necessity, not naming'));
  assert.ok(brief.includes("restates the pin's protected guarantee in its new form"));
  assert.ok(brief.includes('"acceptance", "scope-boundary", "decisions" or "foreseen"'));
  assert.ok(brief.includes(FORESEEN_HEADING));
  // The honesty guard the brief carries is unchanged.
  assert.ok(brief.includes('word for word is refused and the run parks'));
});

test('the ruling a card mints tells the amendment to restate the guarantee', () => {
  const ruling = supersedeRuling([
    {
      seq: 7,
      test: 'tests/pinned.test.mjs',
      assertion: 'the export set is exactly ["f"], and becomes exactly ["f", "g"]',
      cardQuote: MANDATE_LINE,
      clause: 'acceptance',
    },
  ]);
  assert.ok(ruling.answer.includes('a pin is amended, never deleted'));
  assert.ok(ruling.answer.includes(MANDATE_LINE));
});
