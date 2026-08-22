// The substrate probe (ADR-0022): the published ports come off the stack's
// own compose document; each one is asked on both loopback families; a family
// that accepts and relays nothing beside one that answers is the wedge, a port
// no family accepts is dead, and everything else leaves the route alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { probeSubstrate, publishedPorts, substrateGate } from '../src/lanes/substrate.mjs';
import { tempDir, removeDir } from './helpers.mjs';

const COMPOSE = ['docker', 'compose'];
const DEADLINE = 400;

/** A compose `ps` runner that answers with one document, whatever it is. */
function psRunner(output, code = 0) {
  const calls = [];
  return {
    calls,
    run: async (argv, opts) => {
      calls.push({ argv, opts });
      return { code, output };
    },
  };
}

/** The compose document for a set of published tcp ports. */
function psDocument(entries) {
  return JSON.stringify(
    entries.map(({ service, port }) => ({
      Service: service,
      State: 'running',
      Publishers: [{ URL: '0.0.0.0', TargetPort: 80, PublishedPort: port, Protocol: 'tcp' }],
    })),
  );
}

/** Listens on one address and answers every write. Returns its port. */
function listen(t, { address, port = 0, answer }) {
  const server = createServer((socket) => {
    socket.on('data', () => {
      if (answer) socket.write('answer\n');
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, address, () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve(server.address().port);
    });
  });
}

/** A port with nothing behind it: bound, read, and closed again. */
function freePort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function fixture(t) {
  const root = tempDir();
  const paths = scaffoldHome(join(root, 'home'));
  mkdirSync(join(paths.runs, 'r1'), { recursive: true });
  const store = openRunStore(paths, 'r1');
  t.after(() => {
    store.close();
    removeDir(root);
  });
  return {
    ctx: { store, paths, runId: 'r1', payload: {} },
    events: () => readEvents(runLedgerPath(paths, 'r1')),
  };
}

// -- reading the stack -------------------------------------------------------

test('the published ports come off the compose document, in either shape', () => {
  const array = psDocument([
    { service: 'web', port: 32770 },
    { service: 'db', port: 32769 },
  ]);
  assert.deepEqual(publishedPorts(array), [
    { port: 32769, service: 'db' },
    { port: 32770, service: 'web' },
  ]);
  // The older per-line shape reads the same.
  const lines = JSON.parse(array).map((entry) => JSON.stringify(entry)).join('\n');
  assert.deepEqual(publishedPorts(lines), publishedPorts(array));
});

test('a port the probe cannot ask a tcp question of is not a published port', () => {
  const document = JSON.stringify([
    {
      Service: 'web',
      Publishers: [
        { PublishedPort: 0, Protocol: 'tcp' },
        { PublishedPort: 5353, Protocol: 'udp' },
        { PublishedPort: 8080, Protocol: 'tcp' },
        { PublishedPort: 8080, Protocol: 'tcp' },
      ],
    },
    { Service: 'quiet', Publishers: [] },
  ]);
  assert.deepEqual(publishedPorts(document), [{ port: 8080, service: 'web' }]);
});

test('a document nobody can read is not a statement that the stack publishes nothing', () => {
  assert.equal(publishedPorts('not json at all'), null);
  assert.deepEqual(publishedPorts(''), []);
});

// -- the probe ---------------------------------------------------------------

test('a port that answers on the family it was asked on is a clean probe', async (t) => {
  const port = await listen(t, { address: '127.0.0.1', answer: true });
  const runner = psRunner(psDocument([{ service: 'web', port }]));
  const result = await probeSubstrate({
    stack: 'oly-r1',
    composeCommand: COMPOSE,
    run: runner.run,
    addresses: ['127.0.0.1'],
    deadlineMs: DEADLINE,
  });
  assert.equal(result.state, 'clean');
  assert.deepEqual(result.ports, [port]);
  assert.deepEqual(
    result.attempts.map((a) => a.state),
    ['answered'],
  );
  // The read names the stack and asks compose for the document, nothing else.
  assert.deepEqual(runner.calls[0].argv, [...COMPOSE, '-p', 'oly-r1', 'ps', '--format', 'json']);
});

test('a family that accepts and relays nothing, beside one that answers, is a failed probe', async (t) => {
  const port = await listen(t, { address: '127.0.0.1', answer: true });
  try {
    await listen(t, { address: '::1', port, answer: false });
  } catch {
    t.skip('this host has no IPv6 loopback to hold the wedged half');
    return;
  }
  const result = await probeSubstrate({
    stack: 'oly-r1',
    composeCommand: COMPOSE,
    run: psRunner(psDocument([{ service: 'web', port }])).run,
    addresses: ['127.0.0.1', '::1'],
    deadlineMs: DEADLINE,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].reason, 'no-relay');
  assert.equal(result.failures[0].service, 'web');
  const byAddress = Object.fromEntries(result.attempts.map((a) => [a.address, a.state]));
  assert.deepEqual(byAddress, { '127.0.0.1': 'answered', '::1': 'silent' });
});

test('a published port no loopback family accepts is a failed probe', async () => {
  const port = await freePort();
  const result = await probeSubstrate({
    stack: 'oly-r1',
    composeCommand: COMPOSE,
    run: psRunner(psDocument([{ service: 'db', port }])).run,
    addresses: ['127.0.0.1'],
    deadlineMs: DEADLINE,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.failures[0].reason, 'unreachable');
  assert.equal(result.attempts[0].state, 'refused');
});

test('a family that refuses beside one that answers is a project publishing on one family', async (t) => {
  const port = await listen(t, { address: '127.0.0.1', answer: true });
  const result = await probeSubstrate({
    stack: 'oly-r1',
    composeCommand: COMPOSE,
    run: psRunner(psDocument([{ service: 'web', port }])).run,
    // 127.0.0.2 is loopback and holds no listener: the refusal must not park.
    addresses: ['127.0.0.1', '127.0.0.2'],
    deadlineMs: DEADLINE,
  });
  assert.equal(result.state, 'clean');
});

test('a probe that could not read the stack judges nothing', async () => {
  const base = { stack: 'oly-r1', composeCommand: COMPOSE, deadlineMs: DEADLINE };
  const failed = await probeSubstrate({ ...base, run: psRunner('', 1).run });
  assert.deepEqual(failed, { state: 'unread', reason: 'stack-unreadable' });
  const garbage = await probeSubstrate({ ...base, run: psRunner('compose: command not found').run });
  assert.deepEqual(garbage, { state: 'unread', reason: 'stack-unreadable' });
  const empty = await probeSubstrate({ ...base, run: psRunner('[]').run });
  assert.deepEqual(empty, { state: 'unread', reason: 'no-published-ports' });
});

// -- the gate ----------------------------------------------------------------

test('a failed probe parks the provisioning gate carrying its own evidence', async (t) => {
  const { ctx, events } = fixture(t);
  const port = await freePort();
  const directive = await substrateGate(ctx, {
    stack: 'oly-r1',
    composeCommand: COMPOSE,
    cwd: process.cwd(),
    io: {
      run: psRunner(psDocument([{ service: 'db', port }])).run,
      addresses: ['127.0.0.1'],
      deadlineMs: DEADLINE,
    },
  });
  assert.equal(directive.park.type, 'provisioning-gate');
  assert.deepEqual(directive.park.options, ['retry']);
  assert.ok(directive.park.question.includes(`port ${port} (db)`));
  assert.ok(directive.park.question.includes('no loopback family accepted a connection'));
  assert.ok(directive.park.question.includes('before any layer re-run'));
  const stamp = events().find((e) => e.event === 'substrate-probe');
  assert.equal(stamp.state, 'failed');
  assert.equal(stamp.stack, 'oly-r1');
  assert.deepEqual(stamp.ports, [port]);
  assert.equal(stamp.failures[0].reason, 'unreachable');
});

test('a clean probe stamps and lets the route through; a run with no stack asks nothing', async (t) => {
  const { ctx, events } = fixture(t);
  const port = await listen(t, { address: '127.0.0.1', answer: true });
  const clean = await substrateGate(ctx, {
    stack: 'oly-r1',
    composeCommand: COMPOSE,
    cwd: process.cwd(),
    io: {
      run: psRunner(psDocument([{ service: 'web', port }])).run,
      addresses: ['127.0.0.1'],
      deadlineMs: DEADLINE,
    },
  });
  assert.equal(clean, null);
  assert.equal(events().filter((e) => e.event === 'substrate-probe')[0].state, 'clean');
  const runner = psRunner(psDocument([{ service: 'web', port }]));
  const none = await substrateGate(ctx, {
    stack: null,
    composeCommand: COMPOSE,
    cwd: process.cwd(),
    io: { run: runner.run },
  });
  assert.equal(none, null);
  assert.equal(runner.calls.length, 0);
  assert.equal(events().filter((e) => e.event === 'substrate-probe').length, 1);
});
