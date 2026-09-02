import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { openInstanceStore } from '../src/telemetry/stores.mjs';
import { openStreamItems } from '../src/telemetry/readers.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { checkReportSchema, validateReport } from '../src/seats/contract.mjs';
import { CERTIFICATION_MODEL } from '../src/seats/seatmap.mjs';
import {
  EvalScheduler,
  EVAL_REPORT_SCHEMA,
  evalReportPath,
  evalWindow,
} from '../src/eval/review.mjs';
import { Daemon } from '../src/daemon/daemon.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

const REPORT = {
  summary: 'window reviewed',
  proposals: [
    {
      shape: 'cut-candidate',
      title: 'minimality lens zero yield',
      evidence: 'no confirmed minimality finding across the window',
      change: 'cut the lens; land a restoring tripwire in the same PR',
    },
  ],
};

function home(t) {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  return scaffoldHome(dir);
}

function writeLedger(path, lines) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function line(seq, ts, event, extra = {}) {
  return { seq, ts, event, actor: 'daemon', ...extra };
}

function shipRun(paths, runId, project, ts, { lane = 'story', escapeSeq } = {}) {
  writeLedger(runLedgerPath(paths, runId), [
    line(1, ts, 'run-launched', {
      project,
      lane,
      ...(lane === 'repair' && { ticket: `/home/tickets/${runId}.md` }),
      ...(escapeSeq !== undefined && { escapeSeq }),
    }),
    line(2, ts, 'merged', { sha: 'a'.repeat(7) }),
    line(3, ts, 'run-closed', { state: 'shipped' }),
  ]);
}

function fixtureParse(text) {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    return { cost: parsed.cost, note: parsed.note, meta: parsed.meta };
  } catch {
    return null;
  }
}

function reportPathFrom(prompt) {
  const lines = prompt.split('\n');
  const contract = lines.findIndex((l) => l.includes('write your JSON report to this file'));
  if (contract >= 0) return lines[contract + 1];
  return /then stop: (.+)$/m.exec(prompt)[1];
}

// A fixture eval seat: `behavior` maps a call to {report?, exitCode?, sleepMs?}.
function evalFixture(behavior) {
  const calls = [];
  const commandFor = (opts) => {
    const reportPath = reportPathFrom(opts.prompt);
    calls.push({ prompt: opts.prompt, model: opts.model, attempt: opts.attempt, reportPath });
    const out = behavior({ prompt: opts.prompt, attempt: opts.attempt }) ?? {};
    const script = [
      `console.log(${JSON.stringify(JSON.stringify({ meta: { model: opts.model } }))});`,
      ...(out.report !== undefined
        ? [
            `require('fs').mkdirSync(require('path').dirname(${JSON.stringify(reportPath)}), { recursive: true });`,
            `require('fs').writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(out.report))});`,
          ]
        : []),
      ...(out.sleepMs !== undefined
        ? [`setTimeout(() => process.exit(${out.exitCode ?? 0}), ${out.sleepMs});`]
        : [`process.exit(${out.exitCode ?? 0});`]),
    ].join('\n');
    return { cmd: process.execPath, args: ['-e', script], parseLine: fixtureParse };
  };
  return { commandFor, calls };
}

function scheduler(t, paths, fixture) {
  const store = openInstanceStore(paths);
  const evals = new EvalScheduler({
    paths,
    ledger: store,
    seatDefaults: () => ({ commandFor: fixture.commandFor }),
  });
  t.after(async () => {
    await evals.stop();
    store.close();
  });
  return { evals, store };
}

test('the report schema stays inside the flat subset and gates the shapes', () => {
  assert.deepEqual(checkReportSchema(EVAL_REPORT_SCHEMA), []);
  assert.deepEqual(validateReport(EVAL_REPORT_SCHEMA, REPORT), []);
  const bad = validateReport(EVAL_REPORT_SCHEMA, {
    summary: 'x',
    proposals: [{ shape: 'auto-execute', title: 't', evidence: 'e', change: 'c' }],
  });
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /must be one of/);
});

test('the fifth ship fires the review; four do not', async (t) => {
  const paths = home(t);
  const fixture = evalFixture(() => ({ report: REPORT }));
  const { evals, store } = scheduler(t, paths, fixture);
  for (let i = 1; i <= 4; i++) shipRun(paths, `s${i}`, 'p', `2026-08-0${i}T00:00:00Z`);
  await evals.notify();
  assert.equal(fixture.calls.length, 0);
  shipRun(paths, 's5', 'p', '2026-08-05T00:00:00Z');
  await evals.notify();
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].model, CERTIFICATION_MODEL);
  const reportPath = evalReportPath(paths, 1);
  assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), REPORT);
  const events = readEvents(paths.instanceLedger);
  const review = events.find((e) => e.event === 'eval-review');
  assert.equal(review.review, 1);
  assert.equal(review.shipCount, 5);
  assert.deepEqual(review.ships, ['s1', 's2', 's3', 's4', 's5']);
  assert.equal(review.report, reportPath);
  assert.equal(review.proposals, 1);
  assert.equal(review.model, CERTIFICATION_MODEL);
  assert.equal(review.stream, 'queued');
  // seat events of the instance-scoped job land in the instance ledger
  const seatEvents = events.filter((e) => e.seat === 'eval').map((e) => e.event);
  assert.deepEqual(seatEvents, ['seat-spawned', 'seat-report']);
  // queued item, resolvable: acknowledged by the human after triage
  assert.ok(openStreamItems(paths, 'queued').some((e) => e.seq === review.seq));
  store.resolve({ actor: 'human', resolves: review.seq, note: 'triaged' });
  assert.ok(!openStreamItems(paths, 'queued').some((e) => e.seq === review.seq));
});

test('the next review covers only the ships since the last one', async (t) => {
  const paths = home(t);
  const fixture = evalFixture(() => ({ report: { summary: 'ok', proposals: [] } }));
  const { evals } = scheduler(t, paths, fixture);
  for (let i = 1; i <= 5; i++) shipRun(paths, `s${i}`, 'p', `2026-08-0${i}T00:00:00Z`);
  await evals.notify();
  for (let i = 6; i <= 9; i++) shipRun(paths, `s${i}`, 'p', `2026-08-0${i}T00:00:00Z`);
  await evals.notify();
  assert.equal(fixture.calls.length, 1); // four new ships: no review owed
  shipRun(paths, 's10', 'q', '2026-08-10T00:00:00Z');
  await evals.notify();
  assert.equal(fixture.calls.length, 2);
  const reviews = readEvents(paths.instanceLedger).filter((e) => e.event === 'eval-review');
  assert.equal(reviews.length, 2);
  assert.equal(reviews[1].review, 2);
  assert.equal(reviews[1].shipCount, 10);
  assert.deepEqual(reviews[1].ships, ['s6', 's7', 's8', 's9', 's10']);
  // the second seat gets the prior report to compare for drift
  assert.match(fixture.calls[1].prompt, /prior eval report/);
  assert.ok(fixture.calls[1].prompt.includes(evalReportPath(paths, 1)));
  assert.match(fixture.calls[0].prompt, /first review; no prior report/);
});

test('a shipped repair is a ship the review counts, and the role block names its lane', async (t) => {
  const paths = home(t);
  const fixture = evalFixture(() => ({ report: { summary: 'ok', proposals: [] } }));
  const { evals } = scheduler(t, paths, fixture);
  for (let i = 1; i <= 3; i++) shipRun(paths, `s${i}`, 'p', `2026-08-0${i}T00:00:00Z`);
  shipRun(paths, 'r1', 'p', '2026-08-04T00:00:00Z', { lane: 'repair', escapeSeq: 7 });
  await evals.notify();
  assert.equal(fixture.calls.length, 0); // four ships: not owed yet
  shipRun(paths, 'r2', 'q', '2026-08-05T00:00:00Z', { lane: 'repair' });
  await evals.notify();
  assert.equal(fixture.calls.length, 1);
  const review = readEvents(paths.instanceLedger).find((e) => e.event === 'eval-review');
  assert.deepEqual(review.ships, ['s1', 's2', 's3', 'r1', 'r2']);
  assert.deepEqual(review.lanes, { story: 3, repair: 2 });
  assert.equal(review.shipCount, 5);
  assert.match(review.gist, /5 ships \(3 story, 2 repair\)/);
  const prompt = fixture.calls[0].prompt;
  assert.match(prompt, /- s1 \(p, story, merged 2026-08-01T00:00:00Z\)/);
  assert.match(prompt, /- r1 \(p, repair, escape #7, merged 2026-08-04T00:00:00Z\)/);
  assert.match(prompt, /- r2 \(q, repair, maintenance, merged 2026-08-05T00:00:00Z\)/);
  assert.match(prompt, /a story run has a card; a repair run has a ticket/);
  assert.match(prompt, /whether a maintenance repair should have\nbeen a story/);
});

test('the window starts after the newest ship the last review named, not at a count', async (t) => {
  const paths = home(t);
  const fixture = evalFixture(() => ({ report: { summary: 'ok', proposals: [] } }));
  const { evals } = scheduler(t, paths, fixture);
  for (let i = 1; i <= 5; i++) shipRun(paths, `s${i}`, 'p', `2026-08-0${i}T00:00:00Z`);
  await evals.notify();
  assert.equal(fixture.calls.length, 1);
  // Two repairs whose ledgers enter the list with merge times inside the
  // reviewed span. A count-based slice would start the next window two ships
  // early and hand s4 and s5 to the seat twice.
  shipRun(paths, 'r-old', 'p', '2026-08-02T12:00:00Z', { lane: 'repair', escapeSeq: 1 });
  shipRun(paths, 'r-older', 'p', '2026-08-01T12:00:00Z', { lane: 'repair' });
  for (let i = 6; i <= 9; i++) shipRun(paths, `s${i}`, 'p', `2026-08-0${i}T00:00:00Z`);
  await evals.notify();
  assert.equal(fixture.calls.length, 1); // s6..s9: four ships, no review owed
  shipRun(paths, 'r-new', 'p', '2026-08-10T00:00:00Z', { lane: 'repair', escapeSeq: 2 });
  await evals.notify();
  assert.equal(fixture.calls.length, 2);
  const reviews = readEvents(paths.instanceLedger).filter((e) => e.event === 'eval-review');
  assert.deepEqual(reviews[1].ships, ['s6', 's7', 's8', 's9', 'r-new']);
  assert.deepEqual(reviews[1].lanes, { story: 4, repair: 1 });
  assert.equal(reviews[1].shipCount, 12);
  assert.ok(!fixture.calls[1].prompt.includes('- s5 ('));
  assert.ok(!fixture.calls[1].prompt.includes('- r-old ('));
});

test('the window derivation reads the named ships, ties included, and every ship before a first review', () => {
  const ship = (runId, ts, lane = 'story') => ({ runId, project: 'p', lane, ts, archived: false });
  const ships = [
    ship('a', '2026-08-01T00:00:00Z'),
    ship('b', '2026-08-02T00:00:00Z'),
    ship('r', '2026-08-02T00:00:00Z', 'repair'),
    ship('c', '2026-08-03T00:00:00Z'),
  ];
  assert.deepEqual(evalWindow(ships, null).map((s) => s.runId), ['a', 'b', 'r', 'c']);
  // The named ship at the boundary is out; the unnamed ship that shares its
  // merge time is in, because nothing has reviewed it.
  assert.deepEqual(evalWindow(ships, { ships: ['a', 'b'] }).map((s) => s.runId), ['r', 'c']);
  assert.deepEqual(evalWindow(ships, { ships: ['a', 'b', 'r'] }).map((s) => s.runId), ['c']);
  // The stamp's own count is not the boundary.
  assert.deepEqual(
    evalWindow(ships, { ships: ['a'], shipCount: 4 }).map((s) => s.runId),
    ['b', 'r', 'c'],
  );
  // A stamp whose ships no ledger holds any more bounds nothing.
  assert.deepEqual(evalWindow(ships, { ships: ['gone'] }).map((s) => s.runId), ['a', 'b', 'r', 'c']);
});

test('a failed seat leaves the trigger owed; the next event retries fresh', async (t) => {
  const paths = home(t);
  let healthy = false;
  const fixture = evalFixture(() =>
    healthy ? { report: REPORT } : { report: { wrong: true } },
  );
  const { evals } = scheduler(t, paths, fixture);
  for (let i = 1; i <= 5; i++) shipRun(paths, `s${i}`, 'p', `2026-08-0${i}T00:00:00Z`);
  await evals.notify();
  // one corrective re-prompt into the same session, then seat-failure
  assert.deepEqual(fixture.calls.map((c) => c.attempt), [1, 2]);
  const events = readEvents(paths.instanceLedger);
  assert.ok(events.some((e) => e.event === 'seat-failure' && e.reason === 'report-invalid'));
  assert.ok(!events.some((e) => e.event === 'eval-review'));
  healthy = true;
  shipRun(paths, 's6', 'p', '2026-08-06T00:00:00Z');
  await evals.notify();
  const review = readEvents(paths.instanceLedger).find((e) => e.event === 'eval-review');
  assert.equal(review.review, 1);
  assert.equal(review.shipCount, 6); // the retry covers the whole owed window
  assert.deepEqual(review.ships, ['s1', 's2', 's3', 's4', 's5', 's6']);
});

test('no proposal self-executes', async (t) => {
  const paths = home(t);
  const proposals = [
    { shape: 'new-tripwire', title: 'x', evidence: 'e', change: 'add metric x' },
    { shape: 'band-change', title: 'y', evidence: 'e', change: 'raise the band' },
    { shape: 'vocabulary-promotion', title: 'z', evidence: 'e', change: 'promote the note' },
  ];
  const fixture = evalFixture(() => ({ report: { summary: 's', proposals } }));
  const { evals } = scheduler(t, paths, fixture);
  writeFileSync(paths.instanceConfig, JSON.stringify({ version: 1 }) + '\n');
  const configBefore = readFileSync(paths.instanceConfig, 'utf8');
  for (let i = 1; i <= 5; i++) shipRun(paths, `s${i}`, 'p', `2026-08-0${i}T00:00:00Z`);
  await evals.notify();
  assert.ok(readEvents(paths.instanceLedger).some((e) => e.event === 'eval-review'));
  // nothing beyond the stamp and the artifact: config untouched, no config
  // or registry events, one report file
  assert.equal(readFileSync(paths.instanceConfig, 'utf8'), configBefore);
  const events = readEvents(paths.instanceLedger).map((e) => e.event);
  assert.ok(!events.includes('config-changed'));
  assert.ok(!events.includes('tripwire-breach'));
  assert.deepEqual(readdirSync(paths.evalReports), ['review-1.json']);
});

test('the daemon fires an owed review at start and drains the seat at stop', async (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const paths = scaffoldHome(root);
  for (let i = 1; i <= 5; i++) shipRun(paths, `s${i}`, 'p', `2026-08-0${i}T00:00:00Z`);
  const fixture = evalFixture(() => ({ report: REPORT }));
  const daemon = new Daemon(root, {
    evalSeatDefaults: () => ({ commandFor: fixture.commandFor }),
  });
  t.after(() => daemon.stop());
  await daemon.start();
  await waitFor(
    () => readEvents(paths.instanceLedger).some((e) => e.event === 'eval-review'),
    { label: 'eval review at start' },
  );
  await daemon.stop();
  const events = readEvents(paths.instanceLedger);
  assert.equal(events[events.length - 1].event, 'daemon-stopped');
});

test('a repair that closes shipped notifies the scheduler', async (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const paths = scaffoldHome(root);
  for (let i = 1; i <= 4; i++) shipRun(paths, `s${i}`, 'p', `2026-08-0${i}T00:00:00Z`);
  const fixture = evalFixture(() => ({ report: REPORT }));
  const daemon = new Daemon(root, {
    evalSeatDefaults: () => ({ commandFor: fixture.commandFor }),
  });
  t.after(() => daemon.stop());
  await daemon.start();
  await daemon.evals.chain;
  assert.equal(fixture.calls.length, 0); // four ships at start: nothing owed
  shipRun(paths, 'r1', 'p', '2026-08-05T00:00:00Z', { lane: 'repair', escapeSeq: 3 });
  // The engine's close hook, with the shape a shipped repair closes with.
  daemon.engine.onClosed({ runId: 'r1', project: 'p', lane: 'repair', state: 'shipped' });
  await waitFor(
    () => readEvents(paths.instanceLedger).find((e) => e.event === 'eval-review'),
    { label: 'eval review after a shipped repair' },
  );
  const review = readEvents(paths.instanceLedger).find((e) => e.event === 'eval-review');
  assert.deepEqual(review.ships, ['s1', 's2', 's3', 's4', 'r1']);
  assert.deepEqual(review.lanes, { story: 4, repair: 1 });
  await daemon.stop();
});

test('daemon stop terminates an in-flight eval seat', async (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const paths = scaffoldHome(root);
  for (let i = 1; i <= 5; i++) shipRun(paths, `s${i}`, 'p', `2026-08-0${i}T00:00:00Z`);
  const fixture = evalFixture(() => ({ report: REPORT, sleepMs: 60000 }));
  const daemon = new Daemon(root, {
    evalSeatDefaults: () => ({ commandFor: fixture.commandFor }),
  });
  t.after(() => daemon.stop());
  await daemon.start();
  await waitFor(
    () => readEvents(paths.instanceLedger).some((e) => e.event === 'seat-spawned' && e.seat === 'eval'),
    { label: 'eval seat spawned' },
  );
  await daemon.stop();
  const events = readEvents(paths.instanceLedger);
  assert.ok(
    events.some(
      (e) => e.event === 'seat-terminated' && e.seat === 'eval' && e.reason === 'daemon-stopped',
    ),
  );
  assert.ok(!events.some((e) => e.event === 'eval-review'));
  assert.equal(events[events.length - 1].event, 'daemon-stopped');
});

test('the eval directory scaffolds with the home', async (t) => {
  const paths = home(t);
  assert.ok(existsSync(paths.evalReports));
});
