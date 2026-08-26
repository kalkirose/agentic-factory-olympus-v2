// Two-block prompt assembly. Block one is the shared core: role line, scope
// discipline, narration cadence, tool policy, the one-turn execution rule, and
// the file contract with the named report path and schema. Block two is the
// per-seat role block — judgment criteria plus dispatch context, supplied by
// the lane. No verification scaffolding, no forced progress summaries, no
// reasoning-echo asks enter here or in any role block.
//
// A third block sits between them when the project ships a constitution: the
// policy text as its own delimited block, plus the authority order for the
// seats that judge. The seat sets below are closed like the seat map. A
// project with no constitution file gets no third block, and its prompts are
// byte for byte what they were.

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
  'generalist-review',
]);

/**
 * The judging seats. Each one weighs the tree against a document, so each one
 * needs to know which document wins when two of them disagree.
 */
export const AUTHORITY_SEATS = new Set([
  'spec-gate',
  'fury-spec',
  'fury-code-shape',
  'fury-operational',
  'fury-interface',
  'fury-verifier',
  'generalist-review',
  'verdict-triage',
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
  if (!CONSTITUTION_SEATS.has(seat)) return null;
  const lines = [CONSTITUTION_HEAD, CONSTITUTION_OPEN, constitution.trim(), CONSTITUTION_CLOSE];
  if (AUTHORITY_SEATS.has(seat)) lines.push(AUTHORITY_ORDER);
  if (seat === 'fury-verifier') lines.push(VERIFIER_AUTHORITY);
  return lines.join('\n');
}

/**
 * @param {{seat: string, def: {web: boolean, explore: number},
 *   reportPath: string, schema: object, roleBlock: string,
 *   constitution?: string|null}} opts
 */
export function assembleSeatPrompt({ seat, def, reportPath, schema, roleBlock, constitution = null }) {
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
  const policy = constitutionBlock(seat, constitution);
  return policy ? `${core}\n\n${policy}\n\n${roleBlock}` : `${core}\n\n${roleBlock}`;
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
