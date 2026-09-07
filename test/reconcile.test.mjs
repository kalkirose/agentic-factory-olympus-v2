// The reconcile stage (ADR-0075): the records are judged between the verdict
// and the update, and nothing in the stage changes a verdict.
//
// The step derivation is read as a pure function over a ledger, because that is
// what a restart reads. The rest runs on a fixture repository through the real
// daemon, because the sequential writers, the per-record commits, the record
// layers and the take-backs are all about a tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, archivedRunLedgerPath, runLedgerPath } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { commitAll, headSha } from '../src/isolation/tree.mjs';
import { reconcileStep, reconcileTicketFromBranch } from '../src/lanes/reconcile.mjs';
import { withReconcileStage } from '../src/lanes/records-stage.mjs';
import { RECORD_CRITERION_KEYS } from '../src/lanes/lenses.mjs';
import { recordUnits } from '../src/lanes/units.mjs';
import { kindTest } from '../src/lanes/records.mjs';
import {
  tempDir,
  removeDir,
  waitFor,
  initOriginRepo,
  projectConfigJson,
  gitSync,
  NO_WAIT,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';
const TICKET_PATH = 'tickets/t1.md';
const ADR = 'docs/adr/adr-0001-double-the-input.md';
const ADR_TWO = 'docs/adr/adr-0002-hold-the-base.md';
const TEMPLATE = 'docs/adr/TEMPLATE.md';

const ADR_TEXT = [
  '# ADR-0001: Double the input',
  '',
  '**Status:** Accepted',
  '',
  '## Decision',
  '',
  'The module src/base.mjs holds the base value.',
  '',
  '## Consequences',
  '',
  'The doubling is not yet implemented.',
  '',
].join('\n');

const ADR_REWRITTEN = ADR_TEXT.replace(
  'The doubling is not yet implemented.',
  'The module src/feature.mjs doubles the base value.',
);

const ADR_CORRECTED = ADR_REWRITTEN.replace(
  'The module src/base.mjs holds the base value.',
  'The module src/base.mjs holds the base value the feature reads.',
);

const ADR_TWO_TEXT = [
  '# ADR-0002: Hold the base',
  '',
  '**Status:** Accepted',
  '',
  '## Decision',
  '',
  'The module src/base.mjs exports one value.',
  '',
].join('\n');

/**
 * The unit answers a seat reports for one record: one entry per unit of the
 * text, in the kinds the harness's own enumerator gives them.
 *
 * The fixture answers the enumeration rather than a list of its own, because
 * the unit check counts the file and a fixture that guessed would be testing
 * its own guess.
 */
function units(record, text) {
  return recordUnits(text).map((unit) => ({
    record,
    id: unit.id,
    kind: unitKind(unit),
    verdict: 'holds',
    evidence: unitKind(unit) === 'claim' ? 'src/base.mjs' : 'structure',
  }));
}

/** The kind a fixture seat files a unit under: a claim where the check says so. */
function unitKind(unit) {
  if (unit.kind) return unit.kind;
  return kindTest(unit.head) ?? 'rationale';
}

/** The unit answers a review seat reports, read off the brief it was given. */
function unitsFromBrief(prompt, record) {
  return [...prompt.matchAll(/^- (U\d+) \(line \d+(?:, (\w+))?\): (.+)$/gm)].map(
    ([, id, kind, head]) => ({
      record,
      id,
      kind: kind ?? (kindTest(head) ?? 'rationale'),
      verdict: 'holds',
      evidence: kind ? 'structure' : (kindTest(head) ? 'src/base.mjs' : 'structure'),
    }),
  );
}

const NO_DIVERGENCE = (record) => [
  { record, state: 'none', statement: 'the record and the tree say one thing', evidence: record },
];

// -- fixture machinery -------------------------------------------------------

function fixtureParse(line) {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    return { cost: parsed.cost, note: parsed.note, meta: parsed.meta };
  } catch {
    return null;
  }
}

function seatScript({ reportPath, model, report, files = {}, hang = false }) {
  const stmts = [
    "const fs = require('fs');",
    "const path = require('path');",
    `console.log(${JSON.stringify(JSON.stringify({ meta: { model }, cost: 0.5 }))});`,
  ];
  for (const [file, content] of Object.entries(files)) {
    stmts.push(
      `fs.mkdirSync(path.dirname(${JSON.stringify(file)}), { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)});`,
    );
  }
  if (hang) return [...stmts, 'setInterval(() => {}, 1 << 30);'].join('\n');
  stmts.push(
    `fs.mkdirSync(path.dirname(${JSON.stringify(reportPath)}), { recursive: true });`,
    `fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});`,
    'process.exit(0);',
  );
  return stmts.join('\n');
}

/** The seat table, keyed on the base seat name: a slot suffix is not a seat. */
function seatFixture(seats) {
  const calls = [];
  const commandFor = (opts) => {
    const full = /You are the (\S+) seat/.exec(opts.prompt)[1];
    const seat = full.split(':')[0];
    const slot = Number(full.split(':')[1] ?? 0);
    const lines = opts.prompt.split('\n');
    const contract = lines.findIndex((l) => l.includes('write your JSON report to this file'));
    const reportPath = lines[contract + 1];
    calls.push({
      seat,
      full,
      slot,
      label: basename(reportPath, '.json'),
      attempt: opts.attempt,
      prompt: opts.prompt,
      denyTools: opts.denyTools,
    });
    const behavior = seats[seat];
    if (!behavior) throw new Error(`no fixture behavior for seat ${seat}`);
    const out = behavior({ seat, full, slot, prompt: opts.prompt, attempt: opts.attempt }) ?? {};
    return {
      cmd: process.execPath,
      args: ['-e', seatScript({ reportPath, model: opts.model, ...out })],
      parseLine: fixtureParse,
    };
  };
  return { commandFor, calls };
}

/**
 * A daemon over a fixture repository with one lane: a seed stage that plants a
 * code commit and the green verdict behind it, then the real reconcile stage,
 * then a close.
 *
 * The seed is what makes this a stage test and not a lane test. The stage reads
 * the ledger for the pass's opening sha and the tree for the records, and both
 * are facts a seed can state exactly.
 */
function stageFixture(
  t,
  {
    seats,
    config = {},
    files = {},
    lane = 'repair',
    seed = null,
    records = true,
    holdUpdate = false,
    repairOnce = false,
  } = {},
) {
  const root = tempDir();
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson({
      repo: {
        testPaths: ['tests'],
        recordPaths: ['docs/adr', `!${TEMPLATE}`],
        ...(config.repo ?? {}),
      },
      commands: { adrform: [process.execPath, '-e', 'process.exit(0)'] },
      gates: { tier1: [{ name: 'adr-form', command: 'adrform' }], recordLayers: ['adr-form'] },
      stack: null,
      ...config,
    }),
    [TICKET_PATH]: '# Ticket\n\n## The work\n\nState the decision the tree holds.\n',
    'src/base.mjs': 'export const base = 1;\n',
    ...(records ? { [ADR]: ADR_TEXT, [TEMPLATE]: '# ADR-<id>\n\n**Status:** Accepted\n' } : {}),
    ...files,
  });
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { proj: { repoUrl: origin, slotCap: 2 } } }) + '\n',
  );
  // The stage after the reconciliation. It closes the run, and a scenario about
  // the boundary behind the render holds it there once: the first entry waits
  // for the stop, and the daemon that comes back closes.
  let held = false;
  let repaired = false;
  const shipStub = {
    stages: ['update'],
    handlers: {
      update: async (ctx) => {
        if (holdUpdate && !held) {
          held = true;
          while (!ctx.stopped()) await new Promise((resolve) => setTimeout(resolve, 20));
          return null;
        }
        // A scenario about the recheck sends the run back for one repair round.
        if (repairOnce && !repaired) {
          repaired = true;
          return { next: 'seed' };
        }
        return { close: { state: 'shipped' } };
      },
    },
  };
  const reconcile = withReconcileStage(shipStub);
  const lanes = {
    [lane]: {
      stages: ['seed', ...reconcile.stages],
      handlers: { seed: seed ?? seedHandler(), ...reconcile.handlers },
    },
  };
  let daemon = new Daemon(join(root, 'home'), { waitSleep: NO_WAIT, lanes });
  const fixture = seatFixture(seats);
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  return {
    root,
    origin,
    paths,
    calls: fixture.calls,
    get daemon() {
      return daemon;
    },
    async restart() {
      await daemon.stop();
      daemon = new Daemon(join(root, 'home'), { waitSleep: NO_WAIT, lanes });
      await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: fixture.commandFor });
    },
    async launch(payload = {}) {
      if (!daemon.running) await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: fixture.commandFor });
      const { runId } = await daemon.launchRun({
        project: 'proj',
        lane,
        ticket: TICKET_PATH,
        ...payload,
      });
      return runId;
    },
  };
}

/**
 * The seed: one code commit, and the green verdict that certified it. The stage
 * reads `implementation-committed.baseSha` as the pass's opening sha, so the
 * record range opens on the tree before this commit.
 */
function seedHandler(extra = null) {
  return async (ctx) => {
    const worktree = ctx.payload.worktree;
    const baseSha = await headSha(worktree);
    writeFileSync(join(worktree, 'src/feature.mjs'), 'export const f = (x) => 2 * x;\n');
    const sha = await commitAll(worktree, 'implement: seed');
    ctx.store.append('implementation-committed', { actor: 'daemon', pass: 1, phase: 'initial', baseSha, sha });
    ctx.store.append('verdict-rendered', {
      actor: 'daemon',
      cycle: 1,
      pass: 1,
      sha,
      sweep: 'full',
      verdict: 'green',
      open: [],
      record: join(ctx.paths.runs, ctx.runId, 'verdict-1.json'),
    });
    if (extra) await extra(ctx, { baseSha, sha });
    return { next: 'reconcile' };
  };
}

async function waitClosed(paths, runId, attempts = 900) {
  try {
    await waitFor(() => existsSync(archivedRunLedgerPath(paths, runId)), {
      label: `run ${runId} archived`,
      attempts,
      intervalMs: 100,
    });
  } catch (error) {
    const live = runLedgerPath(paths, runId);
    const line = (e) =>
      [
        e.seq,
        e.event,
        e.seat ?? e.stage ?? e.layer ?? '',
        e.verdict ?? e.reason ?? e.cause ?? '',
        (e.question ?? e.detail ?? e.note ?? '').toString().slice(0, 1200),
      ].join(' ');
    const tail = existsSync(live)
      ? readEvents(live)
          .filter((e) => e.event !== 'stage-heartbeat')
          .slice(-24)
          .map(line)
      : ['no live ledger'];
    error.message += `\nledger tail:\n${tail.join('\n')}`;
    throw error;
  }
  return readEvents(archivedRunLedgerPath(paths, runId));
}

function waitEvent(paths, runId, predicate, label, attempts = 900) {
  return waitFor(() => readEvents(runLedgerPath(paths, runId)).find(predicate), {
    label,
    attempts,
    intervalMs: 100,
  });
}

// -- the seat table ----------------------------------------------------------

/** The judge: owed on the records the fixture names. */
const judgeOwed =
  (records = [ADR]) =>
  () => ({
    report: { owed: true, records, reason: 'the diff implements the doubling decision' },
  });

const judgeClean = () => ({
  report: { owed: false, records: [], reason: 'no record the diff implicates' },
});

/** A writer that rewrites the record it was given and answers every unit. */
function writeOnce(contents = { [ADR]: ADR_REWRITTEN }) {
  return ({ prompt }) => {
    const record = Object.keys(contents).find((r) => prompt.includes(`- ${r}`));
    const text = contents[record];
    return {
      files: { [record]: text },
      report: {
        rewritten: [record],
        unchanged: [],
        units: units(record, text),
        divergences: NO_DIVERGENCE(record),
        summary: 'the record states what the tree holds',
      },
    };
  };
}

/** A writer whose first dispatch writes and whose later ones correct. */
function writeThenCorrect(second = ADR_CORRECTED) {
  const seen = new Map();
  return ({ prompt, full }) => {
    const record = [ADR, ADR_TWO].find((r) => prompt.includes(`- ${r}`)) ?? ADR;
    const round = (seen.get(full) ?? 0) + 1;
    seen.set(full, round);
    const text = round === 1 ? ADR_REWRITTEN : second;
    const corrective = prompt.includes('Confirmed findings:');
    return {
      files: { [record]: text },
      report: {
        rewritten: [record],
        unchanged: [],
        units: units(record, text),
        divergences: NO_DIVERGENCE(record),
        ...(corrective && { answered: findingIds(prompt) }),
        summary: 'the record states what the tree holds',
      },
    };
  };
}

/** The finding ids a corrective brief carries, in the order it states them. */
function findingIds(prompt) {
  return [...prompt.matchAll(/^- \[(F\d+)\]/gm)].map((m) => m[1]);
}

/**
 * A record review seat that raises one finding per cycle, then none.
 *
 * The finding names a unit the same report answers `fails`, because a finding on
 * a unit the seat called `holds` is a work-product defect the check refuses
 * (rule 8, ADR-0073). The fixture answers the rule rather than working around
 * it: a report the harness would refuse proves nothing about the stage.
 */
function recordReview(summaries) {
  let cycle = 0;
  return ({ prompt }) => {
    const record = recordOf(prompt);
    const summary = summaries[cycle];
    cycle += 1;
    const answers = unitsFromBrief(prompt, record);
    const target = answers.find((u) => u.kind === 'claim') ?? answers.at(-1);
    if (summary && target) target.verdict = 'fails';
    return {
      report: {
        findings:
          summary && target
            ? [
                {
                  id: 'r1',
                  criterion: RECORD_CRITERION_KEYS[0],
                  severity: 'HIGH',
                  file: record,
                  unit: target.id,
                  head: headOf(prompt, target.id),
                  line: 1,
                  summary,
                  evidence: 'src/base.mjs',
                },
              ]
            : [],
        units: answers,
        summary: 'the record against the tree',
      },
    };
  };
}

/** A clean record review: every unit answered, nothing raised. */
const reviewClean = ({ prompt }) => {
  const record = recordOf(prompt);
  return {
    report: {
      findings: [],
      units: unitsFromBrief(prompt, record),
      summary: 'the record stands',
    },
  };
};

/** The record a review brief opens with. */
function recordOf(prompt) {
  return /^Review one decision record: (.+)$/m.exec(prompt)?.[1]?.trim() ?? ADR;
}

/** The head the harness gave one unit, off the brief's own enumeration. */
function headOf(prompt, id) {
  return new RegExp(`^- ${id} \\(line \\d+[^)]*\\): (.+)$`, 'm').exec(prompt)?.[1] ?? id;
}

/** The verifier: confirm what it is asked to confirm, resolve prior findings. */
const confirmAndResolve = ({ prompt }) => ({
  report: {
    results: [...prompt.matchAll(/^- \[([^\]]+)\] \((confirm|resolution-check)\)/gm)].map(
      ([, id, mode]) => ({
        id,
        verdict: mode === 'confirm' ? 'confirmed' : 'resolved',
        evidence: 'the tree does not hold what the record states',
      }),
    ),
    summary: 'verified',
  },
});

/**
 * A seat that never answers its first dispatch. Only a stop ends it, so a
 * scenario about a restart at one step boundary can hold the run exactly there.
 */
function hangFirst(behaviour) {
  let first = true;
  return (opts) => {
    if (!first) return behaviour(opts);
    first = false;
    return { hang: true };
  };
}

/** The verifier that refutes every new claim: a clean render behind a review. */
const refuteAll = ({ prompt }) => ({
  report: {
    results: [...prompt.matchAll(/^- \[([^\]]+)\] \((confirm|resolution-check)\)/gm)].map(
      ([, id, mode]) => ({
        id,
        verdict: mode === 'confirm' ? 'refuted' : 'resolved',
        evidence: 'the tree holds what the record states',
      }),
    ),
    summary: 'verified',
  },
});

// -- the step derivation -----------------------------------------------------

/** A fabricated ledger: the events in order, with the seqs a store would give. */
function ledger(...events) {
  return events.map((e, i) => ({ seq: i + 1, ...e }));
}

test('the stage derives every one of its steps from its own stamps', () => {
  assert.equal(reconcileStep([]), 'judge');
  // Nothing owed, and a judgment nobody could make: both are done.
  assert.equal(reconcileStep(ledger({ event: 'reconciliation-judged', ok: false })), 'done');
  assert.equal(
    reconcileStep(ledger({ event: 'reconciliation-judged', ok: true, owed: false })),
    'done',
  );
  const judged = { event: 'reconciliation-judged', ok: true, owed: true, records: [ADR] };
  assert.equal(reconcileStep(ledger(judged)), 'write');
  // A fallback is the stage's last word.
  assert.equal(
    reconcileStep(ledger(judged, { event: 'reconciliation-written', ok: false, cause: 'operator' })),
    'done',
  );
  const written = {
    event: 'reconciliation-written',
    ok: true,
    rewritten: [ADR],
    records: [{ record: ADR, seat: 'reconcile-write:1' }],
  };
  assert.equal(reconcileStep(ledger(judged, written)), 'spectrum');
  const layer = { event: 'layer-result', cycle: 1, layer: 'adr-form', status: 'green' };
  assert.equal(reconcileStep(ledger(judged, written, layer)), 'review');
  const unitsStamp = { event: 'record-units', cycle: 1, record: ADR, seat: 'record-review:1' };
  assert.equal(reconcileStep(ledger(judged, written, layer, unitsStamp)), 'verify');
  const verified = { event: 'seat-report', seat: 'fury-verifier' };
  assert.equal(reconcileStep(ledger(judged, written, layer, unitsStamp, verified)), 'render');
  const green = { event: 'reconcile-rendered', cycle: 1, sha: 'aaa', verdict: 'green', open: [] };
  const red = { ...green, verdict: 'red', open: ['F1'] };
  assert.equal(reconcileStep(ledger(judged, written, layer, unitsStamp, verified, green)), 'done');
  assert.equal(
    reconcileStep(ledger(judged, written, layer, unitsStamp, verified, red)),
    'correct',
  );
  // The cap stops the corrective rounds and takes the fallback.
  assert.equal(
    reconcileStep(
      ledger(judged, written, layer, unitsStamp, verified, red, {
        event: 'reconcile-round',
        round: 1,
      }),
      { cap: 1 },
    ),
    'stall',
  );
  // A fresh pass discards every statement about the tree it reset.
  assert.equal(
    reconcileStep(ledger(judged, written, layer, unitsStamp, verified, green, { event: 'fresh-pass' })),
    'judge',
  );
});

test('a repair round past a green render owes the recheck, and a re-run owes a cycle', () => {
  const base = ledger(
    { event: 'reconciliation-judged', ok: true, owed: true, records: [ADR] },
    { event: 'reconciliation-written', ok: true, rewritten: [ADR], records: [] },
    { event: 'layer-result', cycle: 1, layer: 'adr-form', status: 'green' },
    { event: 'record-units', cycle: 1, record: ADR, seat: 'record-review:1' },
    { event: 'seat-report', seat: 'fury-verifier' },
    { event: 'reconcile-rendered', cycle: 1, sha: 'aaa', verdict: 'green', open: [] },
  );
  assert.equal(reconcileStep(base), 'done');
  const repaired = [...base, { seq: 7, event: 'repair-round', pass: 1, round: 1 }];
  assert.equal(reconcileStep(repaired), 'recheck');
  // One recheck per round: the stamp closes the question the round opened.
  assert.equal(
    reconcileStep([...repaired, { seq: 8, event: 'reconcile-recheck', result: 'kept' }]),
    'done',
  );
  // A record re-run past the render owes a whole cycle over the merged tree.
  assert.equal(
    reconcileStep([
      ...base,
      { seq: 7, event: 'pre-verdict-update', ran: true, records: { answer: 'rerun', files: [] } },
    ]),
    'spectrum',
  );
  assert.equal(
    reconcileStep([
      ...base,
      { seq: 7, event: 'pre-verdict-update', ran: true, records: { answer: 'kept', files: [] } },
    ]),
    'done',
  );
});

// -- the stage end to end ----------------------------------------------------

test('an owed judgment writes the record, runs the record layers and renders green', async (t) => {
  const fx = stageFixture(t, {
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeOnce(),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');

  const judged = events.find((e) => e.event === 'reconciliation-judged');
  assert.deepEqual(judged.records, [ADR]);
  // The record was not born in this run, so the judge found it late.
  assert.deepEqual(judged.born, []);
  assert.deepEqual(judged.late, [ADR]);

  const written = events.find((e) => e.event === 'reconciliation-written');
  assert.equal(written.ok, true);
  assert.deepEqual(written.rewritten, [ADR]);
  assert.equal(written.records.length, 1);
  assert.equal(written.records[0].record, ADR);
  assert.equal(written.records[0].seat, 'reconcile-write:1');
  assert.equal(written.records[0].cost, 0.5);
  assert.equal(written.records[0].attempts, 1);
  assert.ok(written.records[0].unitsAnswered > 0);

  // The writer's per-unit answers, which the miss rate joins on.
  const writerUnits = events.find(
    (e) => e.event === 'record-units' && e.seat === 'reconcile-write:1',
  );
  assert.equal(writerUnits.record, ADR);
  assert.ok(writerUnits.units.length > 0);
  assert.equal(writerUnits.cost, 0.5);

  // The record layers ran over the record commit, with the wall clock on each.
  const layers = events.filter((e) => e.event === 'layer-result');
  assert.deepEqual([...new Set(layers.map((e) => e.layer))], ['adr-form']);
  assert.ok(layers.every((e) => typeof e.elapsedMs === 'number'));

  // The render is the stage's own, at its own sha, and the verdict is untouched.
  const rendered = events.find((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.verdict, 'green');
  assert.deepEqual(rendered.open, []);
  assert.deepEqual(rendered.records, [ADR]);
  assert.deepEqual(
    rendered.layers.map((l) => l.layer),
    ['adr-form'],
  );
  // The cycle counter continues the run's: the seed rendered cycle 1.
  assert.equal(rendered.cycle, 2);
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 1);
  assert.notEqual(rendered.sha, events.find((e) => e.event === 'verdict-rendered').sha);
});

test('a judgment that owes nothing spends no writer and hands the run on', async (t) => {
  const fx = stageFixture(t, { seats: { 'reconcile-judge': judgeClean } });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  const judged = events.find((e) => e.event === 'reconciliation-judged');
  assert.equal(judged.owed, false);
  assert.ok(!events.some((e) => e.event === 'reconciliation-written'));
  assert.ok(!events.some((e) => e.event === 'reconcile-rendered'));
  assert.ok(!fx.calls.some((c) => c.seat === 'reconcile-write'));
});

test('three records take three writers in turn, each with its own identity', async (t) => {
  const three = {
    [ADR]: ADR_REWRITTEN,
    [ADR_TWO]: ADR_TWO_TEXT + '\nThe module src/base.mjs is read by the feature.\n',
    'docs/adr/adr-0003-name-the-range.md': [
      '# ADR-0003: Name the range',
      '',
      '**Status:** Accepted',
      '',
      '## Decision',
      '',
      'The module src/base.mjs names the range.',
      '',
    ].join('\n'),
  };
  const fx = stageFixture(t, {
    files: {
      [ADR_TWO]: ADR_TWO_TEXT,
      'docs/adr/adr-0003-name-the-range.md': ADR_TWO_TEXT.replace('ADR-0002', 'ADR-0003'),
    },
    seats: {
      'reconcile-judge': judgeOwed(Object.keys(three)),
      'reconcile-write': writeOnce(three),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');

  // Three dispatches, in order, each with its own slot.
  const writers = fx.calls.filter((c) => c.seat === 'reconcile-write');
  assert.deepEqual(
    writers.map((c) => c.full),
    ['reconcile-write:1', 'reconcile-write:2', 'reconcile-write:3'],
  );
  // Each brief names its own record and no peer's.
  for (const [i, record] of Object.keys(three).entries()) {
    assert.ok(writers[i].prompt.includes(`- ${record}`), record);
    for (const other of Object.keys(three)) {
      if (other !== record) assert.ok(!writers[i].prompt.includes(`- ${other}`), other);
    }
  }
  // Three commits, and one entry per record on the write stamp.
  const written = events.find((e) => e.event === 'reconciliation-written');
  assert.equal(written.records.length, 3);
  assert.deepEqual(
    written.records.map((r) => r.seat),
    ['reconcile-write:1', 'reconcile-write:2', 'reconcile-write:3'],
  );
  assert.deepEqual(written.rewritten.sort(), Object.keys(three).sort());
  // Three record-units stamps from the writers, one per record.
  const writerUnits = events.filter(
    (e) => e.event === 'record-units' && e.seat.startsWith('reconcile-write'),
  );
  assert.equal(writerUnits.length, 3);
  assert.equal(events.find((e) => e.event === 'reconcile-rendered').verdict, 'green');
  // Three review seats, one per record, in parallel slots.
  assert.equal(fx.calls.filter((c) => c.seat === 'record-review').length, 3);
});

test('a confirmed record finding buys a corrective round, and no repair-dev runs', async (t) => {
  const fx = stageFixture(t, {
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeThenCorrect(),
      'record-review': recordReview(['the record claims a doubling the tree does not hold']),
      'fury-verifier': confirmAndResolve,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');

  const renders = events.filter((e) => e.event === 'reconcile-rendered');
  assert.equal(renders.length, 2);
  assert.equal(renders[0].verdict, 'red');
  assert.equal(renders[0].open.length, 1);
  assert.equal(renders[1].verdict, 'green');
  assert.deepEqual(renders[1].open, []);

  // The round is the stage's own, and it counts against nothing else.
  const rounds = events.filter((e) => e.event === 'reconcile-round');
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].round, 1);
  assert.deepEqual(rounds[0].records, [ADR]);
  assert.deepEqual(rounds[0].findings, renders[0].open);
  assert.ok(!events.some((e) => e.event === 'repair-round'));
  assert.ok(!fx.calls.some((c) => c.seat === 'repair-dev'));
  // The corrective brief names the finding and its unit.
  const corrective = fx.calls.filter((c) => c.seat === 'reconcile-write').at(-1);
  assert.ok(corrective.prompt.includes('Confirmed findings:'));
  // The finding names one unit, and the brief states it: a corrective round
  // answers a sentence and never a file (ADR-0073).
  const finding = events.find((e) => e.event === 'finding' && e.confirmed === true);
  assert.ok(corrective.prompt.includes(finding.unit), finding.unit);
  assert.ok(corrective.prompt.includes(finding.head), finding.head);
  // And the verdict never moved.
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 1);
});

test('a spent record cap stalls loud, ships the code and names what is open', async (t) => {
  const fx = stageFixture(t, {
    config: { gates: { tier1: [{ name: 'adr-form', command: 'adrform' }], recordLayers: ['adr-form'], reconcileRounds: 1 } },
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeThenCorrect(),
      // A different finding each cycle: the round made progress, so the cap is
      // what stops the stage and never the progress rule.
      'record-review': recordReview([
        'the record claims a doubling the tree does not hold',
        'the record cites a symbol the tree does not export',
      ]),
      'fury-verifier': confirmAndResolve,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');

  assert.equal(events.filter((e) => e.event === 'reconcile-round').length, 1);
  const stall = events.find((e) => e.event === 'reconcile-stall');
  assert.equal(stall.rounds, 1);
  assert.equal(stall.stream, 'loud');
  assert.ok(stall.open.length > 0);
  // No park, and never a fresh pass: a pass discards certified code over a
  // document.
  assert.ok(!events.some((e) => e.event === 'park'));
  assert.ok(!events.some((e) => e.event === 'fresh-pass'));

  const fallback = events.filter((e) => e.event === 'reconciliation-written').at(-1);
  assert.equal(fallback.ok, false);
  assert.equal(fallback.cause, 'record-cap');
  assert.equal(fallback.partial, true);
  assert.deepEqual(fallback.residual, stall.open);
});

test('a round that closes nothing stalls on the progress rule, whatever the cap', async (t) => {
  const fx = stageFixture(t, {
    seats: {
      'reconcile-judge': judgeOwed(),
      // The round writes, so the write check passes; what it does not do is
      // close the finding.
      'reconcile-write': writeThenCorrect(ADR_CORRECTED),
      // The same finding twice: the round moved nothing.
      'record-review': recordReview([
        'the record claims a doubling the tree does not hold',
        'the record claims a doubling the tree does not hold',
      ]),
      'fury-verifier': confirmAndResolve,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  // One round, then the stall: the default cap is five and the progress rule
  // is what stopped it.
  assert.equal(events.filter((e) => e.event === 'reconcile-round').length, 1);
  const stall = events.find((e) => e.event === 'reconcile-stall');
  assert.equal(stall.rounds, 1);
  assert.equal(events.filter((e) => e.event === 'reconciliation-written').at(-1).cause, 'record-cap');
});

test('a red record layer is a red render with the layer in the open set', async (t) => {
  const fx = stageFixture(t, {
    config: {
      commands: { adrform: [process.execPath, '-e', 'process.exit(1)'] },
      gates: {
        tier1: [{ name: 'adr-form', command: 'adrform' }],
        recordLayers: ['adr-form'],
        reconcileRounds: 1,
      },
    },
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeThenCorrect(),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  const rendered = events.find((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.verdict, 'red');
  assert.deepEqual(rendered.open, ['adr-form']);
  assert.deepEqual(rendered.layers, [{ layer: 'adr-form', status: 'red' }]);
  // The corrective round is briefed with the red layer.
  const corrective = fx.calls.filter((c) => c.seat === 'reconcile-write').at(-1);
  assert.ok(corrective.prompt.includes('These Tier-1 layers are red'));
  assert.ok(corrective.prompt.includes('- adr-form'));
});

test('a records-lane stall closes the run on the cap and tickets from the branch', async (t) => {
  const fx = stageFixture(t, {
    lane: 'records',
    config: { gates: { tier1: [{ name: 'adr-form', command: 'adrform' }], recordLayers: ['adr-form'], reconcileRounds: 1 } },
    seed: async (ctx) => {
      // The records lane runs no dev seat: the stage stands on the tree the
      // birth left.
      ctx.store.append('records-committed', {
        actor: 'daemon',
        sha: await headSha(ctx.payload.worktree),
        paths: [ADR],
        decided: true,
      });
      return { next: 'reconcile' };
    },
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeThenCorrect(),
      'record-review': recordReview([
        'the record claims a doubling the tree does not hold',
        'the record cites a symbol the tree does not export',
      ]),
      'fury-verifier': confirmAndResolve,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'reconcile-cap');
  assert.ok(existsSync(closed.ticket));
  const ticket = readFileSync(closed.ticket, 'utf8');
  assert.ok(ticket.includes('## The branch'));
  assert.ok(ticket.includes(ADR));
  assert.ok(!ticket.includes('merge commit'));
  // The stall's owner is the ticketed judgment, so the loud item has one.
  const ticketed = events.filter((e) => e.event === 'reconciliation-judged').at(-1);
  assert.equal(ticketed.ticket, closed.ticket);
  assert.equal(ticketed.cause, 'record-cap');
  // The judge found the record born in this run's own records stage.
  const judged = events.find((e) => e.event === 'reconciliation-judged');
  assert.deepEqual(judged.born, [ADR]);
  assert.deepEqual(judged.late, []);
});

test('the branch ticket names the branch, the records and the open findings', () => {
  const text = reconcileTicketFromBranch({
    ctx: { runId: 'proj-1' },
    base: { branch: 'olympus/proj-1' },
    records: [ADR],
    reason: 'the ticket decides one record',
    residual: [
      { id: 'F1', file: ADR, unit: 'U3', head: 'The module', summary: 'the claim fails', evidence: 'src/base.mjs' },
    ],
    open: ['F1', 'adr-form'],
  });
  assert.ok(text.includes('olympus/proj-1'));
  assert.ok(text.includes(`- ${ADR}`));
  assert.ok(text.includes('[F1]'));
  assert.ok(text.includes('- adr-form'));
  assert.ok(!text.includes('PR #'));
});

// -- the restart boundaries --------------------------------------------------

/**
 * A restart at one step boundary: the stage runs to the stamp the boundary is
 * behind, the daemon goes down and comes back, and the run finishes.
 */
async function restartAt(t, { at, seats }) {
  const fx = stageFixture(t, { seats });
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, at.predicate, at.label);
  await fx.restart();
  const events = await waitClosed(fx.paths, runId);
  return { fx, events };
}

test('a restart before the judge re-judges and nothing else', async (t) => {
  const { fx, events } = await restartAt(t, {
    at: { predicate: (e) => e.event === 'stage-entered' && e.stage === 'reconcile', label: 'entered' },
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeOnce(),
      'record-review': reviewClean,
    },
  });
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').length, 1);
  assert.ok(fx.calls.filter((c) => c.seat === 'reconcile-judge').length >= 1);
});

test('a restart after the judgment writes once and never twice', async (t) => {
  const { fx, events } = await restartAt(t, {
    at: { predicate: (e) => e.event === 'reconciliation-judged', label: 'judged' },
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeOnce(),
      'record-review': reviewClean,
    },
  });
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.filter((e) => e.event === 'reconciliation-judged').length, 1);
  assert.equal(events.filter((e) => e.event === 'reconciliation-written').length, 1);
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').length, 1);
  assert.equal(fx.calls.filter((c) => c.seat === 'reconcile-judge').length, 1);
});

test('a restart after the write never repeats the committed write', async (t) => {
  const { fx, events } = await restartAt(t, {
    at: { predicate: (e) => e.event === 'reconciliation-written', label: 'written' },
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeOnce(),
      'record-review': reviewClean,
    },
  });
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(fx.calls.filter((c) => c.seat === 'reconcile-write').length, 1);
  assert.equal(events.filter((e) => e.event === 'reconciliation-written').length, 1);
});

test('a restart after the spectrum keeps the layer results it already earned', async (t) => {
  const { events } = await restartAt(t, {
    at: { predicate: (e) => e.event === 'layer-result', label: 'layer-result' },
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeOnce(),
      'record-review': reviewClean,
    },
  });
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const layers = events.filter((e) => e.event === 'layer-result');
  assert.equal(layers.length, 1);
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').length, 1);
});

test('a restart between the review and the verifier renders once, from the ledger', async (t) => {
  // The boundary the verifier stands on. The review seats have reported and
  // their answers are stamped; the stop lands on the seat that settles the
  // findings, and the round the restart re-enters re-uses every id it assigned.
  const fx = stageFixture(t, {
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeThenCorrect(),
      // The same finding on every dispatch: the restart re-runs the round, and a
      // fixture that counted its own calls would answer the second one blind.
      'record-review': recordReview(
        Array(4).fill('the record claims a doubling the tree does not hold'),
      ),
      'fury-verifier': hangFirst(refuteAll),
    },
  });
  const runId = await fx.launch();
  await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'record-units' && e.seat.startsWith('record-review'),
    'reviewed',
  );
  await waitEvent(fx.paths, runId, (e) => e.event === 'seat-spawned' && e.seat === 'fury-verifier', 'verifier');
  await fx.restart();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // One unit stamp per seat per cycle, however many times the round re-entered.
  const stamps = events.filter(
    (e) => e.event === 'record-units' && e.seat.startsWith('record-review'),
  );
  assert.equal(stamps.length, 1);
  // A refuted record finding is stamped once and blocks nothing.
  assert.equal(events.filter((e) => e.event === 'finding' && e.record === true).length, 1);
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').length, 1);
  assert.equal(events.find((e) => e.event === 'reconcile-rendered').verdict, 'green');
});

test('a restart after the render never re-enters the verdict', async (t) => {
  // The stage hands the run on and the update holds it there once, so the stop
  // lands past the render and in front of the close.
  const fx = stageFixture(t, {
    holdUpdate: true,
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeOnce(),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'reconcile-rendered', 'rendered');
  await fx.restart();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').length, 1);
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 1);
  // The restart resumed at the stage the render handed the run to, and nothing
  // re-judged anything: one write, one review, one render.
  assert.equal(events.filter((e) => e.event === 'reconciliation-written').length, 1);
  assert.equal(fx.calls.filter((c) => c.seat === 'reconcile-judge').length, 1);
});

test('a restart inside a corrective round re-enters that round alone', async (t) => {
  const fx = stageFixture(t, {
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeThenCorrect(),
      'record-review': recordReview(['the record claims a doubling the tree does not hold']),
      'fury-verifier': confirmAndResolve,
    },
  });
  const runId = await fx.launch();
  await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'reconcile-rendered' && e.verdict === 'red',
    'red render',
  );
  await fx.restart();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.filter((e) => e.event === 'reconcile-round').length, 1);
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').at(-1).verdict, 'green');
});

// -- the recheck (point 14) --------------------------------------------------

/**
 * A seed that plants one repair round on its second entry. The update stub sends
 * the run back to it once, so the stage is entered twice: once for the
 * reconciliation, once for the recheck the repair owes it.
 */
function repairAfterGreen(deltaFile) {
  let seeded = false;
  return async (ctx) => {
    const worktree = ctx.payload.worktree;
    if (seeded) {
      const baseSha = await headSha(worktree);
      writeFileSync(join(worktree, deltaFile), 'export const changed = true;\n');
      const sha = await commitAll(worktree, 'repair: seed');
      ctx.store.append('implementation-committed', {
        actor: 'daemon',
        pass: 1,
        phase: 'repair',
        baseSha,
        sha,
      });
      ctx.store.append('repair-round', {
        actor: 'daemon',
        pass: 1,
        round: 1,
        cap: 3,
        sha,
        openBefore: [],
      });
      return { next: 'reconcile' };
    }
    seeded = true;
    return seedHandler()(ctx);
  };
}

test('a repair whose delta touches no evidence path stamps the recheck kept', async (t) => {
  const fx = stageFixture(t, {
    seed: repairAfterGreen('src/other.mjs'),
    // The first green render sends the run back for its repair round; the second
    // time the update closes it.
    repairOnce: true,
    seats: {
      'reconcile-judge': ({ prompt }) =>
        prompt.includes('A repair round changed this run')
          ? { report: { owed: false, records: [], reason: 'the delta implicates no record' } }
          : judgeOwed()(),
      'reconcile-write': writeOnce(),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const recheck = events.find((e) => e.event === 'reconcile-recheck');
  assert.equal(recheck.result, 'kept');
  assert.deepEqual(recheck.units, []);
  assert.ok(recheck.delta.includes('..'));
  // The recheck judged the delta alone, and the stage wrote nothing behind it.
  assert.equal(events.filter((e) => e.event === 'reconciliation-written').length, 1);
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').length, 1);
  // A corrective record round triggers no code re-verdict.
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 1);
});

test('a repair whose delta touches an evidence path re-answers that unit alone', async (t) => {
  const fx = stageFixture(t, {
    // The unit answers of this fixture cite src/base.mjs, so a repair that
    // touches it moves the evidence one claim rests on.
    seed: repairAfterGreen('src/base.mjs'),
    repairOnce: true,
    seats: {
      'reconcile-judge': ({ prompt }) =>
        prompt.includes('A repair round changed this run')
          ? { report: { owed: false, records: [], reason: 'the delta implicates no record' } }
          : judgeOwed()(),
      'reconcile-write': writeThenCorrect(),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const recheck = events.find((e) => e.event === 'reconcile-recheck');
  assert.equal(recheck.result, 're-answered');
  assert.ok(recheck.units.length > 0);
  assert.ok(recheck.units.every((u) => u.startsWith(`${ADR}#U`)));
  // The units the delta touched are re-answered and re-reviewed: a second write,
  // a second render, and the verdict untouched.
  assert.equal(events.filter((e) => e.event === 'reconciliation-written').length, 2);
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').length, 2);
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 1);
});

