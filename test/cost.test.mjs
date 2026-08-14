import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCost } from '../src/ledger/cost.mjs';
import { RunEngine } from '../src/engine/engine.mjs';
import { scaffoldHome, runLedgerPath, archivedRunLedgerPath } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { openLoud } from '../src/telemetry/readers.mjs';
import { validateProjectConfig } from '../src/config/project.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

// -- the canonical cost helper ------------------------------------------------

let seq = 0;
const line = (event, fields) => ({ seq: ++seq, ts: '2026-08-14T00:00:00.000Z', event, ...fields });
const spawned = (seat) => line('seat-spawned', { actor: 'daemon', seat });
const progress = (seat, cost) => line('seat-progress', { actor: seat, cost });

// One fixture ledger carrying all three shapes at once: a seat that reported,
// a seat that failed carrying its figure, and a seat that ended with nothing
// but its snapshots. A naive sum over every `cost` field reads $23.50 here.
const LEDGER = [
  line('run-launched', { actor: 'daemon', project: 'alpha', lane: 'story' }),
  // shape 1: the report repeats the last snapshot.
  spawned('dev'),
  progress('dev', 2),
  progress('dev', 5),
  line('seat-report', { actor: 'dev', seat: 'dev', cost: 5 }),
  // shape 2: the failure carries its own figure.
  spawned('fury-spec'),
  progress('fury-spec', 1.5),
  line('seat-failure', { actor: 'daemon', seat: 'fury-spec', reason: 'exit', cost: 3 }),
  // shape 3: no terminal stamp at all — the snapshot is the whole record.
  spawned('minos'),
  progress('minos', 4),
  progress('minos', 6.5),
];

test('a terminal stamp supersedes the snapshots of its own invocation', () => {
  assert.equal(runCost(LEDGER.slice(0, 5)), 5);
});

test('a failure that carries a figure is the figure the invocation cost', () => {
  assert.equal(runCost(LEDGER.slice(5, 8)), 3);
});

test('an invocation with no terminal stamp contributes its last snapshot', () => {
  assert.equal(runCost(LEDGER.slice(8)), 6.5);
});

test('the three shapes combine without counting a dollar twice', () => {
  assert.equal(runCost(LEDGER), 14.5);
});

test('a corrective re-prompt is two invocations of one seat, counted once each', () => {
  // Attempt 1 exits 0 with an invalid report: no terminal stamp, and the next
  // spawn is what closes it. Attempt 2 reports.
  const events = [
    spawned('daedalus'),
    progress('daedalus', 3),
    spawned('daedalus'),
    progress('daedalus', 1),
    line('seat-report', { actor: 'daedalus', seat: 'daedalus', cost: 1.25 }),
  ];
  assert.equal(runCost(events), 4.25);
});

test('a terminal stamp without a figure falls back to the invocation snapshots', () => {
  const events = [
    spawned('cassandra'),
    progress('cassandra', 0.75),
    line('seat-failure', { actor: 'daemon', seat: 'cassandra', reason: 'report-invalid' }),
  ];
  assert.equal(runCost(events), 0.75);
});

test('a ledger with no seats costs nothing', () => {
  assert.equal(runCost([line('run-launched', { actor: 'daemon' })]), 0);
});

// -- budget thresholds --------------------------------------------------------

function setup(t, { slotCaps = { proj: 3 } } = {}) {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const engine = new RunEngine(paths, { getSlotCap: (project) => slotCaps[project] });
  t.after(async () => {
    await engine.stop();
    removeDir(home);
  });
  return { paths, engine };
}

// A lane whose stages each burn a fixed amount through one seat invocation.
function spendingLane(engine, spend) {
  const stages = spend.map((_, i) => `s${i + 1}`);
  const handlers = {};
  stages.forEach((stage, i) => {
    handlers[stage] = (ctx) => {
      ctx.store.append('seat-spawned', { actor: 'daemon', seat: stage });
      ctx.store.append('seat-report', {
        actor: stage,
        seat: stage,
        path: 'r.json',
        cost: spend[i],
      });
      return i + 1 < stages.length ? { next: stages[i + 1] } : { close: { state: 'shipped' } };
    };
  });
  engine.registerLane('story', { stages, handlers });
  return stages;
}

test('the first crossing stamps once, and the run walks its later stages', async (t) => {
  const { paths, engine } = setup(t);
  const stages = spendingLane(engine, [40, 40, 40, 40]);
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story', budget: 100 });
  await waitFor(
    () => readEvents(archivedRunLedgerPath(paths, 'r1')).some((e) => e.event === 'run-closed'),
    { label: 'run closed' },
  );
  const events = readEvents(archivedRunLedgerPath(paths, 'r1'));
  const breaches = events.filter((e) => e.event === 'budget-breach');
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].threshold, 100);
  assert.equal(breaches[0].cost, 120);
  assert.equal(breaches[0].stage, 's3');
  assert.equal(breaches[0].stream, 'loud');
  // A threshold never parks, blocks, or closes: the run spent its last stage
  // and shipped.
  assert.deepEqual(
    events.filter((e) => e.event === 'stage-entered').map((e) => e.stage),
    stages,
  );
  assert.equal(events.filter((e) => e.event === 'park').length, 0);
  assert.equal(events.at(-1).event, 'run-closed');
  assert.equal(events.at(-1).state, 'shipped');
  // Loud, and paired at close, so the strip holds no alert for a finished run.
  const resolution = events.find((e) => e.event === 'resolved');
  assert.equal(resolution.resolves, breaches[0].seq);
  assert.equal(resolution.resolvedEvent, 'budget-breach');
  assert.equal(openLoud(paths).length, 0);
});

test('no budget in the launch payload stamps nothing', async (t) => {
  const { paths, engine } = setup(t);
  spendingLane(engine, [40, 40, 40]);
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(
    () => readEvents(archivedRunLedgerPath(paths, 'r1')).some((e) => e.event === 'run-closed'),
    { label: 'run closed' },
  );
  const events = readEvents(archivedRunLedgerPath(paths, 'r1'));
  assert.equal(events.filter((e) => e.event === 'budget-breach').length, 0);
  assert.equal(events.filter((e) => e.event === 'resolved').length, 0);
});

test('a run under its budget stamps nothing', async (t) => {
  const { paths, engine } = setup(t);
  spendingLane(engine, [10, 10]);
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story', budget: 100 });
  await waitFor(
    () => readEvents(archivedRunLedgerPath(paths, 'r1')).some((e) => e.event === 'run-closed'),
    { label: 'run closed' },
  );
  const events = readEvents(archivedRunLedgerPath(paths, 'r1'));
  assert.equal(events.filter((e) => e.event === 'budget-breach').length, 0);
});

test('a resumed run neither re-stamps its breach nor forgets it', async (t) => {
  const { paths, engine } = setup(t);
  const parking = {
    stages: ['burn', 'after'],
    handlers: {
      burn: (ctx) => {
        if (ctx.lastAnswer) return { next: 'after' };
        ctx.store.append('seat-spawned', { actor: 'daemon', seat: 'dev' });
        ctx.store.append('seat-report', { actor: 'dev', seat: 'dev', path: 'r.json', cost: 200 });
        return {
          park: { type: 'provisioning-gate', question: 'continue?', options: ['yes'] },
        };
      },
      // The stage the resume re-enters spends again, so a re-stamp would show.
      after: (ctx) => {
        ctx.store.append('seat-spawned', { actor: 'daemon', seat: 'dev2' });
        ctx.store.append('seat-report', { actor: 'dev2', seat: 'dev2', path: 'r.json', cost: 50 });
        return { close: { state: 'shipped' } };
      },
    },
  };
  engine.registerLane('story', parking);
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story', budget: 100 });
  await waitFor(() => readEvents(runLedgerPath(paths, 'r1')).some((e) => e.event === 'park'), {
    label: 'run parked',
  });
  assert.equal(
    readEvents(runLedgerPath(paths, 'r1')).filter((e) => e.event === 'budget-breach').length,
    1,
  );
  // A fresh engine over the same home: the memory is the ledger, nothing else.
  await engine.stop();
  const revived = new RunEngine(paths, { getSlotCap: () => 3 });
  revived.registerLane('story', parking);
  t.after(async () => revived.stop());
  revived.resumeOpenRuns();
  revived.answer({ runId: 'r1', actor: 'human', option: 'yes' });
  await waitFor(
    () => readEvents(archivedRunLedgerPath(paths, 'r1')).some((e) => e.event === 'run-closed'),
    { label: 'run closed' },
  );
  const events = readEvents(archivedRunLedgerPath(paths, 'r1'));
  assert.equal(events.filter((e) => e.event === 'budget-breach').length, 1);
  assert.equal(events.filter((e) => e.event === 'resolved').length, 1);
});

// -- config validation --------------------------------------------------------

const base = { version: 1, commands: {} };

test('a budgets block takes positive dollars on a lane the daemon runs', () => {
  assert.deepEqual(validateProjectConfig({ ...base, budgets: { story: 160, repair: 50 } }), []);
  assert.deepEqual(validateProjectConfig({ ...base, budgets: {} }), []);
  assert.deepEqual(validateProjectConfig(base), []);
});

test('a budgets block refuses an unknown lane and a figure that is not money', () => {
  const errors = validateProjectConfig({
    ...base,
    budgets: { spec: 10, story: 0, repair: '50' },
  });
  assert.deepEqual(errors.map((e) => e.path).sort(), [
    'budgets.repair',
    'budgets.spec',
    'budgets.story',
  ]);
  assert.match(errors.find((e) => e.path === 'budgets.spec').message, /must name a lane/);
  assert.match(errors.find((e) => e.path === 'budgets.story').message, /positive number/);
});
