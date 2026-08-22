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
import { postFreeze, repairLane } from '../src/lanes/verdict.mjs';
import { shipStep, CHECKLESS_POLLS, UPDATE_CAP } from '../src/lanes/ship.mjs';
import { RERUN_BUDGET } from '../src/ledger/cycles.mjs';
import { gitHubForge, noLogReason, parseGitHubRepo, PartialLogRefusal } from '../src/ship/forge.mjs';
import { derivedLabels } from '../src/ship/labels.mjs';
import { commitAll } from '../src/isolation/tree.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { openEscapesStore, openRunStore, TelemetryStore } from '../src/telemetry/stores.mjs';
import { BEATS_PER_STAMP } from '../src/telemetry/heartbeat.mjs';
import { openLoud } from '../src/telemetry/readers.mjs';
import { RUN_EVENTS } from '../src/ledger/registry.mjs';
import { recordEscape, ticketEscape, readEscapeSet } from '../src/telemetry/escapes.mjs';
import { owedRepairs } from '../src/frontier/repairs.mjs';
import { owedReconciliations, reconciliationLaunch } from '../src/frontier/reconciliations.mjs';
import { tempDir, removeDir, waitFor, gitSync, initOriginRepo, commitTree, projectConfigJson } from './helpers.mjs';

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

const green = (name = 'ci') => ({
  name,
  status: 'completed',
  conclusion: 'success',
  startedAt: '2026-08-10T00:00:00Z',
  completedAt: '2026-08-10T00:03:00Z',
});
const red = (name = 'ci') => ({
  name,
  status: 'completed',
  conclusion: 'failure',
  startedAt: '2026-08-10T00:00:00Z',
  completedAt: '2026-08-10T00:02:00Z',
});
/** A check a human stopped: terminal, red, and nobody's flake. */
const cancelled = (name = 'ci') => ({
  name,
  status: 'completed',
  conclusion: 'cancelled',
  startedAt: '2026-08-10T00:00:00Z',
  completedAt: '2026-08-10T00:01:00Z',
});
const running = (name = 'ci') => ({ name, status: 'in_progress' });
/** A red check that names the workflow run it is a job of. */
const redOf = (run, name = 'ci') => ({ ...red(name), run });

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
  const checksFor = (sha) => {
    if (!state.checks.has(sha) && state.autoChecks) state.checks.set(sha, state.autoChecks(sha));
    return state.checks.get(sha) ?? [];
  };
  const allRequiredGreen = (sha) =>
    state.requiredChecks.every((name) => {
      const run = checksFor(sha).find((r) => r.name === name);
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
    state.checks.set(pr.mergeSha, mergeCommitChecks ?? []);
  };
  return {
    state,
    setChecks: (sha, list) => state.checks.set(sha, list),
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
        state.checks.set(
          sha,
          checksFor(sha).map((r) =>
            r.status === 'completed' && r.conclusion !== 'success' ? { name: r.name, status: 'queued' } : r,
          ),
        );
      }
    },
    async checkOutput(sha, name) {
      return `log tail of ${name} at ${sha}`;
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
  for (const seat of ['fury-spec', 'fury-code-shape', 'fury-operational', 'fury-security', 'fury-interface']) {
    seats[seat] = () => ({ report: { findings: [], summary: 'clean' } });
  }
  return seats;
}

/** Seeds the freeze boundary: suite committed, spec written, freeze stamped. */
function seedHandler() {
  return async (ctx) => {
    const worktree = ctx.payload.worktree;
    const full = join(worktree, 'tests/feature.test.mjs');
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, STRONG_TEST);
    const sha = await commitAll(worktree, 'suite: seed');
    writeFileSync(join(ctx.paths.runs, ctx.runId, 'spec.md'), '# Spec\n\nf(x) returns 2*x.\n');
    ctx.store.append('freeze', { actor: 'daemon', sha, killCount: 3, amendmentKills: 0 });
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
    story: { stages: ['seed', ...post.stages], handlers: { seed: seedHandler(), ...post.handlers } },
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
    const tail = existsSync(live)
      ? readEvents(live)
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

function waitEvent(paths, runId, predicate, label) {
  return waitFor(() => readEvents(runLedgerPath(paths, runId)).find(predicate), {
    label,
    attempts: 600,
    intervalMs: 100,
  });
}

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

test('the dispatch reads the run state itself, right before it asks for a log', async (t) => {
  // The watcher's hold keeps an ordinary CI race cheap, and it is one caller
  // up from the call that can produce the wrong answer. This pins the gate at
  // the dispatch: the run state is read again immediately before the first log
  // the triage asks for, so no route in here can judge a partial log.
  const fx = shipFixture(t, { seats: CI_REPAIR_SEATS });
  let shas = 0;
  fx.forge.state.autoChecks = () => (++shas === 1 ? [redOf('900')] : [green()]);
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [redOf('900')]);
  const calls = [];
  const { workflowRun, checkOutput } = fx.forge;
  fx.forge.workflowRun = async (id) => {
    calls.push(`workflowRun:${id}`);
    return workflowRun(id);
  };
  fx.forge.checkOutput = async (sha, name) => {
    calls.push(`checkOutput:${name}`);
    return checkOutput(sha, name);
  };
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const first = calls.findIndex((c) => c.startsWith('checkOutput'));
  assert.ok(first > 0, 'the triage asked for a log');
  assert.equal(calls[first], 'checkOutput:ci');
  assert.equal(calls[first - 1], 'workflowRun:900');
});

// -- the log the forge would not serve ---------------------------------------

test('a triage the forge served no log to stamps the closed kind, once', async (t) => {
  const fx = shipFixture(t, { seats: CI_REPAIR_SEATS });
  let shas = 0;
  fx.forge.state.autoChecks = () => (++shas === 1 ? [redOf('900')] : [green()]);
  fx.forge.state.onRerun = (sha) => fx.forge.setChecks(sha, [redOf('900')]);
  // The forge's own shape for an answer that is a reason and not a log.
  const absence = '(no failure log for ci: the forge would not read job 42: it answered with nothing)';
  fx.forge.checkOutput = async () => absence;
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

test('a cancelled check earns no automatic re-run: the cancel spends the budget', async (t) => {
  // A cancel is somebody stopping the work. Re-running it is the harness
  // deciding the opposite, and a fresh red manufactured that way used to read
  // as a fresh entitlement.
  const fx = shipFixture(t, { seats: CI_REPAIR_SEATS });
  let shas = 0;
  fx.forge.state.autoChecks = () => (++shas === 1 ? [cancelled()] : [green()]);
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(fx.forge.state.reruns.length, 0);
  assert.ok(!events.some((e) => e.event === 'check-transition' && e.status === 'rerun-requested'));
  // The red took the escalation instead: the shared triage, at once.
  assert.equal(
    events.find((e) => e.event === 'check-transition' && e.status === 'cancelled').required,
    true,
  );
  const ciRender = events.find((e) => e.event === 'verdict-rendered' && e.source === 'ci');
  assert.equal(ciRender.verdict, 'red');
  assert.ok(!events.some((e) => e.event === 'ci-flake'));
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
