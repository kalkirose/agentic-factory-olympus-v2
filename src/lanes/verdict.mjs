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
import { isAbsolute, join } from 'node:path';
import { runReportPath } from '../daemon/home.mjs';
import {
  changedFiles,
  commitAll,
  headSha,
  restorePaths,
  diffRange,
  changedInRange,
  resetHard,
} from '../isolation/tree.mjs';
import { testEditDenyRules } from '../seats/boundary.mjs';
import {
  DROP_NOTE,
  RECAPTURE_NOTE,
  captureGist,
  classifyTakeBacks,
  diffPolicyViolations,
  dropLine,
  laneDiffPolicy,
  parseTouchedPaths,
  recaptureGist,
  recaptureLine,
  violationLine,
} from '../seats/diffpolicy.mjs';
import {
  ACK_OPTION,
  coveringAck,
  findingFingerprint,
  isAckable,
  standingAcksFor,
} from '../ledger/acks.mjs';
import { cycleRepeat, openIdentities } from '../ledger/cycles.mjs';
import { runSpectrum, persistentReds, cyclePlan } from './spectrum.mjs';
import { substrateGate } from './substrate.mjs';
import { furyRound, generalistReview } from './review.mjs';
import { freezeAnchor } from './resume.mjs';
import { parseIntentCard } from './card.mjs';
import { SUITE_SCHEMA, SPEC_AMEND_SCHEMA, specLintDefects } from './story.mjs';
import {
  ACTOR,
  loadProjectConfig,
  readConstitution,
  runEnv,
  runEvents,
  answeredPark,
  freezeExclusions,
  seatReportAfter,
  readJson,
  parkDirective,
  GATE_FORMS,
  withAbandonGuard,
  attemptLimit,
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
    handlers: withAbandonGuard({
      fix: implementationHandler('repair'),
      verdict: verdictHandler('repair', afterVerdict.stages[0]),
      ...afterVerdict.handlers,
    }),
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
        },
        required: ['class', 'layers', 'summary', 'evidence'],
      },
    },
    persisting: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['findings', 'persisting', 'summary'],
};

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
    for (;;) {
      const events = runEvents(ctx);
      const renders = events.filter((e) => e.event === 'verdict-rendered');
      const last = renders[renders.length - 1];
      const needCycle =
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
    cycle,
    sha,
  };
  // What this cycle runs, and what it carries (ADR-0022).
  const plan = cyclePlan(startEvents, { cycle, pass, layers: base.layers });
  let spectrum = await runSpectrum(ctx, { ...gates, run: plan.run, prior: plan.prior });
  if (spectrum.error) return { directive: gateCommandError(ctx, spectrum.error) };
  let reds = persistentReds(spectrum.results);

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
  const priorConfirmed = priorOpen.filter((f) => f.confirmed);
  let reviewOpen = priorConfirmed;
  if (newTree) {
    const diffText = await diffRange(base.worktree, impl.baseSha, impl.sha);
    const diffFiles = await changedInRange(base.worktree, impl.baseSha, impl.sha);
    const round =
      mode === 'story'
        ? await furyRound(ctx, base, { cycle, diffText, diffFiles })
        : await generalistReview(ctx, base, { cycle, diffText, priorConfirmed: [] });
    if (round.fail) return { directive: round.fail };
    reviewOpen = round.confirmed;
  } else if (repaired) {
    const diffText = await diffRange(base.worktree, impl.baseSha, impl.sha);
    const round = await generalistReview(ctx, base, { cycle, diffText, priorConfirmed });
    if (round.fail) return { directive: round.fail };
    reviewOpen = [
      ...priorConfirmed.filter((f) => !round.resolved.includes(f.id)),
      ...round.confirmed,
    ];
  }

  let open = [...triageOpen, ...reviewOpen];

  // The confirmation sweep: a targeted cycle proves nothing about the layers
  // it carried, so no green verdict rests on them. A clean targeted cycle
  // therefore runs every layer it has not run yet, at this sha, before the
  // record calls the tree green. A red the sweep turns up is a regression an
  // edit left in an area no red pointed at, and it enters triage exactly like
  // a first-cycle red.
  if (plan.sweep === 'targeted' && reds.length === 0 && open.length === 0) {
    const confirmed = await runSpectrum(ctx, { ...gates, confirmation: true });
    if (confirmed.error) return { directive: gateCommandError(ctx, confirmed.error) };
    spectrum = confirmed;
    reds = persistentReds(confirmed.results);
    if (reds.length > 0) {
      const triaged = await triageStep(ctx, base, { cycle, reds, priorOpen: triagePrior, dropped });
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
  const record = {
    runId: ctx.runId,
    cycle,
    pass,
    sha,
    ...(suiteSha && { suiteSha }),
    sweep: plan.sweep,
    ...(confirmation && { confirmation: true }),
    // The capture took these paths back before this tree was committed, so a
    // red on the surface they cover is explained, not mysterious.
    ...(dropped.length > 0 && { dropped }),
    spectrum: spectrum.results.map(({ output, ...r }) => r),
    flakes: runEvents(ctx)
      .filter((e) => e.event === 'flake' && e.cycle === cycle)
      .map((e) => e.layer),
    findings: [
      ...open.map((f) => ({ ...f, status: 'open' })),
      ...resolvedNow.map((f) => ({ ...f, status: 'resolved' })),
    ],
    open: openIds,
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
    ...(confirmation && { confirmation: true }),
    ...(dropped.length > 0 && { dropped }),
    verdict,
    open: openIds,
    record: recordPath,
  });
  return {};
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
 */
export async function triageStep(ctx, base, { cycle, reds, priorOpen, dropped = [] }) {
  const events = runEvents(ctx);
  const stamped = events.filter(
    (e) => e.event === 'finding' && e.cycle === cycle && e.source === 'triage',
  );
  // A retry the human bought re-invokes the seat: the stamped report is the
  // one the checks refused, so replaying it buys nothing.
  const retrying = attemptLimit(events, 'verdict-triage') === 1;
  if (stamped.length > 0 || (!retrying && triageReportedFor(ctx, cycle))) {
    // Resumed after the stamp (or after an empty-findings report): rebuild.
    const report = readJson(runReportPath(ctx.paths, ctx.runId, `verdict-triage-c${cycle}`)) ?? {};
    const persisting = new Set(report.persisting ?? []);
    return {
      open: [
        ...priorOpen.filter((f) => persisting.has(f.id)),
        ...stamped.map((e) => findingFromEvent(e)),
      ],
    };
  }
  const redLayers = reds.map((r) => r.layer);
  const { report, fail } = await seatWithChecks(ctx, {
    seat: 'verdict-triage',
    label: `verdict-triage-c${cycle}`,
    schema: TRIAGE_SCHEMA,
    cwd: base.worktree,
    env: base.env,
    constitution: base.constitution,
    buildRole: (brief) => triageRole(base, reds, priorOpen, brief, dropped),
    checks: (r) => triageChecks(r, { redLayers, priorOpen }),
  });
  if (fail) return { fail };
  let nextId = 1 + runEvents(ctx).filter((e) => e.event === 'finding').length;
  const fresh = [];
  for (const f of report.findings) {
    const finding = {
      id: `F${nextId++}`,
      source: 'triage',
      class: f.class,
      ...(f.depth && { depth: f.depth }),
      layers: f.layers,
      summary: f.summary,
      evidence: f.evidence,
    };
    ctx.store.append('finding', {
      actor: ACTOR,
      cycle,
      ...finding,
      summary: gist(finding.summary),
      evidence: gist(finding.evidence),
    });
    if (f.class === 'harness') {
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
  const persisting = new Set(report.persisting);
  return { open: [...priorOpen.filter((f) => persisting.has(f.id)), ...fresh] };
}

function triageReportedFor(ctx, cycle) {
  const path = runReportPath(ctx.paths, ctx.runId, `verdict-triage-c${cycle}`);
  return runEvents(ctx).some(
    (e) => e.event === 'seat-report' && e.seat === 'verdict-triage' && e.path === path,
  );
}

function triageChecks(report, { redLayers, priorOpen }) {
  const defects = [];
  const priorIds = new Set(priorOpen.map((f) => f.id));
  for (const id of report.persisting) {
    if (!priorIds.has(id)) defects.push(`persisting id is not an open prior finding: ${id}`);
  }
  const covered = new Set([
    ...report.findings.flatMap((f) => f.layers),
    ...priorOpen.filter((f) => report.persisting.includes(f.id)).flatMap((f) => f.layers ?? []),
  ]);
  for (const layer of redLayers) {
    if (!covered.has(layer)) defects.push(`persistent red layer not covered by a finding: ${layer}`);
  }
  for (const f of report.findings) {
    for (const layer of f.layers) {
      if (!redLayers.includes(layer)) {
        defects.push(`finding names a layer that is not a persistent red: ${layer}`);
      }
    }
    if (f.class === 'suite-defect' && !f.depth) {
      defects.push(`suite-defect finding needs a depth (test | spec | intent): ${f.summary}`);
    }
  }
  return defects;
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
  const index = findingIndex(events);
  const open = last.open.map((id) => index.get(id)).filter(Boolean);
  const suiteDefects = mode === 'story' ? open.filter((f) => f.class === 'suite-defect') : [];
  const intent = suiteDefects.filter((f) => f.depth === 'intent');
  const ops = open.filter((f) => f.class === 'env' || f.class === 'harness');
  const code = open.filter(
    (f) =>
      f.confirmed === true ||
      f.class === 'code-defect' ||
      (mode !== 'story' && f.class === 'suite-defect'),
  );
  let acted = false;

  // Intent-level conflicts escalate; the answer directs the spec amendment.
  let intentAnswer = null;
  if (intent.length > 0) {
    const park = answeredPark(events, 'intent-conflict');
    if (!park?.answer || park.answer.seq < last.seq) {
      return parkDirective('intent-conflict', {
        question:
          'Verdict triage found an intent-level suite conflict:\n' +
          intent.map((f) => `- ${f.summary} (evidence: ${f.evidence})`).join('\n'),
        text: 'the decision the spec amendment must follow',
        refs: [last.record],
      });
    }
    intentAnswer = park.answer;
  }

  // Env / harness → operational fix; a finding that persists after its fix
  // waits on the human (the substrate needs provisioning the daemon must
  // never self-clear).
  if (ops.length > 0) {
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
      if (!park?.answer || park.answer.seq < last.seq) {
        // The gate the operator already answered. Every finding it would ask
        // about is a harness defect somebody recorded as known, so the lane
        // answers on that authority and stamps twice: the ack it used, and the
        // fix that stands on it. A first gate for a fingerprint finds no ack
        // and reaches the human, which is where an ack comes from (ADR-0032).
        const standing = standingAcksFor(ctx.paths, ctx.project);
        const used = ops.map((f) => coveringAck(standing, f));
        if (!used.every(Boolean)) return gateFor(ops, last);
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
    const prevRender = renders[renders.length - 2];
    const window = prevRender ? eventsAfter(events, prevRender.seq).filter((e) => e.seq < last.seq) : [];
    suiteStalled =
      window.some((e) => e.event === 're-freeze') &&
      suiteDefects.some((f) => prevRender.open.includes(f.id));
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

  // Code findings → repair rounds, progress-gated; stall or a confirmed
  // approach-level finding takes the one fresh pass; a second stall parks.
  if (code.length > 0 || suiteStalled) {
    const pass = currentPass(events);
    const rounds = events.filter((e) => e.event === 'repair-round' && e.pass === pass).length;
    const grants = answerCount(events, 'second-stall', 'repair-again');
    const approach = code.find((f) => f.approach === true);
    const noProgress = repairStalled(events, renders, last);
    const capExhausted = rounds >= REPAIR_CAP + grants;
    if (approach || noProgress || capExhausted || suiteStalled) {
      const reason = approach
        ? 'approach-finding'
        : noProgress
          ? 'no-progress'
          : suiteStalled
            ? 're-freeze-no-progress'
            : 'cap-exhausted';
      if (reason !== 'approach-finding' && !events.some((e) => e.event === 'stall' && e.seq > last.seq)) {
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
const ACK_NOTE =
  'Answer "ack" to record every harness finding above as known and deferred, ' +
  'by the fingerprint beside it: a later gate whose findings are all ' +
  'acknowledged answers itself, on the record, and never reaches you. An ack ' +
  'stands until `olympusctl revoke` names its fingerprint and the fix behind ' +
  'it — a restart never clears one.';

/**
 * The provisioning gate for a set of persisting findings. It offers `ack`
 * only when it names a finding an ack may cover, and then it carries those
 * fingerprints on the record: the answer records what the record names
 * (ADR-0032).
 */
function gateFor(ops, last) {
  const offered = ops.filter(isAckable).map((f) => ({
    fingerprint: findingFingerprint(f),
    class: f.class,
    summary: gist(f.summary),
  }));
  const line = (f) =>
    `- [${f.class}] ${f.summary} (evidence: ${f.evidence})` +
    (isAckable(f) ? ` · ${findingFingerprint(f)}` : '');
  return parkDirective('provisioning-gate', {
    ...GATE_FORMS,
    ...(offered.length > 0 && {
      options: [...GATE_FORMS.options, ACK_OPTION],
      acks: offered,
    }),
    question:
      'These findings persist after an operational fix; confirm the substrate is repaired:\n' +
      ops.map(line).join('\n') +
      (offered.length > 0 ? `\n${ACK_NOTE}` : ''),
    refs: [last.record],
  });
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
  const result = await runDevSeat(ctx, base, mode, {
    seat: 'repair-dev',
    buildRole: (brief) => repairRole(base, open, record, brief),
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
    // The fresh pass never sees the prior tree: reset to the pre-
    // implementation state, then carry the current frozen suite forward.
    // The reset drops any merge the tree held, so the carry reads the suite
    // commit rather than the restore anchor, and the stamp below takes every
    // later restore of this pass back to the same commit.
    // The stamp lands last, so a restart before it redoes the (idempotent)
    // reset instead of skipping it.
    await resetHard(base.worktree, base.resetSha);
    if (mode === 'story') {
      const suiteSha = currentSuiteSha(events);
      await restorePaths(base.worktree, suiteSha, base.testPaths, { except: base.frozenExclusions });
      await commitAll(base.worktree, `suite carry: ${ctx.runId}`);
    }
    ctx.store.append('fresh-pass', { actor: ACTOR, pass: newPass, trigger });
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
  // Spec-deep defects amend the born spec first; the answered intent
  // conflict rides the same amendment.
  const deep = findings.filter((f) => f.depth === 'spec' || f.depth === 'intent');
  if (deep.length > 0 && !seatReportAfter(events, 'spec-birth', lastRenderSeq(events))) {
    // The template holds after the freeze too: this amendment is re-linted
    // like every other one, and a defect takes the corrective route (ADR-0019).
    const amend = await seatWithChecks(ctx, {
      seat: 'spec-birth',
      schema: SPEC_AMEND_SCHEMA,
      cwd: base.worktree,
      env: base.env,
      constitution: base.constitution,
      buildRole: (defects) => specAmendRole(base, deep, intentAnswer, defects),
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
    buildRole: (brief) => refreezeRole(base, findings, record, brief),
    checks: async (r) => {
      const defects = [];
      if (r.suiteFiles.length === 0) defects.push('no suite files declared');
      for (const file of r.suiteFiles) {
        if (!underAny(file, base.testPaths)) defects.push(`suite file outside the test paths: ${file}`);
        else if (!existsSync(join(base.worktree, file))) defects.push(`declared suite file missing: ${file}`);
      }
      for (const file of await changedFiles(base.worktree)) {
        if (!underAny(file, base.testPaths)) defects.push(`change outside the test paths: ${file}`);
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
    sha,
    files: report.suiteFiles,
    findings: findings.map((f) => f.id),
  });
  return {};
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
 * Take-backs come in two record classes, and nothing else about them differs.
 * A path the lane declared `recapturablePaths` is an artifact a re-freeze
 * re-takes, so it stamps the quiet `diff-policy-recapture`; every other frozen
 * path stamps the loud record. The revert, `capture.dropped` and every
 * downstream statement cover both classes.
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
  const dropped =
    mode === 'story'
      ? changed.filter((f) => underAny(f, base.testPaths) && !exempt.includes(f))
      : [];
  if (mode === 'story') {
    await restorePaths(base.worktree, restoreAnchor(runEvents(ctx)), base.testPaths, {
      except: exempt,
    });
  }
  // Across the attempts of one seat pass, not just the last one: a write the
  // first capture took back is gone from the commit the corrective attempt
  // produces, and the commit record has to say so.
  for (const path of dropped) if (!capture.dropped.includes(path)) capture.dropped.push(path);
  const tier = laneDiffPolicy(base.config, mode);
  const kept = changed.filter((f) => !dropped.includes(f));
  const violations = diffPolicyViolations(kept, tier, declaresPath(base, mode, tier));
  // The two classes of take-back part here, and only in the record: the quiet
  // class is reverted, committed around and stated downstream exactly like the
  // loud one.
  const { recaptured, held } = classifyTakeBacks(dropped, tier);
  if (recaptured.length > 0) {
    ctx.store.append('diff-policy-recapture', {
      actor: ACTOR,
      seat,
      lane: mode,
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
      ...(held.length > 0 && { note: DROP_NOTE, droppedLines: held.map(dropLine) }),
      gist: gist(captureGist({ violations, dropped: held })),
    });
  }
  if (violations.length === 0) return [];
  return [...violations.map(violationLine), ...dropped.map(dropLine)];
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

function repairRole(base, open, record, brief = null) {
  return [
    'Repair the candidate tree in place. Fix every open finding below; change nothing else.',
    `The spec: ${base.specRef}`,
    'Do not edit or delete test files.',
    'Open findings:',
    ...open.map((f) => `- ${findingLine(f)}`),
    'Tier-1 verdict:',
    ...(record?.spectrum ?? []).map((r) => `- ${r.layer}: ${r.status}${layerNote(r)}`),
    ...takenBackLines(record?.dropped),
    'Do not commit; the orchestrator commits your work.',
    ...briefLines(brief),
  ].join('\n');
}

/**
 * What the capture took back, stated to a seat that is about to read a tree
 * the take-back already changed. The seat that wrote the file is gone; this
 * seat must not repeat the write, and the lines say why and where the route
 * is instead.
 */
function takenBackLines(dropped) {
  if (!dropped?.length) return [];
  return ['Taken back at capture:', ...dropped.map((p) => `- ${dropLine(p)}`)];
}

function triageRole(base, reds, priorOpen, brief, dropped = []) {
  const lines = [
    'Classify the persistent red Tier-1 layers below into findings. Cluster reds that share one root cause into one finding.',
    'Class each finding — code-defect | suite-defect | env | harness — and cite evidence for every class.',
    'A suite-defect finding also carries a depth: "test" (the test mis-encodes the spec), "spec" (the spec is wrong), or "intent" (the conflict reaches the intent).',
    'Classify only; fix nothing.',
    `The spec: ${base.specRef}`,
  ];
  if (priorOpen.length > 0) {
    lines.push('Prior open findings — list the ids that persist in "persisting"; report only new findings in "findings":');
    for (const f of priorOpen) lines.push(`- [${f.id}] ${findingLine(f)}`);
  }
  lines.push(...takenBackLines(dropped));
  lines.push('Persistent reds:');
  for (const r of reds) {
    lines.push(`- layer ${r.layer}:`, r.output ?? '(no output)');
  }
  lines.push(...briefLines(brief));
  return lines.join('\n');
}

function refreezeRole(base, findings, record, brief) {
  const layers = new Set(findings.flatMap((f) => f.layers ?? []));
  const reds = (record?.spectrum ?? []).filter((r) => layers.has(r.layer));
  return [
    'Verdict triage classed these persistent reds as suite defects: the frozen tests mis-encode the spec.',
    `Amend the tests so they encode the spec at: ${base.specRef}`,
    `Write test files only under: ${base.testPaths.join(', ')}. Touch nothing else.`,
    'In the report, list every amended suite file; list expected residual reds (none when the amended suite is green).',
    'Suite-defect findings:',
    ...findings.map((f) => `- ${findingLine(f)}`),
    'Red layers:',
    ...reds.map((r) => `- ${r.layer}`),
    ...briefLines(brief),
  ].join('\n');
}

function specAmendRole(base, findings, intentAnswer, defects = null) {
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
      'An intent conflict was escalated and answered; honor the answer:',
      `- ${intentAnswer.option ?? intentAnswer.answer} (${intentAnswer.actor})`,
    );
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
  if (r.attributedTo) return ` (attributed to ${r.attributedTo})`;
  return r.mode === 'carried' ? ' (carried from an earlier cycle, not re-run)' : '';
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
      // The freeze's exclusions: test-path files the spec assigned to the dev
      // seat. They ride into the deny rules and out of every restore, and
      // nowhere else — the rest of the test paths stay the frozen suite.
      frozenExclusions: freezeExclusions(ctx.paths, ctx.runId),
      card: worktreeCard(worktree, ctx.payload.card),
      tier: laneDiffPolicy(config, 'story'),
      specRef: join(ctx.paths.runs, ctx.runId, 'spec.md'),
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
  if (typeof cardPath !== 'string' || cardPath.length === 0) return null;
  try {
    return parseIntentCard(readFileSync(join(worktree, cardPath), 'utf8')).card;
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
 * A fresh pass resets the tree to the pre-implementation commit and drops the
 * merge with it, so the anchor goes back to the suite commit; the update stage
 * merges again on that pass's way to its own verdict.
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
      anchor = suite;
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
