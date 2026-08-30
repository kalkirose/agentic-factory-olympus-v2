// The escalation queue: the open items of the queued stream, joined with
// their full source records so each is answerable from the record alone.
// Openness is derived, never stored: a park closes on its paired `answer`
// (or when its run closes); a breach closes on its paired `resolved`.
// Presentation is FIFO with a roadmap-order tiebreak — no priority machinery.
import { readEvents } from '../ledger/ledger.mjs';
import { acceptedForms } from '../ledger/parks.mjs';
import { streamIndexPath, readStreamIndex } from './streams.mjs';
import { ledgerPathFor } from './readers.mjs';

/**
 * Unanswered instance-ledger parks: card-invalidated and card-decision, both
 * from ship-time sweeps.
 * The frontier blocks these cards; the queue presents them.
 */
export function openCardParks(paths) {
  const events = readEvents(paths.instanceLedger);
  const answered = new Set(
    events.filter((e) => e.event === 'answer').map((e) => e.parkSeq),
  );
  return events.filter((e) => e.event === 'park' && !answered.has(e.seq));
}

/**
 * The open escalation queue across all ledgers, presentation-ordered:
 * FIFO by arrival, tie broken by roadmap position (via `roadmap`, a map of
 * story key/card path → position), then by seq. Each entry carries the full
 * source record.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {{roadmap?: Map<string, number>}} [opts]
 */
export function escalationQueue(paths, { roadmap } = {}) {
  const ledgers = new Map();
  const eventsOf = (id) => {
    if (!ledgers.has(id)) ledgers.set(id, readEvents(ledgerPathFor(paths, id)));
    return ledgers.get(id);
  };
  const queue = [];
  for (const pointer of readStreamIndex(streamIndexPath(paths, 'queued'))) {
    const events = eventsOf(pointer.ledger);
    const record = events.find((e) => e.seq === pointer.seq);
    if (!record || !isOpen(record, events)) continue;
    const runId = pointer.ledger.startsWith('run:') ? pointer.ledger.slice('run:'.length) : null;
    const storyKey =
      record.storyKey ??
      (runId ? (events.find((e) => e.event === 'run-launched')?.storyKey ?? null) : null);
    queue.push({
      ledger: pointer.ledger,
      ...(runId && { runId }),
      seq: record.seq,
      ts: record.ts,
      event: record.event,
      ...(record.type && { type: record.type }),
      ...(record.question && { question: record.question }),
      // The record's own statement of what it will take back, so every queue
      // item is answerable from the item (ADR-0029).
      ...(record.event === 'park' && { answers: acceptedForms(record) }),
      // What an `ack` answer would record, by fingerprint, so the operator
      // reads the identity here and hands it to a revoke later (ADR-0032).
      ...(Array.isArray(record.acks) && { acks: record.acks }),
      ...(record.refs && { refs: record.refs }),
      ...(record.card && { card: record.card }),
      ...(storyKey && { storyKey }),
      gist: pointer.gist,
    });
  }
  return sortQueue(queue, roadmap);
}

function isOpen(record, events) {
  if (record.event === 'park') {
    if (events.some((e) => e.event === 'answer' && e.parkSeq === record.seq)) return false;
    // A closed run's park is moot — killed runs wait on nobody.
    return !events.some((e) => e.event === 'run-closed');
  }
  return !events.some((e) => e.event === 'resolved' && e.resolves === record.seq);
}

/** Exported for direct testing; `escalationQueue` sorts through here. */
export function sortQueue(entries, roadmap) {
  const position = (entry) => {
    if (!roadmap) return Infinity;
    const by = entry.storyKey ?? entry.card;
    return by !== undefined && roadmap.has(by) ? roadmap.get(by) : Infinity;
  };
  return [...entries].sort(
    (a, b) =>
      (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) ||
      position(a) - position(b) ||
      a.seq - b.seq,
  );
}
