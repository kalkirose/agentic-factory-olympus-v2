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
