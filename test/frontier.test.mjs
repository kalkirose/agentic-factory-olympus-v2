// Frontier graph: roadmap order (topological, unlock-count tiebreak, hubs
// early), card states, phase gates, and defect handling — all pure inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFrontier, roadmapPositions } from '../src/frontier/graph.mjs';
import { renderFrontier } from '../src/console/status.mjs';

function card(key, { blockedBy = [], phase = null, path = `stories/${key}.md`, errors } = {}) {
  return { key, path, phase, blockedBy, ...(errors && { errors }) };
}

function runsMap(entries) {
  return new Map(
    Object.entries(entries).map(([key, state]) => [
      key,
      { open: 0, shipped: 0, spent: 0, [state]: 1 },
    ]),
  );
}

test('roadmap order: topological, hubs first, then key order', () => {
  const frontier = computeFrontier({
    cards: [
      card('b'),
      card('z'), // hub: two dependents, lands before the earlier key
      card('c', { blockedBy: ['z'] }),
      card('d', { blockedBy: ['z'] }),
    ],
  });
  assert.deepEqual(frontier.order, ['z', 'b', 'c', 'd']);
  assert.deepEqual(
    frontier.launchable.map((e) => e.key),
    ['z', 'b'],
  );
  assert.equal(frontier.cards.find((e) => e.key === 'c').state, 'blocked');
});

test('unlock tiebreak counts transitive descendants, not direct dependents', () => {
  // deep unlocks 4 cards through a chain; wide unlocks 3, all direct.
  // The transitive rule puts deep first; direct out-degree would pick wide.
  const frontier = computeFrontier({
    cards: [
      card('wide'),
      card('w1', { blockedBy: ['wide'] }),
      card('w2', { blockedBy: ['wide'] }),
      card('w3', { blockedBy: ['wide'] }),
      card('deep'),
      card('d1', { blockedBy: ['deep'] }),
      card('d2', { blockedBy: ['d1'] }),
      card('d3', { blockedBy: ['d2'] }),
      card('d4', { blockedBy: ['d3'] }),
    ],
  });
  assert.deepEqual(frontier.order, ['deep', 'd1', 'wide', 'd2', 'd3', 'd4', 'w1', 'w2', 'w3']);
});

test('unlock count: a diamond descendant counts once', () => {
  // x unlocks {x1, x2, join} = 3; a unlocks 3 leaves. Equal counts fall to
  // key order (a first); double-counting join would put x (4) ahead.
  const frontier = computeFrontier({
    cards: [
      card('a'),
      card('a1', { blockedBy: ['a'] }),
      card('a2', { blockedBy: ['a'] }),
      card('a3', { blockedBy: ['a'] }),
      card('x'),
      card('x1', { blockedBy: ['x'] }),
      card('x2', { blockedBy: ['x'] }),
      card('join', { blockedBy: ['x1', 'x2'] }),
    ],
  });
  assert.deepEqual(frontier.order.slice(0, 2), ['a', 'x']);
});

test('equal unlock counts fall back to key order', () => {
  const frontier = computeFrontier({
    cards: [
      card('q'),
      card('p'),
      card('q1', { blockedBy: ['q'] }),
      card('p1', { blockedBy: ['p'] }),
    ],
  });
  assert.deepEqual(frontier.order, ['p', 'q', 'p1', 'q1']);
});

test('a cycle among descendants never hangs the unlock walk', () => {
  // root's descendant set reaches the m<->n cycle; the walk terminates,
  // root still orders, and the cycle cards land as defects.
  const frontier = computeFrontier({
    cards: [
      card('root'),
      card('m', { blockedBy: ['root', 'n'] }),
      card('n', { blockedBy: ['m'] }),
      card('solo'),
    ],
  });
  assert.deepEqual(frontier.order, ['root', 'solo']);
  for (const key of ['m', 'n']) {
    assert.equal(frontier.cards.find((e) => e.key === key).state, 'defect');
  }
});

test('card states from run history and parks', () => {
  const frontier = computeFrontier({
    cards: [card('a'), card('b'), card('c'), card('d'), card('e', { blockedBy: ['a'] })],
    runs: runsMap({ a: 'shipped', b: 'open', c: 'spent' }),
    parkedCards: new Set(['stories/d.md']),
  });
  const state = (key) => frontier.cards.find((e) => e.key === key).state;
  assert.equal(state('a'), 'shipped');
  assert.equal(state('b'), 'open');
  assert.equal(state('c'), 'spent');
  assert.equal(state('d'), 'parked'); // matched by path, as the sweep reports it
  assert.equal(state('e'), 'launchable'); // its blocker shipped
  assert.equal(frontier.unfinished, 4);
});

test('phase gate: a later phase enters the frontier only after its card ships', () => {
  const phases = [{ name: 'launch' }, { name: 'post-launch', after: 's2' }];
  const cards = [card('s1'), card('s2', { blockedBy: ['s1'] }), card('w1', { phase: 'post-launch' })];
  const before = computeFrontier({ cards, phases, runs: runsMap({ s1: 'shipped' }) });
  assert.equal(before.cards.find((e) => e.key === 'w1').state, 'gated');
  assert.deepEqual(
    before.launchable.map((e) => e.key),
    ['s2'],
  );
  const after = computeFrontier({ cards, phases, runs: runsMap({ s1: 'shipped', s2: 'shipped' }) });
  assert.equal(after.cards.find((e) => e.key === 'w1').state, 'launchable');
  // Roadmap order keeps launch-phase cards ahead of the later phase.
  assert.deepEqual(after.order, ['s1', 's2', 'w1']);
});

test('a blocker that shipped and left the card set still satisfies its edge', () => {
  const frontier = computeFrontier({
    cards: [card('n', { blockedBy: ['gone'] })],
    runs: runsMap({ gone: 'shipped' }),
  });
  assert.equal(frontier.cards.find((e) => e.key === 'n').state, 'launchable');
});

test('defects: identity, unknown blocker, unknown phase, cycle', () => {
  const frontier = computeFrontier({
    cards: [
      card(null, { path: 'stories/broken.md', errors: ['card has no frontmatter block'] }),
      card('dup'),
      card('dup', { path: 'stories/dup2.md' }),
      card('ghost', { blockedBy: ['missing'] }),
      card('odd', { phase: 'nowhere' }),
      card('x', { blockedBy: ['y'] }),
      card('y', { blockedBy: ['x'] }),
      card('ok'),
    ],
  });
  // The first 'dup' keeps its identity; the second is the defect.
  assert.deepEqual(frontier.order, ['dup', 'ok']);
  const messages = frontier.defects.map((d) => d.message).join('\n');
  assert.match(messages, /card invalid/);
  assert.match(messages, /duplicate key: dup/);
  assert.match(messages, /unknown blocker: missing/);
  assert.match(messages, /unknown phase: nowhere/);
  assert.match(messages, /cycle/);
  for (const key of ['ghost', 'odd', 'x', 'y']) {
    assert.equal(frontier.cards.find((e) => e.key === key).state, 'defect');
  }
  // Defects render; nothing throws on a null key.
  assert.match(renderFrontier('p', frontier), /defect: ghost — unknown blocker: missing/);
});

test('roadmap positions map keys and paths for the queue tiebreak', () => {
  const frontier = computeFrontier({
    cards: [card('a'), card('b', { blockedBy: ['a'] })],
  });
  const positions = roadmapPositions(frontier);
  assert.equal(positions.get('a'), 0);
  assert.equal(positions.get('stories/b.md'), 1);
});
