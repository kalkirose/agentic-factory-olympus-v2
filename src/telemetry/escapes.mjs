// Escapes ledger: the central, counted record of post-merge defects and
// chores. Two-event lifecycle — `escape-recorded` at repair-lane launch or
// red-merge conversion, `escape-fixed` at repair-lane close, linked by seq.
// The recorded category is a routing hint until fixed; the fix carries the
// final category and attribution.
import { readEvents } from '../ledger/ledger.mjs';

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
 * @param {import('./stores.mjs').TelemetryStore} store the escapes store
 * @param {{actor: string, category: string, defectLine: string,
 *   detectionSource: string, attribution?: string, note?: string,
 *   refs?: object}} fields
 */
export function recordEscape(store, { actor, category, defectLine, detectionSource, attribution = 'unattributed', note, refs }) {
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
  const fields = { actor, category, defectLine, detectionSource, attribution };
  if (note) fields.note = note;
  if (refs) fields.refs = refs;
  return store.append('escape-recorded', fields);
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
  const target = events.find((e) => e.seq === fixes);
  if (!target || target.event !== 'escape-recorded') {
    throw new Error(`no escape-recorded at seq ${fixes}`);
  }
  if (events.some((e) => e.event === 'escape-fixed' && e.fixes === fixes)) {
    throw new Error(`escape at seq ${fixes} is already fixed`);
  }
  return store.append('escape-fixed', { actor, fixes, category, attribution, refs });
}

/**
 * Reads the escapes ledger into one entry per recorded escape, with the fix
 * merged in where one exists. `category` and `attribution` are final values
 * (from the fix when fixed, else from the record).
 */
export function readEscapeSet(path) {
  const events = readEvents(path);
  const fixes = new Map();
  for (const e of events) {
    if (e.event === 'escape-fixed') fixes.set(e.fixes, e);
  }
  const set = [];
  for (const e of events) {
    if (e.event !== 'escape-recorded') continue;
    const fix = fixes.get(e.seq);
    set.push({
      seq: e.seq,
      recordedTs: e.ts,
      defectLine: e.defectLine,
      detectionSource: e.detectionSource,
      category: fix ? fix.category : e.category,
      attribution: fix ? fix.attribution : e.attribution,
      fixed: Boolean(fix),
      fixRefs: fix ? fix.refs : undefined,
    });
  }
  return set;
}

/** Recorded escapes without a linked fix. */
export function openEscapes(path) {
  return readEscapeSet(path).filter((e) => !e.fixed);
}

/**
 * The quality-bar window math. Window = the most recent shipped story-lane
 * runs by ledger order; count = escapes with final category in the counted
 * set, recorded at or after the oldest ship in the window. Recency-based,
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
