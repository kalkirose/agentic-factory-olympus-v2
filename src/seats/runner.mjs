// The headless seat runner: one seat session through the contract loop.
// Acquire the model semaphore, assemble the two-block prompt, spawn the
// child, validate the report file, allow exactly one corrective re-prompt,
// then stamp seat-report or seat-failure. The runner never throws on a seat
// outcome — the lane handler reads the result and decides the route.
//
// Crash retries: a child that dies without a verdict — a nonzero exit, which
// is the transient class (an API drop, a killed connection) — is re-dispatched
// in place on the prompt in force, up to CRASH_RETRIES children per seat
// session. A crashed child that named a session id is resumed into that
// session, so the work it did before the drop is not re-bought; without one
// there is nothing to resume into and the retry is a fresh dispatch. Every
// crashed dispatch stamps its own seat-failure with the evidence before the
// next spawn, and the retry spawn carries `retry` with the shape it took, so
// the ledger reads spawn → failure → spawn with nothing silent. Deliberate
// termination, a cost-ceiling breach, and a spawn refusal are never retried:
// those causes do not change on a second try.
//
// Model integrity: a substitute dispatch stamps `model-substituted` before
// the spawn; a transcript model that differs from the requested model is a
// seat-failure on the harness route, never a silent downgrade.
//
// Availability degrade: a seat whose model refuses the work (the stream says
// the model is unavailable) retries once on the default model at the same
// effort, and stamps `model-degraded` first. Effort never drops. The fallback
// only ever moves a seat from the certification model to the default model,
// which raises capability, so no floor is at risk. The default model refusing
// too is a loud failure, not a second retry.
//
// Quota memo: a run that already watched the vendor refuse a model, and holds
// the reset instant the vendor declared, degrades at the spawn instead of
// buying the same rejection again (ADR-0021). The stamp is the same
// `model-degraded`, marked `memo` — no degrade is ever silent, and the
// evidence it stood on is named.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { superviseSeat } from '../engine/supervise.mjs';
import { seatDef, DEFAULT_MODEL } from './seatmap.mjs';
import { checkReportSchema, validateReport, readReport } from './contract.mjs';
import { assembleSeatPrompt, correctivePrompt } from './prompt.mjs';
import { claudeSeatCommand } from './claude.mjs';

const ACTOR = 'daemon';

// Children a seat session may buy back after nonzero exits, shared across the
// whole session (both contract attempts and a degrade re-dispatch). The
// command center reads it too, to say how much of the allowance a retrying
// seat has spent.
export const CRASH_RETRIES = 3;

/**
 * Runs one seat session end to end.
 * @param {import('../telemetry/stores.mjs').TelemetryStore} store
 * @param {{seat: string, roleBlock: string, reportPath: string, schema: object,
 *   constitution?: string|null,
 *   substitute?: {model: string, reason: string},
 *   semaphores?: import('./semaphore.mjs').ModelSemaphores,
 *   cwd?: string, env?: object, secretEnv?: string[], costCeiling?: number,
 *   claudeCommand?: string[], denyTools?: string[],
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
    claudeCommand,
    denyTools,
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
  // The memo is read before the semaphore: a seat that will run on the default
  // model must hold the default model's slot, not the refused model's.
  const memo = model === DEFAULT_MODEL ? null : unavailableMemo(store.events(), model);
  if (memo !== null) {
    store.append('model-degraded', {
      actor: ACTOR,
      seat,
      requested: model,
      used: DEFAULT_MODEL,
      ...(memo.reason && { reason: memo.reason }),
      attempt: 1,
      resetsAt: memo.resetsAt,
      memo: true,
    });
    model = DEFAULT_MODEL;
    degraded = true;
  }
  let release = semaphores ? await semaphores.acquire(model, { store, seat }) : () => {};
  try {
    let prompt = assembleSeatPrompt({ seat, def, reportPath, schema, roleBlock, constitution });
    let resume;
    // One dispatch: build the argv for the model in force and supervise the
    // child. `seat-spawned` carries the model actually spawned, so a degraded
    // retry reads as its own spawn on the model that judged the work.
    const dispatch = (attempt, retry = 0) => {
      const spec = commandFor({
        claudeCommand,
        prompt,
        model,
        effort: def.effort,
        def,
        denyTools,
        attempt,
        resume,
      });
      return supervise({
        seat,
        cmd: spec.cmd,
        args: spec.args,
        cwd,
        env,
        secretEnv,
        costCeiling,
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
        },
      });
    };
    // The crash-retry loop reads `model` and `prompt` from the enclosing
    // scope, so a retry after a degrade or a corrective runs on whatever is
    // now in force. Only reason `exit` qualifies: `terminated` is deliberate,
    // `cost-ceiling` and `spawn` do not change on a second try, and an
    // unavailable model has its own route below.
    let crashRetries = 0;
    const dispatchWithRetries = async (attempt) => {
      let result = await dispatch(attempt);
      while (result.failed === true && result.reason === 'exit' && crashRetries < CRASH_RETRIES) {
        crashRetries++;
        // A session id the dying child named is the work it had already
        // bought: every finding it reached, every file it read. Resuming
        // costs the drop; a fresh child costs the whole session again. A
        // crash before the transcript named a session leaves nothing to
        // resume into, and the retry keeps whatever resume was in force.
        const sessionId = result.meta?.sessionId;
        if (typeof sessionId === 'string' && sessionId.length > 0) resume = sessionId;
        result = await dispatch(attempt, crashRetries);
      }
      return result;
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      let result = await dispatchWithRetries(attempt);
      if (result.reason === 'model-unavailable') {
        if (!degraded && model !== DEFAULT_MODEL) {
          store.append('model-degraded', {
            actor: ACTOR,
            seat,
            requested: model,
            used: DEFAULT_MODEL,
            reason: result.unavailable,
            attempt,
            ...(typeof result.resetsAt === 'number' && { resetsAt: result.resetsAt }),
          });
          // The semaphore counts seats per model; the retry belongs to the
          // default model's cap, not the one that refused.
          release();
          model = DEFAULT_MODEL;
          degraded = true;
          release = semaphores ? await semaphores.acquire(model, { store, seat }) : () => {};
          // A rejected model wrote no transcript to resume into.
          resume = undefined;
          result = await dispatchWithRetries(attempt);
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
            ...(result.stderrTail && { stderrTail: result.stderrTail }),
            ...(result.stdoutTail && { stdoutTail: result.stdoutTail }),
          });
          return { ok: false, ...result, model };
        }
      }
      if (result.failed || result.terminated) return { ok: false, ...result };
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
