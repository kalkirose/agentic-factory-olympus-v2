import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { homePaths, runLedgerPath, scaffoldHome } from '../src/daemon/home.mjs';
import { Ledger, readEvents } from '../src/ledger/ledger.mjs';
import { RUN_EVENTS } from '../src/ledger/registry.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

function instanceEvents(home) {
  return readEvents(homePaths(home).instanceLedger);
}

// Control files follow the write-then-rename convention so the daemon never
// reads a half-written command.
function writeControl(home, command) {
  const paths = homePaths(home);
  const tmp = join(paths.control, 'cmd.tmp');
  writeFileSync(tmp, JSON.stringify(command) + '\n');
  renameSync(tmp, join(paths.control, 'cmd.json'));
}

test('start scaffolds the home and stamps lifecycle events', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  const paths = homePaths(home);
  assert.ok(existsSync(paths.runs));
  assert.ok(existsSync(paths.control));
  assert.ok(existsSync(paths.instanceConfig));
  await daemon.stop();
  const events = instanceEvents(home);
  assert.equal(events[0].event, 'daemon-started');
  assert.deepEqual(events[0].runsResumed, []);
  assert.equal(events.at(-1).event, 'daemon-stopped');
});

test('a second daemon on the same home is refused', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  await assert.rejects(() => new Daemon(home).start(), /already running/);
});

test('open runs are detected at start', async (t) => {
  const home = tempDir();
  t.after(() => removeDir(home));
  const paths = scaffoldHome(home);
  const open = new Ledger(runLedgerPath(paths, 'run-a'), { allowedEvents: RUN_EVENTS });
  open.append('run-launched', { actor: 'daemon' });
  open.close();
  const closed = new Ledger(runLedgerPath(paths, 'run-b'), { allowedEvents: RUN_EVENTS });
  closed.append('run-launched', { actor: 'daemon' });
  closed.append('run-closed', { actor: 'daemon', state: 'shipped' });
  closed.close();
  const daemon = new Daemon(home);
  const { runsResumed } = await daemon.start();
  await daemon.stop();
  assert.deepEqual(runsResumed, ['run-a']);
});

test('a live config edit applies and stamps config-changed', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  const paths = homePaths(home);
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, semaphores: { 'model-a': 2 } }, null, 2),
  );
  const stamp = await waitFor(
    () => instanceEvents(home).find((e) => e.event === 'config-changed'),
    { label: 'config-changed stamp' },
  );
  assert.equal(stamp.accepted, true);
  assert.ok(stamp.changedKeys.includes('semaphores'));
  assert.equal(daemon.config.semaphores['model-a'], 2);
});

test('an invalid config edit is refused and the old config stays live', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  const before = daemon.config;
  writeFileSync(homePaths(home).instanceConfig, JSON.stringify({ version: 3 }));
  const stamp = await waitFor(
    () => instanceEvents(home).find((e) => e.event === 'config-changed'),
    { label: 'refused config-changed stamp' },
  );
  assert.equal(stamp.accepted, false);
  assert.match(stamp.error, /version/);
  assert.equal(daemon.config, before);
});

test('a stop command through the control inbox stops the daemon', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  writeControl(home, { actor: 'tester', command: 'stop' });
  await waitFor(() => !daemon.running, { label: 'daemon stopped by control command' });
  const events = instanceEvents(home);
  const stopped = events.at(-1);
  assert.equal(stopped.event, 'daemon-stopped');
  assert.equal(stopped.trigger, 'control');
  assert.equal(stopped.actor, 'tester');
  assert.equal(readdirSync(homePaths(home).controlDone).length, 1);
});

test('unknown and malformed commands are rejected with a reason', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  writeControl(home, { actor: 'tester', command: 'dance' });
  await waitFor(
    () => readdirSync(homePaths(home).controlRejected).some((f) => f.endsWith('.json')),
    { label: 'command rejected' },
  );
  assert.equal(daemon.running, true);
  const reasons = readdirSync(homePaths(home).controlRejected).filter((f) =>
    f.endsWith('.reason.txt'),
  );
  assert.equal(reasons.length, 1);
});

test('control files from before start are archived as stale', async (t) => {
  const home = tempDir();
  t.after(() => removeDir(home));
  scaffoldHome(home);
  writeControl(home, { actor: 'tester', command: 'stop' });
  const daemon = new Daemon(home);
  await daemon.start();
  assert.equal(daemon.running, true);
  assert.equal(readdirSync(homePaths(home).control).filter((f) => f.endsWith('.json')).length, 0);
  await daemon.stop();
});
