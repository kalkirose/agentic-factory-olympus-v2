import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { scaffoldHome, repairTicketPath } from '../src/daemon/home.mjs';
import { openEscapesStore } from '../src/telemetry/stores.mjs';
import {
  recordEscape,
  ticketEscape,
  fixEscape,
  markEscapeFixed,
  readEscapeSet,
  openEscapes,
  escapesWindow,
  kindEscapesWindow,
} from '../src/telemetry/escapes.mjs';
import { ESCAPE_KIND_OWNERSHIP, escapesRevokeCloses } from '../src/ledger/resolution.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { DEFECT_KINDS } from '../src/ledger/registry.mjs';
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

test('the scaffold creates the escapes ledger and keeps what it holds', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const paths = scaffoldHome(dir);
  // An empty ledger is a measured zero; a missing file is an unmeasurable
  // hole, and the escapes metric cannot tell one from the other.
  assert.ok(existsSync(paths.escapesLedger));
  assert.equal(readFileSync(paths.escapesLedger, 'utf8'), '');
  assert.ok(existsSync(paths.tickets));
  const store = openEscapesStore(paths);
  recordEscape(store, {
    actor: 'daemon',
    category: 'chore',
    defectLine: 'a stale link',
    detectionSource: 'human-report',
  });
  store.close();
  // A second scaffold (the next daemon start) never truncates it.
  scaffoldHome(dir);
  assert.equal(readEscapeSet(paths.escapesLedger).length, 1);
});

test('a ticket stamp links an absolute path to one recorded escape', (t) => {
  const { paths, store } = escapesStore(t);
  const recorded = recordEscape(store, {
    actor: 'daemon',
    category: 'product-escape',
    defectLine: 'f(3) returns 5 in production',
    detectionSource: 'harness-self',
    attribution: 'alpha-1',
    refs: { project: 'proj', runId: 'r1' },
  });
  const ticket = repairTicketPath(paths, recorded.seq);
  assert.throws(
    () => ticketEscape(store, { actor: 'daemon', escape: 99, ticket }),
    /no escape-recorded at seq/,
  );
  assert.throws(
    () => ticketEscape(store, { actor: 'daemon', escape: recorded.seq, ticket: 'tickets/x.md' }),
    /absolute ticket path/,
  );
  ticketEscape(store, { actor: 'daemon', escape: recorded.seq, ticket, refs: { runId: 'r1' } });
  assert.throws(
    () => ticketEscape(store, { actor: 'daemon', escape: recorded.seq, ticket }),
    /already carries a ticket/,
  );
  store.close();
  const set = readEscapeSet(paths.escapesLedger);
  assert.equal(set[0].ticket, ticket);
  assert.equal(set[0].refs.project, 'proj');
  assert.equal(set[0].fixed, false);
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
  // The defect kind is closed for the same reason the category is: a word a
  // call site invents counts with nothing.
  assert.throws(
    () => recordEscape(store, { ...base, category: 'harness', kind: 'labels-were-late' }),
    /unknown defect kind/,
  );
  store.close();
});

test('a defect the harness has a word for is recorded under it, and read back', (t) => {
  const { paths, store } = escapesStore(t);
  for (const kind of DEFECT_KINDS) {
    recordEscape(store, {
      actor: 'daemon',
      category: 'harness',
      defectLine: `the harness defect named ${kind}`,
      detectionSource: 'harness-self',
      kind,
    });
  }
  // A defect nobody has a vocabulary for is the ordinary case, and it stays
  // one: the field is optional, and its absence reads as an absence.
  recordEscape(store, {
    actor: 'daemon',
    category: 'product-escape',
    defectLine: 'the settings page loses the second address',
    detectionSource: 'human-report',
  });
  store.close();
  const set = readEscapeSet(paths.escapesLedger);
  assert.deepEqual(
    set.map((e) => e.kind),
    [...DEFECT_KINDS, null],
  );
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

test('an operator fixed-mark ends the escape under an event of its own', (t) => {
  const { paths, store } = escapesStore(t);
  const recorded = recordEscape(store, {
    actor: 'daemon',
    category: 'product-escape',
    defectLine: 'f(3) returns 5 in production',
    detectionSource: 'human-report',
    attribution: 'alpha-1',
  });
  markEscapeFixed(store, {
    actor: 'console:operator',
    fixes: recorded.seq,
    evidence: 'fixed by hand on the default branch',
    note: 'found while reading the module',
  });
  store.close();
  // The ledger says which route ended it: a repair run the factory ran and a
  // statement a human made are not the same fact.
  const events = readEvents(paths.escapesLedger);
  assert.deepEqual(
    events.map((e) => e.event),
    ['escape-recorded', 'escape-marked-fixed'],
  );
  const set = readEscapeSet(paths.escapesLedger);
  assert.equal(set[0].fixed, true);
  assert.equal(set[0].fixedBy, 'operator');
  assert.equal(set[0].fixEvidence, 'fixed by hand on the default branch');
  assert.equal(set[0].fixRefs, undefined);
  // The mark classifies nothing, so the record's own values stand and the
  // quality-bar window still counts the escape.
  assert.equal(set[0].category, 'product-escape');
  assert.equal(set[0].attribution, 'alpha-1');
  assert.equal(openEscapes(paths.escapesLedger).length, 0);
});

test('a fixed-mark needs evidence, a real target, and no fix in front of it', (t) => {
  const { store } = escapesStore(t);
  const recorded = recordEscape(store, {
    actor: 'daemon',
    category: 'harness',
    defectLine: 'watcher missed a check transition',
    detectionSource: 'harness-self',
  });
  const mark = { actor: 'console:operator', fixes: recorded.seq, evidence: 'merged by hand' };
  assert.throws(() => markEscapeFixed(store, { ...mark, fixes: 99 }), /no escape-recorded at seq/);
  assert.throws(() => markEscapeFixed(store, { ...mark, evidence: undefined }), /requires the evidence/);
  assert.throws(() => markEscapeFixed(store, { ...mark, evidence: '   ' }), /requires the evidence/);
  assert.throws(() => markEscapeFixed(store, { ...mark, actor: '' }), /requires an actor/);
  markEscapeFixed(store, mark);
  // Neither route may fix an escape the other one closed.
  assert.throws(() => markEscapeFixed(store, mark), /already fixed \(escape-marked-fixed\)/);
  assert.throws(
    () =>
      fixEscape(store, {
        actor: 'daemon',
        fixes: recorded.seq,
        category: 'harness',
        attribution: 'unattributed',
        refs: { pr: 3 },
      }),
    /already fixed \(escape-marked-fixed\)/,
  );
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

test('a kind window counts the escapes of one kind over the ships of a window', () => {
  const ships = [{ ts: '2026-01-01' }, { ts: '2026-01-02' }, { ts: '2026-01-03' }];
  const escapes = [
    { seq: 1, kind: 'harness', recordedTs: '2025-12-30' },
    { seq: 2, kind: 'harness', recordedTs: '2026-01-02' },
    { seq: 3, kind: 'fast-path-escape', recordedTs: '2026-01-02' },
    { seq: 4, kind: null, recordedTs: '2026-01-03' },
  ];
  // The window is the last two ships, so the escape before the oldest of them
  // is outside it, and only the named kind is counted.
  const window = kindEscapesWindow({ kind: 'harness', ships, escapes, windowSize: 2 });
  assert.deepEqual(window, { ships: 2, counted: 1, escapes: [2] });
  // A rate is not what a kind asks for: the quality bar counts categories, and
  // a harness escape carries a category that never enters it.
  assert.equal(escapesWindow({ ships, escapes: [], windowSize: 2 }).rate, 0);
});

test('a revoke closes the harness defect its fingerprint was counted under', () => {
  const escapes = [
    {
      seq: 1,
      kind: 'harness',
      fixed: false,
      refs: { project: 'alpha', fingerprint: 'harness:aaaaaaaaaaaa' },
    },
    {
      seq: 2,
      kind: 'harness',
      fixed: false,
      refs: { project: 'alpha', fingerprint: 'harness:bbbbbbbbbbbb' },
    },
    {
      seq: 3,
      kind: 'harness',
      fixed: false,
      refs: { project: 'beta', fingerprint: 'harness:aaaaaaaaaaaa' },
    },
    {
      seq: 4,
      kind: 'harness',
      fixed: true,
      refs: { project: 'alpha', fingerprint: 'harness:aaaaaaaaaaaa' },
    },
    { seq: 5, kind: 'fast-path-escape', fixed: false, refs: { project: 'alpha' } },
  ];
  const closed = escapesRevokeCloses(escapes, {
    project: 'alpha',
    fingerprint: 'harness:aaaaaaaaaaaa',
  });
  // One defect, in one project, still open: a fingerprint is the identity of a
  // defect and a revoke closes exactly the one it names (ADR-0068).
  assert.deepEqual(closed.map((e) => e.seq), [1]);
  // A kind the table gives no owner is nobody's to close this way.
  assert.deepEqual(escapesRevokeCloses(escapes, { project: 'alpha', fingerprint: 'x' }), []);
  assert.equal(ESCAPE_KIND_OWNERSHIP['fast-path-escape'], undefined);
  assert.equal(ESCAPE_KIND_OWNERSHIP.harness.name, 'acknowledged-harness-defect');
});
