// Helpers shared by the lane handlers: ledger-derived position (events,
// parks, seat invocations), project-config loading from the launch blob, and
// the small directive constructors. Every lane re-derives its position from
// the run ledger and the git state — nothing here holds cross-stage memory.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { readEvents } from '../ledger/ledger.mjs';
import { runLedgerPath } from '../daemon/home.mjs';
import { parseProjectConfig, underEntry } from '../config/project.mjs';
import { cloneDir } from '../isolation/clones.mjs';
import { git } from '../isolation/git.mjs';
import { stackEnv } from '../isolation/stacks.mjs';

export const ACTOR = 'daemon';
export const GIST_MAX = 120;

export async function loadProjectConfig(ctx) {
  const clone = cloneDir(ctx.paths, ctx.project);
  const text = await git(['cat-file', '-p', ctx.payload.configBlob], { cwd: clone });
  return parseProjectConfig(text, `${ctx.project}#${ctx.payload.configBlob}`);
}

/**
 * The run's stack env: the same derivation the stack rose from at provision.
 * Every project-config command and every seat spawned inside the run gets it,
 * so a host-run suite can find the stack it belongs to (no fixed host ports —
 * the project resolves published ports from the compose project name).
 * Undefined when the project has no stack.
 */
export function runEnv(ctx, config) {
  if (!config.stack) return undefined;
  return stackEnv({
    runId: ctx.runId,
    worktree: ctx.payload.worktree,
    extra: config.stack.env,
  });
}

export function runEvents(ctx) {
  return readEvents(runLedgerPath(ctx.paths, ctx.runId));
}

/** The latest park of a type and the answer that followed it, if any. */
export function answeredPark(events, type) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'park' && e.type === type) {
      const answer = events.slice(i + 1).find((a) => a.event === 'answer' && a.parkSeq === e.seq);
      return { park: e, answer: answer ?? null };
    }
  }
  return null;
}

/** Every answered park as a Q→A pair, for seat role blocks. */
export function escalationLog(events) {
  const pairs = [];
  for (const e of events) {
    if (e.event !== 'park') continue;
    const answer = events.find((a) => a.event === 'answer' && a.parkSeq === e.seq);
    if (answer) {
      pairs.push({
        type: e.type,
        question: e.question,
        answer: answer.option ?? answer.answer,
        actor: answer.actor,
      });
    }
  }
  return pairs;
}

/** Completed seat sessions for a seat (corrective re-prompts not counted). */
export function invocationCount(events, seat) {
  return events.filter((e) => e.event === 'seat-spawned' && e.seat === seat && e.attempt === 1).length;
}

export function seatReportAfter(events, seat, seq) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'seat-report' && e.seat === seat && e.seq > seq) return e;
  }
  return null;
}

export function lastSeatReportEvent(events, seat) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'seat-report' && e.seat === seat) return e;
  }
  return null;
}

export function readJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function parkDirective(type, { question, options, refs }) {
  return { park: { type, question, ...(options && { options }), ...(refs && { refs }) } };
}

// -- recoverable failures (ADR-0015) -----------------------------------------

// Terminal-state discipline: a run reaches `run-closed` through the ship
// path, a human kill, or a human answering a park with its abandon option.
// Every other failure parks under one of these types, so a run holding sound
// work waits for a decision instead of dying with the condition it met.
export const RECOVERY_PARKS = new Set(['seat-failure', 'stage-blocked', 'command-error']);
export const RECOVERY_OPTIONS = Object.freeze(['retry', 'abandon']);

/** The run's latest recovery park of any type, with its answer. */
export function lastRecoveryPark(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== 'park' || !RECOVERY_PARKS.has(e.type)) continue;
    const answer = events.slice(i + 1).find((a) => a.event === 'answer' && a.parkSeq === e.seq);
    return { park: e, answer: answer ?? null };
  }
  return null;
}

/**
 * The abandon route: a recovery park answered `abandon` closes the run with
 * the reason and detail its park recorded. Checked at every stage entry, so
 * the answer lands before the stage spends anything else.
 */
export function abandonedClose(events) {
  const asked = lastRecoveryPark(events);
  if (asked?.answer?.option !== 'abandon') return null;
  return {
    close: {
      state: 'failed',
      reason: asked.park.reason ?? 'abandoned',
      ...(asked.park.detail ?? {}),
      abandoned: asked.park.seq,
    },
  };
}

const GUARDED = Symbol('abandon-guard');

/**
 * Wraps a lane's handlers with the abandon guard. Every stage entry answers
 * the same question first: did the human abandon the run at its last park?
 * Idempotent — a composed lane wraps its continuation's handlers again, and
 * one guard per stage is enough.
 * @param {Record<string, Function>} handlers
 */
export function withAbandonGuard(handlers) {
  return Object.fromEntries(
    Object.entries(handlers).map(([stage, handler]) => {
      if (handler[GUARDED]) return [stage, handler];
      const guarded = (ctx) => abandonedClose(runEvents(ctx)) ?? handler(ctx);
      guarded[GUARDED] = true;
      return [stage, guarded];
    }),
  );
}

/**
 * Routes a recoverable failure: the run parks with `retry` and `abandon`
 * instead of closing. One answer buys one attempt — the failure that follows
 * a bought retry parks again, so no arm loops on its own authority.
 */
export function recover(ctx, { type, reason, question, refs, ...detail }) {
  const abandoned = abandonedClose(runEvents(ctx));
  if (abandoned) return abandoned;
  return {
    park: {
      type,
      reason,
      question,
      options: [...RECOVERY_OPTIONS],
      ...(refs && { refs }),
      ...(Object.keys(detail).length > 0 && { detail }),
    },
  };
}

/** A stage precondition the run cannot settle itself. */
export function blocked(ctx, reason, question, detail = {}) {
  return recover(ctx, { type: 'stage-blocked', reason, question, ...detail });
}

/** A configured command that could not run at all — an environment defect. */
export function commandError(ctx, reason, question, detail = {}) {
  return recover(ctx, { type: 'command-error', reason, question, ...detail });
}

/**
 * A seat that could not deliver a usable work product past its corrective
 * invocation. The failure evidence stays in the ledger; a bought retry
 * carries it into the next invocation's brief.
 */
export function seatFail(ctx, seat, result) {
  const cause = result.reason ?? null;
  return recover(ctx, {
    type: 'seat-failure',
    reason: 'seat-failure',
    seat,
    ...(cause && { cause }),
    question:
      `The ${seat} seat failed after its corrective invocation` +
      (cause ? ` (${cause})` : '') +
      `. Answer "retry" for one fresh ${seat} invocation carrying the failure ` +
      'evidence, or "abandon" to close the run.',
  });
}

export function commandFail(ctx, run) {
  return commandError(
    ctx,
    'suite-command-error',
    `The suite command could not run: ${run.error}\n` +
      'Repair the environment, then answer "retry" for one more attempt, or ' +
      '"abandon" to close the run.',
    { error: run.error },
  );
}

/**
 * The attempt budget of a lane contract loop. A bought retry is one fresh
 * invocation, not a second corrective round: the corrective round already ran
 * before the park that bought it.
 */
export function attemptLimit(events, seat) {
  const asked = lastRecoveryPark(events);
  if (!asked?.answer || asked.park.type !== 'seat-failure' || asked.park.detail?.seat !== seat) {
    return 2;
  }
  return events.some((e) => e.event === 'seat-spawned' && e.seq > asked.answer.seq) ? 2 : 1;
}

/** The failure evidence a bought retry carries into the seat's brief. */
export function failureBrief(events, seat) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== 'seat-failure' || e.seat !== seat) continue;
    if (Array.isArray(e.defects)) return e.defects;
    if (Array.isArray(e.errors)) return e.errors;
    return [e.cause ? `${e.reason}: ${e.cause}` : e.reason];
  }
  return null;
}

/**
 * A corrected absolute path carried by the answer to a `stage-blocked` park
 * raised for one reason. The repair lane's intake ticket is the one input a
 * human can hand over in the answer itself; the ledger holds it, so a restart
 * and every later stage resolve the same path.
 */
export function answeredPath(events, reason) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== 'park' || e.type !== 'stage-blocked' || e.reason !== reason) continue;
    const text = events.slice(i + 1).find((a) => a.event === 'answer' && a.parkSeq === e.seq)?.answer;
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    return trimmed.length > 0 && isAbsolute(trimmed) ? trimmed : null;
  }
  return null;
}

/** True when the file falls under any path entry (prefix or glob). */
export function underAny(file, entries) {
  return entries.some((entry) => underEntry(file, entry));
}

export function briefLines(brief) {
  if (!brief) return [];
  const items = Array.isArray(brief) ? brief : [brief];
  return ['Correction brief — fix these defects:', ...items.map((d) => `- ${d}`)];
}

export function gist(text) {
  if (typeof text !== 'string') return '';
  return text.length > GIST_MAX ? text.slice(0, GIST_MAX - 1) + '…' : text;
}
