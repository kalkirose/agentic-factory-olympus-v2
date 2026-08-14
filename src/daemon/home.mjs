// Daemon home layout. All stores sit under this one root — the command
// center's read-only server and every console read from here. Run worktrees
// are the one store that may sit elsewhere: the instance config's
// `worktreeRoot` moves them off the home, which is how a machine with a low
// path ceiling keeps a run's deepest test artifact inside it.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} home
 * @param {{worktreeRoot?: string}} [config] the instance config, once it is
 *   loaded. Without it the layout is the home's own default, so a paths
 *   object built for a read — a console, the center's server — names the
 *   default worktree root. Only the daemon provisions, and it builds its
 *   paths from the config it read.
 */
export function homePaths(home, config) {
  return {
    home,
    instanceConfig: join(home, 'instance.json'),
    instanceLedger: join(home, 'instance.ledger.jsonl'),
    escapesLedger: join(home, 'escapes.ledger.jsonl'),
    streams: join(home, 'streams'),
    queuedStream: join(home, 'streams', 'queued.jsonl'),
    loudStream: join(home, 'streams', 'loud.jsonl'),
    runs: join(home, 'runs'),
    archive: join(home, 'archive'),
    archivedRuns: join(home, 'archive', 'runs'),
    control: join(home, 'control'),
    controlDone: join(home, 'control', 'done'),
    controlRejected: join(home, 'control', 'rejected'),
    clones: join(home, 'clones'),
    // Repair tickets the harness writes for itself. They outlive the run that
    // wrote them and the run that reads them, so they live on the home rather
    // than in either run directory.
    tickets: join(home, 'tickets'),
    // The one accessor for the run-workspace root. Nothing derives a worktree
    // path a second way — `isolation/worktrees.mjs` joins the run id onto this.
    worktrees: config?.worktreeRoot ?? join(home, 'worktrees'),
    evalReports: join(home, 'eval'),
    lock: join(home, 'daemon.lock'),
  };
}

/**
 * Creates the daemon home directory tree, the run-workspace root included,
 * and the escapes ledger. Idempotent.
 * @param {string} home
 * @param {{worktreeRoot?: string}} [config]
 */
export function scaffoldHome(home, config) {
  const paths = homePaths(home, config);
  for (const dir of [
    paths.home,
    paths.streams,
    paths.runs,
    paths.archivedRuns,
    paths.control,
    paths.controlDone,
    paths.controlRejected,
    paths.clones,
    paths.tickets,
    paths.worktrees,
    paths.evalReports,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  // The escapes ledger exists by construction, not by its first writer. It is
  // instance-scoped and rarely written, so a home that never breached had no
  // file at all — and the escapes-per-story metric read that absence as a
  // healthy zero while measuring nothing. An empty ledger is a measured zero.
  // The append never truncates, so a home with history keeps it.
  appendFileSync(paths.escapesLedger, '');
  return paths;
}

/**
 * The path of one escape's repair ticket. The escape seq names it: the ticket
 * is written once per escape, and the sweep that later launches the repair
 * derives nothing it does not read from the escapes ledger.
 * @param {ReturnType<typeof homePaths>} paths
 */
export function repairTicketPath(paths, escapeSeq) {
  return join(paths.tickets, `escape-${escapeSeq}.md`);
}

/**
 * The path of one shipped run's reconciliation ticket. The shipping run's id
 * names it: the close-out judgment writes it once, and the sweep that later
 * launches the reconciliation derives nothing it does not read from that
 * run's ledger.
 * @param {ReturnType<typeof homePaths>} paths
 */
export function reconcileTicketPath(paths, runId) {
  return join(paths.tickets, `reconcile-${runId}.md`);
}

/** @param {ReturnType<typeof homePaths>} paths */
export function runLedgerPath(paths, runId) {
  return join(paths.runs, runId, 'ledger.jsonl');
}

/** @param {ReturnType<typeof homePaths>} paths */
export function archivedRunLedgerPath(paths, runId) {
  return join(paths.archivedRuns, runId, 'ledger.jsonl');
}

/**
 * The named ledger path for a seat's JSON report — a run artifact that
 * archives with the run. The orchestrator names it in the seat prompt.
 * @param {ReturnType<typeof homePaths>} paths
 */
export function runReportPath(paths, runId, name) {
  return join(paths.runs, runId, 'reports', `${name}.json`);
}
