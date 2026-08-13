// Daemon home layout. All stores sit under this one root — the command
// center's read-only server and every console read from here. Run worktrees
// are the one store that may sit elsewhere: the instance config's
// `worktreeRoot` moves them off the home, which is how a machine with a low
// path ceiling keeps a run's deepest test artifact inside it.
import { mkdirSync } from 'node:fs';
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
    // The one accessor for the run-workspace root. Nothing derives a worktree
    // path a second way — `isolation/worktrees.mjs` joins the run id onto this.
    worktrees: config?.worktreeRoot ?? join(home, 'worktrees'),
    evalReports: join(home, 'eval'),
    lock: join(home, 'daemon.lock'),
  };
}

/**
 * Creates the daemon home directory tree, the run-workspace root included.
 * Idempotent.
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
    paths.worktrees,
    paths.evalReports,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
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
