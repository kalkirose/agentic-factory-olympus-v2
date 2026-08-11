// The ship step: the run ends at close-out, not at the green verdict.
// `shipStep({forgeFor})` supplies the two stages after the verdict — `ship`
// (PR open with auto-merge armed, the check watcher, the CI red route, the
// competing-merge update, the merge round) and `close-out` (red-merge breach
// conversion, merge-commit checks to terminal, the card sweep, the escape
// fix-back, ledger close).
//
// The check watcher is a ledger-stamping process: every observed state
// change stamps `check-transition`; pending is a state, never a verdict; no
// wall-clock timeout detects anything. Persistent CI reds render a red
// verdict (`source: 'ci'`) and re-enter the verdict stage — the same
// four-class triage, the same routes, the same shared budgets as in-run
// reds. Every handler re-derives its position from the run ledger, the git
// state, and the forge, so a daemon restart resumes mid-ship without memory.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { runReportPath } from '../daemon/home.mjs';
import { readEvents } from '../ledger/ledger.mjs';
import { openEscapesStore } from '../telemetry/stores.mjs';
import { recordEscape, fixEscape, readEscapeSet } from '../telemetry/escapes.mjs';
import { cloneDir, fetchClone, branchSha } from '../isolation/clones.mjs';
import { git } from '../isolation/git.mjs';
import {
  headSha,
  push,
  mergeIntoTree,
  concludeMerge,
  abortMerge,
  changedFiles,
  commitAll,
  resetHard,
} from '../isolation/tree.mjs';
import { testEditDenyRules } from '../seats/boundary.mjs';
import { parseIntentCard } from './card.mjs';
import { SUITE_SCHEMA } from './story.mjs';
import {
  DEV_SCHEMA,
  triageStep,
  findingIndex,
  currentPass,
  freshPass,
  answerCount,
} from './verdict.mjs';
import {
  ACTOR,
  loadProjectConfig,
  runEnv,
  runEvents,
  answeredPark,
  invocationCount,
  parkDirective,
  underAny,
  briefLines,
  gist,
} from './shared.mjs';

// Check-run terminal states, normalized: a completed run reports its
// conclusion; a pending run reports its status. `rerun-requested` is the
// watcher's own stamp for the one failed-jobs re-run.
const GREEN = new Set(['success', 'neutral', 'skipped']);
const RED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'stale']);
const TERMINAL = new Set([...GREEN, ...RED]);
const LOG_TAIL = 1500;

export const CARD_SWEEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    updatedCards: { type: 'array', items: { type: 'string' } },
    invalidated: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          card: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['card', 'reason'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['updatedCards', 'invalidated', 'summary'],
};

/**
 * Builds the ship continuation for `postFreeze({afterVerdict})` and
 * `repairLane({afterVerdict})`.
 * @param {{forgeFor: (ctx: object) => object, pollMs?: number,
 *   spawnRepair?: (info: object) => Promise<string|null>}} opts
 *   `forgeFor` resolves the forge of one run from the run's project; the
 *   resolved object implements the interface in ship/forge.mjs. The lane
 *   graph registers once per daemon while the instance holds many projects,
 *   each with its own repository, so the forge is per run and never bound
 *   here. `spawnRepair` launches one repair-lane run per converted escape at
 *   a red-merge breach; a spawn failure leaves the open escape as the
 *   tracking record.
 */
export function shipStep({ forgeFor, pollMs = 15000, spawnRepair = null } = {}) {
  if (typeof forgeFor !== 'function') throw new Error('shipStep requires a forgeFor resolver');
  return {
    stages: ['ship', 'close-out'],
    handlers: {
      ship: shipHandler({ forgeFor, pollMs }),
      'close-out': closeOutHandler({ forgeFor, pollMs, spawnRepair }),
    },
  };
}

// -- the ship stage ----------------------------------------------------------

function shipHandler({ forgeFor, pollMs }) {
  return async function ship(ctx) {
    const base = await shipBase(ctx, forgeFor);
    for (;;) {
      if (ctx.stopped()) return null;
      const events = runEvents(ctx);
      // A crash between a rendered red verdict and the stage transition
      // resumes here; red verdicts belong to the verdict stage.
      const lastRender = findLast(events, 'verdict-rendered');
      if (lastRender && lastRender.verdict === 'red') return { next: 'verdict' };
      if (findLast(events, 'merged')) return { next: 'close-out' };
      // A fresh pass interrupted between its stamp and its dev seat resumes
      // here too; finish it before touching the forge.
      const pendingFresh = findLast(events, 'fresh-pass');
      if (
        pendingFresh?.trigger === 'merge-conflict' &&
        !events.some((e) => e.event === 'implementation-committed' && e.seq > pendingFresh.seq)
      ) {
        return resumeMergeFreshPass(ctx, base, pendingFresh);
      }
      const opened = findLast(events, 'pr-opened');
      if (!opened) {
        const directive = await openPr(ctx, base);
        if (directive) return directive;
        continue;
      }
      const st = await base.forge.prState(opened.pr);
      if (st.state === 'closed') {
        return { close: { state: 'failed', reason: 'pr-closed', pr: opened.pr } };
      }
      if (st.state === 'merged') {
        await stampMerged(ctx, base, opened, st);
        continue;
      }
      const localSha = await headSha(base.worktree);
      if (localSha !== st.headSha) {
        // Repair commits and concluded merge rounds move the branch; the
        // remote follows and CI re-runs on the new sha.
        const directive = await pushBranch(ctx, base, { expected: st.headSha });
        if (directive) return directive;
        continue;
      }
      if (st.behindBase) {
        const directive = await branchUpdate(ctx, base);
        if (directive) return directive;
        continue;
      }
      const directive = await watchChecks(ctx, base, opened, st);
      if (directive) return directive;
      await sleep(pollMs);
    }
  };
}

// -- PR open + preflight -----------------------------------------------------

async function openPr(ctx, base) {
  const pf = await base.forge.preflight(base.defaultBranch);
  if (!pf.autoMergeAllowed || pf.requiredChecks.length === 0) {
    // Hands-off ship needs branch protection naming the full required set
    // and auto-merge allowed; anything less is substrate work. The daemon
    // never self-clears it — report and wait.
    const missing = [
      ...(pf.autoMergeAllowed ? [] : ['auto-merge is not allowed on the repository']),
      ...(pf.requiredChecks.length > 0 ? [] : [`no required checks on ${base.defaultBranch}`]),
    ];
    return parkDirective('provisioning-gate', {
      question: `The ship preflight failed:\n${missing.map((m) => `- ${m}`).join('\n')}`,
    });
  }
  const directive = await pushBranch(ctx, base);
  if (directive) return directive;
  const sha = await headSha(base.worktree);
  const pr = await base.forge.openPr({
    head: base.branch,
    base: base.defaultBranch,
    title: base.storyKey ? `${base.storyKey}: ${base.cardTitle ?? 'ship'}` : `repair: ${ctx.runId}`,
    body: [`Olympus run ${ctx.runId}.`, `Spec: ${base.specRef}`, `Head: ${sha}`].join('\n'),
  });
  const arm = await base.forge.armAutoMerge(pr.number);
  if (!arm.armed) {
    return parkDirective('provisioning-gate', {
      question: `Auto-merge would not arm on PR #${pr.number}: ${arm.reason ?? 'refused'}`,
    });
  }
  ctx.store.append('pr-opened', {
    actor: ACTOR,
    pr: pr.number,
    url: pr.url,
    branch: base.branch,
    base: base.defaultBranch,
    sha,
    required: pf.requiredChecks,
    autoMerge: 'squash',
  });
  return null;
}

async function pushBranch(ctx, base, { expected = null } = {}) {
  try {
    // Plain pushes cover the fast-forward cases. A fresh pass rewrites the
    // run branch's history; that push carries an explicit lease on the
    // remote head the loop just observed — force over exactly that value.
    await push(base.worktree, 'origin', base.branch, { lease: expected });
    return null;
  } catch (error) {
    return parkDirective('provisioning-gate', {
      question: `The remote rejected the push of ${base.branch}:\n${error.message}`,
    });
  }
}

// -- the check watcher -------------------------------------------------------

/** Stamps every observed state change per check, and the ci-flake events. */
function stampTransitions(ctx, opened, sha, runs) {
  const events = runEvents(ctx);
  const last = new Map();
  for (const e of events) {
    if (e.event === 'check-transition' && e.sha === sha) last.set(e.check, e.status);
  }
  const required = new Set(opened.required ?? []);
  for (const run of runs) {
    const status = normalize(run);
    if (last.get(run.name) === status) continue;
    const fields = {
      actor: ACTOR,
      pr: opened.pr,
      sha,
      check: run.name,
      status,
      required: required.has(run.name),
    };
    if (TERMINAL.has(status) && run.startedAt && run.completedAt) {
      fields.duration = Date.parse(run.completedAt) - Date.parse(run.startedAt);
    }
    ctx.store.append('check-transition', fields);
    if (
      GREEN.has(status) &&
      events.some(
        (e) => e.event === 'check-transition' && e.sha === sha && e.check === run.name && RED.has(e.status),
      ) &&
      events.some(
        (e) =>
          e.event === 'check-transition' &&
          e.sha === sha &&
          e.check === run.name &&
          e.status === 'rerun-requested',
      )
    ) {
      // The one automatic re-run turned the check green: a flake, never a
      // finding.
      ctx.store.append('ci-flake', { actor: ACTOR, pr: opened.pr, sha, check: run.name });
    }
  }
}

async function watchChecks(ctx, base, opened, st) {
  const sha = st.headSha;
  const runs = await base.forge.checkRuns(sha);
  stampTransitions(ctx, opened, sha, runs);
  const requiredRuns = (opened.required ?? []).map((name) => runs.find((r) => r.name === name));
  if (requiredRuns.some((r) => !r)) return null; // not all appeared: pending
  const redNow = requiredRuns.filter((r) => RED.has(normalize(r)));
  if (redNow.length > 0) return handleRed(ctx, base, opened, sha, redNow);
  if (requiredRuns.every((r) => GREEN.has(normalize(r)))) {
    if (st.autoMergeArmed) return null; // the merge is the forge's next move
    return greenNoMerge(ctx, base, opened, sha);
  }
  return null; // pending is a state, never a verdict
}

function checkMarks(events, sha, name) {
  let lastRerun = 0;
  let lastRed = 0;
  for (const e of events) {
    if (e.event !== 'check-transition' || e.sha !== sha || e.check !== name) continue;
    if (e.status === 'rerun-requested') lastRerun = e.seq;
    else if (RED.has(e.status)) lastRed = e.seq;
  }
  return { lastRerun, lastRed };
}

async function handleRed(ctx, base, opened, sha, redNow) {
  const events = runEvents(ctx);
  const lastOpFix = findLast(events, 'operational-fix')?.seq ?? 0;
  // One automatic re-run of the failed jobs per sha; an operational fix
  // grants the next one.
  const needRerun = redNow.filter((r) => {
    const { lastRerun } = checkMarks(events, sha, r.name);
    return lastRerun === 0 || lastOpFix > lastRerun;
  });
  if (needRerun.length > 0) {
    await base.forge.rerunFailed(sha);
    for (const r of needRerun) {
      ctx.store.append('check-transition', {
        actor: ACTOR,
        pr: opened.pr,
        sha,
        check: r.name,
        status: 'rerun-requested',
        required: true,
      });
    }
    return null;
  }
  const persistent = redNow.every((r) => {
    const { lastRerun, lastRed } = checkMarks(events, sha, r.name);
    return lastRed > lastRerun;
  });
  if (!persistent) return null; // the re-run is still in flight
  return ciTriage(ctx, base, sha, redNow);
}

/**
 * Persistent CI reds enter the shared four-class triage and render a red
 * verdict (`source: 'ci'`); the verdict stage routes it — same ladders, same
 * budgets as in-run reds.
 */
async function ciTriage(ctx, base, sha, redChecks) {
  const events = runEvents(ctx);
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  const cycle = renders.length + 1;
  const pass = currentPass(events);
  const lastCi = [...renders].reverse().find((r) => r.source === 'ci');
  const index = findingIndex(events);
  const priorOpen = (lastCi?.open ?? [])
    .map((id) => index.get(id))
    .filter(Boolean)
    .filter((f) => f.source === 'triage');
  const reds = [];
  for (const r of redChecks) {
    reds.push({ layer: `ci:${r.name}`, output: await base.forge.checkOutput(sha, r.name) });
  }
  const triaged = await triageStep(ctx, base, { cycle, reds, priorOpen });
  if (triaged.fail) return triaged.fail;
  const openIds = triaged.open.map((f) => f.id);
  const record = {
    runId: ctx.runId,
    cycle,
    pass,
    sha,
    source: 'ci',
    spectrum: reds.map((r) => ({ layer: r.layer, status: 'red' })),
    findings: triaged.open.map((f) => ({ ...f, status: 'open' })),
    open: openIds,
    verdict: 'red',
  };
  const recordPath = join(ctx.paths.runs, ctx.runId, `verdict-${cycle}.json`);
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  ctx.store.append('verdict-rendered', {
    actor: ACTOR,
    cycle,
    pass,
    sha,
    source: 'ci',
    verdict: 'red',
    open: openIds,
    record: recordPath,
  });
  return { next: 'verdict' };
}

// -- green but no merge ------------------------------------------------------

async function greenNoMerge(ctx, base, opened, sha) {
  const events = runEvents(ctx);
  // The required set is green and auto-merge is disarmed: a harness-class
  // red. Loud once per sha; one re-arm attempt, then the human.
  if (!events.some((e) => e.event === 'gate-integrity' && e.kind === 'auto-merge' && e.sha === sha)) {
    ctx.store.append('gate-integrity', {
      actor: ACTOR,
      kind: 'auto-merge',
      pr: opened.pr,
      sha,
      detail: 'required checks green, auto-merge did not fire',
      gist: `green but no merge on PR #${opened.pr}`,
    });
  }
  const rearm = [...events]
    .reverse()
    .find((e) => e.event === 'operational-fix' && e.kind === 'auto-merge-rearm' && e.sha === sha);
  const granted = answeredPark(events, 'provisioning-gate');
  if (!rearm || (granted?.answer && granted.answer.seq > rearm.seq)) {
    ctx.store.append('operational-fix', { actor: ACTOR, kind: 'auto-merge-rearm', pr: opened.pr, sha });
    const arm = await base.forge.armAutoMerge(opened.pr);
    if (arm.armed) return null;
  }
  return parkDirective('provisioning-gate', {
    question:
      `PR #${opened.pr} is green but auto-merge did not fire and would not re-arm. ` +
      'Repair the merge substrate, then answer.',
  });
}

// -- merged ------------------------------------------------------------------

async function stampMerged(ctx, base, opened, st) {
  const runs = await base.forge.checkRuns(st.headSha);
  // The merge can land between polls; the final check states of the head
  // sha still stamp — all terminal states are covered, flakes included.
  stampTransitions(ctx, opened, st.headSha, runs);
  const required = new Set(opened.required ?? []);
  const redChecks = runs
    .filter((r) => required.has(r.name) && RED.has(normalize(r)))
    .map((r) => r.name);
  // The merge landed; any open green-but-no-merge alert is resolved.
  const events = runEvents(ctx);
  const resolved = new Set(events.filter((e) => e.event === 'resolved').map((e) => e.resolves));
  for (const e of events) {
    if (e.event === 'gate-integrity' && e.kind === 'auto-merge' && !resolved.has(e.seq)) {
      ctx.store.resolve({ actor: ACTOR, resolves: e.seq });
    }
  }
  ctx.store.append('merged', {
    actor: ACTOR,
    pr: opened.pr,
    sha: st.headSha,
    mergeSha: st.mergeSha,
    red: redChecks.length > 0,
    ...(redChecks.length > 0 && { redChecks }),
  });
}

// -- competing-merge branch update -------------------------------------------

async function branchUpdate(ctx, base) {
  const events = runEvents(ctx);
  // One merge round only: a failed round takes the stall route until a fresh
  // pass (born on updated main) dissolves the conflict.
  const failedRound = [...events]
    .reverse()
    .find((e) => e.event === 'merge-round' && e.resolved === false);
  if (failedRound && !events.some((e) => e.event === 'fresh-pass' && e.seq > failedRound.seq)) {
    return mergeStall(ctx, base, failedRound);
  }
  const clone = cloneDir(ctx.paths, ctx.project);
  await fetchClone(clone);
  const mainSha = await branchSha(clone, base.defaultBranch);
  const fromSha = await headSha(base.worktree);
  const merged = await mergeIntoTree(
    base.worktree,
    mainSha,
    `merge ${base.defaultBranch} into ${base.branch}`,
  );
  if (merged.ok) {
    const directive = await pushBranch(ctx, base);
    if (directive) return directive;
    // The linkage stamp: later check transitions on toSha are the update's
    // re-run.
    ctx.store.append('branch-update', { actor: ACTOR, fromSha, toSha: merged.sha, mainSha });
    return null;
  }
  return mergeRound(ctx, base, { fromSha, mainSha, conflicts: merged.conflicts });
}

// -- the merge round ---------------------------------------------------------

async function mergeRound(ctx, base, { fromSha, mainSha, conflicts }) {
  const testConflicts = conflicts.filter((f) => underAny(f, base.testPaths));
  const codeConflicts = conflicts.filter((f) => !underAny(f, base.testPaths));
  const brief = await incomingBrief(base, mainSha);
  let cause = null;
  if (codeConflicts.length > 0) {
    const n = invocationCount(runEvents(ctx), 'dev') + 1;
    const result = await ctx.runSeat({
      seat: 'dev',
      roleBlock: conflictRole(base, codeConflicts, brief),
      reportPath: runReportPath(ctx.paths, ctx.runId, `dev-${n}`),
      schema: DEV_SCHEMA,
      cwd: base.worktree,
      env: base.env,
      ...(base.storyLane && { denyTools: testEditDenyRules(base.testPaths) }),
    });
    if (!result.ok) cause = 'dev seat failed';
  }
  if (!cause && testConflicts.length > 0) {
    // Conflict hunks in test files are the suite seat's work — the test-edit
    // boundary holds through the merge round.
    const n = invocationCount(runEvents(ctx), 'suite') + 1;
    const result = await ctx.runSeat({
      seat: 'suite',
      roleBlock: testConflictRole(base, testConflicts, brief),
      reportPath: runReportPath(ctx.paths, ctx.runId, `suite-${n}`),
      schema: SUITE_SCHEMA,
      cwd: base.worktree,
      env: base.env,
    });
    if (!result.ok) cause = 'suite seat failed';
  }
  if (!cause) {
    // The index keeps its unmerged entries until the conclude stages them;
    // resolution is judged on the files — leftover markers fail the round.
    // A missing file is a resolution by deletion.
    for (const file of conflicts) {
      const full = join(base.worktree, file);
      if (!existsSync(full)) continue;
      if (/^(<{7}(\s|$)|={7}$|>{7}(\s|$))/m.test(readFileSync(full, 'utf8'))) {
        cause = `conflict markers remain in ${file}`;
        break;
      }
    }
  }
  if (cause) {
    await abortMerge(base.worktree).catch(() => {});
    const round = ctx.store.append('merge-round', {
      actor: ACTOR,
      resolved: false,
      mainSha,
      conflicts,
      cause,
    });
    return mergeStall(ctx, base, round);
  }
  const sha = await concludeMerge(
    base.worktree,
    `merge ${base.defaultBranch} into ${base.branch}`,
  );
  if (testConflicts.length > 0 && base.storyLane) {
    // The merged tests are the frozen suite now: the round re-freezes.
    ctx.store.append('suite-committed', { actor: ACTOR, sha, phase: 're-freeze', files: testConflicts });
    ctx.store.append('re-freeze', { actor: ACTOR, sha, files: testConflicts, findings: [] });
  }
  const directive = await pushBranch(ctx, base);
  if (directive) return directive;
  ctx.store.append('merge-round', {
    actor: ACTOR,
    resolved: true,
    sha,
    mainSha,
    conflicts,
    ...(testConflicts.length > 0 && { testFiles: testConflicts }),
  });
  ctx.store.append('branch-update', { actor: ACTOR, fromSha, toSha: sha, mainSha });
  return null;
}

// A failed merge round is a stall: the run's one fresh pass is born on
// updated main, where the conflict dissolves. A second stall parks.
async function mergeStall(ctx, base, failedRound) {
  const events = runEvents(ctx);
  let stall = [...events]
    .reverse()
    .find((e) => e.event === 'stall' && e.reason === 'merge-conflict' && e.seq > failedRound.seq);
  if (!stall) {
    stall = ctx.store.append('stall', {
      actor: ACTOR,
      pass: currentPass(events),
      reason: 'merge-conflict',
      open: 0,
    });
  }
  const freshUsed = events.filter(
    (e) => e.event === 'implementation-committed' && e.phase === 'fresh',
  ).length;
  const freshAllowed = 1 + answerCount(events, 'second-stall', 'fresh-pass');
  if (freshUsed < freshAllowed) {
    return mergeFreshPass(ctx, base, { mainSha: failedRound.mainSha, stallSeq: stall.seq });
  }
  const park = answeredPark(events, 'second-stall');
  if (!park?.answer || park.answer.seq < stall.seq) {
    return parkDirective('second-stall', {
      question:
        `The merge round could not resolve the conflicts with ${base.defaultBranch} ` +
        `(${failedRound.cause}). Conflicted files:\n` +
        failedRound.conflicts.map((f) => `- ${f}`).join('\n') +
        '\nPick an option.',
      options: ['fresh-pass', 'fail'],
    });
  }
  if (park.answer.option === 'fail') {
    return { close: { state: 'failed', reason: 'second-stall' } };
  }
  return mergeFreshPass(ctx, base, { mainSha: failedRound.mainSha, stallSeq: stall.seq });
}

async function mergeFreshPass(ctx, base, { mainSha, stallSeq }) {
  const outcome = await freshPass(ctx, freshBase(base, mainSha), base.mode, {
    newPass: currentPass(runEvents(ctx)) + 1,
    trigger: 'merge-conflict',
    open: [],
    last: { seq: stallSeq },
  });
  if (outcome.fail) return outcome.fail;
  return { next: 'verdict' };
}

// A restart between the fresh-pass stamp and its dev seat lands here: the
// reset already happened; run the seat and hand the tree to the verdict.
async function resumeMergeFreshPass(ctx, base, pendingFresh) {
  const outcome = await freshPass(ctx, freshBase(base, null), base.mode, {
    newPass: pendingFresh.pass,
    trigger: 'merge-conflict',
    open: [],
    last: { seq: pendingFresh.seq - 1 },
  });
  if (outcome.fail) return outcome.fail;
  return { next: 'verdict' };
}

function freshBase(base, resetSha) {
  return {
    worktree: base.worktree,
    testPaths: base.testPaths,
    specRef: base.specRef,
    env: base.env,
    resetSha,
  };
}

// -- close-out ---------------------------------------------------------------

function closeOutHandler({ forgeFor, pollMs, spawnRepair }) {
  return async function closeOut(ctx) {
    const base = await shipBase(ctx, forgeFor);
    const merged = findLast(runEvents(ctx), 'merged');
    if (!merged) return { close: { state: 'failed', reason: 'no-merge-record' } };
    if (merged.red && !runEvents(ctx).some((e) => e.event === 'red-merge-breach')) {
      await breachFlow(ctx, base, merged, spawnRepair);
    }
    const directive = await watchMergeCommit(ctx, base, merged, pollMs);
    if (directive === 'stopped') return null;
    if (directive) return directive;
    if (base.storyLane && !runEvents(ctx).some((e) => e.event === 'card-sweep')) {
      await cardSweep(ctx, base, merged);
    }
    if (Number.isInteger(ctx.payload.escapeSeq)) fixEscapeBack(ctx, merged);
    return { close: { state: 'shipped', pr: merged.pr, mergeSha: merged.mergeSha } };
  };
}

// -- red-merge breach --------------------------------------------------------

async function breachFlow(ctx, base, merged, spawnRepair) {
  const events = runEvents(ctx);
  const lastRender = findLast(events, 'verdict-rendered');
  const index = findingIndex(events);
  const open =
    lastRender?.verdict === 'red'
      ? lastRender.open.map((id) => index.get(id)).filter(Boolean)
      : [];
  const store = openEscapesStore(ctx.paths, { onAppend: ctx.onAppend });
  try {
    // Restart-safe: a crash after recording re-uses the recorded entries.
    let entries = readEvents(ctx.paths.escapesLedger)
      .filter((e) => e.event === 'escape-recorded' && e.refs?.runId === ctx.runId)
      .map((e) => e.seq);
    if (entries.length === 0) {
      const attribution = base.storyKey ?? ctx.runId;
      const lines =
        open.length > 0
          ? open.map((f) => ({
              category: escapeCategory(f),
              defectLine: `${f.summary} (evidence: ${f.evidence})`,
              findingId: f.id,
            }))
          : [
              {
                category: 'product-escape',
                defectLine: `red merge on PR #${merged.pr}: ${(merged.redChecks ?? []).join(', ')} red at merge`,
                findingId: null,
              },
            ];
      entries = lines.map(
        (line) =>
          recordEscape(store, {
            actor: ACTOR,
            category: line.category,
            defectLine: line.defectLine,
            detectionSource: 'harness-self',
            attribution,
            refs: {
              runId: ctx.runId,
              pr: merged.pr,
              ...(line.findingId && { findingId: line.findingId }),
            },
          }).seq,
      );
    }
    const spawned = [];
    if (spawnRepair) {
      const set = readEscapeSet(ctx.paths.escapesLedger);
      for (const seq of entries) {
        const escape = set.find((e) => e.seq === seq);
        if (escape?.fixed) continue;
        try {
          const runId = await spawnRepair({
            escapeSeq: seq,
            category: escape.category,
            defectLine: escape.defectLine,
            project: ctx.project,
            runId: ctx.runId,
            pr: merged.pr,
          });
          if (runId) spawned.push(runId);
        } catch {
          // The open escape stays the tracking record; the console sees it.
        }
      }
    }
    ctx.store.append('red-merge-breach', {
      actor: ACTOR,
      pr: merged.pr,
      sha: merged.sha,
      mergeSha: merged.mergeSha,
      escapes: entries,
      spawned,
      gist: `red merge on PR #${merged.pr}: ${entries.length} escape(s) recorded`,
    });
  } finally {
    store.close();
  }
}

function escapeCategory(finding) {
  if (finding.source !== 'triage') return 'product-escape'; // confirmed review finding
  return (
    {
      'code-defect': 'product-escape',
      'suite-defect': 'suite-defect',
      env: 'infra',
      harness: 'harness',
    }[finding.class] ?? 'product-escape'
  );
}

// -- merge-commit checks -----------------------------------------------------

async function watchMergeCommit(ctx, base, merged, pollMs) {
  for (;;) {
    if (ctx.stopped()) return 'stopped';
    const runs = await base.forge.checkRuns(merged.mergeSha);
    if (runs.length === 0) return null;
    const events = runEvents(ctx);
    const last = new Map();
    for (const e of events) {
      if (e.event === 'merge-commit-check') last.set(e.check, e.status);
    }
    for (const run of runs) {
      const status = normalize(run);
      if (!TERMINAL.has(status) || last.get(run.name) === status) continue;
      const fields = { actor: ACTOR, check: run.name, status };
      if (run.startedAt && run.completedAt) {
        fields.duration = Date.parse(run.completedAt) - Date.parse(run.startedAt);
      }
      ctx.store.append('merge-commit-check', fields);
    }
    const reds = runs.filter((r) => RED.has(normalize(r)));
    if (reds.length === 0) {
      if (runs.every((r) => TERMINAL.has(normalize(r)))) return null;
      await sleep(pollMs);
      continue;
    }
    // A red merge-commit check is an env-class operational fix: one re-run,
    // then the human confirms the substrate.
    const fresh = runEvents(ctx);
    const marks = (name) => {
      let lastRerun = 0;
      let lastRed = 0;
      for (const e of fresh) {
        if (e.event !== 'merge-commit-check' || e.check !== name) continue;
        if (e.status === 'rerun-requested') lastRerun = e.seq;
        else if (RED.has(e.status)) lastRed = e.seq;
      }
      return { lastRerun, lastRed };
    };
    const lastOpFix =
      [...fresh]
        .reverse()
        .find((e) => e.event === 'operational-fix' && e.kind === 'merge-commit-rerun')?.seq ?? 0;
    const granted = answeredPark(fresh, 'provisioning-gate');
    const needRerun = reds.filter((r) => {
      const { lastRerun } = marks(r.name);
      return lastRerun === 0 || (granted?.answer && granted.answer.seq > lastRerun);
    });
    if (needRerun.length > 0) {
      ctx.store.append('operational-fix', {
        actor: ACTOR,
        kind: 'merge-commit-rerun',
        checks: needRerun.map((r) => r.name),
        ...(granted?.answer && granted.answer.seq > lastOpFix && { source: 'answer' }),
      });
      await base.forge.rerunFailed(merged.mergeSha);
      for (const r of needRerun) {
        ctx.store.append('merge-commit-check', { actor: ACTOR, check: r.name, status: 'rerun-requested' });
      }
      await sleep(pollMs);
      continue;
    }
    const persistent = reds.every((r) => {
      const { lastRerun, lastRed } = marks(r.name);
      return lastRed > lastRerun;
    });
    if (!persistent) {
      await sleep(pollMs);
      continue;
    }
    return parkDirective('provisioning-gate', {
      question:
        'Merge-commit checks stay red after a re-run; repair the substrate, then answer:\n' +
        reds.map((r) => `- ${r.name}`).join('\n'),
    });
  }
}

// -- the card sweep ----------------------------------------------------------

async function cardSweep(ctx, base, merged) {
  const clone = cloneDir(ctx.paths, ctx.project);
  await fetchClone(clone);
  await resetHard(base.worktree, merged.mergeSha);
  const cardDir = dirname(base.cardPath);
  let brief = null;
  let report = null;
  for (let attempt = 1; ; attempt++) {
    const n = invocationCount(runEvents(ctx), 'card-sweep') + 1;
    const result = await ctx.runSeat({
      seat: 'card-sweep',
      roleBlock: sweepRole(base, cardDir, brief),
      reportPath: runReportPath(ctx.paths, ctx.runId, `card-sweep-${n}`),
      schema: CARD_SWEEP_SCHEMA,
      cwd: base.worktree,
      env: base.env,
    });
    if (!result.ok) {
      // The story shipped; a sweep failure never un-ships it. Loud enough
      // through the seat-failure stamp; the sweep records the miss.
      ctx.store.append('card-sweep', { actor: ACTOR, ok: false, cause: 'seat-failure' });
      return;
    }
    const defects = await sweepChecks(base, cardDir, result.report);
    if (defects.length === 0) {
      report = result.report;
      break;
    }
    if (attempt === 2) {
      ctx.store.append('seat-failure', {
        actor: ACTOR,
        seat: 'card-sweep',
        reason: 'work-product-defect',
        defects,
      });
      ctx.store.append('card-sweep', { actor: ACTOR, ok: false, cause: 'work-product-defect' });
      return;
    }
    brief = defects;
  }
  let pushed = false;
  let sha = null;
  let pushError = null;
  if ((await changedFiles(base.worktree)).length > 0) {
    sha = await commitAll(base.worktree, `cards: sweep ${base.storyKey ?? ctx.runId}`);
    try {
      // Cards are planning artifacts; the sweep lands them directly on the
      // default branch. A rejected push is recorded, never retried blindly.
      await push(base.worktree, 'origin', `HEAD:${base.defaultBranch}`);
      pushed = true;
    } catch (error) {
      pushError = error.message;
    }
  }
  // An invalidated card parks the card, never the run that shipped: the park
  // lands in the instance ledger and blocks that card's launch, not this
  // close.
  const parked = new Set(
    readEvents(ctx.paths.instanceLedger)
      .filter((e) => e.event === 'park' && e.type === 'card-invalidated' && e.runId === ctx.runId)
      .map((e) => e.card),
  );
  for (const inv of report.invalidated) {
    if (parked.has(inv.card)) continue;
    ctx.instanceStore?.append('park', {
      actor: ACTOR,
      type: 'card-invalidated',
      card: inv.card,
      runId: ctx.runId,
      question: `The ship of ${base.storyKey ?? ctx.runId} invalidated ${inv.card}: ${inv.reason}`,
      gist: gist(`card-invalidated: ${inv.card} — ${inv.reason}`),
    });
  }
  ctx.store.append('card-sweep', {
    actor: ACTOR,
    ok: true,
    updated: report.updatedCards.length,
    invalidated: report.invalidated.length,
    pushed,
    ...(sha && { sha }),
    ...(pushError && { error: pushError }),
  });
}

async function sweepChecks(base, cardDir, report) {
  const defects = [];
  for (const file of await changedFiles(base.worktree)) {
    if (!underAny(file, [cardDir])) defects.push(`change outside the card directory: ${file}`);
  }
  for (const card of report.updatedCards) {
    if (!underAny(card, [cardDir])) defects.push(`updated card outside the card directory: ${card}`);
  }
  for (const inv of report.invalidated) {
    if (!underAny(inv.card, [cardDir])) {
      defects.push(`invalidated card outside the card directory: ${inv.card}`);
    }
  }
  return defects;
}

// -- escape fix-back (repair lane) -------------------------------------------

function fixEscapeBack(ctx, merged) {
  const store = openEscapesStore(ctx.paths, { onAppend: ctx.onAppend });
  try {
    const target = readEscapeSet(ctx.paths.escapesLedger).find(
      (e) => e.seq === ctx.payload.escapeSeq,
    );
    if (!target || target.fixed) return;
    fixEscape(store, {
      actor: ACTOR,
      fixes: ctx.payload.escapeSeq,
      category: target.category,
      attribution: String(ctx.payload.attribution ?? target.attribution),
      refs: { runId: ctx.runId, pr: merged.pr, mergeSha: merged.mergeSha },
    });
  } finally {
    store.close();
  }
}

// -- role blocks -------------------------------------------------------------

function conflictRole(base, conflicts, brief) {
  return [
    `A merge of ${base.defaultBranch} into the run branch stopped on textual conflicts.`,
    'Resolve the conflict markers in these files; combine both sides faithfully:',
    ...conflicts.map((f) => `- ${f}`),
    `The spec of this run: ${base.specRef}`,
    'Change conflicted files only. Do not edit test files. Do not commit; the orchestrator concludes the merge.',
    ...briefLines(brief),
  ].join('\n');
}

function testConflictRole(base, conflicts, brief) {
  return [
    `A merge of ${base.defaultBranch} into the run branch left conflicts in test files.`,
    'Resolve the conflict markers; the resolved tests become the frozen suite (a re-freeze).',
    ...conflicts.map((f) => `- ${f}`),
    `The spec of this run: ${base.specRef}`,
    `Write test files only under: ${base.testPaths.join(', ')}. Touch nothing else.`,
    'In the report, list the resolved files as suite files; expected reds stay empty.',
    'Do not commit; the orchestrator concludes the merge.',
    ...briefLines(brief),
  ].join('\n');
}

function sweepRole(base, cardDir, brief) {
  return [
    `The story ${base.storyKey ?? ''} shipped; sweep the intent cards.`,
    `The shipped spec: ${base.specRef}`,
    `The cards live under: ${cardDir}. Edit card files in place; touch nothing outside that directory.`,
    'Update Blocked-by edges, sources, and open decisions so every card matches the repository as shipped.',
    "When the shipped work invalidates a card's goal or scope boundary, do not rewrite the card: list it under invalidated with the reason.",
    'List every card you edited under updatedCards.',
    ...briefLines(brief),
  ].join('\n');
}

async function incomingBrief(base, mainSha) {
  let log = '';
  try {
    log = await git(['log', '--oneline', `HEAD..${mainSha}`], { cwd: base.worktree });
  } catch {
    // The brief survives without the log.
  }
  return log.trim().length > 0
    ? `Incoming ${base.defaultBranch} commits:\n${log.trim().slice(0, LOG_TAIL)}`
    : null;
}

// -- shared derivations ------------------------------------------------------

async function shipBase(ctx, forgeFor) {
  // The forge resolves first: the project's repository is the cheapest fact
  // to settle, and a project the instance cannot forge for never reaches the
  // clone read.
  const forge = forgeFor(ctx);
  const config = await loadProjectConfig(ctx);
  const worktree = ctx.payload.worktree;
  const cardPath = typeof ctx.payload.card === 'string' ? ctx.payload.card : null;
  let storyKey = null;
  let cardTitle = null;
  if (cardPath) {
    try {
      const { card } = parseIntentCard(readFileSync(join(worktree, cardPath), 'utf8'));
      storyKey = card.key ?? null;
      cardTitle = card.title ?? null;
    } catch {
      // The card text is a nicety here; the run id carries the identity.
    }
  }
  const ticket = ctx.payload.ticket;
  const specRef = cardPath
    ? join(ctx.paths.runs, ctx.runId, 'spec.md')
    : typeof ticket === 'string'
      ? isAbsolute(ticket)
        ? ticket
        : join(worktree, ticket)
      : null;
  return {
    forge,
    config,
    worktree,
    branch: ctx.payload.branch,
    defaultBranch: ctx.payload.defaultBranch ?? 'main',
    testPaths: config.repo.testPaths ?? [],
    env: runEnv(ctx, config),
    cardPath,
    storyKey,
    cardTitle,
    specRef,
    storyLane: cardPath !== null,
    mode: cardPath !== null ? 'story' : 'repair',
  };
}

function normalize(run) {
  return run.status === 'completed' ? (run.conclusion ?? 'neutral') : run.status;
}

function findLast(events, name) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === name) return events[i];
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
