import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeDir, tempDir, writeTree } from './helpers.mjs';
import {
  FORESEEN_MARKER,
  cardClosure,
  isForeseenNote,
  noCriteriaMessage,
  parseIntentCard,
} from '../src/lanes/card.mjs';

const CARD = `---
key: alpha-1
title: Alpha feature
blocked-by: ["alpha-0", "base-2"]
---

## Goal

Double numbers.

## Open decisions

- Pick the rounding mode
- Confirm the input domain

## Sources

- legacy spec
`;

test('parses key, title, edges, and open decisions', () => {
  const { card, errors } = parseIntentCard(CARD);
  assert.deepEqual(errors, []);
  assert.equal(card.key, 'alpha-1');
  assert.equal(card.title, 'Alpha feature');
  assert.deepEqual(card.blockedBy, ['alpha-0', 'base-2']);
  assert.deepEqual(card.openDecisions, ['Pick the rounding mode', 'Confirm the input domain']);
});

test('an explicit "None" open-decisions section is empty', () => {
  const { card, errors } = parseIntentCard(
    '---\nkey: a-1\n---\n\n## Open decisions\n\n- None\n',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(card.openDecisions, []);
});

test('a card with no open-decisions section has none', () => {
  const { card } = parseIntentCard('---\nkey: a-1\n---\n\n## Goal\n\nDo the thing.\n');
  assert.deepEqual(card.openDecisions, []);
});

test('missing frontmatter and missing key are errors', () => {
  assert.ok(parseIntentCard('## Goal\n\nNo frontmatter.\n').errors.length > 0);
  assert.ok(parseIntentCard('---\ntitle: No key\n---\n').errors.length > 0);
});

test('blocked-by accepts a bare comma list', () => {
  const { card } = parseIntentCard('---\nkey: a-1\nblocked-by: a-0, b-1\n---\n');
  assert.deepEqual(card.blockedBy, ['a-0', 'b-1']);
});

// -- acceptance criteria -----------------------------------------------------

function criteria(section) {
  return parseIntentCard(`---\nkey: a-1\n---\n\n${section}`).card.acceptance;
}

test('every line shape a card writes a criterion in parses, in card order', () => {
  const parsed = criteria(
    [
      '## Acceptance Criteria',
      '',
      '**AC-3.6.1** The bold form real cards write.',
      '',
      'AC-3.6.2 The bare form.',
      '',
      'AC-12: The bare form with a colon.',
      '',
      '- AC-0.1.4: The list form.',
      '',
      '### AC-7',
      '',
      'The heading form states its text below the heading.',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    parsed.map((c) => c.id),
    ['AC-3.6.1', 'AC-3.6.2', 'AC-12', 'AC-0.1.4', 'AC-7'],
  );
  assert.equal(parsed[0].text, 'The bold form real cards write.');
  assert.equal(parsed[3].text, 'The list form.');
});

test('prose under the heading is prose, and ids outside the section are ignored', () => {
  const parsed = criteria(
    [
      '## Acceptance criteria',
      '',
      'Each criterion below is assertable by one test.',
      '',
      '**AC-1** The widget renders.',
      '  AC-2 is named in the sentence above, indented under it.',
      '',
      '## Sources',
      '',
      '**AC-9** A criterion of the story this one supersedes.',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    parsed.map((c) => c.id),
    ['AC-1'],
  );
});

test('a card that labels nothing still names an ordered set', () => {
  assert.deepEqual(
    criteria('## Acceptance criteria\n\n- The widget renders.\n- The widget closes.\n').map(
      (c) => c.id,
    ),
    ['AC-1', 'AC-2'],
  );
});

test('a card with no criterion line yields none, and the message names it', () => {
  assert.deepEqual(criteria('## Acceptance criteria\n\nThe goal above states it.\n'), []);
  assert.deepEqual(criteria('## Goal\n\nDo the thing.\n'), []);
  const message = noCriteriaMessage('.olympus/cards/a-1.md');
  assert.match(message, /\.olympus\/cards\/a-1\.md/);
  assert.match(message, /acceptance/);
});

// -- foreseen amendments (ADR-0052) ------------------------------------------

const NOTE = `${FORESEEN_MARKER} tests/exports.test.mjs pins the closed export set; AC-2 mandates the third export.`;

const NOTED_CARD = `---
key: alpha-2
title: Alpha extension
---

## Open decisions

- Pick the rounding mode
- ${NOTE}

## Foreseen amendments

- ${NOTE}
- **${FORESEEN_MARKER}** tests/rows.test.mjs pins the row count; AC-3 mandates a new row.

## Acceptance criteria

**AC-1** The extension ships.
`;

test('a foreseen amendment is published on its own and never as an open decision', () => {
  const { card } = parseIntentCard(NOTED_CARD);
  // The question stays a question. The notes leave the set a launch parks on,
  // including the one a writer put under the wrong heading.
  assert.deepEqual(card.openDecisions, ['Pick the rounding mode']);
  assert.equal(card.foreseenAmendments.length, 2);
  assert.ok(card.foreseenAmendments[0].includes('tests/exports.test.mjs'));
  assert.ok(card.foreseenAmendments[1].includes('tests/rows.test.mjs'));
});

test('the note marker is read through markdown emphasis and leading space', () => {
  assert.ok(isForeseenNote(`${FORESEEN_MARKER} a note`));
  assert.ok(isForeseenNote(`  **${FORESEEN_MARKER}** a note`));
  assert.ok(isForeseenNote(`\`${FORESEEN_MARKER}\` a note`));
  assert.ok(!isForeseenNote('Pick the rounding mode'));
  assert.ok(!isForeseenNote(null));
});

test('a card with no foreseen section carries no notes', () => {
  assert.deepEqual(parseIntentCard(CARD).card.foreseenAmendments, []);
});

// -- named dependencies ------------------------------------------------------

function dependencies(section) {
  return parseIntentCard(`---\nkey: a-1\n---\n\n${section}`);
}

test('a dependency line names one importer and one package', () => {
  const { card, errors } = dependencies(
    ['## Dependencies', '', '- apps/storefront: zod', '- .: @scope/tool', ''].join('\n'),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(card.dependencies, [
    { importer: 'apps/storefront', name: 'zod' },
    { importer: '.', name: '@scope/tool' },
  ]);
});

test('a dependency line is read through the markdown a writer wraps it in', () => {
  const { card, errors } = dependencies('## Dependencies\n\n- `apps/storefront`: **zod**\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(card.dependencies, [{ importer: 'apps/storefront', name: 'zod' }]);
});

test('a card that names no dependency names none', () => {
  assert.deepEqual(parseIntentCard(CARD).card.dependencies, []);
  assert.deepEqual(dependencies('## Dependencies\n\n- None\n').card.dependencies, []);
});

test('a dependency line the parser cannot read is an error, never an omission', () => {
  for (const line of ['- apps/storefront zod', '- apps/storefront: zod ^3.0.0', '- : zod']) {
    const { card, errors } = dependencies(`## Dependencies\n\n${line}\n`);
    assert.deepEqual(card.dependencies, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /<importer>: <name>/);
  }
});

// -- the closure a launch is judged on ---------------------------------------

function cardText(key, blockedBy) {
  const edges = blockedBy.map((b) => `"${b}"`).join(', ');
  return `---\nkey: ${key}\nblocked-by: [${edges}]\n---\n\n## Goal\n\nDo the thing.\n`;
}

/** A cards directory, one file per key, named for its key. */
function cardTree(t, graph) {
  const dir = tempDir('olympus-cards-');
  t.after(() => removeDir(dir));
  writeTree(
    dir,
    Object.fromEntries(
      Object.entries(graph).map(([key, blockedBy]) => [`${key}.md`, cardText(key, blockedBy)]),
    ),
  );
  return dir;
}

test('the closure is the launched card and the cards it waits on', (t) => {
  const dir = cardTree(t, { top: ['mid'], mid: ['base'], base: [] });
  assert.deepEqual(cardClosure(dir, `${dir}/top.md`, { shipped: new Set() }), [
    `${dir}/top.md`,
    `${dir}/mid.md`,
    `${dir}/base.md`,
  ]);
});

test('the walk stops at a shipped card and never reaches behind it', (t) => {
  const dir = cardTree(t, { top: ['mid'], mid: ['base'], base: [] });
  assert.deepEqual(cardClosure(dir, `${dir}/top.md`, { shipped: new Set(['mid']) }), [
    `${dir}/top.md`,
  ]);
});

test('a diamond names each card once', (t) => {
  const dir = cardTree(t, { top: ['left', 'right'], left: ['base'], right: ['base'], base: [] });
  assert.deepEqual(cardClosure(dir, `${dir}/top.md`, {}), [
    `${dir}/top.md`,
    `${dir}/left.md`,
    `${dir}/right.md`,
    `${dir}/base.md`,
  ]);
});

test('a blocker with no card file adds no path, and the rest of the walk holds', (t) => {
  const dir = cardTree(t, { top: ['ghost', 'mid'], mid: [] });
  assert.deepEqual(cardClosure(dir, `${dir}/top.md`, {}), [`${dir}/top.md`, `${dir}/mid.md`]);
});

test('the launched card is named once, whatever else in the directory names it', (t) => {
  const dir = cardTree(t, { top: ['mid'], mid: ['top'] });
  assert.deepEqual(cardClosure(dir, `${dir}/top.md`, {}), [`${dir}/top.md`, `${dir}/mid.md`]);
});
