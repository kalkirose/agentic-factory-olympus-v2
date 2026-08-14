import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { runSeat, unavailableMemo } from '../src/seats/runner.mjs';
import { parseClaudeLine } from '../src/seats/claude.mjs';
import { ModelSemaphores } from '../src/seats/semaphore.mjs';
import { DEFAULT_MODEL, CERTIFICATION_MODEL } from '../src/seats/seatmap.mjs';
import { ONE_TURN_RULE } from '../src/seats/prompt.mjs';
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

// -- availability degrade ----------------------------------------------------

const RESETS_AT = 1786557600;

// A seat child that speaks real stream-json and is read by the real parser, so
// the degrade decision is driven by the stream shapes a rejected model emits.
function claudeFixtureCommand({ report, reportPath, lines = [], exitCode = 0 }) {
  const script = [
    ...(report !== undefined
      ? [
          `require('fs').writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});`,
        ]
      : []),
    ...lines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`),
    `process.exit(${exitCode});`,
  ].join('\n');
  return { cmd: process.execPath, args: ['-e', script], parseLine: parseClaudeLine };
}

const initLine = (model) => ({ type: 'system', subtype: 'init', session_id: 's1', model });

// The stream a rejected model emits: the rate-limit event, then a synthetic
// message in place of the answer, then a result that calls itself a success.
const rejectionLines = [
  initLine(CERTIFICATION_MODEL),
  {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      resetsAt: RESETS_AT,
      rateLimitType: 'seven_day_overage_included',
      overageStatus: 'rejected',
    },
    session_id: 's1',
  },
  {
    type: 'assistant',
    message: {
      model: '<synthetic>',
      content: [{ type: 'text', text: 'You have reached your limit. Switch models to continue.' }],
    },
    error: 'rate_limit',
    is_api_error_message: true,
    session_id: 's1',
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 429,
    terminal_reason: 'api_error',
    total_cost_usd: 0,
  },
];

const healthyLines = (model) => [
  initLine(model),
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: RESETS_AT } },
  { type: 'assistant', message: { model, content: [{ type: 'text', text: 'judging the diff' }] } },
  { type: 'result', subtype: 'success', total_cost_usd: 0.5 },
];

test('a rejected model degrades to the default model at the same effort', async (t) => {
  const { paths, store } = setup(t);
  const reportPath = runReportPath(paths, 'r1', 'verdict-triage');
  const calls = [];
  const result = await runSeat(store, {
    seat: 'verdict-triage',
    roleBlock: 'ROLE',
    reportPath,
    schema: SCHEMA,
    commandFor: (opts) => {
      calls.push(opts);
      return opts.model === CERTIFICATION_MODEL
        ? claudeFixtureCommand({ reportPath, lines: rejectionLines, exitCode: 1 })
        : claudeFixtureCommand({
            report: { verdict: 'pass' },
            reportPath,
            lines: healthyLines(DEFAULT_MODEL),
          });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, DEFAULT_MODEL);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, CERTIFICATION_MODEL);
  assert.equal(calls[1].model, DEFAULT_MODEL);
  // Effort never drops; the fallback only ever raises capability.
  assert.equal(calls[0].effort, 'xhigh');
  assert.equal(calls[1].effort, 'xhigh');
  // The rejected attempt wrote no transcript worth resuming into.
  assert.equal(calls[1].resume, undefined);
  assert.equal(calls[1].attempt, 1);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  const degrades = events.filter((e) => e.event === 'model-degraded');
  assert.equal(degrades.length, 1);
  assert.equal(degrades[0].seat, 'verdict-triage');
  assert.equal(degrades[0].requested, CERTIFICATION_MODEL);
  assert.equal(degrades[0].used, DEFAULT_MODEL);
  assert.equal(degrades[0].reason, 'rate-limit');
  assert.equal(degrades[0].resetsAt, RESETS_AT);
  assert.equal(degrades[0].attempt, 1);
  // seat-spawned names the model that ran, so no reader is misled about who
  // judged the work, and the degrade stamp sits before the second spawn.
  const spawned = events.filter((e) => e.event === 'seat-spawned');
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].model, CERTIFICATION_MODEL);
  assert.equal(spawned[0].degraded, undefined);
  assert.equal(spawned[1].model, DEFAULT_MODEL);
  assert.equal(spawned[1].degraded, true);
  assert.ok(degrades[0].seq < spawned[1].seq);
  assert.equal(events.find((e) => e.event === 'seat-report').model, DEFAULT_MODEL);
  // The rejected attempt is not a seat failure; the seat produced its report.
  assert.ok(!events.some((e) => e.event === 'seat-failure'));
});

test('a rejection is read from the stream, not the exit code', async (t) => {
  const { paths, store } = setup(t);
  const reportPath = runReportPath(paths, 'r1', 'eval');
  const calls = [];
  const result = await runSeat(store, {
    seat: 'eval',
    roleBlock: 'ROLE',
    reportPath,
    schema: SCHEMA,
    commandFor: (opts) => {
      calls.push(opts);
      // The rejected model exits 0 here — measured from a terminal — and the
      // degrade must fire exactly as it does on the exit-1 path.
      return opts.model === CERTIFICATION_MODEL
        ? claudeFixtureCommand({ reportPath, lines: rejectionLines, exitCode: 0 })
        : claudeFixtureCommand({
            report: { verdict: 'pass' },
            reportPath,
            lines: healthyLines(DEFAULT_MODEL),
          });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, DEFAULT_MODEL);
  assert.equal(calls.length, 2);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  assert.equal(events.filter((e) => e.event === 'model-degraded').length, 1);
  // A clean exit must not send the seat down the corrective re-prompt route
  // against a model that answered nothing.
  assert.ok(!events.some((e) => e.event === 'seat-spawned' && e.corrective));
});

test('a healthy seat never degrades', async (t) => {
  const { paths, store } = setup(t);
  const reportPath = runReportPath(paths, 'r1', 'verdict-triage');
  let calls = 0;
  const result = await runSeat(store, {
    seat: 'verdict-triage',
    roleBlock: 'ROLE',
    reportPath,
    schema: SCHEMA,
    commandFor: () => {
      calls++;
      return claudeFixtureCommand({
        report: { verdict: 'pass' },
        reportPath,
        lines: healthyLines(CERTIFICATION_MODEL),
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, CERTIFICATION_MODEL);
  assert.equal(calls, 1);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  assert.ok(!events.some((e) => e.event === 'model-degraded'));
  assert.equal(events.filter((e) => e.event === 'seat-spawned').length, 1);
  assert.equal(events.find((e) => e.event === 'seat-report').model, CERTIFICATION_MODEL);
});

test('both models rejected fails loudly with the evidence, and never loops', async (t) => {
  const { paths, store } = setup(t);
  const reportPath = runReportPath(paths, 'r1', 'fury-verifier');
  const calls = [];
  const result = await runSeat(store, {
    seat: 'fury-verifier',
    roleBlock: 'ROLE',
    reportPath,
    schema: SCHEMA,
    commandFor: (opts) => {
      calls.push(opts.model);
      return claudeFixtureCommand({ reportPath, lines: rejectionLines, exitCode: 1 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'model-unavailable');
  // Exactly one degrade attempt: the configured model, then the default.
  assert.deepEqual(calls, [CERTIFICATION_MODEL, DEFAULT_MODEL]);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  assert.equal(events.filter((e) => e.event === 'model-degraded').length, 1);
  const failures = events.filter((e) => e.event === 'seat-failure');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'model-unavailable');
  assert.equal(failures[0].model, DEFAULT_MODEL);
  assert.equal(failures[0].cause, 'rate-limit');
  assert.equal(failures[0].degraded, true);
  assert.equal(failures[0].resetsAt, RESETS_AT);
  // The evidence rides the failure: the reader sees what the seat emitted.
  assert.ok(failures[0].stdoutTail.some((line) => line.includes('rate_limit')));
  assert.ok(!events.some((e) => e.event === 'seat-report'));
});

test('a rejection on the default model degrades nothing and fails once', async (t) => {
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
      return claudeFixtureCommand({ reportPath, lines: rejectionLines, exitCode: 1 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'model-unavailable');
  assert.equal(calls, 1);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  assert.ok(!events.some((e) => e.event === 'model-degraded'));
  const failure = events.find((e) => e.event === 'seat-failure');
  assert.equal(failure.model, DEFAULT_MODEL);
  assert.equal(failure.degraded, undefined);
});

// -- the per-run quota memo --------------------------------------------------

const FUTURE_RESET = Math.floor(Date.now() / 1000) + 3600;
const PAST_RESET = Math.floor(Date.now() / 1000) - 3600;

const rejectionResetting = (resetsAt) =>
  rejectionLines.map((line) =>
    line.type === 'rate_limit_event'
      ? { ...line, rate_limit_info: { ...line.rate_limit_info, resetsAt } }
      : line,
  );

test('a run degrades the second seat on its memo, without re-buying the rejection', async (t) => {
  const { paths, store } = setup(t);
  const calls = [];
  const commandFor = (reportPath) => (opts) => {
    calls.push(opts.model);
    return opts.model === CERTIFICATION_MODEL
      ? claudeFixtureCommand({ reportPath, lines: rejectionResetting(FUTURE_RESET), exitCode: 1 })
      : claudeFixtureCommand({
          report: { verdict: 'pass' },
          reportPath,
          lines: healthyLines(DEFAULT_MODEL),
        });
  };
  const first = runReportPath(paths, 'r1', 'verdict-triage');
  const one = await runSeat(store, {
    seat: 'verdict-triage',
    roleBlock: 'ROLE',
    reportPath: first,
    schema: SCHEMA,
    commandFor: commandFor(first),
  });
  assert.equal(one.ok, true);
  const second = runReportPath(paths, 'r1', 'fury-verifier');
  const two = await runSeat(store, {
    seat: 'fury-verifier',
    roleBlock: 'ROLE',
    reportPath: second,
    schema: SCHEMA,
    commandFor: commandFor(second),
  });
  assert.equal(two.ok, true);
  assert.equal(two.model, DEFAULT_MODEL);
  // The refused model is spawned once in the whole run, not once per seat.
  assert.deepEqual(calls, [CERTIFICATION_MODEL, DEFAULT_MODEL, DEFAULT_MODEL]);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  const degrades = events.filter((e) => e.event === 'model-degraded');
  assert.equal(degrades.length, 2);
  // The first degrade stood on its own rejection; the second on the memo, and
  // says so. Neither is silent.
  assert.equal(degrades[0].memo, undefined);
  assert.equal(degrades[1].memo, true);
  assert.equal(degrades[1].seat, 'fury-verifier');
  assert.equal(degrades[1].requested, CERTIFICATION_MODEL);
  assert.equal(degrades[1].used, DEFAULT_MODEL);
  assert.equal(degrades[1].reason, 'rate-limit');
  assert.equal(degrades[1].resetsAt, FUTURE_RESET);
  assert.equal(degrades[1].attempt, 1);
  // The memo degrade rides its own spawn stamp, on the model that did the work.
  const spawned = events.filter((e) => e.event === 'seat-spawned' && e.seat === 'fury-verifier');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].model, DEFAULT_MODEL);
  assert.equal(spawned[0].degraded, true);
  assert.ok(degrades[1].seq < spawned[0].seq);
});

test('a memo whose reset instant has passed sends the seat at its own model', async (t) => {
  const { paths, store } = setup(t);
  const reportPath = runReportPath(paths, 'r1', 'verdict-triage');
  store.append('model-degraded', {
    actor: 'daemon',
    seat: 'eval',
    requested: CERTIFICATION_MODEL,
    used: DEFAULT_MODEL,
    reason: 'rate-limit',
    attempt: 1,
    resetsAt: PAST_RESET,
  });
  const calls = [];
  const result = await runSeat(store, {
    seat: 'verdict-triage',
    roleBlock: 'ROLE',
    reportPath,
    schema: SCHEMA,
    commandFor: (opts) => {
      calls.push(opts.model);
      return claudeFixtureCommand({
        report: { verdict: 'pass' },
        reportPath,
        lines: healthyLines(CERTIFICATION_MODEL),
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, CERTIFICATION_MODEL);
  assert.deepEqual(calls, [CERTIFICATION_MODEL]);
  const events = readEvents(runLedgerPath(paths, 'r1'));
  assert.equal(events.filter((e) => e.event === 'model-degraded' && e.memo).length, 0);
});

test('a rejection recorded with no reset instant leaves the memo empty', () => {
  assert.equal(
    unavailableMemo(
      [{ event: 'model-degraded', requested: CERTIFICATION_MODEL, reason: 'rate-limit' }],
      CERTIFICATION_MODEL,
    ),
    null,
  );
});

test('the memo reads a seat-failure record as readily as a degrade', () => {
  const memo = unavailableMemo(
    [
      {
        event: 'seat-failure',
        reason: 'model-unavailable',
        model: CERTIFICATION_MODEL,
        cause: 'rate-limit',
        resetsAt: FUTURE_RESET,
      },
    ],
    CERTIFICATION_MODEL,
  );
  assert.deepEqual(memo, { resetsAt: FUTURE_RESET, reason: 'rate-limit' });
  // Another model's rejection is not this model's memo.
  assert.equal(unavailableMemo([{ event: 'model-degraded', requested: 'other', resetsAt: FUTURE_RESET }], CERTIFICATION_MODEL), null);
});

test('a degrade moves the seat onto the default model semaphore', async (t) => {
  const { paths, store } = setup(t);
  const reportPath = runReportPath(paths, 'r1', 'verdict-triage');
  const semaphores = new ModelSemaphores({ [DEFAULT_MODEL]: 1, [CERTIFICATION_MODEL]: 1 });
  const result = await runSeat(store, {
    seat: 'verdict-triage',
    roleBlock: 'ROLE',
    reportPath,
    schema: SCHEMA,
    semaphores,
    commandFor: (opts) =>
      opts.model === CERTIFICATION_MODEL
        ? claudeFixtureCommand({ reportPath, lines: rejectionLines, exitCode: 1 })
        : claudeFixtureCommand({
            report: { verdict: 'pass' },
            reportPath,
            lines: healthyLines(DEFAULT_MODEL),
          }),
  });
  assert.equal(result.ok, true);
  const granted = readEvents(runLedgerPath(paths, 'r1')).filter(
    (e) => e.event === 'semaphore-granted',
  );
  assert.deepEqual(
    granted.map((e) => e.model),
    [CERTIFICATION_MODEL, DEFAULT_MODEL],
  );
  // The refused model's slot is handed back, not held for the whole session.
  assert.equal(semaphores.held.get(CERTIFICATION_MODEL), 0);
  assert.equal(semaphores.held.get(DEFAULT_MODEL), 0);
});

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
  // The corrective brief names the cause the seat cannot see from inside its
  // own turn: the session ended with nothing written, so the work is gone.
  assert.ok(calls[1].prompt.includes('ended with no report file'));
  assert.ok(calls[1].prompt.includes(ONE_TURN_RULE));
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
