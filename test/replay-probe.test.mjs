// The replay probe, and the mechanical attribution beside it. A judgment seat
// holds none of the machine's credentials, so a credential-dependent red used
// to be a red it could not reproduce. These tests walk what it may now ask for
// (one Tier-1 layer of its own run, by name), what it gets back (the output,
// with every secret value replaced), what it is refused, and what the ledger
// says about all of it. The attribution tests hold the half that needs no seat
// at all: a red the host explains names the variable on the layer result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scaffoldHome, runLedgerPath, probeOutputPath } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { PROBE_REFUSALS, RUN_EVENTS, assertProbeRefusal } from '../src/ledger/registry.mjs';
import { seatExecutesSuite } from '../src/seats/seatmap.mjs';
import { validateInstanceConfig } from '../src/config/instance.mjs';
import { validateProjectConfig } from '../src/config/project.mjs';
import { runSpectrum } from '../src/lanes/spectrum.mjs';
import { triageStep } from '../src/lanes/verdict.mjs';
import { generalistReview } from '../src/lanes/review.mjs';
import {
  PROBE_REQUEST_PROPERTY,
  PROBE_ROUNDS,
  PROBE_SEATS,
  absentCredentials,
  redactSecrets,
  withReplayRounds,
} from '../src/lanes/replay.mjs';
import { tempDir, removeDir } from './helpers.mjs';

const ABSENT = 'OLYMPUS_TEST_ABSENT_KEY';
const SECRET = 'OLYMPUS_TEST_SECRET_KEY';
// Deliberately shaped like nothing a vendor issues. A fixture that looks like a
// real key is a fixture a secret scanner blocks the repository on, and this one
// is only ever asserted absent.
const SECRET_VALUE = 'the-value-no-brief-may-carry';

const GREEN = ['node', '-e', 'process.exit(0)'];
const RED = ['node', '-e', 'console.log("the acceptance suite said boom"); process.exit(1)'];
const PRINTS_SECRET = [
  'node',
  '-e',
  `console.log('key was ' + process.env.${SECRET}); process.exit(1)`,
];

function fixture(t, { probeCredentials = [], secretEnv = [] } = {}) {
  const root = tempDir('olympus-replay-');
  const paths = scaffoldHome(join(root, 'home'));
  mkdirSync(join(paths.runs, 'r1'), { recursive: true });
  const store = openRunStore(paths, 'r1');
  t.after(() => {
    store.close();
    removeDir(root);
  });
  const ctx = { store, paths, runId: 'r1', probeCredentials, secretEnv };
  return { root, paths, ctx };
}

function events(ctx) {
  return readEvents(runLedgerPath(ctx.paths, ctx.runId));
}

function probeRuns(ctx) {
  return events(ctx).filter((e) => e.event === 'probe-run');
}

/**
 * A base the judgment lanes accept, over a fixture project config. The
 * worktree is the harness checkout: the probe commands here never read it.
 */
function baseFor({ command = RED, credentials = [], env } = {}) {
  return {
    config: {
      version: 1,
      commands: { suite: command, lint: GREEN },
      gates: { tier1: [{ name: 'acceptance', command: 'suite' }, { name: 'lint', command: 'lint' }] },
      credentials,
    },
    worktree: process.cwd(),
    env,
    constitution: null,
    specRef: 'spec.md',
    lenses: ['spec', 'security'],
  };
}

/**
 * A seat seam that answers with the next report in the queue, writes it where
 * the contract expects it, and stamps `seat-report` — so the resume-by-report
 * routes the loop depends on are exercised, not stubbed past.
 */
function seatQueue(ctx, reports) {
  let index = 0;
  const calls = [];
  const runSeat = async ({ seat, roleBlock, reportPath }) => {
    const next = reports[Math.min(index, reports.length - 1)];
    index++;
    const report = typeof next === 'function' ? next(roleBlock) : next;
    calls.push({ seat, roleBlock, reportPath });
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report));
    ctx.store.append('seat-report', { actor: seat, seat, path: reportPath, attempt: 1 });
    return { ok: true, report };
  };
  runSeat.calls = calls;
  return runSeat;
}

const COVERED = {
  findings: [
    {
      class: 'env',
      layers: ['acceptance'],
      summary: 'the acceptance layer cannot reach its provider',
      evidence: 'the replay printed the same refusal',
    },
  ],
  persisting: [],
  summary: 'one env finding',
};

const asks = (layer, reason = 'reproduce the red') => ({
  findings: [],
  persisting: [],
  summary: 'asking first',
  probe: { layer, reason },
});

const REDS = [{ layer: 'acceptance', status: 'red', output: 'boom' }];

// -- the closed statements ---------------------------------------------------

test('the probe is a registered event and its refusals are a closed vocabulary', () => {
  assert.ok(RUN_EVENTS.has('probe-run'));
  assert.equal(assertProbeRefusal('not-a-tier1-layer'), 'not-a-tier1-layer');
  assert.throws(() => assertProbeRefusal('because-i-said-so'), /unknown probe refusal/);
  assert.deepEqual(
    [...PROBE_REFUSALS].sort(),
    ['credential-not-eligible', 'no-rounds-left', 'not-a-tier1-layer'],
  );
});

test('the request form has no route to an environment value', () => {
  assert.equal(PROBE_REQUEST_PROPERTY.additionalProperties, false);
  assert.deepEqual(Object.keys(PROBE_REQUEST_PROPERTY.properties).sort(), ['layer', 'reason']);
});

test('the probe is open to the judgment seats alone, and none of them holds a credential', () => {
  assert.deepEqual([...PROBE_SEATS].sort(), ['fury-verifier', 'verdict-triage']);
  for (const seat of PROBE_SEATS) {
    assert.equal(seatExecutesSuite(seat), false, `${seat} would keep the host credentials`);
  }
});

test('a seat outside the judgment set never reaches the probe', async (t) => {
  const { ctx } = fixture(t);
  await assert.rejects(
    withReplayRounds(ctx, { seat: 'dev', cycle: 1, label: 'dev', base: baseFor() }, async () => ({
      report: {},
    })),
    /closed to the dev seat/,
  );
});

// -- one round, end to end ---------------------------------------------------

test('a triage seat asks for a layer, reads its output, and reports on it', async (t) => {
  const { ctx } = fixture(t);
  ctx.runSeat = seatQueue(ctx, [asks('acceptance'), COVERED]);
  const base = baseFor();
  const outcome = await triageStep(ctx, base, { cycle: 1, reds: REDS, priorOpen: [] });

  assert.equal(outcome.fail, undefined);
  assert.equal(outcome.open.length, 1);
  assert.equal(ctx.runSeat.calls.length, 2, 'the second round is a fresh invocation');

  const runs = probeRuns(ctx);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].layer, 'acceptance');
  assert.equal(runs[0].requestedBy, 'verdict-triage');
  assert.equal(runs[0].exit, 1);
  assert.equal(runs[0].refused, undefined);

  // The second brief carries what the command printed; the ledger does not.
  assert.match(ctx.runSeat.calls[1].roleBlock, /the acceptance suite said boom/);
  assert.equal(runs[0].output, undefined, 'the command output reached the ledger');
  assert.ok(existsSync(runs[0].record));
  assert.match(readFileSync(runs[0].record, 'utf8'), /the acceptance suite said boom/);
});

test('a report that asks for a probe is not judged on coverage', async (t) => {
  const { ctx } = fixture(t);
  // The asking report names no finding for the red layer at all. Held to the
  // coverage rules it would spend the corrective invocation and fail the seat.
  ctx.runSeat = seatQueue(ctx, [asks('acceptance'), COVERED]);
  const outcome = await triageStep(ctx, baseFor(), { cycle: 1, reds: REDS, priorOpen: [] });
  assert.equal(outcome.fail, undefined);
  assert.ok(!events(ctx).some((e) => e.event === 'seat-failure'));
});

test('the second round is written under its own label, so no report is overwritten', async (t) => {
  const { ctx } = fixture(t);
  ctx.runSeat = seatQueue(ctx, [asks('acceptance'), COVERED]);
  await triageStep(ctx, baseFor(), { cycle: 1, reds: REDS, priorOpen: [] });
  const names = ctx.runSeat.calls.map((c) => c.reportPath);
  assert.match(names[0], /verdict-triage-c1\.json$/);
  assert.match(names[1], /verdict-triage-c1-p1\.json$/);
});

// -- the refusals ------------------------------------------------------------

test('a name that is not a Tier-1 layer is refused, and the refusal is stamped', async (t) => {
  const { ctx } = fixture(t);
  ctx.runSeat = seatQueue(ctx, [asks('deploy-to-production'), COVERED]);
  const outcome = await triageStep(ctx, baseFor(), { cycle: 1, reds: REDS, priorOpen: [] });
  assert.equal(outcome.fail, undefined);
  const runs = probeRuns(ctx);
  assert.equal(runs.length, 1, 'the request the rules turned down left no record');
  assert.equal(runs[0].refused, 'not-a-tier1-layer');
  assert.equal(runs[0].exit, undefined);
  assert.equal(runs[0].record, undefined);
  // The next round reads the refusal and the names it may use instead.
  assert.match(ctx.runSeat.calls[1].roleBlock, /refused \(not-a-tier1-layer\)/);
  assert.match(ctx.runSeat.calls[1].roleBlock, /the gate table names: acceptance, lint/);
});

test('a layer whose credential this host does not declare eligible is refused', async (t) => {
  const { ctx } = fixture(t, { probeCredentials: [] });
  ctx.runSeat = seatQueue(ctx, [asks('acceptance'), COVERED]);
  const base = baseFor({
    credentials: [{ name: 'pay', env: SECRET, probe: 'lint', layers: ['acceptance'] }],
  });
  await triageStep(ctx, base, { cycle: 1, reds: REDS, priorOpen: [] });
  const runs = probeRuns(ctx);
  assert.equal(runs[0].refused, 'credential-not-eligible');
  assert.deepEqual(runs[0].credentials, [SECRET]);
  assert.match(ctx.runSeat.calls[1].roleBlock, new RegExp(SECRET));
});

test('the same layer runs once this host declares its credential eligible', async (t) => {
  const { ctx } = fixture(t, { probeCredentials: [SECRET] });
  ctx.runSeat = seatQueue(ctx, [asks('acceptance'), COVERED]);
  const base = baseFor({
    credentials: [{ name: 'pay', env: SECRET, probe: 'lint', layers: ['acceptance'] }],
  });
  await triageStep(ctx, base, { cycle: 1, reds: REDS, priorOpen: [] });
  const runs = probeRuns(ctx);
  assert.equal(runs[0].refused, undefined);
  assert.equal(runs[0].exit, 1);
});

test('the round budget is spent, and the report the seat wrote with the ask stands', async (t) => {
  const { ctx } = fixture(t);
  const asking = { ...COVERED, probe: { layer: 'acceptance', reason: 'once more' } };
  ctx.runSeat = seatQueue(ctx, [asks('acceptance'), asks('acceptance'), asking]);
  const outcome = await triageStep(ctx, baseFor(), { cycle: 1, reds: REDS, priorOpen: [] });

  assert.equal(outcome.fail, undefined);
  assert.equal(outcome.open.length, 1, 'the last report is the verdict');
  const runs = probeRuns(ctx);
  assert.equal(runs.filter((e) => !e.refused).length, PROBE_ROUNDS);
  assert.equal(runs[runs.length - 1].refused, 'no-rounds-left');
  assert.equal(ctx.runSeat.calls.length, PROBE_ROUNDS + 1);
  assert.match(ctx.runSeat.calls[2].roleBlock, /No replay probe is left in this session/);
});

// -- what the seat is never given --------------------------------------------

test('a value this host calls a secret is replaced in the output the seat reads', async (t) => {
  const { ctx } = fixture(t, { probeCredentials: [SECRET] });
  ctx.runSeat = seatQueue(ctx, [asks('acceptance'), COVERED]);
  const base = baseFor({
    command: PRINTS_SECRET,
    credentials: [{ name: 'pay', env: SECRET, probe: 'lint', layers: ['acceptance'] }],
    env: { [SECRET]: SECRET_VALUE },
  });
  await triageStep(ctx, base, { cycle: 1, reds: REDS, priorOpen: [] });

  const brief = ctx.runSeat.calls[1].roleBlock;
  assert.match(brief, new RegExp(`key was \\[redacted:${SECRET}\\]`));
  assert.ok(!brief.includes(SECRET_VALUE), 'the credential reached the seat');
  const record = probeRuns(ctx)[0].record;
  assert.ok(!readFileSync(record, 'utf8').includes(SECRET_VALUE));
});

test('redaction replaces the longest value first, so one secret cannot cut another', () => {
  const pairs = [
    ['LONG', 'abcdefghij'],
    ['SHORT', 'abcdef'],
  ].sort((a, b) => b[1].length - a[1].length);
  assert.equal(redactSecrets('abcdefghij', pairs), '[redacted:LONG]');
});

// -- resume ------------------------------------------------------------------

test('a run that died between two rounds resumes into the round it was in', async (t) => {
  const { ctx } = fixture(t);
  ctx.runSeat = seatQueue(ctx, [asks('acceptance'), COVERED]);
  await triageStep(ctx, baseFor(), { cycle: 1, reds: REDS, priorOpen: [] });
  assert.equal(probeRuns(ctx).length, 1);

  // The stage runs again over the same ledger: the findings are stamped, so
  // triage rebuilds from the report of the round the seat ended on.
  const second = seatQueue(ctx, [COVERED]);
  ctx.runSeat = second;
  const outcome = await triageStep(ctx, baseFor(), { cycle: 1, reds: REDS, priorOpen: [] });
  assert.equal(second.calls.length, 0, 'a settled triage bought another seat session');
  assert.equal(outcome.open.length, 1);
  assert.equal(probeRuns(ctx).length, 1, 'a settled triage ran the probe again');
});

test('a round whose seat already answered is never bought twice', async (t) => {
  const { ctx } = fixture(t);
  // The state a daemon that died between the report and the probe leaves: the
  // round-zero report is on disk and stamped, with no `probe-run` behind it.
  const path = join(ctx.paths.runs, 'r1', 'reports', 'verdict-triage-c1.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(asks('acceptance')));
  ctx.store.append('seat-report', {
    actor: 'verdict-triage',
    seat: 'verdict-triage',
    path,
    attempt: 1,
  });

  const second = seatQueue(ctx, [COVERED]);
  ctx.runSeat = second;
  const outcome = await triageStep(ctx, baseFor(), { cycle: 1, reds: REDS, priorOpen: [] });
  assert.equal(outcome.fail, undefined);
  assert.equal(probeRuns(ctx).length, 1, 'the probe the first pass owed never ran');
  assert.equal(second.calls.length, 1, 'round zero was bought a second time');
  assert.match(second.calls[0].reportPath, /verdict-triage-c1-p1\.json$/);
});

// -- the verifier ------------------------------------------------------------

test('the Fury verifier spends a round the same way triage does', async (t) => {
  const { ctx } = fixture(t);
  const review = {
    findings: [
      {
        lens: 'security',
        severity: 'HIGH',
        finding: 'the token check is skipped when the provider is absent',
        evidence: 'src/pay.mjs:41',
      },
    ],
    summary: 'one high',
  };
  const askThen = {
    results: [],
    summary: 'asking first',
    probe: { layer: 'acceptance', reason: 'see what the provider answers here' },
  };
  const verdicts = {
    results: [{ id: 'new-1', verdict: 'confirmed', evidence: 'the replay reproduced it' }],
    summary: 'confirmed',
  };
  ctx.runSeat = seatQueue(ctx, [review, askThen, verdicts]);
  const outcome = await generalistReview(ctx, baseFor(), {
    cycle: 1,
    diffText: 'diff',
    priorConfirmed: [],
  });

  assert.equal(outcome.fail, undefined);
  assert.equal(outcome.confirmed.length, 1);
  const runs = probeRuns(ctx);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].requestedBy, 'fury-verifier');
  assert.match(ctx.runSeat.calls[2].reportPath, /fury-verifier-c1-p1\.json$/);
  assert.match(ctx.runSeat.calls[2].roleBlock, /the acceptance suite said boom/);
});

// -- mechanical attribution --------------------------------------------------

test('a red layer whose declared credential is absent names the variable', async (t) => {
  const { ctx } = fixture(t);
  const credentials = [{ name: 'pay', env: ABSENT, probe: 'lint', layers: ['acceptance'] }];
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'suite' }],
    commands: { suite: RED },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
    credentials,
  });
  assert.deepEqual(results[0].credentialAbsent, [ABSENT]);
  const result = events(ctx).find((e) => e.event === 'layer-result');
  assert.deepEqual(result.credentialAbsent, [ABSENT]);
});

test('a green layer is never attributed to a credential it did not need', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'suite' }],
    commands: { suite: GREEN },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
    credentials: [{ name: 'pay', env: ABSENT, probe: 'lint', layers: ['acceptance'] }],
  });
  assert.equal(results[0].status, 'green');
  assert.equal(results[0].credentialAbsent, undefined);
  const result = events(ctx).find((e) => e.event === 'layer-result');
  assert.equal(result.credentialAbsent, undefined);
});

test('the attribution reaches triage before the seat reads a line of the output', async (t) => {
  const { ctx } = fixture(t);
  ctx.runSeat = seatQueue(ctx, [COVERED]);
  const reds = [{ layer: 'acceptance', status: 'red', output: 'boom', credentialAbsent: [ABSENT] }];
  await triageStep(ctx, baseFor(), { cycle: 1, reds, priorOpen: [] });
  assert.match(
    ctx.runSeat.calls[0].roleBlock,
    new RegExp(`declares this layer needs ${ABSENT}, and this host holds no value`),
  );
});

test('a declaration for another layer attributes nothing, and an empty value counts as absent', () => {
  const credentials = [
    { name: 'pay', env: ABSENT, probe: 'lint', layers: ['acceptance'] },
    { name: 'mail', env: SECRET, probe: 'lint', layers: ['acceptance'] },
  ];
  assert.deepEqual(absentCredentials(credentials, 'lint', {}), []);
  assert.deepEqual(absentCredentials(credentials, 'acceptance', { [SECRET]: '   ' }), [
    ABSENT,
    SECRET,
  ]);
  assert.deepEqual(absentCredentials(credentials, 'acceptance', { [SECRET]: 'held' }), [ABSENT]);
});

// -- the config surfaces -----------------------------------------------------

test('the eligible names are exact: a pattern would widen what is exposed', () => {
  const errors = (probeCredentials) =>
    validateInstanceConfig({ version: 1, probeCredentials }).map((e) => e.path);
  assert.deepEqual(errors([SECRET]), []);
  assert.deepEqual(errors(['STRIPE_*']), ['probeCredentials.STRIPE_*']);
  assert.deepEqual(errors(['*']), ['probeCredentials.*']);
  assert.deepEqual(errors([SECRET, SECRET]), [`probeCredentials.${SECRET}`]);
  assert.deepEqual(errors('nope'), ['probeCredentials']);
});

test('a credential names the Tier-1 layers that need it, and only layers that exist', () => {
  const config = (layers) => ({
    version: 1,
    commands: { suite: GREEN, prove: GREEN },
    gates: { tier1: [{ name: 'acceptance', command: 'suite' }] },
    credentials: [{ name: 'pay', env: SECRET, probe: 'prove', ...(layers && { layers }) }],
  });
  assert.deepEqual(validateProjectConfig(config(['acceptance'])), []);
  assert.deepEqual(validateProjectConfig(config()), []);
  assert.deepEqual(
    validateProjectConfig(config(['nowhere'])).map((e) => e.path),
    ['credentials[0].layers[0]'],
  );
  assert.deepEqual(
    validateProjectConfig(config([])).map((e) => e.path),
    ['credentials[0].layers'],
  );
});

test('the probe output path lands inside the run, so it archives with it', (t) => {
  const { paths } = fixture(t);
  const path = probeOutputPath(paths, 'r1', 'verdict-triage-c1-p1');
  assert.ok(path.startsWith(join(paths.runs, 'r1')));
  assert.match(path, /probes[\\/]verdict-triage-c1-p1\.txt$/);
});
