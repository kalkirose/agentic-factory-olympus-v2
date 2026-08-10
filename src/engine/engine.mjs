// The run engine: every open run as an in-process state machine. A lane
// names an ordered stage set and one handler per stage; a handler returns a
// directive — advance, park, or close. Transitions are stamped; all run
// state lives in the run ledger; a daemon restart resumes every open run at
// its recorded stamp.
//
// Liveness invariant, event-keyed: every open run holds an in-flight child,
// a parked escalation, or a transition in progress (a running handler). The
// engine checks at every handler settle; a violation stamps loud and leaves
// the run open — alert, never auto-kill. The console resolves or kills it.
import { readdirSync } from 'node:fs';
import { readEvents } from '../ledger/ledger.mjs';
import { PARK_TYPES, CLOSE_STATES } from '../ledger/registry.mjs';
import { runLedgerPath } from '../daemon/home.mjs';
import { openRunStore, archiveRun } from '../telemetry/stores.mjs';
import { deriveRunState } from './replay.mjs';
import { superviseSeat } from './supervise.mjs';
import { runSeat } from '../seats/runner.mjs';

const ACTOR = 'daemon';
const GIST_MAX = 120;

export class RunEngine {
  /**
   * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
   * @param {{instanceStore?: object, getSlotCap: (project: string) => number|undefined,
   *   onClosed?: (info: {runId: string, project: string, lane: string, state: string}) => void,
   *   onParked?: (info: {runId: string, project: string, lane: string, type: string}) => void,
   *   semaphores?: import('../seats/semaphore.mjs').ModelSemaphores,
   *   seatDefaults?: () => object}} opts
   *   seatDefaults supplies machine-scoped runSeat options (claudeCommand)
   *   read fresh per dispatch, so a live config edit applies.
   */
  constructor(paths, { instanceStore, getSlotCap, onClosed, onParked, semaphores, seatDefaults }) {
    this.paths = paths;
    this.instanceStore = instanceStore ?? null;
    this.getSlotCap = getSlotCap;
    this.onClosed = onClosed ?? null;
    this.onParked = onParked ?? null;
    this.semaphores = semaphores ?? null;
    this.seatDefaults = seatDefaults ?? (() => ({}));
    this.lanes = new Map();
    this.runs = new Map();
    this.stopped = false;
    this.idCounter = 0;
  }

  /** @param {string} name @param {{stages: string[], handlers: object}} lane */
  registerLane(name, { stages, handlers }) {
    if (!Array.isArray(stages) || stages.length === 0) {
      throw new Error(`lane ${name} requires a non-empty stage list`);
    }
    for (const stage of stages) {
      if (typeof handlers?.[stage] !== 'function') {
        throw new Error(`lane ${name} stage ${stage} has no handler`);
      }
    }
    this.lanes.set(name, { stages, handlers });
  }

  // -- slot accounting (lane-agnostic) --------------------------------------

  /** Active runs of a project: open and not parked. A parked run frees its slot. */
  activeCount(project) {
    let count = 0;
    for (const run of this.runs.values()) {
      if (run.project === project && !run.closed && !run.parked) count++;
    }
    return count;
  }

  hasFreeSlot(project) {
    const cap = this.getSlotCap(project);
    return cap !== undefined && this.activeCount(project) < cap;
  }

  // -- launch ---------------------------------------------------------------

  /**
   * Launches a run. The slot cap gates launch only; nothing else blocks on it.
   * @param {{runId?: string, project: string, lane: string, [k: string]: unknown}} opts
   */
  launch({ runId, project, lane, ...payload }) {
    if (this.stopped) throw new Error('engine stopped');
    if (!this.lanes.has(lane)) throw new Error(`unknown lane: ${lane}`);
    if (this.getSlotCap(project) === undefined) throw new Error(`unknown project: ${project}`);
    if (!this.hasFreeSlot(project)) throw new Error(`no free slot for project ${project}`);
    runId = runId ?? `${project}-${Date.now().toString(36)}-${++this.idCounter}`;
    if (this.runs.has(runId)) throw new Error(`run ${runId} is already live`);
    if (readEvents(runLedgerPath(this.paths, runId)).length > 0) {
      throw new Error(`run ${runId} already has a ledger`);
    }
    const run = this.trackRun({ runId, project, lane, payload });
    run.store.append('run-launched', { actor: ACTOR, project, lane, ...payload });
    this.instanceStore?.append('launch', { actor: ACTOR, runId, project, lane });
    this.enterStage(run, this.lanes.get(lane).stages[0]);
    return runId;
  }

  trackRun({ runId, project, lane, payload }) {
    const run = {
      runId,
      project,
      lane,
      payload,
      stage: null,
      store: openRunStore(this.paths, runId),
      parked: false,
      parkSeq: 0,
      parkRecord: null,
      violated: false,
      closed: false,
      executing: false,
      seats: new Set(),
      lastAnswer: null,
    };
    this.runs.set(runId, run);
    return run;
  }

  // -- state machine --------------------------------------------------------

  enterStage(run, stage, { resumed = false } = {}) {
    run.stage = stage;
    run.store.append('stage-entered', { actor: ACTOR, stage, ...(resumed && { resumed }) });
    this.executeStage(run);
  }

  executeStage(run) {
    const lane = this.lanes.get(run.lane);
    const handler = lane.handlers[run.stage];
    run.executing = true;
    // A handler may supervise several seats at once (the Fury fan-out); the
    // run tracks the whole in-flight set for liveness, kill, and stop.
    const supervise = (opts) => {
      const seat = superviseSeat(run.store, opts);
      run.seats.add(seat);
      return seat.done.finally(() => {
        run.seats.delete(seat);
      });
    };
    const ctx = {
      runId: run.runId,
      project: run.project,
      lane: run.lane,
      stage: run.stage,
      payload: run.payload,
      lastAnswer: run.lastAnswer,
      store: run.store,
      instanceStore: this.instanceStore,
      paths: this.paths,
      // Long-poll handlers (the check watcher) exit their loop on this; the
      // engine ignores any directive returned after stop or close.
      stopped: () => this.stopped || run.closed,
      supervise,
      // Dispatch through the engine's supervise wrapper so the liveness
      // invariant sees the seat as an in-flight child.
      runSeat: (opts) =>
        runSeat(run.store, {
          ...this.seatDefaults(),
          semaphores: this.semaphores ?? undefined,
          ...opts,
          supervise,
        }),
    };
    Promise.resolve()
      .then(() => handler(ctx))
      .then(
        (directive) => {
          run.executing = false;
          if (this.stopped || run.closed) return;
          this.applyDirective(run, directive);
        },
        (error) => {
          run.executing = false;
          if (this.stopped || run.closed) return;
          this.stampViolation(run, `stage handler failed: ${error.message}`);
        },
      );
  }

  applyDirective(run, directive) {
    if (typeof directive !== 'object' || directive === null) {
      this.stampViolation(run, `stage ${run.stage} returned no directive`);
      return;
    }
    if (typeof directive.next === 'string') {
      if (!this.lanes.get(run.lane).stages.includes(directive.next)) {
        this.stampViolation(run, `directive names unknown stage: ${directive.next}`);
        return;
      }
      this.enterStage(run, directive.next);
      return;
    }
    if (directive.park) {
      const { type, question, options, refs } = directive.park;
      if (!PARK_TYPES.has(type)) {
        this.stampViolation(run, `park type not in the catalog: ${type}`);
        return;
      }
      if (typeof question !== 'string' || question.length === 0) {
        this.stampViolation(run, `park at ${run.stage} carries no question`);
        return;
      }
      this.park(run, { type, question, options, refs });
      return;
    }
    if (directive.close) {
      const { state, ...extra } = directive.close;
      if (!CLOSE_STATES.has(state)) {
        this.stampViolation(run, `close state not in the registry: ${state}`);
        return;
      }
      this.closeRun(run, state, extra);
      return;
    }
    this.stampViolation(run, `stage ${run.stage} returned an invalid directive`);
  }

  // -- park / answer / resume -----------------------------------------------

  park(run, { type, question, options, refs }) {
    run.parked = true;
    run.parkRecord = { type, question, options };
    const line = run.store.append('park', {
      actor: ACTOR,
      type,
      question,
      ...(options && { options }),
      ...(refs && { refs }),
      gist: gist(`${type}: ${question}`),
    });
    run.parkSeq = line.seq;
    try {
      // A park frees its slot; the hook lets the frontier fill it.
      this.onParked?.({ runId: run.runId, project: run.project, lane: run.lane, type });
    } catch {
      // The hook owns its errors; a park never fails on it.
    }
  }

  /**
   * Validates and applies a human answer, then resumes the run at its parked
   * stage. The `answer` stamp carries who (actor) and when (ts).
   * @param {{runId: string, actor: string, answer?: string, option?: string}} cmd
   */
  answer({ runId, actor, answer, option }) {
    const run = this.runs.get(runId);
    if (!run || run.closed) throw new Error(`no open run: ${runId}`);
    if (!run.parked) throw new Error(`run ${runId} is not parked`);
    if (typeof actor !== 'string' || actor.length === 0) throw new Error('answer requires an actor');
    if (option !== undefined) {
      const offered = run.parkRecord?.options;
      if (!Array.isArray(offered) || !offered.includes(option)) {
        throw new Error(`option not offered by the escalation record: ${option}`);
      }
    } else if (typeof answer !== 'string' || answer.length === 0) {
      throw new Error('answer requires an option or answer text');
    }
    run.store.append('answer', {
      actor,
      parkSeq: run.parkSeq,
      ...(option !== undefined && { option }),
      ...(answer !== undefined && { answer }),
    });
    run.lastAnswer = { actor, option, answer };
    run.parked = false;
    run.parkRecord = null;
    run.store.append('resume', { actor: ACTOR, stage: run.stage });
    this.executeStage(run);
  }

  /**
   * Appends the paired `resolved` stamp for a loud item in an open run, from
   * a console command. When the resolution clears the run's last open
   * liveness violation, the engine re-enters the recorded stage — the same
   * recovery a daemon restart would perform after replay.
   * @param {{runId: string, actor: string, resolves: number, note?: string}} cmd
   */
  resolve({ runId, actor, resolves, note }) {
    const run = this.runs.get(runId);
    if (!run || run.closed) throw new Error(`no open run: ${runId}`);
    if (typeof actor !== 'string' || actor.length === 0) throw new Error('resolve requires an actor');
    const line = run.store.resolve({ actor, resolves, ...(note !== undefined && { note }) });
    if (line.resolvedEvent === 'liveness-violation' && run.violated) {
      const events = readEvents(runLedgerPath(this.paths, run.runId));
      const cleared = new Set(
        events.filter((e) => e.event === 'resolved').map((e) => e.resolves),
      );
      const open = events.filter(
        (e) => e.event === 'liveness-violation' && !cleared.has(e.seq),
      );
      if (open.length === 0) {
        run.violated = false;
        if (!run.parked && !run.executing && run.seats.size === 0) this.executeStage(run);
      }
    }
    return line;
  }

  // -- close ----------------------------------------------------------------

  killRun(runId, { actor = ACTOR } = {}) {
    const run = this.runs.get(runId);
    if (!run || run.closed) throw new Error(`no open run: ${runId}`);
    for (const seat of run.seats) seat.terminate('run-killed');
    this.closeRun(run, 'killed', { actor });
  }

  closeRun(run, state, { actor = ACTOR, ...extra } = {}) {
    run.closed = true;
    run.store.append('run-closed', { actor, state, ...extra });
    run.store.close();
    this.runs.delete(run.runId);
    archiveRun(this.paths, run.runId);
    try {
      this.onClosed?.({ runId: run.runId, project: run.project, lane: run.lane, state });
    } catch {
      // The hook owns its errors; a close never fails on it.
    }
  }

  // -- liveness -------------------------------------------------------------

  /**
   * Sweeps the invariant over every open run. The per-transition check stamps
   * at the handler-settle point; this sweep backs it for resume and consoles.
   */
  checkLiveness() {
    const violations = [];
    for (const run of this.runs.values()) {
      if (run.closed || run.parked || run.violated || run.executing || run.seats.size > 0) continue;
      this.stampViolation(run, 'no in-flight child, no parked escalation, no transition in progress');
      violations.push(run.runId);
    }
    return violations;
  }

  stampViolation(run, detail) {
    run.violated = true;
    run.store.append('liveness-violation', {
      actor: ACTOR,
      stage: run.stage,
      detail,
      gist: gist(`${run.runId} inert at ${run.stage}: ${detail}`),
    });
  }

  // -- resume at daemon start ----------------------------------------------

  /**
   * Resumes every open run from its ledger. A parked or violated run stays
   * waiting on the human; every other run re-enters its recorded stage. A run
   * the engine cannot resume (unknown lane or stage) violates loud.
   */
  resumeOpenRuns() {
    const resumed = [];
    for (const runId of runDirs(this.paths.runs)) {
      const events = readEvents(runLedgerPath(this.paths, runId));
      if (events.length === 0) continue;
      const state = deriveRunState(events);
      if (state.closed) continue;
      const run = this.trackRun({
        runId,
        project: state.project,
        lane: state.lane,
        payload: state.payload,
      });
      run.stage = state.stage;
      run.parked = state.parked;
      run.parkSeq = state.parkSeq;
      run.parkRecord = state.parkRecord;
      run.violated = state.violated;
      run.lastAnswer = state.lastAnswer;
      resumed.push(runId);
      if (run.parked || run.violated) continue;
      const lane = this.lanes.get(run.lane);
      if (!lane || !run.stage || !lane.stages.includes(run.stage)) {
        this.stampViolation(run, `cannot resume: lane ${run.lane}, stage ${run.stage}`);
        continue;
      }
      this.enterStage(run, run.stage, { resumed: true });
    }
    return resumed;
  }

  /** Terminates in-flight seats, waits for their stamps, closes all stores. */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    const draining = [];
    for (const run of this.runs.values()) {
      for (const seat of run.seats) {
        seat.terminate('daemon-stopped');
        draining.push(seat.done);
      }
    }
    await Promise.all(draining);
    for (const run of this.runs.values()) run.store.close();
    this.runs.clear();
  }
}

function gist(text) {
  return text.length > GIST_MAX ? text.slice(0, GIST_MAX - 1) + '…' : text;
}

function runDirs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}
