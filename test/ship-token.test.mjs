// The per-project ship token, over ledger fixtures: who holds it, who waits,
// and the order the queue hands it on. The token is a reading of the run
// ledgers and nothing else, so these tests write ledgers and read the token —
// no forge, no worktree, no daemon. The two-run scenario drives the real gate
// the update stage calls, because serialization is what the gate is for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldHome, homePaths } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import {
  releaseShipToken,
  shipTokenState,
  takeShipToken,
  tokenPosition,
} from '../src/ship/token.mjs';
import { tempDir, removeDir } from './helpers.mjs';

// An ISO stamp at a fixed minute of one fixture hour. The hour is in the past,
// so a stamp a store writes during a test always queues behind a fixture one.
const at = (minute) => `2020-05-04T12:${String(minute).padStart(2, '0')}:00.000Z`;

/**
 * Writes a run ledger by hand: the envelope a store writes, with the
 * timestamps the test needs. `run-launched` leads, as it does in every run.
 */
function writeLedger(paths, runId, entries, { project = 'proj', lane = 'story' } = {}) {
  const all = [{ event: 'run-launched', ts: at(0), project, lane }, ...entries];
  const lines = all.map(({ event, ts, ...fields }, i) =>
    JSON.stringify({ seq: i + 1, ts, event, actor: 'daemon', ...fields }),
  );
  mkdirSync(join(paths.runs, runId), { recursive: true });
  writeFileSync(join(paths.runs, runId, 'ledger.jsonl'), lines.join('\n') + '\n');
}

function fixtureHome(t) {
  const home = tempDir();
  t.after(() => removeDir(home));
  return scaffoldHome(home);
}

test('a run between its request and its merge holds the token', (t) => {
  const paths = fixtureHome(t);
  writeLedger(paths, 'run-a', [
    { event: 'ship-token', ts: at(1), state: 'acquired' },
    { event: 'pr-opened', ts: at(2), pr: 1 },
  ]);
  assert.deepEqual(shipTokenState(paths, 'proj'), {
    holder: 'run-a',
    waiting: [],
    next: null,
  });
  // The merge concludes the turn: close-out keeps the run, not the token.
  writeLedger(paths, 'run-a', [
    { event: 'ship-token', ts: at(1), state: 'acquired' },
    { event: 'pr-opened', ts: at(2), pr: 1 },
    { event: 'merged', ts: at(3), pr: 1 },
  ]);
  assert.equal(shipTokenState(paths, 'proj').holder, null);
});

test('a run that acquired and never opened its request still holds it', (t) => {
  const paths = fixtureHome(t);
  // The crash window the token would leak through if it were a file: acquired,
  // then nothing. The ledger says the run is mid-ship, so the run holds it.
  writeLedger(paths, 'run-a', [{ event: 'ship-token', ts: at(1), state: 'acquired' }]);
  assert.equal(shipTokenState(paths, 'proj').holder, 'run-a');
  assert.equal(tokenPosition([]).state, null);
});

test('a closed run holds nothing, and the next waiter takes the token', (t) => {
  const paths = fixtureHome(t);
  writeLedger(paths, 'run-a', [
    { event: 'ship-token', ts: at(1), state: 'acquired' },
    { event: 'pr-opened', ts: at(2), pr: 1 },
    { event: 'run-closed', ts: at(4), state: 'failed' },
  ]);
  writeLedger(paths, 'run-b', [{ event: 'ship-token', ts: at(3), state: 'waiting' }]);
  assert.deepEqual(shipTokenState(paths, 'proj'), {
    holder: null,
    waiting: ['run-b'],
    next: 'run-b',
  });
});

test('the queue order is the order the waiters queued, and a tie falls to the run id', (t) => {
  const paths = fixtureHome(t);
  writeLedger(paths, 'run-a', [
    { event: 'ship-token', ts: at(1), state: 'acquired' },
    { event: 'pr-opened', ts: at(2), pr: 1 },
  ]);
  writeLedger(paths, 'run-c', [{ event: 'ship-token', ts: at(9), state: 'waiting' }]);
  writeLedger(paths, 'run-b', [{ event: 'ship-token', ts: at(5), state: 'waiting' }]);
  writeLedger(paths, 'run-d', [{ event: 'ship-token', ts: at(5), state: 'waiting' }]);
  const token = shipTokenState(paths, 'proj');
  assert.equal(token.holder, 'run-a');
  assert.deepEqual(token.waiting, ['run-b', 'run-d', 'run-c']);
  assert.equal(token.next, 'run-b');
});

test('the token is per project: another project is another token', (t) => {
  const paths = fixtureHome(t);
  writeLedger(paths, 'run-a', [{ event: 'pr-opened', ts: at(1), pr: 1 }]);
  writeLedger(paths, 'run-x', [{ event: 'pr-opened', ts: at(1), pr: 1 }], { project: 'other' });
  assert.equal(shipTokenState(paths, 'proj').holder, 'run-a');
  assert.equal(shipTokenState(paths, 'other').holder, 'run-x');
});

test('two runs at the gate serialize, and the merge is the hand-over', (t) => {
  const paths = fixtureHome(t);
  const stores = new Map();
  const ctxFor = (runId) => {
    if (!stores.has(runId)) {
      const store = openRunStore(paths, runId);
      store.append('run-launched', { actor: 'daemon', project: 'proj', lane: 'story' });
      stores.set(runId, store);
    }
    return { paths, project: 'proj', runId, store: stores.get(runId) };
  };
  const a = ctxFor('run-a');
  const b = ctxFor('run-b');
  t.after(() => {
    for (const store of stores.values()) store.close();
  });

  assert.equal(takeShipToken(a), true);
  assert.equal(takeShipToken(b), false);
  // The wait is one stamp, however often the stage asks.
  assert.equal(takeShipToken(b), false);
  assert.equal(takeShipToken(b), false);
  const waits = b.store.events().filter((e) => e.event === 'ship-token');
  assert.deepEqual(
    waits.map((e) => [e.state, e.holder, e.ahead]),
    [['waiting', 'run-a', 0]],
  );
  // A restart mid-ship re-derives the same holder from the same files.
  assert.equal(shipTokenState(homePaths(paths.home), 'proj').holder, 'run-a');

  a.store.append('pr-opened', { actor: 'daemon', pr: 1 });
  assert.equal(takeShipToken(b), false);
  a.store.append('merged', { actor: 'daemon', pr: 1, sha: 'x', mergeSha: 'y', red: false });
  assert.equal(takeShipToken(b), true);
  assert.equal(takeShipToken(a), false);
  assert.equal(shipTokenState(paths, 'proj').holder, 'run-b');
  assert.deepEqual(
    b.store.events().filter((e) => e.event === 'ship-token').map((e) => e.state),
    ['waiting', 'acquired'],
  );
});

test('a released run holds nothing and waits for nothing', (t) => {
  const paths = fixtureHome(t);
  writeLedger(paths, 'run-a', [
    { event: 'ship-token', ts: at(1), state: 'acquired' },
    { event: 'ship-token', ts: at(2), state: 'released', reason: 're-verdict' },
  ]);
  // The restart shape: the run is in its verdict cycle and the token is free.
  assert.deepEqual(shipTokenState(paths, 'proj'), { holder: null, waiting: [], next: null });
  assert.equal(tokenPosition([{ event: 'ship-token', ts: at(1), state: 'acquired' }]).state, 'holding');
});

test('a release clears the place the run queued with, so it queues at the back', (t) => {
  // The whole of the queue-order decision, in the fold. A run that waited,
  // held and released has had its turn; the stamp it queued with the first
  // time would put it ahead of every run that queued during its hold.
  const events = [
    { event: 'ship-token', ts: at(1), state: 'waiting' },
    { event: 'ship-token', ts: at(2), state: 'acquired' },
    { event: 'ship-token', ts: at(3), state: 'released', reason: 're-verdict' },
    { event: 'ship-token', ts: at(9), state: 'waiting' },
  ];
  assert.deepEqual(tokenPosition(events), {
    closed: false,
    state: 'waiting',
    queuedAt: at(9),
    heldSince: null,
    requested: false,
  });
  const paths = fixtureHome(t);
  writeLedger(paths, 'run-a', events);
  writeLedger(paths, 'run-b', [{ event: 'ship-token', ts: at(5), state: 'waiting' }]);
  const token = shipTokenState(paths, 'proj');
  assert.deepEqual(token.waiting, ['run-b', 'run-a']);
  assert.equal(token.next, 'run-b');
});

test('the release hands the token to the waiter behind it', (t) => {
  const paths = fixtureHome(t);
  const stores = new Map();
  const ctxFor = (runId) => {
    if (!stores.has(runId)) {
      const store = openRunStore(paths, runId);
      store.append('run-launched', { actor: 'daemon', project: 'proj', lane: 'story' });
      stores.set(runId, store);
    }
    return { paths, project: 'proj', runId, store: stores.get(runId) };
  };
  const a = ctxFor('run-a');
  const b = ctxFor('run-b');
  t.after(() => {
    for (const store of stores.values()) store.close();
  });

  assert.equal(takeShipToken(a), true);
  assert.equal(takeShipToken(b), false);
  // The holder goes back to its verdict. Nothing it does there reads the
  // default branch, so the waiter ships while it judges.
  assert.equal(releaseShipToken(a, 're-verdict'), true);
  assert.equal(takeShipToken(b), true);
  assert.equal(shipTokenState(paths, 'proj').holder, 'run-b');
  assert.deepEqual(
    a.store.events().filter((e) => e.event === 'ship-token').map((e) => [e.state, e.reason]),
    [['acquired', undefined], ['released', 're-verdict']],
  );
  // A run that holds nothing releases nothing, however often it asks.
  assert.equal(releaseShipToken(a, 're-verdict'), false);
  assert.equal(a.store.events().filter((e) => e.event === 'ship-token').length, 2);
});

test('a run whose request is open keeps the token whatever it does', (t) => {
  const paths = fixtureHome(t);
  const store = openRunStore(paths, 'run-a');
  t.after(() => store.close());
  store.append('run-launched', { actor: 'daemon', project: 'proj', lane: 'story' });
  const a = { paths, project: 'proj', runId: 'run-a', store };
  assert.equal(takeShipToken(a), true);
  store.append('pr-opened', { actor: 'daemon', pr: 1 });
  // The hold from the request to the merge covers a CI red and its repair
  // round. A competing merge under an open request costs the update it was
  // going to cost, so the release buys nothing and stamps nothing.
  assert.equal(releaseShipToken(a, 're-verdict'), false);
  assert.deepEqual(
    store.events().filter((e) => e.event === 'ship-token').map((e) => e.state),
    ['acquired'],
  );
  assert.equal(shipTokenState(paths, 'proj').holder, 'run-a');
});

test('a release reason outside the closed set never reaches a stamp', (t) => {
  const paths = fixtureHome(t);
  const store = openRunStore(paths, 'run-a');
  t.after(() => store.close());
  store.append('run-launched', { actor: 'daemon', project: 'proj', lane: 'story' });
  const a = { paths, project: 'proj', runId: 'run-a', store };
  assert.equal(takeShipToken(a), true);
  assert.throws(() => releaseShipToken(a, 'because'), /unknown ship-token release reason/);
  assert.equal(shipTokenState(paths, 'proj').holder, 'run-a');
});

test('the front of the queue takes the free token, and nobody jumps it', (t) => {
  const paths = fixtureHome(t);
  writeLedger(paths, 'run-b', [{ event: 'ship-token', ts: at(5), state: 'waiting' }]);
  const store = openRunStore(paths, 'run-c');
  t.after(() => store.close());
  store.append('run-launched', { actor: 'daemon', project: 'proj', lane: 'story' });
  const c = { paths, project: 'proj', runId: 'run-c', store };
  // The token is free, but run-b queued for it first: run-c joins the queue.
  assert.equal(takeShipToken(c), false);
  assert.equal(shipTokenState(paths, 'proj').next, 'run-b');
  assert.deepEqual(
    store.events().filter((e) => e.event === 'ship-token').map((e) => [e.state, e.ahead]),
    [['waiting', 1]],
  );
});
