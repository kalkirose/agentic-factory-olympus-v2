// Stage duration, read from the run ledgers. The no-timeout doctrine answers
// "is this stage alive?" with telemetry and duration history, so the history
// has to be a reading of what the same stage of the same lane already did. A
// band is that reading; a stage past the band is the detection (ADR-0034).
//
// Nothing here decides anything about a run. It returns numbers, and the
// watcher is the only caller that stamps.

/**
 * The completed visits a band needs before it says anything. Under this the
 * band is null and the watcher stays quiet: a harness with four ships has no
 * statement to make about the fifth, and a loud guess would teach an operator
 * to ignore the record.
 */
export const MIN_SAMPLES = 5;

/**
 * How far past the middle of the history the band reaches. The top of the band
 * is also never below the slowest visit on record, so a stage outside it did
 * something no completed visit of that stage ever did.
 */
export const BAND_FACTOR = 4;

/**
 * The stage visits of one run, in ledger order. A visit starts at the
 * `stage-entered` stamp and, when the stage parked and the human answered, at
 * the `resume` behind the answer — the wait for a human is the human's time,
 * never the stage's. A visit ends at the next stage or at the run close.
 *
 * A resumed entry ends nothing: a daemon that stopped mid-stage and started
 * again re-enters the same stage, and the gap between the two is the daemon's
 * downtime. That visit never completed, so it is dropped rather than measured.
 *
 * @param {object[]} events one run ledger
 * @returns {{stage: string, start: string, end: string|null}[]}
 */
export function stageVisits(events) {
  const visits = [];
  let open = null;
  for (const e of events) {
    if (e.event === 'stage-entered') {
      if (open && !e.resumed) visits.push({ ...open, end: e.ts });
      open = { stage: e.stage, start: e.ts, end: null };
    } else if (!open) {
      continue;
    } else if (e.event === 'resume') {
      open.start = e.ts;
    } else if (e.event === 'run-closed') {
      visits.push({ ...open, end: e.ts });
      open = null;
    }
  }
  if (open) visits.push(open);
  return visits;
}

/**
 * Completed durations of one stage in one run ledger, in milliseconds. The
 * open visit — the one the run is in — is not a sample of anything.
 * @param {object[]} events one run ledger
 * @param {string} stage
 * @returns {number[]}
 */
export function stageDurations(events, stage) {
  return stageVisits(events)
    .filter((v) => v.stage === stage && v.end !== null)
    .map((v) => Date.parse(v.end) - Date.parse(v.start))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
}

/**
 * The band of a sample set, or null when the history is too thin to hold one.
 * @param {number[]} samples
 * @returns {{samples: number, median: number, max: number, upper: number}|null}
 */
export function durationBand(samples) {
  if (samples.length < MIN_SAMPLES) return null;
  const mid = median(samples);
  const max = Math.max(...samples);
  return { samples: samples.length, median: mid, max, upper: Math.max(max, mid * BAND_FACTOR) };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
