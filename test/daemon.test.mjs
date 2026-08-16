import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, renameSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { homePaths, runLedgerPath, scaffoldHome } from '../src/daemon/home.mjs';
import { readLock } from '../src/daemon/lock.mjs';
import { Ledger, readEvents } from '../src/ledger/ledger.mjs';
import { RUN_EVENTS } from '../src/ledger/registry.mjs';
import { openLoud, openWorkspaceLeftovers } from '../src/telemetry/readers.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

function instanceEvents(home) {
  return readEvents(homePaths(home).instanceLedger);
}

// Control files follow the write-then-rename convention so the daemon never
// reads a half-written command.
function writeControl(home, command, name = 'cmd') {
  const paths = homePaths(home);
  const tmp = join(paths.control, `${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(command) + '\n');
  renameSync(tmp, join(paths.control, `${name}.json`));
}

/** The reason files the daemon left, as `{name, reason}`. */
function rejectionReasons(home) {
  const dir = homePaths(home).controlRejected;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.reason.txt'))
    .map((f) => ({ name: f, reason: readFileSync(join(dir, f), 'utf8').trim() }));
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

// The seat environment is a fact about the host, so the fixture states the
// host: a runner name nothing on any PATH answers to, and a trust store that
// records no workspace at all.
const FIXTURE_RUNNER = 'olympus-fixture-runner';

function untrustedHost(t, home) {
  const store = join(home, 'host');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, `.${FIXTURE_RUNNER}.json`), JSON.stringify({ projects: {} }) + '\n');
  const key = 'OLYMPUS_FIXTURE_RUNNER_CONFIG_DIR';
  const before = process.env[key];
  process.env[key] = store;
  t.after(() => {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  });
  writeFileSync(
    join(home, 'instance.json'),
    JSON.stringify({
      version: 1,
      claudeCommand: [FIXTURE_RUNNER],
      projects: { alpha: { repoUrl: 'unused' } },
    }) + '\n',
  );
}

test('the seat environment is checked once, and no finding stops the start', async (t) => {
  const home = tempDir();
  mkdirSync(home, { recursive: true });
  untrustedHost(t, home);
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  assert.equal(daemon.running, true);
  const found = instanceEvents(home).filter((e) => e.event === 'seat-environment');
  const started = instanceEvents(home).find((e) => e.event === 'daemon-started');
  assert.ok(found.every((e) => e.seq > started.seq));
  const runner = found.filter((e) => e.check === 'runner-command');
  assert.equal(runner.length, 1);
  assert.equal(runner[0].severity, 'blocking');
  // One per path the seats work in: the workspace root and the project clone.
  const trust = found.filter((e) => e.check === 'runner-trust');
  assert.deepEqual(
    trust.map((e) => e.path).sort(),
    [homePaths(home).worktrees, join(homePaths(home).clones, 'alpha.git')].sort(),
  );
  // Once per instance: nothing the daemon does afterwards asks again.
  const before = found.length;
  writeFileSync(
    homePaths(home).instanceConfig,
    JSON.stringify({
      version: 1,
      logLevel: 'debug',
      claudeCommand: [FIXTURE_RUNNER],
      projects: { alpha: { repoUrl: 'unused' } },
    }) + '\n',
  );
  await waitFor(() => instanceEvents(home).find((e) => e.event === 'config-changed'), {
    label: 'config-changed stamp',
  });
  assert.equal(instanceEvents(home).filter((e) => e.event === 'seat-environment').length, before);
});

test('an instance with no project stamps no seat-environment finding', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  assert.ok(!instanceEvents(home).some((e) => e.event === 'seat-environment'));
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
  assert.deepEqual(
    rejectionReasons(home).map((r) => r.reason),
    ['stale: written while the daemon was down'],
  );
  await daemon.stop();
});

// The stale rule reads "written while the daemon was down", and a start step
// that takes time must not widen that to "written while the daemon was busy
// starting". One orphan-workspace sweep held a start for 28 seconds, and every
// command a console queued in that window was archived as stale.
test('a command queued while the start runs is not stale', async (t) => {
  const home = tempDir();
  scaffoldHome(home);
  writeControl(home, { actor: 'tester', command: 'stop' }, 'while-down');
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  const sweep = daemon.sweepOrphanWorkspaces.bind(daemon);
  daemon.sweepOrphanWorkspaces = async () => {
    await sweep();
    // The console reads a started daemon and queues its command, long before
    // the start has worked through the rest of its steps.
    writeControl(home, { actor: 'tester', command: 'stop' }, 'after-start');
  };
  await daemon.start();
  await waitFor(() => instanceEvents(home).at(-1)?.event === 'daemon-stopped', {
    label: 'daemon stopped by the queued command',
  });
  // The one written first is the only stale one; the one written after the
  // start ran as asked.
  const rejected = rejectionReasons(home);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].name, /while-down\.json/);
  assert.equal(rejected[0].reason, 'stale: written while the daemon was down');
  const done = readdirSync(homePaths(home).controlDone);
  assert.equal(done.length, 1);
  assert.match(done[0], /after-start\.json/);
  const stopped = instanceEvents(home).at(-1);
  assert.equal(stopped.event, 'daemon-stopped');
  assert.equal(stopped.trigger, 'control');
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

// -- workspaces a release could not delete -----------------------------------
// A run workspace is a checked-out application tree, and a hold on one file in
// it refuses the whole removal even after the process sweep has run. The hold
// belongs to another process, so no portable test can stage one: the delete
// call and the process sweep are the seams.

/** A delete nothing will let through. */
function blockedRemove() {
  throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
}

/** Puts a daemon's removals and its process sweep under the test's control. */
function stageRemovals(daemon, { remove } = {}) {
  daemon.isolation.sweepProcesses = async () => ({ count: 0, names: [] });
  if (remove) daemon.isolation.removalIo = { remove, sleep: async () => {}, attempts: 2 };
}

/** A workspace directory with no run behind it. Returns its root. */
function stageWorkspace(home, runId) {
  const root = join(homePaths(home).worktrees, runId);
  mkdirSync(join(root, 'tree'), { recursive: true });
  return root;
}

test('a workspace nothing will delete is recorded quiet, and the daemon runs on', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  stageRemovals(daemon, { remove: blockedRemove });
  const root = stageWorkspace(home, 'r1');
  await daemon.releaseWorkspace('r1', {});

  const released = instanceEvents(home).find((e) => e.event === 'workspace-released');
  assert.equal(released.ok, false);
  assert.equal(released.leftover, root);
  const record = instanceEvents(home).find((e) => e.event === 'workspace-leftover');
  assert.equal(record.runId, 'r1');
  assert.equal(record.path, root);
  assert.match(record.reason, /EBUSY/);
  // The run is over and the record asks the owner for nothing, so it is on no
  // alert strip — and the daemon that could not do the housekeeping runs on.
  assert.deepEqual(openLoud(homePaths(home)), []);
  assert.equal(daemon.running, true);
  // A second release blocked the same way reports the same directory once.
  await daemon.releaseWorkspace('r1', {});
  assert.equal(instanceEvents(home).filter((e) => e.event === 'workspace-leftover').length, 1);
  assert.ok(existsSync(root));
});

test('a start sweeps up a recorded leftover and answers the record', async (t) => {
  const home = tempDir();
  t.after(() => removeDir(home));
  const blocked = new Daemon(home);
  await blocked.start();
  stageRemovals(blocked, { remove: blockedRemove });
  const root = stageWorkspace(home, 'r1');
  await blocked.releaseWorkspace('r1', {});
  const record = instanceEvents(home).find((e) => e.event === 'workspace-leftover');
  await blocked.stop();
  assert.ok(existsSync(root));

  // The next daemon over the same home. The hold belonged to the process that
  // held it and rarely survives the gap between two daemons, so the start
  // sweep is where the harness takes the retry it owes itself.
  const revived = new Daemon(home);
  t.after(async () => revived.stop());
  await revived.start();
  assert.ok(!existsSync(root));
  const events = instanceEvents(home);
  const resolution = events.find((e) => e.event === 'resolved');
  assert.equal(resolution.resolves, record.seq);
  assert.equal(resolution.resolvedEvent, 'workspace-leftover');
  assert.equal(resolution.runId, 'r1');
  assert.equal(openWorkspaceLeftovers(homePaths(home)).size, 0);
  assert.equal(events.filter((e) => e.event === 'workspace-released').at(-1).orphan, true);
});

test('the periodic sweep clears what a release left, and is silent otherwise', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home, { workspaceSweepMs: 20 });
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  stageRemovals(daemon);
  // Ticks over an instance with nothing left behind write nothing at all.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(instanceEvents(home).filter((e) => e.event === 'workspace-released'), []);

  const root = stageWorkspace(home, 'r1');
  const released = await waitFor(
    () => instanceEvents(home).find((e) => e.event === 'workspace-released'),
    { label: 'the periodic sweep to release the workspace' },
  );
  assert.equal(released.runId, 'r1');
  assert.equal(released.ok, true);
  assert.equal(released.orphan, true);
  assert.ok(!existsSync(root));
});

test('a sweep leaves the workspace of a run that is still provisioning', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  stageRemovals(daemon);
  const root = stageWorkspace(home, 'r-launching');
  // The workspace exists before the engine holds the run, and a sweep that
  // read it as an orphan would delete a live checkout under its launch.
  daemon.provisioning.add('r-launching');
  await daemon.sweepOrphanWorkspaces();
  assert.ok(existsSync(root));
  assert.deepEqual(instanceEvents(home).filter((e) => e.event === 'workspace-released'), []);

  daemon.provisioning.delete('r-launching');
  await daemon.sweepOrphanWorkspaces();
  assert.ok(!existsSync(root));
  assert.equal(instanceEvents(home).filter((e) => e.event === 'workspace-released').length, 1);
});
