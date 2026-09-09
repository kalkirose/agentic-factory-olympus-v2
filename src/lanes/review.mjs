// The judgment review machinery: the Fury round (the panel's lenses over the
// seats that carry them, interface conditional on UI diffs, fully parallel),
// the generalist review seat (the same lenses on one seat, diff-scoped —
// repair cycles and the repair lane), the record review (one seat per record),
// and the verifier. Confirm-to-block: a lane finding never blocks alone; the
// verifier confirms or refutes each item against the code, and only confirmed
// items enter the verdict.
//
// The verifier's item list is severity OR record. A sub-HIGH finding on code
// never blocks and is never verified: it lands in the run ledger as advisory
// material. A finding on a decision record is verified at every grade and is
// never advisory: a record states how the product works, so a sentence of it
// that the tree contradicts is a defect and not a remark (ADR-0007).
//
// A record is judged by a round of its own. One seat reads one record, whole,
// with the units the harness enumerated, the neighbourhood, the criteria and no
// diff; a finding names the unit it is about. A brief that ends with a diff
// anchors the seat on the hunks and leaves the rest of the document sampled,
// which is the defect this round removes. So the code lenses keep the diff and
// the "judge the diff only" line, and they hold no record (ADR-0073).
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
import { join } from 'node:path';
import { runReportPath } from '../daemon/home.mjs';
import { recordPathIncludes } from '../config/project.mjs';
import {
  LENS_CRITERIA,
  RECORD_CRITERION_KEYS,
  RECORD_LENS,
  furyPanel,
  recordCriteriaLines,
} from './lenses.mjs';
import { REVIEW_SEAT, UNITS_BIN, unitChecks, unitKindLines } from './records.mjs';
import {
  NEIGHBOUR_CAP,
  UNIT_KINDS,
  UNIT_VERDICTS,
  isActiveRecord,
  readText,
  recordNeighbours,
  recordUnits,
} from './units.mjs';
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
  seatWithChecks,
  underAny,
  againstClause,
  secondRecordOf,
  briefLines,
  gist,
} from './shared.mjs';

/** What a finding may be graded, on every review seat. */
const SEVERITIES = Object.freeze(['HIGH', 'MED', 'LOW']);

/**
 * The report shape one code review seat answers in.
 *
 * No record enters it. A record is judged by the record round, which has its
 * own seat, its own brief and its own schema, so a code lens carries the
 * panel's lenses and nothing else (ADR-0073).
 */
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
            severity: { type: 'string', enum: [...SEVERITIES] },
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

/**
 * The report shape one record review seat answers in: the findings it raised,
 * and one entry per unit of the record it read.
 *
 * It is a schema of its own rather than a subset of the code one. The flat
 * schema holds one `required` list per item and no conditional, so a `unit`
 * required on a record finding could not be optional on a code finding beside
 * it, and a record finding that names no unit is a finding about no sentence
 * (ADR-0073).
 *
 * The second place is optional in the shape and owed on a `consistent`
 * finding, which the deterministic check states because the shape cannot.
 */
export function recordReviewSchema() {
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
            // The seat's own label, so the unit checks and the brief can name
            // one finding. The ledger id is the harness's, assigned at the
            // stamp, because ids are unique across a run and not across a seat.
            id: { type: 'string' },
            criterion: { type: 'string', enum: [...RECORD_CRITERION_KEYS] },
            severity: { type: 'string', enum: [...SEVERITIES] },
            file: { type: 'string' },
            unit: { type: 'string' },
            head: { type: 'string' },
            line: { type: 'integer' },
            summary: { type: 'string' },
            evidence: { type: 'string' },
            // The second place: the unit of the other record a `consistent`
            // finding says this one contradicts.
            file2: { type: 'string' },
            unit2: { type: 'string' },
            head2: { type: 'string' },
          },
          required: [
            'id',
            'criterion',
            'severity',
            'file',
            'unit',
            'head',
            'line',
            'summary',
            'evidence',
          ],
        },
      },
      // One entry per unit of the record, in the shape every record seat
      // answers in: the harness enumerates the file and counts the answers.
      units: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            record: { type: 'string' },
            id: { type: 'string' },
            kind: { type: 'string', enum: [...UNIT_KINDS] },
            verdict: { type: 'string', enum: [...UNIT_VERDICTS] },
            evidence: { type: 'string' },
          },
          required: ['record', 'id', 'kind', 'verdict', 'evidence'],
        },
      },
      summary: { type: 'string' },
    },
    required: ['findings', 'units', 'summary'],
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
 * The panel is the code panel. A record path leaves its file list, because a
 * record is judged in the record round and nowhere else, and a code lens that
 * read one would report on a document through criteria it does not carry
 * (ADR-0073).
 */
export async function furyRound(ctx, base, { cycle, diff, diffFiles }) {
  const codeFiles = codeOnly(base, diffFiles);
  const panel = furyPanel(base.lenses);
  const supersedes = authorizedSupersedes(runEvents(ctx));
  const seats = Object.keys(panel).filter(
    (seat) =>
      seat !== 'fury-interface' ||
      (base.uiPaths.length > 0 && codeFiles.some((f) => underAny(f, base.uiPaths))),
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

/** The files of a diff a code lens is answerable for: the record paths leave. */
function codeOnly(base, diffFiles) {
  const files = Array.isArray(diffFiles) ? diffFiles : [];
  const paths = base?.recordPaths ?? [];
  if (paths.length === 0) return files;
  return files.filter((file) => !recordPathIncludes(file, paths));
}

/**
 * The generalist review seat: the panel's whole lens set over one diff. Used on
 * repair cycles (story lane) and as the only judgment seat of the repair lane.
 * The verifier fires only when the round has something for it: a HIGH, a record
 * finding, or a prior confirmed finding needing a resolution-check. So a clean
 * small fix costs one review agent.
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
 * The record review: one seat per record file, all of them in parallel.
 *
 * Review seats only read, so parallel is safe, and one record per seat is what
 * makes the unit duty answerable: the seat holds one document, the harness's
 * own enumeration of it, and the neighbourhood it may not contradict. Each seat
 * runs under the unit checks, so a report that leaves a unit unanswered, names
 * a unit the file does not hold, or files a claim as rationale buys the seat
 * its one corrective attempt and never reaches the verifier (ADR-0073).
 *
 * `units`, `neighbours` and `moved` are keyed by record path. The stage holds
 * them: it enumerated each record to judge the write, and it matched the units
 * across that write. Where it passes none, the round reads the record from the
 * worktree, which is the same enumeration from the same file.
 * @param {{records: string[], units?: Map|object, neighbours?: Map|object,
 *   moved?: Map|object, spec?: object|string|null, cycle: number,
 *   priorConfirmed?: object[]}} opts
 */
export async function recordReviewRound(
  ctx,
  base,
  {
    records,
    units = null,
    neighbours = null,
    moved = null,
    spec = null,
    cycle,
    priorConfirmed = [],
  },
) {
  const list = records ?? [];
  // The stamp this cycle's seats resume behind. A report the ledger holds for a
  // seat's own label after it is this cycle's answer (ADR-0079).
  const since =
    runEvents(ctx).find((e) => e.event === 'reconcile-review-set' && e.cycle === cycle)?.seq ?? 0;
  const outcomes = await Promise.all(
    list.map((record, i) =>
      recordReviewSeat(ctx, base, {
        record,
        slot: i + 1,
        cycle,
        since,
        units: unitsOf(base, units, record),
        neighbours: neighboursOf(base, neighbours, record),
        moved: byRecord(moved, record) ?? [],
        spec,
      }),
    ),
  );
  const failed = outcomes.find((o) => o.fail);
  if (failed) return { fail: failed.fail };
  const collected = [];
  for (const outcome of outcomes) {
    collected.push(
      ...outcome.report.findings.map((f) => ({
        ...f,
        source: outcome.seat,
        lens: RECORD_LENS,
        record: true,
      })),
    );
  }
  return settleFindings(ctx, base, { cycle, collected, priorConfirmed });
}

/**
 * One record, one seat, one check loop. The slot keeps the seat's own budget.
 *
 * The seat resumes by report: a report the ledger holds for this seat's label
 * after this cycle's dispatch stamp is this cycle's answer, and the checks run
 * over it again rather than a fresh seat over the same record. A stop inside
 * the fan-out used to cost every seat of the cycle (ADR-0079).
 *
 * The unit stamp lands as the seat settles, for the same reason: a stamp that
 * waited for the whole fan-out is a stamp a stop takes with it.
 */
async function recordReviewSeat(
  ctx,
  base,
  { record, slot, cycle, since = 0, units, neighbours, moved, spec },
) {
  const seat = `${REVIEW_SEAT}:${slot}`;
  const outcome = await seatWithChecks(ctx, {
    seat,
    label: `${REVIEW_SEAT}-${slot}-c${cycle}`,
    resumeByReport: since,
    schema: recordReviewSchema(),
    cwd: base.worktree,
    env: base.env,
    constitution: base.constitution,
    styleFiles: base.styleFiles ?? [],
    buildRole: (brief) => recordReviewRole(base, { record, units, neighbours, moved, spec }, brief),
    checks: (report) => recordSeatDefects(base, record, report),
  });
  if (outcome.fail) return { fail: outcome.fail };
  const settled = {
    seat,
    record,
    units,
    neighbours,
    report: outcome.report,
    cost: outcome.cost,
  };
  stampRecordUnits(ctx, cycle, settled);
  return settled;
}

/**
 * What one record review report is refused for: the eight unit rules, and the
 * two refusals a record finding carries with it.
 *
 * The findings are brought to the repository's own path form first, because
 * rules 7 and 8 join a finding to a unit by the file and the id, and a seat
 * writes the path it was reading.
 */
function recordSeatDefects(base, record, report) {
  const findings = (report.findings ?? []).map((f) => ({
    ...f,
    file: repoRelative(f.file, base.worktree) ?? record,
    ...(f.file2 && { file2: repoRelative(f.file2, base.worktree) ?? f.file2 }),
  }));
  return [
    ...unitChecks(base, [record], report, { seat: 'review', findings }),
    ...findingRefusals(base, findings).map((r) => r.defect),
  ];
}

/**
 * The findings a review seat may not raise, with the reason it reads.
 *
 * A `consistent` finding says two records decide one unbuilt part two ways, so
 * a `consistent` finding that names one record states half a claim and the
 * verifier has nothing to read. A closed record is out of every seat's scope
 * under the supersede lifecycle: it states what was known then, and a finding
 * against today's tree is a finding against a document nobody may edit
 * (ADR-0073).
 *
 * Both are work-product defects and not findings. They are returned to the seat
 * through its check loop, and `settleFindings` drops them before the verifier
 * for the seats that have no such loop.
 * @returns {Array<{finding: object, defect: string}>}
 */
function findingRefusals(base, findings) {
  const refusals = [];
  for (const finding of findings) {
    const id = finding.id ?? finding.unit ?? recordPathOf(finding) ?? 'a finding';
    if (finding.criterion === 'consistent' && !secondRecordOf(finding)) {
      refusals.push({
        finding,
        defect:
          `finding ${id} cites "consistent" and names one record. That criterion is about two ` +
          'records: name the second record in "file2", with the unit it decides otherwise in ' +
          '"unit2" and that unit\'s head in "head2".',
      });
      continue;
    }
    const closed = [recordPathOf(finding), secondRecordOf(finding)].find((path) =>
      closedRecord(base, path),
    );
    if (closed === undefined) continue;
    refusals.push({
      finding,
      defect:
        `finding ${id} is about ${closed}, whose status line reads superseded or retired. A ` +
        'closed record states what was known then and is out of this review. Raise the finding ' +
        'against the active record that replaced it, or leave it.',
    });
  }
  return refusals;
}

/** Whether a path is a record this lifecycle has closed. */
function closedRecord(base, path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (lifecycleOf(base) !== 'supersede') return false;
  const text = readText(join(base.worktree ?? '', path));
  return text !== null && !isActiveRecord(text);
}

/** How this project changes an accepted record. The base carries it; config is the fallback. */
function lifecycleOf(base) {
  return base?.recordLifecycle ?? base?.config?.repo?.recordLifecycle ?? null;
}

/**
 * What one record review seat answered, unit by unit, with what it cost.
 *
 * The per-unit list is the fact the writer's miss rate joins on: a review that
 * fails a unit the writer reported `holds` is the one reading that catches a
 * seat which answered without reading. The cost is the dispatch's own, because
 * the ledger's per-seat total cannot say which slot spent it (ADR-0073).
 *
 * One stamp per seat per cycle. A restart that re-runs the round finds its own
 * stamp and leaves it, as the finding stamp does.
 */
function stampRecordUnits(ctx, cycle, { seat, record, report, neighbours, cost }) {
  const stamped = runEvents(ctx).some(
    (e) => e.event === 'record-units' && e.seat === seat && e.cycle === cycle,
  );
  if (stamped) return;
  const units = (report.units ?? []).map((u) => ({
    id: u.id,
    kind: u.kind,
    verdict: u.verdict,
    ...(u.evidence !== undefined && { evidence: u.evidence }),
  }));
  ctx.store.append('record-units', {
    actor: ACTOR,
    seat,
    ...(cycle !== undefined && { cycle }),
    record,
    units,
    counts: {
      claims: units.filter((u) => u.kind === 'claim').length,
      holds: units.filter((u) => u.verdict === 'holds').length,
      fails: units.filter((u) => u.verdict === 'fails').length,
      notBuilt: units.filter((u) => u.verdict === 'not-built').length,
    },
    neighbours: neighbours.neighbours.length,
    neighboursDropped: neighbours.dropped,
    ...(cost !== undefined && { cost }),
  });
}

/** The units of one record: the stage's enumeration, or the file's own. */
function unitsOf(base, units, record) {
  const given = byRecord(units, record);
  if (Array.isArray(given)) return given;
  const text = readText(join(base.worktree ?? '', record));
  return text === null ? [] : recordUnits(text);
}

/** The neighbourhood of one record: the stage's, or the tree's own. */
function neighboursOf(base, neighbours, record) {
  const given = byRecord(neighbours, record);
  if (given) return { neighbours: given.neighbours ?? [], dropped: given.dropped ?? 0 };
  return recordNeighbours(base.worktree, record, base.recordPaths ?? []);
}

/** One record's entry of a per-record map, however the caller keyed it. */
function byRecord(value, record) {
  if (value instanceof Map) return value.get(record) ?? null;
  if (value && typeof value === 'object') return value[record] ?? null;
  return null;
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
 *
 * A finding a record seat may not raise is refused before the verifier runs and
 * is stamped nowhere. It is a defect in the work product, not a claim about the
 * tree, and the verifier seat is the run's most expensive reader (ADR-0073).
 * The record round returns those refusals to the seat through its check loop;
 * every other round drops them and reports them to its caller.
 */
async function settleFindings(
  ctx,
  base,
  { cycle, collected, priorConfirmed, diffTruncated = false },
) {
  const allowlist = base.allowlistPaths ?? [];
  const recordPaths = base.recordPaths ?? [];
  const marked = collected.map((f) => {
    const place = findingPlace(f, allowlist, base.worktree);
    return {
      ...f,
      place,
      record:
        f.record === true ||
        (place.file !== undefined && recordPathIncludes(place.file, recordPaths)),
    };
  });
  const refusals = findingRefusals(base, marked);
  const refused = new Set(refusals.map((r) => r.finding));
  const judged = marked.filter((f) => !refused.has(f));
  const verifiable = judged.filter((f) => f.severity === 'HIGH' || f.record);
  const advisory = judged.filter((f) => !(f.severity === 'HIGH' || f.record));
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
        // The place a record finding names, both sides of it. A corrective
        // brief states the unit and the verifier's item line quotes its head,
        // so a finding rebuilt from the ledger without them names a file and
        // no sentence.
        ...recordFields(e),
        ...(e.approach && { approach: true }),
      }));
    const resolved = priorConfirmed
      .filter((f) => results.get(f.id)?.verdict === 'resolved')
      .map((f) => f.id);
    return {
      confirmed,
      resolved,
      ...(refusals.length > 0 && { refused: refusals.map((r) => r.defect) }),
    };
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
  return {
    confirmed,
    resolved,
    ...(refusals.length > 0 && { refused: refusals.map((r) => r.defect) }),
  };
}

/**
 * The unit a finding is about, and the second place a `consistent` one names.
 *
 * One definition, three readers: the place assigned at the stamp, the stamp
 * itself, and the ladder's rebuild of a finding from the ledger. A finding
 * rebuilt without them names a file and no sentence, and the corrective brief
 * and the verifier's item line both state the sentence (ADR-0073).
 */
export function recordFields(f) {
  return {
    ...(f.unit && { unit: f.unit }),
    ...(f.head && { head: f.head }),
    ...(typeof f.line === 'number' && Number.isFinite(f.line) && { line: f.line }),
    ...(f.file2 && { file2: f.file2 }),
    ...(f.unit2 && { unit2: f.unit2 }),
    ...(f.head2 && { head2: f.head2 }),
  };
}

/**
 * Where a finding sits, as far as the ledger is concerned: the file the lens
 * named, whether that file is one of the project's cross-cutting gate
 * allowlists, the unit of the record it is about, and the second record a
 * `consistent` finding weighs it against.
 *
 * The unit rides the place because a record finding is about one sentence, and
 * the id alone does not survive a rewrite: the head and the line beside it are
 * what match the finding to a unit after a write moved the numbers (ADR-0073).
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
function findingPlace(finding, allowlist, worktree) {
  const path = repoRelative(finding.file, worktree);
  const second = repoRelative(finding.file2, worktree);
  return {
    ...(path !== null && {
      file: path,
      ...(underAny(path, allowlist) && { allowlist: true }),
    }),
    ...recordFields({ ...finding, file2: second }),
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
    // project's declared record paths and the seat that raised it, and never
    // read back out of the sentence the seat wrote. Every reader of the ledger
    // counts these fields: the ladder, the two tripwires, the lens-yield metric
    // and the close's own scan (ADR-0010).
    ...(finding.record && { record: true }),
    ...(finding.criterion && { criterion: finding.criterion }),
    // The unit the finding is about, and the second place a `consistent`
    // finding weighs it against. The writer's miss rate joins the review's
    // findings to the writer's answers on the record and the unit id, so a
    // finding stamped without them is a finding no reading can count
    // (ADR-0073).
    ...recordFields(finding),
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

function furyRole(lenses, base, diff, supersedes = []) {
  return [
    `Review the candidate implementation diff through these lenses, and label every finding with its lens:`,
    ...lenses.map((lens) => `- ${LENS_CRITERIA[lens]}`),
    `The spec: ${base.specRef}`,
    JUDGE_SCOPE,
    'Severity HIGH means the finding must block the ship. Cite evidence (file and line, or spec section) for every finding.',
    'Set "approach": true only when the finding names the implementation structure as wrong against the spec.',
    'Put the repo-relative path of the one file a finding is about in "file"; leave it out for a finding about no single file.',
    ...(lenses.includes('spec') ? supersedeDutyLines(base, supersedes) : []),
    ...diffLines(diff),
  ].join('\n');
}

function generalistRole(base, diff, supersedes = []) {
  return [
    'Review the diff below through these lenses, and label every finding with its lens:',
    ...base.lenses.map((lens) => `- ${LENS_CRITERIA[lens]}`),
    `The spec: ${base.specRef}`,
    JUDGE_SCOPE,
    'Severity HIGH means the finding must block the ship. Cite evidence (file and line, or spec section) for every finding.',
    'Set "approach": true only when the finding names the implementation structure as wrong against the spec.',
    'Put the repo-relative path of the one file a finding is about in "file"; leave it out for a finding about no single file.',
    ...(base.lenses.includes('spec') ? supersedeDutyLines(base, supersedes) : []),
    ...diffLines(diff),
  ].join('\n');
}

/**
 * The line every code lens takes about its scope. The diff is the work, and a
 * seat that reviews the repository around it reports on decisions nobody made
 * this time. It takes no qualification any more: a record is not in this diff's
 * file list and is judged by a seat of its own (ADR-0073).
 */
const JUDGE_SCOPE = 'Judge the diff only. Do not fix anything; do not widen into unchanged code.';

/**
 * The whole brief of one record review seat: one record, the units the harness
 * counted in it, the criteria, the neighbourhood, and no diff.
 *
 * No diff, on the evidence of a live reconciliation: a seat whose brief ends
 * with the diff starts at the hunks, re-checks what the verifier already
 * checked, and samples the rest of the document. The record is the work here,
 * and the unit list is what makes "every sentence" a countable duty rather than
 * a word in a brief (ADR-0073).
 *
 * The moved units are named because they are the sentences this round wrote,
 * and a seat that knows which sentence moved reads the rest as well: the line
 * says what moved, and the unit list says what is owed.
 */
function recordReviewRole(base, { record, units, neighbours, moved, spec }, brief) {
  return [
    `Review one decision record: ${record}`,
    'Read it whole, from the working tree. Read the code it describes before you write a finding.',
    'You are given no diff. The record is the work, and every unit of it is yours.',
    ...recordSpecLines(base, spec),
    '',
    'The criteria this record is held to:',
    ...recordCriteriaLines(),
    ...unitListLines(record, units),
    ...movedLines(moved, units),
    ...neighbourhoodLines(neighbours),
    ...unitAnswerLines(),
    ...recordFindingLines(record),
    ...CONSTITUTION_DUTY,
    ...briefLines(brief),
  ].join('\n');
}

/** The work the record decides, as the stage states it, or the run's own spec. */
function recordSpecLines(base, spec) {
  if (typeof spec === 'string' && spec.trim().length > 0) {
    return ['', `The specification: ${spec}. Read it whole.`];
  }
  if (!spec) {
    return base.specRef ? ['', `The specification: ${base.specRef}. Read it whole.`] : [];
  }
  const lines = [''];
  if (spec.key) lines.push(`Work: ${spec.key}`);
  if (spec.path) lines.push(`The specification: ${spec.path}. Read it whole.`);
  if (spec.reason) lines.push(`Reason: ${spec.reason}`);
  if (spec.text) lines.push('', spec.text);
  return lines;
}

/** The harness's own enumeration of the record, which the report answers. */
function unitListLines(record, units) {
  return [
    '',
    `The units of ${record}, as the harness counts them:`,
    ...units.map((unit) => {
      const kind = unit.kind ? `, ${unit.kind}` : '';
      return `- ${unit.id} (line ${unit.line}${kind}): ${unit.head}`;
    }),
    `Count them yourself against the file: node ${UNITS_BIN} ${record}`,
  ];
}

/** One line naming the sentences this round moved. */
function movedLines(moved, units) {
  const heads = (moved ?? []).map((id) => units.find((unit) => unit.id === id)?.head ?? id);
  if (heads.length === 0) return ['', 'No unit of this record moved in this round.'];
  return ['', `The units this round moved: ${heads.map((head) => `"${head}"`).join(', ')}.`];
}

/**
 * The neighbourhood, by path, and what the cap left out.
 *
 * The `consistent` criterion is answerable only against a list, and the list is
 * capped: a seat that reads twelve records and is told eight more exist knows
 * what its answer covers (ADR-0073).
 */
function neighbourhoodLines(neighbours) {
  const list = neighbours.neighbours ?? [];
  if (list.length === 0) {
    return ['', 'Neighbourhood: no active record cites this record, and it cites none.'];
  }
  return [
    '',
    'The neighbourhood. Read each one whole. An open part of this record may not contradict an',
    'open part of any of them:',
    ...list.map((path) => `- ${path}`),
    ...(neighbours.dropped > 0
      ? [
          `${neighbours.dropped} more active records cite this one or are cited by it. The`,
          `neighbourhood is capped at ${NEIGHBOUR_CAP} by rank, and those are outside the cap.`,
        ]
      : []),
  ];
}

/** The unit duty, stated where the seat answers it. */
function unitAnswerLines() {
  return [
    '',
    '"units" takes one entry per unit above, and the harness refuses a report that misses one,',
    'names a unit the file does not hold, or answers one twice:',
    '- "record": the record path. "id": the unit id above.',
    ...unitKindLines(),
    'A unit you report "fails" carries a finding that names it. A unit you report "holds" carries',
    'none. The two say one thing.',
  ];
}

/** What a finding on this record carries, and what it may not be about. */
function recordFindingLines(record) {
  return [
    '',
    'Every finding carries:',
    '- "id": your own label for it, unique in this report.',
    '- "criterion": the one criterion above it fails.',
    '- "severity": "HIGH", "MED" or "LOW". Every grade is verified and a confirmed finding of any',
    '  grade blocks the ship, so grade what the finding is worth and nothing else.',
    `- "file": ${record}. "unit", "head" and "line": the unit it is about, as the list above`,
    '  states them.',
    '- "summary": what is wrong. "evidence": the file and line of the tree that answers it.',
    '- On "consistent" alone: "file2", "unit2" and "head2", the unit of the other record this one',
    '  contradicts. A "consistent" finding that names one record is refused.',
    'A finding about a superseded or a retired record is refused: a closed record states what was',
    'known then.',
    'Cite the unit your finding is about. Taste is not a criterion.',
    'Do not fix anything. Do not judge the code: the code is judged elsewhere.',
  ];
}

/** Where the seat reads the standard the record's sentences are written to. */
const CONSTITUTION_DUTY = [
  '',
  'A constitution block above this brief states the standard this project holds a record to, and',
  'a style block names the rule files that bind its sentences. Both are binding text. They state',
  'the form of a record; the criteria above state the truth of one.',
];

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

/**
 * One item as the verifier reads it: the grade, the place, and the sentence.
 *
 * The unit rides the line beside the file, with its head quoted. A record item
 * is about one sentence of one document, and a verifier given the file alone
 * reads the file for a sentence that matches the claim, which is the sampling
 * this plan removes. A `consistent` item names the second unit as well, because
 * the claim is that two records decide one part two ways (ADR-0073).
 */
function verifierItemLine(item) {
  const f = item.finding;
  const grade = [f.lens ?? f.source ?? '', f.severity ?? ''].filter(Boolean).join(' ');
  const where = f.record ? ` [record: ${recordPathOf(f) ?? '(none cited)'}]` : '';
  const unit = f.unit ? ` [unit: ${f.unit}${f.head ? ` "${f.head}"` : ''}]` : '';
  const criterion = f.record ? ` [criterion: ${f.criterion ?? '(none cited)'}]` : '';
  const against = againstClause(f);
  return (
    `[${item.id}] (${item.mode}) ${grade}${where}${unit}${criterion}${against}: ` +
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
 * scope the review that raised the finding had: the review judges every unit of
 * a record and not the changed hunks alone, so a finding about a sentence this
 * pass never moved is an ordinary finding, and a verifier that refuted it for
 * sitting outside the diff would refuse the work the review exists to do
 * (ADR-0026). The second record of a `consistent` item is named beside it, for
 * the same reason: the claim is about both.
 */
function recordVerifierLines(items) {
  const records = items.filter((item) => item.finding.record);
  if (records.length === 0) return [];
  const paths = [
    ...new Set(
      records
        .flatMap((item) => [recordPathOf(item.finding), secondRecordOf(item.finding)])
        .filter(Boolean),
    ),
  ];
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
