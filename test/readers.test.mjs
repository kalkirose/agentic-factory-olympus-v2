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
import { newestBaseCertification, certifiedAt } from '../src/ledger/readers.mjs';
import { tempDir, removeDir, initOriginRepo, commitTree, gitSync } from './helpers.mjs';

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

test('listShips returns shipped runs of every lane in ship order, with lane and escape', (t) => {
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
  // repair run against a recorded escape: a ship, and it names the escape
  writeLedger(runLedgerPath(paths, 'c'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', {
      project: 'p',
      lane: 'repair',
      ticket: '/home/tickets/escape-4.md',
      escapeSeq: 4,
    }),
    line(2, '2026-08-03T00:00:00Z', 'merged'),
  ]);
  // maintenance repair, no escape behind it: a ship with no escape field
  writeLedger(archivedRunLedgerPath(paths, 'e'), [
    line(1, '2026-07-20T00:00:00Z', 'run-launched', {
      project: 'p',
      lane: 'repair',
      ticket: '/home/tickets/chore.md',
    }),
    line(2, '2026-07-21T00:00:00Z', 'merged'),
  ]);
  // story run, not merged yet
  writeLedger(runLedgerPath(paths, 'd'), [
    line(1, '2026-08-04T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
  ]);
  // repair run, not merged: a repair that never shipped is no ship either
  writeLedger(runLedgerPath(paths, 'f'), [
    line(1, '2026-08-04T00:00:00Z', 'run-launched', { project: 'p', lane: 'repair', escapeSeq: 9 }),
    line(2, '2026-08-05T00:00:00Z', 'run-closed', { state: 'failed' }),
  ]);
  assert.deepEqual(listShips(paths), [
    { runId: 'e', project: 'p', lane: 'repair', ts: '2026-07-21T00:00:00Z', archived: true },
    { runId: 'b', project: 'p', lane: 'story', ts: '2026-08-01T12:00:00Z', archived: true },
    { runId: 'a', project: 'p', lane: 'story', ts: '2026-08-02T00:00:00Z', archived: false },
    {
      runId: 'c',
      project: 'p',
      lane: 'repair',
      ts: '2026-08-03T00:00:00Z',
      archived: false,
      escapeSeq: 4,
    },
  ]);
  // One lane is a filter on the list, never a second reader.
  assert.deepEqual(
    listShips(paths).filter((s) => s.lane === 'story').map((s) => s.runId),
    ['b', 'a'],
  );
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
  // A RED render after the record re-certified nothing: the env-only CI route
  // renders one for a failure the tree is not to blame for, and the run
  // recovers and ships on the certification the fast path carried.
  writeLedger(runLedgerPath(paths, 'recovered'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-02T00:00:00Z', 'fast-path-ship', { taken: true, commits: ['c3'] }),
    line(3, '2026-08-02T01:00:00Z', 'verdict-rendered', { cycle: 2, verdict: 'red' }),
    line(4, '2026-08-02T03:00:00Z', 'merged', { pr: 9, mergeSha: 'm3' }),
  ]);
  assert.deepEqual(
    listFastPathShips(paths).map((s) => s.runId),
    ['carried', 'recovered'],
  );
  assert.equal(fastPathShipOf(paths, { project: 'p', pr: 7 }).runId, 'carried');
  assert.equal(fastPathShipOf(paths, { project: 'p', pr: 9 }).runId, 'recovered');
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

// -- what the default branch is already certified for -------------------------

/** Stamps one base certification and answers the line it wrote. */
function certify(paths, fields) {
  const store = openInstanceStore(paths);
  const line = store.append('base-certified', { actor: 'daemon', ...fields });
  store.close();
  return line;
}

function row(name, status, { elapsedMs = 100, mode = 'run', verdict = 'verdict-1.json' } = {}) {
  return { name, status, elapsedMs, mode, verdict };
}

/**
 * A project clone holding two commits, the second touching `changed` alone.
 * Bare, because that is the form the daemon holds a project in, and a diff of
 * two shas is read in it without a working tree.
 */
function projectClone(t, changed) {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const origin = join(dir, 'origin');
  initOriginRepo(origin, { 'src/feature.mjs': 'first\n', 'docs/note.md': 'first\n' });
  const first = gitSync(['rev-parse', 'HEAD'], origin).trim();
  const later = commitTree(origin, changed, 'second');
  const bare = join(dir, 'p.git');
  gitSync(['clone', '--bare', origin, bare], dir);
  return { bare, first, later };
}

test('the newest certification of one project at one sha is what a carry reads', (t) => {
  const paths = home(t);
  assert.equal(newestBaseCertification(paths, 'p', 'aaa'), null);
  certify(paths, { project: 'p', runId: 'r1', sha: 'aaa', layers: [row('unit', 'red')] });
  const newer = certify(paths, {
    project: 'p',
    runId: 'r2',
    sha: 'aaa',
    layers: [row('unit', 'green')],
  });
  // Another project's word about the same sha, and this project's word about
  // another sha, are both somebody else's answer.
  certify(paths, { project: 'q', runId: 'r3', sha: 'aaa', layers: [row('unit', 'green')] });
  certify(paths, { project: 'p', runId: 'r4', sha: 'bbb', layers: [row('unit', 'green')] });
  const held = newestBaseCertification(paths, 'p', 'aaa');
  assert.equal(held.seq, newer.seq);
  assert.equal(held.runId, 'r2');
  assert.equal(newestBaseCertification(paths, 'p', 'ccc'), null);
  assert.equal(newestBaseCertification(paths, 'other', 'aaa'), null);
});

test('with no sha the newest certification of the project answers, which is the duration', (t) => {
  const paths = home(t);
  assert.equal(newestBaseCertification(paths, 'p'), null);
  certify(paths, { project: 'p', runId: 'r1', sha: 'aaa', layers: [row('unit', 'green')] });
  const newest = certify(paths, {
    project: 'p',
    runId: 'r2',
    sha: 'bbb',
    layers: [row('unit', 'green', { elapsedMs: 4000 })],
  });
  // A layer takes about as long as it took last time, and the sha it took
  // that long at says nothing about the number.
  const held = newestBaseCertification(paths, 'p');
  assert.equal(held.seq, newest.seq);
  assert.equal(held.layers[0].elapsedMs, 4000);
});

test('a certification at the sha answers for its layers, and a red there is final', async (t) => {
  const paths = home(t);
  const { bare, first, later } = projectClone(t, { 'docs/note.md': 'second\n' });
  // An older green for the layer the newer certification calls red. The older
  // claim is about another tree; the newer one measured this one.
  certify(paths, { project: 'p', runId: 'r0', sha: first, layers: [row('lint', 'green')] });
  certify(paths, {
    project: 'p',
    runId: 'r1',
    sha: later,
    layers: [row('unit', 'green', { elapsedMs: 2000 }), row('lint', 'red')],
  });
  const unit = await certifiedAt(paths, 'p', later, 'unit', ['src'], bare);
  assert.equal(unit.baseSha, later);
  assert.equal(unit.status, 'green');
  assert.equal(unit.elapsedMs, 2000);
  assert.equal(await certifiedAt(paths, 'p', later, 'lint', ['docs'], bare), null);
  // A layer the certification never named is not certified by it either.
  assert.equal(await certifiedAt(paths, 'p', later, 'acceptance', ['src'], bare), null);
});

test('a certification at the sha needs no ground: the layer ran on this tree', async (t) => {
  const paths = home(t);
  const { bare, later } = projectClone(t, { 'docs/note.md': 'second\n' });
  certify(paths, { project: 'p', runId: 'r1', sha: later, layers: [row('unit', 'green')] });
  const held = await certifiedAt(paths, 'p', later, 'unit', [], bare);
  assert.equal(held.baseSha, later);
});

test('an earlier certification stands while the diff leaves the ground alone', async (t) => {
  const paths = home(t);
  const { bare, first, later } = projectClone(t, { 'docs/note.md': 'second\n' });
  const stamp = certify(paths, {
    project: 'p',
    runId: 'r1',
    sha: first,
    layers: [row('unit', 'green'), row('docs-lint', 'green')],
  });
  const carried = await certifiedAt(paths, 'p', later, 'unit', ['src'], bare);
  assert.equal(carried.baseSha, first);
  assert.equal(carried.certifiedSeq, stamp.seq);
  assert.equal(carried.runId, 'r1');
  // The same branch move touches the second layer's ground, so that one has
  // to answer for the tree itself.
  assert.equal(await certifiedAt(paths, 'p', later, 'docs-lint', ['docs'], bare), null);
  // A layer that declares no ground has claimed nothing to carry.
  assert.equal(await certifiedAt(paths, 'p', later, 'unit', [], bare), null);
});

test('an earlier certification that holds the layer red carries nothing', async (t) => {
  const paths = home(t);
  const { bare, first, later } = projectClone(t, { 'docs/note.md': 'second\n' });
  certify(paths, { project: 'p', runId: 'r1', sha: first, layers: [row('unit', 'red')] });
  assert.equal(await certifiedAt(paths, 'p', later, 'unit', ['src'], bare), null);
});

test('a clone the diff cannot be read in refuses the carry', async (t) => {
  const paths = home(t);
  const { first, later } = projectClone(t, { 'docs/note.md': 'second\n' });
  certify(paths, { project: 'p', runId: 'r1', sha: first, layers: [row('unit', 'green')] });
  // Doubt runs the layer, and a clone that answers nothing is doubt.
  assert.equal(
    await certifiedAt(paths, 'p', later, 'unit', ['src'], join(paths.home, 'no-clone')),
    null,
  );
});

test('the verdict record of a certification resolves where the run directory is now', async (t) => {
  const paths = home(t);
  const { bare, later } = projectClone(t, { 'docs/note.md': 'second\n' });
  certify(paths, {
    project: 'p',
    runId: 'r1',
    sha: later,
    layers: [row('unit', 'green', { verdict: 'verdict-2.json' })],
  });
  // The stamp carries the file's name. The run that wrote it archives, so the
  // live directory is read first and the archive answers for the rest.
  mkdirSync(join(paths.runs, 'r1'), { recursive: true });
  writeFileSync(join(paths.runs, 'r1', 'verdict-2.json'), '{}');
  const live = await certifiedAt(paths, 'p', later, 'unit', ['src'], bare);
  assert.equal(live.record, join(paths.runs, 'r1', 'verdict-2.json'));
  certify(paths, {
    project: 'q',
    runId: 'r2',
    sha: later,
    layers: [row('unit', 'green', { verdict: 'verdict-3.json' })],
  });
  const archived = await certifiedAt(paths, 'q', later, 'unit', ['src'], bare);
  assert.equal(archived.record, join(paths.archivedRuns, 'r2', 'verdict-3.json'));
  // A certification that names no record answers with none rather than with a
  // path to nothing.
  certify(paths, {
    project: 'z',
    runId: 'r3',
    sha: later,
    layers: [{ name: 'unit', status: 'green', elapsedMs: 5, mode: 'run' }],
  });
  const unnamed = await certifiedAt(paths, 'z', later, 'unit', ['src'], bare);
  assert.equal(unnamed.record, null);
});
