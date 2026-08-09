// Append-only JSONL ledger with the six-field envelope:
//   seq   — monotonic per ledger
//   ts    — ISO 8601 UTC; recording and duration history only, never a trigger
//   event — from the ledger's closed registry
//   actor — daemon, process name, seat id, or human
//   stream — 'queued' | 'loud', stream-classed events only
//   refs  — artifact pointers
// Payload fields sit inline beside the envelope.
import {
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  readFileSync,
  truncateSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { streamOf } from './registry.mjs';

const ENVELOPE_KEYS = new Set(['seq', 'ts', 'event', 'actor', 'stream', 'refs']);

export class Ledger {
  /** @param {string} path @param {{allowedEvents: Set<string>}} opts */
  constructor(path, { allowedEvents }) {
    if (!allowedEvents) throw new Error('Ledger requires a closed event registry');
    this.path = path;
    this.allowedEvents = allowedEvents;
    this.lastSeq = repairTail(path);
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'a');
  }

  /**
   * Appends one event line and fsyncs it. Returns the full stamped line.
   * @param {string} event
   * @param {{actor: string, refs?: object, [k: string]: unknown}} fields
   */
  append(event, fields) {
    if (this.fd === null) throw new Error(`ledger closed: ${this.path}`);
    if (!this.allowedEvents.has(event)) {
      throw new Error(`event not in registry: ${event}`);
    }
    const { actor, refs, ...payload } = fields;
    if (!actor) throw new Error(`event ${event} requires an actor`);
    for (const key of Object.keys(payload)) {
      if (ENVELOPE_KEYS.has(key)) {
        throw new Error(`payload key shadows the envelope: ${key}`);
      }
    }
    const line = {
      seq: ++this.lastSeq,
      ts: new Date().toISOString(),
      event,
      actor,
    };
    const stream = streamOf(event);
    if (stream) line.stream = stream;
    if (refs) line.refs = refs;
    Object.assign(line, payload);
    writeSync(this.fd, JSON.stringify(line) + '\n');
    fsyncSync(this.fd);
    return line;
  }

  close() {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

/**
 * Validates the tail of an existing ledger file. A partial last line (crash
 * mid-write) is truncated away. Returns the last valid seq (0 for none).
 */
function repairTail(path) {
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path, 'utf8');
  if (raw.length === 0) return 0;
  let end = raw.length;
  let lastSeq = 0;
  // Find the last newline-terminated prefix whose final line parses.
  const lines = raw.split('\n');
  // A well-formed file ends with '\n', so the final split element is ''.
  let tailIsPartial = lines[lines.length - 1] !== '';
  if (tailIsPartial) {
    const partial = lines.pop();
    if (isValidLine(partial)) {
      // Complete line, missing only the newline — keep it, restore the '\n'.
      lines.push(partial, '');
      tailIsPartial = false;
    } else {
      end = raw.length - partial.length;
      truncateSync(path, end);
      lines.push('');
    }
  }
  for (let i = lines.length - 2; i >= 0; i--) {
    const parsed = isValidLine(lines[i]);
    if (parsed) {
      lastSeq = parsed.seq;
      break;
    }
    throw new Error(`corrupt ledger line in ${path}: ${lines[i].slice(0, 80)}`);
  }
  return lastSeq;
}

function isValidLine(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Number.isInteger(parsed.seq) && typeof parsed.event === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Reads all events from a ledger file. Missing file reads as empty. */
export function readEvents(path) {
  if (!existsSync(path)) return [];
  const events = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    const parsed = isValidLine(line);
    if (parsed) events.push(parsed);
  }
  return events;
}

/** Reads the last n events from a ledger file. */
export function tailEvents(path, n) {
  const events = readEvents(path);
  return events.slice(Math.max(0, events.length - n));
}
