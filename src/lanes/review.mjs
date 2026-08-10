// The judgment review machinery: the Fury round (six lenses on five seats,
// interface conditional on UI diffs, fully parallel), the generalist review
// seat (all six lenses, diff-scoped — repair cycles and the repair lane),
// and the verifier. Confirm-to-block: a lane finding never blocks alone; the
// verifier confirms or refutes each HIGH against the code, and only
// confirmed HIGHs enter the verdict. Sub-HIGH findings never block and are
// never verified — they land in the run ledger as advisory material.
//
// No re-fan-out over a judged tree: the five-seat round fires once per
// implementation pass; every later cycle of the pass reviews the repair diff
// with the generalist seat and resolution-checks prior confirmed HIGHs.
import { runReportPath } from '../daemon/home.mjs';
import { ACTOR, runEvents, readJson, seatFail, underAny, briefLines, gist } from './shared.mjs';

export const FURY_SEATS = Object.freeze({
  'fury-spec': ['spec'],
  'fury-code-shape': ['architecture', 'minimality'],
  'fury-operational': ['operational'],
  'fury-security': ['security'],
  'fury-interface': ['interface'],
});

export const ALL_LENSES = Object.freeze(Object.values(FURY_SEATS).flat());

const LENS_CRITERIA = {
  spec: 'spec: the diff implements exactly the validated spec — nothing missing, nothing extra.',
  architecture: 'architecture: placement, coupling, abstraction, domain language.',
  minimality: 'minimality: reinvention, unearned generality, dead weight, comment discipline.',
  operational: 'operational: failure paths, data-layer discipline, idempotency, observability.',
  security: 'security: authorization on every entry point, input trust, secrets, trust boundaries.',
  interface: 'interface: rendered screens against the design reference.',
};

export function reviewSchema(lenses) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            lens: { type: 'string', enum: [...lenses] },
            severity: { type: 'string', enum: ['HIGH', 'MED', 'LOW'] },
            file: { type: 'string' },
            finding: { type: 'string' },
            evidence: { type: 'string' },
            approach: { type: 'boolean' },
          },
          required: ['lens', 'severity', 'finding', 'evidence'],
        },
      },
      summary: { type: 'string' },
    },
    required: ['findings', 'summary'],
  };
}

export const VERIFIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'resolved', 'unresolved'] },
          evidence: { type: 'string' },
          approach: { type: 'boolean' },
        },
        required: ['id', 'verdict', 'evidence'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['results', 'summary'],
};

/**
 * The five-seat Fury fan-out for one implementation pass. Fires the four
 * always-on seats plus the interface seat when the diff touches a UI path;
 * all seats run in parallel. HIGHs go to the verifier; findings stamp once
 * per cycle. Returns the confirmed HIGHs.
 */
export async function furyRound(ctx, base, { cycle, diffText, diffFiles }) {
  const seats = Object.keys(FURY_SEATS).filter(
    (seat) =>
      seat !== 'fury-interface' ||
      (base.uiPaths.length > 0 && diffFiles.some((f) => underAny(f, base.uiPaths))),
  );
  const outcomes = await Promise.all(
    seats.map((seat) =>
      reviewSeat(ctx, {
        seat,
        label: `${seat}-c${cycle}`,
        schema: reviewSchema(FURY_SEATS[seat]),
        roleBlock: furyRole(seat, base, diffText),
        cwd: base.worktree,
        env: base.env,
      }),
    ),
  );
  const failed = outcomes.find((o) => o.fail);
  if (failed) return { fail: failed.fail };
  const collected = outcomes.flatMap((o, i) =>
    o.report.findings.map((f) => ({ ...f, source: seats[i] })),
  );
  return settleFindings(ctx, base, { cycle, collected, priorConfirmed: [] });
}

/**
 * The generalist review seat: all six lenses over one diff. Used on repair
 * cycles (story lane) and as the only judgment seat of the repair lane. The
 * verifier fires only when HIGHs exist or prior confirmed HIGHs need a
 * resolution-check, so a clean small fix costs one review agent.
 */
export async function generalistReview(ctx, base, { cycle, diffText, priorConfirmed }) {
  const outcome = await reviewSeat(ctx, {
    seat: 'generalist-review',
    label: `generalist-review-c${cycle}`,
    schema: reviewSchema(ALL_LENSES),
    roleBlock: generalistRole(base, diffText),
    cwd: base.worktree,
    env: base.env,
  });
  if (outcome.fail) return { fail: outcome.fail };
  const collected = outcome.report.findings.map((f) => ({ ...f, source: 'generalist-review' }));
  return settleFindings(ctx, base, { cycle, collected, priorConfirmed });
}

/**
 * Splits collected findings on severity, verifies what must be verified,
 * stamps every finding once per cycle, and returns the confirmed HIGHs plus
 * the resolution results for prior confirmed findings.
 */
async function settleFindings(ctx, base, { cycle, collected, priorConfirmed }) {
  const highs = collected.filter((f) => f.severity === 'HIGH');
  const advisory = collected.filter((f) => f.severity !== 'HIGH');
  const items = [
    ...highs.map((f, i) => ({ id: `new-${i + 1}`, mode: 'confirm', finding: f })),
    ...priorConfirmed.map((f) => ({ id: f.id, mode: 'resolution-check', finding: f })),
  ];
  let results = new Map();
  if (items.length > 0) {
    const verified = await verifierSeat(ctx, base, { cycle, items });
    if (verified.fail) return { fail: verified.fail };
    results = verified.results;
  }
  const events = runEvents(ctx);
  const stampedForCycle = events.filter(
    (e) => e.event === 'finding' && e.cycle === cycle && e.source !== 'triage',
  );
  if (stampedForCycle.length > 0) {
    // Resumed after the stamp: the ledger holds the assigned ids.
    const confirmed = stampedForCycle
      .filter((e) => e.confirmed === true)
      .map((e) => ({
        id: e.id,
        source: e.source,
        lens: e.lens,
        severity: e.severity,
        summary: e.summary,
        evidence: e.evidence,
        confirmed: true,
        ...(e.approach && { approach: true }),
      }));
    const resolved = priorConfirmed
      .filter((f) => results.get(f.id)?.verdict === 'resolved')
      .map((f) => f.id);
    return { confirmed, resolved };
  }
  let nextId = 1 + events.filter((e) => e.event === 'finding').length;
  const confirmed = [];
  for (let i = 0; i < highs.length; i++) {
    const f = highs[i];
    const result = results.get(`new-${i + 1}`);
    const isConfirmed = result?.verdict === 'confirmed';
    const finding = {
      id: `F${nextId++}`,
      source: f.source,
      lens: f.lens,
      severity: f.severity,
      summary: f.finding,
      evidence: f.evidence,
      approach: isConfirmed && (result.approach ?? f.approach ?? false),
      confirmed: isConfirmed,
    };
    stampReviewFinding(ctx, cycle, finding, { advisory: !isConfirmed });
    if (isConfirmed) confirmed.push(finding);
  }
  for (const f of advisory) {
    stampReviewFinding(
      ctx,
      cycle,
      {
        id: `F${nextId++}`,
        source: f.source,
        lens: f.lens,
        severity: f.severity,
        summary: f.finding,
        evidence: f.evidence,
      },
      { advisory: true },
    );
  }
  const resolved = priorConfirmed
    .filter((f) => results.get(f.id)?.verdict === 'resolved')
    .map((f) => f.id);
  return { confirmed, resolved };
}

function stampReviewFinding(ctx, cycle, finding, { advisory }) {
  ctx.store.append('finding', {
    actor: ACTOR,
    cycle,
    id: finding.id,
    source: finding.source,
    lens: finding.lens,
    severity: finding.severity,
    summary: gist(finding.summary),
    evidence: gist(finding.evidence),
    ...(advisory ? { advisory: true } : {}),
    ...(finding.confirmed !== undefined && { confirmed: finding.confirmed }),
    ...(finding.approach && { approach: true }),
  });
}

/** One review seat with resume-by-report: a stamped report is never re-run. */
async function reviewSeat(ctx, { seat, label, schema, roleBlock, cwd, env }) {
  const reportPath = runReportPath(ctx.paths, ctx.runId, label);
  const events = runEvents(ctx);
  const prior = events.find(
    (e) => e.event === 'seat-report' && e.seat === seat && e.path === reportPath,
  );
  if (prior) {
    const report = readJson(reportPath);
    if (report) return { report };
  }
  const result = await ctx.runSeat({ seat, roleBlock, reportPath, schema, cwd, env });
  if (!result.ok) return { fail: seatFail(seat, result) };
  return { report: result.report };
}

/**
 * The verifier seat over one cycle's items: confirm-or-refute for new HIGHs,
 * resolved-or-unresolved for prior confirmed HIGHs. Coverage is a
 * deterministic check — one corrective invocation, then seat-failure.
 */
async function verifierSeat(ctx, base, { cycle, items }) {
  let brief = null;
  for (let attempt = 1; ; attempt++) {
    const label = `fury-verifier-c${cycle}${attempt === 2 ? '-r' : ''}`;
    const outcome = await reviewSeat(ctx, {
      seat: 'fury-verifier',
      label,
      schema: VERIFIER_SCHEMA,
      roleBlock: verifierRole(base, items, brief),
      cwd: base.worktree,
      env: base.env,
    });
    if (outcome.fail) return outcome;
    const defects = verifierCoverageDefects(items, outcome.report.results);
    if (defects.length === 0) {
      return { results: new Map(outcome.report.results.map((r) => [r.id, r])) };
    }
    if (attempt === 2) {
      ctx.store.append('seat-failure', {
        actor: ACTOR,
        seat: 'fury-verifier',
        reason: 'verifier-coverage',
        defects,
      });
      return {
        fail: {
          close: {
            state: 'failed',
            reason: 'seat-failure',
            seat: 'fury-verifier',
            cause: 'verifier-coverage',
          },
        },
      };
    }
    brief = defects;
  }
}

function verifierCoverageDefects(items, results) {
  const defects = [];
  const byId = new Map(results.map((r) => [r.id, r]));
  if (byId.size !== results.length) defects.push('duplicate item ids in results');
  for (const item of items) {
    const r = byId.get(item.id);
    if (!r) {
      defects.push(`item ${item.id} has no verdict`);
      continue;
    }
    const legal = item.mode === 'confirm' ? ['confirmed', 'refuted'] : ['resolved', 'unresolved'];
    if (!legal.includes(r.verdict)) {
      defects.push(`item ${item.id} needs a verdict of: ${legal.join(' | ')}`);
    }
  }
  return defects;
}

// -- role blocks -------------------------------------------------------------

function furyRole(seat, base, diffText) {
  const lenses = FURY_SEATS[seat];
  return [
    `Review the candidate implementation diff through these lenses, and label every finding with its lens:`,
    ...lenses.map((lens) => `- ${LENS_CRITERIA[lens]}`),
    `The spec: ${base.specRef}`,
    'Judge the diff only. Do not fix anything; do not widen into unchanged code.',
    'Severity HIGH means the finding must block the ship. Cite evidence (file and line, or spec section) for every finding.',
    'Set "approach": true only when the finding names the implementation structure as wrong against the spec.',
    'Diff:',
    diffText,
  ].join('\n');
}

function generalistRole(base, diffText) {
  return [
    'Review the diff below through all six lenses, and label every finding with its lens:',
    ...ALL_LENSES.map((lens) => `- ${LENS_CRITERIA[lens]}`),
    `The spec: ${base.specRef}`,
    'Judge the diff only. Do not fix anything; do not widen into unchanged code.',
    'Severity HIGH means the finding must block the ship. Cite evidence (file and line, or spec section) for every finding.',
    'Set "approach": true only when the finding names the implementation structure as wrong against the spec.',
    'Diff:',
    diffText,
  ].join('\n');
}

function verifierRole(base, items, brief) {
  return [
    'Verify each review finding below against the code as it stands. Cite evidence for every verdict.',
    'For a "confirm" item, the verdict is "confirmed" or "refuted": confirmed only when the code shows the finding.',
    'For a "resolution-check" item, the verdict is "resolved" or "unresolved": resolved only when the code no longer shows the finding.',
    'Set "approach": true on a confirmed finding only when it names the implementation structure as wrong against the spec.',
    `The spec: ${base.specRef}`,
    'Items:',
    ...items.map(
      (item) =>
        `- [${item.id}] (${item.mode}) ${item.finding.lens ?? item.finding.source ?? ''} ${
          item.finding.severity ?? ''
        }: ${item.finding.finding ?? item.finding.summary} (evidence: ${item.finding.evidence})`,
    ),
    ...briefLines(brief),
  ].join('\n');
}
