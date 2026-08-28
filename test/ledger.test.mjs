import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger, readEvents, tailEvents } from '../src/ledger/ledger.mjs';
import {
  DEFECT_KINDS,
  GATE_INTEGRITY_KINDS,
  OBSERVED_DEFECT_KINDS,
  RUN_EVENTS,
  INSTANCE_EVENTS,
  assertDefectKind,
} from '../src/ledger/registry.mjs';
import { tempDir, removeDir } from './helpers.mjs';

function runLedger(dir) {
  return new Ledger(join(dir, 'ledger.jsonl'), { allowedEvents: RUN_EVENTS });
}

test('append stamps the envelope with monotonic seq', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const ledger = runLedger(dir);
  const a = ledger.append('run-launched', { actor: 'daemon', lane: 'story' });
  const b = ledger.append('stage-entered', { actor: 'daemon', stage: 'readiness' });
  ledger.close();
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.ok(a.ts <= b.ts);
  const events = readEvents(join(dir, 'ledger.jsonl'));
  assert.equal(events.length, 2);
  assert.equal(events[1].stage, 'readiness');
});

test('stream-classed events carry their stream; others carry none', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const ledger = runLedger(dir);
  const park = ledger.append('park', { actor: 'daemon', reason: 'open-decisions' });
  const loud = ledger.append('liveness-violation', { actor: 'daemon' });
  const plain = ledger.append('stage-entered', { actor: 'daemon', stage: 'freeze' });
  ledger.close();
  assert.equal(park.stream, 'queued');
  assert.equal(loud.stream, 'loud');
  assert.equal(plain.stream, undefined);
});

test('a composed line is invisible until it commits, and holds no seq meanwhile', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const path = join(dir, 'ledger.jsonl');
  const ledger = runLedger(dir);
  const composed = ledger.compose('park', { actor: 'daemon', reason: 'open-decisions' });
  assert.equal(composed.seq, 1);
  assert.equal(composed.stream, 'queued');
  assert.deepEqual(readEvents(path), []);
  // The seq the compose named is still the next one to be written, so a caller
  // that drops a composed line leaves no gap behind it.
  const written = ledger.append('run-launched', { actor: 'daemon' });
  assert.equal(written.seq, 1);
  assert.throws(() => ledger.commit(composed), /out-of-order commit/);
  ledger.close();
  assert.deepEqual(readEvents(path).map((e) => e.event), ['run-launched']);
});

test('events outside the closed registry are refused', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const ledger = runLedger(dir);
  assert.throws(() => ledger.append('made-up-event', { actor: 'daemon' }), /not in registry/);
  assert.throws(() => ledger.append('daemon-started', { actor: 'daemon' }), /not in registry/);
  ledger.close();
});

test('the defect vocabulary is closed, and holds the kinds that recur', () => {
  // Four defects the ledgers carried as free text, each of them more than
  // once. A word is what makes the next occurrence a number instead of a
  // reading job.
  for (const kind of [
    'pr-label-missing',
    'triage-log-missing',
    'layer-log-truncated',
    'capture-takeback',
  ]) {
    assert.ok(DEFECT_KINDS.has(kind), `${kind} is not a closed kind`);
  }
  assert.ok(DEFECT_KINDS.has('deterministic-red'));
  for (const kind of DEFECT_KINDS) assert.equal(assertDefectKind(kind), kind);
  assert.throws(() => assertDefectKind('no-failure-log-found'), /unknown defect kind/);
  assert.throws(() => assertDefectKind(undefined), /unknown defect kind/);
});

test('the vocabulary says which record carries each kind, and the two sets are disjoint', () => {
  // A kind on a `gate-integrity` record decides who answers a loud item. A
  // kind a step stamps on its own record decides nothing and is counted. The
  // split is what keeps the second class from owing the first class's rules.
  assert.deepEqual(
    [...GATE_INTEGRITY_KINDS].sort(),
    [
      'auto-merge',
      'deterministic-red',
      'pr-label-missing',
      'resource-exhaustion',
      'triage-log-missing',
    ],
  );
  assert.deepEqual([...OBSERVED_DEFECT_KINDS].sort(), ['capture-takeback', 'layer-log-truncated']);
  for (const kind of GATE_INTEGRITY_KINDS) assert.ok(!OBSERVED_DEFECT_KINDS.has(kind));
  assert.deepEqual(
    [...DEFECT_KINDS].sort(),
    [...GATE_INTEGRITY_KINDS, ...OBSERVED_DEFECT_KINDS].sort(),
  );
});

test('payload keys cannot shadow the envelope', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const ledger = runLedger(dir);
  assert.throws(() => ledger.append('flake', { actor: 'p', seq: 99 }), /shadows the envelope/);
  ledger.close();
});

test('reopen resumes seq after the last valid line', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const path = join(dir, 'ledger.jsonl');
  const first = new Ledger(path, { allowedEvents: RUN_EVENTS });
  first.append('run-launched', { actor: 'daemon' });
  first.append('stage-entered', { actor: 'daemon', stage: 'readiness' });
  first.close();
  const second = new Ledger(path, { allowedEvents: RUN_EVENTS });
  const line = second.append('stage-entered', { actor: 'daemon', stage: 'spec-birth' });
  second.close();
  assert.equal(line.seq, 3);
});

test('a torn tail from a crash is truncated away on open', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const path = join(dir, 'ledger.jsonl');
  const first = new Ledger(path, { allowedEvents: RUN_EVENTS });
  first.append('run-launched', { actor: 'daemon' });
  first.append('stage-entered', { actor: 'daemon', stage: 'readiness' });
  first.close();
  appendFileSync(path, '{"seq":3,"ev'); // torn write
  const second = new Ledger(path, { allowedEvents: RUN_EVENTS });
  const line = second.append('stage-entered', { actor: 'daemon', stage: 'spec-birth' });
  second.close();
  assert.equal(line.seq, 3);
  const events = readEvents(path);
  assert.equal(events.length, 3);
  assert.ok(!readFileSync(path, 'utf8').includes('{"seq":3,"ev'));
  assert.equal(events[2].stage, 'spec-birth');
});

test('tailEvents returns the newest n', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const ledger = new Ledger(join(dir, 'i.jsonl'), { allowedEvents: INSTANCE_EVENTS });
  for (let i = 0; i < 5; i++) ledger.append('launch', { actor: 'daemon', n: i });
  ledger.close();
  const tail = tailEvents(join(dir, 'i.jsonl'), 2);
  assert.deepEqual(tail.map((e) => e.n), [3, 4]);
});
