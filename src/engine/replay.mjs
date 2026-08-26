// Derives a run's resumable state from its ledger events alone. The daemon
// calls this at start; every field answers from the file, never from memory.

const ENVELOPE_KEYS = new Set(['seq', 'ts', 'event', 'actor', 'stream', 'refs']);

/** @param {Array<object>} events one run ledger, in order */
export function deriveRunState(events) {
  const state = {
    launched: false,
    project: null,
    lane: null,
    payload: {},
    stage: null,
    parked: false,
    parkSeq: 0,
    parkRecord: null,
    violated: false,
    // The operator hold, as the ledger left it: held at a boundary, the stage
    // the run did not enter, and whether entering it is the re-execution an
    // answered park owes (ADR-0040).
    held: false,
    deferred: null,
    deferredResume: false,
    lastAnswer: null,
    closed: null,
  };
  let resumeSeq = 0;
  const violations = [];
  const resolved = new Set();
  for (const e of events) {
    switch (e.event) {
      case 'run-launched': {
        state.launched = true;
        state.project = e.project ?? null;
        state.lane = e.lane ?? null;
        for (const [key, value] of Object.entries(e)) {
          if (!ENVELOPE_KEYS.has(key) && key !== 'project' && key !== 'lane') {
            state.payload[key] = value;
          }
        }
        break;
      }
      case 'stage-entered':
        state.stage = e.stage;
        break;
      case 'stage-held':
        state.held = true;
        state.deferred = e.next ?? null;
        state.deferredResume = e.resumed === true;
        break;
      case 'stage-released':
        state.held = false;
        state.deferred = null;
        state.deferredResume = false;
        break;
      case 'park':
        state.parkSeq = e.seq;
        // The record itself, because the record is what an answer is judged
        // against: a restart validates against the same declaration the park
        // wrote (ADR-0029).
        state.parkRecord = e;
        break;
      case 'answer':
        state.lastAnswer = { actor: e.actor, ts: e.ts, option: e.option, answer: e.answer };
        break;
      case 'resume':
        resumeSeq = e.seq;
        break;
      case 'liveness-violation':
        violations.push(e.seq);
        break;
      case 'resolved':
        resolved.add(e.resolves);
        break;
      case 'run-closed':
        state.closed = { state: e.state };
        break;
    }
  }
  state.parked = state.parkSeq > resumeSeq;
  state.violated = violations.some((seq) => !resolved.has(seq));
  return state;
}
