// Escapes ledger: the central, counted record of post-merge defects and
// chores. Lifecycle — `escape-recorded` at repair-lane launch or red-merge
// conversion, `escape-ticketed` when the harness has written the repair
// ticket the escape is repaired from, then one of the two ends: `escape-fixed`
// at repair-lane close, or `escape-marked-fixed` when an operator fixed it
// outside the factory and says what that stands on. Every event is linked by
// the recorded seq. The recorded category is a routing hint until fixed; a
// repair-lane fix carries the final category and attribution.
import { isAbsolute } from 'node:path';
import { readEvents } from '../ledger/ledger.mjs';
import { assertDefectKind } from '../ledger/registry.mjs';

export const ESCAPE_CATEGORIES = new Set([
  'product-escape',
  'spec-deviation',
  'gate-integrity',
  'suite-defect',
  'infra',
  'harness',
  'chore',
]);

// The quality-bar ceiling counts only these two categories.
export const COUNTED_CATEGORIES = new Set(['product-escape', 'spec-deviation']);

// Starter vocabulary; the eval review owns promotions.
export const DETECTION_SOURCES = new Set([
  'human-report',
  'post-merge-ci',
  'tripwire',
  'downstream-run',
  'harness-self',
  'other',
]);

function assertCategory(category) {
  if (!ESCAPE_CATEGORIES.has(category)) {
    throw new Error(`unknown escape category: ${category}`);
  }
}

/**
 * Appends an `escape-recorded` event.
 *
 * `kind` is the closed name of a defect the harness recognizes as one of its
 * own (`DEFECT_KINDS`). It is optional, because most escapes are defects in a
 * product nobody has a vocabulary for; where the harness does have the word,
 * the defect line stops being the only record of what happened and the same
 * defect recurring is a count. An unknown kind throws rather than passing
 * through as a new one — a vocabulary that grows at a call site is prose again.
 * @param {import('./stores.mjs').TelemetryStore} store the escapes store
 * @param {{actor: string, category: string, defectLine: string,
 *   detectionSource: string, attribution?: string, kind?: string,
 *   note?: string, refs?: object}} fields
 */
export function recordEscape(store, { actor, category, defectLine, detectionSource, attribution = 'unattributed', kind, note, refs }) {
  assertCategory(category);
  if (!DETECTION_SOURCES.has(detectionSource)) {
    throw new Error(`unknown detection source: ${detectionSource}`);
  }
  if (detectionSource === 'other' && !note) {
    throw new Error('detection source other requires a note');
  }
  if (typeof defectLine !== 'string' || defectLine.length === 0) {
    throw new Error('escape-recorded requires a defect line');
  }
  if (kind !== undefined) assertDefectKind(kind);
  const fields = { actor, category, defectLine, detectionSource, attribution };
  if (kind !== undefined) fields.kind = kind;
  if (note) fields.note = note;
  if (refs) fields.refs = refs;
  return store.append('escape-recorded', fields);
}

/**
 * Appends the linked `escape-ticketed` event: the escape now has a repair
 * ticket, and that ticket is the whole spec of the repair. The stamp follows
 * the file it names, so a ticketed escape is always repairable — every step
 * after it may fail and the record stays actionable. Refuses an unknown
 * target, a relative path, and a second ticket.
 * @param {import('./stores.mjs').TelemetryStore} store the escapes store
 * @param {{actor: string, escape: number, ticket: string, refs?: object}} fields
 *   `escape` is the recorded seq; `ticket` is an absolute path in the daemon
 *   home — the repair seat reads it from a fresh worktree.
 */
export function ticketEscape(store, { actor, escape, ticket, refs }) {
  if (!Number.isInteger(escape)) {
    throw new Error('escape-ticketed requires an integer escape seq');
  }
  if (typeof ticket !== 'string' || !isAbsolute(ticket)) {
    throw new Error('escape-ticketed requires an absolute ticket path');
  }
  const events = readEvents(store.ledger.path);
  const target = events.find((e) => e.seq === escape);
  if (!target || target.event !== 'escape-recorded') {
    throw new Error(`no escape-recorded at seq ${escape}`);
  }
  if (events.some((e) => e.event === 'escape-ticketed' && e.escape === escape)) {
    throw new Error(`escape at seq ${escape} already carries a ticket`);
  }
  return store.append('escape-ticketed', { actor, escape, ticket, ...(refs && { refs }) });
}

// The two events that end an escape. A repair run's close-out stamps
// `escape-fixed` with the run and the merge behind it; an operator who fixed
// the defect outside the factory stamps `escape-marked-fixed` with the
// evidence they stand on. Both close the escape, and the ledger says which
// one happened — a repair the factory ran and a claim a human made are not
// the same fact (ADR-0024).
export const ESCAPE_FIX_EVENTS = new Set(['escape-fixed', 'escape-marked-fixed']);

/** The event that closed this escape, or undefined. */
function fixOf(events, seq) {
  return events.find((e) => ESCAPE_FIX_EVENTS.has(e.event) && e.fixes === seq);
}

/** The escape-recorded event at this seq, or a throw naming what is there. */
function requireRecord(events, seq) {
  const target = events.find((e) => e.seq === seq);
  if (!target || target.event !== 'escape-recorded') {
    throw new Error(`no escape-recorded at seq ${seq}`);
  }
  return target;
}

/**
 * Appends the linked `escape-fixed` event with the final category and
 * attribution. Refuses an unknown target and a double fix.
 * @param {import('./stores.mjs').TelemetryStore} store the escapes store
 * @param {{actor: string, fixes: number, category: string,
 *   attribution: string, refs: object}} fields `refs` names the fix
 *   (PR + run id)
 */
export function fixEscape(store, { actor, fixes, category, attribution, refs }) {
  assertCategory(category);
  if (!Number.isInteger(fixes)) throw new Error('escape-fixed requires an integer fixes seq');
  if (typeof attribution !== 'string' || attribution.length === 0) {
    throw new Error('escape-fixed requires a final attribution');
  }
  if (!refs) throw new Error('escape-fixed requires a fix ref');
  const events = readEvents(store.ledger.path);
  requireRecord(events, fixes);
  const fixed = fixOf(events, fixes);
  if (fixed) throw new Error(`escape at seq ${fixes} is already fixed (${fixed.event})`);
  return store.append('escape-fixed', { actor, fixes, category, attribution, refs });
}

/**
 * Appends the linked `escape-marked-fixed` event: an operator states that the
 * defect is out of the product, and no repair run says so. The evidence is
 * required, because a mark with nothing behind it retires a defect on
 * somebody's memory. Refuses an unknown target and a double fix.
 * @param {import('./stores.mjs').TelemetryStore} store the escapes store
 * @param {{actor: string, fixes: number, evidence: string, note?: string}} fields
 */
export function markEscapeFixed(store, { actor, fixes, evidence, note }) {
  if (typeof actor !== 'string' || actor.length === 0) {
    throw new Error('escape-marked-fixed requires an actor');
  }
  if (!Number.isInteger(fixes)) {
    throw new Error('escape-marked-fixed requires an integer fixes seq');
  }
  if (typeof evidence !== 'string' || evidence.trim().length === 0) {
    throw new Error('escape-marked-fixed requires the evidence the mark stands on');
  }
  const events = readEvents(store.ledger.path);
  requireRecord(events, fixes);
  const fixed = fixOf(events, fixes);
  if (fixed) throw new Error(`escape at seq ${fixes} is already fixed (${fixed.event})`);
  return store.append('escape-marked-fixed', {
    actor,
    fixes,
    evidence,
    ...(note !== undefined && { note }),
  });
}

/**
 * Reads the escapes ledger into one entry per recorded escape, with the
 * ticket and the fix merged in where they exist. `category` and
 * `attribution` are final values (from the fix when it carries them, else
 * from the record); `ticket` is the repair ticket's absolute path, or null.
 * `fixed` is true for either end, and `fixedBy` says which: `repair` for a
 * repair run's close-out, `operator` for a mark. `kind` is the closed defect
 * name where the record carried one, and null where it did not — a fix never
 * renames a defect, so this value is the record's own.
 */
export function readEscapeSet(path) {
  const events = readEvents(path);
  const fixes = new Map();
  const tickets = new Map();
  for (const e of events) {
    if (ESCAPE_FIX_EVENTS.has(e.event)) fixes.set(e.fixes, e);
    else if (e.event === 'escape-ticketed') tickets.set(e.escape, e);
  }
  const set = [];
  for (const e of events) {
    if (e.event !== 'escape-recorded') continue;
    const fix = fixes.get(e.seq);
    set.push({
      seq: e.seq,
      recordedTs: e.ts,
      defectLine: e.defectLine,
      kind: e.kind ?? null,
      detectionSource: e.detectionSource,
      // An operator mark carries no classification: the record's own category
      // and attribution stand, so the quality-bar window counts the escape as
      // it was recorded rather than losing it to an undefined class.
      category: fix?.category ?? e.category,
      attribution: fix?.attribution ?? e.attribution,
      refs: e.refs,
      ticket: tickets.get(e.seq)?.ticket ?? null,
      fixed: Boolean(fix),
      fixedBy: fix ? (fix.event === 'escape-fixed' ? 'repair' : 'operator') : undefined,
      fixRefs: fix?.refs,
      fixEvidence: fix?.evidence,
    });
  }
  return set;
}

/** Recorded escapes without a linked fix. */
export function openEscapes(path) {
  return readEscapeSet(path).filter((e) => !e.fixed);
}

/**
 * The closed defect kind an escape carries when the ship that let it through
 * carried its certification over a moved base rather than earning it again
 * (ADR-0056). The word is assigned where the escape is recorded, from the
 * ship's own ledger record, and this is the only name for it.
 */
export const FAST_PATH_ESCAPE_KIND = 'fast-path-escape';

/**
 * The cost of the fast-path trade, counted. Window = the most recent shipped
 * runs of any lane; count = escapes recorded at or after the oldest ship of
 * the window whose kind names the fast path. A count and not a rate: the owner
 * turned the flag on knowing some defects would ship, and the question the
 * tripwire asks is how many, not what share.
 * @param {{ships: Array<{ts: string}>, escapes: ReturnType<typeof readEscapeSet>,
 *   windowSize?: number}} input `ships` in ship order
 */
export function fastPathEscapesWindow({ ships, escapes, windowSize = 10 }) {
  const window = ships.slice(-windowSize);
  const oldest = window[0];
  const counted = escapes.filter(
    (e) => e.kind === FAST_PATH_ESCAPE_KIND && oldest && e.recordedTs >= oldest.ts,
  );
  return {
    ships: window.length,
    counted: counted.length,
    escapes: counted.map((e) => e.seq),
  };
}

/**
 * The quality-bar window math. Window = the most recent shipped runs of any
 * lane by ledger order; count = escapes with final category in the counted
 * set, recorded at or after the oldest ship in the window. A shipped repair
 * is a ship that can escape, so it stands in the window like a story. Recency-based,
 * not attribution-based — unknown origin still counts. The divisor is the
 * window size even while fewer ships exist.
 * @param {{ships: Array<{ts: string}>, escapes: ReturnType<typeof readEscapeSet>,
 *   windowSize?: number, ceiling?: number}} input `ships` in ship order
 */
export function escapesWindow({ ships, escapes, windowSize = 10, ceiling = 0.5 }) {
  const window = ships.slice(-windowSize);
  const oldest = window[0];
  const counted = escapes.filter(
    (e) => COUNTED_CATEGORIES.has(e.category) && oldest && e.recordedTs >= oldest.ts,
  );
  const rate = counted.length / windowSize;
  return {
    ships: window.length,
    counted: counted.length,
    rate,
    ceiling,
    breach: rate > ceiling,
  };
}
