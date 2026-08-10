// The story-lane pre-freeze chain: readiness (process) → spec birth (seat)
// → spec gate (seat, cap 2 rounds) → suite authoring (seat) → adversary
// (3 waves in disposable worktrees) → freeze (process). The freeze record is
// the completion signal; the stages after freeze land with their milestones
// and enter through `storyLane({afterFreeze})`.
//
// Every handler re-derives its position from the run ledger and the git
// state, so a daemon restart resumes mid-chain without memory. Deterministic
// defects in a seat's work product (boundary breaches, wrong red classes,
// uncovered survivors) take the contract-loop route: one corrective
// invocation, then seat-failure.
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '../ledger/ledger.mjs';
import { runLedgerPath, runReportPath } from '../daemon/home.mjs';
import { parseProjectConfig } from '../config/project.mjs';
import { cloneDir } from '../isolation/clones.mjs';
import { git } from '../isolation/git.mjs';
import { addDisposableWorktree, removeWorktree, workspaceRoot } from '../isolation/worktrees.mjs';
import {
  changedFiles,
  commitAll,
  headSha,
  restorePaths,
  evidenceDiff,
  filesAt,
} from '../isolation/tree.mjs';
import { testEditDenyRules } from '../seats/boundary.mjs';
import { parseIntentCard } from './card.mjs';
import { runCommand } from './exec.mjs';

const ACTOR = 'daemon';
const WAVES = 3;
const GIST_MAX = 120;

export const PRE_FREEZE_STAGES = ['readiness', 'spec-birth', 'spec-gate', 'suite', 'adversary', 'freeze'];

/**
 * Builds the story lane. `afterFreeze` is the post-freeze continuation
 * (implementation → verdict → ship), landing with its own milestones; the
 * freeze stage hands over to its first stage.
 * @param {{afterFreeze: {stages: string[], handlers: object}}} opts
 */
export function storyLane({ afterFreeze }) {
  if (!Array.isArray(afterFreeze?.stages) || afterFreeze.stages.length === 0) {
    throw new Error('storyLane requires an afterFreeze continuation');
  }
  return {
    stages: [...PRE_FREEZE_STAGES, ...afterFreeze.stages],
    handlers: {
      readiness,
      'spec-birth': specBirth,
      'spec-gate': specGate,
      suite: suiteStage,
      adversary,
      freeze: freezeHandler(afterFreeze.stages[0]),
      ...afterFreeze.handlers,
    },
  };
}

// -- report schemas (flat draft-07-safe subset) ------------------------------

export const SPEC_BIRTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: ['spec-born', 'grounding-conflict'] },
    summary: { type: 'string' },
    conflict: { type: 'string' },
  },
  required: ['outcome', 'summary'],
};

export const SPEC_AMEND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    amendedSections: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['amendedSections', 'summary'],
};

export const SPEC_GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          section: { type: 'string' },
          finding: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['section', 'finding', 'evidence'],
      },
    },
    intentConflict: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['findings', 'summary'],
};

const RED_CLASSES = ['feature-absence', 'fixture-defect', 'env-collision', 'other'];

const SUITE_PROPERTIES = {
  suiteFiles: { type: 'array', items: { type: 'string' } },
  reds: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        test: { type: 'string' },
        class: { type: 'string', enum: RED_CLASSES },
      },
      required: ['test', 'class'],
    },
  },
  summary: { type: 'string' },
};

export const SUITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: SUITE_PROPERTIES,
  required: ['suiteFiles', 'reds', 'summary'],
};

export const SUITE_AMEND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SUITE_PROPERTIES,
    killingTests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          wave: { type: 'integer' },
          test: { type: 'string' },
        },
        required: ['wave', 'test'],
      },
    },
    dispositions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          wave: { type: 'integer' },
          disposition: { type: 'string', enum: ['spec-indifferent', 'unkilled-gap'] },
          reason: { type: 'string' },
        },
        required: ['wave', 'disposition', 'reason'],
      },
    },
  },
  required: ['suiteFiles', 'reds', 'summary', 'killingTests', 'dispositions'],
};

export const ADVERSARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    approach: { type: 'string' },
    wrongness: { type: 'string' },
  },
  required: ['approach', 'wrongness'],
};

// -- readiness (process) -----------------------------------------------------

async function readiness(ctx) {
  const worktree = ctx.payload.worktree;
  if (typeof worktree !== 'string' || !existsSync(worktree)) {
    return { close: { state: 'failed', reason: 'no-worktree' } };
  }
  const config = await loadProjectConfig(ctx);
  const story = config.lanes.story;
  if (!story) return { close: { state: 'failed', reason: 'story-lane-unconfigured' } };
  const cardPath = ctx.payload.card;
  if (typeof cardPath !== 'string' || cardPath.length === 0) {
    return { close: { state: 'failed', reason: 'no-card' } };
  }
  const file = join(worktree, cardPath);
  if (!existsSync(file)) {
    return { close: { state: 'failed', reason: 'card-missing', card: cardPath } };
  }
  const { card, errors } = parseIntentCard(readFileSync(file, 'utf8'));
  if (errors.length > 0) {
    return { close: { state: 'failed', reason: 'card-invalid', errors } };
  }
  if (story.lintCommand) {
    const lint = await runCommand(config.commands[story.lintCommand], { cwd: worktree });
    if (lint.code === null) {
      return { close: { state: 'failed', reason: 'lint-command-error', error: lint.error } };
    }
    if (lint.code !== 0) {
      return { close: { state: 'failed', reason: 'readiness-lint', output: lint.output } };
    }
  }
  if (card.openDecisions.length > 0) {
    const events = runEvents(ctx);
    if (!answeredPark(events, 'open-decisions')?.answer) {
      return parkDirective('open-decisions', {
        question:
          `Resolve the open decisions on ${card.key ?? cardPath}:\n` +
          card.openDecisions.map((d) => `- ${d}`).join('\n'),
        refs: [cardPath],
      });
    }
  }
  return { next: 'spec-birth' };
}

// -- spec birth (seat) -------------------------------------------------------

async function specBirth(ctx) {
  const base = await laneBase(ctx);
  const events = runEvents(ctx);
  if (events.some((e) => e.event === 'spec-born')) return { next: 'spec-gate' };
  const n = invocationCount(events, 'spec-birth') + 1;
  const result = await ctx.runSeat({
    seat: 'spec-birth',
    roleBlock: birthRole(base, escalationLog(events)),
    reportPath: runReportPath(ctx.paths, ctx.runId, `spec-birth-${n}`),
    schema: SPEC_BIRTH_SCHEMA,
    cwd: base.worktree,
  });
  if (!result.ok) return seatFail('spec-birth', result);
  if (result.report.outcome === 'grounding-conflict') {
    return parkDirective('grounding-conflict', {
      question: result.report.conflict?.trim() || result.report.summary,
      refs: [base.cardPath],
    });
  }
  if (!existsSync(base.specPath) || readFileSync(base.specPath, 'utf8').trim().length === 0) {
    ctx.store.append('seat-failure', {
      actor: ACTOR,
      seat: 'spec-birth',
      reason: 'artifact-missing',
      path: base.specPath,
    });
    return {
      close: { state: 'failed', reason: 'seat-failure', seat: 'spec-birth', cause: 'artifact-missing' },
    };
  }
  ctx.store.append('spec-born', {
    actor: ACTOR,
    specPath: base.specPath,
    summary: gist(result.report.summary),
  });
  return { next: 'spec-gate' };
}

// -- spec gate (seat, cap 2 counted rounds) ----------------------------------

async function specGate(ctx) {
  const base = await laneBase(ctx);
  for (;;) {
    const events = runEvents(ctx);
    const rounds = events.filter((e) => e.event === 'spec-gate-round');
    const last = rounds[rounds.length - 1];
    // An answered intent conflict directs one amendment before any re-check;
    // the conflict never burns a counted round.
    const conflict = answeredPark(events, 'intent-conflict');
    if (conflict?.answer && !seatReportAfter(events, 'spec-birth', conflict.answer.seq)) {
      const amend = await amendSpec(ctx, base, conflictBrief(conflict));
      if (!amend.ok) return seatFail('spec-birth', amend);
      continue;
    }
    if (last?.verdict === 'pass') return { next: 'suite' };
    if (rounds.length === 0) {
      const r = await gateRound(ctx, base, { round: 1, sections: null });
      if (r.directive) return r.directive;
      continue;
    }
    if (rounds.length >= 2) {
      return { close: { state: 'failed', reason: 'spec-gate-exhausted' } };
    }
    // One counted round with findings open: the birth seat amends, then the
    // gate re-checks the amended sections only.
    const amendReport = seatReportAfter(events, 'spec-birth', last.seq);
    if (!amendReport) {
      const findings = readJson(lastSeatReportEvent(events, 'spec-gate').path)?.findings ?? [];
      const amend = await amendSpec(ctx, base, findingsBrief(findings));
      if (!amend.ok) return seatFail('spec-birth', amend);
      continue;
    }
    const sections = readJson(amendReport.path)?.amendedSections ?? [];
    const r = await gateRound(ctx, base, { round: 2, sections });
    if (r.directive) return r.directive;
  }
}

async function gateRound(ctx, base, { round, sections }) {
  const events = runEvents(ctx);
  const n = invocationCount(events, 'spec-gate') + 1;
  const result = await ctx.runSeat({
    seat: 'spec-gate',
    roleBlock: gateRole(base, sections),
    reportPath: runReportPath(ctx.paths, ctx.runId, `spec-gate-${n}`),
    schema: SPEC_GATE_SCHEMA,
    cwd: base.worktree,
  });
  if (!result.ok) return { directive: seatFail('spec-gate', result) };
  const conflict = result.report.intentConflict;
  if (typeof conflict === 'string' && conflict.trim().length > 0) {
    return {
      directive: parkDirective('intent-conflict', {
        question: conflict.trim(),
        refs: [base.cardPath],
      }),
    };
  }
  const verdict = result.report.findings.length > 0 ? 'findings' : 'pass';
  ctx.store.append('spec-gate-round', {
    actor: ACTOR,
    round,
    verdict,
    findings: result.report.findings.length,
  });
  return { directive: null };
}

async function amendSpec(ctx, base, brief) {
  const events = runEvents(ctx);
  const n = invocationCount(events, 'spec-birth') + 1;
  return ctx.runSeat({
    seat: 'spec-birth',
    roleBlock: amendRole(base, brief),
    reportPath: runReportPath(ctx.paths, ctx.runId, `spec-birth-${n}`),
    schema: SPEC_AMEND_SCHEMA,
    cwd: base.worktree,
  });
}

// -- suite authoring (seat) --------------------------------------------------

async function suiteStage(ctx) {
  const base = await laneBase(ctx);
  const events = runEvents(ctx);
  if (events.some((e) => e.event === 'suite-committed' && e.phase === 'author')) {
    return { next: 'adversary' };
  }
  const { report, fail } = await suiteSeatWithChecks(ctx, base, {
    schema: SUITE_SCHEMA,
    buildRole: (brief) => suiteAuthorRole(base, brief),
    checks: (r) => suiteChecks(base, r),
  });
  if (fail) return fail;
  const sha = await commitAll(base.worktree, `suite: ${base.card.key}`);
  ctx.store.append('suite-committed', { actor: ACTOR, sha, phase: 'author', files: report.suiteFiles });
  return { next: 'adversary' };
}

/**
 * The lane-level contract loop for the suite seat: one corrective invocation
 * on a deterministic defect in the work product, then seat-failure.
 */
async function suiteSeatWithChecks(ctx, base, { schema, buildRole, checks }) {
  let brief = null;
  for (let attempt = 1; ; attempt++) {
    const events = runEvents(ctx);
    const n = invocationCount(events, 'suite') + 1;
    const result = await ctx.runSeat({
      seat: 'suite',
      roleBlock: buildRole(brief),
      reportPath: runReportPath(ctx.paths, ctx.runId, `suite-${n}`),
      schema,
      cwd: base.worktree,
    });
    if (!result.ok) return { fail: seatFail('suite', result) };
    const defects = await checks(result.report);
    if (defects.length === 0) return { report: result.report };
    if (attempt === 2) {
      ctx.store.append('seat-failure', { actor: ACTOR, seat: 'suite', reason: 'suite-defect', defects });
      return {
        fail: { close: { state: 'failed', reason: 'seat-failure', seat: 'suite', cause: 'suite-defect' } },
      };
    }
    brief = defects;
  }
}

async function suiteChecks(base, report) {
  const defects = [];
  if (report.suiteFiles.length === 0) defects.push('no suite files declared');
  for (const file of report.suiteFiles) {
    if (!underAny(file, base.testPaths)) {
      defects.push(`suite file outside the test paths: ${file}`);
    } else if (!existsSync(join(base.worktree, file))) {
      defects.push(`declared suite file missing: ${file}`);
    }
  }
  for (const file of await changedFiles(base.worktree)) {
    if (!underAny(file, base.testPaths)) defects.push(`change outside the test paths: ${file}`);
  }
  for (const red of report.reds) {
    if (red.class !== 'feature-absence') {
      defects.push(`expected red "${red.test}" is classed ${red.class}; every red must be feature-absence`);
    }
  }
  return defects;
}

// -- adversary ---------------------------------------------------------------

async function adversary(ctx) {
  const base = await laneBase(ctx);
  const clone = cloneDir(ctx.paths, ctx.project);
  for (;;) {
    const events = runEvents(ctx);
    const round =
      1 + events.filter((e) => e.event === 'suite-committed' && e.phase === 'strengthening').length;
    const waves = events.filter(
      (e) => e.event === 'adversary-wave' && e.phase === 'initial' && e.round === round,
    );
    // 1) Run the round's missing waves; every wave goes to verdict.
    if (waves.length < WAVES) {
      const done = new Set(waves.map((e) => e.wave));
      for (let wave = 1; wave <= WAVES; wave++) {
        if (done.has(wave)) continue;
        const fail = await runWave(ctx, base, clone, { round, wave });
        if (fail) return fail;
      }
      continue;
    }
    const survivors = waves
      .filter((e) => e.result === 'survived')
      .map((e) => e.wave)
      .sort((a, b) => a - b);
    const kills = WAVES - survivors.length;
    const lastWaveSeq = Math.max(...waves.map((e) => e.seq));
    // 2) Zero kills: one automatic strengthening round, then every further
    //    zero round escalates.
    if (kills === 0) {
      if (round === 1) {
        const fail = await strengthen(ctx, base, clone, { round, survivors });
        if (fail) return fail;
        continue;
      }
      const park = answeredPark(events, 'second-zero-kill');
      if (!park?.answer || park.answer.seq < lastWaveSeq) {
        return parkDirective('second-zero-kill', {
          question:
            `Adversary round ${round} scored 0/${WAVES} after a strengthening round. Survivors:\n` +
            survivorLines(ctx, round, survivors) +
            '\nPick an option.',
          options: ['strengthen-again', 'fail'],
        });
      }
      if (park.answer.option === 'strengthen-again') {
        const fail = await strengthen(ctx, base, clone, { round, survivors });
        if (fail) return fail;
        continue;
      }
      if (park.answer.option === 'fail') {
        return { close: { state: 'failed', reason: 'second-zero-kill' } };
      }
      return parkDirective('second-zero-kill', {
        question: 'The answer picked no option. Pick one.',
        options: ['strengthen-again', 'fail'],
      });
    }
    // 3) Full kill: nothing to amend.
    if (survivors.length === 0) return { next: 'freeze' };
    // 4) Survivors are demonstrated suite gaps: one targeted amendment round.
    const amend = events.find(
      (e) => e.event === 'suite-committed' && e.phase === 'amendment' && e.seq > lastWaveSeq,
    );
    if (!amend) {
      const fail = await amendment(ctx, base, clone, { round, survivors });
      if (fail) return fail;
      continue;
    }
    const amendReport = readJson(lastSeatReportEvent(events, 'suite').path) ?? {};
    const killingWaves = new Set((amendReport.killingTests ?? []).map((k) => k.wave));
    // 5) Survivors-only re-run for the waves with killing tests.
    const reruns = events.filter(
      (e) => e.event === 'adversary-wave' && e.phase === 're-run' && e.round === round && e.seq > amend.seq,
    );
    const rerunDone = new Set(reruns.map((e) => e.wave));
    let ranRerun = false;
    for (const wave of survivors) {
      if (!killingWaves.has(wave) || rerunDone.has(wave)) continue;
      const fail = await rerunWave(ctx, base, clone, { round, wave, sha: amend.sha });
      if (fail) return fail;
      ranRerun = true;
    }
    if (ranRerun) continue;
    // 6) Dispositions for every residual survivor.
    const declared = new Map((amendReport.dispositions ?? []).map((d) => [d.wave, d]));
    const stamped = events.filter((e) => e.event === 'survivor-disposition' && e.seq > amend.seq);
    const stampedWaves = new Set(stamped.map((e) => e.wave));
    let stampedNow = false;
    for (const wave of survivors) {
      if (stampedWaves.has(wave)) continue;
      const rerun = reruns.find((e) => e.wave === wave);
      if (rerun?.result === 'killed') continue;
      let d;
      if (killingWaves.has(wave) && rerun?.result === 'survived') {
        d = { wave, disposition: 'unkilled-gap', reason: 'the killing test did not kill the survivor' };
      } else if (declared.has(wave)) {
        d = declared.get(wave);
      } else {
        // Unreachable when the amendment checks held; recorded as a gap.
        d = { wave, disposition: 'unkilled-gap', reason: 'no killing test and no disposition' };
      }
      ctx.store.append('survivor-disposition', {
        actor: ACTOR,
        round,
        wave: d.wave,
        disposition: d.disposition,
        reason: d.reason,
      });
      if (d.disposition === 'spec-indifferent') await dropWaveTree(ctx, clone, round, d.wave);
      stampedNow = true;
    }
    if (stampedNow) continue;
    // 7) Open gaps block the freeze and escalate; the human accepts or fails.
    const latest = new Map();
    for (const e of stamped) latest.set(e.wave, e);
    const gaps = [...latest.values()].filter((e) => e.disposition === 'unkilled-gap');
    if (gaps.length > 0) {
      const gapSeq = Math.max(...gaps.map((e) => e.seq));
      const park = answeredPark(events, 'unkilled-gap-survivor');
      if (!park?.answer || park.answer.seq < gapSeq) {
        return parkDirective('unkilled-gap-survivor', {
          question:
            `Unkilled suite gaps block the freeze (round ${round}):\n` +
            gaps.map((g) => `- wave ${g.wave}: ${g.reason}`).join('\n') +
            '\n' +
            survivorLines(
              ctx,
              round,
              gaps.map((g) => g.wave),
            ) +
            '\nPick an option.',
          options: ['accept-spec-indifferent', 'fail'],
        });
      }
      if (park.answer.option === 'accept-spec-indifferent') {
        for (const gap of gaps) {
          ctx.store.append('survivor-disposition', {
            actor: park.answer.actor,
            round,
            wave: gap.wave,
            disposition: 'spec-indifferent',
            reason: `unkilled gap accepted by ${park.answer.actor}`,
            source: 'answer',
          });
          await dropWaveTree(ctx, clone, round, gap.wave);
        }
        continue;
      }
      if (park.answer.option === 'fail') {
        return { close: { state: 'failed', reason: 'unkilled-gap-survivor' } };
      }
      return parkDirective('unkilled-gap-survivor', {
        question: 'The answer picked no option. Pick one.',
        options: ['accept-spec-indifferent', 'fail'],
      });
    }
    return { next: 'freeze' };
  }
}

async function runWave(ctx, base, clone, { round, wave }) {
  const sha = await headSha(base.worktree);
  const tag = `adversary-r${round}-w${wave}`;
  const tree = waveTreePath(ctx, round, wave);
  if (existsSync(tree)) await dropWaveTree(ctx, clone, round, wave); // stale half-run
  await addDisposableWorktree(clone, ctx.paths, ctx.runId, tag, sha);
  const result = await ctx.runSeat({
    seat: 'adversary',
    roleBlock: adversaryRole(base),
    reportPath: runReportPath(ctx.paths, ctx.runId, tag),
    schema: ADVERSARY_SCHEMA,
    cwd: tree,
    denyTools: testEditDenyRules(base.testPaths),
  });
  if (!result.ok) return seatFail('adversary', result);
  // Restore the suite from the sha before evaluation — a tampered test file
  // is structurally void, not detected.
  await restorePaths(tree, sha, base.testPaths);
  const run = await runCommand(base.suiteArgv, { cwd: tree });
  if (run.code === null) return commandFail(run);
  const killed = run.code !== 0;
  ctx.store.append('adversary-wave', {
    actor: ACTOR,
    round,
    wave,
    phase: 'initial',
    result: killed ? 'killed' : 'survived',
    sha,
    wrongness: gist(result.report.wrongness),
  });
  if (killed) await dropWaveTree(ctx, clone, round, wave);
  return null;
}

async function rerunWave(ctx, base, clone, { round, wave, sha }) {
  const tree = waveTreePath(ctx, round, wave);
  if (!existsSync(tree)) {
    return { close: { state: 'failed', reason: 'wave-tree-missing', round, wave } };
  }
  await restorePaths(tree, sha, base.testPaths);
  const run = await runCommand(base.suiteArgv, { cwd: tree });
  if (run.code === null) return commandFail(run);
  const killed = run.code !== 0;
  ctx.store.append('adversary-wave', {
    actor: ACTOR,
    round,
    wave,
    phase: 're-run',
    result: killed ? 'killed' : 'survived',
    sha,
  });
  if (killed) await dropWaveTree(ctx, clone, round, wave);
  return null;
}

async function amendment(ctx, base, clone, { round, survivors }) {
  const evidence = await survivorEvidence(ctx, round, survivors);
  const { report, fail } = await suiteSeatWithChecks(ctx, base, {
    schema: SUITE_AMEND_SCHEMA,
    buildRole: (brief) => amendmentRole(base, evidence, brief),
    checks: async (r) => {
      const defects = await suiteChecks(base, r);
      const covered = new Set([
        ...(r.killingTests ?? []).map((k) => k.wave),
        ...(r.dispositions ?? []).map((d) => d.wave),
      ]);
      for (const wave of survivors) {
        if (!covered.has(wave)) {
          defects.push(`survivor wave ${wave} has neither a killing test nor a disposition`);
        }
      }
      return defects;
    },
  });
  if (fail) return fail;
  const sha = await commitAll(base.worktree, `suite amend r${round}: ${base.card.key}`);
  ctx.store.append('suite-committed', { actor: ACTOR, sha, phase: 'amendment', files: report.suiteFiles });
  return null;
}

async function strengthen(ctx, base, clone, { round, survivors }) {
  const evidence = await survivorEvidence(ctx, round, survivors);
  const { report, fail } = await suiteSeatWithChecks(ctx, base, {
    schema: SUITE_SCHEMA,
    buildRole: (brief) => strengthenRole(base, evidence, brief),
    checks: (r) => suiteChecks(base, r),
  });
  if (fail) return fail;
  const sha = await commitAll(base.worktree, `suite strengthen r${round}: ${base.card.key}`);
  ctx.store.append('suite-committed', {
    actor: ACTOR,
    sha,
    phase: 'strengthening',
    files: report.suiteFiles,
  });
  for (const wave of survivors) await dropWaveTree(ctx, clone, round, wave);
  return null;
}

async function survivorEvidence(ctx, round, survivors) {
  const parts = [];
  for (const wave of survivors) {
    const report = readJson(runReportPath(ctx.paths, ctx.runId, `adversary-r${round}-w${wave}`)) ?? {};
    const tree = waveTreePath(ctx, round, wave);
    let diff = '';
    if (existsSync(tree)) diff = await evidenceDiff(tree).catch(() => '');
    parts.push(
      [
        `Survivor wave ${wave}:`,
        `approach: ${report.approach ?? 'unknown'}`,
        `wrongness: ${report.wrongness ?? 'unknown'}`,
        'diff:',
        diff,
      ].join('\n'),
    );
  }
  return parts.join('\n\n');
}

function survivorLines(ctx, round, waves) {
  return waves
    .map((wave) => {
      const report = readJson(runReportPath(ctx.paths, ctx.runId, `adversary-r${round}-w${wave}`));
      return `- wave ${wave}: ${report?.wrongness ?? 'no report'}`;
    })
    .join('\n');
}

function waveTreePath(ctx, round, wave) {
  return join(workspaceRoot(ctx.paths, ctx.runId), `adversary-r${round}-w${wave}`);
}

async function dropWaveTree(ctx, clone, round, wave) {
  const tree = waveTreePath(ctx, round, wave);
  if (!existsSync(tree)) return;
  try {
    await removeWorktree(clone, tree);
  } catch {
    rmSync(tree, { recursive: true, force: true, maxRetries: 3 });
  }
}

// -- freeze (process) --------------------------------------------------------

function freezeHandler(nextStage) {
  return async function freeze(ctx) {
    const base = await laneBase(ctx);
    // Red-state: the suite must be red against the pre-implementation tree,
    // by feature absence alone. One corrective fix round on green, then fail.
    for (let attempt = 1; ; attempt++) {
      const sha = await headSha(base.worktree);
      const run = await runCommand(base.suiteArgv, { cwd: base.worktree });
      if (run.code === null) return commandFail(run);
      const red = run.code !== 0;
      ctx.store.append('red-state-check', { actor: ACTOR, sha, result: red ? 'red' : 'green' });
      if (red) break;
      if (attempt === 2) {
        ctx.store.append('seat-failure', { actor: ACTOR, seat: 'suite', reason: 'red-state-green' });
        return {
          close: { state: 'failed', reason: 'seat-failure', seat: 'suite', cause: 'red-state-green' },
        };
      }
      const { report, fail } = await suiteSeatWithChecks(ctx, base, {
        schema: SUITE_SCHEMA,
        buildRole: (brief) => redStateFixRole(base, brief),
        checks: (r) => suiteChecks(base, r),
      });
      if (fail) return fail;
      const fixSha = await commitAll(base.worktree, `suite red-state fix: ${base.card.key}`);
      ctx.store.append('suite-committed', { actor: ACTOR, sha: fixSha, phase: 'fix', files: report.suiteFiles });
    }
    // The freeze record — the completion signal of the pre-freeze chain.
    const events = runEvents(ctx);
    const sha = await headSha(base.worktree);
    const suiteFiles = await filesAt(base.worktree, sha, base.testPaths);
    const initial = events.filter((e) => e.event === 'adversary-wave' && e.phase === 'initial');
    const finalRound = initial.length > 0 ? Math.max(...initial.map((e) => e.round)) : 0;
    const killCount = initial.filter((e) => e.round === finalRound && e.result === 'killed').length;
    const amendmentKills = events.filter(
      (e) => e.event === 'adversary-wave' && e.phase === 're-run' && e.result === 'killed',
    ).length;
    const latestDisposition = new Map();
    for (const e of events) {
      if (e.event === 'survivor-disposition') latestDisposition.set(`${e.round}:${e.wave}`, e);
    }
    const dispositions = [...latestDisposition.values()].map((e) => ({
      round: e.round,
      wave: e.wave,
      disposition: e.disposition,
      reason: e.reason,
    }));
    const reds = readJson(lastSeatReportEvent(events, 'suite')?.path)?.reds ?? [];
    const record = {
      runId: ctx.runId,
      project: ctx.project,
      card: ctx.payload.card,
      storyKey: base.card.key,
      specRef: base.specPath,
      suiteSha: sha,
      suiteFiles,
      waves: initial.map((e) => ({ round: e.round, wave: e.wave, result: e.result, sha: e.sha })),
      killCount,
      amendmentKills,
      dispositions,
      redState: { result: 'red', sha, reds },
    };
    const recordPath = join(ctx.paths.runs, ctx.runId, 'freeze.json');
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
    ctx.store.append('freeze', {
      actor: ACTOR,
      sha,
      killCount,
      amendmentKills,
      dispositions: dispositions.length,
      files: suiteFiles.length,
      record: recordPath,
    });
    return { next: nextStage };
  };
}

// -- role blocks -------------------------------------------------------------

function birthRole(base, resolved) {
  const lines = [
    'Author the story spec from the intent card below.',
    'Ground every claim in the repository as it stands; cite file paths for grounding claims.',
    `Write the spec as markdown to this absolute path: ${base.specPath}`,
    "Stay inside the card's scope boundary. Encode every acceptance criterion so a test can assert it.",
    'If the repository state conflicts with the card\'s intent, do not author around the conflict: set outcome "grounding-conflict" and describe the conflict.',
    'Otherwise set outcome "spec-born".',
  ];
  if (resolved.length > 0) {
    lines.push('Decisions already made for this run (honor them):');
    for (const pair of resolved) {
      lines.push(`- [${pair.type}] ${pair.question} → ${pair.answer} (${pair.actor})`);
    }
  }
  lines.push(`Intent card (${base.cardPath}):`, base.cardText);
  return lines.join('\n');
}

function amendRole(base, brief) {
  return [
    `Amend the born spec at this absolute path: ${base.specPath}`,
    'Edit the file in place. Keep unaffected sections unchanged.',
    'Report the headings of every section you amended.',
    'Brief:',
    brief,
    `Intent card (${base.cardPath}):`,
    base.cardText,
  ].join('\n');
}

function conflictBrief(conflict) {
  return [
    'An intent conflict was escalated and answered.',
    `Conflict: ${conflict.park.question}`,
    `Answer (${conflict.answer.actor}): ${conflict.answer.option ?? conflict.answer.answer}`,
    'Amend the spec to honor the answer.',
  ].join('\n');
}

function findingsBrief(findings) {
  return [
    'The spec gate found birth defects. Fix each finding:',
    ...findings.map((f) => `- [${f.section}] ${f.finding} (evidence: ${f.evidence})`),
  ].join('\n');
}

function gateRole(base, sections) {
  return [
    'Fresh-context review of a born story spec.',
    `The spec: ${base.specPath}`,
    `The intent card: ${base.cardPath} (in your working directory).`,
    'Check three things and cite evidence for every finding:',
    "- grounding: spot-check the spec's claims against the repository;",
    "- scope: the spec must not widen past the card's scope boundary;",
    '- encodability: every acceptance criterion must be assertable by a test.',
    'If the spec and the card\'s intent disagree, put the disagreement in "intentConflict"; do not list it as a finding.',
    sections && sections.length > 0
      ? `Re-check only these amended sections: ${sections.join('; ')}`
      : 'Review the whole spec.',
  ].join('\n');
}

function suiteReportLines(base) {
  return [
    `Write test files only under: ${base.testPaths.join(', ')}. Touch nothing else.`,
    `The suite runs with: ${base.suiteArgv.join(' ')}`,
    'In the report, list every suite file and class every expected red.',
    'The suite must be red against the current tree only because the feature is absent.',
  ];
}

function suiteAuthorRole(base, brief) {
  return [
    `Author the acceptance suite for the spec at: ${base.specPath}`,
    ...suiteReportLines(base),
    ...briefLines(brief),
  ].join('\n');
}

function amendmentRole(base, evidence, brief) {
  return [
    'The adversary round left survivors: wrong implementations the suite did not kill.',
    `The spec: ${base.specPath}`,
    'For each survivor, do one of:',
    '- add a killing test and list it under killingTests with the wave number;',
    '- declare a disposition: "spec-indifferent" when the spec does not constrain the surviving behavior, "unkilled-gap" when the gap is real but you cannot encode a killing test.',
    ...suiteReportLines(base),
    'Survivor evidence:',
    evidence,
    ...briefLines(brief),
  ].join('\n');
}

function strengthenRole(base, evidence, brief) {
  return [
    'The adversary round scored zero kills: every wrong implementation passed the suite.',
    `Strengthen the suite against the spec at: ${base.specPath}`,
    'Use every survivor below as evidence. Fresh adversary waves follow.',
    ...suiteReportLines(base),
    'Survivor evidence:',
    evidence,
    ...briefLines(brief),
  ].join('\n');
}

function redStateFixRole(base, brief) {
  return [
    'The red-state check failed: the suite is green against the pre-implementation tree.',
    `Fix the suite so it asserts the behavior specified at: ${base.specPath}`,
    ...suiteReportLines(base),
    ...briefLines(brief),
  ].join('\n');
}

function adversaryRole(base) {
  return [
    'You work in a disposable worktree; nothing you write ships.',
    `Write a plausible wrong implementation against the spec at: ${base.specPath}`,
    'Goal: the acceptance suite passes while the behavior violates the spec.',
    'Do not edit or delete test files; the suite is restored before evaluation.',
    'Report your approach and the deliberate wrongness.',
  ].join('\n');
}

function briefLines(brief) {
  if (!brief) return [];
  const items = Array.isArray(brief) ? brief : [brief];
  return ['Correction brief — fix these defects:', ...items.map((d) => `- ${d}`)];
}

// -- shared derivations ------------------------------------------------------

async function laneBase(ctx) {
  const config = await loadProjectConfig(ctx);
  const story = config.lanes.story;
  if (!story) throw new Error('story lane settings missing from project config');
  const worktree = ctx.payload.worktree;
  const cardPath = ctx.payload.card;
  const cardText = readFileSync(join(worktree, cardPath), 'utf8');
  const { card } = parseIntentCard(cardText);
  return {
    config,
    story,
    worktree,
    cardPath,
    cardText,
    card,
    testPaths: config.repo.testPaths,
    suiteArgv: config.commands[story.suiteCommand],
    specPath: join(ctx.paths.runs, ctx.runId, 'spec.md'),
  };
}

async function loadProjectConfig(ctx) {
  const clone = cloneDir(ctx.paths, ctx.project);
  const text = await git(['cat-file', '-p', ctx.payload.configBlob], { cwd: clone });
  return parseProjectConfig(text, `${ctx.project}#${ctx.payload.configBlob}`);
}

function runEvents(ctx) {
  return readEvents(runLedgerPath(ctx.paths, ctx.runId));
}

/** The latest park of a type and the answer that followed it, if any. */
function answeredPark(events, type) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'park' && e.type === type) {
      const answer = events.slice(i + 1).find((a) => a.event === 'answer' && a.parkSeq === e.seq);
      return { park: e, answer: answer ?? null };
    }
  }
  return null;
}

/** Every answered park as a Q→A pair, for seat role blocks. */
function escalationLog(events) {
  const pairs = [];
  for (const e of events) {
    if (e.event !== 'park') continue;
    const answer = events.find((a) => a.event === 'answer' && a.parkSeq === e.seq);
    if (answer) {
      pairs.push({
        type: e.type,
        question: e.question,
        answer: answer.option ?? answer.answer,
        actor: answer.actor,
      });
    }
  }
  return pairs;
}

/** Completed seat sessions for a seat (corrective re-prompts not counted). */
function invocationCount(events, seat) {
  return events.filter((e) => e.event === 'seat-spawned' && e.seat === seat && e.attempt === 1).length;
}

function seatReportAfter(events, seat, seq) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'seat-report' && e.seat === seat && e.seq > seq) return e;
  }
  return null;
}

function lastSeatReportEvent(events, seat) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'seat-report' && e.seat === seat) return e;
  }
  return null;
}

function readJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function parkDirective(type, { question, options, refs }) {
  return { park: { type, question, ...(options && { options }), ...(refs && { refs }) } };
}

function seatFail(seat, result) {
  return {
    close: {
      state: 'failed',
      reason: 'seat-failure',
      seat,
      ...(result.reason ? { cause: result.reason } : {}),
    },
  };
}

function commandFail(run) {
  // The command could not run at all — an environment defect, not a verdict.
  return { close: { state: 'failed', reason: 'suite-command-error', error: run.error } };
}

function underAny(file, prefixes) {
  const norm = file.replaceAll('\\', '/');
  return prefixes.some((p) => {
    const prefix = p.replaceAll('\\', '/').replace(/\/+$/, '');
    return norm === prefix || norm.startsWith(prefix + '/');
  });
}

function gist(text) {
  if (typeof text !== 'string') return '';
  return text.length > GIST_MAX ? text.slice(0, GIST_MAX - 1) + '…' : text;
}
