// Terminal-state discipline: a run reaches `run-closed` through the ship
// path, a human kill, or a human answering a park with its abandon option.
// Every other failure parks with `retry` / `abandon`, so a run holding sound
// work waits for a decision instead of dying with the condition it met. The
// structural tests hold the closed set; the scenarios walk each park class
// through park, retry, re-park, abandon, and a daemon restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, archivedRunLedgerPath, runLedgerPath } from '../src/daemon/home.mjs';
import { assembleLanes } from '../src/lanes/assemble.mjs';
import { storyLane } from '../src/lanes/story.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import {
  tempDir,
  removeDir,
  waitFor,
  initOriginRepo,
  projectConfigJson,
  FIXTURE_ACCEPTANCE,
  FIXTURE_SPEC,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';
const CARD_PATH = 'stories/alpha.md';

const CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Provide f(x) that doubles x in src/feature.mjs.
${FIXTURE_ACCEPTANCE}`;

// The closed set of terminal routes, now two. A new entry belongs to a
// design-level decision recorded in an ADR, never to a call site that found a
// new way to give up. Every park of every type offers `abandon`, and that one
// route closes on the reason the answered park recorded — so no park type
// carries a close of its own.
const CLOSE_SET = new Set([
  'shipped', // the ship step's close-out
  'failed:<answer>', // the abandon route (lanes/shared.mjs)
]);

// -- source scan -------------------------------------------------------------

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith('.mjs')) files.push(full);
  }
  return files;
}

/** Every close directive of one source file, as `state` or `state:reason`. */
function closeDirectives(source) {
  const found = [];
  const opener = /close:\s*\{/g;
  let match;
  while ((match = opener.exec(source))) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    const body = source.slice(match.index + match[0].length, i - 1);
    const state = /state:\s*'([\w-]+)'/.exec(body)?.[1] ?? '<derived>';
    if (state === 'shipped') {
      found.push('shipped');
      continue;
    }
    const literal = /reason:\s*'([\w-]+)'/.exec(body)?.[1];
    found.push(`${state}:${literal ?? (/reason:/.test(body) ? '<answer>' : '<none>')}`);
  }
  return found;
}

test('the source holds no close route outside the terminal set', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const found = new Set();
  for (const file of sourceFiles(src)) {
    for (const directive of closeDirectives(readFileSync(file, 'utf8'))) found.add(directive);
  }
  assert.deepEqual([...found].sort(), [...CLOSE_SET].sort());
});

test('only the engine stamps run-closed, and only for a directive or a kill', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const stampers = sourceFiles(src).filter((file) =>
    /append\(\s*'run-closed'/.test(readFileSync(file, 'utf8')),
  );
  assert.deepEqual(stampers.map((f) => basename(f)), ['engine.mjs']);
  const engine = readFileSync(join(src, 'engine', 'engine.mjs'), 'utf8');
  const calls = [...engine.matchAll(/this\.closeRun\(run, ([^,)]+)/g)].map((m) => m[1].trim());
  // The directive route (state from the lane) and the human kill.
  assert.deepEqual(calls, ['state', "'killed'"]);
});

test('every assembled stage answers an abandoned park with the close', async (t) => {
  const home = tempDir();
  t.after(() => removeDir(home));
  const paths = scaffoldHome(home);
  const store = openRunStore(paths, 'r1');
  const park = store.append('park', {
    actor: 'daemon',
    type: 'stage-blocked',
    question: 'blocked',
    options: ['retry', 'abandon'],
    reason: 'fixture-block',
    detail: { note: 'kept' },
    gist: 'stage-blocked: blocked',
  });
  store.append('answer', { actor: 'operator', parkSeq: park.seq, option: 'abandon' });
  const lanes = assembleLanes({ instanceConfig: () => ({ projects: {} }) });
  const ctx = { runId: 'r1', project: 'proj', paths, payload: {}, store };
  for (const [name, lane] of Object.entries(lanes)) {
    for (const stage of lane.stages) {
      const directive = await lane.handlers[stage](ctx);
      assert.deepEqual(
        directive,
        { close: { state: 'failed', reason: 'fixture-block', note: 'kept', abandoned: park.seq } },
        `${name}/${stage} must close on an abandoned park`,
      );
    }
  }
  store.close();
});

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

function seatScript({ reportPath, model, report, files = {} }) {
  const stmts = [
    "const fs = require('fs');",
    "const path = require('path');",
    `console.log(${JSON.stringify(JSON.stringify({ meta: { model } }))});`,
  ];
  for (const [file, content] of Object.entries(files)) {
    stmts.push(
      `fs.mkdirSync(path.dirname(${JSON.stringify(file)}), { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)});`,
    );
  }
  if (report !== undefined) {
    stmts.push(
      `fs.mkdirSync(path.dirname(${JSON.stringify(reportPath)}), { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});`,
    );
  }
  stmts.push('process.exit(0);');
  return stmts.join('\n');
}

function seatFixture(seats) {
  const calls = [];
  let last = null;
  const commandFor = (opts) => {
    // The corrective re-prompt carries neither the seat header nor the
    // contract block; it re-uses the session the first dispatch opened.
    const header = /You are the (\S+) seat/.exec(opts.prompt);
    const lines = opts.prompt.split('\n');
    const contract = lines.findIndex((l) => l.includes('write your JSON report to this file'));
    const seat = header ? header[1] : last.seat;
    const reportPath = header ? lines[contract + 1] : last.reportPath;
    last = { seat, reportPath };
    calls.push({ seat, label: basename(reportPath, '.json'), attempt: opts.attempt, prompt: opts.prompt });
    const behavior = seats[seat];
    if (!behavior) throw new Error(`no fixture behavior for seat ${seat}`);
    const out = behavior({ seat, prompt: opts.prompt, attempt: opts.attempt }) ?? {};
    return {
      cmd: process.execPath,
      args: ['-e', seatScript({ reportPath, model: opts.model, ...out })],
      parseLine: fixtureParse,
    };
  };
  return { commandFor, calls };
}

function fixture(t, { seats = {}, card = CARD, config = {}, originFiles = {} } = {}) {
  const root = tempDir();
  const base = {
    repo: { testPaths: ['tests'] },
    commands: { suite: ['node', '--test', 'tests/*.test.mjs'] },
    lanes: { story: { suiteCommand: 'suite' } },
    stack: null,
  };
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson({
      ...base,
      ...config,
      commands: { ...base.commands, ...(config.commands ?? {}) },
      lanes: { ...base.lanes, ...(config.lanes ?? {}) },
    }),
    'src/base.mjs': 'export const base = 1;\n',
    ...(card === null ? {} : { [CARD_PATH]: card }),
    ...originFiles,
  });
  const home = join(root, 'home');
  const paths = scaffoldHome(home);
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { proj: { repoUrl: origin, slotCap: 2 } } }) + '\n',
  );
  const lanes = () => ({
    story: storyLane({
      afterFreeze: {
        stages: ['done'],
        handlers: { done: async () => ({ close: { state: 'shipped' } }) },
      },
    }),
  });
  const seatDefs = seatFixture(seats);
  let daemon = new Daemon(home, { lanes: lanes() });
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  const fx = {
    paths,
    calls: seatDefs.calls,
    get daemon() {
      return daemon;
    },
    async launch() {
      await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: seatDefs.commandFor });
      return daemon.launchRun({ project: 'proj', lane: 'story', card: CARD_PATH });
    },
    /** Restarts the daemon on the same home — the ledger is the only state. */
    async restart() {
      await daemon.stop();
      daemon = new Daemon(home, { lanes: lanes() });
      const started = await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: seatDefs.commandFor });
      return started;
    },
    answer(runId, answer) {
      daemon.engine.answer({ runId, actor: 'operator', ...answer });
    },
  };
  return fx;
}

function waitParked(paths, runId, type, nth = 1) {
  return waitFor(
    () => {
      const parks = readEvents(runLedgerPath(paths, runId)).filter(
        (e) => e.event === 'park' && e.type === type,
      );
      return parks.length >= nth ? parks[nth - 1] : undefined;
    },
    { label: `park ${type} #${nth}`, attempts: 400, intervalMs: 100 },
  );
}

async function waitClosed(paths, runId) {
  await waitFor(() => existsSync(archivedRunLedgerPath(paths, runId)), {
    label: `run ${runId} archived`,
    attempts: 400,
    intervalMs: 100,
  });
  return readEvents(archivedRunLedgerPath(paths, runId));
}

function waitStage(paths, runId, stage) {
  return waitFor(
    () =>
      readEvents(runLedgerPath(paths, runId)).find(
        (e) => e.event === 'stage-entered' && e.stage === stage,
      ),
    { label: `stage ${stage}`, attempts: 400, intervalMs: 100 },
  );
}

// A pre-freeze chain that reaches the suite stage and stops there.
function chainSeats(suiteBehavior) {
  return {
    'spec-birth': ({ prompt }) => ({
      files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
      report: { outcome: 'spec-born', summary: 'born' },
    }),
    'spec-gate': () => ({ report: { findings: [], summary: 'clean' } }),
    suite: suiteBehavior,
  };
}

// -- scenarios ---------------------------------------------------------------

test('a missing card parks; a retry re-runs readiness and the run goes on', async (t) => {
  const fx = fixture(t, { seats: chainSeats(() => ({ report: {} })), card: null });
  const { runId, worktree } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'stage-blocked');
  assert.equal(park.reason, 'card-missing');
  assert.deepEqual(park.answers.options, ['retry', 'abandon']);
  assert.ok(park.question.includes(CARD_PATH));
  // The run is parked, not closed: nothing archived it.
  assert.ok(!existsSync(archivedRunLedgerPath(fx.paths, runId)));
  mkdirSync(dirname(join(worktree, CARD_PATH)), { recursive: true });
  writeFileSync(join(worktree, CARD_PATH), CARD);
  fx.answer(runId, { option: 'retry' });
  await waitStage(fx.paths, runId, 'spec-birth');
  // The chain runs on until the fixture's own defect parks it — still open,
  // and the readiness park is not repeated.
  await waitParked(fx.paths, runId, 'seat-failure');
  const events = readEvents(runLedgerPath(fx.paths, runId));
  assert.equal(events.filter((e) => e.event === 'park' && e.type === 'stage-blocked').length, 1);
  assert.ok(!existsSync(archivedRunLedgerPath(fx.paths, runId)));
});

test('an abandoned readiness park closes failed on the original reason', async (t) => {
  const fx = fixture(t, { seats: {}, card: null });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'stage-blocked');
  fx.answer(runId, { option: 'abandon' });
  const events = await waitClosed(fx.paths, runId);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'card-missing');
  assert.equal(closed.card, CARD_PATH);
  assert.equal(closed.abandoned, park.seq);
  assert.ok(!events.some((e) => e.event === 'seat-spawned'));
});

test('a card lint that cannot run parks under command-error', async (t) => {
  const fx = fixture(t, {
    seats: {},
    config: {
      commands: { cardlint: ['olympus-no-such-binary-xyz'] },
      lanes: { story: { suiteCommand: 'suite', lintCommand: 'cardlint' } },
    },
  });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'command-error');
  assert.equal(park.reason, 'lint-command-error');
  assert.deepEqual(park.answers.options, ['retry', 'abandon']);
  fx.answer(runId, { option: 'abandon' });
  const closed = (await waitClosed(fx.paths, runId)).find((e) => e.event === 'run-closed');
  assert.equal(closed.reason, 'lint-command-error');
});

test('a suite work-product defect parks; each answer buys exactly one invocation', async (t) => {
  const fx = fixture(t, {
    seats: chainSeats(() => ({
      files: { 'src/stray.mjs': 'export const stray = 1;\n' },
      report: {
        suiteFiles: ['src/stray.mjs'],
        reds: [{ test: 'stray', class: 'feature-absence' }],
        summary: 'authored',
      },
    })),
  });
  const { runId } = await fx.launch();
  const first = await waitParked(fx.paths, runId, 'seat-failure');
  assert.equal(first.reason, 'seat-failure');
  assert.equal(first.detail.seat, 'suite');
  assert.equal(first.detail.cause, 'suite-defect');
  // The contract loop spent its corrective invocation before the park.
  const suiteCalls = () => fx.calls.filter((c) => c.seat === 'suite').length;
  assert.equal(suiteCalls(), 2);
  // One answer, one invocation, then the same failure parks again.
  fx.answer(runId, { option: 'retry' });
  const second = await waitParked(fx.paths, runId, 'seat-failure', 2);
  assert.equal(suiteCalls(), 3);
  assert.ok(second.seq > first.seq);
  // The bought retry carried the defect list into its brief.
  const retryCall = fx.calls.filter((c) => c.seat === 'suite')[2];
  assert.ok(retryCall.prompt.includes('outside the test paths'));
  fx.answer(runId, { option: 'abandon' });
  const closed = (await waitClosed(fx.paths, runId)).find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'seat-failure');
  assert.equal(closed.seat, 'suite');
  assert.equal(closed.cause, 'suite-defect');
  assert.equal(suiteCalls(), 3); // the abandon spends nothing
});

test('an invalid report past the corrective re-prompt parks', async (t) => {
  const fx = fixture(t, { seats: { 'spec-birth': () => ({ report: { summary: 'no outcome' } }) } });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'seat-failure');
  assert.equal(park.detail.seat, 'spec-birth');
  assert.equal(park.detail.cause, 'report-invalid');
  // The runner's own corrective re-prompt ran inside the seat session.
  assert.deepEqual(
    fx.calls.map((c) => c.attempt),
    [1, 2],
  );
  fx.answer(runId, { option: 'abandon' });
  const closed = (await waitClosed(fx.paths, runId)).find((e) => e.event === 'run-closed');
  assert.equal(closed.reason, 'seat-failure');
  assert.equal(closed.cause, 'report-invalid');
});

test('a transcript model that differs from the request parks', async (t) => {
  const fx = fixture(t, {
    seats: {
      'spec-birth': ({ prompt }) => ({
        model: 'some-other-model',
        files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
        report: { outcome: 'spec-born', summary: 'born' },
      }),
    },
  });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'seat-failure');
  assert.equal(park.detail.cause, 'model-mismatch');
  fx.answer(runId, { option: 'abandon' });
  const closed = (await waitClosed(fx.paths, runId)).find((e) => e.event === 'run-closed');
  assert.equal(closed.cause, 'model-mismatch');
});

test('a spec-lint park replays across a restart, and one retry buys one invocation', async (t) => {
  let written = 0;
  const fx = fixture(t, {
    seats: {
      // The first two invocations write prose with no criterion section and no
      // touched-paths block; the one the retry buys writes the template.
      'spec-birth': ({ prompt }) => ({
        files: {
          [specPathFrom(prompt)]: written++ < 2 ? '# alpha-1 spec\n\nProse only.\n' : FIXTURE_SPEC,
        },
        report: { outcome: 'spec-born', summary: 'born' },
      }),
      'spec-gate': () => ({ report: { findings: [], summary: 'clean' } }),
      suite: () => ({ report: {} }),
    },
  });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'seat-failure');
  assert.equal(park.detail.seat, 'spec-birth');
  assert.equal(park.detail.cause, 'spec-defect');
  const specCalls = () => fx.calls.filter((c) => c.seat === 'spec-birth');
  assert.equal(specCalls().length, 2);
  // The lint is derived from the ledger and the files, so a restart over a
  // parked run re-enters nothing and re-lints nothing.
  const before = readEvents(runLedgerPath(fx.paths, runId));
  await fx.restart();
  assert.deepEqual(
    readEvents(runLedgerPath(fx.paths, runId)).map((e) => e.event),
    before.map((e) => e.event),
  );
  // One answer, one invocation, carrying the lint failures by name.
  fx.answer(runId, { option: 'retry' });
  await waitFor(
    () => readEvents(runLedgerPath(fx.paths, runId)).find((e) => e.event === 'spec-born'),
    { label: 'spec born', attempts: 400, intervalMs: 100 },
  );
  assert.equal(specCalls().length, 3);
  assert.match(specCalls()[2].prompt, /Correction brief/);
  assert.match(specCalls()[2].prompt, /touched-paths/);
  // The chain went on to the gate; the spec was born exactly once.
  await waitParked(fx.paths, runId, 'seat-failure', 2);
  const events = readEvents(runLedgerPath(fx.paths, runId));
  assert.equal(events.filter((e) => e.event === 'spec-born').length, 1);
  assert.equal(events.filter((e) => e.event === 'spec-gate-round').length, 1);
  fx.answer(runId, { option: 'abandon' });
  const closed = (await waitClosed(fx.paths, runId)).find((e) => e.event === 'run-closed');
  assert.equal(closed.seat, 'suite');
});

test('the convergence park replays across a restart, and one answer buys one round', async (t) => {
  let amendments = 0;
  const fx = fixture(t, {
    seats: {
      'spec-birth': ({ prompt }) =>
        prompt.includes('Amend the born spec')
          ? {
              files: {
                [specPathFrom(prompt)]: FIXTURE_SPEC.replace(
                  'The suite asserts it on one number.',
                  `The suite asserts it on one number. Amendment ${++amendments}.`,
                ),
              },
              report: { amendedSections: ['AC-1'], summary: 'amended' },
            }
          : {
              files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
              report: { outcome: 'spec-born', summary: 'born' },
            },
      // Two blocking findings every round: the open set never shrinks.
      'spec-gate': () => ({
        report: {
          findings: [
            { section: 'AC-1', finding: 'ungrounded claim', evidence: 'src/base.mjs' },
            { section: 'AC-1', finding: 'unassertable clause', evidence: 'src/base.mjs' },
          ],
          summary: 'two blocking',
        },
      }),
    },
  });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'spec-gate-stalled');
  assert.deepEqual(park.answers.options, ['round', 'abandon']);
  const gateCalls = () => fx.calls.filter((c) => c.seat === 'spec-gate');
  assert.equal(gateCalls().length, 2);
  // The gate's position is the ledger and the run's files, so a restart over a
  // parked run re-enters nothing and re-checks nothing.
  const before = readEvents(runLedgerPath(fx.paths, runId));
  await fx.restart();
  assert.deepEqual(
    readEvents(runLedgerPath(fx.paths, runId)).map((e) => e.event),
    before.map((e) => e.event),
  );
  // One answer buys one amendment plus one re-check; the round it buys stalls
  // again, and the park asks once more instead of reading the spent answer.
  fx.answer(runId, { option: 'round' });
  const second = await waitParked(fx.paths, runId, 'spec-gate-stalled', 2);
  assert.ok(second.question.includes('2 blocking findings against 2 in round 2'));
  assert.equal(gateCalls().length, 3);
  fx.answer(runId, { option: 'abandon' });
  const closed = (await waitClosed(fx.paths, runId)).find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'spec-gate-stalled');
  assert.equal(gateCalls().length, 3); // the abandon spends nothing
});

test('a park replays across a daemon restart and the answer still closes the run', async (t) => {
  const fx = fixture(t, { seats: {}, card: null });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'stage-blocked');
  const before = readEvents(runLedgerPath(fx.paths, runId));
  const { runsResumed } = await fx.restart();
  assert.deepEqual(runsResumed, [runId]);
  // A parked run waits on the human: the restart re-enters nothing.
  const after = readEvents(runLedgerPath(fx.paths, runId));
  assert.deepEqual(
    after.map((e) => e.event),
    before.map((e) => e.event),
  );
  fx.answer(runId, { option: 'abandon' });
  const closed = (await waitClosed(fx.paths, runId)).find((e) => e.event === 'run-closed');
  assert.equal(closed.reason, 'card-missing');
  assert.equal(closed.abandoned, park.seq);
});
