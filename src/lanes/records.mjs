// The decision-record rewrite seat: its report shape, its brief, and the
// deterministic checks over what it left in the tree (ADR-0026).
//
// Two lanes dispatch this seat and they dispatch the same seat. The update
// stage runs it once, in front of the ship token, over the records the
// reconciliation judge found owed. The verdict stage runs it again, correctively,
// for every confirmed record finding the reconciliation cycle's review raised —
// the ladder's repair arm never calls `repair-dev` there, because the context
// that implemented the code does not reconcile the records against its own
// work. So the contract lives here, beside neither lane, and both read it.
//
// The checks are the containment. No deny rule can say "everything except these
// directories" without walking the repository, so the boundary is a check over
// what the seat left in the tree, in the shape the card sweep already uses, and
// the commit is behind it.
//
// One rule of the brief is proved rather than asked for. "A divergence is never
// absorbed silently" was stated in two briefs and enforced nowhere, and a live
// run half kept it: the seat named three divergences in its report and absorbed
// a fourth. The half a check can see is now mechanical — the seat declares one
// entry per judged record, and a declared statement that is not in the record
// file is a work-product defect. The half no check can see is whether a
// divergence exists that nobody named, and that is the review seat's work under
// the `divergence` criterion.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { changedFiles } from '../isolation/tree.mjs';
import { underAny, briefLines } from './shared.mjs';

/** The seat that rewrites the records, in both of the lanes that dispatch it. */
export const WRITE_SEAT = 'reconcile-write';

/** What a divergence entry may say about one judged record. */
export const DIVERGENCE_STATES = Object.freeze(['none', 'named']);

/**
 * The write seat's report shape. `answered` is present on a corrective
 * invocation alone: the seat lists the finding ids it answered, and a schema
 * that carried the field on the first write would ask a seat to invent a list
 * of findings nobody had raised.
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
      // One entry per judged record: the record, whether the seat found a
      // divergence between the tree and the record, and the sentence behind
      // that word. For `named` it is the sentence the seat wrote into the
      // record, and a check proves it is there. For `none` it is the seat's own
      // one-sentence reason.
      divergences: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            record: { type: 'string' },
            state: { type: 'string', enum: [...DIVERGENCE_STATES] },
            statement: { type: 'string' },
          },
          required: ['record', 'state', 'statement'],
        },
      },
      ...(answered && { answered: { type: 'array', items: { type: 'string' } } }),
      summary: { type: 'string' },
    },
    required: [
      'rewritten',
      'unchanged',
      'divergences',
      ...(answered ? ['answered'] : []),
      'summary',
    ],
  };
}

/** The shape the first write of a run answers in. */
export const RECONCILE_WRITE_SCHEMA = reconcileWriteSchema();

/**
 * The write seat's brief. It carries the judged records, the diff to read them
 * against, and the rules the record tree binds its editors to.
 */
export function writeRole(base, judged, brief) {
  return [
    'Rewrite the decision records below so they stand as fact against this',
    'branch. You did not write the code; read it before you write a word.',
    `The diff is this branch against ${base.defaultBranch}. Read it with:`,
    `git diff ${base.defaultBranch}...HEAD`,
    '',
    'Records to reconcile:',
    ...(judged.records ?? []).map((r) => `- ${r}`),
    '',
    `Judged reason: ${judged.reason}`,
    '',
    'Rules:',
    ...WRITE_RULES,
    ...divergenceDutyLines(judged.records ?? []),
    ...briefLines(brief),
  ].join('\n');
}

/**
 * The corrective brief: the same rules, plus the findings a review raised on
 * the records this seat already wrote and a verifier confirmed against the
 * tree. Each finding carries the criterion it fails and the verifier's own
 * evidence, so the seat answers a claim about the tree rather than a remark.
 */
export function correctiveRole(base, judged, { findings, divergences, brief }) {
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
    '',
    'Records to reconcile:',
    ...(judged.records ?? []).map((r) => `- ${r}`),
    '',
    `Judged reason: ${judged.reason}`,
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
    ...WRITE_RULES,
    ...divergenceDutyLines(judged.records ?? []),
    ...briefLines(brief),
  ].join('\n');
}

function findingLine(f) {
  const where = f.file ? ` (${f.file})` : '';
  const criterion = f.criterion ? ` [${f.criterion}]` : '';
  return `[${f.id}]${criterion}${where} ${f.summary} (evidence: ${f.evidence})`;
}

/** The rules the record tree binds its editors to, in both briefs. */
const WRITE_RULES = [
  '- Rewrite the implemented parts of each record as standalone',
  '  present-tense fact. Keep the rationale and the fallback paths.',
  '- Parts the diff did not implement stay as explicit open sections.',
  '- A divergence between the diff and a recorded decision is never absorbed',
  '  silently: name it in the record and in your report, verbatim.',
  '- Edit only the decision-record tree. No source, test, or config change',
  '  rides this run.',
  '- A record the diff turns out not to affect goes in unchanged with the',
  '  reason. Report every judged record in rewritten or in unchanged, and',
  '  never in both.',
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
  ];
}

/**
 * What the write seat left in the tree, against what it reported and against
 * what it was asked for. The judged records are the harness's own list, so
 * their directories are the boundary and no project has to declare one.
 */
export async function writeChecks(base, records, report) {
  const defects = [];
  const trees = [...new Set(records.map((record) => dirname(record.replaceAll('\\', '/'))))].filter(
    (dir) => dir.length > 0 && dir !== '.',
  );
  const changed = await changedFiles(base.worktree);
  for (const file of changed) {
    if (!underAny(file, trees)) {
      defects.push(
        `change outside the decision-record tree: ${file}. This run rewrites records and ` +
          `nothing else; the records it was given live under ${trees.join(', ')}.`,
      );
    }
  }
  const rewritten = new Set(report.rewritten);
  const unchanged = new Set(report.unchanged.map((u) => u.record));
  for (const record of records) {
    if (rewritten.has(record) && unchanged.has(record)) {
      defects.push(`${record} is reported as rewritten and as unchanged; it is one or the other.`);
      continue;
    }
    if (!rewritten.has(record) && !unchanged.has(record)) {
      defects.push(
        `${record} was judged owed and your report accounts for it nowhere. Rewrite it, or ` +
          'put it in unchanged with the reason it needs no change.',
      );
    }
  }
  const touched = new Set(changed);
  for (const record of report.rewritten) {
    if (!records.includes(record)) {
      defects.push(`${record} is not one of the judged records; this run rewrites those alone.`);
    } else if (!touched.has(record)) {
      defects.push(`you report ${record} as rewritten and the file is unchanged in the tree.`);
    }
  }
  defects.push(...divergenceDefects(base, records, report));
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
    const text = recordText(base.worktree, entry.record);
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

/** One record's text as the worktree holds it, or null. */
function recordText(worktree, record) {
  const path = join(worktree, record);
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** One line of text, whatever the wrapping: every run of whitespace is a space. */
export function flattened(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}
