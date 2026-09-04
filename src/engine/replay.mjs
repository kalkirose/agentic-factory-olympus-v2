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
    // The hold this run carries in its own right, taken with `hold --run`:
    // the actor who took it and the instant they did, or null. A project hold
    // is not this. A project hold lives in the instance ledger and covers every
    // run of the project, so a project release leaves this one standing
    // (ADR-0057).
    ownHold: null,
    // The wait the run is standing in, as the ledger left it: the kind, what
    // it waits for, and the instant the span runs to. A `waiting` with no
    // `waiting-ended` behind it is an open span, and the daemon start closes
    // every one of them before anything reads this — so what a resumed run
    // holds here is null, and what a console reading a live ledger holds is
    // the wait the run is in right now (ADR-0069).
    waiting: null,
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
      // The pin an operator replaced while the run was open. It lands after
      // `run-launched` in every ledger that holds one, so the newest wins by
      // walking the file in order and nothing here has to compare stamps. Only
      // the config blob moves: a reconfigure states which config the run reads
      // and nothing else about the run, and every other launch value stays the
      // fact the launch recorded (ADR-0061).
      case 'run-reconfigured':
        state.payload.configBlob = e.configBlob;
        break;
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
      case 'run-hold-changed':
        state.ownHold = e.held === true ? { actor: e.actor, ts: e.ts } : null;
        break;
      case 'waiting':
        state.waiting = {
          seq: e.seq,
          kind: e.kind,
          reason: e.reason,
          until: e.until ?? null,
          attempt: e.attempt ?? null,
          freesSlot: e.freesSlot === true,
        };
        break;
      case 'waiting-ended':
        if (state.waiting === null || state.waiting.seq === e.waitSeq) state.waiting = null;
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
