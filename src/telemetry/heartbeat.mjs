// Progress telemetry for a stage in progress. A stage that polls — the ship
// token, the checks on a request, the checks on a merge commit — has nobody to
// stamp for it, and its ledger reads the same after one minute as it does
// after three hours. A stage that supervises a seat looked safe, because the
// seat stamps its own progress, until a seat stopped stamping and the stage
// went silent for four hours with nothing in the run to say so.
//
// So there are two beats here, and between them every stage of every lane is
// covered (ADR-0034):
//
//   stageHeartbeat — the poll beat. The handler beats once per poll outcome
//                    that changed nothing, and every batch becomes a stamp
//                    carrying what the stage waits on and the evidence of it.
//   stagePulse     — the stage beat. The engine opens one over every handler
//                    it runs, and it stamps on a cadence for as long as the
//                    handler does. It stands down for the interval after any
//                    other voice stamps a heartbeat for the stage, so a
//                    polling stage keeps its own richer record and no stage
//                    stamps twice for one interval.
//
// A stage that settles inside its first interval stamps nothing at all, so the
// ledger of a run that never stalls keeps the shape it always had.
const ACTOR = 'daemon';

/**
 * Poll outcomes per stamp. At the default ship cadence this is one stamp per
 * five minutes of waiting: enough to prove a stage is alive, and far too few
 * to bury the run's own events.
 */
export const BEATS_PER_STAMP = 20;

/**
 * The stage beat's interval. The same five minutes the poll batch works out
 * to, because the question both answer is the same one and an operator reading
 * a ledger should not have to hold two cadences in mind.
 */
export const PULSE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Opens the heartbeat of one stage entry. The caller beats once per poll
 * outcome; the batch decides which beat becomes a stamp.
 *
 * The clock starts at the call, which is where the stage starts work: the
 * engine enters a stage or resumes it, and the handler runs from there. A
 * stage that parked and was answered therefore measures the machine's time and
 * not the human's, because the resumed handler opens a heartbeat of its own.
 *
 * @param {{stage: string, store: object}} ctx the stage context
 * @param {{every?: number, now?: () => number}} [opts] `every` is the batch
 *   size in poll outcomes; `now` is the clock seam the tests drive.
 * @returns {{beat: (waitingOn: string, detail?: object) => object|null,
 *   polls: () => number}}
 */
export function stageHeartbeat(ctx, { every = BEATS_PER_STAMP, now = Date.now } = {}) {
  const started = now();
  let polls = 0;
  return {
    /**
     * Records one poll outcome. Returns the stamp when this beat closed a
     * batch, and null every other time.
     * @param {string} waitingOn what the stage is waiting on, in one word
     * @param {object} [detail] the evidence the wait stands on
     */
    beat(waitingOn, detail) {
      polls += 1;
      if (polls % every !== 0) return null;
      return ctx.store.append('stage-heartbeat', {
        actor: ACTOR,
        stage: ctx.stage,
        waitingOn,
        // Cumulative, so one stamp says how much reading stands behind it and
        // two stamps say how much stands between them.
        polls,
        elapsed: now() - started,
        ...(detail && Object.keys(detail).length > 0 && { detail }),
      });
    },
    polls: () => polls,
  };
}

/**
 * Opens the stage beat over one handler. The caller closes it when the handler
 * settles; nothing else ends it, and nothing it stamps decides anything.
 *
 * The clock starts at the call, which is the same instant the poll beat starts
 * from and the same instant `stageVisits` measures a visit from: the engine
 * enters a stage or resumes it, and the handler runs from there.
 *
 * `describe` says what the stage is waiting on at the moment of the beat —
 * the seats in flight, when there are any — and returns null for a beat that
 * should not be stamped at all (a run that closed or parked under the timer).
 * `lastBeat` is the seq of the last `stage-heartbeat` the run recorded, from
 * any voice: a value that moved since the last tick means somebody else has
 * already said what this beat would say, and this beat stands down for the
 * interval. Seq, not a clock, so a beat and a poll stamp landing in the same
 * millisecond still read correctly.
 *
 * @param {{stage: string, store: object}} ctx the stage context
 * @param {{everyMs?: number, now?: () => number,
 *   describe?: () => ({waitingOn: string, detail?: object}|null),
 *   lastBeat?: () => number|null}} [opts]
 * @returns {{close: () => void, beats: () => number}}
 */
export function stagePulse(
  ctx,
  {
    everyMs = PULSE_INTERVAL_MS,
    now = Date.now,
    describe = () => ({ waitingOn: 'stage' }),
    lastBeat = () => null,
  } = {},
) {
  const started = now();
  let beats = 0;
  let heard = lastBeat();
  const timer = setInterval(() => {
    const latest = lastBeat();
    if (latest !== heard) {
      heard = latest;
      return;
    }
    const said = describe();
    if (said === null) return;
    beats += 1;
    try {
      const line = ctx.store.append('stage-heartbeat', {
        actor: ACTOR,
        stage: ctx.stage,
        waitingOn: said.waitingOn,
        // Beats, not polls: this stamp read nothing and stands for the
        // interval alone.
        beats,
        elapsed: now() - started,
        ...(said.detail && Object.keys(said.detail).length > 0 && { detail: said.detail }),
      });
      heard = line?.seq ?? lastBeat();
    } catch {
      // A run whose ledger closed under the timer. The beat is a record of a
      // stage in progress and never a step of one, so it fails alone.
      heard = lastBeat();
    }
  }, everyMs);
  timer.unref?.();
  return {
    close() {
      clearInterval(timer);
    },
    beats: () => beats,
  };
}
