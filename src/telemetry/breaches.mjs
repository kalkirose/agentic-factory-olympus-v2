// The red-merge breach record and the escape fixes that answer it. A breach
// is stamped on the run that merged red; its owning event is the fix of every
// escape it ticketed, and that fix lands in another ledger, on another run,
// long after the breached run closed. The sweep the engine runs over one run
// ledger cannot reach across that gap, so this does (ADR-0015).
import { readEvents } from '../ledger/ledger.mjs';
import { runLedgerPath, archivedRunLedgerPath } from '../daemon/home.mjs';
import { readEscapeSet } from './escapes.mjs';
import { resolveClosedRun } from './stores.mjs';

const ACTOR = 'daemon';
// The resolution names the route the fix came by, so a breach a human retired
// out of band never reads as a repair the factory ran.
const OWNERS = { repair: 'escape-fixed', operator: 'escape-marked-fixed' };

/**
 * Resolves the red-merge breach one fixed escape belonged to, once every
 * escape that breach ticketed is fixed. Both fix routes settle a breach: the
 * strip asks whether the defect is still in the product, and it is out either
 * way.
 *
 * Best effort by design. The breach record is a fact whatever happens here,
 * and neither a repair that shipped nor a mark an operator made fails on the
 * bookkeeping of the run they answer.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {{seq: number, refs?: object, fixedBy?: string}} escape the fixed
 *   entry from `readEscapeSet`
 * @param {{exceptRunId?: string}} [opts] the run doing the settling, when a
 *   run is: its own ledger belongs to the engine, never to this.
 */
export function settleBreachOf(paths, escape, { exceptRunId } = {}) {
  const originRunId = escape.refs?.runId;
  if (typeof originRunId !== 'string' || originRunId === exceptRunId) return;
  try {
    const set = readEscapeSet(paths.escapesLedger);
    const fixed = new Set(set.filter((e) => e.fixed).map((e) => e.seq));
    const events = originEvents(paths, originRunId);
    // Only a run that is over: an open run belongs to the engine, and two
    // writers on one live ledger would collide on seq.
    if (!events.some((e) => e.event === 'run-closed')) return;
    const resolved = new Set(events.filter((e) => e.event === 'resolved').map((e) => e.resolves));
    for (const e of events) {
      if (e.event !== 'red-merge-breach' || resolved.has(e.seq)) continue;
      // A breach that ticketed nothing has no repair to wait for, and no fix
      // can answer it. That one stays for the human.
      const ticketed = e.ticketed ?? [];
      if (ticketed.length === 0 || !ticketed.every((seq) => fixed.has(seq))) continue;
      resolveClosedRun(paths, originRunId, {
        actor: ACTOR,
        resolves: e.seq,
        owner: OWNERS[escape.fixedBy] ?? OWNERS.repair,
      });
    }
  } catch {
    // The console can still resolve the record by hand.
  }
}

/** A closed run's events, live path first, then the archive. */
function originEvents(paths, runId) {
  const live = readEvents(runLedgerPath(paths, runId));
  return live.length > 0 ? live : readEvents(archivedRunLedgerPath(paths, runId));
}
