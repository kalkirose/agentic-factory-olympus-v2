// The ship step end to end on fixture repos against a fake forge: a fixture
// PR ships green hands-off; a forced red-merge and a competing merge produce
// the specified stamps and routes; CI reds take the flake filter and the
// shared triage; textual conflicts take the merge round. The lane is seeded
// at the freeze boundary — the pre-freeze chain has its own suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import {
  scaffoldHome,
  archivedRunLedgerPath,
  repairTicketPath,
  reconcileTicketPath,
  runLedgerPath,
} from '../src/daemon/home.mjs';
import { postFreeze, repairLane, restoreAnchor } from '../src/lanes/verdict.mjs';
import {
  checksByName,
  fastPathTaken,
  shipStep,
  unstampedMerge,
  CHECKLESS_POLLS,
  UPDATE_CAP,
} from '../src/lanes/ship.mjs';
import { FLAKE_LIMIT, RERUN_BUDGET } from '../src/ledger/cycles.mjs';
import { gitHubForge, noLogReason, parseGitHubRepo, PartialLogRefusal } from '../src/ship/forge.mjs';
import { derivedLabels } from '../src/ship/labels.mjs';
import { commitAll, restorePaths } from '../src/isolation/tree.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { openEscapesStore, openRunStore, TelemetryStore } from '../src/telemetry/stores.mjs';
import { BEATS_PER_STAMP } from '../src/telemetry/heartbeat.mjs';
import { openLoud } from '../src/telemetry/readers.mjs';
import { openCardParks } from '../src/telemetry/queue.mjs';
import { FORESEEN_HEADING, FORESEEN_MARKER } from '../src/lanes/card.mjs';
import { RUN_EVENTS } from '../src/ledger/registry.mjs';
import { recordEscape, ticketEscape, readEscapeSet } from '../src/telemetry/escapes.mjs';
import { standingTripwires, withTripwireDefaults } from '../src/tripwires/registry.mjs';
import { owedRepairs } from '../src/frontier/repairs.mjs';
import { owedReconciliations, reconciliationLaunch } from '../src/frontier/reconciliations.mjs';
import {
  tempDir,
  removeDir,
  waitFor,
  gitSync,
  initOriginRepo,
  commitTree,
  projectConfigJson,
  writeTree,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';

const DEFAULT_CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Provide f(x) that doubles x in src/feature.mjs.
`;

const GOOD_FEATURE = 'export const f = (x) => 2 * x;\n';
const ALT_FEATURE = 'export const f = (x) => x + x; // main variant\n';

const STRONG_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('f doubles', async () => {
  const { f } = await import('../src/feature.mjs');
  assert.equal(f(2), 4);
});
`;

const ALT_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
// main variant
test('f doubles', async () => {
  const { f } = await import('../src/feature.mjs');
  assert.equal(f(3), 6);
});
`;

// -- check-run shorthands ----------------------------------------------------

// A credential probe the fixture controls through one variable. Its output
// carries a value that must never be recorded, so the ledger and the park text
// can be searched for it.
const PROBE_VAR = 'OLYMPUS_FIXTURE_CREDENTIAL';
const PROBE_LEAK = 'sk_fixture_never_record_me';
const PROBE_SCRIPT =
  `console.log('probe sent ${PROBE_LEAK}');` +
  `process.exit(process.env.${PROBE_VAR} === 'live' ? 0 : 1);`;

// Every shorthand takes an optional check-run id and start time: two attempts
// at one name are two check runs, and the watcher orders them by those two
// facts. A shorthand that names neither is one attempt, and the forge fixture
// mints its id when it hands the list out.
const green = (name = 'ci', extra = {}) => ({
  name,
  status: 'completed',
  conclusion: 'success',
  startedAt: '2026-08-10T00:00:00Z',
  completedAt: '2026-08-10T00:03:00Z',
  ...extra,
});
const red = (name = 'ci', extra = {}) => ({
  name,
  status: 'completed',
  conclusion: 'failure',
  startedAt: '2026-08-10T00:00:00Z',
  completedAt: '2026-08-10T00:02:00Z',
  ...extra,
});
/** A check somebody stopped: terminal, no answer about the tree, nobody's flake. */
const cancelled = (name = 'ci', extra = {}) => ({
  name,
  status: 'completed',
  conclusion: 'cancelled',
  startedAt: '2026-08-10T00:00:00Z',
  completedAt: '2026-08-10T00:01:00Z',
  ...extra,
});
const running = (name = 'ci', extra = {}) => ({ name, status: 'in_progress', ...extra });
/** A red check that names the workflow run it is a job of. */
const redOf = (run, name = 'ci', extra = {}) => ({ ...red(name, extra), run });

// -- fake forge over the fixture origin --------------------------------------

function fakeForge(origin, { required = ['ci'], mergeCommitChecks = null } = {}) {
  const state = {
    autoMergeAllowed: true,
    requiredChecks: required,
    armAccepts: true,
    pr: null,
    // Labels the forge accepts on a request, and the ones it holds. With
    // `labelsAccept` off it answers as a repository that defines none.
    labelsAccept: true,
    labels: new Set(),
    labelCalls: [],
    // The labels each create call carried, so a test can say which call
    // labelled the request.
    createLabels: [],
    // The CI secret names the parity read asks for; null is a forge that
    // would not answer at all.
    ciSecrets: [],
    checks: new Map(),
    autoChecks: null,
    onRerun: null,
    reruns: [],
    // Workflow-run states by id, for the checks that name one. A check whose
    // run is not in here belongs to a run that is over — which is what every
    // scenario but the wait scenarios assumes.
    runs: new Map(),
    // A default branch the head does not carry answers as `behindBase`. With
    // this on it answers as `conflicting` instead — the state the forge
    // reports when the two sides touched the same lines — so a scenario picks
    // which of the two routes it drives.
    conflictMode: false,
  };
  const head = (ref) => gitSync(['rev-parse', ref], origin).trim();
  const isAncestor = (a, b) => {
    try {
      gitSync(['merge-base', '--is-ancestor', a, b], origin);
      return true;
    } catch {
      return false;
    }
  };
  // A check run the fixture hands out carries its own id and the sha it sits
  // on, the way the forge's does: the watcher identifies an attempt by that id
  // and the log calls are addressed to the attempt, never to the name.
  let nextCheckId = 900100;
  const withIds = (sha, list) =>
    list.map((run) => ({ sha, ...run, id: run.id == null ? String(nextCheckId++) : String(run.id) }));
  const checksFor = (sha) => {
    if (!state.checks.has(sha) && state.autoChecks) {
      state.checks.set(sha, withIds(sha, state.autoChecks(sha)));
    }
    return state.checks.get(sha) ?? [];
  };
  // The forge merges on the latest attempt at each required name, never on
  // whichever attempt its own list happens to carry first.
  const allRequiredGreen = (sha) =>
    state.requiredChecks.every((name) => {
      const run = checksFor(sha).filter((r) => r.name === name).at(-1);
      return run?.status === 'completed' && ['success', 'neutral', 'skipped'].includes(run.conclusion);
    });
  const doMerge = () => {
    const pr = state.pr;
    pr.headShaAtMerge = head(pr.head);
    gitSync(['merge', '--squash', pr.head], origin);
    gitSync(
      ['-c', 'user.email=f@f', '-c', 'user.name=forge', '-c', 'commit.gpgsign=false', 'commit', '-m', `squash ${pr.head}`],
      origin,
    );
    pr.mergeSha = head('main');
    pr.state = 'merged';
    // Preset the merge sha's checks so autoChecks never leaks onto it.
    state.checks.set(pr.mergeSha, withIds(pr.mergeSha, mergeCommitChecks ?? []));
  };
  return {
    state,
    setChecks: (sha, list) => state.checks.set(sha, withIds(sha, list)),
    adminMerge: () => doMerge(),
    async preflight() {
      return {
        autoMergeAllowed: state.autoMergeAllowed,
        strict: true,
        requiredChecks: state.requiredChecks,
      };
    },
    async openPr({ head: headBranch, base, labels = [] }) {
      const fresh = !state.pr || state.pr.state === 'closed';
      if (fresh) {
        state.pr = { number: 7, head: headBranch, base, armed: false, state: 'open', mergeSha: null };
      }
      // The create carries the labels, the way `gh pr create --label` does. A
      // repository that defines none refuses that create and the adapter opens
      // the request bare, which is the state this leaves behind; a create that
      // found the request already open labelled nothing either.
      const carried = fresh && labels.length > 0 && state.labelsAccept;
      if (carried) {
        state.createLabels.push({ number: state.pr.number, labels: [...labels] });
        for (const label of labels) state.labels.add(label);
      }
      return { number: state.pr.number, url: `fake://pr/${state.pr.number}`, labelled: carried };
    },
    async ciSecrets() {
      return state.ciSecrets;
    },

    async applyLabels(number, labels) {
      state.labelCalls.push({ number, labels: [...labels] });
      if (labels.length === 0) return { applied: [] };
      if (!state.labelsAccept) return { applied: [], reason: 'label not found (fixture)' };
      for (const label of labels) state.labels.add(label);
      return { applied: [...labels] };
    },

    async armAutoMerge() {
      if (!state.armAccepts) return { armed: false, reason: 'refused (fixture)' };
      state.pr.armed = true;
      return { armed: true };
    },
    async prState() {
      const pr = state.pr;
      if (pr.state === 'open' && pr.armed && isAncestor('main', pr.head) && allRequiredGreen(head(pr.head))) {
        doMerge();
      }
      if (pr.state === 'merged') {
        return {
          state: 'merged',
          headSha: pr.headShaAtMerge,
          mergeSha: pr.mergeSha,
          behindBase: false,
          conflicting: false,
          autoMergeArmed: false,
        };
      }
      const behind = !isAncestor('main', pr.head);
      return {
        state: pr.state,
        headSha: head(pr.head),
        mergeSha: null,
        behindBase: state.conflictMode ? false : behind,
        conflicting: state.conflictMode ? behind : false,
        autoMergeArmed: pr.armed,
      };
    },
    async checkRuns(sha) {
      return checksFor(sha);
    },
    async workflowRun(id) {
      return state.runs.get(String(id)) ?? { id: String(id), status: 'completed', conclusion: 'failure' };
    },
    async rerunFailed(sha) {
      state.reruns.push(sha);
      if (state.onRerun) state.onRerun(sha);
      else {
        // A re-run is a fresh attempt: a new check run, with the id and the
        // start time that say it came after the one it replaces.
        state.checks.set(
          sha,
          withIds(
            sha,
            checksFor(sha).map((r) =>
              r.status === 'completed' && r.conclusion !== 'success'
                ? { name: r.name, status: 'queued', startedAt: '2026-08-10T01:00:00Z' }
                : r,
            ),
          ),
        );
      }
    },
    async checkOutput(sha, name) {
      return `log tail of ${name} at ${sha}`;
    },
    // The same answer for the attempt the caller holds. The fixture names the
    // attempt in it, so a test can tell a captured log from a live read.
    async checkLog(run) {
      return `log tail of ${run.name} at ${run.sha} (check run ${run.id})`;
    },
  };
}

// -- fixture machinery (seat children, seeded freeze) ------------------------

function fixtureParse(line) {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    return { cost: parsed.cost, note: parsed.note, meta: parsed.meta };
  } catch {
    return null;
  }
}

function seatScript({ reportPath, model, report, files = {}, exitCode = 0 }) {
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

function furyClean() {
  const seats = {};
  for (const seat of ['fury-spec', 'fury-code-shape', 'fury-operational', 'fury-interface']) {
    seats[seat] = () => ({ report: { findings: [], summary: 'clean' } });
  }
  return seats;
}

/** Seeds the freeze boundary: suite committed, spec written, freeze stamped. */
function seedHandler(seedExtra = null) {
  return async (ctx) => {
    const worktree = ctx.payload.worktree;
    const full = join(worktree, 'tests/feature.test.mjs');
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, STRONG_TEST);
    const sha = await commitAll(worktree, 'suite: seed');
    writeFileSync(join(ctx.paths.runs, ctx.runId, 'spec.md'), '# Spec\n\nf(x) returns 2*x.\n');
    ctx.store.append('freeze', { actor: 'daemon', sha, killCount: 3, amendmentKills: 0 });
    if (seedExtra) await seedExtra(ctx);
    return { next: 'implementation' };
  };
}

const BASE_SEATS = {
  dev: ({ prompt }) => {
    if (prompt.includes('textual conflicts')) {
      return { files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'conflicts resolved' } };
    }
    return { files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } };
  },
  ...furyClean(),
  'card-sweep': () => ({
    files: { 'stories/alpha.md': DEFAULT_CARD + '\n<!-- swept -->\n' },
    report: { updatedCards: ['stories/alpha.md'], invalidated: [], summary: 'swept' },
  }),
  'reconcile-judge': () => ({
    report: { owed: false, records: [], reason: 'no decision-record tree' },
  }),
  learning: () => ({ report: { artifacts: ['/w/lessons/alpha-1.md'], summary: 'a lesson' } }),
};

function shipFixture(
  t,
  {
    seats = {},
    pollMs = 30,
    forgeOpts = {},
    enqueue = false,
    slotCap = 2,
    config = {},
    files = {},
    // Registers the ship-carrying repair lane under the name the console
    // route requires: `--lane repair` is the only lane a ticket and an escape
    // reach, so a test of that route needs the real close-out behind it.
    repairShips = false,
    seedExtra = null,
  } = {},
) {
  const root = tempDir();
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson({
      repo: { testPaths: ['tests'] },
      gates: { tier1: [{ name: 'unit', command: 'suite' }] },
      lanes: { story: { suiteCommand: 'suite' } },
      stack: null,
      ...config,
      commands: { suite: ['node', '--test', 'tests/*.test.mjs'], ...(config.commands ?? {}) },
    }),
    'stories/alpha.md': DEFAULT_CARD,
    'src/base.mjs': 'export const base = 1;\n',
    ...files,
  });
  // The card sweep pushes straight to main; the fixture origin accepts it.
  gitSync(['config', 'receive.denyCurrentBranch', 'updateInstead'], origin);
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { proj: { repoUrl: origin, slotCap } } }) + '\n',
  );
  const forge = fakeForge(origin, forgeOpts);
  const enqueued = [];
  const shipLane = shipStep({
    forgeFor: () => forge,
    pollMs,
    // The production hand-off is the daemon's sweep; the fixture records the
    // call and lets the frontier find the owed work on its own.
    enqueueRepair: enqueue
      ? (info) => {
          enqueued.push(info);
          daemon.frontier.queueSweep(info.project);
        }
      : null,
  });
  const post = postFreeze({ afterVerdict: shipLane });
  const done = { stages: ['done'], handlers: { done: async () => ({ close: { state: 'shipped' } }) } };
  const repairship = {
    stages: ['seed-fix', ...shipLane.stages],
    handlers: {
      'seed-fix': async (ctx) => {
        writeFileSync(join(ctx.payload.worktree, 'src/fix.mjs'), 'export const fixed = true;\n');
        await commitAll(ctx.payload.worktree, 'fix: seed');
        return { next: 'ship' };
      },
      ...shipLane.handlers,
    },
  };
  const lanes = {
    story: { stages: ['seed', ...post.stages], handlers: { seed: seedHandler(seedExtra), ...post.handlers } },
    repair: repairShips ? repairship : repairLane({ afterVerdict: done }),
    repairship,
  };
  const daemon = new Daemon(join(root, 'home'), { lanes });
  const fixture = seatFixture({ ...BASE_SEATS, ...seats });
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  return {
    root,
    origin,
    paths,
    daemon,
    forge,
    enqueued,
    calls: fixture.calls,
    async launch(payload = {}) {
      await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: fixture.commandFor });
      const { runId } = await daemon.launchRun({
        project: 'proj',
        lane: 'story',
        card: 'stories/alpha.md',
        ...payload,
      });
      return runId;
    },
  };
}

async function waitClosed(paths, runId, attempts = 600) {
  try {
    await waitFor(() => existsSync(archivedRunLedgerPath(paths, runId)), {
      label: 'run archived',
      attempts,
      intervalMs: 100,
    });
  } catch (error) {
    const live = runLedgerPath(paths, runId);
    // The heartbeat is the pulse, not the state. A stage that is alive and
    // waiting stamps one every few seconds, so an unfiltered tail is fourteen
    // heartbeats and no answer to what the run is waiting on.
    const tail = existsSync(live)
      ? readEvents(live)
          .filter((e) => e.event !== 'stage-heartbeat')
          .slice(-14)
          .map(
            (e) =>
              `${e.seq} ${e.event} ${e.check ?? e.stage ?? e.seat ?? ''} ` +
              `${e.status ?? e.reason ?? e.verdict ?? e.result ?? ''} ${(e.question ?? '').slice(0, 500)}`,
          )
      : ['no live ledger'];
    error.message += `\nledger tail:\n${tail.join('\n')}`;
    throw error;
  }
  return readEvents(archivedRunLedgerPath(paths, runId));
}

function waitEvent(paths, runId, predicate, label, attempts = 600) {
  return waitFor(() => readEvents(runLedgerPath(paths, runId)).find(predicate), {
    label,
    attempts,
    intervalMs: 100,
  });
}

// The budget the longest journey in this file waits on, at every one of its
// waits. The default holds that run on an idle machine and not on a shared
// runner with the rest of the suite beside it, where each poll also re-reads
// the ledger it grew: the observed timeout was one of these waits at 184
// seconds of wall clock, on a run that was still heartbeating.
const LONGEST_JOURNEY_ATTEMPTS = 1800;

function waitParked(paths, runId, type) {
  return waitEvent(paths, runId, (e) => e.event === 'park' && e.type === type, `park ${type}`);
}

// -- scenarios ---------------------------------------------------------------

test('a fixture PR ships green hands-off with full stamps', async (t) => {
  const fx = shipFixture(t, { forgeOpts: { mergeCommitChecks: [green('post-merge')] } });
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  assert.equal(opened.pr, 7);
  assert.equal(opened.base, 'main');
  assert.deepEqual(opened.required, ['ci']);
  assert.equal(opened.autoMerge, 'squash');
  await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'check-transition' && e.status === 'in_progress',
    'in_progress transition',
  );
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'shipped');
  // the watcher stamped the terminal transition with its duration
  const success = events.find((e) => e.event === 'check-transition' && e.status === 'success');
  assert.equal(success.required, true);
  assert.equal(success.duration, 180000);
  const merged = events.find((e) => e.event === 'merged');
  assert.equal(merged.red, false);
  assert.equal(merged.pr, 7);
  assert.ok(merged.mergeSha);
  // merge-commit checks watched to terminal
  const mcc = events.find((e) => e.event === 'merge-commit-check');
  assert.equal(mcc.check, 'post-merge');
  assert.equal(mcc.status, 'success');
  // the squash merge carries the implementation
  assert.equal(gitSync(['show', 'main:src/feature.mjs'], fx.origin), GOOD_FEATURE);
  // the card sweep ran and pushed straight to main
  const sweep = events.find((e) => e.event === 'card-sweep');
  assert.equal(sweep.ok, true);
  assert.equal(sweep.pushed, true);
  assert.match(gitSync(['show', 'main:stories/alpha.md'], fx.origin), /<!-- swept -->/);
  assert.ok(!events.some((e) => e.event === 'red-merge-breach'));
});

test('the ship stage beats while it waits, once per batch of poll outcomes', async (t) => {
  // The stage runs no seat, so before the heartbeat its ledger read the same
  // after one poll as after a thousand.
  const fx = shipFixture(t, { pollMs: 5 });
  fx.forge.state.autoChecks = () => [running()];
  let polls = 0;
  const forgeChecks = fx.forge.checkRuns;
  fx.forge.checkRuns = async (sha) => {
    polls += 1;
    return forgeChecks(sha);
  };
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  await waitFor(
    () => readEvents(runLedgerPath(fx.paths, runId)).filter((e) => e.event === 'stage-heartbeat').length >= 2,
    { label: 'two heartbeats', attempts: 600, intervalMs: 50 },
  );
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const stamps = events.filter((e) => e.event === 'stage-heartbeat');
  const waiting = stamps.filter((e) => e.stage === 'ship');
  assert.ok(waiting.length >= 2);
  assert.equal(waiting[0].waitingOn, 'checks');
  assert.equal(waiting[0].detail.pr, opened.pr);
  assert.equal(waiting[0].polls, BEATS_PER_STAMP);
  assert.equal(waiting[1].polls, 2 * BEATS_PER_STAMP);
  assert.ok(waiting[1].elapsed >= waiting[0].elapsed);
  // Low volume by construction: every stamp stands for a whole batch of reads.
  assert.ok(
    stamps.length * BEATS_PER_STAMP <= polls,
    `${stamps.length} stamps over ${polls} polls`,
  );
});

test('an owed judgment writes the reconciliation ticket the sweep derives from', async (t) => {
  const fx = shipFixture(t, {
    seats: {
      'reconcile-judge': () => ({
        report: {
          owed: true,
          records: ['docs/adr/0001-doubling.md'],
          reason: 'the diff implements the doubling decision',
        },
      }),
    },
  });
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const judged = events.find((e) => e.event === 'reconciliation-judged');
  assert.equal(judged.ok, true);
  assert.equal(judged.owed, true);
  assert.deepEqual(judged.records, ['docs/adr/0001-doubling.md']);
  assert.equal(judged.ticket, reconcileTicketPath(fx.paths, runId));
  // Ticket before stamp: a stamped judgment always has a ticket to launch from.
  const ticket = readFileSync(judged.ticket, 'utf8');
  assert.match(ticket, /docs\/adr\/0001-doubling\.md/);
  assert.match(ticket, /never\s+absorbed silently/);
  // The frontier derives the owed reconciliation and its launch payload.
  const owed = owedReconciliations(fx.paths, 'proj');
  assert.equal(owed.length, 1);
  assert.equal(owed[0].runId, runId);
  assert.deepEqual(reconciliationLaunch(owed[0]), {
    project: 'proj',
    lane: 'repair',
    ticket: judged.ticket,
    reconcilesRunId: runId,
  });
});

test('a not-owed judgment stamps its reason and derives nothing', async (t) => {
  const fx = shipFixture(t);
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  const judged = events.find((e) => e.event === 'reconciliation-judged');
  assert.equal(judged.ok, true);
  assert.equal(judged.owed, false);
  assert.equal(judged.reason, 'no decision-record tree');
  assert.ok(!existsSync(reconcileTicketPath(fx.paths, runId)));
  assert.deepEqual(owedReconciliations(fx.paths, 'proj'), []);
});

test('a failed judgment is a recorded miss; the story ships regardless', async (t) => {
  const fx = shipFixture(t, { seats: { 'reconcile-judge': () => ({ exitCode: 3 }) } });
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const judged = events.find((e) => e.event === 'reconciliation-judged');
  assert.equal(judged.ok, false);
  assert.equal(judged.cause, 'seat-failure');
  assert.ok(!existsSync(reconcileTicketPath(fx.paths, runId)));
  assert.deepEqual(owedReconciliations(fx.paths, 'proj'), []);
});

// -- the close-out learning artifact (ADR-0031) ------------------------------

const INSTRUCTIONS = 'Keep one lesson file per story. Write for a human.\n';

/**
 * An instructions file and a workspace directory for the learning close-out.
 * `write: false` leaves the instructions file absent — the unreadable case.
 */
function learningSetup(t, { write = true } = {}) {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const instructions = join(dir, 'teach.md');
  if (write) writeFileSync(instructions, INSTRUCTIONS);
  const workspace = join(dir, 'workspace');
  return {
    instructions,
    workspace,
    config: { closeout: { learning: { instructions, workspace } } },
  };
}

async function shipGreen(fx) {
  fx.forge.state.autoChecks = () => [green()];
  const runId = await fx.launch();
  return { runId, events: await waitClosed(fx.paths, runId) };
}

test('the configured close-out seat carries the instructions and the workspace', async (t) => {
  const learning = learningSetup(t);
  const fx = shipFixture(t, { config: learning.config });
  const { runId, events } = await shipGreen(fx);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const lesson = events.find((e) => e.event === 'learning-lesson');
  assert.equal(lesson.ok, true);
  assert.deepEqual(lesson.artifacts, ['/w/lessons/alpha-1.md']);
  // The workspace is the seat's, and the harness creates it when it is absent.
  assert.ok(existsSync(learning.workspace));
  // The seat runs last, on the shipped facts: the instructions are its
  // conduct, and the merge commit, the PR and the card key are its inputs.
  const judged = events.find((e) => e.event === 'reconciliation-judged');
  assert.ok(judged.seq < lesson.seq);
  const call = fx.calls.find((c) => c.seat === 'learning');
  assert.ok(call.prompt.includes(INSTRUCTIONS.trim()));
  assert.ok(call.prompt.includes(learning.workspace));
  assert.ok(call.prompt.includes(events.find((e) => e.event === 'merged').mergeSha));
  assert.ok(call.prompt.includes('#7'));
  assert.ok(call.prompt.includes('alpha-1'));
  assert.ok(call.prompt.includes(join(fx.paths.runs, runId, 'spec.md')));
});

test('an unconfigured project runs the close-out it always ran', async (t) => {
  const fx = shipFixture(t);
  const { events } = await shipGreen(fx);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'learning-lesson'));
  assert.ok(!fx.calls.some((c) => c.seat === 'learning'));
});

test('unreadable instructions stamp the miss; the close proceeds untouched', async (t) => {
  const learning = learningSetup(t, { write: false });
  const fx = shipFixture(t, { config: learning.config });
  const { events } = await shipGreen(fx);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const lesson = events.find((e) => e.event === 'learning-lesson');
  assert.equal(lesson.ok, false);
  assert.match(lesson.reason, /^instructions: /);
  assert.ok(!fx.calls.some((c) => c.seat === 'learning'));
  assert.ok(!events.some((e) => e.event === 'park'));
  assert.deepEqual(openLoud(fx.paths), []);
});

test('a failed learning seat is a quiet miss; the story ships regardless', async (t) => {
  const learning = learningSetup(t);
  const fx = shipFixture(t, {
    config: learning.config,
    seats: { learning: () => ({ exitCode: 3 }) },
  });
  const { events } = await shipGreen(fx);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const lesson = events.find((e) => e.event === 'learning-lesson');
  assert.equal(lesson.ok, false);
  assert.equal(lesson.reason, 'seat-failure');
  // One attempt: the seat's own crash allowance is all it gets, and no park,
  // no loud item and no retry of the lesson itself follows.
  assert.equal(events.filter((e) => e.event === 'learning-lesson').length, 1);
  assert.ok(!events.some((e) => e.event === 'park'));
  assert.deepEqual(openLoud(fx.paths), []);
});

test('a repair-lane ship writes no lesson', async (t) => {
  const learning = learningSetup(t);
  const fx = shipFixture(t, { config: learning.config });
  fx.forge.state.autoChecks = () => [green()];
  await fx.daemon.start();
  fx.daemon.engine.seatDefaults = () => ({ commandFor: seatFixture(BASE_SEATS).commandFor });
  const { runId } = await fx.daemon.launchRun({
    project: 'proj',
    lane: 'repairship',
    ticket: 'docs/fix.md',
  });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'learning-lesson'));
  assert.ok(!existsSync(learning.workspace));
});

test('one failed-jobs re-run turns the check green: a ci-flake, never a finding', async (t) => {
  const fx = shipFixture(t);
  let first = true;
  fx.forge.state.autoChecks = () => {
    if (first) {
      first = false;
      return [red()];
    }
    return [green()];
  };
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [green()]);
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const rerun = events.find((e) => e.event === 'check-transition' && e.status === 'rerun-requested');
  assert.equal(rerun.check, 'ci');
  const flake = events.find((e) => e.event === 'ci-flake');
  assert.equal(flake.check, 'ci');
  assert.equal(fx.forge.state.reruns.length, 1);
  assert.ok(!events.some((e) => e.event === 'verdict-rendered' && e.source === 'ci'));
  assert.ok(!events.some((e) => e.event === 'finding'));
});

test('persistent CI reds enter the shared triage and the repair route', async (t) => {
  const fx = shipFixture(t, {
    seats: {
      'verdict-triage': ({ prompt }) => {
        const layers = [...prompt.matchAll(/^- layer (\S+):$/gm)].map((m) => m[1]);
        return {
          report: {
            findings: layers.map((layer) => ({
              class: 'code-defect',
              layers: [layer],
              summary: `broken ${layer}`,
              evidence: `red output of ${layer}`,
            })),
            persisting: [],
            summary: 'triaged',
          },
        };
      },
      'repair-dev': () => ({
        files: { 'src/fix-note.mjs': 'export const note = 1;\n' },
        report: { summary: 'repaired' },
      }),
      'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
    },
  });
  let shas = 0;
  fx.forge.state.autoChecks = () => (++shas === 1 ? [red()] : [green()]);
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [red()]);
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // the CI verdict rendered red with the triaged finding
  const ciRender = events.find((e) => e.event === 'verdict-rendered' && e.source === 'ci');
  assert.equal(ciRender.verdict, 'red');
  assert.equal(ciRender.open.length, 1);
  const finding = events.find((e) => e.event === 'finding');
  assert.equal(finding.class, 'code-defect');
  assert.deepEqual(finding.layers, ['ci:ci']);
  // the shared route: a repair round on the candidate tree, then green
  assert.ok(events.some((e) => e.event === 'repair-round'));
  assert.ok(
    events.some((e) => e.event === 'implementation-committed' && e.phase === 'repair'),
  );
  const merged = events.find((e) => e.event === 'merged');
  assert.equal(merged.red, false);
  assert.ok(!events.some((e) => e.event === 'ci-flake'));
});

/** A triage behavior that classes the red CI layers into the given classes. */
function ciTriageSeat(classes) {
  return ({ prompt }) => {
    const layers = [...prompt.matchAll(/^- layer (\S+):$/gm)].map((m) => m[1]);
    return {
      report: {
        findings: layers.flatMap((layer) =>
          classes.map((cls) => ({
            class: cls,
            layers: [layer],
            summary: `${cls} on ${layer}`,
            evidence: `red output of ${layer}`,
          })),
        ),
        persisting: [],
        summary: 'triaged',
      },
    };
  };
}

test('env-only CI findings skip the local sweep: the fix goes back for the re-run', async (t) => {
  const fx = shipFixture(t, { seats: { 'verdict-triage': ciTriageSeat(['env']) } });
  fx.forge.state.autoChecks = () => [red()];
  let reruns = 0;
  // The first re-run leaves the check red — the credential is still stale, so
  // the red is persistent and triage classes it. The operational fix earns
  // the second re-run, which is green.
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [++reruns === 1 ? red() : green()]);
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const finding = events.find((e) => e.event === 'finding');
  assert.equal(finding.class, 'env');
  // the skip, stamped: which findings, and why no cycle ran
  const fix = events.find((e) => e.event === 'operational-fix');
  assert.equal(fix.sweep, 'skipped');
  assert.deepEqual(fix.findings, [finding.id]);
  assert.match(fix.note, /env or harness class/);
  // no local cycle behind the fix: the spectrum ran once, for the candidate
  assert.deepEqual(
    [...new Set(events.filter((e) => e.event === 'layer-result').map((e) => e.cycle))],
    [1],
  );
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 2);
  assert.equal(fx.forge.state.reruns.length, 2);
});

test('an env and harness CI verdict skips the local sweep on both classes', async (t) => {
  // A harness finding's remedy is forge metadata, which sits outside the tree
  // exactly like the substrate the env finding names. No local layer tests
  // either, so the mixed set takes the same route as the env-only one.
  const fx = shipFixture(t, { seats: { 'verdict-triage': ciTriageSeat(['env', 'harness']) } });
  fx.forge.state.autoChecks = () => [red()];
  let reruns = 0;
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [++reruns === 1 ? red() : green()]);
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const findings = events.filter((e) => e.event === 'finding');
  assert.deepEqual(
    findings.map((e) => e.class).sort(),
    ['env', 'harness'],
  );
  const fix = events.find((e) => e.event === 'operational-fix');
  assert.equal(fix.sweep, 'skipped');
  assert.deepEqual(
    [...fix.findings].sort(),
    findings.map((e) => e.id).sort(),
  );
  assert.match(fix.note, /env or harness class/);
  // no local cycle behind the fix: the spectrum ran once, for the candidate
  assert.deepEqual(
    [...new Set(events.filter((e) => e.event === 'layer-result').map((e) => e.cycle))],
    [1],
  );
  assert.equal(fx.forge.state.reruns.length, 2);
});

test('a CI cycle that repeats itself parks after one retry, never a seventh time', async (t) => {
  // The observed loop: the fix is stamped, the re-run it grants comes back red
  // on the same head, triage raises the same defect under a fresh id, and the
  // ladder stamps the fix again. Nothing in that sequence ends it — six cycles
  // ran and a human's empty commit stopped them. The fingerprint ends it here.
  const fx = shipFixture(t, { seats: { 'verdict-triage': ciTriageSeat(['env']) } });
  fx.forge.state.autoChecks = () => [red()];
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [red()]);
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'cycle-repeat');
  const live = readEvents(runLedgerPath(fx.paths, runId));
  const ci = live.filter((e) => e.event === 'verdict-rendered' && e.source === 'ci');
  // Three CI cycles: the first, the repeat that spent the retry, and the one
  // the retry did not move.
  assert.equal(ci.length, 3);
  // Every one of them judged the same head sha and the same defect, under a
  // fresh finding id each time — which is why the identity, and not the id, is
  // what the fingerprint holds.
  assert.equal(new Set(ci.map((e) => e.sha)).size, 1);
  assert.equal(new Set(ci.flatMap((e) => e.open)).size, 3);
  const retries = live.filter((e) => e.event === 'cycle-retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].render, ci[1].seq);
  assert.equal(park.detail.fingerprint, retries[0].fingerprint);
  // The evidence the owner reads: both earlier occurrences, beside this one.
  assert.deepEqual(
    park.detail.occurrences.map((o) => o.seq),
    ci.map((e) => e.seq),
  );
  assert.ok(park.question.includes(park.detail.fingerprint));
  assert.deepEqual(park.answers.options, ['retry', 'abandon']);
  // A park, never a kill: the run holds its work until the owner answers.
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const events = await waitClosed(fx.paths, runId);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'cycle-repeat');
});

test('the third flake on one check and one head sha ends the re-runs, loudly', async (t) => {
  // The observed loop: one required check answering both ways on a head sha
  // that never moves, a green after every re-run, and an env-classed triage
  // stamping the operational fix that grants the next one. Nothing in that
  // sequence ends it — one run took 33 turns of it and merged red.
  const fx = shipFixture(t, {
    forgeOpts: { required: ['ci', 'hold'] },
    seats: { 'verdict-triage': ciTriageSeat(['env']) },
  });
  // `hold` never completes, so the request never merges while the other check
  // flaps: the state the incident sat in for the whole of its 33 turns.
  let reads = 0;
  const forgeChecks = fx.forge.checkRuns;
  fx.forge.checkRuns = async (sha) => {
    const list = await forgeChecks(sha);
    if (!list.some((r) => r.name === 'ci')) return list;
    return [++reads % 2 === 1 ? red() : green(), running('hold')];
  };
  fx.forge.state.autoChecks = () => [red(), running('hold')];
  const runId = await fx.launch();
  await waitParked(fx.paths, runId, 'cycle-repeat');
  const live = readEvents(runLedgerPath(fx.paths, runId));
  // Three flakes on the pair, and the third is the last: the greens after it
  // are the same answer, and classifying them again is how one broken check
  // writes a thousand ledger lines.
  const flakes = live.filter((e) => e.event === 'ci-flake');
  assert.equal(flakes.length, FLAKE_LIMIT);
  assert.equal(new Set(flakes.map((e) => `${e.check}@${e.sha}`)).size, 1);
  const record = live.find((e) => e.event === 'gate-integrity' && e.kind === 'deterministic-red');
  assert.equal(record.check, 'ci');
  assert.equal(record.sha, flakes[0].sha);
  assert.equal(record.flakes, FLAKE_LIMIT);
  assert.equal(record.pr, 7);
  assert.equal(record.seq > flakes.at(-1).seq, true);
  // The stop is the classification and not an empty budget: fixes were stamped
  // behind the record, each one a grant the check would have spent before.
  const after = (event, extra = () => true) =>
    live.filter((e) => e.event === event && e.seq > record.seq && extra(e));
  assert.ok(after('operational-fix').length > 0);
  assert.equal(after('check-transition', (e) => e.status === 'rerun-requested').length, 0);
  // The watcher keeps stamping what it sees. Only the reading was withdrawn.
  assert.ok(after('check-transition', (e) => e.check === 'ci').length > 0);
  // The record asks a human to go and look, so nothing in the run answers it —
  // the close of the run it reported on included.
  const lit = () => openLoud(fx.paths).some((e) => e.seq === record.seq && e.gist === record.gist);
  assert.ok(lit());
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'failed');
  assert.ok(lit());
});

test('a mixed CI verdict keeps the local sweep: the repair round is judged', async (t) => {
  const fx = shipFixture(t, {
    seats: {
      'verdict-triage': ciTriageSeat(['env', 'code-defect']),
      'repair-dev': () => ({
        files: { 'src/fix-note.mjs': 'export const note = 1;\n' },
        report: { summary: 'repaired' },
      }),
      'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
    },
  });
  let shas = 0;
  fx.forge.state.autoChecks = () => (++shas === 1 ? [red()] : [green()]);
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [red()]);
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const classes = events.filter((e) => e.event === 'finding').map((e) => e.class);
  assert.deepEqual(classes.sort(), ['code-defect', 'env']);
  // the env finding still takes its operational fix, and the sweep stands
  const fix = events.find((e) => e.event === 'operational-fix');
  assert.equal(fix.sweep, undefined);
  assert.ok(events.some((e) => e.event === 'repair-round'));
  const cycles = new Set(events.filter((e) => e.event === 'layer-result').map((e) => e.cycle));
  assert.ok(cycles.has(3), `the repair round was judged: cycles ${[...cycles]}`);
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').at(-1).verdict, 'green');
});

// -- triage waits for the workflow run to finish -----------------------------

/** The seats a CI red needs to reach triage and ship the repair behind it. */
const CI_REPAIR_SEATS = {
  'verdict-triage': ciTriageSeat(['code-defect']),
  'repair-dev': () => ({
    files: { 'src/fix-note.mjs': 'export const note = 1;\n' },
    report: { summary: 'repaired' },
  }),
  'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
};

test('a red check on a workflow run still executing never reaches triage', async (t) => {
  // The check is one job of the run. It went red while the rest of the run
  // carried on writing the log the triage would have read.
  const fx = shipFixture(t, { pollMs: 5, seats: CI_REPAIR_SEATS });
  fx.forge.state.autoChecks = () => [redOf('900')];
  fx.forge.state.runs.set('900', { id: '900', status: 'in_progress', conclusion: null });
  let polls = 0;
  const forgeChecks = fx.forge.checkRuns;
  fx.forge.checkRuns = async (sha) => {
    polls += 1;
    return forgeChecks(sha);
  };
  const runId = await fx.launch();
  const wait = await waitEvent(fx.paths, runId, (e) => e.event === 'triage-wait', 'triage-wait');
  assert.equal(wait.run, '900');
  assert.equal(wait.status, 'in_progress');
  assert.deepEqual(wait.checks, ['ci']);
  const reached = polls;
  await waitFor(() => polls >= reached + 30, {
    label: 'thirty more poll outcomes',
    attempts: 600,
    intervalMs: 20,
  });
  const live = readEvents(runLedgerPath(fx.paths, runId));
  // One stamp for the wait, whatever the poll count behind it.
  assert.equal(live.filter((e) => e.event === 'triage-wait').length, 1);
  // Nothing the watcher does to a red was done: no triage, and no re-run of
  // jobs the run still holds.
  assert.ok(!live.some((e) => e.event === 'verdict-rendered' && e.source === 'ci'));
  assert.ok(!live.some((e) => e.event === 'check-transition' && e.status === 'rerun-requested'));
  assert.equal(fx.forge.state.reruns.length, 0);
});

test('the dispatch comes on the first poll after the workflow run goes terminal', async (t) => {
  const fx = shipFixture(t, { seats: CI_REPAIR_SEATS });
  let shas = 0;
  fx.forge.state.autoChecks = () => (++shas === 1 ? [redOf('900')] : [green()]);
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [redOf('900')]);
  fx.forge.state.runs.set('900', { id: '900', status: 'in_progress', conclusion: null });
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'triage-wait', 'triage-wait');
  assert.equal(fx.forge.state.reruns.length, 0);
  fx.forge.state.runs.set('900', { id: '900', status: 'completed', conclusion: 'failure' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const ciRender = events.find((e) => e.event === 'verdict-rendered' && e.source === 'ci');
  assert.equal(ciRender.verdict, 'red');
  // The verdict says how long the watcher held it back, at the one moment the
  // span is known.
  assert.ok(Number.isInteger(ciRender.waited), `the CI verdict carries the wait: ${ciRender.waited}`);
  assert.equal(events.filter((e) => e.event === 'triage-wait').length, 1);
  assert.equal(fx.forge.state.reruns.length, 1);
});

test('a red check on a workflow run that finished dispatches with no wait at all', async (t) => {
  const fx = shipFixture(t, { seats: CI_REPAIR_SEATS });
  let shas = 0;
  fx.forge.state.autoChecks = () => (++shas === 1 ? [redOf('900')] : [green()]);
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [redOf('900')]);
  fx.forge.state.runs.set('900', { id: '900', status: 'completed', conclusion: 'failure' });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const ciRender = events.find((e) => e.event === 'verdict-rendered' && e.source === 'ci');
  assert.equal(ciRender.verdict, 'red');
  assert.equal(ciRender.waited, undefined);
  assert.ok(!events.some((e) => e.event === 'triage-wait'));
  const finding = events.find((e) => e.event === 'finding');
  assert.deepEqual(finding.layers, ['ci:ci']);
});

test('a workflow run the forge will not answer for holds the dispatch too', async (t) => {
  // The bar is the run's own report of a completed status. A read nobody
  // could make is not that report, and the log behind it is exactly as
  // partial as the log of a run that said it was still executing.
  const fx = shipFixture(t, { pollMs: 5, seats: CI_REPAIR_SEATS });
  fx.forge.state.autoChecks = () => [redOf('900')];
  fx.forge.workflowRun = async () => null;
  const runId = await fx.launch();
  const wait = await waitEvent(fx.paths, runId, (e) => e.event === 'triage-wait', 'triage-wait');
  assert.equal(wait.run, '900');
  assert.equal(wait.status, 'unreadable');
  const live = readEvents(runLedgerPath(fx.paths, runId));
  assert.ok(!live.some((e) => e.event === 'verdict-rendered' && e.source === 'ci'));
  assert.equal(fx.forge.state.reruns.length, 0);
});

test('no log is asked for until the run state was read right before it', async (t) => {
  // The watcher's hold keeps an ordinary CI race cheap, and it is one caller
  // up from the call that can produce the wrong answer. This pins the gate at
  // every read of a log: the run state is read again immediately before the
  // first one, so no route in here can take a partial log.
  const fx = shipFixture(t, { seats: CI_REPAIR_SEATS });
  let shas = 0;
  fx.forge.state.autoChecks = () => (++shas === 1 ? [redOf('900')] : [green()]);
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [redOf('900')]);
  const calls = [];
  const { workflowRun, checkOutput, checkLog } = fx.forge;
  fx.forge.workflowRun = async (id) => {
    calls.push(`workflowRun:${id}`);
    return workflowRun(id);
  };
  fx.forge.checkOutput = async (sha, name) => {
    calls.push(`checkOutput:${name}`);
    return checkOutput(sha, name);
  };
  fx.forge.checkLog = async (run) => {
    calls.push(`checkLog:${run.name}`);
    return checkLog(run);
  };
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const first = calls.findIndex((c) => c.startsWith('checkOutput') || c.startsWith('checkLog'));
  assert.ok(first > 0, 'a log was asked for');
  assert.equal(calls[first], 'checkLog:ci');
  assert.equal(calls[first - 1], 'workflowRun:900');
});

// -- the log the forge would not serve ---------------------------------------

test('a triage the forge served no log to stamps the closed kind, once', async (t) => {
  const fx = shipFixture(t, { seats: CI_REPAIR_SEATS });
  let shas = 0;
  fx.forge.state.autoChecks = () => (++shas === 1 ? [redOf('900')] : [green()]);
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [redOf('900')]);
  // The forge's own shape for an answer that is a reason and not a log. Both
  // reads answer with it: a forge that will not serve a log will not serve it
  // to the capture either, so nothing lands on disk for the triage to read.
  const absence = '(no failure log for ci: the forge would not read job 42: it answered with nothing)';
  fx.forge.checkOutput = async () => absence;
  fx.forge.checkLog = async () => absence;
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const missing = events.filter(
    (e) => e.event === 'gate-integrity' && e.kind === 'triage-log-missing',
  );
  // One record per check on one sha, whatever the poll count behind it.
  assert.equal(missing.length, 1);
  assert.equal(missing[0].check, 'ci');
  assert.equal(missing[0].detail, 'the forge would not read job 42: it answered with nothing');
  assert.equal(missing[0].sha, events.find((e) => e.event === 'pr-opened').sha);
  // The reason still travels to the seat: a triage told why the evidence is
  // absent judges the red better than one told nothing at all.
  const prompt = fx.calls.find((c) => c.seat === 'verdict-triage')?.prompt;
  assert.ok(prompt?.includes(absence), 'the reason reached the triage seat');
  // Nothing in a ledger answers a log that is gone: the record stays open.
  assert.ok(!events.some((e) => e.event === 'resolved' && e.resolves === missing[0].seq));
  assert.match(readFileSync(fx.paths.loudStream, 'utf8'), /no CI failure log for ci/);
});

// -- the automatic-rerun budget, per (run, finding) --------------------------

test('a cancelled check nobody replaces earns no re-run, and escalates at the bound', async (t) => {
  // A cancel is somebody stopping the work. Re-running it is the harness
  // deciding the opposite, and a fresh red manufactured that way used to read
  // as a fresh entitlement. The watcher waits for the attempt that answers,
  // and this cancel never gets one.
  const fx = shipFixture(t, { pollMs: 5, seats: CI_REPAIR_SEATS });
  let shas = 0;
  fx.forge.state.autoChecks = () => (++shas === 1 ? [cancelled()] : [green()]);
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(fx.forge.state.reruns.length, 0);
  assert.ok(!events.some((e) => e.event === 'check-transition' && e.status === 'rerun-requested'));
  // The cancel took the escalation once the bound was spent: the shared triage.
  assert.equal(
    events.find((e) => e.event === 'check-transition' && e.status === 'cancelled').required,
    true,
  );
  const ciRender = events.find((e) => e.event === 'verdict-rendered' && e.source === 'ci');
  assert.equal(ciRender.verdict, 'red');
  assert.ok(!events.some((e) => e.event === 'ci-flake'));
  // The stopped attempt is on disk with the rest of them: one capture, and its
  // log taken at the escalation.
  const evidence = events.filter((e) => e.event === 'ci-evidence');
  assert.equal(new Set(evidence.map((e) => e.checkRunId)).size, 1);
  assert.equal(evidence[0].state, 'cancelled');
});

// -- captured CI evidence ----------------------------------------------------

/**
 * A captured directory after the close. The stamp names where the capture was
 * written, and a closed run's directory travels to the archive whole, so the
 * evidence is at the same place under the archive root.
 */
function archivedDir(fx, dir) {
  assert.ok(dir.startsWith(fx.paths.runs), `the capture is inside the run: ${dir}`);
  return join(fx.paths.archivedRuns, dir.slice(fx.paths.runs.length + 1));
}

test('the authoritative run of a name is the latest attempt, whatever the list order', () => {
  const early = red('ci', { id: '10', startedAt: '2026-08-10T00:00:00Z' });
  const late = green('ci', { id: '11', startedAt: '2026-08-10T01:00:00Z' });
  for (const list of [
    [early, late],
    [late, early],
  ]) {
    const byName = checksByName(list);
    assert.equal(byName.size, 1);
    assert.equal(byName.get('ci').id, '11');
    assert.equal(byName.get('ci').conclusion, 'success');
    assert.equal(byName.get('ci').attempt, 2);
  }
});

test('attempts that started together are ordered by the id minted last', () => {
  const first = red('ci', { id: '10' });
  const second = green('ci', { id: '9' });
  assert.equal(checksByName([first, second]).get('ci').id, '10');
  assert.equal(checksByName([second, first]).get('ci').id, '10');
});

test('a forge that names no check-run id leaves one identity per name', () => {
  const byName = checksByName([red('ci'), red('lint')]);
  assert.deepEqual([...byName.keys()].sort(), ['ci', 'lint']);
  assert.equal(byName.get('ci').attempt, 1);
  assert.equal(byName.get('ci').id, undefined);
});

test('a required name with two attempts is read on the later one', async (t) => {
  // The measured defect: one check name carried success 59 times, failure 35
  // and skipped 31, and the required set was resolved with `runs.find(name)`.
  // The stale green is listed first here, which is the order that used to ship
  // this request with a red required check on its head.
  const stale = green('ci', { id: '10', startedAt: '2026-08-10T00:00:00Z' });
  const latest = redOf('900', 'ci', { id: '11', startedAt: '2026-08-10T01:00:00Z' });
  // The re-run is a third attempt, red again: a re-run always mints a check
  // run of its own, and the stale green is still listed under the same name.
  const rerun = redOf('900', 'ci', { id: '12', startedAt: '2026-08-10T02:00:00Z' });
  const fx = shipFixture(t, { seats: CI_REPAIR_SEATS });
  let shas = 0;
  fx.forge.state.autoChecks = () => (++shas === 1 ? [stale, latest] : [green()]);
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [stale, latest, rerun]);
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const opened = events.find((e) => e.event === 'pr-opened');
  const ci = events.find((e) => e.event === 'verdict-rendered' && e.source === 'ci');
  assert.ok(ci, 'the later attempt decided the read');
  // One attempt per name reaches the ledger, and it is the one that answered.
  // The stale green is listed on every poll and stamps nothing at all.
  const stamped = events.filter(
    (e) => e.event === 'check-transition' && e.sha === opened.sha && e.status !== 'rerun-requested',
  );
  assert.deepEqual([...new Set(stamped.map((e) => e.status))], ['failure']);
  assert.deepEqual([...new Set(stamped.map((e) => e.checkRunId))], ['11', '12']);
  assert.deepEqual(
    stamped.map((e) => e.attempt),
    [2, 3],
  );
});

test('the failing attempt is captured before anything classifies it', async (t) => {
  const fx = shipFixture(t, { seats: CI_REPAIR_SEATS });
  let shas = 0;
  fx.forge.state.autoChecks = () => (++shas === 1 ? [redOf('900')] : [green()]);
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [redOf('900')]);
  // What the forge still holds once the attempt is gone, and what the attempt
  // itself said. Only the capture can carry the second one to the triage.
  const live = 'the workflow run was cancelled';
  fx.forge.checkOutput = async () => live;
  fx.forge.checkLog = async (run) => `assertion failed in ${run.name} (check run ${run.id})`;
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const opened = events.find((e) => e.event === 'pr-opened');
  const evidence = events.filter((e) => e.event === 'ci-evidence');
  // Two attempts, two stamps each: the metadata at the observation, the log at
  // the poll the workflow run reported itself over.
  const attempts = [...new Set(evidence.map((e) => e.checkRunId))];
  assert.equal(attempts.length, 2);
  assert.equal(evidence.length, 4);
  for (const id of attempts) {
    const [first, second] = evidence.filter((e) => e.checkRunId === id);
    assert.equal(first.log, 'pending');
    assert.equal(first.state, 'red');
    assert.equal(first.sha, opened.sha);
    assert.equal(second.log, 'captured');
    assert.ok(second.bytes > 0);
    // The capture archived with the run that judged on it.
    const kept = archivedDir(fx, second.dir);
    assert.equal(readAt(kept, 'log.txt'), `assertion failed in ci (check run ${id})`);
    const meta = JSON.parse(readAt(kept, 'check-run.json'));
    assert.equal(meta.checkRunId, id);
    assert.equal(meta.workflowRun, '900');
    assert.equal(meta.conclusion, 'failure');
    // The capture is before the stamp a reader classifies on.
    const stamp = events.find(
      (e) => e.event === 'check-transition' && e.checkRunId === id && e.status === 'failure',
    );
    assert.ok(first.seq < stamp.seq, 'the evidence precedes the transition');
  }
  // ... and before the re-run that replaces the attempt on the forge.
  const rerun = events.find((e) => e.event === 'check-transition' && e.status === 'rerun-requested');
  assert.ok(evidence.find((e) => e.log === 'captured').seq < rerun.seq);
  // The triage judged the failure, not what the forge held afterwards.
  const prompt = fx.calls.find((c) => c.seat === 'verdict-triage')?.prompt;
  assert.ok(prompt?.includes('assertion failed in ci'), 'the capture reached the seat');
  assert.ok(!prompt?.includes(live), 'the live answer was never asked for');
});

test('one attempt is captured once, whatever the poll count over it', async (t) => {
  // The flapping check of the deterministic-red incident, on one head sha: the
  // watcher reads it dozens of times and the evidence is written twice, because
  // the second observation of one check run is the same piece of news.
  const fx = shipFixture(t, {
    pollMs: 5,
    forgeOpts: { required: ['ci', 'hold'] },
    seats: { 'verdict-triage': ciTriageSeat(['env']) },
  });
  let reads = 0;
  const forgeChecks = fx.forge.checkRuns;
  fx.forge.checkRuns = async (sha) => {
    const list = await forgeChecks(sha);
    if (!list.some((r) => r.name === 'ci')) return list;
    return [++reads % 2 === 1 ? red('ci', { id: '77' }) : green('ci', { id: '77' }), running('hold')];
  };
  fx.forge.state.autoChecks = () => [red(), running('hold')];
  const runId = await fx.launch();
  await waitParked(fx.paths, runId, 'cycle-repeat');
  const live = readEvents(runLedgerPath(fx.paths, runId));
  const evidence = live.filter((e) => e.event === 'ci-evidence' && e.check === 'ci');
  assert.equal(evidence.length, 2);
  assert.deepEqual(
    evidence.map((e) => e.log),
    ['pending', 'captured'],
  );
  assert.ok(reads > 4, `the check was read many times: ${reads}`);
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  await waitClosed(fx.paths, runId);
});

test('a cancel a later attempt answers green mints no flake and no CI verdict', async (t) => {
  // The measured flood: one head sha with 36 cancels and 34 successes on it.
  // Read as a red, every cancel-then-green pair is the shape of a flake.
  const fx = shipFixture(t, { pollMs: 5 });
  const stopped = cancelled('ci', { id: '10', startedAt: '2026-08-10T00:00:00Z' });
  const answered = green('ci', { id: '11', startedAt: '2026-08-10T01:00:00Z' });
  fx.forge.state.autoChecks = () => [stopped];
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'check-transition' && e.status === 'cancelled',
    'the cancel observed',
  );
  fx.forge.setChecks(opened.sha, [stopped, answered]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(fx.forge.state.reruns.length, 0);
  assert.ok(!events.some((e) => e.event === 'ci-flake'));
  assert.ok(!events.some((e) => e.event === 'gate-integrity' && e.kind === 'deterministic-red'));
  assert.ok(!events.some((e) => e.event === 'verdict-rendered' && e.source === 'ci'));
  assert.equal(events.find((e) => e.event === 'merged').red, false);
  // The cancel was still captured, and its state is its own word.
  const evidence = events.filter((e) => e.event === 'ci-evidence');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].state, 'cancelled');
  assert.equal(evidence[0].log, 'pending');
  const meta = JSON.parse(readAt(archivedDir(fx, evidence[0].dir), 'check-run.json'));
  assert.equal(meta.conclusion, 'cancelled');
  assert.equal(meta.checkRunId, '10');
});

test('the same finding across CI cycles spends one automatic re-run in all', async (t) => {
  // The repair moves the head, and the head the repair produced is red on the
  // same required check. The budget belongs to the run and the finding, so the
  // new head buys no second re-run.
  const fx = shipFixture(t, {
    seats: {
      ...CI_REPAIR_SEATS,
      // One file per invocation: two rounds that write the same bytes would
      // leave the second with nothing to commit.
      'repair-dev': ({ label }) => ({
        files: { [`src/fix-${label}.mjs`]: 'export const note = 1;\n' },
        report: { summary: 'repaired' },
      }),
    },
  });
  let shas = 0;
  fx.forge.state.autoChecks = () => (++shas <= 2 ? [red()] : [green()]);
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [red()]);
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // two CI verdicts on the same check, one re-run between them
  assert.equal(events.filter((e) => e.event === 'verdict-rendered' && e.source === 'ci').length, 2);
  assert.equal(fx.forge.state.reruns.length, RERUN_BUDGET);
  assert.equal(
    events.filter((e) => e.event === 'check-transition' && e.status === 'rerun-requested').length,
    RERUN_BUDGET,
  );
  // The second cycle's reds are on a head the first cycle never saw.
  const shasSeen = new Set(
    events.filter((e) => e.event === 'check-transition' && e.check === 'ci').map((e) => e.sha),
  );
  assert.ok(shasSeen.size >= 2, `the reds spanned heads: ${shasSeen.size}`);
});

test('a competing merge updates the branch: merge main in, re-run, auto-merge fires', async (t) => {
  const fx = shipFixture(t);
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  commitTree(fx.origin, { 'docs/note.md': 'competing change\n' }, 'competing merge');
  const update = await waitEvent(fx.paths, runId, (e) => e.event === 'branch-update', 'branch-update');
  assert.equal(update.fromSha, opened.sha);
  assert.equal(update.mainSha, gitSync(['rev-parse', 'main'], fx.origin).trim());
  assert.notEqual(update.toSha, update.fromSha);
  fx.forge.setChecks(update.toSha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'merge-round'));
  // a request behind its base is an ordinary state of the ship loop
  assert.ok(!events.some((e) => e.event === 'forge-anomaly'));
  // the merged main carries both sides
  assert.equal(gitSync(['show', 'main:src/feature.mjs'], fx.origin), GOOD_FEATURE);
  assert.match(gitSync(['show', 'main:docs/note.md'], fx.origin), /competing change/);
});

test('a request in conflict takes the update route, and says so first', async (t) => {
  const fx = shipFixture(t);
  fx.forge.state.autoChecks = () => [running()];
  fx.forge.state.conflictMode = true;
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  commitTree(fx.origin, { 'docs/note.md': 'competing change\n' }, 'competing merge');
  const anomaly = await waitEvent(fx.paths, runId, (e) => e.event === 'forge-anomaly', 'forge-anomaly');
  assert.equal(anomaly.kind, 'merge-conflicting');
  assert.equal(anomaly.pr, 7);
  assert.equal(anomaly.sha, opened.sha);
  assert.match(anomaly.detail, /in conflict with main/);
  // the same update the behind-base state takes: merge main in, push
  const update = await waitEvent(fx.paths, runId, (e) => e.event === 'branch-update', 'branch-update');
  assert.equal(update.fromSha, opened.sha);
  assert.equal(update.mainSha, gitSync(['rev-parse', 'main'], fx.origin).trim());
  assert.notEqual(update.toSha, update.fromSha);
  // the push carries a new head, and CI runs on it
  fx.forge.setChecks(update.toSha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // one stamp for the state, not one per poll
  assert.equal(events.filter((e) => e.event === 'forge-anomaly').length, 1);
  assert.equal(gitSync(['show', 'main:src/feature.mjs'], fx.origin), GOOD_FEATURE);
  assert.match(gitSync(['show', 'main:docs/note.md'], fx.origin), /competing change/);
});

test('a conflict inside the update of a conflicting request takes the fresh pass', async (t) => {
  const fx = shipFixture(t, {
    seats: {
      dev: ({ prompt }) => {
        if (prompt.includes('textual conflicts')) return { exitCode: 1 }; // the round fails
        return { files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } };
      },
    },
  });
  fx.forge.state.autoChecks = () => [running()];
  fx.forge.state.conflictMode = true;
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  commitTree(fx.origin, { 'src/feature.mjs': ALT_FEATURE }, 'conflicting main work');
  const anomaly = await waitEvent(fx.paths, runId, (e) => e.event === 'forge-anomaly', 'forge-anomaly');
  assert.equal(anomaly.kind, 'merge-conflicting');
  const fresh = await waitEvent(fx.paths, runId, (e) => e.event === 'fresh-pass', 'fresh-pass');
  assert.equal(fresh.trigger, 'merge-conflict');
  fx.forge.state.autoChecks = () => [green()];
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const round = events.find((e) => e.event === 'merge-round');
  assert.equal(round.resolved, false);
  assert.ok(events.some((e) => e.event === 'stall' && e.reason === 'merge-conflict'));
  // the fresh tree was born on updated main: the conflict dissolved there
  assert.equal(gitSync(['show', 'main:src/feature.mjs'], fx.origin), GOOD_FEATURE);
});

test('a head sha the forge builds no check for is stamped, re-delivered once, then parked', async (t) => {
  const fx = shipFixture(t);
  fx.forge.state.autoChecks = () => []; // the forge delivers nothing for any sha
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  const anomaly = await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'forge-anomaly' && e.kind === 'checkless-sha',
    'checkless-sha anomaly',
  );
  assert.equal(anomaly.pr, 7);
  assert.equal(anomaly.sha, opened.sha);
  assert.equal(anomaly.polls, CHECKLESS_POLLS);
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  assert.match(park.question, /no check run of any name/);
  assert.ok(park.question.includes(opened.sha));
  const live = readEvents(runLedgerPath(fx.paths, runId));
  // one anomaly stamp, one re-delivery, and no check state invented for a sha
  // that carries none
  assert.equal(live.filter((e) => e.event === 'forge-anomaly').length, 1);
  assert.deepEqual(
    live.filter((e) => e.event === 'operational-fix').map((e) => e.kind),
    ['check-redelivery'],
  );
  assert.ok(!live.some((e) => e.event === 'check-transition'));
  // the re-delivery took the update path and found the branch where it was
  const update = live.find((e) => e.event === 'branch-update');
  assert.equal(update.fromSha, update.toSha);
  // the substrate is repaired and the gate answered: the same sha ships
  fx.forge.setChecks(opened.sha, [green()]);
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'retry' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.find((e) => e.event === 'merged').sha, opened.sha);
});

test('textual conflicts take the merge round; test hunks go to the suite seat', async (t) => {
  const fx = shipFixture(t, {
    seats: {
      suite: ({ prompt }) => {
        assert.match(prompt, /conflicts in test files/);
        return {
          files: { 'tests/feature.test.mjs': STRONG_TEST },
          report: { suiteFiles: ['tests/feature.test.mjs'], reds: [], summary: 'resolved' },
        };
      },
    },
  });
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  commitTree(
    fx.origin,
    { 'src/feature.mjs': ALT_FEATURE, 'tests/feature.test.mjs': ALT_TEST },
    'conflicting main work',
  );
  const round = await waitEvent(fx.paths, runId, (e) => e.event === 'merge-round', 'merge-round');
  assert.equal(round.resolved, true);
  assert.deepEqual(round.testFiles, ['tests/feature.test.mjs']);
  assert.ok(round.conflicts.includes('src/feature.mjs'));
  fx.forge.setChecks(round.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // the resolved tests are the frozen suite now: the round re-froze
  const refreeze = events.find((e) => e.event === 're-freeze');
  assert.equal(refreeze.sha, round.sha);
  assert.ok(
    events.some((e) => e.event === 'suite-committed' && e.phase === 're-freeze'),
  );
  const update = events.find((e) => e.event === 'branch-update');
  assert.equal(update.toSha, round.sha);
  // both resolutions shipped
  assert.equal(gitSync(['show', 'main:src/feature.mjs'], fx.origin), GOOD_FEATURE);
  assert.equal(gitSync(['show', 'main:tests/feature.test.mjs'], fx.origin), STRONG_TEST);
  // the dev seat saw the conflict brief; the suite seat took the test hunks
  const conflictCall = fx.calls.find((c) => c.seat === 'dev' && c.prompt.includes('textual conflicts'));
  assert.ok(conflictCall);
  assert.ok(!conflictCall.prompt.includes('tests/feature.test.mjs'));
});

test('an admin merge over red checks is a breach: ticket, stamp, enqueue', async (t) => {
  const fx = shipFixture(t, {
    pollMs: 300,
    enqueue: true,
    // One slot: the breaching run holds it through its own close-out, which
    // is why the breach enqueues its repair instead of launching it.
    slotCap: 1,
    seats: {
      dev: ({ prompt }) => {
        if (prompt.includes('Fix the defect')) {
          return { files: { 'src/regression.mjs': 'export const r = 1;\n' }, report: { summary: 'fixed' } };
        }
        return { files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } };
      },
      'generalist-review': () => ({ report: { findings: [], summary: 'clean' } }),
    },
  });
  fx.forge.state.autoChecks = () => [running()];
  fx.forge.state.onRerun = () => {};
  const runId = await fx.launch();
  fx.daemon.frontier.setArmed('proj', true, 'human');
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  fx.forge.setChecks(opened.sha, [red()]);
  fx.forge.adminMerge();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const merged = events.find((e) => e.event === 'merged');
  assert.equal(merged.red, true);
  assert.deepEqual(merged.redChecks, ['ci']);
  const breach = events.find((e) => e.event === 'red-merge-breach');
  assert.equal(breach.escapes.length, 1);
  assert.deepEqual(breach.ticketed, breach.escapes);
  // loud stream carries the pointer
  const loud = readFileSync(fx.paths.loudStream, 'utf8');
  assert.match(loud, /red-merge-breach/);
  // the conversion landed in the escapes ledger, attributed to the story, in
  // the order the breach owes: recorded, then ticketed
  const ledger = readEvents(fx.paths.escapesLedger);
  assert.deepEqual(
    ledger.map((e) => e.event),
    ['escape-recorded', 'escape-ticketed'],
  );
  const escapes = readEscapeSet(fx.paths.escapesLedger);
  assert.equal(escapes.length, 1);
  assert.equal(escapes[0].seq, breach.escapes[0]);
  assert.equal(escapes[0].category, 'product-escape');
  assert.equal(escapes[0].detectionSource, 'harness-self');
  assert.equal(escapes[0].attribution, 'alpha-1');
  assert.equal(escapes[0].refs.project, 'proj');
  // the escape carries the ticket path, and the ticket is self-contained
  assert.equal(escapes[0].ticket, repairTicketPath(fx.paths, escapes[0].seq));
  const ticket = readFileSync(escapes[0].ticket, 'utf8');
  assert.match(ticket, new RegExp(`escape: seq ${escapes[0].seq}`));
  assert.match(ticket, /merged PR: #7/);
  assert.match(ticket, new RegExp(`merge commit: ${merged.mergeSha}`));
  assert.match(ticket, /### ci/);
  assert.match(ticket, /log tail of ci at/);
  // the hand-off named the project and the ticketed escapes; nothing launched
  // from inside the breaching run
  assert.equal(fx.enqueued.length, 1);
  assert.equal(fx.enqueued[0].project, 'proj');
  assert.deepEqual(fx.enqueued[0].escapes, breach.escapes);
  // the frontier launched the repair once the slot came free
  const launch = await waitFor(
    () => readEvents(fx.paths.instanceLedger).find((e) => e.event === 'launch' && e.lane === 'repair'),
    { attempts: 600, intervalMs: 100, label: 'repair launched' },
  );
  const repairEvents = await waitClosed(fx.paths, launch.runId);
  const repairLaunched = repairEvents.find((e) => e.event === 'run-launched');
  assert.equal(repairLaunched.escapeSeq, breach.escapes[0]);
  assert.equal(repairLaunched.ticket, escapes[0].ticket);
  assert.equal(repairEvents.find((e) => e.event === 'run-closed').state, 'shipped');
});

test('a repair-lane ship stamps the escape fixed at close-out', async (t) => {
  const fx = shipFixture(t);
  const store = openEscapesStore(fx.paths);
  const recorded = recordEscape(store, {
    actor: 'daemon',
    category: 'product-escape',
    defectLine: 'f(3) returns 5 in production',
    detectionSource: 'human-report',
    attribution: 'alpha-1',
    refs: { project: 'proj', runId: 'seed' },
  });
  const ticket = repairTicketPath(fx.paths, recorded.seq);
  writeFileSync(ticket, '# Fix f(3)\n');
  ticketEscape(store, { actor: 'daemon', escape: recorded.seq, ticket });
  store.close();
  // ticketed, unfixed, no repair run: the sweep owes this one
  assert.deepEqual(
    owedRepairs(fx.paths, 'proj').map((e) => e.seq),
    [recorded.seq],
  );
  fx.forge.state.autoChecks = () => [green()];
  await fx.daemon.start();
  fx.daemon.engine.seatDefaults = () => ({ commandFor: seatFixture(BASE_SEATS).commandFor });
  const { runId } = await fx.daemon.launchRun({
    project: 'proj',
    lane: 'repairship',
    ticket,
    escapeSeq: recorded.seq,
  });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // repair mode: no card sweep, and the escape lifecycle closed
  assert.ok(!events.some((e) => e.event === 'card-sweep'));
  const escapes = readEscapeSet(fx.paths.escapesLedger);
  assert.equal(escapes[0].fixed, true);
  assert.equal(escapes[0].fixRefs.runId, runId);
  assert.equal(escapes[0].fixRefs.pr, 7);
  // the loop closed: a fixed escape is owed to nobody
  assert.deepEqual(owedRepairs(fx.paths, 'proj'), []);
});

test('a console repair launch stamps its escape fixed at close-out', async (t) => {
  const fx = shipFixture(t, { repairShips: true });
  const store = openEscapesStore(fx.paths);
  const recorded = recordEscape(store, {
    actor: 'daemon',
    category: 'product-escape',
    defectLine: 'f(3) returns 5 in production',
    detectionSource: 'human-report',
    attribution: 'alpha-1',
    refs: { project: 'proj', runId: 'seed' },
  });
  const ticket = repairTicketPath(fx.paths, recorded.seq);
  writeFileSync(ticket, '# Fix f(3)\n');
  ticketEscape(store, { actor: 'daemon', escape: recorded.seq, ticket });
  store.close();
  fx.forge.state.autoChecks = () => [green()];
  await fx.daemon.start();
  fx.daemon.engine.seatDefaults = () => ({ commandFor: seatFixture(BASE_SEATS).commandFor });
  // The console names the ticket and nothing else. The daemon reads the
  // escape off it, so the payload the close-out fix-back looks at is the
  // payload the sweep would have built.
  const { runId } = await fx.daemon.launchCommand({
    actor: 'console:operator',
    project: 'proj',
    lane: 'repair',
    ticket,
  });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.find((e) => e.event === 'run-launched').escapeSeq, recorded.seq);
  const escapes = readEscapeSet(fx.paths.escapesLedger);
  assert.equal(escapes[0].fixed, true);
  assert.equal(escapes[0].fixedBy, 'repair');
  assert.equal(escapes[0].fixRefs.runId, runId);
  // The loop closes for the console route as it does for the sweep's.
  assert.deepEqual(owedRepairs(fx.paths, 'proj'), []);
});

test('the escape fix clears the red-merge breach it was recorded for', async (t) => {
  const fx = shipFixture(t);
  const store = openEscapesStore(fx.paths);
  const recorded = recordEscape(store, {
    actor: 'daemon',
    category: 'product-escape',
    defectLine: 'f(3) returns 5 in production',
    detectionSource: 'harness-self',
    attribution: 'alpha-1',
    refs: { project: 'proj', runId: 'seed' },
  });
  const ticket = repairTicketPath(fx.paths, recorded.seq);
  writeFileSync(ticket, '# Fix f(3)\n');
  ticketEscape(store, { actor: 'daemon', escape: recorded.seq, ticket });
  store.close();
  // The run that shipped the red merge, as its close-out left it: breached,
  // loud, closed, archived.
  const seed = new TelemetryStore(
    fx.paths,
    'run:seed',
    archivedRunLedgerPath(fx.paths, 'seed'),
    RUN_EVENTS,
  );
  seed.append('run-launched', { actor: 'daemon', project: 'proj', lane: 'story' });
  const breach = seed.append('red-merge-breach', {
    actor: 'daemon',
    pr: 3,
    escapes: [recorded.seq],
    ticketed: [recorded.seq],
    gist: 'red merge on PR #3',
  });
  seed.append('run-closed', { actor: 'daemon', state: 'shipped' });
  seed.close();
  assert.equal(openLoud(fx.paths).length, 1);
  fx.forge.state.autoChecks = () => [green()];
  await fx.daemon.start();
  fx.daemon.engine.seatDefaults = () => ({ commandFor: seatFixture(BASE_SEATS).commandFor });
  const { runId } = await fx.daemon.launchRun({
    project: 'proj',
    lane: 'repairship',
    ticket,
    escapeSeq: recorded.seq,
  });
  await waitClosed(fx.paths, runId);
  // The defect is out of the product, so the breach is no longer an ask: the
  // strip clears without anyone reading it.
  const seeded = readEvents(archivedRunLedgerPath(fx.paths, 'seed'));
  const resolution = seeded.find((e) => e.event === 'resolved');
  assert.equal(resolution.resolves, breach.seq);
  assert.equal(resolution.resolvedEvent, 'red-merge-breach');
  assert.equal(resolution.owner, 'escape-fixed');
  assert.deepEqual(
    openLoud(fx.paths).filter((e) => e.event === 'red-merge-breach'),
    [],
  );
});

test('an operator fixed-mark clears the breach the way a shipped repair does', (t) => {
  const fx = shipFixture(t);
  const store = openEscapesStore(fx.paths);
  const recorded = recordEscape(store, {
    actor: 'daemon',
    category: 'product-escape',
    defectLine: 'f(3) returns 5 in production',
    detectionSource: 'harness-self',
    attribution: 'alpha-1',
    refs: { project: 'proj', runId: 'seed' },
  });
  const ticket = repairTicketPath(fx.paths, recorded.seq);
  writeFileSync(ticket, '# Fix f(3)\n');
  ticketEscape(store, { actor: 'daemon', escape: recorded.seq, ticket });
  store.close();
  const seed = new TelemetryStore(
    fx.paths,
    'run:seed',
    archivedRunLedgerPath(fx.paths, 'seed'),
    RUN_EVENTS,
  );
  seed.append('run-launched', { actor: 'daemon', project: 'proj', lane: 'story' });
  const breach = seed.append('red-merge-breach', {
    actor: 'daemon',
    pr: 3,
    escapes: [recorded.seq],
    ticketed: [recorded.seq],
    gist: 'red merge on PR #3',
  });
  seed.append('run-closed', { actor: 'daemon', state: 'shipped' });
  seed.close();
  assert.equal(openLoud(fx.paths).length, 1);
  fx.daemon.markEscapeFixed({
    actor: 'console:operator',
    escape: recorded.seq,
    evidence: 'fixed by hand on the default branch',
  });
  // The strip asks whether the defect is still in the product, and it is out
  // either way; the resolution says which route took it out.
  const seeded = readEvents(archivedRunLedgerPath(fx.paths, 'seed'));
  const resolution = seeded.find((e) => e.event === 'resolved');
  assert.equal(resolution.resolves, breach.seq);
  assert.equal(resolution.owner, 'escape-marked-fixed');
  assert.deepEqual(
    openLoud(fx.paths).filter((e) => e.event === 'red-merge-breach'),
    [],
  );
});

test('green but no merge: loud gate-integrity, one re-arm, resolution at merge', async (t) => {
  const fx = shipFixture(t);
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  // the arm silently drops; the checks go green — auto-merge cannot fire
  fx.forge.state.pr.armed = false;
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const alert = events.find((e) => e.event === 'gate-integrity' && e.kind === 'auto-merge');
  assert.ok(alert);
  const rearm = events.find((e) => e.event === 'operational-fix' && e.kind === 'auto-merge-rearm');
  assert.ok(rearm);
  const resolved = events.find((e) => e.event === 'resolved' && e.resolves === alert.seq);
  assert.ok(resolved);
});

test('the sweep parks an invalidated card in the instance ledger, not the run', async (t) => {
  const fx = shipFixture(t, {
    seats: {
      'card-sweep': () => ({
        files: { 'stories/alpha.md': DEFAULT_CARD + '\n<!-- swept -->\n' },
        report: {
          updatedCards: ['stories/alpha.md'],
          invalidated: [{ card: 'stories/beta.md', reason: 'goal shipped by alpha-1' }],
          summary: 'swept',
        },
      }),
    },
  });
  fx.forge.state.autoChecks = () => [green()];
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const sweep = events.find((e) => e.event === 'card-sweep');
  assert.equal(sweep.invalidated, 1);
  // the park lives in the instance ledger and the queued stream — the
  // shipping run closed anyway
  const instanceEvents = readEvents(fx.paths.instanceLedger);
  const park = instanceEvents.find((e) => e.event === 'park' && e.type === 'card-invalidated');
  assert.equal(park.card, 'stories/beta.md');
  assert.equal(park.runId, runId);
  const queued = readFileSync(fx.paths.queuedStream, 'utf8');
  assert.match(queued, /card-invalidated/);
});

test('the preflight parks a provisioning gate until the substrate is ready', async (t) => {
  const fx = shipFixture(t);
  fx.forge.state.autoMergeAllowed = false;
  fx.forge.state.autoChecks = () => [green()];
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  assert.match(park.question, /auto-merge is not allowed/);
  // A gate takes the same option every other park takes, a note in words, or
  // the abandon (ADR-0029). This one is answered in words.
  assert.deepEqual(park.answers, {
    options: ['retry', 'abandon'],
    text: 'a note on what you repaired',
  });
  fx.forge.state.autoMergeAllowed = true;
  fx.daemon.engine.answer({ runId, actor: 'kalki', answer: 'auto-merge enabled' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(events.some((e) => e.event === 'pr-opened'));
});

test('a credential that went stale in the run parks the ship gate before the PR', async (t) => {
  // The launch proved the key; it expired while the run built. The ship gate
  // asks again, and the answer arrives before a CI round pays for it.
  const previous = process.env[PROBE_VAR];
  const set = (next) => {
    if (next === undefined) delete process.env[PROBE_VAR];
    else process.env[PROBE_VAR] = next;
  };
  set('stale');
  t.after(() => set(previous));
  const fx = shipFixture(t, {
    config: {
      commands: { probe: [process.execPath, '-e', PROBE_SCRIPT] },
      credentials: [{ name: 'payments', env: PROBE_VAR, probe: 'probe' }],
    },
  });
  fx.forge.state.autoChecks = () => [green()];
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  assert.match(park.question, /payments credential probe answered no at the ship gate/);
  assert.ok(!park.question.includes(PROBE_LEAK));
  // No PR, so no CI round: the gate sits in front of the money.
  const live = readEvents(runLedgerPath(fx.paths, runId));
  assert.ok(!live.some((e) => e.event === 'pr-opened'));
  assert.ok(!readFileSync(runLedgerPath(fx.paths, runId), 'utf8').includes(PROBE_LEAK));
  set('live');
  // The option form at a gate: the operator repaired the substrate and the run
  // asks the same question again.
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'retry' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(
    events.filter((e) => e.event === 'credential-probe').map((e) => [e.phase, e.ok]),
    [
      ['ship', false],
      ['ship', true],
    ],
  );
});

test('the ship gate parks on a CI surface the host surface cannot speak for', async (t) => {
  // The key works on this host and the workflow reads it. CI holds no secret
  // of that name, which is what used to surface as a red round on an open
  // request rather than as a gate in front of it.
  const secret = 'PAY_CI_KEY';
  const workflow = '.github/workflows/ci.yml';
  const previous = process.env[PROBE_VAR];
  process.env[PROBE_VAR] = 'live';
  t.after(() => {
    if (previous === undefined) delete process.env[PROBE_VAR];
    else process.env[PROBE_VAR] = previous;
  });
  const fx = shipFixture(t, {
    config: {
      commands: { probe: [process.execPath, '-e', PROBE_SCRIPT] },
      credentials: [
        { name: 'payments', env: PROBE_VAR, probe: 'probe', ci: { secret, workflows: [workflow] } },
      ],
    },
    files: { [workflow]: `jobs:\n  suite:\n    env:\n      K: \${{ secrets.${secret} }}\n` },
  });
  fx.forge.state.autoChecks = () => [green()];
  fx.forge.state.ciSecrets = ['UNRELATED_KEY'];
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  assert.match(park.question, new RegExp(`holds no secret named ${secret}`));
  assert.match(park.question, /at the ship gate/);
  // The wired surfaces are not named, and no request was opened over the gap.
  assert.ok(!park.question.includes(workflow));
  const live = readEvents(runLedgerPath(fx.paths, runId));
  assert.ok(!live.some((e) => e.event === 'pr-opened'));
  assert.deepEqual(live.find((e) => e.event === 'credential-surface').missing, [
    { surface: 'ci-secret', name: secret },
  ]);
  fx.forge.state.ciSecrets = ['UNRELATED_KEY', secret];
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'secret set on the repository' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(
    events.filter((e) => e.event === 'credential-surface').map((e) => e.ok),
    [false, true],
  );
});

// -- request labels ----------------------------------------------------------

const LABEL_RULES = [
  { label: 'migration', paths: ['db/migrations'] },
  { label: 'ui', paths: ['src/ui/**'] },
];

/** A dev seat that lands a migration beside the feature. */
const MIGRATING_DEV = {
  dev: () => ({
    files: {
      'src/feature.mjs': GOOD_FEATURE,
      'db/migrations/001_add_column.sql': 'ALTER TABLE t ADD COLUMN c INT;\n',
    },
    report: { summary: 'implemented with a migration' },
  }),
};

test('label derivation answers from the project rules and guesses nothing', () => {
  assert.deepEqual(derivedLabels(['db/migrations/001.sql', 'src/app.mjs'], LABEL_RULES), [
    'migration',
  ]);
  // Sorted, and one rule fires once however many of its files the diff holds.
  assert.deepEqual(
    derivedLabels(['src/ui/page.js', 'db/migrations/1.sql', 'db/migrations/2.sql'], LABEL_RULES),
    ['migration', 'ui'],
  );
  // A diff no rule covers derives nothing; the project's own check owns it.
  assert.deepEqual(derivedLabels(['README.md'], LABEL_RULES), []);
  assert.deepEqual(derivedLabels(['db/migrations/1.sql']), []);
});

test('the request is created carrying the labels its diff requires, in one call', async (t) => {
  const fx = shipFixture(t, { seats: MIGRATING_DEV, config: { labels: LABEL_RULES } });
  fx.forge.state.autoChecks = () => [green()];
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const labelled = events.find((e) => e.event === 'pr-labeled');
  assert.deepEqual(labelled.labels, ['migration']);
  assert.equal(labelled.applied, true);
  assert.deepEqual([...fx.forge.state.labels], ['migration']);
  // Creation and labelling are one call: the forge opened the request with
  // the label on it, and nothing applied a label afterwards. The request is
  // therefore never open unlabelled, so no check of it can read a bare one.
  assert.equal(labelled.at, 'create');
  assert.deepEqual(fx.forge.state.createLabels, [{ number: 7, labels: ['migration'] }]);
  assert.deepEqual(fx.forge.state.labelCalls, []);
  // The label is on the record before the request can merge: the stamp
  // precedes `pr-opened`, which precedes the arm.
  assert.ok(labelled.seq < events.find((e) => e.event === 'pr-opened').seq);
  // The defect this fix removed has a name, and a healthy ship stamps none of
  // it: that is what makes a recurrence a number rather than a reading job.
  assert.ok(!events.some((e) => e.event === 'gate-integrity' && e.kind === 'pr-label-missing'));
});

test('a request that did not carry its labels at creation is the named defect', async (t) => {
  // The forge refuses a create carrying a label the repository does not
  // define, so the request opens bare and the apply call puts the label on
  // afterwards. Between the two the request existed unlabelled, which is the
  // one moment a label check reads.
  const fx = shipFixture(t, { seats: MIGRATING_DEV, config: { labels: LABEL_RULES } });
  fx.forge.state.autoChecks = () => [green()];
  fx.forge.state.labelsAccept = false;
  const runId = await fx.launch();
  await waitParked(fx.paths, runId, 'provisioning-gate');
  fx.forge.state.labelsAccept = true;
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'label created' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const named = events.filter(
    (e) => e.event === 'gate-integrity' && e.kind === 'pr-label-missing',
  );
  // One record per request, however many opens the park costs.
  assert.equal(named.length, 1);
  assert.equal(named[0].pr, 7);
  assert.deepEqual(named[0].labels, ['migration']);
  assert.equal(named[0].applied, false);
  assert.match(named[0].detail, /the apply call was refused/);
  // The record reports a window that closed. The merge of the request is what
  // says the window cost that request nothing.
  const resolved = events.find((e) => e.event === 'resolved' && e.resolves === named[0].seq);
  assert.equal(resolved.owner, 'merged');
  assert.equal(resolved.pr, 7);
});

test('a diff no rule covers is stamped as labelled with nothing', async (t) => {
  const fx = shipFixture(t, { config: { labels: LABEL_RULES } });
  fx.forge.state.autoChecks = () => [green()];
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The derivation ran and asked for nothing; a run that never derived would
  // read the same without this stamp.
  assert.deepEqual(events.find((e) => e.event === 'pr-labeled').labels, []);
  assert.deepEqual([...fx.forge.state.labels], []);
});

test('a project that configured no rules leaves the label surface untouched', async (t) => {
  // The derivation is total over the rules it was given and asks for nothing
  // else. This diff carries the file another project's rule would fire on, and
  // on a project that named no rule it derives nothing: the create carries no
  // label, no apply call carries one, and the ship is the journey it always
  // was. A harness that held label names of its own would fail exactly here.
  const fx = shipFixture(t, { seats: MIGRATING_DEV });
  fx.forge.state.autoChecks = () => [green()];
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(events.find((e) => e.event === 'pr-labeled').labels, []);
  assert.deepEqual(fx.forge.state.createLabels, []);
  assert.ok(fx.forge.state.labelCalls.every((call) => call.labels.length === 0));
  assert.deepEqual([...fx.forge.state.labels], []);
  assert.ok(!events.some((e) => e.event === 'gate-integrity' && e.kind === 'pr-label-missing'));
});

test('a label the repository does not define parks the gate and names it', async (t) => {
  const fx = shipFixture(t, { seats: MIGRATING_DEV, config: { labels: LABEL_RULES } });
  fx.forge.state.autoChecks = () => [green()];
  fx.forge.state.labelsAccept = false;
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  assert.match(park.question, /needs the label migration/);
  assert.match(park.question, /label not found \(fixture\)/);
  // The request is not armed on a label the check will ask for and not find.
  const live = readEvents(runLedgerPath(fx.paths, runId));
  assert.ok(!live.some((e) => e.event === 'pr-opened'));
  assert.equal(live.find((e) => e.event === 'pr-labeled').applied, false);
  // A create the label refused opens the request bare, and the apply path
  // behind it is what names the refusal.
  assert.equal(live.find((e) => e.event === 'pr-labeled').at, 'open');
  assert.deepEqual(fx.forge.state.createLabels, []);
  fx.forge.state.labelsAccept = true;
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'label created' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual([...fx.forge.state.labels], ['migration']);
});

test('an escape from a merge the harness already named takes that word for it', async (t) => {
  // The defect was stamped where it was observed, hours before the merge that
  // carried it into the product. The escape is the same defect arriving, so it
  // is recorded under the same closed kind instead of described a second time.
  const fx = shipFixture(t, { seats: MIGRATING_DEV, config: { labels: LABEL_RULES } });
  fx.forge.state.autoChecks = () => [running()];
  fx.forge.state.onRerun = () => {};
  fx.forge.state.labelsAccept = false;
  const runId = await fx.launch();
  await waitParked(fx.paths, runId, 'provisioning-gate');
  fx.forge.state.labelsAccept = true;
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'label created' });
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  fx.forge.setChecks(opened.sha, [red()]);
  fx.forge.adminMerge();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const escapes = readEscapeSet(fx.paths.escapesLedger);
  assert.equal(escapes.length, 1);
  assert.equal(escapes[0].kind, 'pr-label-missing');
  // The repair seat reads the ticket in a fresh worktree and nothing else, so
  // the word travels there too.
  assert.match(readFileSync(escapes[0].ticket, 'utf8'), /kind .*: pr-label-missing/);
});

test('a failed merge round stalls into the fresh pass born on updated main', async (t) => {
  const fx = shipFixture(t, {
    seats: {
      dev: ({ prompt }) => {
        if (prompt.includes('textual conflicts')) return { exitCode: 1 }; // the round fails
        return { files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } };
      },
    },
  });
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  commitTree(fx.origin, { 'src/feature.mjs': ALT_FEATURE }, 'conflicting main work');
  const fresh = await waitEvent(fx.paths, runId, (e) => e.event === 'fresh-pass', 'fresh-pass');
  assert.equal(fresh.trigger, 'merge-conflict');
  const impl = await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'implementation-committed' && e.phase === 'fresh',
    'fresh implementation',
  );
  fx.forge.state.autoChecks = () => [green()];
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const round = events.find((e) => e.event === 'merge-round');
  assert.equal(round.resolved, false);
  assert.ok(events.some((e) => e.event === 'stall' && e.reason === 'merge-conflict'));
  assert.equal(impl.pass, 2);
  // the fresh tree was born on updated main: no further update needed
  assert.equal(gitSync(['show', 'main:src/feature.mjs'], fx.origin), GOOD_FEATURE);
});

// -- the update stage: the ship token, then the pre-verdict update -----------

test('a base that did not move costs one stamped no-op, and the token comes first', async (t) => {
  const fx = shipFixture(t);
  const mainAtLaunch = gitSync(['rev-parse', 'main'], fx.origin).trim();
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const update = events.find((e) => e.event === 'pre-verdict-update');
  assert.equal(update.ran, false);
  assert.equal(update.mainSha, mainAtLaunch);
  assert.equal(update.pass, 1);
  // The order of the seam: the token, then the update, then the request.
  assert.deepEqual(
    events
      .filter((e) => ['ship-token', 'pre-verdict-update', 'pr-opened'].includes(e.event))
      .map((e) => e.event),
    ['ship-token', 'pre-verdict-update', 'pr-opened'],
  );
  assert.equal(events.find((e) => e.event === 'ship-token').state, 'acquired');
  // A base where the run left it asks for no second judgment.
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 1);
});

test('a base that moved is merged in before the final verdict, and judged there', async (t) => {
  const fx = shipFixture(t);
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'freeze', 'freeze');
  commitTree(fx.origin, { 'docs/note.md': 'competing change\n' }, 'competing merge');
  const update = await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'pre-verdict-update' && e.ran,
    'the pre-verdict update',
  );
  assert.equal(update.mainSha, gitSync(['rev-parse', 'main'], fx.origin).trim());
  assert.notEqual(update.toSha, update.fromSha);
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  assert.equal(opened.sha, update.toSha);
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The verdict that sent the run to the forge judged the merged tree.
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.equal(renders.length, 2);
  assert.equal(renders.at(-1).verdict, 'green');
  assert.equal(renders.at(-1).sha, update.toSha);
  assert.ok(renders.at(-1).seq > update.seq);
  // The request opened current, so the ship stage owed no update of its own.
  assert.ok(!events.some((e) => e.event === 'branch-update'));
  assert.equal(gitSync(['show', 'main:src/feature.mjs'], fx.origin), GOOD_FEATURE);
  assert.match(gitSync(['show', 'main:docs/note.md'], fx.origin), /competing change/);
});

test('a conflict the pre-verdict update meets takes the merge round, before the request', async (t) => {
  const fx = shipFixture(t);
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'freeze', 'freeze');
  commitTree(fx.origin, { 'src/feature.mjs': ALT_FEATURE }, 'conflicting main work');
  const round = await waitEvent(fx.paths, runId, (e) => e.event === 'merge-round', 'merge-round');
  assert.equal(round.resolved, true);
  assert.deepEqual(round.conflicts, ['src/feature.mjs']);
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The repair happened where it is cheapest: no request, no CI round spent.
  assert.ok(round.seq < opened.seq);
  assert.ok(!events.some((e) => e.event === 'forge-anomaly'));
  const conflictCall = fx.calls.find(
    (c) => c.seat === 'dev' && c.prompt.includes('textual conflicts'),
  );
  assert.ok(conflictCall);
  assert.equal(gitSync(['show', 'main:src/feature.mjs'], fx.origin), GOOD_FEATURE);
});

// -- the clean-rebase fast path (ADR-0056) -----------------------------------
//
// The derivation has its own suite (fastpath.test.mjs). These are the lane:
// the flag, the stamp, and the one thing that matters about every ending but
// the clean yes, which is that the run takes the full re-verdict it would have
// taken if this path had never existed.

// A suite command that says what it depends on, in the part-targeting contract
// the harness already consumes (ADR-0046). Without a declaration like this one
// nothing can fast-path, which is the safety the default rests on.
const DECLARING_SUITE = `import { spawnSync } from 'node:child_process';
console.log('::olympus part feature');
console.log('::olympus part-inputs src');
const run = spawnSync(process.execPath, ['--test', 'tests/*.test.mjs'], { stdio: 'inherit' });
console.log(run.status === 0 ? '::olympus part-ok feature' : '::olympus part-failed feature');
process.exit(run.status ?? 1);
`;

/**
 * A ship fixture whose one gate layer declares its ground. `gates` overrides
 * the fast-path settings; everything else is the ordinary fixture.
 */
function fastPathFixture(t, { gates = {}, files = {}, ...rest } = {}) {
  return shipFixture(t, {
    ...rest,
    files: { '.olympus/suite.mjs': DECLARING_SUITE, ...files },
    config: {
      commands: { suite: ['node', '.olympus/suite.mjs'] },
      gates: {
        tier1: [{ name: 'unit', command: 'suite' }],
        fastPathShip: true,
        breadthGround: ['package-lock.json'],
        // The ground this project states no suite of it can reach. Without a
        // claim like this one every file the branch gains is ground nobody
        // described, and the check refuses rather than reading silence as
        // safety (ADR-0056).
        inertGround: ['docs'],
        ...gates,
      },
    },
  });
}

/** Runs a fast-path fixture to its close over one competing merge. */
async function shipOverMerge(fx, tree, message) {
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'freeze', 'freeze');
  const mainSha = commitTree(fx.origin, tree, message);
  await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'pre-verdict-update' && e.ran,
    'the pre-verdict update',
  );
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  fx.forge.setChecks(opened.sha, [green()]);
  return { runId, mainSha, events: await waitClosed(fx.paths, runId) };
}

test('a merge onto ground no suite declares carries the certification it earned', async (t) => {
  const fx = fastPathFixture(t);
  const { mainSha, events } = await shipOverMerge(
    fx,
    { 'docs/note.md': 'unrelated main work\n' },
    'docs: a note',
  );
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const fast = events.find((e) => e.event === 'fast-path-ship');
  assert.equal(fast.taken, true);
  // The record names the commits it examined, the declarations it was checked
  // against, and the certification it reuses.
  assert.deepEqual(fast.commits, [mainSha]);
  assert.equal(fast.commitCount, 1);
  assert.equal(fast.mainSha, mainSha);
  assert.match(fast.declaration.digest, /^[0-9a-f]{12}$/);
  assert.deepEqual(fast.declaration.suites, ['unit/feature']);
  const render = events.find((e) => e.event === 'verdict-rendered');
  assert.equal(fast.declaration.sha, render.sha);
  assert.equal(fast.certification.cycle, render.cycle);
  assert.equal(fast.certification.record, render.record);
  // One verdict, and the merged tree never went back for a second one.
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 1);
  assert.ok(fast.seq > render.seq);
  // The close says the ship carried rather than earned.
  assert.equal(events.find((e) => e.event === 'run-closed').fastPath, true);
  // Both sides landed.
  assert.equal(gitSync(['show', 'main:src/feature.mjs'], fx.origin), GOOD_FEATURE);
  assert.match(gitSync(['show', 'main:docs/note.md'], fx.origin), /unrelated main work/);
});

test('a defect that came in on a fast-path ship is counted as one', async (t) => {
  const fx = fastPathFixture(t);
  const { runId, events } = await shipOverMerge(
    fx,
    { 'docs/note.md': 'unrelated main work\n' },
    'docs: a note',
  );
  const merged = events.find((e) => e.event === 'merged');
  assert.equal(events.find((e) => e.event === 'fast-path-ship').taken, true);
  // The tripwire that measures the trade the flag makes, armed at its standing
  // band: two fast-path escapes in a window of ten ships.
  fx.daemon.tripwires.setRegistry(
    'proj',
    standingTripwires()
      .filter((entry) => entry.metric === 'fast-path-escapes')
      .map(withTripwireDefaults),
  );
  // Two defects an operator found afterwards, named by the merge they came in
  // on. Neither report says anything about the fast path; the attribution is
  // derived from the ledgers.
  for (const line of ['the total is off by one', 'the page loses the second row']) {
    fx.daemon.recordEscapeReport({
      actor: 'console:test',
      project: 'proj',
      defectLine: line,
      pr: merged.pr,
    });
  }
  const escapes = readEscapeSet(fx.paths.escapesLedger);
  assert.equal(escapes.length, 2);
  for (const escape of escapes) {
    assert.equal(escape.kind, 'fast-path-escape');
    assert.equal(escape.attribution, runId);
    assert.equal(escape.refs.pr, merged.pr);
    assert.equal(escape.refs.mergeSha, merged.mergeSha);
  }
  const breach = await waitFor(
    () => readEvents(fx.paths.instanceLedger).find((e) => e.event === 'tripwire-breach'),
    { label: 'the fast-path escapes to breach' },
  );
  assert.equal(breach.tripwire, 'fast-path-escapes');
  assert.equal(breach.value, 2);
  assert.match(breach.answer, /gates\.fastPathShip to false/);
});

test('an escape record refuses what it cannot file', async (t) => {
  const fx = fastPathFixture(t);
  await fx.daemon.start();
  const report = { actor: 'console:test', project: 'proj', defectLine: 'the total is off' };
  assert.throws(
    () => fx.daemon.recordEscapeReport({ ...report, actor: '' }),
    /requires an actor/,
  );
  for (const bad of [undefined, '', '   ']) {
    assert.throws(
      () => fx.daemon.recordEscapeReport({ ...report, defectLine: bad }),
      /requires the defect line/,
      String(bad),
    );
    // The project is required for the same reason the defect line is. The
    // ledger is instance-scoped: a record with no project matches a request
    // number in whatever project opened one, and it belongs to none, so every
    // per-project reading counts it for nobody and no sweep can repair it.
    assert.throws(
      () => fx.daemon.recordEscapeReport({ ...report, project: bad }),
      /requires the project/,
      String(bad),
    );
  }
  assert.deepEqual(readEscapeSet(fx.paths.escapesLedger), []);
});

test('a defect from a ship that earned its verdict is the ordinary escape', async (t) => {
  const fx = fastPathFixture(t, { gates: { fastPathShip: undefined } });
  const { events } = await shipOverMerge(
    fx,
    { 'docs/note.md': 'unrelated main work\n' },
    'docs: a note',
  );
  const merged = events.find((e) => e.event === 'merged');
  fx.daemon.recordEscapeReport({
    actor: 'console:test',
    project: 'proj',
    defectLine: 'the total is off by one',
    pr: merged.pr,
  });
  const escape = readEscapeSet(fx.paths.escapesLedger)[0];
  // No word for it, because the harness has no claim to make about this one.
  assert.equal(escape.kind, null);
  assert.equal(escape.attribution, 'unattributed');
  // Every record carries refs whatever route recorded it. Without the project
  // the repair sweep has no repository to launch into, and the per-project
  // metrics read another project's defects as this one's.
  assert.equal(escape.refs.project, 'proj');
  assert.equal(escape.refs.pr, merged.pr);
});

test('a reported defect is ticketed, and a ticketed defect is owed', async (t) => {
  // An escape with no ticket is recorded, counted, and repaired by nobody: the
  // owed set is ticketed-and-not-fixed. A defect a person found is owed exactly
  // as much as one the harness found for itself.
  const fx = fastPathFixture(t, { gates: { fastPathShip: undefined } });
  const { events } = await shipOverMerge(
    fx,
    { 'docs/note.md': 'unrelated main work\n' },
    'docs: a note',
  );
  const merged = events.find((e) => e.event === 'merged');
  const line = fx.daemon.recordEscapeReport({
    actor: 'console:test',
    project: 'proj',
    defectLine: 'the second row is lost',
    pr: merged.pr,
    mergeSha: merged.mergeSha,
  });
  assert.deepEqual(
    readEvents(fx.paths.escapesLedger).map((e) => e.event),
    ['escape-recorded', 'escape-ticketed'],
  );
  const escape = readEscapeSet(fx.paths.escapesLedger)[0];
  assert.equal(escape.ticket, repairTicketPath(fx.paths, line.seq));
  // The ticket is the whole spec of the repair: the repair run reads it from a
  // fresh worktree and sees nothing else.
  const ticket = readFileSync(escape.ticket, 'utf8');
  assert.match(ticket, new RegExp(`escape: seq ${line.seq}`));
  assert.match(ticket, /the second row is lost/);
  assert.match(ticket, new RegExp(`merge commit: ${merged.mergeSha}`));
  // What the sweep will find.
  const owed = owedRepairs(fx.paths, 'proj');
  assert.deepEqual(owed.map((e) => e.seq), [line.seq]);
  assert.deepEqual(owedRepairs(fx.paths, 'other'), []);
});

test('one overlapping file takes the full re-verdict', async (t) => {
  const fx = fastPathFixture(t);
  // `src/base.mjs` is under the layer's declared input and the story never
  // touched it, so the merge is clean and the ground is not.
  const { events } = await shipOverMerge(
    fx,
    { 'src/base.mjs': 'export const base = 2;\n' },
    'src: a competing edit',
  );
  const fast = events.find((e) => e.event === 'fast-path-ship');
  assert.equal(fast.taken, false);
  assert.equal(fast.refusal, 'ground-intersects');
  assert.match(fast.detail, /src\/base\.mjs is a declared suite input/);
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 2);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.find((e) => e.event === 'run-closed').fastPath, undefined);
});

test('a merge onto the shared breadth list takes the full re-verdict', async (t) => {
  const fx = fastPathFixture(t);
  const { events } = await shipOverMerge(
    fx,
    { 'package-lock.json': '{"lockfileVersion": 3}\n' },
    'deps: the lockfile moved',
  );
  const fast = events.find((e) => e.event === 'fast-path-ship');
  assert.equal(fast.refusal, 'ground-intersects');
  assert.match(fast.detail, /package-lock\.json is the shared breadth list/);
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 2);
});

test('one suite without a declaration takes the full re-verdict', async (t) => {
  // The stock suite command prints no part markers, so the certified verdict
  // says nothing about what its layer depends on.
  const fx = shipFixture(t, {
    config: {
      gates: {
        tier1: [{ name: 'unit', command: 'suite' }],
        fastPathShip: true,
        breadthGround: ['package-lock.json'],
      },
    },
  });
  const { events } = await shipOverMerge(
    fx,
    { 'docs/note.md': 'unrelated main work\n' },
    'docs: a note',
  );
  const fast = events.find((e) => e.event === 'fast-path-ship');
  assert.equal(fast.refusal, 'undeclared-suite');
  assert.match(fast.detail, /reported no suite/);
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 2);
});

test('a merge onto ground no claim reaches takes the full re-verdict', async (t) => {
  // The same merge that fast-paths above, with the project's inert claim taken
  // away. Nothing in the project says a change under `docs` reaches no suite,
  // and the part machinery's rule for ground nobody described is that doubt
  // re-runs (parts.mjs).
  const fx = fastPathFixture(t, { gates: { inertGround: [] } });
  const { events } = await shipOverMerge(
    fx,
    { 'docs/note.md': 'unrelated main work\n' },
    'docs: a note',
  );
  const fast = events.find((e) => e.event === 'fast-path-ship');
  assert.equal(fast.taken, false);
  assert.equal(fast.refusal, 'unclaimed-ground');
  assert.match(fast.detail, /docs\/note\.md/);
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 2);
  assert.equal(events.find((e) => e.event === 'run-closed').fastPath, undefined);
});

test('a story that moved its own declarations takes the full re-verdict', async (t) => {
  // The declarations decide the skip and they are printed by the layer command
  // running in the run's own worktree. A story that edited the ground they come
  // out of would be judged against the narrowing it wrote itself.
  const fx = fastPathFixture(t, {
    seats: {
      dev: () => ({
        files: {
          'src/feature.mjs': GOOD_FEATURE,
          '.olympus/helper.mjs': 'export const helper = 1;\n',
        },
        report: { summary: 'implemented' },
      }),
    },
  });
  const { events } = await shipOverMerge(
    fx,
    { 'docs/note.md': 'unrelated main work\n' },
    'docs: a note',
  );
  const fast = events.find((e) => e.event === 'fast-path-ship');
  assert.equal(fast.taken, false);
  assert.equal(fast.refusal, 'self-declared-ground');
  assert.match(fast.detail, /\.olympus\/helper\.mjs/);
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 2);
});

test('a report between the merge and the close-out never silences the breach', async (t) => {
  // The breach re-uses the escapes it already recorded, so a crash after the
  // record does not file them twice. The match is the breach's own mark: an
  // escape somebody reported against this run in the same window carries the
  // run id too, and reading that as work already done would leave the red merge
  // with no record of its own findings at all.
  const fx = fastPathFixture(t, { pollMs: 300 });
  fx.forge.state.autoChecks = () => [running()];
  fx.forge.state.onRerun = () => {};
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'freeze', 'freeze');
  commitTree(fx.origin, { 'docs/note.md': 'unrelated main work\n' }, 'docs: a note');
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  fx.forge.setChecks(opened.sha, [red()]);
  fx.forge.adminMerge();
  const merged = await waitEvent(fx.paths, runId, (e) => e.event === 'merged', 'merged');
  // The operator gets there first, against the very merge the breach is about.
  fx.daemon.recordEscapeReport({
    actor: 'console:test',
    project: 'proj',
    defectLine: 'a person found this one first',
    pr: merged.pr,
  });
  const events = await waitClosed(fx.paths, runId);
  const breach = events.find((e) => e.event === 'red-merge-breach');
  assert.ok(breach, 'the red merge recorded no breach');
  assert.equal(breach.escapes.length, 1);
  const escapes = readEscapeSet(fx.paths.escapesLedger);
  assert.equal(escapes.length, 2);
  const own = escapes.find((e) => e.seq === breach.escapes[0]);
  assert.equal(own.detectionSource, 'harness-self');
  assert.match(own.defectLine, /red merge on PR/);
  assert.equal(own.refs.redMergeBreach, true);
  // Both are ticketed and both are owed: neither swallowed the other.
  assert.deepEqual(
    owedRepairs(fx.paths, 'proj').map((e) => e.seq).sort((a, b) => a - b),
    escapes.map((e) => e.seq).sort((a, b) => a - b),
  );
});

test('a fast path a later verdict superseded is not a fast-path ship', () => {
  // A taken record is not the end of the question. The run can carry its
  // certification over one moved base and still render the full verdict later:
  // a red at the request sends it back, and so does a second moved base at the
  // ship stage. That verdict judges the tree that lands, which is the whole of
  // what the fast path skipped. The trade was not made, so the close does not
  // mark the ship and the kind that measures the trade is not assigned.
  const event = (seq, name, extra = {}) => ({ seq, event: name, ...extra });
  const carried = [
    event(1, 'fast-path-ship', { taken: true }),
    event(2, 'merged', { pr: 7 }),
  ];
  assert.equal(fastPathTaken(carried).seq, 1);
  const earned = [
    event(1, 'fast-path-ship', { taken: true }),
    event(2, 'verdict-rendered', { cycle: 2, verdict: 'green' }),
    event(3, 'merged', { pr: 7 }),
  ];
  assert.equal(fastPathTaken(earned), undefined);
  // A verdict BEFORE the record is the certification the fast path carries;
  // only one rendered after it is the re-verdict the path was skipping.
  const before = [
    event(1, 'verdict-rendered', { cycle: 1, verdict: 'green' }),
    event(2, 'fast-path-ship', { taken: true }),
    event(3, 'merged', { pr: 7 }),
  ];
  assert.equal(fastPathTaken(before).seq, 2);
  // A refusal was never a carry.
  assert.equal(fastPathTaken([event(1, 'fast-path-ship', { taken: false })]), undefined);
});

test('a defect on a red merge a fast path carried takes the fast-path word', async (t) => {
  // The other intake for the same kind. An operator reporting a defect gets the
  // word from the ledgers (above); a red merge the harness converts itself gets
  // it here, or the tripwire that measures the trade never sees the ships that
  // breached.
  const fx = fastPathFixture(t, { pollMs: 300 });
  fx.forge.state.autoChecks = () => [running()];
  fx.forge.state.onRerun = () => {};
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'freeze', 'freeze');
  commitTree(fx.origin, { 'docs/note.md': 'unrelated main work\n' }, 'docs: a note');
  await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'pre-verdict-update' && e.ran,
    'the pre-verdict update',
  );
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  fx.forge.setChecks(opened.sha, [red()]);
  fx.forge.adminMerge();
  const events = await waitClosed(fx.paths, runId);
  const fast = events.find((e) => e.event === 'fast-path-ship');
  assert.equal(fast.taken, true);
  const merged = events.find((e) => e.event === 'merged');
  const escapes = readEscapeSet(fx.paths.escapesLedger);
  assert.equal(escapes.length, 1);
  assert.equal(escapes[0].kind, 'fast-path-escape');
  // The ship's own attribution, not the story's: the count is about the ships
  // that carried, and the record has to reach the decision behind it.
  assert.equal(escapes[0].attribution, runId);
  assert.equal(escapes[0].refs.fastPathSeq, fast.seq);
  assert.equal(escapes[0].refs.mergeSha, merged.mergeSha);
  assert.equal(escapes[0].refs.project, 'proj');
});

test('a merge this run never stamped is a merge the resume has to judge', async (t) => {
  // The crash window: the merge commit lands in the worktree and the daemon
  // dies before the stamp. On the resume the merge answers "already up to
  // date", `ran` reads false, and the old reading took the run to the request
  // over a tree no verdict had judged. The tree is the record that survived the
  // crash, and this is the stage's reading of it.
  const fx = fastPathFixture(t);
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  const launched = await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'run-launched',
    'run-launched',
  );
  await waitEvent(fx.paths, runId, (e) => e.event === 'freeze', 'freeze');
  const worktree = launched.worktree;
  const before = gitSync(['rev-parse', 'HEAD'], worktree).trim();
  const events = readEvents(runLedgerPath(fx.paths, runId));
  // No merge in the tree yet: nothing to judge.
  assert.equal(await unstampedMerge({ worktree }, events), null);
  // The merge the crash left behind, stamped nowhere.
  commitTree(fx.origin, { 'docs/late.md': 'a competing note\n' }, 'docs: a note');
  gitSync(['fetch', '--quiet', fx.origin, 'main'], worktree);
  gitSync(
    ['-c', 'commit.gpgsign=false', 'merge', '--no-ff', '-m', 'merge main', 'FETCH_HEAD'],
    worktree,
  );
  const head = gitSync(['rev-parse', 'HEAD'], worktree).trim();
  assert.notEqual(head, before);
  assert.ok(!events.some((e) => e.sha === head || e.toSha === head));
  assert.equal(await unstampedMerge({ worktree }, events), head);
  // A merge the ledger does name is the ordinary case and reads as nothing.
  assert.equal(await unstampedMerge({ worktree }, [...events, { event: 'x', toSha: head }]), null);
});

test('a project that declares no breadth ground never fast-paths', async (t) => {
  const fx = fastPathFixture(t, { gates: { breadthGround: [] } });
  const { events } = await shipOverMerge(
    fx,
    { 'docs/note.md': 'unrelated main work\n' },
    'docs: a note',
  );
  assert.equal(events.find((e) => e.event === 'fast-path-ship').refusal, 'no-breadth-ground');
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 2);
});

test('a conflict the update resolved is never carried', async (t) => {
  const fx = fastPathFixture(t);
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'freeze', 'freeze');
  commitTree(fx.origin, { 'src/feature.mjs': ALT_FEATURE }, 'conflicting main work');
  const round = await waitEvent(fx.paths, runId, (e) => e.event === 'merge-round', 'merge-round');
  assert.equal(round.resolved, true);
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // A resolved conflict is a seat's edit to the tree under judgment. The text
  // question sees it first: the story's own diff is no longer what it was, so
  // no certification of the old tree can stand over the new one.
  const fast = events.find((e) => e.event === 'fast-path-ship');
  assert.equal(fast.taken, false);
  assert.equal(fast.refusal, 'diff-changed');
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 2);
  assert.equal(events.find((e) => e.event === 'run-closed').fastPath, undefined);
});

test('an error inside the check itself falls through, never blocks', async (t) => {
  // A breadth entry the path vocabulary cannot compile. The classification
  // throws where the ground question is asked, which is the whole class of
  // failure inside the check: it is stamped, and the run takes the re-verdict
  // it would have taken anyway.
  const fx = fastPathFixture(t, { gates: { breadthGround: ['src/[z-a]lock.json'] } });
  const { events } = await shipOverMerge(
    fx,
    { 'docs/note.md': 'unrelated main work\n' },
    'docs: a note',
  );
  const fast = events.find((e) => e.event === 'fast-path-ship');
  assert.equal(fast.taken, false);
  assert.equal(fast.refusal, 'internal-error');
  assert.match(fast.detail, /character class/);
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 2);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
});

test('with the flag off the same ship is byte for byte what it always was', async (t) => {
  // Every input of a firing fast path is present: the declarations, the
  // breadth list, a merge onto ground nothing claims. The flag is the only
  // thing missing, and the ship takes the second verdict.
  const fx = fastPathFixture(t, { gates: { fastPathShip: undefined } });
  const { events } = await shipOverMerge(
    fx,
    { 'docs/note.md': 'unrelated main work\n' },
    'docs: a note',
  );
  assert.ok(!events.some((e) => e.event === 'fast-path-ship'));
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  assert.equal(renders.length, 2);
  assert.equal(renders.at(-1).verdict, 'green');
  const update = events.find((e) => e.event === 'pre-verdict-update' && e.ran);
  assert.equal(renders.at(-1).sha, update.toSha);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'shipped');
  assert.equal(closed.fastPath, undefined);
});

test('a base that did not move stamps no fast-path record at all', async (t) => {
  const fx = fastPathFixture(t);
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.find((e) => e.event === 'pre-verdict-update').ran, false);
  // There was no second certification to skip, so there is nothing to record.
  assert.ok(!events.some((e) => e.event === 'fast-path-ship'));
  assert.equal(events.filter((e) => e.event === 'verdict-rendered').length, 1);
});

test('the update cap falls through to the ship-stage update', async (t) => {
  const fx = shipFixture(t);
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  const ranUpdates = () =>
    readEvents(runLedgerPath(fx.paths, runId)).filter(
      (e) => e.event === 'pre-verdict-update' && e.ran,
    ).length;
  await waitEvent(fx.paths, runId, (e) => e.event === 'freeze', 'freeze');
  commitTree(fx.origin, { 'docs/one.md': 'one\n' }, 'competing merge one');
  await waitFor(() => ranUpdates() === 1, { attempts: 600, intervalMs: 100, label: 'first update' });
  commitTree(fx.origin, { 'docs/two.md': 'two\n' }, 'competing merge two');
  await waitFor(() => ranUpdates() === 2, { attempts: 600, intervalMs: 100, label: 'second update' });
  const capped = await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'pre-verdict-update' && e.capped,
    'the update cap',
  );
  assert.equal(capped.ran, false);
  assert.equal(capped.cap, UPDATE_CAP);
  assert.equal(capped.updates, UPDATE_CAP);
  // Past the cap the ship stage takes the update, exactly as it always did.
  commitTree(fx.origin, { 'docs/three.md': 'three\n' }, 'competing merge three');
  const update = await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'branch-update',
    'the ship-stage update',
  );
  assert.ok(update.seq > capped.seq);
  fx.forge.setChecks(update.toSha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.filter((e) => e.event === 'pre-verdict-update' && e.ran).length, UPDATE_CAP);
  assert.equal(events.filter((e) => e.event === 'pre-verdict-update' && e.capped).length, 1);
});

test('a run waits for the ship token, and its first act under it is the update', async (t) => {
  const fx = shipFixture(t);
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  // Another run of the project is mid-ship: its request is open and unmerged,
  // so it holds the token and nothing here may open one.
  const holder = openRunStore(fx.paths, 'proj-holder');
  t.after(() => holder.close());
  holder.append('run-launched', { actor: 'daemon', project: 'proj', lane: 'story' });
  holder.append('pr-opened', { actor: 'daemon', pr: 99, branch: 'run/other', base: 'main' });
  const waited = await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'ship-token' && e.state === 'waiting',
    'the token wait',
  );
  assert.equal(waited.holder, 'proj-holder');
  assert.equal(waited.ahead, 0);
  assert.ok(!readEvents(runLedgerPath(fx.paths, runId)).some((e) => e.event === 'pr-opened'));
  // The holder merges: main moves, and its turn is over.
  commitTree(fx.origin, { 'docs/note.md': 'the holder shipped\n' }, 'the holder merge');
  holder.append('merged', { actor: 'daemon', pr: 99, sha: 'a'.repeat(40), red: false });
  const acquired = await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'ship-token' && e.state === 'acquired',
    'the acquire',
  );
  const update = await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'pre-verdict-update',
    'the first act under the token',
  );
  assert.ok(update.seq > acquired.seq);
  assert.equal(update.ran, true);
  assert.equal(update.mainSha, gitSync(['rev-parse', 'main'], fx.origin).trim());
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  assert.ok(opened.seq > update.seq);
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The request opened on the post-merge base: it never went behind.
  assert.ok(!events.some((e) => e.event === 'branch-update'));
});

// -- the restore anchor after an update --------------------------------------

// A story that shipped while this run was in flight. It moved a source file
// and the test path that covers it; this run's spec names neither, and its
// frozen suite holds neither.
const SHIPPED_SRC = 'export const shipped = () => 1;\n';
const SHIPPED_SRC_NEXT = 'export const shipped = () => 2;\n';
const shippedTest = (answer) => `import test from 'node:test';
import assert from 'node:assert/strict';
test('shipped answers ${answer}', async () => {
  const { shipped } = await import('../src/shipped.mjs');
  assert.equal(shipped(), ${answer});
});
`;

/** File content with the line endings a checkout may have normalized. */
function readAt(dir, path) {
  return readFileSync(join(dir, path), 'utf8').replace(/\r\n/g, '\n');
}

test('the verdict behind an update judges main\'s version of a test path the run does not own', async (t) => {
  const fx = shipFixture(t, {
    files: { 'src/shipped.mjs': SHIPPED_SRC, 'tests/shipped.test.mjs': shippedTest(1) },
    // A red second cycle would reach triage; the seat is here so the scenario
    // renders that red instead of parking on a missing fixture behavior.
    seats: {
      'verdict-triage': () => ({
        report: {
          findings: [
            {
              class: 'harness',
              layers: ['unit'],
              summary: 'the suite restore reverted a merged test path',
              evidence: 'the fixture asserts this never runs',
            },
          ],
          persisting: [],
          summary: 'one finding',
        },
      }),
    },
  });
  fx.forge.state.autoChecks = () => [running()];
  const runId = await fx.launch();
  await waitEvent(fx.paths, runId, (e) => e.event === 'freeze', 'freeze');
  commitTree(
    fx.origin,
    { 'src/shipped.mjs': SHIPPED_SRC_NEXT, 'tests/shipped.test.mjs': shippedTest(2) },
    'a later story ships',
  );
  const update = await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'pre-verdict-update' && e.ran,
    'the pre-verdict update',
  );
  // The cycle the update earned. Anchored on the launch base it would restore
  // the pre-merge test over the merged source and go red on shipped work.
  const render = await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'verdict-rendered' && e.seq > update.seq,
    'the post-update verdict',
  );
  assert.equal(render.verdict, 'green');
  assert.equal(render.sha, update.toSha);
  assert.ok(!fx.calls.some((c) => c.seat === 'verdict-triage'));
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr-opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(gitSync(['show', 'main:tests/shipped.test.mjs'], fx.origin), shippedTest(2));
});

test('a merge-born fresh pass carries the frozen suite onto main and reverts nothing', async (t) => {
  const fx = shipFixture(t, {
    files: { 'src/shipped.mjs': SHIPPED_SRC, 'tests/shipped.test.mjs': shippedTest(1) },
    seats: {
      dev: ({ prompt }) => {
        if (prompt.includes('textual conflicts')) return { exitCode: 1 }; // the round fails
        return { files: { 'src/feature.mjs': GOOD_FEATURE }, report: { summary: 'implemented' } };
      },
      // The reverting shape renders a red here; the seat is what lets it
      // render instead of parking on a missing fixture behavior.
      'verdict-triage': () => ({
        report: {
          findings: [
            {
              class: 'harness',
              layers: ['unit'],
              summary: 'the suite carry reverted a merged test path',
              evidence: 'the fixture asserts this never runs',
            },
          ],
          persisting: [],
          summary: 'one finding',
        },
      }),
    },
  });
  // The checks answer to the run's own state, and never to a flip this test
  // performs at a moment it does not control. The fixture forge resolves
  // `autoChecks` once per head sha and keeps that answer, so a daemon that
  // reached the fresh pass's sha before a mid-test flip would hold a check
  // that never completes and the run would wait on it for ever. It is the
  // fresh pass that decides: the shas before it carry the conflict this test
  // is about, and the sha born on the moved base is the one that ships.
  let runId;
  fx.forge.state.autoChecks = () =>
    runId && readEvents(runLedgerPath(fx.paths, runId)).some((e) => e.event === 'fresh-pass')
      ? [green()]
      : [running()];
  fx.forge.state.conflictMode = true;
  runId = await fx.launch();
  await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'pr-opened',
    'pr-opened',
    LONGEST_JOURNEY_ATTEMPTS,
  );
  // main moves under the request in two ways at once: a source file this run
  // is in conflict with, and a test path it neither owns nor names.
  commitTree(
    fx.origin,
    {
      'src/feature.mjs': ALT_FEATURE,
      'src/shipped.mjs': SHIPPED_SRC_NEXT,
      'tests/shipped.test.mjs': shippedTest(2),
    },
    'conflicting main work beside a shipped test',
  );
  const fresh = await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'fresh-pass',
    'fresh-pass',
    LONGEST_JOURNEY_ATTEMPTS,
  );
  assert.equal(fresh.trigger, 'merge-conflict');
  // The pass is born on updated main, so no sha the run already holds names
  // its tree: it composes one, and that is the anchor from here.
  assert.equal(typeof fresh.sha, 'string');
  const untilFresh = readEvents(runLedgerPath(fx.paths, runId)).filter((e) => e.seq <= fresh.seq);
  assert.equal(restoreAnchor(untilFresh), fresh.sha);
  // Carried onto main it is green. Restored onto main it would hold the
  // launch-base test beside the source main advanced, and go red on work that
  // shipped before this run.
  const render = await waitEvent(
    fx.paths,
    runId,
    (e) => e.event === 'verdict-rendered' && e.seq > fresh.seq,
    'the fresh pass verdict',
    LONGEST_JOURNEY_ATTEMPTS,
  );
  assert.equal(render.verdict, 'green');
  assert.ok(!fx.calls.some((c) => c.seat === 'verdict-triage'));
  // The longest journey in this file: a conflicted request, a fresh pass born
  // on the moved branch, a second spectrum, then the ship.
  const events = await waitClosed(fx.paths, runId, LONGEST_JOURNEY_ATTEMPTS);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // Both halves shipped: the conflict dissolved on the new base, the frozen
  // suite came with it, and the test path the run does not own is still the
  // version main shipped.
  assert.equal(gitSync(['show', 'main:src/feature.mjs'], fx.origin), GOOD_FEATURE);
  assert.equal(gitSync(['show', 'main:tests/feature.test.mjs'], fx.origin), STRONG_TEST);
  assert.equal(gitSync(['show', 'main:tests/shipped.test.mjs'], fx.origin), shippedTest(2));
  assert.equal(gitSync(['show', 'main:src/shipped.mjs'], fx.origin), SHIPPED_SRC_NEXT);
});

test('the restore at the merged anchor keeps main\'s test paths and drops the seat\'s own writes', async (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const repo = initOriginRepo(join(root, 'repo'), {
    'src/shipped.mjs': SHIPPED_SRC,
    'tests/shipped.test.mjs': shippedTest(1),
  });
  gitSync(['checkout', '-b', 'run/alpha'], repo);
  const suiteSha = commitTree(repo, { 'tests/feature.test.mjs': STRONG_TEST }, 'suite: freeze');
  gitSync(['checkout', 'main'], repo);
  commitTree(
    repo,
    { 'src/shipped.mjs': SHIPPED_SRC_NEXT, 'tests/shipped.test.mjs': shippedTest(2) },
    'a later story ships',
  );
  gitSync(['checkout', 'run/alpha'], repo);
  gitSync(['-c', 'commit.gpgsign=false', 'merge', '-m', 'merge main', 'main'], repo);
  const mergedSha = gitSync(['rev-parse', 'HEAD'], repo).trim();
  const events = [
    { event: 'freeze', sha: suiteSha },
    { event: 'pre-verdict-update', ran: true, toSha: mergedSha },
  ];
  assert.equal(restoreAnchor(events), mergedSha);
  // What the seat left in the tree: a write to a frozen test path, a test file
  // of its own, and the implementation it was asked for.
  const seatWrites = {
    'tests/shipped.test.mjs': shippedTest(99),
    'tests/seat.test.mjs': 'the seat wrote this\n',
    'src/feature.mjs': GOOD_FEATURE,
  };
  writeTree(repo, seatWrites);
  await restorePaths(repo, restoreAnchor(events), ['tests']);
  assert.equal(readAt(repo, 'tests/shipped.test.mjs'), shippedTest(2));
  assert.equal(readAt(repo, 'tests/feature.test.mjs'), STRONG_TEST);
  assert.ok(!existsSync(join(repo, 'tests/seat.test.mjs')));
  assert.equal(readAt(repo, 'src/feature.mjs'), GOOD_FEATURE);
  // The anchor is the whole of the difference: the same restore against the
  // freeze commit reverts the merged file to the version the run launched on.
  writeTree(repo, seatWrites);
  await restorePaths(repo, restoreAnchor(events.slice(0, 1)), ['tests']);
  assert.equal(readAt(repo, 'tests/shipped.test.mjs'), shippedTest(1));
});

test('the restore anchor follows the tree: the freeze, then the merge, then the freeze again', () => {
  const freeze = { event: 'freeze', sha: 'f'.repeat(40) };
  const merged = { event: 'pre-verdict-update', ran: true, toSha: 'm'.repeat(40) };
  assert.equal(restoreAnchor([]), null);
  // A run that never updated restores from exactly what it always restored
  // from: an update that found the base where the run left it moves nothing,
  // and neither does a capped one.
  assert.equal(restoreAnchor([freeze]), freeze.sha);
  assert.equal(
    restoreAnchor([freeze, { event: 'pre-verdict-update', ran: false, mainSha: 'a'.repeat(40) }]),
    freeze.sha,
  );
  assert.equal(
    restoreAnchor([freeze, { event: 'pre-verdict-update', ran: false, capped: true }]),
    freeze.sha,
  );
  assert.equal(restoreAnchor([freeze, merged]), merged.toSha);
  // The ship-stage update merges the same branch into the same tree.
  assert.equal(
    restoreAnchor([freeze, { event: 'branch-update', toSha: 'b'.repeat(40) }]),
    'b'.repeat(40),
  );
  // A re-freeze is authored on the merged tree, so it takes the anchor back.
  const refreeze = { event: 're-freeze', sha: 'r'.repeat(40) };
  assert.equal(restoreAnchor([freeze, merged, refreeze]), refreeze.sha);
  assert.equal(restoreAnchor([freeze, merged, refreeze, merged]), merged.toSha);
  // A fresh pass anchors on the tree it was born on. A pass reset to the
  // pre-implementation commit drops the merge with it, and its stamp names the
  // suite it carried forward; a pass from a ledger written before the stamp
  // existed falls back to the same commit, which is where its restores went.
  const carried = { event: 'fresh-pass', pass: 2, sha: freeze.sha };
  assert.equal(restoreAnchor([freeze, merged, carried]), freeze.sha);
  assert.equal(restoreAnchor([freeze, merged, { event: 'fresh-pass', pass: 2 }]), freeze.sha);
  assert.equal(
    restoreAnchor([freeze, merged, refreeze, { event: 'fresh-pass', pass: 2 }]),
    refreeze.sha,
  );
  // A merge-born pass is born on the updated default branch, and the commit it
  // composes there carries both halves; nothing the run already held does.
  const born = { event: 'fresh-pass', pass: 2, sha: 'c'.repeat(40) };
  assert.equal(restoreAnchor([freeze, born]), born.sha);
  assert.equal(
    restoreAnchor([freeze, born, { event: 'branch-update', toSha: 'd'.repeat(40) }]),
    'd'.repeat(40),
  );
});

// -- gh adapter units --------------------------------------------------------

test('parseGitHubRepo handles the common remote shapes', () => {
  assert.equal(parseGitHubRepo('https://github.com/acme/widgets'), 'acme/widgets');
  assert.equal(parseGitHubRepo('https://github.com/acme/widgets.git'), 'acme/widgets');
  assert.equal(parseGitHubRepo('git@github.com:acme/widgets.git'), 'acme/widgets');
  assert.equal(parseGitHubRepo('ssh://git@github.com/acme/widgets'), 'acme/widgets');
  assert.equal(parseGitHubRepo('/local/path/repo'), null);
});

test('the gh adapter builds the documented argv and maps the answers', async () => {
  const calls = [];
  const answers = [
    'true\n', // `gh api --jq .allow_auto_merge` prints the bare boolean
    JSON.stringify({ strict: true, contexts: ['ci', 'e2e'] }),
    JSON.stringify({
      state: 'OPEN',
      headRefOid: 'abc123',
      mergeCommit: null,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
      autoMergeRequest: { enabledAt: 'now' },
    }),
  ];
  const runner = async (argv) => {
    calls.push(argv);
    return { code: 0, output: answers.shift() ?? '{}' };
  };
  const forge = gitHubForge({ repo: 'acme/widgets', runner });
  const pf = await forge.preflight('main');
  assert.deepEqual(pf, { autoMergeAllowed: true, strict: true, requiredChecks: ['ci', 'e2e'] });
  assert.deepEqual(calls[0], ['gh', 'api', 'repos/acme/widgets', '--jq', '.allow_auto_merge']);
  assert.equal(calls[1][2], 'repos/acme/widgets/branches/main/protection/required_status_checks');
  const st = await forge.prState(7);
  assert.deepEqual(st, {
    state: 'open',
    headSha: 'abc123',
    mergeSha: null,
    behindBase: true,
    conflicting: false,
    autoMergeArmed: true,
  });
});

test('the gh adapter classifies the conflicting state from the answer that names it', async () => {
  const view = (extra) => async () => ({
    code: 0,
    output: JSON.stringify({
      state: 'OPEN',
      headRefOid: 'abc123',
      mergeCommit: null,
      autoMergeRequest: null,
      ...extra,
    }),
  });
  const conflicting = async (extra) =>
    (await gitHubForge({ repo: 'acme/widgets', runner: view(extra) }).prState(7)).conflicting;
  // Both of the forge's answers about a request in conflict carry it, and
  // either one on its own is the classification: no merge ref is built, so no
  // workflow runs and the head sha can carry no check at all.
  assert.equal(await conflicting({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), true);
  assert.equal(await conflicting({ mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' }), true);
  assert.equal(await conflicting({ mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' }), true);
  // Every other state is one the ship loop already knows how to read.
  assert.equal(await conflicting({ mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }), false);
  assert.equal(await conflicting({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNSTABLE' }), false);
});

test('the preflight reads the auto-merge capability over the repository api', async () => {
  const calls = [];
  const runner = async (argv) => {
    calls.push(argv);
    if (argv.includes('.allow_auto_merge')) return { code: 0, output: 'false\n' };
    return { code: 0, output: JSON.stringify({ strict: true, contexts: ['ci'] }) };
  };
  const pf = await gitHubForge({ repo: 'acme/widgets', runner }).preflight('main');
  assert.equal(pf.autoMergeAllowed, false);
  // `gh repo view --json` carries no autoMergeAllowed field. A call that asks
  // for one exits non-zero and takes the whole ship stage down with it, so no
  // preflight call may name that field or reach for `repo view` again.
  assert.ok(!calls.some((argv) => argv.includes('autoMergeAllowed')));
  assert.ok(!calls.some((argv) => argv[1] === 'repo'));
});

test('the gh adapter puts the labels on the create call, not on a call after it', async () => {
  const calls = [];
  const runner = async (argv) => {
    calls.push(argv);
    if (argv[2] === 'create') return { code: 0, output: '' };
    return { code: 0, output: JSON.stringify({ number: 12, url: 'https://f/12', state: 'OPEN' }) };
  };
  const pr = await gitHubForge({ repo: 'acme/widgets', runner }).openPr({
    head: 'run/x',
    base: 'main',
    title: 't',
    body: 'b',
    labels: ['migration', 'ui'],
  });
  // `labelled` is the forge saying the request never existed unlabelled, so
  // the ship step spends no second call on it.
  assert.deepEqual(pr, { number: 12, url: 'https://f/12', labelled: true });
  const create = calls.find((argv) => argv[2] === 'create');
  assert.deepEqual(create.slice(-4), ['--label', 'migration', '--label', 'ui']);
  assert.equal(calls.filter((argv) => argv[2] === 'create').length, 1);
  assert.ok(!calls.some((argv) => argv[2] === 'edit'));
});

test('a create the labels refuse opens the request bare and reports it unlabelled', async () => {
  const calls = [];
  let opened = false;
  const runner = async (argv) => {
    calls.push(argv);
    if (argv[2] === 'create') {
      // The host resolves the label names before it opens anything, so an
      // undefined label leaves no request at all.
      if (argv.includes('--label')) {
        return { code: 1, output: "could not add label: 'migration' not found" };
      }
      opened = true;
      return { code: 0, output: '' };
    }
    return opened
      ? { code: 0, output: JSON.stringify({ number: 12, url: 'https://f/12', state: 'OPEN' }) }
      : { code: 1, output: 'no pull requests found for branch run/x' };
  };
  const pr = await gitHubForge({ repo: 'acme/widgets', runner }).openPr({
    head: 'run/x',
    base: 'main',
    title: 't',
    body: 'b',
    labels: ['migration'],
  });
  // The request exists, and it says it carries nothing: the ship step's apply
  // path then parks on the forge's own reason, which is where that refusal has
  // always been read.
  assert.deepEqual(pr, { number: 12, url: 'https://f/12', labelled: false });
  assert.equal(calls.filter((argv) => argv[2] === 'create').length, 2);
});

test('the gh adapter lists CI secret names, and an unreadable list is not an empty one', async () => {
  const calls = [];
  const listing = async (argv) => {
    calls.push(argv);
    return { code: 0, output: JSON.stringify({ secrets: [{ name: 'PAY_KEY' }, { name: 'CDN' }] }) };
  };
  const forge = gitHubForge({ repo: 'acme/widgets', runner: listing });
  assert.deepEqual(await forge.ciSecrets(), ['PAY_KEY', 'CDN']);
  // The endpoint serves names; nothing here asks a secret for its value.
  assert.ok(calls.every((argv) => !argv.some((a) => String(a).includes('value'))));
  const refusing = async () => ({ code: 1, output: 'gh: Not Found (HTTP 404)' });
  // A list nobody could read is not a statement that a secret is missing.
  assert.equal(await gitHubForge({ repo: 'acme/widgets', runner: refusing }).ciSecrets(), null);
});

test('an unreadable auto-merge capability reads as off, never as a stage failure', async () => {
  const runner = async (argv) =>
    argv.includes('.allow_auto_merge')
      ? { code: 1, output: 'gh: Not Found (HTTP 404)' }
      : { code: 0, output: JSON.stringify({ strict: true, contexts: ['ci'] }) };
  const pf = await gitHubForge({ repo: 'acme/widgets', runner }).preflight('main');
  // Same posture as the protection read beside it: the ship step parks the
  // provisioning gate, and the daemon never self-clears it.
  assert.deepEqual(pf, { autoMergeAllowed: false, strict: true, requiredChecks: ['ci'] });
});

/** A commit whose failed check is one job of a workflow of another name. */
function checkOutputRunner({ log = null, logCode = 0, checkRuns = null, runStatus = 'completed' } = {}) {
  const calls = [];
  const runner = async (argv) => {
    calls.push(argv);
    if (argv[1] === 'api' && /\/actions\/runs\/\d+$/.test(argv[2])) {
      // The state of the workflow run the check is a job of. `null` is the
      // forge refusing the read, which is not an answer about the run.
      if (runStatus === null) return { code: 1, output: 'gh: Not Found (HTTP 404)' };
      return {
        code: 0,
        output: JSON.stringify({
          status: runStatus,
          conclusion: runStatus === 'completed' ? 'failure' : null,
        }),
      };
    }
    if (argv[1] === 'api' && argv[2].endsWith('/check-runs')) {
      return {
        code: 0,
        output: JSON.stringify({
          check_runs: checkRuns ?? [
            {
              name: 'build-web',
              status: 'completed',
              conclusion: 'success',
              details_url: 'https://github.com/acme/widgets/actions/runs/900/job/11',
            },
            {
              name: 'build-api',
              status: 'completed',
              conclusion: 'failure',
              details_url: 'https://github.com/acme/widgets/actions/runs/900/job/22',
            },
          ],
        }),
      };
    }
    if (argv[1] === 'run' && argv[2] === 'view') return { code: logCode, output: log ?? '' };
    // A workflow run answers with the name of the workflow, never the name of
    // the check: a resolution over `gh run list` matches nothing at all.
    if (argv[1] === 'run' && argv[2] === 'list') {
      return { code: 0, output: JSON.stringify([{ databaseId: 900, name: 'PR', conclusion: 'failure' }]) };
    }
    return { code: 0, output: '' };
  };
  return { calls, runner };
}

test('the adapter reads the log of the attempt the caller holds, by its own link', async () => {
  // The capture holds one check run and wants that one's log. Nothing here
  // re-finds a check by name, so nothing here can choose a different attempt.
  const { calls, runner } = checkOutputRunner({ log: 'step\tassertion failed\n' });
  const forge = gitHubForge({ repo: 'acme/widgets', runner });
  const out = await forge.checkLog({
    name: 'build-api',
    detailsUrl: 'https://github.com/acme/widgets/actions/runs/900/job/22',
  });
  assert.match(out, /assertion failed/);
  assert.ok(!calls.some((argv) => argv[2].endsWith('/check-runs')), 'no lookup by name');
  assert.deepEqual(calls.at(-1), [
    'gh', 'run', 'view', '--job', '22', '-R', 'acme/widgets', '--log-failed',
  ]);
  // A check with no job behind it answers with the reason, as every other
  // absence on this path does.
  assert.equal(
    noLogReason(await forge.checkLog({ name: 'sentinel', detailsUrl: null })),
    'no workflow job behind the check, at no url',
  );
});

test('a name with three attempts on it reads the last one, in either list order', async () => {
  // The measured shape: one check name carrying success, failure and skipped
  // at once. `find` over the forge's list took whichever came back first.
  const attempt = (id, conclusion, at, job) => ({
    id,
    name: 'build-api',
    status: 'completed',
    conclusion,
    started_at: at,
    details_url: `https://github.com/acme/widgets/actions/runs/900/job/${job}`,
  });
  const attempts = [
    attempt(1, 'failure', '2026-08-10T00:00:00Z', 11),
    attempt(2, 'skipped', '2026-08-10T01:00:00Z', 22),
    attempt(3, 'failure', '2026-08-10T02:00:00Z', 33),
  ];
  for (const order of [attempts, [...attempts].reverse()]) {
    const { calls, runner } = checkOutputRunner({ log: 'boom\n', checkRuns: order });
    const out = await gitHubForge({ repo: 'acme/widgets', runner }).checkOutput('sha1', 'build-api');
    assert.match(out, /boom/);
    assert.equal(calls.at(-1)[4], '33');
  }
});

test('the gh adapter reads a failed log through the check the watcher named', async () => {
  const { calls, runner } = checkOutputRunner({ log: 'step\tassertion failed: 1 !== 2\n' });
  const out = await gitHubForge({ repo: 'acme/widgets', runner }).checkOutput('sha1', 'build-api');
  assert.match(out, /assertion failed/);
  // The check names the job; the job id comes off the check's own link, and
  // the log call asks for that job. Any name match against workflow runs
  // resolves nothing, so the adapter must not go that way for a log.
  assert.deepEqual(calls.at(-1), [
    'gh', 'run', 'view', '--job', '22', '-R', 'acme/widgets', '--log-failed',
  ]);
  assert.ok(!calls.some((argv) => argv[1] === 'run' && argv[2] === 'list'));
});

test('the captured log is the tail, and the tail belongs to the failed check', async () => {
  const { calls, runner } = checkOutputRunner({ log: 'x'.repeat(9000) + 'END' });
  const out = await gitHubForge({ repo: 'acme/widgets', runner }).checkOutput('sha1', 'build-api');
  assert.ok(out.length <= 3000, `tail is ${out.length} characters`);
  assert.ok(out.endsWith('END'));
  assert.ok(calls.some((argv) => argv.includes('--job') && argv.includes('22')));
});

test('a job that reports no failed step falls back to the whole job log', async () => {
  const calls = [];
  const { runner: base } = checkOutputRunner();
  const runner = async (argv) => {
    calls.push(argv);
    if (argv.includes('--log-failed')) return { code: 0, output: '' }; // cancelled before a step failed
    if (argv.includes('--log')) return { code: 0, output: 'the runner lost the job\n' };
    return base(argv);
  };
  const out = await gitHubForge({ repo: 'acme/widgets', runner }).checkOutput('sha1', 'build-api');
  assert.match(out, /the runner lost the job/);
  assert.ok(calls.some((argv) => argv.includes('--log-failed')));
});

test('a log the forge will not give up is reported with the reason, never as a bare absence', async () => {
  const { runner } = checkOutputRunner({ logCode: 1, log: 'gh: Not Found (HTTP 404)' });
  const forge = gitHubForge({ repo: 'acme/widgets', runner });
  const out = await forge.checkOutput('sha1', 'build-api');
  // The triage seat reads this string. An absence with no reason sends it to
  // fetch the log itself, so the reason travels with the failure.
  assert.match(out, /job 22/);
  assert.match(out, /HTTP 404/);

  const missing = await forge.checkOutput('sha1', 'nothing-of-that-name');
  assert.match(missing, /no check of that name/);

  const green = await forge.checkOutput('sha1', 'build-web');
  assert.match(green, /completed\/success/);

  const foreign = gitHubForge({
    repo: 'acme/widgets',
    runner: checkOutputRunner({
      checkRuns: [
        {
          name: 'build-api',
          status: 'completed',
          conclusion: 'failure',
          details_url: 'https://coverage.example/report/7',
        },
      ],
    }).runner,
  });
  assert.match(await foreign.checkOutput('sha1', 'build-api'), /no workflow job/);
});

test('a forge that cannot run at all still answers the triage input with a reason', async () => {
  const runner = async () => ({ code: null, output: '', error: 'spawn gh ENOENT' });
  const out = await gitHubForge({ repo: 'acme/widgets', runner }).checkOutput('sha1', 'build-api');
  assert.match(out, /ENOENT/);
});

test('a log and the reason there is none are the same type, and told apart here', async () => {
  // The caller counts the absences, so it must not be the one recognizing
  // prose it did not write: the module that authors the sentence reads it.
  const { runner } = checkOutputRunner({ logCode: 1, log: 'gh: Not Found (HTTP 404)' });
  const forge = gitHubForge({ repo: 'acme/widgets', runner });
  assert.equal(
    noLogReason(await forge.checkOutput('sha1', 'nothing-of-that-name')),
    'the commit carries no check of that name',
  );
  assert.match(noLogReason(await forge.checkOutput('sha1', 'build-api')), /HTTP 404/);
  const { runner: whole } = checkOutputRunner({ log: 'assertion failed at line 4\n' });
  const output = await gitHubForge({ repo: 'acme/widgets', runner: whole }).checkOutput(
    'sha1',
    'build-api',
  );
  assert.match(output, /assertion failed/);
  assert.equal(noLogReason(output), null);
  // A log that merely reads like one is still a log: nothing else answers.
  assert.equal(noLogReason('(no failure log for ci: it is queued) and then more'), null);
  assert.equal(noLogReason(undefined), null);
});

test('every check the adapter reports names the workflow run it is a job of', async () => {
  const { runner } = checkOutputRunner();
  const forge = gitHubForge({ repo: 'acme/widgets', runner });
  assert.deepEqual((await forge.checkRuns('sha1')).map((r) => r.run), ['900', '900']);
  assert.deepEqual(await forge.workflowRun('900'), {
    id: '900',
    status: 'completed',
    conclusion: 'failure',
  });
  // A check no workflow produced carries no run: there is nothing to wait for.
  const foreign = gitHubForge({
    repo: 'acme/widgets',
    runner: checkOutputRunner({
      checkRuns: [{ name: 'coverage', status: 'completed', details_url: 'https://coverage.example/report/7' }],
    }).runner,
  });
  assert.deepEqual((await foreign.checkRuns('sha1')).map((r) => r.run), [null]);
});

test('the log fetch refuses a workflow run that has not finished', async () => {
  const { calls, runner } = checkOutputRunner({ log: 'the steps so far\n', runStatus: 'in_progress' });
  const forge = gitHubForge({ repo: 'acme/widgets', runner });
  await assert.rejects(
    () => forge.checkOutput('sha1', 'build-api'),
    (error) => {
      // Loud, and never the half-log: a caller that got here has a defect, and
      // a reason string would travel into a triage prompt as evidence.
      assert.ok(error instanceof PartialLogRefusal, `refusal class: ${error.name}`);
      assert.match(error.message, /workflow run 900 is in_progress/);
      return true;
    },
  );
  assert.ok(!calls.some((argv) => argv.includes('--log-failed') || argv.includes('--log')));
});

test('a run state the forge will not answer for leaves the log fetch as it was', async () => {
  // An unreadable state is not a statement that the run is going. Refusing on
  // it would turn one 404 into a run the harness stops.
  const { runner } = checkOutputRunner({ log: 'assertion failed\n', runStatus: null });
  const out = await gitHubForge({ repo: 'acme/widgets', runner }).checkOutput('sha1', 'build-api');
  assert.match(out, /assertion failed/);
});

test('the close-out sweep records the supersedes the run executed on the card', async (t) => {
  // The run ledger archives with the run. The card outlives it, and the sweep
  // is the one mechanism allowed to write a card on the default branch, so the
  // supersedes go home there (ADR-0044).
  const fx = shipFixture(t, {
    seedExtra: async (ctx) => {
      ctx.store.append('supersede-authorized', {
        actor: 'daemon',
        site: 'verdict',
        finding: 'F1',
        test: 'tests/pinned.test.mjs',
        assertion: 'the published export set is exactly ["f"]',
        cardQuote: 'the export set an earlier story closed is extended here',
        clause: 'scope-boundary',
        card: 'stories/alpha.md',
      });
    },
    seats: {
      'card-sweep': () => ({
        files: { 'stories/alpha.md': DEFAULT_CARD + '\n## Supersedes\n\n- tests/pinned.test.mjs\n' },
        report: { updatedCards: ['stories/alpha.md'], invalidated: [], summary: 'swept' },
      }),
    },
  });
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const sweep = fx.calls.find((c) => c.seat === 'card-sweep').prompt;
  assert.ok(sweep.includes('on this card\'s own authority'));
  assert.ok(sweep.includes('## Supersedes'));
  assert.ok(sweep.includes('tests/pinned.test.mjs'));
  assert.ok(sweep.includes('the export set an earlier story closed is extended here'));
  assert.match(gitSync(['show', 'main:stories/alpha.md'], fx.origin), /## Supersedes/);
});

test('a run that superseded nothing tells the sweep nothing about supersedes', async (t) => {
  const fx = shipFixture(t);
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr opened');
  fx.forge.setChecks(opened.sha, [green()]);
  await waitClosed(fx.paths, runId);
  assert.ok(!fx.calls.find((c) => c.seat === 'card-sweep').prompt.includes('## Supersedes'));
});

// -- the close-out classification (ADR-0052) ---------------------------------

// The card of a later story. Its criteria mandate a second export, which is
// what makes the collision with this ship's frozen suite a consequence rather
// than a question.
const BETA_CARD = `---
key: beta-1
title: Beta extension
---

## Goal

Publish g beside f.

## Acceptance criteria

**AC-1** The module publishes g beside f, so the published set is f and g.
`;

const BETA_NOTE =
  `${FORESEEN_MARKER} tests/feature.test.mjs pins the published export set; AC-1 mandates the ` +
  'second export.';

const BETA_NOTED = `${BETA_CARD}
## ${FORESEEN_HEADING}

- ${BETA_NOTE}
`;

/** A sweep report with the two classified sets and nothing else to do. */
function sweepReport({ foreseen = [], decisions = [], updatedCards = [] } = {}) {
  return { updatedCards, invalidated: [], foreseen, decisions, summary: 'swept' };
}

const BETA_FORESEEN = {
  card: 'stories/beta.md',
  clause: 'the published export set is exactly f',
  file: 'tests/feature.test.mjs',
  mandate: 'AC-1 the module publishes g beside f',
};

test('a collision the later card mandates becomes a note on that card, never a question', async (t) => {
  const fx = shipFixture(t, {
    files: { 'stories/beta.md': BETA_CARD },
    seats: {
      'card-sweep': () => ({
        files: { 'stories/beta.md': BETA_NOTED },
        report: sweepReport({ foreseen: [BETA_FORESEEN], updatedCards: ['stories/beta.md'] }),
      }),
    },
  });
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const sweep = events.find((e) => e.event === 'card-sweep');
  assert.equal(sweep.ok, true);
  assert.equal(sweep.foreseen, 1);
  assert.equal(sweep.decisions, 0);
  // The note is on the default branch, and it holds nothing: no park was
  // written, so the next launch of that card walks past it.
  assert.match(gitSync(['show', 'main:stories/beta.md'], fx.origin), /Foreseen amendment: tests/);
  assert.deepEqual(openCardParks(fx.paths), []);
  // The seat was told which route each class of collision takes.
  const prompt = fx.calls.find((c) => c.seat === 'card-sweep').prompt;
  assert.ok(prompt.includes(`## ${FORESEEN_HEADING}`));
  assert.ok(prompt.includes('never write it as an open decision'));
  assert.ok(prompt.includes('Report foreseen and decisions on every sweep'));
});

test('a note the card does not carry fails the sweep attempt and never the ship', async (t) => {
  const fx = shipFixture(t, {
    files: { 'stories/beta.md': BETA_CARD },
    seats: {
      // The claim is made and the card is left alone: the note exists only in
      // the report, which is exactly what the check refuses.
      'card-sweep': () => ({ report: sweepReport({ foreseen: [BETA_FORESEEN] }) }),
    },
  });
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  // The story shipped. The sweep spent its two attempts and recorded the miss.
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const sweep = events.find((e) => e.event === 'card-sweep');
  assert.equal(sweep.ok, false);
  assert.equal(sweep.cause, 'work-product-defect');
  const failure = events.find((e) => e.event === 'seat-failure' && e.seat === 'card-sweep');
  assert.ok(failure.defects.some((d) => d.includes('is not on stories/beta.md')));
  const attempts = fx.calls.filter((c) => c.seat === 'card-sweep');
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1].prompt.includes('is not on stories/beta.md'));
});

test('a choice the later card leaves open parks that card at close-out, not the run', async (t) => {
  const fx = shipFixture(t, {
    files: { 'stories/beta.md': BETA_CARD },
    seats: {
      'card-sweep': () => ({
        report: sweepReport({
          decisions: [{ card: 'stories/beta.md', question: 'Does g round or truncate?' }],
        }),
      }),
    },
  });
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  // The run that shipped closed shipped; the question holds the card alone.
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.find((e) => e.event === 'card-sweep').decisions, 1);
  const park = readEvents(fx.paths.instanceLedger).find(
    (e) => e.event === 'park' && e.type === 'card-decision',
  );
  assert.equal(park.card, 'stories/beta.md');
  assert.equal(park.decision, 'Does g round or truncate?');
  assert.equal(park.runId, runId);
  assert.ok(park.question.includes('Does g round or truncate?'));
  // A card park offers no abandon: there is no run to close (ADR-0029).
  assert.ok(!(park.answers.options ?? []).includes('abandon'));
  assert.match(readFileSync(fx.paths.queuedStream, 'utf8'), /card-decision/);
  // The frontier reads the same park and blocks that card.
  assert.deepEqual(openCardParks(fx.paths).map((p) => p.card), ['stories/beta.md']);
  // Nothing was written onto the card: a question is asked, never planted.
  assert.ok(!gitSync(['show', 'main:stories/beta.md'], fx.origin).includes(FORESEEN_MARKER));
});

// -- the sweep passes the project's own card lint (ADR-0054) -----------------

// The lint a project puts in front of every human who edits a card: a card
// carries frontmatter. The sweep is a writer like any other, so it clears the
// same check before it pushes.
const CARD_LINT = `import { readdirSync, readFileSync } from 'node:fs';

let checked = 0;
for (const name of readdirSync('stories')) {
  if (!name.endsWith('.md')) continue;
  if (!readFileSync(\`stories/\${name}\`, 'utf8').startsWith('---')) {
    console.error(\`card lint: \${name} carries no frontmatter\`);
    process.exit(1);
  }
  checked++;
}
console.log(\`card lint: \${checked} card(s)\`);
`;

const LINTED = {
  config: {
    commands: { cardlint: ['node', 'scripts/cardlint.mjs'] },
    lanes: { story: { suiteCommand: 'suite', lintCommand: 'cardlint' } },
  },
  files: { 'scripts/cardlint.mjs': CARD_LINT },
};

test('the sweep runs the project card lint over what it wrote, and says so', async (t) => {
  const fx = shipFixture(t, LINTED);
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  const sweep = events.find((e) => e.event === 'card-sweep');
  assert.equal(sweep.ok, true);
  assert.equal(sweep.lint, 'green');
  assert.equal(sweep.pushed, true);
  // One attempt: a green lint costs the sweep nothing.
  assert.equal(fx.calls.filter((c) => c.seat === 'card-sweep').length, 1);
  // The seat was told the lint binds what it writes.
  const prompt = fx.calls.find((c) => c.seat === 'card-sweep').prompt;
  assert.ok(prompt.includes("The project's own card lint runs over everything you write"));
});

test('a card the project lint refuses fails the attempt and never reaches the branch', async (t) => {
  const fx = shipFixture(t, {
    ...LINTED,
    seats: {
      'card-sweep': () => ({
        files: { 'stories/alpha.md': 'A card the project lint refuses.\n' },
        report: { updatedCards: ['stories/alpha.md'], invalidated: [], summary: 'swept' },
      }),
    },
  });
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  // The story shipped; the sweep spent both attempts and recorded the miss.
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const sweep = events.find((e) => e.event === 'card-sweep');
  assert.equal(sweep.ok, false);
  assert.equal(sweep.cause, 'work-product-defect');
  assert.equal(sweep.lint, 'red');
  assert.equal(sweep.pushed, undefined);
  // The red is in the brief of the second attempt, with the lint's own words.
  const attempts = fx.calls.filter((c) => c.seat === 'card-sweep');
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1].prompt.includes('the card lint of this project is red'));
  assert.ok(attempts[1].prompt.includes('carries no frontmatter'));
  const failure = events.find((e) => e.event === 'seat-failure' && e.seat === 'card-sweep');
  assert.ok(failure.defects.some((d) => d.includes('card lint')));
  // Nothing red reached the default branch: the card is as it was.
  assert.equal(gitSync(['show', 'main:stories/alpha.md'], fx.origin), DEFAULT_CARD);
});

test('a lint the host cannot run fails the sweep and pushes nothing', async (t) => {
  const fx = shipFixture(t, {
    config: {
      commands: { cardlint: ['olympus-no-such-binary-xyz'] },
      lanes: { story: { suiteCommand: 'suite', lintCommand: 'cardlint' } },
    },
  });
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  // The story shipped; the sweep spent both attempts and recorded the miss.
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const sweep = events.find((e) => e.event === 'card-sweep');
  assert.equal(sweep.ok, false);
  assert.equal(sweep.cause, 'work-product-defect');
  // The stamp keeps an unrunnable lint apart from a red one.
  assert.equal(sweep.lint, 'unrun');
  assert.equal(sweep.pushed, undefined);
  // Nothing unlinted reached the default branch: the card is as it was.
  assert.equal(gitSync(['show', 'main:stories/alpha.md'], fx.origin), DEFAULT_CARD);
});

test('a lint the host cannot run re-briefs the sweep once, in its own words', async (t) => {
  const fx = shipFixture(t, {
    config: {
      commands: { cardlint: ['olympus-no-such-binary-xyz'] },
      lanes: { story: { suiteCommand: 'suite', lintCommand: 'cardlint' } },
    },
  });
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  const attempts = fx.calls.filter((c) => c.seat === 'card-sweep');
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1].prompt.includes('the card lint of this project could not run'));
  const failure = events.find((e) => e.event === 'seat-failure' && e.seat === 'card-sweep');
  assert.ok(failure.defects.some((d) => d.includes('could not run')));
});

test('a project that declares no card lint sweeps as it always did', async (t) => {
  const fx = shipFixture(t, {});
  const runId = await fx.launch();
  const opened = await waitEvent(fx.paths, runId, (e) => e.event === 'pr-opened', 'pr opened');
  fx.forge.setChecks(opened.sha, [green()]);
  const events = await waitClosed(fx.paths, runId);
  const sweep = events.find((e) => e.event === 'card-sweep');
  assert.equal(sweep.ok, true);
  assert.equal(sweep.lint, 'undeclared');
  assert.ok(!fx.calls.find((c) => c.seat === 'card-sweep').prompt.includes('card lint'));
});
