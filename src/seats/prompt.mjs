// Two-block prompt assembly. Block one is the shared core: role line, scope
// discipline, narration cadence, tool policy, the one-turn execution rule, and
// the file contract with the named report path and schema. Block two is the
// per-seat role block — judgment criteria plus dispatch context, supplied by
// the lane. No verification scaffolding, no forced progress summaries, no
// reasoning-echo asks enter here or in any role block.
//
// A third block sits between them when the project ships a constitution: the
// policy text as its own delimited block, plus the authority order for the
// seats that judge, and beside it the style files the project binds its written
// work to. The seat sets below are closed like the seat map, and they are read
// by the seat's base name, so a slotted dispatch takes what its seat takes. A
// project with no constitution file and no style files gets no third block, and
// its prompts are byte for byte what they were.
import { seatBase } from './seatmap.mjs';

// A seat is a headless session: it ends when the model stops, and the machine
// kills every child command the seat left behind. A seat that starts a long
// command in the background and then waits for it loses the command and the
// report together, and the run pays the whole seat for nothing. The rule is
// stated to every seat because no seat can read it off its own environment.
export const ONE_TURN_RULE = [
  'Run every command synchronously and read its result in the same turn.',
  'Do not put work in the background. Do not arm a watcher, and do not wait for an event from outside your own turn.',
  'Your session ends when you stop, and the machine kills every command that still runs.',
  'A long command is acceptable. A command whose end you cannot see is not.',
  'Write your report before you stop. A turn that ends with no report breaks the contract, whatever work it did.',
].join('\n');

/**
 * The seats that receive the project constitution. The adversary is out by
 * design: it writes deliberately wrong implementations on purpose, and policy
 * text only dilutes that brief. The card sweep is out because it edits intent
 * cards rather than the tree. The eval seat is instance-scoped and holds no
 * worktree to read a constitution from.
 *
 * The four record seats are in. The constitution is where a project writes the
 * standard its decision records are held to, so a seat that writes a record or
 * judges one reads it, and a writer that did not read it wrote to nothing.
 */
export const CONSTITUTION_SEATS = new Set([
  'spec-birth',
  'spec-gate',
  'suite',
  'dev',
  'repair-dev',
  'verdict-triage',
  'fury-spec',
  'fury-code-shape',
  'fury-operational',
  'fury-interface',
  'fury-verifier',
  'record-verifier',
  'generalist-review',
  'record-author',
  'record-review',
  'reconcile-judge',
  'reconcile-write',
]);

/**
 * The judging seats. Each one weighs the tree against a document, so each one
 * needs to know which document wins when two of them disagree. The record judge
 * is one: it weighs the run's diff against the record tree and reports what the
 * tree owes. The record review is not, because it judges a record against the
 * code and against its criteria, and neither is an authority over the other.
 */
export const AUTHORITY_SEATS = new Set([
  'spec-gate',
  'fury-spec',
  'fury-code-shape',
  'fury-operational',
  'fury-interface',
  'fury-verifier',
  'record-verifier',
  'generalist-review',
  'verdict-triage',
  'reconcile-judge',
]);

const CONSTITUTION_HEAD =
  'Project constitution — the standing policy of this repository, and an input to this seat. It starts at the opening marker and ends at the closing marker.';
const CONSTITUTION_OPEN = '--- constitution ---';
const CONSTITUTION_CLOSE = '--- end constitution ---';

/** The authority order, fixed text, judging seats only. */
export const AUTHORITY_ORDER = [
  "Authority order, highest first: the constitution above, then the intent card, then this run's spec.",
  'A spec clause that contradicts a higher authority has no force. Do not enforce such a clause against the tree.',
  'The clause itself is a blocking finding against the spec.',
].join('\n');

/** What the order means for a seat that confirms or refutes findings. */
export const VERIFIER_AUTHORITY = [
  'Confirm a finding only when the spec clause behind it is legitimate under this order.',
  'Refute a finding that enforces an illegitimate clause, and give that as the reason.',
].join('\n');

/**
 * The policy block, or null when the project ships no constitution and when
 * the seat takes none. Empty policy text counts as no constitution.
 */
function constitutionBlock(seat, constitution) {
  if (typeof constitution !== 'string' || constitution.trim().length === 0) return null;
  const base = seatBase(seat);
  if (!CONSTITUTION_SEATS.has(base)) return null;
  const lines = [CONSTITUTION_HEAD, CONSTITUTION_OPEN, constitution.trim(), CONSTITUTION_CLOSE];
  if (AUTHORITY_SEATS.has(base)) lines.push(AUTHORITY_ORDER);
  // Both verifier names take it: they are one seat function, and the name says
  // which model reads the items (ADR-0005).
  if (base === 'fury-verifier' || base === 'record-verifier') lines.push(VERIFIER_AUTHORITY);
  return lines.join('\n');
}

const STYLE_HEAD = 'Binding style rules. Read each file in your worktree before you write:';

/**
 * The style block, or null where the project names no style file and where the
 * seat takes no policy text.
 *
 * A project that binds its written work to a rule set versions the rules in its
 * own repository, and the seat is told the path rather than the rules: a copy
 * of a rule set inside a prompt is a second rule set the day the first one
 * changes. The block sits with the constitution because a style file is policy
 * of the same kind, and it reaches the same seats.
 */
function styleBlock(seat, styleFiles) {
  if (!Array.isArray(styleFiles)) return null;
  const paths = styleFiles.filter((p) => typeof p === 'string' && p.trim().length > 0);
  if (paths.length === 0 || !CONSTITUTION_SEATS.has(seatBase(seat))) return null;
  return [
    STYLE_HEAD,
    ...paths.map((path) => `The rules in ${path.trim()} bind every sentence you write.`),
  ].join('\n');
}

/**
 * @param {{seat: string, def: {web: boolean, explore: number},
 *   reportPath: string, schema: object, roleBlock: string,
 *   constitution?: string|null, styleFiles?: string[]|null}} opts
 */
export function assembleSeatPrompt({
  seat,
  def,
  reportPath,
  schema,
  roleBlock,
  constitution = null,
  styleFiles = null,
}) {
  if (typeof roleBlock !== 'string' || roleBlock.length === 0) {
    throw new Error('a seat prompt requires a role block');
  }
  const web = def.web
    ? 'Web search is allowed for library and API grounding. Local sources outrank web documentation for pinned versions.'
    : 'Do not use web tools.';
  const subagents =
    def.explore > 0
      ? `You may spawn at most ${def.explore} read-only Explore subagents. Spawn no other subagents.`
      : 'Do not spawn subagents.';
  const core = [
    `You are the ${seat} seat in an Olympus run. Do only this seat's work; do not widen the scope.`,
    'Narrate one short line before each step.',
    'Do not write to any ledger file; the orchestrator records your progress and your report.',
    web,
    subagents,
    ONE_TURN_RULE,
    'File contract: as your final act, write your JSON report to this file, then stop:',
    reportPath,
    'The report must satisfy this JSON schema:',
    JSON.stringify(schema, null, 2),
    'The written report is your completion signal. Keep every free-text field extremely concise.',
  ].join('\n');
  const blocks = [core, constitutionBlock(seat, constitution), styleBlock(seat, styleFiles), roleBlock];
  return blocks.filter((block) => block !== null).join('\n\n');
}

/**
 * The prompt a seat gets when its own prompt was too long to ride the command
 * line: a pointer to the file that holds it. The file is written before the
 * spawn and lives in the run's own directory, so the brief is archived with
 * the run exactly like the report.
 *
 * The wording states the substitution rather than hiding it. A seat that is
 * told its instructions are in a file reads the file; a seat handed a bare
 * path has to guess what the path is for.
 *
 * @param {string} path absolute path to the file holding the seat's prompt
 */
export function promptFileRef(path) {
  return [
    'Your brief for this seat was too long to pass on a command line, so it was written to a file.',
    'That file is the whole of your instructions, and this message adds nothing to it.',
    'Read it first, then do exactly what it says:',
    path,
  ].join('\n');
}

/**
 * The corrective re-prompt after a failed report validation — the one retry
 * the contract allows. Sent into the same seat session where possible.
 *
 * A seat that wrote no file at all gets a different opening: the brief names
 * the missing report as the cause and restates the one-turn rule, because the
 * common way to end a turn with no report is to leave work running behind it.
 * @param {{reportPath: string, schema: object, missing?: boolean,
 *   errors: Array<{path: string, message: string}>}} opts
 */
export function correctivePrompt({ reportPath, schema, errors, missing = false }) {
  return [
    missing
      ? 'Your session ended with no report file, so nothing you did was recorded. What the check found:'
      : 'Your report did not validate. The errors:',
    ...errors.map((e) => `- ${e.path}: ${e.message}`),
    ...(missing ? [ONE_TURN_RULE] : []),
    missing
      ? `Do the work again in this turn, and write your JSON report to this file before you stop: ${reportPath}`
      : `Write a corrected JSON report to the same file, then stop: ${reportPath}`,
    'The report must satisfy this JSON schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}
