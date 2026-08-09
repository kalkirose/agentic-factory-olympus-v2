import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaffoldHome } from '../src/daemon/home.mjs';
import { openEscapesStore } from '../src/telemetry/stores.mjs';
import {
  recordEscape,
  fixEscape,
  readEscapeSet,
  openEscapes,
  escapesWindow,
} from '../src/telemetry/escapes.mjs';
import { tempDir, removeDir } from './helpers.mjs';

function escapesStore(t) {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const paths = scaffoldHome(dir);
  return { paths, store: openEscapesStore(paths) };
}

test('the two-event lifecycle round-trips with final values from the fix', (t) => {
  const { paths, store } = escapesStore(t);
  const recorded = recordEscape(store, {
    actor: 'daemon',
    category: 'chore',
    defectLine: 'stale doc link on the settings page',
    detectionSource: 'human-report',
  });
  assert.equal(recorded.attribution, 'unattributed');
  fixEscape(store, {
    actor: 'daemon',
    fixes: recorded.seq,
    category: 'product-escape',
    attribution: 'story-4-2',
    refs: { pr: 12, runId: 'r9' },
  });
  store.close();
  const set = readEscapeSet(paths.escapesLedger);
  assert.equal(set.length, 1);
  assert.equal(set[0].fixed, true);
  assert.equal(set[0].category, 'product-escape');
  assert.equal(set[0].attribution, 'story-4-2');
  assert.deepEqual(set[0].fixRefs, { pr: 12, runId: 'r9' });
  assert.equal(openEscapes(paths.escapesLedger).length, 0);
});

test('an unfixed escape stays open with its recorded routing hint', (t) => {
  const { paths, store } = escapesStore(t);
  recordEscape(store, {
    actor: 'daemon',
    category: 'infra',
    defectLine: 'preview stack lost its cache volume',
    detectionSource: 'tripwire',
    attribution: 'story-3-1',
  });
  store.close();
  const open = openEscapes(paths.escapesLedger);
  assert.equal(open.length, 1);
  assert.equal(open[0].category, 'infra');
  assert.equal(open[0].attribution, 'story-3-1');
});

test('vocabulary violations are refused', (t) => {
  const { store } = escapesStore(t);
  const base = { actor: 'daemon', defectLine: 'x', detectionSource: 'tripwire' };
  assert.throws(() => recordEscape(store, { ...base, category: 'oops' }), /unknown escape category/);
  assert.throws(
    () => recordEscape(store, { ...base, category: 'chore', detectionSource: 'guess' }),
    /unknown detection source/,
  );
  assert.throws(
    () => recordEscape(store, { ...base, category: 'chore', detectionSource: 'other' }),
    /requires a note/,
  );
  assert.throws(
    () => recordEscape(store, { actor: 'daemon', category: 'chore', detectionSource: 'tripwire' }),
    /requires a defect line/,
  );
  store.close();
});

test('a fix must point at a recorded escape, once, with a fix ref', (t) => {
  const { store } = escapesStore(t);
  const recorded = recordEscape(store, {
    actor: 'daemon',
    category: 'harness',
    defectLine: 'watcher missed a check transition',
    detectionSource: 'harness-self',
  });
  const fix = {
    actor: 'daemon',
    fixes: recorded.seq,
    category: 'harness',
    attribution: 'unattributed',
    refs: { pr: 3 },
  };
  assert.throws(() => fixEscape(store, { ...fix, fixes: 99 }), /no escape-recorded at seq/);
  assert.throws(() => fixEscape(store, { ...fix, refs: undefined }), /requires a fix ref/);
  fixEscape(store, fix);
  assert.throws(() => fixEscape(store, fix), /already fixed/);
  store.close();
});

test('escapes-window math counts final categories after the oldest ship', () => {
  const day = (n) => `2026-08-${String(n).padStart(2, '0')}T00:00:00Z`;
  const ships = Array.from({ length: 12 }, (_, i) => ({ ts: day(i + 1) }));
  const escapes = [
    // before the window (oldest windowed ship = day 3): not counted
    { category: 'product-escape', recordedTs: day(1) },
    // in the window, counted categories
    { category: 'product-escape', recordedTs: day(3) },
    { category: 'spec-deviation', recordedTs: day(5) },
    // in the window, uncounted category
    { category: 'chore', recordedTs: day(5) },
  ];
  const result = escapesWindow({ ships, escapes });
  assert.equal(result.ships, 10);
  assert.equal(result.counted, 2);
  assert.equal(result.rate, 0.2);
  assert.equal(result.breach, false);
});

test('escapes-window math breaches over the ceiling and stays quiet with no ships', () => {
  const ships = [{ ts: '2026-08-01T00:00:00Z' }];
  const escapes = Array.from({ length: 6 }, (_, i) => ({
    category: 'product-escape',
    recordedTs: `2026-08-02T0${i}:00:00Z`,
  }));
  const breached = escapesWindow({ ships, escapes });
  assert.equal(breached.rate, 0.6);
  assert.equal(breached.breach, true);
  const empty = escapesWindow({ ships: [], escapes });
  assert.equal(empty.counted, 0);
  assert.equal(empty.breach, false);
});
