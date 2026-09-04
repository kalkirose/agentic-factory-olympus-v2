// A run's duration, read from its own ledger. Two numbers, because one of them
// lies: wall clock is launch to close, and a run that spent nine of its
// seventeen hours parked on a human reads as a slow harness when the harness
// was not running. Active time is the wall minus every span the run was not
// the machine's to spend — a park waiting on an answer, or an inert stretch
// under a liveness violation nobody had resolved yet. Time waiting on a human
// or on a dead substrate is not the harness's pace.
//
// The same split answers a second question, over a window rather than a run: a
// duration band asks what a stage of a lane usually takes, and a stage standing
// in a queue is not taking anything. So the wait classes are named, a caller
// says which of them its reading counts as waiting, and there is one derivation
// behind both readings (ADR-0039).
//
// Everything here is a derivation over ledger lines. Nothing is held in
// daemon memory, so a restart re-reads the same file and answers the same
// numbers, and an archived ledger answers them years later.

/**
 * The named classes of wait, each with the stamps that open and close one.
 *
 * `human` is the run waiting on a person or on a dead substrate: a park opens
 * the wait, and the answer is what ends it — the human's stamp, not the
 * daemon's `resume` behind it — though a ledger whose answer is missing and
 * whose resume is present still ends the wait at the resume. A
 * `liveness-violation` opens an inert stretch: the invariant found no in-flight
 * child, no parked escalation and no transition in progress, and it stays inert
 * until the paired `resolved` lands.
 *
 * `queue` is the run waiting on another run of its own project: it asked for
 * the ship token, somebody else was holding it, and it polls until the holder
 * merges. Nothing of the run's own work happens in that stretch (ADR-0033).
 *
 * `hold` is the run waiting on an operator hold: it settled a stage, the hold
 * stood, and it stopped at the boundary until somebody released it. The run
 * holds no child at all in that stretch, so it is the purest wait of the
 * three (ADR-0040).
 *
 * `wait` is the run waiting on something outside the factory that no person
 * was asked about: a provider that killed a seat, a host that dropped a
 * connection, a service that is down. `waiting` opens the span and
 * `waiting-ended` closes it. It counts as waiting for the same reason a park
 * does — nothing of the run's own work happens in it, and a ladder that sat
 * out a 45-minute provider outage is not 45 minutes of harness.
 */
export const WAIT_CLASSES = {
  human: {
    opens: (e) => e.event === 'park',
    closes: (e) => e.event === 'answer' || e.event === 'resume',
    inert: (e) => e.event === 'liveness-violation',
  },
  queue: {
    opens: (e) => e.event === 'ship-token' && e.state === 'waiting',
    closes: (e) => e.event === 'ship-token' && e.state === 'acquired',
    inert: () => false,
  },
  hold: {
    opens: (e) => e.event === 'stage-held',
    closes: (e) => e.event === 'stage-released',
    inert: () => false,
  },
  wait: {
    opens: (e) => e.event === 'waiting',
    closes: (e) => e.event === 'waiting-ended',
    inert: () => false,
  },
};

/**
 * What a run duration counts as waiting. The wall-versus-active pair on the
 * close stamp answers how much of a run was the harness working, so it counts
 * every wait the harness was not: the answer to a park, the operator hold that
 * stopped the run at a stage boundary, and the wait a ladder spent on a
 * provider or a host. A queue wait is one run of the harness waiting for
 * another, which is the harness's own pace and belongs in its number.
 */
const RUN_CLASSES = ['human', 'hold', 'wait'];

/**
 * The spans of one run ledger that are not active time, merged so that a park
 * inside an unresolved violation is counted once rather than twice.
 *
 * @param {object[]} events one run ledger, in order
 * @param {{start?: string, end?: string, classes?: string[]}} [opts] the window
 *   the reading covers — `start` defaults to the run's launch stamp and `end`
 *   to its close stamp — and the wait classes it counts as waiting.
 * @returns {{from: string, to: string}[]} in order, non-overlapping
 */
export function inactiveSpans(events, { start, end, classes = RUN_CLASSES } = {}) {
  const bounds = readBounds(events, start, end);
  if (bounds === null) return [];
  const { from, to } = bounds;
  const kinds = classes.map((name) => WAIT_CLASSES[name]).filter(Boolean);
  if (kinds.length === 0) return [];
  const cleared = new Map();
  for (const e of events) {
    if (e.event === 'resolved') cleared.set(e.resolves, Date.parse(e.ts));
  }
  const spans = [];
  // One open wait per class: a park and a queue wait are separate waits, and a
  // run inside both is waiting once, which the merge below settles.
  const open = kinds.map(() => null);
  for (const e of events) {
    const at = Date.parse(e.ts);
    // An event outside the reading opens nothing and closes nothing. The ship
    // stat stops at the merge, and the close-out stage that follows it is a
    // later run's worth of ledger as far as that reading is concerned.
    if (!Number.isFinite(at) || at > to) continue;
    kinds.forEach((kind, i) => {
      if (kind.opens(e)) {
        // A second open with no close between is the same wait, still open.
        if (open[i] === null) open[i] = at;
      } else if (kind.closes(e)) {
        if (open[i] !== null) {
          spans.push([open[i], at]);
          open[i] = null;
        }
      } else if (kind.inert(e)) {
        const resolvedAt = cleared.get(e.seq);
        spans.push([at, resolvedAt === undefined ? to : resolvedAt]);
      }
    });
  }
  // Open at the end: the run closed on a park nobody answered, on a violation
  // nobody resolved, or on a token it never got. It was waiting up to the last
  // moment read.
  for (const at of open) if (at !== null) spans.push([at, to]);
  return merge(spans, from, to);
}

/**
 * The milliseconds of one window that the run spent waiting rather than
 * working. The window and the classes are `inactiveSpans`'s.
 * @param {object[]} events one run ledger, in order
 * @param {{start?: string, end?: string, classes?: string[]}} [opts]
 * @returns {number}
 */
export function inactiveMs(events, opts) {
  return inactiveSpans(events, opts).reduce(
    (sum, span) => sum + (Date.parse(span.to) - Date.parse(span.from)),
    0,
  );
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
 *   activeMs: number, waitedMs: number}|null} `waitedMs` is the wall the run
 *   spent on a person: a park nobody had answered, an unresolved violation, an
 *   operator hold. It is exactly what `wallMs` holds and `activeMs` does not.
 */
export function runDuration(events, { end } = {}) {
  const bounds = readBounds(events, undefined, end);
  if (bounds === null) return null;
  const { from, to, launchedAt, endedAt } = bounds;
  const waitedMs = inactiveMs(events, { end: endedAt, classes: RUN_CLASSES });
  const wallMs = to - from;
  return { launchedAt, endedAt, wallMs, activeMs: wallMs - waitedMs, waitedMs };
}

function readBounds(events, start, end) {
  // A window the caller states needs no launch stamp: a stage visit is a window
  // of a run, and the run it belongs to is the ledger being read.
  const launchedAt = start ?? events.find((e) => e.event === 'run-launched')?.ts ?? null;
  if (launchedAt === null) return null;
  const endedAt = end ?? events.find((e) => e.event === 'run-closed')?.ts ?? null;
  if (endedAt === null) return null;
  const from = Date.parse(launchedAt);
  const to = Date.parse(endedAt);
  // `ts` is recording data, and an out-of-order pair — clock skew, a
  // hand-edited fixture — is not a duration. It reads as no duration rather
  // than as a negative one.
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return { from, to, launchedAt, endedAt };
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
