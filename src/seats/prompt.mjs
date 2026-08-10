// Two-block prompt assembly. Block one is the shared core: role line, scope
// discipline, narration cadence, tool policy, and the file contract with the
// named report path and schema. Block two is the per-seat role block —
// judgment criteria plus dispatch context, supplied by the lane. No
// verification scaffolding, no forced progress summaries, no reasoning-echo
// asks enter here or in any role block.

/**
 * @param {{seat: string, def: {web: boolean, explore: number},
 *   reportPath: string, schema: object, roleBlock: string}} opts
 */
export function assembleSeatPrompt({ seat, def, reportPath, schema, roleBlock }) {
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
    'File contract: as your final act, write your JSON report to this file, then stop:',
    reportPath,
    'The report must satisfy this JSON schema:',
    JSON.stringify(schema, null, 2),
    'The written report is your completion signal. Keep every free-text field extremely concise.',
  ].join('\n');
  return `${core}\n\n${roleBlock}`;
}

/**
 * The corrective re-prompt after a failed report validation — the one retry
 * the contract allows. Sent into the same seat session where possible.
 */
export function correctivePrompt({ reportPath, schema, errors }) {
  return [
    'Your report did not validate. The errors:',
    ...errors.map((e) => `- ${e.path}: ${e.message}`),
    `Write a corrected JSON report to the same file, then stop: ${reportPath}`,
    'The report must satisfy this JSON schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}
