// Stream indexes: two central JSONL files (queued, loud) under the daemon
// home. Each entry is a pointer (source ledger id + seq) plus a one-line
// gist. The full event lives only in its source ledger; the indexes are
// derived data and can be rebuilt from the ledgers.
import { openSync, closeSync, writeSync, fsyncSync, readFileSync, existsSync } from 'node:fs';

/** @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths */
export function streamIndexPath(paths, stream) {
  if (stream === 'queued') return paths.queuedStream;
  if (stream === 'loud') return paths.loudStream;
  throw new Error(`unknown stream: ${stream}`);
}

/**
 * Appends one pointer entry to a stream index and fsyncs it.
 * @param {object} paths
 * @param {'queued'|'loud'} stream
 * @param {{ledger: string, seq: number, ts: string, event: string, gist: string}} entry
 */
export function appendStreamEntry(paths, stream, entry) {
  for (const key of ['ledger', 'ts', 'event', 'gist']) {
    if (typeof entry[key] !== 'string' || entry[key].length === 0) {
      throw new Error(`stream entry requires ${key}`);
    }
  }
  if (!Number.isInteger(entry.seq)) throw new Error('stream entry requires an integer seq');
  const line = {
    ledger: entry.ledger,
    seq: entry.seq,
    ts: entry.ts,
    event: entry.event,
    gist: entry.gist,
  };
  const fd = openSync(streamIndexPath(paths, stream), 'a');
  try {
    writeSync(fd, JSON.stringify(line) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return line;
}

/**
 * Reads all entries from a stream index file. A missing file reads as empty;
 * a torn tail line is skipped.
 */
export function readStreamIndex(path) {
  if (!existsSync(path)) return [];
  const entries = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.ledger === 'string' && Number.isInteger(parsed.seq)) entries.push(parsed);
    } catch {
      // torn tail from a crash mid-append; the source ledger keeps the truth
    }
  }
  return entries;
}
