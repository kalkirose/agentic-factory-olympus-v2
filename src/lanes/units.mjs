// The unit enumeration of a decision record, the identity of a unit across a
// write, the neighbourhood a record is judged beside, and the status line that
// says whether a record is still active (ADR-0026).
//
// One enumeration, in one place. The harness reads it here and a person reads
// it through `bin/olympus-units.mjs`. It is an address book: a finding names
// the unit, the head and the line of the sentence it is about, so a writer and
// a reader reach one sentence by one name (ADR-0080).
//
// The split is deterministic before it is fine-grained. Markdown holds four
// things a reader answers one at a time: a paragraph, a list item, a table row
// and a fenced block. One precedence rule decides every case the two record
// trees hold today. A list item is one unit, whatever it contains, so a fenced
// block or an indented paragraph inside an item belongs to that item. A list
// item at any depth is a unit of its own, because a nested item is a sentence
// a seat answers. Headings, blank lines, a table's header row and its rule
// line are structure, and an HTML comment is structure wherever it stands.
//
// Ids are positional, so they do not survive an edit. `matchUnits` is what
// carries a finding across a write: it matches by head text first and by line
// second, and a unit whose head changed is a moved unit whatever its number
// says.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { recordPathIncludes } from '../config/project.mjs';

/** How many words of a unit's first line stand for it. */
const HEAD_WORDS = 8;

/**
 * How many active records one record is judged beside.
 *
 * Twelve. The widest neighbourhood in the live record tree is twenty, and a
 * four-record reconciliation at that width asks its seats for eighty whole
 * record reads. The seat reads twelve whole and the brief states the count
 * above the cap, so what the cap dropped is a fact the eval reads rather than
 * a silence.
 */
export const NEIGHBOUR_CAP = 12;

/** The status words a record's status line may open with. Closed. */
export const STATUS_WORDS = Object.freeze(['accepted', 'superseded', 'retired']);

/**
 * The status line, in every form the two record trees write it: bold or plain,
 * either case, the emphasis inside the colon or around the word. It never
 * reads `**Status page:**`, because the colon has to follow the word.
 */
export const STATUS_LINE = /^\s*(\*\*)?status(\*\*)?\s*:\s*(.*)$/i;

/** The line a new record carries under its status line, in the same forms. */
export const SUPERSEDES_LINE = /^\s*(\*\*)?supersedes(\*\*)?\s*:\s*(.*)$/i;

/** A reference to a record by id, in both trees' spellings. */
const RECORD_REF = /adr-0*(\d+)/gi;

/**
 * The heading that opens the reference section, and the heading that closes it.
 *
 * The span runs from the heading to the next heading of the same level or
 * higher, or to the end of the file. A project gate over the form of a record
 * reads the section by that rule, so a bullet the gate holds to the section's
 * rule is a bullet the harness names `reference` (ADR-0073).
 */
const REFERENCES_HEADING = /^ {0,3}##\s+references\s*$/i;
const SECTION_HEADING = /^ {0,3}#{1,2}(\s|$)/;

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const TITLE = /^#\s+\S/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\S.*)?$/;
const LIST_MARKER = /^([-*+]|\d{1,9}[.)])\s+/;
const TABLE_ROW = /^\s*\|/;
const TABLE_RULE = /^\s*\|?[\s:|-]*-[\s:|-]*$/;
const COMMENT_OPEN = /^\s*<!--/;

/**
 * The ordered units of one record: the title, each line of the head block,
 * each paragraph, each list item at any depth, each table row and each
 * top-level fenced block.
 *
 * The title is `U0` and the rest run from `U1` in document order. Each unit
 * carries the line it starts on and its first eight words. A head is taken
 * after the list marker, so a renumbered list does not read as rewritten text.
 *
 * The list is a list of addresses. A finding names a unit, a head and a line,
 * and a brief lists the units so a seat and a reader name one sentence by one
 * name. No seat answers a unit and no check reads one (ADR-0080).
 *
 * Three kinds ride the list because they are the enumeration's own reading of
 * the document: `title`, `status`, and `reference` for a unit inside a
 * reference section. They name a unit more exactly in a brief; nothing refuses
 * a report on one.
 * @param {string} text
 * @returns {Array<{id: string, line: number, head: string, kind?: string}>}
 */
export function recordUnits(text) {
  const lines = splitLines(text);
  const status = statusOf(text);
  const references = referenceSpans(lines);
  const units = [];
  let next = 1;
  const add = (index, head, kind) => {
    const named = kind ?? (inSpans(references, index) ? 'reference' : undefined);
    units.push({ id: `U${next++}`, line: index + 1, head, ...(named && { kind: named }) });
  };
  const title = titleIndex(lines);
  let i = 0;
  if (title !== -1) {
    units.push({ id: 'U0', line: title + 1, head: headOf(lines[title]), kind: 'title' });
    i = title + 1;
    // The head block: status, date, deciders, related. One unit per line, so
    // the status line and the related line are each answered on their own.
    while (i < lines.length && !HEADING.test(lines[i])) {
      if (isBlank(lines[i])) {
        i++;
        continue;
      }
      if (COMMENT_OPEN.test(lines[i])) {
        i = commentEnd(lines, i);
        continue;
      }
      add(i, headOf(lines[i]), status.line === i + 1 ? 'status' : undefined);
      i++;
    }
  }
  scanBody(lines, i, add);
  return units;
}

/**
 * The lines the reference sections of one record hold, as half-open spans.
 *
 * A record may carry more than one such heading, so every one of them opens a
 * span. The heading line itself is structure and is outside its span, because a
 * heading is no unit.
 *
 * A fenced block and an HTML comment are skipped whole, as `scanBody` skips
 * both. A fence holds code and examples and a comment holds a note nobody
 * ships, so a heading inside either is text: it opens no section and ends none.
 * A record that shows the form of a reference section in a fence would
 * otherwise name every bullet under it a reference (ADR-0073).
 * @returns {Array<{from: number, to: number}>}
 */
function referenceSpans(lines) {
  const spans = [];
  let open = null;
  let i = 0;
  while (i < lines.length) {
    const fence = FENCE.exec(lines[i]);
    if (fence) {
      i = fenceEnd(lines, i, fence[2]);
      continue;
    }
    if (COMMENT_OPEN.test(lines[i])) {
      i = commentEnd(lines, i);
      continue;
    }
    if (open !== null && SECTION_HEADING.test(lines[i])) {
      spans.push({ from: open, to: i });
      open = null;
    }
    if (REFERENCES_HEADING.test(lines[i])) open = i + 1;
    i++;
  }
  if (open !== null) spans.push({ from: open, to: lines.length });
  return spans;
}

function inSpans(spans, index) {
  return spans.some((span) => index >= span.from && index < span.to);
}

/**
 * The whole text of one unit: the line it opens on, and the lines the
 * enumeration folded into it.
 *
 * A list item is one unit whatever it holds, and a record wraps its items at
 * eighty columns, so the sentence a bullet states runs over two physical lines
 * as often as one. The head is the first eight words and stands for the unit; a
 * check that asks what the unit names reads this. The fold ends where the
 * enumeration ended it: at a blank line, at a heading, or at the line the next
 * unit opens on (ADR-0073).
 * @param {string[]} lines the record's lines, as `recordUnits` split them
 * @param {Array<{line: number}>} units the enumeration, in document order
 * @param {number} index which unit
 * @returns {string}
 */
export function unitText(lines, units, index) {
  const unit = units[index];
  if (!unit) return '';
  const next = units[index + 1];
  const end = next ? Math.min(next.line - 1, lines.length) : lines.length;
  const held = [];
  for (let i = unit.line - 1; i < end; i++) {
    if (i > unit.line - 1 && (isBlank(lines[i]) || HEADING.test(lines[i]))) break;
    held.push(lines[i]);
  }
  return held.join(' ');
}

/** The body, under the precedence rule stated at the head of this module. */
function scanBody(lines, start, add) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const fence = FENCE.exec(line);
    const item = LIST_ITEM.exec(line);
    const opens =
      Boolean(fence || item) ||
      HEADING.test(line) ||
      COMMENT_OPEN.test(line) ||
      TABLE_ROW.test(line);
    // A line under the item's content indent leaves the item, and so does any
    // line that opens a block of its own. A plain line after a non-blank one
    // is the item's own paragraph, wrapped: markdown calls it a lazy
    // continuation and so does the record tree.
    const loose = i === start || isBlank(lines[i - 1]);
    while (items.length > 0 && indent < items[items.length - 1] && (loose || opens)) items.pop();
    const inside = items.length > 0;
    if (COMMENT_OPEN.test(line)) {
      i = commentEnd(lines, i);
      continue;
    }
    if (fence) {
      const end = fenceEnd(lines, i, fence[2]);
      if (!inside) add(i, fenceHead(lines, i, end));
      i = end;
      continue;
    }
    if (HEADING.test(line) && !inside) {
      i++;
      continue;
    }
    if (item) {
      add(i, headOf(item[4] ?? ''));
      items.push(item[1].length + item[2].length + item[3].length);
      i++;
      continue;
    }
    if (inside) {
      i++;
      continue;
    }
    if (TABLE_ROW.test(line)) {
      i = scanTable(lines, i, add);
      continue;
    }
    add(i, headOf(line));
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !opensBlock(lines[i])) i++;
  }
}

/** One table: the header row and the rule line are structure, each row a unit. */
function scanTable(lines, start, add) {
  let i = start;
  const headed =
    i + 1 < lines.length && TABLE_ROW.test(lines[i + 1]) && TABLE_RULE.test(lines[i + 1]);
  if (headed) i += 2;
  while (i < lines.length && TABLE_ROW.test(lines[i])) {
    add(i, headOf(lines[i]));
    i++;
  }
  return i;
}

function opensBlock(line) {
  return (
    FENCE.test(line) ||
    LIST_ITEM.test(line) ||
    HEADING.test(line) ||
    COMMENT_OPEN.test(line) ||
    TABLE_ROW.test(line)
  );
}

/** The index after a fenced block's closing fence, or the end of the file. */
function fenceEnd(lines, open, marker) {
  for (let i = open + 1; i < lines.length; i++) {
    const close = FENCE.exec(lines[i]);
    if (!close || close[2][0] !== marker[0] || close[2].length < marker.length) continue;
    if (close[3].trim() === '') return i + 1;
  }
  return lines.length;
}

/** A fenced block stands for its first line of content, not for its fence. */
function fenceHead(lines, open, end) {
  for (let i = open + 1; i < end - 1; i++) {
    if (!isBlank(lines[i])) return headOf(lines[i]);
  }
  return headOf(lines[open]);
}

/** The index after an HTML comment, which may run over several lines. */
function commentEnd(lines, open) {
  for (let i = open; i < lines.length; i++) {
    if (lines[i].includes('-->')) return i + 1;
  }
  return lines.length;
}

/** The title line, or -1 for a record whose first content is not a title. */
function titleIndex(lines) {
  let i = 0;
  while (i < lines.length) {
    if (isBlank(lines[i])) {
      i++;
      continue;
    }
    if (COMMENT_OPEN.test(lines[i])) {
      i = commentEnd(lines, i);
      continue;
    }
    return TITLE.test(lines[i]) ? i : -1;
  }
  return -1;
}

/** The first eight words of a line, after its list marker and its quote mark. */
function headOf(line) {
  const bare = String(line)
    .replace(/^\s+/, '')
    .replace(/^>\s?/, '')
    .replace(LIST_MARKER, '')
    .trim();
  return bare.split(/\s+/).filter(Boolean).slice(0, HEAD_WORDS).join(' ');
}

function isBlank(line) {
  return line.trim().length === 0;
}

function splitLines(text) {
  return String(text).replace(/\r\n/g, '\n').split('\n');
}

/**
 * Which unit of the rewritten record is which unit of the old one, and which
 * units this write moved.
 *
 * Head text decides identity, because an inserted paragraph renumbers every
 * unit after it and a finding that names a number would then name other text.
 * Line number is the second answer, so a unit the write rewrote keeps its
 * identity for a finding that was raised against it. `moved` is computed from
 * the head alone: a unit whose head changed is a unit the seat must answer
 * again, whatever the line says.
 * @param {string} before
 * @param {string} after
 * @returns {{moved: string[], map: Map<string, string>}}
 */
export function matchUnits(before, after) {
  const old = recordUnits(before);
  const now = recordUnits(after);
  const byHead = new Map();
  for (const unit of now) {
    if (!byHead.has(unit.head)) byHead.set(unit.head, []);
    byHead.get(unit.head).push(unit);
  }
  const map = new Map();
  const kept = new Set();
  for (const unit of old) {
    const queue = byHead.get(unit.head);
    if (!queue || queue.length === 0) continue;
    const match = queue.shift();
    map.set(unit.id, match.id);
    kept.add(match.id);
  }
  const taken = new Set(kept);
  for (const unit of old) {
    if (map.has(unit.id)) continue;
    const match = now.find((u) => u.line === unit.line && !taken.has(u.id));
    if (!match) continue;
    map.set(unit.id, match.id);
    taken.add(match.id);
  }
  return { moved: now.filter((u) => !kept.has(u.id)).map((u) => u.id), map };
}

/**
 * The record's status line: the word it opens with, the text after the colon,
 * and the line it stands on.
 *
 * The first line that matches wins, which is the head block's line in every
 * record of both trees. A file with no status line, and a status text that
 * opens with none of the three words, answer `null`: a record nobody marked
 * superseded is still judged, and the review's `whole` criterion names the
 * malformed line.
 * @param {string} text
 * @returns {{word: string|null, text: string|null, line: number|null}}
 */
export function statusOf(text) {
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const match = STATUS_LINE.exec(lines[i]);
    if (!match) continue;
    const status = stripEmphasis(match[3]);
    const folded = status.toLowerCase();
    const word = STATUS_WORDS.find((w) => folded.startsWith(w)) ?? null;
    return { word, text: status, line: i + 1 };
  }
  return { word: null, text: null, line: null };
}

/** The text of a `Supersedes` line, or null where the record carries none. */
export function supersedesOf(text) {
  const lines = splitLines(text);
  const status = statusOf(text);
  if (status.line === null || status.line >= lines.length) return null;
  const match = SUPERSEDES_LINE.exec(lines[status.line]);
  return match ? stripEmphasis(match[3]) : null;
}

/** A status text without the emphasis the tree wraps it in. */
function stripEmphasis(text) {
  return String(text)
    .replace(/^[\s*_]+/, '')
    .replace(/[\s*_]+$/, '')
    .trim();
}

/** True for a record no supersession and no retirement has closed. */
export function isActiveRecord(text) {
  const { word } = statusOf(text);
  return word !== 'superseded' && word !== 'retired';
}

/**
 * The one filter every list of records a seat is dispatched over goes through:
 * the records of the list the worktree still holds open, and the ones a closed
 * status line drops.
 *
 * A closed record states what was known then. No seat may edit it, so no seat
 * is asked for a unit, a finding or a report entry on one.
 *
 * Two shapes stay in the list on purpose. A file the worktree cannot read stays,
 * so a record a seat deleted still reaches a seat that reports it gone. A file
 * with no status line stays, because a record nobody marked is a record nobody
 * closed.
 *
 * The drop is never silent: `skipped` carries the status word each dropped
 * record read, and the stage stamps it beside the list it dispatched.
 * @param {string} worktree
 * @param {string[]} records
 * @returns {{records: string[], skipped: Array<{record: string, status: string}>}}
 */
export function activeOf(worktree, records = []) {
  const kept = [];
  const skipped = [];
  for (const record of records) {
    const text = readText(join(worktree ?? '', record));
    if (text === null || isActiveRecord(text)) {
      kept.push(record);
      continue;
    }
    skipped.push({ record, status: statusOf(text).word });
  }
  return { records: kept, skipped };
}

/**
 * The record id in a file name, by the leading digits after an `adr-` prefix.
 * ceq writes `adr-020-...md` and the harness writes `0026-...md`; both answer
 * the number the references carry.
 */
export function recordId(path) {
  const match = /^(?:adr[-_]?)?0*(\d+)/i.exec(basename(String(path).replaceAll('\\', '/')));
  return match ? Number(match[1]) : null;
}

/**
 * The record ids one text names. One regex over both spellings, compared by
 * number. References inside a fenced block are skipped: a fence holds code and
 * examples, and a record named there is not a record this one relies on.
 */
export function recordRefs(text) {
  const ids = new Set();
  for (const match of stripFences(text).matchAll(RECORD_REF)) ids.add(Number(match[1]));
  return ids;
}

function stripFences(text) {
  const lines = splitLines(text);
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const fence = FENCE.exec(lines[i]);
    if (fence) {
      i = fenceEnd(lines, i, fence[2]);
      continue;
    }
    kept.push(lines[i]);
    i++;
  }
  return kept.join('\n');
}

/**
 * The active records of a worktree, in path order. A superseded or retired
 * record is out of every seat's scope, so it is out of this list.
 */
export function activeRecords(worktree, recordPaths = []) {
  return recordFiles(worktree, recordPaths).filter((file) => {
    const text = readText(join(worktree, file));
    return text !== null && isActiveRecord(text);
  });
}

/** Every record file of a worktree, exclusions applied, in path order. */
export function recordFiles(worktree, recordPaths = []) {
  const roots = new Set();
  for (const entry of recordPaths) {
    if (!entry.startsWith('!')) roots.add(literalPrefix(entry));
  }
  const found = new Set();
  for (const root of roots) {
    for (const file of walk(worktree, root)) {
      if (/\.md$/i.test(file) && recordPathIncludes(file, recordPaths)) found.add(file);
    }
  }
  return [...found].sort();
}

/**
 * The active records one record is judged beside: the records it names, then
 * the active records that name it, each in id order.
 *
 * Both directions matter, and they are ranked in that order. A record this one
 * cites is one it relies on, and a record that cites this one is one this one's
 * open parts can contradict. The record's own id is out of the list, because
 * every record names itself on its first line.
 * @returns {{neighbours: string[], dropped: number}}
 */
export function recordNeighbours(worktree, record, recordPaths = []) {
  return capped(rankedNeighbours(worktree, record, recordPaths));
}

/** The same ranking, before the cap: the birth neighbourhood unions these. */
function rankedNeighbours(worktree, record, recordPaths = []) {
  const file = String(record).replaceAll('\\', '/');
  const self = recordId(file);
  const active = activeRecords(worktree, recordPaths).filter((f) => f !== file);
  const byId = new Map();
  for (const other of active) {
    const id = recordId(other);
    if (id !== null && !byId.has(id)) byId.set(id, other);
  }
  const text = readText(join(worktree, file)) ?? '';
  const cited = [...recordRefs(text)]
    .filter((id) => id !== self)
    .sort((a, b) => a - b)
    .map((id) => byId.get(id))
    .filter(Boolean);
  const named = new Set(cited);
  const citing = active.filter((other) => {
    if (named.has(other) || self === null) return false;
    return recordRefs(readText(join(worktree, other)) ?? '').has(self);
  });
  return [...cited, ...citing.sort(byRecordId)];
}

/**
 * The neighbourhood at a birth, where no record exists yet to cite anything.
 *
 * A touched path that is not a record is read by the path rule: every active
 * record whose text names that path, then the records those name. A touched
 * path that is itself a record is read by the record rule, because records cite
 * each other by id (ADR-0079). A sweep ticket names records alone, and the path
 * rule answered nothing for it.
 * @returns {{neighbours: string[], dropped: number}}
 */
export function birthNeighbours(worktree, touchedPaths = [], recordPaths = []) {
  const active = activeRecords(worktree, recordPaths);
  const paths = touchedPaths
    .map((path) => String(path).replaceAll('\\', '/'))
    .filter((path) => path.length > 0);
  const records = paths.filter((path) => recordPathIncludes(path, recordPaths));
  const others = paths.filter((path) => !recordPathIncludes(path, recordPaths));
  const byId = new Map();
  const texts = new Map();
  for (const file of active) {
    const id = recordId(file);
    if (id !== null && !byId.has(id)) byId.set(id, file);
    texts.set(file, stripFences(readText(join(worktree, file)) ?? ''));
  }
  const direct = active
    .filter((file) => others.some((path) => texts.get(file).includes(path)))
    .sort(byRecordId);
  const found = new Set(direct);
  const named = [];
  for (const file of direct) {
    for (const id of [...recordRefs(texts.get(file))].sort((a, b) => a - b)) {
      const other = byId.get(id);
      if (!other || found.has(other)) continue;
      found.add(other);
      named.push(other);
    }
  }
  // A touched path that is itself a record cites by id, and no record's text
  // holds its path, so the path rule reads nothing for it. Its neighbourhood is
  // that record's own, both directions (ADR-0079).
  const cited = [];
  for (const record of records) {
    for (const near of rankedNeighbours(worktree, record, recordPaths)) {
      if (found.has(near)) continue;
      found.add(near);
      cited.push(near);
    }
  }
  return capped([...direct, ...named, ...cited]);
}

/**
 * The active records that cite one record, minus the records this run already
 * has in scope. A record in the run's own scope is answered as itself by the
 * seat that writes it, and answering it twice asks two seats for one decision.
 * @returns {string[]}
 */
export function citingRecords(worktree, record, recordPaths = [], { scope = [] } = {}) {
  const file = String(record).replaceAll('\\', '/');
  const self = recordId(file);
  if (self === null) return [];
  const held = new Set([file, ...scope.map((p) => String(p).replaceAll('\\', '/'))]);
  return activeRecords(worktree, recordPaths)
    .filter((other) => !held.has(other))
    .filter((other) => recordRefs(readText(join(worktree, other)) ?? '').has(self))
    .sort(byRecordId);
}

/** The rank cut, and the count above it the brief states. */
function capped(ranked) {
  return {
    neighbours: ranked.slice(0, NEIGHBOUR_CAP),
    dropped: Math.max(0, ranked.length - NEIGHBOUR_CAP),
  };
}

function byRecordId(a, b) {
  const left = recordId(a);
  const right = recordId(b);
  if (left === null || right === null) return a.localeCompare(b);
  return left - right;
}

/** The part of a path entry before its first glob character. */
function literalPrefix(entry) {
  const parts = entry.replaceAll('\\', '/').split('/');
  const kept = [];
  for (const part of parts) {
    if (/[*?[\]]/.test(part)) break;
    kept.push(part);
  }
  return kept.join('/');
}

/** Repo-relative paths under one root, the repository's own directories out. */
function* walk(worktree, root) {
  const base = root.length > 0 ? join(worktree, root) : worktree;
  let entries;
  try {
    entries = readdirSync(base);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === '.git' || name === 'node_modules') continue;
    const rel = root.length > 0 ? `${root}/${name}` : name;
    let stats;
    try {
      stats = statSync(join(worktree, rel));
    } catch {
      continue;
    }
    if (stats.isDirectory()) yield* walk(worktree, rel);
    else yield rel;
  }
}

/** One file's text, or null where it cannot be read. */
export function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}
