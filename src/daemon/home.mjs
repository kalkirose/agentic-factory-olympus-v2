// Daemon home layout. All stores sit under this one root — the command
// center's read-only server and every console read from here.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function homePaths(home) {
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
    worktrees: join(home, 'worktrees'),
    evalReports: join(home, 'eval'),
    lock: join(home, 'daemon.lock'),
  };
}

/** Creates the daemon home directory tree. Idempotent. */
export function scaffoldHome(home) {
  const paths = homePaths(home);
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
