// What a run spent, derived from its ledger alone. Cost reaches a ledger by
// three routes and they overlap, so summing every `cost` field counts the same
// dollars more than once:
//
//   - `seat-progress` carries the cumulative cost of the invocation to date.
//     A seat that runs to a terminal stamp writes many of them.
//   - `seat-report`, `seat-failure` and `seat-terminated` carry the final
//     figure for the invocation that ended. It repeats the last snapshot.
//   - an invocation that ended without a terminal stamp — a corrective
//     re-prompt's first dispatch, a rejected model, a child the daemon lost —
//     left its spend in its last snapshot and nowhere else.
//
// One rule settles all three: per seat invocation, the terminal stamp
// supersedes the snapshots, and an invocation with no terminal stamp
// contributes its last snapshot. Every cost figure the harness shows is
// derived here, so no two readers can disagree about what a run cost.
import { SEAT_TERMINAL_EVENTS } from './registry.mjs';

// Dollars, summed to the micro-dollar. The rounding removes binary-fraction
// noise from the addition; it is not a display precision.
const SCALE = 1e6;

/**
 * The total cost of a run, in US dollars.
 * @param {Array<object>} events one ledger's events, in order
 * @returns {number}
 */
export function runCost(events) {
  let total = 0;
  // seat id → the last snapshot of that seat's open invocation.
  const open = new Map();
  const settle = (seat) => {
    if (!open.has(seat)) return;
    total += open.get(seat);
    open.delete(seat);
  };
  for (const e of events) {
    if (e.event === 'seat-spawned') {
      // A second spawn under an open invocation means the first one ended
      // where the ledger goes silent. Its last snapshot is what it spent.
      settle(e.seat);
      open.set(e.seat, 0);
    } else if (e.event === 'seat-progress') {
      // A progress line names its seat in `actor` — the seat writes its own.
      if (typeof e.cost === 'number') open.set(e.actor, e.cost);
    } else if (SEAT_TERMINAL_EVENTS.has(e.event)) {
      if (typeof e.cost === 'number') {
        total += e.cost;
        open.delete(e.seat);
      } else {
        // A terminal stamp without a figure (a rejected model, an invalid
        // report) settles on the snapshots the invocation did leave.
        settle(e.seat);
      }
    }
  }
  for (const seat of [...open.keys()]) settle(seat);
  return Math.round(total * SCALE) / SCALE;
}
