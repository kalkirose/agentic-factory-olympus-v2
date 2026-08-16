// Owed breach repairs: the escapes the harness ticketed and has not yet put
// a repair run against. The set is derived from the two ledgers at every
// sweep and stored nowhere — the escapes ledger says what was ticketed, the
// repair runs' own launch stamps say what has been answered. A daemon that
// dies between the ticket and the launch owes the same repair after the
// restart, and one that dies after the launch owes nothing, without either
// side keeping a queue file honest.
import { resolve } from 'node:path';
import { readEscapeSet } from '../telemetry/escapes.mjs';
import { listRunEvents } from '../telemetry/readers.mjs';

/** The escape seqs some repair run already carries, closed or still open. */
export function repairedEscapes(paths) {
  const seqs = new Set();
  for (const { events } of listRunEvents(paths, { lane: 'repair' })) {
    const launch = events.find((e) => e.event === 'run-launched');
    if (Number.isInteger(launch?.escapeSeq)) seqs.add(launch.escapeSeq);
  }
  return seqs;
}

/**
 * The owed repairs of one project, oldest escape first. Owed = ticketed, not
 * fixed, and named by no repair run's launch. Not fixed covers both ends of
 * the lifecycle: a repair run's close-out and an operator's fixed-mark retire
 * an escape the same way here, because the owed set asks whether the defect is
 * still in the product and not who took it out. A run that launched and failed
 * is not owed again: a repair that cannot land is a console decision, like a
 * spent card.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 */
export function owedRepairs(paths, project) {
  const launched = repairedEscapes(paths);
  return readEscapeSet(paths.escapesLedger)
    .filter((e) => e.ticket && !e.fixed && !launched.has(e.seq))
    .filter((e) => project === undefined || e.refs?.project === project)
    .sort((a, b) => a.seq - b.seq);
}

/** The launch payload of one owed repair. The ticket is the lane's spec. */
export function repairLaunch(escape) {
  return {
    project: escape.refs.project,
    lane: 'repair',
    ticket: escape.ticket,
    // The linkage close-out reads back: the ship stamps `escape-fixed`
    // against this seq, with this attribution.
    escapeSeq: escape.seq,
    attribution: escape.attribution,
  };
}

/**
 * The escape a console repair launch carries. The sweep builds the linkage
 * into its own payload; a console launch says it with an escape number, or
 * the ticket path says it when an open escape already names that file. Either
 * way the value rides the run payload and the close-out fix-back reads it
 * back from there, so one repair stamps one escape whoever launched it.
 *
 * Returns null when nothing names an escape — a repair against a ticket the
 * operator wrote by hand is a legitimate run with no escape behind it.
 *
 * Refuses a number that names no open escape rather than launching without
 * the linkage: an operator who names a seq is stating what this run repairs,
 * and a wrong seq either loses the linkage in silence or stamps a fix onto an
 * escape nobody repaired.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {{ticket?: string, escape?: number}} intent
 * @returns {{seq: number, attribution: string}|null}
 */
export function launchEscape(paths, { ticket, escape } = {}) {
  const set = readEscapeSet(paths.escapesLedger);
  if (escape !== undefined) {
    if (!Number.isInteger(escape)) {
      throw new Error(`an escape is the integer seq of its ledger record (got: ${escape})`);
    }
    const target = set.find((e) => e.seq === escape);
    if (!target) throw new Error(`no escape at seq ${escape}${openList(set)}`);
    if (target.fixed) {
      throw new Error(
        `escape ${escape} is already fixed (${target.fixedBy})${openList(set)}`,
      );
    }
    return { seq: target.seq, attribution: target.attribution };
  }
  // A repo-relative ticket names a file in the run worktree, and no escape
  // record names one of those, so the comparison simply finds nothing.
  const named = set.find((e) => !e.fixed && samePath(e.ticket, ticket));
  return named ? { seq: named.seq, attribution: named.attribution } : null;
}

/** The open escapes, for a refusal that says what the operator could mean. */
function openList(set) {
  const open = set.filter((e) => !e.fixed).map((e) => e.seq);
  return open.length > 0 ? ` — open escapes: ${open.join(', ')}` : ' — no escape is open';
}

/**
 * Two paths naming one file. Windows compares its paths without case, and the
 * ticket an operator types is rarely cased like the ledger's copy of it.
 */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}
