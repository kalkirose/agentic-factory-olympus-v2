import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  scaffoldHome,
  runLedgerPath,
  archivedRunLedgerPath,
} from '../src/daemon/home.mjs';
import { openInstanceStore, openRunStore, archiveRun } from '../src/telemetry/stores.mjs';
import {
  ledgerPathFor,
  filterEvents,
  openLoud,
  openBreaches,
  listShips,
  listFastPathShips,
  fastPathShipOf,
  storyRunsByKey,
} from '../src/telemetry/readers.mjs';
import { tempDir, removeDir } from './helpers.mjs';

function home(t) {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  return scaffoldHome(dir);
}

function writeLedger(path, lines) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('filterEvents filters by event name and seq floor', (t) => {
  const paths = home(t);
  const store = openRunStore(paths, 'r1');
  store.append('run-launched', { actor: 'daemon', lane: 'story' });
  store.append('stage-entered', { actor: 'daemon', stage: 'readiness' });
  store.append('stage-entered', { actor: 'daemon', stage: 'spec-birth' });
  store.append('freeze', { actor: 'daemon' });
  store.close();
  const path = runLedgerPath(paths, 'r1');
  const stages = filterEvents(path, { events: ['stage-entered'] });
  assert.deepEqual(stages.map((e) => e.stage), ['readiness', 'spec-birth']);
  const late = filterEvents(path, { events: ['stage-entered'], sinceSeq: 2 });
  assert.deepEqual(late.map((e) => e.stage), ['spec-birth']);
});

test('ledgerPathFor resolves ids, with archive fallback for runs', (t) => {
  const paths = home(t);
  assert.equal(ledgerPathFor(paths, 'instance'), paths.instanceLedger);
  assert.equal(ledgerPathFor(paths, 'escapes'), paths.escapesLedger);
  const store = openRunStore(paths, 'r1');
  store.append('run-launched', { actor: 'daemon', lane: 'story' });
  store.append('run-closed', { actor: 'daemon', outcome: 'shipped' });
  store.close();
  assert.equal(ledgerPathFor(paths, 'run:r1'), runLedgerPath(paths, 'r1'));
  archiveRun(paths, 'r1');
  assert.equal(ledgerPathFor(paths, 'run:r1'), archivedRunLedgerPath(paths, 'r1'));
  assert.throws(() => ledgerPathFor(paths, 'nope'), /unknown ledger id/);
});

test('open-loud answers from the files alone and drops resolved items', (t) => {
  const paths = home(t);
  const run = openRunStore(paths, 'r1');
  const violation = run.append('liveness-violation', {
    actor: 'daemon',
    gist: 'open run holds no child',
  });
  run.append('gate-integrity', { actor: 'daemon', gist: 'report truncated' });
  run.close();
  const instance = openInstanceStore(paths);
  instance.append('factory-starvation', { actor: 'daemon', gist: 'no active run' });
  instance.close();

  assert.deepEqual(
    openLoud(paths).map((e) => [e.ledger, e.event]),
    [
      ['run:r1', 'liveness-violation'],
      ['run:r1', 'gate-integrity'],
      ['instance', 'factory-starvation'],
    ],
  );

  const reopened = openRunStore(paths, 'r1');
  reopened.resolve({ actor: 'human', resolves: violation.seq });
  reopened.close();
  assert.deepEqual(
    openLoud(paths).map((e) => e.event),
    ['gate-integrity', 'factory-starvation'],
  );
});

test('open loud items stay queryable after the run archives', (t) => {
  const paths = home(t);
  const run = openRunStore(paths, 'r1');
  run.append('red-merge-breach', { actor: 'daemon', gist: 'admin merge over persistent reds' });
  run.append('run-closed', { actor: 'daemon', outcome: 'shipped' });
  run.close();
  archiveRun(paths, 'r1');
  const open = openLoud(paths);
  assert.equal(open.length, 1);
  assert.equal(open[0].event, 'red-merge-breach');
});

test('openBreaches lists unresolved tripwire breaches, not parks', (t) => {
  const paths = home(t);
  const run = openRunStore(paths, 'r1');
  run.append('park', { actor: 'daemon', gist: 'open decision on card 3' });
  run.close();
  const instance = openInstanceStore(paths);
  const breach = instance.append('tripwire-breach', { actor: 'daemon', gist: 'escapes over ceiling' });
  assert.deepEqual(openBreaches(paths).map((e) => e.event), ['tripwire-breach']);
  instance.resolve({ actor: 'human', resolves: breach.seq, note: 'restore executed' });
  instance.close();
  assert.equal(openBreaches(paths).length, 0);
});

test('listShips returns shipped story-lane runs in ship order, live and archived', (t) => {
  const paths = home(t);
  const line = (seq, ts, event, extra = {}) => ({ seq, ts, event, actor: 'daemon', ...extra });
  // story run, merged second, live
  writeLedger(runLedgerPath(paths, 'a'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-02T00:00:00Z', 'merged'),
  ]);
  // story run, merged first, archived
  writeLedger(archivedRunLedgerPath(paths, 'b'), [
    line(1, '2026-07-30T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-01T12:00:00Z', 'merged'),
    line(3, '2026-08-01T13:00:00Z', 'run-closed', { outcome: 'shipped' }),
  ]);
  // repair run: never a ship
  writeLedger(runLedgerPath(paths, 'c'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'repair' }),
    line(2, '2026-08-03T00:00:00Z', 'merged'),
  ]);
  // story run, not merged yet
  writeLedger(runLedgerPath(paths, 'd'), [
    line(1, '2026-08-04T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
  ]);
  assert.deepEqual(listShips(paths), [
    { runId: 'b', project: 'p', ts: '2026-08-01T12:00:00Z', archived: true },
    { runId: 'a', project: 'p', ts: '2026-08-02T00:00:00Z', archived: false },
  ]);
});

test('a fast-path ship is found by its request number or by its merge commit', (t) => {
  const paths = home(t);
  const line = (seq, ts, event, extra = {}) => ({ seq, ts, event, actor: 'daemon', ...extra });
  // A ship that carried its certification (ADR-0056), archived.
  writeLedger(archivedRunLedgerPath(paths, 'fast'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-02T00:00:00Z', 'fast-path-ship', {
      taken: true,
      commits: ['c1'],
      declaration: { digest: 'abcdef012345' },
    }),
    line(3, '2026-08-02T01:00:00Z', 'merged', { pr: 7, sha: 'h1', mergeSha: 'm1' }),
  ]);
  // A ship whose fast path refused: it earned its verdict, so it is not one.
  writeLedger(runLedgerPath(paths, 'full'), [
    line(1, '2026-08-03T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-03T01:00:00Z', 'fast-path-ship', {
      taken: false,
      refusal: 'ground-intersects',
    }),
    line(3, '2026-08-03T02:00:00Z', 'merged', { pr: 8, sha: 'h2', mergeSha: 'm2' }),
  ]);
  // A fast path taken by a run that never merged: nothing was carried anywhere.
  writeLedger(runLedgerPath(paths, 'open'), [
    line(1, '2026-08-04T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-04T01:00:00Z', 'fast-path-ship', { taken: true, commits: ['c2'] }),
  ]);
  assert.deepEqual(
    listFastPathShips(paths).map((s) => s.runId),
    ['fast'],
  );
  const ship = fastPathShipOf(paths, { project: 'p', pr: 7 });
  assert.equal(ship.runId, 'fast');
  assert.equal(ship.seq, 2);
  assert.equal(ship.mergeSha, 'm1');
  assert.deepEqual(ship.commits, ['c1']);
  assert.equal(ship.declaration.digest, 'abcdef012345');
  // Either name finds it, and a name from a ship that earned its verdict finds
  // nothing at all.
  assert.equal(fastPathShipOf(paths, { mergeSha: 'm1' }).runId, 'fast');
  assert.equal(fastPathShipOf(paths, { pr: 8 }), null);
  assert.equal(fastPathShipOf(paths, { mergeSha: 'm2' }), null);
  assert.equal(fastPathShipOf(paths, {}), null);
  // A project filter is a project filter.
  assert.equal(fastPathShipOf(paths, { project: 'q', pr: 7 }), null);
});

test('a fast path a later verdict superseded is not a fast-path ship', (t) => {
  // The run took the fast path over one moved base and then rendered the full
  // verdict anyway: a second base moved, or a red at the request sent it back.
  // That verdict judged the tree that lands, which is the whole of what the
  // fast path skipped, so the trade was never made and nothing may count it.
  const paths = home(t);
  const line = (seq, ts, event, extra = {}) => ({ seq, ts, event, actor: 'daemon', ...extra });
  writeLedger(runLedgerPath(paths, 'carried'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-02T00:00:00Z', 'fast-path-ship', { taken: true, commits: ['c1'] }),
    line(3, '2026-08-02T01:00:00Z', 'merged', { pr: 7, mergeSha: 'm1' }),
  ]);
  writeLedger(runLedgerPath(paths, 'earned'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-02T00:00:00Z', 'fast-path-ship', { taken: true, commits: ['c2'] }),
    // The full re-verdict, after the record. The certification this run ships
    // is one it earned over this tree.
    line(3, '2026-08-02T01:00:00Z', 'verdict-rendered', { cycle: 2, verdict: 'green' }),
    line(4, '2026-08-02T02:00:00Z', 'merged', { pr: 8, mergeSha: 'm2' }),
  ]);
  assert.deepEqual(
    listFastPathShips(paths).map((s) => s.runId),
    ['carried'],
  );
  assert.equal(fastPathShipOf(paths, { project: 'p', pr: 7 }).runId, 'carried');
  assert.equal(fastPathShipOf(paths, { project: 'p', pr: 8 }), null);
  assert.equal(fastPathShipOf(paths, { project: 'p', mergeSha: 'm2' }), null);
});

test('story-run history is read per project, because a story key is a project word', (t) => {
  // Two projects may both call a card `alpha-1`. Without the narrowing, one
  // project's shipped run marks the other project's card shipped, the frontier
  // drops that card, and nothing launches for it again.
  const paths = home(t);
  const line = (seq, ts, event, extra = {}) => ({ seq, ts, event, actor: 'daemon', ...extra });
  writeLedger(runLedgerPath(paths, 'p1'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', {
      project: 'p',
      lane: 'story',
      storyKey: 'alpha-1',
    }),
  ]);
  writeLedger(archivedRunLedgerPath(paths, 'q1'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', {
      project: 'q',
      lane: 'story',
      storyKey: 'alpha-1',
    }),
    line(2, '2026-08-02T00:00:00Z', 'run-closed', { state: 'shipped' }),
  ]);
  const p = storyRunsByKey(paths, { project: 'p' });
  assert.deepEqual(p.get('alpha-1'), { open: 1, shipped: 0, spent: 0, runIds: ['p1'] });
  const q = storyRunsByKey(paths, { project: 'q' });
  assert.deepEqual(q.get('alpha-1'), { open: 0, shipped: 1, spent: 0, runIds: ['q1'] });
  // Unscoped still reads every project, for a caller that owns none.
  const all = storyRunsByKey(paths);
  assert.equal(all.get('alpha-1').open, 1);
  assert.equal(all.get('alpha-1').shipped, 1);
});
