// The test-edit boundary at the tool level. Story-lane implementation seats
// (dev, adversary) are denied edits to every test path — not only the frozen
// suite — so a test change can only route through the suite seat. The rules
// ride the seat invocation as disallowed-tool entries.
//
// The freeze may exempt named files from that boundary: a spec can assign a
// test-path file to the implementing pass, and the freeze records those files
// as its exclusions (ADR-0019). A deny rule cannot carry an exception — a
// denied tool call is denied whatever else the invocation allows — so an
// exemption is expressed by narrowing the rules themselves: the entry's
// subtree is walked and every path but the exempt file is denied by name.
// Subtrees that hold no exempt file collapse back to one rule, so the narrowing
// costs rules only along the path to the exemption.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isGlobEntry, underEntry } from '../config/project.mjs';

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const GLOB_CHARS = /[*?[\]]/;

/**
 * Deny rules for every edit tool over the project's test paths. A plain
 * prefix covers its subtree (`prefix/**`); a glob entry is already a
 * complete pattern and passes through unsuffixed.
 *
 * `except` names files the boundary lets through. Narrowing needs the tree the
 * seat works in, so without `worktree` the boundary stays whole: the closed
 * rule is the conservative one, and a run that cannot narrow keeps the
 * guarantee it had.
 *
 * @param {string[]} testPaths path entries relative to the repo root
 * @param {{except?: string[], worktree?: string|null}} [opts]
 * @returns {string[]} disallowed-tool entries
 */
export function testEditDenyRules(testPaths, { except = [], worktree = null } = {}) {
  const exempt = new Set((except ?? []).map(normalize));
  const rules = [];
  for (const path of testPaths ?? []) {
    const entry = normalize(path).replace(/\/+$/, '');
    if (entry.length === 0) continue;
    const under = [...exempt].filter((file) => underEntry(file, entry));
    const patterns =
      under.length > 0 && worktree
        ? narrow(entry, under, worktree)
        : [isGlobEntry(entry) ? entry : `${entry}/**`];
    for (const pattern of patterns) {
      for (const tool of EDIT_TOOLS) rules.push(`${tool}(${pattern})`);
    }
  }
  return rules;
}

/**
 * The patterns that cover one test-path entry minus its exempt files. The walk
 * starts at the entry's base directory — for a glob entry, the fixed part
 * before its first metacharacter — and descends only where an exemption lives.
 *
 * A directory under a plain entry with no exemption inside it is denied whole.
 * Under a glob entry nothing collapses: the entry covers some files in a
 * directory and not others, and a collapsed rule would deny paths the boundary
 * never claimed.
 */
function narrow(entry, exempt, worktree) {
  const glob = isGlobEntry(entry);
  const walk = (dir) => {
    let children;
    try {
      children = readdirSync(join(worktree, dir), { withFileTypes: true });
    } catch {
      return []; // nothing there yet; nothing to deny
    }
    const patterns = [];
    for (const child of [...children].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = dir.length > 0 ? `${dir}/${child.name}` : child.name;
      if (exempt.includes(path)) continue;
      if (child.isDirectory()) {
        const inside = exempt.some((file) => file.startsWith(`${path}/`));
        if (!inside && !glob) patterns.push(`${path}/**`);
        else patterns.push(...walk(path));
      } else if (underEntry(path, entry)) {
        patterns.push(path);
      }
    }
    return patterns;
  };
  return walk(baseDir(entry));
}

/** The fixed leading directory of a path entry: everything before its first
 * metacharacter, cut at the last segment boundary. Empty means the repo root. */
function baseDir(entry) {
  if (!isGlobEntry(entry)) return entry;
  const cut = entry.lastIndexOf('/', entry.search(GLOB_CHARS));
  return cut === -1 ? '' : entry.slice(0, cut);
}

function normalize(path) {
  return String(path).replaceAll('\\', '/');
}
