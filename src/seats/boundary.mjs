// The test-edit boundary at the tool level. Story-lane implementation seats
// (dev, adversary) are denied edits to every test path — not only the frozen
// suite — so a test change can only route through the suite seat. The rules
// ride the seat invocation as disallowed-tool entries.
import { isGlobEntry } from '../config/project.mjs';

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/**
 * Deny rules for every edit tool over the project's test paths. A plain
 * prefix covers its subtree (`prefix/**`); a glob entry is already a
 * complete pattern and passes through unsuffixed.
 * @param {string[]} testPaths path entries relative to the repo root
 * @returns {string[]} disallowed-tool entries
 */
export function testEditDenyRules(testPaths) {
  const rules = [];
  for (const path of testPaths ?? []) {
    if (isGlobEntry(path)) {
      for (const tool of EDIT_TOOLS) rules.push(`${tool}(${path})`);
      continue;
    }
    const prefix = path.replace(/[\\/]+$/, '');
    if (prefix.length === 0) continue;
    for (const tool of EDIT_TOOLS) rules.push(`${tool}(${prefix}/**)`);
  }
  return rules;
}
