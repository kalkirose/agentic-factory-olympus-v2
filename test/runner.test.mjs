import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { runSeat } from '../src/seats/runner.mjs';
import { ModelSemaphores } from '../src/seats/semaphore.mjs';
import { DEFAULT_MODEL, CERTIFICATION_MODEL } from '../src/seats/seatmap.mjs';
import { RunEngine } from '../src/engine/engine.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import {
  scaffoldHome,
  runLedgerPath,
  runReportPath,
  archivedRunLedgerPath,
} from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } },
  required: ['verdict'],
};

function setup(t, runId = 'r1') {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const store = openRunStore(paths, runId);
  t.after(() => {
    store.close();
    removeDir(home);
  });
  return { paths, store };
}

// A fixture seat child: writes `report` to the report path (when given) and
// prints progress lines the fixture parser maps to {cost, note, meta}.
function fixtureCommand({ report, reportPath, lines = [], exitCode = 0 }) {
  const script = [
    ...(report !== undefined
      ? [`require('fs').writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});`]
      : []),
    ...lines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`),
    `process.exit(${exitCode});`,
  ].join('\n');
  return { cmd: process.execPath, args: ['-e', script], parseLine: fixtureParse };
}

function fixtureParse(line) {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    return { cost: parsed.cost, note: parsed.note, meta: parsed.meta };
  } catch {
    return null;
  }
}

test('a fixture seat completes the contract loop end to end', async (t) => {
  const { paths, store } = setup(t);
  const reportPath = runReportPath(paths, 'r1', 'dev');
  const calls = [];
  const result = await runSeat(store, {
    seat: 'dev',
    roleBlock: 'ROLE',
    reportPath,
    schema: SCHEMA,
    commandFor: (opts) => {
      calls.push(opts);
      return fixtureCommand({
        report: { verdict: 'pass' },
        reportPath,
        lines: [{ meta: { model: DEFAULT_MODEL, sessionId: 's1' } }, { cost: 2, note: 'done' }],
      });
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.report, { verdict: 'pass' });
  assert.equal(result.model, DEFAULT_MODEL);
  assert.equal(result.cost, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, DEFAULT_MODEL);
  assert.equal(calls[0].effort, 'xhigh');
  assert.ok(calls[0].prompt.includes('You are the dev seat'));
  assert.ok(calls[0].prompt.includes(reportPath));
  const events = readEvents(runLedgerPath(paths, 'r1'));
  const spawned = events.filter((e) => e.event === 'seat-spawned');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].model, DEFAULT_MODEL);
  assert.equal(spawned[0].effort, 'xhigh');
  assert.equal(spawned[0].attempt, 1);
  const report = events.find((e) => e.event === 'seat-report');
  assert.equal(report.actor, 'dev');
  assert.equal(report.path, reportPath);
  assert.equal(report.attempt, 1);
  assert.equal(report.model, DEFAULT_MODEL);
  assert.equal(report.cost, 2);
  assert.ok(!events.some((e) => e.event === 'seat-failure'));
});

test('a broken report triggers exactly one corrective re-prompt, then success', async (t) => {
  const { paths, store } = setup(t);
  const reportPath = runReportPath(paths, 'r1', 'dev');
  const calls = [];
  const result = await runSeat(store, {
    seat: 'dev',
    roleBlock: 'ROLE',
    reportPath,
    schema: SCHEMA,
    commandFor: (opts) => {
      calls.push(opts);
      return fixtureCommand({
        report: opts.attempt === 1 ? { verdict: 'maybe' } : { verdict: 'pass' },
        reportPath,
        lines: [{ meta: { sessionId: 's1' } }],
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].prompt.includes('did not validate'));
  assert.ok(calls[1].prompt.includes('$.verdict'));
  assert.equal(calls[1].resume, 's1');
  const events = readEvents(runLedgerPath(paths, 'r1'));
  const spawned = events.filter((e) => e.event === 'seat-spawned');
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].attempt, 2);
  assert.equal(spawned[1].corrective, true);
  assert.equal(events.find((e) => e.event === 'seat-report').attempt, 2);
  assert.ok(!events.some((e) => e.event === 'seat-failure'));
});

test('a second broken report is a seat-failure, never a retry loop', async (t) => {
  const { paths, store } = setup(t);
  const reportPath = runReportPath(paths, 'r1', 'dev');
  let calls = 0;
  const result = await runSeat(store, {
    seat: 'dev',
    roleBlock: 'ROLE',
    reportPath,
    schema: SCHEMA,
    commandFor: () => {
      calls++;
      return fixtureCommand({ report: { nope: true }, reportPath });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'report-invalid');
  assert.equal(calls, 2);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  const failure = events.find((e) => e.event === 'seat-failure');
  assert.equal(failure.reason, 'report-invalid');
  assert.ok(failure.errors.some((e) => e.includes('$.verdict')));
  assert.ok(!events.some((e) => e.event === 'seat-report'));
});

test('a missing report file takes the same corrective route', async (t) => {
  const { paths, store } = setup(t);
  const reportPath = runReportPath(paths, 'r1', 'suite');
  const calls = [];
  const result = await runSeat(store, {
    seat: 'suite',
    roleBlock: 'ROLE',
    reportPath,
    schema: SCHEMA,
    commandFor: (opts) => {
      calls.push(opts);
      return fixtureCommand({ reportPath }); // writes nothing
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'report-invalid');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].prompt.includes('no report file'));
});

test('a transcript model that differs from the request is a seat-failure', async (t) => {
  const { paths, store } = setup(t);
  const reportPath = runReportPath(paths, 'r1', 'fury-verifier');
  let calls = 0;
  const result = await runSeat(store, {
    seat: 'fury-verifier',
    roleBlock: 'ROLE',
    reportPath,
    schema: SCHEMA,
    commandFor: () => {
      calls++;
      return fixtureCommand({
        report: { verdict: 'pass' },
        reportPath,
        lines: [{ meta: { model: 'claude-opus-4-8' } }],
      });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'model-mismatch');
  assert.equal(calls, 1);
  const failure = readEvents(runLedgerPath(paths, 'r1')).find((e) => e.event === 'seat-failure');
  assert.equal(failure.reason, 'model-mismatch');
  assert.equal(failure.requested, CERTIFICATION_MODEL);
  assert.equal(failure.actual, 'claude-opus-4-8');
});

test('a substitute dispatch stamps model-substituted with the substitute named', async (t) => {
  const { paths, store } = setup(t);
  const reportPath = runReportPath(paths, 'r1', 'verdict-triage');
  const calls = [];
  const result = await runSeat(store, {
    seat: 'verdict-triage',
    roleBlock: 'ROLE',
    reportPath,
    schema: SCHEMA,
    substitute: { model: DEFAULT_MODEL, reason: 'certification-model outage' },
    commandFor: (opts) => {
      calls.push(opts);
      return fixtureCommand({
        report: { verdict: 'pass' },
        reportPath,
        lines: [{ meta: { model: DEFAULT_MODEL } }],
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].model, DEFAULT_MODEL);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  const substituted = events.find((e) => e.event === 'model-substituted');
  assert.equal(substituted.from, CERTIFICATION_MODEL);
  assert.equal(substituted.to, DEFAULT_MODEL);
  assert.equal(substituted.reason, 'certification-model outage');
  assert.ok(events.indexOf(substituted) < events.findIndex((e) => e.event === 'seat-spawned'));
});

test('a child failure ends the session — no corrective re-prompt, no report', async (t) => {
  const { paths, store } = setup(t);
  const reportPath = runReportPath(paths, 'r1', 'dev');
  let calls = 0;
  const result = await runSeat(store, {
    seat: 'dev',
    roleBlock: 'ROLE',
    reportPath,
    schema: SCHEMA,
    commandFor: () => {
      calls++;
      return fixtureCommand({ reportPath, exitCode: 3 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'exit');
  assert.equal(calls, 1);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  assert.equal(events.find((e) => e.event === 'seat-failure').reason, 'exit');
  assert.ok(!events.some((e) => e.event === 'seat-report'));
});

test('a schema outside the flat subset refuses the dispatch', async (t) => {
  const { paths, store } = setup(t);
  await assert.rejects(
    runSeat(store, {
      seat: 'dev',
      roleBlock: 'ROLE',
      reportPath: runReportPath(paths, 'r1', 'dev'),
      schema: { type: 'object', properties: {} },
    }),
    /flat subset/,
  );
});

test('two seats on one capped model run one at a time, with wait stamps', async (t) => {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const storeA = openRunStore(paths, 'ra');
  const storeB = openRunStore(paths, 'rb');
  t.after(() => {
    storeA.close();
    storeB.close();
    removeDir(home);
  });
  const semaphores = new ModelSemaphores({ [DEFAULT_MODEL]: 1 });
  const run = (store, runId) =>
    runSeat(store, {
      seat: 'dev',
      roleBlock: 'ROLE',
      reportPath: runReportPath(paths, runId, 'dev'),
      schema: SCHEMA,
      semaphores,
      commandFor: () =>
        fixtureCommand({
          report: { verdict: 'pass' },
          reportPath: runReportPath(paths, runId, 'dev'),
        }),
    });
  const a = run(storeA, 'ra');
  const b = run(storeB, 'rb');
  const [resultA, resultB] = await Promise.all([a, b]);
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
  const eventsA = readEvents(runLedgerPath(paths, 'ra'));
  const eventsB = readEvents(runLedgerPath(paths, 'rb'));
  assert.equal(eventsA.find((e) => e.event === 'semaphore-granted').waited, false);
  const wait = eventsB.find((e) => e.event === 'semaphore-wait');
  assert.ok(wait);
  const granted = eventsB.find((e) => e.event === 'semaphore-granted');
  assert.equal(granted.waited, true);
  assert.equal(granted.waitSeq, wait.seq);
  // The waiter's child spawns only after the holder's session ends.
  assert.ok(!eventsB.some((e) => e.event === 'seat-spawned' && e.seq < granted.seq));
});

test('a lane handler dispatches through ctx.runSeat; liveness stays clean', async (t) => {
  const home = tempDir();
  const paths = scaffoldHome(home);
  t.after(() => removeDir(home));
  const semaphores = new ModelSemaphores({ [DEFAULT_MODEL]: 1 });
  const engine = new RunEngine(paths, { getSlotCap: () => 1, semaphores });
  const reportPath = runReportPath(paths, 'e1', 'dev');
  engine.registerLane('mini', {
    stages: ['work'],
    handlers: {
      work: async (ctx) => {
        const result = await ctx.runSeat({
          seat: 'dev',
          roleBlock: 'ROLE',
          reportPath,
          schema: SCHEMA,
          commandFor: () => fixtureCommand({ report: { verdict: 'pass' }, reportPath }),
        });
        return { close: { state: result.ok ? 'shipped' : 'failed' } };
      },
    },
  });
  engine.launch({ runId: 'e1', project: 'p', lane: 'mini' });
  await waitFor(() => existsSync(archivedRunLedgerPath(paths, 'e1')), { label: 'run archived' });
  const events = readEvents(archivedRunLedgerPath(paths, 'e1'));
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(events.some((e) => e.event === 'seat-report'));
  assert.ok(events.some((e) => e.event === 'semaphore-granted'));
  assert.ok(!events.some((e) => e.event === 'liveness-violation'));
  await engine.stop();
});
