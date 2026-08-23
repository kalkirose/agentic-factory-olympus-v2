// The spec lint: the deterministic bookend on the story spec. The spec-gate
// seat judges what the spec says; this judges the shape it says it in, and it
// runs at birth and after every amendment, before any judging seat spawns
// (ADR-0019).
//
// The shape is the point. A spec that invents a requirement invents it in
// prose, and prose is what no mechanical check ever read: the clause binds the
// suite, the implementer and the review, and nothing ever asked which card
// criterion it came from. The template answers that by construction — one
// section per card criterion, and the structured entries (test mappings,
// touched paths, supersedes) carry everything a later stage acts on. This lint
// checks the template, and only the template's structured entries. It never
// reads prose: a lint that judged sentences would be a second spec gate, and
// the spec gate is the seat's work.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { underEntry } from '../config/project.mjs';
import { parseTouchedBlock } from '../seats/diffpolicy.mjs';
import { isCriterionId, noCriteriaMessage } from './card.mjs';

/** The template's hard cap. A spec past it is a document nobody reads whole. */
export const SPEC_LINE_CAP = 400;

/** The seats a touched-paths entry may name as the owner of a file. */
export const TOUCHED_OWNERS = ['dev', 'suite'];

/**
 * The two template parts that carry no criterion id. They are compared like
 * sections because a re-check that skipped them would skip the two blocks a
 * later stage acts on: the paths the capture judges, and the variables the
 * stack must hold.
 */
const TOUCHED_PATHS_SECTION = 'touched-paths';
const ENVIRONMENT_SECTION = 'environment';

/**
 * The only two characters that make a touched-paths entry a pattern instead of
 * a path. Everything else a path may hold is a character of that path:
 * brackets, parentheses, braces and spaces all appear in real directory names,
 * and a framework whose routes are directories named `[param]` or `(group)`
 * puts them in the paths a story touches. Config path entries are globs and
 * keep their glob syntax (`isGlobEntry`); a spec entry is a literal.
 */
const GLOB_MARKERS = /[*?]/;

/**
 * What tells a path from a word. A mapping bullet opens with the repo-relative
 * path of a test file, and a path carries a directory separator or a file
 * extension. An English word carries neither, so a bullet that opens with one
 * is a bullet whose path went somewhere else. That is a shape defect, which
 * rule (i) reports, and never a path defect: no rule about paths can say one
 * true thing about the word a rewrap left at the start of a line.
 */
const PATH_TOKEN = /\/|\.[A-Za-z0-9]{1,10}$/;

const HEADING = /^#{1,6}\s+(.*\S)\s*$/;
const ENVIRONMENT_HEADING = /^environment\b/i;
const TOUCHED_FENCE = /^```touched-paths\b/;
const FENCE = /^```/;
const LIST_ITEM = /^\s*[-*]\s+(.*\S)\s*$/;
const TEST_MAPPING_LABEL = /^\**\s*test mapping\b/i;
const SUPERSEDES_LABEL = /^\**\s*supersedes\b/i;
const NONE = /^none\.?$/i;

/**
 * Lints a born or amended story spec against the template.
 *
 * @param {string} specText
 * @param {{card: object, cardPath: string|null, worktree: string, testPaths: string[],
 *   tier: object|null, baseFiles: string[]|null}} ctx `tier` is the lane's diff
 *   policy, or null when the project declares none; `cardPath` names the card in
 *   rule (a)'s messages; `baseFiles` is the supersede targets that exist at the
 *   spec's base sha, or null when the base sha is unknown.
 * @returns {string[]} one message per defect, in rule order; empty means clean
 */
export function lintSpec(
  specText,
  { card, cardPath = null, worktree, testPaths = [], tier = null, baseFiles = null },
) {
  const text = typeof specText === 'string' ? specText : '';
  const lines = text.split(/\r?\n/);
  const criteria = card?.acceptance ?? [];
  const sections = specSections(lines, new Set(criteria.map((c) => c.id)));
  const block = parseTouchedBlock(text);
  const defects = [];

  // (a) one section per card criterion, in card order, none missing, none extra.
  defects.push(...criterionDefects(card, sections, cardPath));

  // (b) the hard cap.
  const count = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (count > SPEC_LINE_CAP) {
    defects.push(`the spec runs ${count} lines; the template caps it at ${SPEC_LINE_CAP}.`);
  }

  // (c) the touched-paths block parses, and every entry is clean.
  defects.push(...blockDefects(block));

  const mappings = sections.flatMap((s) => s.testMappings.map((m) => ({ ...m, id: s.id })));
  const supersedes = sections.flatMap((s) => s.supersedes.map((m) => ({ ...m, id: s.id })));
  const declared = new Set(block.entries.map((e) => e.path));

  // (d) a declared-tier path the spec plans to touch belongs in the block.
  const declarable = tier?.declaredPaths ?? [];
  const planned = [
    ...mappings.map((m) => m.path),
    ...supersedes.filter((s) => s.disposition === 'supersede').map((s) => s.path),
  ];
  for (const path of unique(planned)) {
    const entry = declarable.find((e) => underEntry(path, e));
    if (entry && !declared.has(path)) {
      defects.push(
        `the spec plans to touch ${path}, which the diff policy admits only when the spec ` +
          `declares it (declaredPaths: ${entry}), and the touched-paths block does not list it.`,
      );
    }
  }

  // (e) every planned test file sits under an acceptance test path.
  for (const mapping of mappings) {
    if (!testPaths.some((entry) => underEntry(mapping.path, entry))) {
      defects.push(
        `the test mapping of ${mapping.id} names ${mapping.path}, which is not under an ` +
          `acceptance test path (${testPaths.join(', ') || 'none configured'}); the suite ` +
          'command would never run it.',
      );
    }
  }

  // (f) every superseded test existed where the clause was written.
  //
  // A Supersedes clause is a statement about the tree the spec was born on, and
  // the worktree it is linted in is not that tree. The candidate's own work
  // deletes the file a criterion supersedes — that deletion IS the supersede —
  // and a rule that read only the worktree called the seat's correct clause a
  // defect, parked the run and cost an owner touch. So the clause resolves
  // against the base sha as well: a target the run itself deleted is satisfied,
  // and a target that existed at neither sha is still the defect this rule was
  // written for. A lint with no base sha to read reads the worktree alone,
  // which is where the rule started.
  const atBase = baseFiles === null ? null : new Set(baseFiles);
  for (const entry of supersedes) {
    if (existsSync(join(worktree, entry.path))) continue;
    if (atBase?.has(entry.path)) continue;
    defects.push(
      `${entry.id} supersedes ${entry.path}; no such file exists in the worktree` +
        (atBase ? " or at the spec's base sha." : '.'),
    );
  }

  // (g) a dev-owned test-path entry names one file.
  for (const entry of block.entries) {
    if (entry.owner !== 'dev' || !testPaths.some((e) => underEntry(entry.path, e))) continue;
    const defect = notOneFile(entry, worktree);
    if (defect) {
      defects.push(
        `the touched-paths entry ${entry.raw} is owned by dev and sits under a test path, ` +
          `so it must name one file: ${defect}. The freeze exempts files, never directories.`,
      );
    }
  }

  // (h) no structured entry names a forbidden path shape.
  const forbidden = tier?.forbiddenPatterns ?? [];
  for (const path of unique([...block.entries.map((e) => e.path), ...mappings.map((m) => m.path)])) {
    const pattern = forbidden.find((p) => new RegExp(p).test(path));
    if (pattern) {
      defects.push(
        `${path} matches a path shape the diff policy forbids (forbiddenPatterns: ${pattern}); ` +
          'no run ships it, so no spec may plan it.',
      );
    }
  }

  // (i) every mapping is one bullet on one line, path first.
  const rewrapped = sections.filter((s) => s.rewrapped.length > 0);
  if (rewrapped.length > 0) {
    const places = rewrapped.map(
      (s) =>
        `${s.id} ${s.rewrapped.length === 1 ? 'line' : 'lines'} ${s.rewrapped.join(', ')}`,
    );
    defects.push(
      `the test mapping is rewrapped or malformed at ${places.join('; ')}: a mapping is one ` +
        'bullet on one line, the test path first, then " — ", then the behavior the test ' +
        'asserts. A mapping never wraps across lines and never carries a nested list; meet the ' +
        `${SPEC_LINE_CAP}-line cap with shorter prose instead.`,
    );
  }
  return defects;
}

/**
 * Every path a spec's Supersedes clauses name, deduplicated. The caller reads
 * them out of the spec to ask git which ones existed at the spec's base sha,
 * and hands the answer back as `baseFiles`. Naming them here keeps one parser
 * for the clause: a caller that re-read the document with its own regex would
 * be a second reading of the same lines, free to disagree with rule (f).
 *
 * @param {string} specText
 * @param {{card: object}} ctx
 * @returns {string[]}
 */
export function supersedeTargets(specText, { card }) {
  const lines = String(specText ?? '').split(/\r?\n/);
  const known = new Set((card?.acceptance ?? []).map((c) => c.id));
  return unique(specSections(lines, known).flatMap((s) => s.supersedes.map((m) => m.path)));
}

/**
 * The files the freeze exempts from the test-edit boundary: every touched-paths
 * entry the implementing seat owns that sits under a test path. Everything
 * else under those paths is the frozen suite.
 * @param {string} specText
 * @param {string[]} testPaths
 * @returns {string[]}
 */
export function frozenExclusions(specText, testPaths = []) {
  return unique(
    parseTouchedBlock(specText)
      .entries.filter(
        (entry) => entry.owner === 'dev' && testPaths.some((e) => underEntry(entry.path, e)),
      )
      .map((entry) => entry.path),
  );
}

// -- the amended set ---------------------------------------------------------

/**
 * The template parts whose text moved between two versions of one spec. The
 * spec gate scopes every re-check with it, so the scope is derived from the
 * two documents rather than declared by the seat that edited one of them.
 *
 * A part is a criterion section, the touched-paths block, or the environment
 * section. A part that only one version carries counts as moved. Comparison
 * ignores blank lines and end-of-line whitespace: an amendment that reflows a
 * paragraph changed the section, one that re-indents it did not.
 *
 * @param {string} priorText the spec as the previous round judged it
 * @param {string} currentText the spec as it stands
 * @param {{card: object}} ctx
 * @returns {string[]} part names, in card order, then touched-paths, then
 *   environment
 */
export function amendedSections(priorText, currentText, { card }) {
  const ids = (card?.acceptance ?? []).map((c) => c.id);
  const known = new Set(ids);
  const before = specParts(priorText, known);
  const after = specParts(currentText, known);
  const order = [...ids, TOUCHED_PATHS_SECTION, ENVIRONMENT_SECTION];
  const rank = (name) => {
    const at = order.indexOf(name);
    return at === -1 ? order.length : at;
  };
  return unique([...before.keys(), ...after.keys()])
    .filter((name) => before.get(name) !== after.get(name))
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * One spec as a map of part name to normalized text. The criterion-section
 * rule is the lint's own (see `specSections`); the touched-paths block is read
 * from its fence wherever it sits, so a block nested under a criterion heading
 * still compares as itself.
 */
function specParts(specText, known) {
  const lines = String(specText ?? '').split(/\r?\n/);
  const parts = new Map();
  const push = (name, line) => {
    const text = line.trim();
    if (text.length === 0) return;
    if (!parts.has(name)) parts.set(name, []);
    parts.get(name).push(text);
  };
  let current = null;
  let headings = 0;
  let fenced = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (fenced) {
      if (FENCE.test(trimmed)) fenced = false;
      else push(TOUCHED_PATHS_SECTION, line);
      continue;
    }
    if (TOUCHED_FENCE.test(trimmed)) {
      // An empty block is a part that exists; a missing block is not.
      if (!parts.has(TOUCHED_PATHS_SECTION)) parts.set(TOUCHED_PATHS_SECTION, []);
      fenced = true;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const title = heading[1];
      const id = title.split(/\s+/)[0].replace(/^[`*]+/, '').replace(/[`*:.]+$/, '');
      headings++;
      if (isCriterionId(id) && (headings > 1 || known.has(id))) current = id;
      else if (ENVIRONMENT_HEADING.test(title)) current = ENVIRONMENT_SECTION;
      else current = null;
      continue;
    }
    if (current) push(current, line);
  }
  return new Map([...parts].map(([name, body]) => [name, body.join('\n')]));
}

// -- rule (a) ----------------------------------------------------------------

function criterionDefects(card, sections, cardPath = null) {
  const defects = [];
  const criteria = card?.acceptance ?? [];
  // An empty criterion set is nothing to compare a spec against. Every section
  // would answer no criterion and the expected-id list would render empty, so
  // the rule says the one true thing instead: the card yielded no criterion.
  // The lane parks that state stage-blocked, because no seat can fix a parse.
  if (criteria.length === 0) return [noCriteriaMessage(cardPath)];
  const ids = criteria.map((c) => c.id);
  const known = new Set(ids);
  const found = sections.map((s) => s.id);
  // A section title is the card's id, and a seat that renumbers positionally
  // fails every criterion at once. So the message that names a wrong title
  // names the right ones: the list is the card's own data, read at runtime.
  const expectedList = `expected sections, in card order: ${ids.join(', ')}`;
  for (const id of ids) {
    const n = found.filter((f) => f === id).length;
    if (n === 0) {
      defects.push(
        `the spec has no section for acceptance criterion ${id}; the template takes one ` +
          `section per card criterion, titled with its id — ${expectedList}.`,
      );
    } else if (n > 1) {
      defects.push(`the spec has ${n} sections titled ${id}; the template takes exactly one.`);
    }
  }
  for (const id of unique(found)) {
    if (!known.has(id)) {
      defects.push(
        `section ${id} answers no acceptance criterion on the card; the card defines what ` +
          `ships, so a requirement with no criterion behind it is a defect — ${expectedList}.`,
      );
    }
  }
  const ordered = unique(found).filter((id) => known.has(id));
  const expected = ids.filter((id) => ordered.includes(id));
  if (ordered.join(' ') !== expected.join(' ')) {
    defects.push(
      `the spec orders its criterion sections ${ordered.join(', ')}; the card orders them ` +
        `${expected.join(', ')}.`,
    );
  }
  return defects;
}

// -- rule (c) ----------------------------------------------------------------

function blockDefects({ entries, blocks, unterminated }) {
  const defects = [];
  if (unterminated) {
    defects.push(
      'the touched-paths block is never closed by a fence, so it declares nothing.',
    );
  }
  if (blocks === 0 && !unterminated) {
    defects.push('the spec declares no ```touched-paths block; the template takes exactly one.');
  }
  if (blocks > 1) {
    defects.push(`the spec declares ${blocks} touched-paths blocks; the template takes exactly one.`);
  }
  if (blocks === 1 && entries.length === 0) {
    defects.push('the touched-paths block lists no path.');
  }
  for (const entry of entries) {
    const defect = pathDefect(entry.raw);
    if (defect) defects.push(`the touched-paths entry ${entry.raw} ${defect}`);
    if (entry.owner === null) {
      defects.push(
        `the touched-paths entry ${entry.raw} names no owner; every path takes ` +
          `" — dev" or " — suite".`,
      );
    } else if (!TOUCHED_OWNERS.includes(entry.owner)) {
      defects.push(
        `the touched-paths entry ${entry.raw} names the owner "${entry.owner}"; the owner ` +
          `is one of ${TOUCHED_OWNERS.join(' | ')}.`,
      );
    }
  }
  return defects;
}

function pathDefect(raw) {
  if (/^([A-Za-z]:)?[\\/]/.test(raw)) return 'is not relative to the repository root.';
  if (raw.includes('\\')) return 'carries a backslash; paths are written with forward slashes.';
  const segments = raw.split('/');
  if (segments.includes('..')) return 'walks out of the repository with "..".';
  if (segments.includes('.')) {
    return 'carries a "." segment; a path entry is written from the repository root.';
  }
  if (raw.endsWith('/')) return 'ends in a slash; a path entry names a file.';
  if (GLOB_MARKERS.test(raw)) return 'is a glob; a path entry names one file.';
  return null;
}

// -- rule (g) ----------------------------------------------------------------

function notOneFile(entry, worktree) {
  if (GLOB_MARKERS.test(entry.raw)) return 'it is a glob';
  if (entry.raw.endsWith('/')) return 'it ends in a slash';
  const full = join(worktree, entry.path);
  if (existsSync(full) && statSync(full).isDirectory()) return 'it names a directory in the worktree';
  // An entry with nothing at it yet is a file the story will create. Judging
  // that by the file name would read a naming convention, and the worktree is
  // the only thing here that knows a directory from a file.
  return null;
}

// -- spec structure ----------------------------------------------------------

/**
 * The spec's criterion sections. A section is a heading whose first title token
 * has the shape of a criterion id; its body runs to the next heading. The
 * structured entries inside it are read from their labels, and nothing else in
 * the body is read at all.
 *
 * The document's title is the one exception. A card key has the shape of a
 * criterion id, the template's header names the card key, and a title is not a
 * section — so the first heading counts only when it names a criterion the card
 * actually carries.
 */
function specSections(lines, known) {
  const sections = [];
  let current = null;
  let headings = 0;
  for (const [index, line] of lines.entries()) {
    const heading = HEADING.exec(line);
    if (heading) {
      const id = heading[1].split(/\s+/)[0].replace(/^[`*]+/, '').replace(/[`*:.]+$/, '');
      headings++;
      const section = isCriterionId(id) && (headings > 1 || known.has(id));
      current = section ? { id, body: [] } : null;
      if (current) sections.push(current);
      continue;
    }
    if (current) current.body.push({ text: line, line: index + 1 });
  }
  return sections.map((section) => {
    const mapping = labelledItems(section.body, TEST_MAPPING_LABEL);
    const read = mapping.items.map((item) => ({ ...testMapping(item.text), line: item.line }));
    return {
      id: section.id,
      testMappings: read.filter(isMapping),
      // A bullet the mapping shape does not fit says nothing about a path, so
      // it never reaches rules (d), (e) and (h). Its line joins rule (i).
      rewrapped: unique([...mapping.broken, ...read.filter((m) => !isMapping(m)).map((m) => m.line)])
        .sort((a, b) => a - b),
      supersedes: labelledItems(section.body, SUPERSEDES_LABEL)
        .items.map((item) => supersede(item.text))
        .filter(Boolean),
    };
  });
}

/**
 * The list items that follow a label line, up to the first line that is
 * neither blank nor an item.
 *
 * An item is one bullet on one line at the list's own indent. A line indented
 * past that bullet is the bullet's wrapped tail or a list nested under it, and
 * either one broke the shape the template states: the list stays open — the
 * bullets after it are still items — and the bullet the line belongs to is
 * reported once.
 *
 * @returns {{items: {text: string, line: number}[], broken: number[]}} `broken`
 *   holds the line of each bullet whose shape the list lost.
 */
function labelledItems(body, label) {
  const items = [];
  const broken = [];
  let inside = false;
  let indent = null;
  let bullet = null;
  for (const { text, line } of body) {
    if (label.test(text.trim())) {
      inside = true;
      indent = null;
      bullet = null;
      continue;
    }
    if (!inside) continue;
    const width = text.length - text.trimStart().length;
    const item = LIST_ITEM.exec(text);
    if (item) {
      if (indent === null) indent = width;
      if (width > indent) broken.push(bullet ?? line);
      else {
        bullet = line;
        items.push({ text: item[1], line });
      }
      continue;
    }
    // A blank line inside a list is still the list; prose after it is not.
    if (text.trim().length === 0) continue;
    if (indent !== null && width > indent) {
      broken.push(bullet ?? line);
      continue;
    }
    inside = false;
    indent = null;
    bullet = null;
  }
  return { items, broken };
}

/**
 * A mapping the lint can read: the first token is a path, and a behavior
 * follows it. A bullet that fails either one is a bullet whose mapping was
 * rewrapped away from it.
 */
function isMapping(mapping) {
  return PATH_TOKEN.test(mapping.path) && mapping.behavior.length > 0;
}

/** `<path> — <the behavior the test asserts>`. */
function testMapping(item) {
  const [first, ...rest] = item.split(/\s+/);
  return { path: cleanPath(first), behavior: rest.join(' ').replace(/^[—–-]\s*/, '') };
}

/** `<path> — keep | supersede — <replacement clause>`, or "None". */
function supersede(item) {
  if (NONE.test(item)) return null;
  const fields = item.split(/\s+[—–-]\s+/);
  const [first, ...rest] = fields[0].split(/\s+/);
  const disposition = (fields[1] ?? rest.join(' ')).trim().toLowerCase();
  return { path: cleanPath(first), disposition };
}

function cleanPath(token) {
  return token.replace(/^[`'"(]+/, '').replace(/[`'",.;)]+$/, '').replaceAll('\\', '/');
}

function unique(values) {
  return [...new Set(values)];
}
