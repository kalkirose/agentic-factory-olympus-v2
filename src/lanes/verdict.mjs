// The post-freeze chain: implementation (seat) → verdict (the full-spectrum
// loop with its response ladder). `postFreeze({afterVerdict})` composes the
// story-lane continuation; `repairLane({afterVerdict})` wires the repair
// variant — the intake ticket is the spec, the generalist review seat
// replaces the Fury fan-out, and the dev seat may edit tests (it writes the
// regression test).
//
// The verdict loop per cycle: full Tier-1 spectrum with the flake filter →
// verdict triage on persistent reds → the judgment review (Fury once per
// implementation pass; generalist review on repair diffs) → the verdict
// record. The response ladder acts on the rendered verdict: repair rounds
// (progress-gated, cap 3), suite-defect re-freeze, env/harness operational
// fixes, one fresh pass per run, and the second-stall escalation. Re-freeze
// steps and operational fixes never consume implementation budget.
//
// Every handler re-derives its position from the run ledger and the git
// state, so a daemon restart resumes mid-verdict without memory.
import { existsSync, writeFileSync } from 'node:fs';
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
import { runSpectrum, persistentReds } from './spectrum.mjs';
import { furyRound, generalistReview } from './review.mjs';
import { SUITE_SCHEMA, SPEC_AMEND_SCHEMA } from './story.mjs';
import {
  ACTOR,
  loadProjectConfig,
  runEnv,
  runEvents,
  answeredPark,
  invocationCount,
  seatReportAfter,
  readJson,
  parkDirective,
  seatFail,
  underAny,
  briefLines,
  gist,
} from './shared.mjs';

const REPAIR_CAP = 3;
const TRIAGE_CLASSES = ['code-defect', 'suite-defect', 'env', 'harness'];

/**
 * The story-lane continuation after the freeze. `afterVerdict` supplies the
 * ship stages, landing with their milestone.
 * @param {{afterVerdict: {stages: string[], handlers: object}}} opts
 */
export function postFreeze({ afterVerdict }) {
  requireContinuation(afterVerdict, 'postFreeze');
  return {
    stages: ['implementation', 'verdict', ...afterVerdict.stages],
    handlers: {
      implementation: implementationHandler('story'),
      verdict: verdictHandler('story', afterVerdict.stages[0]),
      ...afterVerdict.handlers,
    },
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
    handlers: {
      fix: implementationHandler('repair'),
      verdict: verdictHandler('repair', afterVerdict.stages[0]),
      ...afterVerdict.handlers,
    },
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
    const n = invocationCount(events, 'dev') + 1;
    const result = await ctx.runSeat({
      seat: 'dev',
      roleBlock: mode === 'story' ? devRole(base) : fixRole(base),
      reportPath: runReportPath(ctx.paths, ctx.runId, `dev-${n}`),
      schema: DEV_SCHEMA,
      cwd: base.worktree,
      env: base.env,
      ...(mode === 'story' && { denyTools: testEditDenyRules(base.testPaths) }),
    });
    if (!result.ok) return seatFail('dev', result);
    // Structural test-edit guarantee: the frozen suite is restored from its
    // sha before the tree is committed or judged.
    if (mode === 'story') await restorePaths(base.worktree, base.suiteSha, base.testPaths);
    const sha = await commitAll(base.worktree, `implement: ${ctx.runId}`);
    ctx.store.append('implementation-committed', {
      actor: ACTOR,
      pass: 1,
      phase: 'initial',
      baseSha,
      sha,
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
              e.event === 'operational-fix'),
        );
      if (needCycle) {
        const outcome = await runCycle(ctx, base, mode, { cycle: renders.length + 1 });
        if (outcome.directive) return outcome.directive;
        continue;
      }
      if (last.verdict === 'green') return { next: nextStage };
      const directive = await ladder(ctx, base, mode, { events, renders, last });
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
  if (mode === 'story') await restorePaths(base.worktree, suiteSha, base.testPaths);
  const sha = await headSha(base.worktree);
  const spectrum = await runSpectrum(ctx, {
    layers: base.layers,
    commands: base.commands,
    cwd: base.worktree,
    env: base.env,
    cycle,
    sha,
  });
  if (spectrum.error) {
    return {
      directive: { close: { state: 'failed', reason: 'gate-command-error', error: spectrum.error } },
    };
  }
  const reds = persistentReds(spectrum.results);

  const events = runEvents(ctx);
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  const prevRender = renders[renders.length - 1];
  const index = findingIndex(events);
  const priorOpen =
    prevRender && prevRender.pass === pass
      ? prevRender.open.map((id) => index.get(id)).filter(Boolean)
      : [];

  // Verdict triage fires only when persistent reds exist. Findings from a
  // green spectrum resolve mechanically: their evidence is gone.
  let triageOpen = [];
  if (reds.length > 0) {
    const triaged = await triageStep(ctx, base, {
      cycle,
      reds,
      priorOpen: priorOpen.filter((f) => f.source === 'triage'),
    });
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

  const open = [...triageOpen, ...reviewOpen];
  const openIds = open.map((f) => f.id);
  resolveGateIntegrity(ctx, openIds);
  const resolvedNow = priorOpen.filter((f) => !openIds.includes(f.id));
  const verdict = reds.length === 0 && open.length === 0 ? 'green' : 'red';
  const record = {
    runId: ctx.runId,
    cycle,
    pass,
    sha,
    ...(suiteSha && { suiteSha }),
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
    verdict,
    open: openIds,
    record: recordPath,
  });
  return {};
}

// -- verdict triage (seat) ---------------------------------------------------

/**
 * The shared four-class triage over persistent reds. The ship step calls it
 * with CI checks as the red layers (`ci:<check>`); the routes stay the same.
 */
export async function triageStep(ctx, base, { cycle, reds, priorOpen }) {
  const stamped = runEvents(ctx).filter(
    (e) => e.event === 'finding' && e.cycle === cycle && e.source === 'triage',
  );
  if (stamped.length > 0 || triageReportedFor(ctx, cycle)) {
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
    buildRole: (brief) => triageRole(base, reds, priorOpen, brief),
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

async function ladder(ctx, base, mode, { events, renders, last }) {
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
        refs: [last.record],
      });
    }
    intentAnswer = park.answer;
  }

  // Env / harness → operational fix; a finding that persists after its fix
  // waits on the human (the substrate needs provisioning the daemon must
  // never self-clear).
  if (ops.length > 0) {
    const fixedIds = new Set(
      events.filter((e) => e.event === 'operational-fix').flatMap((e) => e.findings ?? []),
    );
    const unfixed = ops.filter((f) => !fixedIds.has(f.id));
    if (unfixed.length > 0) {
      ctx.store.append('operational-fix', {
        actor: ACTOR,
        findings: unfixed.map((f) => f.id),
        layers: [...new Set(unfixed.flatMap((f) => f.layers ?? []))],
      });
      acted = true;
    } else {
      const park = answeredPark(events, 'provisioning-gate');
      if (!park?.answer || park.answer.seq < last.seq) {
        return parkDirective('provisioning-gate', {
          question:
            'These findings persist after an operational fix; confirm the substrate is repaired:\n' +
            ops.map((f) => `- [${f.class}] ${f.summary} (evidence: ${f.evidence})`).join('\n'),
          refs: [last.record],
        });
      }
      ctx.store.append('operational-fix', {
        actor: park.answer.actor,
        findings: ops.map((f) => f.id),
        source: 'answer',
      });
      acted = true;
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
          options: ['repair-again', 'fresh-pass', 'fail'],
          refs: [last.record],
        });
      }
      if (park.answer.option === 'fail') {
        return { close: { state: 'failed', reason: 'second-stall' } };
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

/** The progress rule: a repair round must strictly shrink the open set. */
function repairStalled(events, renders, last) {
  const prevRender = renders[renders.length - 2];
  if (!prevRender || prevRender.pass !== last.pass) return false;
  const window = eventsAfter(events, prevRender.seq).filter((e) => e.seq < last.seq);
  if (!window.some((e) => e.event === 'repair-round')) return false;
  return last.open.length >= prevRender.open.length;
}

// -- ladder arms -------------------------------------------------------------

async function repairRound(ctx, base, mode, { pass, round, open, record }) {
  const result = await runDevSeat(ctx, base, mode, {
    seat: 'repair-dev',
    roleBlock: repairRole(base, open, record),
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
    // The stamp lands last, so a restart before it redoes the (idempotent)
    // reset instead of skipping it.
    await resetHard(base.worktree, base.resetSha);
    if (mode === 'story') {
      const suiteSha = currentSuiteSha(events);
      await restorePaths(base.worktree, suiteSha, base.testPaths);
      await commitAll(base.worktree, `suite carry: ${ctx.runId}`);
    }
    ctx.store.append('fresh-pass', { actor: ACTOR, pass: newPass, trigger });
  }
  const result = await runDevSeat(ctx, base, mode, {
    seat: 'dev',
    roleBlock: mode === 'story' ? devRole(base, stallBrief(open)) : fixRole(base, stallBrief(open)),
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
async function runDevSeat(ctx, base, mode, { seat, roleBlock, pass = null, phase = null }) {
  const events = runEvents(ctx);
  const baseSha = await headSha(base.worktree);
  const n = invocationCount(events, seat) + 1;
  const result = await ctx.runSeat({
    seat,
    roleBlock,
    reportPath: runReportPath(ctx.paths, ctx.runId, `${seat}-${n}`),
    schema: DEV_SCHEMA,
    cwd: base.worktree,
    env: base.env,
    ...(mode === 'story' && { denyTools: testEditDenyRules(base.testPaths) }),
  });
  if (!result.ok) return { fail: seatFail(seat, result) };
  if (mode === 'story') {
    await restorePaths(base.worktree, currentSuiteSha(runEvents(ctx)), base.testPaths);
  }
  const sha = await commitAll(base.worktree, `${seat === 'dev' ? 'implement' : 'repair'}: ${ctx.runId}`);
  ctx.store.append('implementation-committed', {
    actor: ACTOR,
    pass: pass ?? currentPass(events),
    phase: phase ?? 'repair',
    baseSha,
    sha,
  });
  return { sha };
}

async function refreezeStep(ctx, base, { findings, record, intentAnswer }) {
  const events = runEvents(ctx);
  // Spec-deep defects amend the born spec first; the answered intent
  // conflict rides the same amendment.
  const deep = findings.filter((f) => f.depth === 'spec' || f.depth === 'intent');
  if (deep.length > 0 && !seatReportAfter(events, 'spec-birth', lastRenderSeq(events))) {
    const n = invocationCount(events, 'spec-birth') + 1;
    const amend = await ctx.runSeat({
      seat: 'spec-birth',
      roleBlock: specAmendRole(base, deep, intentAnswer),
      reportPath: runReportPath(ctx.paths, ctx.runId, `spec-birth-${n}`),
      schema: SPEC_AMEND_SCHEMA,
      cwd: base.worktree,
      env: base.env,
    });
    if (!amend.ok) return { fail: seatFail('spec-birth', amend) };
  }
  const { report, fail } = await seatWithChecks(ctx, {
    seat: 'suite',
    label: null,
    schema: SUITE_SCHEMA,
    cwd: base.worktree,
    env: base.env,
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

// -- gate integrity ----------------------------------------------------------

/** Pairs a `resolved` append to every gate-integrity line whose harness
 * finding has left the open set. */
function resolveGateIntegrity(ctx, openIds) {
  const events = runEvents(ctx);
  const resolved = new Set(
    events.filter((e) => e.event === 'resolved').map((e) => e.resolves),
  );
  for (const e of events) {
    if (e.event !== 'gate-integrity' || resolved.has(e.seq)) continue;
    if (!openIds.includes(e.findingId)) {
      ctx.store.resolve({ actor: ACTOR, resolves: e.seq, findingId: e.findingId });
    }
  }
}

// -- seat contract loop ------------------------------------------------------

/**
 * The lane-level contract loop: one corrective invocation on a deterministic
 * defect in the work product, then seat-failure.
 */
async function seatWithChecks(ctx, { seat, label, schema, cwd, env, buildRole, checks }) {
  let brief = null;
  for (let attempt = 1; ; attempt++) {
    const events = runEvents(ctx);
    const n = invocationCount(events, seat) + 1;
    const result = await ctx.runSeat({
      seat,
      roleBlock: buildRole(brief),
      reportPath: runReportPath(ctx.paths, ctx.runId, label ?? `${seat}-${n}`),
      schema,
      cwd,
      env,
    });
    if (!result.ok) return { fail: seatFail(seat, result) };
    const defects = await checks(result.report);
    if (defects.length === 0) return { report: result.report };
    if (attempt === 2) {
      ctx.store.append('seat-failure', { actor: ACTOR, seat, reason: 'work-product-defect', defects });
      return {
        fail: {
          close: { state: 'failed', reason: 'seat-failure', seat, cause: 'work-product-defect' },
        },
      };
    }
    brief = defects;
  }
}

// -- role blocks -------------------------------------------------------------

function devRole(base, brief = null) {
  return [
    `Implement the story spec at: ${base.specRef}`,
    'The frozen acceptance suite defines done. Do not edit or delete test files.',
    `Test paths (read-only): ${base.testPaths.join(', ')}`,
    'Run the Tier-1 gate commands from the project config to check your work.',
    'Do not commit; the orchestrator commits your work.',
    ...briefLines(brief),
  ].join('\n');
}

function fixRole(base, brief = null) {
  return [
    `Fix the defect described by the intake ticket at: ${base.specRef}`,
    'The ticket is the spec. Stay inside its scope.',
    'Add a regression test when the defect class demands one.',
    'Do not commit; the orchestrator commits your work.',
    ...briefLines(brief),
  ].join('\n');
}

function repairRole(base, open, record) {
  return [
    'Repair the candidate tree in place. Fix every open finding below; change nothing else.',
    `The spec: ${base.specRef}`,
    'Do not edit or delete test files.',
    'Open findings:',
    ...open.map((f) => `- ${findingLine(f)}`),
    'Full-spectrum verdict:',
    ...(record?.spectrum ?? []).map(
      (r) => `- ${r.layer}: ${r.status}${r.attributedTo ? ` (attributed to ${r.attributedTo})` : ''}`,
    ),
    'Do not commit; the orchestrator commits your work.',
  ].join('\n');
}

function triageRole(base, reds, priorOpen, brief) {
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

function specAmendRole(base, findings, intentAnswer) {
  const lines = [
    `Amend the born spec at this absolute path: ${base.specRef}`,
    'Edit the file in place. Keep unaffected sections unchanged.',
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
  return lines.join('\n');
}

function stallBrief(open) {
  return [
    'A prior implementation of this spec stalled and was discarded. Start fresh; do not reconstruct the prior approach.',
    'The stall left these findings open:',
    ...open.map((f) => `- ${findingLine(f)}`),
  ].join('\n');
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
    return { fail: { close: { state: 'failed', reason: 'no-tier1-gates' } } };
  }
  const events = runEvents(ctx);
  if (mode === 'story') {
    const freeze = events.find((e) => e.event === 'freeze');
    if (!freeze) return { fail: { close: { state: 'failed', reason: 'no-freeze-record' } } };
    return {
      config,
      worktree,
      layers,
      commands: config.commands,
      env: runEnv(ctx, config),
      testPaths: config.repo.testPaths,
      uiPaths: config.repo.uiPaths ?? [],
      specRef: join(ctx.paths.runs, ctx.runId, 'spec.md'),
      suiteSha: currentSuiteSha(events),
      resetSha: freeze.sha,
    };
  }
  // The intake ticket is the spec. A repo-relative path names a committed
  // ticket; an absolute path names a daemon-home ticket (red-merge repair
  // spawns write these — the defect is not in the tree it escaped from).
  const ticket = ctx.payload.ticket;
  const ticketPath =
    typeof ticket === 'string' ? (isAbsolute(ticket) ? ticket : join(worktree, ticket)) : null;
  if (!ticketPath || !existsSync(ticketPath)) {
    return { fail: { close: { state: 'failed', reason: 'ticket-missing', ticket } } };
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
  };
}

function currentSuiteSha(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 're-freeze' || e.event === 'freeze') return e.sha;
  }
  return null;
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
