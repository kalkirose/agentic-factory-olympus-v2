// The story-lane pre-freeze chain: readiness (process) → spec birth (seat)
// → spec gate (seat, no round cap) → suite authoring (seat) → adversary
// (one wave per round by default, each in a disposable worktree) → freeze
// (process). The freeze record is the completion signal; the stages after
// freeze land with their milestones and enter through
// `storyLane({afterFreeze})`.
//
// A launch that names a prior run takes the second route through readiness:
// it inherits that run's freeze — spec, record and frozen suite — stamps the
// inheritance, and hands the tree straight to the post-freeze stage. No
// pre-freeze seat runs on that route.
//
// Every handler re-derives its position from the run ledger and the git
// state, so a daemon restart resumes mid-chain without memory. Deterministic
// defects in a seat's work product (boundary breaches, wrong red classes,
// uncovered survivors) take the contract-loop route: one corrective
// invocation, then the seat-failure park — no condition the lane meets on its
// own closes a run (ADR-0015).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandLogPath, runReportPath } from '../daemon/home.mjs';
import { textIdentity } from '../ledger/acks.mjs';
import { cloneDir } from '../isolation/clones.mjs';
import { addDisposableWorktree, removeWorktree, workspaceRoot } from '../isolation/worktrees.mjs';
import {
  abortMerge,
  changedFiles,
  changedInRange,
  commitAll,
  headSha,
  mergeIntoTree,
  restorePaths,
  evidenceDiff,
  filesAt,
  filesMentioning,
  treeFiles,
} from '../isolation/tree.mjs';
import { testEditDenyRules } from '../seats/boundary.mjs';
import { laneDiffPolicy, parseTouchedBlock } from '../seats/diffpolicy.mjs';
import { noCriteriaMessage, parseIntentCard } from './card.mjs';
import { SECURITY_DIMENSIONS } from './lenses.mjs';
import { runCommand } from './exec.mjs';
import { probeCredentials } from './probes.mjs';
import { readInheritance } from './resume.mjs';
import {
  SUPERSEDE_BRIEF_LINES,
  SUPERSEDE_CLAIM_PROPERTIES,
  authorizeSupersede,
  ownerPinnedFiles,
  refusalLine,
  supersedeClaim,
} from './supersede.mjs';
import {
  SPEC_LINE_CAP,
  amendedSections,
  componentIndex,
  frozenExclusions,
  lintSpec,
  supersedeTargets,
} from './speclint.mjs';
import {
  ACTOR,
  loadProjectConfig,
  readConstitution,
  runEnv,
  runEvents,
  answeredPark,
  escalationLog,
  invocationCount,
  seatReportAfter,
  lastSeatReportEvent,
  readJson,
  parkDirective,
  withAbandonGuard,
  withTreeRefresh,
  seatWithChecks,
  blocked,
  commandError,
  seatFail,
  commandFail,
  underAny,
  briefLines,
  gist,
} from './shared.mjs';

// Waves per adversary round when the project declares no count. One wave
// buys the kill/survive signal; every wave past the first buys sample size
// for the kill rate, at a full seat plus a full suite run each. The count is
// project config (`lanes.story.adversaryWaves`), and the launch pins the
// config blob, so a raise takes effect at the next launch and never mid-run
// (ADR-0006).
const DEFAULT_ADVERSARY_WAVES = 1;

export const PRE_FREEZE_STAGES = ['readiness', 'spec-birth', 'spec-gate', 'suite', 'adversary', 'freeze'];

/**
 * Builds the story lane. `afterFreeze` is the post-freeze continuation
 * (implementation → verdict → ship), landing with its own milestones; the
 * freeze stage hands over to its first stage.
 * @param {{afterFreeze: {stages: string[], handlers: object},
 *   forgeFor?: (ctx: object) => object}} opts `forgeFor` resolves the forge of
 *   one run from the run's project, as it does for the ship step: readiness
 *   asks it what CI holds, so a credential is proven on every surface before
 *   the first seat spawns. Unset, a declared CI surface reads as unproven and
 *   readiness parks rather than passing it.
 */
export function storyLane({ afterFreeze, forgeFor = null }) {
  if (!Array.isArray(afterFreeze?.stages) || afterFreeze.stages.length === 0) {
    throw new Error('storyLane requires an afterFreeze continuation');
  }
  const postFreeze = afterFreeze.stages[0];
  return {
    stages: [...PRE_FREEZE_STAGES, ...afterFreeze.stages],
    // The lane root carries both stage-entry guards: the abandon route the
    // human takes out of any park (ADR-0015), and, inside it, the tree refresh
    // a bought retry is owed (ADR-0055).
    handlers: withAbandonGuard(
      withTreeRefresh({
        readiness: readinessHandler(postFreeze, forgeFor),
        'spec-birth': specBirth,
        'spec-gate': specGate,
        suite: suiteStage,
        adversary,
        freeze: freezeHandler(postFreeze),
        ...afterFreeze.handlers,
      }),
    ),
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
    // The amendment's own account of its scope, for the run record. The gate
    // scopes its re-check on the diff of the two spec versions instead, so a
    // declaration that understates the edit cannot narrow a re-check.
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
          // Where the defect can be settled, not how much it matters.
          // "blocking": the spec is wrong, unassertable, or would force a
          // defective implementation. "note": prose the suite proves against
          // running code. An absent severity is read as blocking.
          severity: { type: 'string', enum: ['blocking', 'note'] },
        },
        // `severity` is not required: an omitted value reads as blocking, so
        // a seat that never learned the field cannot weaken a gate.
        required: ['section', 'finding', 'evidence'],
      },
    },
    // A conflict says so with a boolean. A field whose only "no" is emptiness
    // gets prose that means "no conflict" and parks the run for a human.
    //
    // The claim beside it says the card already settled the conflict, and it is
    // the other way round: four facts or nothing, because the direction that
    // skips the owner is the one that has to be earned (ADR-0044).
    intentConflict: {
      type: 'object',
      additionalProperties: false,
      properties: {
        conflict: { type: 'boolean' },
        detail: { type: 'string' },
        ...SUPERSEDE_CLAIM_PROPERTIES,
      },
      required: ['conflict', 'detail'],
    },
    summary: { type: 'string' },
  },
  // `intentConflict` stays optional: an absent field is no conflict, so a seat
  // that omits it cannot park the run by accident.
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

/**
 * Readiness is the lane's admission gate, and it has two routes. A normal
 * launch is admitted on its intent card and derives everything after it. A
 * launch that names a prior run is admitted on that run's freeze instead: it
 * carries the artifacts over, hands the tree to `postFreezeStage`, and runs no
 * pre-freeze seat at all.
 */
function readinessHandler(postFreezeStage, forgeFor) {
  return async function readiness(ctx) {
    if (typeof ctx.payload.resumeFrom === 'string') {
      return inheritFreeze(ctx, postFreezeStage, forgeFor);
    }
    const worktree = ctx.payload.worktree;
    if (typeof worktree !== 'string' || !existsSync(worktree)) {
      return blocked(ctx, 'no-worktree', `The run worktree is gone: ${worktree ?? '(none)'}`);
    }
    const config = await loadProjectConfig(ctx);
    const story = config.lanes.story;
    if (!story) {
      return blocked(ctx, 'story-lane-unconfigured', 'The project config names no story lane.');
    }
    const cardPath = ctx.payload.card;
    if (typeof cardPath !== 'string' || cardPath.length === 0) {
      return blocked(ctx, 'no-card', 'The launch named no intent card.');
    }
    const file = join(worktree, cardPath);
    if (!existsSync(file)) {
      return blocked(ctx, 'card-missing', `No intent card at ${cardPath}.`, { card: cardPath });
    }
    const { card, errors } = parseIntentCard(readFileSync(file, 'utf8'));
    if (errors.length > 0) {
      return blocked(
        ctx,
        'card-invalid',
        `The intent card at ${cardPath} does not parse:\n${errors.map((e) => `- ${e}`).join('\n')}`,
        { errors },
      );
    }
    const noCriteria = criteriaBlock(ctx, card, cardPath);
    if (noCriteria) return noCriteria;
    if (story.lintCommand) {
      const lint = await runCommand(config.commands[story.lintCommand], {
        cwd: worktree,
        env: runEnv(ctx, config),
        log: commandLogPath(ctx.paths, ctx.runId, 'card-lint'),
      });
      if (lint.code === null) {
        return commandError(
          ctx,
          'lint-command-error',
          `The card lint command could not run: ${lint.error}`,
          { error: lint.error },
        );
      }
      if (lint.code !== 0) {
        return blocked(ctx, 'readiness-lint', `The card lint is red:\n${lint.output}`, {
          output: lint.output,
        });
      }
    }
    // The questions the card leaves open, and never the foreseen amendments a
    // close-out sweep wrote onto it. A foreseen amendment states a consequence
    // the card's own criteria already mandate, so there is nothing here for a
    // human to settle: the build-time classifier consumes the note as evidence
    // and the launch proceeds (ADR-0052).
    if (card.openDecisions.length > 0) {
      const events = runEvents(ctx);
      if (!answeredPark(events, 'open-decisions')?.answer) {
        return parkDirective('open-decisions', {
          question:
            `Resolve the open decisions on ${card.key ?? cardPath}:\n` +
            card.openDecisions.map((d) => `- ${d}`).join('\n'),
          text: 'the decisions, resolved',
          refs: [cardPath],
        });
      }
    }
    // Last, so the credentials are proven as late as readiness can prove them
    // and the first seat spawns behind a yes on every surface (ADR-0027).
    const probed = await probeCredentials(ctx, config, {
      phase: 'launch',
      cwd: worktree,
      env: runEnv(ctx, config),
      forge: resolveForge(ctx, forgeFor),
      defaultBranch: ctx.payload.defaultBranch ?? 'main',
    });
    if (probed) return probed;
    return { next: 'spec-birth' };
  };
}

/**
 * The forge readiness asks about the CI surface, or null. A resolver that
 * refuses — a project the instance holds no repository for — answers null
 * rather than failing the stage: the credential gate is what a missing forge
 * costs, and it says so in the park instead of taking down a launch that
 * declares no CI surface at all.
 */
function resolveForge(ctx, forgeFor) {
  if (typeof forgeFor !== 'function') return null;
  try {
    return forgeFor(ctx);
  } catch {
    return null;
  }
}

/**
 * The criterion-set guard, or null when the card names criteria. The card is
 * the only source of the set the spec mirrors, so a card that yields none
 * leaves every later stage judging a spec against nothing. That is a defect of
 * the card or of the parser, and a seat can fix neither, so the run parks
 * stage-blocked (ADR-0015) instead of spending a corrective invocation on it.
 * Readiness asks first; the two stages that lint a spec ask again, because the
 * card sits in a worktree that a seat can write to.
 */
function criteriaBlock(ctx, card, cardPath) {
  if ((card?.acceptance ?? []).length > 0) return null;
  return blocked(ctx, 'card-no-criteria', noCriteriaMessage(cardPath), { card: cardPath });
}

// -- the resume route --------------------------------------------------------

/**
 * Admits a run on a prior run's freeze. The card gates are not re-run: the
 * prior run passed them, and its answers are already written into the spec
 * this run inherits. The gates that replace them are about the freeze itself,
 * and each one refuses by name rather than guessing.
 */
async function inheritFreeze(ctx, nextStage, forgeFor) {
  const events = runEvents(ctx);
  if (events.some((e) => e.event === 'freeze-inherited')) return { next: nextStage };
  const worktree = ctx.payload.worktree;
  if (typeof worktree !== 'string' || !existsSync(worktree)) {
    return blocked(ctx, 'no-worktree', `The run worktree is gone: ${worktree ?? '(none)'}`);
  }
  const config = await loadProjectConfig(ctx);
  const story = config.lanes.story;
  if (!story) {
    return blocked(ctx, 'story-lane-unconfigured', 'The project config names no story lane.');
  }
  // An inherited freeze skips the card gates and hands the tree to a dev seat,
  // so this route asks the credential question for itself, before the stamp
  // that makes the inheritance permanent (ADR-0027).
  const probed = await probeCredentials(ctx, config, {
    phase: 'launch',
    cwd: worktree,
    env: runEnv(ctx, config),
    forge: resolveForge(ctx, forgeFor),
    defaultBranch: ctx.payload.defaultBranch ?? 'main',
  });
  if (probed) return probed;
  let prior;
  try {
    prior = readInheritance(ctx.paths, ctx.payload.resumeFrom);
  } catch (error) {
    return blocked(
      ctx,
      'inherit-invalid',
      `The freeze of run ${ctx.payload.resumeFrom} cannot be inherited: ${error.message}`,
      { from: ctx.payload.resumeFrom, cause: error.message },
    );
  }
  // The artifacts travel as files: the spec the gate passed, and the record
  // that certified the suite. The record is copied verbatim — it names the run
  // that earned it, and evidence is never rewritten to read as this run's own.
  const runDir = join(ctx.paths.runs, ctx.runId);
  mkdirSync(runDir, { recursive: true });
  copyFileSync(prior.specPath, join(runDir, 'spec.md'));
  copyFileSync(prior.freezePath, join(runDir, 'freeze.json'));

  let sha = await headSha(worktree);
  const base = ctx.payload.baseSha;
  if (typeof base !== 'string') {
    // No base means no way to tell whether the freeze still applies. The
    // launch always records one, so this is a refusal, never a skip.
    return blocked(
      ctx,
      'inherit-invalid',
      `The freeze of run ${prior.runId} cannot be inherited: the launch recorded no base sha.`,
      { from: prior.runId, cause: 'the launch recorded no base sha' },
    );
  }
  if (prior.baseSha !== base) {
    const directive = await advanceBase(ctx, {
      worktree,
      config,
      story,
      prior,
      base,
      from: sha,
    });
    if (!directive.sha) return directive; // a refusal: park or the abandon close
    sha = directive.sha;
  }
  ctx.store.append('freeze-inherited', {
    actor: ACTOR,
    from: prior.runId,
    sha,
    frozenSha: prior.frozenSha,
    base,
    priorBase: prior.baseSha,
    spec: join(runDir, 'spec.md'),
    record: join(runDir, 'freeze.json'),
    files: prior.record.suiteFiles?.length ?? 0,
    killCount: prior.record.killCount ?? 0,
    // What stays behind. A finding is evidence about the tree it was found
    // on, and this run discards that tree, so no finding is carried forward
    // as its own. The prior ledger keeps them, open and readable, and the
    // stamp names them so the trail from here is one hop. Escapes need no
    // carry at all: they live in the instance-scoped escapes ledger, which
    // no run owns and no launch touches.
    priorFindings: prior.openFindings,
    priorLoud: prior.openLoud,
  });
  return { next: nextStage };
}

/**
 * The default branch advanced under the inherited freeze. The freeze's
 * evidence is a claim about a tree, so a moved tree gets the claim re-derived
 * where that is possible and refused where it is not:
 * - main edited the frozen suite: refuse, naming the files. The suite that was
 *   proven is not the suite that would run.
 * - the merge conflicts: refuse, naming the files. Resolution is judgment
 *   work, and it belongs to a run that owns its own spec.
 * - the merged tree passes the suite: refuse. Red state is the freeze's core
 *   claim, and a green suite says the feature is already there.
 * The merge follows the ship step's rule — merge main in, never rewrite the
 * branch — so the frozen commit stays an ancestor of everything after it.
 */
async function advanceBase(ctx, { worktree, config, story, prior, base, from }) {
  const testPaths = config.repo.testPaths;
  const moved = await changedInRange(worktree, prior.baseSha, base);
  const suiteMoved = moved.filter((file) => underAny(file, testPaths));
  if (suiteMoved.length > 0) {
    return blocked(
      ctx,
      'inherit-suite-diverged',
      `${ctx.payload.defaultBranch ?? 'main'} edited the frozen suite of run ${prior.runId}; ` +
        'the suite that was proven is not the suite that would run:\n' +
        suiteMoved.map((f) => `- ${f}`).join('\n'),
      { from: prior.runId, files: suiteMoved },
    );
  }
  const defaultBranch = ctx.payload.defaultBranch ?? 'main';
  const merged = await mergeIntoTree(
    worktree,
    base,
    `merge ${defaultBranch} into ${ctx.payload.branch}`,
  );
  if (!merged.ok) {
    await abortMerge(worktree).catch(() => {});
    return blocked(
      ctx,
      'inherit-base-conflict',
      `The merge of ${defaultBranch} under the inherited freeze of run ${prior.runId} ` +
        'conflicts:\n' +
        merged.conflicts.map((f) => `- ${f}`).join('\n'),
      { from: prior.runId, files: merged.conflicts },
    );
  }
  ctx.store.append('branch-update', {
    actor: ACTOR,
    fromSha: from,
    toSha: merged.sha,
    mainSha: base,
  });
  const run = await runCommand(config.commands[story.suiteCommand], {
    cwd: worktree,
    env: runEnv(ctx, config),
    log: commandLogPath(ctx.paths, ctx.runId, 'red-state-inherited'),
  });
  if (run.code === null) return commandFail(ctx, run);
  const red = run.code !== 0;
  ctx.store.append('red-state-check', { actor: ACTOR, sha: merged.sha, result: red ? 'red' : 'green' });
  if (!red) {
    return blocked(
      ctx,
      'inherit-red-state-green',
      `The frozen suite of run ${prior.runId} is green on the advanced base (${merged.sha}); ` +
        'red state is the freeze\'s core claim.',
      { from: prior.runId, sha: merged.sha },
    );
  }
  return { sha: merged.sha };
}

// -- spec birth (seat) -------------------------------------------------------

async function specBirth(ctx) {
  const base = await laneBase(ctx);
  const noCriteria = criteriaBlock(ctx, base.card, base.cardPath);
  if (noCriteria) return noCriteria;
  const events = runEvents(ctx);
  if (events.some((e) => e.event === 'spec-born')) return { next: 'spec-gate' };
  const { report, fail } = await seatWithChecks(ctx, {
    seat: 'spec-birth',
    schema: SPEC_BIRTH_SCHEMA,
    cwd: base.worktree,
    env: base.env,
    constitution: base.constitution,
    buildRole: (brief) => birthRole(base, escalationLog(events), brief),
    checks: (r) => birthChecks(base, r),
    defectReason: 'spec-defect',
  });
  if (fail) return fail;
  if (report.outcome === 'grounding-conflict') {
    return parkDirective('grounding-conflict', {
      question: report.conflict?.trim() || report.summary,
      text: 'how the spec should stand against the conflict',
      refs: [base.cardPath],
    });
  }
  ctx.store.append('spec-born', {
    actor: ACTOR,
    specPath: base.specPath,
    summary: gist(report.summary),
  });
  return { next: 'spec-gate' };
}

/**
 * The birth work product: the file exists, and it holds the template. A
 * conflict is a refusal to author, so it is checked against nothing.
 */
async function birthChecks(base, report) {
  if (report.outcome === 'grounding-conflict') return [];
  if (!existsSync(base.specPath) || readFileSync(base.specPath, 'utf8').trim().length === 0) {
    return [`the spec is missing or empty at ${base.specPath}; author it there.`];
  }
  return specLintDefects(base);
}

/**
 * The spec lint at its two run points: after birth, and after every amendment
 * (ADR-0019). It runs before the spec gate spawns, so a template defect is
 * fixed by the seat that wrote it and never spends a gate round.
 */
export async function specLintDefects(base) {
  if (!base.card) return [];
  let text;
  try {
    text = readFileSync(base.specPath, 'utf8');
  } catch {
    return [`the spec is missing at ${base.specPath}; author it there.`];
  }
  return lintSpec(text, {
    card: base.card,
    cardPath: base.cardPath,
    worktree: base.worktree,
    testPaths: base.testPaths,
    tier: base.tier,
    baseFiles: await supersedeBaseFiles(base, text),
    ground: await specGround(base, text),
  });
}

/**
 * The tree the spec is written against, read for the four path rules
 * (ADR-0067): every tracked path at the base sha, the test files under the
 * test paths that mention each touched path, the routes root, and the
 * component names the design-system root holds. A run with no base sha reads
 * the worktree's index instead, which at birth is the same tree. A tree git
 * cannot read turns the rules off rather than parking a run on a lint that
 * could not look.
 *
 * The component listing is derived from the same `treeFiles` answer the first
 * two rules stand on, so the fourth rule costs no second look at the tree.
 */
async function specGround(base, text) {
  const sha = typeof base.baseSha === 'string' && base.baseSha.length > 0 ? base.baseSha : null;
  let files;
  try {
    files = await treeFiles(base.worktree, sha);
  } catch {
    return null;
  }
  const touched = [...new Set(parseTouchedBlock(text).entries.map((e) => e.path))];
  let pins = new Map();
  try {
    for (const path of touched) {
      pins.set(path, await filesMentioning(base.worktree, sha, path, base.testPaths ?? []));
    }
  } catch {
    pins = null;
  }
  const componentsRoot = base.componentsRoot ?? null;
  return {
    files,
    pins,
    routesRoot: base.routesRoot ?? null,
    componentsRoot,
    components: componentIndex(files, componentsRoot),
  };
}

/**
 * The supersede targets that exist at the spec's base sha — the tree every
 * Supersedes clause was written against. A run with no base sha on its payload,
 * a spec that supersedes nothing, and a sha git cannot read all answer null,
 * and the lint falls back to the worktree alone.
 */
async function supersedeBaseFiles(base, text) {
  const targets = supersedeTargets(text, { card: base.card });
  if (targets.length === 0) return null;
  if (typeof base.baseSha !== 'string' || base.baseSha.length === 0) return null;
  try {
    return await filesAt(base.worktree, base.baseSha, targets);
  } catch {
    return null;
  }
}

// -- spec gate (seat, as many rounds as it converges for) --------------------

/** Findings that hold the spec. An absent severity reads as blocking. */
function blockingFindings(findings) {
  return (findings ?? []).filter((f) => f.severity !== 'note');
}

/**
 * Whether a round closed none of the blocking findings the round before it
 * raised — the gate's first progress rule, keyed on identity rather than on a
 * count (ADR-0020). A count says three against three and cannot say whether
 * they are the same three: a round that closes two and opens two is
 * converging on a document that is moving, and a round that reports the same
 * three again is a round nobody needed. A round stamped before the identities
 * were recorded judges nothing here.
 */
function closedNothing(previous, last) {
  const prior = new Set(previous.blocking ?? []);
  if (prior.size === 0) return false;
  const open = new Set(last.blocking ?? []);
  return [...prior].every((identity) => open.has(identity));
}

/**
 * Why the gate stops, or null while it is still getting closer.
 *
 * Two conditions, either of which parks (ADR-0020). The first is identity: a
 * round that closed none of the previous round's blocking findings is the gate
 * oscillating, because each amendment rewrites spec text and the next re-check
 * reads the new text as new surface. The second is the count over two rounds:
 * a gate that closes one finding and opens one every round passes the identity
 * rule for ever, and the count is what says that trade is not progress. Two
 * rounds and not one, because closing two and opening two in a single round is
 * a document moving under a gate that is working, and the round after it says
 * which.
 *
 * A cap says nothing about either. Eleven gates on the ledger reached the cap
 * of two or its stall park, ten of them passed at rounds three to five once
 * the owner bought the rounds, and the answer at the park was "round" fourteen
 * times in fifteen. A budget that stops is not a budget (ADR-0021), so the
 * gate now runs for as long as it converges.
 */
function gateStall(rounds) {
  const last = rounds[rounds.length - 1];
  const previous = rounds[rounds.length - 2];
  const before = rounds[rounds.length - 3];
  if (previous && closedNothing(previous, last)) {
    return { rule: 'closed-nothing', last, against: previous };
  }
  if (before && last.findings >= before.findings) {
    return { rule: 'no-fall', last, against: before };
  }
  return null;
}

/** The stall park's question: both counts, the rounds they came from, and why. */
function stallQuestion(stall, base) {
  const { last, against } = stall;
  const opening =
    stall.rule === 'closed-nothing'
      ? `The spec gate is not converging. Round ${last.round} ended with ` +
        `${last.findings} blocking findings against ${against.findings} in round ` +
        `${against.round}, and closed none of them — every finding that round raised is ` +
        `open again, by identity; notes: ${last.notes ?? 0}. `
      : `The spec gate is not converging. Round ${last.round} ended with ` +
        `${last.findings} blocking findings against ${against.findings} in round ` +
        `${against.round}, two rounds back, so the count has not fallen across two ` +
        `rounds; notes: ${last.notes ?? 0}. `;
  return (
    opening +
    'Notes do not hold the spec; they travel to the suite seat as proof obligations. ' +
    'The gate stops here rather than spend another round on a document ' +
    `that is not getting closer. The spec stands at ${base.specPath}. ` +
    'Answer "round" for one more amendment and re-check, or "abandon" to close the run.'
  );
}

/** Every note the gate raised across its rounds, in the order it raised them. */
function gateNotes(events) {
  const notes = [];
  for (const e of events) {
    if (e.event !== 'seat-report' || e.seat !== 'spec-gate') continue;
    const report = readJson(e.path);
    for (const f of report?.findings ?? []) {
      if (f.severity === 'note') notes.push(f);
    }
  }
  return notes;
}

/**
 * The gate park of a type raised after a given round, with its answer. Keyed
 * on the round rather than on the type alone: a bought round is spent, so the
 * next park must ask again instead of reading the answer that bought it.
 */
function gatePark(events, type, afterSeq) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== 'park' || e.type !== type || e.seq <= afterSeq) continue;
    const answer = events.slice(i + 1).find((a) => a.event === 'answer' && a.parkSeq === e.seq);
    return { park: e, answer: answer ?? null };
  }
  return null;
}

/**
 * The spec as a round judged it. Every round writes one before it
 * spawns its seat, so the next round derives its own scope from two documents
 * instead of trusting the amendment's account of what it changed. The copies
 * live beside the spec in the run directory and archive with the run.
 */
function roundSpecPath(ctx, round) {
  return join(ctx.paths.runs, ctx.runId, `spec-round-${round}.md`);
}

/** The findings the last round reported, verbatim, notes included. */
function priorRoundFindings(events) {
  const rounds = events.filter((e) => e.event === 'spec-gate-round');
  const last = rounds[rounds.length - 1];
  if (!last) return [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'seat-report' && e.seat === 'spec-gate' && e.seq < last.seq) {
      return readJson(e.path)?.findings ?? [];
    }
  }
  return [];
}

async function specGate(ctx) {
  const base = await laneBase(ctx);
  for (;;) {
    const events = runEvents(ctx);
    const rounds = events.filter((e) => e.event === 'spec-gate-round');
    const last = rounds[rounds.length - 1];
    // An answered intent conflict directs one amendment before any re-check;
    // the conflict never burns a round.
    const conflict = answeredPark(events, 'intent-conflict');
    if (conflict?.answer && !seatReportAfter(events, 'spec-birth', conflict.answer.seq)) {
      // The parking round stamps nothing, so its findings have no other route
      // into the amendment. They travel with the conflict answer or they die.
      const parked = readJson(lastSeatReportEvent(events, 'spec-gate').path);
      const findings = blockingFindings(parked?.findings);
      const brief =
        findings.length > 0
          ? `${conflictBrief(conflict)}\n${findingsBrief(findings)}`
          : conflictBrief(conflict);
      const amend = await amendSpec(ctx, base, brief);
      if (amend.fail) return amend.fail;
      continue;
    }
    if (last?.verdict === 'pass') return { next: 'suite' };
    if (rounds.length === 0) {
      const r = await gateRound(ctx, base, { round: 1 });
      if (r.directive) return r.directive;
      if (r.amend) {
        const amend = await amendSpec(ctx, base, r.amend);
        if (amend.fail) return amend.fail;
      }
      continue;
    }
    // Convergence, and nothing else. The gate has no round cap: a spec that is
    // getting closer every round is a gate doing its work, and the cost of it
    // informs through the budget record and stops nothing (ADR-0021). What
    // stops the gate is a round that stopped closing findings, by either of
    // the two rules, and that is one park with both counts in it.
    const stall = gateStall(rounds);
    if (stall) {
      const asked = gatePark(events, 'spec-gate-stalled', last.seq);
      if (!asked) {
        return parkDirective('spec-gate-stalled', {
          question: stallQuestion(stall, base),
          options: ['round'],
          refs: [base.cardPath],
        });
      }
      // An `abandon` answer never reaches here: the guard closed the run at
      // this stage entry (ADR-0015). A granted round falls through.
    }
    // A round with findings open: the birth seat amends, then the gate
    // re-checks the amended sections only.
    if (!seatReportAfter(events, 'spec-birth', last.seq)) {
      const report = readJson(lastSeatReportEvent(events, 'spec-gate').path);
      const amend = await amendSpec(ctx, base, findingsBrief(blockingFindings(report?.findings)));
      if (amend.fail) return amend.fail;
      continue;
    }
    const r = await gateRound(ctx, base, { round: rounds.length + 1 });
    if (r.directive) return r.directive;
    // The card settled a collision this round found. The amendment runs on the
    // card's authority, exactly where an answered ruling's amendment runs, and
    // the conflict burns no round either way (ADR-0044).
    if (r.amend) {
      const amend = await amendSpec(ctx, base, r.amend);
      if (amend.fail) return amend.fail;
    }
  }
}

async function gateRound(ctx, base, { round }) {
  const events = runEvents(ctx);
  const n = invocationCount(events, 'spec-gate') + 1;
  // The re-check's two additions: the parts the amendment moved, computed
  // from the spec the previous round judged, and that round's findings. A
  // first round, and any round whose predecessor left no copy, reviews whole.
  const prior = round > 1 ? roundSpecPath(ctx, round - 1) : null;
  const scope =
    prior && existsSync(prior)
      ? amendedSections(readFileSync(prior, 'utf8'), readFileSync(base.specPath, 'utf8'), {
          card: base.card,
        })
      : null;
  copyFileSync(base.specPath, roundSpecPath(ctx, round));
  const result = await ctx.runSeat({
    seat: 'spec-gate',
    roleBlock: gateRole(base, { scope, priorFindings: priorRoundFindings(events) }),
    reportPath: runReportPath(ctx.paths, ctx.runId, `spec-gate-${n}`),
    schema: SPEC_GATE_SCHEMA,
    cwd: base.worktree,
    env: base.env,
    constitution: base.constitution,
  });
  if (!result.ok) return { directive: seatFail(ctx, 'spec-gate', result) };
  const conflict = result.report.intentConflict;
  if (conflict?.conflict === true) {
    const detail = conflict.detail?.trim() || result.report.summary;
    // The card decides first. A collision its scope covers is an authorized
    // supersede: the amendment runs on the card's own words, the stamp records
    // which words, and the owner is never asked what the card already says
    // (ADR-0044). Everything the checks refuse parks, with the refusal named.
    const claim = supersedeClaim(conflict);
    const { event, refused } = authorizeSupersede(ctx.store, {
      actor: ACTOR,
      site: 'spec-gate',
      claim,
      cardText: base.cardText,
      cardPath: base.cardPath,
      worktree: base.worktree,
      testPaths: base.testPaths,
      pins: [],
      authorized: events
        .filter((e) => e.event === 'supersede-authorized')
        .map((e) => e.test),
      enabled: base.cardAuthorizedSupersede,
    });
    if (event) return { amend: supersedeBrief(detail, event) };
    return {
      directive: parkDirective('intent-conflict', {
        // The whole round, not the conflict alone. A ruling is given against
        // the state of the spec the round found, and the findings beside the
        // conflict are that state: an owner who reads the conflict on its own
        // rules on half a document, and the ruling comes back into an
        // amendment that has to carry the other half anyway. Three of the ten
        // intent-conflict parks on the ledger were answered "no conflict
        // exists", which is what a question asked without its context gets.
        question:
          `${detail}\n\nThe card did not settle it: ${refusalLine(refused, claim)}\n\n` +
          openFindingsBlock(result.report.findings),
        text: RULING_TEXT,
        refs: [base.cardPath],
      }),
    };
  }
  // Blocking findings hold the spec. Notes are prose the suite proves against
  // running code, so they travel to the suite seat rather than buy a round of
  // document editing. Nothing is waived: an unresolved note is a suite defect.
  const blocking = blockingFindings(result.report.findings);
  const notes = result.report.findings.length - blocking.length;
  ctx.store.append('spec-gate-round', {
    actor: ACTOR,
    round,
    verdict: blocking.length > 0 ? 'findings' : 'pass',
    findings: blocking.length,
    // The blocking set by identity, not by count alone: the next round's
    // progress rule reads which findings are still open, and a count cannot
    // tell three closed and three opened from three untouched (ADR-0020).
    blocking: blocking.map((f) => textIdentity(f.section, f.finding)),
    notes,
  });
  return { directive: null };
}

/**
 * One amendment of the born spec. The lint runs again on what comes back: an
 * amendment that breaks the template is a defect of the same kind as a birth
 * that never held it, and it takes the same corrective route.
 */
async function amendSpec(ctx, base, brief) {
  const noCriteria = criteriaBlock(ctx, base.card, base.cardPath);
  if (noCriteria) return { fail: noCriteria };
  return seatWithChecks(ctx, {
    seat: 'spec-birth',
    schema: SPEC_AMEND_SCHEMA,
    cwd: base.worktree,
    env: base.env,
    constitution: base.constitution,
    buildRole: (defects) => amendRole(base, brief, defects),
    checks: () => specLintDefects(base),
    defectReason: 'spec-defect',
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
    phase: 'author',
    schema: SUITE_SCHEMA,
    buildRole: (brief) => suiteAuthorRole(base, brief),
    checks: (r) => suiteChecks(ctx, base, r, 'author'),
  });
  if (fail) return fail;
  const sha = await commitAll(base.worktree, `suite: ${base.card.key}`);
  ctx.store.append('suite-committed', { actor: ACTOR, sha, phase: 'author', files: report.suiteFiles });
  return { next: 'adversary' };
}

/**
 * The suite seat on the lane's contract loop: one corrective invocation on a
 * deterministic defect in the work product, then the seat-failure park.
 *
 * The one failure it re-routes is a declared-ground check that could not run at
 * all. That is a defect of this host and not of the suite the seat wrote, so it
 * takes the route every unrunnable command takes rather than spending the
 * seat's corrective round on a brief no seat can answer (ADR-0060).
 */
async function suiteSeatWithChecks(ctx, base, { phase, schema, buildRole, checks }) {
  const outcome = await seatWithChecks(ctx, {
    seat: 'suite',
    schema,
    cwd: base.worktree,
    env: base.env,
    constitution: base.constitution,
    buildRole,
    checks,
    defectReason: 'suite-defect',
  });
  const unrun = lastGroundCheck(runEvents(ctx));
  if (unrun?.result === 'unrun' && unrun.phase === phase) {
    return {
      fail: commandError(
        ctx,
        'ground-command-error',
        'The declared-ground check of this project could not run, so nothing read the suite ' +
          `this run wrote: ${unrun.cause}\n` +
          'Repair the environment, then answer "retry" for one more attempt, or ' +
          '"abandon" to close the run.',
        { cause: unrun.cause },
      ),
    };
  }
  return outcome;
}

async function suiteChecks(ctx, base, report, phase) {
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
  await groundCheck(ctx, base, phase, defects);
  return defects;
}

/**
 * The project's own declared-ground check, run over the suite as the seat left
 * it. It is here rather than after the freeze because of where the two put the
 * repair: a suite file that declares no ground is a lost skip and no more, but
 * the check that finds it after the freeze finds it in a frozen file, and the
 * correction then costs a repair round, a re-freeze and a second verdict. Three
 * runs paid that in one week. Here the file is not committed, the seat that
 * wrote it is still live, and the correction is one brief (ADR-0060).
 *
 * Every suite write of the pre-freeze chain passes through it — the authoring
 * round, an adversary amendment, a strengthening round, the red-state fix —
 * because each of them can add the file that declares nothing, and a check at
 * the authoring round alone would let the other three past.
 *
 * A red is a work-product defect and re-briefs the seat with the check's own
 * output, which names the file and the family. A command that could not run is
 * not a defect of the suite and pushes no defect: it is stamped, and the lane's
 * seat wrapper turns it into the command-error park it belongs in. A project
 * that names no ground command stamps nothing and the step is not there.
 */
async function groundCheck(ctx, base, phase, defects) {
  const name = base.story.groundCommand;
  if (!name) return;
  const n = runEvents(ctx).filter((e) => e.event === 'ground-check').length + 1;
  const run = await runCommand(base.config.commands[name], {
    cwd: base.worktree,
    env: base.env,
    log: commandLogPath(ctx.paths, ctx.runId, `ground-check-${n}`),
  });
  const stamp = (result, fields) =>
    ctx.store.append('ground-check', { actor: ACTOR, phase, result, ...fields });
  if (run.code === null) {
    stamp('unrun', { cause: run.error ?? 'the command did not start' });
    return;
  }
  if (run.code === 0) {
    stamp('green');
    return;
  }
  stamp('red', { code: run.code });
  defects.push(
    'the declared-ground check of this project is red on the suite you wrote; every suite ' +
      'file must belong to a family and every family must declare the ground that can change ' +
      `its answer:\n${run.output}`,
  );
}

/** The last declared-ground check this run ran, or null. */
function lastGroundCheck(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === 'ground-check') return events[i];
  }
  return null;
}

// -- adversary ---------------------------------------------------------------

async function adversary(ctx) {
  const base = await laneBase(ctx);
  const perRound = base.adversaryWaves;
  const clone = cloneDir(ctx.paths, ctx.project);
  for (;;) {
    const events = runEvents(ctx);
    const round =
      1 + events.filter((e) => e.event === 'suite-committed' && e.phase === 'strengthening').length;
    const waves = events.filter(
      (e) => e.event === 'adversary-wave' && e.phase === 'initial' && e.round === round,
    );
    // 1) Run the round's missing waves; every wave goes to verdict.
    if (waves.length < perRound) {
      const done = new Set(waves.map((e) => e.wave));
      for (let wave = 1; wave <= perRound; wave++) {
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
    const kills = perRound - survivors.length;
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
            `Adversary round ${round} scored 0/${perRound} after a strengthening round. Survivors:\n` +
            survivorLines(ctx, round, survivors) +
            '\nPick an option.',
          options: ['strengthen-again'],
        });
      }
      if (park.answer.option === 'strengthen-again') {
        const fail = await strengthen(ctx, base, clone, { round, survivors });
        if (fail) return fail;
        continue;
      }
      // `abandon` closed the run at the guard, and the record offers nothing
      // else; an answer that is neither asks again rather than pick for the
      // human.
      return parkDirective('second-zero-kill', {
        question: 'The answer picked no option. Pick one.',
        options: ['strengthen-again'],
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
          options: ['accept-spec-indifferent'],
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
      // `abandon` closed the run at the guard; anything else asks again.
      return parkDirective('unkilled-gap-survivor', {
        question: 'The answer picked no option. Pick one.',
        options: ['accept-spec-indifferent'],
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
    env: base.env,
    denyTools: testEditDenyRules(base.testPaths),
  });
  if (!result.ok) return seatFail(ctx, 'adversary', result);
  // Restore the suite from the sha before evaluation — a tampered test file
  // is structurally void, not detected.
  await restorePaths(tree, sha, base.testPaths);
  const run = await runCommand(base.suiteArgv, {
    cwd: tree,
    env: base.env,
    log: commandLogPath(ctx.paths, ctx.runId, `adversary-r${round}-w${wave}`),
  });
  if (run.code === null) return commandFail(ctx, run);
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
    return blocked(
      ctx,
      'wave-tree-missing',
      `The survivor tree of round ${round} wave ${wave} is gone; the killing test ` +
        'has nothing to re-run against.',
      { round, wave },
    );
  }
  await restorePaths(tree, sha, base.testPaths);
  const run = await runCommand(base.suiteArgv, {
    cwd: tree,
    env: base.env,
    log: commandLogPath(ctx.paths, ctx.runId, `adversary-r${round}-w${wave}-rerun`),
  });
  if (run.code === null) return commandFail(ctx, run);
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
    phase: 'amendment',
    schema: SUITE_AMEND_SCHEMA,
    buildRole: (brief) => amendmentRole(base, evidence, brief),
    checks: async (r) => {
      const defects = await suiteChecks(ctx, base, r, 'amendment');
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
    phase: 'strengthening',
    schema: SUITE_SCHEMA,
    buildRole: (brief) => strengthenRole(base, evidence, brief),
    checks: (r) => suiteChecks(ctx, base, r, 'strengthening'),
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
  // The removal falls back to a direct delete of its own; a wave tree that
  // survives that as well goes to the workspace release at close.
  await removeWorktree(clone, tree).catch(() => {});
}

// -- freeze (process) --------------------------------------------------------

function freezeHandler(nextStage) {
  return async function freeze(ctx) {
    const base = await laneBase(ctx);
    // Red-state: the suite must be red against the pre-implementation tree,
    // by feature absence alone. One corrective fix round on green, then fail.
    for (let attempt = 1; ; attempt++) {
      const sha = await headSha(base.worktree);
      const run = await runCommand(base.suiteArgv, {
        cwd: base.worktree,
        env: base.env,
        log: commandLogPath(ctx.paths, ctx.runId, `red-state-a${attempt}`),
      });
      if (run.code === null) return commandFail(ctx, run);
      const red = run.code !== 0;
      ctx.store.append('red-state-check', { actor: ACTOR, sha, result: red ? 'red' : 'green' });
      if (red) break;
      if (attempt === 2) {
        ctx.store.append('seat-failure', { actor: ACTOR, seat: 'suite', reason: 'red-state-green' });
        return seatFail(ctx, 'suite', { reason: 'red-state-green' });
      }
      const { report, fail } = await suiteSeatWithChecks(ctx, base, {
        phase: 'fix',
        schema: SUITE_SCHEMA,
        buildRole: (brief) => redStateFixRole(base, brief),
        checks: (r) => suiteChecks(ctx, base, r, 'fix'),
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
    // The exclusions: test-path files the spec assigned to the implementing
    // seat. They are named at the freeze because that is where the frozen set
    // is fixed, and every reader after it takes the two apart from one record
    // (ADR-0019). Everything else under the test paths is the frozen suite.
    const exclusions = frozenExclusions(readFileSync(base.specPath, 'utf8'), base.testPaths);
    // The pins: frozen tests that carry the owner marker. They are read where
    // the frozen set is fixed, for the reason the exclusions are — a later
    // reader takes both off one record — and a pinned test's collision parks
    // whatever the card says (ADR-0044).
    const pinned = ownerPinnedFiles(base.worktree, suiteFiles);
    const record = {
      runId: ctx.runId,
      project: ctx.project,
      card: ctx.payload.card,
      storyKey: base.card.key,
      specRef: base.specPath,
      suiteSha: sha,
      suiteFiles,
      frozenExclusions: exclusions,
      ownerPinned: pinned,
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
      exclusions: exclusions.length,
      ...(pinned.length > 0 && { pins: pinned.length }),
      record: recordPath,
    });
    return { next: nextStage };
  };
}

// -- role blocks -------------------------------------------------------------

function birthRole(base, resolved, brief = null) {
  const lines = [
    'Author the story spec from the intent card below.',
    'Ground every claim in the repository as it stands; cite file paths for grounding claims.',
    `Write the spec as markdown to this absolute path: ${base.specPath}`,
    "Stay inside the card's scope boundary. Encode every acceptance criterion so a test can assert it.",
    ...templateLines(),
    // The spec writes the test plan, so it needs the two facts that decide
    // where a test can live and what will run it. Without them a plan can
    // name a runner the suite seat is not allowed to reach.
    ...suiteFacts(base),
    'If the repository state conflicts with the card\'s intent, do not author around the conflict: set outcome "grounding-conflict" and describe the conflict.',
    'Otherwise set outcome "spec-born".',
  ];
  if (resolved.length > 0) {
    lines.push('Decisions already made for this run (honor them):');
    for (const pair of resolved) {
      lines.push(`- [${pair.type}] ${pair.question} → ${pair.answer} (${pair.actor})`);
    }
  }
  lines.push(...briefLines(brief));
  lines.push(`Intent card (${base.cardPath}):`, base.cardText);
  return lines.join('\n');
}

/**
 * The template. It is stated to the seat that writes the spec and checked
 * mechanically on what comes back (ADR-0019), so the two never drift.
 *
 * Every part of it exists because its absence cost a run. A clause with no
 * criterion behind it binds the suite, the implementer and the review, and
 * nothing ever asks where it came from; a test plan without file paths cannot
 * be checked against the paths the suite may use; a constant restated in three
 * places is three constants; a clause that contradicts a frozen test is a
 * deadlock nobody declared. The cap is what keeps the document readable whole.
 *
 * The one-line mapping rule is stated beside the cap because a seat that meets
 * the cap by reflowing its mapping list destroys the one structure the lint
 * reads there: a run compressed a spec that way, and every mapping after the
 * first line of each list stopped being a mapping.
 */
function templateLines() {
  return [
    'The spec has a fixed template. Write these parts, in this order, and nothing else:',
    '1. A header: the card key, the base sha, and the scope exclusions the card states.',
    '2. One section per acceptance criterion on the card, in card order, each titled with that criterion\'s id as the card writes it — copied verbatim, never renumbered and never renamed — and holding, in this order:',
    '   - the intent of the criterion, three sentences at most;',
    '   - a line "Test mapping:" and under it one list item per asserted behavior, written "<path> — <the behavior the test asserts>": the repo-relative path of the test file first, on the same line as the behavior. One mapping is one bullet on one line. Never wrap a mapping across two lines and never nest a list under one, however long the line runs;',
    '   - a line "Named constants:" and under it one list item per constant, written "NAME = value". A constant is named in one place; every other mention refers to it.',
    '   - a line "Supersedes:" and under it one list item per frozen test this criterion contradicts, written "<path> — keep|supersede — <the clause that replaces it>". Write "- None" when it contradicts none.',
    '3. One fenced block, opened by ```touched-paths and closed by ```, naming every repo-relative path the work touches: one path per line, each followed by " — dev" or " — suite" for the seat that owns the file. Exactly one such block in the document, and every line names one file.',
    '   Every path in the block exists in the repository as it stands, or the work creates it. Write a path the work creates with the marker (new) between the path and the owner: "src/new-module.mjs (new) — dev". The lint refutes a path that is neither.',
    '   A test file that mentions a touched path by its repo-relative path is a pin on it. Name every such pin in the block, or name it in the Supersedes clause of the criterion that replaces it; the lint reports a pin the spec says nothing about.',
    '   A route id in prose, such as /[lang=lang]/cart, names a directory under the routes root of the repository. Name only routes that exist there, or mark a route the work creates: `/[lang=lang]/cart` (new).',
    '   A story that changes a rendered surface re-renders that surface\'s existing visual baseline files, so name each of those files in the block as a dev-owned entry and they join the freeze exclusions. A baseline the block does not name is frozen: the capture reverts the write, and the change costs a verdict round-trip to reach the suite.',
    '4. A section titled "Components", listing every design-system component the story renders, one per line as a list item: `Name`, or `Name` (new) for a component the story creates. Write "- None." when the story renders none. The lint refuses a component the design system does not hold and does not mark new, and the suite seat reads this list as the components its tests may target by test id.',
    '5. An environment section naming only the environment variables the card names.',
    `The whole document runs to ${SPEC_LINE_CAP} lines at most.`,
    'Meet the cap by writing less prose. Never meet it by reflowing a structured list: a mapping bullet the compression wrapped across lines is a defect, and the lint reports it as one.',
    'Only a criterion whose card text opens with no id of its own takes its position as its id: AC-1, AC-2, in card order. A criterion that carries an id keeps it, whatever its position.',
    'The card defines WHAT ships. The spec adds only HOW, plus the test encoding. A requirement with no acceptance criterion behind it is a defect, and so is a section that answers no criterion.',
  ];
}

function amendRole(base, brief, defects = null) {
  return [
    `Amend the born spec at this absolute path: ${base.specPath}`,
    'Edit the file in place. Keep unaffected sections unchanged.',
    'Report the headings of every section you amended.',
    ...templateLines(),
    'Brief:',
    brief,
    ...briefLines(defects),
    `Intent card (${base.cardPath}):`,
    base.cardText,
  ].join('\n');
}

// What a park asking for a ruling takes back. The answer is one statement,
// and it may rule on more than the conflict that raised the park: every
// finding the question lists carries an id for exactly that (ADR-0068).
const RULING_TEXT =
  'the decision the amendment must follow. Address any finding above by its id; ' +
  'the amendment carries every ruling the answer gives';

/**
 * Every finding the round left open, by id, with the section it sits in, the
 * channel it holds the spec on, and the defect it states. The ids are the
 * round's own order: a gate finding has no identity of its own outside the
 * round that raised it, and the question and the amendment brief that follows
 * it read the same list.
 */
function openFindingsBlock(findings) {
  const open = findings ?? [];
  if (open.length === 0) return 'The round left no other finding open.';
  return [
    'Every finding this round left open:',
    ...open.map(
      (f, i) =>
        `- [F${i + 1}] [${f.section}] ${f.severity === 'note' ? 'note' : 'blocking'} — ` +
        `${f.finding} (evidence: ${f.evidence})`,
    ),
  ].join('\n');
}

function conflictBrief(conflict) {
  return [
    'An intent conflict was escalated and answered.',
    `Conflict: ${conflict.park.question}`,
    `Answer (${conflict.answer.actor}): ${conflict.answer.option ?? conflict.answer.answer}`,
    'Amend the spec to honor the answer. The question above lists every finding that round ' +
      'left open, by id; where the answer rules on one of them, the amendment carries that ' +
      'ruling as well as the conflict.',
  ].join('\n');
}

/**
 * The brief of a collision the card settled. It carries the card's own line, so
 * the amendment is written against the words the authorization rests on and the
 * supersede clause the spec gains quotes the same source (ADR-0044).
 */
function supersedeBrief(detail, event) {
  return [
    'A frozen-surface collision was found, and the intent card authorizes the supersede.',
    `Collision: ${detail}`,
    `The card's ${event.clause} section says: "${event.cardQuote}"`,
    `The frozen test ${event.test} pins: ${event.assertion}`,
    'Amend the spec so the criterion states the supersede and names that test file in its ' +
      'Supersedes clause. Go exactly as far as the quoted card line reaches and no further.',
    'Restate what the pin protected in the form the card mandates. The guarantee survives in its ' +
      'new form; a pin is amended, never deleted.',
  ].join('\n');
}

function findingsBrief(findings) {
  return [
    'The spec gate found birth defects. Fix each finding:',
    ...findings.map((f) => `- [${f.section}] ${f.finding} (evidence: ${f.evidence})`),
  ].join('\n');
}

function gateRole(base, { scope, priorFindings }) {
  const lines = [
    'Fresh-context review of a born story spec.',
    `The spec: ${base.specPath}`,
    `The intent card: ${base.cardPath} (in your working directory).`,
    'Check three things and cite evidence for every finding:',
    "- grounding: spot-check the spec's claims against the repository;",
    "- scope: the spec must not widen past the card's scope boundary;",
    '- encodability: every acceptance criterion must be assertable by a test.',
    // The severity says where a defect can be settled, not how much it
    // matters. A document defect is settled in the document; a claim about
    // the tree is settled by a test that runs, never by prose a human
    // retypes every round.
    'Class every finding with "severity":',
    '- "blocking": the spec is wrong, a clause is not assertable, or the shape it states would force a defective implementation. A blocking finding holds the spec and buys an amendment round.',
    '- "note": prose the suite can prove against running code — a count of occurrences in the tree, the size of a pattern set, a name the code carries. A note does not hold the spec. It travels to the suite seat, which proves it with a test or reports it as unprovable.',
    'Never use "note" to pass a finding you cannot defend as suite-provable. When you are unsure which one a finding is, class it "blocking". An omitted severity counts as blocking.',
    'The spec lint has already refused a Components section that names a design-system component the tree does not hold and does not mark (new), so read that section as ground truth about the component set and judge what the spec does with it.',
    'Report "intentConflict" on every pass: {"conflict": false, "detail": ""} when the spec and the card agree.',
    'Set "conflict": true only when the spec and the card\'s intent disagree, and put the disagreement in "detail"; do not list it as a finding.',
    base.cardAuthorizedSupersede
      ? 'A conflict the card does not settle stops the run and waits for a human, so a note, an observation, or the word "none" belongs in the summary instead.'
      : 'A true value stops the run and waits for a human, so a note, an observation, or the word "none" belongs in the summary instead.',
    ...(base.cardAuthorizedSupersede ? SUPERSEDE_BRIEF_LINES : []),
  ];
  if (!scope) {
    lines.push('Review the whole spec.');
    return lines.join('\n');
  }
  // The re-check rule. A full re-review of an amended document finds new
  // surface every round, because the amendment wrote new text, so the open set
  // never shrinks and the gate never converges. The scope is what the machine
  // saw move; everything else was read once already and passed.
  lines.push(
    'This is a re-check, not a fresh review. The spec was amended to close the findings of the previous round.',
    scope.length > 0
      ? `Sections amended since the previous round: ${scope.join('; ')}`
      : 'Sections amended since the previous round: none.',
    'Re-check every amended section in full, exactly as you would on a first pass.',
    'For every finding of the previous round, say whether it is closed or still open. A finding that is still open keeps the severity it carried.',
    'A new defect in a section that was NOT amended is reported with severity "note", never "blocking". That text was reviewed and passed a round ago, and a gate that re-opens settled text spends the run on a document instead of shipping it.',
    'One exception, blocking wherever you find it, amended or not: a clause that contradicts a higher authority — the constitution, then the intent card. Name the document it contradicts in the evidence.',
    priorFindings.length > 0
      ? 'The findings of the previous round, verbatim:'
      : 'The previous round reported no finding.',
    ...priorFindings.map(
      (f) => `- [${f.section}] (${f.severity ?? 'blocking'}) ${f.finding} (evidence: ${f.evidence})`,
    ),
  );
  return lines.join('\n');
}

/** The two facts that bound any test plan: what runs the suite, and where a
 * test file may live. The spec seat and the suite seat both need them. */
function suiteFacts(base) {
  return [
    `The acceptance suite runs with: ${base.suiteArgv.join(' ')}`,
    `Suite files live only under: ${base.testPaths.join(', ')}`,
    'Every clause the suite asserts must be reachable by that command. A test plan that names a runner outside it cannot be authored.',
  ];
}

function suiteReportLines(base) {
  return [
    `Write test files only under: ${base.testPaths.join(', ')}. Touch nothing else.`,
    `The suite runs with: ${base.suiteArgv.join(' ')}`,
    'In the report, list every suite file and class every expected red.',
    'The suite must be red against the current tree only because the feature is absent.',
    // The component list, stated to every suite seat. It is the answer to the
    // question a suite file asks when it reaches for an element: which of
    // them does this story own? A suite that asserts on a component the spec
    // does not name is a pin on somebody else's surface, and the story that
    // changes that surface later pays for it.
    "The spec's Components section names the design-system components this story renders. Target those components and no others, through the story's own test ids; never through a page-wide locator by element type or role.",
    ...groundLines(base),
    ...noteLines(base),
  ];
}

/**
 * The declared-ground rule, stated to every seat that writes a suite file. The
 * check runs on what comes back either way; saying it first is what lets a seat
 * meet it without spending a corrective round on it (ADR-0060).
 */
function groundLines(base) {
  const name = base.story.groundCommand;
  if (!name) return [];
  return [
    `This project checks the declared ground of its suite with: ${base.config.commands[name].join(' ')}`,
    'Run it yourself before you report, and repair whatever it names. It runs again on what ' +
      'you hand back, and a red is a defect of your work product.',
  ];
}

/**
 * The spec-gate notes, carried to every suite invocation. A note is an
 * obligation, not a waiver: the gate found a claim it could not settle by
 * reading, so the suite settles it against running code. Every suite seat
 * gets them — author, amendment, strengthening, red-state fix — because each
 * one runs in fresh context and each one can delete the test that discharges
 * a note without ever knowing the obligation existed.
 */
function noteLines(base) {
  const notes = base.gateNotes ?? [];
  if (notes.length === 0) return [];
  return [
    'The spec gate raised these notes. A note is not a waiver. Each one names a fact the spec asserts in prose, and you own the proof.',
    'Prove each note with a test that asserts the fact against running code, and name that test in your summary.',
    'If a note cannot be proven by a test, report it as unprovable in your summary and give the reason. Leave no note unanswered.',
    ...notes.map((n) => `- [${n.section}] ${n.finding} (evidence: ${n.evidence})`),
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
    'Use every survivor below as evidence. A fresh adversary round follows.',
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

// The adversary brief. The security dimensions ride it because a wave is where
// a missing assertion is cheapest to find: an implementation the suite cannot
// tell from a right one on authorization or input trust is a gap the amendment
// round closes, and the test that closes it is frozen against every candidate
// after it (ADR-0038).
function adversaryRole(base) {
  return [
    'You work in a disposable worktree; nothing you write ships.',
    `Write a plausible wrong implementation against the spec at: ${base.specPath}`,
    'Goal: the acceptance suite passes while the behavior violates the spec.',
    'The dimensions below are wrong in ways a suite rarely asserts on, so weigh them',
    'beside the behavior the spec names when you pick your wrongness:',
    ...SECURITY_DIMENSIONS.map((dimension) => `- ${dimension}`),
    'Do not edit or delete test files; the suite is restored before evaluation.',
    'Report your approach and the deliberate wrongness.',
  ].join('\n');
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
    // The tree the spec is written against. A Supersedes clause names a file as
    // it stood here, not as the run's own commits later left it (ADR-0019).
    baseSha: typeof ctx.payload.baseSha === 'string' ? ctx.payload.baseSha : null,
    // Derived from the ledger like every other position in this lane, so a
    // restart mid-suite re-reads the same notes instead of losing them.
    gateNotes: gateNotes(runEvents(ctx)),
    constitution: readConstitution(worktree, config),
    testPaths: config.repo.testPaths,
    routesRoot: config.repo.routesRoot ?? null,
    componentsRoot: config.repo.componentsRoot ?? null,
    // The lane's diff policy. The spec lint judges the paths the spec plans
    // against the same tiers the candidate capture judges the diff against, so
    // a spec cannot plan a path the capture would refuse.
    tier: laneDiffPolicy(config, 'story'),
    adversaryWaves: story.adversaryWaves ?? DEFAULT_ADVERSARY_WAVES,
    // The card decides a frozen-surface collision unless the project says
    // otherwise. `false` restores the old default, where every collision is an
    // owner question (ADR-0044).
    cardAuthorizedSupersede: story.cardAuthorizedSupersede !== false,
    suiteArgv: config.commands[story.suiteCommand],
    env: runEnv(ctx, config),
    specPath: join(ctx.paths.runs, ctx.runId, 'spec.md'),
  };
}
