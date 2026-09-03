// The judgment review machinery: the Fury round (the panel's lenses over the
// seats that carry them, interface conditional on UI diffs, fully parallel),
// the generalist review seat (the same lenses on one seat, diff-scoped —
// repair cycles and the repair lane), and the verifier. Confirm-to-block: a
// lane finding never blocks alone; the verifier confirms or refutes each HIGH
// against the code, and only confirmed HIGHs enter the verdict. Sub-HIGH
// findings never block and are never verified — they land in the run ledger as
// advisory material.
//
// The panel is the project's `review.lenses`, resolved at the lane base; the
// seat a lens rides and the default set live in the lens registry (ADR-0038).
//
// No re-fan-out over a judged tree: the fan-out fires once per implementation
// pass; every later cycle of the pass reviews the repair diff with the
// generalist seat and resolution-checks prior confirmed HIGHs.
//
// The verifier is one of the two seats the replay probe is open to: it may ask
// for a Tier-1 layer of its own run to be run again and read the output, where
// a finding turns on what the code does under this host's credentials. The
// lane seats never reach it — they judge a diff (ADR-0042).
import { runReportPath } from '../daemon/home.mjs';
import { LENS_CRITERIA, furyPanel } from './lenses.mjs';
import { authorizedSupersedes, supersedeLines } from './supersede.mjs';
import {
  PROBE_REQUEST_PROPERTY,
  asksForProbe,
  probeOfferLines,
  withReplayRounds,
} from './replay.mjs';
import {
  ACTOR,
  runEvents,
  readJson,
  attemptLimit,
  failureBrief,
  seatFail,
  underAny,
  briefLines,
  gist,
} from './shared.mjs';

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
    // The replay probe: the verifier may ask for one Tier-1 layer of its own
    // run to be run again and read the output, where a finding turns on what
    // the code does under this host's credentials rather than on what it says
    // (ADR-0042). Optional; a report that carries it is a request, not a set
    // of verdicts.
    probe: PROBE_REQUEST_PROPERTY,
  },
  required: ['results', 'summary'],
};

/**
 * The Fury fan-out for one implementation pass. Fires every seat the panel
 * puts on it, minus the interface seat when the diff touches no UI path; all
 * seats run in parallel. HIGHs go to the verifier; findings stamp once per
 * cycle. Returns the confirmed HIGHs.
 */
export async function furyRound(ctx, base, { cycle, diff, diffFiles }) {
  const panel = furyPanel(base.lenses);
  const supersedes = authorizedSupersedes(runEvents(ctx));
  const seats = Object.keys(panel).filter(
    (seat) =>
      seat !== 'fury-interface' ||
      (base.uiPaths.length > 0 && diffFiles.some((f) => underAny(f, base.uiPaths))),
  );
  const outcomes = await Promise.all(
    seats.map((seat) =>
      reviewSeat(ctx, {
        seat,
        label: `${seat}-c${cycle}`,
        schema: reviewSchema(panel[seat]),
        roleBlock: furyRole(panel[seat], base, diff, supersedes),
        cwd: base.worktree,
        env: base.env,
        constitution: base.constitution,
      }),
    ),
  );
  const failed = outcomes.find((o) => o.fail);
  if (failed) return { fail: failed.fail };
  const collected = outcomes.flatMap((o, i) =>
    o.report.findings.map((f) => ({ ...f, source: seats[i] })),
  );
  return settleFindings(ctx, base, {
    cycle,
    collected,
    priorConfirmed: [],
    diffTruncated: diff.truncated === true,
  });
}

/**
 * The generalist review seat: the panel's whole lens set over one diff. Used on
 * repair cycles (story lane) and as the only judgment seat of the repair lane.
 * The verifier fires only when HIGHs exist or prior confirmed HIGHs need a
 * resolution-check, so a clean small fix costs one review agent.
 */
export async function generalistReview(ctx, base, { cycle, diff, priorConfirmed }) {
  const outcome = await reviewSeat(ctx, {
    seat: 'generalist-review',
    label: `generalist-review-c${cycle}`,
    schema: reviewSchema(base.lenses),
    roleBlock: generalistRole(base, diff, authorizedSupersedes(runEvents(ctx))),
    cwd: base.worktree,
    env: base.env,
    constitution: base.constitution,
  });
  if (outcome.fail) return { fail: outcome.fail };
  const collected = outcome.report.findings.map((f) => ({ ...f, source: 'generalist-review' }));
  return settleFindings(ctx, base, {
    cycle,
    collected,
    priorConfirmed,
    diffTruncated: diff.truncated === true,
  });
}

/**
 * Splits collected findings on severity, verifies what must be verified,
 * stamps every finding once per cycle, and returns the confirmed HIGHs plus
 * the resolution results for prior confirmed findings.
 */
async function settleFindings(ctx, base, { cycle, collected, priorConfirmed, diffTruncated = false }) {
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
    stampReviewFinding(ctx, cycle, finding, { advisory: !isConfirmed, diffTruncated });
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
      { advisory: true, diffTruncated },
    );
  }
  const resolved = priorConfirmed
    .filter((f) => results.get(f.id)?.verdict === 'resolved')
    .map((f) => f.id);
  return { confirmed, resolved };
}

function stampReviewFinding(ctx, cycle, finding, { advisory, diffTruncated = false }) {
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
    ...(diffTruncated && { diffTruncated: true }),
  });
}

/**
 * One review seat with resume-by-report: a stamped report is never re-run.
 * `fresh` opts out of the shortcut for a retry the human bought — that report
 * is the one the coverage check refused, so replaying it buys nothing.
 */
async function reviewSeat(ctx, { seat, label, schema, roleBlock, cwd, env, constitution, fresh = false }) {
  const reportPath = runReportPath(ctx.paths, ctx.runId, label);
  const events = runEvents(ctx);
  const prior = fresh
    ? null
    : events.find((e) => e.event === 'seat-report' && e.seat === seat && e.path === reportPath);
  if (prior) {
    const report = readJson(reportPath);
    if (report) return { report };
  }
  const result = await ctx.runSeat({ seat, roleBlock, reportPath, schema, cwd, env, constitution });
  if (!result.ok) return { fail: seatFail(ctx, seat, result) };
  return { report: result.report };
}

/**
 * The verifier seat over one cycle's items: confirm-or-refute for new HIGHs,
 * resolved-or-unresolved for prior confirmed HIGHs. Coverage is a
 * deterministic check — one corrective invocation, then the seat-failure park.
 *
 * Around that loop sit the replay rounds. A finding can turn on what the code
 * does under this host's credentials rather than on what it reads like, and
 * the verifier holds none of them: it asks for a Tier-1 layer to be run again
 * and is briefed with the output (ADR-0042).
 */
async function verifierSeat(ctx, base, { cycle, items }) {
  const outcome = await withReplayRounds(
    ctx,
    { seat: 'fury-verifier', cycle, label: `fury-verifier-c${cycle}`, base },
    (round) => verifierRounds(ctx, base, { cycle, items, ...round }),
  );
  if (outcome.fail) return outcome;
  return { results: new Map(outcome.report.results.map((r) => [r.id, r])) };
}

/** One verifier round: the contract loop, under the label the round names. */
async function verifierRounds(ctx, base, { cycle, items, label, replays, budget }) {
  const limit = attemptLimit(runEvents(ctx), 'fury-verifier');
  const layers = (base.config?.gates?.tier1 ?? []).map((layer) => layer.name);
  let brief = limit === 1 ? failureBrief(runEvents(ctx), 'fury-verifier') : null;
  for (let attempt = 1; ; attempt++) {
    const corrective = attempt === 2 || limit === 1;
    const outcome = await reviewSeat(ctx, {
      seat: 'fury-verifier',
      label: `${label}${corrective ? '-r' : ''}`,
      schema: VERIFIER_SCHEMA,
      roleBlock: verifierRole(base, items, brief, { replays, budget, layers }),
      cwd: base.worktree,
      env: base.env,
      constitution: base.constitution,
      fresh: limit === 1,
    });
    if (outcome.fail) return outcome;
    // A report that asks for a probe it can still have is a request and not a
    // set of verdicts, so the coverage rules do not judge it. Past the round
    // budget the report is the answer whatever it asks for.
    const defects = asksForProbe(outcome.report, budget)
      ? []
      : verifierCoverageDefects(items, outcome.report.results);
    if (defects.length === 0) return outcome;
    if (attempt >= limit) {
      ctx.store.append('seat-failure', {
        actor: ACTOR,
        seat: 'fury-verifier',
        reason: 'verifier-coverage',
        defects,
      });
      return { fail: seatFail(ctx, 'fury-verifier', { reason: 'verifier-coverage' }) };
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

function furyRole(lenses, base, diff, supersedes = []) {
  return [
    `Review the candidate implementation diff through these lenses, and label every finding with its lens:`,
    ...lenses.map((lens) => `- ${LENS_CRITERIA[lens]}`),
    `The spec: ${base.specRef}`,
    'Judge the diff only. Do not fix anything; do not widen into unchanged code.',
    'Severity HIGH means the finding must block the ship. Cite evidence (file and line, or spec section) for every finding.',
    'Set "approach": true only when the finding names the implementation structure as wrong against the spec.',
    ...(lenses.includes('spec') ? supersedeDutyLines(base, supersedes) : []),
    ...diffLines(diff),
  ].join('\n');
}

function generalistRole(base, diff, supersedes = []) {
  return [
    'Review the diff below through these lenses, and label every finding with its lens:',
    ...base.lenses.map((lens) => `- ${LENS_CRITERIA[lens]}`),
    `The spec: ${base.specRef}`,
    'Judge the diff only. Do not fix anything; do not widen into unchanged code.',
    'Severity HIGH means the finding must block the ship. Cite evidence (file and line, or spec section) for every finding.',
    'Set "approach": true only when the finding names the implementation structure as wrong against the spec.',
    ...(base.lenses.includes('spec') ? supersedeDutyLines(base, supersedes) : []),
    ...diffLines(diff),
  ].join('\n');
}

/**
 * The diff the seat is given: how much of it is in the brief, how much of it
 * there is, and where the rest of it is.
 *
 * A seat handed the first few thousand characters of a diff with no statement
 * about the cut judges what it can see and reports as if it had seen the work.
 * So the excerpt opens with what it is: the size of the whole diff in bytes,
 * the number of files in it, the path of the file that holds it, and the duty
 * to read that file. The seats run with the run worktree as their working
 * directory and the file sits on the daemon home, so the path is absolute and
 * the seat opens it exactly as it opens the spec.
 *
 * An excerpt that IS the diff says so in one line. It names the file anyway,
 * because the file is always written and a brief that named it only sometimes
 * would teach a seat that the absence of a path means something (ADR-0066).
 */
function diffLines(diff) {
  const files = `${diff.files} ${diff.files === 1 ? 'file' : 'files'}`;
  if (!diff.partial) {
    return [
      `The whole diff is below: ${diff.bytes} bytes across ${files}. ` +
        `The same text is on disk at ${diff.path}.`,
      'Diff:',
      diff.text,
    ];
  }
  return [
    `The excerpt below is the first ${diff.chars} characters of a ${diff.bytes}-byte diff ` +
      `across ${files}.`,
    `The whole diff is at ${diff.path}.`,
    'Read the whole file before you judge; a finding must cite the file and hunk it comes from.',
    'Excerpt:',
    diff.text,
  ];
}

/**
 * The verification duty the spec lens carries when a run amended a frozen test
 * on the card's authority. The quote check is mechanical and proves only that
 * the words are in the card; whether the words REACH the collision is a
 * judgment, and this is the seat that already judges the diff against the
 * validated spec. A stretched authorization is a HIGH, and confirm-to-block
 * does the rest (ADR-0044).
 */
function supersedeDutyLines(base, supersedes) {
  if (supersedes.length === 0) return [];
  return [
    'This run amended frozen tests on the intent card\'s authority, without asking the owner.',
    `The card: ${base.cardPath ?? '(the run names none)'}`,
    'Verify every one of these against the card: the quoted line is in the card, and what it ' +
      'mandates genuinely reaches the assertion that changed. It reaches it when no ' +
      'implementation of the mandated behavior could leave that assertion true.',
    ...supersedeLines(supersedes),
    'An authorization whose card line does not reach the change is a HIGH finding on the spec lens.',
    'So is an amendment that drops what the pin protected instead of restating it in the form the ' +
      'card mandates: the guarantee survives the supersede, or the supersede is a deletion.',
  ];
}

function verifierRole(base, items, brief, probe = null) {
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
    ...(probe ? probeOfferLines(probe) : []),
    ...briefLines(brief),
  ].join('\n');
}
