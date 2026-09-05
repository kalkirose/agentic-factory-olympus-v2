// The surface map: what a suite seat enumerates before it writes a test, and
// what the daemon checks about that enumeration.
//
// A suite seat is shown defects. It writes a test for each one and stops. It
// never asks the question the defect list is a sample of: what else on this
// surface can carry the same fault. The adversary then becomes an enumeration
// device. It finds one member of a set per round, at a full seat and a full
// suite run per round, and a person pays for every round past the second. A
// suite that gained a test for one cookie name gained no test for the second
// cookie name beside it, and the second cookie name was already in the tree
// (ADR-0072).
//
// So every seat that writes a suite file receives the same dimensions the
// adversary receives, and owes an enumeration of the story's surface along
// each of them. The enumeration is a structured field in the seat's report,
// not prose. Per item it names the test that kills a wrong implementation of
// that item, or it states why the spec does not constrain it.
//
// THE MAP IS NOT THE MEASURE OF ITSELF. Nothing mechanical knows the surface,
// so no check here proves the enumeration is complete. The checks below hold
// the shape and the coverage of the document. The adversary stays the measure
// of whether the map is the surface, and it is never told what the map holds:
// an adversary that reads the map is told where the seat already looked, and a
// kill would then prove the suite covers what the map declared (ADR-0072).
//
// One module, read by the story lane and by the verdict lane, so neither lane
// owns the rule. It imports the dimension list and nothing else from the lane.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECURITY_DIMENSIONS } from './lenses.mjs';

/**
 * The kinds an item of the surface can be named by. Closed like the lens
 * vocabulary and the event registry: a kind enters, moves or leaves by a
 * decision recorded in an ADR, never from a call site (ADR-0072).
 */
export const SURFACE_KINDS = Object.freeze([
  'carrier',
  'route',
  'parameter',
  'override',
  'fallback',
  'log-site',
  'store',
  'boundary',
]);

/** The question each kind answers, as the brief states it. */
const KIND_QUESTIONS = Object.freeze({
  carrier:
    'what carries a credential or a grant into a request (a cookie, a header, a parameter, ' +
    'a body field, a token)',
  route: 'where a request can arrive (a path, an endpoint, a hook branch, a route id family)',
  parameter:
    'what steers a destination, a query or a client (a redirect target, a query fragment, ' +
    'a type name, a locale)',
  override: 'a value a caller can set that displaces a pinned configuration',
  fallback: 'a value the code uses when the configured one is absent',
  'log-site': 'a call that writes a log line, a metric or an error payload',
  store:
    'where a value comes to rest (a cookie jar, a cache, a CDN, a generated URL, the page HTML)',
  boundary: 'where data crosses into this process from outside it',
});

/**
 * The two report fields the map rides. Both are flat arrays of flat objects,
 * because the report schema subset allows one level of object nesting
 * (`src/seats/contract.mjs`), so the dimension rides each row.
 */
export const SURFACE_MAP_PROPERTIES = Object.freeze({
  surfaceMap: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dimension: { type: 'string', enum: [...SECURITY_DIMENSIONS] },
        kind: { type: 'string', enum: [...SURFACE_KINDS] },
        item: { type: 'string' },
        where: { type: 'string' },
        test: { type: 'string' },
        outOfScope: { type: 'string' },
        survivors: { type: 'array', items: { type: 'integer' } },
      },
      required: ['dimension', 'kind', 'item', 'where'],
    },
  },
  dimensionsOutOfScope: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dimension: { type: 'string', enum: [...SECURITY_DIMENSIONS] },
        reason: { type: 'string' },
      },
      required: ['dimension', 'reason'],
    },
  },
});

/** The two field names every suite report must carry. */
export const SURFACE_MAP_REQUIRED = Object.freeze(['surfaceMap', 'dimensionsOutOfScope']);

/**
 * The map rule, stated to every seat that writes a suite file. A seat runs in
 * fresh context, so the whole obligation is on the brief or it does not exist.
 *
 * @param {{survivors?: number[]}} opts the survivor waves this write answers.
 *   The amendment write and the strengthening write carry them; the author
 *   write, the red-state fix and the re-freeze carry none.
 */
export function surfaceMapLines({ survivors = [] } = {}) {
  const lines = [
    'Before you write a test, map the surface of this story along the dimensions below. ' +
      'They are the dimensions the adversary weighs.',
    ...SECURITY_DIMENSIONS.map((dimension) => `- ${dimension}`),
    'For each dimension, enumerate every item of this story that sits on it. Read the spec ' +
      'and read the tree. An item the tree already holds counts, and so does an item the ' +
      'spec plans.',
    'Name each item by one kind:',
    ...SURFACE_KINDS.map((kind) => `- ${kind}: ${KIND_QUESTIONS[kind]}`),
    'Enumerate the whole kind, not the one member the spec names. A grant that rides one ' +
      'cookie sits beside every other cookie, header and parameter this tree reads. List them all.',
    'Report the map in "surfaceMap". One row per item: the dimension, the kind, the item as ' +
      'the tree or the spec names it, and "where" (a repository path, or the spec section ' +
      'that plans it).',
    'Close each item. Name in "test" the test that kills a wrong implementation of that item, ' +
      'by the test\'s own name. Or state in "outOfScope" why the spec does not constrain it. ' +
      'Never both, never neither.',
    'A test you name must exist in a file you declare in "suiteFiles". The machine searches ' +
      'those files for the name.',
    'A dimension this story does not touch at all goes in "dimensionsOutOfScope" with its ' +
      'reason, and it gets no row in "surfaceMap".',
    'The map does not shrink. Every item of your previous map stays in this one. An item the ' +
      'spec no longer constrains stays, with "outOfScope" and the reason.',
  ];
  if (survivors.length > 0) {
    lines.push(
      'Each survivor wave below sits on surface items. Put the wave number in "survivors" on ' +
        'every item it sits on, and close each of those items with a test, never with "outOfScope".',
    );
  }
  return lines;
}

/**
 * The deterministic defects of one surface map. Eleven checks, in this order.
 * Every one of them is about the shape and the coverage of the document; none
 * of them judges whether the enumeration is the surface (ADR-0072).
 *
 * A defect line takes the route every suite-report defect takes: the lane
 * contract loop gives the seat one corrective invocation with the defect list,
 * then the seat-failure park (ADR-0006, ADR-0015).
 *
 * @param {object} report the suite seat's report
 * @param {{worktree: string, previous?: object[]|null, survivors?: number[]}} at
 *   `previous` is the map of the previous suite write, or null where there is
 *   none. `survivors` are the waves this write answers.
 * @returns {string[]} defect lines
 */
export function surfaceMapDefects(report, { worktree, previous = null, survivors = [] }) {
  const rows = Array.isArray(report?.surfaceMap) ? report.surfaceMap : [];
  const outOfScope = Array.isArray(report?.dimensionsOutOfScope) ? report.dimensionsOutOfScope : [];
  const defects = [];
  const mapped = new Set(rows.map((row) => row.dimension));
  const declared = new Set(outOfScope.map((entry) => entry.dimension));

  // 1. A dimension nobody accounted for.
  for (const dimension of SECURITY_DIMENSIONS) {
    if (mapped.has(dimension) || declared.has(dimension)) continue;
    defects.push(
      `the dimension "${dimension}" has no row in "surfaceMap" and no entry in ` +
        '"dimensionsOutOfScope". Enumerate the items that sit on it, or declare it out of ' +
        'scope with a reason.',
    );
  }
  // 2. A dimension accounted for twice, in two opposite ways.
  for (const dimension of SECURITY_DIMENSIONS) {
    if (!mapped.has(dimension) || !declared.has(dimension)) continue;
    defects.push(
      `the dimension "${dimension}" is in "surfaceMap" and in "dimensionsOutOfScope". A ` +
        'dimension is enumerated or it is out of scope, never both.',
    );
  }
  // 3. A dimension declared out of scope for no stated reason.
  for (const entry of outOfScope) {
    if (!blank(entry.reason)) continue;
    defects.push(`the "dimensionsOutOfScope" entry for "${entry.dimension}" states no reason.`);
  }
  // 4. A row that names no item, or does not say where the item sits.
  rows.forEach((row, i) => {
    if (blank(row.item)) defects.push(`${rowRef(row, i)} names no item.`);
    if (blank(row.where)) {
      defects.push(
        `${rowRef(row, i)} states no "where". Name a repository path, or the spec section ` +
          'that plans it.',
      );
    }
  });
  // 5. A row closed twice, or not closed at all.
  rows.forEach((row, i) => {
    const test = typeof row.test === 'string';
    const excused = typeof row.outOfScope === 'string';
    if (test && excused) {
      defects.push(
        `${rowRef(row, i)} carries both "test" and "outOfScope". An item is closed by one ` +
          'or the other, never by both.',
      );
    }
    if (!test && !excused) {
      defects.push(
        `${rowRef(row, i)} carries neither "test" nor "outOfScope". Name the test that kills ` +
          'a wrong implementation of this item, or state why the spec does not constrain it.',
      );
    }
  });
  // 6. A row excused for no stated reason.
  rows.forEach((row, i) => {
    if (typeof row.outOfScope !== 'string' || !blank(row.outOfScope)) return;
    defects.push(`${rowRef(row, i)} carries an empty "outOfScope" reason.`);
  });
  // 7. A named test no declared suite file holds. The files are read once.
  if (rows.some((row) => typeof row.test === 'string')) {
    const files = (Array.isArray(report?.suiteFiles) ? report.suiteFiles : []).filter(
      (file) => typeof file === 'string',
    );
    const text = files.map((file) => collapse(readOrEmpty(worktree, file)));
    const searched = files.length > 0 ? files.join(', ') : 'none';
    rows.forEach((row, i) => {
      if (typeof row.test !== 'string') return;
      const name = collapse(row.test);
      if (name.length > 0 && text.some((body) => body.includes(name))) return;
      defects.push(
        `${rowRef(row, i)} names the test "${row.test}" and no declared suite file holds that ` +
          `name. The files searched: ${searched}.`,
      );
    });
  }
  // 8. A survivor wave the map does not sit under.
  const covered = new Set(rows.flatMap((row) => (Array.isArray(row.survivors) ? row.survivors : [])));
  for (const wave of survivors) {
    if (covered.has(wave)) continue;
    defects.push(
      `survivor wave ${wave} sits on no row of "surfaceMap". Put the wave number in ` +
        '"survivors" on every item it sits on.',
    );
  }
  // 9. A survivor's own item excused instead of tested.
  rows.forEach((row, i) => {
    const waves = (Array.isArray(row.survivors) ? row.survivors : []).filter((w) =>
      survivors.includes(w),
    );
    if (waves.length === 0 || typeof row.outOfScope !== 'string') return;
    defects.push(
      `${rowRef(row, i)} names survivor wave ${waves.join(', ')} and carries "outOfScope". A ` +
        'survivor is a wrong implementation of that item that the suite let past, so the spec ' +
        'constrains it. Close it with a test.',
    );
  });
  // 10. An item the previous map held and this one drops.
  if (Array.isArray(previous)) {
    const here = new Set(rows.map((row) => identity(row)));
    for (const row of previous) {
      if (here.has(identity(row))) continue;
      defects.push(
        `the previous map holds the item "${row.item}" on the dimension "${row.dimension}" ` +
          'and this map does not. The map does not shrink: an item the spec no longer ' +
          'constrains stays, with "outOfScope" and the reason.',
      );
    }
  }
  // 11. One item, two rows.
  const seen = new Set();
  for (const row of rows) {
    const key = identity(row);
    if (seen.has(key)) {
      defects.push(
        `the item "${row.item}" appears twice on the dimension "${row.dimension}" in ` +
          '"surfaceMap". One item is one row.',
      );
      continue;
    }
    seen.add(key);
  }
  return defects;
}

/**
 * The seat report holding the map of the previous suite write, or null.
 *
 * It is the last suite seat report whose seq falls before the last
 * `suite-committed` event, so a corrective invocation inside the current write
 * is never mistaken for the previous write. A run with no committed suite yet
 * is at its author write, and the author write has no previous map.
 *
 * @param {object[]} events the run ledger
 */
export function previousMapReport(events) {
  let committed = -1;
  for (const e of events) {
    if (e.event === 'suite-committed') committed = e.seq;
  }
  if (committed === -1) return null;
  let report = null;
  for (const e of events) {
    if (e.event === 'seat-report' && e.seat === 'suite' && e.seq < committed) report = e;
  }
  return report;
}

/**
 * What the `surface-map` stamp carries: counts only, so the ledger stays small.
 * The rows themselves stay in the seat report on disk, and the freeze record
 * carries the map of the last write.
 */
export function surfaceMapCounts(report) {
  const rows = Array.isArray(report?.surfaceMap) ? report.surfaceMap : [];
  const out = Array.isArray(report?.dimensionsOutOfScope) ? report.dimensionsOutOfScope : [];
  const tested = rows.filter((row) => typeof row.test === 'string').length;
  return {
    items: rows.length,
    covered: tested,
    outOfScope: rows.length - tested,
    dimensionsOut: out.length,
    kinds: new Set(rows.map((row) => row.kind)).size,
  };
}

function identity(row) {
  return `${row?.dimension ?? ''} ${row?.item ?? ''}`;
}

function rowRef(row, i) {
  const item = typeof row?.item === 'string' ? row.item.trim() : '';
  return item.length > 0 ? `the surface map row "${item}"` : `surface map row ${i + 1}`;
}

function blank(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}

function collapse(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function readOrEmpty(worktree, file) {
  // A declared suite file that is not there is reported by the lane's own file
  // check, and this one reads what it can.
  try {
    return readFileSync(join(worktree, file), 'utf8');
  } catch {
    return '';
  }
}
