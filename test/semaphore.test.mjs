import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelSemaphores } from '../src/seats/semaphore.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { tempDir, removeDir } from './helpers.mjs';

const MODEL = 'claude-opus-5';

function setup(t) {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const store = openRunStore(paths, 'r1');
  t.after(() => {
    store.close();
    removeDir(home);
  });
  return { paths, store };
}

test('an uncapped model grants without stamps', async (t) => {
  const { paths, store } = setup(t);
  const semaphores = new ModelSemaphores({});
  const release = await semaphores.acquire(MODEL, { store, seat: 'dev' });
  release();
  assert.equal(readEvents(runLedgerPath(paths, 'r1')).length, 0);
});

test('a grant under the cap stamps semaphore-granted without a wait', async (t) => {
  const { paths, store } = setup(t);
  const semaphores = new ModelSemaphores({ [MODEL]: 2 });
  await semaphores.acquire(MODEL, { store, seat: 'dev' });
  const events = readEvents(runLedgerPath(paths, 'r1'));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'semaphore-granted');
  assert.equal(events[0].seat, 'dev');
  assert.equal(events[0].model, MODEL);
  assert.equal(events[0].waited, false);
  assert.ok(!events.some((e) => e.event === 'semaphore-wait'));
});

test('contention stamps semaphore-wait, then granted after release, FIFO', async (t) => {
  const { paths, store } = setup(t);
  const semaphores = new ModelSemaphores({ [MODEL]: 1 });
  const releaseA = await semaphores.acquire(MODEL, { store, seat: 'seat-a' });
  let bGranted = false;
  let cGranted = false;
  const b = semaphores.acquire(MODEL, { store, seat: 'seat-b' }).then((r) => {
    bGranted = true;
    return r;
  });
  const c = semaphores.acquire(MODEL, { store, seat: 'seat-c' }).then((r) => {
    cGranted = true;
    return r;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bGranted, false);
  assert.equal(cGranted, false);
  const waits = readEvents(runLedgerPath(paths, 'r1')).filter((e) => e.event === 'semaphore-wait');
  assert.equal(waits.length, 2);
  assert.equal(waits[0].seat, 'seat-b');
  assert.equal(waits[0].holders, 1);
  assert.equal(waits[1].seat, 'seat-c');
  assert.equal(waits[1].queued, 1);
  releaseA();
  const releaseB = await b;
  assert.equal(cGranted, false);
  releaseB();
  await c;
  const grants = readEvents(runLedgerPath(paths, 'r1')).filter(
    (e) => e.event === 'semaphore-granted',
  );
  assert.deepEqual(
    grants.map((e) => e.seat),
    ['seat-a', 'seat-b', 'seat-c'],
  );
  assert.equal(grants[1].waited, true);
  assert.equal(grants[1].waitSeq, waits[0].seq);
  assert.equal(grants[2].waitSeq, waits[1].seq);
});

test('a raised limit from a live edit grants waiters', async (t) => {
  const { store } = setup(t);
  const semaphores = new ModelSemaphores({ [MODEL]: 1 });
  await semaphores.acquire(MODEL, { store, seat: 'seat-a' });
  let granted = false;
  const b = semaphores.acquire(MODEL, { store, seat: 'seat-b' }).then(() => {
    granted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(granted, false);
  semaphores.setLimits({ [MODEL]: 2 });
  await b;
  assert.equal(granted, true);
});

test('release is idempotent — a double release frees one slot only', async (t) => {
  const { store } = setup(t);
  const semaphores = new ModelSemaphores({ [MODEL]: 1 });
  const releaseA = await semaphores.acquire(MODEL, { store, seat: 'seat-a' });
  releaseA();
  releaseA();
  await semaphores.acquire(MODEL, { store, seat: 'seat-b' });
  let granted = false;
  semaphores.acquire(MODEL, { store, seat: 'seat-c' }).then(() => {
    granted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(granted, false);
});
