// Owed decision-record reconciliations: the shipped story runs whose
// close-out judgment named records this diff implements or contradicts,
// minus those a reconciliation run already carries. The set is derived from
// the run ledgers at every sweep and stored nowhere — the shipping run's
// `reconciliation-judged` stamp says what is owed, the reconciliation runs'
// own launch stamps say what has been answered (the owed-repairs pattern,
// ADR-0024). A daemon that dies between the judgment and the launch owes the
// same reconciliation after the restart.
import { listRunEvents } from '../telemetry/readers.mjs';

/** The story-run ids some reconciliation run already carries, open or closed. */
export function launchedReconciliations(paths) {
  const ids = new Set();
  for (const { events } of listRunEvents(paths, { lane: 'repair' })) {
    const launch = events.find((e) => e.event === 'run-launched');
    if (typeof launch?.reconcilesRunId === 'string') ids.add(launch.reconcilesRunId);
  }
  return ids;
}

/**
 * The owed reconciliations of one project, oldest ship first. Owed = closed
 * shipped, judged owed with a ticket, and named by no reconciliation run's
 * launch. A run that launched and failed is not owed again: a reconciliation
 * that cannot land is a console decision, like a spent card.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 */
export function owedReconciliations(paths, project) {
  const launched = launchedReconciliations(paths);
  const owed = [];
  for (const { runId, events } of listRunEvents(paths, { project, lane: 'story' })) {
    if (launched.has(runId)) continue;
    const judged = events.find(
      (e) => e.event === 'reconciliation-judged' && e.owed === true && typeof e.ticket === 'string',
    );
    if (!judged) continue;
    const closed = events.find((e) => e.event === 'run-closed');
    if (closed?.state !== 'shipped') continue;
    owed.push({ runId, project, ticket: judged.ticket, closedTs: closed.ts });
  }
  return owed.sort((a, b) => (a.closedTs < b.closedTs ? -1 : a.closedTs > b.closedTs ? 1 : 0));
}

/** The launch payload of one owed reconciliation. The ticket is the lane's spec. */
export function reconciliationLaunch(owed) {
  return {
    project: owed.project,
    lane: 'repair',
    ticket: owed.ticket,
    reconcilesRunId: owed.runId,
  };
}
