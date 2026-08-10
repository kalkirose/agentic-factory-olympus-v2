// Telemetry stores compose the ledger primitive with the stream indexes.
// A stream-classed append lands in its source ledger and, in the same call,
// as a pointer entry in the matching index — indexing holds by construction,
// never by call-site discipline.
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger, readEvents } from '../ledger/ledger.mjs';
import {
  RUN_EVENTS,
  INSTANCE_EVENTS,
  ESCAPES_EVENTS,
  LOUD_EVENTS,
  streamOf,
} from '../ledger/registry.mjs';
import { runLedgerPath, archivedRunLedgerPath } from '../daemon/home.mjs';
import { appendStreamEntry } from './streams.mjs';

// Loud items and breaches take a paired `resolved` append; nothing else does.
export const RESOLVABLE_EVENTS = new Set([...LOUD_EVENTS, 'tripwire-breach']);

export class TelemetryStore {
  /**
   * @param {object} paths daemon home paths
   * @param {string} id source-ledger id as written to stream indexes
   *   ('instance', 'escapes', or 'run:<runId>')
   * @param {string} ledgerPath
   * @param {Set<string>} allowedEvents
   */
  constructor(paths, id, ledgerPath, allowedEvents) {
    this.paths = paths;
    this.id = id;
    this.ledger = new Ledger(ledgerPath, { allowedEvents });
  }

  /**
   * Appends one event. A stream-classed event requires a `gist` payload
   * field; the same call appends the pointer entry to the stream index.
   */
  append(event, fields) {
    if (streamOf(event) && (typeof fields.gist !== 'string' || fields.gist.length === 0)) {
      throw new Error(`stream-classed event ${event} requires a one-line gist`);
    }
    const line = this.ledger.append(event, fields);
    if (line.stream) {
      appendStreamEntry(this.paths, line.stream, {
        ledger: this.id,
        seq: line.seq,
        ts: line.ts,
        event: line.event,
        gist: fields.gist,
      });
    }
    return line;
  }

  /**
   * Appends the paired `resolved` event for a loud item or a breach in this
   * ledger. Refuses an unknown target, a non-resolvable event, and a double
   * resolution.
   * @param {{actor: string, resolves: number, [k: string]: unknown}} fields
   */
  resolve({ actor, resolves, ...rest }) {
    if (!Number.isInteger(resolves)) throw new Error('resolve requires an integer resolves seq');
    const events = readEvents(this.ledger.path);
    const target = events.find((e) => e.seq === resolves);
    if (!target) throw new Error(`no event at seq ${resolves} in ${this.id}`);
    if (!RESOLVABLE_EVENTS.has(target.event)) {
      throw new Error(`event ${target.event} does not take a resolution`);
    }
    if (events.some((e) => e.event === 'resolved' && e.resolves === resolves)) {
      throw new Error(`seq ${resolves} in ${this.id} is already resolved`);
    }
    return this.append('resolved', { actor, resolves, resolvedEvent: target.event, ...rest });
  }

  close() {
    this.ledger.close();
  }
}

/** @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths */
export function openInstanceStore(paths) {
  return new TelemetryStore(paths, 'instance', paths.instanceLedger, INSTANCE_EVENTS);
}

/** @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths */
export function openEscapesStore(paths) {
  return new TelemetryStore(paths, 'escapes', paths.escapesLedger, ESCAPES_EVENTS);
}

/** @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths */
export function openRunStore(paths, runId) {
  return new TelemetryStore(paths, `run:${runId}`, runLedgerPath(paths, runId), RUN_EVENTS);
}

/**
 * Resolves a loud item in a run ledger the engine no longer holds open —
 * live path first, then the archive. The caller routes open runs through
 * the engine; two writers on one live ledger would collide on seq.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {{actor: string, resolves: number, [k: string]: unknown}} fields
 */
export function resolveClosedRun(paths, runId, fields) {
  const live = runLedgerPath(paths, runId);
  const path = existsSync(live) ? live : archivedRunLedgerPath(paths, runId);
  if (!existsSync(path)) throw new Error(`no ledger for run ${runId}`);
  const store = new TelemetryStore(paths, `run:${runId}`, path, RUN_EVENTS);
  try {
    return store.resolve(fields);
  } finally {
    store.close();
  }
}

/**
 * Moves a closed run's directory — ledger and artifacts together — to the
 * archive. Refuses an open run and an already-archived run id. Close the
 * run's store first; an open file handle blocks the move on Windows.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 */
export function archiveRun(paths, runId) {
  const liveDir = join(paths.runs, runId);
  const archiveDir = join(paths.archivedRuns, runId);
  if (existsSync(archiveDir)) throw new Error(`run ${runId} is already archived`);
  const events = readEvents(runLedgerPath(paths, runId));
  if (events.length === 0) throw new Error(`run ${runId} has no ledger`);
  if (!events.some((e) => e.event === 'run-closed')) {
    throw new Error(`run ${runId} is open; archive follows run-closed`);
  }
  renameSync(liveDir, archiveDir);
  return archivedRunLedgerPath(paths, runId);
}
