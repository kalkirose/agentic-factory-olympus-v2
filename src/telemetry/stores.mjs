// Telemetry stores compose the ledger primitive with the stream indexes.
// A stream-classed append lands in its source ledger and, in the same call,
// as a pointer entry in the matching index — indexing holds by construction,
// never by call-site discipline.
//
// The index is written first, and the ledger line second. The order is the
// guarantee a reader depends on: nothing is readable in a ledger before it is
// findable on its stream, so a park a reader can see is a park the queue can
// answer for. The other direction is the harmless one — a pointer whose record
// is not written yet names nothing, and every reader of an index joins to the
// source record and skips a pointer that finds none.
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
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

// Loud items, breaches, baseline proposals, eval reviews, and the quiet
// records that name a job the harness owes itself take a paired `resolved`
// append; nothing else does.
export const RESOLVABLE_EVENTS = new Set([
  ...LOUD_EVENTS,
  'tripwire-breach',
  'stage-overrun',
  'baseline-proposal',
  'eval-review',
  'workspace-leftover',
]);

export class TelemetryStore {
  /**
   * @param {object} paths daemon home paths
   * @param {string} id source-ledger id as written to stream indexes
   *   ('instance', 'escapes', or 'run:<runId>')
   * @param {string} ledgerPath
   * @param {Set<string>} allowedEvents
   * @param {{onAppend?: (line: object, ledger: string) => void,
   *   onLate?: (late: {ledger: string, event: string, actor?: string,
   *   seat?: string}) => void}} [opts]
   *   onAppend fires after every append, with the source-ledger id — the
   *   tripwire watcher's and the notifier's event key. onLate fires instead,
   *   for an append that arrived after this store closed. Both hooks own
   *   their errors; a failing hook never fails the append.
   */
  constructor(paths, id, ledgerPath, allowedEvents, { onAppend, onLate } = {}) {
    this.paths = paths;
    this.id = id;
    this.allowedEvents = allowedEvents;
    this.ledger = new Ledger(ledgerPath, { allowedEvents });
    this.onAppend = onAppend ?? null;
    this.onLate = onLate ?? null;
    this.closed = false;
  }

  /**
   * Appends one event. A stream-classed event requires a `gist` payload
   * field; the same call appends the pointer entry to the stream index.
   *
   * An append that arrives after this store closed lands nowhere and answers
   * null. The close is the deliberate end of a ledger — a run's terminal
   * state, or the daemon's own stop — and a stamp that comes in behind it is
   * a child the close already terminated, a poll that was in flight, or a
   * callback the close outran. None of those is news, and none of them is
   * worth the instance the throw used to cost (ADR-0015). Everything else a
   * bad append can be still throws.
   */
  append(event, fields) {
    if (streamOf(event) && (typeof fields.gist !== 'string' || fields.gist.length === 0)) {
      throw new Error(`stream-classed event ${event} requires a one-line gist`);
    }
    if (this.closed) return this.dropLate(event, fields);
    const line = this.ledger.compose(event, fields);
    if (line.stream) {
      appendStreamEntry(this.paths, line.stream, {
        ledger: this.id,
        seq: line.seq,
        ts: line.ts,
        event: line.event,
        gist: fields.gist,
      });
    }
    this.ledger.commit(line);
    if (this.onAppend) {
      try {
        this.onAppend(line, this.id);
      } catch {
        // the hook owns its errors
      }
    }
    return line;
  }

  /** Every event in this ledger, in order. A reader; never store state. */
  events() {
    return readEvents(this.ledger.path);
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

  /**
   * The late append: refused exactly as a live one would be, minus the write.
   * The registry check stands on both sides of the close, so a call site that
   * names an event no registry holds is the defect it always was; only the
   * closed ledger is tolerated. The hook is where the drop becomes a record.
   */
  dropLate(event, fields) {
    if (!this.allowedEvents.has(event)) {
      throw new Error(`event not in registry: ${event}`);
    }
    if (this.onLate) {
      try {
        this.onLate({
          ledger: this.id,
          event,
          ...(fields?.actor && { actor: fields.actor }),
          ...(fields?.seat && { seat: fields.seat }),
        });
      } catch {
        // the hook owns its errors
      }
    }
    return null;
  }

  close() {
    this.closed = true;
    this.ledger.close();
  }
}

/** @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths */
export function openInstanceStore(paths, opts) {
  return new TelemetryStore(paths, 'instance', paths.instanceLedger, INSTANCE_EVENTS, opts);
}

/** @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths */
export function openEscapesStore(paths, opts) {
  return new TelemetryStore(paths, 'escapes', paths.escapesLedger, ESCAPES_EVENTS, opts);
}

/** @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths */
export function openRunStore(paths, runId, opts) {
  return new TelemetryStore(paths, `run:${runId}`, runLedgerPath(paths, runId), RUN_EVENTS, opts);
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
 *
 * The move retries, and then copies, because the handle that blocks it is
 * not the harness's own. A reader outside the daemon — an editor, a tail, a
 * backup scanner — holds a run ledger for as long as it holds it, and the run
 * underneath has already closed. A brief retry clears the readers that pass;
 * a copy clears the rest. A copy whose source will not delete is still an
 * archive: the copy is the authority from that moment, and the live directory
 * left behind is named in the return so the caller can say so (ADR-0015).
 *
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {{attempts?: number, delayMs?: number, rename?: Function, copy?: Function,
 *   remove?: Function, sleep?: (ms: number) => void}} [io] the filesystem seam.
 *   A held handle is a real condition no portable test can stage, so the
 *   calls the condition breaks are injectable.
 * @returns {{ledger: string, method: 'rename'|'copy', attempts: number,
 *   leftover: string|null}}
 */
export function archiveRun(paths, runId, io = {}) {
  const {
    attempts = 5,
    delayMs = 20,
    rename = renameSync,
    copy = cpSync,
    remove = rmSync,
    sleep = sleepSync,
  } = io;
  const liveDir = join(paths.runs, runId);
  const archiveDir = join(paths.archivedRuns, runId);
  if (existsSync(archiveDir)) throw new Error(`run ${runId} is already archived`);
  const events = readEvents(runLedgerPath(paths, runId));
  if (events.length === 0) throw new Error(`run ${runId} has no ledger`);
  if (!events.some((e) => e.event === 'run-closed')) {
    throw new Error(`run ${runId} is open; archive follows run-closed`);
  }
  const ledger = archivedRunLedgerPath(paths, runId);
  let blocked;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      rename(liveDir, archiveDir);
      return { ledger, method: 'rename', attempts: attempt, leftover: null };
    } catch (error) {
      blocked = error;
      if (attempt < attempts) sleep(delayMs * attempt);
    }
  }
  try {
    copy(liveDir, archiveDir, { recursive: true });
  } catch (error) {
    // A half-written archive directory reads as a finished archive to the
    // guard above, and to every reader that falls back to the archive. The
    // failure takes it with it.
    try {
      remove(archiveDir, { recursive: true, force: true });
    } catch {
      // Best effort. The throw below is the answer either way.
    }
    throw new Error(
      `run ${runId} did not archive: rename ${blocked.message}; copy ${error.message}`,
    );
  }
  try {
    remove(liveDir, { recursive: true, force: true });
    return { ledger, method: 'copy', attempts, leftover: null };
  } catch {
    return { ledger, method: 'copy', attempts, leftover: liveDir };
  }
}

// The archive sits in a synchronous close path and the wait between attempts
// is milliseconds, so the pause is synchronous too. A private buffer nothing
// else can notify is the portable form of a sleep this short.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
