// A run's duration, read from its own ledger. Two numbers, because one of them
// lies: wall clock is launch to close, and a run that spent nine of its
// seventeen hours parked on a human reads as a slow harness when the harness
// was not running. Active time is the wall minus every span the run was not
// the machine's to spend — a park waiting on an answer, or an inert stretch
// under a liveness violation nobody had resolved yet. Time waiting on a human
// or on a dead substrate is not the harness's pace.
//
// Everything here is a derivation over ledger lines. Nothing is held in
// daemon memory, so a restart re-reads the same file and answers the same
// numbers, and an archived ledger answers them years later.

// A park opens the wait. The answer is what ends it — the human's stamp, not
// the daemon's `resume` behind it — but a ledger whose answer is missing and
// whose resume is present still ends the wait at the resume.
const WAIT_OPEN = 'park';
const WAIT_CLOSE = new Set(['answer', 'resume']);

// The run is inert: the invariant found no in-flight child, no parked
// escalation and no transition in progress. It stays inert until the paired
// `resolved` lands, and an unresolved violation at the end runs to the end.
const INERT_OPEN = 'liveness-violation';

/**
 * The spans of one run ledger that are not active time, merged so that a park
 * inside an unresolved violation is counted once rather than twice.
 *
 * @param {object[]} events one run ledger, in order
 * @param {{end?: string}} [opts] the moment the reading stops; defaults to the
 *   run's own close stamp
 * @returns {{from: string, to: string}[]} in order, non-overlapping
 */
export function inactiveSpans(events, { end } = {}) {
  const bounds = readBounds(events, end);
  if (bounds === null) return [];
  const { from, to } = bounds;
  const cleared = new Map();
  for (const e of events) {
    if (e.event === 'resolved') cleared.set(e.resolves, Date.parse(e.ts));
  }
  const spans = [];
  let waiting = null;
  for (const e of events) {
    const at = Date.parse(e.ts);
    // An event outside the reading opens nothing and closes nothing. The ship
    // stat stops at the merge, and the close-out stage that follows it is a
    // later run's worth of ledger as far as that reading is concerned.
    if (!Number.isFinite(at) || at > to) continue;
    if (e.event === WAIT_OPEN) {
      // A second park with no answer between is the same wait, still open.
      if (waiting === null) waiting = at;
    } else if (WAIT_CLOSE.has(e.event)) {
      if (waiting !== null) {
        spans.push([waiting, at]);
        waiting = null;
      }
    } else if (e.event === INERT_OPEN) {
      const resolvedAt = cleared.get(e.seq);
      spans.push([at, resolvedAt === undefined ? to : resolvedAt]);
    }
  }
  // Open at the end: the run closed on a park nobody answered, or on a
  // violation nobody resolved. It was waiting up to the last moment read.
  if (waiting !== null) spans.push([waiting, to]);
  return merge(spans, from, to);
}

/**
 * Wall and active time of one run, in milliseconds, or null when the ledger
 * carries no measurable pair of ends.
 *
 * @param {object[]} events one run ledger, in order
 * @param {{end?: string}} [opts] the moment the reading stops. The close path
 *   passes its own clock read, because the close stamp it is about to write
 *   does not exist yet; every later reader lets the close stamp answer.
 * @returns {{launchedAt: string, endedAt: string, wallMs: number,
 *   activeMs: number, parkedMs: number}|null}
 */
export function runDuration(events, { end } = {}) {
  const bounds = readBounds(events, end);
  if (bounds === null) return null;
  const { from, to, launchedAt, endedAt } = bounds;
  const parkedMs = inactiveSpans(events, { end: endedAt }).reduce(
    (sum, span) => sum + (Date.parse(span.to) - Date.parse(span.from)),
    0,
  );
  const wallMs = to - from;
  return { launchedAt, endedAt, wallMs, activeMs: wallMs - parkedMs, parkedMs };
}

function readBounds(events, end) {
  const launch = events.find((e) => e.event === 'run-launched');
  if (!launch) return null;
  const endedAt = end ?? events.find((e) => e.event === 'run-closed')?.ts ?? null;
  if (endedAt === null) return null;
  const from = Date.parse(launch.ts);
  const to = Date.parse(endedAt);
  // `ts` is recording data, and an out-of-order pair — clock skew, a
  // hand-edited fixture — is not a duration. It reads as no duration rather
  // than as a negative one.
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return { from, to, launchedAt: launch.ts, endedAt };
}

/** Clamps to the reading, drops the empty, and unions what overlaps. */
function merge(spans, from, to) {
  const clamped = spans
    .map(([start, stop]) => [Math.max(start, from), Math.min(stop, to)])
    .filter(([start, stop]) => Number.isFinite(start) && Number.isFinite(stop) && stop > start)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, stop] of clamped) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], stop);
    else out.push([start, stop]);
  }
  return out.map(([start, stop]) => ({
    from: new Date(start).toISOString(),
    to: new Date(stop).toISOString(),
  }));
}
