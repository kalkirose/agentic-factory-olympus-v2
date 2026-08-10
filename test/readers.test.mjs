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
