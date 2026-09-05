// The per-project ship token: the one run of a project that may open or merge
// its pull request. Runs parallelize through every stage before the merge; the
// merge itself is serial, because a protected branch that requires its
// requests current makes every concurrent pair pay for the other's merge — a
// CI round at least, a dev pass when the two sides touched the same lines
// (ADR-0033).
//
// The token is derived, never stored. A run that stamped `ship-token`
// (acquired) or `pr-opened`, and has not released it, stamped `merged` or
// closed, holds it; every other open run of the project that stamped a wait is
// in the queue, ordered by the stamp it queued with. So a restart re-derives
// the same holder and the same order from the same ledgers, and a token nobody
// wrote down can be neither lost nor duplicated.
//
// The window the token covers is the merge of the default branch to the merge
// of the request. A run that leaves the update stage for anywhere but the ship
// stage gives the token back first, because nothing it does there needs the
// default branch to stand still, and every other run of the project waits
// through it. A run whose request is already open never gives it back: a
// competing merge under an open request costs the branch update it was going
// to cost anyway, and the released run would re-queue behind runs it was ahead
// of (ADR-0033).
import { readEvents } from '../ledger/ledger.mjs';
import { runLedgerPath } from '../daemon/home.mjs';
import { listLiveRuns } from '../telemetry/readers.mjs';

const ACTOR = 'daemon';

/**
 * Why a run gave the token back. Closed, for the reason every vocabulary in
 * this harness is closed: a reason written as prose at a call site counts as
 * nothing, and a count that mixes a machine cycle with a human answer is a
 * count of nothing (ADR-0008).
 *
 * `re-verdict` is one verdict cycle and the run comes back on its own.
 * `park` is a wait on a person, which no run can bound.
 */
export const SHIP_TOKEN_RELEASE_REASONS = new Set(['re-verdict', 'park']);

/** The reason, or a throw naming it. The only way a reason reaches a stamp. */
export function assertReleaseReason(reason) {
  if (!SHIP_TOKEN_RELEASE_REASONS.has(reason)) {
    throw new Error(`unknown ship-token release reason: ${reason}`);
  }
  return reason;
}

/**
 * One run's position, from its own ledger alone. The project is not read here
 * — the caller selects the ledgers of one project before it folds them.
 *
 * A release takes the run out of the token entirely: it is neither the holder
 * nor a waiter, and it clears `queuedAt` as well, so the run's next wait stamp
 * queues it at the back. It already had its turn, and a released run that kept
 * its first stamp would re-enter ahead of every run that queued during its
 * hold.
 * @returns {{closed: boolean, state: null|'waiting'|'holding'|'done',
 *   queuedAt: string|null, heldSince: string|null, requested: boolean}}
 */
export function tokenPosition(events) {
  let closed = false;
  let state = null;
  let queuedAt = null;
  let heldSince = null;
  let requested = false;
  for (const e of events) {
    switch (e.event) {
      case 'run-closed':
        closed = true;
        break;
      case 'ship-token':
        if (e.state === 'acquired') {
          state = 'holding';
          heldSince = e.ts;
        } else if (e.state === 'waiting') {
          state = 'waiting';
          queuedAt ??= e.ts;
        } else if (e.state === 'released') {
          state = null;
          queuedAt = null;
          heldSince = null;
        }
        break;
      case 'pr-opened':
        state = 'holding';
        heldSince ??= e.ts;
        requested = true;
        break;
      case 'merged':
        state = 'done';
        break;
      default:
        break;
    }
  }
  return { closed, state, queuedAt, heldSince, requested };
}

/**
 * Takes the project's ship token for one run, or records that the run is
 * waiting for it. The derivation and the stamp share one synchronous step, so
 * two runs of one daemon never read the same free token: the second reads the
 * first's acquire. A run that already holds it takes nothing and stamps
 * nothing — a stage may ask as often as it likes.
 * @param {{paths: object, project: string, runId: string, store: object}} ctx
 * @returns {boolean} whether the run holds the token now
 */
export function takeShipToken(ctx) {
  const mine = tokenPosition(readEvents(runLedgerPath(ctx.paths, ctx.runId)));
  if (mine.state === 'holding') return true;
  const token = shipTokenState(ctx.paths, ctx.project);
  if (token.holder === null && (token.next === null || token.next === ctx.runId)) {
    ctx.store.append('ship-token', { actor: ACTOR, state: 'acquired' });
    return true;
  }
  // One stamp per wait, not one per poll: the position holds until the
  // acquire, and the acquire is the next thing this run says.
  if (mine.state !== 'waiting') {
    ctx.store.append('ship-token', {
      actor: ACTOR,
      state: 'waiting',
      ...(token.holder && { holder: token.holder }),
      ahead: token.waiting.length,
    });
  }
  return false;
}

/**
 * Gives the project's ship token back. The run keeps its place in no queue: it
 * takes the token again from the back, when it comes back to the seam.
 *
 * Two runs never release each other's token, because a run stamps only its own
 * ledger and only a holder's stamp counts. A run that holds nothing stamps
 * nothing, so a caller may release as often as it likes.
 *
 * A run whose request is open keeps the token whatever it does. The hold from
 * the request to the merge covers a CI red and the repair round it earns, and
 * releasing there buys nothing: the request is open, so a competing merge under
 * it costs the branch update it was going to cost (ADR-0033).
 * @param {{paths: object, runId: string, store: object}} ctx
 * @param {'re-verdict'|'park'} reason
 * @returns {boolean} whether the run gave the token back
 */
export function releaseShipToken(ctx, reason) {
  assertReleaseReason(reason);
  const mine = tokenPosition(readEvents(runLedgerPath(ctx.paths, ctx.runId)));
  if (mine.state !== 'holding' || mine.requested) return false;
  ctx.store.append('ship-token', { actor: ACTOR, state: 'released', reason });
  return true;
}

/**
 * The token of one project across its open runs: who holds it, who waits, and
 * which waiter takes it next. Closed runs hold nothing — the archive is not
 * read at all, because a run that is over can neither merge nor wait.
 *
 * The order is the order the waiters queued, and a tie falls to the lower run
 * id: two runs are never handed the same position, and a restart derives the
 * order it derived before.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @returns {{holder: string|null, waiting: string[], next: string|null}}
 */
export function shipTokenState(paths, project) {
  let holder = null;
  let holderSince = null;
  const waiting = [];
  for (const { runId, events } of listLiveRuns(paths, { project })) {
    const pos = tokenPosition(events);
    if (pos.closed) continue;
    if (pos.state === 'holding') {
      // Two holders is a state no route produces; the tie-break is here so a
      // ledger set that somehow carries one still resolves the same way twice.
      if (holder === null || earlier(pos.heldSince, holderSince, runId, holder)) {
        holder = runId;
        holderSince = pos.heldSince;
      }
    } else if (pos.state === 'waiting') {
      waiting.push({ runId, since: pos.queuedAt });
    }
  }
  waiting.sort((a, b) => (earlier(a.since, b.since, a.runId, b.runId) ? -1 : 1));
  const queue = waiting.map((w) => w.runId);
  return { holder, waiting: queue, next: queue[0] ?? null };
}

/** Queue order: the earlier stamp, then the lower run id. */
function earlier(aTs, bTs, aId, bId) {
  if (aTs !== bTs) return String(aTs) < String(bTs);
  return aId < bId;
}
