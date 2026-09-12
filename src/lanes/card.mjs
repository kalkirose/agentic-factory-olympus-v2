// Intent-card parsing. A card is the roadmap artifact for one story: YAML
// frontmatter (key, title, blocked-by, phase) plus markdown sections. The
// harness reads only what readiness, the frontier and the spec lint need —
// the key, the edges, the phase, the open decisions, the foreseen amendments,
// the named dependencies, and the acceptance criteria. Everything else is
// seat-facing prose.
//
// This is the harness's only card parser: readiness, the daemon's card sweep,
// the frontier's graph source and the spec lint all read a card through
// `parseIntentCard`, so a card reads the same everywhere it is read. It is
// also the one computer of a card's closure, for the same reason.
import { readFileSync, readdirSync } from 'node:fs';

/** The acceptance section's heading: any level, matched without case. */
const ACCEPTANCE_HEADING = /acceptance/i;

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const LIST_ITEM = /^\s*[-*+]\s+(.*)$/;
const NONE = /^none\.?$/i;

/**
 * The heading a card carries its foreseen amendments under, and the lead token
 * every one of those notes opens with.
 *
 * A foreseen amendment states a settled consequence, never a question. A
 * close-out sweep writes one when a card's own acceptance criteria already
 * mandate a behavior that collides with a suite an earlier story froze: the
 * pinned clause, the file it lives in, and the card line that mandates the
 * change. Nothing is left for a human to settle, so nothing may park on it.
 *
 * The marker is what makes that mechanical. The heading keeps the notes out of
 * the decisions section by structure, and the marker keeps them out of it by
 * content, so a note written under the wrong heading still parks nothing.
 */
export const FORESEEN_HEADING = 'Foreseen amendments';
export const FORESEEN_MARKER = 'Foreseen amendment:';

/** The heading pattern the foreseen section is read by. */
export const FORESEEN_SECTION = /foreseen amendments/i;

/**
 * The heading a card names its dependencies under, and the shape of one line
 * beneath it: `- <importer>: <name>`. The importer is the workspace key the
 * lockfile spells (`.`, `apps/storefront`), so the root has a spelling; the
 * name is the package, never a version, because the card states which package
 * the story may add and the lockfile states which version it resolved to.
 */
export const DEPENDENCIES_SECTION = /dependencies/i;

const EMPHASIS = /^[`*_]+/;

/**
 * Whether a card line is a foreseen-amendment note. Markdown emphasis around
 * the lead token is stripped first: a card writes the marker in bold as readily
 * as it writes it plain, and both are the same note.
 * @param {string} item
 */
export function isForeseenNote(item) {
  if (typeof item !== 'string') return false;
  const lead = item.trimStart().replace(EMPHASIS, '').toLowerCase();
  return lead.startsWith(FORESEEN_MARKER.toLowerCase());
}

/**
 * An acceptance-criterion id: an identifier that carries a digit. The digit is
 * what separates a labelled criterion from one written as prose, so a
 * criterion that opens with an ordinary word is never read as a label.
 * @param {string} token
 */
export function isCriterionId(token) {
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(token) && /\d/.test(token);
}

/**
 * The one message a card that yields no criterion raises. It names the card
 * and the heading the parse read, because the two candidates are a card that
 * labels nothing and a parser that cannot read the labels it carries — and
 * neither is a defect of the spec.
 * @param {string|null} cardPath
 */
export function noCriteriaMessage(cardPath) {
  return (
    `the intent card at ${cardPath ?? '(no path recorded)'} yields no acceptance criterion: ` +
    `no line under its acceptance heading (any level, matched without case against ` +
    `/${ACCEPTANCE_HEADING.source}/) opens with a criterion id. A criterion line is written ` +
    '"**AC-1** text", "AC-1 text", "AC-1: text", "- AC-1 text", or "### AC-1". A spec cannot ' +
    'answer an empty set, so this is a defect of the card or of the parser, never of the spec.'
  );
}

/**
 * Parses an intent card. Returns `{card, errors}`; a non-empty errors list
 * means the card fails readiness.
 * @param {string} text
 */
export function parseIntentCard(text) {
  const errors = [];
  const { fields, body, found } = splitFrontmatter(text);
  if (!found) errors.push('card has no frontmatter block');
  const key = fields.key ?? null;
  if (found && !key) errors.push('frontmatter names no key');
  const dependencies = cardDependencies(body);
  errors.push(...dependencies.errors);
  const card = {
    key,
    title: fields.title ?? null,
    blockedBy: parseList(fields['blocked-by']),
    // Phase membership for the launch gate; absent = the first phase.
    phase: fields.phase ?? null,
    // The questions a launch waits on, and never the notes. A foreseen
    // amendment is an answer the card already gave, so it is filtered out of
    // the set the launch gate parks on and published on its own instead.
    openDecisions: sectionItems(body, /open decisions/i).filter((d) => !isForeseenNote(d)),
    foreseenAmendments: sectionItems(body, FORESEEN_SECTION),
    // The packages this story may add, and the only packages it may add. A
    // card that names none leaves the lockfile shut.
    dependencies: dependencies.entries,
    acceptance: acceptanceCriteria(body),
  };
  return { card, errors };
}

/**
 * The cards a launch is judged on: the launched card, then every card it is
 * blocked by, transitively, that has not shipped. The walk stops at a shipped
 * key, because a shipped card is settled and so is everything behind it.
 *
 * The shipped set is a parameter. Which keys shipped is run history, which the
 * frontier owns; a closure computed in two places is two closures.
 *
 * A key that resolves to no card file adds no path. That edge is a card
 * defect, and the readers that own it report it: the frontier admits no card
 * with an unknown blocker, and a corpus-wide card lint reads the edge against
 * the launched card, which every caller of this names.
 *
 * A returned path is spelled off `cardsDir` with a forward slash, so a path
 * that rides a command line reads the same on every platform; the launched
 * card keeps the spelling the caller passed.
 *
 * @param {string} cardsDir the directory the card files live in
 * @param {string} cardPath the launched card, readable as it is passed
 * @param {{shipped?: Set<string>}} [options] shipped card keys
 * @returns {string[]} each card once, breadth-first over `blocked-by`
 */
export function cardClosure(cardsDir, cardPath, { shipped = new Set() } = {}) {
  const launched = parseIntentCard(readFileSync(cardPath, 'utf8')).card;
  const byKey = cardsByKey(cardsDir);
  const closure = [cardPath];
  const seen = new Set(launched.key === null ? [] : [launched.key]);
  const queue = [...launched.blockedBy];
  while (queue.length > 0) {
    const key = queue.shift();
    if (seen.has(key) || shipped.has(key)) continue;
    seen.add(key);
    const blocker = byKey.get(key);
    if (!blocker) continue;
    closure.push(blocker.path);
    queue.push(...blocker.blockedBy);
  }
  return closure;
}

/**
 * Every card in the directory by key, each file read once. A key two cards
 * claim resolves to the first in name order: a duplicate key is a defect the
 * frontier and the card lint both refuse, and the closure adds no second
 * verdict on it.
 */
function cardsByKey(cardsDir) {
  const dir = cardsDir.replace(/[\\/]+$/, '');
  const byKey = new Map();
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    const path = `${dir}/${name}`;
    const { card } = parseIntentCard(readFileSync(path, 'utf8'));
    if (card.key === null || byKey.has(card.key)) continue;
    byKey.set(card.key, { path, blockedBy: card.blockedBy });
  }
  return byKey;
}

/**
 * The dependency lines of a card, and the lines that state nothing readable.
 * A line the parser cannot read is an error and not an omission: the section
 * is the story's whole permission to touch the lockfile, so a line it drops in
 * silence is a package the capture would refuse later and further from the
 * card.
 * @returns {{entries: {importer: string, name: string}[], errors: string[]}}
 */
function cardDependencies(body) {
  const entries = [];
  const errors = [];
  for (const item of sectionItems(body, DEPENDENCIES_SECTION)) {
    const entry = dependencyOf(item);
    if (entry) entries.push(entry);
    else errors.push(`dependency line does not read "<importer>: <name>": ${item}`);
  }
  return { entries, errors };
}

/** One dependency line as `{importer, name}`, or null when it is not one. */
function dependencyOf(item) {
  const split = item.indexOf(':');
  if (split === -1) return null;
  const importer = unwrapped(item.slice(0, split));
  const name = unwrapped(item.slice(split + 1));
  if (importer.length === 0 || name.length === 0) return null;
  // One package per line, and the name alone: a token with a space in it is a
  // version range, a comment, or a second package, and the card means none of
  // the three.
  if (/\s/.test(importer) || /\s/.test(name)) return null;
  return { importer, name };
}

/** A token without the markdown a writer wraps a path or a package name in. */
function unwrapped(token) {
  return token.trim().replace(/^[`*]+/, '').replace(/[`*]+$/, '');
}

/**
 * The prose of every section whose heading matches `pattern`, in card order. A
 * section runs to the next heading of its own level or shallower, so a deeper
 * sub-heading stays inside it.
 *
 * Every other reader here wants a list or a label. This one wants the sentences
 * a human wrote, because a supersede authorization rests on a line of the card
 * and the check that the line is really there reads the section it claims to
 * come from (ADR-0044). It lives with the parser for the reason the file says:
 * a card reads the same everywhere it is read.
 * @param {string} text the whole card, frontmatter included
 * @param {RegExp} pattern matched against the heading text
 * @returns {string[]} one entry per matching section; empty when there is none
 */
export function cardSections(text, pattern) {
  const { body } = splitFrontmatter(text);
  const lines = body.split(/\r?\n/);
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = HEADING.exec(lines[i]);
    if (!heading || !pattern.test(heading[2])) continue;
    const level = heading[1].length;
    const section = [];
    for (const line of lines.slice(i + 1)) {
      const next = HEADING.exec(line);
      if (next && next[1].length <= level) break;
      section.push(line);
    }
    sections.push(section.join('\n'));
  }
  return sections;
}

/**
 * The card's acceptance criteria, in card order. A criterion carries its own
 * id when the line it opens starts with one, and takes its position as its id
 * when the card labels nothing. Every card therefore names an ordered id set,
 * which is the set the spec must mirror section for section.
 * @returns {{id: string, text: string}[]}
 */
function acceptanceCriteria(body) {
  const criteria = [];
  for (const line of acceptanceLines(body)) {
    const criterion = criterionOf(line, criteria.length);
    if (criterion) criteria.push(criterion);
  }
  return criteria;
}

/**
 * The lines under the acceptance heading. Cards write their criteria as
 * sub-headings as readily as they write them as plain lines, so a deeper
 * heading that opens with a criterion id stays inside the section; every other
 * heading closes it.
 */
function acceptanceLines(body) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const heading = HEADING.exec(line);
    return heading && ACCEPTANCE_HEADING.test(heading[2]);
  });
  if (start === -1) return [];
  const level = HEADING.exec(lines[start])[1].length;
  const section = [];
  for (const line of lines.slice(start + 1)) {
    const heading = HEADING.exec(line);
    if (heading && !(heading[1].length > level && criterionId(firstToken(heading[2])))) break;
    section.push(line);
  }
  return section;
}

/**
 * One line of the acceptance section as a criterion, or null. A criterion is a
 * line that opens with its id, in any of the forms a card writes it in: bold
 * (`**AC-3.6.1** the text`), bare (`AC-12 the text`, `AC-12: the text`), a
 * list item of either (`- AC-1: the text`), or a sub-heading (`### AC-1`). A
 * list item that opens with no id takes its position, which is how a card that
 * labels nothing still names an ordered set. Everything else under the heading
 * is prose: an indented line belongs to the item above it, and a paragraph
 * that opens with an ordinary word states no criterion.
 */
function criterionOf(line, position) {
  const heading = HEADING.exec(line);
  const item = heading ? null : LIST_ITEM.exec(line);
  const text = (heading ? heading[2] : (item ? item[1] : line)).trim();
  if (text.length === 0 || NONE.test(text)) return null;
  if (!heading && !item && /^\s/.test(line)) return null;
  const [first, ...rest] = text.split(/\s+/);
  const id = criterionId(first);
  if (id) return { id, text: rest.join(' ').replace(/^[—–-]\s*/, '') };
  return item ? { id: `AC-${position + 1}`, text } : null;
}

/** The criterion id a token carries, stripped of its markdown, or null. */
function criterionId(token) {
  const stripped = token.replace(/^[`*_(\[]+/, '').replace(/[`*_:.,;)\]]+$/, '');
  return isCriterionId(stripped) ? stripped : null;
}

function firstToken(text) {
  return text.split(/\s+/)[0];
}

function splitFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { fields: {}, body: text, found: false };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) return { fields: {}, body: text, found: false };
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = stripQuotes(match[2].trim());
  }
  return { fields, body: lines.slice(end + 1).join('\n'), found: true };
}

function parseList(value) {
  if (!value) return [];
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      // fall through to the comma split
    }
  }
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((v) => stripQuotes(v.trim()))
    .filter((v) => v.length > 0);
}

/** List items under the first heading that matches `pattern`, until the next heading. */
function sectionItems(body, pattern) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const heading = HEADING.exec(line);
    return heading && pattern.test(heading[2]);
  });
  if (start === -1) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line)) break;
    const item = LIST_ITEM.exec(line);
    if (!item) continue;
    const value = item[1].trim();
    if (value.length > 0 && !NONE.test(value)) items.push(value);
  }
  return items;
}

function stripQuotes(value) {
  const match = /^(['"])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}
