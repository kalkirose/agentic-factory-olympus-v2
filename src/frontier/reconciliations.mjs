// Owed decision-record reconciliations: the shipped story runs that owed a
// record rewrite and did not write it themselves, minus those a reconciliation
// run already carries. A story run judges its own diff before it ships and
// rewrites the records on its own branch (ADR-0026); this set is the fallback,
// and it holds the ships where that rewrite could not be made.
//
// The set is derived from the run ledgers at every sweep and stored nowhere.
// The shipping run's `reconciliation-judged` stamp with a ticket on it says
// what is owed, the reconciliation runs' own launch stamps say what has been
// answered (the owed-repairs pattern, ADR-0024). A daemon that dies between
// the ticket and the launch owes the same reconciliation after the restart.
import { listRunEvents } from '../telemetry/readers.mjs';
import { TICKETED_LANES } from '../lanes/records-stage.mjs';

/**
 * The story-run ids some reconciliation run already carries, open or closed.
 *
 * Both ticketed lanes are read. A reconciliation launches on the records lane
 * now, and the runs launched before it ran on the repair lane: an owed set that
 * read one lane would owe every reconciliation the other lane answered.
 */
export function launchedReconciliations(paths) {
  const ids = new Set();
  for (const { lane, events } of listRunEvents(paths)) {
    if (!TICKETED_LANES.includes(lane)) continue;
    const launch = events.find((e) => e.event === 'run-launched');
    if (typeof launch?.reconcilesRunId === 'string') ids.add(launch.reconcilesRunId);
  }
  return ids;
}

/**
 * The owed reconciliations of one project, oldest ship first. Owed = closed
 * shipped, judged owed with a ticket, and named by no reconciliation run's
 * launch. The ticket is written at the close of the shipping run, and only
 * where the records did not ride its own merge. A run that launched and failed
 * is not owed again: a reconciliation that cannot land is a console decision,
 * like a spent card.
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

/**
 * The launch payload of one owed reconciliation. The ticket is the lane's spec.
 *
 * The lane is `records`: the ticket names decision records and nothing else, so
 * there is no code to fix, no suite to run and no code verdict to render, and
 * the repair lane would refuse it at the door (ADR-0074).
 */
export function reconciliationLaunch(owed) {
  return {
    project: owed.project,
    lane: 'records',
    ticket: owed.ticket,
    reconcilesRunId: owed.runId,
  };
}
