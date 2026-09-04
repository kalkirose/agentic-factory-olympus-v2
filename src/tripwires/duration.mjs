// Stage duration, read from the run ledgers. The no-timeout doctrine answers
// "is this stage alive?" with telemetry and duration history, so the history
// has to be a reading of what the same stage of the same lane already did. A
// band is that reading; a stage past the band is the detection (ADR-0034).
//
// The history is work, never wall clock. A stage that stood in the ship-token
// queue, sat parked on a human, or waited out an operator hold at a boundary
// did nothing in that stretch, and a band that
// counted it would learn the pathology it exists to flag: one five-minute queue
// wait once took an update band from 119 seconds to 112 minutes, and the next
// run stood two hours in the same queue inside the band it had taught
// (ADR-0039). So a visit is measured as the wall of it minus the waits the run
// was not spending, by the one split the run's own durations use.
//
// Nothing here decides anything about a run. It returns numbers, and the
// watcher is the only caller that stamps.
import { inactiveMs } from '../ledger/durations.mjs';

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
 * What a stage band counts as waiting: the human's answer, the inert stretch
 * under an unresolved violation, the ship-token queue, the operator hold, and
 * the wait a ladder spends on a provider, a host or a service. A band is a
 * statement about work, and none of the five is the stage working — a band
 * that counted a 45-minute provider outage would learn the outage.
 */
export const BAND_CLASSES = ['human', 'queue', 'hold', 'wait'];

/**
 * The work inside one window of a run, in milliseconds: the wall of it, less
 * every span the run spent waiting. Never negative — a ledger whose spans
 * somehow outrun their window reads as no work rather than as anti-work.
 * @param {object[]} events one run ledger
 * @param {string} start ISO
 * @param {string} end ISO
 * @returns {number}
 */
export function activeMs(events, start, end) {
  const wall = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(wall)) return NaN;
  return Math.max(0, wall - inactiveMs(events, { start, end, classes: BAND_CLASSES }));
}

/**
 * Completed durations of one stage in one run ledger, in milliseconds of work.
 * The open visit — the one the run is in — is not a sample of anything.
 * @param {object[]} events one run ledger
 * @param {string} stage
 * @returns {number[]}
 */
export function stageDurations(events, stage) {
  return stageVisits(events)
    .filter((v) => v.stage === stage && v.end !== null)
    .map((v) => activeMs(events, v.start, v.end))
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
