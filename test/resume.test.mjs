// Resume from a prior run's freeze: a launch inherits the pre-freeze
// derivation of a run that died after its freeze, enters at the post-freeze
// stage, and runs no pre-freeze seat. Every condition under which the harness
// would have to guess refuses instead — at the console, at the daemon
// handler, and at the lane's admission gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, archivedRunLedgerPath, runLedgerPath } from '../src/daemon/home.mjs';
import { storyLane } from '../src/lanes/story.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { openRunStore, archiveRun } from '../src/telemetry/stores.mjs';
import { cloneDir, ensureBareClone, fetchClone } from '../src/isolation/clones.mjs';
import { runBranch } from '../src/isolation/worktrees.mjs';
import {
  tempDir,
  removeDir,
  waitFor,
  gitSync,
  writeTree,
  commitTree,
  initOriginRepo,
  projectConfigJson,
  FIXTURE_ACCEPTANCE,
  FIXTURE_SPEC,
  NO_SURFACE,
  NO_WAIT,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';
const CARD_PATH = 'stories/alpha.md';
const PRIOR = 'prior-run';

const CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Provide f(x) that doubles x in src/feature.mjs.
${FIXTURE_ACCEPTANCE}`;

const SUITE_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('f doubles', async () => {
  const { f } = await import('../src/feature.mjs');
  assert.equal(f(2), 4);
});
`;

const IMPLEMENTATION = 'export const f = (x) => 2 * x;\n';

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
  stmts.push(
    `fs.mkdirSync(path.dirname(${JSON.stringify(reportPath)}), { recursive: true });`,
    `fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});`,
    'process.exit(0);',
  );
  return stmts.join('\n');
}

function seatFixture(seats) {
  const calls = [];
  const commandFor = (opts) => {
    const seat = /You are the (\S+) seat/.exec(opts.prompt)[1];
    const lines = opts.prompt.split('\n');
    const contract = lines.findIndex((l) => l.includes('write your JSON report to this file'));
    const reportPath = lines[contract + 1];
    calls.push({ seat, label: basename(reportPath, '.json') });
    const out = seats[seat]({ prompt: opts.prompt, label: basename(reportPath, '.json') });
    return {
      cmd: process.execPath,
      args: ['-e', seatScript({ reportPath, model: opts.model, ...out })],
      parseLine: fixtureParse,
    };
  };
  return { commandFor, calls };
}

/**
 * A project fixture with the story lane and a recording post-freeze stage.
 * The stage closes the run failed, which is exactly the shape a resume
 * inherits from: a run that reached its freeze and died after it.
 */
function fixture(t, { originFiles = {} } = {}) {
  const root = tempDir();
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson({
      repo: { testPaths: ['tests'] },
      commands: { suite: ['node', '--test', 'tests/*.test.mjs'] },
      lanes: { story: { suiteCommand: 'suite' } },
      stack: null,
    }),
    [CARD_PATH]: CARD,
    'src/base.mjs': 'export const base = 1;\n',
    ...originFiles,
  });
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { proj: { repoUrl: origin, slotCap: 2 } } }) + '\n',
  );
  const entered = [];
  const lanes = {
    story: storyLane({
      afterFreeze: {
        stages: ['build'],
        handlers: {
          build: async (ctx) => {
            entered.push({
              runId: ctx.runId,
              head: gitSync(['rev-parse', 'HEAD'], ctx.payload.worktree).trim(),
            });
            return { close: { state: 'failed', reason: 'fixture-stop' } };
          },
        },
      },
    }),
  };
  const daemon = new Daemon(join(root, 'home'), { waitSleep: NO_WAIT, lanes });
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  return { root, origin, paths, daemon, entered };
}

async function waitClosed(paths, runId) {
  await waitFor(() => existsSync(archivedRunLedgerPath(paths, runId)), {
    label: `run ${runId} archived`,
    attempts: 400,
    intervalMs: 100,
  });
  return readEvents(archivedRunLedgerPath(paths, runId));
}

function waitParked(paths, runId, type) {
  return waitFor(
    () =>
      readEvents(runLedgerPath(paths, runId)).find((e) => e.event === 'park' && e.type === type),
    { label: `park ${type}`, attempts: 400, intervalMs: 100 },
  );
}

/** A refusal parks; the owner abandons it, and the close names the reason. */
async function abandon(fx, runId) {
  const park = await waitParked(fx.paths, runId, 'stage-blocked');
  assert.deepEqual(park.answers.options, ['retry', 'abandon']);
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const events = await waitClosed(fx.paths, runId);
  return { park, events, closed: events.find((e) => e.event === 'run-closed') };
}

function waitReleased(paths, runId) {
  return waitFor(
    () =>
      readEvents(paths.instanceLedger).find(
        (e) => e.event === 'workspace-released' && e.runId === runId,
      ),
    { label: `workspace of ${runId} released`, attempts: 400, intervalMs: 100 },
  );
}

// -- seeding a prior run -----------------------------------------------------

/** Creates the bare clone and a run branch holding the frozen suite. */
async function seedFrozenBranch(root, paths, origin, { extraFiles = {} } = {}) {
  const clone = await ensureBareClone(paths, 'proj', origin, 'main');
  await fetchClone(clone);
  gitSync(['config', 'user.email', 'harness@test.invalid'], clone);
  gitSync(['config', 'user.name', 'Harness Test'], clone);
  const baseSha = gitSync(['rev-parse', 'main'], clone).trim();
  const tree = join(root, 'seed');
  gitSync(['worktree', 'add', '-b', runBranch(PRIOR), tree, 'main'], clone);
  writeTree(tree, { 'tests/feature.test.mjs': SUITE_TEST, ...extraFiles });
  gitSync(['add', '-A'], tree);
  gitSync(['-c', 'commit.gpgsign=false', 'commit', '-m', 'suite'], tree);
  const frozenSha = gitSync(['rev-parse', 'HEAD'], tree).trim();
  gitSync(['worktree', 'remove', '--force', tree], clone);
  return { clone, baseSha, frozenSha };
}

/**
 * Writes a closed prior run: ledger, born spec, freeze record. `overrides`
 * bends each part so a test can seed exactly one defect.
 */
function seedPriorRun(paths, { baseSha, frozenSha, launch = {}, freeze = {}, closed = {}, spec = FIXTURE_SPEC, record = {}, archive = true }) {
  const store = openRunStore(paths, PRIOR);
  store.append('run-launched', {
    actor: 'daemon',
    project: 'proj',
    lane: 'story',
    card: CARD_PATH,
    storyKey: 'alpha-1',
    branch: runBranch(PRIOR),
    baseSha,
    ...launch,
  });
  if (freeze !== null) {
    store.append('freeze', {
      actor: 'daemon',
      sha: frozenSha,
      killCount: 3,
      amendmentKills: 0,
      dispositions: 0,
      files: 1,
      record: 'seeded',
      ...freeze,
    });
  }
  if (closed !== null) {
    store.append('run-closed', { actor: 'daemon', state: 'failed', reason: 'fixture-stop', ...closed });
  }
  store.close();
  const dir = join(paths.runs, PRIOR);
  if (spec !== null) writeFileSync(join(dir, 'spec.md'), spec);
  if (record !== null) {
    writeFileSync(
      join(dir, 'freeze.json'),
      JSON.stringify(
        {
          runId: PRIOR,
          project: 'proj',
          card: CARD_PATH,
          storyKey: 'alpha-1',
          suiteSha: frozenSha,
          suiteFiles: ['tests/feature.test.mjs'],
          killCount: 3,
          amendmentKills: 0,
          dispositions: [],
          redState: { result: 'red', sha: frozenSha, reds: [] },
          ...record,
        },
        null,
        2,
      ) + '\n',
    );
  }
  if (closed !== null && archive) archiveRun(paths, PRIOR);
}

// -- scenarios ---------------------------------------------------------------

test('a resume inherits a real freeze and enters the post-freeze stage seatless', async (t) => {
  const seats = {
    'spec-birth': ({ prompt }) => ({
      files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
      report: { outcome: 'spec-born', summary: 'born' },
    }),
    'spec-gate': () => ({ report: { findings: [], summary: 'clean' } }),
    suite: () => ({
      files: { 'tests/feature.test.mjs': SUITE_TEST },
      report: {
        suiteFiles: ['tests/feature.test.mjs'],
        reds: [{ test: 'f doubles', class: 'feature-absence' }],
        ...NO_SURFACE,
        summary: 'authored',
      },
    }),
    adversary: () => ({
      files: { 'src/feature.mjs': 'export const f = () => 0;\n' },
      report: { approach: 'stub', wrongness: 'f returns 0' },
    }),
  };
  const fx = fixture(t);
  const seat = seatFixture(seats);
  await fx.daemon.start();
  fx.daemon.engine.seatDefaults = () => ({ commandFor: seat.commandFor });
  const first = await fx.daemon.launchCommand({
    actor: 'console:tester',
    project: 'proj',
    card: CARD_PATH,
  });
  const firstEvents = await waitClosed(fx.paths, first.runId);
  await waitReleased(fx.paths, first.runId);
  const frozen = firstEvents.find((e) => e.event === 'freeze');
  assert.equal(frozen.killCount, 1);
  // The branch a resume inherits from survives a close that did not ship.
  const clone = cloneDir(fx.paths, 'proj');
  assert.match(gitSync(['branch', '--list', runBranch(first.runId)], clone), /run\//);
  const firstLength = firstEvents.length;

  const priorCalls = seat.calls.length;
  const second = await fx.daemon.launchCommand({
    actor: 'console:tester',
    project: 'proj',
    resumeFrom: first.runId,
  });
  const events = await waitClosed(fx.paths, second.runId);

  // It entered at the post-freeze stage and spawned no seat on the way.
  assert.deepEqual(
    events.filter((e) => e.event === 'stage-entered').map((e) => e.stage),
    ['readiness', 'build'],
  );
  assert.ok(!events.some((e) => e.event === 'seat-spawned'));
  assert.equal(seat.calls.length, priorCalls);
  assert.ok(!events.some((e) => e.event === 'freeze'));
  // The inheritance is stamped and names its source.
  const inherited = events.find((e) => e.event === 'freeze-inherited');
  assert.equal(inherited.from, first.runId);
  assert.equal(inherited.frozenSha, frozen.sha);
  assert.equal(inherited.sha, frozen.sha); // the base did not move: no merge
  assert.equal(inherited.files, 1);
  assert.equal(inherited.killCount, 1);
  assert.deepEqual(inherited.priorFindings, []);
  assert.deepEqual(inherited.priorLoud, []);
  // The artifacts travelled, and the record still names the run that earned it.
  const archive = join(fx.paths.archivedRuns, second.runId);
  assert.equal(
    readFileSync(join(archive, 'spec.md'), 'utf8'),
    readFileSync(join(fx.paths.archivedRuns, first.runId, 'spec.md'), 'utf8'),
  );
  const record = JSON.parse(readFileSync(join(archive, 'freeze.json'), 'utf8'));
  assert.equal(record.runId, first.runId);
  assert.equal(record.suiteSha, frozen.sha);
  // The post-freeze stage got the frozen tree, and the card came from the
  // prior run rather than from the caller.
  assert.equal(fx.entered.find((e) => e.runId === second.runId).head, frozen.sha);
  const launched = events.find((e) => e.event === 'run-launched');
  assert.equal(launched.card, CARD_PATH);
  assert.equal(launched.storyKey, 'alpha-1');
  assert.equal(launched.resumeFrom, first.runId);
  // The prior run stays closed and archived, untouched.
  assert.equal(readEvents(archivedRunLedgerPath(fx.paths, first.runId)).length, firstLength);
});

test('a resume without a valid freeze refuses before it provisions', async (t) => {
  const fx = fixture(t);
  await fx.daemon.start();
  const { baseSha, frozenSha } = await seedFrozenBranch(fx.root, fx.paths, fx.origin);
  const launch = (extra) =>
    fx.daemon.launchRun({ project: 'proj', lane: 'story', resumeFrom: PRIOR, ...extra });

  await assert.rejects(
    () => fx.daemon.launchRun({ project: 'proj', lane: 'story', resumeFrom: 'ghost' }),
    /no ledger for run ghost/,
  );
  // Still open: its branch is live and another run writes to it.
  seedPriorRun(fx.paths, { baseSha, frozenSha, closed: null });
  await assert.rejects(launch, /still open/);
  removeDir(join(fx.paths.runs, PRIOR));
  // Shipped: the freeze belongs to work already on the default branch.
  seedPriorRun(fx.paths, { baseSha, frozenSha, closed: { state: 'shipped' } });
  await assert.rejects(launch, /shipped/);
  removeDir(join(fx.paths.archivedRuns, PRIOR));
  // No freeze at all.
  seedPriorRun(fx.paths, { baseSha, frozenSha, freeze: null });
  await assert.rejects(launch, /has no freeze record/);
  removeDir(join(fx.paths.archivedRuns, PRIOR));
  // A stamped freeze whose record is unreadable.
  seedPriorRun(fx.paths, { baseSha, frozenSha, record: null });
  await assert.rejects(launch, /no readable freeze record/);
  removeDir(join(fx.paths.archivedRuns, PRIOR));
  // A record without the born spec beside it.
  seedPriorRun(fx.paths, { baseSha, frozenSha, spec: null });
  await assert.rejects(launch, /has no born spec/);
  removeDir(join(fx.paths.archivedRuns, PRIOR));
  // No recorded base: nothing can say whether the freeze still applies.
  seedPriorRun(fx.paths, { baseSha, frozenSha, launch: { baseSha: undefined } });
  await assert.rejects(launch, /records no base sha/);
  removeDir(join(fx.paths.archivedRuns, PRIOR));
  // Valid in every respect but the branch: the frozen tree is unreachable.
  seedPriorRun(fx.paths, { baseSha, frozenSha });
  gitSync(['branch', '-D', runBranch(PRIOR)], cloneDir(fx.paths, 'proj'));
  await assert.rejects(launch, /is gone from the clone/);
  // Nothing was provisioned by any of them.
  assert.equal(fx.daemon.engine.runs.size, 0);
  assert.ok(!readEvents(fx.paths.instanceLedger).some((e) => e.event === 'launch'));
});

test('an advanced base merges, re-runs the red state, and inherits', async (t) => {
  const fx = fixture(t);
  await fx.daemon.start();
  const { baseSha, frozenSha } = await seedFrozenBranch(fx.root, fx.paths, fx.origin);
  seedPriorRun(fx.paths, { baseSha, frozenSha });
  commitTree(fx.origin, { 'src/other.mjs': 'export const other = 1;\n' }, 'main moves');
  const { runId } = await fx.daemon.launchRun({
    project: 'proj',
    lane: 'story',
    resumeFrom: PRIOR,
  });
  const events = await waitClosed(fx.paths, runId);
  const update = events.find((e) => e.event === 'branch-update');
  assert.equal(update.fromSha, frozenSha);
  const redState = events.find((e) => e.event === 'red-state-check');
  assert.equal(redState.result, 'red');
  const inherited = events.find((e) => e.event === 'freeze-inherited');
  assert.equal(inherited.frozenSha, frozenSha);
  assert.equal(inherited.sha, update.toSha); // the merge head, not the freeze
  assert.notEqual(inherited.base, inherited.priorBase);
  assert.deepEqual(
    events.filter((e) => e.event === 'stage-entered').map((e) => e.stage),
    ['readiness', 'build'],
  );
});

test('an advance into the test paths refuses and names the diverged files', async (t) => {
  const fx = fixture(t);
  await fx.daemon.start();
  const { baseSha, frozenSha } = await seedFrozenBranch(fx.root, fx.paths, fx.origin);
  seedPriorRun(fx.paths, { baseSha, frozenSha });
  commitTree(fx.origin, { 'tests/other.test.mjs': "import test from 'node:test';\n" }, 'main tests');
  const { runId } = await fx.daemon.launchRun({
    project: 'proj',
    lane: 'story',
    resumeFrom: PRIOR,
  });
  const { park, events, closed } = await abandon(fx, runId);
  assert.ok(park.question.includes('tests/other.test.mjs'));
  assert.equal(closed.reason, 'inherit-suite-diverged');
  assert.deepEqual(closed.files, ['tests/other.test.mjs']);
  assert.ok(!events.some((e) => e.event === 'freeze-inherited'));
  assert.ok(!events.some((e) => e.event === 'seat-spawned'));
});

test('a base advance that greens the frozen suite refuses', async (t) => {
  const fx = fixture(t);
  await fx.daemon.start();
  const { baseSha, frozenSha } = await seedFrozenBranch(fx.root, fx.paths, fx.origin);
  seedPriorRun(fx.paths, { baseSha, frozenSha });
  commitTree(fx.origin, { 'src/feature.mjs': IMPLEMENTATION }, 'main ships the feature');
  const { runId } = await fx.daemon.launchRun({
    project: 'proj',
    lane: 'story',
    resumeFrom: PRIOR,
  });
  const { events, closed } = await abandon(fx, runId);
  assert.equal(events.find((e) => e.event === 'red-state-check').result, 'green');
  assert.equal(closed.reason, 'inherit-red-state-green');
  assert.ok(!events.some((e) => e.event === 'freeze-inherited'));
});

test('a merge conflict with the advanced base refuses and names the files', async (t) => {
  const fx = fixture(t);
  await fx.daemon.start();
  const { baseSha, frozenSha } = await seedFrozenBranch(fx.root, fx.paths, fx.origin, {
    extraFiles: { 'src/base.mjs': 'export const base = 2;\n' },
  });
  seedPriorRun(fx.paths, { baseSha, frozenSha });
  commitTree(fx.origin, { 'src/base.mjs': 'export const base = 3;\n' }, 'main edits base');
  const { runId } = await fx.daemon.launchRun({
    project: 'proj',
    lane: 'story',
    resumeFrom: PRIOR,
  });
  const { events, closed } = await abandon(fx, runId);
  assert.equal(closed.reason, 'inherit-base-conflict');
  assert.deepEqual(closed.files, ['src/base.mjs']);
  assert.ok(!events.some((e) => e.event === 'freeze-inherited'));
});

test('a malformed resume is refused at the console and at the daemon handler', async (t) => {
  const fx = fixture(t);
  await fx.daemon.start();
  const bin = join(import.meta.dirname, '..', 'bin', 'olympusctl.mjs');
  const home = join(fx.root, 'home');
  const ctl = (args) => {
    try {
      execFileSync(process.execPath, [bin, ...args], {
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch (error) {
      return { code: error.status, err: error.stderr };
    }
    return { code: 0, err: '' };
  };
  const wrongLane = ctl([
    'launch', '--home', home, '--project', 'proj',
    '--lane', 'repair', '--resume-from', PRIOR, '--ticket', 'tickets/t1.md',
  ]);
  assert.equal(wrongLane.code, 2);
  assert.match(wrongLane.err, /--resume-from applies to --lane story only/);
  const withCard = ctl([
    'launch', '--home', home, '--project', 'proj',
    '--resume-from', PRIOR, '--card', CARD_PATH,
  ]);
  assert.equal(withCard.code, 2);
  assert.match(withCard.err, /takes its card from the prior run/);
  // Neither reached the inbox.
  assert.equal(readEvents(runLedgerPath(fx.paths, PRIOR)).length, 0);

  // The daemon handler refuses the same combinations on its own authority.
  await assert.rejects(
    () =>
      fx.daemon.launchCommand({
        actor: 'console:tester',
        project: 'proj',
        lane: 'repair',
        ticket: 'tickets/t1.md',
        resumeFrom: PRIOR,
      }),
    /a resume applies to the story lane only/,
  );
  await assert.rejects(
    () =>
      fx.daemon.launchCommand({
        actor: 'console:tester',
        project: 'proj',
        resumeFrom: PRIOR,
        card: CARD_PATH,
      }),
    /takes its card from the prior run/,
  );
  assert.equal(fx.daemon.engine.runs.size, 0);
});
