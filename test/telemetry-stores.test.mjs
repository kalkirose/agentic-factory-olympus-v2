import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '../src/ledger/ledger.mjs';
import {
  RUN_EVENTS,
  INSTANCE_EVENTS,
  QUEUED_EVENTS,
  LOUD_EVENTS,
  streamOf,
} from '../src/ledger/registry.mjs';
import { scaffoldHome, runLedgerPath, archivedRunLedgerPath } from '../src/daemon/home.mjs';
import {
  openInstanceStore,
  openRunStore,
  openEscapesStore,
  archiveRun,
} from '../src/telemetry/stores.mjs';
import { readStreamIndex } from '../src/telemetry/streams.mjs';
import { tempDir, removeDir } from './helpers.mjs';

function home(t) {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  return scaffoldHome(dir);
}

function fieldsFor(event) {
  const fields = { actor: 'test' };
  if (streamOf(event)) fields.gist = `gist for ${event}`;
  return fields;
}

test('every run-registry event round-trips writer to reader', (t) => {
  const paths = home(t);
  const store = openRunStore(paths, 'r1');
  const appended = [];
  for (const event of RUN_EVENTS) appended.push(store.append(event, fieldsFor(event)));
  store.close();
  const read = readEvents(runLedgerPath(paths, 'r1'));
  assert.deepEqual(read, appended);
  assert.deepEqual(read.map((e) => e.event), [...RUN_EVENTS]);
});

test('every instance-registry event round-trips writer to reader', (t) => {
  const paths = home(t);
  const store = openInstanceStore(paths);
  const appended = [];
  for (const event of INSTANCE_EVENTS) appended.push(store.append(event, fieldsFor(event)));
  store.close();
  assert.deepEqual(readEvents(paths.instanceLedger), appended);
});

test('stream-classed appends index with pointer and gist; plain appends do not', (t) => {
  const paths = home(t);
  const store = openRunStore(paths, 'r1');
  store.append('run-launched', { actor: 'daemon', lane: 'story' });
  const park = store.append('park', { actor: 'daemon', gist: 'open decision on card 3' });
  const loud = store.append('gate-integrity', { actor: 'daemon', gist: 'suite wired to no runner' });
  store.close();
  const queued = readStreamIndex(paths.queuedStream);
  assert.deepEqual(queued, [
    { ledger: 'run:r1', seq: park.seq, ts: park.ts, event: 'park', gist: 'open decision on card 3' },
  ]);
  const loudIndex = readStreamIndex(paths.loudStream);
  assert.deepEqual(loudIndex, [
    { ledger: 'run:r1', seq: loud.seq, ts: loud.ts, event: 'gate-integrity', gist: 'suite wired to no runner' },
  ]);
});

test('a stream-classed append without a gist is refused', (t) => {
  const paths = home(t);
  const store = openInstanceStore(paths);
  for (const event of [...QUEUED_EVENTS, ...LOUD_EVENTS]) {
    if (!INSTANCE_EVENTS.has(event)) continue;
    assert.throws(() => store.append(event, { actor: 'daemon' }), /requires a one-line gist/);
  }
  store.close();
  assert.equal(readStreamIndex(paths.queuedStream).length, 0);
  assert.equal(readStreamIndex(paths.loudStream).length, 0);
});

test('resolve pairs a resolved append to a loud item or a breach', (t) => {
  const paths = home(t);
  const store = openInstanceStore(paths);
  const breach = store.append('tripwire-breach', { actor: 'daemon', gist: 'escapes over ceiling' });
  const line = store.resolve({ actor: 'human', resolves: breach.seq, note: 'restore executed' });
  assert.equal(line.event, 'resolved');
  assert.equal(line.resolves, breach.seq);
  assert.equal(line.resolvedEvent, 'tripwire-breach');
  store.close();
});

test('resolve refuses unknown targets, non-resolvable events, and double resolution', (t) => {
  const paths = home(t);
  const store = openInstanceStore(paths);
  const plain = store.append('launch', { actor: 'daemon' });
  const loud = store.append('factory-starvation', { actor: 'daemon', gist: 'no active run' });
  assert.throws(() => store.resolve({ actor: 'h', resolves: 99 }), /no event at seq/);
  assert.throws(() => store.resolve({ actor: 'h', resolves: plain.seq }), /does not take a resolution/);
  store.resolve({ actor: 'h', resolves: loud.seq });
  assert.throws(() => store.resolve({ actor: 'h', resolves: loud.seq }), /already resolved/);
  store.close();
});

test('archiveRun moves a closed run directory to the archive', (t) => {
  const paths = home(t);
  const store = openRunStore(paths, 'r1');
  store.append('run-launched', { actor: 'daemon', lane: 'story' });
  store.append('run-closed', { actor: 'daemon', outcome: 'shipped' });
  store.close();
  const archivedPath = archiveRun(paths, 'r1');
  assert.equal(archivedPath, archivedRunLedgerPath(paths, 'r1'));
  assert.ok(!existsSync(join(paths.runs, 'r1')));
  assert.equal(readEvents(archivedPath).length, 2);
});

test('archiveRun refuses an open run and a repeated archive', (t) => {
  const paths = home(t);
  const open = openRunStore(paths, 'r1');
  open.append('run-launched', { actor: 'daemon', lane: 'story' });
  open.close();
  assert.throws(() => archiveRun(paths, 'r1'), /is open/);
  const reopened = openRunStore(paths, 'r1');
  reopened.append('run-closed', { actor: 'daemon', outcome: 'killed' });
  reopened.close();
  archiveRun(paths, 'r1');
  assert.throws(() => archiveRun(paths, 'r1'), /already archived/);
  assert.throws(() => archiveRun(paths, 'r2'), /has no ledger/);
});

test('escapes store accepts only escape events', (t) => {
  const paths = home(t);
  const store = openEscapesStore(paths);
  assert.throws(() => store.append('run-launched', { actor: 'daemon' }), /not in registry/);
  store.close();
});
