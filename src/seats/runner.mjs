// The headless seat runner: one seat session through the contract loop.
// Acquire the model semaphore, assemble the two-block prompt, spawn the
// child, validate the report file, allow exactly one corrective re-prompt,
// then stamp seat-report or seat-failure. The runner never throws on a seat
// outcome — the lane handler reads the result and decides the route.
//
// Crash retries: a child that dies without a verdict — a nonzero exit or a
// silence deadline, which is the transient class (an API drop, a killed
// connection, a stream that stopped) — is re-dispatched in place on the prompt
// in force, up to CRASH_RETRIES children per seat session. A crashed child
// that named a session id is resumed into that session, so the work it did
// before the drop is not re-bought; without one there is nothing to resume
// into and the retry is a fresh dispatch. Every crashed dispatch stamps its
// own seat-failure with the evidence before the next spawn, and the retry
// spawn carries `retry` with the shape it took, so the ledger reads spawn →
// failure → spawn with nothing silent. Deliberate termination, a cost-ceiling
// breach, and a spawn refusal are never retried: those causes do not change on
// a second try.
//
// Model integrity: a substitute dispatch stamps `model-substituted` before
// the spawn; a transcript model that differs from the requested model is a
// seat-failure on the harness route, never a silent downgrade.
//
// Availability degrade: a seat whose model refuses the work (the stream says
// the model is unavailable) retries once on FALLBACK_MODEL (Claude Opus 5) at
// the same effort, and stamps `model-degraded` first. Effort never drops. The
// fallback moves a certification seat from Claude Fable 5.1 down to the
// substitute, which lowers capability and holds the effort floor, so the
// stamp is the record a reader needs to see who judged the work. A seat
// already on the fallback model, which every default seat is, has nowhere to
// go: the fallback model refusing is a loud failure, not a second retry.
//
// Quota memo: a run that already watched the vendor refuse a model, and holds
// the reset instant the vendor declared, degrades at the spawn instead of
// buying the same rejection again (ADR-0021). The stamp is the same
// `model-degraded`, marked `memo` — no degrade is ever silent, and the
// evidence it stood on is named.
//
// The seat ladder: past the crash retries the seat waits instead of failing
// (ADR-0069). A child that keeps dying of the provider takes 5, 15 and 45
// minutes, one re-dispatch a step, resuming the session where one was named. A
// model the vendor refused with a reset instant waits until that instant and
// one minute, and re-dispatches on the same model — the degrade runs first, so
// what waits here is a seat with no substitute below it. Only a spent ladder
// fails the seat, and the `seat-failure` park behind it is the park it always
// was. A wait spends nothing and stamps no `seat-failure`, so the corrective
// and crash-retry budgets read exactly what they read before.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { superviseSeat } from '../engine/supervise.mjs';
import { COMMAND_LINE_MAX, commandLineLength } from '../engine/executable.mjs';
import { seatDef, FALLBACK_MODEL } from './seatmap.mjs';
import { checkReportSchema, validateReport, readReport } from './contract.mjs';
import { assembleSeatPrompt, correctivePrompt, promptFileRef } from './prompt.mjs';
import { claudeSeatCommand } from './claude.mjs';
import {
  SEAT_LADDER,
  ladderStep,
  seatLadderSince,
  waitAttempt,
  waitFor,
} from '../lanes/waiting.mjs';

const ACTOR = 'daemon';

// Children a seat session may buy back after nonzero exits, shared across the
// whole session (both contract attempts and a degrade re-dispatch). The
// command center reads it too, to say how much of the allowance a retrying
// seat has spent.
export const CRASH_RETRIES = 3;

/**
 * What is added to the vendor's own reset instant before the seat asks again.
 * The instant is the vendor's statement about when it will take work, and a
 * request that lands on the same second is a request that races it.
 */
export const RESET_GRACE_MS = 60_000;

/**
 * The failure reasons a fresh child may answer. Both are a child that stopped
 * without a verdict and neither says anything about the work: an exit code the
 * CLI never chose, and a stream that went silent long enough to call the child
 * dead (ADR-0037).
 */
const RETRYABLE = new Set(['exit', 'silence']);

/**
 * Runs one seat session end to end.
 * @param {import('../telemetry/stores.mjs').TelemetryStore} store
 * @param {{seat: string, roleBlock: string, reportPath: string, schema: object,
 *   constitution?: string|null,
 *   substitute?: {model: string, reason: string},
 *   semaphores?: import('./semaphore.mjs').ModelSemaphores,
 *   cwd?: string, env?: object, secretEnv?: string[], costCeiling?: number,
 *   silenceMs?: number, claudeCommand?: string[], denyTools?: string[],
 *   waits?: {register?: Function, holdBarrier?: Function},
 *   sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   commandFor?: (opts: object) => {cmd: string, args: string[], parseLine?: Function},
 *   supervise?: (opts: object) => Promise<object>}} opts
 *   commandFor substitutes the claude argv builder (tests, fixture seats).
 *   supervise substitutes the child supervisor — the engine passes its
 *   tracked wrapper so the liveness invariant sees the in-flight child.
 * @returns {Promise<{ok: boolean, report?: object, model?: string, [k: string]: unknown}>}
 */
export async function runSeat(store, opts) {
  const {
    seat,
    roleBlock,
    reportPath,
    schema,
    constitution,
    substitute,
    semaphores,
    cwd,
    env,
    secretEnv,
    costCeiling,
    silenceMs,
    claudeCommand,
    denyTools,
    // The engine's wait seam and the clock behind it: the ladder below is the
    // one place a seat session stops and does nothing, and the run has to be
    // readable as waiting while it does (ADR-0069).
    waits,
    sleep,
    now = Date.now,
    commandFor = claudeSeatCommand,
    supervise = (superviseOpts) => superviseSeat(store, superviseOpts).done,
  } = opts;
  const def = seatDef(seat);
  if (typeof reportPath !== 'string' || reportPath.length === 0) {
    throw new Error('runSeat requires a reportPath');
  }
  const schemaErrors = checkReportSchema(schema);
  if (schemaErrors.length > 0) {
    const detail = schemaErrors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`report schema outside the flat subset: ${detail}`);
  }
  let model = substitute?.model ?? def.model;
  if (substitute && substitute.model !== def.model) {
    if (typeof substitute.reason !== 'string' || substitute.reason.length === 0) {
      throw new Error('a substitute dispatch requires a reason');
    }
    store.append('model-substituted', {
      actor: ACTOR,
      seat,
      from: def.model,
      to: substitute.model,
      reason: substitute.reason,
    });
  }
  mkdirSync(dirname(reportPath), { recursive: true });
  let degraded = false;
  const waitCtx = { store, waits, ...(sleep && { sleep }), now };
  // Where this seat's ladder stands, and whether the vendor's own instant has
  // already been waited out, both read from the ledger and never from this
  // session. A restart re-dispatches the seat into a new session, and a ladder
  // counted in that session's memory would start again at five minutes every
  // time the daemon came back (ADR-0069). The crash retries above stay a
  // session budget, which is what ADR-0005 gives them.
  const ladderFrom = () => seatLadderSince(store.events(), seat);
  const seatWaits = () =>
    store
      .events()
      .filter(
        (e) =>
          e.event === 'waiting' &&
          e.kind === 'seat' &&
          e.detail?.seat === seat &&
          e.seq > ladderFrom(),
      );
  // The ladder's own rungs, and never the vendor's instant beside them: a
  // wait on a declared reset window is the window, not a step of the ladder,
  // so the three steps are still owed after it (ADR-0069).
  const ladderPosition = () =>
    waitAttempt(store.events(), 'seat', {
      since: ladderFrom(),
      match: (e) => e.detail?.seat === seat && typeof e.detail?.resetsAt !== 'number',
    });
  const resetWaited = () => seatWaits().some((e) => typeof e.detail?.resetsAt === 'number');
  // Every reason this session collected, in order: one per dispatch that died
  // and one per wait it bought. A seat that fails on a spent ladder says what
  // it spent it on, rather than naming the last of eight identical endings.
  const collected = [];
  // The memo is read before the semaphore: a seat that will run on the
  // fallback model must hold the fallback model's slot, not the refused
  // model's. A seat already on the fallback model has no memo to read.
  const memo = model === FALLBACK_MODEL ? null : unavailableMemo(store.events(), model);
  if (memo !== null) {
    store.append('model-degraded', {
      actor: ACTOR,
      seat,
      requested: model,
      used: FALLBACK_MODEL,
      ...(memo.reason && { reason: memo.reason }),
      attempt: 1,
      resetsAt: memo.resetsAt,
      memo: true,
    });
    model = FALLBACK_MODEL;
    degraded = true;
  }
  let release = semaphores ? await semaphores.acquire(model, { store, seat }) : () => {};
  try {
    let prompt = assembleSeatPrompt({ seat, def, reportPath, schema, roleBlock, constitution });
    let resume;
    // One dispatch: build the argv for the model in force and supervise the
    // child. `seat-spawned` carries the model actually spawned, so a degraded
    // retry reads as its own spawn on the model that judged the work.
    const dispatch = (attempt, retry = 0, waited = 0) => {
      const build = (text) =>
        commandFor({
          claudeCommand,
          prompt: text,
          model,
          effort: def.effort,
          def,
          denyTools,
          attempt,
          resume,
        });
      let spec = build(prompt);
      // A prompt is content, and content has no bound the harness controls:
      // a correction brief carries one line per defect, a constitution grows
      // with the project, a tool deny list grows with the test tree. Past the
      // command-line ceiling the spawn dies with `ENAMETOOLONG` — no child,
      // no transcript, and a stage handler that failed for a reason no ledger
      // reader can see. So the prompt moves to a file and the command line
      // carries the path. Below the ceiling nothing changes: the prompt rides
      // argv byte for byte, as it always has.
      if (commandLineLength([spec.cmd, ...spec.args]) > COMMAND_LINE_MAX) {
        const path = promptPath(reportPath, attempt, retry);
        writeFileSync(path, prompt, 'utf8');
        store.append('prompt-spilled', {
          actor: ACTOR,
          seat,
          attempt,
          ...(retry > 0 && { retry }),
          path,
          chars: prompt.length,
        });
        spec = build(promptFileRef(path));
      }
      return supervise({
        seat,
        cmd: spec.cmd,
        args: spec.args,
        cwd,
        env,
        secretEnv,
        costCeiling,
        ...(silenceMs !== undefined && { silenceMs }),
        ...(spec.parseLine && { parseLine: spec.parseLine }),
        spawnFields: {
          model,
          effort: def.effort,
          attempt,
          // A retry names the shape it took: resumed into the session the
          // crashed child was writing, or dispatched fresh. `resumed` is
          // stamped either way, so a reader never has to read absence.
          ...(retry > 0 && {
            retry,
            resumed: resume !== undefined,
            ...(resume !== undefined && { session: resume }),
          }),
          ...(attempt === 2 && { corrective: true }),
          ...(degraded && { degraded: true }),
          // The ladder step this dispatch stands on, so a spawn after a wait
          // reads as one rather than as a retry nobody can account for.
          ...(waited > 0 && { afterWait: waited }),
        },
      });
    };
    // The crash-retry loop reads `model` and `prompt` from the enclosing
    // scope, so a retry after a degrade or a corrective runs on whatever is
    // now in force. Only `exit` and `silence` qualify: `terminated` is
    // deliberate, `cost-ceiling` and `spawn` do not change on a second try,
    // and an unavailable model has its own route below.
    let crashRetries = 0;
    // The session a dying child named, carried into whatever re-dispatches
    // next: the crash retry in place, and the ladder step after a wait.
    const carrySession = (result) => {
      const sessionId = result.meta?.sessionId;
      if (typeof sessionId === 'string' && sessionId.length > 0) resume = sessionId;
    };
    const dispatchWithRetries = async (attempt) => {
      let result = await dispatch(attempt, 0, ladderPosition() - 1);
      while (result.failed === true && RETRYABLE.has(result.reason) && crashRetries < CRASH_RETRIES) {
        crashRetries++;
        // A session id the dying child named is the work it had already
        // bought: every finding it reached, every file it read. Resuming
        // costs the drop; a fresh child costs the whole session again. A
        // crash before the transcript named a session leaves nothing to
        // resume into, and the retry keeps whatever resume was in force.
        carrySession(result);
        result = await dispatch(attempt, crashRetries, ladderPosition() - 1);
      }
      return result;
    };
    // A wait holds no model slot. A ladder step is up to forty-five minutes of
    // doing nothing, and a seat that kept its semaphore through it would stop
    // every other run's seat on that model for the same forty-five minutes
    // (ADR-0005). The slot is given back before the wait and taken again after
    // it; a wait the daemon cancels throws, and the release the `finally`
    // below calls is then the one this left behind, which does nothing.
    const idle = async (fn) => {
      release();
      release = () => {};
      await fn();
      release = semaphores ? await semaphores.acquire(model, { store, seat }) : () => {};
    };
    // One step of the seat ladder: the wait, then one re-dispatch into the
    // session the dead child named. Null when the ladder is spent, which is
    // the only way a provider failure reaches the park.
    const seatLadderStep = async (result, attempt) => {
      const rung = ladderPosition();
      const step = ladderStep(SEAT_LADDER, rung);
      if (step === null) return null;
      collected.push(`waited ${Math.round(step / 60_000)}m`);
      await idle(() =>
        waitFor(waitCtx, {
          kind: 'seat',
          reason: result.reason ?? 'exit',
          ms: step,
          attempt: rung,
          detail: { seat, model },
        }),
      );
      carrySession(result);
      return dispatch(attempt, 0, rung);
    };
    // A model with no substitute below it, refused. The vendor's own reset
    // instant is the better wait when it named one — the run asks again a
    // minute after the window it was told about, once — and the seat ladder is
    // what a rejection with no instant on it takes.
    const unavailableStep = async (result, attempt) => {
      if (typeof result.resetsAt === 'number' && !resetWaited()) {
        const rung = ladderPosition();
        const ms = result.resetsAt * 1000 + RESET_GRACE_MS - now();
        if (ms > 0) {
          await idle(() =>
            waitFor(waitCtx, {
              kind: 'seat',
              reason: 'model-unavailable',
              ms,
              attempt: rung,
              detail: { seat, model, resetsAt: result.resetsAt },
            }),
          );
        } else {
          // The instant is already behind us, so there is nothing to wait out.
          // The stamp still lands, because the ledger has to say the vendor's
          // own window was read and spent.
          const opened = store.append('waiting', {
            actor: ACTOR,
            kind: 'seat',
            reason: 'model-unavailable',
            until: new Date(result.resetsAt * 1000 + RESET_GRACE_MS).toISOString(),
            attempt: rung,
            detail: { seat, model, resetsAt: result.resetsAt },
          });
          store.append('waiting-ended', {
            actor: ACTOR,
            kind: 'seat',
            outcome: 'elapsed',
            waitSeq: opened.seq,
            elapsed: 0,
          });
        }
        return dispatch(attempt, 0, rung);
      }
      return seatLadderStep(result, attempt);
    };
    // One attempt of the contract loop, with every wait the provider's own
    // failures buy. A seat that never meets one runs exactly the dispatches it
    // ran before this existed.
    const dispatchWithWaits = async (attempt) => {
      let result = await dispatchWithRetries(attempt);
      for (;;) {
        if (result.failed === true || result.terminated === true) {
          collected.push(result.reason ?? 'unknown');
        }
        let next = null;
        if (result.failed === true && RETRYABLE.has(result.reason)) {
          next = await seatLadderStep(result, attempt);
        } else if (result.reason === 'model-unavailable' && (degraded || model === FALLBACK_MODEL)) {
          // The degrade route runs first, in the loop below. What reaches this
          // is a seat that has nowhere left to degrade to, and the answer for
          // it is the wait rather than the failure.
          next = await unavailableStep(result, attempt);
        }
        if (next === null) return result;
        result = next;
      }
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      let result = await dispatchWithWaits(attempt);
      if (result.reason === 'model-unavailable') {
        if (!degraded && model !== FALLBACK_MODEL) {
          store.append('model-degraded', {
            actor: ACTOR,
            seat,
            requested: model,
            used: FALLBACK_MODEL,
            reason: result.unavailable,
            attempt,
            ...(typeof result.resetsAt === 'number' && { resetsAt: result.resetsAt }),
          });
          // The semaphore counts seats per model; the retry belongs to the
          // fallback model's cap, not the one that refused.
          release();
          model = FALLBACK_MODEL;
          degraded = true;
          release = semaphores ? await semaphores.acquire(model, { store, seat }) : () => {};
          // A rejected model wrote no transcript to resume into.
          resume = undefined;
          result = await dispatchWithWaits(attempt);
        }
        if (result.reason === 'model-unavailable') {
          store.append('seat-failure', {
            actor: ACTOR,
            seat,
            reason: 'model-unavailable',
            model,
            cause: result.unavailable,
            ...(degraded && { degraded: true }),
            ...(typeof result.resetsAt === 'number' && { resetsAt: result.resetsAt }),
            // Every ending this session met, in order, and the waits it bought
            // between them. The last reason alone says a model was refused; the
            // list says how long the harness went on asking (ADR-0069).
            ...(collected.length > 0 && { reasons: [...collected] }),
            ...(result.stderrTail && { stderrTail: result.stderrTail }),
            ...(result.stdoutTail && { stdoutTail: result.stdoutTail }),
          });
          return { ok: false, ...result, model, reasons: [...collected] };
        }
      }
      if (result.failed || result.terminated) {
        return { ok: false, ...result, ...(collected.length > 0 && { reasons: [...collected] }) };
      }
      const actual = result.meta?.model;
      if (typeof actual === 'string' && actual !== model) {
        store.append('seat-failure', {
          actor: ACTOR,
          seat,
          reason: 'model-mismatch',
          requested: model,
          actual,
        });
        return { ok: false, failed: true, reason: 'model-mismatch', requested: model, actual };
      }
      const read = readReport(reportPath);
      const errors = read.errors ?? validateReport(schema, read.value);
      if (errors.length === 0) {
        store.append('seat-report', {
          actor: seat,
          seat,
          path: reportPath,
          attempt,
          cost: result.cost,
          ...(typeof actual === 'string' && { model: actual }),
        });
        return { ok: true, report: read.value, model: actual ?? model, cost: result.cost };
      }
      if (attempt === 1) {
        prompt = correctivePrompt({ reportPath, schema, errors, missing: read.missing === true });
        resume = result.meta?.sessionId;
        continue;
      }
      store.append('seat-failure', {
        actor: ACTOR,
        seat,
        reason: 'report-invalid',
        path: reportPath,
        errors: errors.map((e) => `${e.path}: ${e.message}`),
      });
      return { ok: false, failed: true, reason: 'report-invalid', errors };
    }
  } finally {
    release();
  }
}

/**
 * Where a spilled prompt is written: beside the report the same dispatch will
 * write, under the report's own name. Every dispatch of a seat session gets
 * its own file, because a corrective attempt and a crash retry carry
 * different prompts and the ledger names the file each spawn actually read.
 */
function promptPath(reportPath, attempt, retry) {
  const name = reportPath.replace(/\.json$/i, '');
  return join(dirname(reportPath), `${basenameOf(name)}.prompt-${attempt}${retry > 0 ? `-r${retry}` : ''}.txt`);
}

function basenameOf(path) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * The ledger's standing record of a model the vendor refused: the latest
 * rejection this ledger holds for that model, when the reset instant it came
 * with has not yet arrived. Both stamps that record a rejection are read — a
 * `model-degraded` names the refusing model in `requested`, a `seat-failure`
 * on reason `model-unavailable` names it in `model` — so the memo works
 * whether the first seat degraded or failed.
 *
 * `resetsAt` is the vendor's own declaration, in Unix seconds. Comparing it
 * to now reads a fact the vendor stated; no elapsed time is measured, and
 * nothing here expires on a clock of the harness's own.
 * @returns {{resetsAt: number, reason: string|undefined}|null}
 */
export function unavailableMemo(events, model) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (typeof e.resetsAt !== 'number') continue;
    let reason;
    if (e.event === 'model-degraded' && e.requested === model) reason = e.reason;
    else if (e.event === 'seat-failure' && e.reason === 'model-unavailable' && e.model === model) {
      reason = e.cause;
    } else continue;
    return e.resetsAt * 1000 > Date.now() ? { resetsAt: e.resetsAt, reason } : null;
  }
  return null;
}
