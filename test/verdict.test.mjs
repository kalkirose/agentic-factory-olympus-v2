// The post-freeze chain end to end on fixture repos: seeded defect fixtures
// route down each response-ladder arm, and the verdict record carries the
// full spectrum plus confirmed findings only. The lane is seeded at the
// freeze boundary — the pre-freeze chain has its own suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, archivedRunLedgerPath, runLedgerPath } from '../src/daemon/home.mjs';
import { postFreeze, repairLane } from '../src/lanes/verdict.mjs';
import { commitAll } from '../src/isolation/tree.mjs';
import { Ledger, readEvents } from '../src/ledger/ledger.mjs';
import { INSTANCE_EVENTS } from '../src/ledger/registry.mjs';
import { ackFingerprint, findingFingerprint, standingAcksFor } from '../src/ledger/acks.mjs';
import { writeControlCommand } from '../src/daemon/control.mjs';
import { openLoud } from '../src/telemetry/readers.mjs';
import { OWNER_PIN_MARKER } from '../src/lanes/supersede.mjs';
import { PARTS_ENV } from '../src/lanes/parts.mjs';
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

// A pin an earlier story froze: the export set is closed. This story's own
// criterion needs a second export, so the two are unsatisfiable together —
// the intent conflict only an owner can settle.
const PINNED_CLOSED = `import test from 'node:test';
import assert from 'node:assert/strict';
test('the export set is closed', async () => {
  const mod = await import('../src/feature.mjs');
  assert.deepEqual(Object.keys(mod).sort(), ['f']);
});
`;

// The same pin, opened for the deliberate extension the ruling grants.
const PINNED_EXTENDED = `import test from 'node:test';
import assert from 'node:assert/strict';
test('the export set is closed', async () => {
  const mod = await import('../src/feature.mjs');
  assert.deepEqual(Object.keys(mod).sort(), ['f', 'g']);
});
`;

const PAIR_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('g is published', async () => {
  const mod = await import('../src/feature.mjs');
  assert.equal(typeof mod.g, 'function');
});
`;

const PAIR_FEATURE = 'export const f = (x) => 2 * x;\nexport const g = () => 1;\n';

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
      JSON.stringify(
        {
          runId: ctx.runId,
          suiteSha: sha,
          suiteFiles: Object.keys(files),
          frozenExclusions: exclusions,
        },
        null,
        2,
      ) + '\n',
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
    review = undefined,
    diffPolicy = undefined,
    specText = undefined,
    exclusions = [],
    stack = null,
    composeCommand = undefined,
    partTargeting = undefined,
    flakeRerun = undefined,
    concurrencyGroups = undefined,
    laneConfig = { story: { suiteCommand: 'suite' } },
  } = opts;
  const root = tempDir();
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson({
      repo,
      commands,
      gates: {
        tier1: gates,
        ...(partTargeting !== undefined && { partTargeting }),
        ...(flakeRerun !== undefined && { flakeRerun }),
        ...(concurrencyGroups !== undefined && { concurrencyGroups }),
      },
      lanes: laneConfig,
      stack,
      ...(review && { review }),
      ...(diffPolicy && { diffPolicy }),
    }),
    'src/base.mjs': 'export const base = 1;\n',
    ...originFiles,
  });
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({
      version: 1,
      projects: { proj: { repoUrl: origin, slotCap: 2 } },
      ...(composeCommand && { composeCommand }),
    }) + '\n',
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

// Every seat a panel can put on the fan-out. The code-shape seat is out of the
// default panel and only fires where a scenario configures its lenses back on.
function furyClean() {
  const seats = {};
  for (const seat of ['fury-spec', 'fury-code-shape', 'fury-operational', 'fury-interface']) {
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
    return {
      report: {
        findings,
        // A first cycle has no prior findings and takes no field for them.
        ...(prior.length > 0 && { persisting: persisting.map((p) => p.id) }),
        summary: 'triaged',
      },
    };
  };
}

/** A re-freeze suite behavior that declares nothing twice, then amends. */
function refusesTwice() {
  let refused = 0;
  return () =>
    refused++ < 2
      ? { report: { suiteFiles: [], reds: [], summary: 'nothing declared' } }
      : {
          files: { 'tests/feature.test.mjs': STRONG_TEST, 'tests/marker.txt': 'ok' },
          report: {
            suiteFiles: ['tests/feature.test.mjs', 'tests/marker.txt'],
            reds: [],
            summary: 're-frozen',
          },
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
    'fury-operational': () => ({
      report: {
        findings: [
          { lens: 'operational', severity: 'MED', finding: 'no retry handling', evidence: 'src/feature.mjs:1' },
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
  // The default panel fired once each; no interface (no UI paths), no
  // verifier, no triage, no generalist.
  const seatsFired = fx.calls.map((c) => c.seat);
  for (const seat of ['fury-spec', 'fury-operational']) {
    assert.equal(seatsFired.filter((s) => s === seat).length, 1);
  }
  for (const seat of ['fury-interface', 'fury-verifier', 'verdict-triage', 'generalist-review']) {
    assert.ok(!seatsFired.includes(seat), `${seat} must not fire`);
  }
  // The cut lenses spawn nothing: no code-shape seat, and no seat anywhere is
  // asked to judge architecture or minimality.
  assert.ok(!seatsFired.includes('fury-code-shape'), 'the cut lenses spawned a seat');
  for (const call of fx.calls) {
    assert.ok(!call.prompt.includes('- architecture:'), call.seat);
    assert.ok(!call.prompt.includes('- minimality:'), call.seat);
  }
  // Security folded onto the operational seat rather than out of the panel.
  const operational = fx.calls.find((c) => c.seat === 'fury-operational').prompt;
  assert.ok(operational.includes('- operational: failure paths'));
  assert.ok(operational.includes('- security: authorization on every entry point'));
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
  for (const seat of ['fury-spec', 'fury-operational', 'fury-verifier']) {
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

test('a repair cycle runs the reds and their dependents, carries the rest, and confirms before green', async (t) => {
  const seats = {
    dev: () => ({
      files: { 'src/feature.mjs': BAD_FEATURE, 'src/shape.txt': 'bad\n', 'src/quiet.txt': 'ok\n' },
      report: { summary: 'implemented' },
    }),
    'verdict-triage': triageSeat(() => ({ class: 'code-defect' })),
    ...furyClean(),
    'repair-dev': ({ label }) =>
      label === 'repair-dev-1'
        ? { files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'fixed the unit red' } }
        : { files: { 'src/shape.txt': 'ok\n' }, report: { summary: 'fixed the shape red' } },
    'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
  };
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'shape', command: 'shape' },
      { name: 'quiet', command: 'quiet' },
      { name: 'build', command: 'build', needs: ['unit'] },
    ],
    commands: {
      suite: SUITE_CMD,
      shape: markerCmd('src/shape.txt'),
      quiet: markerCmd('src/quiet.txt'),
      build: BUILD_CMD,
    },
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const ranIn = (cycle) =>
    events.filter((e) => e.event === 'layer-result' && e.cycle === cycle).map((e) => e.layer);
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.deepEqual(
    renders.map((e) => [e.cycle, e.sweep, e.verdict]),
    [
      [1, 'full', 'red'],
      [2, 'targeted', 'red'],
      [3, 'targeted', 'green'],
    ],
  );
  // Cycle 1 proves everything; the reds take unit and shape, and build is not
  // runnable behind unit.
  assert.deepEqual(ranIn(1), ['unit', 'shape', 'quiet', 'build']);
  // Cycle 2 runs the two reds and build, which depends on one of them. The
  // green quiet layer no red points at carries forward, unrun.
  assert.deepEqual(ranIn(2), ['unit', 'shape', 'build']);
  const record2 = readRecord(fx.paths, runId, 2);
  assert.equal(record2.sweep, 'targeted');
  assert.ok(!record2.confirmation);
  assert.deepEqual(
    record2.spectrum.map((r) => [r.layer, r.status, r.mode]),
    [
      ['unit', 'green', 'run'],
      ['shape', 'red', 'run'],
      ['quiet', 'green', 'carried'],
      ['build', 'green', 'run'],
    ],
  );
  // The repair seat is told which greens it is reading are carried.
  const repair2 = fx.calls.find((c) => c.label === 'repair-dev-2');
  assert.ok(repair2.prompt.includes('- quiet: green (carried from an earlier cycle, not re-run)'));
  assert.ok(repair2.prompt.includes('- shape: red'));
  // Cycle 3 targets the last red alone, then confirms the carried greens at
  // this sha before the verdict turns green.
  assert.deepEqual(ranIn(3), ['shape', 'unit', 'quiet', 'build']);
  assert.deepEqual(
    events
      .filter((e) => e.event === 'layer-result' && e.cycle === 3 && e.confirmation)
      .map((e) => e.layer),
    ['unit', 'quiet', 'build'],
  );
  const record3 = readRecord(fx.paths, runId, 3);
  assert.equal(record3.sweep, 'targeted');
  assert.equal(record3.confirmation, true);
  assert.equal(record3.verdict, 'green');
  assert.deepEqual(
    record3.spectrum.map((r) => [r.layer, r.mode]),
    [
      ['unit', 'run'],
      ['shape', 'run'],
      ['quiet', 'run'],
      ['build', 'run'],
    ],
  );
});

// -- part-level targeting inside a layer (ADR-0046) ---------------------------

const PART_TABLE = [
  { name: 'alpha', file: 'src/alpha.txt', inputs: ['src/alpha.txt'] },
  { name: 'beta', file: 'src/beta.txt', inputs: ['src/beta.txt'] },
  { name: 'gamma', file: 'src/gamma.txt', inputs: ['src/gamma.txt'] },
];

/**
 * A gate command that runs in parts, honours the caller's narrowing, and
 * appends the parts it actually ran to a file outside the worktree — the
 * fixture's own record of what each invocation cost.
 */
function partsGate(logFile) {
  const body = [
    "const fs = require('fs');",
    `const table = ${JSON.stringify(PART_TABLE)};`,
    `const only = (process.env.${PARTS_ENV} || '').split(',').filter(Boolean);`,
    'const ran = [];',
    'let bad = 0;',
    'for (const part of table) {',
    '  if (only.length > 0 && !only.includes(part.name)) continue;',
    '  ran.push(part.name);',
    "  console.log('::olympus part ' + part.name);",
    "  console.log('::olympus part-inputs ' + part.inputs.join(' '));",
    "  const ok = fs.readFileSync(part.file, 'utf8').trim() === 'ok';",
    "  console.log(part.name + (ok ? ' passed' : ' failed'));",
    "  console.log('::olympus part-' + (ok ? 'ok' : 'failed') + ' ' + part.name);",
    '  if (!ok) bad = 1;',
    '}',
    `fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(ran) + '\\n');`,
    'process.exitCode = bad;',
  ].join('\n');
  return ['node', '-e', body];
}

/**
 * A triage behavior that raises one finding per failing PART, over the part
 * lines the red evidence carries. The layer stays red across both rounds, so
 * a layer-keyed triage would read a repair that fixed one part as a round
 * that closed nothing.
 */
function partTriageSeat() {
  return ({ prompt }) => {
    const failing = [...prompt.matchAll(/^ {2}part (.+):$/gm)].map((m) => m[1]);
    const prior = [...prompt.matchAll(/- \[(F\d+)\] \[[^\]]+\] broken part (\S+)/g)].map((m) => ({
      id: m[1],
      part: m[2],
    }));
    const persisting = prior.filter((p) => failing.includes(p.part));
    const covered = new Set(persisting.map((p) => p.part));
    return {
      report: {
        findings: failing
          .filter((part) => !covered.has(part))
          .map((part) => ({
            class: 'code-defect',
            layers: ['acceptance'],
            summary: `broken part ${part}`,
            evidence: `red output of part ${part}`,
          })),
        ...(prior.length > 0 && { persisting: persisting.map((p) => p.id) }),
        summary: 'triaged',
      },
    };
  };
}

/** One scenario: two seeded part reds, repaired one at a time. */
function partsScenario(t, { partTargeting, flakeRerun } = {}) {
  const root = tempDir('olympus-parts-lane-');
  t.after(() => removeDir(root));
  const logFile = join(root, 'parts.log');
  writeFileSync(logFile, '');
  const seats = {
    dev: () => ({
      files: {
        'src/feature.mjs': GOOD_FEATURE,
        'src/alpha.txt': 'bad\n',
        'src/beta.txt': 'ok\n',
        'src/gamma.txt': 'bad\n',
      },
      report: { summary: 'implemented' },
    }),
    'verdict-triage': partTriageSeat(),
    ...furyClean(),
    'repair-dev': ({ label }) =>
      label === 'repair-dev-1'
        ? { files: { 'src/alpha.txt': 'ok\n' }, report: { summary: 'fixed alpha' } }
        : { files: { 'src/gamma.txt': 'ok\n' }, report: { summary: 'fixed gamma' } },
    'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
  };
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'acceptance', command: 'acceptance' },
    ],
    commands: { suite: SUITE_CMD, acceptance: partsGate(logFile) },
    ...(partTargeting !== undefined && { partTargeting }),
    ...(flakeRerun !== undefined && { flakeRerun }),
  });
  return {
    fx,
    ran: () =>
      readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

test('a repair that reaches one part re-runs that part alone; the final cycle runs them all', async (t) => {
  const { fx, ran } = partsScenario(t);
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(
    events.filter((e) => e.event === 'verdict-rendered').map((e) => [e.cycle, e.sweep, e.verdict]),
    [
      [1, 'full', 'red'],
      [2, 'targeted', 'red'],
      [3, 'targeted', 'green'],
    ],
  );
  assert.deepEqual(ran(), [
    // Cycle 1 proves nothing yet, so every part runs. Two of them are red, so
    // the flake filter owes the layer one re-run — and that re-run buys the
    // two reds, because beta passed at this sha already.
    ['alpha', 'beta', 'gamma'],
    ['alpha', 'gamma'],
    // Cycle 2 judges a diff that touched src/alpha.txt alone. Beta's green is
    // out of that diff's reach and carries; the two reds re-run whatever the
    // diff says. Alpha passes and gamma does not, so the re-run buys gamma.
    ['alpha', 'gamma'],
    ['gamma'],
    // Cycle 3 judges a diff that touched src/gamma.txt alone.
    ['gamma'],
    // The cycle that turns green owes every part a proof at this sha. Gamma
    // has one already, so the sweep buys the two this cycle carried.
    ['alpha', 'beta'],
  ]);
  // The red record states the carry, so no green in it is silent, and every
  // part it ran says why it ran (ADR-0058). Both reds re-run whatever the diff
  // says, so both read `not-green` and neither reads `touched`.
  const record2 = readRecord(fx.paths, runId, 2);
  assert.deepEqual(
    record2.spectrum.find((r) => r.layer === 'acceptance').parts,
    [
      { name: 'gamma', status: 'red', mode: 'run', reason: 'not-green' },
      { name: 'alpha', status: 'green', mode: 'run', reason: 'not-green' },
      { name: 'beta', status: 'green', mode: 'carried', carriedFrom: 1 },
    ],
  );
  // The share of the cycle's part work the cycle did not do, on the record and
  // on the event the metric reads.
  assert.deepEqual(
    [record2.partsRun, record2.partsCarried, record2.carryShare],
    [2, 1, 0.333],
  );
  const render2 = events.find((e) => e.event === 'verdict-rendered' && e.cycle === 2);
  assert.deepEqual([render2.partsRun, render2.partsCarried, render2.carryShare], [2, 1, 0.333]);
  // The repair seat reads the same fact on the layer's own line.
  const repair2 = fx.calls.find((c) => c.label === 'repair-dev-2');
  assert.ok(
    repair2.prompt.includes('- acceptance: red (1 of 3 parts carried from cycle 1, not re-run)'),
    repair2.prompt,
  );
  // The green record rests on nothing carried: every part of it ran at this
  // sha, two in the sweep and one in the pass before it. The two the sweep
  // bought owe no reason — it derived no plan — and the one it kept holds the
  // reason of the pass that ran it.
  const record3 = readRecord(fx.paths, runId, 3);
  assert.equal(record3.verdict, 'green');
  assert.deepEqual(
    record3.spectrum
      .find((r) => r.layer === 'acceptance')
      .parts.map((p) => [p.name, p.mode, p.reason]),
    [
      ['alpha', 'run', undefined],
      ['beta', 'run', undefined],
      ['gamma', 'run', 'not-green'],
    ],
  );
  assert.deepEqual([record3.partsRun, record3.partsCarried, record3.carryShare], [3, 0, 0]);
  // What the sweep bought and what it stood on, as the number a tripwire reads
  // (ADR-0046). `ran` reaching the layer's whole part count is the reading that
  // says this narrowing has stopped working.
  assert.deepEqual(record3.confirmationParts, { ran: 2, kept: 1 });
  const render3 = events.find((e) => e.event === 'verdict-rendered' && e.cycle === 3);
  assert.deepEqual(render3.confirmationParts, { ran: 2, kept: 1 });
  // No part of the shipped record is carried, and the layer's own stamp says
  // the same: the sweep's re-run stands on nothing an older sha proved.
  const swept = events.filter(
    (e) => e.event === 'layer-result' && e.layer === 'acceptance' && e.confirmation,
  );
  assert.equal(swept.length, 1);
  assert.deepEqual(swept[0].parts.filter((p) => p.carriedFrom !== undefined), []);
});

test('a diff that touches a path no part claims re-runs every part', async (t) => {
  const root = tempDir('olympus-parts-blind-');
  t.after(() => removeDir(root));
  const logFile = join(root, 'parts.log');
  writeFileSync(logFile, '');
  const seats = {
    dev: () => ({
      files: {
        'src/feature.mjs': GOOD_FEATURE,
        'src/alpha.txt': 'bad\n',
        'src/beta.txt': 'ok\n',
        'src/gamma.txt': 'ok\n',
      },
      report: { summary: 'implemented' },
    }),
    'verdict-triage': triageSeat(() => ({ class: 'code-defect' })),
    ...furyClean(),
    // The repair reaches alpha, and a lockfile beside it. No part claims a
    // lockfile, so the narrowing that alpha alone would have earned is off.
    'repair-dev': () => ({
      files: { 'src/alpha.txt': 'ok\n', 'package-lock.json': 'two\n' },
      report: { summary: 'fixed alpha and re-locked' },
    }),
    'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
  };
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'acceptance', command: 'acceptance' },
    ],
    commands: { suite: SUITE_CMD, acceptance: partsGate(logFile) },
    originFiles: { 'package-lock.json': 'one\n' },
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const ran = readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(ran, [
    // Cycle 1, twice: the flake filter owes the red layer a re-run, and that
    // re-run buys the one part that failed.
    ['alpha', 'beta', 'gamma'],
    ['alpha'],
    // Cycle 2 narrows nothing, goes green, and carries nothing — so the
    // confirmation sweep has a full result at this sha already and re-runs
    // no layer at all.
    ['alpha', 'beta', 'gamma'],
  ]);
  const cycle2 = events.filter(
    (e) => e.event === 'layer-result' && e.cycle === 2 && e.layer === 'acceptance',
  );
  assert.deepEqual(cycle2.flatMap((e) => e.parts.filter((p) => p.carriedFrom !== undefined)), []);
  // The saving the lockfile cost is on the record, with the path that cost it
  // (ADR-0058). Before this the whole decision was silent.
  assert.deepEqual(cycle2.at(-1).blindPaths, ['package-lock.json']);
  assert.deepEqual(
    cycle2.at(-1).parts.map((p) => [p.name, p.reason]),
    [
      ['alpha', 'blind'],
      ['beta', 'blind'],
      ['gamma', 'blind'],
    ],
  );
  const render2 = events.find((e) => e.event === 'verdict-rendered' && e.cycle === 2);
  assert.deepEqual([render2.partsRun, render2.partsCarried, render2.carryShare], [3, 0, 0]);
});

test('gates.partTargeting false runs every layer whole, whatever its parts say', async (t) => {
  const { fx, ran } = partsScenario(t, { partTargeting: false });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The same three cycles, and every cycle pays for every part: nothing
  // carries, so the confirmation sweep has a full result at this sha and
  // re-runs no layer at all. The two short invocations are the flake filter's
  // own re-runs, which are a different switch and still ask only what failed.
  assert.deepEqual(
    ran().map((parts) => parts.length),
    [3, 2, 3, 1, 3],
  );
  assert.deepEqual(
    events
      .filter((e) => e.event === 'layer-result' && e.layer === 'acceptance')
      .flatMap((e) => (e.parts ?? []).filter((p) => p.carriedFrom !== undefined)),
    [],
  );
  // The seat brief drops the line with the mechanism it describes. (The gate
  // command's own argv is quoted in that brief and mentions the variable, so
  // the test reads the sentence and not the name.)
  const dev = fx.calls.find((c) => c.seat === 'dev');
  assert.ok(
    !dev.prompt.includes('Check your own work with the parts your diff can reach'),
    'the brief offered a narrowing nothing honours',
  );
});

test('gates.flakeRerun "whole" sends the re-run back over the layer', async (t) => {
  const { fx, ran } = partsScenario(t, { flakeRerun: 'whole' });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // Every re-run pays for the whole narrowing it was given, which is what the
  // filter did before this key existed. The cycle-to-cycle carry is a
  // different switch and still holds, and so is the sweep's own narrowing:
  // the last invocation buys the two parts cycle 3 carried.
  assert.deepEqual(
    ran().map((parts) => parts.length),
    [3, 3, 2, 2, 1, 2],
  );
  assert.deepEqual(
    events
      .filter((e) => e.event === 'layer-result' && e.layer === 'acceptance')
      .map((e) => e.narrowedTo),
    [undefined, undefined, undefined, undefined],
  );
});

test('the dev and repair briefs name the mapping the cycle uses', async (t) => {
  const { fx } = partsScenario(t);
  const { runId } = await fx.launch();
  await waitClosed(fx.paths, runId);
  for (const seat of ['dev', 'repair-dev']) {
    const prompt = fx.calls.find((c) => c.seat === seat).prompt;
    assert.match(prompt, new RegExp(`${PARTS_ENV}=<comma-separated part names>`), seat);
    assert.match(prompt, /a part is affected unless your diff falls entirely outside its input set/, seat);
    assert.match(prompt, /its own test sources and the source trees it exercises/, seat);
    assert.match(prompt, /A path no part claims \(a lockfile, a shared package, a migration, a config file\) reaches every part/, seat);
    assert.match(prompt, /The verdict proves every part of every layer at the sha it ships\./, seat);
  }
});

test('a red the confirmation sweep turns up enters triage like any other', async (t) => {
  const seats = {
    dev: () => ({
      files: { 'src/feature.mjs': BAD_FEATURE, 'src/extra.txt': 'bad\n', 'src/quiet.txt': 'ok\n' },
      report: { summary: 'implemented' },
    }),
    'verdict-triage': triageSeat(() => ({ class: 'code-defect' })),
    ...furyClean(),
    // The first repair clears both reds and breaks a layer no red pointed at.
    'repair-dev': ({ label }) =>
      label === 'repair-dev-1'
        ? {
            files: {
              'src/feature.mjs': GOOD_FEATURE,
              'src/extra.txt': 'ok\n',
              'src/quiet.txt': 'bad\n',
            },
            report: { summary: 'fixed the reds' },
          }
        : { files: { 'src/quiet.txt': 'ok\n' }, report: { summary: 'fixed the regression' } },
    'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
  };
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'extra', command: 'extra' },
      { name: 'quiet', command: 'quiet' },
    ],
    commands: {
      suite: SUITE_CMD,
      extra: markerCmd('src/extra.txt'),
      quiet: markerCmd('src/quiet.txt'),
    },
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // Cycle 2 targeted the two reds, found them green, and only then swept the
  // carried layer — which the repair had broken.
  const cycle2 = events.filter((e) => e.event === 'layer-result' && e.cycle === 2);
  assert.deepEqual(
    cycle2.map((e) => [e.layer, e.status, e.confirmation]),
    [
      ['unit', 'green', undefined],
      ['extra', 'green', undefined],
      ['quiet', 'red', true],
    ],
  );
  const record2 = readRecord(fx.paths, runId, 2);
  assert.equal(record2.confirmation, true);
  assert.equal(record2.verdict, 'red');
  // The regression is a first sight of a red: triage classed it, and the
  // ladder answered with a repair round like any other.
  const regression = events.filter((e) => e.event === 'finding' && e.cycle === 2);
  assert.equal(regression.length, 1);
  assert.equal(regression[0].class, 'code-defect');
  assert.deepEqual(regression[0].layers, ['quiet']);
  assert.equal(fx.calls.filter((c) => c.seat === 'verdict-triage').length, 2);
  assert.equal(events.filter((e) => e.event === 'repair-round').length, 2);
  assert.ok(!events.some((e) => e.event === 'stall'));
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.deepEqual(
    renders.map((e) => [e.cycle, e.verdict]),
    [
      [1, 'red'],
      [2, 'red'],
      [3, 'green'],
    ],
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
  // A re-freeze cycle targets like any other: the suite layer the defect made
  // red, and build behind it. The lint layer carried until the confirmation.
  assert.equal(renders[1].sweep, 'targeted');
  assert.equal(renders[1].confirmation, true);
  const record = readRecord(fx.paths, runId, 2);
  assert.deepEqual(
    record.findings.map((f) => [f.id, f.status]),
    [[finding.id, 'resolved']],
  );
});

test('spec-deep and intent-deep suite defects amend the spec; the intent conflict parks first', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': ({ prompt }) => ({
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
        ...(prompt.includes('Prior open findings') && { persisting: [] }),
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
  // The ruling named no frozen test, so the suite arm ran as it always did:
  // the amendment is recorded, and it was owed no file.
  assert.deepEqual(refreeze.ruling.files, []);
  const refrozen = fx.calls.find((c) => c.seat === 'suite');
  assert.ok(!refrozen.prompt.includes('The ruling names these frozen test files'));
});

test('an intent ruling that names a frozen test reaches the suite, once, on the record', async (t) => {
  // The conflict of a real run: the story's criterion needs a second export,
  // an earlier story's frozen pin says the set is closed, and no
  // implementation satisfies both. The owner rules for the extension and
  // names the file; the amendment is the only place that ruling can land.
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': PAIR_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': ({ prompt }) => ({
      report: {
        findings: [
          {
            class: 'suite-defect',
            depth: 'intent',
            layers: ['unit'],
            summary: 'the frozen pin closes the export set the criterion extends',
            evidence: 'tests/pinned.test.mjs pins the set closed',
          },
        ],
        ...(prompt.includes('Prior open findings') && { persisting: [] }),
        summary: 'triaged',
      },
    }),
    ...furyClean(),
    'spec-birth': () => ({ report: { amendedSections: ['AC-1'], summary: 'amended' } }),
    suite: ({ prompt }) =>
      // The first pass amends everything but the file the ruling names. The
      // check is what sends it back, so the ruling cannot be answered with a
      // report about some other file.
      prompt.includes('Correction brief')
        ? {
            files: { 'tests/pinned.test.mjs': PINNED_EXTENDED },
            report: {
              suiteFiles: ['tests/pinned.test.mjs'],
              reds: [],
              summary: 'the pin now admits the extension',
            },
          }
        : {
            files: { 'tests/pair.test.mjs': PAIR_TEST },
            report: { suiteFiles: ['tests/pair.test.mjs'], reds: [], summary: 'nothing amended' },
          },
  };
  const fx = verdictFixture(t, {
    seats,
    suiteFiles: { 'tests/pair.test.mjs': PAIR_TEST, 'tests/pinned.test.mjs': PINNED_CLOSED },
  });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'intent-conflict');
  assert.ok(park.answers.text.includes('Name the frozen test file'), park.answers.text);
  fx.daemon.engine.answer({
    runId,
    actor: 'operator',
    answer:
      'AC-1 supersedes the closed export set. Amend tests/pinned.test.mjs to admit g as a ' +
      'deliberate extension; the pin stays closed otherwise.',
  });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The ruling reached the suite seat, naming the file it names.
  const refreezes = fx.calls.filter((c) => c.seat === 'suite');
  assert.equal(refreezes.length, 2);
  assert.ok(refreezes[0].prompt.includes('The ruling is the authority for this amendment'));
  assert.ok(refreezes[0].prompt.includes('- tests/pinned.test.mjs'));
  // A pass that left the named file alone is a work-product defect, by name.
  assert.match(
    refreezes[1].prompt,
    /the answered intent ruling names the frozen test tests\/pinned\.test\.mjs and it is unchanged/,
  );
  // One re-freeze, carrying the ruling, on the record.
  const refreeze = events.filter((e) => e.event === 're-freeze');
  assert.equal(refreeze.length, 1);
  assert.equal(refreeze[0].ruling.park, park.seq);
  assert.equal(refreeze[0].ruling.actor, 'operator');
  assert.deepEqual(refreeze[0].ruling.files, ['tests/pinned.test.mjs']);
  // And the next verdict found the conflict closed: one park, never a second.
  assert.equal(events.filter((e) => e.event === 'park' && e.type === 'intent-conflict').length, 1);
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.deepEqual(
    renders.map((e) => [e.cycle, e.verdict]),
    [
      [1, 'red'],
      [2, 'green'],
    ],
  );
  assert.equal(renders[1].suiteSha, refreeze[0].sha);
});

test('an operational fix does not swallow the re-freeze the ladder still owes', async (t) => {
  // The two arms of one ladder pass: the env finding stamps its fix, and the
  // suite arm behind it parks. The stamp alone would earn the next cycle, and
  // the suite would go into it unamended — the same red, the same finding, the
  // same park, forever. The owed amendment wins instead.
  const marker = join(tempDir('olympus-refreeze-'), 'ext-marker.txt');
  t.after(() => removeDir(dirname(marker)));
  writeFileSync(marker, 'no\n');
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': triageSeat((layer) =>
      layer === 'ext' ? { class: 'env' } : { class: 'suite-defect', depth: 'test' },
    ),
    ...furyClean(),
    // Two refusals spend the arm's invocation and its corrective round, and the
    // park lands with the suite still unamended. The pass the retry buys writes
    // the amendment, and the marker with it.
    suite: refusesTwice(),
  };
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'ext', command: 'ext' },
    ],
    commands: { suite: SUITE_CMD, ext: markerCmd('tests/marker.txt') },
    suiteFiles: { 'tests/feature.test.mjs': WRONG_TEST, 'tests/marker.txt': 'no\n' },
  });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'seat-failure');
  assert.equal(park.detail.seat, 'suite');
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'retry' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  const refreeze = events.find((e) => e.event === 're-freeze');
  // The amendment landed before the cycle the operational fix earned.
  assert.ok(refreeze, 'the ladder never re-freezes');
  assert.ok(refreeze.seq < renders[1].seq);
  assert.equal(renders[1].suiteSha, refreeze.sha);
  // The fix the first pass stamped stands: it is not re-taken, and the gate it
  // would otherwise persist into is never raised.
  assert.equal(events.filter((e) => e.event === 'operational-fix').length, 1);
  assert.ok(!events.some((e) => e.event === 'park' && e.type === 'provisioning-gate'));
  assert.deepEqual(
    renders.map((e) => [e.cycle, e.verdict]),
    [
      [1, 'red'],
      [2, 'green'],
    ],
  );
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

// -- the substrate probe (ADR-0022) ------------------------------------------

/** A loopback port with a listener that answers, and one with nothing. */
function livePort(t) {
  const server = createServer((socket) => socket.on('data', () => socket.write('ok\n')));
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve(server.address().port);
    });
  });
}

function deadPort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * The stack tool of a fixture host: it answers `ps` with one published port —
 * the dead one until the operator's marker appears, the live one after — and
 * every other compose verb with silence.
 */
function composeStub({ marker, dead, live }) {
  return [
    'node',
    '-e',
    `const fs=require('fs');const port=fs.existsSync(${JSON.stringify(marker)})?${live}:${dead};` +
      "if(process.argv.includes('ps'))console.log(JSON.stringify([{Service:'app'," +
      "Publishers:[{PublishedPort:port,Protocol:'tcp'}]}]));",
    // Everything the harness appends is this script's argument, never node's.
    '--',
  ];
}

test('an env finding probes the substrate before it spends a layer re-run on it', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': triageSeat(() => ({ class: 'env' })),
    ...furyClean(),
  };
  const root = tempDir();
  t.after(() => removeDir(root));
  const repaired = join(root, 'substrate-repaired');
  const ext = ['node', '-e', "process.exit(require('fs').existsSync('../env-broken')?1:0)"];
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'ext', command: 'ext' },
    ],
    commands: { suite: SUITE_CMD, ext },
    stack: { composeFile: 'compose.yml' },
    composeCommand: composeStub({
      marker: repaired,
      dead: await deadPort(),
      live: await livePort(t),
    }),
    seedExtra: async (ctx, worktree) => {
      writeFileSync(join(worktree, '..', 'env-broken'), 'x');
    },
  });
  const { runId, worktree } = await fx.launch();

  // The gate parks on the probe, and it parks before the fix it guards: no
  // operational fix is stamped and no second cycle runs a layer.
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  assert.ok(park.question.includes('The substrate probe answered no'));
  assert.ok(park.question.includes('no loopback family accepted a connection'));
  let events = readEvents(runLedgerPath(fx.paths, runId));
  const probe = events.find((e) => e.event === 'substrate-probe');
  assert.equal(probe.state, 'failed');
  assert.equal(probe.failures[0].reason, 'unreachable');
  assert.ok(!events.some((e) => e.event === 'operational-fix'));
  assert.ok(!events.some((e) => e.event === 'layer-started' && e.cycle === 2));

  // The operator repairs the host and the layer's own defect, then answers.
  writeFileSync(repaired, 'x');
  rmSync(join(worktree, '..', 'env-broken'));
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'restarted the host relay' });
  events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const probes = events.filter((e) => e.event === 'substrate-probe');
  assert.deepEqual(probes.map((e) => e.state), ['failed', 'clean']);
  // The fix, and the cycle behind it, came after the clean probe and only
  // after it.
  const fix = events.find((e) => e.event === 'operational-fix');
  assert.ok(fix.seq > probes[1].seq);
  const rerun = events.find((e) => e.event === 'layer-started' && e.cycle === 2 && e.layer === 'ext');
  assert.ok(rerun.seq > fix.seq);
});

test('a harness finding leaves the substrate alone: the probe asks on env findings', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': triageSeat(() => ({ class: 'harness' })),
    ...furyClean(),
  };
  const root = tempDir();
  t.after(() => removeDir(root));
  const hlayer = decayingLayer('hcount-probe', 2);
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'hlayer', command: 'hlayer' },
    ],
    commands: { suite: SUITE_CMD, hlayer },
    stack: { composeFile: 'compose.yml' },
    composeCommand: composeStub({
      marker: join(root, 'never-written'),
      dead: await deadPort(),
      live: 1,
    }),
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // A dead port would have parked an env finding; the harness route never asks.
  assert.ok(!events.some((e) => e.event === 'substrate-probe'));
  assert.equal(events.filter((e) => e.event === 'operational-fix').length, 1);
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

// -- acknowledged harness findings (ADR-0032) --------------------------------

/** A layer red for its first `redRuns` invocations, green after. */
function decayingLayer(marker, redRuns) {
  return [
    'node',
    '-e',
    `const fs=require('fs');const p=${JSON.stringify(`../${marker}`)};` +
      "const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));" +
      `process.exit(n>=${redRuns}?0:1);`,
  ];
}

/** The triage fixture's finding for one layer, as the ledger rebuilds it. */
function layerFinding(cls, layer) {
  return {
    class: cls,
    layers: [layer],
    summary: `broken ${layer}`,
    evidence: `red output of ${layer}`,
  };
}

/** The identity the gate offers for that finding, and keys its ack on. */
function layerFingerprint(cls, layer) {
  return ackFingerprint(layerFinding(cls, layer));
}

/** Records one standing ack, as a prior run's answered gate left it. */
function seedAck(paths, { project, fingerprint, actor = 'operator' }) {
  const ledger = new Ledger(paths.instanceLedger, { allowedEvents: INSTANCE_EVENTS });
  ledger.append('finding-ack', {
    actor,
    project,
    fingerprint,
    class: 'harness',
    summary: 'a known harness defect',
  });
  ledger.close();
}

/** The console path for an answer: the inbox, claimed by the daemon. */
async function answerFromConsole(fx, command) {
  writeControlCommand(fx.paths, { actor: 'operator', ...command });
  await fx.daemon.drainControlInbox();
}

test('a harness gate answered "ack" records the finding, and the next gate answers itself', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': triageSeat(() => ({ class: 'harness' })),
    ...furyClean(),
  };
  // Red through three cycles of two runs each: cycle 1 earns the operational
  // fix, cycle 2 parks the gate, cycle 3 meets the ack the answer recorded.
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'hlayer', command: 'hlayer' },
    ],
    commands: { suite: SUITE_CMD, hlayer: decayingLayer('hcount', 6) },
  });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  // The gate names the option and the identity the option records.
  assert.deepEqual(park.answers.options, ['retry', 'ack', 'abandon']);
  const fingerprint = layerFingerprint('harness', 'hlayer');
  assert.deepEqual(park.acks, [
    { fingerprint, class: 'harness', summary: 'broken hlayer' },
  ]);
  assert.ok(park.question.includes(fingerprint));
  assert.ok(park.question.includes('known and deferred'));

  await answerFromConsole(fx, { command: 'answer', runId, option: 'ack' });
  const instance = readEvents(fx.paths.instanceLedger);
  const ack = instance.find((e) => e.event === 'finding-ack');
  assert.equal(ack.project, 'proj');
  assert.equal(ack.fingerprint, fingerprint);
  assert.equal(ack.actor, 'operator');
  assert.equal(ack.runId, runId);
  assert.equal(ack.parkSeq, park.seq);

  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The first gate reached the human; the repeat did not park at all.
  assert.equal(events.filter((e) => e.event === 'park' && e.type === 'provisioning-gate').length, 1);
  const used = events.find((e) => e.event === 'finding-ack-used');
  assert.deepEqual(used.findings, ['F1']);
  assert.deepEqual(used.acks, [
    { finding: 'F1', fingerprint, ackSeq: ack.seq, ackedBy: 'operator' },
  ]);
  // Nothing silent: the fix says what answered it.
  const fixes = events.filter((e) => e.event === 'operational-fix');
  assert.deepEqual(
    fixes.map((e) => e.source ?? null),
    [null, 'answer', 'ack'],
  );
  assert.deepEqual(fixes.at(-1).acks, [fingerprint]);
});

test('an ack from an earlier run answers this run\'s gate, and a revoke parks it again', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': triageSeat(() => ({ class: 'harness' })),
    ...furyClean(),
  };
  const gates = [
    { name: 'unit', command: 'suite' },
    { name: 'hlayer', command: 'hlayer' },
  ];
  const fingerprint = layerFingerprint('harness', 'hlayer');
  const other = layerFingerprint('harness', 'somewhere-else');

  // The ack outlives the run that recorded it: this daemon never saw that run,
  // and it never parks the gate.
  const acked = verdictFixture(t, { seats, gates, commands: { suite: SUITE_CMD, hlayer: decayingLayer('hcount', 4) } });
  seedAck(acked.paths, { project: 'proj', fingerprint });
  seedAck(acked.paths, { project: 'proj', fingerprint: other });
  const first = await acked.launch();
  let events = await waitClosed(acked.paths, first.runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'park'));
  assert.equal(events.find((e) => e.event === 'finding-ack-used').acks[0].fingerprint, fingerprint);

  // A revoke ends the one fingerprint it names. The ack beside it still
  // stands, and the gate it covers nothing for parks like any other.
  const revoked = verdictFixture(t, { seats, gates, commands: { suite: SUITE_CMD, hlayer: decayingLayer('hcount', 4) } });
  seedAck(revoked.paths, { project: 'proj', fingerprint });
  seedAck(revoked.paths, { project: 'proj', fingerprint: other });
  const second = await revoked.launch();
  revoked.daemon.revokeAck({
    actor: 'operator',
    project: 'proj',
    fingerprint,
    fix: 'harness abc1234: the triage capture armed',
  });
  const park = await waitParked(revoked.paths, second.runId, 'provisioning-gate');
  assert.ok(park.question.includes(fingerprint));
  const standing = standingAcksFor(revoked.paths, 'proj');
  assert.deepEqual([...standing.keys()], [other]);
  revoked.daemon.engine.answer({ runId: second.runId, actor: 'operator', option: 'retry' });
  events = await waitClosed(revoked.paths, second.runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
});

test('an ack of one wording answers the same defect described differently', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': triageSeat(() => ({ class: 'harness' })),
    ...furyClean(),
  };
  // The acknowledgment was earned by a sentence no seat in this run will
  // write: another operator, another run, another half of the explanation.
  // The defect is the machinery behind one gate layer, and that is the key.
  const fingerprint = ackFingerprint({
    class: 'harness',
    layers: ['hlayer'],
    summary: 'the hlayer gate command reads a marker the host rotates under it',
    evidence: 'seq 118 of a run on another host, months ago',
  });
  assert.equal(fingerprint, layerFingerprint('harness', 'hlayer'));
  assert.notEqual(fingerprint, findingFingerprint(layerFinding('harness', 'hlayer')));
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'hlayer', command: 'hlayer' },
    ],
    commands: { suite: SUITE_CMD, hlayer: decayingLayer('hcount', 4) },
  });
  seedAck(fx.paths, { project: 'proj', fingerprint });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // No gate reached the human, and the record says whose authority answered it.
  assert.ok(!events.some((e) => e.event === 'park'));
  assert.equal(events.find((e) => e.event === 'finding-ack-used').acks[0].fingerprint, fingerprint);
});

test('an ack recorded under a prose fingerprint still answers its gate', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': triageSeat(() => ({ class: 'harness' })),
    ...furyClean(),
  };
  // What every acknowledgment on an instance was keyed on before the identity
  // existed. The harness learned a better key; it did not learn that the
  // defect behind this one was fixed.
  const words = findingFingerprint(layerFinding('harness', 'hlayer'));
  assert.notEqual(words, layerFingerprint('harness', 'hlayer'));
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'hlayer', command: 'hlayer' },
    ],
    commands: { suite: SUITE_CMD, hlayer: decayingLayer('hcount', 4) },
  });
  seedAck(fx.paths, { project: 'proj', fingerprint: words });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'park'));
  // The fingerprint it was recorded under is the one the record names, which
  // is the one a revoke will have to name.
  assert.equal(events.find((e) => e.event === 'finding-ack-used').acks[0].fingerprint, words);
});

test('a gate mixing an acked harness finding with an env one parks all the same', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': triageSeat((layer) => ({ class: layer === 'hlayer' ? 'harness' : 'env' })),
    ...furyClean(),
  };
  const fx = verdictFixture(t, {
    seats,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'hlayer', command: 'hlayer' },
      { name: 'elayer', command: 'elayer' },
    ],
    commands: {
      suite: SUITE_CMD,
      hlayer: decayingLayer('hcount', 6),
      elayer: ['node', '-e', "process.exit(require('fs').existsSync('../env-broken')?1:0)"],
    },
    seedExtra: async (ctx, worktree) => {
      writeFileSync(join(worktree, '..', 'env-broken'), 'x');
    },
  });
  const { runId, worktree } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  // Only the harness finding is offered: an ack never covers the substrate.
  assert.deepEqual(park.acks.map((a) => a.class), ['harness']);
  assert.ok(park.question.includes('[env]'));
  await answerFromConsole(fx, { command: 'answer', runId, option: 'ack' });
  assert.equal(readEvents(fx.paths.instanceLedger).filter((e) => e.event === 'finding-ack').length, 1);

  // The env finding is uncovered, so the gate reaches the human again.
  const second = await waitFor(
    () => {
      const parks = readEvents(runLedgerPath(fx.paths, runId)).filter(
        (e) => e.event === 'park' && e.type === 'provisioning-gate',
      );
      return parks.length > 1 ? parks[1] : null;
    },
    { label: 'the second provisioning gate', attempts: 600, intervalMs: 100 },
  );
  assert.ok(second.question.includes('[env]'));
  rmSync(join(worktree, '..', 'env-broken'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'retry' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'finding-ack-used'));
});

// The security lens has no seat of its own, and a security defect on the
// candidate still blocks the ship: the operational seat carries the lens, and a
// confirmed HIGH under it takes the code arm like any other.
test('confirm-to-block: only verifier-confirmed HIGHs enter the verdict, and a candidate security defect is one', async (t) => {
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
          { lens: 'security', severity: 'HIGH', finding: 'injection risk in query', evidence: 'src/feature.mjs:1' },
        ],
        summary: 'two',
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
  // The UI diff pulled the conditional interface seat in; no seat carried the
  // security lens alone.
  assert.equal(fx.calls.filter((c) => c.seat === 'fury-interface').length, 1);
  assert.ok(!fx.calls.some((c) => c.seat === 'fury-security'), 'a standalone security seat fired');
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

// The cut is a config flip and not a deletion. A project that wants the two
// lenses back names them, and the seat that carries them returns with its
// blocking route intact.
test('a project that names the cut lenses gets the code-shape seat back, and it blocks', async (t) => {
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
      item.mode === 'confirm' ? { verdict: 'confirmed' } : { verdict: 'resolved' },
    ),
    'repair-dev': () => ({ report: { summary: 'moved' } }),
    'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
  };
  const fx = verdictFixture(t, {
    seats,
    review: {
      lenses: ['spec', 'architecture', 'minimality', 'operational', 'security', 'interface'],
    },
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The restored seat fired once, with both of its lenses.
  const codeShape = fx.calls.filter((c) => c.seat === 'fury-code-shape');
  assert.equal(codeShape.length, 1);
  assert.ok(codeShape[0].prompt.includes('- architecture: placement, coupling'));
  assert.ok(codeShape[0].prompt.includes('- minimality: reinvention'));
  // Its HIGH blocked cycle 1; the repair round closed it.
  const confirmed = events.find((e) => e.event === 'finding' && e.lens === 'architecture');
  assert.equal(confirmed.confirmed, true);
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.deepEqual(renders[0].open, [confirmed.id]);
  assert.equal(renders[1].verdict, 'green');
  assert.equal(events.filter((e) => e.event === 'repair-round').length, 1);
  // The generalist seat of the repair cycle carries the restored set too.
  const generalist = fx.calls.find((c) => c.seat === 'generalist-review').prompt;
  assert.ok(generalist.includes('- architecture: placement, coupling'));
  assert.ok(generalist.includes('- minimality: reinvention'));
});

test('stall → fresh pass → second stall parks; abandon closes the run', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
    ...furyClean(),
    'fury-spec': () => ({
      report: {
        findings: [
          { lens: 'spec', severity: 'HIGH', finding: 'the criterion is unimplemented', evidence: 'src/feature.mjs:1' },
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
  assert.deepEqual(park.answers.options, ['repair-again', 'fresh-pass', 'abandon']);
  assert.ok(park.question.includes('stalled again'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
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
    fx.calls.filter((c) => c.seat === 'fury-spec').map((c) => c.label),
    ['fury-spec-c1', 'fury-spec-c3'],
  );
  // No layer was ever red, so a repair cycle targets nothing and every green
  // carries. An open finding holds the confirmation sweep back: nothing is
  // about to be called green.
  const record2 = readRecord(fx.paths, runId, 2);
  assert.equal(record2.sweep, 'targeted');
  assert.ok(!record2.confirmation);
  assert.deepEqual(
    record2.spectrum.map((r) => r.mode),
    ['carried', 'carried', 'carried'],
  );
  assert.ok(!events.some((e) => e.event === 'layer-result' && e.cycle === 2));
  // The fresh pass judges a tree the run has never seen: full spectrum.
  const record3 = readRecord(fx.paths, runId, 3);
  assert.equal(record3.sweep, 'full');
  assert.deepEqual(
    record3.spectrum.map((r) => r.mode),
    ['run', 'run', 'run'],
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
    'verdict-triage': ({ prompt }) => ({
      report: {
        findings: [
          { class: 'code-defect', layers: ['ghost'], summary: 'broken ghost', evidence: 'none' },
        ],
        ...(prompt.includes('Prior open findings') && { persisting: [] }),
        summary: 'triaged',
      },
    }),
    ...furyClean(),
  };
  const fx = verdictFixture(t, { seats, gates: [{ name: 'unit', command: 'suite' }] });
  const { runId } = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'seat-failure');
  assert.deepEqual(park.answers.options, ['retry', 'abandon']);
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
  assert.deepEqual(park.answers.options, ['retry', 'abandon']);
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
          { lens: 'operational', severity: 'LOW', finding: 'no failure path', evidence: 'src/g.mjs:1' },
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
  assert.equal(record.sweep, 'full');
  // What the layer cost the machine rides the record too (ADR-0045) and is
  // asserted where it belongs; this is about what the spectrum decided.
  assert.deepEqual(
    record.spectrum.map(({ resources, exhaustion, ...decision }) => decision),
    [{ layer: 'unit', status: 'green', mode: 'run' }],
  );
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

// The class that quiets a take-back, declared per lane beside the tiers. The
// tiers are absent here on purpose: quieting a take-back turns no policing on.
const RECAPTURE_POLICY = { story: { recapturablePaths: ['**/__screenshots__/**'] } };

const SHOT = 'tests/visual/__screenshots__/checkout.png';

// A freeze that holds a visual baseline. The baseline is committed work: a
// write to it is a take-back whatever directory it sits in, and the sweep —
// which is about files the freeze never held — must not reach it.
const FROZEN_BASELINE = {
  'tests/feature.test.mjs': STRONG_TEST,
  [SHOT]: 'committed-baseline-bytes\n',
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
  assert.deepEqual(park.answers.options, ['retry', 'abandon']);
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

test('a take-back is stamped and the capture commits the allowed set anyway', async (t) => {
  // No diffPolicy block at all: the take-back record is not a policy tier, it
  // is the capture refusing to discard a seat's work in silence. The seat is
  // invoked once — a frozen path is not a defect it can answer.
  const seats = {
    dev: ({ label }) =>
      label === 'dev-1'
        ? {
            files: { 'src/feature.mjs': GOOD_FEATURE, 'tests/feature.test.mjs': WRONG_TEST },
            report: { summary: 'implemented, and I relaxed the test' },
          }
        : { report: { summary: 'a second invocation the take-back must not buy' } },
    ...furyClean(),
  };
  const fx = verdictFixture(t, { seats });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const stamp = events.find((e) => e.event === 'diff-policy-violation');
  assert.deepEqual(stamp.dropped, ['tests/feature.test.mjs']);
  assert.deepEqual(stamp.violations, []);
  assert.equal(stamp.kind, 'capture-takeback');
  assert.match(stamp.gist, /1 frozen path\(s\) the capture reverted/);
  // No corrective invocation, no park, and the allowed half of the tree is
  // committed: the run walks straight into the verdict.
  assert.equal(fx.calls.filter((c) => c.seat === 'dev').length, 1);
  assert.ok(!events.some((e) => e.event === 'seat-failure'));
  assert.ok(!events.some((e) => e.event === 'park'));
  const commit = events.find((e) => e.event === 'implementation-committed');
  assert.deepEqual(commit.dropped, ['tests/feature.test.mjs']);
  // The frozen suite is what was judged. The seat's relaxed test expects
  // f(2) === 5 against a feature that doubles, so a candidate carrying it
  // would have gone red on the unit layer instead of shipping in one cycle.
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.deepEqual(
    renders.map((e) => [e.cycle, e.verdict]),
    [[1, 'green']],
  );
  assert.deepEqual(renders[0].dropped, ['tests/feature.test.mjs']);
  assert.deepEqual(readRecord(fx.paths, runId, 1).dropped, ['tests/feature.test.mjs']);
  // Loud until the run ends, then paired — the same close the budget threshold
  // takes, because neither asks the owner for a decision.
  const resolution = events.find((e) => e.event === 'resolved' && e.resolves === stamp.seq);
  assert.equal(resolution.resolvedEvent, 'diff-policy-violation');
  assert.ok(events.indexOf(resolution) > events.findIndex((e) => e.event === 'verdict-rendered'));
  assert.equal(loudFor(fx.paths, runId, 'diff-policy-violation').length, 0);
});

test('a re-capturable take-back stamps quiet, and stamps no loud record at all', async (t) => {
  // The live shape this class exists for: a seat re-renders a surface, the
  // visual baseline under it is re-taken, and the capture reverts the write.
  // The verdict's re-freeze already owns that artifact, so the record is a
  // record — not a loud item the owner has to read and dismiss.
  const seats = {
    dev: ({ label }) =>
      label === 'dev-1'
        ? {
            files: { 'src/feature.mjs': GOOD_FEATURE, [SHOT]: 're-rendered-bytes\n' },
            report: { summary: 'implemented, and the surface re-rendered' },
          }
        : { report: { summary: 'a second invocation the take-back must not buy' } },
    ...furyClean(),
  };
  const fx = verdictFixture(t, {
    seats,
    diffPolicy: RECAPTURE_POLICY,
    suiteFiles: FROZEN_BASELINE,
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const quiet = events.find((e) => e.event === 'diff-policy-recapture');
  assert.equal(quiet.seat, 'dev');
  assert.equal(quiet.lane, 'story');
  assert.equal(quiet.kind, 'capture-takeback');
  assert.deepEqual(quiet.recaptured, [{ path: SHOT, pattern: '**/__screenshots__/**' }]);
  assert.match(quiet.recapturedLines[0], /a re-capturable frozen path/);
  assert.match(quiet.note, /a record and not an open item/);
  // Nothing loud was stamped, so there is nothing to resolve and nothing the
  // loud strip ever carried.
  assert.ok(!events.some((e) => e.event === 'diff-policy-violation'));
  assert.ok(!events.some((e) => e.event === 'resolved'));
  assert.equal(openLoud(fx.paths).filter((i) => i.ledger === `run:${runId}`).length, 0);
  // Everything else about a take-back is unchanged: one seat invocation, no
  // park, the allowed set committed, and the loss stated to every later stage.
  assert.equal(fx.calls.filter((c) => c.seat === 'dev').length, 1);
  assert.ok(!events.some((e) => e.event === 'park'));
  const commit = events.find((e) => e.event === 'implementation-committed');
  assert.deepEqual(commit.dropped, [SHOT]);
  assert.deepEqual(readRecord(fx.paths, runId, 1).dropped, [SHOT]);
});

test('the class quiets only what it names: an undeclared frozen path stays loud', async (t) => {
  const seats = {
    dev: ({ label }) =>
      label === 'dev-1'
        ? {
            files: {
              'src/feature.mjs': GOOD_FEATURE,
              [SHOT]: 're-rendered-bytes\n',
              'tests/feature.test.mjs': WRONG_TEST,
            },
            report: { summary: 'implemented, and I relaxed the test' },
          }
        : { report: { summary: 'a second invocation the take-back must not buy' } },
    ...furyClean(),
  };
  const fx = verdictFixture(t, {
    seats,
    diffPolicy: RECAPTURE_POLICY,
    suiteFiles: FROZEN_BASELINE,
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // One take-back per class, and the loud record carries only its own. Both
  // carry the closed word for the defect: the class decides the loudness, and
  // the word is the same defect either way.
  const quiet = events.find((e) => e.event === 'diff-policy-recapture');
  assert.deepEqual(quiet.recaptured.map((r) => r.path), [SHOT]);
  assert.equal(quiet.kind, 'capture-takeback');
  const loud = events.find((e) => e.event === 'diff-policy-violation');
  assert.deepEqual(loud.dropped, ['tests/feature.test.mjs']);
  assert.deepEqual(loud.violations, []);
  assert.equal(loud.kind, 'capture-takeback');
  assert.match(loud.droppedLines[0], /this path is frozen for this lane/);
  // The commit and the verdict record judge one tree, so they carry both.
  const commit = events.find((e) => e.event === 'implementation-committed');
  assert.deepEqual([...commit.dropped].sort(), ['tests/feature.test.mjs', SHOT]);
  assert.deepEqual(readRecord(fx.paths, runId, 1).dropped, commit.dropped);
});

test('a red cycle writes a screenshot the freeze never held: swept, not taken back', async (t) => {
  // The live shape: a browser-mode runner drops one PNG per failing test into
  // the screenshot directory beside the frozen suite. Nothing authored those
  // files, so reverting them takes nothing back — and every verdict of the run
  // used to haul the list to the next seat.
  const seats = {
    dev: ({ label }) =>
      label === 'dev-1'
        ? {
            files: {
              'src/feature.mjs': GOOD_FEATURE,
              [SHOT]: 'failure-shot\n',
              'tests/visual/__screenshots__/cart.png': 'failure-shot\n',
            },
            report: { summary: 'implemented; the red cycle left its screenshots' },
          }
        : { report: { summary: 'a second invocation nothing here buys' } },
    ...furyClean(),
  };
  const fx = verdictFixture(t, { seats, diffPolicy: RECAPTURE_POLICY });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const swept = events.find((e) => e.event === 'capture-swept');
  assert.equal(swept.seat, 'dev');
  assert.equal(swept.lane, 'story');
  assert.deepEqual([...swept.swept].sort(), ['tests/visual/__screenshots__/cart.png', SHOT]);
  assert.match(swept.note, /Generated artifacts cleared from frozen paths/);
  assert.match(swept.gist, /2 generated file\(s\)/);
  // No take-back record of either class, and nothing downstream is told to
  // reason about paths that never held anybody's work.
  assert.ok(!events.some((e) => e.event === 'diff-policy-violation'));
  assert.ok(!events.some((e) => e.event === 'diff-policy-recapture'));
  assert.equal(events.find((e) => e.event === 'implementation-committed').dropped, undefined);
  assert.equal(readRecord(fx.paths, runId, 1).dropped, undefined);
  assert.equal(openLoud(fx.paths).filter((i) => i.ledger === `run:${runId}`).length, 0);
  // The files are gone from the tree either way: the restore that reverts the
  // frozen paths is what removes them, and the sweep only decides the record.
  assert.equal(fx.calls.filter((c) => c.seat === 'dev').length, 1);
  assert.ok(!events.some((e) => e.event === 'park'));
});

test('the sweep reaches nothing outside the frozen paths, and no capture without one', async (t) => {
  // A generated file the seat wrote into its own area is the seat's change and
  // the diff policy judges it like any other. Nothing here is frozen, so the
  // capture has no take-back to sweep and stamps no sweep record.
  const seats = {
    dev: () => ({
      files: {
        'src/feature.mjs': GOOD_FEATURE,
        'src/visual/__screenshots__/hero.png': 'generated\n',
      },
      report: { summary: 'implemented' },
    }),
    ...furyClean(),
  };
  const fx = verdictFixture(t, { seats, diffPolicy: RECAPTURE_POLICY });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'capture-swept'));
  assert.ok(!events.some((e) => e.event === 'diff-policy-violation'));
  assert.equal(events.find((e) => e.event === 'implementation-committed').dropped, undefined);
});

test('a lane that declares an empty swept list keeps every take-back it had', async (t) => {
  // The reversal: `sweptPaths: []` turns the sweep off for the lane, and a
  // generated file under a frozen path is a take-back again, in whichever
  // class the tiers put it.
  const seats = {
    dev: ({ label }) =>
      label === 'dev-1'
        ? {
            files: { 'src/feature.mjs': GOOD_FEATURE, [SHOT]: 'failure-shot\n' },
            report: { summary: 'implemented; the red cycle left its screenshot' },
          }
        : { report: { summary: 'a second invocation nothing here buys' } },
    ...furyClean(),
  };
  const fx = verdictFixture(t, {
    seats,
    diffPolicy: { story: { recapturablePaths: ['**/__screenshots__/**'], sweptPaths: [] } },
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'capture-swept'));
  const quiet = events.find((e) => e.event === 'diff-policy-recapture');
  assert.deepEqual(quiet.recaptured.map((r) => r.path), [SHOT]);
  assert.equal(quiet.kind, 'capture-takeback');
  assert.deepEqual(events.find((e) => e.event === 'implementation-committed').dropped, [SHOT]);
});

/**
 * A triage behavior that reads every persistent red as one harness defect,
 * and writes about the take-backs under one path. The live shape of the
 * finding this pair is about: the seat is told a surface left the tree, and it
 * reports what it was told.
 */
function triageAbout(surface) {
  return ({ prompt }) => ({
    report: {
      findings: [
        {
          class: 'harness',
          layers: [...prompt.matchAll(/^- layer (\S+):$/gm)].map((m) => m[1]),
          summary: `The capture take-backs under ${surface} are debris of a red cycle.`,
          evidence: `Nothing under ${surface} is tracked, and it ships from nowhere.`,
        },
      ],
      ...(prompt.includes('Prior open findings') && { persisting: [] }),
      summary: 'triaged',
    },
  });
}

test('a harness finding about a re-capturable take-back stamps no gate-integrity defect', async (t) => {
  // The capture classed these paths at the revert: a record, not an open item.
  // A later step that meets the same paths in a sentence and stamps a
  // zero-tolerance defect for them contradicts the capture, and the owner
  // reads an alert about an artifact the re-freeze already owns.
  const seats = {
    dev: () => ({
      files: { 'src/feature.mjs': GOOD_FEATURE, [SHOT]: 're-rendered-bytes\n' },
      report: { summary: 'implemented, and the surface re-rendered' },
    }),
    'verdict-triage': triageAbout('tests/visual/__screenshots__'),
    ...furyClean(),
  };
  const fx = verdictFixture(t, {
    seats,
    diffPolicy: RECAPTURE_POLICY,
    suiteFiles: FROZEN_BASELINE,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'rlayer', command: 'rlayer' },
    ],
    commands: { suite: SUITE_CMD, rlayer: decayingLayer('rcount', 2) },
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(
    events.find((e) => e.event === 'diff-policy-recapture').recaptured.map((r) => r.path),
    [SHOT],
  );
  // The finding stands, and says on itself why no defect record stands beside
  // it. Nothing loud was stamped and the loud strip carries nothing.
  const finding = events.find((e) => e.event === 'finding' && e.class === 'harness');
  assert.equal(finding.recapturable, true);
  assert.match(finding.note, /honored here/);
  assert.ok(!events.some((e) => e.event === 'gate-integrity'));
  assert.equal(openLoud(fx.paths).filter((i) => i.ledger === `run:${runId}`).length, 0);
  // The route the finding takes is untouched: it is still a harness finding,
  // and it still earns the operational fix that re-runs the layer.
  assert.equal(events.filter((e) => e.event === 'operational-fix').length, 1);
  // The brief the seat read stated the class, in the words the class is worth.
  const triage = fx.calls.find((c) => c.seat === 'verdict-triage');
  assert.match(triage.prompt, /Taken back at capture, re-capturable:/);
  assert.match(triage.prompt, /a re-capturable frozen path/);
  assert.doesNotMatch(triage.prompt, /Taken back at capture:/);
});

test('a harness finding about a held take-back keeps its gate-integrity defect', async (t) => {
  // The same route, the same seat, one path out of the quiet class. A frozen
  // test is authored work, and a write to it is worth the owner's attention.
  const seats = {
    dev: () => ({
      files: { 'src/feature.mjs': GOOD_FEATURE, 'tests/feature.test.mjs': WRONG_TEST },
      report: { summary: 'implemented, and I relaxed the test' },
    }),
    'verdict-triage': triageAbout('tests/feature.test.mjs'),
    ...furyClean(),
  };
  const fx = verdictFixture(t, {
    seats,
    diffPolicy: RECAPTURE_POLICY,
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'rlayer', command: 'rlayer' },
    ],
    commands: { suite: SUITE_CMD, rlayer: decayingLayer('rcount', 2) },
  });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(events.find((e) => e.event === 'diff-policy-violation').dropped, [
    'tests/feature.test.mjs',
  ]);
  assert.ok(!events.some((e) => e.event === 'diff-policy-recapture'));
  const finding = events.find((e) => e.event === 'finding' && e.class === 'harness');
  assert.equal(finding.recapturable, undefined);
  const loud = events.find((e) => e.event === 'gate-integrity');
  assert.equal(loud.findingId, finding.id);
  assert.match(loud.gist, /harness defect/);
  const triage = fx.calls.find((c) => c.seat === 'verdict-triage');
  assert.match(triage.prompt, /Taken back at capture:/);
  assert.doesNotMatch(triage.prompt, /re-capturable/);
});

test('the take-back message names the freeze and the re-freeze route, never a fix', async (t) => {
  // The wording is the fix. A seat told its write "is still unfixed" writes it
  // again, is taken back again, and parks the run; a seat told the path is
  // frozen and that the verdict owns the route does neither.
  const seats = {
    dev: ({ label }) =>
      label === 'dev-1'
        ? {
            files: {
              'src/feature.mjs': BAD_FEATURE,
              'tests/feature.test.mjs': WRONG_TEST,
            },
            report: { summary: 'implemented, and I relaxed the test' },
          }
        : { files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'repaired' } },
    'verdict-triage': triageSeat(() => ({ class: 'code-defect' })),
    'repair-dev': () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'repaired' } }),
    'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
    ...furyClean(),
  };
  const fx = verdictFixture(t, { seats });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const stamp = events.find((e) => e.event === 'diff-policy-violation');
  const line = stamp.droppedLines[0];
  assert.match(line, /^tests\/feature\.test\.mjs: this path is frozen for this lane\./);
  assert.match(line, /The capture reverted the write, and it ships from no implementation seat\./);
  assert.match(line, /the verdict routes that change through a re-freeze; do not write the file again\./);
  assert.doesNotMatch(line, /unfixed/);
  assert.match(stamp.note, /reaches it through the verdict re-freeze route, never through an implementation seat/);
  // Every later seat briefed on this tree is told the same thing.
  const triage = fx.calls.find((c) => c.seat === 'verdict-triage');
  assert.match(triage.prompt, /Taken back at capture:/);
  assert.match(triage.prompt, /this path is frozen for this lane/);
  const repair = fx.calls.find((c) => c.seat === 'repair-dev');
  assert.match(repair.prompt, /Taken back at capture:/);
  assert.match(repair.prompt, /do not write the file again/);
});

test('a violation alongside a take-back still blocks, and the brief carries both', async (t) => {
  // The violation decides. The take-back rides the same brief as a statement,
  // because the corrective seat is about to re-read a tree without its write.
  const seats = {
    dev: ({ label }) =>
      label === 'dev-1'
        ? {
            files: {
              'src/feature.mjs': GOOD_FEATURE,
              '.npmrc': 'link-workspace-packages=true\n',
              'tests/feature.test.mjs': WRONG_TEST,
            },
            report: { summary: 'implemented' },
          }
        : { removes: ['.npmrc'], report: { summary: 'implemented without the topology change' } },
    ...furyClean(),
  };
  const fx = verdictFixture(t, { seats, diffPolicy: POLICY });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const stamp = events.find((e) => e.event === 'diff-policy-violation');
  assert.deepEqual(stamp.violations.map((v) => v.path), ['.npmrc']);
  assert.deepEqual(stamp.dropped, ['tests/feature.test.mjs']);
  const corrective = fx.calls.find((c) => c.label === 'dev-2');
  assert.ok(corrective, 'the violation bought a corrective invocation');
  assert.match(corrective.prompt, /\.npmrc: the diff policy denies this path to this lane/);
  assert.match(corrective.prompt, /tests\/feature\.test\.mjs: this path is frozen for this lane/);
  // The take-back happened in this pass, so the commit that pass produced
  // carries it even though the corrective capture took nothing back.
  const commit = events.find((e) => e.event === 'implementation-committed');
  assert.deepEqual(commit.dropped, ['tests/feature.test.mjs']);
  // The record that blocked is cleared by the capture that cleared it, not at
  // close: it asked for a correction and got one.
  assert.equal(events.filter((e) => e.event === 'diff-policy-violation').length, 1);
  assert.ok(
    events.some((e) => e.event === 'resolved' && e.resolves === stamp.seq && !e.note),
  );
  assert.equal(loudFor(fx.paths, runId, 'diff-policy-violation').length, 0);
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

// -- the card authorizes a supersede (ADR-0044) -------------------------------

// The collision of the run that paid for this decision: the story's criterion
// needs a second export, an earlier story's frozen pin says the set is closed,
// and the card's own scope boundary already says the extension is this story's
// work. The card is the ruling; nobody is asked.
const SUPERSEDE_CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Publish g beside f in src/feature.mjs.

## Scope boundary

This story adds a second published export to the feature module; the export
set an earlier story closed is extended here, not replaced.
${FIXTURE_ACCEPTANCE}`;

// The same card with the covering line gone: the scope says nothing about the
// closed set, so the collision is a question again.
const SILENT_CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Publish g beside f in src/feature.mjs.

## Scope boundary

Registration is another story's work. Nothing here reaches the export set.
${FIXTURE_ACCEPTANCE}`;

// The card line as a seat copies it: one line where the card wraps it over two.
const COVERING_LINE =
  'This story adds a second published export to the feature module; the export ' +
  'set an earlier story closed is extended here, not replaced.';

const PINNED_ASSERTION = 'the published export set is exactly ["f"]';

// The same pin, with the owner's marker on it: a legal gate, a money path, or
// anything else whose change is the owner's call and no seat's.
const PINNED_OWNER_PINNED = `// ${OWNER_PIN_MARKER}: the closed export set is the owner's call.\n${PINNED_CLOSED}`;

const COVERING_CLAIM = {
  supersedes: 'tests/pinned.test.mjs',
  supersedeAssertion: PINNED_ASSERTION,
  supersedeQuote: COVERING_LINE,
  supersedeClause: 'scope-boundary',
};

/** A triage behavior that reports the pin collision, with or without a claim. */
function pinTriage(claim) {
  return ({ prompt }) => ({
    report: {
      findings: [
        {
          class: 'suite-defect',
          depth: 'intent',
          layers: ['unit'],
          summary: 'the frozen pin closes the export set the criterion extends',
          evidence: 'tests/pinned.test.mjs pins the set closed',
          ...claim,
        },
      ],
      ...(prompt.includes('Prior open findings') && { persisting: [] }),
      summary: 'triaged',
    },
  });
}

/** The suite seat of the pin scenario: it amends the file the ruling names. */
function pinSuite() {
  return ({ prompt }) =>
    prompt.includes('tests/pinned.test.mjs')
      ? {
          files: { 'tests/pinned.test.mjs': PINNED_EXTENDED },
          report: {
            suiteFiles: ['tests/pinned.test.mjs'],
            reds: [],
            summary: 'the pin now admits the extension',
          },
        }
      : {
          files: { 'tests/pair.test.mjs': PAIR_TEST },
          report: { suiteFiles: ['tests/pair.test.mjs'], reds: [], summary: 'nothing amended' },
        };
}

function pinFixture(t, { card, seats, pinnedTest = PINNED_CLOSED, laneConfig }) {
  return verdictFixture(t, {
    seats,
    specText: FIXTURE_SPEC,
    originFiles: { 'cards/alpha.md': card },
    suiteFiles: { 'tests/pair.test.mjs': PAIR_TEST, 'tests/pinned.test.mjs': pinnedTest },
    ...(laneConfig && { laneConfig }),
  });
}

test("a collision the card covers is superseded with no park, on the card's own words", async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': PAIR_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': pinTriage(COVERING_CLAIM),
    ...furyClean(),
    'spec-birth': () => ({ report: { amendedSections: ['AC-1'], summary: 'amended' } }),
    suite: pinSuite(),
    'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
  };
  const fx = pinFixture(t, { card: SUPERSEDE_CARD, seats });
  const { runId } = await fx.launch({ card: 'cards/alpha.md' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // Zero parks. The card answered the question before the run could ask it.
  assert.deepEqual(
    events.filter((e) => e.event === 'park').map((e) => e.type),
    [],
  );
  // The record: the test, the assertion, the clause, and the card line verbatim.
  const stamps = events.filter((e) => e.event === 'supersede-authorized');
  assert.equal(stamps.length, 1);
  assert.equal(stamps[0].site, 'verdict');
  assert.equal(stamps[0].test, 'tests/pinned.test.mjs');
  assert.equal(stamps[0].assertion, PINNED_ASSERTION);
  assert.equal(stamps[0].clause, 'scope-boundary');
  assert.equal(stamps[0].card, 'cards/alpha.md');
  assert.equal(stamps[0].finding, events.find((e) => e.event === 'finding').id);
  // Verbatim means verbatim: the quote is in the card the run was given,
  // whitespace apart. The card is read from the fixture and not from the
  // worktree, which the close released.
  assert.ok(
    SUPERSEDE_CARD.replace(/\s+/g, ' ').includes(stamps[0].cardQuote.replace(/\s+/g, ' ')),
  );
  // The citation rode the re-freeze route the human ruling rides, and says so.
  const refreeze = events.filter((e) => e.event === 're-freeze');
  assert.equal(refreeze.length, 1);
  assert.equal(refreeze[0].ruling.source, 'card');
  assert.equal(refreeze[0].ruling.actor, 'card');
  assert.equal(refreeze[0].ruling.park, undefined);
  assert.equal(refreeze[0].ruling.answer, stamps[0].seq);
  assert.deepEqual(refreeze[0].ruling.files, ['tests/pinned.test.mjs']);
  // The suite seat was told the card is the authority, and which file it reaches.
  const refrozen = fx.calls.filter((c) => c.seat === 'suite');
  assert.equal(refrozen.length, 1);
  assert.ok(refrozen[0].prompt.includes('The intent card authorizes this amendment'));
  assert.ok(refrozen[0].prompt.includes('- tests/pinned.test.mjs'));
  assert.ok(refrozen[0].prompt.includes(COVERING_LINE));
  // The verdict record carries the supersede for the reviewer who reads it.
  const record = readRecord(fx.paths, runId, 2);
  assert.deepEqual(record.supersedes, [
    {
      test: 'tests/pinned.test.mjs',
      assertion: PINNED_ASSERTION,
      cardQuote: COVERING_LINE,
      clause: 'scope-boundary',
      site: 'verdict',
    },
  ]);
  // And a judgment seat read the amendment nobody was asked about, with the
  // verification duty and the executed supersede in its brief.
  const review = fx.calls.filter((c) => c.seat === 'generalist-review');
  assert.equal(review.length, 1);
  assert.ok(review[0].prompt.includes('without asking the owner'));
  assert.ok(review[0].prompt.includes('tests/pinned.test.mjs'));
  assert.ok(review[0].prompt.includes('is a HIGH finding on the spec lens'));
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.deepEqual(
    renders.map((e) => [e.cycle, e.verdict]),
    [
      [1, 'red'],
      [2, 'green'],
    ],
  );
});

test('the same collision on a card that does not cover it parks, exactly as before', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': PAIR_FEATURE }, report: { summary: 'implemented' } }),
    // The seat read the card and found nothing that reaches the collision, so
    // it makes no claim. Silence is the owner's question.
    'verdict-triage': pinTriage({}),
    ...furyClean(),
    'spec-birth': () => ({ report: { amendedSections: ['AC-1'], summary: 'amended' } }),
    suite: pinSuite(),
  };
  const fx = pinFixture(t, { card: SILENT_CARD, seats });
  const { runId } = await fx.launch({ card: 'cards/alpha.md' });
  const park = await waitParked(fx.paths, runId, 'intent-conflict');
  assert.ok(park.question.includes('The card did not settle it'));
  // The park says which check refused, in the words of the test it applied
  // (ADR-0053).
  assert.ok(park.question.includes('the card mandates no behavior whose implementation'));
  fx.daemon.engine.answer({
    runId,
    actor: 'operator',
    answer: 'AC-1 supersedes the closed set. Amend tests/pinned.test.mjs to admit g.',
  });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // Nothing was authorized, and the human ruling took the route it always took.
  assert.equal(events.filter((e) => e.event === 'supersede-authorized').length, 0);
  const refreeze = events.find((e) => e.event === 're-freeze');
  assert.equal(refreeze.ruling.source, undefined);
  assert.equal(refreeze.ruling.actor, 'operator');
  assert.equal(refreeze.ruling.park, park.seq);
  // A ruling a human gave was judged by that human; no review seat re-reads it.
  assert.ok(!fx.calls.some((c) => c.seat === 'generalist-review'));
});

test('an owner-pinned test parks even with a covering card line', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': PAIR_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': pinTriage(COVERING_CLAIM),
    ...furyClean(),
    'spec-birth': () => ({ report: { amendedSections: ['AC-1'], summary: 'amended' } }),
    suite: pinSuite(),
  };
  const fx = pinFixture(t, { card: SUPERSEDE_CARD, seats, pinnedTest: PINNED_OWNER_PINNED });
  const { runId } = await fx.launch({ card: 'cards/alpha.md' });
  const park = await waitParked(fx.paths, runId, 'intent-conflict');
  assert.ok(park.question.includes('carries the owner pin'));
  assert.ok(park.question.includes('parks whatever'));
  fx.daemon.engine.answer({
    runId,
    actor: 'operator',
    answer: 'Granted. Amend tests/pinned.test.mjs to admit g.',
  });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.filter((e) => e.event === 'supersede-authorized').length, 0);
  assert.equal(events.find((e) => e.event === 're-freeze').ruling.actor, 'operator');
});

test('a fabricated quote fails at the stamp site and the run parks on it', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': PAIR_FEATURE }, report: { summary: 'implemented' } }),
    // The card says nothing of the kind; the claim quotes it anyway.
    'verdict-triage': pinTriage(COVERING_CLAIM),
    ...furyClean(),
    'spec-birth': () => ({ report: { amendedSections: ['AC-1'], summary: 'amended' } }),
    suite: pinSuite(),
  };
  const fx = pinFixture(t, { card: SILENT_CARD, seats });
  const { runId } = await fx.launch({ card: 'cards/alpha.md' });
  const park = await waitParked(fx.paths, runId, 'intent-conflict');
  assert.ok(park.question.includes('not in the card section the claim names'));
  // Nothing was stamped: the run parked rather than proceed on the claim.
  const live = readEvents(runLedgerPath(fx.paths, runId));
  assert.equal(live.filter((e) => e.event === 'supersede-authorized').length, 0);
  fx.daemon.engine.answer({
    runId,
    actor: 'operator',
    answer: 'Granted anyway. Amend tests/pinned.test.mjs to admit g.',
  });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.filter((e) => e.event === 'supersede-authorized').length, 0);
});

test('a stretched authorization surfaces as a confirmed HIGH on the spec lens', async (t) => {
  let reviewed = 0;
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': PAIR_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': pinTriage(COVERING_CLAIM),
    ...furyClean(),
    'spec-birth': () => ({ report: { amendedSections: ['AC-1'], summary: 'amended' } }),
    suite: pinSuite(),
    // The quote is in the card, so the mechanical check passes it. Whether the
    // line REACHES the assertion that changed is the judgment this seat makes.
    'generalist-review': () =>
      reviewed++ === 0
        ? {
            report: {
              findings: [
                {
                  lens: 'spec',
                  severity: 'HIGH',
                  finding: 'the scope line covers a second export, not the closed-set shape the amendment dropped',
                  evidence: 'tests/pinned.test.mjs',
                },
              ],
              summary: 'the authorization is stretched',
            },
          }
        : { report: { findings: [], summary: 'clean' } },
    'fury-verifier': verifierSeat((item) =>
      item.mode === 'confirm' ? { verdict: 'confirmed' } : { verdict: 'resolved' },
    ),
    'repair-dev': () => ({
      files: { 'src/feature.mjs': PAIR_FEATURE },
      report: { summary: 'narrowed' },
    }),
  };
  const fx = pinFixture(t, { card: SUPERSEDE_CARD, seats });
  const { runId } = await fx.launch({ card: 'cards/alpha.md' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const high = events.find((e) => e.event === 'finding' && e.lens === 'spec');
  assert.equal(high.severity, 'HIGH');
  assert.equal(high.confirmed, true);
  assert.equal(high.advisory, undefined);
  // It blocked the cycle behind the amendment, and the repair round closed it.
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.deepEqual(renders[1].open, [high.id]);
  assert.equal(renders[2].verdict, 'green');
  assert.equal(events.filter((e) => e.event === 'repair-round').length, 1);
});

test('a project that turns the decision off parks every collision, card or no card', async (t) => {
  const seats = {
    dev: () => ({ files: { 'src/feature.mjs': PAIR_FEATURE }, report: { summary: 'implemented' } }),
    'verdict-triage': pinTriage(COVERING_CLAIM),
    ...furyClean(),
    'spec-birth': () => ({ report: { amendedSections: ['AC-1'], summary: 'amended' } }),
    suite: pinSuite(),
  };
  const fx = pinFixture(t, {
    card: SUPERSEDE_CARD,
    seats,
    laneConfig: { story: { suiteCommand: 'suite', cardAuthorizedSupersede: false } },
  });
  const { runId } = await fx.launch({ card: 'cards/alpha.md' });
  const park = await waitParked(fx.paths, runId, 'intent-conflict');
  assert.ok(park.question.includes('turned card-authorized supersedes off'));
  fx.daemon.engine.answer({
    runId,
    actor: 'operator',
    answer: 'Granted. Amend tests/pinned.test.mjs to admit g.',
  });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.filter((e) => e.event === 'supersede-authorized').length, 0);
  // The triage seat was never given the classification duty either.
  assert.ok(
    !fx.calls
      .find((c) => c.seat === 'verdict-triage')
      .prompt.includes('does the card'),
  );
});

// -- concurrency groups reach the cycle (ADR-0047) ---------------------------

/** A gate command that writes down the span it held the machine for. */
function spanGate(file, ms = 400) {
  return [
    'node',
    '-e',
    `const {writeFileSync}=require('fs');const s=Date.now();` +
      `setTimeout(()=>{writeFileSync(${JSON.stringify(file)},` +
      `JSON.stringify({s,e:Date.now()}));process.exit(0);},${ms});`,
  ];
}

function concurrencyScenario(t, { concurrencyGroups, ms = 400 }) {
  const root = tempDir('olympus-groups-lane-');
  t.after(() => removeDir(root));
  const files = { left: join(root, 'left.json'), right: join(root, 'right.json') };
  const fx = verdictFixture(t, {
    seats: {
      dev: () => ({ files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } }),
      ...furyClean(),
    },
    gates: [
      { name: 'unit', command: 'suite' },
      { name: 'left', command: 'left' },
      { name: 'right', command: 'right' },
    ],
    commands: { suite: SUITE_CMD, left: spanGate(files.left, ms), right: spanGate(files.right, ms) },
    ...(concurrencyGroups !== undefined && { concurrencyGroups }),
  });
  return {
    fx,
    spans: () => ({
      left: JSON.parse(readFileSync(files.left, 'utf8')),
      right: JSON.parse(readFileSync(files.right, 'utf8')),
    }),
  };
}

const overlapping = (x, y) => x.s < y.e && y.s < x.e;

test('a cycle runs a declared group together, and the record says which layers overlapped', async (t) => {
  const { fx, spans } = concurrencyScenario(t, { concurrencyGroups: [['left', 'right']], ms: 1500 });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const { left, right } = spans();
  assert.ok(overlapping(left, right), 'the grouped layers did not run together');
  // Each layer keeps its own result, and each says what it ran beside, so a
  // duration read off this ledger is never mistaken for a serial one.
  // The set and never the sequence: these layers run together by design, so
  // ledger order is completion order and nothing about the group fixes it.
  assert.deepEqual(
    events
      .filter((e) => e.event === 'layer-result')
      .map((e) => [e.layer, e.status, e.concurrentWith])
      .sort((a, b) => a[0].localeCompare(b[0])),
    [
      ['left', 'green', ['right']],
      ['right', 'green', ['left']],
      ['unit', 'green', undefined],
    ],
  );
  const record = readRecord(fx.paths, runId, 1);
  assert.deepEqual(
    record.spectrum.map((r) => [r.layer, r.concurrentWith]),
    [
      ['unit', undefined],
      ['left', ['right']],
      ['right', ['left']],
    ],
  );
});

test('the same lane with the field absent runs the strict sequence', async (t) => {
  // The revert of ADR-0047, through the whole lane: one config field goes,
  // and the engine keeps the capability and does nothing with it.
  const { fx, spans } = concurrencyScenario(t, { concurrencyGroups: undefined });
  const { runId } = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const { left, right } = spans();
  assert.ok(!overlapping(left, right), 'the layers overlapped with no group declared');
  assert.deepEqual(
    events
      .filter((e) => e.event === 'layer-result')
      .map((e) => [e.layer, e.status, e.concurrentWith]),
    [
      ['unit', 'green', undefined],
      ['left', 'green', undefined],
      ['right', 'green', undefined],
    ],
  );
  const record = readRecord(fx.paths, runId, 1);
  assert.ok(record.spectrum.every((r) => r.concurrentWith === undefined));
});
