// The headless seat runner: one seat session through the contract loop.
// Acquire the model semaphore, assemble the two-block prompt, spawn the
// child, validate the report file, allow exactly one corrective re-prompt,
// then stamp seat-report or seat-failure. The runner never throws on a seat
// outcome — the lane handler reads the result and decides the route.
//
// Model integrity: a substitute dispatch stamps `model-substituted` before
// the spawn; a transcript model that differs from the requested model is a
// seat-failure on the harness route, never a silent downgrade.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { superviseSeat } from '../engine/supervise.mjs';
import { seatDef } from './seatmap.mjs';
import { checkReportSchema, validateReport, readReport } from './contract.mjs';
import { assembleSeatPrompt, correctivePrompt } from './prompt.mjs';
import { claudeSeatCommand } from './claude.mjs';

const ACTOR = 'daemon';

/**
 * Runs one seat session end to end.
 * @param {import('../telemetry/stores.mjs').TelemetryStore} store
 * @param {{seat: string, roleBlock: string, reportPath: string, schema: object,
 *   substitute?: {model: string, reason: string},
 *   semaphores?: import('./semaphore.mjs').ModelSemaphores,
 *   cwd?: string, env?: object, costCeiling?: number,
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
    substitute,
    semaphores,
    cwd,
    env,
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
  const model = substitute?.model ?? def.model;
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
  const release = semaphores ? await semaphores.acquire(model, { store, seat }) : () => {};
  try {
    let prompt = assembleSeatPrompt({ seat, def, reportPath, schema, roleBlock });
    let resume;
    for (let attempt = 1; attempt <= 2; attempt++) {
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
      const result = await supervise({
        seat,
        cmd: spec.cmd,
        args: spec.args,
        cwd,
        env,
        costCeiling,
        ...(spec.parseLine && { parseLine: spec.parseLine }),
        spawnFields: {
          model,
          effort: def.effort,
          attempt,
          ...(attempt === 2 && { corrective: true }),
        },
      });
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
        prompt = correctivePrompt({ reportPath, schema, errors });
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
