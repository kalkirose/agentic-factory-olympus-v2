// The records stage: one seat writes the decision records a work item decides,
// before any code exists, and the run commits them on its own branch. The
// module also composes the records lane and holds the seam the reconcile stage
// lands in.
//
// A record is born by a seat that did not write the code (ADR-0074). The stage
// stands after the spec gate and before the suite in the story lane, so the
// frozen sha carries the records and the dev seat reads them as it reads the
// tests. In the records lane the ticket is the spec and the stage stands
// second. A repair ticket that names records and code dispatches the same seat
// before its dev seat, and the record paths are frozen for that seat.
//
// One seat writes the whole set. The count of records is not known before the
// seat runs, so a per-record dispatch has nothing to dispatch on. The harness
// reads what the seat left in the tree and refuses nothing about it: a file
// outside the record tree goes back, and a record the report claims and the
// tree does not hold drops off the list (ADR-0080).
//
// The stage derives its step from its own stamps and never from memory. No
// spawn is a dispatch; a spawn with no report is a seat that died mid-write, so
// the tree goes back to its last commit and the seat is dispatched again over
// the tree its predecessor started on (ADR-0070); a report with no commit is a
// commit, behind the same checks; the commit stamp is the end of the stage.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { recordPathIncludes } from '../config/project.mjs';
import { carryPaths, changedFiles, commitAll, headSha, resetHard } from '../isolation/tree.mjs';
import { parseTouchedPaths } from '../seats/diffpolicy.mjs';
import { parseIntentCard } from './card.mjs';
import { probeCredentials } from './probes.mjs';
import { AUTHOR_SEAT, birthRole, reconcileWriteSchema, runWindow, writeChecks } from './records.mjs';
import { reconcileHandler } from './reconcile.mjs';
import { recordLayerNeeds, runSpectrum } from './spectrum.mjs';
import { birthNeighbours, recordFiles } from './units.mjs';
import {
  ACTOR,
  answeredPath,
  blocked,
  commandError,
  gist,
  lastSeatReportEvent,
  loadProjectConfig,
  readConstitution,
  readJson,
  runEnv,
  runEvents,
  seatWithChecks,
  withAbandonGuard,
  withTreeRefresh,
} from './shared.mjs';

/** The stage that judges the records, between the verdict and the update. */
export const RECONCILE_STAGE = 'reconcile';

/** The stages of the records lane: no fix, no suite, no code verdict. */
export const RECORDS_LANE_STAGES = ['readiness', 'records'];

/**
 * The lanes whose spec is an intake ticket. The console refuses a ticket on any
 * other lane, and refuses a launch on one of these without a ticket: a lane
 * with no spec has nothing to judge its work against.
 */
export const TICKETED_LANES = ['repair', 'records'];

/**
 * The refusal a record-only ticket takes on the repair lane. The repair lane
 * runs a dev seat, no seat there may write a record (ADR-0074), and a run that
 * dispatched one would have nothing for it to do.
 */
export function recordLaneRefusal(ticket) {
  return (
    `the ticket ${ticket} names decision records and nothing else. A record-only ticket ` +
    'runs on the records lane: launch it with --lane records. The repair lane runs a dev ' +
    'seat, and no dev seat writes a record.'
  );
}

/** The refusal a ticket that names code takes on the records lane. */
export function codeTicketRefusal(ticket, paths) {
  return (
    `the ticket ${ticket} names paths outside the decision-record tree: ${paths.join(', ')}. ` +
    'The records lane holds no dev seat and no code verdict. Launch a ticket that names code ' +
    'on the repair lane.'
  );
}

/**
 * What a ticket's fenced touched-paths block declares, by the record tree.
 * `records` is a block whose every entry is a record; `mixed` names both;
 * `code` names no record; `undeclared` is a ticket with no block at all, which
 * declares nothing and is classified by no rule.
 * @param {string|null} text the ticket text
 * @param {string[]} recordPaths
 * @returns {{klass: 'records'|'mixed'|'code'|'undeclared', records: string[],
 *   code: string[]}}
 */
export function ticketPathClass(text, recordPaths = []) {
  const paths = typeof text === 'string' ? parseTouchedPaths(text) : [];
  if (paths.length === 0) return { klass: 'undeclared', records: [], code: [] };
  const records = paths.filter((path) => recordPathIncludes(path, recordPaths));
  const code = paths.filter((path) => !recordPathIncludes(path, recordPaths));
  if (records.length === 0) return { klass: 'code', records, code };
  return { klass: code.length === 0 ? 'records' : 'mixed', records, code };
}

/**
 * The step the stage owes, from the stage's own stamps.
 * @param {object[]} events the run's ledger, in order
 * @returns {'dispatch'|'redispatch'|'commit'|'done'}
 */
export function recordsStep(events) {
  if (events.some((e) => e.event === 'records-committed')) return 'done';
  let spawn = null;
  let report = null;
  for (const e of events) {
    if (e.event === 'seat-spawned' && e.seat === AUTHOR_SEAT) {
      spawn = e;
      report = null;
    } else if (e.event === 'seat-report' && e.seat === AUTHOR_SEAT) {
      report = e;
    }
  }
  if (!spawn) return 'dispatch';
  return report ? 'commit' : 'redispatch';
}

/** The `records-committed` stamp of this run, or null. */
export function recordsCommitted(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === 'records-committed') return events[i];
  }
  return null;
}

/**
 * The path entries a reset carries back over: the frozen suite and the record
 * tree. A fresh pass resets to the tree the pass is born on, and the records
 * were born before that tree existed as far as the reset is concerned, so
 * without the carry a pass deletes them and the stage never runs again.
 *
 * An `!` exclusion names a file that is not a record, so it carries nothing and
 * leaves the list here.
 * @param {{testPaths?: string[], recordPaths?: string[]}} base
 */
export function carriedPaths(base) {
  return [...(base?.testPaths ?? []), ...recordEntries(base?.recordPaths ?? [])];
}

/** The record path entries a git pathspec takes: the exclusions leave. */
export function recordEntries(recordPaths = []) {
  return recordPaths.filter((entry) => typeof entry === 'string' && !entry.startsWith('!'));
}

/**
 * Carries the run's born records over a fresh pass's reset, and re-stamps
 * `records-committed` with `carried: true`, so every reader that reads the
 * stamp since the last fresh pass reads the records the tree still holds.
 *
 * The story lane's own carry takes the records with the frozen suite: the
 * freeze sha is a commit over the record commit, and `carriedPaths` puts both
 * path lists in one call. A lane that carries no suite carries the records
 * here, from the commit the stamp names.
 *
 * The state is derived and never remembered: a pass that already re-stamped
 * does nothing here, so a restart repeats the carry instead of losing it.
 * @param {'story'|'repair'|'records'} mode
 * @returns {Promise<string|null>} the tree the records stand at, or null
 */
export async function carryRecords(ctx, base, mode) {
  const events = runEvents(ctx);
  const fresh = lastSeq(events, 'fresh-pass');
  if (fresh < 0) return null;
  const stamp = recordsCommitted(events);
  if (!stamp || stamp.seq > fresh) return null;
  const paths = stamp.paths ?? [];
  let sha = await headSha(base.worktree);
  if (paths.length > 0 && mode !== 'story' && typeof stamp.sha === 'string') {
    await carryPaths(base.worktree, stamp.sha, recordEntries(base.recordPaths));
    sha = await commitAll(base.worktree, `records carry: ${ctx.runId}`);
  }
  ctx.store.append('records-committed', {
    actor: ACTOR,
    sha,
    paths,
    decided: stamp.decided === true,
    ...(stamp.unreported?.length > 0 && { unreported: stamp.unreported }),
    carried: true,
  });
  return sha;
}

/** The seq of the last event of one name, or -1. */
function lastSeq(events, name) {
  let seq = -1;
  for (const e of events) if (e.event === name) seq = e.seq;
  return seq;
}

/**
 * The lane continuation with the reconcile stage named in it exactly once. The
 * ship step names the stage first and carries its handler, so every assembled
 * lane already holds both; a continuation that names neither is composed one
 * here, with the stage's own handler.
 */
export function withReconcileStage(continuation) {
  const stages = continuation.stages.includes(RECONCILE_STAGE)
    ? [...continuation.stages]
    : [RECONCILE_STAGE, ...continuation.stages];
  // The stage the lane puts behind this one. The composer knows it and the stage
  // does not, so a continuation that opens with anything is composable.
  const next = stages.find((stage) => stage !== RECONCILE_STAGE);
  return {
    stages,
    handlers: {
      [RECONCILE_STAGE]: reconcileHandler({ next }),
      ...continuation.handlers,
    },
  };
}

/**
 * The records lane: readiness → records → reconcile → the ship stages. A
 * record-only ticket is the whole work, so there is no fix seat, no suite and
 * no code verdict; the records the stage writes are judged by the reconcile
 * stage and shipped by the ship stages.
 * @param {{afterRecords: {stages: string[], handlers: object},
 *   forgeFor?: (ctx: object) => object}} opts
 */
export function recordsLane({ afterRecords, forgeFor = null }) {
  if (!Array.isArray(afterRecords?.stages) || afterRecords.stages.length === 0) {
    throw new Error('recordsLane requires an afterRecords continuation');
  }
  const after = withReconcileStage(afterRecords);
  return {
    stages: [...RECORDS_LANE_STAGES, ...after.stages],
    // A lane root carries both stage-entry guards: the abandon route out of any
    // park (ADR-0015), and, inside it, the tree refresh a bought retry on a
    // stage-blocked park is owed (ADR-0055).
    handlers: withAbandonGuard(
      withTreeRefresh({
        readiness: recordsReadiness(forgeFor),
        records: recordsStageHandler('records'),
        ...after.handlers,
      }),
    ),
  };
}

/**
 * The records lane's admission gate. It asks the two questions the lane can be
 * refused on: the ticket this lane's stage writes from, and the credentials
 * every launch is admitted behind (ADR-0027). The credential read is the story
 * lane's own, so both lanes admit on one answer.
 */
function recordsReadiness(forgeFor) {
  return async function readiness(ctx) {
    const worktree = ctx.payload.worktree;
    if (typeof worktree !== 'string' || !existsSync(worktree)) {
      return blocked(ctx, 'no-worktree', `The run worktree is gone: ${worktree ?? '(none)'}`);
    }
    const config = await loadProjectConfig(ctx);
    const ticket = ticketPath(ctx, worktree);
    if (!ticket || !existsSync(ticket)) {
      return blocked(
        ctx,
        'ticket-missing',
        `No intake ticket at ${ticket ?? '(no path)'}. Answer "retry" after placing the ` +
          'ticket, answer with a corrected absolute ticket path, or "abandon" to close the run.',
        { text: 'a corrected absolute ticket path' },
      );
    }
    const { klass, code } = ticketPathClass(readFileSync(ticket, 'utf8'), config.repo.recordPaths);
    if (klass === 'mixed' || klass === 'code') {
      return blocked(ctx, 'lane-mismatch', codeTicketRefusal(ticket, code), { files: code });
    }
    const probed = await probeCredentials(ctx, config, {
      phase: 'launch',
      cwd: worktree,
      env: runEnv(ctx, config),
      forge: resolveForge(ctx, forgeFor),
      defaultBranch: ctx.payload.defaultBranch ?? 'main',
    });
    if (probed) return probed;
    return { next: 'records' };
  };
}

/**
 * What the record form gate needs before a seat can run it.
 *
 * Every record brief names the gate command and asks the seat to run it before
 * it reports. A seat that runs it in a worktree with no dependencies installed
 * reads "the modules are absent here" and reports without the one mechanical
 * check the design leaves it (ADR-0080). So the layers the record layers need,
 * and none of the record layers themselves, run once here.
 *
 * It stands in front of the birth seat and not in one lane's readiness, because
 * every lane that holds a records stage dispatches that seat with the same brief
 * and the same gate command in it.
 *
 * They run under cycle 0, which no render counts, so the green they earn is a
 * prior the first record cycle carries: the layer reads the dependency manifest,
 * and the records the birth writes cannot change it. The cycle is also the
 * resume boundary: a ledger that holds one of these stamps has run them.
 */
async function installGateNeeds(ctx, base) {
  if (runEvents(ctx).some((e) => e.event === 'layer-result' && e.cycle === 0)) return null;
  const layers = base.layers ?? [];
  const needs = recordLayerNeeds(layers, new Set(base.recordLayers ?? []));
  if (needs.size === 0) return null;
  const spectrum = await runSpectrum(ctx, {
    layers,
    commands: base.commands,
    cwd: base.worktree,
    env: base.env,
    cycle: 0,
    sha: await headSha(base.worktree),
    run: needs,
    skip: new Set(layers.map((layer) => layer.name).filter((name) => !needs.has(name))),
    credentials: base.config?.credentials ?? [],
  });
  if (!spectrum.error) return null;
  return commandError(
    ctx,
    'gate-command',
    `A record gate prerequisite could not run: ${spectrum.error}\nRepair the command, then answer.`,
  );
}

/**
 * The forge the credential gate asks about, or null. A resolver that refuses
 * answers null rather than failing the stage, exactly as it does in the story
 * lane: the credential park is what a missing forge costs.
 */
function resolveForge(ctx, forgeFor) {
  if (typeof forgeFor !== 'function') return null;
  try {
    return forgeFor(ctx);
  } catch {
    return null;
  }
}

/**
 * The stage handler, for the story lane and for the records lane. It dispatches
 * the birth seat, commits what the seat wrote, and stamps the commit.
 * @param {'story'|'records'} mode
 */
export function recordsStageHandler(mode) {
  return async function records(ctx) {
    const next = mode === 'story' ? 'suite' : RECONCILE_STAGE;
    const base = await recordsBase(ctx, mode);
    if (base.fail) return base.fail;
    const outcome = await birthRecords(ctx, base);
    if (outcome.fail) return outcome.fail;
    // The records lane writes decision records and nothing else. A birth that
    // decided none leaves the lane no work: no record to review, nothing to put
    // in a request, and nothing to merge. The run says so and ends. A park here
    // would ask a person a question whose only answer is a different ticket, and
    // the ticket this run was launched from stands where it was (ADR-0015,
    // ADR-0080).
    if (mode === 'records' && outcome.stamp?.decided !== true) {
      return { close: { state: 'failed', reason: NOTHING_BORN } };
    }
    return { next };
  };
}

/** The close a records-lane run takes where its birth decided no record. */
export const NOTHING_BORN = 'nothing-born';

/**
 * One birth of the records a work item decides: the seat, the checks, the
 * commit and the stamps. Three sites call it — the story lane's stage, the
 * records lane's stage, and the repair lane's fix stage on a ticket that names
 * records beside code — and every one of them gets the same contract.
 *
 * A run that already stamped `records-committed` returns at once, so the mixed
 * repair ticket dispatches one birth and its dev seat reads the committed
 * records afterwards.
 * @returns {Promise<{fail?: object, stamp?: object}>}
 */
export async function birthRecords(ctx, base) {
  const step = recordsStep(runEvents(ctx));
  if (step === 'done') return { stamp: recordsCommitted(runEvents(ctx)) };
  // A project with no record tree has nowhere to write and nothing to read:
  // the stage decides nothing and says so, and no seat is spent on it.
  if (recordEntries(base.recordPaths).length === 0) {
    return { stamp: await stampNothing(ctx, base) };
  }
  // The neighbourhood the seat reads, derived from the work's own touched paths.
  const neighbours = birthNeighbours(base.worktree, base.spec.touchedPaths, base.recordPaths);
  if (step === 'commit') {
    const report = readJson(lastSeatReportEvent(runEvents(ctx), AUTHOR_SEAT)?.path);
    // The report is stamped before the readings run, so a stop between the two
    // leaves a report nothing read. They run again over the tree the seat left.
    if (report) {
      await writeChecks(ctx, { ...base, seat: AUTHOR_SEAT }, [], report);
      return { stamp: await commitRecords(ctx, base, report, null) };
    }
  }
  // The gate the brief is about to name has to be runnable where the seat runs.
  const installed = await installGateNeeds(ctx, base);
  if (installed) return { fail: installed };
  // A seat that died mid-edit leaves whatever it had written, and the next
  // dispatch has to be the same dispatch as the first (ADR-0070).
  await resetHard(base.worktree, await headSha(base.worktree));
  const outcome = await seatWithChecks(ctx, {
    seat: AUTHOR_SEAT,
    schema: reconcileWriteSchema(),
    cwd: base.worktree,
    env: base.env,
    constitution: base.constitution,
    styleFiles: base.styleFiles,
    buildRole: (brief) => birthRole(base, base.spec, neighbours, brief),
    checks: (report) => writeChecks(ctx, { ...base, seat: AUTHOR_SEAT }, [], report),
    defectReason: 'record-defect',
  });
  // A birth that delivered nothing. The records lane has nothing to hold without
  // it, so it keeps the park: a run there with no record has no work. The story
  // and repair lanes go on to their freeze, and the judge names the records late
  // in the reconcile stage, which is ADR-0074's own fallback path (ADR-0080).
  if (outcome.fail) {
    if (base.mode === 'records') return { fail: outcome.fail };
    return { stamp: await stampBirthFailed(ctx, base) };
  }
  return { stamp: await commitRecords(ctx, base, outcome.report, outcome.cost) };
}

/** The stamp a spent birth ladder leaves on a lane that ships code beside it. */
async function stampBirthFailed(ctx, base) {
  const stamp = {
    actor: ACTOR,
    sha: await headSha(base.worktree),
    paths: [],
    decided: false,
    birthFailed: true,
    cause: 'seat-failure',
    gist: gist('the record birth spent its ladder; the judge owes these records late'),
  };
  ctx.store.append('records-committed', stamp);
  return stamp;
}

/**
 * The commit and the stamps of one birth. A seat that wrote nothing commits
 * nothing: the stamp says the work decided nothing new, which is what the
 * born and late counts read (ADR-0074).
 *
 * `paths` names every record path the commit changed, read from the tree. The
 * seat's `rewritten` list alone is not enough: a superseded record's status-line
 * edit is a legal write the seat does not list, and the reconcile stage would
 * read a set without it. `unreported` names the paths the seat did not report,
 * so a reader tells the two kinds apart (ADR-0077).
 *
 * `cost` rides the stamp, because the dispatch that wrote every record here is
 * one dispatch and the number is its own.
 */
async function commitRecords(ctx, base, report, cost) {
  const reported = [...new Set(report.rewritten ?? [])];
  const changed = await changedFiles(base.worktree);
  const touched = changed.filter((file) => recordPathIncludes(file, base.recordPaths));
  const unreported = touched.filter((file) => !reported.includes(file));
  const paths = [...new Set([...reported, ...touched])];
  const decided = paths.length > 0;
  const sha =
    changed.length > 0
      ? await commitAll(base.worktree, `records: ${base.key}`)
      : await headSha(base.worktree);
  const stamp = {
    actor: ACTOR,
    sha,
    paths,
    decided,
    ...(unreported.length > 0 && { unreported }),
    ...((report.dropped ?? []).length > 0 && { dropped: report.dropped }),
    ...(typeof cost === 'number' && { cost }),
  };
  ctx.store.append('records-committed', stamp);
  return stamp;
}

/** The stamp a stage with no record tree leaves: it decided nothing. */
async function stampNothing(ctx, base) {
  const stamp = {
    actor: ACTOR,
    sha: await headSha(base.worktree),
    paths: [],
    decided: false,
  };
  ctx.store.append('records-committed', stamp);
  return stamp;
}

/**
 * The base the birth reads: the tree, the seat environment, the record tree and
 * the work item the records are written from. The story lane reads the
 * validated spec; the records lane reads the intake ticket.
 */
async function recordsBase(ctx, mode) {
  const config = await loadProjectConfig(ctx);
  const worktree = ctx.payload.worktree;
  if (typeof worktree !== 'string' || !existsSync(worktree)) {
    return { fail: blocked(ctx, 'no-worktree', `The run worktree is gone: ${worktree ?? '(none)'}`) };
  }
  const source = mode === 'story' ? storySource(ctx, worktree) : ticketSource(ctx, worktree);
  if (!source.path || !existsSync(source.path)) {
    return {
      fail: blocked(
        ctx,
        mode === 'story' ? 'spec-missing' : 'ticket-missing',
        `The records stage has no ${mode === 'story' ? 'validated specification' : 'intake ticket'} ` +
          `at ${source.path ?? '(no path)'}.`,
        mode === 'story' ? {} : { text: 'a corrected absolute ticket path' },
      ),
    };
  }
  const key = source.key ?? ctx.runId;
  const recordPaths = config.repo.recordPaths ?? [];
  const defaultBranch = ctx.payload.defaultBranch ?? 'main';
  const touched = touchedPaths(readFileSync(source.path, 'utf8'), worktree, recordPaths);
  // The window the birth writes inside. Its base rides the seat environment, so
  // the record layers the seat runs read the range CI reads (ADR-0079).
  const window = await runWindow({ worktree, defaultBranch, recordPaths });
  return recordBase({
    config,
    worktree,
    key,
    mode,
    env: runEnv(ctx, config, { rangeFrom: window.base }),
    constitution: readConstitution(worktree, config),
    defaultBranch,
    testPaths: config.repo.testPaths ?? [],
    // The layers that read a record diff, and the commands behind them. The
    // birth brief names the gate command and asks the seat to run it in its own
    // shell before it reports (ADR-0080).
    recordLayers: config.gates?.recordLayers ?? [],
    layers: config.gates?.tier1 ?? [],
    commands: config.commands,
    spec: {
      key,
      path: source.path,
      ...(source.reason && { reason: source.reason }),
      touchedPaths: touched,
    },
  });
}

/**
 * The paths a work item touches, which the birth neighbourhood is derived
 * from. The fenced block is the declaration where the item carries one.
 *
 * A ticket without a block names its records in prose — a reconciliation ticket
 * lists them under a heading — and a neighbourhood of nothing would leave the
 * seat reading no record beside the ones it writes. So a record the text names
 * verbatim counts, which is the rule the repair lane's own declaration falls
 * back to.
 */
function touchedPaths(text, worktree, recordPaths) {
  const declared = parseTouchedPaths(text);
  if (declared.length > 0) return declared;
  return recordFiles(worktree, recordPaths).filter((file) => text.includes(file));
}

/** The record fields of a lane base, filled from the project config. */
export function recordBase(base) {
  const repo = base.config?.repo ?? {};
  return {
    ...base,
    recordPaths: base.recordPaths ?? repo.recordPaths ?? [],
    recordLifecycle: base.recordLifecycle ?? repo.recordLifecycle,
    styleFiles: base.styleFiles ?? repo.styleFiles ?? [],
  };
}

/** The story lane's work item: the spec the gate passed, and the card's key. */
function storySource(ctx, worktree) {
  const cardPath = ctx.payload.card;
  let key = null;
  if (typeof cardPath === 'string' && cardPath.length > 0) {
    try {
      key = parseIntentCard(readFileSync(join(worktree, cardPath), 'utf8')).card.key ?? null;
    } catch {
      key = null;
    }
  }
  return { path: join(ctx.paths.runs, ctx.runId, 'spec.md'), key, reason: null };
}

/** The ticketed lanes' work item: the intake ticket. */
function ticketSource(ctx, worktree) {
  return {
    path: ticketPath(ctx, worktree),
    key: ctx.runId,
    reason: 'the intake ticket states the decisions this run records',
  };
}

/**
 * The intake ticket's absolute path. A repo-relative path names a committed
 * ticket, an absolute one names a daemon-home ticket, and a `stage-blocked`
 * answer may hand over a corrected absolute path — the repair lane's own rule.
 */
function ticketPath(ctx, worktree) {
  const ticket = answeredPath(runEvents(ctx), 'ticket-missing') ?? ctx.payload.ticket;
  if (typeof ticket !== 'string' || ticket.length === 0) return null;
  return isAbsolute(ticket) ? ticket : join(worktree, ticket);
}

/**
 * What a capture says about a record a code seat wrote. The record tree is
 * frozen for every seat that writes code, in every lane, so the write is
 * reverted and recorded; the seat cannot make it legal by trying again
 * (ADR-0074).
 */
export function recordDropLine(path) {
  return (
    `${path}: this decision record is frozen for every seat that writes code. The capture ` +
    'reverted the write. A record is written by a record seat and by nothing else; the ' +
    'reconciliation stage owns every change to one.'
  );
}

/** The record's one-sentence statement of what a record take-back is. */
export const RECORD_TAKEBACK_NOTE =
  'Decision records reverted at capture. No seat that writes code writes a record, in any ' +
  'lane, so the write is taken back and the allowed set is committed around it; the record ' +
  'seats own the tree.';

/** A one-line gist for the ledger stream index. */
export function recordTakeBackGist(paths) {
  return `${paths.length} decision record(s) the capture reverted: ${paths.slice(0, 3).join(', ')}`;
}
