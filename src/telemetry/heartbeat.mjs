// Progress telemetry for the stages that run no seat. A seat stamps its own
// progress, so a stage that supervises one is never silent. A stage that polls
// — the ship token, the checks on a request, the checks on a merge commit —
// has nobody to stamp for it, and its ledger reads the same after one minute
// as it does after three hours. The heartbeat is what a polling stage says
// while it waits: what it waits on, how many poll outcomes it has read, and
// how long it has been in the stage (ADR-0034).
//
// One stamp per batch of poll outcomes, never one per poll. The cadence of the
// reading belongs to the stage and stays what the project configured; the
// cadence of the record belongs here. A stage that settles inside its first
// batch stamps nothing at all, so the ledger of a run that never stalls keeps
// the shape it always had.
const ACTOR = 'daemon';

/**
 * Poll outcomes per stamp. At the default ship cadence this is one stamp per
 * five minutes of waiting: enough to prove a stage is alive, and far too few
 * to bury the run's own events.
 */
export const BEATS_PER_STAMP = 20;

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
