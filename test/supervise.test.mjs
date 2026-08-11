import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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
