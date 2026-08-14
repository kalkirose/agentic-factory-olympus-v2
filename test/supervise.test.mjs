import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { superviseSeat } from '../src/engine/supervise.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { tempDir, removeDir } from './helpers.mjs';

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

function nodeSeat(code) {
  return { cmd: process.execPath, args: ['-e', code] };
}

test('progress lines stamp seat-progress and a clean exit is no failure', async (t) => {
  const { paths, store } = setup(t);
  const seat = superviseSeat(store, {
    seat: 'dev-1',
    ...nodeSeat(
      `console.log(JSON.stringify({cost: 5, note: 'half'}));
       console.log(JSON.stringify({cost: 9}));
       console.log('plain narration is not progress');`,
    ),
  });
  const result = await seat.done;
  assert.equal(result.failed, false);
  assert.equal(result.cost, 9);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  assert.equal(events[0].event, 'seat-spawned');
  assert.equal(events[0].seat, 'dev-1');
  const progress = events.filter((e) => e.event === 'seat-progress');
  assert.equal(progress.length, 2);
  assert.equal(progress[0].actor, 'dev-1');
  assert.equal(progress[0].cost, 5);
  assert.equal(progress[0].note, 'half');
  assert.equal(progress[1].cost, 9);
  assert.ok(!events.some((e) => e.event === 'seat-failure'));
});

test('a nonzero exit stamps seat-failure with the code', async (t) => {
  const { paths, store } = setup(t);
  const seat = superviseSeat(store, { seat: 'dev-1', ...nodeSeat('process.exit(3)') });
  const result = await seat.done;
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'exit');
  assert.equal(result.code, 3);
  const failure = readEvents(runLedgerPath(paths, 'r1')).find((e) => e.event === 'seat-failure');
  assert.equal(failure.reason, 'exit');
  assert.equal(failure.code, 3);
});

test('a failed seat records what it emitted, so the cause reads from the ledger', async (t) => {
  const { paths, store } = setup(t);
  const seat = superviseSeat(store, {
    seat: 'dev-1',
    ...nodeSeat(
      `console.log(JSON.stringify({type: 'system', subtype: 'init'}));
       console.error('Error: input must be provided as a prompt argument');
       process.exit(1);`,
    ),
  });
  const result = await seat.done;
  assert.equal(result.failed, true);
  const failure = readEvents(runLedgerPath(paths, 'r1')).find((e) => e.event === 'seat-failure');
  assert.ok(failure.stderrTail.includes('input must be provided'));
  assert.ok(failure.stdoutTail.some((line) => line.includes('init')));
  assert.equal(result.stderrTail, failure.stderrTail);
});

test('the recorded evidence is bounded — a ledger, not a log sink', async (t) => {
  const { paths, store } = setup(t);
  const seat = superviseSeat(store, {
    seat: 'dev-1',
    ...nodeSeat(
      `for (let i = 0; i < 40; i++) console.log('x'.repeat(4000) + ' line ' + i);
       console.error('y'.repeat(20000) + 'THE LAST WORD');
       process.exit(1);`,
    ),
  });
  await seat.done;
  const failure = readEvents(runLedgerPath(paths, 'r1')).find((e) => e.event === 'seat-failure');
  assert.equal(failure.stdoutTail.length, 3);
  for (const line of failure.stdoutTail) assert.ok(line.length <= 200);
  assert.ok(failure.stderrTail.length <= 600);
  // The end of the stream is kept: the last thing a dying child says names the
  // cause, and the last stdout lines are the ones nearest the failure.
  assert.ok(failure.stderrTail.endsWith('THE LAST WORD'));
  assert.ok(failure.stdoutTail.at(-1).startsWith('xxx'));
});

test('a clean seat records no evidence at all', async (t) => {
  const { paths, store } = setup(t);
  const seat = superviseSeat(store, {
    seat: 'dev-1',
    ...nodeSeat(`console.error('a warning nobody needs'); console.log('{"cost":1}');`),
  });
  const result = await seat.done;
  assert.equal(result.failed, false);
  assert.equal(result.stderrTail, undefined);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  assert.ok(!events.some((e) => e.event === 'seat-failure'));
  assert.ok(!events.some((e) => e.stderrTail !== undefined));
});

test('a progress line cannot shadow envelope fields', async (t) => {
  const { paths, store } = setup(t);
  const seat = superviseSeat(store, {
    seat: 'dev-1',
    ...nodeSeat(`console.log(JSON.stringify({cost: 1, event: 'run-closed', seq: 999}));`),
  });
  const result = await seat.done;
  assert.equal(result.failed, false);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  assert.ok(!events.some((e) => e.event === 'run-closed'));
  assert.equal(events.find((e) => e.event === 'seat-progress').cost, 1);
});

test('the cost ceiling terminates the seat and stamps seat-failure', async (t) => {
  const { paths, store } = setup(t);
  const seat = superviseSeat(store, {
    seat: 'dev-1',
    costCeiling: 10,
    ...nodeSeat(`console.log(JSON.stringify({cost: 50})); setInterval(() => {}, 1000);`),
  });
  const result = await seat.done;
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'cost-ceiling');
  assert.equal(result.cost, 50);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  const failure = events.find((e) => e.event === 'seat-failure');
  assert.equal(failure.reason, 'cost-ceiling');
  assert.equal(failure.cost, 50);
  assert.equal(failure.costCeiling, 10);
  assert.ok(!events.some((e) => e.event === 'seat-terminated'));
});

test('terminate ends the seat with seat-terminated, not seat-failure', async (t) => {
  const { paths, store } = setup(t);
  const seat = superviseSeat(store, { seat: 'dev-1', ...nodeSeat('setInterval(() => {}, 1000)') });
  seat.terminate('run-killed');
  const result = await seat.done;
  assert.equal(result.terminated, true);
  assert.equal(result.reason, 'run-killed');
  const events = readEvents(runLedgerPath(paths, 'r1'));
  assert.equal(events.find((e) => e.event === 'seat-terminated').reason, 'run-killed');
  assert.ok(!events.some((e) => e.event === 'seat-failure'));
});

test('a spawn error stamps seat-failure on the spawn route', async (t) => {
  const { paths, store } = setup(t);
  const seat = superviseSeat(store, { seat: 'dev-1', cmd: 'no-such-binary-anywhere' });
  const result = await seat.done;
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'spawn');
  const failure = readEvents(runLedgerPath(paths, 'r1')).find((e) => e.event === 'seat-failure');
  assert.equal(failure.reason, 'spawn');
});

// -- secret environment -------------------------------------------------------

// The machine's credentials, as a host that runs a payment provider's test
// mode holds them, plus the near misses that must survive every pattern.
const SECRET_PATTERNS = ['PAY_SECRET_*', '*_TOKEN', 'ADMIN_PASSWORD'];
const MACHINE_ENV = {
  PAY_SECRET_KEY: 'sk-test-1',
  PAY_SECRET_WEBHOOK: 'whsec-1',
  SESSION_TOKEN: 'tok-1',
  ADMIN_PASSWORD: 'pw-1',
  PAY_PUBLIC_KEY: 'pk-test-1',
  TOKEN_STORE: 'store-1',
  ADMIN_PASSWORD_HINT: 'the usual one',
  RUN_ID: 'r1',
};
const SECRET_NAMES = ['PAY_SECRET_KEY', 'PAY_SECRET_WEBHOOK', 'SESSION_TOKEN', 'ADMIN_PASSWORD'];
const KEPT_NAMES = ['PAY_PUBLIC_KEY', 'TOKEN_STORE', 'ADMIN_PASSWORD_HINT', 'RUN_ID'];

// The environment a seat child actually inherited: the child writes it to a
// file, because nothing outside the process can read what it was given.
async function spawnedEnv(t, store, { seat, env, secretEnv }) {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const file = join(dir, 'env.json');
  const dump = `require('fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify(process.env));`;
  const result = await superviseSeat(store, { seat, ...nodeSeat(dump), env, secretEnv }).done;
  assert.equal(result.failed, false);
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('a seat that never runs the suite is spawned without the machine secrets', async (t) => {
  const { paths, store } = setup(t);
  const seen = await spawnedEnv(t, store, {
    seat: 'spec-gate',
    env: MACHINE_ENV,
    secretEnv: SECRET_PATTERNS,
  });
  for (const name of SECRET_NAMES) assert.equal(seen[name], undefined, name);
  // Everything else is untouched, including the names a pattern nearly caught.
  for (const name of KEPT_NAMES) assert.equal(seen[name], MACHINE_ENV[name], name);
  // A strip, never an allowlist: the CLI keeps the host environment it needs
  // to run at all.
  assert.ok(Object.keys(seen).some((name) => name.toLowerCase() === 'path'));
  const spawned = readEvents(runLedgerPath(paths, 'r1')).find((e) => e.event === 'seat-spawned');
  // The count, and never the names.
  assert.equal(spawned.envStripped, SECRET_NAMES.length);
  assert.ok(!SECRET_NAMES.some((name) => JSON.stringify(spawned).includes(name)));
});

test('a seat that executes the suite keeps the environment whole', async (t) => {
  const { paths, store } = setup(t);
  const seen = await spawnedEnv(t, store, {
    seat: 'dev',
    env: MACHINE_ENV,
    secretEnv: SECRET_PATTERNS,
  });
  for (const [name, value] of Object.entries(MACHINE_ENV)) assert.equal(seen[name], value, name);
  const spawned = readEvents(runLedgerPath(paths, 'r1')).find((e) => e.event === 'seat-spawned');
  assert.equal(spawned.envStripped, undefined);
});

test('without patterns every seat inherits the same environment', async (t) => {
  const { paths, store } = setup(t);
  const gate = await spawnedEnv(t, store, { seat: 'spec-gate', env: MACHINE_ENV });
  const dev = await spawnedEnv(t, store, { seat: 'dev', env: MACHINE_ENV });
  assert.deepEqual(gate, dev);
  // Identical because nothing was removed, not because both were emptied.
  for (const name of SECRET_NAMES) assert.equal(gate[name], MACHINE_ENV[name], name);
  assert.ok(!readEvents(runLedgerPath(paths, 'r1')).some((e) => e.envStripped !== undefined));
});

// The seat command comes from config the same way a gate command does, so a
// tool that exists only as a Windows shim has to run here too.
test(
  'a seat command that is a Windows shim runs and reports progress',
  { skip: process.platform === 'win32' ? false : 'runs on Windows only' },
  async (t) => {
    const { paths, store } = setup(t);
    const dir = tempDir();
    t.after(() => removeDir(dir));
    writeFileSync(
      join(dir, 'seattool.mjs'),
      `console.log(JSON.stringify({cost: 3, note: process.argv[2]}));\n`,
    );
    writeFileSync(join(dir, 'seattool.cmd'), `@echo off\r\nnode "%~dp0seattool.mjs" %*\r\n`);
    const seat = superviseSeat(store, {
      seat: 'dev-1',
      cmd: 'seattool',
      args: ['a note & not a command'],
      env: { PATH: `${dir};${process.env.PATH}` },
    });
    const result = await seat.done;
    assert.equal(result.failed, false);
    assert.equal(result.cost, 3);
    const progress = readEvents(runLedgerPath(paths, 'r1')).filter(
      (e) => e.event === 'seat-progress',
    );
    assert.equal(progress.length, 1);
    assert.equal(progress[0].note, 'a note & not a command');
  },
);
