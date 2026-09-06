// The judgment review machinery: the Fury round (the panel's lenses over the
// seats that carry them, interface conditional on UI diffs, fully parallel),
// the generalist review seat (the same lenses on one seat, diff-scoped —
// repair cycles and the repair lane), and the verifier. Confirm-to-block: a
// lane finding never blocks alone; the verifier confirms or refutes each item
// against the code, and only confirmed items enter the verdict.
//
// The verifier's item list is severity OR record. A sub-HIGH finding on code
// never blocks and is never verified: it lands in the run ledger as advisory
// material. A finding on a decision record is verified at every grade and is
// never advisory: a record states how the product works, so a sentence of it
// that the tree contradicts is a defect and not a remark (ADR-0007). Which
// findings those are is the diff's answer, not the seat's: a review of a
// record-only diff raises record findings and nothing else, and a mixed diff
// answers per finding from the path the seat named (ADR-0026).
//
// A record in the diff is judged whole. The seat is given the path of every
// record the change moved and reads each file from the working tree, and a
// finding may cite any sentence of it. The diff says what moved; it is not the
// boundary of the review, and the verifier is given the same scope. Only the
// code lenses keep "do not widen into unchanged code" (ADR-0026).
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
import {
  LENS_CRITERIA,
  RECORD_CRITERION_KEYS,
  RECORD_LENS,
  furyPanel,
  recordCriteriaLines,
} from './lenses.mjs';
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
  boughtRetry,
  failureBrief,
  seatFail,
  underAny,
  briefLines,
  gist,
} from './shared.mjs';

/**
 * The scope a review's findings are judged in: whether every one of them is
 * about a decision record, and the paths that decide it for the rest.
 *
 * Three rules answer it, in order, and the first two need no config.
 *
 * A reconciliation cycle judges a record commit whose own containment check
 * refused any other file, so every finding of that review is a record finding
 * whatever any path list says. Its files are the diff's own for the same
 * reason: the brief names each record the seat must read whole, and a path list
 * that missed the tree would name none of them. A review whose diff touches at
 * least one file and no file outside the project's record paths is the same
 * case reached from the diff, which is what covers the repair lane's
 * reconciliation run. A mixed diff is answered per finding, from the path the
 * seat named (ADR-0026).
 *
 * @param {{recordPaths?: string[]}} base the lane base
 * @param {{diffFiles?: string[]|null, reconcile?: boolean}} [opts]
 * @returns {{only: boolean, paths: string[], files: string[]}}
 */
export function recordScope(base, { diffFiles = null, reconcile = false } = {}) {
  const paths = base?.recordPaths ?? [];
  const files = Array.isArray(diffFiles) ? diffFiles : [];
  if (reconcile) return { only: true, paths, files };
  const records = files.filter((f) => underAny(f, paths));
  const only = files.length > 0 && records.length === files.length;
  return { only, paths, files: records };
}

/** A review with no record scope: every finding takes the severity ladder. */
export const NO_RECORDS = Object.freeze({ only: false, paths: [], files: [] });

/**
 * The report shape one review seat answers in.
 *
 * A record-only review carries the record lens and no code lens, and it
 * requires the two fields the rule downstream reads: the file, because a
 * finding about no file is about no record, and the criterion, because the
 * verifier refutes a finding whose evidence does not reach the one it cites.
 * A mixed review carries the panel's lenses plus the record lens, and both
 * fields stay optional there. The brief asks for them on a record file, and a
 * finding that leaves the path out is graded as it always was.
 */
export function reviewSchema(lenses, records = NO_RECORDS) {
  const carries = records.only || records.files.length > 0;
  const names = records.only ? [RECORD_LENS] : carries ? [...lenses, RECORD_LENS] : [...lenses];
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
            lens: { type: 'string', enum: names },
            severity: { type: 'string', enum: ['HIGH', 'MED', 'LOW'] },
            file: { type: 'string' },
            finding: { type: 'string' },
            evidence: { type: 'string' },
            approach: { type: 'boolean' },
            ...(carries && { criterion: { type: 'string', enum: [...RECORD_CRITERION_KEYS] } }),
          },
          required: records.only
            ? ['lens', 'severity', 'file', 'finding', 'evidence', 'criterion']
            : ['lens', 'severity', 'finding', 'evidence'],
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
 * seats run in parallel. HIGHs and record findings go to the verifier; findings
 * stamp once per cycle. Returns the confirmed findings.
 *
 * A pass whose whole diff is decision records is judged by the record lens and
 * by no code lens, and the record lens rides one seat (ADR-0038). So that round
 * is the generalist seat: the panel would spawn several seats to read a
 * markdown tree through criteria none of them carries.
 */
export async function furyRound(ctx, base, { cycle, diff, diffFiles }) {
  const records = recordScope(base, { diffFiles });
  if (records.only) {
    return generalistReview(ctx, base, { cycle, diff, priorConfirmed: [], diffFiles });
  }
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
        schema: reviewSchema(panel[seat], records),
        roleBlock: furyRole(panel[seat], base, diff, supersedes, records),
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
    records,
  });
}

/**
 * The generalist review seat: the panel's whole lens set over one diff. Used on
 * repair cycles (story lane), on the reconciliation cycle, and as the only
 * judgment seat of the repair lane. The verifier fires only when the round has
 * something for it: a HIGH, a record finding, or a prior confirmed finding
 * needing a resolution-check. So a clean small fix costs one review agent.
 *
 * `reconcile` says the diff is a record commit whatever its paths look like.
 */
export async function generalistReview(
  ctx,
  base,
  { cycle, diff, priorConfirmed, diffFiles = null, reconcile = false },
) {
  const records = recordScope(base, { diffFiles, reconcile });
  const outcome = await reviewSeat(ctx, {
    seat: 'generalist-review',
    label: `generalist-review-c${cycle}`,
    schema: reviewSchema(base.lenses, records),
    roleBlock: generalistRole(base, diff, authorizedSupersedes(runEvents(ctx)), records),
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
    records,
  });
}

/**
 * Splits collected findings on severity OR record, verifies what must be
 * verified, stamps every finding once per cycle, and returns the confirmed
 * findings plus the resolution results for prior confirmed ones.
 *
 * The split is the whole of the record rule. A sub-HIGH code finding is worth
 * less than the round it would cost, so it is stamped advisory and nobody must
 * act on it. A record finding is a claim that the record and the tree disagree,
 * and the verifier is the one seat that reads the code and answers such a
 * claim: it is put to that seat at every grade, a confirmed one blocks, and a
 * refuted one carries the verifier's evidence under its own id and no advisory
 * word (ADR-0007).
 */
async function settleFindings(
  ctx,
  base,
  { cycle, collected, priorConfirmed, diffTruncated = false, records = NO_RECORDS },
) {
  const allowlist = base.allowlistPaths ?? [];
  const marked = collected.map((f) => {
    const place = findingPlace(f.file, allowlist, base.worktree);
    return {
      ...f,
      place,
      record: records.only || (place.file !== undefined && underAny(place.file, records.paths)),
    };
  });
  const verifiable = marked.filter((f) => f.severity === 'HIGH' || f.record);
  const advisory = marked.filter((f) => !(f.severity === 'HIGH' || f.record));
  const items = [
    ...verifiable.map((f, i) => ({ id: `new-${i + 1}`, mode: 'confirm', finding: f })),
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
        ...(e.file && { file: e.file }),
        ...(e.record && { record: true }),
        ...(e.criterion && { criterion: e.criterion }),
        ...(e.approach && { approach: true }),
      }));
    const resolved = priorConfirmed
      .filter((f) => results.get(f.id)?.verdict === 'resolved')
      .map((f) => f.id);
    return { confirmed, resolved };
  }
  let nextId = 1 + events.filter((e) => e.event === 'finding').length;
  const confirmed = [];
  for (let i = 0; i < verifiable.length; i++) {
    const f = verifiable[i];
    const result = results.get(`new-${i + 1}`);
    const isConfirmed = result?.verdict === 'confirmed';
    const finding = {
      id: `F${nextId++}`,
      source: f.source,
      lens: f.lens,
      severity: f.severity,
      summary: f.finding,
      evidence: f.evidence,
      ...f.place,
      ...(f.record && { record: true, ...(f.criterion && { criterion: f.criterion }) }),
      approach: isConfirmed && (result.approach ?? f.approach ?? false),
      confirmed: isConfirmed,
    };
    // A refuted record finding is not advice. A second seat read the tree and
    // wrote down, with evidence, why the record is right; the word for material
    // nobody must act on would bury that under the one thing this plan removed.
    stampReviewFinding(ctx, cycle, finding, {
      advisory: !isConfirmed && !f.record,
      diffTruncated,
    });
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
        ...f.place,
      },
      { advisory: true, diffTruncated },
    );
  }
  const resolved = priorConfirmed
    .filter((f) => results.get(f.id)?.verdict === 'resolved')
    .map((f) => f.id);
  return { confirmed, resolved };
}

/**
 * Where a finding sits, as far as the ledger is concerned: the file the lens
 * named, and whether that file is one of the project's cross-cutting gate
 * allowlists.
 *
 * The allowlist word is assigned here and never read back out of the seat's
 * sentence, for the reason every closed vocabulary in the ledger is: a fact
 * carried as prose counts as nothing when somebody comes to count it. The
 * lens's `file` is optional in its report; a finding that names none carries
 * neither field, and the metric over these reads it as a finding that is not
 * about an allowlist, which is the safe direction for a reading watched for
 * falling (ADR-0010).
 *
 * The path itself is prose: a seat writes what it was reading, and what it was
 * reading is the run worktree. So it is brought to the form a path entry is
 * written in before anything is asked of it — separators forward, the worktree
 * prefix off, a leading `./` off — because a match against any other form
 * silently answers no, and a silent no is exactly what this field exists to
 * stop.
 */
function findingPlace(file, allowlist, worktree) {
  const path = repoRelative(file, worktree);
  if (path === null) return {};
  return {
    file: path,
    ...(underAny(path, allowlist) && { allowlist: true }),
  };
}

/** A seat-written path as the repository names it, or null for no path. */
function repoRelative(file, worktree) {
  if (typeof file !== 'string' || file.trim().length === 0) return null;
  let path = file.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  const root = typeof worktree === 'string' ? worktree.replaceAll('\\', '/').replace(/\/+$/, '') : '';
  // The worktree prefix is compared case-insensitively because the hosts that
  // hand a seat an absolute path are the ones whose file systems are.
  if (root.length > 0 && path.toLowerCase().startsWith(root.toLowerCase() + '/')) {
    path = path.slice(root.length + 1);
  }
  while (path.startsWith('./')) path = path.slice(2);
  return path.length > 0 ? path : null;
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
    ...(finding.file && { file: finding.file }),
    ...(finding.allowlist && { allowlist: true }),
    // The record word and the criterion it fails, assigned here against the
    // project's declared record paths and the diff's own shape, and never read
    // back out of the sentence the seat wrote. Every reader of the ledger counts
    // these fields: the ladder, the two tripwires, the lens-yield metric and the
    // close's own scan (ADR-0010).
    ...(finding.record && { record: true }),
    ...(finding.criterion && { criterion: finding.criterion }),
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
  const bought = boughtRetry(runEvents(ctx), 'fury-verifier');
  const layers = (base.config?.gates?.tier1 ?? []).map((layer) => layer.name);
  let brief = bought ? failureBrief(runEvents(ctx), 'fury-verifier') : null;
  for (let attempt = 1; ; attempt++) {
    const corrective = attempt === 2 || bought;
    const outcome = await reviewSeat(ctx, {
      seat: 'fury-verifier',
      label: `${label}${corrective ? '-r' : ''}`,
      schema: VERIFIER_SCHEMA,
      roleBlock: verifierRole(base, items, brief, { replays, budget, layers }),
      cwd: base.worktree,
      env: base.env,
      constitution: base.constitution,
      fresh: bought,
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

function furyRole(lenses, base, diff, supersedes = [], records = NO_RECORDS) {
  return [
    `Review the candidate implementation diff through these lenses, and label every finding with its lens:`,
    ...lenses.map((lens) => `- ${LENS_CRITERIA[lens]}`),
    ...recordLensLines(records),
    `The spec: ${base.specRef}`,
    judgeScopeLine(records),
    'Severity HIGH means the finding must block the ship. Cite evidence (file and line, or spec section) for every finding.',
    'Set "approach": true only when the finding names the implementation structure as wrong against the spec.',
    'Put the repo-relative path of the one file a finding is about in "file"; leave it out for a finding about no single file.',
    ...(lenses.includes('spec') ? supersedeDutyLines(base, supersedes) : []),
    ...diffLines(diff),
  ].join('\n');
}

function generalistRole(base, diff, supersedes = [], records = NO_RECORDS) {
  if (records.only) return recordRole(base, diff, records);
  return [
    'Review the diff below through these lenses, and label every finding with its lens:',
    ...base.lenses.map((lens) => `- ${LENS_CRITERIA[lens]}`),
    ...recordLensLines(records),
    `The spec: ${base.specRef}`,
    judgeScopeLine(records),
    'Severity HIGH means the finding must block the ship. Cite evidence (file and line, or spec section) for every finding.',
    'Set "approach": true only when the finding names the implementation structure as wrong against the spec.',
    'Put the repo-relative path of the one file a finding is about in "file"; leave it out for a finding about no single file.',
    ...(base.lenses.includes('spec') ? supersedeDutyLines(base, supersedes) : []),
    ...diffLines(diff),
  ].join('\n');
}

/**
 * The record lens on a mixed diff: the criteria, the record files the diff
 * holds, the duty to read each of them whole, and the two fields a finding
 * about one of them carries.
 *
 * The files are named because the path decides the route here, and because the
 * file is the unit of the review. A finding about a record file that carries no
 * path is graded on severity like any other finding, and the seat is the only
 * reader that knows which file it meant.
 */
function recordLensLines(records) {
  if (records.only || records.files.length === 0) return [];
  return [
    `- ${RECORD_LENS}: the decision records this diff changes, against these criteria:`,
    ...recordCriteriaLines().map((line) => `  ${line}`),
    ...wholeRecordLines(records.files),
    `A finding about one of those files carries "lens": "${RECORD_LENS}", its "file", and the ` +
      '"criterion" it fails.',
  ];
}

/**
 * The scope of a record review: the records by path, and the duty to read each
 * of them whole.
 *
 * A record is a set of claims about the code, and it is judged as a document.
 * A seat handed the changed hunks alone reads the hunks, opens the code they
 * name, and reports what it finds there; a stale claim three paragraphs above
 * the change is invisible to it until a later round happens to move that
 * paragraph. One live reconciliation spent four review cycles that way, each
 * one raising four or five confirmed findings on the layer the round before it
 * had just touched, and the pass ended on the round cap rather than on a clean
 * record. So the diff says what moved and the file is what is judged.
 *
 * The paths are named where the caller knows them. A reconciliation cycle whose
 * diff read failed knows none, and the duty is stated against the diff instead:
 * a brief that named no file and asked for none would leave the seat with the
 * hunks again.
 */
function wholeRecordLines(files) {
  const named = files.length > 0;
  return [
    ...(named ? ['The decision records this change moved:', ...files.map((f) => `- ${f}`)] : []),
    named
      ? 'Read every one of those files whole, from the working tree, before you write a finding.'
      : 'Read every decision record in the diff whole, from the working tree, before you write a finding.',
    'Judge every claim in each record, changed in this diff or not. The diff below shows what this',
    'change moved. It is context, and it is not the boundary of the review: a finding may cite any',
    'sentence of the record.',
  ];
}

/**
 * The line every code lens takes about its scope, and the qualification a
 * record file in the same diff earns.
 *
 * "Do not widen into unchanged code" is right for a code lens: the diff is the
 * work, and a seat that reviews the repository around it reports on decisions
 * nobody made this time. It is wrong for a record. So the sentence stays and
 * says which files it is about (ADR-0026).
 */
function judgeScopeLine(records) {
  const line = 'Judge the diff only. Do not fix anything; do not widen into unchanged code.';
  if (records.only || records.files.length === 0) return line;
  return (
    `${line} That rule is about the code files: a decision record in this diff is read whole, ` +
    'from the working tree, and judged whole.'
  );
}

/**
 * The whole brief of a record-only review: the six criteria, the records to
 * read whole, and nothing from the code lenses.
 *
 * A code lens reading a markdown document raises findings about failure paths
 * and input trust, and after the record rule those findings block a ship. A
 * seat that is not asked to read a record that way does not report it, which is
 * the whole answer to that noise (ADR-0038).
 */
function recordRole(base, diff, records = NO_RECORDS) {
  return [
    'Every file in the diff below is a decision record. Review the records against these',
    'criteria, and label every finding with the criterion it fails:',
    ...recordCriteriaLines(),
    `The spec: ${base.specRef}`,
    ...wholeRecordLines(records.files),
    'Judge the records against the tree they describe. Read the code before you write a finding.',
    'Do not fix anything. Do not judge the code: the code is judged elsewhere.',
    `Every finding carries "lens": "${RECORD_LENS}", the repo-relative path of the one record it ` +
      'is about in "file", and the "criterion" it fails.',
    'Cite the sentence of the record your finding is about, and the file and line of the tree that',
    'answers it. A finding that names no sentence of the record is refused by the verifier for',
    'want of evidence. Taste is not a criterion.',
    'Grade every finding HIGH, MED or LOW. Every grade is verified and a confirmed finding of any',
    'grade blocks the ship, so grade what the finding is worth and nothing else.',
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
    ...recordVerifierLines(items),
    'Items:',
    ...items.map((item) => `- ${verifierItemLine(item)}`),
    ...(probe ? probeOfferLines(probe) : []),
    ...briefLines(brief),
  ].join('\n');
}

function verifierItemLine(item) {
  const f = item.finding;
  const grade = [f.lens ?? f.source ?? '', f.severity ?? ''].filter(Boolean).join(' ');
  const where = f.record ? ` [record: ${recordPathOf(f) ?? '(none cited)'}]` : '';
  const criterion = f.record ? ` [criterion: ${f.criterion ?? '(none cited)'}]` : '';
  return (
    `[${item.id}] (${item.mode}) ${grade}${where}${criterion}: ` +
    `${f.finding ?? f.summary} (evidence: ${f.evidence})`
  );
}

/**
 * The record a finding is about, as the repository names it.
 *
 * A finding reaches this seat by two roads. A finding of this cycle carries the
 * path under `place`, assigned at the stamp against the run worktree; a prior
 * confirmed finding was rebuilt from the ledger and carries it flat. Both are
 * the same path, and a brief that read one road would name half the records.
 */
function recordPathOf(finding) {
  return finding?.place?.file ?? finding?.file ?? null;
}

/**
 * What the verifier is told about the record items, where the round holds any.
 *
 * A record item is a claim that a document and a tree disagree, so the verdict
 * turns on the criterion the finding cites and on nothing else. The list is
 * given because the criterion is load-bearing: a finding that cites the wrong
 * one is refused here, and a refusal for want of evidence is what stops a
 * remark about taste from blocking a ship (ADR-0007).
 *
 * The records themselves are named, and read whole. This seat is given the same
 * scope the review that raised the finding had: the review judges every claim
 * of a record and not the changed hunks alone, so a finding about a sentence
 * this diff never moved is an ordinary finding, and a verifier that refuted it
 * for sitting outside the diff would refuse the work the review exists to do
 * (ADR-0026).
 */
function recordVerifierLines(items) {
  const records = items.filter((item) => item.finding.record);
  if (records.length === 0) return [];
  const paths = [...new Set(records.map((item) => recordPathOf(item.finding)).filter(Boolean))];
  return [
    'Some items below are about a decision record. A record states how the product works, so the',
    'question is whether the record and the tree disagree as the finding states.',
    ...(paths.length > 0
      ? [
          'The records those items are about:',
          ...paths.map((path) => `- ${path}`),
          'Read each of those records whole, from the working tree, before you confirm or refute',
          'one of them.',
        ]
      : [
          'Read the record an item is about whole, from the working tree, before you confirm or',
          'refute that item.',
        ]),
    'A finding about a sentence this diff did not change is as confirmable as a finding about a',
    'sentence it did: the record is judged whole.',
    'The criteria a record is held to:',
    ...recordCriteriaLines(),
    'A record item is "confirmed" when the record and the tree disagree as the finding states, or',
    'when the record fails the criterion the finding cites, as the finding states it.',
    'It is "refuted" when the evidence does not reach the cited criterion. A finding that cites',
    '"whole" or "fact" and names no sentence of the record is refuted for want of evidence.',
    'Taste is not a criterion. Read the record and the tree; do not rewrite either.',
  ];
}
