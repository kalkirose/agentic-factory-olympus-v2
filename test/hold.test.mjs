// The operator hold: the stage chain stops at a boundary, and nothing else
// about a run changes. The engine tests drive a real engine over fixture lanes,
// because what is under test is the transition; the daemon tests drive the
// assembled daemon over the control inbox, because what is under test is the
// command path and what survives a restart. The reading tests drive fixture
// ledgers, because what is under test is a derivation (ADR-0040).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { OperatorHold, INSTANCE_SCOPE, holdState, projectHeld } from '../src/daemon/hold.mjs';
import { RunEngine } from '../src/engine/engine.mjs';
import { deriveRunState } from '../src/engine/replay.mjs';
import { scaffoldHome, runLedgerPath, archivedRunLedgerPath } from '../src/daemon/home.mjs';
import { writeControlCommand } from '../src/daemon/control.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { runDuration } from '../src/ledger/durations.mjs';
import { activeMs, stageDurations } from '../src/tripwires/duration.mjs';
import { openInstanceStore } from '../src/telemetry/stores.mjs';
import { renderStatus } from '../src/console/status.mjs';
import { TripwireWatcher } from '../src/tripwires/watcher.mjs';
import { tempDir, removeDir, waitFor, NO_WAIT } from './helpers.mjs';

const MINUTE = 60000;

// -- the engine transition ---------------------------------------------------

/** An engine whose hold is a set the test writes into mid-run. */
function engineFixture(t, { heartbeatMs } = {}) {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const held = new Set();
  const engine = new RunEngine(paths, {
    getSlotCap: () => 3,
    isHeld: (project) => held.has(project),
    ...(heartbeatMs !== undefined && { heartbeatMs }),
  });
  t.after(async () => {
    await engine.stop();
    removeDir(home);
  });
  return { paths, engine, held };
}

/** A run's ledger, live or archived: a closed run has moved by the time a
 * release's last assertion reads it. */
function events(paths, runId = 'r1') {
  const live = readEvents(runLedgerPath(paths, runId));
  return live.length > 0 ? live : readEvents(archivedRunLedgerPath(paths, runId));
}

function names(paths, runId = 'r1') {
  return events(paths, runId).map((e) => e.event);
}

test('a hold stops the chain at the next boundary and interrupts nothing', async (t) => {
  const { paths, engine, held } = engineFixture(t);
  const ran = [];
  engine.registerLane('story', {
    stages: ['work', 'ship'],
    handlers: {
      work: async () => {
        ran.push('work');
        // The hold lands while the stage is running: it takes the boundary
        // behind this handler, never the handler itself.
        held.add('proj');
        return { next: 'ship' };
      },
      ship: () => {
        ran.push('ship');
        return { close: { state: 'shipped' } };
      },
    },
  });
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => events(paths).some((e) => e.event === 'stage-held'), { label: 'held' });

  assert.deepEqual(ran, ['work'], 'the deferred stage ran');
  const stamp = events(paths).find((e) => e.event === 'stage-held');
  assert.equal(stamp.stage, 'work');
  assert.equal(stamp.next, 'ship');
  assert.deepEqual(names(paths), ['run-launched', 'stage-entered', 'stage-held']);
  // The slot stays taken: a hold is operational, and a freed slot would invite
  // a launch that oversubscribes the project at the release.
  assert.equal(engine.activeCount('proj'), 1);
  // And the run is not inert: an operator hold is a state of the invariant.
  assert.deepEqual(engine.checkLiveness(), []);
  assert.ok(!events(paths).some((e) => e.event === 'liveness-violation'));
});

test('a release enters the deferred stage exactly once', async (t) => {
  const { paths, engine, held } = engineFixture(t);
  const ran = [];
  held.add('proj');
  engine.registerLane('story', {
    stages: ['work', 'ship'],
    handlers: {
      work: () => {
        ran.push('work');
        return { next: 'ship' };
      },
      ship: () => {
        ran.push('ship');
        return { close: { state: 'shipped' } };
      },
    },
  });
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => events(paths).some((e) => e.event === 'stage-held'), { label: 'held' });

  // A release that frees nothing enters nothing: the run's project is held.
  assert.deepEqual(engine.releaseHeldRuns(), []);
  assert.deepEqual(ran, ['work']);

  held.delete('proj');
  assert.deepEqual(engine.releaseHeldRuns(), ['r1']);
  // A second release has nothing left to enter.
  assert.deepEqual(engine.releaseHeldRuns(), []);
  await waitFor(() => ran.includes('ship'), { label: 'the deferred stage ran' });
  assert.deepEqual(ran, ['work', 'ship']);
  const after = events(paths);
  assert.equal(after.filter((e) => e.event === 'stage-released').length, 1);
  assert.equal(after.filter((e) => e.event === 'stage-entered' && e.stage === 'ship').length, 1);
  const released = after.find((e) => e.event === 'stage-released');
  assert.equal(released.stage, 'work');
  assert.equal(released.next, 'ship');
});

test('a run that parks while held records its answer and enters at the release', async (t) => {
  const { paths, engine, held } = engineFixture(t);
  let visits = 0;
  engine.registerLane('story', {
    stages: ['decide'],
    handlers: {
      decide: (ctx) => {
        visits += 1;
        if (ctx.lastAnswer) return { close: { state: 'shipped' } };
        held.add('proj');
        return {
          park: { type: 'open-decisions', question: 'Which scope?', options: ['narrow', 'wide'] },
        };
      },
    },
  });
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => events(paths).some((e) => e.event === 'park'), { label: 'parked' });

  // The park is a park: the human is answered exactly as it would be with no
  // hold standing, and the answer is recorded the moment it is given.
  engine.answer({ runId: 'r1', actor: 'operator', option: 'narrow' });
  const held1 = events(paths).find((e) => e.event === 'stage-held');
  assert.deepEqual(names(paths), [
    'run-launched',
    'stage-entered',
    'park',
    'answer',
    'resume',
    'stage-held',
  ]);
  assert.equal(held1.stage, 'decide');
  assert.equal(held1.next, 'decide');
  assert.equal(held1.resumed, true);
  assert.equal(visits, 1, 'the parked stage ran again under the hold');

  held.delete('proj');
  assert.deepEqual(engine.releaseHeldRuns(), ['r1']);
  await waitFor(() => visits === 2, { label: 'the resumed stage ran' });
  // The resumed stage re-executes; it does not re-enter, so the visit the
  // ledger records is still the one the answer restarted.
  assert.equal(events(paths).filter((e) => e.event === 'stage-entered').length, 1);
});

test('the stage beat over a held run says it is quiet on purpose', async (t) => {
  const { paths, engine, held } = engineFixture(t, { heartbeatMs: 20 });
  held.add('proj');
  engine.registerLane('story', {
    stages: ['work', 'ship'],
    handlers: { work: () => ({ next: 'ship' }), ship: () => ({ close: { state: 'shipped' } }) },
  });
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  const beat = await waitFor(
    () => events(paths).find((e) => e.event === 'stage-heartbeat' && e.waitingOn === 'hold'),
    { label: 'a hold heartbeat' },
  );
  assert.equal(beat.stage, 'work');
  assert.deepEqual(beat.detail, { next: 'ship' });
});

test('a held run comes back held from its own ledger', async (t) => {
  const home = tempDir();
  const paths = scaffoldHome(home);
  t.after(() => removeDir(home));
  const held = new Set(['proj']);
  const ran = [];
  const lane = {
    stages: ['work', 'ship'],
    handlers: {
      work: () => {
        ran.push('work');
        return { next: 'ship' };
      },
      ship: () => {
        ran.push('ship');
        return { close: { state: 'shipped' } };
      },
    },
  };
  const first = new RunEngine(paths, { getSlotCap: () => 3, isHeld: (p) => held.has(p) });
  first.registerLane('story', lane);
  first.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => events(paths).some((e) => e.event === 'stage-held'), { label: 'held' });
  await first.stop();

  const state = deriveRunState(events(paths));
  assert.equal(state.held, true);
  assert.equal(state.deferred, 'ship');

  const second = new RunEngine(paths, { getSlotCap: () => 3, isHeld: (p) => held.has(p) });
  t.after(async () => {
    await second.stop();
  });
  second.registerLane('story', lane);
  assert.deepEqual(second.resumeOpenRuns(), ['r1']);
  // The stage that completed is not run again, and the stage behind the
  // boundary still waits: the restart lost no work and crossed nothing.
  assert.deepEqual(ran, ['work']);
  assert.deepEqual(names(paths), ['run-launched', 'stage-entered', 'stage-held']);
  assert.equal(second.activeCount('proj'), 1);
  assert.deepEqual(second.checkLiveness(), []);

  held.delete('proj');
  assert.deepEqual(second.releaseHeldRuns(), ['r1']);
  await waitFor(() => ran.includes('ship'), { label: 'the deferred stage ran after the restart' });
});

test('a run the start finds held holds where it stands, and runs at the release', async (t) => {
  // The stop caught this run inside a stage, so it recorded no boundary: what
  // the next start finds is a run standing in the middle of the stage it must
  // run again. A hold governs that entry as it governs every other one, or the
  // restart is the one boundary an operator hold does not cover (ADR-0070).
  const home = tempDir();
  const paths = scaffoldHome(home);
  t.after(() => removeDir(home));
  const held = new Set();
  const ran = [];
  const lane = {
    stages: ['work', 'ship'],
    handlers: {
      work: () => {
        ran.push('work');
        // The first instance never gets an answer out of this stage: it is
        // still running when the daemon goes.
        if (ran.length === 1) return new Promise(() => {});
        return { next: 'ship' };
      },
      ship: () => {
        ran.push('ship');
        return { close: { state: 'shipped' } };
      },
    },
  };
  const first = new RunEngine(paths, { getSlotCap: () => 3, isHeld: (p) => held.has(p) });
  first.registerLane('story', lane);
  first.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => ran.length === 1, { label: 'the stage in flight' });
  await first.stop();
  assert.deepEqual(names(paths), ['run-launched', 'stage-entered']);

  held.add('proj');
  const second = new RunEngine(paths, { getSlotCap: () => 3, isHeld: (p) => held.has(p) });
  t.after(async () => {
    await second.stop();
  });
  second.registerLane('story', lane);
  assert.deepEqual(second.resumeOpenRuns(), ['r1']);
  // Nothing ran, and the hold is on the record with the stage it stopped: the
  // run is standing at its own stage, not at the boundary behind it.
  assert.deepEqual(ran, ['work']);
  const stamp = events(paths).find((e) => e.event === 'stage-held');
  assert.equal(stamp.stage, 'work');
  assert.equal(stamp.next, 'work');
  assert.equal(stamp.resumed, true);
  assert.deepEqual(names(paths), ['run-launched', 'stage-entered', 'stage-held']);
  assert.deepEqual(second.checkLiveness(), []);

  held.delete('proj');
  assert.deepEqual(second.releaseHeldRuns(), ['r1']);
  // The release runs the stage the hold stopped, and it enters nothing twice:
  // the run was already standing in `work`, so the release re-executes it and
  // stamps no second entry.
  await waitFor(() => ran.includes('ship'), { label: 'the held stage ran at the release' });
  assert.deepEqual(ran, ['work', 'work', 'ship']);
  const after = events(paths);
  assert.equal(after.filter((e) => e.event === 'stage-entered' && e.stage === 'work').length, 1);
  assert.equal(after.filter((e) => e.event === 'stage-released').length, 1);
});

test('a killed hold closes the run it was holding', async (t) => {
  const { paths, engine, held } = engineFixture(t);
  held.add('proj');
  engine.registerLane('story', {
    stages: ['work', 'ship'],
    handlers: { work: () => ({ next: 'ship' }), ship: () => ({ close: { state: 'shipped' } }) },
  });
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => events(paths).some((e) => e.event === 'stage-held'), { label: 'held' });
  engine.killRun('r1', { actor: 'operator' });
  assert.equal(engine.runs.has('r1'), false);
});

// -- the hold state ----------------------------------------------------------

function holdFixture(t, projects = { alpha: {}, beta: {} }) {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const ledger = openInstanceStore(paths);
  t.after(() => {
    ledger.close();
    removeDir(home);
  });
  const daemon = { paths, ledger, config: { projects } };
  return { paths, ledger, hold: new OperatorHold(daemon) };
}

test('a hold names one project or the instance, and only a transition stamps', (t) => {
  const { paths, hold } = holdFixture(t);
  assert.throws(() => hold.set({ project: 'alpha' }, true, ''), /actor/);
  assert.throws(() => hold.set({}, true, 'human'), /--project.*--all/);
  assert.throws(() => hold.set({ project: 'alpha', all: true }, true, 'human'), /never two of them/);
  assert.throws(() => hold.set({ project: 'nope' }, true, 'human'), /unknown project: nope/);
  assert.throws(() => hold.set({ project: INSTANCE_SCOPE }, true, 'human'), /hold it with --all/);

  assert.equal(hold.set({ project: 'alpha' }, true, 'human'), true);
  assert.equal(hold.set({ project: 'alpha' }, true, 'human'), false);
  assert.equal(hold.isHeld('alpha'), true);
  assert.equal(hold.isHeld('beta'), false);
  assert.equal(
    readEvents(paths.instanceLedger).filter((e) => e.event === 'hold-changed').length,
    1,
  );
});

test('the instance hold and a project hold are separate statements', (t) => {
  const { paths, hold } = holdFixture(t);
  hold.set({ all: true }, true, 'human');
  hold.set({ project: 'alpha' }, true, 'human');
  assert.equal(hold.isHeld('beta'), true);

  // A release ends the one it names. Alpha's own hold is still alpha's.
  hold.set({ all: true }, false, 'human');
  assert.equal(hold.isHeld('beta'), false);
  assert.equal(hold.isHeld('alpha'), true);

  const folded = holdState(readEvents(paths.instanceLedger));
  assert.equal(folded.get(INSTANCE_SCOPE), false);
  assert.equal(projectHeld(folded, 'alpha'), true);
  assert.equal(projectHeld(folded, 'beta'), false);
});

test('a hold state is folded back from the ledger', (t) => {
  const { hold } = holdFixture(t);
  hold.set({ project: 'alpha' }, true, 'human');
  hold.scopes.clear();
  hold.replay();
  assert.equal(hold.isHeld('alpha'), true);
});

// -- the assembled daemon ----------------------------------------------------

function daemonHome(t, { slotCap } = {}) {
  const home = tempDir();
  const paths = scaffoldHome(home);
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({
      version: 1,
      projects: { proj: { repoUrl: 'file:///fixture', ...(slotCap !== undefined && { slotCap }) } },
    }) + '\n',
  );
  t.after(() => removeDir(home));
  return { home, paths };
}

/** Queues one console command and waits for the daemon to claim it. */
async function command(paths, fields, settled) {
  writeControlCommand(paths, fields);
  await waitFor(settled, { label: `the daemon to apply ${fields.command}` });
}

function heldChanges(paths) {
  return readEvents(paths.instanceLedger).filter((e) => e.event === 'hold-changed');
}

test('the console holds a project, and the daemon stops at the boundary', async (t) => {
  const { home, paths } = daemonHome(t);
  const ran = [];
  const lanes = {
    story: {
      stages: ['build', 'ship'],
      handlers: {
        // A real child, so the stop that follows has something to lose: the
        // seat runs to its own end inside the stage, and the hold takes the
        // boundary behind it.
        build: async (ctx) => {
          ran.push('build');
          await ctx.supervise({ seat: 'dev', cmd: process.execPath, args: ['-e', ''] });
          return { next: 'ship' };
        },
        ship: () => {
          ran.push('ship');
          return { close: { state: 'shipped' } };
        },
      },
    },
  };
  const first = new Daemon(home, { waitSleep: NO_WAIT, lanes });
  await first.start();
  await command(paths, { command: 'hold', actor: 'operator', project: 'proj' }, () =>
    first.hold.isHeld('proj'),
  );
  assert.equal(heldChanges(paths).length, 1);
  assert.equal(heldChanges(paths)[0].project, 'proj');
  assert.equal(heldChanges(paths)[0].held, true);

  first.engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => events(paths).some((e) => e.event === 'stage-held'), { label: 'held' });
  assert.deepEqual(ran, ['build']);

  // The console reads the hold off the ledgers alone.
  const status = renderStatus(paths);
  assert.match(status, /runs 0 active \/ 0 parked \/ 1 held/);
  assert.match(status, /r1 story @ build .*\[held:ship\]/);
  assert.match(status, /proj: paused, held, slot cap/);

  // The stop the hold was taken for: no seat is in flight, so none is ended.
  await first.stop();
  const afterStop = events(paths);
  assert.ok(!afterStop.some((e) => e.event === 'seat-terminated'), 'a seat was cut off');
  assert.ok(!afterStop.some((e) => e.event === 'seat-failure'), 'a seat failed at the stop');
  assert.equal(afterStop.at(-1).event, 'stage-held');

  const second = new Daemon(home, { waitSleep: NO_WAIT, lanes });
  t.after(async () => {
    await second.stop();
  });
  const { runsResumed } = await second.start();
  assert.deepEqual(runsResumed, ['r1']);
  assert.equal(second.hold.isHeld('proj'), true);
  // The hold survived the restart, and the stage that ran did not run twice.
  assert.deepEqual(ran, ['build']);
  assert.deepEqual(names(paths), ['run-launched', 'stage-entered', 'seat-spawned', 'stage-held']);

  await command(paths, { command: 'release', actor: 'operator', project: 'proj' }, () =>
    events(paths).some((e) => e.event === 'stage-released'),
  );
  await waitFor(() => ran.includes('ship'), { label: 'the deferred stage ran after the release' });
  assert.equal(second.hold.isHeld('proj'), false);
  assert.equal(heldChanges(paths).length, 2);
});

test('a hold over the instance holds every project, and the release frees them', async (t) => {
  const { home, paths } = daemonHome(t);
  const ran = [];
  const lanes = {
    story: {
      stages: ['build', 'ship'],
      handlers: {
        build: () => {
          ran.push('build');
          return { next: 'ship' };
        },
        ship: () => {
          ran.push('ship');
          return { close: { state: 'shipped' } };
        },
      },
    },
  };
  const daemon = new Daemon(home, { waitSleep: NO_WAIT, lanes });
  t.after(async () => {
    await daemon.stop();
  });
  await daemon.start();
  await command(paths, { command: 'hold', actor: 'operator', all: true }, () =>
    daemon.hold.isHeld('proj'),
  );
  assert.equal(heldChanges(paths)[0].all, true);
  assert.equal(heldChanges(paths)[0].project, undefined);

  daemon.engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => events(paths).some((e) => e.event === 'stage-held'), { label: 'held' });
  assert.deepEqual(ran, ['build']);

  await command(paths, { command: 'release', actor: 'operator', all: true }, () =>
    events(paths).some((e) => e.event === 'stage-released'),
  );
  await waitFor(() => events(paths).some((e) => e.event === 'run-closed'), { label: 'closed' });
  assert.deepEqual(ran, ['build', 'ship']);
});

test('a hold command the daemon refuses leaves a reason for the console', async (t) => {
  const { home, paths } = daemonHome(t);
  const daemon = new Daemon(home, { waitSleep: NO_WAIT, lanes: {} });
  t.after(async () => {
    await daemon.stop();
  });
  await daemon.start();
  writeControlCommand(paths, { command: 'hold', actor: 'operator', project: 'ghost' });
  const reason = await waitFor(() => rejectedReasons(paths).find((text) => text.includes('ghost')), {
    label: 'the refusal',
  });
  assert.match(reason, /unknown project: ghost/);
  assert.equal(heldChanges(paths).length, 0);
});

function rejectedReasons(paths) {
  return readdirSync(paths.controlRejected)
    .filter((name) => name.endsWith('.reason.txt'))
    .map((name) => readFileSync(join(paths.controlRejected, name), 'utf8'));
}

// -- one run at a time -------------------------------------------------------
// A hold over one run is the third scope. What is under test here is that it
// settles at the same boundary, that the three scopes resolve in one direction
// only, and that a run's own hold outlives the process that took it (ADR-0057).

/** A two-stage lane whose first stage waits for the test to let it finish. */
function gatedLane(ran) {
  const gate = { release: null };
  const lane = {
    stages: ['work', 'ship'],
    handlers: {
      work: async () => {
        ran.push('work');
        await new Promise((resolve) => {
          gate.release = resolve;
        });
        return { next: 'ship' };
      },
      ship: () => {
        ran.push('ship');
        return { close: { state: 'shipped' } };
      },
    },
  };
  return { gate, lane };
}

/** An operator hold over a real engine: the pair a per-run hold needs. */
function runHoldFixture(t, projects = { proj: {} }) {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const ledger = openInstanceStore(paths);
  const engine = new RunEngine(paths, {
    getSlotCap: () => 3,
    isHeld: (project) => hold.isHeld(project),
  });
  const hold = new OperatorHold({ paths, ledger, config: { projects }, engine });
  t.after(async () => {
    await engine.stop();
    ledger.close();
    removeDir(home);
  });
  return { paths, engine, hold };
}

function runHoldStamps(paths, runId) {
  return events(paths, runId).filter((e) => e.event === 'run-hold-changed');
}

test('a hold over one run names that run and no other scope', (t) => {
  const { engine, hold } = runHoldFixture(t);
  engine.registerLane('story', {
    stages: ['work'],
    handlers: { work: () => ({ park: { type: 'open-decisions', question: 'q', options: ['a'] } }) },
  });
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });

  assert.throws(() => hold.set({ runId: 'r1' }, true, ''), /actor/);
  assert.throws(
    () => hold.set({ runId: 'r1', project: 'proj' }, true, 'human'),
    /never two of them/,
  );
  assert.throws(() => hold.set({ runId: 'r1', all: true }, true, 'human'), /never two of them/);
  assert.throws(() => hold.set({ runId: '' }, true, 'human'), /--run <id>/);
  assert.throws(() => hold.set({ runId: 'ghost' }, true, 'human'), /unknown open run: ghost/);

  // Only a transition stamps, here as everywhere.
  assert.equal(hold.set({ runId: 'r1' }, true, 'human'), true);
  assert.equal(hold.set({ runId: 'r1' }, true, 'human'), false);
  assert.equal(hold.set({ runId: 'r1' }, false, 'human'), true);
});

test('a hold over one run settles at the boundary and leaves its neighbour alone', async (t) => {
  const { paths, engine, hold } = runHoldFixture(t);
  const ran = [];
  const { gate, lane } = gatedLane(ran);
  engine.registerLane('story', lane);
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => gate.release !== null, { label: 'the first stage to be running' });

  // The hold lands while the stage is running: it takes the boundary behind
  // this handler, exactly as a project hold does, and it interrupts nothing.
  hold.set({ runId: 'r1' }, true, 'human');
  gate.release();
  await waitFor(() => events(paths, 'r1').some((e) => e.event === 'stage-held'), { label: 'held' });
  assert.deepEqual(ran, ['work']);
  assert.deepEqual(names(paths, 'r1'), [
    'run-launched',
    'stage-entered',
    'run-hold-changed',
    'stage-held',
  ]);
  const stamp = runHoldStamps(paths, 'r1')[0];
  assert.equal(stamp.held, true);
  assert.equal(stamp.actor, 'human');
  // A held run is not inert, and it keeps its slot: a per-run hold is the same
  // operational statement a project hold is.
  assert.equal(engine.activeCount('proj'), 1);
  assert.deepEqual(engine.checkLiveness(), []);
  // And the project is untouched, so nothing else of the project is held.
  assert.equal(hold.isHeld('proj'), false);

  hold.set({ runId: 'r1' }, false, 'human');
  assert.deepEqual(engine.releaseHeldRuns(), ['r1']);
  await waitFor(() => ran.includes('ship'), { label: 'the deferred stage ran' });
  assert.equal(events(paths, 'r1').filter((e) => e.event === 'stage-released').length, 1);
});

test('two runs held one at a time release one at a time, in either order', async (t) => {
  for (const first of ['r1', 'r2']) {
    const { paths, engine, hold } = runHoldFixture(t);
    const ran = { r1: [], r2: [] };
    const second = first === 'r1' ? 'r2' : 'r1';
    engine.registerLane('story', {
      stages: ['work', 'ship'],
      handlers: {
        work: (ctx) => {
          ran[ctx.runId].push('work');
          return { next: 'ship' };
        },
        ship: (ctx) => {
          ran[ctx.runId].push('ship');
          return { close: { state: 'shipped' } };
        },
      },
    });
    // Both runs launch into a project hold, so both stop at the same boundary
    // without a race, and each then takes a hold of its own.
    hold.set({ project: 'proj' }, true, 'human');
    engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
    engine.launch({ runId: 'r2', project: 'proj', lane: 'story' });
    await waitFor(
      () => ['r1', 'r2'].every((id) => events(paths, id).some((e) => e.event === 'stage-held')),
      { label: 'both runs to hold' },
    );
    hold.set({ runId: 'r1' }, true, 'human');
    hold.set({ runId: 'r2' }, true, 'human');

    // The project release lifts the project's hold and nothing else: neither
    // run moves, because each is still held in its own right.
    hold.set({ project: 'proj' }, false, 'human');
    assert.deepEqual(engine.releaseHeldRuns(), []);
    assert.deepEqual(ran, { r1: ['work'], r2: ['work'] });

    hold.set({ runId: first }, false, 'human');
    assert.deepEqual(engine.releaseHeldRuns(), [first]);
    await waitFor(() => ran[first].includes('ship'), { label: `${first} to enter its next stage` });
    assert.deepEqual(ran[second], ['work'], `${second} moved on ${first}'s release`);

    hold.set({ runId: second }, false, 'human');
    assert.deepEqual(engine.releaseHeldRuns(), [second]);
    await waitFor(() => ran[second].includes('ship'), { label: `${second} to enter its next stage` });
  }
});

test('a per-run release under a wider hold is refused and names it', (t) => {
  const { paths, engine, hold } = runHoldFixture(t);
  engine.registerLane('story', {
    stages: ['work'],
    handlers: { work: () => ({ park: { type: 'open-decisions', question: 'q', options: ['a'] } }) },
  });
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });

  // A hold is never refused. A wide hold is a reason for a run to stand still;
  // it is no reason to refuse a narrower statement that it stands still too.
  hold.set({ project: 'proj' }, true, 'human');
  assert.equal(hold.set({ runId: 'r1' }, true, 'human'), true);

  assert.throws(
    () => hold.set({ runId: 'r1' }, false, 'human'),
    /run r1 is held by the proj project hold; release --project proj before this run/,
  );
  hold.set({ all: true }, true, 'human');
  assert.throws(
    () => hold.set({ runId: 'r1' }, false, 'human'),
    /run r1 is held by the instance hold; release --all before this run/,
  );
  // The refusals stamped nothing and changed nothing.
  assert.equal(runHoldStamps(paths, 'r1').length, 1);
  assert.notEqual(engine.runs.get('r1').ownHold, null);

  // With the wider scopes lifted the same release lands.
  hold.set({ all: true }, false, 'human');
  hold.set({ project: 'proj' }, false, 'human');
  assert.equal(hold.set({ runId: 'r1' }, false, 'human'), true);
});

test("a run's own hold comes back from its own ledger", async (t) => {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const ledger = openInstanceStore(paths);
  t.after(() => {
    ledger.close();
    removeDir(home);
  });
  const ran = [];
  const { gate, lane } = gatedLane(ran);
  const config = { projects: { proj: {} } };

  const first = new RunEngine(paths, { getSlotCap: () => 3, isHeld: (p) => firstHold.isHeld(p) });
  const firstHold = new OperatorHold({ paths, ledger, config, engine: first });
  first.registerLane('story', lane);
  first.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => gate.release !== null, { label: 'the first stage to be running' });
  firstHold.set({ runId: 'r1' }, true, 'human');
  gate.release();
  await waitFor(() => events(paths, 'r1').some((e) => e.event === 'stage-held'), { label: 'held' });
  await first.stop();

  const state = deriveRunState(events(paths, 'r1'));
  assert.equal(state.held, true);
  assert.equal(state.ownHold.actor, 'human');
  assert.equal(typeof state.ownHold.ts, 'string');

  const second = new RunEngine(paths, { getSlotCap: () => 3, isHeld: (p) => secondHold.isHeld(p) });
  const secondHold = new OperatorHold({ paths, ledger, config, engine: second });
  t.after(async () => {
    await second.stop();
  });
  second.registerLane('story', lane);
  assert.deepEqual(second.resumeOpenRuns(), ['r1']);
  // The restart lost no work and crossed nothing, and the hold is still the
  // run's own: a project release would not lift it now either.
  assert.deepEqual(ran, ['work']);
  assert.deepEqual(second.releaseHeldRuns(), []);
  secondHold.set({ project: 'proj' }, false, 'human');
  assert.deepEqual(second.releaseHeldRuns(), []);

  secondHold.set({ runId: 'r1' }, false, 'human');
  assert.deepEqual(second.releaseHeldRuns(), ['r1']);
  await waitFor(() => ran.includes('ship'), { label: 'the deferred stage ran after the restart' });
});

test('a ledger written before per-run holds existed reads as a run with none', () => {
  const state = deriveRunState([
    { seq: 1, ts: '2026-08-26T00:00:00.000Z', event: 'run-launched', project: 'proj', lane: 'story' },
    { seq: 2, ts: '2026-08-26T00:00:00.000Z', event: 'stage-entered', stage: 'work' },
    { seq: 3, ts: '2026-08-26T00:10:00.000Z', event: 'stage-held', stage: 'work', next: 'ship' },
  ]);
  assert.equal(state.held, true);
  assert.equal(state.ownHold, null);
});

test('the console holds one run, and status says who held it and when', async (t) => {
  const { home, paths } = daemonHome(t, { slotCap: 2 });
  const ran = { r1: [], r2: [] };
  const lanes = {
    story: {
      stages: ['build', 'ship'],
      handlers: {
        build: (ctx) => {
          ran[ctx.runId].push('build');
          return { next: 'ship' };
        },
        ship: (ctx) => {
          ran[ctx.runId].push('ship');
          return { close: { state: 'shipped' } };
        },
      },
    },
  };
  const first = new Daemon(home, { waitSleep: NO_WAIT, lanes });
  await first.start();
  await command(paths, { command: 'hold', actor: 'operator', project: 'proj' }, () =>
    first.hold.isHeld('proj'),
  );
  first.engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  first.engine.launch({ runId: 'r2', project: 'proj', lane: 'story' });
  await waitFor(
    () => ['r1', 'r2'].every((id) => events(paths, id).some((e) => e.event === 'stage-held')),
    { label: 'both runs to hold' },
  );

  await command(paths, { command: 'hold', actor: 'console:ana', runId: 'r1' }, () =>
    runHoldStamps(paths, 'r1').length === 1,
  );
  const stamp = runHoldStamps(paths, 'r1')[0];
  assert.equal(stamp.held, true);
  assert.equal(stamp.actor, 'console:ana');
  // A run held by hand names the hand and the hour; a run the project stopped
  // reads exactly as it did before.
  const status = renderStatus(paths);
  assert.match(status, new RegExp(`r1 story @ build .*\\[held:ship by console:ana at ${stamp.ts}\\]`));
  assert.match(status, /r2 story @ build .*\[held:ship\]/);

  // Lifting the project hold frees the run the project held, and leaves the
  // one an operator stopped by name exactly where it is.
  await command(paths, { command: 'release', actor: 'operator', project: 'proj' }, () =>
    events(paths, 'r2').some((e) => e.event === 'stage-released'),
  );
  await waitFor(() => ran.r2.includes('ship'), { label: 'r2 to enter its deferred stage' });
  assert.deepEqual(ran.r1, ['build']);

  // The restart the hold outlives.
  await first.stop();
  const second = new Daemon(home, { waitSleep: NO_WAIT, lanes });
  t.after(async () => {
    await second.stop();
  });
  await second.start();
  assert.deepEqual(ran.r1, ['build']);
  assert.match(renderStatus(paths), /r1 story @ build .*\[held:ship by console:ana/);

  await command(paths, { command: 'release', actor: 'console:ana', runId: 'r1' }, () =>
    events(paths, 'r1').some((e) => e.event === 'stage-released'),
  );
  await waitFor(() => ran.r1.includes('ship'), { label: 'r1 to enter its deferred stage' });
  assert.equal(runHoldStamps(paths, 'r1').length, 2);
});

test('the daemon refuses a per-run release under a project hold', async (t) => {
  const { home, paths } = daemonHome(t);
  const ran = [];
  const lanes = {
    story: {
      stages: ['build', 'ship'],
      handlers: {
        build: () => {
          ran.push('build');
          return { next: 'ship' };
        },
        ship: () => ({ close: { state: 'shipped' } }),
      },
    },
  };
  const daemon = new Daemon(home, { waitSleep: NO_WAIT, lanes });
  t.after(async () => {
    await daemon.stop();
  });
  await daemon.start();
  await command(paths, { command: 'hold', actor: 'operator', project: 'proj' }, () =>
    daemon.hold.isHeld('proj'),
  );
  daemon.engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => events(paths, 'r1').some((e) => e.event === 'stage-held'), { label: 'held' });

  writeControlCommand(paths, { command: 'release', actor: 'operator', runId: 'r1' });
  const reason = await waitFor(() => rejectedReasons(paths).find((text) => text.includes('r1')), {
    label: 'the refusal',
  });
  assert.match(reason, /release --project proj before this run/);
  assert.deepEqual(ran, ['build']);
  assert.deepEqual(runHoldStamps(paths, 'r1'), []);
});

// -- what a hold is worth in a reading ---------------------------------------

function writeLedger(path, lines) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('held time is waiting, not work', () => {
  const t0 = Date.parse('2026-08-26T00:00:00.000Z');
  const at = (minutes) => new Date(t0 + minutes * MINUTE).toISOString();
  const ledger = [
    { seq: 1, ts: at(0), event: 'run-launched', project: 'alpha', lane: 'story' },
    { seq: 2, ts: at(0), event: 'stage-entered', stage: 'verdict' },
    { seq: 3, ts: at(10), event: 'stage-held', stage: 'verdict', next: 'update' },
    { seq: 4, ts: at(130), event: 'stage-released', stage: 'verdict', next: 'update' },
    { seq: 5, ts: at(130), event: 'stage-entered', stage: 'update' },
    { seq: 6, ts: at(140), event: 'run-closed', state: 'shipped' },
  ];
  // The run's own numbers: two hours of the wall belong to the operator.
  const d = runDuration(ledger);
  assert.equal(d.wallMs, 140 * MINUTE);
  assert.equal(d.waitedMs, 120 * MINUTE);
  assert.equal(d.activeMs, 20 * MINUTE);
  // And the band's: the visit that stood through the hold is a ten-minute
  // visit, so a hold can never teach a band that a stage takes hours.
  assert.deepEqual(stageDurations(ledger, 'verdict'), [10 * MINUTE]);
  assert.equal(activeMs(ledger, at(0), at(130)), 10 * MINUTE);
});

test('the overrun tripwire stays quiet across a hold', (t) => {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const ledger = openInstanceStore(paths);
  t.after(() => {
    ledger.close();
    removeDir(home);
  });
  const t0 = Date.parse('2026-08-26T00:00:00.000Z');
  const at = (minutes) => new Date(t0 + minutes * MINUTE).toISOString();
  // Five completed one-minute visits of the same stage in other runs: the band
  // exists, and it is tight.
  for (let i = 0; i < 5; i++) {
    writeLedger(runLedgerPath(paths, `history-${i}`), [
      { seq: 1, ts: at(0), event: 'run-launched', actor: 'daemon', project: 'alpha', lane: 'story' },
      { seq: 2, ts: at(0), event: 'stage-entered', actor: 'daemon', stage: 'verdict' },
      { seq: 3, ts: at(1), event: 'stage-entered', actor: 'daemon', stage: 'update' },
      { seq: 4, ts: at(1), event: 'run-closed', actor: 'daemon', state: 'shipped' },
    ]);
  }
  // The run under the hold: two hours standing at the boundary, half a minute
  // of work behind it. Wall clock alone puts it thirty times outside the band.
  const beat = {
    seq: 4,
    ts: at(130),
    event: 'stage-heartbeat',
    actor: 'daemon',
    stage: 'verdict',
    waitingOn: 'hold',
    beats: 24,
    elapsed: 130 * MINUTE,
  };
  writeLedger(runLedgerPath(paths, 'r1'), [
    { seq: 1, ts: at(0), event: 'run-launched', actor: 'daemon', project: 'alpha', lane: 'story' },
    { seq: 2, ts: at(0), event: 'stage-entered', actor: 'daemon', stage: 'verdict' },
    { seq: 3, ts: at(0.5), event: 'stage-held', actor: 'daemon', stage: 'verdict', next: 'update' },
    beat,
  ]);

  const watcher = new TripwireWatcher({ paths, ledger, readRegistry: async () => [] });
  watcher.checkStageDuration('alpha', 'r1', beat);
  assert.deepEqual(
    readEvents(paths.instanceLedger).filter((e) => e.event === 'stage-overrun'),
    [],
  );
});
