// Helpers shared by the lane handlers: ledger-derived position (events,
// parks, seat invocations), project-config loading from the launch blob, and
// the small directive constructors. Every lane re-derives its position from
// the run ledger and the git state — nothing here holds cross-stage memory.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readEvents } from '../ledger/ledger.mjs';
import { ACK_OPTION } from '../ledger/acks.mjs';
import { isAbandon } from '../ledger/parks.mjs';
import { runLedgerPath, runReportPath } from '../daemon/home.mjs';
import { credentialEnv, declaredNames } from '../daemon/credentials.mjs';
import {
  DEFAULT_CONSTITUTION_PATH,
  parseProjectConfig,
  underEntry,
} from '../config/project.mjs';
import { branchSha, cloneDir, fetchClone } from '../isolation/clones.mjs';
import { git } from '../isolation/git.mjs';
import { changedFiles, headSha, resetHard } from '../isolation/tree.mjs';
import { stackEnv } from '../isolation/stacks.mjs';
import { RUN_CACHE_ENV, runCacheDir } from '../isolation/worktrees.mjs';

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
 * The environment every project-config command and every seat of a run is
 * given.
 *
 * Three things ride it. The run's stack env is the same derivation the stack
 * rose from at provision, so a host-run suite can find the stack it belongs to
 * (no fixed host ports: the project resolves published ports from the compose
 * project name). The run's cache directory (ADR-0048) is where a command that
 * builds something expensive puts it, so the cycle after this one reuses it;
 * it lives in the worktree and dies with the run, so a new run starts cold.
 *
 * The third is the credentials the project declares, read from the machine's
 * store at this moment rather than from the copy the daemon inherited when it
 * started (ADR-0064). They ride last, so the freshest value wins, and they ride
 * the environment rather than `process.env`, so the seat strip still decides
 * which seats may hold them. A home that declares no store adds nothing here.
 *
 * Undefined when the project has no stack, turns the cache off and declares no
 * credential the store answers for, which is what every caller saw before any
 * of the three existed.
 */
export function runEnv(ctx, config) {
  const stack = config.stack
    ? stackEnv({ runId: ctx.runId, worktree: ctx.payload.worktree, extra: config.stack.env })
    : null;
  const cache =
    config.runCache !== false && ctx.payload.worktree
      ? { [RUN_CACHE_ENV]: runCacheDir(ctx.payload.worktree) }
      : null;
  const credentials = credentialEnv(ctx.paths, declaredNames(config));
  if (!stack && !cache && Object.keys(credentials).length === 0) return undefined;
  return { ...stack, ...cache, ...credentials };
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
 *
 * `gate` names the check an `ack` answer acknowledges, at a gate that states a
 * judgment about the world. It rides the record for the reason `acks` does: the
 * engine writes the acknowledgment from the record, and the site is gone by
 * then. `reasoned` names the options that take the answer text as well
 * (ADR-0062).
 */
export function parkDirective(
  type,
  { question, options, text, reasoned, refs, acks, gate, detail },
) {
  return {
    park: {
      type,
      question,
      ...(options && { options }),
      ...(text && { text }),
      ...(reasoned && { reasoned }),
      ...(refs && { refs }),
      ...(acks && { acks }),
      ...(gate && { gate }),
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

// -- gates that state a judgment about the world (ADR-0062) -------------------

// The gates an `ack` answer may take, by the check each one names. The set is
// closed and it is the whole scope rule in code: adding a gate to it is a
// decision about who may walk past what, and it cannot be taken at a call site.
//
// A gate is in here when its park states a JUDGMENT the harness formed about
// the world: a declaration the run pinned, compared against the world; a
// project-declared probe's verdict; an inference over a live read. A judgment
// can be stale or wrong, the operator standing in front of the world is the
// one who can say so, and `retry` only asks the same wrong question again.
//
// A gate is NOT in here when its park states a REFUSAL the world itself gave
// to an action the harness took — a rejected push, an auto-merge the forge
// would not arm, a label it would not apply, a check run it never delivered. An
// ack cannot talk past one of those: the action did not happen, and the step
// behind the gate needs it to have happened.
//
// And no gate that reads the run's own tree is in here, whatever else it does,
// because a tree cannot be stale against itself.
//
// The verdict lane's operational-fix gate is deliberately absent. It already
// answers itself on standing finding acknowledgments, keyed per finding and
// ended by a revoke (ADR-0032), which is a finer instrument than this one and a
// different question. Two acknowledgment rules at one gate would leave nobody
// able to say which of them let a run through.
export const WORLD_GATES = new Set(['credential-surface', 'credential-probe', 'substrate-probe']);

// What the text slot is for at a gate that offers the ack. It says both jobs,
// because the same slot carries the note beside a `retry` and the reason an
// `ack` cannot be given without.
const WORLD_GATE_TEXT = 'why this gate is wrong about the world, or a note on what you repaired';

/**
 * The park forms of a gate that states a judgment about the world: `retry`,
 * `ack`, and the reason the ack owes. The key names the check the ack answers,
 * and it rides the record — a subject may follow it after a colon, so an ack of
 * one credential's probe is not an ack of another's.
 * @param {string} key a name in `WORLD_GATES`, optionally `<name>:<subject>`
 */
export function worldGate(key) {
  if (!WORLD_GATES.has(key.split(':')[0])) throw new Error(`unknown world gate: ${key}`);
  return {
    options: [...GATE_FORMS.options, ACK_OPTION],
    text: WORLD_GATE_TEXT,
    reasoned: [ACK_OPTION],
    gate: key,
  };
}

// What an `ack` at a world gate is worth, said at the gate itself, so the
// operator reads the rule where they answer rather than in the source.
export const WORLD_GATE_NOTE =
  'Answer "ack" with --text to record, against this run, that the gate is wrong ' +
  'about the world and that the run may go past it. The reason is required, and ' +
  'the acknowledgment stands for this run and this gate alone: it ends with the ' +
  'run, it covers no other gate, and it is counted.';

/**
 * The acknowledgment standing over one gate of this run, or null.
 *
 * It stands for the whole run rather than for the one park it answered. A gate
 * that judges the world wrongly at the launch judges it wrongly again at the
 * ship, and asking the same person the same settled question twice in one run
 * is the loop this option exists to end. It reaches no further than the run:
 * nothing here is standing policy, and the next run asks again (ADR-0062).
 * @param {Array<object>} events the run ledger, in order
 * @param {string} gate the key the gate declared
 */
export function gateAck(events, gate) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'gate-acknowledged' && e.gate === gate) return e;
  }
  return null;
}

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

// -- the tree a retry runs against (ADR-0055) --------------------------------

const REFRESHED = Symbol('tree-refresh');

/**
 * Wraps a lane's handlers with the tree refresh: before a stage re-runs on a
 * bought retry, the run's tree is brought to the default branch head.
 *
 * A `stage-blocked` park is the class of failure the run cannot repair itself,
 * so the repair lands where the operator can write: on the default branch. The
 * run's tree is pinned at launch, so the retry that asked for that repair ran
 * against a tree the repair never reached, and the same park came back for
 * ever. The refresh is what makes the retry answerable.
 *
 * It goes inside the abandon guard, so a run being closed refreshes nothing.
 * A composed lane wraps its continuation's handlers again; the guard is
 * idempotent through the ledger, so a second wrap costs a read and changes
 * nothing.
 * @param {Record<string, Function>} handlers
 */
export function withTreeRefresh(handlers) {
  return Object.fromEntries(
    Object.entries(handlers).map(([stage, handler]) => {
      if (handler[REFRESHED]) return [stage, handler];
      const refreshed = async (ctx) => {
        await refreshForRetry(ctx);
        return handler(ctx);
      };
      refreshed[REFRESHED] = true;
      return [stage, refreshed];
    }),
  );
}

/**
 * Brings the run's tree to the default branch head for one answered
 * `stage-blocked` park, and stamps what it did. Returns the stamp, or null
 * where there is nothing to do.
 *
 * The reach is exactly the tree the run has written nothing to: a clean tree
 * whose HEAD the default branch already holds. A tree with the run's own work
 * in it keeps that work, because a reset would take what a verdict is owed,
 * and the stamp says so. One stamp per park, so the tree moves once per answer
 * and every later entry of the stage reads the ledger and stops.
 *
 * The refresh never fails a stage. A fetch or a reset that throws is recorded
 * with its cause, and the stage runs against the tree it already had, exactly
 * as it did before this guard existed.
 */
export async function refreshForRetry(ctx) {
  const events = runEvents(ctx);
  const asked = lastPark(events);
  if (!asked?.answer || asked.park.type !== 'stage-blocked') return null;
  if (isAbandon(asked.answer)) return null;
  if (events.some((e) => e.event === 'tree-refreshed' && e.park === asked.park.seq)) return null;
  const worktree = ctx.payload.worktree;
  const branch = ctx.payload.defaultBranch ?? 'main';
  const stamp = (fields) =>
    ctx.store.append('tree-refreshed', { actor: ACTOR, park: asked.park.seq, branch, ...fields });
  let from = null;
  try {
    await fetchClone(cloneDir(ctx.paths, ctx.project));
    const to = await branchSha(cloneDir(ctx.paths, ctx.project), branch);
    from = await headSha(worktree);
    const own = await ownWork(worktree, to);
    if (own) return stamp({ from, to, moved: false, cause: own });
    if (from === to) return stamp({ from, to, moved: false });
    await resetHard(worktree, to);
    return stamp({ from, to, moved: true });
  } catch (error) {
    return stamp({ ...(from && { from }), moved: false, cause: error.message });
  }
}

/** What the run has of its own in its tree, in one sentence, or null. */
async function ownWork(worktree, to) {
  const dirty = await changedFiles(worktree);
  if (dirty.length > 0) return `the tree holds ${dirty.length} uncommitted change(s)`;
  const ahead = (await git(['rev-list', '--count', `${to}..HEAD`], { cwd: worktree })).trim();
  if (ahead !== '0') return `the tree holds ${ahead} commit(s) of its own`;
  return null;
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
