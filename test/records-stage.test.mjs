// The records stage and the records lane (ADR-0074): a record is born before
// the freeze by a seat that did not write the code, a record-only ticket runs
// on a lane of its own, a mixed ticket writes its records before its code, and
// no seat that writes code reaches the record tree in any lane.
//
// The step derivations are read as pure functions over a ledger, because that
// is what a restart reads. The rest runs on fixture repositories through the
// real daemon, because the commit, the deny rules and the capture are about a
// tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, archivedRunLedgerPath, runLedgerPath } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { storyLane } from '../src/lanes/story.mjs';
import { postFreeze, repairLane } from '../src/lanes/verdict.mjs';
import {
  carriedPaths,
  carryRecords,
  recordsLane,
  recordsStep,
  ticketPathClass,
  withReconcileStage,
} from '../src/lanes/records-stage.mjs';
import { recordUnits } from '../src/lanes/units.mjs';
import { commitAll, headSha, resetHard } from '../src/isolation/tree.mjs';
import {
  tempDir,
  removeDir,
  waitFor,
  writeTree,
  initOriginRepo,
  projectConfigJson,
  gitSync,
  FIXTURE_ACCEPTANCE,
  FIXTURE_SPEC,
  NO_SURFACE,
  NO_WAIT,
  answeredReport,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';
const CARD_PATH = 'stories/alpha.md';
const RECORD_PATH = 'docs/adr/adr-0002-double-the-input.md';
const TEMPLATE_PATH = 'docs/adr/TEMPLATE.md';

const CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Provide f(x) that doubles x in src/feature.mjs.
${FIXTURE_ACCEPTANCE}`;

const STRONG_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('f doubles', async () => {
  const { f } = await import('../src/feature.mjs');
  assert.equal(f(2), 4);
});
`;

// The record tree the fixture repository ships with: one active record the
// birth neighbourhood reaches through the spec's own touched paths, and the
// template, which the record paths exclude by name.
const EXISTING_RECORD = [
  '# ADR-0001: Keep one entry point',
  '',
  '**Status:** Accepted',
  '',
  '## Decision',
  '',
  'The module src/feature.mjs holds the entry point.',
  '',
].join('\n');

// The record a birth writes, and the unit answers the harness holds it to. A
// claim's evidence names a path the worktree holds: the code does not exist at
// a birth, and a claim's path has to resolve (ADR-0073).
const RECORD_TEXT = [
  '# ADR-0002: Double the input',
  '',
  '**Status:** Accepted',
  '',
  '## Decision',
  '',
  'The module src/base.mjs holds the base value the feature doubles.',
  '',
  '## Consequences',
  '',
  'The doubling is not yet implemented.',
  '',
].join('\n');

/** The birth report of a run that writes one record. */
function bornReport(record = RECORD_PATH) {
  return {
    rewritten: [record],
    unchanged: [],
    summary: 'one record born',
  };
}

/** The birth report of a run that decides no record. */
const NOTHING_DECIDED = {
  rewritten: [],
  unchanged: [],
  summary: 'the work decides no record the tree does not hold',
};

const TICKET_HEAD = '# Ticket\n\n## The work\n\nState the decision the tree already holds.\n';

/** A ticket with a fenced touched-paths block naming the given paths. */
function ticketText(paths) {
  const block = paths.map((p) => `${p} — dev`).join('\n');
  return `${TICKET_HEAD}\n## Touched paths\n\n\`\`\`touched-paths\n${block}\n\`\`\`\n`;
}

// -- fixture machinery -------------------------------------------------------

function specPathFrom(prompt) {
  return /absolute path: (.+)$/m.exec(prompt)[1].trim();
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

function seatScript({ reportPath, model, report, files = {}, hang = false, probe = null }) {
  const stmts = [
    "const fs = require('fs');",
    "const path = require('path');",
    `console.log(${JSON.stringify(JSON.stringify({ meta: { model }, cost: 0.5 }))});`,
  ];
  // What the seat's own environment held, written where a scenario can read it.
  // The environment is the one thing a prompt cannot show (ADR-0079).
  if (probe) {
    stmts.push(
      `fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify(process.env.OLYMPUS_BASE_SHA ?? null));`,
    );
  }
  for (const [file, content] of Object.entries(files)) {
    stmts.push(
      `fs.mkdirSync(path.dirname(${JSON.stringify(file)}), { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)});`,
    );
  }
  // A seat that never answers: it writes what it had got to and stands there.
  // Only a stop ends it, and the half-written tree it leaves is what a
  // scenario about a daemon that went down inside a seat needs.
  if (hang) return [...stmts, 'setInterval(() => {}, 1 << 30);'].join('\n');
  stmts.push(
    `fs.mkdirSync(path.dirname(${JSON.stringify(reportPath)}), { recursive: true });`,
    `fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});`,
    'process.exit(0);',
  );
  return stmts.join('\n');
}

function seatFixture(seats) {
  const calls = [];
  // The corrective prompt of an invalid report names no seat: it is the same
  // seat session, told what its report failed. So the last seat stands.
  let last = null;
  const commandFor = (opts) => {
    const seat = /You are the (\S+) seat/.exec(opts.prompt)?.[1] ?? last;
    last = seat;
    const lines = opts.prompt.split('\n');
    const contract = lines.findIndex((l) => l.includes('write your JSON report to this file'));
    // The corrective prompt names the same file on the line that asks for it.
    const reportPath =
      contract === -1
        ? /report to the same file, then stop: (.+)$/m.exec(opts.prompt)[1].trim()
        : lines[contract + 1];
    calls.push({
      seat,
      label: basename(reportPath, '.json'),
      attempt: opts.attempt,
      prompt: opts.prompt,
      denyTools: opts.denyTools,
    });
    // A slot suffix is not a seat. The table entry for `record-review` answers
    // `record-review:1` where the table names no slot of its own.
    const behavior = seats[seat] ?? seats[seat.split(':')[0]];
    if (!behavior) throw new Error(`no fixture behavior for seat ${seat}`);
    const out = behavior({ seat, prompt: opts.prompt, attempt: opts.attempt }) ?? {};
    return {
      cmd: process.execPath,
      args: [
        '-e',
        seatScript({
          reportPath,
          model: opts.model,
          ...out,
          report: answeredReport(out.report, opts.prompt),
        }),
      ],
      parseLine: fixtureParse,
    };
  };
  return { commandFor, calls };
}

/**
 * A daemon over a fixture repository with all three lanes. The story lane runs
 * its whole pre-freeze chain and its real implementation seat; the verdict is a
 * seam, because nothing here is about a spectrum, and the spectrum has a suite
 * of its own. The repair and records lanes run their real stages to the same
 * seam.
 */
function laneFixture(t, { seats, files = {}, config = {}, realReconcile = false } = {}) {
  const root = tempDir();
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson({
      repo: { testPaths: ['tests'], recordPaths: ['docs/adr', `!${TEMPLATE_PATH}`] },
      commands: { suite: ['node', '--test', 'tests/*.test.mjs'] },
      gates: { tier1: [{ name: 'unit', command: 'suite' }] },
      lanes: { story: { suiteCommand: 'suite' } },
      stack: null,
      ...config,
    }),
    [CARD_PATH]: CARD,
    'src/base.mjs': 'export const base = 1;\n',
    'docs/adr/adr-0001-keep-one-entry-point.md': EXISTING_RECORD,
    [TEMPLATE_PATH]: '# ADR-<id>: <title>\n\n**Status:** Accepted\n',
    ...files,
  });
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { proj: { repoUrl: origin, slotCap: 2 } } }) + '\n',
  );
  const closed = [];
  const done = {
    stages: ['done'],
    handlers: {
      done: async (ctx) => {
        closed.push(snapshot(paths, ctx));
        return { close: { state: 'shipped' } };
      },
    },
  };
  const post = postFreeze({ afterVerdict: done });
  const repair = repairLane({ afterVerdict: done });
  const seam = async () => ({ next: 'done' });
  // The reconcile stage is a seam here, for the reason the verdict is. That
  // stage has a suite of its own. One scenario runs the real stage over the
  // record set a birth leaves, and it asks for it by `realReconcile`.
  const records = recordsLane({ afterRecords: done });
  const lanes = {
    story: storyLane({
      afterFreeze: {
        stages: post.stages,
        handlers: { ...post.handlers, verdict: seam, reconcile: seam },
      },
    }),
    repair: {
      stages: repair.stages,
      handlers: { ...repair.handlers, verdict: seam, reconcile: seam },
    },
    // The records lane keeps the real reconcile stage where a scenario is
    // about what that stage reads. Every other scenario leaves it a seam.
    records: realReconcile
      ? records
      : { stages: records.stages, handlers: { ...records.handlers, reconcile: seam } },
  };
  let daemon = new Daemon(join(root, 'home'), { waitSleep: NO_WAIT, lanes });
  const fixture = seatFixture(seats);
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  return {
    paths,
    closed,
    calls: fixture.calls,
    get daemon() {
      return daemon;
    },
    /** A stop, and a new daemon over the same ledgers: the restart recipe. */
    async restart() {
      await daemon.stop();
      daemon = new Daemon(join(root, 'home'), { waitSleep: NO_WAIT, lanes });
      await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: fixture.commandFor });
    },
    async launch(payload) {
      if (!daemon.running) await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: fixture.commandFor });
      return daemon.launchRun({ project: 'proj', ...payload });
    },
    /** The console route: the launch a `launch` control command performs. */
    async launchFromConsole(command) {
      if (!daemon.running) await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: fixture.commandFor });
      return daemon.launchCommand({ actor: 'console:test', project: 'proj', ...command });
    },
    /** A launch the door is expected to refuse: the throw it answers with. */
    async refused(payload) {
      if (!daemon.running) await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: fixture.commandFor });
      return daemon.launchRun({ project: 'proj', ...payload }).then(
        (ok) => {
          throw new Error(`the door admitted the launch: ${JSON.stringify(ok)}`);
        },
        (error) => error,
      );
    },
  };
}

/**
 * What the tree held at the last stage of a run. The workspace is released at
 * the close, so every reading a scenario needs is taken while the run still
 * holds it.
 */
function snapshot(paths, ctx) {
  const worktree = ctx.payload.worktree;
  const events = readEvents(runLedgerPath(paths, ctx.runId));
  const freeze = events.find((e) => e.event === 'freeze');
  const show = (sha, path) => {
    try {
      return gitSync(['show', `${sha}:${path}`], worktree);
    } catch {
      return null;
    }
  };
  return {
    runId: ctx.runId,
    worktree,
    subjects: gitSync(['log', '--format=%s'], worktree).trim().split('\n'),
    record: existsSync(join(worktree, RECORD_PATH))
      ? readFileSync(join(worktree, RECORD_PATH), 'utf8')
      : null,
    base: readFileSync(join(worktree, 'src/base.mjs'), 'utf8'),
    frozenRecord: freeze ? show(freeze.sha, RECORD_PATH) : null,
  };
}

async function waitClosed(paths, runId) {
  await waitFor(() => existsSync(archivedRunLedgerPath(paths, runId)), {
    label: `run ${runId} archived`,
    attempts: 900,
    intervalMs: 100,
  });
  return readEvents(archivedRunLedgerPath(paths, runId));
}

/** The story seats around the records stage. */
function storySeats(recordAuthor) {
  return {
    'spec-birth': ({ prompt }) => ({
      files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
      report: { outcome: 'spec-born', summary: 'born' },
    }),
    'spec-gate': () => ({ report: { findings: [], summary: 'clean' } }),
    'record-author': recordAuthor,
    suite: () => ({
      files: { 'tests/feature.test.mjs': STRONG_TEST },
      report: {
        suiteFiles: ['tests/feature.test.mjs'],
        reds: [{ test: 'f doubles', class: 'feature-absence' }],
        ...NO_SURFACE,
        summary: 'authored',
      },
    }),
  };
}

// -- the step derivation -----------------------------------------------------

function ledger(...events) {
  return events.map((e, i) => ({ seq: i + 1, ...e }));
}

// One case per boundary of the stage. A restart lands on one of these four
// states and on no other, and the answer is read off the stamps alone.
test('the records step is derived from the stage own stamps', () => {
  const entered = { event: 'stage-entered', stage: 'records' };
  const spawn = { event: 'seat-spawned', seat: 'record-author' };
  const report = { event: 'seat-report', seat: 'record-author', path: 'r.json' };
  // No spawn since the entry: the seat has not run.
  assert.equal(recordsStep(ledger(entered)), 'dispatch');
  // A spawn with no report: the seat died mid-write and is dispatched again.
  assert.equal(recordsStep(ledger(entered, spawn)), 'redispatch');
  // A report with no commit: the files are in the tree and the commit is owed.
  assert.equal(recordsStep(ledger(entered, spawn, report)), 'commit');
  // The commit stamp: the stage is done, and nothing re-runs.
  assert.equal(
    recordsStep(
      ledger(entered, spawn, report, {
        event: 'records-committed',
        sha: 'abc',
        paths: [RECORD_PATH],
        decided: true,
      }),
    ),
    'done',
  );
  // A corrective attempt inside one dispatch: the second spawn has no report,
  // so the seat is owed again and the first report answers nothing.
  assert.equal(recordsStep(ledger(entered, spawn, report, spawn)), 'redispatch');
  // Another seat's spawn says nothing about this stage.
  assert.equal(recordsStep(ledger(entered, { event: 'seat-spawned', seat: 'dev' })), 'dispatch');
  // A stage that decided nothing is done too: the stamp is the end, whatever
  // it says the work decided.
  assert.equal(
    recordsStep(ledger(entered, { event: 'records-committed', paths: [], decided: false })),
    'done',
  );
});

// -- the ticket classification -----------------------------------------------

test('a ticket is classified by its fenced block against the record tree', () => {
  const recordPaths = ['docs/adr', `!${TEMPLATE_PATH}`];
  assert.equal(ticketPathClass(ticketText([RECORD_PATH]), recordPaths).klass, 'records');
  assert.equal(ticketPathClass(ticketText(['src/a.mjs']), recordPaths).klass, 'code');
  const mixed = ticketPathClass(ticketText([RECORD_PATH, 'src/a.mjs']), recordPaths);
  assert.equal(mixed.klass, 'mixed');
  assert.deepEqual(mixed.records, [RECORD_PATH]);
  assert.deepEqual(mixed.code, ['src/a.mjs']);
  // The exclusion is not a record: a ticket that names the template alone
  // names code as far as the lanes are concerned.
  assert.equal(ticketPathClass(ticketText([TEMPLATE_PATH]), recordPaths).klass, 'code');
  // A ticket with no block declares nothing, and no rule classifies it.
  assert.equal(ticketPathClass(TICKET_HEAD, recordPaths).klass, 'undeclared');
  assert.equal(ticketPathClass(null, recordPaths).klass, 'undeclared');
  // A project with no record tree has no record ticket.
  assert.equal(ticketPathClass(ticketText([RECORD_PATH]), []).klass, 'code');
});

// -- the lane seam -----------------------------------------------------------

test('the reconcile stage is named once, and the continuation own handler governs', async () => {
  const ship = { stages: ['update', 'ship'], handlers: { update: () => {}, ship: () => {} } };
  const seamed = withReconcileStage(ship);
  assert.deepEqual(seamed.stages, ['reconcile', 'update', 'ship']);
  // A continuation that names neither is composed one, and the handler is the
  // stage's own.
  assert.equal(typeof seamed.handlers.reconcile, 'function');
  // A continuation that carries the stage keeps its own place and its own
  // handler; the name is never doubled.
  const own = async () => ({ next: 'ship' });
  const carried = withReconcileStage({
    stages: ['reconcile', 'update', 'ship'],
    handlers: { ...ship.handlers, reconcile: own },
  });
  assert.deepEqual(carried.stages, ['reconcile', 'update', 'ship']);
  assert.equal(carried.handlers.reconcile, own);
});

test('the carried paths are the frozen suite and the record tree', () => {
  assert.deepEqual(carriedPaths({ testPaths: ['tests'], recordPaths: ['docs/adr', '!x.md'] }), [
    'tests',
    'docs/adr',
  ]);
  assert.deepEqual(carriedPaths({}), []);
});

// -- the story lane ----------------------------------------------------------

test('a story commits the records it decides before the freeze, and stamps them', async (t) => {
  const fx = laneFixture(t, {
    seats: {
      ...storySeats(() => ({ files: { [RECORD_PATH]: RECORD_TEXT }, report: bornReport() })),
      dev: () => ({
        files: { 'src/feature.mjs': 'export const f = (x) => 2 * x;\n' },
        report: { summary: 'implemented' },
      }),
    },
  });
  const { runId } = await fx.launch({ lane: 'story', card: CARD_PATH });
  const events = await waitClosed(fx.paths, runId);
  // The stage stands between the gate and the suite.
  assert.deepEqual(
    events.filter((e) => e.event === 'stage-entered').map((e) => e.stage),
    [
      'readiness',
      'spec-birth',
      'spec-gate',
      'records',
      'suite',
      'freeze',
      'implementation',
      'verdict',
      'done',
    ],
  );
  const born = events.find((e) => e.event === 'records-committed');
  const suite = events.find((e) => e.event === 'suite-committed');
  assert.equal(born.decided, true);
  assert.deepEqual(born.paths, [RECORD_PATH]);
  assert.ok(born.seq < suite.seq, 'the records commit before the suite seat runs');
  assert.ok(fx.closed[0].subjects.includes('records: alpha-1'));
  // The frozen sha carries them, so the dev seat reads them as it reads the
  // tests (ADR-0074).
  assert.match(fx.closed[0].frozenRecord, /ADR-0002/);
  // The birth stamp carries the dispatch's cost, and no reading of the text.
  assert.equal(typeof born.cost, 'number');
  assert.equal(events.filter((e) => e.event === 'record-units').length, 0);
  // The brief carries the neighbourhood by path and no diff.
  const brief = fx.calls.find((c) => c.seat === 'record-author').prompt;
  assert.match(brief, /docs\/adr\/adr-0001-keep-one-entry-point\.md/);
  assert.ok(!brief.includes('git diff'), brief);
});

test('a story that decides no record stamps it and commits nothing', async (t) => {
  const fx = laneFixture(t, {
    seats: {
      ...storySeats(() => ({ report: NOTHING_DECIDED })),
      dev: () => ({
        files: { 'src/feature.mjs': 'export const f = (x) => 2 * x;\n' },
        report: { summary: 'implemented' },
      }),
    },
  });
  const { runId } = await fx.launch({ lane: 'story', card: CARD_PATH });
  const events = await waitClosed(fx.paths, runId);
  const born = events.find((e) => e.event === 'records-committed');
  assert.equal(born.decided, false);
  assert.deepEqual(born.paths, []);
  assert.equal(events.filter((e) => e.event === 'record-units').length, 0);
  // No commit, and no record file: the stage decided nothing.
  assert.ok(!fx.closed[0].subjects.some((s) => s.startsWith('records:')));
  assert.equal(fx.closed[0].record, null);
});

test('the story dev seat is denied the record tree, and a write to one is taken back', async (t) => {
  const fx = laneFixture(t, {
    seats: {
      ...storySeats(() => ({ files: { [RECORD_PATH]: RECORD_TEXT }, report: bornReport() })),
      // A dev seat that writes past its deny rules: the capture is what the
      // ledger records, because a denied tool call is not a fact the harness
      // holds (ADR-0074).
      dev: () => ({
        files: {
          'src/feature.mjs': 'export const f = (x) => 2 * x;\n',
          [RECORD_PATH]: `${RECORD_TEXT}\nThe dev seat wrote this line.\n`,
        },
        report: { summary: 'implemented' },
      }),
    },
  });
  const { runId } = await fx.launch({ lane: 'story', card: CARD_PATH });
  const events = await waitClosed(fx.paths, runId);
  const dev = fx.calls.find((c) => c.seat === 'dev');
  assert.ok(dev.denyTools.includes('Edit(docs/adr/**)'), dev.denyTools.join(' '));
  assert.ok(dev.denyTools.includes('Edit(tests/**)'));
  // The brief says it beside the test line, so the seat is told rather than
  // left to discover the boundary at the capture.
  assert.match(dev.prompt, /Decision records \(read-only\): docs\/adr\./);
  const recapture = events.find((e) => e.event === 'diff-policy-recapture');
  assert.equal(recapture.class, 'record');
  assert.equal(recapture.kind, 'capture-takeback');
  assert.equal(recapture.lane, 'story');
  assert.deepEqual(recapture.recaptured, [RECORD_PATH]);
  // The write is reverted, and the commit record says what it lost.
  assert.ok(!fx.closed[0].record.includes('The dev seat wrote'));
  const committed = events.find((e) => e.event === 'implementation-committed');
  assert.deepEqual(committed.dropped, [RECORD_PATH]);
});

// -- the records lane --------------------------------------------------------

test('a record-only ticket runs on the records lane, and one seat writes it', async (t) => {
  const fx = laneFixture(t, {
    seats: {
      'record-author': () => ({ files: { [RECORD_PATH]: RECORD_TEXT }, report: bornReport() }),
    },
    files: { 'tickets/records.md': ticketText([RECORD_PATH]) },
  });
  const { runId } = await fx.launch({ lane: 'records', ticket: 'tickets/records.md' });
  const events = await waitClosed(fx.paths, runId);
  assert.deepEqual(
    events.filter((e) => e.event === 'stage-entered').map((e) => e.stage),
    ['readiness', 'records', 'reconcile', 'done'],
  );
  const born = events.find((e) => e.event === 'records-committed');
  assert.equal(born.decided, true);
  assert.deepEqual(born.paths, [RECORD_PATH]);
  assert.ok(fx.closed[0].subjects.some((s) => s.startsWith('records: ')));
  // The lane runs one seat and no other: no fix, no suite, no code verdict.
  assert.deepEqual([...new Set(fx.calls.map((c) => c.seat))], ['record-author']);
  assert.match(fx.calls[0].prompt, /tickets[\\/]records\.md/);
});

// The record layers of a records-lane run: a command that answers green, and
// the record diff selects it.
const RECORD_LAYER_CONFIG = {
  commands: {
    suite: ['node', '--test', 'tests/*.test.mjs'],
    adrform: [process.execPath, '-e', 'process.exit(0)'],
  },
  gates: {
    tier1: [
      { name: 'unit', command: 'suite' },
      { name: 'adr-form', command: 'adrform' },
    ],
    recordLayers: ['adr-form'],
  },
};

test('a record-only ticket is judged to the end of the stage, and the render exists', async (t) => {
  // The whole diff of this run is the birth write, so the judge owes nothing.
  // The born record is still the run's record set, and it takes the cycle.
  // That is the record layers, a review seat, and a render (ADR-0077).
  const fx = laneFixture(t, {
    realReconcile: true,
    config: RECORD_LAYER_CONFIG,
    seats: {
      'record-author': () => ({ files: { [RECORD_PATH]: RECORD_TEXT }, report: bornReport() }),
      'record-review': () => ({
        report: { findings: [], summary: 'the record stands against the tree' },
      }),
    },
    files: { 'tickets/records.md': ticketText([RECORD_PATH]) },
  });
  const { runId } = await fx.launch({ lane: 'records', ticket: 'tickets/records.md' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');

  // The records lane spawns no judge: the diff is the records, so the birth is
  // the judgment (ADR-0080).
  assert.equal(fx.calls.filter((c) => c.seat === 'reconcile-judge').length, 0);
  const judged = events.find((e) => e.event === 'reconciliation-judged');
  assert.equal(judged.owed, false);
  assert.equal(judged.source, 'born');
  assert.deepEqual(judged.born, [RECORD_PATH]);
  assert.deepEqual(judged.late, []);
  assert.ok(!events.some((e) => e.event === 'reconciliation-written'));

  // One review seat over the born record, and no verifier behind it.
  const reviews = fx.calls.filter((c) => c.seat.startsWith('record-review'));
  assert.equal(reviews.length, 1);
  assert.ok(reviews[0].prompt.includes(`Review one decision record: ${RECORD_PATH}`));
  assert.equal(fx.calls.filter((c) => c.seat.includes('verifier')).length, 0);
  assert.equal(
    events.filter((e) => e.event === 'record-reviewed').map((e) => e.record).join(),
    RECORD_PATH,
  );
  assert.deepEqual(
    events.filter((e) => e.event === 'layer-result').map((e) => [e.layer, e.status]),
    [['adr-form', 'green']],
  );

  const rendered = events.find((e) => e.event === 'reconcile-rendered');
  assert.equal(rendered.verdict, 'green');
  assert.deepEqual(rendered.open, []);
  assert.deepEqual(rendered.records, [RECORD_PATH]);
});

// A reconciliation ticket names its records in prose under a heading and
// carries no fenced block. The paths the work touches are those records, so
// the brief states them and the neighbourhood is derived from them.
// -- the birth brief (ADR-0079) -----------------------------------------------

/** The project that supersedes its records, with a record layer of its own. */
const SUPERSEDE_LAYERS = {
  repo: {
    testPaths: ['tests'],
    recordPaths: ['docs/adr', `!${TEMPLATE_PATH}`],
    recordLifecycle: 'supersede',
  },
  commands: {
    suite: ['node', '--test', 'tests/*.test.mjs'],
    lockfile: ['node', '-e', 'process.exit(0)'],
    adrform: ['node', '-e', 'process.exit(0)'],
  },
  gates: {
    tier1: [
      { name: 'unit', command: 'suite' },
      { name: 'lockfile', command: 'lockfile' },
      { name: 'adr-form', command: 'adrform', needs: ['lockfile'] },
    ],
    recordLayers: ['adr-form'],
  },
};

/** Active records that cite the record a sweep ticket touches, by count. */
function citingTree(count = 23, id = '0001') {
  const out = {};
  for (let n = 0; n < count; n++) {
    const number = String(11 + n).padStart(4, '0');
    out[`docs/adr/adr-${number}-cites.md`] =
      `# ADR-${number}: A record\n\n**Status:** Accepted\n\n## Decision\n\nIt relies on ADR-${id}.\n`;
  }
  return out;
}

test('the birth brief names the gate command, and the birth installs what it needs', async (t) => {
  const touched = 'docs/adr/adr-0001-keep-one-entry-point.md';
  const probe = join(tempDir(), 'birth-env.json');
  const fx = laneFixture(t, {
    config: SUPERSEDE_LAYERS,
    files: { 'tickets/records.md': ticketText([touched]), ...citingTree() },
    seats: {
      'record-author': () => ({
        files: { [RECORD_PATH]: RECORD_TEXT },
        report: bornReport(),
        probe,
      }),
    },
  });
  const { runId } = await fx.launch({ lane: 'records', ticket: 'tickets/records.md' });
  const events = await waitClosed(fx.paths, runId);
  const brief = fx.calls.find((c) => c.seat === 'record-author').prompt;

  // The neighbourhood of a touched record is that record's own, capped by rank
  // with the count above the cap stated.
  assert.match(brief, /The neighbourhood\. Read each one whole/);
  assert.match(brief, /11 more active records cite these or are cited by them/);
  // The gate command, by name, and the duty to run it before reporting. It is a
  // brief line and not a check: the harness reads no token of a record
  // (ADR-0080).
  assert.match(brief, /The project form gate reads the files you leave/);
  assert.match(brief, /node -e process\.exit\(0\)/);
  assert.match(brief, /A red at the render costs the run a cycle/);
  // The sibling table and the divergence table are gone; the direction stays.
  assert.ok(!brief.includes('"siblings"'), brief);
  assert.match(brief, /Read every active record that cites the one you supersede/);
  // The layer the gate needs ran once, before the seat.
  const lockfile = events.filter((e) => e.event === 'layer-result' && e.layer === 'lockfile');
  assert.equal(lockfile.length, 1);
  assert.equal(lockfile[0].cycle, 0);
  const spawned = events.find((e) => e.event === 'seat-spawned' && e.seat === 'record-author');
  assert.ok(lockfile[0].seq < spawned.seq, 'the gate prerequisite ran after the seat');
  // The environment carries the base the gate reads.
  assert.match(JSON.parse(readFileSync(probe, 'utf8')), /^[0-9a-f]{40}$/);
  // One dispatch: the report answered the shape the brief asked for.
  assert.equal(fx.calls.filter((c) => c.seat === 'record-author').length, 1);
});

// The install stands in front of the birth seat and not in one lane's
// readiness. Every lane that holds a records stage dispatches that seat with the
// same gate command in its brief (ADR-0080).
test('a story birth installs what the gate needs, before the seat', async (t) => {
  const fx = laneFixture(t, {
    config: SUPERSEDE_LAYERS,
    files: citingTree(),
    seats: {
      ...storySeats(() => ({ files: { [RECORD_PATH]: RECORD_TEXT }, report: bornReport() })),
      dev: () => ({
        files: { 'src/feature.mjs': 'export const f = (x) => 2 * x;\n' },
        report: { summary: 'implemented' },
      }),
    },
  });
  const { runId } = await fx.launch({ lane: 'story', card: CARD_PATH });
  const events = await waitClosed(fx.paths, runId);
  const lockfile = events.filter(
    (e) => e.event === 'layer-result' && e.layer === 'lockfile' && e.cycle === 0,
  );
  assert.equal(lockfile.length, 1);
  const spawned = events.find((e) => e.event === 'seat-spawned' && e.seat === 'record-author');
  assert.ok(lockfile[0].seq < spawned.seq, 'the gate prerequisite ran after the seat');
  // The gate itself is not run here: the seat runs it, and the render runs it
  // over the committed bytes.
  assert.ok(!events.some((e) => e.event === 'layer-result' && e.layer === 'adr-form' && e.cycle === 0));
});

test('a ticket with no block gives the birth the records it names', async (t) => {
  const ticket = [
    '# Reconciliation ticket: run r1',
    '',
    '## Records to reconcile',
    '',
    '- docs/adr/adr-0001-keep-one-entry-point.md',
    '',
  ].join('\n');
  const fx = laneFixture(t, {
    seats: {
      'record-author': () => ({ files: { [RECORD_PATH]: RECORD_TEXT }, report: bornReport() }),
    },
    files: { 'tickets/reconcile.md': ticket },
  });
  const { runId } = await fx.launch({ lane: 'records', ticket: 'tickets/reconcile.md' });
  await waitClosed(fx.paths, runId);
  const brief = fx.calls.find((c) => c.seat === 'record-author').prompt;
  assert.match(brief, /The paths this work touches:\n- docs\/adr\/adr-0001-keep-one-entry-point\.md/);
});

// The stop that catches the stage inside its seat: the seat left half a record
// in the tree, and the next dispatch is the same dispatch as the first
// (ADR-0070). A restart at the other three boundaries is the step derivation
// above, which is what the restart reads.
test('a stop inside the birth seat re-dispatches it over the tree it started on', async (t) => {
  let spawns = 0;
  const fx = laneFixture(t, {
    seats: {
      'record-author': () => {
        spawns += 1;
        // The first seat writes half a record and never answers.
        return spawns === 1
          ? { files: { [RECORD_PATH]: '# ADR-0002: Doub' }, hang: true }
          : { files: { [RECORD_PATH]: RECORD_TEXT }, report: bornReport() };
      },
    },
    files: { 'tickets/records.md': ticketText([RECORD_PATH]) },
  });
  const { runId } = await fx.launch({ lane: 'records', ticket: 'tickets/records.md' });
  await waitFor(
    () =>
      readEvents(runLedgerPath(fx.paths, runId)).some(
        (e) => e.event === 'seat-spawned' && e.seat === 'record-author',
      ),
    { label: 'the birth seat', attempts: 600, intervalMs: 100 },
  );
  await fx.restart();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(spawns, 2);
  assert.equal(
    events.filter((e) => e.event === 'seat-spawned' && e.seat === 'record-author').length,
    2,
  );
  // One commit, of the record the second seat wrote whole.
  const born = events.filter((e) => e.event === 'records-committed');
  assert.equal(born.length, 1);
  assert.deepEqual(born[0].paths, [RECORD_PATH]);
  assert.match(fx.closed[0].record, /The doubling is not yet implemented/);
  assert.ok(!fx.closed[0].record.includes('# ADR-0002: Doub\n'));
});

test('the console launches the records lane, and refuses it without a ticket', async (t) => {
  const fx = laneFixture(t, {
    seats: {
      'record-author': () => ({ files: { [RECORD_PATH]: RECORD_TEXT }, report: bornReport() }),
    },
    files: { 'tickets/records.md': ticketText([RECORD_PATH]) },
  });
  const { runId } = await fx.launchFromConsole({ lane: 'records', ticket: 'tickets/records.md' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-launched').lane, 'records');
  await assert.rejects(
    () => fx.launchFromConsole({ lane: 'records' }),
    /a records launch requires a ticket path/,
  );
  // The escape linkage stays the repair lane's: no escape record names a
  // decision record.
  await assert.rejects(
    () => fx.launchFromConsole({ lane: 'records', ticket: 'tickets/records.md', escape: 4 }),
    /an escape applies to the repair lane only/,
  );
});

test('a record-only ticket on the repair lane is refused with the lane to use', async (t) => {
  const fx = laneFixture(t, {
    seats: {},
    files: { 'tickets/records.md': ticketText([RECORD_PATH]) },
  });
  const error = await fx.refused({ lane: 'repair', ticket: 'tickets/records.md' });
  assert.match(error.message, /decision records and nothing else/);
  assert.match(error.message, /--lane records/);
  // Nothing was spent on it: no seat, and no run.
  assert.equal(fx.calls.length, 0);
});

test('a ticket that names code is refused on the records lane', async (t) => {
  const fx = laneFixture(t, {
    seats: {},
    files: { 'tickets/mixed.md': ticketText([RECORD_PATH, 'src/base.mjs']) },
  });
  const error = await fx.refused({ lane: 'records', ticket: 'tickets/mixed.md' });
  assert.match(error.message, /outside the decision-record tree: src\/base\.mjs/);
  assert.match(error.message, /repair lane/);
});

// -- the repair lane ---------------------------------------------------------

test('a mixed ticket writes its records first, then runs the dev seat frozen', async (t) => {
  const fx = laneFixture(t, {
    seats: {
      'record-author': () => ({ files: { [RECORD_PATH]: RECORD_TEXT }, report: bornReport() }),
      dev: () => ({
        files: {
          'src/base.mjs': 'export const base = 2;\n',
          // The dev seat reaches the record the birth committed. The capture
          // takes it back and the run goes on with the allowed set.
          [RECORD_PATH]: `${RECORD_TEXT}\nThe dev seat wrote this line.\n`,
        },
        report: { summary: 'repaired' },
      }),
    },
    files: { 'tickets/mixed.md': ticketText([RECORD_PATH, 'src/base.mjs']) },
  });
  const { runId } = await fx.launch({ lane: 'repair', ticket: 'tickets/mixed.md' });
  const events = await waitClosed(fx.paths, runId);
  // One birth, then the dev seat, in that order.
  assert.deepEqual(
    fx.calls.map((c) => c.seat),
    ['record-author', 'dev'],
  );
  const born = events.find((e) => e.event === 'records-committed');
  const committed = events.find((e) => e.event === 'implementation-committed');
  assert.equal(born.decided, true);
  assert.ok(born.seq < committed.seq);
  // The record paths are frozen for the dev seat, and the test paths are not:
  // this lane's dev seat writes the regression test.
  const dev = fx.calls.find((c) => c.seat === 'dev');
  assert.ok(dev.denyTools.includes('Edit(docs/adr/**)'), dev.denyTools.join(' '));
  assert.ok(!dev.denyTools.includes('Edit(tests/**)'));
  // The take-back carries its own class, and the record the birth committed is
  // the record the tree holds.
  const recapture = events.find((e) => e.event === 'diff-policy-recapture');
  assert.equal(recapture.class, 'record');
  assert.equal(recapture.lane, 'repair');
  assert.deepEqual(recapture.recaptured, [RECORD_PATH]);
  assert.ok(!fx.closed[0].record.includes('The dev seat wrote'));
  assert.equal(fx.closed[0].base.trim(), 'export const base = 2;');
});

// -- the fresh pass ----------------------------------------------------------

test('a fresh pass carries the born records and re-stamps them', async (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const paths = scaffoldHome(join(dir, 'home'));
  const worktree = initOriginRepo(join(dir, 'tree'), { 'src/base.mjs': 'export const base = 1;\n' });
  const baseSha = gitSync(['rev-parse', 'HEAD'], worktree).trim();
  // The birth commit, as the stage leaves it.
  writeTree(worktree, { [RECORD_PATH]: RECORD_TEXT });
  const recordSha = await commitAll(worktree, 'records: t1');
  const store = openRunStore(paths, 'r1');
  const ctx = { paths, runId: 'r1', store, payload: {} };
  store.append('records-committed', {
    actor: 'daemon',
    sha: recordSha,
    paths: [RECORD_PATH],
    decided: true,
  });
  store.append('fresh-pass', { actor: 'daemon', pass: 2, trigger: 'no-progress' });
  // The reset a fresh pass takes: the tree goes back to the sha the pass is
  // born on, and the records go with it.
  await resetHard(worktree, baseSha);
  assert.ok(!existsSync(join(worktree, RECORD_PATH)));
  const carried = await carryRecords(ctx, { worktree, recordPaths: ['docs/adr'] }, 'repair');
  store.close();
  assert.ok(existsSync(join(worktree, RECORD_PATH)), 'the records are back on the tree');
  assert.equal(carried, await headSha(worktree));
  const stamp = readEvents(runLedgerPath(paths, 'r1')).at(-1);
  assert.equal(stamp.event, 'records-committed');
  assert.equal(stamp.carried, true);
  assert.equal(stamp.decided, true);
  assert.deepEqual(stamp.paths, [RECORD_PATH]);
  assert.equal(stamp.sha, carried);
});

test('a pass with no records to carry stamps nothing, and carries once', async (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const paths = scaffoldHome(join(dir, 'home'));
  const worktree = initOriginRepo(join(dir, 'tree'), { 'src/base.mjs': 'export const base = 1;\n' });
  const store = openRunStore(paths, 'r1');
  const ctx = { paths, runId: 'r1', store, payload: {} };
  const base = { worktree, recordPaths: ['docs/adr'] };
  // No fresh pass: there is nothing to carry over.
  assert.equal(await carryRecords(ctx, base, 'story'), null);
  store.append('fresh-pass', { actor: 'daemon', pass: 2, trigger: 'no-progress' });
  // A pass of a run that stamped no records carries none.
  assert.equal(await carryRecords(ctx, base, 'story'), null);
  // A pass that already carried them does it once: the second call reads its
  // own stamp and stands down.
  store.append('records-committed', { actor: 'daemon', sha: 'x', paths: [], decided: false });
  store.append('fresh-pass', { actor: 'daemon', pass: 3, trigger: 'no-progress' });
  assert.ok((await carryRecords(ctx, base, 'story')) !== null);
  assert.equal(await carryRecords(ctx, base, 'story'), null);
  store.close();
  const stamps = readEvents(runLedgerPath(paths, 'r1')).filter(
    (e) => e.event === 'records-committed' && e.carried === true,
  );
  assert.equal(stamps.length, 1);
});

// -- the closed record at a birth (ADR-0078) ----------------------------------

/** The existing record, closed by the write that replaces it. */
const EXISTING_CLOSED = EXISTING_RECORD.replace(
  '**Status:** Accepted',
  '**Status:** Superseded by ADR-0002 (2026-09-08)',
);

/** The record a birth writes to replace the existing one. */
const REPLACEMENT_TEXT = [
  '# ADR-0002: Double the input',
  '',
  '**Status:** Accepted',
  '**Supersedes:** ADR-0001',
  '',
  '## Decision',
  '',
  'The module src/base.mjs holds the base value the feature doubles.',
  '',
  '## Consequences',
  '',
  'The doubling is not yet implemented.',
  '',
].join('\n');

const SUPERSEDE_CONFIG = {
  repo: {
    testPaths: ['tests'],
    recordPaths: ['docs/adr', `!${TEMPLATE_PATH}`],
    recordLifecycle: 'supersede',
  },
};

// The sweep shape, at one record. The birth closes the record it replaces and
// writes the replacement. Nothing in the harness reads the pairing: the project
// form gate is the one implementation of the lifecycle's mechanics (ADR-0080).
test('a birth that supersedes a record is committed on its first attempt', async (t) => {
  const fx = laneFixture(t, {
    config: SUPERSEDE_CONFIG,
    seats: {
      'record-author': () => ({
        files: {
          'docs/adr/adr-0001-keep-one-entry-point.md': EXISTING_CLOSED,
          [RECORD_PATH]: REPLACEMENT_TEXT,
        },
        report: {
          rewritten: [RECORD_PATH],
          unchanged: [],
          summary: 'the decision moves to a new record',
        },
      }),
    },
    files: { 'tickets/records.md': ticketText([RECORD_PATH]) },
  });
  const { runId } = await fx.launch({ lane: 'records', ticket: 'tickets/records.md' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // One attempt, and no refusal: the write is right and the harness says so.
  assert.equal(fx.calls.filter((c) => c.seat === 'record-author').length, 1);
  assert.ok(!events.some((e) => e.event === 'seat-refused'));
  assert.ok(!events.some((e) => e.event === 'seat-failure'));
  // The born stamp still names every record path the commit changed, and marks
  // the one the seat did not report. That is what the reconcile stage reads.
  const born = events.find((e) => e.event === 'records-committed');
  assert.deepEqual(born.paths.sort(), [
    'docs/adr/adr-0001-keep-one-entry-point.md',
    RECORD_PATH,
  ]);
  assert.deepEqual(born.unreported, ['docs/adr/adr-0001-keep-one-entry-point.md']);
  assert.equal(born.decided, true);
  // The brief told the seat the rule before it wrote.
  const brief = fx.calls.find((c) => c.seat === 'record-author').prompt;
  assert.ok(brief.includes('A status-line change of an old record is not a rewrite.'), brief);
});

// -- a birth that delivers nothing (ADR-0080) ---------------------------------

// The story lane ships code beside its records. A birth that spent its ladder
// there used to park the run before its freeze, for a document. It stamps
// `birthFailed` instead and the run goes on: the judge names the records late
// in the reconcile stage, which is ADR-0074's own fallback path.
test('a story birth that spends its ladder stamps birthFailed and the run goes on', async (t) => {
  const fx = laneFixture(t, {
    seats: {
      ...storySeats(() => ({ report: { rewritten: [], unchanged: [] } })),
      dev: () => ({
        files: { 'src/feature.mjs': 'export const f = (x) => 2 * x;\n' },
        report: { summary: 'implemented' },
      }),
    },
  });
  const { runId } = await fx.launch({ lane: 'story', card: CARD_PATH });
  const events = await waitClosed(fx.paths, runId);
  // The seat spent its ladder on a report the schema refuses, which is the one
  // refusal a record write still takes.
  assert.deepEqual(
    events.filter((e) => e.seat === 'record-author').map((e) => [e.event, e.reason ?? '']),
    [
      ['seat-spawned', ''],
      ['seat-spawned', ''],
      ['seat-failure', 'report-invalid'],
    ],
  );
  const born = events.find((e) => e.event === 'records-committed');
  assert.equal(born.birthFailed, true);
  assert.equal(born.decided, false);
  assert.equal(born.cause, 'seat-failure');
  // No park, and the run reached its freeze and its close.
  assert.deepEqual(events.filter((e) => e.event === 'park').map((e) => e.type), []);
  assert.ok(events.some((e) => e.event === 'suite-committed'));
  assert.deepEqual(
    events.filter((e) => e.event === 'stage-entered').map((e) => e.stage),
    [
      'readiness',
      'spec-birth',
      'spec-gate',
      'records',
      'suite',
      'freeze',
      'implementation',
      'verdict',
      'done',
    ],
  );
});

// A birth that answered and wrote nothing is not a failure of a seat: the seat
// read the ticket and found no decision in it. The lane has no work either way,
// so the run ends loud and asks nobody anything (ADR-0015, ADR-0080).
test('a records-lane birth that decides nothing closes the run loud', async (t) => {
  const fx = laneFixture(t, {
    seats: {
      'record-author': () => ({
        report: { rewritten: [], unchanged: [], summary: 'the ticket decides nothing new' },
      }),
    },
    files: { 'tickets/records.md': ticketText([RECORD_PATH]) },
  });
  const { runId } = await fx.launch({ lane: 'records', ticket: 'tickets/records.md' });
  const events = await waitClosed(fx.paths, runId);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'nothing-born');
  // No park, no request, and no stage behind the birth.
  assert.deepEqual(events.filter((e) => e.event === 'park').map((e) => e.type), []);
  assert.ok(!events.some((e) => e.event === 'pr-opened'));
  assert.ok(!events.some((e) => e.event === 'reconcile-rendered'));
  assert.deepEqual(
    events.filter((e) => e.event === 'stage-entered').map((e) => e.stage),
    ['readiness', 'records'],
  );
  assert.equal(events.find((e) => e.event === 'records-committed').decided, false);
});

// The records lane keeps the park: a birth that delivered nothing leaves that
// lane no record, and a lane with no work has nothing to merge.
test('a records-lane birth that spends its ladder parks', async (t) => {
  const fx = laneFixture(t, {
    seats: { 'record-author': () => ({ report: { rewritten: [], unchanged: [] } }) },
    files: { 'tickets/records.md': ticketText([RECORD_PATH]) },
  });
  const { runId } = await fx.launch({ lane: 'records', ticket: 'tickets/records.md' });
  const parked = await waitFor(
    () => readEvents(runLedgerPath(fx.paths, runId)).find((e) => e.event === 'park'),
    { label: 'the birth park', attempts: 900, intervalMs: 100 },
  );
  assert.equal(parked.type, 'seat-failure');
  assert.match(parked.detail.seat, /record-author/);
});
