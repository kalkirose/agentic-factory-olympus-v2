// The edit boundary at the tool level. An implementation seat is denied edits
// to every test path — not only the frozen suite — so a test change can only
// route through the suite seat, and to every record path, so a decision
// record is written by a record seat and by nothing else (ADR-0074).
// The rules ride the seat invocation as disallowed-tool entries.
//
// A record-path entry may be an exclusion, `!<path>`, which names a file that
// is not a record. An exclusion is not a deny rule: the file it names is
// already covered by the entry it was carved out of, and denying it twice would
// say the boundary claims a file the record tree does not.
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
 * Deny rules for every edit tool over the project's test paths and record
 * paths. A plain prefix covers its subtree (`prefix/**`); a glob entry is
 * already a complete pattern and passes through unsuffixed; an `!` exclusion
 * entry is skipped. The test paths come first, and a path both lists name is
 * denied once.
 *
 * `except` names files the boundary lets through. Narrowing needs the tree the
 * seat works in, so without `worktree` the boundary stays whole: the closed
 * rule is the conservative one, and a run that cannot narrow keeps the
 * guarantee it had.
 *
 * @param {{testPaths?: string[], recordPaths?: string[], except?: string[],
 *   worktree?: string|null}} opts path entries relative to the repo root
 * @returns {string[]} disallowed-tool entries
 */
export function editDenyRules({ testPaths = [], recordPaths = [], except = [], worktree = null } = {}) {
  const exempt = new Set((except ?? []).map(normalize));
  const seen = new Set();
  const rules = [];
  for (const path of [...(testPaths ?? []), ...(recordPaths ?? [])]) {
    const entry = normalize(path).replace(/\/+$/, '');
    if (entry.length === 0 || entry.startsWith('!')) continue;
    const under = [...exempt].filter((file) => underEntry(file, entry));
    const patterns =
      under.length > 0 && worktree
        ? narrow(entry, under, worktree)
        : [isGlobEntry(entry) ? entry : `${entry}/**`];
    for (const pattern of patterns) {
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      for (const tool of EDIT_TOOLS) rules.push(`${tool}(${pattern})`);
    }
  }
  return rules;
}

/**
 * The test half of the boundary, by its old positional call. Every site that
 * denies the test paths alone still reads this, and it is the same rules it
 * always was.
 * @param {string[]} testPaths
 * @param {{except?: string[], worktree?: string|null}} [opts]
 */
export function testEditDenyRules(testPaths, opts = {}) {
  return editDenyRules({ ...opts, testPaths: testPaths ?? [] });
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
