// The ship step: the run ends at close-out, not at the green verdict.
// `shipStep({forgeFor})` supplies the three stages after the verdict —
// `update` (the ship token, then the branch update that precedes the final
// verdict), `ship` (PR open with auto-merge armed, the check watcher, the CI
// red route, the competing-merge update, the merge round) and `close-out`
// (red-merge breach conversion, merge-commit checks to terminal, the card
// sweep, the reconciliation judgment, the configured learning artifact, the
// escape fix-back, ledger close).
//
// Ships are serial per project and everything before them is not. The update
// stage holds the seam: a run takes the project's ship token there, merges the
// default branch into its tree under it, and hands a moved tree back to the
// verdict — so the verdict certifies the tree that lands, and no other run of
// the project can merge between the two (ADR-0033).
//
// These three stages run no seat, so they are the run's silent stretches: a
// poll outcome that changes nothing stamps nothing. Each poll loop therefore
// carries a heartbeat, one stamp per batch of poll outcomes, saying what it
// waits on (ADR-0034).
//
// The check watcher is a ledger-stamping process: every observed state
// change stamps `check-transition`; pending is a state, never a verdict; no
// wall-clock timeout detects anything. Two forge states are not check states
// at all and are classified before the watcher sees them — a request in
// conflict with its base, and a head sha the forge carries no check run for.
// Both stamp `forge-anomaly` and take a route. A red check whose workflow run
// is still executing is a third: the check is terminal and the run behind it
// is not, so the watcher holds the red until the run ends and stamps
// `triage-wait` once for the wait. Persistent CI reds render a red
// verdict (`source: 'ci'`) and re-enter the verdict stage — the same
// four-class triage, the same routes, the same shared budgets as in-run
// reds. An env-only verdict comes back here for the re-run without a local
// cycle; every other route judges the tree again first. Every handler
// re-derives its position from the run ledger, the git state, and the forge,
// so a daemon restart resumes mid-ship without memory.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { repairTicketPath, reconcileTicketPath, runReportPath } from '../daemon/home.mjs';
import { readEvents } from '../ledger/ledger.mjs';
import { instanceParkForms } from '../ledger/parks.mjs';
import { openEscapesStore } from '../telemetry/stores.mjs';
import { stageHeartbeat } from '../telemetry/heartbeat.mjs';
import { recordEscape, ticketEscape, fixEscape, readEscapeSet } from '../telemetry/escapes.mjs';
import { settleBreachOf } from '../telemetry/breaches.mjs';
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
import { takeShipToken } from '../ship/token.mjs';
import { parseIntentCard } from './card.mjs';
import { probeCredentials } from './probes.mjs';
import { SUITE_SCHEMA } from './story.mjs';
import {
  DEV_SCHEMA,
  triageStep,
  findingIndex,
  currentPass,
  freshPass,
  answerCount,
  sweepSkippedAfter,
} from './verdict.mjs';
import {
  ACTOR,
  loadProjectConfig,
  readConstitution,
  runEnv,
  runEvents,
  answeredPark,
  answeredPath,
  freezeExclusions,
  invocationCount,
  parkDirective,
  GATE_FORMS,
  withAbandonGuard,
  blocked,
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

/**
 * The watcher's bound on a head sha the forge carries no check run of any
 * name for. It is a count of poll outcomes that saw nothing, never a span of
 * wall-clock time: the recovery route fires on observations, and `pollMs`
 * stays what it always was — cadence, not detection.
 */
export const CHECKLESS_POLLS = 20;

/**
 * The bound on the branch updates one implementation pass takes before its
 * final verdict. Under the token the base moves only when a human merges, so
 * the second update in one pass is already the sign that this tree is chasing
 * a branch it will not catch; past the bound the run ships and the ship stage
 * takes the update, exactly as it did before the pre-verdict one existed.
 */
export const UPDATE_CAP = 2;

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
 *   enqueueRepair?: (info: object) => unknown}} opts
 *   `forgeFor` resolves the forge of one run from the run's project; the
 *   resolved object implements the interface in ship/forge.mjs. The lane
 *   graph registers once per daemon while the instance holds many projects,
 *   each with its own repository, so the forge is per run and never bound
 *   here. `enqueueRepair` hands a breach's ticketed escapes to the frontier;
 *   it never launches, because the breaching run still holds its slot
 *   through close-out. The owed work is durable without it — the ticketed
 *   escape is the queue — so a failing hand-off costs a sweep, not a repair.
 */
export function shipStep({ forgeFor, pollMs = 15000, enqueueRepair = null } = {}) {
  if (typeof forgeFor !== 'function') throw new Error('shipStep requires a forgeFor resolver');
  return {
    stages: ['update', 'ship', 'close-out'],
    handlers: withAbandonGuard({
      update: updateHandler({ forgeFor, pollMs }),
      ship: shipHandler({ forgeFor, pollMs }),
      'close-out': closeOutHandler({ forgeFor, pollMs, enqueueRepair }),
    }),
  };
}

// -- the update stage --------------------------------------------------------

/**
 * The seam between a green verdict and the request. The run takes the
 * project's ship token here, and its first act under the token is the branch
 * update against the default branch as it stands after the previous holder's
 * merge. An update that moved the tree hands the run back to the verdict — the
 * tree that ships is the tree a verdict certified — and a base that did not
 * move costs one fetch and a stamp. Conflicts take the route they have always
 * taken, one stage earlier, where the repair is cheapest: no request is open,
 * no CI round is spent, and the verdict that follows covers the merged result.
 */
function updateHandler({ forgeFor, pollMs }) {
  return async function update(ctx) {
    const base = await shipBase(ctx, forgeFor);
    const heart = stageHeartbeat(ctx);
    for (;;) {
      if (ctx.stopped()) return null;
      // The wait is on a state change in another run's ledger — the merge that
      // ends the holder's turn — and never on a span of time. `pollMs` is the
      // cadence of the reading, as it is for the check watcher.
      if (!takeShipToken(ctx)) {
        heart.beat('ship-token');
        await sleep(pollMs);
        continue;
      }
      return preVerdictUpdate(ctx, base);
    }
  };
}

// Why a capped pass leaves the update to the ship stage. The stamp carries it,
// because an update the run decided not to take must read as a decision.
const UPDATE_CAP_NOTE =
  'the base moved twice under one pass: the ship stage takes the update from ' +
  'here, as it did before this one existed';

async function preVerdictUpdate(ctx, base) {
  const events = runEvents(ctx);
  const pass = currentPass(events);
  const taken = events.filter(
    (e) => e.event === 'pre-verdict-update' && e.pass === pass && e.ran,
  ).length;
  if (taken >= UPDATE_CAP) {
    if (!events.some((e) => e.event === 'pre-verdict-update' && e.pass === pass && e.capped)) {
      ctx.store.append('pre-verdict-update', {
        actor: ACTOR,
        pass,
        ran: false,
        capped: true,
        updates: taken,
        cap: UPDATE_CAP,
        note: UPDATE_CAP_NOTE,
      });
    }
    return { next: 'ship' };
  }
  // No push: there is no request to update yet, and a run branch pushed here
  // would meet a later fresh pass's rewrite with a plain push.
  const out = await branchUpdate(ctx, base, { push: false, stamp: false });
  if (out.directive) return out.directive;
  const ran = out.toSha !== out.fromSha;
  ctx.store.append('pre-verdict-update', {
    actor: ACTOR,
    pass,
    ran,
    mainSha: out.mainSha,
    ...(ran && { fromSha: out.fromSha, toSha: out.toSha }),
  });
  return ran ? { next: 'verdict' } : { next: 'ship' };
}

// -- the ship stage ----------------------------------------------------------

function shipHandler({ forgeFor, pollMs }) {
  return async function ship(ctx) {
    const base = await shipBase(ctx, forgeFor);
    // Poll outcomes of this stage entry that saw no check run at all, per
    // head sha. The count lives here and the route's decisions live in the
    // ledger: a restart re-enters the stage and counts again, while the
    // stamps below still say which recovery step the run already spent.
    const checkless = new Map();
    // The stage runs no seat, so nothing else stamps while it waits on the
    // forge or on the token. Every poll outcome that changed nothing beats.
    const heart = stageHeartbeat(ctx);
    for (;;) {
      if (ctx.stopped()) return null;
      const events = runEvents(ctx);
      // A crash between a rendered red verdict and the stage transition
      // resumes here; red verdicts belong to the verdict stage. The one red
      // render that stays here is the env-only CI verdict the ladder handed
      // back with its sweep skipped: the re-run this stage asks for is the
      // test of the fix, and bouncing it would be the loop (ADR-0022).
      const lastRender = findLast(events, 'verdict-rendered');
      if (
        lastRender &&
        lastRender.verdict === 'red' &&
        !sweepSkippedAfter(events, lastRender.seq)
      ) {
        return { next: 'verdict' };
      }
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
        // The token gate again, for the run that reached ship without the
        // update stage: only its holder opens a request. A run that took the
        // token there takes nothing here and stamps nothing.
        if (!takeShipToken(ctx)) {
          heart.beat('ship-token');
          await sleep(pollMs);
          continue;
        }
        const directive = await openPr(ctx, base);
        if (directive) return directive;
        continue;
      }
      const st = await base.forge.prState(opened.pr);
      if (st.state === 'closed') {
        return blocked(
          ctx,
          'pr-closed',
          `PR #${opened.pr} was closed without a merge. Re-open it and answer "retry", ` +
            'or "abandon" to close the run.',
          { pr: opened.pr },
        );
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
      if (st.conflicting) {
        // A competing story merged under this request. The forge builds no
        // merge ref for a request in conflict, so no pull-request workflow
        // runs and no check can ever arrive: the state takes the update path
        // a request behind its base takes, and it is stamped before it does.
        forgeAnomaly(ctx, events, {
          kind: 'merge-conflicting',
          pr: opened.pr,
          sha: st.headSha,
          detail: `PR #${opened.pr} is in conflict with ${base.defaultBranch}`,
        });
      }
      if (st.behindBase || st.conflicting) {
        const out = await branchUpdate(ctx, base);
        if (out.directive) return out.directive;
        continue;
      }
      const directive = await watchChecks(ctx, base, opened, st, checkless);
      if (directive) return directive;
      heart.beat('checks', { pr: opened.pr, sha: st.headSha });
      await sleep(pollMs);
    }
  };
}

// -- PR open + preflight -----------------------------------------------------

async function openPr(ctx, base) {
  // The credential gate comes first: a CI round is the most expensive way to
  // learn that a key went stale since the launch proved it (ADR-0027).
  const probed = await probeCredentials(ctx, base.config, {
    phase: 'ship',
    cwd: base.worktree,
    env: base.env,
  });
  if (probed) return probed;
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
      ...GATE_FORMS,
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
      ...GATE_FORMS,
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
      ...GATE_FORMS,
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

async function watchChecks(ctx, base, opened, st, checkless) {
  const sha = st.headSha;
  const runs = await base.forge.checkRuns(sha);
  stampTransitions(ctx, opened, sha, runs);
  if (runs.length === 0) {
    // No check of any name on the head of an open request the forge does not
    // call conflicting: the required set is not late, it was never delivered.
    // Counted, then routed — the watcher does not wait on it.
    const polls = (checkless.get(sha) ?? 0) + 1;
    checkless.set(sha, polls);
    if (polls < CHECKLESS_POLLS) return null;
    checkless.set(sha, 0);
    return checklessSha(ctx, base, opened, sha, polls);
  }
  checkless.delete(sha);
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

/**
 * One forge state the ship loop cannot read as a check state, stamped once
 * per head sha. Quiet: every kind here has a route of its own and the route
 * stamps what it did. Never silent: a loop that waits on the forge says what
 * it is waiting on, and both kinds are states a check watcher would otherwise
 * read as pending forever.
 */
function forgeAnomaly(ctx, events, fields) {
  const stamped = events.some(
    (e) => e.event === 'forge-anomaly' && e.kind === fields.kind && e.sha === fields.sha,
  );
  return stamped ? null : ctx.store.append('forge-anomaly', { actor: ACTOR, ...fields });
}

/**
 * A head sha the forge carries no check run for. The recovery is bounded and
 * finite: one re-delivery, then the human. The re-delivery is the update
 * path — the one push this stage owns that leaves the run's work as it
 * stands. A default branch that moved gives the forge a new head to build
 * for; one that did not leaves the branch where it was, and the stamped
 * `branch-update` says which of the two happened. An answered gate grants the
 * next attempt, the way the re-run and the re-arm are granted.
 */
async function checklessSha(ctx, base, opened, sha, polls) {
  const events = runEvents(ctx);
  forgeAnomaly(ctx, events, {
    kind: 'checkless-sha',
    pr: opened.pr,
    sha,
    polls,
    detail: `no check run of any name on ${sha} after ${polls} polls`,
  });
  const lastTry = [...events]
    .reverse()
    .find((e) => e.event === 'operational-fix' && e.kind === 'check-redelivery' && e.sha === sha);
  const granted = answeredPark(events, 'provisioning-gate');
  if (!lastTry || (granted?.answer && granted.answer.seq > lastTry.seq)) {
    ctx.store.append('operational-fix', {
      actor: ACTOR,
      kind: 'check-redelivery',
      pr: opened.pr,
      sha,
    });
    return (await branchUpdate(ctx, base)).directive ?? null;
  }
  return parkDirective('provisioning-gate', {
    ...GATE_FORMS,
    question:
      `The forge holds no check run of any name on ${sha} (PR #${opened.pr}), and a ` +
      're-delivery brought none. The required checks ' +
      `(${(opened.required ?? []).join(', ')}) cannot arrive on their own. ` +
      'Repair the delivery, then answer.',
  });
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

/**
 * The workflow runs behind the red checks that are still executing. A check is
 * one job of a workflow run: a job that fails early turns its check red and
 * leaves the rest of the run going, so a terminal check is no statement at all
 * about the run it belongs to. A check with no workflow run behind it — any
 * other app's check — has nothing to wait for.
 */
async function executingRuns(base, redChecks) {
  const ids = [...new Set(redChecks.map((r) => r.run).filter((id) => id != null).map(String))];
  const executing = [];
  for (const id of ids) {
    const state = await base.forge.workflowRun(id);
    if (state && state.status !== 'completed') executing.push({ run: id, status: state.status });
  }
  return executing;
}

/**
 * The one stamp of a held-back dispatch, per head sha and per workflow run.
 * The stamp's own timestamp is when the wait began, and the CI verdict that
 * ends it carries the span — so the wait costs the ledger one line however
 * many poll outcomes it spans.
 */
function stampWait(ctx, opened, sha, executing, redChecks) {
  const events = runEvents(ctx);
  for (const { run, status } of executing) {
    if (events.some((e) => e.event === 'triage-wait' && e.sha === sha && e.run === run)) continue;
    ctx.store.append('triage-wait', {
      actor: ACTOR,
      pr: opened.pr,
      sha,
      run,
      status,
      checks: redChecks.map((r) => r.name),
    });
  }
  return null; // the next poll asks again; an executing run is a state, never a verdict
}

/** How long the dispatch of this sha was held back, from the wait's own stamp. */
function waitedFor(events, sha) {
  const wait = [...events].reverse().find((e) => e.event === 'triage-wait' && e.sha === sha);
  return wait ? Date.now() - Date.parse(wait.ts) : null;
}

async function handleRed(ctx, base, opened, sha, redNow) {
  // Nothing the watcher does to a red belongs to a workflow run still in
  // flight. The failed-jobs re-run cannot be asked for while the run holds
  // them, and triage judged on a run that is still writing its log judges half
  // the evidence — so a red on an executing run is not yet a red the watcher
  // acts on, and the poll after the run ends is where it acts.
  const executing = await executingRuns(base, redNow);
  if (executing.length > 0) return stampWait(ctx, opened, sha, executing, redNow);
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
  return ciTriage(ctx, base, sha, redNow, waitedFor(events, sha));
}

/**
 * Persistent CI reds enter the shared four-class triage and render a red
 * verdict (`source: 'ci'`); the verdict stage routes it — same ladders, same
 * budgets as in-run reds. Every red here is a red of a workflow run that has
 * finished, so the logs the triage reads are whole. `waited` is the span the
 * watcher held the dispatch back for, and it is on the verdict because that is
 * the moment the span is known.
 */
async function ciTriage(ctx, base, sha, redChecks, waited = null) {
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
    ...(waited != null && { waited }),
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
    ...GATE_FORMS,
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
  // The merge is what a green-but-no-merge alert was waiting for, so the
  // engine's owning-event sweep clears it behind this stamp (ADR-0015).
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

/**
 * Merges the default branch into the run tree. Both stages take it: the ship
 * stage on a request behind its base or in conflict with it, and the update
 * stage before the final verdict. `push` and `stamp` are the whole difference
 * — before the request exists there is nothing on the forge to update, and the
 * update stage's own stamp carries the shas.
 * @returns {Promise<{directive: object} |
 *   {directive?: undefined, fromSha: string, toSha: string, mainSha: string}>}
 */
async function branchUpdate(ctx, base, { push: doPush = true, stamp = true } = {}) {
  const events = runEvents(ctx);
  // One merge round only: a failed round takes the stall route until a fresh
  // pass (born on updated main) dissolves the conflict.
  const failedRound = [...events]
    .reverse()
    .find((e) => e.event === 'merge-round' && e.resolved === false);
  if (failedRound && !events.some((e) => e.event === 'fresh-pass' && e.seq > failedRound.seq)) {
    return { directive: await mergeStall(ctx, base, failedRound) };
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
    if (doPush) {
      const directive = await pushBranch(ctx, base);
      if (directive) return { directive };
    }
    // The linkage stamp: later check transitions on toSha are the update's
    // re-run.
    if (stamp) {
      ctx.store.append('branch-update', { actor: ACTOR, fromSha, toSha: merged.sha, mainSha });
    }
    return { fromSha, toSha: merged.sha, mainSha };
  }
  return mergeRound(
    ctx,
    base,
    { fromSha, mainSha, conflicts: merged.conflicts },
    { push: doPush, stamp },
  );
}

// -- the merge round ---------------------------------------------------------

async function mergeRound(
  ctx,
  base,
  { fromSha, mainSha, conflicts },
  { push: doPush = true, stamp = true } = {},
) {
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
      constitution: base.constitution,
      ...(base.storyLane && {
        denyTools: testEditDenyRules(base.testPaths, {
          except: base.frozenExclusions,
          worktree: base.worktree,
        }),
      }),
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
      constitution: base.constitution,
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
    return { directive: await mergeStall(ctx, base, round) };
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
  if (doPush) {
    const directive = await pushBranch(ctx, base);
    if (directive) return { directive };
  }
  ctx.store.append('merge-round', {
    actor: ACTOR,
    resolved: true,
    sha,
    mainSha,
    conflicts,
    ...(testConflicts.length > 0 && { testFiles: testConflicts }),
  });
  if (stamp) ctx.store.append('branch-update', { actor: ACTOR, fromSha, toSha: sha, mainSha });
  return { fromSha, toSha: sha, mainSha };
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
      options: ['fresh-pass'],
    });
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
    // The freeze's exclusions travel with the test paths: a merge-born fresh
    // pass restores the same suite every other pass restores.
    frozenExclusions: base.frozenExclusions,
    specRef: base.specRef,
    env: base.env,
    // The dev seat's brief names the Tier-1 gate commands and carries the
    // constitution, so the narrowed base holds both facts the verdict base
    // holds. A merge-born pass gets the same brief as any other pass.
    layers: base.config.gates.tier1,
    commands: base.config.commands,
    constitution: base.constitution,
    resetSha,
  };
}

// -- close-out ---------------------------------------------------------------

function closeOutHandler({ forgeFor, pollMs, enqueueRepair }) {
  return async function closeOut(ctx) {
    const base = await shipBase(ctx, forgeFor);
    const merged = findLast(runEvents(ctx), 'merged');
    if (!merged) {
      return blocked(ctx, 'no-merge-record', 'Close-out found no merge record in the ledger.');
    }
    if (merged.red && !runEvents(ctx).some((e) => e.event === 'red-merge-breach')) {
      await breachFlow(ctx, base, merged, enqueueRepair);
    }
    const directive = await watchMergeCommit(ctx, base, merged, pollMs);
    if (directive === 'stopped') return null;
    if (directive) return directive;
    if (base.storyLane && !runEvents(ctx).some((e) => e.event === 'card-sweep')) {
      await cardSweep(ctx, base, merged);
    }
    if (base.storyLane && !runEvents(ctx).some((e) => e.event === 'reconciliation-judged')) {
      await reconcileJudge(ctx, base, merged);
    }
    if (base.storyLane && !runEvents(ctx).some((e) => e.event === 'learning-lesson')) {
      await learningLesson(ctx, base, merged);
    }
    if (Number.isInteger(ctx.payload.escapeSeq)) fixEscapeBack(ctx, merged);
    return { close: { state: 'shipped', pr: merged.pr, mergeSha: merged.mergeSha } };
  };
}

// -- red-merge breach --------------------------------------------------------

async function breachFlow(ctx, base, merged, enqueueRepair) {
  const events = runEvents(ctx);
  const lastRender = findLast(events, 'verdict-rendered');
  const index = findingIndex(events);
  const open =
    lastRender?.verdict === 'red'
      ? lastRender.open.map((id) => index.get(id)).filter(Boolean)
      : [];
  const store = openEscapesStore(ctx.paths, { onAppend: ctx.onAppend });
  const ticketed = [];
  let entries = [];
  try {
    // Restart-safe: a crash after recording re-uses the recorded entries.
    entries = readEvents(ctx.paths.escapesLedger)
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
              // The project the repair launches into. The escapes ledger is
              // instance-scoped; nothing else in it names the repository the
              // defect shipped to.
              project: ctx.project,
              pr: merged.pr,
              ...(line.findingId && { findingId: line.findingId }),
            },
          }).seq,
      );
    }
    // Ticket, then stamp, per escape. The ticket file is written first, so a
    // ticketed escape always has a ticket to repair from; the stamp is the
    // last thing that must succeed for the record to stay actionable.
    const tails = await redCheckTails(base, merged);
    const set = readEscapeSet(ctx.paths.escapesLedger);
    for (const seq of entries) {
      const escape = set.find((e) => e.seq === seq);
      if (!escape || escape.fixed) continue;
      if (!escape.ticket) {
        const ticket = repairTicketPath(ctx.paths, seq);
        writeFileSync(ticket, breachTicket({ ctx, base, merged, escape, tails }));
        ticketEscape(store, {
          actor: ACTOR,
          escape: seq,
          ticket,
          refs: { runId: ctx.runId, project: ctx.project, pr: merged.pr, mergeSha: merged.mergeSha },
        });
      }
      ticketed.push(seq);
    }
    ctx.store.append('red-merge-breach', {
      actor: ACTOR,
      pr: merged.pr,
      sha: merged.sha,
      mergeSha: merged.mergeSha,
      escapes: entries,
      ticketed,
      gist: `red merge on PR #${merged.pr}: ${entries.length} escape(s) recorded`,
    });
  } finally {
    store.close();
  }
  if (!enqueueRepair || ticketed.length === 0) return;
  try {
    // The hand-off, never a launch: at slot cap 1 this run still holds its
    // slot, so an inline launch fails exactly when it matters. It is not
    // awaited either — the sweep it queues provisions runs of its own, and
    // this run's close-out is not the place to wait for that. The frontier
    // derives the owed set from the ledgers, so a hand-off that never lands
    // costs one sweep, and the run's own close queues the next one.
    const handed = enqueueRepair({ project: ctx.project, escapes: ticketed, runId: ctx.runId });
    if (typeof handed?.catch === 'function') handed.catch(() => {});
  } catch {
    // The ticketed escape is the record; the sweep finds it either way.
  }
}

/** The red checks at the merge, each with the tail of its output. */
async function redCheckTails(base, merged) {
  const tails = [];
  for (const name of merged.redChecks ?? []) {
    let output;
    try {
      output = await base.forge.checkOutput(merged.sha, name);
    } catch (error) {
      output = `(the forge would not return the output of ${name}: ${error.message})`;
    }
    tails.push({ name, output: String(output ?? '').slice(-LOG_TAIL) });
  }
  return tails;
}

/**
 * The repair ticket of one breach escape. The repair run reads it from a
 * fresh worktree of the default branch and can see nothing else — not this
 * run's ledger, not its spec, not its tree — so the ticket carries every
 * fact the repair needs: the merged PR, the red checks with their output,
 * the merge commit, and the escape it closes.
 */
function breachTicket({ ctx, base, merged, escape, tails }) {
  const opened = findLast(runEvents(ctx), 'pr-opened');
  return [
    `# Repair ticket: escape ${escape.seq}`,
    '',
    'A merge landed on the default branch with a required check red. This',
    'ticket is the spec of the repair run: fix the defect below and leave a',
    'regression test that fails without the fix.',
    '',
    '## The defect',
    '',
    escape.defectLine,
    '',
    '## Facts',
    '',
    `- escape: seq ${escape.seq} in the escapes ledger`,
    `- category (a routing hint, not a verdict): ${escape.category}`,
    `- attributed to: ${escape.attribution}`,
    `- merged PR: #${merged.pr}${opened?.url ? ` (${opened.url})` : ''}`,
    `- branch: ${base.branch}`,
    `- head sha at the merge: ${merged.sha}`,
    `- merge commit: ${merged.mergeSha}`,
    `- red at the merge: ${(merged.redChecks ?? []).join(', ') || '(none named)'}`,
    `- the run that shipped it: ${ctx.runId}`,
    '',
    '## The red checks at the merge',
    ...(tails.length > 0
      ? tails.flatMap(({ name, output }) => ['', `### ${name}`, '', '```', output.trim(), '```'])
      : ['', '(the forge named no output)']),
    '',
    '## Scope',
    '',
    'Stay inside the defect above. The merge commit is on the default branch',
    'already; repair it forward, never revert it here.',
    '',
  ].join('\n');
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
  // The last poll loop of the run, and the last one nothing else stamps for.
  const heart = stageHeartbeat(ctx);
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
      heart.beat('merge-commit-checks', { sha: merged.mergeSha });
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
      heart.beat('merge-commit-checks', { sha: merged.mergeSha });
      await sleep(pollMs);
      continue;
    }
    const persistent = reds.every((r) => {
      const { lastRerun, lastRed } = marks(r.name);
      return lastRed > lastRerun;
    });
    if (!persistent) {
      heart.beat('merge-commit-checks', { sha: merged.mergeSha });
      await sleep(pollMs);
      continue;
    }
    return parkDirective('provisioning-gate', {
      ...GATE_FORMS,
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
      // The one park with no run behind it, so the one park that offers no
      // abandon: the answer unblocks the card, and there is nothing to close
      // (ADR-0029).
      answers: instanceParkForms({ text: 'what you did about the card' }),
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

// -- the reconciliation judgment (ADR-0026) ----------------------------------

const RECONCILE_JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    owed: { type: 'boolean' },
    records: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['owed', 'records', 'reason'],
};

/**
 * A fresh-context seat judges whether the shipped diff implements or
 * contradicts any decision record. Owed writes the reconciliation ticket
 * first, then stamps — a stamped judgment always has a ticket to launch
 * from. The sweep derives the owed set from the stamp and launches the
 * reconciliation as a repair-lane run; the rewrite never rides the run
 * that shipped the diff. Either verdict stamps with the reason, and a
 * failed judgment stamps ok:false: an unjudged ship is a recorded miss,
 * never a silent skip. The story shipped either way — nothing here blocks
 * the close.
 */
async function reconcileJudge(ctx, base, merged) {
  try {
    await fetchClone(cloneDir(ctx.paths, ctx.project));
    await resetHard(base.worktree, merged.mergeSha);
  } catch (error) {
    ctx.store.append('reconciliation-judged', {
      actor: ACTOR,
      ok: false,
      cause: `worktree: ${error.message}`,
    });
    return;
  }
  const result = await ctx.runSeat({
    seat: 'reconcile-judge',
    roleBlock: judgeRole(base, merged),
    reportPath: runReportPath(ctx.paths, ctx.runId, 'reconcile-judge'),
    schema: RECONCILE_JUDGE_SCHEMA,
    cwd: base.worktree,
    env: base.env,
  });
  if (!result.ok) {
    ctx.store.append('reconciliation-judged', { actor: ACTOR, ok: false, cause: 'seat-failure' });
    return;
  }
  const { owed, records, reason } = result.report;
  if (!owed) {
    ctx.store.append('reconciliation-judged', { actor: ACTOR, ok: true, owed: false, reason });
    return;
  }
  const ticket = reconcileTicketPath(ctx.paths, ctx.runId);
  writeFileSync(ticket, reconcileTicket({ ctx, base, merged, records, reason }));
  ctx.store.append('reconciliation-judged', {
    actor: ACTOR,
    ok: true,
    owed: true,
    records,
    reason,
    ticket,
    gist: gist(`reconciliation owed: ${records.join(', ')}`),
  });
}

function judgeRole(base, merged) {
  return [
    'Judge whether this shipped diff implements or contradicts any decision',
    'record (ADR). You judge only; change nothing.',
    `The shipped diff is the merge commit ${merged.mergeSha} on ${base.defaultBranch}`,
    `(PR #${merged.pr}). Read it with: git show ${merged.mergeSha}`,
    'Locate the decision-record tree (commonly docs/adr/). No such tree means',
    'owed=false with that as the reason.',
    'owed=true when the diff implements a recorded decision, contradicts one,',
    'or deviates from one — implementation counts even when the diff never',
    'touches the record files themselves. List every affected record path in',
    'records, and state the reason in one or two sentences.',
  ].join('\n');
}

/**
 * The reconciliation ticket. The reconciliation run reads it from a fresh
 * worktree of the default branch and can see nothing else — so the ticket
 * carries the shipped diff's identity, the judged records, and the rewrite
 * rules the record tree binds its editors to.
 */
function reconcileTicket({ ctx, base, merged, records, reason }) {
  return [
    `# Reconciliation ticket: run ${ctx.runId}`,
    '',
    `The ship of ${base.storyKey ?? ctx.runId} (PR #${merged.pr}, merge`,
    `commit ${merged.mergeSha}) implicates the decision records below. This`,
    'ticket is the spec of the reconciliation run: rewrite the records so they',
    'stand as fact against the repository as shipped.',
    '',
    '## Records to reconcile',
    '',
    ...records.map((r) => `- ${r}`),
    '',
    `Judged reason: ${reason}`,
    '',
    '## The shipped diff',
    '',
    `- merge commit: ${merged.mergeSha} (read it with git show)`,
    `- merged PR: #${merged.pr}`,
    `- the run that shipped it: ${ctx.runId}`,
    '',
    '## Rules',
    '',
    '- Rewrite the implemented parts of each record as standalone',
    '  present-tense fact. Keep the rationale and the fallback paths.',
    '- Parts the diff did not implement stay as explicit open sections.',
    '- A divergence between the shipped diff and a recorded decision is never',
    '  absorbed silently: name it in the record and in your report, verbatim.',
    '- Edit only the decision-record tree. No source, test, or config change',
    '  rides this run.',
    '',
  ].join('\n');
}

// -- the learning artifact (ADR-0031) ----------------------------------------

const LEARNING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    artifacts: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['artifacts', 'summary'],
};

/**
 * The close-out seat that writes a human-readable learning artifact about the
 * story that just shipped. The project asks for it in its config; a project
 * that does not stamps nothing and runs exactly as it did before. The seat's
 * conduct is the owner's instructions file, read here and carried in the role
 * block — the harness supplies the shipped story's identity and the workspace
 * and holds no opinion about what a lesson is.
 *
 * Every failure is quiet and the close proceeds: one attempt, no retry, no
 * park, no loud item, and no path from here to a failed close. Both outcomes
 * stamp `learning-lesson`, so a feature that stopped working says so.
 */
async function learningLesson(ctx, base, merged) {
  const learning = base.config.closeout?.learning;
  if (!learning) return;
  const fail = (reason) => ctx.store.append('learning-lesson', { actor: ACTOR, ok: false, reason });
  let instructions;
  let step = 'instructions';
  try {
    instructions = readFileSync(learning.instructions, 'utf8');
    step = 'workspace';
    mkdirSync(learning.workspace, { recursive: true });
    step = 'worktree';
    await fetchClone(cloneDir(ctx.paths, ctx.project));
    await resetHard(base.worktree, merged.mergeSha);
  } catch (error) {
    fail(`${step}: ${error.message}`);
    return;
  }
  let result;
  try {
    result = await ctx.runSeat({
      seat: 'learning',
      roleBlock: learningRole({ ctx, base, merged, instructions, workspace: learning.workspace }),
      reportPath: runReportPath(ctx.paths, ctx.runId, 'learning'),
      schema: LEARNING_SCHEMA,
      cwd: base.worktree,
      env: base.env,
    });
  } catch (error) {
    fail(`seat: ${error.message}`);
    return;
  }
  if (!result.ok) {
    fail('seat-failure');
    return;
  }
  ctx.store.append('learning-lesson', {
    actor: ACTOR,
    ok: true,
    artifacts: result.report.artifacts,
    summary: result.report.summary,
  });
}

function learningRole({ ctx, base, merged, instructions, workspace }) {
  return [
    'A story shipped. Write the learning artifact for it, and nothing else.',
    'The instructions below are your conduct: they are the authority on what',
    'the artifact is, where it belongs, and how it reads. Follow them.',
    `Your workspace is the directory ${workspace}. It is stateful — read what`,
    'stands there before you add to it, and keep it as the instructions say.',
    'Write inside that directory and nowhere else: no file outside it, no',
    'change to this repository, and no push.',
    'You judge nothing about the code and decide nothing about the project.',
    'The story that shipped:',
    `- story: ${base.storyKey ?? ctx.runId}`,
    `- its spec: ${base.specRef}`,
    `- merge commit ${merged.mergeSha} on ${base.defaultBranch}; read the`,
    `  shipped diff with: git show ${merged.mergeSha}`,
    `- merged PR: #${merged.pr}`,
    'Report every file you wrote or changed under artifacts, by absolute',
    'path, and say in one or two sentences what the lesson was.',
    '',
    '--- the instructions ---',
    instructions.trim(),
  ].join('\n');
}

// -- escape fix-back (repair lane) -------------------------------------------

function fixEscapeBack(ctx, merged) {
  const target = readEscapeSet(ctx.paths.escapesLedger).find(
    (e) => e.seq === ctx.payload.escapeSeq,
  );
  if (!target) return;
  if (!target.fixed) {
    const store = openEscapesStore(ctx.paths, { onAppend: ctx.onAppend });
    try {
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
  // The entry was read before the fix landed, so the route is this run's own
  // unless an operator had already marked the escape.
  const fixedBy = target.fixedBy ?? 'repair';
  settleBreachOf(ctx.paths, { ...target, fixedBy }, { exceptRunId: ctx.runId });
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
  // The repair lane's ticket may have been corrected in a `stage-blocked`
  // answer; the ship step names the same spec the verdict judged against.
  const ticket = answeredPath(runEvents(ctx), 'ticket-missing') ?? ctx.payload.ticket;
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
    frozenExclusions: cardPath ? freezeExclusions(ctx.paths, ctx.runId) : [],
    env: runEnv(ctx, config),
    constitution: readConstitution(worktree, config),
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
