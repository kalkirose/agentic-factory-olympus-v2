// The ship step: the run ends at close-out, not at the green verdict.
// `shipStep({forgeFor})` supplies the three stages after the verdict —
// `update` (the ship token, then the branch update that precedes the final
// verdict), `ship` (PR open carrying the diff's labels, with auto-merge
// armed, the check watcher, the CI red route, the competing-merge update, the
// merge round) and `close-out`
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
// wall-clock timeout detects anything. It reads one attempt per check name —
// the latest, decided from the attempts' own facts — and it captures the
// evidence of every required check that is not green at the observation, so a
// cancel-and-rerun from outside the harness cannot take a failing attempt's
// log away from the triage that judges it (ADR-0041). Two forge states are not
// check states at all and are classified before the watcher sees them — a
// request in conflict with its base, and a head sha the forge carries no check
// run for. Both stamp `forge-anomaly` and take a route. A red check whose
// workflow run is still executing is a third: the check is terminal and the
// run behind it is not, so the watcher holds the red until the run ends and
// stamps `triage-wait` once for the wait. A check that turns green after a
// re-run three times on one head sha is a fourth: the tree never moved between
// the answers, so the flake reading is withdrawn, the check is reclassified
// deterministic-red (loud) and it earns no further automatic re-run. A
// cancelled check is a fifth, and it is neither red nor green: nobody ran it
// to an answer, so the watcher waits a bounded number of observations for the
// attempt that will, and escalates the cancel when none comes.
// Persistent CI reds render a red
// verdict (`source: 'ci'`) and re-enter the verdict stage — the same
// four-class triage, the same routes, the same shared budgets as in-run
// reds. An env-only verdict comes back here for the re-run without a local
// cycle; every other route judges the tree again first. Every handler
// re-derives its position from the run ledger, the git state, and the forge,
// so a daemon restart resumes mid-ship without memory.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  ciEvidenceDir,
  commandLogPath,
  repairTicketPath,
  reconcileTicketPath,
  runReportPath,
} from '../daemon/home.mjs';
import { readEvents } from '../ledger/ledger.mjs';
import { assertDefectKind } from '../ledger/registry.mjs';
import { budgetOpen, ciFlakes, deterministicRed, FLAKE_LIMIT } from '../ledger/cycles.mjs';
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
  changedAgainstBase,
  commitAll,
  resetHard,
} from '../isolation/tree.mjs';
import { testEditDenyRules } from '../seats/boundary.mjs';
import { attemptOrder, noLogReason, PartialLogRefusal } from '../ship/forge.mjs';
import { derivedLabels } from '../ship/labels.mjs';
import { takeShipToken } from '../ship/token.mjs';
import {
  FORESEEN_HEADING,
  FORESEEN_MARKER,
  isForeseenNote,
  parseIntentCard,
} from './card.mjs';
import { authorizedSupersedes, supersedeLines } from './supersede.mjs';
import { fastPathDecision } from './fastpath.mjs';
import { runCommand } from './exec.mjs';
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
//
// A cancel is in none of these sets. It is terminal and it is not green, but
// it is not a red either: nobody ran the check to an answer, somebody stopped
// it. Reading it as a red made a cancel-then-green cycle look exactly like a
// flake — one head sha once carried 36 cancels and 34 successes, and the
// harness classified its way through all of them (ADR-0041).
const GREEN = new Set(['success', 'neutral', 'skipped']);
const RED = new Set(['failure', 'timed_out', 'action_required', 'stale']);
const CANCELLED = 'cancelled';
const TERMINAL = new Set([...GREEN, ...RED, CANCELLED]);
const LOG_TAIL = 1500;

/**
 * The watcher's bound on a head sha the forge carries no check run of any
 * name for. It is a count of poll outcomes that saw nothing, never a span of
 * wall-clock time: the recovery route fires on observations, and `pollMs`
 * stays what it always was — cadence, not detection.
 */
export const CHECKLESS_POLLS = 20;

/**
 * The watcher's bound on a required check that stands cancelled with no later
 * attempt behind it. A cancel is not an answer, so the watcher waits for the
 * attempt that will answer — a re-run somebody asked for, a concurrency group
 * releasing the job. Past the bound nobody is going to send one, and the run
 * escalates the cancel rather than waiting on it for ever. Poll outcomes, like
 * every other bound here, never wall-clock time.
 */
export const CANCELLED_POLLS = 20;

/**
 * The bound on the branch updates one implementation pass takes before its
 * final verdict. Under the token the base moves only when a human merges, so
 * the second update in one pass is already the sign that this tree is chasing
 * a branch it will not catch; past the bound the run ships and the ship stage
 * takes the update, exactly as it did before the pre-verdict one existed.
 */
export const UPDATE_CAP = 2;

/**
 * Stamps one gate-integrity record under a closed defect kind. Every stamp on
 * this path goes through here, so the kind is checked against the registry at
 * the one moment it could still be a new word — a defect the harness names in
 * a sentence is a defect nobody counts, which is the whole reason the
 * vocabulary is closed (ADR-0008).
 * @param {object} ctx the run context
 * @param {{kind: string} & Record<string, unknown>} fields
 */
function gateIntegrity(ctx, { kind, ...fields }) {
  return ctx.store.append('gate-integrity', {
    actor: ACTOR,
    kind: assertDefectKind(kind),
    ...fields,
  });
}

/**
 * The defect kind this run named for one request, or undefined. A gate the
 * harness itself failed is stamped where it is observed, long before the merge
 * that carries it into the product; when that merge is red, the escape the
 * breach records is that same defect and takes the same word for it. A record
 * naming a finding is a seat's judgment about the tree, not the harness naming
 * its own defect, so it is not one of these.
 */
function namedDefect(events, pr) {
  return [...events]
    .reverse()
    .find((e) => e.event === 'gate-integrity' && e.pr === pr && e.kind && !e.findingId)?.kind;
}

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
    // The two routes a downstream collision takes (ADR-0052). A consequence the
    // target card already mandates is a note the sweep writes onto that card; a
    // choice the card leaves open is a question for the owner. Both are
    // optional: a sweep that reports neither has found neither, and the
    // build-time classifier still reads the card for itself.
    foreseen: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          card: { type: 'string' },
          clause: { type: 'string' },
          file: { type: 'string' },
          mandate: { type: 'string' },
        },
        required: ['card', 'clause', 'file', 'mandate'],
      },
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          card: { type: 'string' },
          question: { type: 'string' },
        },
        required: ['card', 'question'],
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
  if (!ran) return { next: 'ship' };
  // The flag is the whole of the difference. Absent or false, the moved tree
  // goes back to the verdict exactly as it always has, and nothing above or
  // below this line reads differently (ADR-0056).
  if (base.config?.gates?.fastPathShip !== true) return { next: 'verdict' };
  return (await fastPathShip(ctx, base, out)) ? { next: 'ship' } : { next: 'verdict' };
}

/**
 * The clean-rebase fast path over one moved base: the decision, the stamp,
 * and nothing else. Returns true when the run may keep the certification it
 * already earned and go straight to the request.
 *
 * Every ending of the check that is not a clean yes is a no, including the
 * ones the check itself caused. A throw inside it is stamped as the closed
 * internal-error refusal and the run takes the re-verdict it would have taken
 * anyway: this path can remove work and can never block a ship.
 */
async function fastPathShip(ctx, base, out) {
  const events = runEvents(ctx);
  const pass = currentPass(events);
  let decision;
  try {
    decision = await fastPathDecision(base, events, out);
  } catch (error) {
    decision = {
      taken: false,
      refusal: 'internal-error',
      detail: gist(String(error?.message ?? error)),
    };
  }
  ctx.store.append('fast-path-ship', {
    actor: ACTOR,
    pass,
    mainSha: out.mainSha,
    fromSha: out.fromSha,
    toSha: out.toSha,
    ...decision,
  });
  return decision.taken === true;
}

/** The taken fast-path record of this run, or undefined. */
export function fastPathTaken(events) {
  return [...events].reverse().find((e) => e.event === 'fast-path-ship' && e.taken === true);
}

// -- the ship stage ----------------------------------------------------------

function shipHandler({ forgeFor, pollMs }) {
  return async function ship(ctx) {
    const base = await shipBase(ctx, forgeFor);
    // Poll outcomes of this stage entry that saw nothing move: no check run at
    // all on a head sha, and a required check standing cancelled. The counts
    // live here and the routes' decisions live in the ledger: a restart
    // re-enters the stage and counts again, while the stamps below still say
    // which recovery step the run already spent.
    const polls = { checkless: new Map(), cancelled: new Map() };
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
      const directive = await watchChecks(ctx, base, opened, st, polls);
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
    forge: base.forge,
    defaultBranch: base.defaultBranch,
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
  // The labels are derived before the request exists and ride the create
  // call, because the forge starts the request's checks the moment it opens
  // one: a label applied after that races the check that reads it, and a
  // check judging the request as it was created can never see the label at
  // all. The derivation is the same diff read the apply path always took.
  const labels = derivedLabels(
    await changedAgainstBase(base.worktree, base.defaultBranch),
    base.config.labels,
  );
  const pr = await base.forge.openPr({
    head: base.branch,
    base: base.defaultBranch,
    title: base.storyKey ? `${base.storyKey}: ${base.cardTitle ?? 'ship'}` : `repair: ${ctx.runId}`,
    body: [`Olympus run ${ctx.runId}.`, `Spec: ${base.specRef}`, `Head: ${sha}`].join('\n'),
    labels,
  });
  // Labels before the arm: a required-label check gates the merge, so the
  // request carries what its diff asks for before anything can merge it.
  const labelled = await labelRequest(ctx, base, pr.number, labels, pr.labelled === true);
  if (labelled) return labelled;
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

/**
 * Records the labels the request's own diff requires, and applies them when
 * the create did not. The derivation reads the diff against the default
 * branch — the same evidence the project's own label check reads — so the
 * harness and the check answer one question from one input, and a label a
 * human used to apply by hand arrives with the request.
 *
 * `atCreation` is the forge saying the request it just opened already carries
 * them; the stamp then records one act, not two, and there is no moment in
 * which the request exists unlabelled. The apply call stays the fallback: a
 * forge whose create takes no labels, and a create that found the request
 * already open, both answer false and take it.
 *
 * A label the forge will not apply is a repository that does not define it.
 * That is substrate the daemon never self-clears, so it parks and names the
 * labels. A label no rule derives is not a park and not a guess: the check
 * that wants it is the thing that says so.
 *
 * A request that did not carry its labels out of the create is the
 * `pr-label-missing` defect, whether the apply call rescued it or not: the
 * forge starts the checks at creation, so a request labelled a moment later
 * existed unlabelled for the one moment that decides the label check. The
 * defect has a fix (the labels ride the create) and this is the count that
 * says whether the fix is holding — one record per request, loud, and answered
 * by that request merging, which is the evidence the window cost it nothing.
 */
async function labelRequest(ctx, base, pr, labels, atCreation) {
  const applied = atCreation ? { applied: [...labels] } : await base.forge.applyLabels(pr, labels);
  const ok = applied.applied.length === labels.length;
  ctx.store.append('pr-labeled', {
    actor: ACTOR,
    pr,
    labels,
    applied: ok,
    at: atCreation ? 'create' : 'open',
  });
  const events = runEvents(ctx);
  if (
    labels.length > 0 &&
    !atCreation &&
    !events.some((e) => e.event === 'gate-integrity' && e.kind === 'pr-label-missing' && e.pr === pr)
  ) {
    gateIntegrity(ctx, {
      kind: 'pr-label-missing',
      pr,
      labels,
      applied: ok,
      detail: ok
        ? 'the create did not carry the labels; the apply call put them on afterwards'
        : `the create did not carry the labels and the apply call was refused: ${applied.reason ?? 'no reason given'}`,
      gist: `PR #${pr} opened without the label${labels.length > 1 ? 's' : ''} its diff asks for`,
    });
  }
  if (ok) return null;
  return parkDirective('provisioning-gate', {
    ...GATE_FORMS,
    question:
      `PR #${pr} needs the label${labels.length > 1 ? 's' : ''} ${labels.join(', ')} ` +
      `and the forge refused: ${applied.reason ?? 'no reason given'}. ` +
      'Define them on the repository, then answer to open the request again.',
  });
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

/**
 * The authoritative check run of every name on one head sha, with the number
 * of the attempt it is.
 *
 * The forge lists every attempt it holds, so one name can carry three of them:
 * a request whose check name once answered success 59 times, failure 35 and
 * skipped 31 was read by taking whichever the forge listed first, which made
 * the green-or-red reading of that request depend on the order an API answer
 * came back in. The latest attempt is the answer — it is the one the forge
 * itself will merge on — and `attemptOrder` decides which that is from the
 * attempts' own facts. A forge that names no check-run id leaves every attempt
 * on a name tied, and the read falls back to what it always was: one identity
 * per name (ADR-0041).
 * @param {Array<object>} runs the forge's check runs for one head sha
 * @returns {Map<string, object>} name → the authoritative run, plus `attempt`
 */
export function checksByName(runs) {
  const groups = new Map();
  for (const run of runs) {
    const list = groups.get(run.name) ?? [];
    list.push(run);
    groups.set(run.name, list);
  }
  const resolved = new Map();
  for (const [name, list] of groups) {
    list.sort(attemptOrder);
    resolved.set(name, { ...list.at(-1), attempt: list.length });
  }
  return resolved;
}

/** The identity of one check attempt: its check-run id, or the name behind a forge that serves none. */
function runKey(run) {
  return run.id == null ? `name:${run.name}` : String(run.id);
}

/** What the watcher makes of one check run: green, red, cancelled, or pending. */
function stateOf(run) {
  const status = normalize(run);
  if (GREEN.has(status)) return 'green';
  if (RED.has(status)) return 'red';
  if (status === CANCELLED) return 'cancelled';
  return 'pending';
}

/** A terminal state that is not a green: a red, or a cancel. */
function notGreen(status) {
  return TERMINAL.has(status) && !GREEN.has(status);
}

/**
 * Stamps every observed state change per check, captures the evidence of a
 * required check that is not green, and stamps the ci-flake events and the
 * point at which a check stops being a flake.
 *
 * The evidence comes first, before any classification reads the state: what
 * the forge holds about an attempt is not durable, and a cancel-and-rerun from
 * outside the harness replaces the attempts a triage was going to read. The
 * capture is the run's own copy (ADR-0041).
 *
 * The flake reading rests on one claim: the red was the substrate, and the
 * green is the tree. A check that has now made that claim `FLAKE_LIMIT` times
 * on one head sha has answered both ways over a tree that never moved between
 * any of the answers, so the claim is spent. The check is reclassified
 * deterministic-red — loud, once per pair — and from there its greens buy it
 * nothing: no further flake is classified, and no automatic re-run is granted
 * (ADR-0008). A cancel is no part of that claim: nobody read an answer out of
 * a check somebody stopped.
 */
function observeChecks(ctx, opened, sha, byName) {
  const events = runEvents(ctx);
  const last = new Map();
  for (const e of events) {
    if (e.event === 'check-transition' && e.sha === sha) {
      last.set(e.check, { status: e.status, id: e.checkRunId ?? null });
    }
  }
  const required = new Set(opened.required ?? []);
  for (const run of byName.values()) {
    const status = normalize(run);
    if (required.has(run.name) && notGreen(status)) {
      captureCheckRun(ctx, events, opened, sha, run);
    }
    const held = last.get(run.name);
    // A fresh attempt is a fresh observation even when it lands on the state
    // the attempt before it held: the same red twice is two reds, and the
    // ledger is where a reader counts them.
    const moved = !held || held.status !== status || (held.id != null && held.id !== runKey(run));
    if (!moved) continue;
    const fields = {
      actor: ACTOR,
      pr: opened.pr,
      sha,
      check: run.name,
      status,
      required: required.has(run.name),
      ...(run.id != null && { checkRunId: String(run.id), attempt: run.attempt }),
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
      // A check the ledger already reclassified is done being a flake: the
      // green is one more of the answers the record is about, and classifying
      // it again is how one broken check writes a thousand lines.
      if (deterministicRed(events, sha, run.name)) continue;
      // The one automatic re-run turned the check green: a flake, never a
      // finding.
      ctx.store.append('ci-flake', { actor: ACTOR, pr: opened.pr, sha, check: run.name });
      // The stamp above is the flake this pass counted; `events` is the ledger
      // as it stood before it, and one check stamps at most one flake per pass.
      const flakes = ciFlakes(events, sha, run.name) + 1;
      if (flakes < FLAKE_LIMIT) continue;
      gateIntegrity(ctx, {
        kind: 'deterministic-red',
        pr: opened.pr,
        sha,
        check: run.name,
        flakes,
        detail:
          `${run.name} turned green after a re-run ${flakes} times on ${sha}, ` +
          'a tree that did not move between them',
        gist: `${run.name} is not a flake on ${sha.slice(0, 7)}: ${flakes} greens over one tree`,
      });
    }
  }
}

// -- captured CI evidence ----------------------------------------------------

/**
 * The metadata of one check attempt, written the moment the watcher sees it in
 * a state that is not green. It costs no forge call — the watcher already
 * holds the check run — and it is what identifies an attempt after the forge
 * stops listing it: a cancel-and-rerun from outside the harness replaces the
 * attempts of a head sha, and a triage run afterwards reads the replacements.
 *
 * The log is not here, because a log read out of a workflow run still
 * executing is a partial log that reads exactly like a whole one (ADR-0008).
 * `captureLogs` takes it at the first poll where the run reports itself over,
 * which is the earliest moment the evidence is both whole and readable.
 */
function captureCheckRun(ctx, events, opened, sha, run) {
  const checkRunId = runKey(run);
  const held = events.some(
    (e) => e.event === 'ci-evidence' && e.sha === sha && e.checkRunId === checkRunId,
  );
  if (held) return;
  const dir = ciEvidenceDir(ctx.paths, ctx.runId, run.name, checkRunId, run.attempt ?? 1);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'check-run.json'),
    JSON.stringify(
      {
        check: run.name,
        checkRunId,
        attempt: run.attempt ?? 1,
        pr: opened.pr,
        sha,
        state: stateOf(run),
        status: run.status,
        conclusion: run.conclusion ?? null,
        startedAt: run.startedAt ?? null,
        completedAt: run.completedAt ?? null,
        workflowRun: run.run ?? null,
        detailsUrl: run.detailsUrl ?? null,
        observedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  ctx.store.append('ci-evidence', {
    actor: ACTOR,
    pr: opened.pr,
    sha,
    check: run.name,
    checkRunId,
    attempt: run.attempt ?? 1,
    state: stateOf(run),
    dir,
    log: 'pending',
  });
}

/**
 * The failure logs of the attempts this poll is about to classify, taken
 * before the classification runs. Every caller reaches here with the workflow
 * runs behind these checks already reported complete, so the log is whole.
 *
 * One attempt is fetched once: the stamp that says the log landed — or that
 * the forge answered with a reason instead of a log — is the record that stops
 * the next poll asking again.
 */
async function captureLogs(ctx, base, opened, sha, runs) {
  const events = runEvents(ctx);
  for (const run of runs) {
    const checkRunId = runKey(run);
    const held = events.filter(
      (e) => e.event === 'ci-evidence' && e.sha === sha && e.checkRunId === checkRunId,
    );
    if (held.length === 0 || held.some((e) => e.log !== 'pending')) continue;
    let output;
    try {
      output = await base.forge.checkLog(run);
    } catch (error) {
      // The one refusal this read expects: the workflow run behind the check
      // had not finished after all. The metadata stands, the log stays owed,
      // and the next poll asks again. Every other failure is the forge's own
      // and travels, exactly as it does from the triage's read.
      if (!(error instanceof PartialLogRefusal)) throw error;
      continue;
    }
    const dir = held[0].dir;
    const reason = noLogReason(output);
    if (reason == null) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'log.txt'), String(output));
    }
    ctx.store.append('ci-evidence', {
      actor: ACTOR,
      pr: opened.pr,
      sha,
      check: run.name,
      checkRunId,
      attempt: run.attempt ?? 1,
      state: stateOf(run),
      dir,
      log: reason == null ? 'captured' : 'absent',
      ...(reason == null ? { bytes: Buffer.byteLength(String(output)) } : { reason }),
    });
  }
}

/**
 * The captured log of the latest attempt at one check on one head sha, or null
 * when the run captured none. The ledger names the directory, so a reader
 * finds the evidence without walking the filesystem, and a restart finds it
 * exactly where the stamp says it is.
 */
function capturedLog(events, sha, check) {
  const stamps = events.filter(
    (e) => e.event === 'ci-evidence' && e.sha === sha && e.check === check && e.log === 'captured',
  );
  for (const stamp of stamps.reverse()) {
    const path = join(stamp.dir, 'log.txt');
    if (existsSync(path)) return { path, output: readFileSync(path, 'utf8'), stamp };
  }
  return null;
}

async function watchChecks(ctx, base, opened, st, polls) {
  const sha = st.headSha;
  const runs = await base.forge.checkRuns(sha);
  const byName = checksByName(runs);
  observeChecks(ctx, opened, sha, byName);
  if (runs.length === 0) {
    // No check of any name on the head of an open request the forge does not
    // call conflicting: the required set is not late, it was never delivered.
    // Counted, then routed — the watcher does not wait on it.
    const seen = (polls.checkless.get(sha) ?? 0) + 1;
    polls.checkless.set(sha, seen);
    if (seen < CHECKLESS_POLLS) return null;
    polls.checkless.set(sha, 0);
    return checklessSha(ctx, base, opened, sha, seen);
  }
  polls.checkless.delete(sha);
  const requiredRuns = (opened.required ?? []).map((name) => byName.get(name));
  if (requiredRuns.some((r) => !r)) return null; // not all appeared: pending
  const redNow = requiredRuns.filter((r) => stateOf(r) === 'red');
  if (redNow.length > 0) return handleRed(ctx, base, opened, sha, redNow);
  const stopped = requiredRuns.filter((r) => stateOf(r) === 'cancelled');
  if (stopped.length > 0) return handleCancelled(ctx, base, opened, sha, stopped, polls);
  if (requiredRuns.every((r) => stateOf(r) === 'green')) {
    if (st.autoMergeArmed) return null; // the merge is the forge's next move
    return greenNoMerge(ctx, base, opened, sha);
  }
  return null; // pending is a state, never a verdict
}

/**
 * A required check somebody stopped. It is not a red — no run of the check
 * produced that state, and the automatic re-run exists to test a claim a
 * cancel never made — and it is not a green either, so the watcher waits for
 * the attempt that answers: a re-run, or a concurrency group letting the job
 * through. Waiting is bounded by observations, and past the bound the cancel
 * takes the escalation a red takes, with its evidence already on disk.
 */
async function handleCancelled(ctx, base, opened, sha, stopped, polls) {
  const key = `${sha}:${stopped.map((r) => runKey(r)).join(',')}`;
  const seen = (polls.cancelled.get(key) ?? 0) + 1;
  polls.cancelled.set(key, seen);
  if (seen < CANCELLED_POLLS) return null;
  const executing = await runsNotDone(base, stopped);
  // A run still executing holds the escalation the way it holds a red, and it
  // holds the count with it: the bound is on observations of a cancel nobody
  // replaced, not on the wait for the run behind one.
  if (executing.length > 0) return stampWait(ctx, opened, sha, executing, stopped);
  polls.cancelled.delete(key);
  await captureLogs(ctx, base, opened, sha, stopped);
  return ciTriage(ctx, base, opened, sha, stopped, waitedFor(runEvents(ctx), sha));
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

/**
 * What one finding has spent of the automatic re-run budget, as ledger seqs in
 * order. The budget is counted against the pair of the run and the finding —
 * the failing check's name — and never against the head sha. A finding does
 * not become a new one because the head moved: a cancel, a replay, a repair
 * push and a whole verdict cycle all leave the same required check red, and
 * reading each of them as a fresh entitlement is how a ship re-runs itself in
 * circles. Past the budget the red takes the escalation it would take anyway —
 * the CI triage, its ladder and its own budgets — and never another re-run.
 *
 * A re-run the stage asked for spends it. So does an attempt a cancel ended: a
 * cancel is somebody stopping the work, and an automatic re-run is the harness
 * deciding the opposite — which is exactly the move that outlived an explicit
 * stop once already.
 */
function rerunSpent(events, event, check) {
  const seqs = [];
  for (const e of events) {
    if (e.event !== event || e.check !== check) continue;
    if (e.status === 'rerun-requested' || e.status === 'cancelled') seqs.push(e.seq);
  }
  return seqs;
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
 * The workflow runs behind the red checks that have not reported themselves
 * complete. A check is one job of a workflow run: a job that fails early turns
 * its check red and leaves the rest of the run going, so a terminal check is
 * no statement at all about the run it belongs to. A check with no workflow run
 * behind it — any other app's check — has nothing to wait for.
 *
 * The bar is the run's own report of a completed status, so a run the forge
 * would not answer for holds the dispatch too. The answer that matters here is
 * not "is it still going" but "did it say it was done", and those differ on
 * exactly the read that costs the most: a triage handed the first half of a
 * run's log reads the steps that passed and concludes about the ones it cannot
 * see. Holding costs a poll, and the poll asks again.
 */
async function runsNotDone(base, redChecks) {
  const ids = [...new Set(redChecks.map((r) => r.run).filter((id) => id != null).map(String))];
  const waiting = [];
  for (const id of ids) {
    const state = await base.forge.workflowRun(id);
    if (state?.status !== 'completed') waiting.push({ run: id, status: state?.status ?? 'unreadable' });
  }
  return waiting;
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
  const executing = await runsNotDone(base, redNow);
  if (executing.length > 0) return stampWait(ctx, opened, sha, executing, redNow);
  // The evidence, before the classification that decides what happens to these
  // reds. The re-run below replaces the attempts on the forge, so this is the
  // last moment their logs are the harness's to take (ADR-0041).
  await captureLogs(ctx, base, opened, sha, redNow);
  const events = runEvents(ctx);
  const lastOpFix = findLast(events, 'operational-fix')?.seq ?? 0;
  // One automatic re-run of the failed jobs per (run, finding); an operational
  // fix grants the next one. A check reclassified deterministic-red on this
  // head sha takes neither: the re-run is the test of a flake, this check has
  // stopped being one, and a grant that re-opens a budget cannot hand back a
  // reading the ledger withdrew.
  const needRerun = redNow.filter(
    (r) =>
      !deterministicRed(events, sha, r.name) &&
      budgetOpen(rerunSpent(events, 'check-transition', r.name), lastOpFix),
  );
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
        // The attempt the harness asked the forge to replace. The one that
        // answers is a different check run, and the ledger says which was
        // which.
        ...(r.id != null && { checkRunId: String(r.id), attempt: r.attempt }),
      });
    }
    return null;
  }
  const persistent = redNow.every((r) => {
    const { lastRerun, lastRed } = checkMarks(events, sha, r.name);
    return lastRed > lastRerun;
  });
  if (!persistent) return null; // the re-run is still in flight
  return ciTriage(ctx, base, opened, sha, redNow, waitedFor(events, sha));
}

/**
 * Persistent CI reds enter the shared four-class triage and render a red
 * verdict (`source: 'ci'`); the verdict stage routes it — same ladders, same
 * budgets as in-run reds. `waited` is the span the watcher held the dispatch
 * back for, and it is on the verdict because that is the moment the span is
 * known.
 *
 * The dispatch reads the workflow runs itself, immediately before it asks for
 * a single log. The watcher upstream already holds a red whose run has not
 * reported complete, and that hold is what keeps an ordinary CI race cheap —
 * but a rule that lives one caller up is a rule the next caller does not know
 * about, and the cost of not knowing it is a gate judged on half a log. Here
 * the condition is checked where the consequence is, so no route into this
 * function can produce a triage over a run that never said it was done.
 */
async function ciTriage(ctx, base, opened, sha, redChecks, waited = null) {
  const notDone = await runsNotDone(base, redChecks);
  if (notDone.length > 0) return stampWait(ctx, opened, sha, notDone, redChecks);
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
    // The snapshot first, the forge second. The capture was taken when the
    // attempt was observed; the live read asks the forge what it still holds,
    // which after an external cancel-and-rerun is the replacement rather than
    // the attempt that failed (ADR-0041).
    const captured = capturedLog(events, sha, r.name);
    const output = captured ? captured.output : await base.forge.checkOutput(sha, r.name);
    // The forge answers a log it cannot serve with a reason, and the reason
    // travels to the seat as it always has: a red check is a red check, and a
    // triage told why the evidence is absent judges better than one told
    // nothing. What it stops doing is passing quietly — the absence is a
    // defect of the gate, so it is stamped under its own name and counted,
    // once per check on this sha (ADR-0008).
    const absent = noLogReason(output);
    if (
      absent != null &&
      !events.some(
        (e) =>
          e.event === 'gate-integrity' &&
          e.kind === 'triage-log-missing' &&
          e.sha === sha &&
          e.check === r.name,
      )
    ) {
      gateIntegrity(ctx, {
        kind: 'triage-log-missing',
        pr: opened.pr,
        sha,
        check: r.name,
        cycle,
        detail: absent,
        gist: `no CI failure log for ${r.name} on ${sha.slice(0, 7)}: ${absent}`,
      });
    }
    reds.push({ layer: `ci:${r.name}`, output });
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
    gateIntegrity(ctx, {
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
  const byName = checksByName(runs);
  // The merge can land between polls; the final check states of the head
  // sha still stamp — all terminal states are covered, flakes included.
  observeChecks(ctx, opened, st.headSha, byName);
  const required = new Set(opened.required ?? []);
  // What landed on the default branch with a required check that never turned
  // green — a red, or a cancel nobody replaced. The merge is the escape
  // either way, and the state travels with it.
  const redChecks = [...byName.values()]
    .filter((r) => required.has(r.name) && notGreen(normalize(r)))
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
    // A ship that carried its certification over a moved base is marked at the
    // close as well as where it was decided. The close record is what a reader
    // of one line of `run-closed` sees, and the trade the flag makes is worth
    // seeing there (ADR-0056).
    const fast = fastPathTaken(runEvents(ctx));
    return {
      close: {
        state: 'shipped',
        pr: merged.pr,
        mergeSha: merged.mergeSha,
        ...(fast && { fastPath: true }),
      },
    };
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
      // The word this run already used for its own defect, where it named one.
      // The escape is that same defect arriving in the product, so it is
      // recorded under the same closed kind rather than described again in a
      // second sentence nobody can count with the first (ADR-0024).
      const kind = namedDefect(events, merged.pr);
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
            ...(kind && { kind }),
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
    const tails = await redCheckTails(ctx, base, merged);
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

/**
 * The red checks at the merge, each with the tail of its output. The captured
 * evidence answers first: the merge is behind these reds, so the forge has had
 * every chance to re-run them, and the repair ticket is the one reader that
 * cannot come back for a second look (ADR-0041).
 */
async function redCheckTails(ctx, base, merged) {
  const events = runEvents(ctx);
  const tails = [];
  for (const name of merged.redChecks ?? []) {
    const captured = capturedLog(events, merged.sha, name);
    let output = captured?.output;
    if (output == null) {
      try {
        output = await base.forge.checkOutput(merged.sha, name);
      } catch (error) {
        output = `(the forge would not return the output of ${name}: ${error.message})`;
      }
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
    ...(escape.kind ? [`- kind (the harness already named this defect): ${escape.kind}`] : []),
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
    const all = await base.forge.checkRuns(merged.mergeSha);
    if (all.length === 0) return null;
    // The latest attempt at every name, the same read the request path takes:
    // a merge commit carries re-runs too, and the answer is the last of them.
    const runs = [...checksByName(all).values()];
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
    // Every terminal state that is not a green, the cancel included: the merge
    // has landed, so a check that never answered green on it is the same news
    // as one that answered red.
    const reds = runs.filter((r) => notGreen(normalize(r)));
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
        else if (notGreen(e.status)) lastRed = e.seq;
      }
      return { lastRerun, lastRed };
    };
    const lastOpFix =
      [...fresh]
        .reverse()
        .find((e) => e.event === 'operational-fix' && e.kind === 'merge-commit-rerun')?.seq ?? 0;
    const granted = answeredPark(fresh, 'provisioning-gate');
    // The same budget the ship path counts, over the merge commit's own
    // stamps: one automatic re-run per (run, finding), and an answered gate is
    // the only thing that grants the next.
    const needRerun = reds.filter((r) =>
      budgetOpen(rerunSpent(fresh, 'merge-commit-check', r.name), granted?.answer?.seq ?? 0),
    );
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
  // The supersedes this run executed on the card's authority. The card is their
  // durable home — a run ledger archives with its run, and the next story reads
  // the card — and this sweep is the one mechanism already allowed to write a
  // card on the default branch (ADR-0044).
  const supersedes = authorizedSupersedes(runEvents(ctx));
  let brief = null;
  let report = null;
  let lint = null;
  for (let attempt = 1; ; attempt++) {
    const n = invocationCount(runEvents(ctx), 'card-sweep') + 1;
    const result = await ctx.runSeat({
      seat: 'card-sweep',
      roleBlock: sweepRole(base, cardDir, brief, supersedes),
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
    const checked = await sweepChecks(ctx, base, cardDir, result.report);
    const defects = checked.defects;
    lint = checked.lint;
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
      ctx.store.append('card-sweep', {
        actor: ACTOR,
        ok: false,
        cause: 'work-product-defect',
        ...(lint && { lint }),
      });
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
  const instanceParks = readEvents(ctx.paths.instanceLedger).filter(
    (e) => e.event === 'park' && e.runId === ctx.runId,
  );
  const parked = new Set(
    instanceParks.filter((e) => e.type === 'card-invalidated').map((e) => e.card),
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
  // A choice the card genuinely leaves open takes the same route, one park per
  // question. It is asked here rather than planted on the card, because a
  // question written into a card parks the next launch of that card before the
  // machinery that settles collisions from card authority ever runs, and the
  // owner is then asked once per ship for ever (ADR-0052). The park holds the
  // card it names and never this close: the story shipped.
  const asked = new Set(
    instanceParks
      .filter((e) => e.type === 'card-decision')
      .map((e) => `${e.card}\n${e.decision}`),
  );
  for (const open of report.decisions ?? []) {
    const key = `${open.card}\n${open.question}`;
    if (asked.has(key)) continue;
    asked.add(key);
    ctx.instanceStore?.append('park', {
      actor: ACTOR,
      type: 'card-decision',
      card: open.card,
      decision: open.question,
      runId: ctx.runId,
      question:
        `The ship of ${base.storyKey ?? ctx.runId} left a decision open on ${open.card}: ` +
        open.question,
      answers: instanceParkForms({ text: 'the decision, resolved' }),
      gist: gist(`card-decision on ${open.card}: ${open.question}`),
    });
  }
  ctx.store.append('card-sweep', {
    actor: ACTOR,
    ok: true,
    updated: report.updatedCards.length,
    invalidated: report.invalidated.length,
    // What the sweep classified: the notes it wrote onto cards, and the
    // questions it put to the owner. Both counts record that the
    // classification duty ran at all.
    foreseen: (report.foreseen ?? []).length,
    decisions: (report.decisions ?? []).length,
    // What the project's own card lint said about the writes this sweep is
    // pushing: green, or the reason there is no green to report (ADR-0054).
    ...(lint && { lint }),
    pushed,
    ...(sha && { sha }),
    ...(pushError && { error: pushError }),
  });
}

/**
 * The sweep's self-check on its own work product: what the seat wrote, and
 * where. It returns the defects that re-brief the attempt, and what the
 * project's card lint said (ADR-0054).
 */
async function sweepChecks(ctx, base, cardDir, report) {
  const defects = [];
  const changed = await changedFiles(base.worktree);
  for (const file of changed) {
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
  // A foreseen amendment is a note ON a card, so the note has to be there. The
  // report is the sweep's claim and the card is the durable record: the next
  // launch reads the card to see there is nothing to ask, and the build-time
  // classifier reads it as evidence. A claim with no note on the card is a
  // work-product defect, and the attempt is re-briefed (ADR-0052).
  for (const note of report.foreseen ?? []) {
    if (!underAny(note.card, [cardDir])) {
      defects.push(`foreseen amendment on a card outside the card directory: ${note.card}`);
    } else if (!noteWritten(base.worktree, note)) {
      defects.push(
        `the foreseen amendment for ${note.file} is not on ${note.card}: write it there under a ` +
          `"${FORESEEN_HEADING}" heading, as one line that opens with "${FORESEEN_MARKER}" and ` +
          'names the file.',
      );
    }
  }
  for (const open of report.decisions ?? []) {
    if (!underAny(open.card, [cardDir])) {
      defects.push(`open decision on a card outside the card directory: ${open.card}`);
    }
  }
  return { defects, lint: await cardLint(ctx, base, changed, defects) };
}

/**
 * The project's own card lint, run over what the sweep wrote, before any of it
 * is pushed.
 *
 * The sweep is the one writer in the harness that lands text on the default
 * branch without a request behind it, so it is the one writer whose output no
 * gate reads. The command is the project's, named in its own config, and it is
 * the same command the launch gate runs over the same files: an automated
 * writer passes every mechanical check that binds the equivalent human path,
 * because a card the project's check refuses parks every launch behind it
 * (ADR-0054).
 *
 * A red is a work-product defect. It fails this attempt and re-briefs the seat
 * on the two-attempt loop the sweep already has, so nothing red is pushed. A
 * command that could not run at all fails the attempt the same way: it is not
 * a red, but it is not a green either, and a push behind it is a push of cards
 * no check read. The stamp keeps the two apart, so a reader can tell a refused
 * card from a host that could not answer. A sweep that wrote nothing is not a
 * writer, and the lint of the tree as it was merged is not this sweep's answer
 * to give.
 */
async function cardLint(ctx, base, changed, defects) {
  const name = base.config.lanes?.story?.lintCommand;
  if (!name) return 'undeclared';
  if (changed.length === 0) return 'unwritten';
  const n = invocationCount(runEvents(ctx), 'card-sweep');
  const run = await runCommand(base.config.commands[name], {
    cwd: base.worktree,
    env: base.env,
    log: commandLogPath(ctx.paths, ctx.runId, `card-sweep-lint-${n}`),
  });
  if (run.code === null) {
    defects.push(
      'the card lint of this project could not run, so nothing read the cards you wrote; ' +
        `the sweep pushes no card the lint did not pass:\n${run.error ?? run.output}`,
    );
    return 'unrun';
  }
  if (run.code === 0) return 'green';
  defects.push(
    'the card lint of this project is red on what you wrote; repair the cards you edited ' +
      `until it passes:\n${run.output}`,
  );
  return 'red';
}

/**
 * Whether the card really carries the note the report claims for it: a line
 * under the foreseen heading, opening with the marker, naming the file whose
 * clause the amendment is foreseen for.
 */
function noteWritten(worktree, note) {
  let text;
  try {
    text = readFileSync(join(worktree, note.card), 'utf8');
  } catch {
    return false;
  }
  return parseIntentCard(text).card.foreseenAmendments.some(
    (item) => isForeseenNote(item) && item.includes(note.file),
  );
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

function sweepRole(base, cardDir, brief, supersedes = []) {
  return [
    `The story ${base.storyKey ?? ''} shipped; sweep the intent cards.`,
    `The shipped spec: ${base.specRef}`,
    `The cards live under: ${cardDir}. Edit card files in place; touch nothing outside that directory.`,
    'Update Blocked-by edges, sources, and open decisions so every card matches the repository as shipped.',
    "When the shipped work invalidates a card's goal or scope boundary, do not rewrite the card: list it under invalidated with the reason.",
    'List every card you edited under updatedCards.',
    ...(base.config.lanes?.story?.lintCommand
      ? [
          "The project's own card lint runs over everything you write, before any of it is " +
            'pushed. A card it refuses fails this attempt, so keep every card you edit inside ' +
            'the conventions the lint enforces.',
        ]
      : []),
    ...foreseenLines(cardDir),
    ...(supersedes.length > 0
      ? [
          'This run amended frozen tests on this card\'s own authority. Record each one on this ' +
            `story's card (${base.cardPath}) under a "## Supersedes" heading, creating the heading ` +
            'when the card has none. One line each: the test file, the assertion that changed, and ' +
            'the card line the authorization rested on. Record them; do not re-judge them.',
          ...supersedeLines(supersedes),
        ]
      : []),
    ...briefLines(brief),
  ].join('\n');
}

/**
 * The classification duty (ADR-0052). This ship froze tests, and a later card's
 * work can collide with them. Every such collision is one of two things, and
 * they take different routes.
 *
 * A consequence the target card's own acceptance criteria already mandate is
 * not a question. It becomes a note on that card: the next launch reads it and
 * proceeds, and the machinery that settles collisions from card authority
 * consumes it as evidence at build time. Writing it as an open decision instead
 * parks that launch before the machinery ever runs, and asks the owner, once
 * per ship, what the card already answered.
 *
 * A choice the card genuinely leaves open is a question, and it is put to the
 * owner here, at close-out, while the context is fresh. It holds the card it
 * names and no run.
 */
function foreseenLines(cardDir) {
  return [
    `This ship froze tests. Where the work of a later card under ${cardDir} would collide with ` +
      'them, classify the collision before you write anything, and take the route the class asks for.',
    `Mandated by the target card: the card's own acceptance criteria mandate a behavior whose ` +
      `implementation necessarily changes what the frozen clause asserts. Write a note on that ` +
      `card under a "## ${FORESEEN_HEADING}" heading, creating the heading when the card has ` +
      `none. One line, opening with "${FORESEEN_MARKER}", naming the clause the tests pin, the ` +
      `file it lives in, and the card line that mandates the change. Report it under foreseen ` +
      `with the card, the clause, the file and the mandate. It is a note, not a question: never ` +
      `write it as an open decision, and never rewrite the frozen tests here.`,
    'Left open by the target card: the card states no such mandate and a human has to choose. ' +
      'Report it under decisions with the card and the question. The owner is asked at this ' +
      'close-out and the question holds that card alone. Do not write it onto the card.',
    'Report foreseen and decisions on every sweep, empty when you found neither.',
  ];
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
