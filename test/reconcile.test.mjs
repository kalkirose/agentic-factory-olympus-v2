// The reconcile stage (ADR-0075): the records are judged between the verdict
// and the update, and nothing in the stage changes a verdict.
//
// The step derivation is read as a pure function over a ledger, because that is
// what a restart reads. The rest runs on a fixture repository through the real
// daemon, because the sequential writers, the per-record commits, the record
// layers and the take-backs are all about a tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, archivedRunLedgerPath, runLedgerPath } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { commitAll, headSha } from '../src/isolation/tree.mjs';
import {
  OWED_CRITERION,
  correctiveRecords,
  reconcileCertification,
  reconcileStep,
  runRemarks,
  skippedReds,
  unreviewedOf,
  unwrittenOf,
} from '../src/lanes/reconcile.mjs';
import { withReconcileStage } from '../src/lanes/records-stage.mjs';
import { withAbandonGuard } from '../src/lanes/shared.mjs';
import { RECORD_CRITERION_KEYS } from '../src/lanes/lenses.mjs';
import { OTHER_RECORDS_LINE, recordUnits } from '../src/lanes/units.mjs';
import {
  tempDir,
  removeDir,
  waitFor,
  waitRunEvents,
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

/** A record the tree has closed: out of every seat's scope and every brief. */
const CLOSED_ADR = 'docs/adr/adr-0009-hold-the-gateway.md';
const CLOSED_TEXT = [
  '# ADR-0009: Hold the gateway',
  '',
  '**Status:** Superseded by ADR-0001 (2026-09-02)',
  '',
  '## Decision',
  '',
  'The module src/base.mjs held the gateway.',
  '',
].join('\n');

const RECORD_SENTENCE = 'A record in docs/adr named in neither list is closed';

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

/** The records a write brief was dispatched over, off its own list. */
function briefRecords(prompt) {
  const block = /^Records to reconcile:\n((?:- \S+\n)+)/m.exec(prompt);
  return block
    ? block[1]
        .trim()
        .split('\n')
        .map((line) => line.slice(2))
    : [];
}

/** The one record a write brief was dispatched over, where it holds one. */
function briefRecord(prompt) {
  return briefRecords(prompt)[0] ?? null;
}

/** The records a review brief opens with: one seat reads the set (ADR-0090). */
function reviewRecords(prompt) {
  const one = /^Review one decision record: (.+)$/m.exec(prompt);
  if (one) return [one[1].trim()];
  const many = /^Review these \d+ decision records:\n((?:- \S+\n)+)/m.exec(prompt);
  return many
    ? many[1]
        .trim()
        .split('\n')
        .map((line) => line.slice(2))
    : [];
}

/** The units a record brief names, as addresses: the id, the kind, the head. */
function briefUnits(prompt) {
  return [...prompt.matchAll(/^- (U\d+) \(line \d+(?:, (\w+))?\): (.+)$/gm)].map(
    ([, id, kind, head]) => ({ id, kind, head }),
  );
}

/** The unit list of one record, off a brief that carries several (ADR-0090). */
function briefUnitsFor(prompt, record) {
  const start = prompt.indexOf(`The units of ${record},`);
  if (start === -1) return [];
  const rest = prompt.slice(start);
  const end = rest.indexOf('\nRead the same list yourself:');
  return briefUnits(end === -1 ? rest : rest.slice(0, end));
}

/** The unit a finding on one record names: the first the brief calls no structure. */
function targetUnitFor(prompt, record) {
  const units = briefUnitsFor(prompt, record);
  return units.find((u) => u.kind === undefined) ?? units.at(-1) ?? null;
}

/** The unit a review finding names, where the brief carries one record. */
function targetUnit(prompt) {
  const units = briefUnits(prompt);
  return units.find((u) => u.kind === undefined) ?? units.at(-1) ?? null;
}

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

function seatScript({ reportPath, model, report, files = {}, hang = false, invalid = false }) {
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
  // `invalid` writes no JSON the schema names. It is the one refusal a record
  // write still takes, and the runner is what makes it (ADR-0080).
  stmts.push(
    `fs.mkdirSync(path.dirname(${JSON.stringify(reportPath)}), { recursive: true });`,
    invalid
      ? `fs.writeFileSync(${JSON.stringify(reportPath)}, 'not a report');`
      : `fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});`,
    'process.exit(0);',
  );
  return stmts.join('\n');
}

/** The seat table, keyed on the base seat name: a slot suffix is not a seat. */
function seatFixture(seats) {
  const calls = [];
  // The corrective prompt of an invalid report names no seat: it is the same
  // seat session, told what its report failed.
  let last = null;
  const commandFor = (opts) => {
    const full = /You are the (\S+) seat/.exec(opts.prompt)?.[1] ?? last;
    last = full;
    const seat = full.split(':')[0];
    const slot = Number(full.split(':')[1] ?? 0);
    const lines = opts.prompt.split('\n');
    const contract = lines.findIndex((l) => l.includes('write your JSON report to this file'));
    // The corrective prompt names the same file on the line that asks for it.
    const reportPath =
      contract === -1
        ? /report to the same file, then stop: (.+)$/m.exec(opts.prompt)[1].trim()
        : lines[contract + 1];
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
    rerunOnce = null,
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
  let reran = false;
  // What the run's tree held at the last stage before the close. The close
  // schedules the workspace teardown, and that delete runs while the caller
  // reads, so every tree reading a scenario needs is taken here (ADR-0051).
  const trees = [];
  const shipStub = {
    stages: ['update'],
    handlers: {
      update: async (ctx) => {
        trees.push(treeSnapshot(ctx.payload.worktree));
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
        // A scenario about a moved default branch: the update merged records
        // this run's own ground names, so the reconciliation is asked again.
        if (rerunOnce && !reran) {
          reran = true;
          ctx.store.append('pre-verdict-update', {
            actor: 'daemon',
            pass: 1,
            ran: true,
            mainSha: 'main-moved',
            records: { answer: 'rerun', files: rerunOnce },
          });
          return { next: 'reconcile' };
        }
        return { close: { state: 'shipped' } };
      },
    },
  };
  const reconcile = withReconcileStage(shipStub);
  const lanes = {
    [lane]: {
      stages: ['seed', ...reconcile.stages],
      // The guard every assembled lane carries: a park answered `abandon`
      // closes the run at the next stage entry (ADR-0015).
      handlers: withAbandonGuard({ seed: seed ?? seedHandler(), ...reconcile.handlers }),
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
    /** The tree readings the update stage took, newest last. */
    trees,
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
 * One reading of a run's tree: the commit subjects it holds and the record
 * files it stands on. It is taken while the run still holds the workspace,
 * because the close tears that workspace down behind the caller.
 */
function treeSnapshot(worktree) {
  const records = join(worktree, 'docs', 'adr');
  return {
    worktree,
    subjects: gitSync(['log', '--format=%s'], worktree).trim().split('\n'),
    // The whole message of each commit, subject and body, one entry per commit.
    // A round names the records it wrote in the body, and the workspace is gone
    // by the time a scenario reads (ADR-0051, ADR-0090).
    messages: gitSync(['log', '--format=%s%n%b%x1e', '-n', '20'], worktree)
      .split('\u001e')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    records: existsSync(records) ? readdirSync(records).sort() : [],
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
  return waitRunEvents(paths, runId, (events) => events.find(predicate), { label, attempts });
}

// -- the seat table ----------------------------------------------------------

/**
 * The judge: owed on the records the fixture names, with the cause every owed
 * record carries (ADR-0090).
 */
const judgeOwed =
  (records = [ADR], cause = 'contradicts') =>
  () => ({
    report: {
      owed: true,
      records,
      causes: records.map(() => cause),
      reason: 'the diff contradicts the doubling decision',
    },
  });

const judgeClean = () => ({
  report: { owed: false, records: [], causes: [], reason: 'no record the diff implicates' },
});

/** A writer that rewrites every record it was given and answers every unit. */
function writeOnce(contents = { [ADR]: ADR_REWRITTEN }) {
  return ({ prompt }) => {
    const records = briefRecords(prompt);
    return {
      files: Object.fromEntries(records.map((record) => [record, contents[record]])),
      report: {
        rewritten: records,
        unchanged: [],
        summary: 'the records state what the tree holds',
      },
    };
  };
}

/**
 * A writer whose first dispatch writes every record of its set and whose later
 * ones correct them. Each record's text moves on every round, so a cycle after
 * the first reads a record whose text changed.
 */
function writeThenCorrect(second = ADR_CORRECTED) {
  const seen = new Map();
  return ({ prompt, full }) => {
    const records = briefRecords(prompt);
    const round = (seen.get(full) ?? 0) + 1;
    seen.set(full, round);
    const corrective = prompt.includes('Findings:');
    const files = {};
    for (const record of records.length > 0 ? records : [ADR]) {
      files[record] =
        record === ADR
          ? round === 1
            ? ADR_REWRITTEN
            : second
          : `${ADR_TWO_TEXT}
Round ${round} wrote this record.
`;
    }
    return {
      files,
      report: {
        rewritten: Object.keys(files),
        unchanged: [],
        ...(corrective && { answered: findingIds(prompt) }),
        summary: 'the records state what the tree holds',
      },
    };
  };
}

/** The findings a corrective brief carries, answered in the order it states them. */
function findingIds(prompt) {
  return [...prompt.matchAll(/^- \[(F\d+)\]/gm)].map((m) => ({ id: m[1] }));
}

/**
 * A record review seat that raises one finding on the first record of its set
 * per cycle, then none.
 *
 * The finding names one unit of that record, by the address the brief gave it.
 */
function recordReview(summaries) {
  let cycle = 0;
  return ({ prompt }) => {
    const record = recordOf(prompt);
    const summary = summaries[cycle];
    cycle += 1;
    const target = targetUnitFor(prompt, record);
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
                  ground: [record, 'src/base.mjs'],
                  unit: target.id,
                  head: target.head,
                  line: 1,
                  summary,
                  evidence: 'src/base.mjs',
                },
              ]
            : [],
        summary: 'the record against the tree',
      },
    };
  };
}

/** A clean record review: the seat read its records and raised nothing. */
const reviewClean = () => ({ report: { findings: [], summary: 'the records stand' } });

/** The first record a review brief names. */
function recordOf(prompt) {
  return reviewRecords(prompt)[0] ?? ADR;
}

/**
 * A writer that writes every record it was given, and answers on a later
 * round. The second dispatch over a record adds a sentence, so the finding the
 * review raised is on a record whose text has moved.
 */
function writeCorrecting(contents) {
  const seen = new Map();
  return ({ prompt }) => {
    const files = {};
    for (const record of briefRecords(prompt)) {
      const rounds = (seen.get(record) ?? 0) + 1;
      seen.set(record, rounds);
      files[record] =
        rounds === 1
          ? contents[record]
          : contents[record].replace(
              '## Decision',
              '## Decision\n\nThe corrective round answered the finding.',
            );
    }
    return {
      files,
      report: {
        rewritten: Object.keys(files),
        unchanged: [],
        ...(prompt.includes('Findings:') && { answered: findingIds(prompt) }),
        summary: 'the records state what the tree holds',
      },
    };
  };
}

/** A writer that leaves a different record on every dispatch it takes. */
function writeEveryRound(record = ADR, text = ADR_REWRITTEN) {
  let n = 0;
  return ({ prompt }) => {
    n += 1;
    const body = text.replace(
      '## Consequences',
      `## Consequences\n\nDispatch ${n} answered the review.`,
    );
    return {
      files: { [record]: body },
      report: {
        rewritten: [record],
        unchanged: [],
        ...(prompt.includes('Findings:') && { answered: findingIds(prompt) }),
        summary: 'the record states what the tree holds',
      },
    };
  };
}

/** A review that raises one finding, on one record, the first time it reads it. */
function reviewOnce(record, summary) {
  const seen = new Set();
  return ({ prompt }) => {
    const raise = reviewRecords(prompt).includes(record) && !seen.has(record);
    const target = raise ? targetUnitFor(prompt, record) : null;
    if (target) seen.add(record);
    return {
      report: {
        findings: target
          ? [
              {
                id: 'r1',
                criterion: RECORD_CRITERION_KEYS[0],
                severity: 'HIGH',
                file: record,
                ground: [record, 'src/base.mjs'],
                unit: target.id,
                head: target.head,
                line: 1,
                summary,
                evidence: 'src/base.mjs',
              },
            ]
          : [],
        summary: 'the record against the tree',
      },
    };
  };
}

/** The sentence a corrective dispatch writes into the record it answers. */
const ANSWERED = 'The corrective round answered the finding.';

/**
 * A writer that delivers nothing the schema names over a set holding one named
 * record, twice, then writes it. A report that is not the JSON the schema names
 * is the one refusal a record write still takes (ADR-0080).
 */
function writeRefusing(contents, refuses, { corrective = true } = {}) {
  const seen = new Map();
  return ({ prompt }) => {
    const records = briefRecords(prompt);
    const answering = prompt.includes('Findings:');
    let n = 0;
    if (records.includes(refuses) && answering === corrective) {
      n = (seen.get(refuses) ?? 0) + 1;
      seen.set(refuses, n);
    }
    if (n > 0 && n <= 2) return { invalid: true };
    const files = {};
    for (const record of records) {
      files[record] = answering
        ? contents[record].replace('## Decision', `## Decision\n\n${ANSWERED}`)
        : contents[record];
    }
    return {
      files,
      report: {
        rewritten: Object.keys(files),
        unchanged: [],
        ...(answering && { answered: findingIds(prompt) }),
        summary: 'the records state what the tree holds',
      },
    };
  };
}

/**
 * A review that delivers nothing the schema names where its set holds one
 * named record, and raises one finding per record otherwise.
 *
 * A retry prompt names no record: it is the same seat session, told what its
 * report failed. Only the seat that holds this record ever writes an invalid
 * report here, so a prompt with no record on it belongs to that seat.
 */
function reviewInvalidFor(record, summary) {
  return (opts) => {
    const read = reviewRecords(opts.prompt);
    if (read.length === 0 || read.includes(record)) return { invalid: true };
    return reviewUnanswered(summary)(opts);
  };
}

/** A review that raises one finding per record until the record answers it. */
function reviewUnanswered(summary) {
  return ({ prompt }) => {
    const answered = prompt.includes(ANSWERED);
    const findings = [];
    for (const record of reviewRecords(prompt)) {
      const target = answered ? null : targetUnitFor(prompt, record);
      if (!target) continue;
      findings.push({
        id: `r${findings.length + 1}`,
        criterion: RECORD_CRITERION_KEYS[0],
        severity: 'HIGH',
        file: record,
        ground: [record, 'src/base.mjs'],
        unit: target.id,
        head: target.head,
        line: 1,
        summary,
        evidence: 'src/base.mjs',
      });
    }
    return { report: { findings, summary: 'the records against the tree' } };
  };
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
 * A seat that never answers its `nth` dispatch. Only a stop ends that one, so a
 * scenario about a restart at one step boundary can hold the run exactly there.
 * Every other dispatch is the behaviour the seat table names, and the hung one
 * never reaches it: a fixture that counts its own rounds counts the dispatches
 * that answered.
 */
function hangNth(nth, behaviour) {
  let seen = 0;
  return (opts) => {
    seen += 1;
    return seen === nth ? { hang: true } : behaviour(opts);
  };
}

/**
 * A seat that never answers the corrective dispatch of one named record. Only a
 * stop ends that one, so a scenario about a restart inside a round holds the run
 * at the dispatch it names, whatever the attempts before it cost.
 */
function hangOnCorrective(record, behaviour) {
  let held = false;
  return (opts) => {
    const mine =
      briefRecords(opts.prompt).includes(record) && opts.prompt.includes('Findings:');
    if (mine && !held) {
      held = true;
      return { hang: true };
    }
    return behaviour(opts);
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
  const read = { event: 'record-reviewed', cycle: 1, record: ADR, seat: 'record-review:1' };
  assert.equal(reconcileStep(ledger(judged, written, layer, read)), 'render');
  const green = { event: 'reconcile-rendered', cycle: 1, sha: 'aaa', verdict: 'green', open: [] };
  const red = { ...green, verdict: 'red', open: ['F1'] };
  assert.equal(reconcileStep(ledger(judged, written, layer, read, green)), 'done');
  assert.equal(
    reconcileStep(ledger(judged, written, layer, read, red)),
    'correct',
  );
  // The cap stops the corrective rounds and takes the fallback.
  assert.equal(
    reconcileStep(
      ledger(judged, written, layer, read, red, {
        event: 'reconcile-round',
        round: 1,
      }),
      { cap: 1 },
    ),
    'stall',
  );
  // A fresh pass discards every statement about the tree it reset.
  assert.equal(
    reconcileStep(ledger(judged, written, layer, read, green, { event: 'fresh-pass' })),
    'judge',
  );
});

test('a born record set anchors the cycle where the pass wrote nothing', () => {
  // The judge leaves out a born record that still stands. A pass whose whole
  // diff is the birth write is therefore judged "nothing owed". The born stamp
  // is that pass's record set, and it takes the cycle (ADR-0077).
  const clean = { event: 'reconciliation-judged', ok: true, owed: false, born: [ADR], late: [] };
  assert.equal(reconcileStep(ledger(clean)), 'done');
  // A birth that decided nothing is no record set either.
  assert.equal(
    reconcileStep(ledger({ event: 'records-committed', decided: false, paths: [] }, clean)),
    'done',
  );
  const born = { event: 'records-committed', decided: true, paths: [ADR], sha: 'bbb' };
  assert.equal(reconcileStep(ledger(born, clean)), 'spectrum');
  const layer = { event: 'layer-result', cycle: 1, layer: 'adr-form', status: 'green' };
  assert.equal(reconcileStep(ledger(born, clean, layer)), 'review');
  const read = { event: 'record-reviewed', cycle: 1, record: ADR, seat: 'record-review:1' };
  assert.equal(reconcileStep(ledger(born, clean, layer, read)), 'render');
  const green = { event: 'reconcile-rendered', cycle: 1, sha: 'aaa', verdict: 'green', open: [] };
  const red = { ...green, verdict: 'red', open: ['F1'] };
  assert.equal(reconcileStep(ledger(born, clean, layer, read, green)), 'done');
  assert.equal(reconcileStep(ledger(born, clean, layer, read, red)), 'correct');
  assert.equal(
    reconcileStep(
      ledger(born, clean, layer, read, red, {
        event: 'reconcile-round',
        round: 1,
      }),
      { cap: 1 },
    ),
    'stall',
  );
  // A write is the anchor wherever the pass holds one. The born stamp answers
  // for a pass that wrote nothing, and never for one that wrote.
  const written = { event: 'reconciliation-written', ok: true, rewritten: [ADR], records: [] };
  assert.equal(reconcileStep(ledger(born, clean, written)), 'spectrum');
  // A judgment that owes records still buys the write first, born set or not.
  const owed = { event: 'reconciliation-judged', ok: true, owed: true, records: [ADR] };
  assert.equal(reconcileStep(ledger(born, owed)), 'write');
});

test('a repair round past a green render owes the recheck, and a re-run owes a cycle', () => {
  const base = ledger(
    { event: 'reconciliation-judged', ok: true, owed: true, records: [ADR] },
    { event: 'reconciliation-written', ok: true, rewritten: [ADR], records: [] },
    { event: 'layer-result', cycle: 1, layer: 'adr-form', status: 'green' },
    { event: 'record-reviewed', cycle: 1, record: ADR, seat: 'record-review:1' },
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

// -- the corrective dispatch set (ADR-0079) -----------------------------------

const ADR_THREE = 'docs/adr/adr-0003-name-the-range.md';

test('a corrective round dispatches the records an open finding names (W15)', () => {
  const three = [ADR, ADR_TWO, ADR_THREE];
  const events = ledger(
    { event: 'finding', id: 'F1', file: ADR, summary: 'the claim fails' },
    { event: 'finding', id: 'F2', file: ADR_THREE, file2: ADR_TWO, criterion: 'consistent' },
    { event: 'layer-result', cycle: 2, layer: 'adr-form', status: 'green' },
  );
  // The findings decide the set, and a record no finding names owes nothing.
  assert.deepEqual([...correctiveRecords(events, { cycle: 2, open: ['F1'] }, three)], [ADR]);
  // A consistent finding names two records, and both answer it.
  assert.deepEqual(
    [...correctiveRecords(events, { cycle: 2, open: ['F2'] }, three)],
    [ADR_TWO, ADR_THREE],
  );
  // A red layer that names records in its output dispatches those records.
  const named = ledger(
    { event: 'finding', id: 'F1', file: ADR, summary: 'the claim fails' },
    {
      event: 'layer-result',
      cycle: 2,
      layer: 'adr-form',
      status: 'red',
      output: `${ADR_TWO}:3 the status line is malformed\n${ADR_THREE}:1 the title is missing`,
    },
  );
  assert.deepEqual(
    [...correctiveRecords(named, { cycle: 2, open: ['adr-form'] }, three)],
    [ADR_TWO, ADR_THREE],
  );
  // A red layer that names no record of the set dispatches nothing. The
  // widening it used to buy sent every record of a batch to a writer over a red
  // no seat could clear, at a round's whole cost; the empty set stalls at once
  // and the run merges with the layer named (ADR-0080).
  const silent = ledger({
    event: 'layer-result',
    cycle: 2,
    layer: 'adr-form',
    status: 'red',
    output: 'the record tree does not parse',
  });
  assert.deepEqual([...correctiveRecords(silent, { cycle: 2, open: ['adr-form'] }, three)], []);
  // A layer red in an earlier cycle says nothing about this one.
  assert.deepEqual([...correctiveRecords(named, { cycle: 3, open: ['F1'] }, three)], [ADR]);
  // Nor does a red layer that names a record no seat may answer for.
  const closed = ledger({
    event: 'layer-result',
    cycle: 2,
    layer: 'adr-form',
    status: 'red',
    output: 'docs/adr/adr-0009-closed.md:3 the status line is malformed',
  });
  assert.deepEqual([...correctiveRecords(closed, { cycle: 2, open: ['adr-form'] }, three)], []);
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

  // The write stamp behind the commit, which the resume reads and nothing else
  // does (ADR-0080).
  const stamp = events.find(
    (e) => e.event === 'record-written' && e.seat === 'reconcile-write:1',
  );
  assert.equal(stamp.record, ADR);
  assert.equal(stamp.cost, 0.5);
  assert.equal(typeof stamp.sha, 'string');
  assert.equal(stamp.failed, undefined);
  // No verifier: a record round confirms a HIGH as its reviewer raised it.
  assert.equal(fx.calls.filter((c) => c.seat.endsWith('-verifier')).length, 0);
  // Three record seats before any corrective round: the judge, one writer
  // over the owed set, and one reviewer over it (ADR-0090). The layer run is
  // a command and no seat.
  assert.deepEqual(
    fx.calls.map((c) => c.full),
    ['reconcile-judge', 'reconcile-write:1', 'record-review:1'],
  );

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

test('no born record and nothing owed: no cycle, and the run is handed on', async (t) => {
  const fx = stageFixture(t, {
    seats: { 'reconcile-judge': judgeClean },
    files: { [CLOSED_ADR]: CLOSED_TEXT },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  const judged = events.find((e) => e.event === 'reconciliation-judged');
  assert.equal(judged.owed, false);
  // The judge is given the active tree by path and is no longer told to find it
  // itself. The record the tree closed is in no list (ADR-0089).
  const judge = fx.calls.find((c) => c.seat === 'reconcile-judge');
  assert.ok(judge.prompt.includes(`${OTHER_RECORDS_LINE}\n- ${ADR}\n`), judge.prompt);
  assert.ok(judge.prompt.includes(RECORD_SENTENCE), judge.prompt);
  assert.ok(!judge.prompt.includes(CLOSED_ADR), judge.prompt);
  assert.ok(!judge.prompt.includes('Locate the decision-record tree'), judge.prompt);
  // The lists ride the stamp whatever the answer, and this pass bore nothing.
  assert.deepEqual(judged.born, []);
  assert.deepEqual(judged.late, []);
  assert.ok(!events.some((e) => e.event === 'reconciliation-written'));
  assert.ok(!events.some((e) => e.event === 'reconcile-rendered'));
  assert.ok(!fx.calls.some((c) => c.seat === 'reconcile-write'));
});

test('a born record takes the cycle, and spends no writer', async (t) => {
  // The pass wrote its records before the stage, so the judge owes nothing.
  // No writer runs. The record set is the birth's, and the cycle reads it. That
  // is the layers, one review seat per record, and a render (ADR-0077).
  const fx = stageFixture(t, {
    seed: seedHandler((ctx, { sha }) => {
      ctx.store.append('records-committed', { actor: 'daemon', sha, paths: [ADR], decided: true });
    }),
    seats: { 'reconcile-judge': judgeClean, 'record-review': reviewClean },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');

  const judged = events.find((e) => e.event === 'reconciliation-judged');
  assert.equal(judged.owed, false);
  assert.deepEqual(judged.born, [ADR]);
  assert.deepEqual(judged.late, []);
  // No write of any kind: the birth wrote the record and the judge owes none.
  assert.ok(!events.some((e) => e.event === 'reconciliation-written'));
  assert.ok(!fx.calls.some((c) => c.seat === 'reconcile-write'));

  // The judge's brief names the born record once. The brief lists it as the
  // pass's own, so the active-tree block leaves it out (ADR-0089).
  const judge = fx.calls.find((c) => c.seat === 'reconcile-judge');
  assert.equal(judge.prompt.split(ADR).length - 1, 1, judge.prompt);
  assert.ok(!judge.prompt.includes(OTHER_RECORDS_LINE), judge.prompt);
  assert.ok(judge.prompt.includes(RECORD_SENTENCE), judge.prompt);

  // Two record seats: the judge, and one reviewer over the born set. A born
  // record takes the cycle whether the judge owed it or not (ADR-0077).
  assert.deepEqual(
    fx.calls.map((c) => c.full),
    ['reconcile-judge', 'record-review:1'],
  );
  const reviews = fx.calls.filter((c) => c.seat === 'record-review');
  assert.equal(reviews.length, 1);
  assert.ok(reviews[0].prompt.includes(`Review one decision record: ${ADR}`), reviews[0].prompt);
  assert.deepEqual(
    events.filter((e) => e.event === 'layer-result').map((e) => [e.layer, e.status]),
    [['adr-form', 'green']],
  );

  // The render names the born record and stands green.
  const rendered = events.find((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.verdict, 'green');
  assert.deepEqual(rendered.open, []);
  assert.deepEqual(rendered.records, [ADR]);
});

test('three records take one writer over the set, and one reviewer over it', async (t) => {
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

  // One dispatch over the whole set, at slot one (ADR-0090).
  const writers = fx.calls.filter((c) => c.seat === 'reconcile-write');
  assert.deepEqual(
    writers.map((c) => c.full),
    ['reconcile-write:1'],
  );
  // The one brief names every record of the set.
  for (const record of Object.keys(three)) {
    assert.ok(writers[0].prompt.includes(`- ${record}`), record);
  }
  // One commit, with the set in its body, and one entry per record on the
  // write stamp, all of them naming the one seat.
  const written = events.find((e) => e.event === 'reconciliation-written');
  assert.equal(written.records.length, 3);
  assert.deepEqual(
    written.records.map((r) => r.seat),
    ['reconcile-write:1', 'reconcile-write:1', 'reconcile-write:1'],
  );
  assert.deepEqual(written.rewritten.sort(), Object.keys(three).sort());
  const subjects = fx.trees.at(-1).subjects.filter((s) => s.startsWith('reconcile: '));
  assert.equal(subjects.length, 1, subjects.join(' | '));
  assert.ok(/^reconcile: \S+ reconcile-write:1 @\d+$/.test(subjects[0]), subjects[0]);
  // Three write stamps, one per record.
  const writerUnits = events.filter(
    (e) => e.event === 'record-written',
  );
  assert.equal(writerUnits.length, 3);
  assert.equal(events.find((e) => e.event === 'reconcile-rendered').verdict, 'green');
  // One review seat over the set, and one `record-reviewed` per record.
  const reviews = fx.calls.filter((c) => c.seat === 'record-review');
  assert.deepEqual(
    reviews.map((c) => c.full),
    ['record-review:1'],
  );
  assert.ok(reviews[0].prompt.includes('Review these 3 decision records:'), reviews[0].prompt);
  assert.deepEqual(
    events.filter((e) => e.event === 'record-reviewed').map((e) => e.record).sort(),
    Object.keys(three).sort(),
  );
});

test('a confirmed record finding buys a corrective round, and no repair-dev runs', async (t) => {
  const fx = stageFixture(t, {
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeThenCorrect(),
      'record-review': recordReview(['the record claims a doubling the tree does not hold']),
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
  assert.ok(corrective.prompt.includes('Findings:'));
  // The finding names one unit, and the brief states it: a corrective round
  // answers a sentence and never a file (ADR-0073).
  const finding = events.find((e) => e.event === 'finding' && e.confirmed === true);
  assert.ok(corrective.prompt.includes(finding.unit), finding.unit);
  assert.ok(corrective.prompt.includes(finding.head), finding.head);
  // And the verdict never moved.
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 1);
});

test('a corrective round spends a seat on the records that owe one (W15)', async (t) => {
  const three = {
    [ADR]: ADR_REWRITTEN,
    [ADR_TWO]: ADR_TWO_TEXT + '\nThe module src/base.mjs is read by the feature.\n',
    [ADR_THREE]: ADR_TWO_TEXT.replace('ADR-0002', 'ADR-0003') + '\nThe range is src/base.mjs.\n',
  };
  const fx = stageFixture(t, {
    files: {
      [ADR_TWO]: ADR_TWO_TEXT,
      [ADR_THREE]: ADR_TWO_TEXT.replace('ADR-0002', 'ADR-0003'),
    },
    seats: {
      'reconcile-judge': judgeOwed(Object.keys(three)),
      'reconcile-write': writeCorrecting(three),
      'record-review': reviewOnce(ADR, 'the record claims a doubling the tree does not hold'),
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');

  // The judged write dispatched all three; the corrective round dispatched the
  // one record with an open finding and stamped the other two.
  const sets = events.filter((e) => e.event === 'reconcile-write-set');
  assert.equal(sets.length, 2);
  assert.deepEqual(sets[0].records, Object.keys(three));
  assert.equal(sets[0].kept, undefined);
  assert.deepEqual(sets[1].records, [ADR]);
  assert.deepEqual(sets[1].kept, [
    { record: ADR_TWO, reason: 'no open finding' },
    { record: ADR_THREE, reason: 'no open finding' },
  ]);
  const round = events.find((e) => e.event === 'reconcile-round');
  assert.deepEqual(round.records, [ADR]);
  // Two writer dispatches: one over the set, one at the correction (ADR-0090).
  const writers = fx.calls.filter((c) => c.seat === 'reconcile-write');
  assert.equal(writers.length, 2);
  assert.ok(writers[1].prompt.includes('Findings:'));
  assert.ok(writers[1].prompt.includes(`- ${ADR}`), writers[1].prompt);

  // The second cycle reads the record the round changed and keeps the two the
  // round left alone, each with the cycle of its green review (D1).
  const cycles = events.filter((e) => e.event === 'reconcile-review-set');
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles[0].records, Object.keys(three));
  assert.equal(cycles[0].kept, undefined);
  assert.deepEqual(cycles[1].records, [ADR]);
  // The cycle counter is the run's own, and the seed's code verdict is its
  // first, so the first record cycle is 2.
  assert.deepEqual(cycles[1].kept, [
    { record: ADR_TWO, cycle: 2 },
    { record: ADR_THREE, cycle: 2 },
  ]);
  // The render names the whole set it stood over: what a seat read, and what
  // its last green review answers for.
  const second = events.filter((e) => e.event === 'reconcile-rendered')[1];
  assert.deepEqual(second.records, [ADR]);
  assert.deepEqual(second.kept, [ADR_TWO, ADR_THREE]);
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered')[0].kept, undefined);
  // A kept record takes no seat, and the render names the dispatched set. One
  // review seat per cycle, whatever the cycle holds (ADR-0090).
  assert.equal(fx.calls.filter((c) => c.seat === 'record-review').length, 2);
  assert.deepEqual(events.filter((e) => e.event === 'reconcile-rendered').at(-1).records, [ADR]);
  // The pin: no round since a kept record's green review wrote that record. A
  // kept record whose text moved is a derivation defect, and this is the
  // reading that catches one.
  const renders = events.filter((e) => e.event === 'reconcile-rendered');
  for (const entry of cycles[1].kept) {
    const green = renders.find((r) => r.cycle === entry.cycle);
    const since = new Set(
      events
        .filter((e) => e.event === 'reconciliation-written' && e.seq > green.seq)
        .flatMap((e) => e.rewritten ?? []),
    );
    assert.ok(!since.has(entry.record), entry.record);
  }
});

test('a re-run a moved default branch buys reads the whole set again (D1)', async (t) => {
  const two = {
    [ADR]: ADR_REWRITTEN,
    [ADR_TWO]: ADR_TWO_TEXT + '\nThe module src/base.mjs is read by the feature.\n',
  };
  const fx = stageFixture(t, {
    files: { [ADR_TWO]: ADR_TWO_TEXT },
    rerunOnce: [ADR],
    seats: {
      'reconcile-judge': judgeOwed(Object.keys(two)),
      'reconcile-write': writeCorrecting(two),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // Two cycles, and the second reads every record of the set: a merge of the
  // default branch is a tree no green review of this run has read.
  const cycles = events.filter((e) => e.event === 'reconcile-review-set');
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles[1].records, Object.keys(two));
  assert.equal(cycles[1].kept, undefined);
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').length, 2);
});

test('a corrective round dispatches a born record the judge never owed (W6)', async (t) => {
  // The judge owes one record of a born pair. The other is the birth's, and a
  // finding on it used to have no writer at all.
  const fx = stageFixture(t, {
    // The birth writes the second record on the run's own branch, so the run's
    // window holds it and the judge still owes only the first.
    seed: seedHandler(async (ctx) => {
      const worktree = ctx.payload.worktree;
      writeFileSync(join(worktree, ADR_TWO), ADR_TWO_TEXT);
      const sha = await commitAll(worktree, 'records: the birth writes the second');
      ctx.store.append('records-committed', {
        actor: 'daemon',
        sha,
        paths: [ADR, ADR_TWO],
        decided: true,
      });
    }),
    seats: {
      'reconcile-judge': judgeOwed([ADR]),
      'reconcile-write': writeCorrecting({
        [ADR]: ADR_REWRITTEN,
        [ADR_TWO]: ADR_TWO_TEXT + '\nThe module src/base.mjs is read by the feature.\n',
      }),
      'record-review': reviewOnce(ADR_TWO, 'the record states a value the tree does not hold'),
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The write stamp names the judged record alone, and the cycle read both.
  const written = events.find((e) => e.event === 'reconciliation-written');
  assert.deepEqual(written.rewritten, [ADR]);
  assert.deepEqual(
    events.find((e) => e.event === 'reconcile-review-set').records,
    [ADR, ADR_TWO],
  );
  // The corrective round dispatched the born record the finding names.
  const round = events.find((e) => e.event === 'reconcile-round');
  assert.deepEqual(round.records, [ADR_TWO]);
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').at(-1).verdict, 'green');
});

// -- a dispatch that delivers nothing (ADR-0080) ------------------------------

test('a corrective round that delivers nothing leaves every record of it open', async (t) => {
  const two = {
    [ADR]: ADR_REWRITTEN,
    [ADR_TWO]: ADR_TWO_TEXT + '\nThe module src/base.mjs is read by the feature.\n',
  };
  const fx = stageFixture(t, {
    files: { [ADR_TWO]: ADR_TWO_TEXT },
    seats: {
      'reconcile-judge': judgeOwed(Object.keys(two)),
      'reconcile-write': writeRefusing(two, ADR_TWO),
      'record-review': reviewUnanswered('the record claims what the tree does not hold'),
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  // The run ships, and nobody is asked anything.
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(events.filter((e) => e.event === 'park').map((e) => e.type), []);

  // One seat holds the round, so a seat that delivers nothing leaves every
  // record of the round unwritten, each with the reason that ended it
  // (ADR-0090).
  const round = events.filter((e) => e.event === 'reconcile-round')[0];
  assert.deepEqual(round.records, [ADR, ADR_TWO]);
  assert.deepEqual(round.failed, [ADR, ADR_TWO]);
  const written = events.filter((e) => e.event === 'reconciliation-written');
  const failed = written[1].records.find((r) => r.record === ADR_TWO);
  assert.equal(failed.failed, true);
  assert.equal(typeof failed.reason, 'string');
  assert.deepEqual(written[1].rewritten, []);
  const stamp = events.filter((e) => e.event === 'record-written' && e.record === ADR_TWO).at(-1);
  assert.equal(stamp.failed, true);

  // The render that follows carries both records by name, and the run merges at
  // its cap with them named (ADR-0080).
  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.ok(rendered[1].open.includes(`unwritten:${ADR_TWO}`), rendered[1].open.join(', '));
  assert.ok(rendered[1].open.includes(`unwritten:${ADR}`), rendered[1].open.join(', '));
  assert.ok(events.some((e) => e.event === 'reconcile-stall'));
  assert.equal(written.at(-1).cause, 'record-cap');
});

// A reviewer's failure is about the reviewer. Every record it was given rides
// the render unreviewed, the next cycle dispatches them, and no run parks on it
// (ADR-0080, ADR-0090).
test('a review seat that delivers nothing leaves its records for the next cycle', async (t) => {
  const two = {
    [ADR]: ADR_REWRITTEN,
    [ADR_TWO]: ADR_TWO_TEXT + '\nThe module src/base.mjs is read by the feature.\n',
  };
  const fx = stageFixture(t, {
    files: { [ADR_TWO]: ADR_TWO_TEXT },
    seats: {
      'reconcile-judge': judgeOwed(Object.keys(two)),
      'reconcile-write': writeThenCorrect(),
      'record-review': reviewInvalidFor(ADR_TWO, 'the record claims what the tree does not hold'),
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(events.filter((e) => e.event === 'park').map((e) => e.type), []);

  // One seat holds the cycle, so a seat that delivered nothing stamped every
  // record of it unreviewed, one stamp per record (ADR-0090).
  const missed = events.filter((e) => e.event === 'record-unreviewed');
  const sets = events.filter((e) => e.event === 'reconcile-review-set');
  assert.equal(sets.length, 1);
  assert.deepEqual(missed.map((e) => e.record), sets[0].records);
  assert.ok(missed.every((e) => e.seat === 'record-review:1'), JSON.stringify(missed));
  assert.ok(missed.every((e) => e.cycle === sets[0].cycle));
  // The render stands green over them: an unread record holds no render red,
  // and it rides the render under its own heading (ADR-0080).
  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].verdict, 'green');
  assert.deepEqual(rendered[0].unreviewed, sets[0].records);
  // The run's ending names them, and no seat of the run was asked about a park.
  assert.deepEqual(unreviewedOf(events).slice().sort(), sets[0].records.slice().sort());
});

test('a records-lane round that delivers nothing leaves the record unwritten', async (t) => {
  const two = {
    [ADR]: ADR_REWRITTEN,
    [ADR_TWO]: ADR_TWO_TEXT + '\nThe module src/base.mjs is read by the feature.\n',
  };
  const fx = stageFixture(t, {
    lane: 'records',
    seed: async (ctx) => {
      const worktree = ctx.payload.worktree;
      writeFileSync(join(worktree, ADR_TWO), ADR_TWO_TEXT);
      const sha = await commitAll(worktree, 'records: the birth writes both');
      ctx.store.append('records-committed', {
        actor: 'daemon',
        sha,
        paths: [ADR, ADR_TWO],
        decided: true,
      });
      return { next: 'reconcile' };
    },
    seats: {
      'reconcile-write': writeRefusing(two, ADR_TWO),
      'record-review': reviewUnanswered('the record claims what the tree does not hold'),
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  // The lane spawns no judge, parks on nothing, and merges at its cap.
  assert.equal(fx.calls.filter((c) => c.seat === 'reconcile-judge').length, 0);
  assert.equal(events.find((e) => e.event === 'reconciliation-judged').source, 'born');
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(events.filter((e) => e.event === 'park').map((e) => e.type), []);
  const written = events.filter((e) => e.event === 'reconciliation-written');
  assert.equal(written[0].ok, true);
  assert.ok(!written[0].rewritten.includes(ADR_TWO));
  assert.equal(written[0].records.find((r) => r.record === ADR_TWO).failed, true);
  // The render names the record no write answered.
  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.ok(rendered.at(-1).open.includes(`unwritten:${ADR_TWO}`), rendered.at(-1).open.join(', '));
  assert.equal(written.at(-1).cause, 'record-cap');
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

test('a red record layer that names a record briefs the round with it', async (t) => {
  // The layer is red until the record holds the sentence a corrective dispatch
  // adds, and its output names the record it refused.
  const layer = [
    'const fs = require("fs");',
    `const ok = fs.readFileSync(${JSON.stringify(ADR)}, "utf8").includes("the feature reads");`,
    `if (!ok) console.log(${JSON.stringify(`${ADR}:3 the status line is malformed`)});`,
    'process.exit(ok ? 0 : 1);',
  ].join('\n');
  const fx = stageFixture(t, {
    config: {
      commands: { adrform: [process.execPath, '-e', layer] },
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
  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered[0].verdict, 'red');
  assert.deepEqual(rendered[0].open, ['adr-form']);
  assert.deepEqual(rendered[0].layers, [{ layer: 'adr-form', status: 'red' }]);
  // The corrective round is briefed with the red layer, and it answers it.
  const corrective = fx.calls.filter((c) => c.seat === 'reconcile-write').at(-1);
  assert.ok(corrective.prompt.includes('These Tier-1 layers are red'));
  assert.ok(corrective.prompt.includes('- adr-form'));
  assert.equal(rendered.at(-1).verdict, 'green');
});

// A red layer that names no active record of the set dispatches nothing. The
// widening it used to buy sent every record of a batch to a writer over a red
// no seat could clear, at a round's whole cost (ADR-0080).
test('a red record layer that names nothing stalls at once and merges', async (t) => {
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
      'reconcile-write': writeOnce(),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  const rendered = events.find((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.verdict, 'red');
  assert.deepEqual(rendered.open, ['adr-form']);
  // No corrective round at all: the round would spawn a seat over a red no seat
  // can clear.
  assert.deepEqual(events.filter((e) => e.event === 'reconcile-round'), []);
  const stall = events.find((e) => e.event === 'reconcile-stall');
  assert.equal(stall.rounds, 0);
  assert.match(stall.gist, /holds nothing to dispatch/);
  assert.equal(events.filter((e) => e.event === 'reconciliation-written').at(-1).cause, 'record-cap');
  assert.deepEqual(events.filter((e) => e.event === 'park').map((e) => e.type), []);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
});

/** The records-lane fixture that reaches its cap with one round and one open. */
function capFixture(t) {
  return stageFixture(t, {
    lane: 'records',
    config: {
      gates: {
        tier1: [{ name: 'adr-form', command: 'adrform' }],
        recordLayers: ['adr-form'],
        reconcileRounds: 1,
      },
    },
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
      'reconcile-write': writeEveryRound(),
      'record-review': recordReview([
        'the record claims a doubling the tree does not hold',
        'the record cites a symbol the tree does not export',
      ]),
    },
  });
}

// -- the remarks (plan 41, point 2) -------------------------------------------

/**
 * A review that grades: one HIGH and one remark on the first read of one
 * record, each on a unit of its own, and nothing on any later read.
 */
function reviewGraded(record, { high = null, remark = null } = {}) {
  const seen = new Set();
  return ({ prompt }) => {
    const read = recordOf(prompt);
    if (read !== record || seen.has(read)) {
      return { report: { findings: [], summary: 'the record stands' } };
    }
    seen.add(read);
    const findings = [];
    const raise = (severity, summary, target) => {
      if (!target) return;
      findings.push({
        id: `r${findings.length + 1}`,
        criterion: RECORD_CRITERION_KEYS[0],
        severity,
        file: read,
        ground: [read, 'src/base.mjs'],
        unit: target.id,
        head: target.head,
        line: 1,
        summary,
        evidence: 'src/base.mjs',
      });
    };
    const body = briefUnits(prompt).filter((u) => u.kind === undefined);
    if (high) raise('HIGH', high, body[0]);
    if (remark) raise('MED', remark, body[high ? 1 : 0]);
    return { report: { findings, summary: 'the record against the tree' } };
  };
}

/** A writer that answers every id its brief names, remarks included. */
function writeAnswering(contents) {
  const seen = new Map();
  return ({ prompt }) => {
    const record = briefRecord(prompt);
    const rounds = (seen.get(record) ?? 0) + 1;
    seen.set(record, rounds);
    const text =
      rounds === 1
        ? contents[record]
        : contents[record].replace('## Decision', `## Decision\n\n${ANSWERED}`);
    return {
      files: { [record]: text },
      report: {
        rewritten: [record],
        unchanged: [],
        ...(prompt.includes('Findings:') && {
          answered: [...new Set([...prompt.matchAll(/\[(F\d+)\]/g)].map((m) => m[1]))].map(
            (id) => ({ id }),
          ),
        }),
        summary: 'the record states what the tree holds',
      },
    };
  };
}

// A remark buys nothing. No verifier reads it, no round answers it, and the
// render is green with the remark named beside the empty open set.
test('a cycle whose findings are all remarks renders green and lists them', async (t) => {
  const fx = stageFixture(t, {
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeOnce(),
      'record-review': reviewGraded(ADR, { remark: 'the record names the module loosely' }),
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');

  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].verdict, 'green');
  assert.deepEqual(rendered[0].open, []);
  const remark = events.find((e) => e.event === 'finding');
  assert.equal(remark.advisory, true);
  assert.equal(remark.record, true);
  assert.equal(remark.severity, 'MED');
  assert.deepEqual(rendered[0].advisory, [remark.id]);
  // The run's most expensive reader is never spawned for a remark, and no
  // round is opened for one.
  assert.ok(!fx.calls.some((c) => c.seat.endsWith('-verifier')));
  assert.ok(!events.some((e) => e.event === 'reconcile-round'));
});

// The remark rides the brief of the round a HIGH opened on its record, and the
// write stamp records the ids the writer says it answered.
test('a corrective round hands the writer the remarks its record holds', async (t) => {
  const fx = stageFixture(t, {
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeAnswering({ [ADR]: ADR_REWRITTEN }),
      'record-review': reviewGraded(ADR, {
        high: 'the record claims a doubling the tree does not hold',
        remark: 'the record names the module loosely',
      }),
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');

  const findings = events.filter((e) => e.event === 'finding');
  const high = findings.find((e) => e.severity === 'HIGH');
  const remark = findings.find((e) => e.severity === 'MED');
  assert.equal(remark.advisory, true);
  assert.equal(high.confirmed, true);
  // The render is red on the HIGH alone, and it names the remark beside it.
  const first = events.filter((e) => e.event === 'reconcile-rendered')[0];
  assert.deepEqual(first.open, [high.id]);
  assert.deepEqual(first.advisory, [remark.id]);

  // The set the round dispatched carries the remark, so a resume rebuilds the
  // same brief.
  const set = events.filter((e) => e.event === 'reconcile-write-set').at(-1);
  assert.deepEqual(set.advisory, [{ record: ADR, ids: [remark.id] }]);

  // The brief states both, and says what a remark is worth.
  const corrective = fx.calls.filter((c) => c.seat === 'reconcile-write').at(-1);
  assert.ok(corrective.prompt.includes(`[${high.id}]`), corrective.prompt);
  assert.ok(corrective.prompt.includes('These remarks hold no render red.'), corrective.prompt);
  assert.ok(corrective.prompt.includes(`[MED] [${remark.id}]`), corrective.prompt);
  assert.ok(corrective.prompt.includes(remark.summary), corrective.prompt);

  // The write stamp names both, so a later round hands the remark over no
  // second time.
  const written = events.filter((e) => e.event === 'reconciliation-written').at(-1);
  assert.deepEqual(written.answered.slice().sort(), [high.id, remark.id].sort());
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').at(-1).verdict, 'green');
});

// A run's remarks are read over every record it holds and no stamp's own list.
// The judge names the records it found owed; a birth writes records it never
// owed, and a corrective round's write stamp names the records that round
// dispatched. Each list leaves out a record another one holds (fix round 1,
// finding 1).
test('the remarks of a run are read over every record it holds', () => {
  const BORN = 'docs/adr/adr-0003-born.md';
  const remark = (id, file, severity) => ({
    event: 'finding',
    id,
    cycle: 1,
    record: true,
    advisory: true,
    severity,
    file,
    unit: 'U2',
    head: 'The module src/base.mjs holds the base',
    summary: `${id}: the record names the module loosely`,
    evidence: 'src/base.mjs',
  });
  const base = [
    { event: 'reconciliation-judged', ok: true, owed: true, records: [ADR] },
    // The birth wrote a record the judge never owed (W6).
    { event: 'records-committed', decided: true, paths: [BORN] },
    { event: 'reconciliation-written', ok: true, rewritten: [ADR], records: [{ record: ADR }] },
    remark('F1', BORN, 'MED'),
    remark('F2', ADR, 'LOW'),
    { event: 'reconcile-rendered', cycle: 1, sha: 'aaa', verdict: 'green', open: [], advisory: ['F1', 'F2'] },
  ];
  const carried = runRemarks(ledger(...base));
  assert.deepEqual(
    carried.map((f) => f.id),
    ['F1', 'F2'],
  );
  // The finding rides whole: the grade, the criterion place and the sentence a
  // ticket and a close stamp state.
  assert.equal(carried[0].severity, 'MED');
  assert.equal(carried[0].file, BORN);
  assert.equal(carried[0].summary, 'F1: the record names the module loosely');

  // A corrective round that answered one remark leaves the other standing, and
  // its own write stamp names one record: a set read from that stamp would drop
  // the remark on the record the round never dispatched.
  const answered = ledger(...base, {
    event: 'reconciliation-written',
    ok: true,
    corrective: true,
    answered: ['F1'],
    rewritten: [BORN],
    records: [{ record: BORN }],
  });
  assert.deepEqual(
    runRemarks(answered).map((f) => f.id),
    ['F2'],
  );
  // A run with no record work at all carries none.
  assert.deepEqual(runRemarks(ledger({ event: 'launched' })), []);
});

// -- the restart boundaries --------------------------------------------------

/**
 * A restart at one step boundary: the stage runs to the stamp the boundary is
 * behind, the daemon goes down and comes back, and the run finishes.
 *
 * `hold` names the seat the boundary stands in front of and `nth` which of its
 * dispatches hangs, so a boundary inside a later round is held as exactly as
 * the first one. Only the stop ends that dispatch, so the daemon goes down with
 * the run on the boundary. Without the hold the stage runs the whole cycle out
 * and the run closes, and the restart lands on a run that is already over.
 */
async function restartAt(t, { at, hold, nth = 1, seats, files = undefined }) {
  const fx = stageFixture(t, { files, seats: { ...seats, [hold]: hangNth(nth, seats[hold]) } });
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, at.predicate, at.label);
  // The held dispatch has to stand before the stop: a stop that starts in front
  // of the spawn ends nothing, and the seat it leaves belongs to no daemon.
  await waitRunEvents(
    fx.paths,
    runId,
    (events) => events.filter((e) => e.event === 'seat-spawned' && baseSeat(e.seat) === hold)[nth - 1],
    { label: `${hold} dispatch ${nth}`, attempts: 900 },
  );
  await fx.restart();
  const events = await waitClosed(fx.paths, runId);
  return { fx, events };
}

/** The seat behind a stamp's name: a slot suffix is not a seat. */
function baseSeat(seat) {
  return String(seat).split(':')[0];
}

test('a restart before the judge re-judges and nothing else', async (t) => {
  const { fx, events } = await restartAt(t, {
    at: { predicate: (e) => e.event === 'stage-entered' && e.stage === 'reconcile', label: 'entered' },
    hold: 'reconcile-judge',
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
    hold: 'reconcile-write',
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
    hold: 'record-review',
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
    hold: 'record-review',
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

test('a restart between the review and the render renders once, from the ledger', async (t) => {
  // The boundary the render stands on. One review seat has answered and the
  // other has not, so the stop falls inside the cycle; the round the restart
  // re-enters re-uses every finding id it assigned.
  const two = {
    [ADR]: ADR_REWRITTEN,
    [ADR_TWO]: ADR_TWO_TEXT + '\nThe module src/base.mjs is read by the feature.\n',
  };
  const fx = stageFixture(t, {
    files: { [ADR_TWO]: ADR_TWO_TEXT },
    seats: {
      'reconcile-judge': judgeOwed(Object.keys(two)),
      'reconcile-write': writeOnce(two),
      'record-review': hangNth(2, reviewClean),
    },
  });
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'record-reviewed', 'the first review');
  await fx.restart();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // One stamp per record per cycle, however many times the round re-entered.
  assert.deepEqual(
    events.filter((e) => e.event === 'record-reviewed').map((e) => e.record).sort(),
    Object.keys(two).slice().sort(),
  );
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').length, 1);
  assert.equal(events.find((e) => e.event === 'reconcile-rendered').verdict, 'green');
  // No verifier: a record round confirms a HIGH as its reviewer raised it.
  assert.equal(fx.calls.filter((c) => c.seat.endsWith('-verifier')).length, 0);
});

test('a restart inside the review re-runs the one seat and renders once', async (t) => {
  const two = {
    [ADR]: ADR_REWRITTEN,
    [ADR_TWO]: ADR_TWO_TEXT + '\nThe module src/base.mjs is read by the feature.\n',
  };
  const fx = stageFixture(t, {
    files: { [ADR_TWO]: ADR_TWO_TEXT },
    seats: {
      'reconcile-judge': judgeOwed(Object.keys(two)),
      'reconcile-write': writeOnce(two),
      // The cycle's one seat never answers, so the stop falls inside the review
      // with no report and no stamp on the ledger.
      'record-review': hangNth(1, reviewClean),
    },
  });
  const runId = await fx.launch();
  await waitRunEvents(
    fx.paths,
    runId,
    (events) => events.find((e) => e.event === 'seat-spawned' && e.seat === 'record-review:1'),
    { label: 'the review seat', attempts: 900 },
  );
  await fx.restart();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');

  // Two dispatches of the one seat: the one the stop ended, and the one the
  // resume made. The cycle costs the dispatch it interrupted and no other.
  const reviews = fx.calls.filter((c) => c.seat === 'record-review');
  assert.equal(reviews.length, 2);
  assert.deepEqual([...new Set(reviews.map((c) => c.full))], ['record-review:1']);
  // One stamp per record of the set, and one render.
  const stamps = events.filter(
    (e) => e.event === 'record-reviewed' || e.event === 'record-unreviewed',
  );
  assert.deepEqual(stamps.map((e) => e.record).sort(), Object.keys(two).slice().sort());
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').length, 1);
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
  // The boundary stands past the red render and inside the round it bought, so
  // the hold is the writer's second dispatch: the corrective one.
  const { events } = await restartAt(t, {
    at: {
      predicate: (e) => e.event === 'reconcile-rendered' && e.verdict === 'red',
      label: 'red render',
    },
    hold: 'reconcile-write',
    nth: 2,
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': writeThenCorrect(),
      'record-review': recordReview(['the record claims a doubling the tree does not hold']),
    },
  });
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.filter((e) => e.event === 'reconcile-round').length, 1);
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').at(-1).verdict, 'green');
});

// A resume past a failed round reads its stamps and dispatches nothing again.
// Every reader of the round takes a report that says it answered nothing
// (ADR-0080, ADR-0090).
test('a resume past a failed round re-dispatches nothing and merges', async (t) => {
  const two = {
    [ADR]: ADR_REWRITTEN,
    [ADR_TWO]: ADR_TWO_TEXT + '\nThe module src/base.mjs is read by the feature.\n',
  };
  // The corrective round spends its attempts and fails. The update stage holds
  // the run once past the stall, so the stop falls behind the failed stamps.
  const fx = stageFixture(t, {
    files: { [ADR_TWO]: ADR_TWO_TEXT },
    seats: {
      'reconcile-judge': judgeOwed(Object.keys(two)),
      'reconcile-write': writeRefusing(two, ADR),
      'record-review': reviewUnanswered('the record claims what the tree does not hold'),
    },
  });
  const runId = await fx.launch();
  await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'record-written' && e.failed === true,
    'a failed write',
  );
  const spawnedBefore = fx.calls.filter((c) => c.seat === 'reconcile-write').length;
  await fx.restart();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(events.filter((e) => e.event === 'park').map((e) => e.type), []);
  // One judged write and one corrective round, and the resume dispatched no
  // writer at all: the stamps say the round is spent.
  assert.equal(events.filter((e) => e.event === 'reconcile-round').length, 1);
  assert.equal(fx.calls.filter((c) => c.seat === 'reconcile-write').length, spawnedBefore);
  const stamps = events.filter((e) => e.event === 'record-written' && e.record === ADR);
  assert.deepEqual(stamps.map((e) => e.failed ?? false), [false, true]);
  // The render names the records the spent round left, and the tree still holds
  // the judged round's own write of them: the run lost no record.
  const rendered = events.filter((e) => e.event === 'reconcile-rendered').at(-1);
  assert.ok(rendered.open.includes(`unwritten:${ADR}`), rendered.open.join(', '));
  assert.deepEqual(unwrittenOf(events), []);
});

// The judged write answers siblings over the same scope the corrective round
// does: the records the judgment names and the records the birth committed
// (ADR-0079).
test('a born peer that cites the judged record is not a sibling', async (t) => {
  const cites = `${ADR_TWO_TEXT}\nIt follows ADR-0001.\n`;
  const fx = stageFixture(t, {
    config: SUPERSEDE_REPO,
    // The birth writes the pair; the judge owes the first record alone.
    seed: seedHandler(async (ctx) => {
      const worktree = ctx.payload.worktree;
      writeFileSync(join(worktree, ADR), ADR_REWRITTEN);
      writeFileSync(join(worktree, ADR_TWO), cites);
      const sha = await commitAll(worktree, 'records: the birth writes the pair');
      ctx.store.append('records-committed', {
        actor: 'daemon',
        sha,
        paths: [ADR, ADR_TWO],
        decided: true,
      });
    }),
    seats: {
      'reconcile-judge': judgeOwed([ADR]),
      'reconcile-write': writeEveryRound(),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const write = fx.calls.find((c) => c.seat === 'reconcile-write');
  assert.ok(write.prompt.includes(`- ${ADR}`), write.prompt.slice(0, 200));
  // The harness computes no sibling list at all: the brief states the duty as
  // prose, and the seat reads the neighbourhood (ADR-0080).
  assert.ok(!write.prompt.includes('"siblings"'), write.prompt);
  assert.match(write.prompt, /Read every active record that cites the one you supersede/);
  // The peer is still the record's neighbour, which is where the seat reads it.
  const neighbourhood = write.prompt.slice(write.prompt.indexOf('The neighbourhood'));
  assert.ok(neighbourhood.includes(`- ${ADR_TWO}`), neighbourhood.slice(0, 300));
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

test('a record the last render kept is not newly owed at the recheck', async (t) => {
  // The pair the run holds: one record a round rewrote, one the second cycle
  // kept. The recheck judge names the kept one, which this run already stands
  // over, so nothing is newly owed and no second judgment is made (ADR-0079).
  let seeded = false;
  const fx = stageFixture(t, {
    repairOnce: true,
    seed: async (ctx) => {
      const worktree = ctx.payload.worktree;
      if (seeded) {
        const baseSha = await headSha(worktree);
        writeFileSync(join(worktree, 'src/other.mjs'), 'export const changed = true;\n');
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
      return seedHandler(async (inner) => {
        const tree = inner.payload.worktree;
        writeFileSync(join(tree, ADR), ADR_REWRITTEN);
        writeFileSync(join(tree, ADR_TWO), `${ADR_TWO_TEXT}\nThe range is src/base.mjs.\n`);
        const sha = await commitAll(tree, 'records: the birth writes the pair');
        inner.store.append('records-committed', {
          actor: 'daemon',
          sha,
          paths: [ADR, ADR_TWO],
          decided: true,
        });
      })(ctx);
    },
    seats: {
      'reconcile-judge': ({ prompt }) =>
        prompt.includes('A repair round changed this run')
          ? { report: { owed: true, records: [ADR_TWO], reason: 'the delta moves the second record' } }
          : judgeOwed([ADR])(),
      'reconcile-write': writeEveryRound(),
      'record-review': reviewOnce(ADR, 'the record claims a doubling the tree does not hold'),
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The green render stood over both: one read, one kept.
  const green = events.filter((e) => e.event === 'reconcile-rendered').find((e) => e.verdict === 'green');
  assert.deepEqual(green.records, [ADR]);
  assert.deepEqual(green.kept, [ADR_TWO]);
  // The recheck owes nothing, and no judgment names the kept record late.
  const recheck = events.find((e) => e.event === 'reconcile-recheck');
  assert.equal(recheck.result, 'kept');
  assert.ok(!events.some((e) => e.event === 'reconciliation-judged' && e.recheck === true));
});

test('a repair whose delta implicates no record stamps the recheck kept', async (t) => {
  const fx = stageFixture(t, {
    seed: repairAfterGreen('src/other.mjs'),
    // The first green render sends the run back for its repair round; the second
    // time the update closes it.
    repairOnce: true,
    seats: {
      'reconcile-judge': ({ prompt }) =>
        prompt.includes('A repair round changed this run')
          ? { report: { owed: false, records: [], causes: [], reason: 'the delta implicates no record' } }
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
  assert.equal(recheck.units, undefined);
  assert.ok(recheck.delta.includes('..'));
  // The recheck judged the delta alone, and the stage wrote nothing behind it.
  assert.equal(events.filter((e) => e.event === 'reconciliation-written').length, 1);
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').length, 1);
  // A corrective record round triggers no code re-verdict.
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 1);
});

// A record the recheck judge names anew is re-reviewed whole. The unit
// intersection is gone: nothing carries a per-unit evidence path, and a record
// is one screen (ADR-0080).
test('a repair whose delta implicates a record re-reviews that record whole', async (t) => {
  const fx = stageFixture(t, {
    seed: repairAfterGreen('src/base.mjs'),
    repairOnce: true,
    seats: {
      'reconcile-judge': ({ prompt }) =>
        prompt.includes('A repair round changed this run')
          ? {
              report: {
                owed: true,
                records: [ADR_TWO],
                causes: ['contradicts'],
                reason: 'the delta moved what it states',
              },
            }
          : judgeOwed()(),
      'reconcile-write': writeOnce({ [ADR]: ADR_REWRITTEN, [ADR_TWO]: ADR_TWO_TEXT }),
      'record-review': reviewClean,
    },
    files: { [ADR_TWO]: ADR_TWO_TEXT },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const recheck = events.find((e) => e.event === 'reconcile-recheck');
  assert.equal(recheck.result, 'owed');
  assert.deepEqual(recheck.records, [ADR_TWO]);
  assert.equal(recheck.units, undefined);
  // The record the judge named is written and reviewed again: a second write,
  // a second render, and the verdict untouched.
  assert.equal(events.filter((e) => e.event === 'reconciliation-written').length, 2);
  assert.equal(events.filter((e) => e.event === 'reconcile-rendered').length, 2);
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 1);
});

// -- the word that says where the judge runs (ADR-0090) ----------------------

/** A project config whose record judge runs after the merge. */
const ADVISORY = {
  gates: {
    tier1: [{ name: 'adr-form', command: 'adrform' }],
    recordLayers: ['adr-form'],
    reconcile: 'advisory',
  },
};

test('the stage under advisory runs the record layers over the born set and no seat', async (t) => {
  const fx = stageFixture(t, {
    config: ADVISORY,
    seed: seedHandler((ctx, { sha }) => {
      ctx.store.append('records-committed', { actor: 'daemon', sha, paths: [ADR], decided: true });
    }),
    seats: {},
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // No seat at all: no judge, no writer, no reviewer.
  assert.deepEqual(fx.calls, []);
  assert.ok(!events.some((e) => e.event === 'reconciliation-judged'));
  assert.ok(!events.some((e) => e.event === 'reconciliation-written'));
  assert.ok(!events.some((e) => e.event === 'reconcile-rendered'));
  // The record layers ran once over the born set, and the stamp carries them.
  const skipped = events.find((e) => e.event === 'reconcile-skipped');
  assert.equal(skipped.mode, 'advisory');
  assert.deepEqual(skipped.layers, [{ layer: 'adr-form', status: 'green' }]);
  assert.deepEqual(
    events.filter((e) => e.event === 'layer-result').map((e) => [e.layer, e.status]),
    [['adr-form', 'green']],
  );
  // The lane certifies no records, which is what every reader behind the stage
  // takes a null for.
  assert.equal(reconcileCertification(events), null);
});

test('a red record layer under advisory rides the stamp and blocks nothing', async (t) => {
  const fx = stageFixture(t, {
    config: {
      commands: { adrform: [process.execPath, '-e', 'process.exit(1)'] },
      gates: ADVISORY.gates,
    },
    seed: seedHandler((ctx, { sha }) => {
      ctx.store.append('records-committed', { actor: 'daemon', sha, paths: [ADR], decided: true });
    }),
    seats: {},
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const skipped = events.find((e) => e.event === 'reconcile-skipped');
  assert.deepEqual(skipped.layers, [{ layer: 'adr-form', status: 'red' }]);
  assert.deepEqual(skippedReds(events), ['adr-form']);
  assert.match(skipped.gist, /the record layers are red and the run goes on/);
  // Nothing blocks: no park, no stall, no render.
  assert.deepEqual(events.filter((e) => e.event === 'park'), []);
  assert.ok(!events.some((e) => e.event === 'reconcile-stall'));
});

test('a run under advisory with no born record stamps the word and runs no layer', async (t) => {
  const fx = stageFixture(t, { config: ADVISORY, seats: {} });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const skipped = events.find((e) => e.event === 'reconcile-skipped');
  assert.deepEqual(skipped.layers, []);
  assert.deepEqual(events.filter((e) => e.event === 'layer-result'), []);
});

test('a restart inside an advisory stage runs the layers once', async (t) => {
  const fx = stageFixture(t, {
    config: ADVISORY,
    holdUpdate: true,
    seed: seedHandler((ctx, { sha }) => {
      ctx.store.append('records-committed', { actor: 'daemon', sha, paths: [ADR], decided: true });
    }),
    seats: {},
  });
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'reconcile-skipped', 'the stage handed on');
  await fx.restart();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // One stamp and one layer run, however many times the stage was entered.
  assert.equal(events.filter((e) => e.event === 'reconcile-skipped').length, 1);
  assert.equal(events.filter((e) => e.event === 'layer-result').length, 1);
});

test('the records lane runs its stage in full under advisory', async (t) => {
  const fx = stageFixture(t, {
    lane: 'records',
    config: ADVISORY,
    seed: async (ctx) => {
      const worktree = ctx.payload.worktree;
      writeFileSync(join(worktree, ADR), ADR_REWRITTEN);
      const sha = await commitAll(worktree, 'records: the birth writes one');
      ctx.store.append('records-committed', { actor: 'daemon', sha, paths: [ADR], decided: true });
      return { next: 'reconcile' };
    },
    seats: { 'record-review': reviewClean },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // Its diff is the records and its birth is the judgment, so the stage judges
  // here whatever the word says (ADR-0090).
  assert.ok(!events.some((e) => e.event === 'reconcile-skipped'));
  assert.equal(events.find((e) => e.event === 'reconciliation-judged').source, 'born');
  const rendered = events.find((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.verdict, 'green');
  assert.deepEqual(rendered.records, [ADR]);
  assert.equal(fx.calls.filter((c) => c.seat === 'record-review').length, 1);
});

test('the judge names a cause per owed record, and a report that names none is no judgment', async (t) => {
  const fx = stageFixture(t, {
    seats: {
      'reconcile-judge': judgeOwed([ADR], 'undecided'),
      'reconcile-write': writeOnce(),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  const judged = events.find((e) => e.event === 'reconciliation-judged');
  assert.deepEqual(judged.records, [ADR]);
  assert.deepEqual(judged.causes, ['undecided']);
  // The brief states the two grounds and no third.
  const judge = fx.calls.find((c) => c.seat === 'reconcile-judge');
  for (const line of OWED_CRITERION) assert.ok(judge.prompt.includes(line), line);

  // A judgment that owes records and names no ground for them is stamped as one
  // the seat could not make, and the stage buys the cycle over the born set.
  const bad = stageFixture(t, {
    seed: seedHandler((ctx, { sha }) => {
      ctx.store.append('records-committed', { actor: 'daemon', sha, paths: [ADR], decided: true });
    }),
    seats: {
      'reconcile-judge': () => ({
        report: { owed: true, records: [ADR], causes: [], reason: 'it moved past this' },
      }),
      'record-review': reviewClean,
    },
  });
  const other = await bad.launch();
  const left = await waitClosed(bad.paths, other);
  assert.equal(left.find((e) => e.event === 'run-closed').state, 'shipped');
  const refused = left.find((e) => e.event === 'reconciliation-judged');
  assert.equal(refused.ok, false);
  assert.equal(refused.owed, false);
  assert.match(refused.cause, /named no cause/);
  assert.ok(!bad.calls.some((c) => c.seat === 'reconcile-write'));
  assert.equal(left.find((e) => e.event === 'reconcile-rendered').verdict, 'green');
});

test('a record the round\'s report says nothing about rides the render unwritten', async (t) => {
  const two = {
    [ADR]: ADR_REWRITTEN,
    [ADR_TWO]: ADR_TWO_TEXT + '\nThe module src/base.mjs is read by the feature.\n',
  };
  const fx = stageFixture(t, {
    files: { [ADR_TWO]: ADR_TWO_TEXT },
    seats: {
      'reconcile-judge': judgeOwed(Object.keys(two)),
      // The seat writes both records and reports one of them. The other is a
      // record it held and said nothing about (ADR-0090).
      'reconcile-write': ({ prompt }) => ({
        files: Object.fromEntries(briefRecords(prompt).map((r) => [r, two[r]])),
        report: {
          rewritten: [ADR],
          unchanged: [],
          ...(prompt.includes('Findings:') && { answered: findingIds(prompt) }),
          summary: 'one of the two',
        },
      }),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const written = events.find((e) => e.event === 'reconciliation-written');
  const missed = written.records.find((r) => r.record === ADR_TWO);
  assert.equal(missed.failed, true);
  assert.equal(missed.reason, 'unreported');
  // The render carries it by name, and the next round dispatches it.
  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.ok(rendered[0].open.includes(`unwritten:${ADR_TWO}`), rendered[0].open.join(', '));
  const round = events.find((e) => e.event === 'reconcile-round');
  assert.deepEqual(round.records, [ADR_TWO]);
});

// -- what the stage took out of the verdict (ADR-0075) -----------------------
//
// The coupling between the two certifications was a set of readers, and a
// reader that stays is a coupling that stays. Each name below is asserted
// absent from the module that held it, because the removal is only kept by
// nothing reading them again.

test('every reader of the old coupling is gone from its module', () => {
  const source = (path) => readFileSync(join(import.meta.dirname, '..', path), 'utf8');
  const verdict = source('src/lanes/verdict.mjs');
  for (const name of [
    'droppedFindings',
    'reconcileFallbackStamp',
    'reconcileCorrection',
    'reconcileFallbackArm',
    'reconcileArm',
    'reconcileRounds(',
    'judgedReconcile',
    'certifyingReconcile',
    'RECORD_LAYER_RED',
    'RECORD_FINDINGS',
    'renderOverReconcile',
    'reconcileCommit',
  ]) {
    assert.ok(!verdict.includes(name), `verdict.mjs still holds ${name}`);
  }
  // The verdict reads no record stamp at all.
  assert.ok(!verdict.includes('reconciliation-written'), 'the verdict reads a record stamp');
  assert.ok(!verdict.includes('reconcile-rendered'), 'the verdict reads the stage render');

  const shared = source('src/lanes/shared.mjs');
  assert.ok(!shared.includes('reconcileCommit'), 'shared.mjs still holds reconcileCommit');
  assert.ok(!shared.includes('renderOverReconcile'), 'shared.mjs still holds renderOverReconcile');

  // The ship judges no record and writes none: the round moved to the stage.
  const ship = source('src/lanes/ship.mjs');
  for (const name of ['reconcileStep', 'reconcileJudge', 'reconcileRound', 'certifiedTree(']) {
    assert.ok(!ship.includes(name), `ship.mjs still holds ${name}`);
  }

  // The reconciliation sweep left the plan with the round that named it.
  assert.ok(!source('src/lanes/spectrum.mjs').includes('sweep: ' + "'reconcile'"));

  // And the retired cause is gone from the registry.
  assert.ok(!source('src/ledger/registry.mjs').includes('RECORD_FINDINGS'));
});

// -- the closed record (ADR-0078) ---------------------------------------------
//
// A closed record is out of every seat's scope, and the set a round or a cycle
// dispatched over is a fact of the ledger. The two rules are one story: a
// filter that read the tree at every entry would shrink the list between two
// entries of one round, and a seat name is the index in that list.

/** The record as a write closes it: nothing changed but the status line. */
const ADR_RETIRED = ADR_TEXT.replace(
  '**Status:** Accepted',
  '**Status:** Retired (2026-09-08): the module this record named is gone.',
);

const ADR_TWO_RETIRED = ADR_TWO_TEXT.replace(
  '**Status:** Accepted',
  '**Status:** Retired (2026-09-08): the value this record named is gone.',
);

/** A record that replaces another, naming it back under its status line. */
function replacement(id, parents, title, decision) {
  return [
    `# ADR-${id}: ${title}`,
    '',
    '**Status:** Accepted',
    `**Supersedes:** ${parents}`,
    '',
    '## Decision',
    '',
    decision,
    '',
  ].join('\n');
}

/** The record as a write supersedes it, and the record that replaces it. */
const SUPERSEDES = {
  [ADR]: {
    closed: ADR_TEXT.replace(
      '**Status:** Accepted',
      '**Status:** Superseded by ADR-0003 (2026-09-08)',
    ),
    added: 'docs/adr/adr-0003-name-the-base.md',
    text: replacement('0003', 'ADR-0001', 'Name the base', 'The module src/base.mjs names the base.'),
  },
  [ADR_TWO]: {
    closed: ADR_TWO_TEXT.replace(
      '**Status:** Accepted',
      '**Status:** Superseded by ADR-0004 (2026-09-08)',
    ),
    added: 'docs/adr/adr-0004-read-the-base.md',
    text: replacement('0004', 'ADR-0002', 'Read the base', 'The module src/base.mjs holds one value.'),
  },
};

/** The project that supersedes its records rather than editing them. */
const SUPERSEDE_REPO = {
  repo: {
    testPaths: ['tests'],
    recordPaths: ['docs/adr', `!${TEMPLATE}`],
    recordLifecycle: 'supersede',
  },
};

/**
 * A writer that supersedes the record it was given: the old record takes its
 * status line, and the record that replaces it is the one the report answers.
 */
function supersedeWrite(map) {
  return ({ prompt }) => {
    const records = briefRecords(prompt);
    const files = {};
    const added = [];
    for (const record of records) {
      const entry = map[record];
      files[record] = entry.closed;
      files[entry.added] = entry.text;
      added.push(entry.added);
    }
    return {
      files,
      report: {
        // A closed record is listed in neither list: its status line is a fact
        // of the tree and not a rewrite (ADR-0078).
        rewritten: added,
        unchanged: [],
        summary: `${records.join(', ')} are superseded`,
      },
    };
  };
}

/** A seed that closes the record and stamps the birth that holds it. */
function closedSeed(text = ADR_RETIRED) {
  return seedHandler(async (ctx) => {
    const worktree = ctx.payload.worktree;
    writeFileSync(join(worktree, ADR), text);
    const sha = await commitAll(worktree, 'records: the record is closed');
    ctx.store.append('records-committed', { actor: 'daemon', sha, paths: [ADR], decided: true });
  });
}

// The stage's certification is what the ship stage bounces on. A red render the
// stage answered with a fallback is the stage's last word, so the run merges
// with what is still wrong named; a red render with nothing behind it is a stage
// that never finished, and the ship stage hands the run back (ADR-0080).
test('a red render a fallback answered certifies, and a bare red render does not', () => {
  const red = { event: 'reconcile-rendered', cycle: 1, sha: 'r1', verdict: 'red', open: ['F1'] };
  const green = { event: 'reconcile-rendered', cycle: 2, sha: 'r2', verdict: 'green', open: [] };
  const fallback = { event: 'reconciliation-written', ok: false, cause: 'record-cap' };
  // Nothing rendered: the run owes no reconciliation at all.
  assert.equal(reconcileCertification(ledger()), null);
  // A red with nothing behind it. The ship stage reads this and hands back.
  assert.deepEqual(reconcileCertification(ledger(red)), { sha: 'r1', ok: false });
  // The same red with the stall's own fallback behind it.
  assert.deepEqual(reconcileCertification(ledger(red, fallback)), {
    sha: 'r1',
    ok: true,
    fallback: 'record-cap',
  });
  // A fallback in front of the render answers a render that is past it.
  assert.deepEqual(reconcileCertification(ledger(fallback, red)), { sha: 'r1', ok: false });
  assert.deepEqual(reconcileCertification(ledger(red, fallback, green)), { sha: 'r2', ok: true });
});

// What the run says it never wrote is read over this pass alone, and per record
// and never per dispatch (ADR-0080).
test('the unwritten set opens at the judgment and reads the pass, not the dispatch', () => {
  const other = 'docs/adr/adr-0009-other.md';
  const judged = { event: 'reconciliation-judged', ok: true, owed: true, records: [ADR] };
  // A drop a merge round made before this pass belongs to the pass that made
  // it. The pass behind it writes its records again.
  assert.deepEqual(
    unwrittenOf(ledger({ event: 'merge-round', recordsDropped: [other] }, judged)),
    [],
  );
  // A dispatch that wrote, then a corrective dispatch of the same pass that
  // changed no line: the tree still holds what the first one wrote.
  assert.deepEqual(
    unwrittenOf(
      ledger(
        judged,
        { event: 'record-written', record: ADR },
        { event: 'record-written', record: ADR, dropped: [ADR] },
      ),
    ),
    [],
  );
  // A dispatch that failed before any dispatch wrote the record.
  assert.deepEqual(
    unwrittenOf(ledger(judged, { event: 'record-written', record: ADR, failed: true })),
    [ADR],
  );
  // A merge that took the default branch's version undoes every write behind it.
  assert.deepEqual(
    unwrittenOf(
      ledger(
        judged,
        { event: 'record-written', record: ADR },
        { event: 'merge-round', recordsDropped: [ADR] },
      ),
    ),
    [ADR],
  );
});

test('the cycle derives its review from the set it was dispatched over', () => {
  const closed = 'docs/adr/adr-0009-closed.md';
  const born = { event: 'records-committed', decided: true, paths: [ADR, closed], sha: 'bbb' };
  const clean = { event: 'reconciliation-judged', ok: true, owed: false, born: [ADR], late: [] };
  const layer = { event: 'layer-result', cycle: 1, layer: 'adr-form', status: 'green' };
  const set = { event: 'reconcile-review-set', cycle: 1, records: [ADR], skipped: [] };
  const stamp = { event: 'record-reviewed', cycle: 1, record: ADR, seat: 'record-review:1' };
  // The dispatched set is the active record alone, and its seat has answered.
  assert.equal(reconcileStep(ledger(born, clean, layer, set, stamp)), 'render');
  // Before its seats report, the cycle still owes the review.
  assert.equal(reconcileStep(ledger(born, clean, layer, set)), 'review');
  // A seat that could not read its record answers for it all the same: the two
  // stamps are one boundary, and the render lists the record unreviewed.
  const missed = { event: 'record-unreviewed', cycle: 1, record: ADR, seat: 'record-review:1' };
  assert.equal(reconcileStep(ledger(born, clean, layer, set, missed)), 'render');
  // The anchor holds the closed record, which takes no seat and leaves no
  // stamp. A derivation that read the anchor would re-enter the review of a
  // cycle that is past it, so a ledger with the stamp never does.
  assert.equal(reconcileStep(ledger(born, clean, layer, stamp)), 'review');
  // The stamp answers for its own cycle and for no other.
  const other = { event: 'reconcile-review-set', cycle: 2, records: [], skipped: [] };
  assert.equal(reconcileStep(ledger(born, clean, layer, other, stamp)), 'review');
});

test('a closed record takes no review seat, and the layers still read its path', async (t) => {
  const fx = stageFixture(t, {
    config: {
      ...SUPERSEDE_REPO,
      commands: {
        adrform: [process.execPath, '-e', 'process.exit(0)'],
        codegate: [process.execPath, '-e', 'process.exit(0)'],
      },
      gates: {
        tier1: [
          { name: 'adr-form', command: 'adrform' },
          { name: 'code', command: 'codegate' },
        ],
        recordLayers: ['adr-form'],
      },
    },
    seed: closedSeed(),
    seats: { 'reconcile-judge': judgeClean, 'record-review': reviewClean },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The born set holds the closed record. No seat is dispatched over it.
  assert.deepEqual(events.find((e) => e.event === 'records-committed').paths, [ADR]);
  assert.equal(fx.calls.filter((c) => c.seat === 'record-review').length, 0);
  const rendered = events.find((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.verdict, 'green');
  assert.deepEqual(rendered.records, []);
  // The layers read the record diff whole, so the form gate still reads the
  // file the closure changed and the code layer stays out.
  assert.deepEqual(
    events.filter((e) => e.event === 'layer-result').map((e) => [e.layer, e.status]),
    [['adr-form', 'green']],
  );
});

test('a project that rewrites its records reviews the active ones alone', async (t) => {
  const fx = stageFixture(t, {
    seed: closedSeed(),
    seats: { 'reconcile-judge': judgeClean, 'record-review': reviewClean },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(fx.calls.filter((c) => c.seat === 'record-review').length, 0);
  // The cycle stamps what it dispatched and what it dropped, with the status
  // word the dropped record carried. The lifecycle does not gate the filter: a
  // record closed by hand traps a seat exactly as a superseded one does.
  const dispatched = events.filter((e) => e.event === 'reconcile-review-set');
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].records, []);
  assert.deepEqual(dispatched[0].skipped, [{ record: ADR, status: 'retired' }]);
  assert.deepEqual(events.find((e) => e.event === 'reconcile-rendered').records, []);
});

test('a judged record the tree has closed takes no writer', async (t) => {
  const fx = stageFixture(t, {
    files: { [ADR_TWO]: ADR_TWO_RETIRED },
    seats: {
      'reconcile-judge': judgeOwed([ADR, ADR_TWO]),
      'reconcile-write': writeOnce(),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The judge named both records and its stamp keeps that answer.
  assert.deepEqual(events.find((e) => e.event === 'reconciliation-judged').records, [ADR, ADR_TWO]);
  // One dispatch, over the active record alone, and its brief names no other.
  const writers = fx.calls.filter((c) => c.seat === 'reconcile-write');
  assert.deepEqual(
    writers.map((c) => c.full),
    ['reconcile-write:1'],
  );
  assert.ok(writers[0].prompt.includes(`- ${ADR}`), writers[0].prompt);
  assert.ok(!writers[0].prompt.includes(ADR_TWO), writers[0].prompt);
  const written = events.find((e) => e.event === 'reconciliation-written');
  assert.deepEqual(written.rewritten, [ADR]);
  assert.equal(written.records.length, 1);
  // The drop is a fact and never a silence: the round stamps the list it
  // dispatched, the tree it opened on, and what it left out.
  const dispatched = events.filter((e) => e.event === 'reconcile-write-set');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].round, 0);
  assert.equal(typeof dispatched[0].sha, 'string');
  assert.deepEqual(dispatched[0].records, [ADR]);
  assert.deepEqual(dispatched[0].skipped, [{ record: ADR_TWO, status: 'retired' }]);
  // The stamp lands before the first seat of the round spawns, so no dispatch
  // is ever made off a list the ledger does not hold.
  const firstWriter = events.find(
    (e) => e.event === 'seat-spawned' && e.seat.startsWith('reconcile-write'),
  );
  assert.ok(dispatched[0].seq < firstWriter.seq, 'the set was stamped after the first seat');
  // The stamped list is the seats the ledger then spawned, in order.
  assert.deepEqual(
    events
      .filter((e) => e.event === 'seat-spawned' && e.seat.startsWith('reconcile-write'))
      .map((e) => e.seat),
    dispatched[0].records.map((_, i) => `reconcile-write:${i + 1}`),
  );
});

test('a corrective round leaves the closed record of the born set alone', async (t) => {
  const fx = stageFixture(t, {
    files: { [ADR_TWO]: ADR_TWO_RETIRED },
    // The birth decided one record and closed another. Both are on the born
    // stamp, and the cycle stands on it.
    seed: seedHandler(async (ctx, { sha }) => {
      ctx.store.append('records-committed', {
        actor: 'daemon',
        sha,
        paths: [ADR, ADR_TWO],
        decided: true,
      });
    }),
    seats: {
      'reconcile-judge': judgeClean,
      'reconcile-write': writeThenCorrect(),
      'record-review': recordReview(['the record claims a doubling the tree does not hold']),
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const rounds = events.filter((e) => e.event === 'reconcile-round');
  assert.equal(rounds.length, 1);
  assert.deepEqual(rounds[0].records, [ADR]);
  const writers = fx.calls.filter((c) => c.seat === 'reconcile-write');
  assert.deepEqual(
    writers.map((c) => c.full),
    ['reconcile-write:1'],
  );
  assert.ok(!writers[0].prompt.includes(ADR_TWO), writers[0].prompt);
  const dispatched = events.filter((e) => e.event === 'reconcile-write-set');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].round, 1);
  assert.deepEqual(dispatched[0].skipped, [{ record: ADR_TWO, status: 'retired' }]);
});

test('a judged write that supersedes its record answers the replacement', async (t) => {
  const fx = stageFixture(t, {
    config: SUPERSEDE_REPO,
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': supersedeWrite(SUPERSEDES),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // One attempt, no refusal: the write closed the record it was given and
  // answered the record it added.
  assert.equal(fx.calls.filter((c) => c.seat === 'reconcile-write').length, 1);
  assert.ok(!events.some((e) => e.event === 'seat-failure'));
  const written = events.find((e) => e.event === 'reconciliation-written');
  assert.deepEqual(written.rewritten, [SUPERSEDES[ADR].added]);
  assert.deepEqual(
    written.records.map((r) => r.record),
    [ADR],
  );
  assert.equal(typeof written.records[0].sha, 'string');
  // The write stamp names the record the dispatch was given, and the resume
  // reads it (ADR-0080).
  assert.deepEqual(
    events.filter((e) => e.event === 'record-written').map((e) => e.record),
    [ADR],
  );
  // The cycle reviews the replacement, and the closed record takes no seat.
  const reviewed = events.filter((e) => e.event === 'reconcile-review-set');
  assert.deepEqual(reviewed.at(-1).records, [SUPERSEDES[ADR].added]);
  assert.equal(events.find((e) => e.event === 'reconcile-rendered').verdict, 'green');
});

test('a judged write that supersedes one record with two answers both', async (t) => {
  const heirs = ['docs/adr/adr-0003-name-the-base.md', 'docs/adr/adr-0004-read-the-base.md'];
  const texts = {
    [heirs[0]]: replacement('0003', 'ADR-0001', 'Name the base', 'The module src/base.mjs names the base.'),
    [heirs[1]]: replacement('0004', 'ADR-0001', 'Read the base', 'The module src/base.mjs holds one value.'),
  };
  const split = {
    [ADR]: {
      closed: ADR_TEXT.replace(
        '**Status:** Accepted',
        '**Status:** Superseded by ADR-0003 and ADR-0004 (2026-09-08)',
      ),
      files: texts,
    },
  };
  const fx = stageFixture(t, {
    config: SUPERSEDE_REPO,
    seats: {
      'reconcile-judge': judgeOwed(),
      'reconcile-write': ({ prompt }) => {
        const record = briefRecord(prompt);
        const { closed, files } = split[record];
        return {
          files: { [record]: closed, ...files },
          report: {
            rewritten: heirs,
            unchanged: [],
            summary: `${record} becomes two records`,
          },
        };
      },
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // One attempt, no refusal: the write closed the record it was given and
  // answered the two records it added.
  assert.equal(fx.calls.filter((c) => c.seat === 'reconcile-write').length, 1);
  assert.ok(!events.some((e) => e.event === 'seat-failure'));
  const written = events.find((e) => e.event === 'reconciliation-written');
  assert.deepEqual(written.rewritten, heirs);
  assert.deepEqual(
    written.records.map((r) => r.record),
    [ADR],
  );
  assert.equal(typeof written.records[0].sha, 'string');
  // One write stamp per dispatch, naming the record the dispatch was given.
  assert.deepEqual(
    events.filter((e) => e.event === 'record-written').map((e) => e.record),
    [ADR],
  );
  // The cycle reviews both replacements in one seat, and the closed record
  // takes no place in the set (ADR-0090).
  assert.deepEqual(events.filter((e) => e.event === 'reconcile-review-set').at(-1).records, heirs);
  assert.equal(fx.calls.filter((c) => c.seat === 'record-review').length, 1);
  assert.equal(events.find((e) => e.event === 'reconcile-rendered').verdict, 'green');
});

// A merge: two judged records become one, and one seat writes it. Both parents
// leave the round closed, and a closed record is an answer the report lists in
// neither of its two lists (ADR-0078, ADR-0090).
test('a round that merges two records into one answers for both of them', async (t) => {
  const merged = 'docs/adr/adr-0003-hold-the-base-once.md';
  const mergedText = replacement(
    '0003',
    'ADR-0001 and ADR-0002',
    'Hold the base once',
    'The module src/base.mjs holds one value the feature reads.',
  );
  const closed = (text, id) =>
    text.replace('**Status:** Accepted', `**Status:** Superseded by ADR-${id} (2026-09-08)`);
  const fx = stageFixture(t, {
    config: SUPERSEDE_REPO,
    files: { [ADR_TWO]: ADR_TWO_TEXT },
    seats: {
      'reconcile-judge': judgeOwed([ADR, ADR_TWO]),
      // One seat holds both parents. It writes the merged record and closes the
      // two, and it lists neither parent: a status line is not a rewrite.
      'reconcile-write': () => ({
        files: {
          [ADR]: closed(ADR_TEXT, '0003'),
          [ADR_TWO]: closed(ADR_TWO_TEXT, '0003'),
          [merged]: mergedText,
        },
        report: {
          rewritten: [merged],
          unchanged: [],
          summary: 'two records merge into one',
        },
      }),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // One seat, one attempt: it was not refused.
  assert.deepEqual(
    events
      .filter((e) => e.event === 'seat-spawned' && e.seat.startsWith('reconcile-write'))
      .map((e) => e.seat),
    ['reconcile-write:1'],
  );
  assert.ok(!events.some((e) => e.event === 'seat-failure'));
  const written = events.find((e) => e.event === 'reconciliation-written');
  assert.equal(written.ok, true);
  assert.deepEqual(written.rewritten, [merged]);
  assert.deepEqual(
    written.records.map((r) => r.record),
    [ADR, ADR_TWO],
  );
  // Both parents are answered, and neither rides the render as unwritten: the
  // round closed them, which is the third legal answer (ADR-0090).
  assert.ok(!written.records.some((r) => r.failed === true), JSON.stringify(written.records));
  assert.deepEqual(
    events.filter((e) => e.event === 'record-written').map((e) => e.record),
    [ADR, ADR_TWO],
  );
  assert.deepEqual(unwrittenOf(events), []);
});

// A red layer over a set whose every record is closed. No seat can answer it,
// so the round that would buy nothing is not bought (ADR-0078).
test('a red render over a set with nothing to dispatch stalls at once', async (t) => {
  const fx = stageFixture(t, {
    config: {
      commands: { adrform: [process.execPath, '-e', 'process.exit(1)'] },
      gates: {
        tier1: [{ name: 'adr-form', command: 'adrform' }],
        recordLayers: ['adr-form'],
        reconcileRounds: 5,
      },
    },
    seed: closedSeed(),
    seats: { 'reconcile-judge': judgeClean, 'record-review': reviewClean },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].verdict, 'red');
  assert.deepEqual(rendered[0].open, ['adr-form']);
  // The stall is the stage's answer, and no round was spent on it.
  const stall = events.find((e) => e.event === 'reconcile-stall');
  assert.equal(stall.rounds, 0);
  assert.deepEqual(stall.open, ['adr-form']);
  assert.match(stall.gist, /nothing to dispatch/);
  assert.equal(events.filter((e) => e.event === 'reconcile-round').length, 0);
  assert.equal(fx.calls.filter((c) => c.seat === 'reconcile-write').length, 0);
  const written = events.find((e) => e.event === 'reconciliation-written');
  assert.equal(written.ok, false);
  assert.equal(written.cause, 'record-cap');
});

// A red layer whose output names a record no seat may answer for. The question
// of who owes an answer is asked over the active set, so the round widens to
// that set rather than dispatching nothing and stalling (ADR-0079).
// The scope a corrective seat answers siblings over is the set this run holds,
// and not the list the round dispatches. A peer the round kept is answered by
// the seat that wrote it (ADR-0079).
test('a kept peer that cites the dispatched record is not a sibling', async (t) => {
  const cites = `${ADR_TWO_TEXT}\nIt follows ADR-0001.\n`;
  const fx = stageFixture(t, {
    config: SUPERSEDE_REPO,
    seed: seedHandler(async (ctx) => {
      const worktree = ctx.payload.worktree;
      writeFileSync(join(worktree, ADR), ADR_REWRITTEN);
      writeFileSync(join(worktree, ADR_TWO), cites);
      const sha = await commitAll(worktree, 'records: the birth writes the pair');
      ctx.store.append('records-committed', {
        actor: 'daemon',
        sha,
        paths: [ADR, ADR_TWO],
        decided: true,
      });
    }),
    seats: {
      'reconcile-judge': judgeClean,
      'reconcile-write': writeEveryRound(),
      'record-review': reviewOnce(ADR, 'the record claims a doubling the tree does not hold'),
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // One round over one record, with the peer kept.
  const round = events.find((e) => e.event === 'reconcile-round');
  assert.deepEqual(round.records, [ADR]);
  assert.deepEqual(
    (events.filter((e) => e.event === 'reconcile-write-set').at(-1).kept ?? []).map((k) => k.record),
    [ADR_TWO],
  );
  // The corrective brief asks for no sibling table at all.
  const corrective = fx.calls.filter((c) => c.seat === 'reconcile-write').at(-1);
  assert.ok(corrective.prompt.includes('Findings:'), corrective.prompt.slice(0, 200));
  assert.ok(!corrective.prompt.includes('"siblings"'), corrective.prompt);
  // The peer is still the record's neighbour, which is where the seat reads it.
  const neighbourhood = corrective.prompt.slice(corrective.prompt.indexOf('The neighbourhood'));
  assert.ok(neighbourhood.includes(`- ${ADR_TWO}`), neighbourhood.slice(0, 300));
});

test('a red layer that names a closed record dispatches nothing and merges', async (t) => {
  // The layer names a record no seat may answer for, so the round dispatches
  // nothing and the stage stalls at once (ADR-0080).
  const layer = [
    'const fs = require("fs");',
    `const ok = fs.readFileSync(${JSON.stringify(ADR)}, "utf8").includes("Dispatch");`,
    `if (!ok) console.log(${JSON.stringify(`${ADR_TWO}:3 the status line is malformed`)});`,
    'process.exit(ok ? 0 : 1);',
  ].join('\n');
  const fx = stageFixture(t, {
    lane: 'records',
    config: {
      commands: { adrform: [process.execPath, '-e', layer] },
      gates: {
        tier1: [{ name: 'adr-form', command: 'adrform' }],
        recordLayers: ['adr-form'],
        reconcileRounds: 5,
      },
    },
    // The birth wrote one record and closed another. The layer is red and its
    // output names the closed one.
    seed: async (ctx) => {
      const worktree = ctx.payload.worktree;
      writeFileSync(join(worktree, ADR_TWO), ADR_TWO_RETIRED);
      const sha = await commitAll(worktree, 'records: the birth writes one and closes one');
      ctx.store.append('records-committed', {
        actor: 'daemon',
        sha,
        paths: [ADR, ADR_TWO],
        decided: true,
      });
      return { next: 'reconcile' };
    },
    seats: {
      'reconcile-judge': judgeClean,
      'reconcile-write': writeEveryRound(),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // No round: a writer over the active record could not clear a red the layer
  // raised about a closed one.
  assert.deepEqual(events.filter((e) => e.event === 'reconcile-round'), []);
  assert.deepEqual(events.filter((e) => e.event === 'park').map((e) => e.type), []);
  const stall = events.find((e) => e.event === 'reconcile-stall');
  assert.equal(stall.rounds, 0);
  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.deepEqual(rendered[0].open, ['adr-form']);
  assert.equal(events.filter((e) => e.event === 'reconciliation-written').at(-1).cause, 'record-cap');
});

test('a cycle past the review of a set with a closed record reads the review done', async (t) => {
  const fx = stageFixture(t, {
    files: { [ADR_TWO]: ADR_TWO_RETIRED },
    seed: seedHandler(async (ctx, { sha }) => {
      ctx.store.append('records-committed', {
        actor: 'daemon',
        sha,
        paths: [ADR, ADR_TWO],
        decided: true,
      });
    }),
    seats: { 'reconcile-judge': judgeClean, 'record-review': reviewClean },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The closed record was never dispatched to a seat.
  const stamped = events.filter((e) => e.event === 'reconcile-review-set');
  assert.equal(stamped.length, 1);
  assert.deepEqual(stamped[0].records, [ADR], 'the closed record was dispatched to a seat');
  assert.deepEqual(
    events.filter((e) => e.event === 'record-reviewed').map((e) => e.record),
    [ADR],
  );

  // The boundary a restart lands on, read off the ledger the run left: the
  // cycle whose seats have answered owes the render and no review seat.
  const held = events.filter((e) => e.seq <= events.find((e) => e.event === 'record-reviewed').seq);
  assert.equal(reconcileStep(held), 'render');
  // The same ledger without the stamp is what a run from before this rule
  // wrote, and it derives the review as owed all over again.
  assert.equal(reconcileStep(held.filter((e) => e.event !== 'reconcile-review-set')), 'review');

  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].verdict, 'green');
  assert.deepEqual(rendered[0].records, [ADR]);
});

// The round dispatches the list it stamped, on every entry. A seat that closes
// a record it was given moves that record out of a filter that reads the tree,
// so a resume that read the tree again would answer for a set nobody dispatched
// (ADR-0078, ADR-0090).
test('a restart mid-round dispatches the set the round stamped', async (t) => {
  const fx = stageFixture(t, {
    config: SUPERSEDE_REPO,
    files: { [ADR_TWO]: ADR_TWO_TEXT },
    seats: {
      'reconcile-judge': judgeOwed([ADR, ADR_TWO]),
      // The round's one seat never answers, so the stop falls inside the round
      // with the set stamped and nothing written.
      'reconcile-write': hangNth(1, supersedeWrite(SUPERSEDES)),
      'record-review': reviewClean,
    },
  });
  const runId = await fx.launch();
  await waitRunEvents(
    fx.paths,
    runId,
    (events) => events.find((e) => e.event === 'seat-spawned' && e.seat === 'reconcile-write:1'),
    { label: 'the writer', attempts: 900 },
  );
  await fx.restart();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The round stamped the list it dispatched, once, and the resume read it.
  const dispatched = events.filter((e) => e.event === 'reconcile-write-set');
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].records, [ADR, ADR_TWO]);
  assert.deepEqual(dispatched[0].skipped, []);
  // Both records are answered by the one seat, and the round closed both.
  const written = events.find((e) => e.event === 'reconciliation-written');
  assert.deepEqual(
    written.records.map((r) => [r.record, r.seat]),
    [
      [ADR, 'reconcile-write:1'],
      [ADR_TWO, 'reconcile-write:1'],
    ],
  );
  assert.ok(
    written.records.every((r) => typeof r.sha === 'string'),
    JSON.stringify(written.records),
  );
  assert.deepEqual(
    events.filter((e) => e.event === 'record-written').map((e) => [e.record, e.seat]),
    [
      [ADR, 'reconcile-write:1'],
      [ADR_TWO, 'reconcile-write:1'],
    ],
  );
  // One commit for the round, with the set in its body: the subject names the
  // run, the seat and the ledger position, and the body names the records
  // (ADR-0090).
  const commit = fx.trees.at(-1).messages.find((entry) => entry.includes('reconcile: '));
  assert.ok(/reconcile: \S+ reconcile-write:1 @\d+/.test(commit), commit);
  for (const record of [ADR, ADR_TWO]) assert.ok(commit.includes(record), commit);
});

// A cycle dispatches the list it stamped. A list the filter shrinks between two
// entries of one cycle would lose the answer for the record it dropped
// (ADR-0078).
test('a cycle re-entered after the tree closed a record reviews the set it stamped', async (t) => {
  const fx = stageFixture(t, {
    files: { [ADR_TWO]: ADR_TWO_TEXT },
    seed: seedHandler(async (ctx, { sha }) => {
      ctx.store.append('records-committed', {
        actor: 'daemon',
        sha,
        paths: [ADR, ADR_TWO],
        decided: true,
      });
    }),
    seats: {
      'reconcile-judge': judgeClean,
      // The cycle's one seat never answers, so the stop falls inside it.
      'record-review': hangNth(1, reviewClean),
    },
  });
  const runId = await fx.launch();
  await waitRunEvents(
    fx.paths,
    runId,
    (events) => events.find((e) => e.event === 'seat-spawned' && e.seat === 'record-review:1'),
    { label: 'the review seat', attempts: 900 },
  );
  const held = readEvents(runLedgerPath(fx.paths, runId));
  const stamped = held.filter((e) => e.event === 'reconcile-review-set');
  assert.equal(stamped.length, 1);
  assert.deepEqual(stamped[0].records, [ADR, ADR_TWO]);
  // The stamp lands before the cycle's seat spawns.
  const firstReview = held.find(
    (e) => e.event === 'seat-spawned' && e.seat.startsWith('record-review'),
  );
  assert.ok(stamped[0].seq < firstReview.seq, 'the set was stamped after the seat');
  const worktree = held.find((e) => e.event === 'run-launched').worktree;
  // The tree moves under the cycle: one of the two records it is reviewing is
  // closed while the daemon is down.
  await fx.daemon.stop();
  writeFileSync(join(worktree, ADR), ADR_RETIRED);
  await fx.restart();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // One stamp for the cycle, and the render reads the set it names.
  assert.equal(events.filter((e) => e.event === 'reconcile-review-set').length, 1);
  const rendered = events.filter((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.length, 1);
  assert.deepEqual(rendered[0].records, [ADR, ADR_TWO]);
  // Both records kept their answers, because the cycle read the set it stamped.
  assert.deepEqual(
    events
      .filter((e) => (e.event === 'record-reviewed' || e.event === 'record-unreviewed'))
      .map((e) => e.record)
      .sort(),
    [ADR, ADR_TWO].sort(),
  );
});

// The commit is the durable half of a write and the stamps behind it are the
// recorded half. A stop between the two re-reads the body and stamps from it,
// and the seat is dispatched again never (ADR-0090).
test('a write stopped between its commit and its stamps resumes from the body', async (t) => {
  const two = {
    [ADR]: ADR_REWRITTEN,
    [ADR_TWO]: ADR_TWO_TEXT + '\nThe module src/base.mjs is read by the feature.\n',
  };
  const fx = stageFixture(t, {
    files: { [ADR_TWO]: ADR_TWO_TEXT },
    seats: {
      'reconcile-judge': judgeOwed(Object.keys(two)),
      'reconcile-write': writeOnce(two),
      // The cycle behind the write never answers, so the stop lands past the
      // commit and its stamps.
      'record-review': hangNth(1, reviewClean),
    },
  });
  const runId = await fx.launch();
  await waitRunEvents(
    fx.paths,
    runId,
    (events) => events.find((e) => e.event === 'seat-spawned' && e.seat === 'record-review:1'),
    { label: 'the review seat', attempts: 900 },
  );
  await fx.daemon.stop();
  // The ledger of a run the stop caught between the commit and the stamps: the
  // commit stands in the tree and nothing on the ledger says so.
  const path = runLedgerPath(fx.paths, runId);
  const dropped = new Set(['record-written', 'reconciliation-written', 'reconcile-review-set']);
  const kept = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0 && !dropped.has(JSON.parse(line).event));
  writeFileSync(path, `${kept.join('\n')}\n`);
  const spawnedBefore = fx.calls.filter((c) => c.seat === 'reconcile-write').length;
  await fx.restart();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // No second writer: the resume read the commit body and stamped from it.
  assert.equal(fx.calls.filter((c) => c.seat === 'reconcile-write').length, spawnedBefore);
  assert.deepEqual(
    events.filter((e) => e.event === 'record-written').map((e) => e.record),
    Object.keys(two),
  );
  assert.ok(!events.some((e) => e.event === 'record-written' && e.failed === true));
  // The tree holds both writes, and the run merged with no record owed.
  assert.deepEqual(unwrittenOf(events), []);
});
