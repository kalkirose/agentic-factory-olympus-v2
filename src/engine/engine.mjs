// The run engine: every open run as an in-process state machine. A lane
// names an ordered stage set and one handler per stage; a handler returns a
// directive — advance, park, or close. Transitions are stamped; all run
// state lives in the run ledger; a daemon restart resumes every open run at
// its recorded stamp.
//
// Liveness invariant, event-keyed: every open run holds an in-flight child,
// a parked escalation, an operator hold, or a transition in progress (a
// running handler). The engine checks at every handler settle; a violation
// stamps loud and leaves the run open — alert, never auto-kill. The console
// resolves or kills it.
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '../ledger/ledger.mjs';
import { runCost } from '../ledger/cost.mjs';
import { runDuration } from '../ledger/durations.mjs';
import {
  PARK_TYPES,
  CLOSE_STATES,
  CLOSE_RESOLVED_EVENTS,
  SEAT_TERMINAL_EVENTS,
} from '../ledger/registry.mjs';
import { OWNER_EVENTS, settleOwnedLoud } from '../ledger/resolution.mjs';
import { checkAnswer, runParkForms } from '../ledger/parks.mjs';
import { runLedgerPath, archivedRunLedgerPath } from '../daemon/home.mjs';
import { openRunStore, archiveRun } from '../telemetry/stores.mjs';
import { stagePulse, PULSE_INTERVAL_MS } from '../telemetry/heartbeat.mjs';
import { deriveRunState } from './replay.mjs';
import { superviseSeat } from './supervise.mjs';
import { runSeat } from '../seats/runner.mjs';

const ACTOR = 'daemon';
const GIST_MAX = 120;

export class RunEngine {
  /**
   * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
   * @param {{instanceStore?: object, getSlotCap: (project: string) => number|undefined,
   *   isHeld?: (project: string) => boolean,
   *   onClosed?: (info: {runId: string, project: string, lane: string, state: string}) => void,
   *   onParked?: (info: {runId: string, project: string, lane: string, type: string}) => void,
   *   semaphores?: import('../seats/semaphore.mjs').ModelSemaphores,
   *   seatDefaults?: () => object,
   *   composeCommand?: () => string[],
   *   archiveIo?: object,
   *   heartbeatMs?: number,
   *   onEvent?: (project: string, line: object, ledger: string) => void}} opts
   *   seatDefaults supplies machine-scoped runSeat options (claudeCommand)
   *   read fresh per dispatch, so a live config edit applies. composeCommand
   *   is the same machine-scoped read for the stack tool: a handler that asks
   *   the run's stack a question gets the argv this host runs it with. isHeld
   *   is the operator hold, read at every stage chain: a held project's runs
   *   settle the stage they are in and stop at the boundary (ADR-0040).
   *   onEvent fires on every run-store append, project-attributed and carrying
   *   its source ledger — the event key every in-daemon observer reads.
   *   archiveIo is the archive's filesystem seam, read at every call.
   *   heartbeatMs is the stage beat's interval, the seam the tests drive it at.
   */
  constructor(
    paths,
    {
      instanceStore,
      getSlotCap,
      isHeld,
      onClosed,
      onParked,
      semaphores,
      seatDefaults,
      composeCommand,
      archiveIo,
      heartbeatMs,
      onEvent,
    },
  ) {
    this.paths = paths;
    this.instanceStore = instanceStore ?? null;
    this.getSlotCap = getSlotCap;
    this.isHeld = isHeld ?? (() => false);
    this.onClosed = onClosed ?? null;
    this.onParked = onParked ?? null;
    this.semaphores = semaphores ?? null;
    this.seatDefaults = seatDefaults ?? (() => ({}));
    this.composeCommand = composeCommand ?? (() => ['docker', 'compose']);
    this.archiveIo = archiveIo ?? {};
    this.heartbeatMs = heartbeatMs ?? PULSE_INTERVAL_MS;
    this.onEvent = onEvent ?? null;
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

  /**
   * Active runs of a project: open and not parked. A parked run frees its slot;
   * a held run keeps it. A hold is operational rather than scheduling, and
   * freeing the slots it stops would invite launches that oversubscribe the
   * project the moment somebody releases it (ADR-0040).
   */
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
      store: null,
      parked: false,
      parkSeq: 0,
      parkRecord: null,
      violated: false,
      closed: false,
      executing: false,
      settling: false,
      // The operator hold, as this run stands under it: `held` while the run
      // sits at a boundary it may not cross, `deferred` the stage waiting on
      // the other side, and `deferredResume` whether entering it is a fresh
      // entry or the re-execution an answered park owes.
      held: false,
      deferred: null,
      deferredResume: false,
      seats: new Set(),
      lastAnswer: null,
      pulse: null,
      // The last heartbeat this run recorded, from any voice. The stage beat
      // reads it to know whether a polling handler has already spoken.
      lastBeatSeq: null,
    };
    run.store = openRunStore(this.paths, runId, {
      onAppend: (line, ledger) => {
        if (line.event === 'stage-heartbeat') run.lastBeatSeq = line.seq;
        // The watcher's event key first, so it reads the seat's own stamp
        // before it reads anything the budget check appends behind it.
        this.onEvent?.(project, line, ledger);
        this.checkBudget(run, line);
        this.settleLoud(run, line);
      },
      onLate: (late) => this.recordLateAppend(run, late),
    });
    this.runs.set(runId, run);
    return run;
  }

  // -- state machine --------------------------------------------------------

  enterStage(run, stage, { resumed = false } = {}) {
    run.stage = stage;
    run.store.append('stage-entered', { actor: ACTOR, stage, ...(resumed && { resumed }) });
    this.executeStage(run);
  }

  /**
   * The one place stages chain, and so the one place an operator hold is read.
   * A hold interrupts nothing: whatever ran has run, and the run stops here
   * rather than entering what comes next (ADR-0040).
   */
  chainStage(run, next) {
    if (this.isHeld(run.project)) this.holdAt(run, next);
    else this.enterStage(run, next);
  }

  /**
   * Records the boundary a held run is standing at and idles it. The stamp
   * carries the stage that settled and the stage that did not start, because
   * those two are what a release needs and what an operator reads.
   *
   * The stage beat keeps running over the wait. A held run holds no child and
   * stamps nothing of its own, and telemetry that goes quiet is telemetry a
   * reader has to interpret; a beat that says `hold` is a run saying it is
   * quiet on purpose.
   */
  holdAt(run, next, { resumed = false } = {}) {
    run.held = true;
    run.deferred = next;
    run.deferredResume = resumed;
    run.store.append('stage-held', {
      actor: ACTOR,
      stage: run.stage,
      next,
      ...(resumed && { resumed }),
    });
    this.openPulse(run);
  }

  /**
   * Enters the deferred stage of every run this release frees. A run whose
   * project is still held by another scope stays where it is: the instance
   * hold and a project hold are separate statements, and a release ends the
   * one it names.
   * @returns {string[]} the runs that entered their deferred stage
   */
  releaseHeldRuns() {
    const released = [];
    for (const run of [...this.runs.values()]) {
      if (!run.held || run.closed || this.isHeld(run.project)) continue;
      // The flag drops before the stage runs, so a stage that settles inside
      // this call chains as any stage does and the release enters once.
      const { deferred, deferredResume } = run;
      run.held = false;
      run.deferred = null;
      run.deferredResume = false;
      run.store.append('stage-released', { actor: ACTOR, stage: run.stage, next: deferred });
      released.push(run.runId);
      if (deferredResume) this.executeStage(run);
      else this.enterStage(run, deferred);
    }
    return released;
  }

  executeStage(run) {
    const lane = this.lanes.get(run.lane);
    const handler = lane.handlers[run.stage];
    run.executing = true;
    this.openPulse(run);
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
      // The stack tool of this machine, read per dispatch like the seat
      // defaults: a handler that asks the run's own stack a question spawns
      // the argv the host is configured with, never a name it guessed.
      composeCommand: this.composeCommand(),
      // For stores a handler opens itself (the escapes ledger): the same
      // project-attributed event key the run store carries.
      onAppend: (line, ledger) => this.onEvent?.(run.project, line, ledger),
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
          this.closePulse(run);
          if (this.stopped || run.closed) return;
          this.applyDirective(run, directive);
        },
        (error) => {
          run.executing = false;
          this.closePulse(run);
          if (this.stopped || run.closed) return;
          this.stampViolation(run, `stage handler failed: ${error.message}`);
        },
      );
  }

  /**
   * The stage beat, over the handler the engine is about to run. Every stage
   * of every lane gets one, because the condition it exists for — a stage
   * whose ledger says nothing for hours — belongs to no particular kind of
   * stage. The seat stages looked covered by the seats' own progress stamps
   * until a seat stopped stamping and its stage went silent for four hours
   * (ADR-0034).
   *
   * It records and it decides nothing. The beat holds no run, ends no run and
   * returns no directive; a stage that beats for a day carries on exactly as
   * it would have, and the reading against the duration history happens
   * outside, in a watcher that cannot touch a run either.
   */
  openPulse(run) {
    this.closePulse(run);
    run.pulse = stagePulse(
      { stage: run.stage, store: run.store },
      {
        everyMs: this.heartbeatMs,
        lastBeat: () => run.lastBeatSeq,
        describe: () => {
          if (this.stopped || run.closed || run.parked) return null;
          // A held run is waiting on a person the way a park is, and it is the
          // only wait with nothing of the run's own left running, so it is read
          // before the seats.
          if (run.held) return { waitingOn: 'hold', detail: { next: run.deferred } };
          const seats = [...run.seats].map((s) => s.seat).filter((s) => typeof s === 'string');
          // What the stage is waiting on, in the terms the stage has: the
          // seats in flight, or the handler itself when it runs no child.
          return seats.length > 0
            ? { waitingOn: 'seat', detail: { seats: seats.sort() } }
            : { waitingOn: 'handler' };
        },
      },
    );
  }

  closePulse(run) {
    run.pulse?.close();
    run.pulse = null;
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
      this.chainStage(run, directive.next);
      return;
    }
    if (directive.park) {
      const { type, question, options, text, refs, reason, detail, acks } = directive.park;
      if (!PARK_TYPES.has(type)) {
        this.stampViolation(run, `park type not in the catalog: ${type}`);
        return;
      }
      if (typeof question !== 'string' || question.length === 0) {
        this.stampViolation(run, `park at ${run.stage} carries no question`);
        return;
      }
      // A park that declares neither an option nor a text slot would offer the
      // human `abandon` alone: the stage asked a question it will not read the
      // answer to.
      if ((options ?? []).length === 0 && typeof text !== 'string') {
        this.stampViolation(run, `park at ${run.stage} declares no answer form`);
        return;
      }
      this.park(run, { type, question, options, text, refs, reason, detail, acks });
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

  // -- budget ---------------------------------------------------------------

  /**
   * The lane's budget, evaluated after every seat terminal stamp. The first
   * crossing stamps `budget-breach` once and the run carries on: a threshold
   * informs, and never parks, blocks, or closes anything (ADR-0021). The
   * ledger is the only memory, so a resumed run neither re-stamps nor forgets.
   */
  checkBudget(run, line) {
    const threshold = run.payload?.budget;
    if (typeof threshold !== 'number' || !SEAT_TERMINAL_EVENTS.has(line.event)) return;
    const events = readEvents(runLedgerPath(this.paths, run.runId));
    if (events.some((e) => e.event === 'budget-breach')) return;
    const cost = runCost(events);
    if (cost < threshold) return;
    run.store.append('budget-breach', {
      actor: ACTOR,
      threshold,
      cost,
      stage: run.stage,
      gist:
        `${run.runId} is at $${cost.toFixed(2)} of its $${threshold.toFixed(2)} ` +
        `${run.lane} budget (${run.stage})`,
    });
  }

  // -- loud lifecycle -------------------------------------------------------

  /**
   * Pairs the resolution a loud record owes as soon as the event that owns it
   * lands (ADR-0015). The key is the append itself, so no lane has to remember
   * to clear the record it opened: a run ledger that holds an owning event
   * holds the resolution behind it.
   */
  settleLoud(run, line) {
    if (!OWNER_EVENTS.has(line.event) || run.settling) return;
    // The sweep appends, and every append re-enters this hook. The flag keeps
    // one sweep in flight; its own resolutions own nothing, so nothing is lost.
    run.settling = true;
    try {
      settleOwnedLoud(run.store, { actor: ACTOR });
    } catch {
      // A resolution never fails the append it followed. The close-out sweep
      // is the backstop for anything this pass could not pair.
    } finally {
      run.settling = false;
    }
  }

  /**
   * The backstop under the owning-event sweep: a loud record whose owner never
   * landed, on a run that is now over. A budget breach and a capture take-back
   * both ask for no decision, so the run closes them rather than leaving the
   * owner an alert strip of runs that already ended.
   */
  resolveLoudAtClose(run, state) {
    const events = readEvents(runLedgerPath(this.paths, run.runId));
    const resolved = new Set(events.filter((e) => e.event === 'resolved').map((e) => e.resolves));
    for (const e of events) {
      if (CLOSE_RESOLVED_EVENTS.has(e.event) && !resolved.has(e.seq)) {
        run.store.resolve({ actor: ACTOR, resolves: e.seq, note: `run closed ${state}` });
      }
    }
  }

  // -- park / answer / resume -----------------------------------------------

  // `reason` and `detail` belong to a recoverable failure: they carry the
  // close the run would have taken, so the abandon answer closes on the
  // original condition rather than on whatever the resumed stage meets.
  //
  // `answers` is the record's own statement of what it will take back, the
  // site's declaration plus the `abandon` every run park owes (ADR-0029). It
  // is the whole of the answer contract: the record is what validates an
  // answer, what a refusal quotes, and what the console renders.
  //
  // `acks` says what one of those options will record: the findings an `ack`
  // answer acknowledges, by fingerprint. It sits on the record so the daemon
  // writes the acks from the record and from nothing else (ADR-0032).
  park(run, { type, question, options, text, refs, reason, detail, acks }) {
    run.parked = true;
    const line = run.store.append('park', {
      actor: ACTOR,
      type,
      question,
      answers: runParkForms({ options, text }),
      ...(refs && { refs }),
      ...(reason && { reason }),
      ...(detail && { detail }),
      ...(acks && { acks }),
      gist: gist(`${type}: ${question}`),
    });
    run.parkRecord = line;
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
    // The record is the authority on its own answer forms, and the refusal
    // quotes them, so a rejected answer never sends the operator to the source.
    checkAnswer(run.parkRecord, { option, answer });
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
    // A run may park while held, and its answer is recorded the moment the
    // human gives it — the wait on the human is over. Re-entering the stage is
    // the step the hold stops, so the run holds at the boundary it is already
    // standing at and the resumed stage runs at the release (ADR-0040).
    if (this.isHeld(run.project)) this.holdAt(run, run.stage, { resumed: true });
    else this.executeStage(run);
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
        // A held run is idle because an operator said so, and the resolution of
        // an unrelated violation is not a release.
        if (!run.parked && !run.held && !run.executing && run.seats.size === 0) {
          this.executeStage(run);
        }
      }
    }
    return line;
  }

  // -- close ----------------------------------------------------------------

  /**
   * Ends an open run on a human's word: every in-flight seat is terminated and
   * the run closes `killed` in the same call. The close does not wait for the
   * children to die — a kill lands when the operator asks for it — so a seat
   * that takes a moment stamps its exit after the ledger closed and the
   * archive moved. That stamp is recorded late; it is never a fault
   * (ADR-0015).
   */
  killRun(runId, { actor = ACTOR } = {}) {
    const run = this.runs.get(runId);
    if (!run || run.closed) throw new Error(`no open run: ${runId}`);
    for (const seat of run.seats) seat.terminate('run-killed');
    this.closeRun(run, 'killed', { actor });
  }

  /**
   * The close-out record. It carries what the run closed on and how long the
   * run took, in the two numbers that mean different things: `wallMs` from the
   * launch stamp to this one, and `activeMs` with every parked and inert span
   * taken out. Both are derived from the ledger under the run and from nothing
   * the daemon remembers, so a reader of the archived ledger re-derives them
   * (ADR-0036). The clock read is the close's own, one write ahead of the
   * stamp's `ts`, because the stamp does not exist to be read yet.
   */
  closeRun(run, state, { actor = ACTOR, ...extra } = {}) {
    run.closed = true;
    // A kill closes a run whose handler is still running, and a beat into a
    // ledger the archive has moved is a late append nobody asked for.
    this.closePulse(run);
    this.resolveLoudAtClose(run, state);
    const duration = runDuration(readEvents(runLedgerPath(this.paths, run.runId)), {
      end: new Date().toISOString(),
    });
    run.store.append('run-closed', {
      actor,
      state,
      ...extra,
      ...(duration && { wallMs: duration.wallMs, activeMs: duration.activeMs }),
    });
    run.store.close();
    this.runs.delete(run.runId);
    this.archiveClosedRun(run.runId);
    try {
      this.onClosed?.({ runId: run.runId, project: run.project, lane: run.lane, state });
    } catch {
      // The hook owns its errors; a close never fails on it.
    }
  }

  /**
   * A stamp that arrived for this run after its ledger closed. The kill is
   * where it happens: the close terminates the seats and does not wait for
   * them, so a child that takes a moment to die stamps its exit into a ledger
   * the archive has already moved. The run is over in the state it recorded
   * and nothing behind that close is news, so the stamp does not go back into
   * the run — it goes to the instance ledger as a quiet record of a write that
   * did not land, and the run keeps the terminal state it closed on
   * (ADR-0015).
   */
  recordLateAppend(run, late) {
    if (!this.instanceStore) return;
    try {
      this.instanceStore.append('late-append', {
        actor: ACTOR,
        runId: run.runId,
        lateEvent: late.event,
        ...(late.actor && { lateActor: late.actor }),
        ...(late.seat && { seat: late.seat }),
      });
    } catch {
      // The record of a dropped write is the last thing that may cost an
      // instance. The instance ledger closes at the daemon's own stop, and a
      // seat can outlive that too.
    }
  }

  // -- archive --------------------------------------------------------------

  /**
   * Moves a closed run to the archive, and never fails its caller. The move is
   * the last step of a close and the only one that touches a directory a
   * process outside the harness may be holding open. A blocked move changes
   * nothing about the run: it closed as it closed, and everything it earned is
   * in the ledger under it. So the daemon stamps the block loud and carries on
   * — a run directory in the wrong place is a housekeeping fact, never a fault
   * of the daemon that could not do the housekeeping (ADR-0015).
   * @returns {boolean} whether the run is in the archive now
   */
  archiveClosedRun(runId) {
    let moved;
    try {
      moved = archiveRun(this.paths, runId, this.archiveIo);
    } catch (error) {
      this.stampArchiveFailure(runId, error);
      return false;
    }
    if (!this.instanceStore) return true;
    try {
      this.instanceStore.append('run-archived', {
        actor: ACTOR,
        runId,
        method: moved.method,
        ...(moved.leftover !== null && { leftover: moved.leftover }),
      });
      // The stamp owns any open archive-failure record for this run, and the
      // instance ledger has no per-append sweep of its own, so the pairing
      // happens where the stamp lands.
      settleOwnedLoud(this.instanceStore, { actor: ACTOR });
    } catch {
      // The run is archived. No bookkeeping behind that undoes it.
    }
    return true;
  }

  /**
   * A closed run still under `runs/` at a daemon start. Either the move was
   * blocked at its close, and this start retries it, or the archive already
   * holds the run and what is left here is the source of a copy whose delete
   * was blocked. The leftover goes, against proof that the copy is whole: an
   * archive short of the live ledger is not the run, and that is worth the
   * owner's attention rather than a delete.
   * @returns {boolean} whether the archive is the only copy now
   */
  sweepClosedRun(runId) {
    const archived = readEvents(archivedRunLedgerPath(this.paths, runId));
    if (archived.length === 0) return this.archiveClosedRun(runId);
    const live = readEvents(runLedgerPath(this.paths, runId));
    if (archived.length < live.length) {
      this.stampArchiveFailure(
        runId,
        new Error(`the archived ledger holds ${archived.length} of ${live.length} events`),
      );
      return false;
    }
    try {
      (this.archiveIo.remove ?? rmSync)(join(this.paths.runs, runId), {
        recursive: true,
        force: true,
      });
    } catch {
      // The archived copy is the authority and the archive stamp already named
      // the leftover. A directory that will not go is not an alert.
      return false;
    }
    return true;
  }

  stampArchiveFailure(runId, error) {
    if (!this.instanceStore) return;
    // One open record per run. A start that retries the move and is blocked
    // again reports the same block, and the strip carries it once.
    const events = readEvents(this.paths.instanceLedger);
    const resolved = new Set(events.filter((e) => e.event === 'resolved').map((e) => e.resolves));
    const open = events.some(
      (e) => e.event === 'archive-failed' && e.runId === runId && !resolved.has(e.seq),
    );
    if (open) return;
    this.instanceStore.append('archive-failed', {
      actor: ACTOR,
      runId,
      reason: error.message,
      gist: gist(`${runId} closed but did not archive: ${error.message}`),
    });
  }

  // -- liveness -------------------------------------------------------------

  /**
   * Sweeps the invariant over every open run. The per-transition check stamps
   * at the handler-settle point; this sweep backs it for resume and consoles.
   */
  checkLiveness() {
    const violations = [];
    for (const run of this.runs.values()) {
      if (run.closed || run.parked || run.held || run.violated) continue;
      if (run.executing || run.seats.size > 0) continue;
      this.stampViolation(
        run,
        'no in-flight child, no parked escalation, no operator hold, no transition in progress',
      );
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
   * Resumes every open run from its ledger. A parked, held or violated run
   * stays waiting on the human; every other run re-enters its recorded stage.
   * A run the engine cannot resume (unknown lane or stage) violates loud.
   *
   * A closed run still sitting under `runs/` is a move that was blocked at its
   * close, so the start sweeps it up. The handle that blocked it belonged to
   * another process and rarely survives the gap between two daemons; the run
   * lives in the archive (ADR-0002), and until it gets there its loud record
   * stays open and nothing else would ever move it.
   */
  resumeOpenRuns() {
    const resumed = [];
    for (const runId of runDirs(this.paths.runs)) {
      const events = readEvents(runLedgerPath(this.paths, runId));
      if (events.length === 0) continue;
      const state = deriveRunState(events);
      if (state.closed) {
        this.sweepClosedRun(runId);
        continue;
      }
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
      run.held = state.held;
      run.deferred = state.deferred;
      run.deferredResume = state.deferredResume;
      resumed.push(runId);
      if (run.parked || run.violated) continue;
      const lane = this.lanes.get(run.lane);
      if (!lane || !run.stage || !lane.stages.includes(run.stage)) {
        this.stampViolation(run, `cannot resume: lane ${run.lane}, stage ${run.stage}`);
        continue;
      }
      // A held run resumes as a held run: the stage it completed is not run
      // again, and the stage behind the boundary waits for the release exactly
      // as it did before the restart. The beat picks up where the last instance
      // left it, so the quiet still reads as intentional (ADR-0040).
      if (run.held) {
        if (!lane.stages.includes(run.deferred)) {
          this.stampViolation(run, `cannot resume a hold: unknown deferred stage ${run.deferred}`);
          continue;
        }
        this.openPulse(run);
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
      this.closePulse(run);
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
