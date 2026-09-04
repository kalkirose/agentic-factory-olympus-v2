// The post-freeze chain: implementation (seat) → verdict (the spectrum loop
// with its response ladder). `postFreeze({afterVerdict})` composes the
// story-lane continuation; `repairLane({afterVerdict})` wires the repair
// variant — the intake ticket is the spec, the generalist review seat
// replaces the Fury fan-out, and the dev seat may edit tests (it writes the
// regression test).
//
// The verdict loop per cycle: the cycle's Tier-1 spectrum with the flake
// filter → verdict triage on persistent reds → the judgment review (Fury once
// per implementation pass; generalist review on repair diffs) → the
// confirmation sweep, when the cycle came out clean on a targeted spectrum →
// the verdict record. The response ladder acts on the rendered verdict:
// repair rounds (progress-gated, cap 3), suite-defect re-freeze, env/harness
// operational fixes, one fresh pass per run, and the second-stall escalation.
// Re-freeze steps and operational fixes never consume implementation budget.
// An operational fix on a CI verdict whose open findings are all env-class
// takes no cycle at all: it hands the run back to ship, where the CI re-run
// is the test, and stamps the skip on the ledger. An operational fix that does
// earn a local cycle probes the substrate before it stamps, because a re-run
// against a broken host fails again at the price of a full spectrum.
// A finding that persists past
// its fix parks the provisioning gate, unless every one of them is a harness
// defect an operator already acknowledged — then the lane answers the gate on
// that authority and stamps both the ack it used and the fix (ADR-0032).
//
// Every handler re-derives its position from the run ledger and the git
// state, so a daemon restart resumes mid-verdict without memory.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { reviewDiffPath, runReportPath } from '../daemon/home.mjs';
import {
  carryPaths,
  changedFiles,
  commitAll,
  filesAt,
  headSha,
  restorePaths,
  reviewDiff,
  changedInRange,
  resetHard,
} from '../isolation/tree.mjs';
import { testEditDenyRules } from '../seats/boundary.mjs';
import {
  DROP_NOTE,
  RECAPTURE_NOTE,
  SWEEP_NOTE,
  captureGist,
  classifyTakeBacks,
  diffPolicyViolations,
  dropLine,
  laneDiffPolicy,
  namesOnlyRecapturable,
  parseTouchedPaths,
  recaptureGist,
  recaptureLine,
  sweepCandidates,
  sweepGist,
  sweptTakeBacks,
  violationLine,
} from '../seats/diffpolicy.mjs';
import {
  ackFingerprint,
  coveringAck,
  findingFingerprint,
  isAckable,
  standingAcksFor,
} from '../ledger/acks.mjs';
import { cycleRepeat, openIdentities } from '../ledger/cycles.mjs';
import { readEvents } from '../ledger/ledger.mjs';
import { assertDefectKind } from '../ledger/registry.mjs';
import { openEscapesStore } from '../telemetry/stores.mjs';
import { readEscapeSet, recordEscape } from '../telemetry/escapes.mjs';
import {
  PROBE_REQUEST_PROPERTY,
  asksForProbe,
  finalReplayLabel,
  probeOfferLines,
  withReplayRounds,
} from './replay.mjs';
import { runSpectrum, rerunLayers, persistentReds, cyclePlan } from './spectrum.mjs';
import {
  credentialHostIn,
  readTransient,
  showsCode,
  showsTransient,
} from './transient.mjs';
import {
  EXTERNAL_OUTAGE_MS,
  EXTERNAL_POLL_MS,
  EXTERNAL_WAIT_MS,
  LAYER_LADDER,
  ladderStep,
  waitAttempt,
  waitFor,
  waitHistory,
  waitLine,
} from './waiting.mjs';
import { askProbe } from './probes.mjs';
import { configuredGroups } from './schedule.mjs';
import { PARTS_ENV, partPlan, carryTally, confirmationTally } from './parts.mjs';
import { substrateGate } from './substrate.mjs';
import { furyRound, generalistReview } from './review.mjs';
import { panelLenses } from './lenses.mjs';
import { freezeAnchor } from './resume.mjs';
import { parseIntentCard } from './card.mjs';
import {
  SUPERSEDE_BRIEF_LINES,
  SUPERSEDE_CLAIM_PROPERTIES,
  authorizeSupersede,
  authorizedSupersedes,
  refusalLine,
  supersedeClaim,
  supersedeRuling,
} from './supersede.mjs';
import { SUITE_SCHEMA, SPEC_AMEND_SCHEMA, specLintDefects } from './story.mjs';
import {
  ACTOR,
  loadProjectConfig,
  readConstitution,
  runEnv,
  runEvents,
  answeredPark,
  freezeExclusions,
  freezeOwnerPins,
  freezeSuiteFiles,
  seatReportAfter,
  seatFailureAfter,
  readJson,
  parkDirective,
  GATE_FORMS,
  HARNESS_GATE_FORMS,
  withAbandonGuard,
  withTreeRefresh,
  boughtRetry,
  answeredPath,
  blocked,
  commandError,
  seatWithChecks,
  underAny,
  briefLines,
  gist,
} from './shared.mjs';

const REPAIR_CAP = 3;
const TRIAGE_CLASSES = ['code-defect', 'suite-defect', 'env', 'harness'];

// The closed name a harness defect met at a provisioning gate is counted
// under. It is the finding's class, deliberately: the triage seat classes the
// defect and the escape records the same word, so nobody has to decide whether
// two vocabularies mean one thing (ADR-0024, ADR-0068).
const HARNESS_DEFECT_KIND = assertDefectKind('harness');

// Why a CI verdict whose findings all point outside the tree goes back to
// ship without a local cycle. The stamp carries it, because a skipped sweep
// must read as a decision and not as a step the run forgot.
const SWEEP_SKIP_NOTE =
  'every open finding is env or harness class on a CI verdict: each remedy ' +
  'lives outside this tree, so no Tier-1 layer of it exercises them and the ' +
  'CI re-run is the test';

/**
 * The story-lane continuation after the freeze. `afterVerdict` supplies the
 * ship stages, landing with their milestone.
 * @param {{afterVerdict: {stages: string[], handlers: object}}} opts
 */
export function postFreeze({ afterVerdict }) {
  requireContinuation(afterVerdict, 'postFreeze');
  return {
    stages: ['implementation', 'verdict', ...afterVerdict.stages],
    handlers: withAbandonGuard({
      implementation: implementationHandler('story'),
      verdict: verdictHandler('story', afterVerdict.stages[0]),
      ...afterVerdict.handlers,
    }),
  };
}

/**
 * The repair lane: fix (seat) → verdict → continuation. No spec birth and no
 * adversary — the intake ticket is the spec; deterministic gates run in
 * full; judgment collapses to the generalist review seat.
 * @param {{afterVerdict: {stages: string[], handlers: object}}} opts
 */
export function repairLane({ afterVerdict }) {
  requireContinuation(afterVerdict, 'repairLane');
  return {
    stages: ['fix', 'verdict', ...afterVerdict.stages],
    // A lane root carries both stage-entry guards: the abandon route out of
    // any park (ADR-0015), and, inside it, the tree refresh a bought retry on
    // a stage-blocked park is owed (ADR-0055).
    handlers: withAbandonGuard(
      withTreeRefresh({
        fix: implementationHandler('repair'),
        verdict: verdictHandler('repair', afterVerdict.stages[0]),
        ...afterVerdict.handlers,
      }),
    ),
  };
}

function requireContinuation(continuation, name) {
  if (!Array.isArray(continuation?.stages) || continuation.stages.length === 0) {
    throw new Error(`${name} requires an afterVerdict continuation`);
  }
}

// -- report schemas (flat draft-07-safe subset) ------------------------------

export const DEV_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
  },
  required: ['summary'],
};

export const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          class: { type: 'string', enum: TRIAGE_CLASSES },
          depth: { type: 'string', enum: ['test', 'spec', 'intent'] },
          layers: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          // An intent-depth finding may carry the card's own authorization for
          // the amendment it needs. Four facts or nothing (ADR-0044).
          ...SUPERSEDE_CLAIM_PROPERTIES,
        },
        required: ['class', 'layers', 'summary', 'evidence'],
      },
    },
    persisting: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    // The replay probe: triage may ask for one Tier-1 layer of its own run to
    // be run again and read the output, which is the only route it has to a
    // credential-dependent red (ADR-0042). Optional; a report that carries it
    // is a request and not yet a verdict.
    probe: PROBE_REQUEST_PROPERTY,
  },
  required: ['findings', 'persisting', 'summary'],
};

/**
 * The triage report shape for one cycle. A cycle with open prior findings
 * takes the full shape: `persisting` is required, and the brief lists the ids
 * it may hold. A cycle with none takes a shape with no `persisting` field at
 * all, because a mandatory list with nothing to put in it is a field the seat
 * fills by invention. The schema validator refuses the extra key in session,
 * so a seat that sends it anyway is corrected before any check reads the
 * report.
 * @param {object[]} priorOpen the findings still open from earlier cycles
 */
export function triageSchema(priorOpen) {
  if (priorOpen.length > 0) return TRIAGE_SCHEMA;
  const { persisting, ...properties } = TRIAGE_SCHEMA.properties;
  return {
    ...TRIAGE_SCHEMA,
    properties,
    required: TRIAGE_SCHEMA.required.filter((key) => key !== 'persisting'),
  };
}

// -- implementation / fix (seat) ---------------------------------------------

function implementationHandler(mode) {
  return async function implementation(ctx) {
    const base = await verdictBase(ctx, mode);
    if (base.fail) return base.fail;
    const events = runEvents(ctx);
    if (events.some((e) => e.event === 'implementation-committed')) return { next: 'verdict' };
    const baseSha = await headSha(base.worktree);
    // The capture gate holds the structural test-edit guarantee: the frozen
    // suite is restored from its sha before the tree is committed or judged.
    const { fail, dropped } = await devSeatWithCapture(ctx, base, mode, {
      seat: 'dev',
      buildRole: (brief) => (mode === 'story' ? devRole(base, brief) : fixRole(base, brief)),
      suiteSha: base.suiteSha,
    });
    if (fail) return fail;
    const sha = await commitAll(base.worktree, `implement: ${ctx.runId}`);
    ctx.store.append('implementation-committed', {
      actor: ACTOR,
      pass: 1,
      phase: 'initial',
      baseSha,
      sha,
      // What the capture took back rides the commit record: this commit is
      // not the tree the seat left, and every later reader must know that
      // from the record rather than from a re-discovered red (ADR-0017).
      ...(dropped.length > 0 && { dropped }),
    });
    return { next: 'verdict' };
  };
}

// -- verdict (loop) ----------------------------------------------------------

function verdictHandler(mode, nextStage) {
  return async function verdict(ctx) {
    const base = await verdictBase(ctx, mode);
    if (base.fail) return base.fail;
    // The entry reads the ledger before it runs a layer. A stop catches this
    // stage inside a dev seat as easily as between two of them, and the seat
    // is where the hours are: what the stop left is a tree with no
    // implementation of the step that was running on it, and a loop that
    // reads its stamps alone would answer that with a spectrum over the
    // untouched tree. So the step the stop interrupted is dispatched again,
    // once, before anything is judged (ADR-0070).
    const resumed = await resumeInterrupted(ctx, base, mode);
    if (resumed) return resumed;
    for (;;) {
      const events = runEvents(ctx);
      const renders = events.filter((e) => e.event === 'verdict-rendered');
      const last = renders[renders.length - 1];
      const moved =
        !last ||
        events.some(
          (e) =>
            e.seq > last.seq &&
            (e.event === 'implementation-committed' ||
              e.event === 're-freeze' ||
              e.event === 'operational-fix' ||
              // The update stage merged the default branch into the tree and
              // handed it back. The render behind it judged a tree that no
              // longer exists, and the whole point of that update is that the
              // verdict certifies the tree that lands (ADR-0033).
              (e.event === 'pre-verdict-update' && e.ran === true)),
        );
      // A moved tree earns a cycle — unless the ladder still owes this render
      // the re-freeze it began. The ladder acts in arms, and an arm that parks
      // leaves the arms behind it unrun while the arms in front of it have
      // already stamped. Reading the stamp alone, the loop would start a fresh
      // cycle over the unamended suite, render the same finding, and re-park
      // the same question forever: the answer would never reach the suite it
      // was about. So the owed re-freeze wins, the ladder re-enters where it
      // stopped, and the cycle follows the amendment it was waiting for.
      const needCycle = moved && !refreezeOwed(events, renders, last, mode);
      if (needCycle) {
        const outcome = await runCycle(ctx, base, mode, { cycle: renders.length + 1 });
        if (outcome.directive) return outcome.directive;
        continue;
      }
      if (last.verdict === 'green') return { next: nextStage };
      const directive = await ladder(ctx, base, mode, { events, renders, last, nextStage });
      if (directive) return directive;
    }
  };
}

// -- what a stop left half done ----------------------------------------------

/** The stamps that bound a step of the ladder. */
const STEP_BOUNDARIES = new Set(['fresh-pass', 'repair-round', 'verdict-rendered']);

/**
 * The step of the ladder that never finished, read from the ledger alone, or
 * null when the stage owes no step.
 *
 * Two shapes say a step is owed, and neither one asks how the step ended.
 *
 * A `fresh-pass` stamp with no `implementation-committed` behind it is a pass
 * whose tree was reset and never implemented: the stamp is the last thing the
 * pass wrote, and the only tree under it is the one the pass was born on.
 *
 * A `repair-dev` seat spawned since the last render with no
 * `implementation-committed` behind it is a repair round that never reached
 * its own stamp. What ended that session is not asked, because the endings do
 * not all leave a record: a stop with the child alive stamps `seat-terminated`
 * `daemon-stopped`, a stop while the seat stood in a wait leaves a
 * `waiting-ended` and no termination at all, a stop while that wait stood at
 * the hold barrier leaves a wait that reads as elapsed, and a crash leaves
 * nothing. A rule keyed on any of those records would answer three of the four
 * and send the fourth into a cycle over a tree nobody implemented. A round
 * that ended in a seat-failure park is included and costs nothing: the answer
 * to that park re-dispatches the same round the ladder would.
 *
 * A `dev` seat of this stage belongs to a fresh pass, which stamps before it
 * spawns, so the first shape answers it and there is no second rule for it.
 * `waiting` pairs between a `fresh-pass` and the dev report are stepped over:
 * the scans read the stamps that bound a step, and a wait is none of them.
 * @param {object[]} events the run's ledger, in order
 */
export function interruptedStep(events) {
  const reversed = [...events].reverse();
  const last = reversed.find((e) => e.event === 'verdict-rendered');
  if (!last) return null;
  const committedAfter = (seq) =>
    events.some((e) => e.event === 'implementation-committed' && e.seq > seq);
  const bound = reversed.find((e) => STEP_BOUNDARIES.has(e.event));
  if (bound.event === 'fresh-pass' && !committedAfter(bound.seq)) {
    return { kind: 'fresh-pass', stamp: bound };
  }
  const spawn = reversed.find(
    (e) => e.event === 'seat-spawned' && e.seat === 'repair-dev' && e.seq > last.seq,
  );
  if (!spawn || committedAfter(spawn.seq)) return null;
  return { kind: 'repair-round' };
}

/**
 * Dispatches the interrupted step again, with the open set the render it acts
 * on left. Nothing else of the ladder re-runs: the arms in front of this step
 * stamped before the stop and their records are what the ladder reads.
 *
 * The tree is put back to its last commit first. A seat that died mid-edit
 * leaves whatever it had written, the capture restores the test paths and
 * nothing else, and `git add -A` behind the next seat would commit both halves
 * as one implementation. The commit under the run at this point is the tree
 * the step was dispatched over — the pass's own birth commit for a fresh pass,
 * the render's tree for a repair round — so the reset is what makes the second
 * dispatch the same dispatch as the first (ADR-0070). The run cache is
 * excluded from git and survives it (ADR-0048).
 *
 * The `fresh-pass` stamp is already on the ledger, so the reset and the suite
 * carry inside `freshPass` are skipped and the pass is not born a second time.
 */
async function resumeInterrupted(ctx, base, mode) {
  const events = runEvents(ctx);
  const step = interruptedStep(events);
  if (!step) return null;
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  const last = renders[renders.length - 1];
  const { code, suiteDefects } = openSets(events, last, mode);
  await resetHard(base.worktree, await headSha(base.worktree));
  if (step.kind === 'fresh-pass') {
    const outcome = await freshPass(ctx, base, mode, {
      newPass: step.stamp.pass,
      trigger: step.stamp.trigger,
      open: [...code, ...suiteDefects],
      last,
    });
    return outcome.fail ?? null;
  }
  const pass = currentPass(events);
  const rounds = events.filter((e) => e.event === 'repair-round' && e.pass === pass).length;
  const outcome = await repairRound(ctx, base, mode, {
    pass,
    round: rounds + 1,
    open: code,
    record: readJson(last.record),
  });
  return outcome.fail ?? null;
}

/**
 * The open findings of a render, split into the sets the ladder routes on.
 * One derivation, because the ladder and the resume above must brief a seat
 * with the same set: a step dispatched again over a narrower set would repair
 * less than the step the stop interrupted.
 */
function openSets(events, last, mode) {
  const index = findingIndex(events);
  const open = last.open.map((id) => index.get(id)).filter(Boolean);
  const suiteDefects = mode === 'story' ? open.filter((f) => f.class === 'suite-defect') : [];
  return {
    open,
    suiteDefects,
    intent: suiteDefects.filter((f) => f.depth === 'intent'),
    ops: open.filter((f) => f.class === 'env' || f.class === 'harness'),
    code: open.filter(
      (f) =>
        f.confirmed === true ||
        f.class === 'code-defect' ||
        (mode !== 'story' && f.class === 'suite-defect'),
    ),
  };
}

// -- one verdict cycle -------------------------------------------------------

async function runCycle(ctx, base, mode, { cycle }) {
  const startEvents = runEvents(ctx);
  const suiteSha = mode === 'story' ? currentSuiteSha(startEvents) : null;
  const pass = currentPass(startEvents);
  const impl = lastImplementation(startEvents);
  // What the capture took back before this tree was committed. Every seat this
  // cycle briefs is reading a tree the take-back already changed.
  const dropped = impl?.dropped ?? [];
  if (mode === 'story') {
    await restorePaths(base.worktree, restoreAnchor(startEvents), base.testPaths, {
      except: base.frozenExclusions,
    });
  }
  const sha = await headSha(base.worktree);
  const gates = {
    layers: base.layers,
    commands: base.commands,
    cwd: base.worktree,
    env: base.env,
    // What each layer needs of the host, so a red the host explains is
    // attributed by the runner rather than guessed at by a seat (ADR-0042).
    credentials: base.config.credentials ?? [],
    // The layers this project lets hold the machine together. Absent is the
    // strict sequence, and arming, tuning and reverting the concurrency are
    // all edits of this one config field (ADR-0047).
    groups: configuredGroups(base.config),
    // What the flake filter's re-run asks for. `whole` returns it to a whole
    // re-run of the layer, which is what every project ran before the key
    // existed; absent is the decision, which is that a re-run asks only what
    // failed.
    flakeRerun: base.config?.gates?.flakeRerun ?? 'narrowed',
    cycle,
    sha,
  };
  // What this cycle runs, and what it carries (ADR-0022) — then, inside each
  // layer it does run, which parts of it the diff since that layer's standing
  // result could have reached (ADR-0046).
  const plan = cyclePlan(startEvents, { cycle, pass, layers: base.layers });
  const parts = await partTargets(base, startEvents, { plan, sha });
  let spectrum = await runSpectrum(ctx, { ...gates, run: plan.run, prior: plan.prior, parts });
  if (spectrum.error) return { directive: gateCommandError(ctx, spectrum.error) };
  let reds = persistentReds(spectrum.results);
  // The parts a ship went out without, where an operator took that trade. They
  // are red and they do not block: the record carries them and the daemon
  // settles the debt when the service comes back (ADR-0069).
  let deferred = [];
  // A red whose cause is outside the tree never reaches a seat. The ladder,
  // the external wait and the deferred trade all live here, in front of
  // triage, because no repair fixes a dropped connection and a fresh pass
  // discards a sound implementation over one. A CI-source verdict never
  // reaches this function at all: the ship lane renders those, and a red
  // GitHub check has its own re-run in the forge.
  const outside = async () => {
    if (reds.length === 0) return null;
    const read = await outsideTheTree(ctx, base, { cycle, sha, gates, spectrum, reds });
    if (read.directive) return read.directive;
    if (read.spectrum) spectrum = read.spectrum;
    if (read.reds) reds = read.reds;
    if (read.deferred?.length > 0) deferred = [...deferred, ...read.deferred];
    return null;
  };
  const outsideDirective = await outside();
  if (outsideDirective) return { directive: outsideDirective };

  const events = runEvents(ctx);
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  const prevRender = renders[renders.length - 1];
  const index = findingIndex(events);
  const priorOpen =
    prevRender && prevRender.pass === pass
      ? prevRender.open.map((id) => index.get(id)).filter(Boolean)
      : [];
  const triagePrior = priorOpen.filter((f) => f.source === 'triage');

  // Verdict triage fires only when persistent reds exist. Findings from a
  // green spectrum resolve mechanically: their evidence is gone.
  let triageOpen = [];
  if (reds.length > 0) {
    const triaged = await triageStep(ctx, base, { cycle, reds, priorOpen: triagePrior, dropped });
    if (triaged.fail) return { directive: triaged.fail };
    triageOpen = triaged.open;
  }

  // Judgment review: the Fury fan-out once per implementation pass; the
  // generalist seat over the repair diff on repair cycles; no judgment seats
  // after a re-freeze or an operational fix alone — the tree did not change.
  const newTree = !prevRender || prevRender.pass !== pass;
  const repaired =
    prevRender && eventsAfter(events, prevRender.seq).some((e) => e.event === 'repair-round');
  const cardRuled = prevRender
    ? eventsAfter(events, prevRender.seq).find(
        (e) => e.event === 're-freeze' && e.ruling?.source === 'card' && e.baseSha,
      )
    : null;
  const priorConfirmed = priorOpen.filter((f) => f.confirmed);
  let reviewOpen = priorConfirmed;
  // What the judgment seats of this cycle were actually given. The whole diff
  // is written to the run's own directory before any seat spawns, and the brief
  // names it; the seats read the file. A diff the read cap cut is a diff whose
  // end is nowhere, which is a seat judging part of the work, and the ledger
  // carries the word for it: on the findings it raised, and on the cycle
  // record, which is stamped even when the round came out clean (ADR-0066).
  let diffTruncated = false;
  const readDiff = async (from, to) => {
    const diff = await reviewDiff(base.worktree, from, to, {
      path: reviewDiffPath(ctx.paths, ctx.runId, `diff-c${cycle}`),
      exclude: base.config?.review?.excludeFromDiff,
      excerptChars: base.config?.review?.excerptChars,
    });
    if (diff.truncated) diffTruncated = true;
    return diff;
  };
  if (newTree) {
    const diff = await readDiff(impl.baseSha, impl.sha);
    // Name-only, and so the whole file set: what a panel seat is shown and what
    // decides which seats sit are different questions (ADR-0066).
    const diffFiles = await changedInRange(base.worktree, impl.baseSha, impl.sha);
    const round =
      mode === 'story'
        ? await furyRound(ctx, base, { cycle, diff, diffFiles })
        : await generalistReview(ctx, base, { cycle, diff, priorConfirmed: [] });
    if (round.fail) return { directive: round.fail };
    reviewOpen = round.confirmed;
  } else if (repaired) {
    const diff = await readDiff(impl.baseSha, impl.sha);
    const round = await generalistReview(ctx, base, { cycle, diff, priorConfirmed });
    if (round.fail) return { directive: round.fail };
    reviewOpen = [
      ...priorConfirmed.filter((f) => !round.resolved.includes(f.id)),
      ...round.confirmed,
    ];
  } else if (cardRuled) {
    // A re-freeze behind a human ruling was judged by the human who ruled. A
    // re-freeze on the card's authority was judged by nobody: the quote check
    // proves the words are in the card, and whether the words reach the
    // assertion that changed is a judgment. So the panel reads that amendment's
    // own diff — one seat, only where nobody was asked (ADR-0044).
    const diff = await readDiff(cardRuled.baseSha, cardRuled.sha);
    const round = await generalistReview(ctx, base, { cycle, diff, priorConfirmed });
    if (round.fail) return { directive: round.fail };
    reviewOpen = [
      ...priorConfirmed.filter((f) => !round.resolved.includes(f.id)),
      ...round.confirmed,
    ];
  }

  let open = [...triageOpen, ...reviewOpen];

  // The confirmation sweep: a targeted cycle proves nothing about the layers
  // it carried, so no green verdict rests on them. A clean targeted cycle
  // therefore runs everything it has not run yet, at this sha, before the
  // record calls the tree green — every layer it carried whole, and, inside a
  // layer it narrowed, the parts it carried. What it already ran at this sha
  // it keeps. A red the sweep turns up is a regression an edit left in an area
  // no red pointed at, and it enters triage exactly like a first-cycle red.
  if (plan.sweep === 'targeted' && reds.length === 0 && open.length === 0) {
    const confirmed = await runSpectrum(ctx, { ...gates, confirmation: true });
    if (confirmed.error) return { directive: gateCommandError(ctx, confirmed.error) };
    spectrum = confirmed;
    reds = persistentReds(confirmed.results);
    // A sweep red is a red like any other, and a dropped connection is no more
    // the tree's fault at the confirmation than it was at the cycle.
    const sweptDirective = await outside();
    if (sweptDirective) return { directive: sweptDirective };
    if (reds.length > 0) {
      const triaged = await triageStep(ctx, base, {
        cycle,
        reds,
        priorOpen: triagePrior,
        dropped,
      });
      if (triaged.fail) return { directive: triaged.fail };
      open = [...triaged.open, ...reviewOpen];
    }
  }

  const openIds = open.map((f) => f.id);
  const resolvedNow = priorOpen.filter((f) => !openIds.includes(f.id));
  const verdict = reds.length === 0 && open.length === 0 ? 'green' : 'red';
  const confirmation = runEvents(ctx).some(
    (e) => e.event === 'layer-result' && e.cycle === cycle && e.confirmation,
  );
  const supersedes = authorizedSupersedes(runEvents(ctx)).map((e) => ({
    test: e.test,
    assertion: e.assertion,
    cardQuote: e.cardQuote,
    clause: e.clause,
    site: e.site,
  }));
  // What this cycle did not run, as a number. The record already says which
  // parts carried; the share is what a tripwire can watch, and a carry that
  // decays with nothing red is the one failure of this mechanism that nothing
  // else detects (ADR-0058). Absent for a cycle that recorded no part.
  const tally = carryTally(spectrum.results);
  // What the confirmation sweep executed of the layers it narrowed, and what it
  // stood on instead. A sweep that re-ran every part of every layer it touched
  // reports its whole part count as `ran` and nought as `kept`, which is the
  // reading that says this narrowing has stopped working (ADR-0046).
  const swept = confirmation ? confirmationTally(spectrum.results) : null;
  const record = {
    runId: ctx.runId,
    cycle,
    pass,
    sha,
    ...(suiteSha && { suiteSha }),
    sweep: plan.sweep,
    ...(tally ?? {}),
    ...(confirmation && { confirmation: true }),
    ...(swept && { confirmationParts: swept }),
    // The capture took these paths back before this tree was committed, so a
    // red on the surface they cover is explained, not mysterious.
    ...(dropped.length > 0 && { dropped }),
    // The record is a summary: the output stays in the ledger. What it does
    // carry is every part a layer that runs in parts reported — so a red
    // inside a sequence reads here as the part that failed and not as the
    // layer alone, and a part this cycle did not run says which cycle earned
    // its green. A carried green is evidence a reader can see (ADR-0046).
    spectrum: spectrum.results.map(({ output, parts: layerParts, ...r }) => ({
      ...r,
      ...(layerParts?.length > 0 && {
        parts: layerParts.map((part) => partSummary(part, r.mode)),
      }),
    })),
    flakes: runEvents(ctx)
      .filter((e) => e.event === 'flake' && e.cycle === cycle)
      .map((e) => e.layer),
    findings: [
      ...open.map((f) => ({ ...f, status: 'open' })),
      ...resolvedNow.map((f) => ({ ...f, status: 'resolved' })),
    ],
    open: openIds,
    // Every supersede this run has taken on the card's authority, with the card
    // line each one rests on. A reviewer reads the record and the card side by
    // side; nobody has to reconstruct which frozen test was amended and why
    // (ADR-0044).
    ...(supersedes.length > 0 && { supersedes }),
    // The proofs this verdict is going out without, beside the parts it
    // carried. A carry is a green earned at another sha; this is a red nobody
    // could turn green because the service it needs is down, and an operator
    // said the ship may go without it. The fast path refuses to carry a
    // certification that holds one (ADR-0069).
    ...(deferred.length > 0 && { deferred }),
    verdict,
  };
  const recordPath = join(ctx.paths.runs, ctx.runId, `verdict-${cycle}.json`);
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  ctx.store.append('verdict-rendered', {
    actor: ACTOR,
    cycle,
    pass,
    sha,
    ...(suiteSha && { suiteSha }),
    sweep: plan.sweep,
    // The share rides the event as well as the record, because the reading is
    // taken from the ledgers and a metric that had to open a record file per
    // cycle would be reading somebody else's lifecycle (ADR-0058).
    ...(tally ?? {}),
    ...(confirmation && { confirmation: true }),
    ...(swept && { confirmationParts: swept }),
    ...(dropped.length > 0 && { dropped }),
    ...(diffTruncated && { diffTruncated: true }),
    ...(deferred.length > 0 && { deferred }),
    verdict,
    open: openIds,
    record: recordPath,
  });
  return {};
}

/**
 * The part plan of every layer this cycle runs: which parts of it the diff
 * since that layer's standing result could have reached, which greens it
 * carries instead (ADR-0046), and why every part that runs is running
 * (ADR-0058). Null for a cycle that plans no layer.
 *
 * Every clause here re-runs on doubt. A cycle that runs the full spectrum
 * plans no layer. A range git cannot answer, a result with no sha, a result
 * older than the last re-freeze: each of the three drops the layer out of the
 * map, and the layer then runs whole for a reason that is not about its parts,
 * so no part of it is given a word it did not earn.
 *
 * A layer whose standing result holds no part table stays IN the map. Its
 * plan narrows nothing and carries nothing, and the record it produces is the
 * one that says so: every part the command opened is a part the standing
 * result did not hold, and the result names each of them `no-record`.
 *
 * A re-freeze invalidates every carry because it moves the suite the parts
 * were judged against: a part's green is a statement about a pair of shas,
 * and the amendment changed the half this derivation cannot see in a diff of
 * the candidate tree.
 */
export async function partTargets(base, events, { plan, sha }) {
  if (plan.sweep !== 'targeted' || base.config?.gates?.partTargeting === false) return null;
  // Ground the project states no suite of it reads. It leaves every diff this
  // derivation reads, before anything is attributed to a part (ADR-0059).
  const groundless = base.config?.gates?.groundlessPaths ?? [];
  const refrozen = events.filter((e) => e.event === 're-freeze').pop()?.seq ?? -1;
  const diffs = new Map();
  const targets = new Map();
  for (const layer of base.layers) {
    if (!plan.run?.has(layer.name)) continue;
    const prior = plan.prior?.get(layer.name);
    if (!prior || !prior.sha || prior.seq < refrozen) continue;
    if (!diffs.has(prior.sha)) {
      diffs.set(
        prior.sha,
        await changedInRange(base.worktree, prior.sha, sha).catch(() => null),
      );
    }
    const changed = diffs.get(prior.sha);
    if (changed === null) continue;
    targets.set(layer.name, partPlan(prior, changed, { groundless }));
  }
  return targets.size > 0 ? targets : null;
}

/**
 * One part, as the verdict record states it: what it decided, whether this
 * cycle ran it, and — where the part itself was carried — the cycle whose
 * execution earned the green. A layer the cycle carried whole carried every
 * part in it, whatever the part's own record says, and the layer's line
 * states where that one came from.
 *
 * A part this cycle ran also states why (ADR-0058). A carried part states
 * none: it did not run, and a reason on it would read as a reason it did.
 */
function partSummary(part, layerMode) {
  const carried = layerMode === 'carried' || part.carriedFrom !== undefined;
  return {
    name: part.name,
    ...(part.status && { status: part.status }),
    mode: carried ? 'carried' : 'run',
    ...(part.carriedFrom !== undefined && { carriedFrom: part.carriedFrom }),
    ...(!carried && part.reason !== undefined && { reason: part.reason }),
  };
}

/** A gate command that could not run at all: an environment defect. */
function gateCommandError(ctx, error) {
  return commandError(
    ctx,
    'gate-command-error',
    `A Tier-1 gate command could not run: ${error}\n` +
      'Repair the environment, then answer "retry" for one more spectrum, or ' +
      '"abandon" to close the run.',
    { error },
  );
}

// -- verdict triage (seat) ---------------------------------------------------

/**
 * The shared four-class triage over persistent reds. The ship step calls it
 * with CI checks as the red layers (`ci:<check>`); the routes stay the same.
 *
 * The seat may spend replay rounds before it reports: each one re-runs a
 * Tier-1 layer of this run and briefs the seat again with the output, which is
 * how a credential-dependent red becomes reproducible to a seat that holds no
 * credential (ADR-0042). A round is a fresh invocation under its own label, so
 * the resume reads the round it stopped in.
 */
export async function triageStep(ctx, base, { cycle, reds, priorOpen, dropped = [] }) {
  const events = runEvents(ctx);
  const stamped = events.filter(
    (e) => e.event === 'finding' && e.cycle === cycle && e.source === 'triage',
  );
  const spec = {
    seat: 'verdict-triage',
    cycle,
    label: `verdict-triage-c${cycle}`,
    base,
  };
  // A retry the human bought re-invokes the seat: the stamped report, where
  // one exists, is the one the checks refused, so replaying it buys nothing.
  const retrying = boughtRetry(events, 'verdict-triage');
  if (stamped.length > 0) {
    // Resumed after the stamp: rebuild, from the round the seat ended on.
    const report = readJson(runReportPath(ctx.paths, ctx.runId, finalReplayLabel(ctx, spec))) ?? {};
    const persisting = new Set(report.persisting ?? []);
    return {
      open: [
        ...priorOpen.filter((f) => persisting.has(f.id)),
        ...stamped.map((e) => findingFromEvent(e)),
      ],
    };
  }
  const redLayers = reds.map((r) => r.layer);
  const takeBacks = recordedTakeBacks(events);
  // What the harness already read as a cause outside the tree, and the ladder
  // it already climbed against it. The seat is told, and the checks below
  // refuse a code-class finding whose only evidence is one of these
  // signatures (ADR-0069).
  const transient = transientRead(events, cycle);
  const tier1 = (base.config?.gates?.tier1 ?? []).map((layer) => layer.name);
  const { report, fail } = await withReplayRounds(ctx, spec, ({ label, replays, budget }) => {
    // Resume by report, per round: a round whose seat already answered is
    // never bought twice, and the loop carries on from the answer it left.
    if (!retrying) {
      const prior = triageReportAt(ctx, label);
      if (prior) return { report: prior };
    }
    return seatWithChecks(ctx, {
      seat: 'verdict-triage',
      label,
      schema: triageSchema(priorOpen),
      cwd: base.worktree,
      env: base.env,
      constitution: base.constitution,
      buildRole: (brief) =>
        triageRole(
          base,
          reds,
          priorOpen,
          brief,
          dropped,
          takeBacks.recaptured,
          { replays, budget, layers: tier1 },
          transient,
        ),
      // A report that asks for a probe it can still have is a request and not
      // a verdict, so the coverage rules do not judge it. Past the round
      // budget the report is the verdict whatever it asks for, and they are
      // back.
      checks: (r) =>
        asksForProbe(r, budget)
          ? []
          : triageChecks(r, {
              redLayers,
              priorOpen,
              transient,
              // The project's own wording for a cause outside the tree counts
              // here exactly as the closed set does: a finding that cites one
              // of them and nothing else is a finding about the world.
              patterns: base.config?.gates?.transientPatterns ?? [],
            }),
    });
  });
  if (fail) return { fail };
  let nextId = 1 + runEvents(ctx).filter((e) => e.event === 'finding').length;
  const fresh = [];
  for (const f of report.findings) {
    // The card claim rides the finding to the ladder, which is where the checks
    // run and the authorization is either stamped or refused (ADR-0044).
    const claim = supersedeClaim(f);
    const finding = {
      id: `F${nextId++}`,
      source: 'triage',
      class: f.class,
      ...(f.depth && { depth: f.depth }),
      layers: f.layers,
      summary: f.summary,
      evidence: f.evidence,
      ...(claim && { supersede: claim }),
    };
    // A finding about the artifacts the capture classed re-capturable is a
    // finding about a handled case. The capture made that call at the revert,
    // and this step honors it rather than re-judging the same paths.
    const recapturable =
      f.class === 'harness' &&
      namesOnlyRecapturable(`${f.summary}\n${f.evidence}`, takeBacks);
    ctx.store.append('finding', {
      actor: ACTOR,
      cycle,
      ...finding,
      summary: gist(finding.summary),
      evidence: gist(finding.evidence),
      ...(recapturable && { recapturable: true, note: RECAPTURE_FINDING_NOTE }),
    });
    if (f.class === 'harness' && !recapturable) {
      // A harness finding is a gate-integrity defect: zero-tolerance, loud.
      ctx.store.append('gate-integrity', {
        actor: ACTOR,
        findingId: finding.id,
        detail: gist(f.summary),
        gist: gist(`harness defect: ${f.summary}`),
      });
    }
    fresh.push(finding);
  }
  const persisting = new Set(report.persisting ?? []);
  return { open: [...priorOpen.filter((f) => persisting.has(f.id)), ...fresh] };
}

/**
 * The report of one triage round the seat already wrote, or null. The ledger
 * decides — a report file with no `seat-report` behind it is a file the
 * contract loop refused, and reading it would take the answer the checks threw
 * away.
 */
function triageReportAt(ctx, label) {
  const path = runReportPath(ctx.paths, ctx.runId, label);
  const reported = runEvents(ctx).some(
    (e) => e.event === 'seat-report' && e.seat === 'verdict-triage' && e.path === path,
  );
  return reported ? readJson(path) : null;
}

// Why a finding about a re-capturable artifact carries no loud stamp, said on
// the finding, so a reader who goes looking for the gate-integrity record that
// every other harness finding has finds the reason there is none.
const RECAPTURE_FINDING_NOTE =
  'This finding names only paths the capture classed re-capturable, which the ' +
  "verdict's re-freeze re-takes. The class was decided at the revert and is " +
  'honored here: the take-back is a record and not an open item, so no ' +
  'gate-integrity defect is stamped for it.';

/**
 * What this run's captures took back, in the two classes they were recorded
 * under. Read from the run's own ledger rather than carried in an argument, so
 * a step that resumed mid-cycle reads what the capture decided instead of what
 * its caller happened to still hold.
 *
 * A ledger written before the quiet class existed carries every take-back in
 * `diff-policy-violation`, and this reads all of them as held — which is the
 * loud answer, and the safe direction for an old record to fall.
 */
function recordedTakeBacks(events) {
  const recaptured = [];
  const held = [];
  for (const e of events ?? []) {
    if (e.event === 'diff-policy-recapture') {
      for (const r of e.recaptured ?? []) if (typeof r?.path === 'string') recaptured.push(r);
    } else if (e.event === 'diff-policy-violation') {
      for (const path of e.dropped ?? []) if (typeof path === 'string') held.push(path);
    }
  }
  return { recaptured, held };
}

/**
 * The deterministic rules a triage report meets. Every defect line states the
 * rule beside the entry that broke it, so the corrective brief says what to
 * write and not only what was refused.
 */
function triageChecks(report, { redLayers, priorOpen, transient = null, patterns = [] }) {
  const defects = [];
  // The harness already read these reds as a cause outside the tree and spent
  // a ladder of re-runs against them. A code-defect finding whose evidence is
  // one of those signatures and nothing else sends a repair seat to rewrite
  // working code, which is the failure this whole route exists to end
  // (ADR-0069). An assertion or a compile error beside the signature is the
  // tree's own answer and the finding stands.
  for (const f of transient === null ? [] : report.findings) {
    if (f.class !== 'code-defect') continue;
    const evidence = `${f.summary}\n${f.evidence}`;
    if (!showsTransient(evidence, patterns) || showsCode(evidence)) continue;
    defects.push(
      `the code-defect finding "${f.summary}" cites only a signature of a cause outside the ` +
        `tree (${transient.signatures.join(', ')}); the harness re-ran these files after ` +
        '1, 5 and 15 minutes and they failed the same way. Class it env, or cite an ' +
        'assertion failure or a compile error from the tree itself.',
    );
  }
  const priorIds = new Set(priorOpen.map((f) => f.id));
  const persisting = report.persisting ?? [];
  if (priorOpen.length === 0 && report.persisting !== undefined) {
    defects.push(
      'the report carries a "persisting" field, and this cycle has no prior findings; ' +
        'remove the field and report every red as a new finding.',
    );
  }
  for (const id of persisting) {
    if (!priorIds.has(id)) {
      defects.push(
        `persisting id ${id} is not an open prior finding; "persisting" takes only ids from ` +
          `the open set, which is [${[...priorIds].join(', ')}].`,
      );
    }
  }
  const covered = new Set([
    ...report.findings.flatMap((f) => f.layers),
    ...priorOpen.filter((f) => persisting.includes(f.id)).flatMap((f) => f.layers ?? []),
  ]);
  for (const layer of redLayers) {
    if (!covered.has(layer)) {
      defects.push(
        `persistent red layer ${layer} is covered by no finding; every red layer below is ` +
          'named in the "layers" of a new finding or of a persisting prior finding.',
      );
    }
  }
  for (const f of report.findings) {
    for (const layer of f.layers) {
      if (!redLayers.includes(layer)) {
        defects.push(
          `the finding "${f.summary}" names the layer ${layer}, which is not a persistent ` +
            `red; a finding names only red layers, which are [${redLayers.join(', ')}].`,
        );
      }
    }
    if (f.class === 'suite-defect' && !f.depth) {
      defects.push(
        `the suite-defect finding "${f.summary}" carries no depth; a suite-defect finding ` +
          'takes "depth": "test", "spec" or "intent".',
      );
    }
  }
  return defects;
}

// -- a red from outside the tree ---------------------------------------------

/** What an operator answers at the external gate to let the ship go on. */
export const DEFER_PROOF = 'defer-proof';

/**
 * The wait routes in front of triage (ADR-0069).
 *
 * Three things happen here and they are one decision: a red is read against
 * the closed signature set, a red the read recognises climbs the layer ladder,
 * and a red that survives the ladder while naming a declared service waits for
 * that service instead of asking anybody. Every one of them is in front of the
 * seat because no repair fixes a cause outside the tree, and a fresh pass
 * discards a sound implementation over one.
 *
 * A red the read does not recognise is returned untouched: it takes triage
 * exactly as it did before, which is the safe direction.
 *
 * @returns {Promise<{spectrum?: object, reds?: Array<object>,
 *   deferred?: Array<object>, directive?: object}>}
 */
async function outsideTheTree(ctx, base, { cycle, sha, gates, spectrum, reds }) {
  const events = runEvents(ctx);
  // The trade an operator already took at the external gate. It is read first,
  // because those parts are red and are not the tree's to answer any more.
  const debt = deferredProof(ctx, events, { cycle, reds });
  if (debt) return { reds: debt.reds, deferred: debt.deferred };
  const patterns = base.config?.gates?.transientPatterns ?? [];
  let read = readTransient(reds, { patterns });
  if (!read.ok) return {};
  const since = ladderSince(events);
  // One reading per layer per ladder. A run that comes back here on an
  // answered retry reads the red again and climbs a fresh ladder, and a second
  // copy of the same stamp would say the harness had recognised it twice.
  const already = new Set(
    events
      .filter((e) => e.event === 'layer-transient' && e.cycle === cycle && e.seq > since)
      .map((e) => e.layer),
  );
  for (const layer of read.layers) {
    if (already.has(layer.layer)) continue;
    ctx.store.append('layer-transient', {
      actor: ACTOR,
      cycle,
      layer: layer.layer,
      parts: layer.parts,
      files: layer.files,
      signatures: layer.signatures,
    });
  }
  let current = spectrum;
  let open = reds;
  for (;;) {
    const attempt = waitAttempt(runEvents(ctx), 'layer', { since });
    const step = ladderStep(LAYER_LADDER, attempt);
    if (step === null) break;
    await waitFor(waitCtx(ctx), {
      kind: 'layer',
      reason: read.signatures.join(', '),
      ms: step,
      attempt,
      detail: { layers: read.layers.map((l) => l.layer), files: read.files.length },
    });
    const again = await rerunLayers(ctx, {
      ...gates,
      layers: layerDefs(base, read.layers.map((l) => l.layer)),
      trigger: 'layer-ladder',
    });
    if (again.error) return { directive: gateCommandError(ctx, again.error) };
    current = mergeResults(current, again.results);
    open = persistentReds(current.results);
    if (open.length === 0) return { spectrum: current, reds: [] };
    read = readTransient(open, { patterns });
    // A red that came back showing the tree's own signature is the tree's, and
    // the ladder stops the moment it says so.
    if (!read.ok) return { spectrum: current, reds: open };
  }
  // The ladder is spent. A red that names a service the project declared a
  // credential for is that service being down, and the wait for it is longer
  // than any ladder (ADR-0069).
  const host = declaredHost(base, open, read);
  if (!host) return { spectrum: current, reds: open };
  return externalWait(ctx, base, { cycle, sha, gates, spectrum: current, reds: open, read, host });
}

/**
 * The external wait: the run frees its slot, the service's own probe is asked
 * every ten minutes for a day, and nothing is stamped for an answer of no —
 * a service that is down says no a hundred and forty-four times, and a stamp
 * per poll would bury the run's own ledger.
 *
 * At an hour the instance says so, loudly and once: nobody is being asked
 * anything, and a human who wants to know a service is down should not have to
 * read a run ledger to find out. A green ends the wait, re-acquires the slot
 * and re-runs the red parts narrowed to their files. A day of no ends it at
 * the gate, with the whole history in the question.
 */
async function externalWait(ctx, base, { cycle, sha, gates, spectrum, reds, read, host }) {
  const events = runEvents(ctx);
  const since = ladderSince(events);
  const credential = host.credential;
  const layers = read.layers.map((l) => l.layer);
  const attempt = waitAttempt(events, 'external', { since });
  // One wait per ladder, and never a second day of it. A daemon restart closes
  // the open span, re-enters the stage and finds the ladder spent, so without
  // this the run would open a fresh twenty-four hours at every restart and
  // reach nobody. The second attempt is the gate (ADR-0069).
  if (attempt > EXTERNAL_ATTEMPTS) {
    return {
      directive: externalGate(ctx, base, {
        host,
        read,
        history: externalHistory(events, since),
      }),
    };
  }
  // The loud record this service already has open, read off the instance
  // ledger rather than held in this call: the call does not survive a restart
  // and the record does, and a second record for one outage is the thing a
  // reader least needs.
  let outage = openOutage(ctx, credential.name);
  const wait = await waitFor(waitCtx(ctx), {
    kind: 'external',
    reason: `${credential.name} at ${host.host}`,
    ms: EXTERNAL_WAIT_MS,
    attempt,
    // The one wait that gives the slot up. The run may sit here for a day, and
    // a day of a slot is what a park would have cost the project.
    freesSlot: true,
    pollMs: EXTERNAL_POLL_MS,
    detail: { credential: credential.name, host: host.host, layers },
    poll: async ({ spent }) => {
      const answer = await askProbe(base.config, credential, {
        cwd: base.worktree,
        env: base.env,
      });
      if (answer.ok) {
        // The green is stamped, because it is the answer the run acts on.
        ctx.store.append('credential-probe', {
          actor: ACTOR,
          phase: 'external-wait',
          project: ctx.project,
          credential: credential.name,
          variable: credential.env,
          ok: true,
        });
        if (outage !== null) {
          // The record the outage opened is answered by the service coming
          // back, and this is the reader that has that evidence.
          try {
            ctx.instanceStore?.resolve({ actor: ACTOR, resolves: outage, note: 'probe green' });
          } catch {
            // A resolution nobody can pair is not worth failing a wait for.
          }
          outage = null;
        }
        return true;
      }
      if (outage === null && spent >= EXTERNAL_OUTAGE_MS) {
        outage =
          ctx.instanceStore?.append('external-outage', {
            actor: ACTOR,
            project: ctx.project,
            runId: ctx.runId,
            credential: credential.name,
            host: host.host,
            waited: spent,
            gist: `${credential.name} (${host.host}) has refused its probe for an hour`,
          })?.seq ?? null;
      }
      return false;
    },
  });
  if (wait.outcome === 'probe-green') {
    const again = await rerunLayers(ctx, {
      ...gates,
      layers: layerDefs(base, layers),
      trigger: 'external-wait',
    });
    if (again.error) return { directive: gateCommandError(ctx, again.error) };
    const merged = mergeResults(spectrum, again.results);
    return { spectrum: merged, reds: persistentReds(merged.results) };
  }
  return {
    directive: externalGate(ctx, base, {
      host,
      read,
      history: externalHistory(runEvents(ctx), since),
    }),
  };
}

/** How many days a service is waited for before somebody is asked: one. */
const EXTERNAL_ATTEMPTS = 1;

/** The waits this run has spent on a service since the ladder began. */
function externalHistory(events, since) {
  return waitHistory(events, 'external', { since });
}

/**
 * The `external-outage` this project already has open for one credential, or
 * null. Derived from the instance ledger, so a restart finds the record the
 * instance before it opened instead of opening a second one, and the green
 * probe that ends any wait on that service resolves it.
 */
function openOutage(ctx, credential) {
  const events = readEvents(ctx.paths.instanceLedger);
  const resolved = new Set(events.filter((e) => e.event === 'resolved').map((e) => e.resolves));
  const open = events.filter(
    (e) =>
      e.event === 'external-outage' &&
      e.project === ctx.project &&
      e.credential === credential &&
      !resolved.has(e.seq),
  );
  return open.at(-1)?.seq ?? null;
}

/**
 * The gate a service that stayed down past the day raises. It offers the
 * repair every provisioning gate offers, and — only where the project turned
 * `gates.proofDebt` on — the owner's speed-over-residual-safety trade: the
 * ship goes out and the proof is owed.
 */
function externalGate(ctx, base, { host, read, history }) {
  const debt = base.config?.gates?.proofDebt === true;
  const deferred = read.layers.map((l) => ({
    layer: l.layer,
    parts: l.parts,
    files: l.files,
    // The mapping the settle run needs: it asks the default branch for these
    // parts and these files, and a path filter belongs to the part that named
    // it (ADR-0065).
    byPart: l.byPart,
  }));
  const lines = read.layers.map(
    (l) => `- ${l.layer}: ${l.parts.join(', ')} (${l.files.length} file(s)) — ${l.signatures.join(', ')}`,
  );
  return parkDirective('provisioning-gate', {
    options: debt ? [...GATE_FORMS.options, DEFER_PROOF] : [...GATE_FORMS.options],
    text: GATE_FORMS.text,
    question:
      `The ${host.credential.name} service at ${host.host} has refused its own probe for a ` +
      'day, and these layers cannot be proven without it:\n' +
      lines.join('\n') +
      '\nThe harness waited for it and asked nobody:\n' +
      history.map((entry) => waitLine(entry)).join('\n') +
      '\nRepair the service or its credential, then answer "retry" to run these files ' +
      'again.' +
      (debt
        ? `\nAnswer "${DEFER_PROOF}" to ship without this proof: the parts above are recorded ` +
          'as deferred on the verdict, the fast path refuses to carry the certification, and ' +
          'the daemon runs the files against the default branch as soon as the service comes ' +
          'back. A red there is an escape against this ship.'
        : ''),
    detail: {
      external: true,
      credential: host.credential.name,
      host: host.host,
      layers: read.layers.map((l) => l.layer),
      files: read.files,
      deferred,
    },
  });
}

/**
 * The trade an operator took at the external gate, applied. The stamp is
 * written once, from the park's own record and the answer alone, so a restart
 * reads the same debt and never writes a second one.
 * @returns {{reds: Array<object>, deferred: Array<object>}|null}
 */
function deferredProof(ctx, events, { cycle, reds }) {
  const asked = answeredPark(events, 'provisioning-gate');
  if (!asked?.answer || asked.park.detail?.external !== true) return null;
  if (asked.answer.option !== DEFER_PROOF) return null;
  const detail = asked.park.detail;
  const deferred = detail.deferred ?? [];
  const stamped = events.find((e) => e.event === 'proof-deferred' && e.seq > asked.answer.seq);
  // The trade is this cycle's. A later cycle judges a tree somebody changed,
  // and a red there is that tree's answer rather than the service's — so the
  // deferral does not travel, and the debt is recorded once.
  if (stamped && stamped.cycle !== cycle) return null;
  if (!stamped) {
    ctx.store.append('proof-deferred', {
      actor: asked.answer.actor,
      cycle,
      credential: detail.credential,
      host: detail.host,
      parts: deferred,
      files: detail.files ?? [],
      parkSeq: asked.park.seq,
    });
  }
  const names = new Set(detail.layers ?? []);
  return { reds: reds.filter((r) => !names.has(r.layer)), deferred };
}

/**
 * The substrate ladder (ADR-0069): an env finding that survived its
 * operational fix waits and re-runs before anybody is asked. Nine of the
 * fourteen env-class provisioning parks on the ledger were host conditions
 * that were green on a retry hours later, and every one of them cost a human
 * the same word.
 *
 * The probe runs before every step, because a host that refuses its own probe
 * will not pass its layers and the ladder would spend an hour proving it
 * (ADR-0022).
 *
 * @returns {Promise<{green?: boolean, directive?: object}>} `green` says the
 *   re-run turned the layers green and the fix is stamped; a directive is the
 *   probe's own park, or a command that could not run.
 */
async function substrateLadder(ctx, base, { ops, last, events, skip, skipStamp }) {
  // A CI-source render runs no local layer, so there is nothing here to re-run
  // and the gate is the whole route (ADR-0022).
  if (skip) return { green: false };
  const env = ops.filter((f) => f.class === 'env');
  if (env.length === 0) return { green: false };
  const names = [...new Set(env.flatMap((f) => f.layers ?? []))];
  const layers = layerDefs(base, names);
  if (layers.length === 0) return { green: false };
  const since = Math.max(last.seq, lastAnswerSeq(events));
  for (;;) {
    const attempt = waitAttempt(runEvents(ctx), 'substrate', { since });
    const step = ladderStep(LAYER_LADDER, attempt);
    if (step === null) return { green: false };
    const gate = await substrateProbeGate(ctx, base, { ops: env, skip: false });
    if (gate) return { directive: gate };
    await waitFor(waitCtx(ctx), {
      kind: 'substrate',
      reason: 'an env finding survived its fix',
      ms: step,
      attempt,
      detail: { findings: env.map((f) => f.id), layers: names },
    });
    const again = await rerunLayers(ctx, {
      layers,
      commands: base.commands,
      cwd: base.worktree,
      env: base.env,
      cycle: last.cycle,
      sha: last.sha,
      credentials: base.config.credentials ?? [],
      trigger: 'substrate-ladder',
    });
    if (again.error) return { directive: gateCommandError(ctx, again.error) };
    if (persistentReds(again.results).length === 0) {
      ctx.store.append('operational-fix', {
        actor: ACTOR,
        findings: env.map((f) => f.id),
        layers: names,
        source: 'wait',
        attempts: attempt,
        ...skipStamp,
      });
      return { green: true };
    }
  }
}

/** The wait mechanism's context: the run's ledger and the engine's seams. */
function waitCtx(ctx) {
  return {
    store: ctx.store,
    waits: ctx.waits,
    ...(ctx.sleep && { sleep: ctx.sleep }),
    ...(ctx.now && { now: ctx.now }),
  };
}

/**
 * Where a ladder inside a cycle starts counting: the render this cycle
 * follows, or the answer a human gave after it. An answer is a grant — it is
 * the operator saying the world changed — so it buys a fresh ladder rather
 * than a fourth step.
 */
function ladderSince(events) {
  return Math.max(lastRenderSeq(events), lastAnswerSeq(events));
}

/** The seq of the newest answer in a ledger, or 0. */
function lastAnswerSeq(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === 'answer') return events[i].seq;
  }
  return 0;
}

/** The Tier-1 layer definitions behind a set of layer names, in config order. */
function layerDefs(base, names) {
  const wanted = new Set(names);
  return base.layers.filter((layer) => wanted.has(layer.name));
}

/** A spectrum result set with the re-run's answers in place of the old ones. */
function mergeResults(spectrum, results) {
  const replaced = new Map((results ?? []).map((r) => [r.layer, r]));
  return {
    ...spectrum,
    results: spectrum.results.map((r) => replaced.get(r.layer) ?? r),
  };
}

/**
 * The declared service a transient red names, or null. A signature host
 * resolves to the credential whose declared host it equals or ends with, and a
 * project that declares no host for a credential gets no external wait — which
 * is the answer every project had before this existed.
 */
function declaredHost(base, reds, read) {
  const credentials = (base.config?.credentials ?? []).filter((c) => (c.hosts ?? []).length > 0);
  if (credentials.length === 0) return null;
  const evidence = reds
    .flatMap((r) => [r.output ?? '', ...(r.parts ?? []).map((part) => part.output ?? '')])
    .join('\n');
  return credentialHostIn(evidence, credentials) ?? credentialHostIn(read.files.join('\n'), credentials);
}

/**
 * What this cycle already read as a cause outside the tree: the layers, the
 * files and the signatures the `layer-transient` stamps carry. Null for a
 * cycle that read none.
 */
function transientRead(events, cycle) {
  const layers = events.filter((e) => e.event === 'layer-transient' && e.cycle === cycle);
  if (layers.length === 0) return null;
  return {
    layers: layers.map((e) => ({
      layer: e.layer,
      parts: e.parts ?? [],
      files: e.files ?? [],
      signatures: e.signatures ?? [],
    })),
    signatures: [...new Set(layers.flatMap((e) => e.signatures ?? []))].sort(),
  };
}

// -- the response ladder -----------------------------------------------------

async function ladder(ctx, base, mode, { events, renders, last, nextStage }) {
  // Progress before anything else. A cycle whose fingerprint the run has
  // already judged cannot end differently, so the first repeat buys one retry
  // out of the same budget an automatic re-run comes from, and the second
  // hands the decision to the owner (ADR-0022).
  const repeat = cycleRepeat(events, renders, last);
  if (repeat.action === 'park') return cycleRepeatPark(repeat, last);
  if (repeat.action === 'retry') {
    ctx.store.append('cycle-retry', {
      actor: ACTOR,
      fingerprint: repeat.fingerprint,
      render: last.seq,
      cycles: repeat.occurrences.map((o) => o.cycle),
    });
  }
  const { open, suiteDefects, intent, ops, code } = openSets(events, last, mode);
  let acted = false;

  // Intent-level conflicts escalate; the ruling directs the amendment. A ruling
  // this run has already carried into a re-freeze is spent: it rides one
  // amendment and one only, and the re-freeze that carried it says so on the
  // record.
  //
  // The card rules first. Every intent finding whose claim clears the checks is
  // an authorized supersede, and a render whose intent set is authorized end to
  // end needs no human: the citation becomes the ruling and rides the same
  // re-freeze route (ADR-0044). One finding the card does not settle sends the
  // whole set to the owner, because a park that carried half a conflict would
  // ask a question the run had already half answered.
  let intentAnswer = null;
  if (intent.length > 0) {
    const card = cardSupersedes(ctx, base, { intent, last });
    if (card.ruling) intentAnswer = rulingCarried(events, card.ruling) ? null : card.ruling;
    else {
      const park = answeredPark(events, 'intent-conflict');
      if (!park?.answer || park.answer.seq < last.seq) {
        return parkDirective('intent-conflict', {
          // Every finding the render left open, and not the intent set alone.
          // A ruling is given against the state the render found, and the
          // findings beside the conflict are that state: the amendment that
          // carries the ruling meets them all anyway, and an owner who reads
          // the conflict on its own rules on half a verdict (ADR-0068). The
          // intent findings come first, because they are what the park asks
          // about; the card's refusals close the question.
          question:
            'Verdict triage found an intent-level suite conflict. Every finding open at this ' +
            `render:\n${openFindingsBlock(open, intent)}\n\nThe card did not settle it:\n` +
            card.refusals.map((r) => `- ${r}`).join('\n'),
          text: RULING_TEXT,
          refs: [last.record],
        });
      }
      intentAnswer = rulingCarried(events, park.answer) ? null : park.answer;
    }
  }

  // Env / harness → operational fix; a finding that persists after its fix
  // waits on the human (the substrate needs provisioning the daemon must
  // never self-clear).
  // A fix this render already earned is not earned twice. The ladder re-enters
  // a render whose later arm parked, and this arm's own record is what it reads
  // to know it has run: without that, the second entry would find the findings
  // "fixed" and park the provisioning gate over a substrate nobody claimed was
  // broken.
  const fixedThisRender = events.some(
    (e) => e.event === 'operational-fix' && e.seq > last.seq,
  );
  if (ops.length > 0 && fixedThisRender) acted = true;
  else if (ops.length > 0) {
    // A fix the local spectrum cannot test hands the run straight back to
    // ship, where the CI re-run tests it (ADR-0022). The stamp names the
    // findings and the reason, so the missing cycle reads as a decision.
    const skip = skipsSweep(last, open);
    const skipStamp = skip ? { sweep: 'skipped', note: SWEEP_SKIP_NOTE } : {};
    const fixedIds = new Set(
      events.filter((e) => e.event === 'operational-fix').flatMap((e) => e.findings ?? []),
    );
    const unfixed = ops.filter((f) => !fixedIds.has(f.id));
    if (unfixed.length > 0) {
      // The substrate first, and the layers after it. An env finding says the
      // failure sits outside the tree, so the fix this route stamps buys a
      // re-run of layers that a broken host will fail again — for as long as
      // that spectrum takes. The probe asks the host in seconds, and a host
      // that answers no parks here with the probe's own evidence, before the
      // re-run rather than an hour and a half after it (ADR-0022).
      const gate = await substrateProbeGate(ctx, base, { ops: unfixed, skip });
      if (gate) return gate;
      ctx.store.append('operational-fix', {
        actor: ACTOR,
        findings: unfixed.map((f) => f.id),
        layers: [...new Set(unfixed.flatMap((f) => f.layers ?? []))],
        ...skipStamp,
      });
      if (skip) return { next: nextStage };
      acted = true;
    } else {
      const park = answeredPark(events, 'provisioning-gate');
      const asked = Boolean(park?.answer) && park.answer.seq >= last.seq;
      // Before anybody is asked: the substrate ladder. An env finding that
      // survived its fix waits and re-runs on its own, and only a spent ladder
      // reaches the gate (ADR-0069). A gate the operator has already answered
      // is past that question.
      const climbed = asked
        ? { green: false }
        : await substrateLadder(ctx, base, { ops, last, events, skip, skipStamp });
      if (climbed.directive) return climbed.directive;
      if (climbed.green) {
        if (skip) return { next: nextStage };
        acted = true;
      } else if (!asked) {
        // The gate the operator already answered. Every finding it would ask
        // about is a harness defect somebody recorded as known, so the lane
        // answers on that authority and stamps twice: the ack it used, and the
        // fix that stands on it. A first gate for a fingerprint finds no ack
        // and reaches the human, which is where an ack comes from (ADR-0032).
        const standing = standingAcksFor(ctx.paths, ctx.project);
        const used = ops.map((f) => coveringAck(standing, f));
        if (!used.every(Boolean)) return gateFor(ctx, ops, last, { events, standing });
        ctx.store.append('finding-ack-used', {
          actor: ACTOR,
          findings: ops.map((f) => f.id),
          acks: ops.map((f, i) => ({
            finding: f.id,
            fingerprint: used[i].fingerprint,
            ackSeq: used[i].seq,
            ackedBy: used[i].actor,
          })),
        });
        ctx.store.append('operational-fix', {
          actor: ACTOR,
          findings: ops.map((f) => f.id),
          source: 'ack',
          acks: [...new Set(used.map((a) => a.fingerprint))],
          ...skipStamp,
        });
        if (skip) return { next: nextStage };
        acted = true;
      } else {
        ctx.store.append('operational-fix', {
          actor: park.answer.actor,
          findings: ops.map((f) => f.id),
          source: 'answer',
          ...skipStamp,
        });
        if (skip) return { next: nextStage };
        acted = true;
      }
    }
  }

  // Suite-defect → re-freeze step (story lane). A suite defect that survived
  // its re-freeze is a stall for loop safety — it still costs no budget.
  let suiteStalled = false;
  if (suiteDefects.length > 0) {
    suiteStalled = suiteDefectStalled(events, renders, last, suiteDefects);
    if (!suiteStalled) {
      const outcome = await refreezeStep(ctx, base, {
        findings: suiteDefects,
        record: readJson(last.record),
        intentAnswer,
      });
      if (outcome.fail) return outcome.fail;
      acted = true;
    }
  }

  // Code findings → repair rounds, progress-gated; a stall takes the one fresh
  // pass; a second stall parks. A confirmed approach finding is a code finding
  // like any other here: it rides the repair brief under its own heading, and
  // the round that closes nothing is what buys the pass (ADR-0007).
  if (code.length > 0 || suiteStalled) {
    const pass = currentPass(events);
    const rounds = events.filter((e) => e.event === 'repair-round' && e.pass === pass).length;
    const grants = answerCount(events, 'second-stall', 'repair-again');
    const noProgress = repairStalled(events, renders, last);
    const capExhausted = rounds >= REPAIR_CAP + grants;
    if (noProgress || capExhausted || suiteStalled) {
      const reason = noProgress
        ? 'no-progress'
        : suiteStalled
          ? 're-freeze-no-progress'
          : 'cap-exhausted';
      if (!events.some((e) => e.event === 'stall' && e.seq > last.seq)) {
        ctx.store.append('stall', { actor: ACTOR, pass, reason, open: last.open.length });
      }
      const freshUsed = events.filter(
        (e) => e.event === 'implementation-committed' && e.phase === 'fresh',
      ).length;
      const freshAllowed = 1 + answerCount(events, 'second-stall', 'fresh-pass');
      if (freshUsed < freshAllowed) {
        const outcome = await freshPass(ctx, base, mode, {
          newPass: pass + 1,
          trigger: reason,
          open: [...code, ...suiteDefects],
          last,
        });
        if (outcome.fail) return outcome.fail;
        return null;
      }
      const park = answeredPark(events, 'second-stall');
      if (!park?.answer || park.answer.seq < last.seq) {
        return parkDirective('second-stall', {
          question:
            `The run stalled again (pass ${pass}, ${rounds} repair rounds, ` +
            `${last.open.length} open findings):\n` +
            open.map((f) => `- ${findingLine(f)}`).join('\n') +
            '\nThe verdict history is in the run records. Pick an option.',
          options: ['repair-again', 'fresh-pass'],
          refs: [last.record],
        });
      }
      if (park.answer.option === 'fresh-pass') {
        const outcome = await freshPass(ctx, base, mode, {
          newPass: pass + 1,
          trigger: 'answer',
          open: [...code, ...suiteDefects],
          last,
        });
        if (outcome.fail) return outcome.fail;
        return null;
      }
      // repair-again: one more granted round.
      const outcome = await repairRound(ctx, base, mode, {
        pass,
        round: rounds + 1,
        open: code,
        record: readJson(last.record),
      });
      if (outcome.fail) return outcome.fail;
      return null;
    }
    const outcome = await repairRound(ctx, base, mode, {
      pass,
      round: rounds + 1,
      open: code,
      record: readJson(last.record),
    });
    if (outcome.fail) return outcome.fail;
    acted = true;
  }

  if (!acted) throw new Error('verdict ladder found no route for the open findings');
  return null;
}

/**
 * The park a repeated cycle fingerprint raises. It carries every occurrence of
 * the fingerprint, so the owner reads the repetition off the question instead
 * of diffing verdict records, and it carries the fingerprint itself, so the
 * `retry` it takes back grants exactly the cycle it was asked about.
 */
function cycleRepeatPark({ fingerprint, occurrences }, last) {
  const line = (o) => `- cycle ${o.cycle} (seq ${o.seq})` + (o.record ? `: ${o.record}` : '');
  return parkDirective('cycle-repeat', {
    question:
      `Cycle ${last.cycle} judged what an earlier cycle of this run judged: the same candidate ` +
      `sha (${last.sha}), the same suite, the same open findings by identity, and the same ` +
      'check state. One retry has already been spent on the repetition and it moved nothing, ' +
      `so the next cycle would spend the same work on the same inputs. Fingerprint ` +
      `${fingerprint}:\n` +
      occurrences.map(line).join('\n') +
      '\nThe run holds every result it has earned and costs nothing while it waits. ' +
      'Answer "retry" for one more cycle, or "abandon" to close the run.',
    options: ['retry'],
    refs: [last.record],
    detail: { fingerprint, occurrences },
  });
}

// What an `ack` answer at the gate is worth, said at the gate. The operator
// reads the fingerprints off this text and hands one back to the revoke.
const HARNESS_NOTE =
  'This is a defect of the harness, not of the substrate and not of the tree, ' +
  'so the gate offers no retry: a retry re-runs the same harness on the same ' +
  'tree. Answer "ack" to record every finding above as known, by the ' +
  'fingerprint beside it — the run goes on, a later gate on the same ' +
  'fingerprint answers itself in this run and in every other, and the defect ' +
  'is counted on the escapes ledger until `olympusctl revoke` names its ' +
  'fingerprint and the fix behind it. Answer "abandon" if the run is not worth ' +
  'finishing under it.';

/**
 * The provisioning gate for a set of persisting findings, split on class.
 *
 * An env finding says the host this run stands on is wrong, and only a person
 * standing in front of that host can repair it: the gate asks for the repair
 * and takes `retry`. A harness finding says the machinery that judges is
 * wrong, and no answer the operator can give repairs it here — so that gate
 * asks the one question the operator can answer, which is whether the run goes
 * on under a defect somebody already holds (ADR-0068).
 *
 * A render that holds both takes the substrate gate first, because the env
 * findings are the ones a repair can still clear. The harness question is
 * asked when nothing but harness findings is left, or when the substrate half
 * is exhausted: a gate whose env findings are the same ones the previous
 * substrate gate of this run named is a gate the retry did not move, and
 * holding the harness question behind it for ever is the loop this split
 * exists to end.
 */
function gateFor(ctx, ops, last, { events, standing }) {
  // The split is the ack's own scope rule (`ACKABLE_CLASSES`), read through
  // `isAckable`: a finding an ack may cover is a defect of the harness, and
  // every other finding at this gate is a statement about the host. The two
  // halves therefore stay in step with that set rather than with a second copy
  // of it here.
  const harness = ops.filter(isAckable);
  const substrate = ops.filter((f) => !isAckable(f));
  if (substrate.length === 0) return harnessGateFor(ctx, harness, last, []);
  // Only what the operator has not already answered. A harness finding a
  // standing ack covers is not a question, and asking it again at every
  // exhausted substrate gate would be the same loop in the other direction.
  const unasked = harness.filter((f) => !coveringAck(standing, f));
  // The ledger as it stands now, not as the ladder found it: the waits this
  // route just spent are what says the substrate half has nothing left to try.
  const now = runEvents(ctx);
  if (unasked.length > 0 && substrateExhausted(now, substrate, last)) {
    return harnessGateFor(ctx, unasked, last, substrate);
  }
  return substrateGateFor(substrate, harness, last, waitHistory(now, 'substrate', {
    since: last.seq,
  }));
}

/**
 * Whether the substrate half of this gate has nothing left to try: the env
 * findings of this render are, by identity, the set the last substrate gate of
 * this run named, AND the wait ladder of this render is spent.
 *
 * Both halves are needed and they answer different questions. The identity
 * says the human's retry moved nothing — it is the finding fingerprint, the
 * harness's own answer to whether two findings are one (ADR-0022), and it
 * survives the fresh ids a triage seat mints for a red it meets again. The
 * ladder says the machine's own three re-runs moved nothing either
 * (ADR-0069). Only when neither moved anything is the harness question worth
 * asking ahead of the substrate one, and holding it behind a substrate gate
 * for ever is the loop this split exists to end.
 */
function substrateExhausted(events, substrate, last) {
  const asked = [...events]
    .reverse()
    .find((e) => e.event === 'park' && e.type === 'provisioning-gate' && e.detail?.substrate);
  if (!asked) return false;
  const now = substrate.map((f) => findingFingerprint(f)).sort();
  const before = [...asked.detail.substrate].sort();
  if (now.length !== before.length || !now.every((id, i) => id === before[i])) return false;
  return ladderStep(LAYER_LADDER, waitAttempt(events, 'substrate', { since: last.seq })) === null;
}

/**
 * The substrate half: the gate as it was, with `retry` and nothing else. No
 * finding it names may carry an ack — that is what put the other half on the
 * other side of the split — so the option that walks past a judgment is not
 * offered here at all.
 *
 * Harness findings the same render holds are named and not asked about. The
 * gate after this one asks them, and an operator handed a list they cannot act
 * on answers the wrong half of it.
 */
function substrateGateFor(ops, harness, last, history = []) {
  const line = (f) => `- [${f.class}] ${f.summary} (evidence: ${f.evidence})`;
  return parkDirective('provisioning-gate', {
    ...GATE_FORMS,
    question:
      'These findings persist after an operational fix; confirm the substrate is repaired:\n' +
      ops.map(line).join('\n') +
      // What the harness already tried on its own, and when. An operator asked
      // to look at a host reads the three attempts before they decide whether
      // a fourth is worth anything (ADR-0069).
      (history.length > 0
        ? '\nThe harness waited and re-ran these layers before asking:\n' +
          history.map((entry) => waitLine(entry)).join('\n')
        : '') +
      (harness.length > 0
        ? `\nThis render also holds ${harness.length} harness finding(s). They are a defect of ` +
          'the machinery and not of this host. The gate after this one asks about them, and a ' +
          'gate that finds these same substrate findings again asks about them there.'
        : ''),
    refs: [last.record],
    // What this gate asked about, by identity. The gate after it reads this to
    // know whether the retry moved anything, and hands the harness question
    // over when it did not.
    detail: { substrate: ops.map((f) => findingFingerprint(f)).sort() },
  });
}

/**
 * The harness half: no retry, the ack first with its fingerprint, the abandon
 * every park owes. The escape is recorded before the park, because the count
 * is what the ack buys against: a defect the harness walks past is a cost, and
 * a cost nobody wrote down is an anecdote (ADR-0024, ADR-0068).
 */
function harnessGateFor(ctx, ops, last, standingOn) {
  const offered = ops.map((f) => ({
    fingerprint: ackFingerprint(f),
    class: f.class,
    summary: gist(f.summary),
  }));
  const counted = recordHarnessDefects(ctx, ops, offered);
  const line = (f, i) =>
    `- [${f.class}] ${f.summary} (evidence: ${f.evidence}) · ${offered[i].fingerprint}` +
    ` · escape #${counted.get(offered[i].fingerprint)}`;
  return parkDirective('provisioning-gate', {
    ...HARNESS_GATE_FORMS,
    acks: offered,
    question:
      'These harness findings persist after an operational fix:\n' +
      ops.map(line).join('\n') +
      (standingOn.length > 0
        ? '\nThe substrate findings under them are unchanged since the last gate, so the ' +
          'question the retry could answer has been asked:\n' +
          standingOn.map((f) => `- [${f.class}] ${f.summary} (evidence: ${f.evidence})`).join('\n')
        : '') +
      `\n${HARNESS_NOTE}`,
    refs: [last.record],
    // The records this gate is asking against, and no others: an escape the
    // project already carried for some other defect is not what an answer here
    // is about.
    detail: { escapes: offered.map((a) => counted.get(a.fingerprint)) },
  });
}

/**
 * One counted escape per harness defect this gate asks about, on the escapes
 * ledger. Idempotent by fingerprint: a defect already counted and still open
 * is the same defect, however many gates of however many runs meet it, and the
 * revoke that ends its acknowledgment is what closes it (`resolution.mjs`).
 * The escape carries no ticket, so no repair sweep launches against it — the
 * fix of a harness defect is not a run of the project it was met in.
 * @returns {Map<string, number>} fingerprint → the seq of the open escape that
 *   counts it, so the gate's question names the record the ack is answering
 *   against
 */
function recordHarnessDefects(ctx, ops, offered) {
  const store = openEscapesStore(ctx.paths, { onAppend: ctx.onAppend });
  try {
    const counted = new Map(
      readEscapeSet(ctx.paths.escapesLedger)
        .filter((e) => e.kind === HARNESS_DEFECT_KIND && !e.fixed && e.refs?.project === ctx.project)
        .map((e) => [e.refs?.fingerprint, e.seq]),
    );
    ops.forEach((finding, i) => {
      const fingerprint = offered[i].fingerprint;
      if (counted.has(fingerprint)) return;
      const line = recordEscape(store, {
        actor: ACTOR,
        category: 'harness',
        defectLine: `${finding.summary} (evidence: ${finding.evidence})`,
        detectionSource: 'harness-self',
        attribution: 'harness',
        kind: HARNESS_DEFECT_KIND,
        refs: {
          project: ctx.project,
          runId: ctx.runId,
          fingerprint,
          findingId: finding.id,
          ...(hasLayers(finding.layers) && { layers: finding.layers }),
        },
      });
      counted.set(fingerprint, line.seq);
    });
    return counted;
  } finally {
    store.close();
  }
}

/** True when a layer list is worth carrying: the subject an ack keys on. */
function hasLayers(layers) {
  return Array.isArray(layers) && layers.length > 0;
}

/**
 * The substrate probe in front of an operational fix (ADR-0022). It asks on an
 * env-class finding, which is the class that names the host this run stands
 * on, and only where the fix earns a local cycle: a skipped sweep runs no
 * layer here, and the substrate a CI finding names is not this host's. A probe
 * that reads nothing parks nothing — the route carries on as it did before the
 * probe existed.
 */
function substrateProbeGate(ctx, base, { ops, skip }) {
  if (skip || !ops.some((f) => f.class === 'env')) return null;
  return substrateGate(ctx, {
    stack: ctx.payload.stack,
    composeCommand: ctx.composeCommand,
    cwd: base.worktree,
  });
}

/**
 * Whether the operational fix this verdict earns needs a local cycle behind
 * it. It does not when every open finding takes the operational route on a
 * verdict the CI checks rendered: the layers of this tree were green at this
 * sha, the red ones are CI checks the spectrum does not hold, and the remedy
 * of an env or a harness finding lands outside the tree — a credential, a
 * runner, forge metadata — where no local layer reaches it either way. An
 * open finding of any other class is something the local layers do judge, so
 * the cycle runs (ADR-0022).
 */
function skipsSweep(last, open) {
  return (
    last.source === 'ci' &&
    open.length > 0 &&
    open.every((f) => f.class === 'env' || f.class === 'harness')
  );
}

/**
 * Whether a suite defect already survived a re-freeze of its own. One defect
 * buys one amendment: a defect the previous render left open, and that a
 * re-freeze between the two renders was meant to close, is not amended again —
 * the tree is the suspect from there, and the code arm takes it.
 */
function suiteDefectStalled(events, renders, last, suiteDefects) {
  const prevRender = renders[renders.length - 2];
  if (!prevRender) return false;
  const window = eventsAfter(events, prevRender.seq).filter((e) => e.seq < last.seq);
  return (
    window.some((e) => e.event === 're-freeze') &&
    suiteDefects.some((f) => prevRender.open.includes(f.id))
  );
}

/**
 * Whether the ladder still owes this render a re-freeze — the suite arm's own
 * precondition, read from outside the ladder so the loop that decides whether
 * to start a cycle and the arm that would amend the suite cannot disagree.
 *
 * A render with open suite defects owes one, until the `re-freeze` that answers
 * it is stamped, and never when the defects already survived a re-freeze. The
 * repair lane owes none: it routes a suite defect to the code arm.
 */
export function refreezeOwed(events, renders, last, mode) {
  if (!last || mode !== 'story') return false;
  if (events.some((e) => e.event === 're-freeze' && e.seq > last.seq)) return false;
  const index = findingIndex(events);
  const suiteDefects = last.open
    .map((id) => index.get(id))
    .filter((f) => f?.class === 'suite-defect');
  if (suiteDefects.length === 0) return false;
  return !suiteDefectStalled(events, renders, last, suiteDefects);
}

/**
 * The card's answer to a render's intent findings: a ruling when the card
 * authorizes every one of them, and the refusals when it does not.
 *
 * The stamping is idempotent by render. The ladder re-enters a render whose
 * later arm parked, and a second stamp would mint a second ruling seq: the
 * re-freeze that already spent the first would read as unspent, and the suite
 * would be amended twice for one collision.
 *
 * @returns {{ruling: object|null, refusals: string[]}}
 */
function cardSupersedes(ctx, base, { intent, last }) {
  const refusals = [];
  const stamped = [];
  for (const finding of intent) {
    const events = runEvents(ctx);
    const already = authorizedSupersedes(events, { after: last.seq }).find(
      (e) => e.finding === finding.id,
    );
    if (already) {
      stamped.push(already);
      continue;
    }
    const claim = finding.supersede ?? null;
    const { event, refused } = authorizeSupersede(ctx.store, {
      actor: ACTOR,
      site: 'verdict',
      claim,
      findingId: finding.id,
      cardText: base.cardText,
      cardPath: base.cardPath,
      worktree: base.worktree,
      testPaths: base.testPaths,
      frozen: base.frozenSuiteFiles,
      pins: base.ownerPins,
      enabled: base.cardAuthorizedSupersede,
    });
    if (event) stamped.push(event);
    else refusals.push(`[${finding.id}] ${refusalLine(refused, claim)}`);
  }
  if (refusals.length > 0 || stamped.length !== intent.length) {
    return { ruling: null, refusals };
  }
  return { ruling: supersedeRuling(stamped), refusals };
}

/**
 * Whether a re-freeze of this run already carried a ruling into the suite. The
 * amendment is where a ruling becomes a change to the frozen tests, and it
 * happens once: a second delivery of the same answer would re-brief a seat
 * about a change the suite already holds.
 */
function rulingCarried(events, answer) {
  return events.some((e) => e.event === 're-freeze' && e.ruling?.answer === answer.seq);
}

/**
 * Whether the verdict stage handed a red render back to ship without a local
 * cycle. The render stays red until the CI re-run answers it, so the ship
 * stage reads this before it bounces a red verdict back.
 */
export function sweepSkippedAfter(events, seq) {
  return events.some((e) => e.event === 'operational-fix' && e.sweep === 'skipped' && e.seq > seq);
}

/**
 * The progress rule: a repair round is a stall when it closed none of the
 * findings the render before it left open (ADR-0022). A count of the open set
 * says two against two and cannot say whether they are the same two, so the
 * round that fixes the defect it was given while the review names the next one
 * reads as a stall and costs the run its fresh pass. The key is the identity a
 * standing acknowledgment and the cycle fingerprint already read, so the
 * harness holds one answer to "is this the same finding".
 *
 * The comparison is over occurrences, not membership. That identity normalizes
 * away the numerals a defect carries, so four layers failing as `m1` to `m4`
 * reach one identity between them, and a membership test would read three of
 * them closed as nothing closed. An identity that comes back fewer times than
 * it went in is a closed finding.
 *
 * The two guards own different failure shapes. This one asks whether the
 * repair round moved the findings, and a round that moved none takes the fresh
 * pass — the tree is the suspect. The cycle fingerprint asks whether the whole
 * cycle repeated its inputs, and a second repeat parks — nothing left in the
 * harness can move it. A repair round that closes one finding and surfaces
 * another passes both: it is progress here, and a new fingerprint there.
 */
export function repairStalled(events, renders, last) {
  const prevRender = renders[renders.length - 2];
  if (!prevRender || prevRender.pass !== last.pass) return false;
  const window = eventsAfter(events, prevRender.seq).filter((e) => e.seq < last.seq);
  if (!window.some((e) => e.event === 'repair-round')) return false;
  const prior = tally(openIdentities(events, prevRender));
  if (prior.size === 0) return false;
  const open = tally(openIdentities(events, last));
  return [...prior].every(([identity, count]) => (open.get(identity) ?? 0) >= count);
}

/** How many times each identity of a set occurs in it. */
function tally(identities) {
  const counts = new Map();
  for (const identity of identities) counts.set(identity, (counts.get(identity) ?? 0) + 1);
  return counts;
}

// -- ladder arms -------------------------------------------------------------

async function repairRound(ctx, base, mode, { pass, round, open, record }) {
  const { recaptured } = recordedTakeBacks(runEvents(ctx));
  const result = await runDevSeat(ctx, base, mode, {
    seat: 'repair-dev',
    buildRole: (brief) => repairRole(base, open, record, brief, recaptured),
  });
  if (result.fail) return result;
  ctx.store.append('repair-round', {
    actor: ACTOR,
    pass,
    round,
    sha: result.sha,
    openBefore: open.map((f) => f.id),
  });
  return {};
}

export async function freshPass(ctx, base, mode, { newPass, trigger, open, last }) {
  const events = runEvents(ctx);
  if (!events.some((e) => e.event === 'fresh-pass' && e.seq > last.seq)) {
    // The fresh pass never sees the prior tree: reset to the state the pass is
    // born on, then carry the current frozen suite forward. A carry and not a
    // restore, because a merge-born pass is born on the updated default branch
    // and a restore of the whole test paths would revert everything that
    // branch advanced under them (ADR-0033).
    // The stamp lands last, so a restart before it redoes the (idempotent)
    // reset instead of skipping it, and it names the tree the pass was born
    // on, which is where every later restore of this pass answers to.
    await resetHard(base.worktree, base.resetSha);
    const stamp = { actor: ACTOR, pass: newPass, trigger };
    if (mode === 'story') {
      await carryPaths(base.worktree, currentSuiteSha(events), base.testPaths, {
        except: base.frozenExclusions,
      });
      stamp.sha = await commitAll(base.worktree, `suite carry: ${ctx.runId}`);
    }
    ctx.store.append('fresh-pass', stamp);
  }
  // The stall brief always rides; a capture correction rides with it.
  const stall = stallBrief(open);
  const withStall = (brief) => (brief ? [stall, ...(Array.isArray(brief) ? brief : [brief])] : stall);
  const result = await runDevSeat(ctx, base, mode, {
    seat: 'dev',
    buildRole: (brief) =>
      mode === 'story' ? devRole(base, withStall(brief)) : fixRole(base, withStall(brief)),
    pass: newPass,
    phase: 'fresh',
  });
  if (result.fail) return result;
  return {};
}

/**
 * One dev-seat pass over the worktree: seat, structural suite restore,
 * commit, `implementation-committed` stamp.
 */
async function runDevSeat(ctx, base, mode, { seat, buildRole, pass = null, phase = null }) {
  const events = runEvents(ctx);
  const baseSha = await headSha(base.worktree);
  const { fail, dropped } = await devSeatWithCapture(ctx, base, mode, {
    seat,
    buildRole,
    suiteSha: mode === 'story' ? currentSuiteSha(events) : null,
  });
  if (fail) return { fail };
  const sha = await commitAll(base.worktree, `${seat === 'dev' ? 'implement' : 'repair'}: ${ctx.runId}`);
  ctx.store.append('implementation-committed', {
    actor: ACTOR,
    pass: pass ?? currentPass(events),
    phase: phase ?? 'repair',
    baseSha,
    sha,
    ...(dropped.length > 0 && { dropped }),
  });
  return { sha };
}

async function refreezeStep(ctx, base, { findings, record, intentAnswer }) {
  const events = runEvents(ctx);
  // The tree the amendment starts from. It rides the stamp so a later reader
  // can diff what the amendment changed without guessing at a parent commit.
  const baseSha = await headSha(base.worktree);
  // The frozen tests the ruling names. A conflict the owner settles against the
  // suite is settled nowhere else: the spec can say the criterion supersedes a
  // pin, and the pin still fails the run until the file itself changes. So the
  // named files are stated to the seat and required of its work.
  const ruled = intentAnswer ? ruledSuiteFiles(intentAnswer, base.frozenSuiteFiles ?? []) : [];
  // Spec-deep defects amend the born spec first; the answered intent
  // conflict rides the same amendment.
  const deep = findings.filter((f) => f.depth === 'spec' || f.depth === 'intent');
  if (deep.length > 0 && !specAmended(events, lastRenderSeq(events))) {
    // The template holds after the freeze too: this amendment is re-linted
    // like every other one, and a defect takes the corrective route (ADR-0019).
    const amend = await seatWithChecks(ctx, {
      seat: 'spec-birth',
      schema: SPEC_AMEND_SCHEMA,
      cwd: base.worktree,
      env: base.env,
      constitution: base.constitution,
      buildRole: (defects) => specAmendRole(base, deep, intentAnswer, ruled, defects),
      checks: () => specLintDefects({ ...base, specPath: base.specRef }),
      defectReason: 'spec-defect',
    });
    if (amend.fail) return { fail: amend.fail };
  }
  const { report, fail } = await seatWithChecks(ctx, {
    seat: 'suite',
    label: null,
    schema: SUITE_SCHEMA,
    cwd: base.worktree,
    env: base.env,
    constitution: base.constitution,
    buildRole: (brief) => refreezeRole(base, findings, record, intentAnswer, ruled, brief),
    checks: async (r) => {
      const defects = [];
      if (r.suiteFiles.length === 0) defects.push('no suite files declared');
      for (const file of r.suiteFiles) {
        if (!underAny(file, base.testPaths)) defects.push(`suite file outside the test paths: ${file}`);
        else if (!existsSync(join(base.worktree, file))) defects.push(`declared suite file missing: ${file}`);
      }
      const changed = await changedFiles(base.worktree);
      for (const file of changed) {
        if (!underAny(file, base.testPaths)) defects.push(`change outside the test paths: ${file}`);
      }
      for (const file of ruled) {
        if (!changed.includes(file)) {
          defects.push(
            `the answered intent ruling names the frozen test ${file} and it is unchanged; ` +
              'this amendment is the only route a ruling has into the frozen suite.',
          );
        }
      }
      return defects;
    },
  });
  if (fail) return { fail };
  const sha = await commitAll(base.worktree, `suite re-freeze: ${ctx.runId}`);
  ctx.store.append('suite-committed', {
    actor: ACTOR,
    sha,
    phase: 're-freeze',
    files: report.suiteFiles,
  });
  ctx.store.append('re-freeze', {
    actor: ACTOR,
    baseSha,
    sha,
    files: report.suiteFiles,
    findings: findings.map((f) => f.id),
    // What the amendment carried, where it carried one. The ruling is spent
    // here, and the record is what says so to every later reader. `source`
    // names which of the two authorities it came from: a human's answer to a
    // park, or the story's own card (ADR-0044). A record written before the
    // second source existed carries no `source` and reads as an answer.
    ...(intentAnswer && {
      ruling: {
        ...(intentAnswer.parkSeq != null && { park: intentAnswer.parkSeq }),
        answer: intentAnswer.seq,
        actor: intentAnswer.actor,
        ...(intentAnswer.source === 'card' && { source: 'card' }),
        files: ruled,
      },
    }),
  });
  return {};
}

/**
 * Whether the spec amendment this render asked for stands. A seat report says
 * the seat answered; a work-product failure after it says the answer did not
 * hold, and the amendment that never landed is owed again.
 */
function specAmended(events, renderSeq) {
  const report = seatReportAfter(events, 'spec-birth', renderSeq);
  if (!report) return false;
  const failure = seatFailureAfter(events, 'spec-birth', renderSeq);
  return !failure || failure.seq < report.seq;
}

/**
 * The frozen suite files an answered ruling names. The owner writes the ruling
 * in prose, so the match is made against the frozen set rather than parsed out
 * of the sentence: a file counts as named when the ruling carries its
 * repo-relative path or its file name. Nothing else in the text is read.
 */
function ruledSuiteFiles(answer, frozen) {
  const text = [answer?.answer ?? '', answer?.option ?? ''].join('\n');
  if (text.trim().length === 0) return [];
  return frozen.filter((file) => text.includes(file) || text.includes(basename(file)));
}

// -- candidate capture -------------------------------------------------------

/**
 * The gate between what a dev seat left in the tree and the implementation
 * commit. Two things can stand in the way, and they are not the same thing.
 *
 * - A **violation** is a change the lane's diff policy refuses (ADR-0017):
 *   a denied path, an undeclared declarable path, a forbidden path shape. It
 *   is a work-product defect the seat answers in one corrective invocation,
 *   and the capture stops until it does.
 * - A **take-back** is a write to a path the lane froze — today, a story-lane
 *   seat that reached a test path past its tool deny. The revert stays
 *   unconditional, because the frozen suite is the thing being judged
 *   against, and it stays recorded. It is not a defect: no seat under that
 *   freeze can make the write legal by trying again, so a corrective
 *   invocation buys the run nothing and the park that follows it costs the
 *   run everything. The capture keeps the allowed set and proceeds; the
 *   verdict owns the frozen surface through its re-freeze route.
 *
 * A capture that holds both blocks. The violation decides that, and the
 * corrective brief still states the take-back, because the seat is about to
 * re-read a tree that no longer holds its write.
 *
 * A third thing is neither of those. A frozen write under the lane's
 * `sweptPaths` that the freeze anchor does not hold is a file a test run
 * generated, so the restore removing it takes nothing back and no downstream
 * reader is told about a loss that did not happen. It is swept before the
 * classes are decided, and stamps the quiet `capture-swept`.
 *
 * Take-backs come in two record classes, and nothing else about them differs.
 * A path the lane declared `recapturablePaths` is an artifact a re-freeze
 * re-takes, so it stamps the quiet `diff-policy-recapture`; every other frozen
 * path stamps the loud record. The revert, `capture.dropped` and every
 * downstream statement cover both classes, and both records carry the closed
 * word for the defect.
 *
 * The restore runs before the record, so the tree is correct whether or not
 * the capture proceeds. `capture.dropped` carries the take-back out to the
 * commit record; the ledger record is the loud copy.
 *
 * @returns {Promise<string[]>} defect lines; empty means the capture proceeds
 */
async function captureDefects(ctx, base, mode, { seat, capture }) {
  const changed = await changedFiles(base.worktree);
  // An exclusion is the seat's own file: the restore leaves it alone, so the
  // capture keeps it and the diff policy judges it like any other change.
  const exempt = mode === 'story' ? (base.frozenExclusions ?? []) : [];
  const anchor = mode === 'story' ? restoreAnchor(runEvents(ctx)) : null;
  const frozenWrites =
    mode === 'story'
      ? changed.filter((f) => underAny(f, base.testPaths) && !exempt.includes(f))
      : [];
  if (mode === 'story') {
    await restorePaths(base.worktree, anchor, base.testPaths, { except: exempt });
  }
  const tier = laneDiffPolicy(base.config, mode);
  // The sweep parts first, because a swept path is not a take-back at all: the
  // freeze never held the file, so the restore that just ran took nothing back
  // by removing it. Nothing downstream is told about it, and the count of
  // take-backs stays a count of writes to work somebody authored.
  const swept = await sweptWrites(base, tier, frozenWrites, anchor);
  const dropped = frozenWrites.filter((f) => !swept.includes(f));
  if (swept.length > 0) {
    ctx.store.append('capture-swept', {
      actor: ACTOR,
      seat,
      lane: mode,
      swept,
      note: SWEEP_NOTE,
      gist: gist(sweepGist(swept)),
    });
  }
  // Across the attempts of one seat pass, not just the last one: a write the
  // first capture took back is gone from the commit the corrective attempt
  // produces, and the commit record has to say so.
  for (const path of dropped) if (!capture.dropped.includes(path)) capture.dropped.push(path);
  const kept = changed.filter((f) => !frozenWrites.includes(f));
  const violations = diffPolicyViolations(kept, tier, declaresPath(base, mode, tier));
  // The two classes of take-back part here, and only in the record: the quiet
  // class is reverted, committed around and stated downstream exactly like the
  // loud one. Both carry the closed word for the defect, so a surface that
  // keeps producing take-backs is a count rather than a sentence (ADR-0008).
  const { recaptured, held } = classifyTakeBacks(dropped, tier);
  if (recaptured.length > 0) {
    ctx.store.append('diff-policy-recapture', {
      actor: ACTOR,
      seat,
      lane: mode,
      kind: assertDefectKind('capture-takeback'),
      recaptured,
      note: RECAPTURE_NOTE,
      recapturedLines: recaptured.map(recaptureLine),
      gist: gist(recaptureGist(recaptured)),
    });
  }
  if (violations.length > 0 || held.length > 0) {
    ctx.store.append('diff-policy-violation', {
      actor: ACTOR,
      seat,
      lane: mode,
      violations,
      dropped: held,
      ...(held.length > 0 && {
        kind: assertDefectKind('capture-takeback'),
        note: DROP_NOTE,
        droppedLines: held.map(dropLine),
      }),
      gist: gist(captureGist({ violations, dropped: held })),
    });
  }
  if (violations.length === 0) return [];
  return [...violations.map(violationLine), ...dropped.map(dropLine)];
}

/**
 * The frozen writes this capture sweeps: generated artifacts under a swept
 * glob that the freeze anchor does not hold. The anchor is the sha the restore
 * just used, so a re-freeze that committed an artifact makes it authored work
 * from that moment on and a later write to it is a take-back again.
 *
 * The tree is read only when a path matched the glob, because the question is
 * about files the runner produced and most captures produce none.
 */
async function sweptWrites(base, tier, frozenWrites, anchor) {
  if (frozenWrites.length === 0 || anchor === null) return [];
  const candidates = sweepCandidates(frozenWrites, tier);
  if (candidates.length === 0) return [];
  return sweptTakeBacks(candidates, tier, await filesAt(base.worktree, anchor, base.testPaths));
}

/**
 * Whether the run declared a path, per lane. The story lane reads the born
 * spec's touched-paths block. The repair lane has no spec, so the intake
 * ticket answers: a path the ticket names verbatim is declared. Unreadable
 * source text declares nothing.
 */
function declaresPath(base, mode, tier) {
  if (!tier?.declaredPaths?.length) return () => false;
  let text;
  try {
    text = readFileSync(base.specRef, 'utf8');
  } catch {
    return () => false;
  }
  if (mode === 'repair') return (path) => text.includes(path);
  const declared = new Set(parseTouchedPaths(text));
  return (path) => declared.has(path);
}

/**
 * One dev-seat invocation and its capture gate, through the lane's corrective
 * machinery: a capture a violation refused buys one corrective invocation
 * carrying the exact paths, then the `seat-failure` park. A capture that only
 * took frozen writes back proceeds, and reports what it took.
 *
 * @returns {Promise<{report?: object, fail?: object, dropped: string[]}>}
 */
async function devSeatWithCapture(ctx, base, mode, { seat, buildRole }) {
  const capture = { dropped: [] };
  const outcome = await seatWithChecks(ctx, {
    seat,
    label: null,
    schema: DEV_SCHEMA,
    cwd: base.worktree,
    env: base.env,
    constitution: base.constitution,
    ...(mode === 'story' && {
      denyTools: testEditDenyRules(base.testPaths, {
        except: base.frozenExclusions,
        worktree: base.worktree,
      }),
    }),
    buildRole,
    checks: () => captureDefects(ctx, base, mode, { seat, capture }),
  });
  return { ...outcome, dropped: capture.dropped };
}

// -- role blocks -------------------------------------------------------------

/**
 * The Tier-1 gate commands, as facts. A dev seat used to be told to run "the
 * gate commands from the project config" without being told what they are,
 * and the fix seat was told nothing at all. Both seats are judged by these
 * commands, so both are given them. The list is a tool the seat may reach
 * for, not an instruction to double-check its work: this module's header
 * bans verification scaffolding, and that ban settles the wording.
 */
function gateCommandLines(base) {
  return [
    'The Tier-1 gate commands this work is judged by:',
    ...base.layers.map((l) => `- ${l.name}: ${(base.commands[l.command] ?? []).join(' ')}`),
    ...affectedPartsLines(base),
  ];
}

/**
 * The one line that rides item 1 (ADR-0046). A seat that reaches for a gate
 * command reaches for the whole battery, and on the reference project the
 * acceptance layer alone is forty minutes of it. The cycle that judges the
 * seat already narrows that layer to the parts a diff can reach, so a seat
 * spending the same clock is told the same mapping and left to use it.
 *
 * Told, never required. The verdict runs the full set whatever the seat did,
 * so this is a saving the seat may take and never a check it owes — the ban
 * on verification scaffolding in this module settles the wording.
 */
function affectedPartsLines(base) {
  if (base.config?.gates?.partTargeting === false) return [];
  return [
    'A layer command that names its parts takes ' +
      `${PARTS_ENV}=<comma-separated part names> and runs those parts alone. ` +
      'Check your own work with the parts your diff can reach: a part is affected ' +
      'unless your diff falls entirely outside its input set — its own test sources ' +
      'and the source trees it exercises, as that command declares them. A path no ' +
      'part claims (a lockfile, a shared package, a migration, a config file) reaches ' +
      'every part, so narrow nothing when you have touched one. The verdict proves every ' +
      'part of every layer at the sha it ships.',
  ];
}

function devRole(base, brief = null) {
  return [
    `Implement the story spec at: ${base.specRef}`,
    'The frozen acceptance suite defines done. Do not edit or delete test files.',
    `Test paths (read-only): ${base.testPaths.join(', ')}`,
    ...gateCommandLines(base),
    'Do not commit; the orchestrator commits your work.',
    ...briefLines(brief),
  ].join('\n');
}

function fixRole(base, brief = null) {
  return [
    `Fix the defect described by the intake ticket at: ${base.specRef}`,
    'The ticket is the spec. Stay inside its scope.',
    'Add a regression test when the defect class demands one.',
    ...gateCommandLines(base),
    'Do not commit; the orchestrator commits your work.',
    ...briefLines(brief),
  ].join('\n');
}

/**
 * What a confirmed approach finding rides into the repair brief, and why it
 * rides in front of the rest.
 *
 * A finding that names the shape of the work as wrong against the spec asks
 * for more than the edit a missing guard asks for, and a brief that lists the
 * two together says nothing about the difference. The heading states what the
 * reviewer found; the note states how far the round may go to answer it, so
 * the seat is not left between that finding and the line above it that says to
 * change nothing else (ADR-0007).
 */
const STRUCTURAL_HEADING =
  'Structural finding: the reviewer names the implementation shape as wrong against the spec.';
const STRUCTURAL_NOTE =
  'Answer it by changing the shape, not by patching around it. Everything else in this brief ' +
  'still holds: the spec, the test files, and every finding it lists.';

function repairRole(base, open, record, brief = null, recaptured = []) {
  const structural = open.filter((f) => f.approach === true);
  const rest = open.filter((f) => f.approach !== true);
  return [
    'Repair the candidate tree in place. Fix every open finding below; change nothing else.',
    `The spec: ${base.specRef}`,
    'Do not edit or delete test files.',
    ...(structural.length > 0
      ? [STRUCTURAL_HEADING, ...structural.map((f) => `- ${findingLine(f)}`), STRUCTURAL_NOTE]
      : []),
    ...(rest.length > 0 ? ['Open findings:', ...rest.map((f) => `- ${findingLine(f)}`)] : []),
    'Tier-1 verdict:',
    ...(record?.spectrum ?? []).map((r) => `- ${r.layer}: ${r.status}${layerNote(r)}`),
    ...gateCommandLines(base),
    ...takenBackLines(record?.dropped, recaptured),
    'Do not commit; the orchestrator commits your work.',
    ...briefLines(brief),
  ].join('\n');
}

/**
 * What the capture took back, stated to a seat that is about to read a tree
 * the take-back already changed. The seat that wrote the file is gone; this
 * seat must not repeat the write, and the lines say why and where the route
 * is instead.
 *
 * The two classes are stated apart. A seat told that a machine-rendered
 * artifact was frozen out of its tree, in the words that describe authored
 * work leaving it, reads a handled case as a loss worth reporting — and it
 * reports it, and the report is a defect record nobody owes an answer for.
 * The re-capturable line says what the class is worth in the same breath.
 */
function takenBackLines(dropped, recaptured = []) {
  if (!dropped?.length) return [];
  const quiet = new Map(recaptured.map((r) => [r.path.replaceAll('\\', '/'), r.pattern]));
  const held = [];
  const taken = [];
  for (const raw of dropped) {
    const path = raw.replaceAll('\\', '/');
    if (quiet.has(path)) taken.push({ path, pattern: quiet.get(path) });
    else held.push(raw);
  }
  return [
    ...(held.length > 0 ? ['Taken back at capture:', ...held.map((p) => `- ${dropLine(p)}`)] : []),
    ...(taken.length > 0
      ? [
          'Taken back at capture, re-capturable:',
          ...taken.map((r) => `- ${recaptureLine(r)}`),
          RECAPTURE_NOTE,
        ]
      : []),
  ];
}

function triageRole(
  base,
  reds,
  priorOpen,
  brief,
  dropped = [],
  recaptured = [],
  probe = null,
  transient = null,
) {
  const lines = [
    'Classify the persistent red Tier-1 layers below into findings. Cluster reds that share one root cause into one finding.',
    'Class each finding — code-defect | suite-defect | env | harness — and cite evidence for every class.',
    'A suite-defect finding also carries a depth: "test" (the test mis-encodes the spec), "spec" (the spec is wrong), or "intent" (the conflict reaches the intent).',
    'Classify only; fix nothing.',
    `The spec: ${base.specRef}`,
    ...(base.cardAuthorizedSupersede && base.cardPath
      ? [
          `The intent card: ${base.cardPath} (in your working directory).`,
          'On an intent-depth finding, classify the collision before you report it:',
          ...SUPERSEDE_BRIEF_LINES,
        ]
      : []),
  ];
  if (priorOpen.length > 0) {
    lines.push(
      'Prior open findings — list the ids that persist in "persisting"; report only new findings in "findings".',
      '"persisting" takes only ids from this list, verbatim:',
    );
    for (const f of priorOpen) lines.push(`- [${f.id}] ${findingLine(f)}`);
  } else {
    lines.push(
      'This is a first cycle: no prior finding is open, so every red below is a new finding.',
      'The report takes no "persisting" field on this cycle; write "findings" and "summary" only.',
    );
  }
  lines.push(...takenBackLines(dropped, recaptured));
  if (transient) {
    lines.push(
      'The harness read these reds as a cause outside the tree before you were spawned, and',
      're-ran the failing files after 1, 5 and 15 minutes; they failed the same way each time.',
      'The signatures it matched:',
      ...transient.layers.map(
        (l) => `- ${l.layer}: ${l.signatures.join(', ')} in ${l.parts.join(', ')}`,
      ),
      'A code-defect finding whose only evidence is one of those signatures is refused: class',
      'it env, or cite an assertion failure or a compile error from the tree itself.',
    );
  }
  lines.push('Persistent reds:');
  for (const r of reds) {
    lines.push(
      `- layer ${r.layer}:`,
      ...exhaustionLines(r),
      ...credentialAbsentLines(r),
      ...redEvidence(r),
    );
  }
  if (probe) lines.push(...probeOfferLines(probe));
  lines.push(...briefLines(brief));
  return lines.join('\n');
}

/**
 * The attribution the harness made of a red before the seat read a line of it:
 * this layer declares a credential the host does not hold. It leads the
 * evidence because it decides what the rest of the output is worth — a suite
 * that stopped at its own credential guard printed a stop, not a defect.
 */
function credentialAbsentLines(r) {
  if (!r.credentialAbsent?.length) return [];
  return [
    `  the project declares this layer needs ${r.credentialAbsent.join(', ')}, and this host ` +
      'holds no value for it. The layer could not judge the tree.',
  ];
}

/**
 * The other attribution the harness made before the seat read anything: this
 * layer died of memory. It leads for the same reason the credential line does,
 * and for one more — the class was twice reasoned out by a seat over an hour
 * of an expensive round, on a fact the exit code and the measured peak had
 * already settled (ADR-0045). The seat is told, never asked.
 */
function exhaustionLines(r) {
  if (!r.exhaustion) return [];
  const held =
    typeof r.exhaustion.peakRssMb === 'number'
      ? `at ${r.exhaustion.peakRssMb} MB`
      : 'at a peak this host could not measure';
  const against =
    typeof r.exhaustion.ceilingMb === 'number'
      ? `, against the ${r.exhaustion.ceilingMb} MB ceiling the project declares for it`
      : '';
  return [
    `  this layer died of resource exhaustion ${held}${against} (${r.exhaustion.evidence}). ` +
      'The harness has already classed it and stamped it; it is an env defect of this host ' +
      'and not a defect of the tree. Do not spend a round attributing it — say what has to ' +
      'change for the layer to fit.',
  ];
}

/**
 * What a triage reads of one persistent red. A layer that ran in parts states
 * the failing part first and under its name: the tail of a sequence is the part
 * that ran last, and on a red in the middle that is the detail of the parts
 * that passed. The tail stays beside it, because it holds what the runner said
 * after every part was done. A layer that reported no parts reads as it always
 * did.
 */
function redEvidence(r) {
  const tail = r.output ?? '(no output)';
  // Everything below is a bound of some kind. The file is not, so it is named
  // beside them: a red in the middle of a long sequence is in that file
  // whether any tail here reached it or not (ADR-0043).
  const whole = r.log
    ? [`  the whole output of this layer is at ${r.log} — read it when the evidence below does not name the failure.`]
    : [];
  // The parts that are evidence, and not the layer's whole part table: a part
  // that passed, and a part this cycle carried, printed nothing here and
  // reading them out would bury the one that failed (ADR-0046).
  const evidence = (r.parts ?? []).filter((p) => p.output !== undefined);
  if (evidence.length === 0) return [...whole, tail];
  return [
    ...evidence.flatMap((p) => [`  part ${p.name}:`, p.output || '(no output)']),
    '  the layer, at the end of its run:',
    tail,
    ...whole,
  ];
}

function refreezeRole(base, findings, record, intentAnswer, ruled, brief) {
  const layers = new Set(findings.flatMap((f) => f.layers ?? []));
  const reds = (record?.spectrum ?? []).filter((r) => layers.has(r.layer));
  const lines = [
    'Verdict triage classed these persistent reds as suite defects: the frozen tests mis-encode the spec.',
    `Amend the tests so they encode the spec at: ${base.specRef}`,
    `Write test files only under: ${base.testPaths.join(', ')}. Touch nothing else.`,
    'In the report, list every amended suite file; list expected residual reds (none when the amended suite is green).',
  ];
  if (intentAnswer) {
    lines.push(
      intentAnswer.source === 'card'
        ? 'The intent card authorizes this amendment. Its own words are the authority, and the ' +
            'amendment reaches exactly as far as they do:'
        : 'An intent conflict was escalated and answered. The ruling is the authority for this amendment:',
      `- ${intentAnswer.option ?? intentAnswer.answer} (${intentAnswer.actor})`,
    );
    if (ruled.length > 0) {
      lines.push(
        'The ruling names these frozen test files. Amend each one here, in this step, ' +
          'exactly as the ruling directs and no further: this amendment is the only ' +
          'route a ruling has into the frozen suite, and a run that leaves them ' +
          'unchanged meets the same conflict again on the next verdict.',
        ...ruled.map((f) => `- ${f}`),
      );
    }
  }
  lines.push(
    'Suite-defect findings:',
    ...findings.map((f) => `- ${findingLine(f)}`),
    'Red layers:',
    ...reds.map((r) => `- ${r.layer}`),
    ...briefLines(brief),
  );
  return lines.join('\n');
}

function specAmendRole(base, findings, intentAnswer, ruled = [], defects = null) {
  const lines = [
    `Amend the born spec at this absolute path: ${base.specRef}`,
    'Edit the file in place. Keep unaffected sections unchanged.',
    'The spec keeps its template: one section per acceptance criterion, the test mappings, the named constants, the supersedes, and the single touched-paths block.',
    'Report the headings of every section you amended.',
    'Verdict triage found the spec wrong on these points:',
    ...findings.map((f) => `- ${findingLine(f)}`),
  ];
  if (intentAnswer) {
    lines.push(
      intentAnswer.source === 'card'
        ? 'The intent card authorizes a supersede; state it in the spec on the card\'s own words:'
        : 'An intent conflict was escalated and answered; honor the answer:',
      `- ${intentAnswer.option ?? intentAnswer.answer} (${intentAnswer.actor})`,
    );
    if (ruled.length > 0) {
      lines.push(
        'The ruling settles the conflict against these frozen test files, and the suite ' +
          'seat amends them in the step after yours. State the supersede in the spec so ' +
          'the amended test has a clause behind it:',
        ...ruled.map((f) => `- ${f}`),
      );
    }
  }
  lines.push(...briefLines(defects));
  return lines.join('\n');
}

function stallBrief(open) {
  return [
    'A prior implementation of this spec stalled and was discarded. Start fresh; do not reconstruct the prior approach.',
    'The stall left these findings open:',
    ...open.map((f) => `- ${findingLine(f)}`),
  ].join('\n');
}

/** What a layer line owes the reader beyond its status. */
function layerNote(r) {
  if (r.credentialAbsent?.length) return ` (credential absent: ${r.credentialAbsent.join(', ')})`;
  if (r.attributedTo) return ` (attributed to ${r.attributedTo})`;
  if (r.mode === 'carried') return ' (carried from an earlier cycle, not re-run)';
  // A layer that ran, of which some parts did not. The count is on the line
  // because the alternative is a green that reads as a whole layer's proof
  // when it is a proof of part of one (ADR-0046).
  const carried = (r.parts ?? []).filter((p) => p.mode === 'carried');
  if (carried.length === 0) return '';
  const from = [...new Set(carried.map((p) => p.carriedFrom))].sort((a, b) => a - b);
  return (
    ` (${carried.length} of ${r.parts.length} parts carried from ` +
    `cycle ${from.join(', ')}, not re-run)`
  );
}

// What a park asking for a ruling takes back. One statement, and it may rule
// on more than the conflict that raised the park: every finding the question
// lists carries its id for exactly that (ADR-0068).
const RULING_TEXT =
  'the decision the amendment must follow. Address any finding above by its id, and name the ' +
  'frozen test file to amend when the ruling reaches the suite; the amendment carries every ' +
  'ruling the answer gives';

/**
 * Every open finding of a render, by id, with its class, its severity and the
 * defect it states. The set the park asks about comes first, and the rest
 * follows in render order.
 *
 * A triage finding carries a class and no severity; a review finding carries a
 * lens and a severity, and `confirmed` is the only grading a triage finding
 * has. The line prints what the finding holds and says `unrated` where the
 * kind has no severity at all, rather than inventing one.
 */
function openFindingsBlock(open, first = []) {
  const ordered = [...first, ...open.filter((f) => !first.includes(f))];
  return ordered.map((f) => `- ${openFindingLine(f)}`).join('\n');
}

function openFindingLine(f) {
  const grade = f.severity ?? (f.confirmed === true ? 'confirmed' : 'unrated');
  const cls = f.class ?? f.lens ?? 'unclassed';
  const depth = f.depth ? ` ${f.depth}` : '';
  return `[${f.id}] [${cls}${depth}] ${grade} — ${f.summary} (evidence: ${f.evidence})`;
}

function findingLine(f) {
  const head = f.source === 'triage' ? `[${f.class}]` : `[${f.lens} ${f.severity}]`;
  return `${head} ${f.summary} (evidence: ${f.evidence})`;
}

// -- shared derivations ------------------------------------------------------

async function verdictBase(ctx, mode) {
  const config = await loadProjectConfig(ctx);
  const worktree = ctx.payload.worktree;
  const layers = config.gates.tier1;
  if (!Array.isArray(layers) || layers.length === 0) {
    return {
      fail: blocked(ctx, 'no-tier1-gates', 'The project config declares no Tier-1 gate layers.'),
    };
  }
  const events = runEvents(ctx);
  if (mode === 'story') {
    // Either anchor serves: a freeze this run earned, or one it inherited.
    // Both name the suite sha and the pre-implementation tree.
    const freeze = freezeAnchor(events);
    if (!freeze) {
      return {
        fail: blocked(ctx, 'no-freeze-record', 'The run holds no freeze record to judge against.'),
      };
    }
    return {
      config,
      worktree,
      layers,
      commands: config.commands,
      env: runEnv(ctx, config),
      testPaths: config.repo.testPaths,
      uiPaths: config.repo.uiPaths ?? [],
      routesRoot: config.repo.routesRoot ?? null,
      // The judgment panel this run is judged by, pinned at the launch blob
      // like every other config value the lane reads (ADR-0038).
      lenses: panelLenses(config),
      // The freeze's exclusions: test-path files the spec assigned to the dev
      // seat. They ride into the deny rules and out of every restore, and
      // nowhere else — the rest of the test paths stay the frozen suite.
      frozenExclusions: freezeExclusions(ctx.paths, ctx.runId),
      card: worktreeCard(worktree, ctx.payload.card),
      // The card as written, beside the card as parsed. A supersede
      // authorization rests on a line of prose, so the check reads the text
      // rather than the fields the parser keeps (ADR-0044).
      cardPath: typeof ctx.payload.card === 'string' ? ctx.payload.card : null,
      cardText: worktreeCardText(worktree, ctx.payload.card),
      ownerPins: freezeOwnerPins(ctx.paths, ctx.runId),
      cardAuthorizedSupersede: config.lanes?.story?.cardAuthorizedSupersede !== false,
      tier: laneDiffPolicy(config, 'story'),
      specRef: join(ctx.paths.runs, ctx.runId, 'spec.md'),
      // The tree the spec was written against. Every post-freeze amendment is
      // linted here too, and a Supersedes clause names a file as it stood at
      // this sha — the candidate's own commits have moved the worktree since.
      baseSha: typeof ctx.payload.baseSha === 'string' ? ctx.payload.baseSha : null,
      // The frozen suite by name. The re-freeze reads it to tell which files an
      // answered intent ruling names.
      frozenSuiteFiles: freezeSuiteFiles(ctx.paths, ctx.runId),
      suiteSha: currentSuiteSha(events),
      resetSha: freeze.sha,
      constitution: readConstitution(worktree, config),
    };
  }
  // The intake ticket is the spec. A repo-relative path names a committed
  // ticket; an absolute path names a daemon-home ticket (red-merge repair
  // spawns write these — the defect is not in the tree it escaped from). A
  // `stage-blocked` answer may hand over a corrected absolute path.
  const ticket = answeredPath(events, 'ticket-missing') ?? ctx.payload.ticket;
  const ticketPath =
    typeof ticket === 'string' ? (isAbsolute(ticket) ? ticket : join(worktree, ticket)) : null;
  if (!ticketPath || !existsSync(ticketPath)) {
    return {
      fail: blocked(
        ctx,
        'ticket-missing',
        `No intake ticket at ${ticketPath ?? '(no path)'}. Answer "retry" after placing ` +
          'the ticket, answer with a corrected absolute ticket path, or "abandon" to ' +
          'close the run.',
        {
          text: 'a corrected absolute ticket path',
          ...(typeof ticket === 'string' && { ticket }),
        },
      ),
    };
  }
  return {
    config,
    worktree,
    layers,
    commands: config.commands,
    env: runEnv(ctx, config),
    testPaths: config.repo.testPaths ?? [],
    uiPaths: config.repo.uiPaths ?? [],
    lenses: panelLenses(config),
    specRef: ticketPath,
    suiteSha: null,
    resetSha: ctx.payload.baseSha,
    constitution: readConstitution(worktree, config),
  };
}

/**
 * The run's intent card, read from the worktree. The spec lint judges the spec
 * against it, and a card it cannot read leaves the lint with nothing to judge
 * against, so this answers null rather than an empty card.
 */
function worktreeCard(worktree, cardPath) {
  const text = worktreeCardText(worktree, cardPath);
  return text === null ? null : parseIntentCard(text).card;
}

/** The card's text, or null. A card nothing can read authorizes nothing. */
function worktreeCardText(worktree, cardPath) {
  if (typeof cardPath !== 'string' || cardPath.length === 0) return null;
  try {
    return readFileSync(join(worktree, cardPath), 'utf8');
  } catch {
    return null;
  }
}

function currentSuiteSha(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 're-freeze' || e.event === 'freeze' || e.event === 'freeze-inherited') {
      return e.sha;
    }
  }
  return null;
}

/**
 * The sha every suite restore checks out from.
 *
 * The restore covers the whole of the test paths and not the freeze's own file
 * list, which is what makes it structural: a write to any test-path file is
 * undone whether or not the freeze authored that file. The anchor therefore
 * decides the content of every test-path file the run never wrote, and it has
 * to name the tree the candidate ships onto.
 *
 * Before the tree merges the default branch, that tree is the freeze commit.
 * After it, the merge commit holds the frozen suite and the default branch's
 * later work in one tree, and the freeze commit describes a tree that stopped
 * existing: restoring from it reverts every test-path file the default branch
 * advanced since the run launched, so a candidate that merged a green default
 * branch turns red against work that shipped before it (ADR-0033).
 *
 * A fresh pass resets the tree and stamps the commit it was born on, which is
 * the anchor from there: the suite commit for a pass reset to the
 * pre-implementation tree, and for a merge-born pass the commit that carried
 * the frozen suite onto the updated default branch — a single sha cannot say
 * "the default branch plus the freeze", so the pass composes one that can. A
 * pass from a ledger written before the stamp existed falls back to the suite
 * commit, which is where its restores went.
 *
 * @param {object[]} events the run's ledger events, in order
 * @returns {string|null} the sha, or null when the run holds no freeze
 */
export function restoreAnchor(events) {
  let suite = null;
  let anchor = null;
  for (const e of events) {
    if (e.event === 'freeze' || e.event === 'freeze-inherited' || e.event === 're-freeze') {
      suite = e.sha;
      anchor = e.sha;
    } else if (e.event === 'branch-update' || (e.event === 'pre-verdict-update' && e.ran === true)) {
      if (typeof e.toSha === 'string') anchor = e.toSha;
    } else if (e.event === 'fresh-pass') {
      anchor = typeof e.sha === 'string' ? e.sha : suite;
    }
  }
  return anchor;
}

export function currentPass(events) {
  let pass = 0;
  for (const e of events) {
    if (e.event === 'implementation-committed' && e.pass > pass) pass = e.pass;
  }
  return pass;
}

function lastImplementation(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === 'implementation-committed') return events[i];
  }
  return null;
}

function lastRenderSeq(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === 'verdict-rendered') return events[i].seq;
  }
  return 0;
}

function eventsAfter(events, seq) {
  return events.filter((e) => e.seq > seq);
}

/** Every non-advisory finding by id, rebuilt from the ledger. */
export function findingIndex(events) {
  const index = new Map();
  for (const e of events) {
    if (e.event !== 'finding' || e.advisory) continue;
    index.set(e.id, findingFromEvent(e));
  }
  return index;
}

function findingFromEvent(e) {
  return {
    id: e.id,
    source: e.source,
    ...(e.class && { class: e.class }),
    ...(e.depth && { depth: e.depth }),
    ...(e.layers && { layers: e.layers }),
    ...(e.lens && { lens: e.lens }),
    ...(e.severity && { severity: e.severity }),
    summary: e.summary,
    evidence: e.evidence,
    ...(e.confirmed !== undefined && { confirmed: e.confirmed }),
    ...(e.approach && { approach: true }),
    // The ladder re-derives every finding from the ledger, so a claim the
    // triage seat made has to survive the round trip or the collision it
    // settled reads as silence on the next entry (ADR-0044).
    ...(e.supersede && { supersede: e.supersede }),
  };
}

export function answerCount(events, parkType, option) {
  const parkSeqs = new Set(
    events.filter((e) => e.event === 'park' && e.type === parkType).map((e) => e.seq),
  );
  return events.filter(
    (e) => e.event === 'answer' && parkSeqs.has(e.parkSeq) && e.option === option,
  ).length;
}
