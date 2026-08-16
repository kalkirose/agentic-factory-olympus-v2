// The per-project ship token: the one run of a project that may open or merge
// its pull request. Runs parallelize through every stage before the merge; the
// merge itself is serial, because a protected branch that requires its
// requests current makes every concurrent pair pay for the other's merge — a
// CI round at least, a dev pass when the two sides touched the same lines
// (ADR-0033).
//
// The token is derived, never stored. A run that stamped `ship-token`
// (acquired) or `pr-opened`, and has not stamped `merged` or closed, holds it;
// every other open run of the project that stamped a wait is in the queue,
// ordered by the stamp it queued with. So a restart re-derives the same holder
// and the same order from the same ledgers, and a token nobody wrote down can
// be neither lost nor duplicated.
import { readEvents } from '../ledger/ledger.mjs';
import { runLedgerPath } from '../daemon/home.mjs';
import { listLiveRuns } from '../telemetry/readers.mjs';

const ACTOR = 'daemon';

/**
 * One run's position, from its own ledger alone. The project is not read here
 * — the caller selects the ledgers of one project before it folds them.
 * @returns {{closed: boolean, state: null|'waiting'|'holding'|'done',
 *   queuedAt: string|null, heldSince: string|null}}
 */
export function tokenPosition(events) {
  let closed = false;
  let state = null;
  let queuedAt = null;
  let heldSince = null;
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
        }
        break;
      case 'pr-opened':
        state = 'holding';
        heldSince ??= e.ts;
        break;
      case 'merged':
        state = 'done';
        break;
      default:
        break;
    }
  }
  return { closed, state, queuedAt, heldSince };
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
