import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntentCard } from '../src/lanes/card.mjs';

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
