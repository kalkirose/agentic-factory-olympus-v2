// Helpers shared by the lane handlers: ledger-derived position (events,
// parks, seat invocations), project-config loading from the launch blob, and
// the small directive constructors. Every lane re-derives its position from
// the run ledger and the git state — nothing here holds cross-stage memory.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readEvents } from '../ledger/ledger.mjs';
import { isAbandon } from '../ledger/parks.mjs';
import { runLedgerPath, runReportPath } from '../daemon/home.mjs';
import {
  DEFAULT_CONSTITUTION_PATH,
  parseProjectConfig,
  underEntry,
} from '../config/project.mjs';
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
 * The project constitution: standing policy the project versions in its own
 * repository, ranked above the intent card and above the run's spec. It is
 * read from the run's worktree, so a run judges against the policy that
 * shipped with the tree it holds. An absent, unreadable, or empty file
 * returns null, and every seat prompt stays what it was.
 */
export function readConstitution(worktree, config) {
  const path = join(worktree, config.constitutionPath ?? DEFAULT_CONSTITUTION_PATH);
  try {
    const text = readFileSync(path, 'utf8');
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
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

/**
 * The latest recorded work-product failure of a seat after a point in the
 * ledger, or null. A seat report says the seat answered; only this says whether
 * the answer stood, so a caller that reads a report alone reads a failed
 * amendment as a completed one.
 */
export function seatFailureAfter(events, seat, seq) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'seat-failure' && e.seat === seat && e.seq > seq) return e;
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

/**
 * The files the run's freeze exempted from the test-edit boundary: test-path
 * files the spec assigned to the implementing seat (ADR-0019). A run that
 * inherited a freeze holds the record it inherited, so both routes read the
 * same file. An absent or older record exempts nothing.
 */
export function freezeExclusions(paths, runId) {
  const record = readJson(join(paths.runs, runId, 'freeze.json'));
  return Array.isArray(record?.frozenExclusions) ? record.frozenExclusions : [];
}

/**
 * The suite files the run's freeze named. An absent or older record names none,
 * and every reader of it treats that as "nothing known", never as "no suite".
 */
export function freezeSuiteFiles(paths, runId) {
  const record = readJson(join(paths.runs, runId, 'freeze.json'));
  return Array.isArray(record?.suiteFiles) ? record.suiteFiles : [];
}

/**
 * The frozen tests the freeze found pinned to the owner. The pin lives in the
 * test file and the freeze writes down which files carried it, so the answer is
 * fixed where the frozen set is fixed. An absent or older record names none,
 * and the reader of it re-reads the file rather than treating that as "no pin"
 * (ADR-0044).
 */
export function freezeOwnerPins(paths, runId) {
  const record = readJson(join(paths.runs, runId, 'freeze.json'));
  return Array.isArray(record?.ownerPinned) ? record.ownerPinned : [];
}

/**
 * A park directive. The site declares what the park will take back: the
 * options it offers, the free-text slot it wants, or both. `text` is the label
 * for that slot and says what the text is for. The engine adds `abandon` and
 * writes the whole declaration onto the record (ADR-0029).
 *
 * `acks` names the findings an `ack` answer records a standing acknowledgment
 * for. It rides the record because the record is what the daemon writes those
 * acks from: the stage that raised the park is long gone by the time the
 * answer lands (ADR-0032). `detail` is the condition the park raised on, in
 * the form a reader can match against the ledger; the abandon route closes the
 * run on it, so a park that names its condition names it once.
 */
export function parkDirective(type, { question, options, text, refs, acks, detail }) {
  return {
    park: {
      type,
      question,
      ...(options && { options }),
      ...(text && { text }),
      ...(refs && { refs }),
      ...(acks && { acks }),
      ...(detail && { detail }),
    },
  };
}

// Every provisioning gate asks the operator for the same thing: repair the
// substrate this run cannot touch, then say so. The option carries the whole
// answer, and the text slot carries a note beside it — the gate re-reads the
// substrate either way. Declaring both is what makes the gates answerable
// with the same habit as every other park (ADR-0029).
export const GATE_FORMS = Object.freeze({
  options: ['retry'],
  text: 'a note on what you repaired',
});

// -- recoverable failures (ADR-0015) -----------------------------------------

// Terminal-state discipline: a run reaches `run-closed` through the ship
// path, a human kill, or a human answering a park with `abandon`. Every other
// failure parks under one of these types, so a run holding sound work waits
// for a decision instead of dying with the condition it met.
export const RECOVERY_PARKS = new Set(['seat-failure', 'stage-blocked', 'command-error']);
export const RECOVERY_OPTIONS = Object.freeze(['retry']);

/** The run's latest recovery park of any type, with its answer. */
export function lastRecoveryPark(events) {
  return lastParkWhere(events, (e) => RECOVERY_PARKS.has(e.type));
}

/** The run's latest park of any type, with its answer. */
export function lastPark(events) {
  return lastParkWhere(events, () => true);
}

function lastParkWhere(events, match) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== 'park' || !match(e)) continue;
    const answer = events.slice(i + 1).find((a) => a.event === 'answer' && a.parkSeq === e.seq);
    return { park: e, answer: answer ?? null };
  }
  return null;
}

/**
 * The abandon route: any park answered `abandon` closes the run with the
 * reason and detail its park recorded, or, where the park recorded neither,
 * on the condition its type names. Checked at every stage entry, so the answer
 * lands before the stage spends anything else.
 */
export function abandonedClose(events) {
  const asked = lastPark(events);
  if (!isAbandon(asked?.answer)) return null;
  return {
    close: {
      state: 'failed',
      reason: asked.park.reason ?? asked.park.type,
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

// What free text says at a recovery park: the operator repaired something and
// the stage should meet it. A text answer buys the same one attempt an option
// answer buys, so both forms are declared and both are counted the same way.
const RECOVERY_TEXT = 'what you changed before the retry';

/**
 * Routes a recoverable failure: the run parks with `retry` and `abandon`
 * instead of closing. One answer buys one attempt — the failure that follows
 * a bought retry parks again, so no arm loops on its own authority.
 *
 * `text` names the free-text slot for parks that read the answer's words (the
 * corrected ticket path); it is a declaration, not park detail, so it never
 * reaches the close an abandon takes.
 */
export function recover(ctx, { type, reason, question, refs, text, ...detail }) {
  const abandoned = abandonedClose(runEvents(ctx));
  if (abandoned) return abandoned;
  return {
    park: {
      type,
      reason,
      question,
      options: [...RECOVERY_OPTIONS],
      text: text ?? RECOVERY_TEXT,
      ...(refs && { refs }),
      ...(Object.keys(detail).length > 0 && { detail }),
    },
  };
}

/**
 * A stage precondition the run cannot settle itself. A `text` key in `detail`
 * declares the park's free-text slot rather than becoming park detail.
 */
export function blocked(ctx, reason, question, detail = {}) {
  return recover(ctx, { type: 'stage-blocked', reason, question, ...detail });
}

/** A configured command that could not run at all — an environment defect. */
export function commandError(ctx, reason, question, detail = {}) {
  return recover(ctx, { type: 'command-error', reason, question, ...detail });
}

/**
 * A seat that could not deliver a usable work product past its machine retry
 * allowance. The failure evidence stays in the ledger; a bought retry
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
      `The ${seat} seat failed` +
      (cause ? ` (${cause})` : '') +
      ` and no machine retry remains. Answer "retry" for one fresh ${seat} ` +
      'invocation carrying the failure evidence, or "abandon" to close the run.',
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

/**
 * The lane-level contract loop: one corrective invocation on a deterministic
 * defect in the work product, then the seat-failure park. It governs judging
 * seats too — a judge that cannot deliver a usable verdict is not the run
 * failing, so the human buys the retry or abandons the run.
 *
 * A retry bought at that park is one invocation carrying the defect list, not
 * a second corrective round. `defectReason` names the failure in the ledger.
 */
export async function seatWithChecks(
  ctx,
  {
    seat,
    label = null,
    schema,
    cwd,
    env,
    constitution,
    denyTools,
    buildRole,
    checks,
    defectReason = 'work-product-defect',
  },
) {
  const limit = attemptLimit(runEvents(ctx), seat);
  let brief = limit === 1 ? failureBrief(runEvents(ctx), seat) : null;
  for (let attempt = 1; ; attempt++) {
    const events = runEvents(ctx);
    const n = invocationCount(events, seat) + 1;
    const result = await ctx.runSeat({
      seat,
      roleBlock: buildRole(brief),
      reportPath: runReportPath(ctx.paths, ctx.runId, label ?? `${seat}-${n}`),
      schema,
      cwd,
      env,
      constitution,
      ...(denyTools && { denyTools }),
    });
    if (!result.ok) return { fail: seatFail(ctx, seat, result) };
    const defects = await checks(result.report);
    if (defects.length === 0) return { report: result.report };
    if (attempt >= limit) {
      ctx.store.append('seat-failure', { actor: ACTOR, seat, reason: defectReason, defects });
      return { fail: seatFail(ctx, seat, { reason: defectReason }) };
    }
    brief = defects;
  }
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
