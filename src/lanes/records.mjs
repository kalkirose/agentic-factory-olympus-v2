// The record contract: the report shape every record seat answers in, the
// three briefs the writer works from, and the two readings the harness makes of
// what a seat left in the tree (ADR-0080).
//
// One contract, three briefs, two seat names. The birth seat writes the records
// a spec decides before the freeze. The reconciliation seat rewrites the records
// a shipped diff moved. The corrective seat answers the findings a review
// raised. All three write the same work product, so the schema, the readings and
// the containment live here and every lane reads them from one place. The seat
// names differ because a seat name is the key of the attempt budget, the cost
// series and the failure record, and a birth must not spend a correction's
// budget.
//
// The harness reads no token, no verb and no path of a record. The project's
// form gate reads the form, in the seat's own shell and again at the render over
// the committed bytes. The review seat reads the truth. The harness reads the
// ledger: which records a dispatch owns, which files a seat may change, and what
// the stamps say.
//
// So neither reading here refuses a report. A change outside the record tree is
// reverted and recorded, because a record run must not ship code and a revert
// costs no attempt where a refusal costs one. A record the report lists as
// rewritten that the tree did not change is dropped from the list with a note.
// The one refusal a record write still takes is the runner's own: a report that
// is not the JSON the schema names is no report.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordPathIncludes } from '../config/project.mjs';
import { assertDefectKind, assertRecaptureClass } from '../ledger/registry.mjs';
import { git } from '../isolation/git.mjs';
import { changedFiles, changedInRange, headSha, restorePaths } from '../isolation/tree.mjs';
import { recordCriteriaLines } from './lenses.mjs';
import { NEIGHBOUR_CAP, isActiveRecord, readText } from './units.mjs';
import { ACTOR, againstClause, briefLines, gist, underAny } from './shared.mjs';

/** The seat that rewrites the records at a reconciliation and at a correction. */
export const WRITE_SEAT = 'reconcile-write';

/** The seat that writes a record at its birth, before the freeze. */
export const AUTHOR_SEAT = 'record-author';

/** The seat that reads one record and judges it. */
export const REVIEW_SEAT = 'record-review';

/**
 * The enumerator, by absolute path. A seat runs with the run worktree as its
 * working directory, so it reaches the harness's own bin by the path the brief
 * names, as it reaches the diff file today (ADR-0066).
 */
export const UNITS_BIN = fileURLToPath(new URL('../../bin/olympus-units.mjs', import.meta.url));

/**
 * The write seat's report shape: the records it rewrote, the records it left
 * alone with the reason, and the findings it answered.
 *
 * `answered` is on a corrective invocation alone, because a schema that carried
 * it on the first write would ask a seat to invent a list of findings nobody
 * raised. An entry names the finding id, and `disputed` carries the one-sentence
 * reason a writer gives for leaving the record as it stands. A disputed finding
 * is closed by the next cycle's reviewer, which reads the record fresh and
 * either raises it again or does not (ADR-0080).
 *
 * The record itself is the work product. Nothing here asks a seat for a reading
 * of its own text.
 * @param {{answered?: boolean}} [opts]
 */
export function reconcileWriteSchema({ answered = false } = {}) {
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
      ...(answered && {
        answered: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              disputed: { type: 'string' },
            },
            required: ['id'],
          },
        },
      }),
      summary: { type: 'string' },
    },
    required: ['rewritten', 'unchanged', ...(answered ? ['answered'] : []), 'summary'],
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
 * @param {{key?: string, path?: string, reason?: string, touchedPaths?: string[]}} spec
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
    ...renderLines(base),
    '',
    'Rules:',
    ...RECORD_RULES,
    ...lifecycleLines(base),
    ...CONSTITUTION_DUTY,
    ...briefLines(brief),
  ].join('\n');
}

/**
 * The write seat's brief. It carries the judged records, what to read them
 * against, and the rules the record tree binds its editors to.
 */
export function writeRole(base, judged, brief) {
  const records = judged.records ?? [];
  return [
    'Rewrite the decision records below so they stand as fact against this',
    'branch.',
    ...sourceLines(base),
    '',
    'Records to reconcile:',
    ...records.map((r) => `- ${r}`),
    '',
    `Judged reason: ${judged.reason}`,
    ...neighbourhoodLines(judged.neighbours),
    ...renderLines(base),
    '',
    'Rules:',
    ...RECORD_RULES,
    ...judgedRules(records),
    ...lifecycleLines(base),
    ...CONSTITUTION_DUTY,
    ...briefLines(brief),
  ].join('\n');
}

/**
 * The corrective brief: the same rules, plus the findings a review raised on
 * the records this seat already wrote. Each finding carries the unit it is
 * about, the criterion it fails and the reviewer's own evidence, so the seat
 * answers a claim about the tree rather than a remark. A finding is one unit of
 * the record, and every other unit of the record is the seat's as well.
 *
 * The remarks ride the same brief. A finding below HIGH holds no render red and
 * buys no round of its own, so it is handed to the writer this round dispatches
 * on its record anyway: that seat is already reading the record, and a remark
 * thrown away is a finding the next run raises again at a higher grade
 * (ADR-0007).
 */
export function correctiveRole(base, judged, { findings, advisory = [], brief }) {
  const records = judged.records ?? [];
  return [
    'The decision records you rewrote were reviewed, and these findings were raised',
    'against the tree. Answer every one of them in the records.',
    ...sourceLines(base),
    '',
    'Findings:',
    ...findings.map((f) => `- ${findingLine(f)}`),
    '',
    ...ANSWERED_DUTY,
    ...(advisory.length > 0
      ? [
          '',
          'These remarks hold no render red. Answer each one in this write, or list its id under',
          '"answered" where the record is right as written:',
          ...advisory.map((f) => `- ${remarkLine(f)}`),
        ]
      : []),
    '',
    'Records to reconcile:',
    ...records.map((r) => `- ${r}`),
    '',
    `Judged reason: ${judged.reason}`,
    ...neighbourhoodLines(judged.neighbours),
    ...renderLines(base),
    '',
    'Rules:',
    ...RECORD_RULES,
    ...judgedRules(records),
    ...lifecycleLines(base),
    ...CONSTITUTION_DUTY,
    ...briefLines(brief),
  ].join('\n');
}

/**
 * What the seat reads the records against.
 *
 * A story-lane or repair-lane record write answers a code diff, so the brief
 * names the diff and the command that reads it. A records-lane write has no
 * such diff: the record it holds is the whole of the branch, and a seat sent to
 * read `git diff` there reads the document it is about to edit (ADR-0080).
 */
function sourceLines(base) {
  if (base?.mode === 'records') {
    return [
      'The record below is this branch\'s own work. Read the record whole, and read the tree it',
      'describes. There is no code diff on this branch.',
    ];
  }
  return [
    'You did not write the code; read it before you write a word.',
    `The diff is this branch against ${base.defaultBranch}. Read it with:`,
    `git diff ${base.defaultBranch}...HEAD`,
  ];
}

/** What the report says about the findings, stated where the seat answers it. */
const ANSWERED_DUTY = [
  'List every finding id in "answered". Answer it in the record, not in the report.',
  'Where you read the record and find it right as written, put the id in "answered" with',
  '"disputed" and the one sentence that says why. The next review reads that record fresh.',
  'A finding names one unit. Every other unit of the record is yours as well.',
];

/**
 * One finding, as a brief states it. The unit and its head ride the line,
 * because a finding that names a file names a record and a finding that names a
 * unit names the sentence.
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
 * One remark, as a brief and a request body state it: the grade rides the line.
 *
 * A remark is answered at the writer's judgment rather than by rule, so the
 * grade is part of what the seat is told. A finding needs no grade on its line:
 * every one of them is a confirmed HIGH (ADR-0007).
 */
export function remarkLine(f) {
  return `[${f.severity ?? 'MED'}] ${findingLine(f)}`;
}

/**
 * The rules the record tree binds its editors to, in all three briefs.
 *
 * The first of them is the criteria list itself, verbatim, because it is the
 * list the review that reads this seat's work judges it against (ADR-0038). A
 * paraphrase beside the list is a second statement of one rule, and the two
 * drift: the writer then meets a criterion at the review that its own brief
 * never stated.
 *
 * The rest are the directions about the document, as prose. They are what the
 * report tables used to ask for entry by entry: the seat still owes every one of
 * them in the record, and it hands back no reading of its own sentences
 * (ADR-0080).
 */
const RECORD_RULES = [
  '- Every record you leave meets these criteria, which are the criteria the',
  '  review reads it against:',
  ...recordCriteriaLines().map((line) => `  ${line}`),
  '- Check every present-tense sentence against the tree before you write it,',
  '  and cite the path in the record where a claim rests on one.',
  '- Name every divergence between the tree and the decision in the record,',
  '  verbatim, with the evidence that shows it. A divergence is never absorbed.',
  '- Read every active record that cites the one you supersede, and leave none',
  '  of them contradicted.',
  '- A record does not cite the standard. It cites the records it relies on.',
  '- Edit only the decision-record tree. No source, test, or config change',
  '  rides this run: a change outside it is reverted before the commit.',
];

/** What the report owes about the records the harness judged owed. */
function judgedRules(records) {
  return [
    '- A record the diff turns out not to affect goes in unchanged with the',
    `  reason. Report every judged record (${records.length}) in rewritten or in`,
    '  unchanged, and never in both.',
  ];
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
 * The one mechanical reader of a record's form, named where the seat can run it.
 *
 * The project's gate reads the form. It runs in the seat's own shell, before the
 * report, and again at the render over the committed bytes, and those are the
 * same bytes CI would read (ADR-0076). This is a line of a brief and not a
 * check: the harness reads no token of a record (ADR-0080).
 */
function renderLines(base) {
  const named = new Set(base?.recordLayers ?? []);
  if (named.size === 0) return [];
  const commands = [];
  for (const layer of base?.layers ?? []) {
    if (!named.has(layer.name)) continue;
    const argv = base?.commands?.[layer.command];
    commands.push(Array.isArray(argv) ? argv.join(' ') : layer.command);
  }
  return [
    '',
    'The project form gate reads the files you leave. Run it in this worktree before you report:',
    ...(commands.length > 0 ? commands : [...named]).map((command) => `  ${command}`),
    'It reads the bytes the render reads. A red at the render costs the run a cycle.',
  ];
}

/**
 * Where the seat reads the lifecycle rule: in the brief that asks for a write.
 *
 * The closed-record duty stands under either lifecycle, because a record closed
 * by hand under `rewrite` traps a seat exactly as a superseded one does. The
 * supersession bullets are the supersede lifecycle's own. The mechanics of the
 * pairing live in the project's form gate and nowhere in the harness, so this
 * text and that gate are one rule with one implementation (ADR-0080).
 */
function lifecycleLines(base) {
  if (base?.recordLifecycle !== 'supersede') return ['', ...CLOSED_RECORD_DUTY];
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
    '  else in it changes, and an emptied body is a lost record.',
    '- The list is ADR-<id> items joined by ", ", with " and " before the last. Every record it',
    '  names is added in this same diff and names the old record back. One record may split into',
    '  several, and several may merge into one.',
    '- The project form gate reads that pairing. Run it before you report.',
    '- Two active records that decide one unbuilt part differently resolve by recency. The newer',
    '  decision stands, the older record gets its status line, and the newer record names both.',
    ...CLOSED_RECORD_DUTY,
  ];
}

/**
 * What the seat owes an old record it closes, stated once.
 *
 * A status-line change is not a rewrite. The harness reads the status line from
 * the tree, so a closed record listed in `rewritten` says nothing the tree does
 * not already say (ADR-0078).
 */
const CLOSED_RECORD_DUTY = [
  '- A status-line change of an old record is not a rewrite. List that record in neither',
  '  `rewritten` nor `unchanged` unless you retire it with a reason. The harness reads its',
  '  status line from the tree.',
];

/** The constitution's place in a record brief. */
const CONSTITUTION_DUTY = [
  '',
  'A constitution block above this brief binds every sentence you write into a record.',
  'It states the form of a record; this brief states the truth of one.',
];

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
 * The record files this run changed, read through the window.
 *
 * The window opens at the merge base of the run branch and the default branch,
 * so a record the default branch gained while the run worked is never in this
 * set, and a record an early round rewrote is read again by the round that
 * follows it (ADR-0079). Under the supersede lifecycle a superseded or retired
 * record is out of every seat's scope, so it leaves the set here.
 *
 * `only` says whether the run's whole diff is records. It reads the window's
 * base against the worktree, because the layer plan asks about the whole diff
 * and the window carries the record half of it.
 * @param {string} worktree
 * @param {string[]} recordPaths
 * @param {{lifecycle?: string, defaultBranch?: string, window?: object}} [opts]
 * @returns {Promise<{files: string[], only: boolean, base: string|null}>}
 */
export async function recordScope(
  worktree,
  recordPaths = [],
  { lifecycle, defaultBranch = 'main', window = null } = {},
) {
  const read = window ?? (await runWindow({ worktree, defaultBranch, recordPaths }));
  if (read.error !== null) throw new Error(read.error);
  const records = read.files;
  const files =
    lifecycle === 'supersede'
      ? records.filter((file) => {
          const text = readText(join(worktree, file));
          return text === null || isActiveRecord(text);
        })
      : records;
  const changed = await windowPaths(worktree, read.base);
  return { files, only: changed.length > 0 && records.length === changed.length, base: read.base };
}

/**
 * The two readings of what a write seat left in the tree. Neither refuses.
 *
 * First: a changed file outside the record tree is reverted to the tree's last
 * commit and recorded. A record run must not ship code, and a revert costs the
 * seat no attempt where a refusal costs one. The judged records are the
 * harness's own list, so their directories are the boundary; a birth judges no
 * record, so the project's record paths are the boundary there.
 *
 * Second: a record the report lists under `rewritten` that the tree did not
 * change is dropped from the list, with the note on the stamp. The list is
 * bookkeeping about the seat's own work, and a report refused for it costs a
 * dispatch and buys nothing (ADR-0080).
 * @returns {Promise<string[]>} the defects, which is always empty
 */
export async function writeChecks(ctx, base, records, report) {
  const trees = containmentTrees(base, records);
  const outside = (await changedFiles(base.worktree)).filter((file) => !underAny(file, trees));
  if (outside.length > 0) {
    await restorePaths(base.worktree, await headSha(base.worktree), outside);
    ctx.store.append('diff-policy-recapture', {
      actor: ACTOR,
      seat: base.seat ?? WRITE_SEAT,
      lane: base.mode ?? 'records',
      kind: assertDefectKind('capture-takeback'),
      class: assertRecaptureClass('record-seat'),
      recaptured: outside,
      note: SEAT_TAKEBACK_NOTE,
      recapturedLines: outside.map((path) => seatDropLine(path, trees)),
      gist: gist(`${outside.length} file(s) outside the record tree reverted: ${outside[0]}`),
    });
  }
  const changed = new Set((await changedFiles(base.worktree)).map(posix));
  const kept = [];
  const dropped = [];
  for (const record of report.rewritten ?? []) {
    (changed.has(posix(record)) ? kept : dropped).push(record);
  }
  report.rewritten = kept;
  if (dropped.length > 0) report.dropped = dropped;
  return [];
}

/** The record's one-sentence statement of what a record-seat take-back is. */
export const SEAT_TAKEBACK_NOTE =
  'A record seat wrote outside the decision-record tree. The write was reverted and the ' +
  'allowed set is committed around it. A record run rewrites records and ships no code.';

/** What the revert says about one file, in the words the seat reads. */
export function seatDropLine(path, trees) {
  return (
    `${path}: this run rewrites decision records and nothing else. The records it was given ` +
    `live under ${trees.join(', ')}. The write was reverted.`
  );
}

/**
 * The one window on this run's work in the record tree: the merge base of the
 * run branch and the default branch, and every record path the run changed
 * from there to the worktree.
 *
 * Every reader of what the run did to the records opens here. A reader with a
 * narrower window reads a record this run closed in an earlier commit as
 * untouched (ADR-0079). The base is computed at the read and never at the
 * launch, so a record the default branch gained during the run stands outside
 * the window and belongs to nobody here.
 *
 * A read that fails is never an empty window. An empty one reads as a run that
 * wrote nothing, so the failure is returned and the caller states it.
 * @param {{worktree: string, defaultBranch?: string, recordPaths?: string[]}} base
 * @returns {Promise<{base: string|null, files: string[], error: string|null}>}
 */
export async function runWindow(base) {
  const worktree = base?.worktree;
  const recordPaths = base?.recordPaths ?? [];
  const branch = base?.defaultBranch ?? 'main';
  let mergeBase;
  try {
    mergeBase = (await git(['merge-base', 'HEAD', branch], { cwd: worktree })).trim();
  } catch (error) {
    return { base: null, files: [], error: `merge-base HEAD ${branch}: ${error.message}` };
  }
  try {
    const paths = await windowPaths(worktree, mergeBase);
    return {
      base: mergeBase,
      files: paths.filter((file) => recordPathIncludes(file, recordPaths)),
      error: null,
    };
  } catch (error) {
    return { base: mergeBase, files: [], error: `${mergeBase}..HEAD: ${error.message}` };
  }
}

/** Every path the window holds, records and code alike: the two reads, once. */
async function windowPaths(worktree, mergeBase) {
  const files = new Set();
  for (const file of await changedInRange(worktree, mergeBase, 'HEAD')) files.add(posix(file));
  for (const file of await changedFiles(worktree)) files.add(posix(file));
  return [...files];
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
 * The ids a supersede list names, or null for a list in another form.
 *
 * The tree shape stamp reads it, to pair a closed record with the record that
 * replaced it. Nothing refuses a record on it: the project's form gate is the
 * one reader of the lifecycle's mechanics (ADR-0080).
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

function posix(path) {
  return String(path ?? '').replaceAll('\\', '/');
}
