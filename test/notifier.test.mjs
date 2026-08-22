// The push edge: what the notifier sends, what it carries, what it does when
// a target refuses it, and what an instance without one does (nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { Notifier, NOTIFIED_EVENTS } from '../src/daemon/notifier.mjs';
import { homePaths, scaffoldHome } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { INSTANCE_EVENTS, LOUD_EVENTS } from '../src/ledger/registry.mjs';
import { validateInstanceConfig } from '../src/config/instance.mjs';
import { openInstanceStore } from '../src/telemetry/stores.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

const CONFIG = { version: 1 };

function errorPaths(config) {
  return validateInstanceConfig(config).map((e) => e.path);
}

/** An http target that records what it was posted. */
async function target(t, { status = 200 } = {}) {
  const posts = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      posts.push({ method: req.method, type: req.headers['content-type'], body: JSON.parse(body) });
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { posts, url: `http://127.0.0.1:${server.address().port}/hook` };
}

function store(t) {
  const dir = tempDir();
  const paths = scaffoldHome(dir);
  const ledger = openInstanceStore(paths);
  t.after(() => {
    ledger.close();
    removeDir(dir);
  });
  return { paths, ledger };
}

const parkLine = {
  seq: 12,
  ts: '2026-08-15T09:00:00.000Z',
  event: 'park',
  actor: 'daemon',
  stream: 'queued',
  type: 'provisioning-gate',
  question: 'the substrate is not ready',
  gist: 'provisioning-gate: the substrate is not ready',
};

// -- config -------------------------------------------------------------------

test('a notifier takes exactly one target', () => {
  assert.deepEqual(errorPaths({ ...CONFIG, notifier: { url: 'https://hooks.test/x' } }), []);
  assert.deepEqual(errorPaths({ ...CONFIG, notifier: { command: ['notify-send', 'olympus'] } }), []);
  assert.deepEqual(errorPaths({ ...CONFIG, notifier: {} }), ['notifier']);
  assert.deepEqual(
    errorPaths({ ...CONFIG, notifier: { url: 'https://hooks.test/x', command: ['x'] } }),
    ['notifier'],
  );
});

test('a notifier target is an http url or a real argv', () => {
  assert.deepEqual(errorPaths({ ...CONFIG, notifier: { url: 'hooks.test/x' } }), ['notifier.url']);
  assert.deepEqual(errorPaths({ ...CONFIG, notifier: { url: 'file:///etc/passwd' } }), [
    'notifier.url',
  ]);
  assert.deepEqual(errorPaths({ ...CONFIG, notifier: { command: [] } }), ['notifier.command']);
  assert.deepEqual(errorPaths({ ...CONFIG, notifier: { command: 'notify' } }), ['notifier.command']);
  assert.deepEqual(errorPaths({ ...CONFIG, notifier: { command: ['n'], timeoutMs: 0 } }), [
    'notifier.timeoutMs',
  ]);
  assert.deepEqual(errorPaths({ ...CONFIG, notifier: 'https://hooks.test/x' }), ['notifier']);
});

// -- what goes out ------------------------------------------------------------

test('the notified set is a park, a close, and every loud record', () => {
  assert.deepEqual([...NOTIFIED_EVENTS].sort(), ['park', 'run-closed', ...LOUD_EVENTS].sort());
  // Not a copy of the loud set: a loud event added to the registry is pushed
  // without a second edit here.
  for (const event of LOUD_EVENTS) assert.ok(NOTIFIED_EVENTS.has(event), event);
});

test('a loud record pushes with the gist the strip would have shown', async (t) => {
  const { ledger } = store(t);
  const hook = await target(t);
  const notifier = new Notifier({ ledger, config: () => ({ url: hook.url }) });
  await notifier.notify({
    ledger: 'run:alpha-9',
    project: 'alpha',
    line: {
      seq: 61,
      ts: parkLine.ts,
      event: 'gate-integrity',
      stream: 'loud',
      gist: 'PR 147 opened without the migration label',
      detail: { pr: 147 },
    },
  });
  await notifier.drain();
  assert.deepEqual(hook.posts[0].body, {
    event: 'gate-integrity',
    ts: parkLine.ts,
    seq: 61,
    ledger: 'run:alpha-9',
    runId: 'alpha-9',
    gist: 'PR 147 opened without the migration label',
    project: 'alpha',
  });
});

test('the failure stamp is a known instance event', () => {
  assert.ok(INSTANCE_EVENTS.has('notify-failed'));
});

test('a park posts as json, with the run it belongs to', async (t) => {
  const { ledger } = store(t);
  const hook = await target(t);
  const notifier = new Notifier({ ledger, config: () => ({ url: hook.url }) });
  await notifier.notify({ ledger: 'run:alpha-9', project: 'alpha', line: parkLine });
  await notifier.drain();
  assert.equal(hook.posts.length, 1);
  assert.equal(hook.posts[0].method, 'POST');
  assert.equal(hook.posts[0].type, 'application/json');
  assert.deepEqual(hook.posts[0].body, {
    event: 'park',
    ts: parkLine.ts,
    seq: 12,
    ledger: 'run:alpha-9',
    runId: 'alpha-9',
    type: 'provisioning-gate',
    gist: parkLine.gist,
    project: 'alpha',
  });
});

test('the payload is an allowlist, so a new stamp field never rides out', async (t) => {
  const { ledger } = store(t);
  const hook = await target(t);
  const notifier = new Notifier({ ledger, config: () => ({ url: hook.url }) });
  await notifier.notify({
    ledger: 'run:alpha-9',
    project: 'alpha',
    line: {
      ...parkLine,
      // Everything a park record holds beyond the projection: the console
      // reads these from the ledger, and a webhook is somebody else's machine.
      refs: { specRef: 'C:/home/runs/alpha-9/spec.md' },
      detail: { token: 'ghp_should_never_travel' },
      answer: 'the operator wrote this',
    },
  });
  await notifier.drain();
  assert.deepEqual(Object.keys(hook.posts[0].body).sort(), [
    'event',
    'gist',
    'ledger',
    'project',
    'runId',
    'seq',
    'ts',
    'type',
  ]);
});

test('a breach and a close carry the figures that make them worth a push', async (t) => {
  const { ledger } = store(t);
  const hook = await target(t);
  const notifier = new Notifier({ ledger, config: () => ({ url: hook.url }) });
  await notifier.notify({
    ledger: 'run:alpha-9',
    project: 'alpha',
    line: {
      seq: 30,
      ts: parkLine.ts,
      event: 'budget-breach',
      threshold: 100,
      cost: 121.5,
      stage: 'verdict',
      gist: 'alpha-9 is at $121.50 of its $100.00 story budget',
    },
  });
  await notifier.notify({
    ledger: 'run:alpha-9',
    project: 'alpha',
    line: { seq: 44, ts: parkLine.ts, event: 'run-closed', state: 'shipped', pr: 7 },
  });
  await notifier.drain();
  assert.equal(hook.posts[0].body.cost, 121.5);
  assert.equal(hook.posts[0].body.threshold, 100);
  assert.equal(hook.posts[1].body.state, 'shipped');
  assert.equal(hook.posts[1].body.pr, undefined);
});

test('every other event passes without a push', async (t) => {
  const { ledger } = store(t);
  const hook = await target(t);
  const notifier = new Notifier({ ledger, config: () => ({ url: hook.url }) });
  for (const event of ['seat-report', 'freeze', 'merged', 'resolved', 'stage-entered']) {
    await notifier.notify({ ledger: 'run:alpha-9', line: { seq: 1, ts: parkLine.ts, event } });
  }
  await notifier.drain();
  assert.equal(hook.posts.length, 0);
});

// -- the command form ---------------------------------------------------------

/** A notify command that appends whatever it is given to one file. */
function sinkCommand(t) {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const script = join(dir, 'sink.mjs');
  const sink = join(dir, 'received.jsonl');
  writeFileSync(
    script,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(sink)}, readFileSync(0, 'utf8'));`,
      '',
    ].join('\n'),
  );
  return {
    command: [process.execPath, script],
    received: () =>
      existsSync(sink)
        ? readFileSync(sink, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  };
}

test('a command target reads the payload on stdin, for a park and for a loud item', async (t) => {
  const { ledger } = store(t);
  const fake = sinkCommand(t);
  const notifier = new Notifier({ ledger, config: () => ({ command: fake.command }) });
  await notifier.notify({ ledger: 'run:alpha-9', project: 'alpha', line: parkLine });
  await notifier.drain();
  await notifier.notify({
    ledger: 'run:alpha-9',
    project: 'alpha',
    line: {
      seq: 77,
      ts: parkLine.ts,
      event: 'liveness-violation',
      stream: 'loud',
      gist: 'alpha-9 holds no child, no park and no transition',
    },
  });
  await notifier.drain();
  const received = fake.received();
  assert.equal(received.length, 2);
  assert.deepEqual(
    received.map((p) => [p.event, p.runId, p.seq]),
    [
      ['park', 'alpha-9', 12],
      ['liveness-violation', 'alpha-9', 77],
    ],
  );
  assert.equal(received[0].type, 'provisioning-gate');
  assert.equal(received[1].gist, 'alpha-9 holds no child, no park and no transition');
  assert.equal(readEvents(ledger.ledger.path).length, 0);
});

test('the command spawns through the executable resolver, so a shim runs', async (t) => {
  const { ledger } = store(t);
  const spawned = [];
  // What `resolveArgv` answers for a `.cmd` shim on Windows: cmd.exe, an
  // escaped command line, and verbatim arguments (ADR-0013). The resolver is
  // injected because no test on another platform can stage that host.
  const shim = {
    file: 'C:\\Windows\\system32\\cmd.exe',
    args: ['/d', '/s', '/c', '"C:\\tools\\notify.cmd olympus"'],
    windowsVerbatimArguments: true,
  };
  const notifier = new Notifier({
    ledger,
    config: () => ({ command: ['notify', 'olympus'] }),
    resolveImpl: (argv) => {
      spawned.push({ argv });
      return shim;
    },
    spawnImpl: (file, args, opts) => {
      spawned.push({ file, args, opts });
      throw new Error('spawned');
    },
  });
  await notifier.notify({ ledger: 'run:alpha-9', line: parkLine });
  await notifier.drain();
  assert.deepEqual(spawned[0].argv, ['notify', 'olympus']);
  assert.equal(spawned[1].file, shim.file);
  assert.deepEqual(spawned[1].args, shim.args);
  assert.equal(spawned[1].opts.windowsVerbatimArguments, true);
  assert.equal(spawned[1].opts.windowsHide, true);
});

// -- failure ------------------------------------------------------------------

test('a target that answers with an error stamps, and says nothing about itself', async (t) => {
  const { ledger } = store(t);
  const hook = await target(t, { status: 503 });
  const notifier = new Notifier({ ledger, config: () => ({ url: hook.url }) });
  await notifier.notify({ ledger: 'run:alpha-9', project: 'alpha', line: parkLine });
  await notifier.drain();
  const events = readEvents(ledger.ledger.path);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'notify-failed');
  assert.equal(events[0].notifiedEvent, 'park');
  assert.equal(events[0].notifiedSeq, 12);
  assert.equal(events[0].runId, 'alpha-9');
  assert.equal(events[0].project, 'alpha');
  assert.equal(events[0].target, 'webhook');
  assert.equal(events[0].reason, 'http 503');
  // Quiet on purpose: a loud record about a broken push would be an alert only
  // the pull surfaces could deliver.
  assert.equal(events[0].stream, undefined);
});

test('an unreachable target stamps without echoing the target back', async (t) => {
  const { ledger } = store(t);
  const url = 'http://127.0.0.1:1/secret-token-in-the-path';
  const notifier = new Notifier({ ledger, config: () => ({ url }) });
  await notifier.notify({ ledger: 'run:alpha-9', line: parkLine });
  await notifier.drain();
  const events = readEvents(ledger.ledger.path);
  assert.equal(events[0].event, 'notify-failed');
  assert.ok(!events[0].reason.includes('secret-token-in-the-path'));
});

test('a command that fails stamps its exit code', async (t) => {
  const { ledger } = store(t);
  const notifier = new Notifier({
    ledger,
    config: () => ({ command: [process.execPath, '-e', 'process.exit(3)'] }),
  });
  await notifier.notify({ ledger: 'run:alpha-9', line: parkLine });
  await notifier.drain();
  const events = readEvents(ledger.ledger.path);
  assert.equal(events[0].event, 'notify-failed');
  assert.equal(events[0].target, 'command');
  assert.equal(events[0].reason, 'exit 3');
});

test('a command that cannot be spawned at all stamps too', async (t) => {
  const { ledger } = store(t);
  const notifier = new Notifier({
    ledger,
    config: () => ({ command: ['this-executable-does-not-exist-olympus'] }),
  });
  await notifier.notify({ ledger: 'run:alpha-9', line: parkLine });
  await notifier.drain();
  assert.equal(readEvents(ledger.ledger.path)[0].event, 'notify-failed');
});

test('a target that never answers is abandoned at the timeout', async (t) => {
  const { ledger } = store(t);
  const notifier = new Notifier({
    ledger,
    config: () => ({ command: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 50 }),
  });
  await notifier.notify({ ledger: 'run:alpha-9', line: parkLine });
  await notifier.drain();
  assert.match(readEvents(ledger.ledger.path)[0].reason, /timed out after 50ms/);
});

test('a notify that throws inside the notifier never reaches the caller', async (t) => {
  const { ledger } = store(t);
  const notifier = new Notifier({
    ledger,
    config: () => ({ url: 'https://hooks.test/x' }),
    fetchImpl: () => {
      throw new Error('the transport itself is broken');
    },
  });
  assert.doesNotThrow(() => notifier.notify({ ledger: 'run:alpha-9', line: parkLine }));
  await notifier.drain();
  assert.equal(readEvents(ledger.ledger.path)[0].reason, 'the transport itself is broken');
});

// -- unconfigured -------------------------------------------------------------

test('no notifier section: no push, no stamp, no transport touched', async (t) => {
  const { ledger } = store(t);
  let called = 0;
  const notifier = new Notifier({
    ledger,
    config: () => undefined,
    fetchImpl: () => {
      called++;
      throw new Error('unreachable');
    },
    spawnImpl: () => {
      called++;
      throw new Error('unreachable');
    },
  });
  for (const event of NOTIFIED_EVENTS) {
    await notifier.notify({ ledger: 'run:alpha-9', line: { ...parkLine, event } });
  }
  await notifier.drain();
  assert.equal(called, 0);
  assert.equal(readEvents(ledger.ledger.path).length, 0);
});

// -- through the daemon -------------------------------------------------------

/** A one-stage lane that parks, then closes over its budget on the answer. */
const spendingLane = {
  stages: ['work'],
  handlers: {
    work: (ctx) => {
      if (ctx.lastAnswer) return { close: { state: 'shipped' } };
      ctx.store.append('seat-spawned', { actor: 'daemon', seat: 'dev' });
      ctx.store.append('seat-report', { actor: 'dev', seat: 'dev', path: 'r.json', cost: 200 });
      return { park: { type: 'provisioning-gate', question: 'continue?', options: ['yes'] } };
    },
  },
};

async function daemonWith(t, notifier) {
  const home = tempDir();
  const paths = homePaths(home);
  scaffoldHome(home);
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: {}, ...(notifier && { notifier }) }, null, 2) + '\n',
  );
  const daemon = new Daemon(home, { lanes: { story: spendingLane } });
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  daemon.config.projects.proj = { slotCap: 1 };
  return { home, paths, daemon };
}

test('the daemon pushes the park, the breach, and the close', async (t) => {
  const hook = await target(t);
  const fx = await daemonWith(t, { url: hook.url });
  fx.daemon.engine.launch({ runId: 'r1', project: 'proj', lane: 'story', budget: 100 });
  await waitFor(() => hook.posts.length >= 2, { label: 'park and breach pushed' });
  fx.daemon.engine.answer({ runId: 'r1', actor: 'human', option: 'yes' });
  await waitFor(() => hook.posts.length >= 3, { label: 'close pushed' });
  await fx.daemon.notifier.drain();
  assert.deepEqual(
    hook.posts.map((p) => p.body.event),
    ['budget-breach', 'park', 'run-closed'],
  );
  for (const post of hook.posts) {
    assert.equal(post.body.runId, 'r1');
    assert.equal(post.body.project, 'proj');
  }
  assert.equal(hook.posts.at(-1).body.state, 'shipped');
});

test('a broken notifier neither blocks the lane nor fails the daemon', async (t) => {
  const fx = await daemonWith(t, { url: 'http://127.0.0.1:1/gone' });
  fx.daemon.engine.launch({ runId: 'r1', project: 'proj', lane: 'story', budget: 100 });
  await waitFor(
    () => readEvents(fx.paths.instanceLedger).filter((e) => e.event === 'notify-failed').length >= 2,
    { label: 'failures stamped' },
  );
  // The run did what it would have done with no notifier at all.
  fx.daemon.engine.answer({ runId: 'r1', actor: 'human', option: 'yes' });
  await waitFor(
    () => existsSync(join(fx.paths.archivedRuns, 'r1', 'ledger.jsonl')),
    { label: 'run closed' },
  );
  const closed = readEvents(join(fx.paths.archivedRuns, 'r1', 'ledger.jsonl'));
  assert.equal(closed.at(-1).event, 'run-closed');
  assert.equal(closed.at(-1).state, 'shipped');
  await fx.daemon.stop();
  const instance = readEvents(fx.paths.instanceLedger);
  assert.ok(instance.filter((e) => e.event === 'notify-failed').length >= 3);
  assert.equal(instance.at(-1).event, 'daemon-stopped');
});

test('a notify command that fails leaves the park standing, quietly', async (t) => {
  const fx = await daemonWith(t, { command: [process.execPath, '-e', 'process.exit(3)'] });
  fx.daemon.engine.launch({ runId: 'r1', project: 'proj', lane: 'story', budget: 100 });
  await waitFor(
    () =>
      readEvents(fx.paths.instanceLedger).some(
        (e) => e.event === 'notify-failed' && e.notifiedEvent === 'park',
      ),
    { label: 'the park notification failed' },
  );
  const failures = readEvents(fx.paths.instanceLedger).filter((e) => e.event === 'notify-failed');
  assert.ok(failures.every((e) => e.target === 'command' && e.reason === 'exit 3'));
  // Quiet: the pull surfaces are the authority a broken push falls back to.
  assert.ok(failures.every((e) => e.stream === undefined));
  // The park is untouched by the failed push — still there, still answerable,
  // and the run closes on the answer as it would with no notifier at all.
  const parked = readEvents(join(fx.paths.runs, 'r1', 'ledger.jsonl')).filter(
    (e) => e.event === 'park',
  );
  assert.equal(parked.length, 1);
  assert.equal(parked[0].type, 'provisioning-gate');
  fx.daemon.engine.answer({ runId: 'r1', actor: 'human', option: 'yes' });
  await waitFor(() => existsSync(join(fx.paths.archivedRuns, 'r1', 'ledger.jsonl')), {
    label: 'run closed',
  });
  assert.equal(readEvents(join(fx.paths.archivedRuns, 'r1', 'ledger.jsonl')).at(-1).state, 'shipped');
});

test('an unconfigured daemon stamps nothing about notifications', async (t) => {
  const fx = await daemonWith(t, null);
  fx.daemon.engine.launch({ runId: 'r1', project: 'proj', lane: 'story', budget: 100 });
  await waitFor(
    () => readEvents(join(fx.paths.runs, 'r1', 'ledger.jsonl')).some((e) => e.event === 'park'),
    { label: 'parked' },
  );
  fx.daemon.engine.answer({ runId: 'r1', actor: 'human', option: 'yes' });
  await waitFor(() => existsSync(join(fx.paths.archivedRuns, 'r1', 'ledger.jsonl')), {
    label: 'run closed',
  });
  assert.equal(
    readEvents(fx.paths.instanceLedger).filter((e) => e.event === 'notify-failed').length,
    0,
  );
});
