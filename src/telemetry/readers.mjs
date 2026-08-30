// Pull-only reader API over the stores. Every query answers from the files
// alone — console sessions, the command center, the tripwire watcher, and
// the eval seat all read through here; none of them holds daemon state.
import { existsSync, readdirSync } from 'node:fs';
import { readEvents } from '../ledger/ledger.mjs';
import { runLedgerPath, archivedRunLedgerPath } from '../daemon/home.mjs';
import { streamIndexPath, readStreamIndex } from './streams.mjs';

/**
 * Resolves a stream-index ledger id to its file path. A run ledger resolves
 * to the live location first, then the archive.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 */
export function ledgerPathFor(paths, id) {
  if (id === 'instance') return paths.instanceLedger;
  if (id === 'escapes') return paths.escapesLedger;
  if (id.startsWith('run:')) {
    const runId = id.slice('run:'.length);
    const live = runLedgerPath(paths, runId);
    return existsSync(live) ? live : archivedRunLedgerPath(paths, runId);
  }
  throw new Error(`unknown ledger id: ${id}`);
}

/**
 * Reads a ledger filtered by event name and seq floor.
 * @param {{events?: Iterable<string>, sinceSeq?: number}} filter
 */
export function filterEvents(path, { events, sinceSeq = 0 } = {}) {
  const wanted = events ? new Set(events) : null;
  return readEvents(path).filter(
    (e) => e.seq > sinceSeq && (wanted === null || wanted.has(e.event)),
  );
}

/**
 * Open items on a stream index: entries whose source ledger holds no
 * `resolved` append linked to their seq.
 * @param {'queued'|'loud'} stream
 */
export function openStreamItems(paths, stream) {
  const entries = readStreamIndex(streamIndexPath(paths, stream));
  const resolvedByLedger = new Map();
  const open = [];
  for (const entry of entries) {
    if (!resolvedByLedger.has(entry.ledger)) {
      const resolutions = filterEvents(ledgerPathFor(paths, entry.ledger), {
        events: ['resolved'],
      });
      resolvedByLedger.set(entry.ledger, new Set(resolutions.map((e) => e.resolves)));
    }
    if (!resolvedByLedger.get(entry.ledger).has(entry.seq)) open.push(entry);
  }
  return open;
}

/** Open loud items across all ledgers. Cutover close reads "no open loud item" from this. */
export function openLoud(paths) {
  return openStreamItems(paths, 'loud');
}

/** Open tripwire breaches (the resolvable part of the queued stream). */
export function openBreaches(paths) {
  return openStreamItems(paths, 'queued').filter((e) => e.event === 'tripwire-breach');
}

/**
 * Workspaces a release could not delete and no sweep has cleared yet, by run
 * id. The records are quiet, so they carry no stream entry and the query reads
 * the instance ledger itself. One run holds at most one open record; a later
 * record for the same run replaces the view of it, which is what a reader
 * wants — the last statement about a directory is the true one.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @returns {Map<string, object>}
 */
export function openWorkspaceLeftovers(paths) {
  const events = readEvents(paths.instanceLedger);
  const resolved = new Set(events.filter((e) => e.event === 'resolved').map((e) => e.resolves));
  const open = new Map();
  for (const event of events) {
    if (event.event !== 'workspace-leftover' || resolved.has(event.seq)) continue;
    open.set(event.runId, event);
  }
  return open;
}

/**
 * All run ledgers, live and archived, optionally filtered by the launching
 * project and lane. Each entry: runId, archived flag, project, lane, and the
 * full event list. A ledger without a `run-launched` stamp matches nothing.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {{project?: string, lane?: string}} [filter]
 */
export function listRunEvents(paths, { project, lane } = {}) {
  const out = [];
  for (const { dir, archived } of [
    { dir: paths.runs, archived: false },
    { dir: paths.archivedRuns, archived: true },
  ]) {
    for (const runId of runDirs(dir)) {
      const path = archived ? archivedRunLedgerPath(paths, runId) : runLedgerPath(paths, runId);
      const events = readEvents(path);
      const launch = events.find((e) => e.event === 'run-launched');
      if (!launch) continue;
      if (project !== undefined && launch.project !== project) continue;
      if (lane !== undefined && launch.lane !== lane) continue;
      out.push({ runId, archived, project: launch.project, lane: launch.lane, events });
    }
  }
  return out;
}

/**
 * Live run ledgers, optionally filtered by the launching project. The archive
 * is not read: the callers here ask about runs that can still act, and the
 * archive grows for the life of the instance while a closed run answers
 * nothing. A ledger without a `run-launched` stamp matches nothing.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {{project?: string}} [filter]
 */
export function listLiveRuns(paths, { project } = {}) {
  const out = [];
  for (const runId of runDirs(paths.runs)) {
    const events = readEvents(runLedgerPath(paths, runId));
    const launch = events.find((e) => e.event === 'run-launched');
    if (!launch) continue;
    if (project !== undefined && launch.project !== project) continue;
    out.push({ runId, project: launch.project, lane: launch.lane, events });
  }
  return out;
}

/**
 * Shipped story-lane runs, live and archived, in ship order (by the `merged`
 * stamp). Each entry: runId, project, ts of the merge, archived flag.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 */
export function listShips(paths) {
  const ships = [];
  for (const { runId, archived, project, events } of listRunEvents(paths, { lane: 'story' })) {
    const merged = events.find((e) => e.event === 'merged');
    if (merged) ships.push({ runId, project, ts: merged.ts, archived });
  }
  return ships.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/**
 * Merged ships that carried their certification over a moved base instead of
 * earning it again (ADR-0056), live and archived, in ship order. Each entry
 * names the run, the request and the merge commit, the fast-path record's own
 * seq, the default-branch commits it examined, and the declaration version it
 * was decided under.
 *
 * A run whose fast-path record is a refusal is not one of these: it took the
 * full re-verdict, like every ship before the flag existed.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 */
export function listFastPathShips(paths, { project } = {}) {
  const ships = [];
  for (const { runId, archived, project: owner, events } of listRunEvents(paths, { project })) {
    const fast = events.filter((e) => e.event === 'fast-path-ship' && e.taken === true).pop();
    if (!fast) continue;
    const merged = events.filter((e) => e.event === 'merged').pop();
    if (!merged) continue;
    ships.push({
      runId,
      project: owner,
      archived,
      ts: merged.ts,
      seq: fast.seq,
      pr: merged.pr ?? null,
      mergeSha: merged.mergeSha ?? null,
      commits: fast.commits ?? [],
      declaration: fast.declaration ?? null,
    });
  }
  return ships.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/**
 * The fast-path ship one merge came from, or null. A request number and a
 * merge commit are the two names an operator reporting a defect can hold, and
 * either one is enough: the attribution is derived from the ledgers, never
 * from what the operator believed about the ship.
 * @param {{project?: string, pr?: number, mergeSha?: string}} named
 */
export function fastPathShipOf(paths, { project, pr, mergeSha } = {}) {
  const ships = listFastPathShips(paths, { project });
  return (
    ships.find(
      (ship) =>
        (pr !== undefined && pr !== null && ship.pr === pr) ||
        (typeof mergeSha === 'string' && mergeSha.length > 0 && ship.mergeSha === mergeSha),
    ) ?? null
  );
}

/**
 * Story-lane run history per story key, live and archived. The frontier
 * classifies cards from this: `shipped` counts runs closed shipped, `spent`
 * counts runs closed failed or killed, `open` counts the rest. A run whose
 * key never landed (no `storyKey` payload, no freeze) matches no card.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @returns {Map<string, {open: number, shipped: number, spent: number, runIds: string[]}>}
 */
export function storyRunsByKey(paths) {
  const map = new Map();
  for (const { runId, events } of listRunEvents(paths, { lane: 'story' })) {
    const launch = events.find((e) => e.event === 'run-launched');
    const key = launch.storyKey ?? events.find((e) => e.event === 'freeze')?.storyKey ?? null;
    if (!key) continue;
    const entry = map.get(key) ?? { open: 0, shipped: 0, spent: 0, runIds: [] };
    const closed = events.find((e) => e.event === 'run-closed');
    if (!closed) entry.open++;
    else if (closed.state === 'shipped') entry.shipped++;
    else entry.spent++;
    entry.runIds.push(runId);
    map.set(key, entry);
  }
  return map;
}

function runDirs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}
