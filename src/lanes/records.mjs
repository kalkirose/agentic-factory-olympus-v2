// The record contract: the report shape every record seat answers in, the
// three briefs the writer works from, and the deterministic checks over what a
// seat left in the tree (ADR-0026).
//
// One contract, three briefs, two seat names. The birth seat writes the records
// a spec decides before the freeze. The reconciliation seat rewrites the records
// a shipped diff moved. The corrective seat answers the findings a review
// raised. All three write the same work product, so the schema, the checks and
// the containment live here and every lane reads them from one place. The seat
// names differ because a seat name is the key of the attempt budget, the cost
// series and the failure record, and a birth must not spend a correction's
// budget.
//
// The checks are the containment. No deny rule can say "everything except these
// directories" without walking the repository, so the boundary is a check over
// what the seat left in the tree, and the commit is behind it.
//
// Two duties are proved rather than asked for. A divergence is declared per
// record and a declared sentence that is not in the file is a defect; a live run
// named three divergences and absorbed a fourth. And every unit of every record
// is answered by id: the harness enumerates the record, the seat answers the
// same list, and a report that leaves a unit out, invents one, files a claim as
// rationale or cites a path the worktree does not hold is refused. What no check
// can see is whether a seat answered honestly, and that is the review's work
// under the criteria.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordPathIncludes } from '../config/project.mjs';
import { git } from '../isolation/git.mjs';
import { changedFiles, changedInRange, filesAt } from '../isolation/tree.mjs';
import { recordCriteriaLines } from './lenses.mjs';
import {
  NEIGHBOUR_CAP,
  UNIT_KINDS,
  UNIT_VERDICTS,
  activeOf,
  isActiveRecord,
  readText,
  recordId,
  recordUnits,
  statusOf,
  supersedesOf,
} from './units.mjs';
import { againstClause, underAny, briefLines } from './shared.mjs';

/** The seat that rewrites the records at a reconciliation and at a correction. */
export const WRITE_SEAT = 'reconcile-write';

/** The seat that writes a record at its birth, before the freeze. */
export const AUTHOR_SEAT = 'record-author';

/** The seat that reads one record and judges it. */
export const REVIEW_SEAT = 'record-review';

/** What a divergence entry may say about one judged record. */
export const DIVERGENCE_STATES = Object.freeze(['none', 'named']);

/** What a sibling entry may say about a record that cites a superseded one. */
export const SIBLING_STATES = Object.freeze(['consistent', 'superseded']);

/**
 * The enumerator, by absolute path. A seat runs with the run worktree as its
 * working directory, so it reaches the harness's own bin by the path the brief
 * names, as it reaches the diff file today (ADR-0066).
 */
export const UNITS_BIN = fileURLToPath(new URL('../../bin/olympus-units.mjs', import.meta.url));

/**
 * The write seat's report shape.
 *
 * Three fields are asked for by the dispatch rather than by the shape.
 * `answered` is on a corrective invocation alone, because a schema that carried
 * it on the first write would ask a seat to invent a list of findings nobody
 * raised. `siblings` is on a write that supersedes a record other records cite.
 * `units` is on a dispatch whose brief carries the unit duty, and it requires
 * the divergence evidence with it: the two are one contract, and a dispatch
 * that asks for neither is a dispatch whose brief asked for neither. Both are
 * in the shape whatever the dispatch says, so a seat that answers more than it
 * was asked for is never refused for it.
 * @param {{answered?: boolean, siblings?: boolean, units?: boolean}} [opts]
 */
export function reconcileWriteSchema({ answered = false, siblings = false, units = false } = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      rewritten: { type: 'array', items: { type: 'string' } },
      unchanged: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            record: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['record', 'reason'],
        },
      },
      // One entry per unit per record: the harness's own id, the kind of
      // sentence, the verdict and the path that answers it.
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
      // One entry per judged record: the record, whether the seat found a
      // divergence between the tree and the record, the sentence behind that
      // word, and the place in the tree that shows it. For `named` the
      // statement is the sentence the seat wrote into the record, and a check
      // proves it is there. For `none` it is the seat's own one-sentence
      // reason.
      divergences: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            record: { type: 'string' },
            state: { type: 'string', enum: [...DIVERGENCE_STATES] },
            statement: { type: 'string' },
            evidence: { type: 'string' },
          },
          required: ['record', 'state', 'statement', ...(units ? ['evidence'] : [])],
        },
      },
      ...(siblings && {
        siblings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              record: { type: 'string' },
              state: { type: 'string', enum: [...SIBLING_STATES] },
              reason: { type: 'string' },
              replacement: { type: 'string' },
            },
            required: ['record', 'state', 'reason'],
          },
        },
      }),
      ...(answered && { answered: { type: 'array', items: { type: 'string' } } }),
      summary: { type: 'string' },
    },
    required: [
      'rewritten',
      'unchanged',
      ...(units ? ['units'] : []),
      'divergences',
      ...(siblings ? ['siblings'] : []),
      ...(answered ? ['answered'] : []),
      'summary',
    ],
  };
}

/**
 * The birth brief: the records a validated spec or a ticket decides, written
 * before the code exists by a seat that will never write that code.
 *
 * It carries no diff, because there is nothing implemented to read. It carries
 * the neighbourhood, because a decision that contradicts an active record's
 * open part is the conflict this brief exists to settle.
 * @param {object} base the lane base
 * @param {{key?: string, path?: string, reason?: string, touchedPaths?: string[],
 *   records?: string[]}} spec `records` are the files a refused attempt left,
 *   which the retry brief is enumerated from
 * @param {{neighbours: string[], dropped: number}|string[]} neighbours
 * @param {string[]|string|null} brief the correction brief, on a second attempt
 */
export function birthRole(base, spec, neighbours, brief) {
  return [
    'Write the decision records this specification decides. The code does not exist yet, and',
    'you will not write it. A record states one decision, not a diff.',
    ...specLines(spec),
    '',
    'Write one file per decision, in the form the project states, with status Accepted. Every',
    'part the tree does not hold is stated as not yet implemented. Where the specification',
    'decides nothing the record tree does not already hold, write no file and say so in',
    '"unchanged" with the reason.',
    ...neighbourhoodLines(neighbours),
    ...siblingLines(spec?.siblings),
    '',
    'Rules:',
    ...RECORD_RULES,
    ...unitDutyLines(),
    '',
    '"divergences" takes no entry: this write judges no record the tree already holds.',
    ...lifecycleLines(base),
    ...CONSTITUTION_DUTY,
    ...briefLines(brief),
    ...retryUnitLines(base, spec?.records ?? [], brief),
  ].join('\n');
}

/**
 * The write seat's brief. It carries the judged records, the diff to read them
 * against, and the rules the record tree binds its editors to.
 */
export function writeRole(base, judged, brief) {
  const records = judged.records ?? [];
  return [
    'Rewrite the decision records below so they stand as fact against this',
    'branch. You did not write the code; read it before you write a word.',
    `The diff is this branch against ${base.defaultBranch}. Read it with:`,
    `git diff ${base.defaultBranch}...HEAD`,
    '',
    'Records to reconcile:',
    ...records.map((r) => `- ${r}`),
    '',
    `Judged reason: ${judged.reason}`,
    ...neighbourhoodLines(judged.neighbours),
    ...siblingLines(judged.siblings),
    '',
    'Rules:',
    ...RECORD_RULES,
    ...judgedRules(records),
    ...unitDutyLines(),
    ...divergenceDutyLines(records),
    ...lifecycleLines(base),
    ...CONSTITUTION_DUTY,
    ...briefLines(brief),
    ...retryUnitLines(base, records, brief),
  ].join('\n');
}

/**
 * The corrective brief: the same rules, plus the findings a review raised on
 * the records this seat already wrote and a verifier confirmed against the
 * tree. Each finding carries the unit it is about, the criterion it fails and
 * the verifier's own evidence, so the seat answers a claim about the tree
 * rather than a remark. A finding is one of the units, and every other unit of
 * the record is the seat's as well.
 */
export function correctiveRole(base, judged, { findings, divergences, brief }) {
  const records = judged.records ?? [];
  return [
    'The decision records you rewrote were reviewed, and these findings were confirmed',
    'against the tree. Answer every one of them in the records.',
    `The diff is this branch against ${base.defaultBranch}. Read it with:`,
    `git diff ${base.defaultBranch}...HEAD`,
    '',
    'Confirmed findings:',
    ...findings.map((f) => `- ${findingLine(f)}`),
    '',
    'List the ids you answered in "answered". Answer them in the records, not in the report.',
    'A finding names one unit. Every other unit of the record is yours as well.',
    '',
    'Records to reconcile:',
    ...records.map((r) => `- ${r}`),
    '',
    `Judged reason: ${judged.reason}`,
    ...neighbourhoodLines(judged.neighbours),
    ...siblingLines(judged.siblings),
    ...(divergences.length > 0
      ? [
          '',
          'The divergences you declared on the last write. Carry them forward: a divergence that',
          'was true then is true now unless this round changed the record it is about.',
          ...divergences.map((d) => `- ${d.record} [${d.state}]: ${d.statement}`),
        ]
      : []),
    '',
    'Rules:',
    ...RECORD_RULES,
    ...judgedRules(records),
    ...unitDutyLines(),
    ...divergenceDutyLines(records),
    ...lifecycleLines(base),
    ...CONSTITUTION_DUTY,
    ...briefLines(brief),
    ...retryUnitLines(base, records, brief),
  ].join('\n');
}

/**
 * One confirmed finding, as a brief states it. The unit and its head ride the
 * line, because a finding that names a file names a record and a finding that
 * names a unit names the sentence.
 *
 * A `consistent` finding names the second record as well, in the clause every
 * other brief names it in: the claim is that two records decide one unbuilt
 * part two ways, and the seat that answers it edits one of the two.
 */
export function findingLine(f) {
  const where = f.file ? ` (${f.file})` : '';
  const unit = f.unit ? ` ${f.unit}${f.head ? ` "${f.head}"` : ''}` : '';
  const criterion = f.criterion ? ` [${f.criterion}]` : '';
  const against = againstClause(f);
  return `[${f.id}]${criterion}${where}${unit}${against} ${f.summary} (evidence: ${f.evidence})`;
}

/**
 * The rules the record tree binds its editors to, in all three briefs.
 *
 * The first of them is the criteria list itself, verbatim, because it is the
 * list the review that reads this seat's work judges it against (ADR-0038). A
 * paraphrase beside the list is a second statement of one rule, and the two
 * drift: the writer then meets a criterion at the review that its own brief
 * never stated.
 */
const RECORD_RULES = [
  '- Every record you leave meets these criteria, which are the criteria the',
  '  review reads it against:',
  ...recordCriteriaLines().map((line) => `  ${line}`),
  '- A divergence between the diff and a recorded decision is named in your',
  '  report as well as in the record, verbatim.',
  '- Edit only the decision-record tree. No source, test, or config change',
  '  rides this run.',
];

/** What the report owes about the records the harness judged owed. */
function judgedRules(records) {
  return [
    '- A record the diff turns out not to affect goes in unchanged with the',
    `  reason. Report every judged record (${records.length}) in rewritten or in`,
    '  unchanged, and never in both.',
  ];
}

/** The unit duty, stated where the seat answers it. */
function unitDutyLines() {
  return [
    '',
    'Every unit of every record you leave is yours.',
    `Enumerate each record after you write it: node ${UNITS_BIN} <record>`,
    'The harness enumerates the same list and refuses a report that misses one unit, names a',
    'unit the file does not hold, or answers one unit twice.',
    '"units" takes one entry per unit per record:',
    '- "kind": "title", "status", "claim", "open" or "rationale". A claim is a present-tense',
    '  statement about the tree. An open unit states a part the tree does not hold. Rationale is',
    '  why the decision was taken, what it rejected, what would reverse it, and plain structure.',
    '  A unit whose text names a repository path, a symbol in backticks, or one of the verbs is,',
    '  are, reads, returns, runs, writes, serves or exposes is a claim. Filing it as rationale is',
    '  a defect.',
    '- "verdict": "holds", "fails" or "not-built". A title, a status and a rationale unit take',
    '  "holds".',
    '- "evidence": on a claim, the repo-relative path that answers it, and the line where one',
    '  exists. The worktree has to hold that path. On any other kind, one short sentence.',
    'A unit you report as "fails" is a unit you have not finished. Answer it in the record and',
    'report it again.',
  ];
}

/**
 * The harness's own enumeration, beside the defects, on a retry.
 *
 * A seat that was refused for a unit it missed is briefed with the list it was
 * counted against. Without it the seat enumerates again and may reach the same
 * list a second time, and the one corrective attempt is spent on the same
 * miss.
 */
function retryUnitLines(base, records, brief) {
  if (!brief) return [];
  const lines = [];
  // The filtered set, because a closed record owes no unit and a brief that
  // enumerated one would ask the seat for the answers the check drops.
  for (const record of activeOf(base?.worktree, records).records) {
    const text = readText(join(base?.worktree ?? '', record));
    if (text === null) continue;
    lines.push('', `The units of ${record}, as the harness counts them:`);
    for (const unit of recordUnits(text)) {
      const kind = unit.kind ? `, ${unit.kind}` : '';
      lines.push(`- ${unit.id} (line ${unit.line}${kind}): ${unit.head}`);
    }
  }
  return lines;
}

/** The neighbourhood, by path, and the count the cap dropped. */
function neighbourhoodLines(neighbours) {
  const list = Array.isArray(neighbours) ? neighbours : (neighbours?.neighbours ?? []);
  const dropped = Array.isArray(neighbours) ? 0 : (neighbours?.dropped ?? 0);
  if (list.length === 0) {
    return ['', 'Neighbourhood: no active record cites these records, and they cite none.'];
  }
  return [
    '',
    'The neighbourhood. Read each one whole. An open part of your records may not contradict an',
    'open part of any of them:',
    ...list.map((path) => `- ${path}`),
    ...(dropped > 0
      ? [
          `${dropped} more active records cite these or are cited by them. The neighbourhood is`,
          `capped at ${NEIGHBOUR_CAP} by rank, and those are outside the cap.`,
        ]
      : []),
  ];
}

/**
 * The records that cite a record this write supersedes, by path.
 *
 * The harness computes them and the seat answers each one, so a supersession
 * never leaves a record citing a decision that no longer stands. A record this
 * run already writes is not in the list: it is answered as itself.
 */
function siblingLines(siblings) {
  const list = siblings ?? [];
  if (list.length === 0) return [];
  return [
    '',
    'These active records cite a record you supersede. Read each one whole and answer it in',
    '"siblings":',
    ...list.map((path) => `- ${path}`),
    '- "consistent" with the one-sentence reason it still stands, or "superseded" with the',
    '  record that replaces it in this diff.',
  ];
}

/** Where the seat reads the lifecycle rule: in the brief that asks for a write. */
function lifecycleLines(base) {
  if (base?.recordLifecycle !== 'supersede') return [];
  const branch = base.defaultBranch ?? 'the default branch';
  return [
    '',
    'Lifecycle: this project supersedes its records. It never edits an accepted one.',
    `- An accepted record is one that stands on ${branch} at this run's merge base. Do not edit`,
    '  it. A record this run added is not accepted yet, so a corrective round edits it in place.',
    '- A change to an accepted record is a new record. It states the tree as it stands and names',
    '  the record it replaces on a "Supersedes: <list>" line, directly under its status line.',
    '- The old record keeps its body, verbatim. Its status line becomes',
    '  "Superseded by <list> (YYYY-MM-DD)", or "Retired (YYYY-MM-DD): <one sentence>". Nothing',
    '  else in it changes, and an emptied body is refused.',
    '- The list is ADR-<id> items joined by ", ", with " and " before the last. Every record it',
    '  names is added in this same diff and names the old record back. One record may split into',
    '  several, and several may merge into one.',
    '- A record another active record cites arrives in "siblings". Answer each one: "consistent"',
    '  with the reason, or "superseded" with the record that replaces it in this diff.',
    '- Two active records that decide one unbuilt part differently resolve by recency. The newer',
    '  decision stands, the older record gets its status line, and your divergence entry names',
    '  both records and the reason.',
    ...CLOSED_RECORD_DUTY,
  ];
}

/**
 * What the seat owes an old record it closes, stated once.
 *
 * The seat used to list a closed record in `rewritten`, because the file
 * changed, and the unit check then enumerated its whole body. No answer to a
 * July claim passes both the writer's rule and the kind test, so the report was
 * refused whatever the seat wrote. The rule is the harness's now: the status
 * line is read from the tree, and the brief says so (ADR-0078).
 */
const CLOSED_RECORD_DUTY = [
  '- A status-line change of an old record is not a rewrite. List that record in neither',
  '  `rewritten` nor `unchanged` unless you retire it with a reason, and answer none of its',
  '  units. The harness reads its status line from the tree. Every unit of a record you add is',
  '  yours.',
];

/** The constitution's place in a record brief. */
const CONSTITUTION_DUTY = [
  '',
  'A constitution block above this brief binds every sentence you write into a record.',
  'It states the form of a record; this brief states the truth of one.',
];

/** What the report owes about divergences, stated where the seat writes it. */
function divergenceDutyLines(records) {
  return [
    '',
    `"divergences" takes exactly one entry per judged record (${records.length}):`,
    '- "state": "named" when you wrote a sentence into the record naming a divergence between',
    '  the tree and the recorded decision. "statement" is that sentence, verbatim as it stands',
    '  in the file. A statement that is not in the file is a defect and buys you another round.',
    '- "state": "none" when you found no divergence in that record. "statement" is your',
    '  one-sentence reason.',
    '- "evidence": the repo-relative path, and the line where one exists, that shows the tree',
    '  side of what you state.',
  ];
}

/** The specification or ticket a birth writes from. */
function specLines(spec) {
  const lines = [''];
  if (spec?.key) lines.push(`Work: ${spec.key}`);
  if (spec?.path) lines.push(`Specification: ${spec.path}. Read it whole.`);
  if (spec?.reason) lines.push(`Reason: ${spec.reason}`);
  const paths = spec?.touchedPaths ?? [];
  if (paths.length > 0) {
    lines.push('', 'The paths this work touches:', ...paths.map((path) => `- ${path}`));
  }
  return lines;
}

/**
 * The record files a pass changed, over the range the pass opened in.
 *
 * The range is the pass's own, never the last round's diff. A round that
 * touched one of four records leaves the other three answered by an earlier
 * cycle and unread by this one, which is how a defect on a record left the
 * review after round one and shipped. Under the supersede lifecycle a
 * superseded or retired record is out of every seat's scope, so it leaves the
 * set here.
 * @param {string} worktree
 * @param {string} from the sha the pass opened at
 * @param {string} to the sha the stage judges
 * @param {string[]} recordPaths
 * @param {{lifecycle?: string}} [opts]
 * @returns {Promise<{files: string[], only: boolean}>}
 */
export async function recordScope(worktree, from, to, recordPaths = [], { lifecycle } = {}) {
  const changed = await changedInRange(worktree, from, to);
  const records = changed.filter((file) => recordPathIncludes(file, recordPaths));
  const files =
    lifecycle === 'supersede'
      ? records.filter((file) => {
          const text = readText(join(worktree, file));
          return text === null || isActiveRecord(text);
        })
      : records;
  return { files, only: changed.length > 0 && records.length === changed.length };
}

/**
 * What the write seat left in the tree, against what it reported and against
 * what it was asked for.
 *
 * The judged records are the harness's own list, so their directories are the
 * boundary. A birth judges no record, so the project's record paths are the
 * boundary there.
 *
 * `seat` arms the unit checks and says which side of them the seat is on. The
 * supersede checks arm on the project's lifecycle, and the sibling checks on a
 * sibling list the harness computed.
 * @param {{seat?: 'writer'|'review', findings?: object[], siblings?: string[]}} [opts]
 */
export async function writeChecks(base, records, report, opts = {}) {
  const { seat = null, findings = [], siblings = null } = opts;
  const defects = [];
  const trees = containmentTrees(base, records);
  const changed = await changedFiles(base.worktree);
  for (const file of changed) {
    if (!underAny(file, trees)) {
      defects.push(
        `change outside the decision-record tree: ${file}. This run rewrites records and ` +
          `nothing else; the records it was given live under ${trees.join(', ')}.`,
      );
    }
  }
  // The round's whole range, read once: the uncommitted diff and every commit a
  // peer dispatch of the same round already made. A merge of two records into
  // one leaves the second seat's replacement in the first seat's commit.
  const range = await writeRange(base, changed);
  const closed = closedOf(base, records, changed);
  const replaced = supersessions(base, [...closed], range).answered;
  const counted = await unitRecords(base, records, report, changed);
  const rewritten = new Set(report.rewritten);
  const unchanged = new Map(report.unchanged.map((u) => [u.record, u.reason]));
  for (const record of records) {
    if (rewritten.has(record) && unchanged.has(record)) {
      defects.push(`${record} is reported as rewritten and as unchanged; it is one or the other.`);
      continue;
    }
    if (rewritten.has(record) || unchanged.has(record)) continue;
    // A record this write closed answers to the closure rule below. The tree
    // accounts for it where a replacement of this round names it.
    if (closed.has(record)) continue;
    defects.push(
      `${record} was judged owed and your report accounts for it nowhere. Rewrite it, or ` +
        'put it in unchanged with the reason it needs no change.',
    );
  }
  defects.push(...closureDefects(base, closed, replaced, unchanged));
  const touched = new Set(changed);
  const kept = new Set(counted.records);
  const listedClosed = new Set(activeOf(base?.worktree, report.rewritten).skipped.map((s) => s.record));
  for (const record of report.rewritten) {
    // A closed record in `rewritten` is tolerated. The seat changed the file, so
    // it listed it; the closure rule is what accounts for that record.
    if (listedClosed.has(record)) continue;
    if (!records.includes(record) && !kept.has(record) && records.length > 0) {
      defects.push(`${record} is not one of the judged records; this run rewrites those alone.`);
    } else if (!touched.has(record)) {
      defects.push(`you report ${record} as rewritten and the file is unchanged in the tree.`);
    }
  }
  defects.push(...divergenceDefects(base, records, report));
  if (seat !== null || Array.isArray(report.units)) {
    defects.push(
      ...unitChecks(base, counted.records, report, {
        seat: seat ?? 'writer',
        findings,
        dropped: counted.dropped,
      }),
    );
  }
  if (base?.recordLifecycle === 'supersede') {
    defects.push(...(await supersedeChecks(base, records, report)));
  }
  if (siblings !== null) defects.push(...(await siblingChecks(base, siblings, report)));
  return defects;
}

/**
 * The record paths this write reaches: the uncommitted diff, and every commit a
 * peer dispatch of the same round made since the round opened.
 *
 * The uncommitted diff alone is not the write. Two seats of one round that
 * merge two records into one leave the second seat with a judged record the
 * first one already closed and committed, and no replacement of its own
 * (ADR-0078). A birth has no round, so its range is its own diff.
 * @returns {Promise<string[]>}
 */
async function writeRange(base, changed) {
  const files = new Set(changed.map(posix));
  if (typeof base?.roundFrom === 'string' && base.roundFrom.length > 0) {
    const committed = await changedInRange(base.worktree, base.roundFrom, 'HEAD').catch(() => []);
    for (const file of committed) files.add(posix(file));
  }
  return [...files];
}

/**
 * The records of this dispatch whose status line the worktree now reads closed.
 * A judged write closes the records it was given; a birth closes whatever
 * record file it changed.
 * @returns {Set<string>}
 */
function closedOf(base, records, changed) {
  const list =
    records.length > 0
      ? records
      : changed.map(posix).filter((file) => recordPathIncludes(file, base?.recordPaths ?? []));
  return new Set(activeOf(base?.worktree, list).skipped.map((entry) => entry.record));
}

/**
 * The supersessions this write's range holds against a set of parents: the
 * records it added that name one of them on a `Supersedes` line, and the
 * parents those records answer for.
 *
 * Under the rewrite lifecycle nothing supersedes anything, so the answer is
 * empty and a closure there takes the retirement route alone.
 * @returns {{replacements: string[], answered: Set<string>}}
 */
function supersessions(base, parents, range) {
  const replacements = [];
  const answered = new Set();
  if (parents.length === 0 || base?.recordLifecycle !== 'supersede') {
    return { replacements, answered };
  }
  const byId = new Map();
  for (const parent of parents) {
    const id = recordId(parent);
    if (id !== null && !byId.has(id)) byId.set(id, parent);
  }
  for (const file of range) {
    if (!recordPathIncludes(file, base?.recordPaths ?? [])) continue;
    const listed = parseRecordList(supersedesOf(readText(join(base.worktree, file)) ?? '') ?? '');
    if (listed === null) continue;
    let names = false;
    for (const id of listed) {
      const parent = byId.get(id);
      if (parent === undefined || posix(parent) === posix(file)) continue;
      answered.add(parent);
      names = true;
    }
    if (names) replacements.push(file);
  }
  return { replacements, answered };
}

/**
 * What a closure owes. A record whose status line this write set to superseded
 * or retired is either replaced by a record of the same round, or retired in
 * the report with the reason. Neither is a way to discharge a judged record
 * unread, and nothing else refuses that (ADR-0078).
 * @returns {string[]}
 */
function closureDefects(base, closed, replaced, unchanged) {
  const defects = [];
  for (const record of closed) {
    if (replaced.has(record)) continue;
    const reason = unchanged.get(record);
    if (typeof reason === 'string' && reason.trim().length > 0) continue;
    defects.push(
      base?.recordLifecycle === 'supersede'
        ? `${record} is closed in this diff and nothing accounts for it. A closure takes one ` +
            'of two routes. Write the record that replaces it, with a "Supersedes" line that ' +
            'names it. Or report it in "unchanged" with the reason you retired it.'
        : `${record} is closed in this diff and nothing accounts for it. Report it in ` +
            '"unchanged" with the reason you retired it.',
    );
  }
  return defects;
}

/** The boundary a write is contained in: the judged records, or the record tree. */
function containmentTrees(base, records) {
  const trees = [...new Set(records.map((record) => dirname(record.replaceAll('\\', '/'))))].filter(
    (dir) => dir.length > 0 && dir !== '.',
  );
  if (trees.length > 0) return trees;
  return (base?.recordPaths ?? []).filter((entry) => !entry.startsWith('!'));
}

/**
 * The records the unit check counts, and the records it drops.
 *
 * A judged write answers the records it was given; a birth answers the records
 * it wrote, which are the ones it reported. Either list goes through the active
 * filter first, because a closed record owes no unit.
 *
 * A replacement joins the set. A judged write under the supersede lifecycle
 * closes the record it was given and adds the record that states the tree, and
 * that new record is the one whose every unit is the seat's (ADR-0078).
 *
 * The replacement is read from this dispatch's own diff and never from the
 * round's range. A record a peer seat of the round wrote is that seat's work,
 * and it answered every unit of it.
 * @param {string[]|null} [added] this dispatch's own changed paths
 * @returns {Promise<{records: string[], dropped: string[]}>}
 */
export async function unitRecords(base, records, report, added = null) {
  const list = records.length > 0 ? records : [...new Set(report?.rewritten ?? [])];
  const { records: active, skipped } = activeOf(base?.worktree, list);
  const diff = added ?? (await changedFiles(base.worktree));
  const { replacements } = supersessions(base, records, diff.map(posix));
  return {
    records: [...new Set([...active, ...replacements])],
    dropped: skipped.map((entry) => entry.record),
  };
}

/**
 * The records one report answered units for, minus the ones the active filter
 * drops.
 *
 * It is the set the unit check counted. Every counted record takes an entry by
 * rule 1, rule 2 refuses an entry about any other record, and an entry about a
 * dropped one is dropped. So a stamp per record of this set is one stamp per
 * record the seat answered, and never one for a record it was told to leave
 * alone (ADR-0078).
 * @returns {string[]}
 */
export function answeredRecords(base, report) {
  const named = [...new Set((report?.units ?? []).map((entry) => entry.record))];
  return activeOf(base?.worktree, named).records;
}

/**
 * The eight refusals over a unit report, numbered as the plan and the tests
 * name them. Rules 1 to 5 bind every record seat, rule 6 the writer, rules 7
 * and 8 the review.
 *
 * The kind is not the seat's escape. A seat that calls every unit `rationale`
 * owes no path and passes a check that reads the kinds it was given, so rule 5
 * reads the unit's own text and refuses the label.
 *
 * `dropped` names the records the active filter took out of the set. An answer
 * about one of them is dropped with it and never refused: the brief tells the
 * seat to leave it out, and a defect would spend a corrective round on a report
 * that is otherwise right (ADR-0078).
 * @param {{seat?: 'writer'|'review', findings?: object[], dropped?: string[]}} [opts]
 * @returns {string[]}
 */
export function unitChecks(
  base,
  records,
  report,
  { seat = 'writer', findings = [], dropped = [] } = {},
) {
  const entries = Array.isArray(report?.units) ? report.units : null;
  if (entries === null) {
    return [
      'unit check 1: your report carries no "units". Every unit of every record takes one entry.',
    ];
  }
  const defects = [];
  const known = new Set(records.map(posix));
  const closed = new Set(dropped.map(posix));
  const grouped = new Map();
  for (const entry of entries) {
    const record = posix(entry.record);
    if (closed.has(record)) continue;
    if (!known.has(record)) {
      defects.push(
        `unit check 2: "units" names ${entry.record}, which is not a record of this dispatch ` +
          `(${records.join(', ')}).`,
      );
      continue;
    }
    if (!grouped.has(record)) grouped.set(record, []);
    grouped.get(record).push(entry);
  }
  const heads = new Map();
  for (const record of known) {
    const text = readText(join(base.worktree, record));
    if (text === null) {
      defects.push(`unit check 2: ${record} cannot be read in the worktree; it is not enumerable.`);
      continue;
    }
    const units = recordUnits(text);
    const counts = new Map();
    for (const entry of grouped.get(record) ?? []) {
      counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    }
    const ids = new Set(units.map((unit) => unit.id));
    for (const unit of units) {
      heads.set(unitKey(record, unit.id), unit.head);
      const n = counts.get(unit.id) ?? 0;
      if (n === 0) {
        defects.push(
          `unit check 1: ${record} ${unit.id} (line ${unit.line}, "${unit.head}") has no entry ` +
            'in "units". Every unit takes one.',
        );
      } else if (n > 1) {
        defects.push(
          `unit check 3: ${record} ${unit.id} has ${n} entries in "units"; each unit takes ` +
            'exactly one.',
        );
      }
    }
    for (const id of counts.keys()) {
      if (ids.has(id)) continue;
      defects.push(
        `unit check 2: "units" names ${record} ${id}, which the file does not hold. The ` +
          `enumeration is: node ${UNITS_BIN} ${record}`,
      );
    }
  }
  for (const entry of entries) {
    const record = posix(entry.record);
    const head = heads.get(unitKey(record, entry.id));
    if (head === undefined) continue;
    if (entry.kind === 'claim') defects.push(...evidenceDefects(base, record, entry, head));
    if (entry.kind === 'rationale' && kindTest(head) === 'claim') {
      defects.push(
        `unit check 5: ${record} ${entry.id} is filed as rationale and its text reads as a ` +
          `claim about the tree: "${head}". A sentence that names a path, a symbol or one of ` +
          'the closed verbs is a claim, and a claim carries the path that answers it.',
      );
    }
  }
  if (seat === 'review') {
    const raised = new Map();
    for (const finding of findings) {
      if (!finding?.unit) continue;
      const key = unitKey(posix(finding.file ?? ''), finding.unit);
      if (!raised.has(key)) raised.set(key, []);
      raised.get(key).push(finding.id ?? finding.unit);
    }
    for (const entry of entries) {
      const record = posix(entry.record);
      const key = unitKey(record, entry.id);
      if (!heads.has(key)) continue;
      if (entry.verdict === 'fails' && !raised.has(key)) {
        defects.push(
          `unit check 7: ${record} ${entry.id} is reported "fails" and no finding names it. A ` +
            'unit that fails is a finding, with its criterion and its evidence.',
        );
      }
      if (entry.verdict === 'holds' && raised.has(key)) {
        defects.push(
          `unit check 8: finding ${raised.get(key).join(', ')} names ${record} ${entry.id} and ` +
            'you reported that unit "holds". The finding and the verdict state one thing.',
        );
      }
    }
    return defects;
  }
  for (const entry of entries) {
    if (entry.verdict !== 'fails') continue;
    const record = posix(entry.record);
    if (!heads.has(unitKey(record, entry.id))) continue;
    defects.push(
      `unit check 6: ${record} ${entry.id} is reported "fails" and you wrote this record. A ` +
        'unit you report as failing is a unit you have not finished; answer it in the record.',
    );
  }
  return defects;
}

/** Rule 4: a claim carries the path in the worktree that answers it. */
function evidenceDefects(base, record, entry, head) {
  const path = evidencePath(entry.evidence);
  if (path === null) {
    return [
      `unit check 4: ${record} ${entry.id} ("${head}") is a claim and its evidence names no ` +
        `path: "${entry.evidence ?? ''}". Cite the repo-relative path that answers it, and the ` +
        'line where one exists.',
    ];
  }
  if (existsSync(join(base.worktree, path))) return [];
  return [
    `unit check 4: ${record} ${entry.id} ("${head}") cites ${path} and the worktree holds no ` +
      'such path.',
  ];
}

/** The verbs that make a sentence a statement about the tree. Closed. */
const CLAIM_VERBS = new Set([
  'is',
  'are',
  'reads',
  'returns',
  'runs',
  'writes',
  'serves',
  'exposes',
]);

/**
 * Whether a unit's own text reads as a claim about the tree, whatever kind the
 * seat put on it. A path, a symbol in backticks, or one of the closed verbs
 * makes it one.
 * @returns {'claim'|null}
 */
export function kindTest(head) {
  const text = String(head ?? '');
  if (/`[^`]+`/.test(text)) return 'claim';
  if (namesPath(text)) return 'claim';
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (CLAIM_VERBS.has(word)) return 'claim';
  }
  return null;
}

/** A token that reads as a repository path: two segments and a suffix, or three. */
function namesPath(text) {
  for (const token of String(text).split(/[\s,;()[\]"']+/)) {
    const bare = token.replaceAll('`', '').replaceAll('*', '').replace(/[.,;:]+$/, '');
    if (!bare.includes('/')) continue;
    if (bare.split('/').filter(Boolean).length > 2 || /\.\w{1,6}$/.test(bare)) return true;
  }
  return false;
}

/** The path a piece of evidence names, without its line suffix, or null. */
function evidencePath(evidence) {
  for (const token of String(evidence ?? '').split(/[\s,;()[\]"']+/)) {
    const bare = token
      .replaceAll('`', '')
      .replaceAll('*', '')
      .replace(/[.,;:]+$/, '')
      .replace(/:\d+(-\d+)?$/, '');
    if (bare.length === 0) continue;
    if (!bare.includes('/') && !/\.\w{1,6}$/.test(bare)) continue;
    return bare.replaceAll('\\', '/');
  }
  return null;
}

/**
 * The supersede lifecycle, checked over the tree the seat left.
 *
 * An accepted record is one that stands at the merge base of the run branch and
 * the default branch, computed at the write and not at the launch: a record the
 * default branch gained during the run is accepted, and a record this run's own
 * birth stage added is not, whatever the freeze sha holds.
 *
 * The only change an accepted record takes is its status line, in one of two
 * closed forms. The body is kept verbatim, because the tree's own precedent is
 * a supersession that empties the record and leaves a stub nobody can read.
 * Both directions of a supersession are checked: the old record names the new
 * ones, and every new one names the old record back.
 * @returns {Promise<string[]>}
 */
export async function supersedeChecks(base, records, report) {
  const worktree = base.worktree;
  const recordPaths = base.recordPaths ?? [];
  const entries = recordPaths.filter((entry) => !entry.startsWith('!'));
  if (entries.length === 0) return [];
  let mergeBase = base.mergeBase ?? null;
  if (!mergeBase) {
    try {
      mergeBase = (await git(['merge-base', 'HEAD', base.defaultBranch], { cwd: worktree })).trim();
    } catch (error) {
      return [`the accepted record set cannot be computed: ${error.message}`];
    }
  }
  const accepted = new Set(
    (await filesAt(worktree, mergeBase, entries)).filter((file) =>
      recordPathIncludes(file, recordPaths),
    ),
  );
  const changed = (await changedFiles(worktree))
    .map(posix)
    .filter((file) => recordPathIncludes(file, recordPaths));
  const added = changed.filter((file) => !accepted.has(file));
  const defects = [];
  for (const file of changed) {
    if (!accepted.has(file)) continue;
    defects.push(...(await acceptedEditDefects(worktree, mergeBase, file, added)));
  }
  for (const file of added) {
    defects.push(...supersedesBackDefects(worktree, file, accepted, changed));
  }
  return defects;
}

/** What one change to an accepted record may be, and what it may not. */
async function acceptedEditDefects(worktree, mergeBase, file, added) {
  const before = await showAt(worktree, mergeBase, file);
  const after = readText(join(worktree, file));
  if (after === null) {
    return [
      `${file} is an accepted record and this diff deletes it. An accepted record is never ` +
        'removed; supersede it and keep its body.',
    ];
  }
  if (before === null) {
    return [`${file} is an accepted record and its accepted text cannot be read.`];
  }
  const status = statusOf(before);
  const moved = changedLines(before, after);
  if (moved === null || moved.length !== 1 || moved[0] + 1 !== status.line) {
    return [
      `${file} is an accepted record and this diff changes more than its status line. An ` +
        'accepted record is never edited: write a new record that states the tree as it stands, ' +
        'name this one on its "Supersedes" line, and change nothing here but the status line. ' +
        'The old body is kept, verbatim.',
    ];
  }
  const text = statusOf(after).text ?? '';
  const superseded = SUPERSEDED_BY.exec(text);
  if (!superseded) {
    if (RETIRED.test(text)) return [];
    return [
      `${file} takes a status line this lifecycle does not hold: "${text}". The two closed ` +
        'forms are "Superseded by <list> (YYYY-MM-DD)" and "Retired (YYYY-MM-DD): <one sentence>".',
    ];
  }
  const listed = parseRecordList(superseded[1]);
  if (listed === null) {
    return [
      `${file} names its successors as "${superseded[1]}". The list is ADR-<id> items joined ` +
        'by ", ", with " and " before the last.',
    ];
  }
  const defects = [];
  const self = recordId(file);
  for (const id of listed) {
    const target = added.find((candidate) => recordId(candidate) === id);
    if (!target) {
      defects.push(
        `${file} is superseded by ADR-${id} and no such record is added in this diff. Every ` +
          'record a status line names is written in the same diff.',
      );
      continue;
    }
    const back = supersedesOf(readText(join(worktree, target)) ?? '');
    const backList = back === null ? null : parseRecordList(back);
    if (backList === null) {
      defects.push(
        `${target} supersedes ${file} and carries no "Supersedes: <list>" line under its ` +
          'status line.',
      );
      continue;
    }
    if (!backList.includes(self)) {
      defects.push(`${target} supersedes ${file} and its "Supersedes" line does not name it.`);
    }
  }
  return defects;
}

/** The other direction: a new record's parent is superseded in the same diff. */
function supersedesBackDefects(worktree, file, accepted, changed) {
  const back = supersedesOf(readText(join(worktree, file)) ?? '');
  if (back === null) return [];
  const listed = parseRecordList(back);
  if (listed === null) {
    return [
      `${file} names what it supersedes as "${back}". The list is ADR-<id> items joined by ` +
        '", ", with " and " before the last.',
    ];
  }
  const self = recordId(file);
  const defects = [];
  for (const id of listed) {
    const old = [...accepted].find((candidate) => recordId(candidate) === id);
    if (!old) {
      defects.push(`${file} supersedes ADR-${id}, which is not an accepted record of this tree.`);
      continue;
    }
    if (!changed.includes(old)) {
      defects.push(
        `${file} supersedes ${old} and this diff leaves that record's status line unchanged. ` +
          'Set it to "Superseded by <list> (YYYY-MM-DD)" and change nothing else in it.',
      );
      continue;
    }
    const status = statusOf(readText(join(worktree, old)) ?? '');
    const superseded = SUPERSEDED_BY.exec(status.text ?? '');
    const listedBack = superseded === null ? null : parseRecordList(superseded[1]);
    if (listedBack === null || !listedBack.includes(self)) {
      defects.push(`${file} supersedes ${old} and that record's status line does not name it.`);
    }
  }
  return defects;
}

const SUPERSEDED_BY = /^Superseded by (.+?) \((\d{4}-\d{2}-\d{2})\)$/i;
const RETIRED = /^Retired \((\d{4}-\d{2}-\d{2})\):\s*\S+/i;

/**
 * The ids a supersede list names, or null for a list in another form. The
 * separator is checked as well as the items: a list is one form, so a reader
 * and a writer never disagree about where one id ends.
 */
export function parseRecordList(text) {
  const raw = String(text ?? '').trim();
  const parts = raw
    .split(/,\s*|\s+and\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const ids = [];
  for (const part of parts) {
    const match = /^adr-0*(\d+)$/i.exec(part);
    if (!match) return null;
    ids.push(Number(match[1]));
  }
  return renderRecordList(parts) === raw ? ids : null;
}

/** The one form a list of records is written in. */
export function renderRecordList(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The indices of the lines two texts differ on, or null when the counts differ. */
function changedLines(before, after) {
  const left = String(before).replace(/\r\n/g, '\n').split('\n');
  const right = String(after).replace(/\r\n/g, '\n').split('\n');
  if (left.length !== right.length) return null;
  const moved = [];
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) moved.push(i);
  }
  return moved;
}

/** One file's text at a sha, or null. */
async function showAt(worktree, sha, file) {
  try {
    return await git(['show', `${sha}:${file}`], { cwd: worktree });
  } catch {
    return null;
  }
}

/**
 * The records that cite a record this write supersedes.
 *
 * The harness computes them, minus the records this run already has in scope,
 * and the seat answers each one: consistent with the reason, or superseded with
 * the record that replaces it in the same diff. A sibling nobody answered is a
 * record left citing a decision that no longer stands.
 * @returns {Promise<string[]>}
 */
export async function siblingChecks(base, siblings, report) {
  const list = (siblings ?? []).map(posix);
  const entries = Array.isArray(report?.siblings) ? report.siblings : [];
  const defects = [];
  const counts = new Map();
  for (const entry of entries) {
    const record = posix(entry.record);
    counts.set(record, (counts.get(record) ?? 0) + 1);
  }
  for (const record of list) {
    const n = counts.get(record) ?? 0;
    if (n === 1) continue;
    defects.push(
      n === 0
        ? `${record} cites a record this write supersedes and "siblings" accounts for it ` +
            'nowhere. Give it one entry: "consistent" with the reason, or "superseded" with the ' +
            'record that replaces it in this diff.'
        : `${record} has ${n} entries in "siblings"; each sibling takes exactly one.`,
    );
  }
  if (list.length === 0 && entries.length === 0) return defects;
  const touched = new Set((await changedFiles(base.worktree)).map(posix));
  for (const entry of entries) {
    const record = posix(entry.record);
    if (!list.includes(record)) {
      defects.push(
        `"siblings" names ${record}, which is not a sibling of this write ` +
          `(${list.length > 0 ? list.join(', ') : 'none'}).`,
      );
      continue;
    }
    if (entry.state !== 'superseded') continue;
    const replacement = posix(entry.replacement ?? '');
    if (replacement.length === 0 || !touched.has(replacement)) {
      defects.push(
        `you report ${record} as superseded and no record that replaces it is in this diff. ` +
          'Name it in "replacement" and write it here, or answer "consistent" with the reason.',
      );
    }
  }
  return defects;
}

/**
 * The two deterministic rules over the divergence declaration.
 *
 * Every judged record is accounted for exactly once, which is the same rule the
 * rewritten/unchanged pair already meets: a record the report is silent about
 * is a record nobody said anything about, and silence is what this declaration
 * exists to remove.
 *
 * And a `named` statement is really in the file. Records are wrapped at 80
 * columns, so the comparison normalises whitespace on both sides: a sentence
 * the seat wrote across a line break is the same sentence, and a comparison
 * that said otherwise would refuse every honest declaration.
 */
export function divergenceDefects(base, records, report) {
  const defects = [];
  const declared = Array.isArray(report.divergences) ? report.divergences : [];
  const counts = new Map();
  for (const entry of declared) {
    counts.set(entry.record, (counts.get(entry.record) ?? 0) + 1);
  }
  for (const record of records) {
    const n = counts.get(record) ?? 0;
    if (n === 1) continue;
    defects.push(
      n === 0
        ? `${record} was judged owed and "divergences" accounts for it nowhere. Give it one ` +
            'entry: "named" with the sentence you wrote into the record, or "none" with your reason.'
        : `${record} has ${n} entries in "divergences"; each judged record takes exactly one.`,
    );
  }
  for (const entry of declared) {
    if (!records.includes(entry.record)) {
      defects.push(
        `"divergences" names ${entry.record}, which was not judged owed; the entries are the ` +
          `judged records and no others (${records.join(', ')}).`,
      );
      continue;
    }
    if (entry.state !== 'named') continue;
    const text = readText(join(base.worktree, entry.record));
    if (text === null) {
      defects.push(
        `you declare a divergence named in ${entry.record} and the file cannot be read.`,
      );
      continue;
    }
    if (!flattened(text).includes(flattened(entry.statement))) {
      defects.push(
        `you declare this divergence as named in ${entry.record} and the sentence is not in ` +
          `the file: "${entry.statement}". Write it into the record, verbatim, or declare ` +
          '"none" with your reason.',
      );
    }
  }
  return defects;
}

function unitKey(record, id) {
  return `${record} ${id}`;
}

function posix(path) {
  return String(path ?? '').replaceAll('\\', '/');
}

/** One line of text, whatever the wrapping: every run of whitespace is a space. */
export function flattened(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}
