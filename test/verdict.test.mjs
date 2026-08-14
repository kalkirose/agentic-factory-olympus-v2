// The post-freeze chain end to end on fixture repos: seeded defect fixtures
// route down each response-ladder arm, and the verdict record carries the
// full spectrum plus confirmed findings only. The lane is seeded at the
// freeze boundary — the pre-freeze chain has its own suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, archivedRunLedgerPath, runLedgerPath } from '../src/daemon/home.mjs';
import { postFreeze, repairLane } from '../src/lanes/verdict.mjs';
import { commitAll } from '../src/isolation/tree.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { openLoud } from '../src/telemetry/readers.mjs';
import { tempDir, removeDir, waitFor, initOriginRepo, projectConfigJson } from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';

const GOOD_FEATURE = 'export const f = (x) => 2 * x;\n';
const BAD_FEATURE = 'export const f = (x) => x;\n';

const STRONG_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('f doubles', async () => {
  const { f } = await import('../src/feature.mjs');
  assert.equal(f(2), 4);
});
`;

// Mis-encodes the spec (2*x): the seeded suite-defect for the re-freeze arm.
const WRONG_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('f doubles', async () => {
  const { f } = await import('../src/feature.mjs');
  assert.equal(f(2), 5);
});
`;

// Reaches a test-path file the freeze exempts: the dev pass owns it, so the
// suite is green only when that file survives every restore.
const HARNESS_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('f doubles what the harness boots', async () => {
  const { boot } = await import('./support/harness.mjs');
  const { f } = await import('../src/feature.mjs');
  assert.equal(f(boot()), 4);
});
`;

const G_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('g increments', async () => {
  const { g } = await import('../src/g.mjs');
  assert.equal(g(1), 2);
});
`;

const SUITE_CMD = ['node', '--test', 'tests/*.test.mjs'];
const GREEN_CMD = ['node', '-e', 'process.exit(0)'];
const BUILD_CMD = [
  'node',
  '-e',
  "import(require('url').pathToFileURL('src/feature.mjs').href).then(m=>process.exit(typeof m.f==='function'?0:1)).catch(()=>process.exit(1))",
];
const DEFAULT_GATES = [
  { name: 'unit', command: 'suite' },
  { name: 'lint', command: 'lint' },
  { name: 'build', command: 'build', needs: ['unit'] },
];
const DEFAULT_COMMANDS = { suite: SUITE_CMD, lint: GREEN_CMD, build: BUILD_CMD };

function markerCmd(file) {
  return [
    'node',
    '-e',
    `process.exit(require('fs').readFileSync(${JSON.stringify(file)},'utf8').trim()==='ok'?0:1)`,
  ];
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

// A fixture seat child: writes files (relative paths land in the seat's cwd),
// writes the report, exits. Behaviors dispatch per seat on label and prompt.
function seatScript({ reportPath, model, report, files = {}, removes = [], exitCode = 0 }) {
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
  for (const file of removes) {
    stmts.push(`fs.rmSync(${JSON.stringify(file)}, { force: true, recursive: true });`);
  }
  if (report !== undefined) {
    stmts.push(
      `fs.mkdirSync(path.dirname(${JSON.stringify(reportPath)}), { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});`,
    );
  }
  stmts.push(`process.exit(${exitCode});`);
  return stmts.join('\n');
}

function seatFixture(seats) {
  const calls = [];
  const commandFor = (opts) => {
    const seat = /You are the (\S+) seat/.exec(opts.prompt)[1];
    const lines = opts.prompt.split('\n');
    const contract = lines.findIndex((l) => l.includes('write your JSON report to this file'));
    const reportPath = lines[contract + 1];
    const label = basename(reportPath, '.json');
    calls.push({ seat, label, attempt: opts.attempt, prompt: opts.prompt, denyTools: opts.denyTools });
    const behavior = seats[seat];
    if (!behavior) throw new Error(`no fixture behavior for seat ${seat}`);
    const out = behavior({ seat, label, prompt: opts.prompt, attempt: opts.attempt }) ?? {};
    return {
      cmd: process.execPath,
      args: ['-e', seatScript({ reportPath, model: opts.model, ...out })],
      parseLine: fixtureParse,
    };
  };
  return { commandFor, calls };
}

/** Seeds the freeze boundary: suite files committed, freeze stamped. */
function seedHandler(files, extra, specText = '# Spec\n\nf(x) returns 2*x.\n', exclusions = []) {
  return async (ctx) => {
    const worktree = ctx.payload.worktree;
    for (const [file, content] of Object.entries(files)) {
      const full = join(worktree, file);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    const sha = await commitAll(worktree, 'suite: seed');
    writeFileSync(join(ctx.paths.runs, ctx.runId, 'spec.md'), specText);
    writeFileSync(
      join(ctx.paths.runs, ctx.runId, 'freeze.json'),
      JSON.stringify({ runId: ctx.runId, suiteSha: sha, frozenExclusions: exclusions }, null, 2) + '\n',
    );
    ctx.store.append('freeze', { actor: 'daemon', sha, killCount: 3, amendmentKills: 0 });
    if (extra) await extra(ctx, worktree);
    return { next: 'implementation' };
  };
}

function verdictFixture(t, opts) {
  const {
    seats,
    gates = DEFAULT_GATES,
    commands = DEFAULT_COMMANDS,
    repo = { testPaths: ['tests'] },
    suiteFiles = { 'tests/feature.test.mjs': STRONG_TEST },
    originFiles = {},
    seedExtra = null,
    diffPolicy = undefined,
    specText = undefined,
    exclusions = [],
  } = opts;
  const root = tempDir();
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson({
      repo,
      commands,
      gates: { tier1: gates },
      lanes: { story: { suiteCommand: 'suite' } },
      stack: null,
      ...(diffPolicy && { diffPolicy }),
    }),
    'src/base.mjs': 'export const base = 1;\n',
    ...originFiles,
  });
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { proj: { repoUrl: origin, slotCap: 2 } } }) + '\n',
  );
  const done = { stages: ['done'], handlers: { done: async () => ({ close: { state: 'shipped' } }) } };
  const post = postFreeze({ afterVerdict: done });
  const lanes = {
    story: {
      stages: ['seed', ...post.stages],
      handlers: { seed: seedHandler(suiteFiles, seedExtra, specText, exclusions), ...post.handlers },
    },
    repair: repairLane({ afterVerdict: done }),
  };
  const daemon = new Daemon(join(root, 'home'), { lanes });
  const fixture = seatFixture(seats);
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  return {
    paths,
    daemon,
    calls: fixture.calls,
    async launch(payload = {}) {
      await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: fixture.commandFor });
      const { runId, worktree } = await daemon.launchRun({ project: 'proj', lane: 'story', ...payload });
      return { runId, worktree };
    },
    /** The console path: the launch a `launch` control command performs. */
    async launchFromConsole(command = {}) {
      await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: fixture.commandFor });
      const { runId, worktree } = await daemon.launchCommand({
        actor: 'console:test',
        project: 'proj',
        ...command,
      });
      return { runId, worktree };
    },
  };
}

async function waitClosed(paths, runId) {
  try {
    await waitFor(() => existsSync(archivedRunLedgerPath(paths, runId)), {
      label: 'run archived',
      attempts: 600,
      intervalMs: 100,
    });
  } catch (error) {
    const live = runLedgerPath(paths, runId);
    const tail = existsSync(live)
      ? readEvents(live)
          .slice(-12)
          .map((e) => `${e.seq} ${e.event} ${e.stage ?? e.layer ?? e.seat ?? ''} ${e.status ?? e.result ?? e.reason ?? e.verdict ?? ''}`)
      : ['no live ledger'];
    error.message += `\nledger tail:\n${tail.join('\n')}`;
    throw error;
  }
  return readEvents(archivedRunLedgerPath(paths, runId));
}

function waitParked(paths, runId, type) {
  return waitFor(
    () => readEvents(runLedgerPath(paths, runId)).find((e) => e.event === 'park' && e.type === type),
    { label: `park ${type}`, attempts: 600, intervalMs: 100 },
  );
}

function readRecord(paths, runId, cycle) {
  return JSON.parse(readFileSync(join(paths.archivedRuns, runId, `verdict-${cycle}.json`), 'utf8'));
}

// Fixture seat behaviors shared across scenarios.

function furyClean() {
  const seats = {};
  for (const seat of ['fury-spec', 'fury-code-shape', 'fury-operational', 'fury-security', 'fury-interface']) {
    seats[seat] = () => ({ report: { findings: [], summary: 'clean' } });
  }
  return seats;
}

/**
 * A triage behavior over the fixture convention: every finding summary is
 * "broken <layer>", so persistence resolves by matching prior findings to
 * the still-red layers.
 */
function triageSeat(classFor) {
  return ({ prompt }) => {
    const reds = [...prompt.matchAll(/^- layer (\S+):$/gm)].map((m) => m[1]);
    const prior = [...prompt.matchAll(/- \[(F\d+)\] \[[^\]]+\] broken (\S+)/g)].map((m) => ({
      id: m[1],
      layer: m[2],
    }));
    const persisting = prior.filter((p) => reds.includes(p.layer));
    const covered = new Set(persisting.map((p) => p.layer));
    const findings = reds
      .filter((layer) => !covered.has(layer))
      .map((layer) => ({
        ...classFor(layer),
        layers: [layer],
        summary: `broken ${layer}`,
        evidence: `red output of ${layer}`,
      }));
    return { report: { findings, persisting: persisting.map((p) => p.id), summary: 'triaged' } };
  };
}

function verifierSeat(decide) {
  return ({ prompt }) => {
    const items = [...prompt.matchAll(/^- \[([^\]]+)\] \((confirm|resolution-check)\) (.*)$/gm)].map(
      (m) => ({ id: m[1], mode: m[2], line: m[3] }),
    );
    return {
      report: {
        results: items.map((item) => {
          const d = decide(item);
          return {
            id: item.id,
            verdict: d.verdict,
            evidence: 'checked against the tree',
            ...(d.approach && { approach: true }),
          };
        }),
        summary: 'verified',
      },
    };
  };
}

// -- scenarios ---------------------------------------------------------------

test('a clean implementation ships green in one cycle; advisory findings never block', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    ...furyClean(),
    'fury-code-shape': () => ({
      report: {
        findings: [
          { lens: 'minimality', severity: 'MED', finding: 'duplicated helper', evidence: 'src/feature.mjs:1' },
        ],
        summary: 'one advisory',
      },
    }),
  };
  const fx = verdictFixture(t, { seats });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'park'));
  // Full spectrum, one cycle, all green.
  const layers = events.filter((e) => e.event === 'layer-result');
  assert.deepEqual(
    layers.map((e) => [e.layer, e.status]),
    [
      ['unit', 'green'],
      ['lint', 'green'],
      ['build', 'green'],
    ],
  );
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.equal(renders.length, 1);
  assert.equal(renders[0].verdict, 'green');
  assert.equal(renders[0].pass, 1);
  assert.deepEqual(renders[0].open, []);
  // The MED finding landed advisory in the ledger and stayed out of the record.
  const findings = events.filter((e) => e.event === 'finding');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].advisory, true);
  assert.equal(findings[0].severity, 'MED');
  const record = readRecord(fx.paths, runId, 1);
  assert.equal(record.verdict, 'green');
  assert.equal(record.spectrum.length, 3);
  assert.deepEqual(record.findings, []);
  // Four Fury seats fired once each; no interface (no UI paths), no verifier,
  // no triage, no generalist.
  const seatsFired = fx.calls.map((c) => c.seat);
  for (const seat of ['fury-spec', 'fury-code-shape', 'fury-operational', 'fury-security']) {
    assert.equal(seatsFired.filter((s) => s === seat).length, 1);
  }
  for (const seat of ['fury-interface', 'fury-verifier', 'verdict-triage', 'generalist-review']) {
    assert.ok(!seatsFired.includes(seat), `${seat} must not fire`);
  }
  // The dev seat carried the test-edit deny rules.
  const dev = fx.calls.find((c) => c.seat === 'dev');
  assert.ok(dev.denyTools.includes('Edit(tests/**)'));
  // The Tier-1 gates reach the dev seat as commands, not as a self-check.
  assert.ok(dev.prompt.includes('- unit: node --test tests/*.test.mjs'));
  assert.ok(dev.prompt.includes('- lint: node -e process.exit(0)'));
  assert.ok(!dev.prompt.includes('gate commands from the project config'));
  // No constitution file in this project: no policy block anywhere.
  for (const call of fx.calls) assert.ok(!call.prompt.includes('constitution'), call.seat);
});

test('the constitution reaches the working seats, and the judges get the authority order', async (t) => {
  const policy = '# Constitution\n\nAbsence of a file is never evidence of a missing deliverable.\n';
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    ...furyClean(),
    'fury-spec': () => ({
      report: {
        findings: [
          { lens: 'spec', severity: 'HIGH', finding: 'missing platform file', evidence: 'src/feature.mjs:1' },
        ],
        summary: 'one',
      },
    }),
    'fury-verifier': verifierSeat(() => ({ verdict: 'refuted' })),
  };
  const fx = verdictFixture(t, {
    seats,
    originFiles: { '.olympus/constitution.md': policy },
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const line = 'Absence of a file is never evidence of a missing deliverable.';
  const promptOf = (seat) => fx.calls.find((c) => c.seat === seat).prompt;
  // The working seat takes the policy without the authority order.
  assert.ok(promptOf('dev').includes(line));
  assert.ok(!promptOf('dev').includes('Authority order'));
  // Every judging seat takes both.
  for (const seat of ['fury-spec', 'fury-security', 'fury-verifier']) {
    assert.ok(promptOf(seat).includes(line), seat);
    assert.match(promptOf(seat), /Authority order, highest first: the constitution above/);
    assert.match(promptOf(seat), /blocking finding against the spec/);
  }
  // Only the verifier is told what the order means for confirming a finding.
  assert.match(promptOf('fury-verifier'), /Refute a finding that enforces an illegitimate clause/);
  assert.ok(!/Refute a finding/.test(promptOf('fury-spec')));
});

test('a code defect routes triage → repair round → generalist re-verdict', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': BAD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': triageSeat(() => ({ class: 'code-defect' })),
    ...furyClean(),
    'repair-dev': () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'fixed' } }),
    'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
  };
  const fx = verdictFixture(t, { seats });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // Cycle 1: the red unit layer blocks build — not-runnable, attributed.
  const c1 = events.filter((e) => e.event === 'layer-result' && e.cycle === 1);
  assert.deepEqual(
    c1.map((e) => [e.layer, e.status, e.attributedTo]),
    [
      ['unit', 'red', undefined],
      ['lint', 'green', undefined],
      ['build', 'not-runnable', 'unit'],
    ],
  );
  const finding = events.find((e) => e.event === 'finding');
  assert.equal(finding.class, 'code-defect');
  assert.deepEqual(finding.layers, ['unit']);
  const repair = events.find((e) => e.event === 'repair-round');
  assert.equal(repair.pass, 1);
  assert.equal(repair.round, 1);
  assert.deepEqual(repair.openBefore, [finding.id]);
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.deepEqual(
    renders.map((e) => [e.cycle, e.verdict, e.open.length]),
    [
      [1, 'red', 1],
      [2, 'green', 0],
    ],
  );
  // The five-seat fan-out never re-fires on a judged tree: the re-verdict
  // reviews the repair diff with the generalist seat.
  assert.equal(fx.calls.filter((c) => c.seat === 'fury-spec').length, 1);
  assert.equal(fx.calls.filter((c) => c.seat === 'generalist-review').length, 1);
  assert.ok(!fx.calls.some((c) => c.seat === 'fury-verifier'));
  assert.ok(fx.calls.find((c) => c.seat === 'repair-dev').denyTools.includes('Edit(tests/**)'));
  // The record closes the finding.
  const record = readRecord(fx.paths, runId, 2);
  assert.deepEqual(
    record.findings.map((f) => [f.id, f.status]),
    [[finding.id, 'resolved']],
  );
});

test('a flaky layer stamps a flake and never reaches triage', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    ...furyClean(),
  };
  const flaky = [
    'node',
    '-e',
    "const fs=require('fs');const p='../flake-marker';if(fs.existsSync(p))process.exit(0);fs.writeFileSync(p,'x');process.exit(1);",
  ];
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'flaky', command: 'flaky' },
    ],
    commands: { suite: SUITE_CMD, flaky },
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const flake = events.find((e) => e.event === 'flake');
  assert.equal(flake.layer, 'flaky');
  assert.equal(
    events.find((e) => e.event === 'layer-result' && e.layer === 'flaky').status,
    'green',
  );
  assert.ok(!fx.calls.some((c) => c.seat === 'verdict-triage'));
  assert.ok(!events.some((e) => e.event === 'finding'));
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.equal(renders.length, 1);
  assert.equal(renders[0].verdict, 'green');
  assert.deepEqual(readRecord(fx.paths, runId, 1).flakes, ['flaky']);
});

test('a suite defect re-freezes the tests without budget and without a new fury round', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': triageSeat(() => ({ class: 'suite-defect', depth: 'test' })),
    ...furyClean(),
    suite: () => ({
      files: { 'tests/feature.test.mjs': STRONG_TEST },
      report: { suiteFiles: ['tests/feature.test.mjs'], reds: [], summary: 're-frozen' },
    }),
  };
  const fx = verdictFixture(t, { seats, suiteFiles: { 'tests/feature.test.mjs': WRONG_TEST } });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const finding = events.find((e) => e.event === 'finding');
  assert.equal(finding.class, 'suite-defect');
  assert.equal(finding.depth, 'test');
  const refreeze = events.find((e) => e.event === 're-freeze');
  assert.deepEqual(refreeze.findings, [finding.id]);
  assert.deepEqual(refreeze.files, ['tests/feature.test.mjs']);
  const committed = events.find((e) => e.event === 'suite-committed');
  assert.equal(committed.phase, 're-freeze');
  assert.equal(committed.sha, refreeze.sha);
  // No implementation budget spent, no judgment seats on the unchanged tree.
  assert.ok(!events.some((e) => e.event === 'repair-round'));
  assert.ok(!fx.calls.some((c) => c.seat === 'generalist-review'));
  assert.equal(fx.calls.filter((c) => c.seat === 'fury-spec').length, 1);
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.deepEqual(
    renders.map((e) => [e.cycle, e.verdict]),
    [
      [1, 'red'],
      [2, 'green'],
    ],
  );
  // The second cycle ran against the re-frozen suite sha.
  assert.equal(renders[1].suiteSha, refreeze.sha);
  const record = readRecord(fx.paths, runId, 2);
  assert.deepEqual(
    record.findings.map((f) => [f.id, f.status]),
    [[finding.id, 'resolved']],
  );
});

test('spec-deep and intent-deep suite defects amend the spec; the intent conflict parks first', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': () => ({
      report: {
        findings: [
          {
            class: 'suite-defect',
            depth: 'spec',
            layers: ['unit'],
            summary: 'broken unit',
            evidence: 'the spec names the wrong factor',
          },
          {
            class: 'suite-defect',
            depth: 'intent',
            layers: ['unit'],
            summary: 'the suite contradicts the card',
            evidence: 'card vs spec',
          },
        ],
        persisting: [],
        summary: 'triaged',
      },
    }),
    ...furyClean(),
    'spec-birth': () => ({ report: { amendedSections: ['Goal'], summary: 'amended' } }),
    suite: () => ({
      files: { 'tests/feature.test.mjs': STRONG_TEST },
      report: { suiteFiles: ['tests/feature.test.mjs'], reds: [], summary: 're-frozen' },
    }),
  };
  const fx = verdictFixture(t, { seats, suiteFiles: { 'tests/feature.test.mjs': WRONG_TEST } });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'intent-conflict');
  assert.ok(park.question.includes('intent-level'));
  assert.ok(park.question.includes('contradicts the card'));
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'Keep the doubling from the card.' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The birth seat amended the spec, honoring the answer, before the re-freeze.
  const amend = fx.calls.find((c) => c.seat === 'spec-birth');
  assert.ok(amend.prompt.includes('Amend the born spec'));
  assert.ok(amend.prompt.includes('Keep the doubling from the card.'));
  const refreeze = events.find((e) => e.event === 're-freeze');
  assert.equal(refreeze.findings.length, 2);
  assert.ok(!events.some((e) => e.event === 'repair-round'));
});

test('a persistent env finding parks the provisioning gate after its operational fix', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': triageSeat(() => ({ class: 'env' })),
    ...furyClean(),
  };
  const ext = ['node', '-e', "process.exit(require('fs').existsSync('../env-broken')?1:0)"];
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'ext', command: 'ext' },
    ],
    commands: { suite: SUITE_CMD, ext },
    seedExtra: async (ctx, worktree) => {
      writeFileSync(join(worktree, '..', 'env-broken'), 'x');
    },
  });
  const { runId, worktree } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  assert.ok(park.question.includes('[env]'));
  assert.ok(park.question.includes('persist after an operational fix'));
  // One automatic operational fix ran before the gate parked.
  let events = readEvents(runLedgerPath(fx.paths, runId));
  assert.equal(events.filter((e) => e.event === 'operational-fix').length, 1);
  // The operator repairs the substrate, then confirms.
  rmSync(join(worktree, '..', 'env-broken'));
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'substrate repaired' });
  events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const fixes = events.filter((e) => e.event === 'operational-fix');
  assert.equal(fixes.length, 2);
  assert.equal(fixes[0].actor, 'daemon');
  assert.equal(fixes[1].actor, 'operator');
  assert.equal(fixes[1].source, 'answer');
  assert.ok(!events.some((e) => e.event === 'repair-round'));
  assert.ok(!events.some((e) => e.event === 'gate-integrity'));
});

test('a harness finding stamps gate-integrity loud and resolves when the layer recovers', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': triageSeat(() => ({ class: 'harness' })),
    ...furyClean(),
  };
  // Red on the first two runs (initial + flake re-run), green from the third:
  // the operational fix "repairs" the machinery by construction.
  const hlayer = [
    'node',
    '-e',
    "const fs=require('fs');const p='../hcount';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));process.exit(n>=2?0:1);",
  ];
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'hlayer', command: 'hlayer' },
    ],
    commands: { suite: SUITE_CMD, hlayer },
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const finding = events.find((e) => e.event === 'finding');
  assert.equal(finding.class, 'harness');
  const loud = events.find((e) => e.event === 'gate-integrity');
  assert.equal(loud.findingId, finding.id);
  assert.ok(loud.gist.includes('harness defect'));
  // The loud line landed in the loud stream index and got its paired
  // resolution when the finding left the open set.
  const stream = readFileSync(fx.paths.loudStream, 'utf8');
  assert.ok(stream.includes(`run:${runId}`));
  assert.ok(stream.includes('gate-integrity'));
  const resolved = events.find((e) => e.event === 'resolved');
  assert.equal(resolved.resolves, loud.seq);
  assert.equal(resolved.resolvedEvent, 'gate-integrity');
  assert.equal(events.filter((e) => e.event === 'operational-fix').length, 1);
});

test('confirm-to-block: only verifier-confirmed HIGHs enter the verdict; repair resolves them', async (t) => {
  const seats = {
    dev: () => ({
      files: { 'src/feature.mjs': GOOD_FEATURE, 'src/ui/widget.mjs': 'export const w = 1;\n' },
      report: { summary: 'implemented' },
    }),
    ...furyClean(),
    'fury-operational': () => ({
      report: {
        findings: [
          { lens: 'operational', severity: 'HIGH', finding: 'no retry handling', evidence: 'src/feature.mjs:1' },
        ],
        summary: 'one',
      },
    }),
    'fury-security': () => ({
      report: {
        findings: [
          { lens: 'security', severity: 'HIGH', finding: 'injection risk in query', evidence: 'src/feature.mjs:1' },
        ],
        summary: 'one',
      },
    }),
    'fury-verifier': verifierSeat((item) =>
      item.mode === 'confirm'
        ? { verdict: item.line.includes('injection') ? 'confirmed' : 'refuted' }
        : { verdict: 'resolved' },
    ),
    'repair-dev': () => ({ files: { 'src/query.mjs': 'export const q = [];\n' }, report: { summary: 'hardened' } }),
    'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
  };
  const fx = verdictFixture(t, { seats, repo: { testPaths: ['tests'], uiPaths: ['src/ui'] } });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The UI diff pulled the conditional interface seat in.
  assert.equal(fx.calls.filter((c) => c.seat === 'fury-interface').length, 1);
  // Refuted HIGH → advisory; confirmed HIGH → blocks.
  const findings = events.filter((e) => e.event === 'finding');
  const refuted = findings.find((e) => e.lens === 'operational');
  assert.equal(refuted.confirmed, false);
  assert.equal(refuted.advisory, true);
  const confirmed = findings.find((e) => e.lens === 'security');
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.advisory, undefined);
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.deepEqual(renders[0].open, [confirmed.id]);
  assert.equal(renders[1].verdict, 'green');
  // The record carries confirmed findings only.
  const record1 = readRecord(fx.paths, runId, 1);
  assert.deepEqual(
    record1.findings.map((f) => [f.id, f.lens, f.status]),
    [[confirmed.id, 'security', 'open']],
  );
  // Verifier: confirm round on cycle 1, resolution-check on cycle 2.
  const verifierCalls = fx.calls.filter((c) => c.seat === 'fury-verifier');
  assert.equal(verifierCalls.length, 2);
  assert.ok(verifierCalls[0].prompt.includes('(confirm)'));
  assert.ok(verifierCalls[1].prompt.includes(`[${confirmed.id}] (resolution-check)`));
  assert.equal(events.filter((e) => e.event === 'repair-round').length, 1);
});

test('stall → fresh pass → second stall parks; fail closes the run', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    ...furyClean(),
    'fury-code-shape': () => ({
      report: {
        findings: [
          { lens: 'architecture', severity: 'HIGH', finding: 'logic in the wrong layer', evidence: 'src/feature.mjs:1' },
        ],
        summary: 'one',
      },
    }),
    'fury-verifier': verifierSeat((item) =>
      item.mode === 'confirm' ? { verdict: 'confirmed' } : { verdict: 'unresolved' },
    ),
    'repair-dev': () => ({ report: { summary: 'tried' } }),
    'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
  };
  const fx = verdictFixture(t, { seats });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'second-stall');
  assert.deepEqual(park.options, ['repair-again', 'fresh-pass', 'fail']);
  assert.ok(park.question.includes('stalled again'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'fail' });
  const events = await waitClosed(fx.paths, runId);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'second-stall');
  // Two stalls around one fresh pass; the ceiling held.
  const stalls = events.filter((e) => e.event === 'stall');
  assert.deepEqual(
    stalls.map((e) => [e.pass, e.reason]),
    [
      [1, 'no-progress'],
      [2, 'no-progress'],
    ],
  );
  const fresh = events.find((e) => e.event === 'fresh-pass');
  assert.equal(fresh.pass, 2);
  assert.equal(fresh.trigger, 'no-progress');
  const impls = events.filter((e) => e.event === 'implementation-committed');
  assert.deepEqual(
    impls.map((e) => [e.pass, e.phase]),
    [
      [1, 'initial'],
      [1, 'repair'],
      [2, 'fresh'],
      [2, 'repair'],
    ],
  );
  // The fresh pass started from the frozen suite, never the prior tree.
  const freeze = events.find((e) => e.event === 'freeze');
  assert.equal(impls[2].baseSha, freeze.sha);
  const freshDev = fx.calls.filter((c) => c.seat === 'dev')[1];
  assert.ok(freshDev.prompt.includes('stalled and was discarded'));
  // The Fury fan-out fired once per implementation pass.
  assert.deepEqual(
    fx.calls.filter((c) => c.seat === 'fury-code-shape').map((c) => c.label),
    ['fury-code-shape-c1', 'fury-code-shape-c3'],
  );
});

test('a confirmed approach-level finding takes the fresh pass without a repair round', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    ...furyClean(),
    'fury-spec': ({ label }) =>
      label === 'fury-spec-c1'
        ? {
            report: {
              findings: [
                {
                  lens: 'spec',
                  severity: 'HIGH',
                  finding: 'the implementation structure contradicts the spec',
                  evidence: 'spec section 1',
                  approach: true,
                },
              ],
              summary: 'approach-level',
            },
          }
        : { report: { findings: [], summary: 'clean' } },
    'fury-verifier': verifierSeat((item) => ({
      verdict: 'confirmed',
      approach: item.line.includes('structure'),
    })),
  };
  const fx = verdictFixture(t, { seats });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'repair-round'));
  assert.ok(!events.some((e) => e.event === 'stall'));
  const fresh = events.find((e) => e.event === 'fresh-pass');
  assert.equal(fresh.trigger, 'approach-finding');
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.deepEqual(
    renders.map((e) => [e.pass, e.verdict]),
    [
      [1, 'red'],
      [2, 'green'],
    ],
  );
});

test('the repair cap exhausts into a stall and the fresh pass', async (t) => {
  const allOk = Object.fromEntries([1, 2, 3, 4].map((n) => [`src/m${n}.txt`, 'ok\n']));
  const allBad = Object.fromEntries([1, 2, 3, 4].map((n) => [`src/m${n}.txt`, 'bad\n']));
  const seats = {
    dev: ({ label }) =>
      label === 'dev-1'
        ? { files: { 'src/feature.mjs': GOOD_FEATURE, ...allBad }, report: { summary: 'partial' } }
        : { files: { 'src/feature.mjs': GOOD_FEATURE, ...allOk }, report: { summary: 'complete' } },
    'verdict-triage': triageSeat(() => ({ class: 'code-defect' })),
    ...furyClean(),
    'repair-dev': ({ label }) => {
      const n = Number(label.split('-')[2]);
      return { files: { [`src/m${n}.txt`]: 'ok\n' }, report: { summary: `fixed m${n}` } };
    },
    'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
  };
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      ...[1, 2, 3, 4].map((n) => ({ name: `m${n}`, command: `m${n}` })),
    ],
    commands: {
      suite: SUITE_CMD,
      ...Object.fromEntries([1, 2, 3, 4].map((n) => [`m${n}`, markerCmd(`src/m${n}.txt`)])),
    },
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // Three shrinking rounds spent the cap; the residual finding forced the
  // fresh pass.
  const repairs = events.filter((e) => e.event === 'repair-round');
  assert.deepEqual(
    repairs.map((e) => [e.round, e.openBefore.length]),
    [
      [1, 4],
      [2, 3],
      [3, 2],
    ],
  );
  const stall = events.find((e) => e.event === 'stall');
  assert.equal(stall.reason, 'cap-exhausted');
  const fresh = events.find((e) => e.event === 'fresh-pass');
  assert.equal(fresh.trigger, 'cap-exhausted');
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.equal(renders.length, 5);
  assert.equal(renders[4].pass, 2);
  assert.equal(renders[4].verdict, 'green');
});

test('a triage seat that fails its own checks parks the run; a judge is not the run', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': BAD_FEATURE }, report: { summary: 'implemented' } }),
    // Names a layer that is not a persistent red, and covers none that is.
    'verdict-triage': () => ({
      report: {
        findings: [
          { class: 'code-defect', layers: ['ghost'], summary: 'broken ghost', evidence: 'none' },
        ],
        persisting: [],
        summary: 'triaged',
      },
    }),
    ...furyClean(),
  };
  const fx = verdictFixture(t, { seats, gates: [{ name: 'unit', command: 'suite' }] });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'seat-failure');
  assert.deepEqual(park.options, ['retry', 'abandon']);
  assert.equal(park.detail.seat, 'verdict-triage');
  assert.equal(park.detail.cause, 'work-product-defect');
  // The corrective invocation ran before the park; the answer buys one more.
  const triageCalls = () => fx.calls.filter((c) => c.seat === 'verdict-triage').length;
  assert.equal(triageCalls(), 2);
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'retry' });
  await waitFor(
    () =>
      readEvents(runLedgerPath(fx.paths, runId)).filter(
        (e) => e.event === 'park' && e.type === 'seat-failure',
      ).length >= 2,
    { label: 'second seat-failure park', attempts: 600, intervalMs: 100 },
  );
  assert.equal(triageCalls(), 3);
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const closed = (await waitClosed(fx.paths, runId)).find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'seat-failure');
  assert.equal(closed.seat, 'verdict-triage');
});

test('a missing intake ticket parks, and the answer hands over a corrected path', async (t) => {
  const seats = {
    dev: () => ({
      files: { 'src/g.mjs': 'export const g = (x) => x + 1;\n', 'tests/g.test.mjs': G_TEST },
      report: { summary: 'fixed with a regression test' },
    }),
    'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
  };
  const fx = verdictFixture(t, {
    seats,
    gates: [{ name: 'unit', command: 'suite' }],
    commands: { suite: SUITE_CMD },
  });
  const { runId } = await fx.launchFromConsole({ lane: 'repair', ticket: 'tickets/gone.md' });
  const park = await waitParked(fx.paths, runId, 'stage-blocked');
  assert.equal(park.reason, 'ticket-missing');
  assert.deepEqual(park.options, ['retry', 'abandon']);
  assert.ok(!fx.calls.some((c) => c.seat === 'dev'));
  // The answer carries the ticket itself: an absolute path the daemon holds.
  const corrected = join(fx.paths.runs, runId, 'ticket.md');
  writeFileSync(corrected, '## Defect\n\ng(x) is missing; add g(x) = x + 1 with a regression test.\n');
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: corrected });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(fx.calls.find((c) => c.seat === 'dev').prompt.includes(corrected));
});

test('a console launch reaches the repair fix seat, which reviews generally and may write tests', async (t) => {
  const seats = {
    dev: () => ({
      files: { 'src/g.mjs': 'export const g = (x) => x + 1;\n', 'tests/g.test.mjs': G_TEST },
      report: { summary: 'fixed with a regression test' },
    }),
    'generalist-review': () => ({
      report: {
        findings: [
          { lens: 'minimality', severity: 'LOW', finding: 'inline constant', evidence: 'src/g.mjs:1' },
        ],
        summary: 'advisory only',
      },
    }),
  };
  const fx = verdictFixture(t, {
    seats,
    gates: [{ name: 'unit', command: 'suite' }],
    commands: { suite: SUITE_CMD },
    originFiles: { 'tickets/t1.md': '## Defect\n\ng(x) is missing; add g(x) = x + 1 with a regression test.\n' },
  });
  const { runId, worktree } = await fx.launchFromConsole({
    lane: 'repair',
    ticket: 'tickets/t1.md',
  });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The ticket is the spec; the fix seat may write tests. A repo-relative
  // ticket resolves inside the run worktree.
  const dev = fx.calls.find((c) => c.seat === 'dev');
  assert.ok(dev.prompt.includes('intake ticket'));
  assert.ok(dev.prompt.includes(join(worktree, 'tickets/t1.md')));
  assert.ok(dev.prompt.includes('regression test'));
  // The fix seat is judged by the same gates, so it is given them too.
  assert.ok(dev.prompt.includes('- unit: node --test tests/*.test.mjs'));
  assert.equal(dev.denyTools, undefined);
  // Generalist review replaces the Fury fan-out; the LOW stays advisory.
  assert.ok(!fx.calls.some((c) => c.seat.startsWith('fury-')));
  assert.equal(fx.calls.filter((c) => c.seat === 'generalist-review').length, 1);
  const finding = events.find((e) => e.event === 'finding');
  assert.equal(finding.advisory, true);
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.equal(renders.length, 1);
  assert.equal(renders[0].verdict, 'green');
  const record = readRecord(fx.paths, runId, 1);
  assert.deepEqual(record.spectrum, [{ layer: 'unit', status: 'green' }]);
  assert.deepEqual(record.findings, []);
});

// -- the diff-policy gate at candidate capture -------------------------------

const POLICY = {
  story: {
    deniedPaths: ['.github/**', '.npmrc', 'scripts/**'],
    declaredPaths: ['**/package.json'],
    forbiddenPatterns: ['-win32\\.'],
  },
  repair: { deniedPaths: ['.olympus/**'], forbiddenPatterns: ['-win32\\.'] },
};

const SPEC_WITH_BLOCK = [
  '# Spec',
  '',
  'f(x) returns 2*x.',
  '',
  '```touched-paths',
  'src/feature.mjs',
  'package.json',
  '```',
  '',
].join('\n');

function loudFor(paths, runId, event) {
  return openLoud(paths).filter((i) => i.ledger === `run:${runId}` && i.event === event);
}

test('a denied path blocks the capture, stamps loud, and buys one corrective', async (t) => {
  const seats = {
    dev: ({ label }) =>
      label === 'dev-1'
        ? {
            files: { 'src/feature.mjs': GOOD_FEATURE, '.npmrc': 'link-workspace-packages=true\n' },
            report: { summary: 'implemented' },
          }
        : { removes: ['.npmrc'], report: { summary: 'implemented without the topology change' } },
    ...furyClean(),
  };
  const fx = verdictFixture(t, { seats, diffPolicy: POLICY });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The stamp names the path and the rule that blocked it.
  const stamp = events.find((e) => e.event === 'diff-policy-violation');
  assert.equal(stamp.seat, 'dev');
  assert.equal(stamp.lane, 'story');
  assert.deepEqual(stamp.violations, [{ path: '.npmrc', rule: 'denied', pattern: '.npmrc' }]);
  assert.deepEqual(stamp.dropped, []);
  assert.match(stamp.gist, /\.npmrc/);
  // The corrective invocation carried the exact violation.
  const corrective = fx.calls.find((c) => c.label === 'dev-2');
  assert.ok(corrective, 'the corrective dev invocation ran');
  assert.match(corrective.prompt, /Correction brief/);
  assert.match(corrective.prompt, /\.npmrc: the diff policy denies this path to this lane/);
  // One candidate was captured, after the corrective, and the cleared record
  // resolves, so the loud strip does not carry a run that answered itself.
  assert.ok(events.some((e) => e.event === 'resolved' && e.resolves === stamp.seq));
  assert.equal(loudFor(fx.paths, runId, 'diff-policy-violation').length, 0);
  assert.equal(events.filter((e) => e.event === 'implementation-committed').length, 1);
});

test('a repeat violation parks seat-failure and the loud record stays open', async (t) => {
  const seats = {
    dev: () => ({
      files: { 'src/feature.mjs': GOOD_FEATURE, 'scripts/gate.mjs': 'process.exit(0);\n' },
      report: { summary: 'implemented' },
    }),
    ...furyClean(),
  };
  const fx = verdictFixture(t, { seats, diffPolicy: POLICY });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'seat-failure');
  assert.deepEqual(park.options, ['retry', 'abandon']);
  assert.equal(park.detail.seat, 'dev');
  assert.equal(park.detail.cause, 'work-product-defect');
  // One corrective ran before the park, and no candidate was ever committed.
  assert.equal(fx.calls.filter((c) => c.seat === 'dev').length, 2);
  const live = readEvents(runLedgerPath(fx.paths, runId));
  assert.ok(!live.some((e) => e.event === 'implementation-committed'));
  const failure = live.find((e) => e.event === 'seat-failure');
  assert.match(failure.defects[0], /scripts\/gate\.mjs: the diff policy denies this path/);
  assert.equal(loudFor(fx.paths, runId, 'diff-policy-violation').length, 2);
  // A bought retry carries the violation into the fresh invocation's brief.
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'retry' });
  await waitFor(
    () =>
      readEvents(runLedgerPath(fx.paths, runId)).filter(
        (e) => e.event === 'park' && e.type === 'seat-failure',
      ).length >= 2,
    { label: 'second seat-failure park', attempts: 600, intervalMs: 100 },
  );
  const retried = fx.calls.filter((c) => c.seat === 'dev');
  assert.equal(retried.length, 3);
  assert.match(retried[2].prompt, /scripts\/gate\.mjs: the diff policy denies this path/);
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const closed = (await waitClosed(fx.paths, runId)).find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.seat, 'dev');
});

test('declaredPaths passes a path the spec declares and blocks one it does not', async (t) => {
  const seats = {
    dev: ({ label }) =>
      label === 'dev-1'
        ? {
            files: {
              'src/feature.mjs': GOOD_FEATURE,
              'package.json': '{"name":"declared"}\n',
              'apps/api/package.json': '{"name":"undeclared"}\n',
            },
            report: { summary: 'implemented' },
          }
        : { removes: ['apps'], report: { summary: 'implemented' } },
    ...furyClean(),
  };
  const fx = verdictFixture(t, { seats, diffPolicy: POLICY, specText: SPEC_WITH_BLOCK });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // Only the undeclared one was named; the declared one rode through.
  const stamp = events.find((e) => e.event === 'diff-policy-violation');
  assert.deepEqual(
    stamp.violations.map((v) => [v.path, v.rule]),
    [['apps/api/package.json', 'undeclared']],
  );
  assert.match(
    fx.calls.find((c) => c.label === 'dev-2').prompt,
    /apps\/api\/package\.json: the diff policy admits this path only when the spec declares it/,
  );
});

test('a forbidden path shape blocks even when the spec declares it', async (t) => {
  const spec = SPEC_WITH_BLOCK.replace('package.json', 'baseline/shot-win32.png');
  const seats = {
    dev: ({ label }) =>
      label === 'dev-1'
        ? {
            files: { 'src/feature.mjs': GOOD_FEATURE, 'baseline/shot-win32.png': 'PNG\n' },
            report: { summary: 'implemented' },
          }
        : { removes: ['baseline'], report: { summary: 'implemented' } },
    ...furyClean(),
  };
  const fx = verdictFixture(t, { seats, diffPolicy: POLICY, specText: spec });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const stamp = events.find((e) => e.event === 'diff-policy-violation');
  assert.deepEqual(
    stamp.violations.map((v) => [v.path, v.rule, v.pattern]),
    [['baseline/shot-win32.png', 'forbidden', '-win32\\.']],
  );
});

test('a change the capture takes back is stamped and named, with no policy declared', async (t) => {
  // No diffPolicy block at all: the drop record is not a policy tier, it is
  // the capture refusing to discard a seat's work in silence.
  const seats = {
    dev: ({ label }) =>
      label === 'dev-1'
        ? {
            files: { 'src/feature.mjs': GOOD_FEATURE, 'tests/feature.test.mjs': WRONG_TEST },
            report: { summary: 'implemented, and I relaxed the test' },
          }
        : { report: { summary: 'implemented; the test stands' } },
    ...furyClean(),
  };
  const fx = verdictFixture(t, { seats });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const stamp = events.find((e) => e.event === 'diff-policy-violation');
  assert.deepEqual(stamp.dropped, ['tests/feature.test.mjs']);
  assert.deepEqual(stamp.violations, []);
  assert.match(
    fx.calls.find((c) => c.label === 'dev-2').prompt,
    /tests\/feature\.test\.mjs: the capture took this change back/,
  );
  // The frozen suite is what was judged. The seat's relaxed test expects
  // f(2) === 5 against a feature that doubles, so a candidate carrying it
  // would have gone red on the unit layer instead of shipping in one cycle.
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.deepEqual(
    renders.map((e) => [e.cycle, e.verdict]),
    [[1, 'green']],
  );
});

test('a freeze exclusion is the dev seat\'s file: no deny rule, no restore, no drop', async (t) => {
  // The frozen suite reaches the dev-owned harness the spec assigned to the
  // implementing pass. The suite is green only if that file survives the tool
  // boundary, the capture and every restore between the seat and the gates.
  const seats = {
    dev: () => ({
      files: {
        'src/feature.mjs': GOOD_FEATURE,
        'tests/support/harness.mjs': 'export const boot = () => 2;\n',
      },
      report: { summary: 'implemented' },
    }),
    ...furyClean(),
  };
  const fx = verdictFixture(t, {
    seats,
    suiteFiles: { 'tests/feature.test.mjs': HARNESS_TEST },
    exclusions: ['tests/support/harness.mjs'],
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(
    events.filter((e) => e.event === 'verdict-rendered').map((e) => [e.cycle, e.verdict]),
    [[1, 'green']],
  );
  // Nothing was taken back and nothing was refused: the exclusion is the
  // seat's own file, and the rest of the test path is still the frozen suite.
  assert.ok(!events.some((e) => e.event === 'diff-policy-violation'));
  assert.equal(events.filter((e) => e.event === 'implementation-committed').length, 1);
  const dev = fx.calls.find((c) => c.seat === 'dev');
  assert.ok(dev.denyTools.includes('Edit(tests/feature.test.mjs)'));
  assert.ok(!dev.denyTools.includes('Edit(tests/**)'));
  assert.ok(!dev.denyTools.some((rule) => rule.includes('harness.mjs')));
});

test('the repair lane keeps its regression test and answers its own tiers', async (t) => {
  const seats = {
    dev: ({ label }) =>
      label === 'dev-1'
        ? {
            files: {
              'src/g.mjs': 'export const g = (x) => x + 1;\n',
              'tests/g.test.mjs': G_TEST,
              '.olympus/cards/invented.md': '# a card the fix seat invented\n',
            },
            report: { summary: 'fixed' },
          }
        : {
            removes: ['.olympus/cards'],
            report: { summary: 'fixed without the harness change' },
          },
    'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
  };
  const fx = verdictFixture(t, {
    seats,
    gates: [{ name: 'unit', command: 'suite' }],
    commands: { suite: SUITE_CMD },
    diffPolicy: POLICY,
    originFiles: {
      'tickets/t1.md':
        '## Defect\n\ng(x) is missing; add g(x) = x + 1 in src/g.mjs with a regression test.\n',
    },
  });
  const { runId } = await fx.launchFromConsole({ lane: 'repair', ticket: 'tickets/t1.md' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const stamp = events.find((e) => e.event === 'diff-policy-violation');
  assert.equal(stamp.lane, 'repair');
  assert.deepEqual(
    stamp.violations.map((v) => [v.path, v.rule]),
    [['.olympus/cards/invented.md', 'denied']],
  );
  // The repair lane has no frozen suite to restore, so its regression test is
  // never taken back: the drop list is empty even though the seat wrote a
  // test file, and the unit layer ran that test green.
  assert.deepEqual(stamp.dropped, []);
  assert.ok(
    events.some((e) => e.event === 'layer-result' && e.layer === 'unit' && e.status === 'green'),
  );
  assert.match(
    fx.calls.find((c) => c.label === 'dev-2').prompt,
    /\.olympus\/cards\/invented\.md: the diff policy denies this path/,
  );
});
