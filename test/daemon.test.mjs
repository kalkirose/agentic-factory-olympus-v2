import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { homePaths, runLedgerPath, scaffoldHome } from '../src/daemon/home.mjs';
import { readLock } from '../src/daemon/lock.mjs';
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

// -- exit stamping -----------------------------------------------------------
// Every way a daemon can end has to reach the same stamp; a start that finds
// none knows the previous instance died where nothing was watching (ADR-0016).

const DAEMON_URL = new URL('../src/daemon/daemon.mjs', import.meta.url).href;

/** Runs a daemon in a child process and resolves its exit code and stderr. */
function runDaemonProcess(home, body) {
  const source = `
    const { Daemon } = await import(${JSON.stringify(DAEMON_URL)});
    const daemon = new Daemon(${JSON.stringify(home)}, { handleSignals: true });
    await daemon.start();
    ${body}
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.on('data', () => {});
    child.on('close', (code) => resolve({ code, stderr, pid: child.pid }));
  });
}

test('an exit that reached no stop path still stamps the stop', async (t) => {
  const home = tempDir();
  t.after(() => removeDir(home));
  const { code } = await runDaemonProcess(home, 'process.exit(0);');
  assert.equal(code, 0);
  const last = instanceEvents(home).at(-1);
  assert.equal(last.event, 'daemon-stopped');
  assert.equal(last.trigger, 'exit');
});

test('a fault stamps the stop and leaves with a failing code', async (t) => {
  const home = tempDir();
  t.after(() => removeDir(home));
  const { code } = await runDaemonProcess(home, 'setTimeout(() => { throw new Error("boom"); }, 0);');
  assert.equal(code, 1);
  const last = instanceEvents(home).at(-1);
  assert.equal(last.event, 'daemon-stopped');
  assert.equal(last.trigger, 'fault');
  assert.match(last.error, /boom/);
});

test('a death nothing could stamp is named at the next start', async (t) => {
  const home = tempDir();
  t.after(() => removeDir(home));
  // SIGKILL runs no handler on any platform: the instance ends mid-life with
  // the ledger's tail wherever it happened to be.
  const killed = runDaemonProcess(home, 'setInterval(() => {}, 1 << 30);');
  const paths = homePaths(home);
  const pid = await waitFor(() => readLock(paths.lock)?.pid, { label: 'the daemon to hold its lock' });
  await waitFor(() => instanceEvents(home).some((e) => e.event === 'daemon-started'), {
    label: 'the daemon to stamp its start',
  });
  process.kill(pid, 'SIGKILL');
  await killed;
  assert.ok(!instanceEvents(home).some((e) => e.event === 'daemon-stopped'));

  const before = instanceEvents(home);
  const daemon = new Daemon(home);
  await daemon.start();
  await daemon.stop();
  const events = instanceEvents(home);
  const crash = events.find((e) => e.event === 'daemon-crash-detected');
  assert.equal(crash.lastSeq, before.at(-1).seq);
  assert.equal(crash.lastEvent, before.at(-1).event);
  assert.equal(crash.startedSeq, before.find((e) => e.event === 'daemon-started').seq);
  // It lands before this instance says anything of its own, and the clean stop
  // that follows leaves nothing for the start after this one to detect.
  assert.equal(events[crash.seq].event, 'daemon-started');
  const after = new Daemon(home);
  await after.start();
  await after.stop();
  assert.equal(instanceEvents(home).filter((e) => e.event === 'daemon-crash-detected').length, 1);
});

test('a home with no history has nothing to have crashed', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  assert.equal(instanceEvents(home)[0].event, 'daemon-started');
  assert.ok(!instanceEvents(home).some((e) => e.event === 'daemon-crash-detected'));
});

test('a console break belongs to whoever it was aimed at, not to the daemon', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home, { handleSignals: true });
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  // Windows delivers a console control event to a whole process group and says
  // nothing about the member it was meant for, so a break aimed at a seat
  // arrives here too. It is listened for — unhandled it is fatal — and then
  // deliberately dropped.
  assert.ok(process.listeners('SIGBREAK').includes(daemon.signalHandler));
  daemon.signalHandler('SIGBREAK');
  assert.equal(daemon.running, true);
  assert.equal(daemon.stopPromise, null);
  assert.ok(!instanceEvents(home).some((e) => e.event === 'daemon-stopped'));
  // The signals that do mean this daemon still end it, and still stamp.
  await daemon.stop({ trigger: 'signal', actor: 'daemon', signal: 'SIGTERM' });
  const stopped = instanceEvents(home).at(-1);
  assert.equal(stopped.event, 'daemon-stopped');
  assert.equal(stopped.signal, 'SIGTERM');
});
