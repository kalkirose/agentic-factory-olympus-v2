// Owed breach repairs: the escapes the harness ticketed and has not yet put
// a repair run against. The set is derived from the two ledgers at every
// sweep and stored nowhere — the escapes ledger says what was ticketed, the
// repair runs' own launch stamps say what has been answered. A daemon that
// dies between the ticket and the launch owes the same repair after the
// restart, and one that dies after the launch owes nothing, without either
// side keeping a queue file honest.
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
 * fixed, and named by no repair run's launch. A run that launched and failed
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
