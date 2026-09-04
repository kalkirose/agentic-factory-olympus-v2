// One wait mechanism, for every failure the harness answers by waiting rather
// than by asking.
//
// A run that stops because a provider refused a seat, because a host dropped a
// connection, or because a service is down for the day used to reach a human.
// Every one of those answers was the same word — retry — given minutes or
// hours later, and the harness held the question open in between. A wait is
// that answer, taken by the machine, on a ladder the run climbs and then stops
// climbing.
//
// The record is a pair: `waiting` opens a span and `waiting-ended` closes it.
// Every reader of a run works off that pair — the liveness rule reads a
// waiting run as alive, the duration split takes the span out of the run's
// active time, `olympusctl status` prints what a run waits on and until when,
// and the cycle fingerprint counts the waits so a cycle after a wait is a new
// cycle by construction. Nothing else is stored: a restart re-derives the
// ladder position from the stamps, and an open span the dead instance left is
// closed by the next start.
//
// Two ladders, and they are named here once. A seat crash is a provider
// incident measured in minutes to an hour, so the seat ladder is 5, 15 and 45
// minutes. A layer red is a host or a service measured in seconds to a day, so
// the layer ladder is 1, 5 and 15 minutes and the external wait follows it.
// Each step is one wait and one re-dispatch or one narrowed re-run.
const ACTOR = 'daemon';

/**
 * The kinds of wait, closed. Each names what the run is waiting for, never
 * what raised it: a reader of a ledger asks what a run is waiting on, and the
 * answer is a provider, a layer, a host, or a service.
 */
export const WAIT_KINDS = new Set([
  // A seat child the provider killed, or a model the vendor refused.
  'seat',
  // A Tier-1 layer whose red the harness read as a condition outside the tree.
  'layer',
  // An env-class finding that survived its operational fix.
  'substrate',
  // A declared service that is down: the wait polls the credential's own probe
  // and it is the one wait that frees the run's slot.
  'external',
]);

/** The seat ladder: 5, 15 and 45 minutes. */
export const SEAT_LADDER = Object.freeze([5, 15, 45].map((m) => m * 60_000));

/** The layer ladder: 1, 5 and 15 minutes. Items 8 and 9 both climb it. */
export const LAYER_LADDER = Object.freeze([1, 5, 15].map((m) => m * 60_000));

/** How long an external wait polls before it asks anybody: one day. */
export const EXTERNAL_WAIT_MS = 24 * 60 * 60 * 1000;

/** How often it asks the service's own probe inside that day. */
export const EXTERNAL_POLL_MS = 10 * 60 * 1000;

/** How long a service is down before the instance says so, loudly. */
export const EXTERNAL_OUTAGE_MS = 60 * 60 * 1000;

/**
 * The step of a ladder an attempt takes, or null past the last one. Attempts
 * are 1-based, because the first wait is the first attempt at waiting and a
 * reader of a ledger counts from one.
 */
export function ladderStep(ladder, attempt) {
  return attempt >= 1 && attempt <= ladder.length ? ladder[attempt - 1] : null;
}

/**
 * A wait the daemon ended for a reason that is not the clock: a kill, or the
 * instance stopping. It is thrown rather than returned, because every caller
 * of a wait is inside a stage handler and the engine already drops what a
 * handler returns after a run closes or the daemon stops. A caller that
 * swallowed it would carry on spawning work into a shutdown.
 */
export class WaitCancelled extends Error {
  constructor(outcome, message) {
    super(message ?? `the wait ended: ${outcome}`);
    this.name = 'WaitCancelled';
    this.outcome = outcome;
  }
}

/** The default sleep: a timer that never holds the process open by itself. */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * One wait, end to end: the `waiting` stamp, the span, and the `waiting-ended`
 * stamp that closes it.
 *
 * @param {{store: object, waits?: {register?: Function, holdBarrier?: Function},
 *   sleep?: (ms: number) => Promise<void>, now?: () => number}} ctx the run's
 *   ledger and the engine's seams: `waits.register` puts the wait where the
 *   heartbeat, the slot count and a kill can see it, and `holdBarrier` is what
 *   holds the re-dispatch behind an operator hold taken while the run waited.
 * @param {{kind: string, reason: string, ms: number, attempt?: number,
 *   detail?: object|null, freesSlot?: boolean,
 *   poll?: ((state: {elapsed: number, spent: number, attempt: number,
 *     step: number, steps: number}) => Promise<boolean|string>)|null,
 *   pollMs?: number|null}} opts
 *   `poll` makes the wait a question asked on a cadence rather than a span
 *   slept through: it is called every `pollMs`, and a truthy answer ends the
 *   wait green. `freesSlot` says the run is not holding the machine while it
 *   waits, which is true of the external wait alone.
 * @returns {Promise<{outcome: string, waitSeq: number, until: string}>}
 *   `outcome` is `elapsed` for a span that ran out, `probe-green` for a poll
 *   that got its answer, and `spent` for a poll that never did.
 */
export async function waitFor(
  ctx,
  { kind, reason, ms, attempt = 1, detail = null, freesSlot = false, poll = null, pollMs = null },
) {
  if (!WAIT_KINDS.has(kind)) throw new Error(`unknown wait kind: ${kind}`);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`a ${kind} wait needs a positive span`);
  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? defaultSleep;
  const startedAt = now();
  const until = new Date(startedAt + ms).toISOString();
  const opened = ctx.store.append('waiting', {
    actor: ACTOR,
    kind,
    reason,
    until,
    attempt,
    ...(freesSlot && { freesSlot: true }),
    ...(detail && Object.keys(detail).length > 0 && { detail }),
  });
  let cancelled = null;
  let stamped = false;
  let wake = () => {};
  const cancellation = new Promise((resolve) => {
    wake = resolve;
  });
  // The close of the span, written where the caller stands. A cancel writes it
  // from inside the call that cancels — a kill closes the run's ledger in the
  // same turn, and a stamp the waiting handler wrote one tick later would land
  // on a ledger that had already moved to the archive.
  const close = (outcome, extra = {}) => {
    if (stamped) return;
    stamped = true;
    try {
      ctx.store.append('waiting-ended', {
        actor: ACTOR,
        kind,
        outcome,
        waitSeq: opened.seq,
        elapsed: now() - startedAt,
        ...extra,
      });
    } catch {
      // A run whose store closed while it waited. The next start pairs it
      // (`recoverOpenWaits`).
    }
  };
  const entry = {
    kind,
    reason,
    until,
    attempt,
    freesSlot,
    cancel(outcome) {
      if (cancelled !== null) return;
      cancelled = outcome ?? 'cancelled';
      close(cancelled);
      wake();
    },
  };
  const leave = ctx.waits?.register?.(entry) ?? (() => {});
  let outcome = poll ? 'spent' : 'elapsed';
  try {
    // The span is slept in one go, or in as many polls as it holds. The count
    // is the bound, never the clock: a caller that drives the sleep drives the
    // whole wait with it, and a loop that re-read a wall clock it was not
    // driving would spin through a wait nobody was spending.
    const span = poll ? Math.min(pollMs ?? ms, ms) : ms;
    const steps = poll ? Math.max(1, Math.ceil(ms / span)) : 1;
    for (let step = 1; step <= steps; step++) {
      await Promise.race([sleep(span), cancellation]);
      if (cancelled !== null) {
        outcome = cancelled;
        break;
      }
      if (!poll) {
        outcome = 'elapsed';
        break;
      }
      // `spent` is what the wait has covered by construction — the steps it
      // has taken, times the span of one — and `elapsed` is what the clock
      // says. A caller that drives the sleep drives the first and not the
      // second, so a reading that must hold under a driven clock uses it.
      const answer = await poll({
        elapsed: now() - startedAt,
        spent: step * span,
        attempt,
        step,
        steps,
      });
      if (cancelled !== null) {
        outcome = cancelled;
        break;
      }
      if (answer === true || answer === 'green') {
        outcome = 'probe-green';
        break;
      }
    }
  } finally {
    leave();
  }
  close(outcome);
  if (cancelled !== null) {
    throw new WaitCancelled(outcome, `the ${kind} wait ended: ${outcome}`);
  }
  // The re-dispatch this wait exists to buy is the step an operator hold
  // stops. A hold taken while the run waited holds it here, and the run enters
  // nothing until the release (ADR-0040).
  await ctx.waits?.holdBarrier?.();
  return { outcome, waitSeq: opened.seq, until };
}

/**
 * Every wait of this ledger that no `waiting-ended` closed, oldest first. A
 * ledger holds at most one at a time; the list is what makes a recovery
 * complete rather than nearly so.
 */
export function openWaits(events) {
  const open = new Map();
  for (const e of events ?? []) {
    if (e.event === 'waiting') open.set(e.seq, e);
    else if (e.event === 'waiting-ended' && typeof e.waitSeq === 'number') open.delete(e.waitSeq);
  }
  return [...open.values()];
}

/** The wait a run is standing in, or null. Derived, never held. */
export function openWait(events) {
  return openWaits(events).at(-1) ?? null;
}

/**
 * Closes every wait a dead instance left open. A wait is a span of one
 * handler's execution, and the handler died with the instance, so the span
 * ended when the daemon did — the same discipline `recoverOpenAttempts` holds
 * for a gate-layer attempt (ADR-0034). The stamps stay in the ledger, so the
 * ladder the run was climbing resumes where it stood rather than at the first
 * step.
 * @returns {number} how many spans were closed
 */
export function recoverOpenWaits(store, { actor = ACTOR, trigger = 'daemon-start' } = {}) {
  const open = openWaits(store.events());
  for (const wait of open) {
    store.append('waiting-ended', {
      actor,
      kind: wait.kind,
      outcome: 'daemon-stopped',
      waitSeq: wait.seq,
      trigger,
    });
  }
  return open.length;
}

/**
 * The next attempt on a ladder of one kind, read from the ledger alone: one
 * more than the waits of that kind stamped since `since`.
 *
 * `since` is the seq the ladder starts from — the render a route acts on, the
 * answer a human gave, the cycle's own beginning. It is what keeps a ladder
 * from restarting at step one after a daemon restart, and what makes a human's
 * `retry` grant a fresh ladder rather than a fourth step.
 */
export function waitAttempt(events, kind, { since = 0 } = {}) {
  let taken = 0;
  for (const e of events ?? []) {
    if (e.event === 'waiting' && e.kind === kind && e.seq > since) taken += 1;
  }
  return taken + 1;
}

/**
 * The waits of one kind stamped since `since`, with what each one waited for
 * and how long. A park raised after a spent ladder carries this: an operator
 * asked to look at a host reads what the harness already tried, and when.
 */
export function waitHistory(events, kind, { since = 0 } = {}) {
  const ended = new Map();
  for (const e of events ?? []) {
    if (e.event === 'waiting-ended' && typeof e.waitSeq === 'number') ended.set(e.waitSeq, e);
  }
  return (events ?? [])
    .filter((e) => e.event === 'waiting' && e.kind === kind && e.seq > since)
    .map((e) => ({
      attempt: e.attempt,
      reason: e.reason,
      at: e.ts,
      until: e.until,
      outcome: ended.get(e.seq)?.outcome ?? 'open',
    }));
}

/** One history line, for a park question a human reads. */
export function waitLine(entry) {
  return `- attempt ${entry.attempt} at ${entry.at} (${entry.reason}) — ${entry.outcome}`;
}
