// Helpers shared by the lane handlers: ledger-derived position (events,
// parks, seat invocations), project-config loading from the launch blob, and
// the small directive constructors. Every lane re-derives its position from
// the run ledger and the git state — nothing here holds cross-stage memory.
import { readFileSync } from 'node:fs';
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

export function seatFail(seat, result) {
  return {
    close: {
      state: 'failed',
      reason: 'seat-failure',
      seat,
      ...(result.reason ? { cause: result.reason } : {}),
    },
  };
}

export function commandFail(run) {
  // The command could not run at all — an environment defect, not a verdict.
  return { close: { state: 'failed', reason: 'suite-command-error', error: run.error } };
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
