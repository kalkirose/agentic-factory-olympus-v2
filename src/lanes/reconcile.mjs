// The reconcile stage: the records are judged in a stage of their own, between
// the verdict and the update, and nothing in it changes a verdict (ADR-0075).
//
// The stage holds two facts apart that used to be one. A code verdict certifies
// the code tree at the code tree's sha; a reconciliation certifies the record
// tree at the record commit's sha. Two grounds, two questions, two stamps. The
// verdict never reads a record commit and the stage never stamps a
// `verdict-rendered`, so a repair round after a green reconciliation leaves the
// code green at its own sha and a corrective record round buys no code cycle.
//
// Seven steps, each derived from the stage's own stamps since the last
// `fresh-pass` and never remembered: judge, write, spectrum, review, render,
// correct, and done or stall. A restart at any boundary resumes that step. Two
// of the seven are cheap on a resume rather than skipped: the spectrum re-uses
// every `layer-result` this cycle stamped, and the review re-uses every finding
// id this cycle assigned, so the work a stop interrupted is the only work a
// restart buys again.
//
// Nothing here blocks a run on a record. A dispatch that fails leaves its record
// unwritten, a review seat that fails leaves its record unreviewed, and a stall
// at the cap takes the fallback on its own and asks nobody. Every lane then
// pushes and merges, with the standing findings and the unwritten and unreviewed
// records named in the request body and on the close stamp (ADR-0080).
// `reconcile-stall` is loud: nothing stops, and somebody reads why.
import { join } from 'node:path';
import { runReportPath } from '../daemon/home.mjs';
import { RECORD_CAP, SEAT_FAILURE, assertReconcileCause } from '../ledger/registry.mjs';
import { DEFAULT_RECONCILE_ROUNDS } from '../config/project.mjs';
import { cloneDir, fetchClone } from '../isolation/clones.mjs';
import { git } from '../isolation/git.mjs';
import {
  changedFiles,
  changedInRange,
  commitAll,
  headSha,
  resetHard,
} from '../isolation/tree.mjs';
import { configuredGroups } from './schedule.mjs';
import { cyclePlan, persistentReds, runSpectrum } from './spectrum.mjs';
import { recordReviewRound } from './review.mjs';
import {
  WRITE_SEAT,
  correctiveRole,
  findingLine,
  parseRecordList,
  reconcileWriteSchema,
  recordScope,
  remarkLine,
  runWindow,
  writeChecks,
  writeRole,
} from './records.mjs';
import { RECONCILE_STAGE, recordBase, recordsCommitted } from './records-stage.mjs';
import {
  activeOf,
  activeRecords,
  matchUnits,
  readText,
  recordFiles,
  recordId,
  recordNeighbours,
  recordUnits,
  statusOf,
  supersedesOf,
} from './units.mjs';
import {
  advisoryIndex,
  currentPass,
  findingIndex,
  passOpeningSha,
  repairStalled,
} from './verdict.mjs';
import {
  ACTOR,
  answeredPath,
  commandError,
  gist,
  lastSeatReportEvent,
  loadProjectConfig,
  readConstitution,
  readJson,
  runEnv,
  runEvents,
  seatFailureAfter,
  seatWithChecks,
  sinceFreshPass,
} from './shared.mjs';

/** The stage's name in every lane that holds it, where its readers reach it. */
export { RECONCILE_STAGE };

/**
 * The stage the reconciliation hands the run to where its lane names none. Every
 * assembled lane opens its continuation with the update, and a lane that opens
 * with something else says so at composition.
 */
const NEXT_STAGE = 'update';

const RECONCILE_JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    owed: { type: 'boolean' },
    records: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['owed', 'records', 'reason'],
};

const RECHECK_JUDGE_SCHEMA = RECONCILE_JUDGE_SCHEMA;

/**
 * The stage handler, for every lane that names the stage. It derives its step,
 * takes it, and derives again, so a stop anywhere inside resumes at the step
 * the stop interrupted.
 *
 * `next` is the stage the lane puts behind this one. The lane composer knows it
 * and the stage does not: a handler that named one stage would be a handler that
 * only one lane graph could hold.
 * @param {{next?: string}} [opts]
 */
export function reconcileHandler({ next = NEXT_STAGE } = {}) {
  return async function reconcile(ctx) {
    const base = await reconcileBase(ctx);
    if (base.fail) return base.fail;
    for (;;) {
      if (ctx.stopped()) return null;
      const events = runEvents(ctx);
      const step = reconcileStep(events, { cap: base.cap });
      if (step === 'done') return { next };
      const directive = await takeStep(ctx, base, { step, next });
      if (directive) return directive;
    }
  };
}

/** One step of the stage. A directive ends the stage; null derives again. */
async function takeStep(ctx, base, { step, next }) {
  switch (step) {
    case 'judge':
      return judgeStep(ctx, base);
    case 'write':
      return writeStep(ctx, base, next);
    case 'spectrum':
    case 'review':
    case 'render':
      return cycleStep(ctx, base);
    case 'correct':
      return correctStep(ctx, base, next);
    case 'recheck':
      return recheckStep(ctx, base);
    default:
      return stallStep(ctx, base, next);
  }
}

/**
 * The step the stage owes, from the stage's own stamps alone.
 *
 * `spectrum`, `review` and `render` are the three thirds of one cycle over the
 * newest record commit: the cycle is owed until it renders, and each name says
 * how much of it the ledger already holds. `correct` and `stall` are the two
 * answers to a red render, and `recheck` is what a repair round past a green
 * render owes (ADR-0075).
 *
 * A judgment that failed is not an ending. The judge answers whether the code
 * diff moved past a record; the records the pass's own birth wrote are a set
 * this stage holds either way, and a crashed judge that closed the stage shipped
 * them with no layer, no review and no render. So the anchor is read first, and
 * a failed judgment owes no write and buys the cycle over the born set
 * (ADR-0080).
 *
 * `done` is every other ending. A spent fallback is one. A pass that holds no
 * record set is one. So is a green render with no repair behind it. The stage
 * then hands the run to the update.
 * @param {object[]} events the run's ledger, in order
 * @param {{cap?: number}} [opts] the record cap, `gates.reconcileRounds`
 * @returns {'judge'|'write'|'spectrum'|'review'|'render'|'correct'|
 *   'recheck'|'stall'|'done'}
 */
export function reconcileStep(events, { cap = DEFAULT_RECONCILE_ROUNDS } = {}) {
  const judged = judgment(events);
  if (!judged) return 'judge';
  const written = sinceFreshPass(events, (e) => e.event === 'reconciliation-written');
  // The write is owed for a judgment that names records and holds no write of
  // its own. Nothing else here asks what the judge owed. A pass that owes no
  // write still owes the cycle over the set it holds (ADR-0077).
  if (judged.owed === true && (!written || written.seq < judged.seq)) return 'write';
  const anchor = cycleAnchor(events);
  if (!anchor) return 'done';
  // A fallback is the stage's last word: the records are owed, the run said so,
  // and nothing here writes them a second time.
  if (anchor.ok !== true) return 'done';
  const rendered = lastRendered(events);
  // A record re-run: the update stage merged a default branch whose incoming
  // work touched a record in this run's neighbourhood, so the reconciliation is
  // asked again against the merged tree (ADR-0075).
  const rerun = sinceFreshPass(
    events,
    (e) => e.event === 'pre-verdict-update' && e.records?.answer === 'rerun',
  );
  if (!rendered || rendered.seq < anchor.seq || (rerun && rerun.seq > rendered.seq)) {
    return cycleStepOf(events, anchor);
  }
  if (rendered.verdict === 'green') {
    return recheckOwed(events, rendered) ? 'recheck' : 'done';
  }
  const rounds = roundsSince(events, judged.seq);
  const renders = rendersSince(events, judged.seq);
  const stalled = repairStalled(events, renders, rendered, { round: 'reconcile-round' });
  return rounds >= cap || stalled ? 'stall' : 'correct';
}

/**
 * How much of the cycle over the anchor the ledger already holds.
 *
 * The review is measured against the set the cycle was dispatched over, which
 * is a stamp of its own. The anchor's list holds every record the pass touched,
 * closed ones included, and a closed record takes no review seat and leaves no
 * stamp. A derivation that read the anchor would therefore re-enter the review
 * of a cycle that is past it (ADR-0078).
 *
 * A seat answers for its record either way: it read it, or it could not. The two
 * stamps are one boundary, so a review round that lost a seat still renders
 * (ADR-0080).
 */
function cycleStepOf(events, anchor) {
  const cycle = nextCycle(events);
  if (!events.some((e) => e.event === 'layer-result' && e.cycle === cycle)) return 'spectrum';
  const dispatched = events.find((e) => e.event === 'reconcile-review-set' && e.cycle === cycle);
  const records = dispatched ? (dispatched.records ?? []) : reviewedRecords(events, anchor);
  const stamped = new Set(
    events
      .filter(
        (e) =>
          (e.event === 'record-reviewed' || e.event === 'record-unreviewed') && e.cycle === cycle,
      )
      .map((e) => e.record),
  );
  if (records.length === 0 || records.some((record) => !stamped.has(record))) return 'review';
  return 'render';
}

/**
 * The records of this pass's set, from the anchor that earned it and the birth
 * behind it. Those are the records the anchor rewrote, the records it left
 * alone, the paths a born stamp names, and the paths this run's own birth
 * committed.
 *
 * The born set rides every anchor. A judge that owes one record leaves a write
 * stamp that names that record alone, and the born records would then have no
 * writer at all: a finding on one could never be answered, and the render would
 * stay red to the cap (ADR-0079).
 */
function reviewedRecords(events, anchor) {
  const entries = Array.isArray(anchor?.records) ? anchor.records.map((r) => r.record) : [];
  const born = recordsCommitted(events)?.paths ?? [];
  return [
    ...new Set([...(anchor?.rewritten ?? []), ...entries, ...(anchor?.paths ?? []), ...born]),
  ];
}

/**
 * The stamp the pass's record cycle stands on. It is the write where the pass
 * wrote records, and the birth where it wrote none.
 *
 * The stage used to open its cycle on a write alone. The judge leaves out a
 * born record that still stands. On the records lane the whole diff is that
 * birth write, so the judge answers nothing owed. The born records then
 * shipped with no layer, no review seat and no render.
 *
 * A born set is a record set the pass holds. It takes the cycle a written set
 * takes (ADR-0077).
 *
 * The born stamp takes the write stamp's shape, so every reader behind this
 * one reads one thing.
 * @param {object[]} events the run's ledger, in order
 */
export function cycleAnchor(events) {
  const written = sinceFreshPass(events, (e) => e.event === 'reconciliation-written');
  if (written) return written;
  const born = sinceFreshPass(
    events,
    (e) => e.event === 'records-committed' && e.decided === true,
  );
  if (!born) return null;
  return { seq: born.seq, ok: true, born: true, paths: born.paths ?? [] };
}

/** The stage's own judgment of this pass, never the close-out's ticket line. */
function judgment(events) {
  return sinceFreshPass(
    events,
    (e) => e.event === 'reconciliation-judged' && typeof e.ticket !== 'string',
  );
}

/** The stage's newest render of this pass, or null. */
export function lastRendered(events) {
  return sinceFreshPass(events, (e) => e.event === 'reconcile-rendered');
}

/**
 * The record certification of the run: the stage's newest render, at the sha it
 * judged. Null where the run owes no reconciliation at all, which is a lane with
 * nothing to certify and never a certification that failed.
 *
 * A fallback behind the render answers for it. The cap fallback is the run's own
 * decision that the records ride with the open findings ticketed, and it is the
 * one way records leave a run with findings open (ADR-0075). The gate reads it
 * as the answer it is, and the ticket carries what is still wrong.
 * @param {object[]} events the run's ledger, in order
 */
export function reconcileCertification(events) {
  const rendered = lastRendered(events);
  if (!rendered) return null;
  const written = sinceFreshPass(events, (e) => e.event === 'reconciliation-written');
  if (written && written.seq > rendered.seq && written.ok === false) {
    return { sha: rendered.sha, ok: true, fallback: written.cause };
  }
  return { sha: rendered.sha, ok: rendered.verdict === 'green' };
}

function rendersSince(events, seq) {
  return events.filter((e) => e.event === 'reconcile-rendered' && e.seq > seq);
}

function roundsSince(events, seq) {
  return events.filter((e) => e.event === 'reconcile-round' && e.seq > seq).length;
}

/**
 * The run's cycle counter, continued. Both renders draw from it, so `runId#cycle`
 * names one judgment across the two stamps (ADR-0075).
 */
export function nextCycle(events) {
  return (
    events.filter((e) => e.event === 'verdict-rendered' || e.event === 'reconcile-rendered')
      .length + 1
  );
}

// -- the judge ---------------------------------------------------------------

/**
 * A fresh seat judges whether this run's own diff implements or contradicts any
 * decision record. It reads the run branch against the default branch, which is
 * the work this run is about to merge, and it judges only.
 *
 * The records lane spawns none. Its diff is the records, so "does this diff move
 * past a record" is answered by the birth: the records are the diff. A seat
 * asked a settled question invents an answer, and the invented answer was a
 * replacement of the project standard on two branches at once (ADR-0080). The
 * stage stamps its judgment from the born set, with `source: 'born'`.
 *
 * The stamp splits what it found. `born` are the records this run's own records
 * stage wrote before the freeze, and `late` are the rest: a decision the card or
 * the ticket stated is born, and a decision only the diff shows is late. The
 * share of the two is the reading of whether the birth seat is working
 * (ADR-0074). A judgment that failed carries the two lists as well, so the
 * cycle over the born set is derivable behind it.
 */
async function judgeStep(ctx, base) {
  const born = recordsCommitted(runEvents(ctx))?.paths ?? [];
  if (base.mode === 'records') {
    ctx.store.append('reconciliation-judged', {
      actor: ACTOR,
      ok: true,
      owed: false,
      reason: BORN_JUDGMENT,
      born,
      late: [],
      source: 'born',
    });
    return null;
  }
  try {
    // The default-branch ref the diff is taken against. Without the fetch it is
    // the branch as it stood when this run last met it, and the merge base
    // behind that ref counts work this run merged in as its own.
    await fetchClone(cloneDir(ctx.paths, ctx.project));
  } catch (error) {
    ctx.store.append('reconciliation-judged', {
      actor: ACTOR,
      ok: false,
      owed: false,
      cause: `fetch: ${error.message}`,
      born,
      late: [],
    });
    return null;
  }
  const result = await ctx.runSeat({
    seat: 'reconcile-judge',
    roleBlock: judgeRole(base),
    reportPath: runReportPath(ctx.paths, ctx.runId, 'reconcile-judge'),
    schema: RECONCILE_JUDGE_SCHEMA,
    cwd: base.worktree,
    env: base.env,
    constitution: base.constitution,
    styleFiles: base.styleFiles,
  });
  if (!result.ok) {
    ctx.store.append('reconciliation-judged', {
      actor: ACTOR,
      ok: false,
      owed: false,
      cause: 'seat-failure',
      born,
      late: [],
    });
    return null;
  }
  const { owed, records, reason } = result.report;
  if (!owed) {
    ctx.store.append('reconciliation-judged', {
      actor: ACTOR,
      ok: true,
      owed: false,
      reason,
      born,
      late: [],
    });
    return null;
  }
  const bornPaths = new Set(born);
  ctx.store.append('reconciliation-judged', {
    actor: ACTOR,
    ok: true,
    owed: true,
    records,
    reason,
    born,
    late: records.filter((record) => !bornPaths.has(record)),
    gist: gist(`reconciliation owed: ${records.join(', ')}`),
  });
  return null;
}

function judgeRole(base) {
  const born = recordEntriesOf(base.born);
  return [
    'Judge whether the diff of this run implements or contradicts any decision',
    'record (ADR). You judge only; change nothing.',
    `The diff is this branch against ${base.defaultBranch}. Read it with:`,
    `git diff ${base.defaultBranch}...HEAD`,
    'Locate the decision-record tree (commonly docs/adr/). No such tree means',
    'owed=false with that as the reason.',
    'owed=true when the diff implements a recorded decision, contradicts one,',
    'or deviates from one. Implementation counts even when the diff never',
    'touches the record files themselves. List every affected record path in',
    'records, and state the reason in one or two sentences.',
    ...(born.length > 0
      ? [
          'This run already wrote these records before its suite was frozen. List',
          'one of them where the diff moved past what it states, and leave it out',
          'where the record still stands:',
          ...born.map((record) => `- ${record}`),
        ]
      : []),
  ].join('\n');
}

function recordEntriesOf(list) {
  return Array.isArray(list) ? list : [];
}

/** What the records lane's own judgment says, in the reason field a seat fills. */
const BORN_JUDGMENT =
  'the diff of this run is its own decision records, so the birth is the judgment: the records ' +
  'the pass wrote are the set this stage reads';

// -- the write ---------------------------------------------------------------

/**
 * The judged records, written one seat at a time, in sequence, in the one run
 * worktree (ADR-0075).
 *
 * Each dispatch has its own seat identity, its own hard reset and its own
 * commit, so a seat sees its own files and no peer's, and N writers in one run
 * keep N budgets, N cost lines and N failure records. The commit is the durable
 * half and the `record-written` stamp behind it is the recorded half: a stop
 * between the two re-dispatches that one record over its own commit, which is
 * the same dispatch again, and every record the ledger already answered is
 * stepped over (ADR-0080).
 */
async function writeStep(ctx, base, next) {
  const judged = judgment(runEvents(ctx));
  // The set this round dispatches over, stamped once and read on every entry.
  // The judge names the records the diff implicates; a record the tree has
  // closed is out of every seat's scope, and it takes no writer (ADR-0078).
  const set = await dispatchSet(ctx, base, {
    round: 0,
    since: judged.seq,
    records: judged.records ?? [],
  });
  const records = set.records;
  const outcome = await writeRound(ctx, roundBase(base, set), {
    records,
    since: judged.seq,
    buildRole: (record, brief) =>
      writeRole(
        base,
        { ...judged, records: [record], neighbours: recordNeighbours(base.worktree, record, base.recordPaths) },
        brief,
      ),
  });
  if (outcome.stopped) return null;
  await stampWritten(ctx, base, { entries: outcome.entries, reports: outcome.reports });
  // The story and repair lanes ship code beside their records, and a dispatch
  // that delivered nothing is the one thing a later round cannot answer: the
  // record is owed and no seat wrote it. Their own ending takes it, which is a
  // merge with the record ticketed (ADR-0080). The records lane has no code, so
  // it carries the record on the render as unwritten and the cycle goes on.
  if (base.mode !== 'records' && outcome.entries.some((entry) => entry.failed === true)) {
    return fallbackStep(ctx, base, { cause: SEAT_FAILURE, next });
  }
  return null;
}

/**
 * The set one write round dispatches over, and the tree it opened on.
 *
 * The first entry of a round filters the list it was given and stamps what it
 * dispatches and what it dropped. Every later entry reads that stamp. A seat
 * name is the index in this list, so a list read from the tree would shrink
 * between two entries of one round, and every record behind the one a seat
 * closed would answer to a name another record's commit already holds
 * (ADR-0078).
 * `advisory` is the remarks each dispatched record holds, by id. It is stamped
 * with the set because the brief is rebuilt from this stamp on a resume: a
 * round that re-derived the remarks from the ledger after its own write would
 * read a different list, and the seat would answer a brief nobody sent it
 * (ADR-0007).
 * @returns {Promise<{records: string[], sha: string|null,
 *   advisory: Array<{record: string, ids: string[]}>}>}
 */
async function dispatchSet(ctx, base, { round, since, records, owed = null, advisory = [] }) {
  const events = runEvents(ctx);
  // The set this round stamped. A round is the pair of the render it answers
  // and its own number, so a re-entry dispatches the list it named (ADR-0078).
  const stamped = events.find(
    (e) => e.event === 'reconcile-write-set' && e.since === since && (e.round ?? 0) === round,
  );
  if (stamped) {
    return {
      records: stamped.records ?? [],
      sha: stamped.sha ?? null,
      advisory: stamped.advisory ?? [],
    };
  }
  const sha = await headSha(base.worktree);
  const { records: active, skipped } = activeOf(base.worktree, records);
  // A round that owes an answer for part of the set dispatches that part and
  // stamps the rest. A seat over a record no finding names writes nothing and
  // costs a dispatch (ADR-0079).
  const dispatched = owed === null ? active : active.filter((record) => owed.has(record));
  const kept =
    owed === null
      ? []
      : active
          .filter((record) => !owed.has(record))
          .map((record) => ({ record, reason: 'no open finding' }));
  const remarks = advisory.filter((entry) => dispatched.includes(entry.record));
  ctx.store.append('reconcile-write-set', {
    actor: ACTOR,
    round,
    since,
    sha,
    records: dispatched,
    skipped,
    ...(kept.length > 0 && { kept }),
    ...(remarks.length > 0 && { advisory: remarks }),
  });
  return { records: dispatched, sha, advisory: remarks };
}

/**
 * The base one round's checks read: the stage's own, plus the sha the round
 * opened at. The checks read the round's whole range from there, so a
 * replacement a peer seat of the round committed is found (ADR-0078).
 */
function roundBase(base, set) {
  return set.sha ? { ...base, roundFrom: set.sha } : base;
}

/**
 * One pass of per-record writers. Returns the per-record ledger entries and the
 * reports behind them.
 *
 * A dispatch that fails ends itself and nothing else. The tree goes back to its
 * last commit, the entry carries the reason, and the round goes on to the next
 * record. No dispatch of this round parks a run: a record nobody wrote rides the
 * render as unwritten, and the run's ending names it (ADR-0080).
 */
async function writeRound(ctx, base, { records, since, buildRole, answered = false }) {
  const entries = [];
  const reports = [];
  // What this round has already committed, by the message each dispatch signs
  // its commit with. The commit is the durable half of a write and the stamp
  // behind it is the recorded half, so a stop between the two is read off the
  // tree and never repeated (ADR-0075).
  const committed = await roundCommits(base, ctx.runId, since);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const seat = `${WRITE_SEAT}:${i + 1}`;
    const done = await writtenAlready(ctx, runEvents(ctx), {
      seat,
      record,
      since,
      committed,
      base,
    });
    if (done) {
      entries.push(done.entry);
      reports.push(done.report);
      continue;
    }
    // A seat that died mid-edit leaves whatever it had written, and the next
    // dispatch must be the same dispatch as the first (ADR-0070). The tree's own
    // last commit is that dispatch's tree: the peer before it committed, and a
    // stop after this record's own commit leaves it at the head.
    await resetHard(base.worktree, await headSha(base.worktree));
    const spawnedAt = lastSeq(runEvents(ctx));
    const outcome = await seatWithChecks(ctx, {
      seat,
      schema: reconcileWriteSchema({ answered }),
      cwd: base.worktree,
      env: base.env,
      constitution: base.constitution,
      styleFiles: base.styleFiles,
      // What ended this record's last dispatch, where a round before this one
      // spent its budget on it. The seat that reads it is a fresh dispatch with
      // a budget of its own (ADR-0079).
      brief: refusedDefects(runEvents(ctx), record),
      buildRole: (brief) => buildRole(record, brief),
      checks: (report) => writeChecks(ctx, { ...base, seat }, [record], report),
    });
    if (outcome.fail) {
      // Every failed dispatch takes one road. The tree goes back to its last
      // commit, the entry carries the reason, and the round goes on to the next
      // record. A dispatch that delivered nothing and one whose work product
      // could not stand are the same fact here: this record has no write
      // (ADR-0080).
      const failure = seatFailureAfter(runEvents(ctx), seat, spawnedAt);
      await resetHard(base.worktree, await headSha(base.worktree));
      const entry = {
        record,
        seat,
        failed: true,
        reason: failure?.reason ?? 'seat-failure',
        attempts: attemptsOf(runEvents(ctx), seat, spawnedAt),
        ...(Array.isArray(failure?.defects) && { defects: failure.defects }),
      };
      stampWrite(ctx, entry);
      entries.push(entry);
      continue;
    }
    // A stop between the seat's report and its commit leaves the write for the
    // restart. The tree is one worktree and the daemon that comes back holds it,
    // so a commit from a stopped run would race the run's own resume.
    if (ctx.stopped()) return { stopped: true };
    const before = await headSha(base.worktree);
    const changed = await changedFiles(base.worktree);
    const sha =
      changed.length > 0
        ? await commitAll(base.worktree, commitMessage(ctx, seat, record, since))
        : before;
    const entry = {
      record,
      seat,
      ...(typeof outcome.cost === 'number' && { cost: outcome.cost }),
      attempts: attemptsOf(runEvents(ctx), seat, spawnedAt),
      ...(sha !== before && { sha }),
      ...((outcome.report.dropped ?? []).length > 0 && { dropped: outcome.report.dropped }),
    };
    stampWrite(ctx, entry);
    entries.push(entry);
    reports.push(outcome.report);
  }
  return { entries, reports };
}

/**
 * One write, stamped right after its commit. It is what a resume reads, beside
 * the commit subject, and nothing else reads it (ADR-0080).
 */
function stampWrite(ctx, entry) {
  ctx.store.append('record-written', {
    actor: ACTOR,
    ...entry,
    ...(entry.failed === true && {
      gist: gist(`${entry.record} was not written: ${entry.reason}`),
    }),
  });
}

/**
 * The message one dispatch signs its commit with: the run, the seat identity,
 * the record and the ledger position the round opened at. It is what a resume
 * reads to tell a write this round already made from one it still owes.
 *
 * The record rides it because the seat name alone is an index. A round that
 * holds no dispatch stamp derives its list from the tree, and a record another
 * seat closed shifts every index behind it. The record in the subject is what
 * keeps such a resume from counting one record's commit for another's
 * (ADR-0078).
 */
function commitMessage(ctx, seat, record, since) {
  return `reconcile: ${ctx.runId} ${seat} ${record} @${since}`;
}

/** The records this round has already committed a write for. */
async function roundCommits(base, runId, since) {
  const log = await git(['log', '--format=%s', '-n', '200'], { cwd: base.worktree }).catch(
    () => '',
  );
  const mark = `reconcile: ${runId} `;
  const tail = ` @${since}`;
  const records = new Set();
  for (const line of log.split('\n').map((entry) => entry.trim())) {
    if (!line.startsWith(mark) || !line.endsWith(tail)) continue;
    const named = line.slice(mark.length, line.length - tail.length).split(' ');
    // A subject a pin before this rule wrote names the seat alone. It answers
    // for no record, so the round re-dispatches that record rather than taking
    // the commit for one it never made.
    if (named.length === 2) records.add(named[1]);
  }
  return records;
}

/**
 * The write of one record this round already made, or null.
 *
 * Two facts say so and either one is enough, and both are read by record. The
 * `record-written` stamp of this seat naming this record is the whole record of
 * a finished dispatch, whether it wrote or failed. The round's commit naming the
 * record is the other, and it covers the stop that fell between the commit and
 * the stamp: the tree holds the write, so the dispatch is never made again
 * (ADR-0070, ADR-0080).
 *
 * Neither reads the seat name alone. A round with no dispatch stamp derives its
 * list from the tree, where a record a seat closed is gone, and a seat name
 * would then answer for a record its dispatch never touched (ADR-0078).
 */
async function writtenAlready(ctx, events, { seat, record, since, committed }) {
  const stamp = events.find(
    (e) => e.event === 'record-written' && e.seat === seat && e.record === record && e.seq > since,
  );
  if (stamp) {
    const { event: _event, seq: _seq, ts: _ts, actor: _actor, gist: _gist, ...entry } = stamp;
    if (entry.failed === true) return { entry, report: null };
    return { entry, report: readJson(lastSeatReportEvent(events, seat)?.path) };
  }
  if (!committed.has(record)) return null;
  // The commit is there and the stamp is not: the stop fell between the two.
  // The write stands in the tree, so the dispatch is never made again, and the
  // stamp is written from the report the seat left behind.
  const report = readJson(lastSeatReportEvent(events, seat)?.path);
  if (!report) return null;
  const entry = { record, seat, attempts: attemptsOf(events, seat, since) };
  stampWrite(ctx, entry);
  return { entry, report };
}

/**
 * The defects that ended this record's last dispatch, or null.
 *
 * A round that spends its budget on a record leaves the reason on its entry.
 * The round that dispatches the record again reads it there, so the seat starts
 * from what refused its predecessor rather than from nothing (ADR-0079).
 */
function refusedDefects(events, record) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== 'reconciliation-written') continue;
    const entry = (e.records ?? []).find((r) => r.record === record);
    if (!entry) continue;
    return entry.failed === true && Array.isArray(entry.defects) ? entry.defects : null;
  }
  return null;
}

/** The records one write stamp could not write, by path. */
function unwrittenRecords(anchor) {
  return (anchor?.records ?? []).filter((entry) => entry.failed === true).map((e) => e.record);
}

/** The mark a record with no write of its own carries in an open set. */
const UNWRITTEN = 'unwritten:';

function attemptsOf(events, seat, since) {
  return events.filter((e) => e.event === 'seat-spawned' && e.seat === seat && e.seq > since)
    .length;
}

function lastSeq(events) {
  return events.length > 0 ? events[events.length - 1].seq : 0;
}

/**
 * The write's own stamp: one entry per record with the seat, the cost and the
 * attempts, and the shape of the record tree behind it.
 */
async function stampWritten(ctx, base, { entries, reports, corrective = null }) {
  const kept = reports.filter(Boolean);
  const rewritten = [...new Set(kept.flatMap((r) => r.rewritten ?? []))];
  const unchanged = [...new Set(kept.flatMap((r) => (r.unchanged ?? []).map((u) => u.record)))];
  const dropped = [...new Set(kept.flatMap((r) => r.dropped ?? []))];
  const tree = await treeShape(base);
  ctx.store.append('reconciliation-written', {
    actor: ACTOR,
    ok: true,
    ...(corrective && { corrective: true, answered: corrective }),
    records: entries,
    rewritten,
    unchanged,
    ...(dropped.length > 0 && { dropped }),
    ...tree,
    sha: await headSha(base.worktree),
    gist: gist(`records written: ${rewritten.join(', ')}`),
  });
}

/**
 * The record tree after a write: how many records are active, how many this
 * write closed, and the pairs behind them. A supersession that splits one record
 * into several and one that merges several into one are the two shapes the count
 * alone cannot tell apart (ADR-0073).
 */
async function treeShape(base) {
  if (base.recordLifecycle !== 'supersede') {
    return { active: activeRecords(base.worktree, base.recordPaths).length };
  }
  const superseded = [];
  const byOld = new Map();
  const byNew = new Map();
  const closed = closedRecords(base);
  for (const file of recordFiles(base.worktree, base.recordPaths)) {
    const text = readText(join(base.worktree, file));
    if (text === null) continue;
    const parents = parseRecordList(supersedesOf(text) ?? '');
    if (!parents) continue;
    for (const id of parents) {
      const old = closed.get(id);
      if (!old) continue;
      superseded.push({ record: old, replacement: file });
      if (!byOld.has(old)) byOld.set(old, new Set());
      byOld.get(old).add(file);
      if (!byNew.has(file)) byNew.set(file, new Set());
      byNew.get(file).add(old);
    }
  }
  return {
    active: activeRecords(base.worktree, base.recordPaths).length,
    ...(superseded.length > 0 && { superseded }),
    supersededCount: byOld.size,
    split: [...byOld.values()].filter((set) => set.size > 1).length,
    merged: [...byNew.values()].filter((set) => set.size > 1).length,
  };
}

/** Every record whose status line is closed, by the id in its file name. */
function closedRecords(base) {
  const out = new Map();
  for (const file of recordFiles(base.worktree, base.recordPaths)) {
    const text = readText(join(base.worktree, file));
    if (text === null) continue;
    const word = statusOf(text).word;
    if (word !== 'superseded' && word !== 'retired') continue;
    const id = recordId(file);
    if (id !== null) out.set(id, file);
  }
  return out;
}

// -- the cycle ---------------------------------------------------------------

/**
 * One cycle of the stage over the newest record commit: the record layers, the
 * per-record review, and the render.
 *
 * Each half is restart-safe on its own terms. `runSpectrum` re-uses every
 * `layer-result` this cycle stamped; the review round re-uses every finding id
 * this cycle assigned. So a stop inside the cycle costs the step it interrupted
 * and never the steps in front of it.
 */
async function cycleStep(ctx, base) {
  const events = runEvents(ctx);
  const anchor = cycleAnchor(events);
  const cycle = nextCycle(events);
  const sha = await headSha(base.worktree);
  // The one window this cycle reads: the run's own record work, against the
  // merge base computed here (ADR-0079). A window the read could not answer
  // falls back to the anchor's own list, which is what the stage read before.
  const window = await runWindow(base);
  const changed = window.files.length > 0 ? window.files : reviewedRecords(events, anchor);
  const spectrum = await runRecordLayers(ctx, base, { cycle, sha, changed });
  if (spectrum.error) {
    return commandError(
      ctx,
      'gate-command',
      `A Tier-1 record layer could not run: ${spectrum.error}\nRepair the command, then answer.`,
    );
  }
  const reds = persistentReds(spectrum.results ?? []);
  const { records, kept } = await reviewSet(ctx, base, { cycle, sha, window, changed });
  const priorRender = lastRendered(events);
  const index = findingIndex(events);
  // What the last render of this stage left open, as findings. A layer name in
  // that set is not a finding and resolves nowhere: the layer answers for
  // itself, on its own next run.
  const priorConfirmed = (priorRender?.open ?? []).map((id) => index.get(id)).filter(Boolean);
  const round = await recordReviewRound(ctx, base, {
    records,
    units: unitsFor(base, records),
    neighbours: neighboursFor(base, records),
    moved: await movedFor(base, records, priorRender, window),
    spec: base.specRef,
    cycle,
    priorConfirmed,
  });
  if (round.fail) return round.fail;
  const open = [
    ...priorConfirmed.filter((f) => !round.resolved.includes(f.id)).map((f) => f.id),
    ...round.confirmed.map((f) => f.id),
    // A red record layer is a red render, and the layer is what the corrective
    // round answers. It rides the open set by name, because the round's brief
    // and the stall's ticket both state what is still wrong (ADR-0075).
    ...reds.map((r) => r.layer),
    // A record the last round could not write. The render stays red until a
    // round writes it, and the next round dispatches it by name (ADR-0079).
    ...unwrittenRecords(anchor).map((record) => `${UNWRITTEN}${record}`),
  ];
  // The remarks this cycle raised. They hold nothing red, and a reader of the
  // ledger asks what a green render stood over (ADR-0007).
  const advisory = runEvents(ctx)
    .filter(
      (e) => e.event === 'finding' && e.cycle === cycle && e.record === true && e.advisory === true,
    )
    .map((e) => e.id);
  ctx.store.append('reconcile-rendered', {
    actor: ACTOR,
    cycle,
    sha,
    // The window this cycle read, so a later reader knows which records were
    // this run's own when the render was made (ADR-0079).
    ...(window.base && { base: window.base }),
    verdict: open.length === 0 ? 'green' : 'red',
    open,
    ...(advisory.length > 0 && { advisory }),
    records,
    // The records this cycle stood over and did not read again. The render is
    // the whole set: what a seat read, and what its last green review answers
    // for (ADR-0079).
    ...(kept.length > 0 && { kept }),
    // The records this cycle dispatched a seat for and no seat read. They stay
    // open for the next cycle, and the run's ending names them (ADR-0080).
    ...(round.unreviewed?.length > 0 && { unreviewed: round.unreviewed }),
    layers: (spectrum.results ?? []).map((r) => ({ layer: r.layer, status: r.status })),
    ...(open.length > 0 && { gist: gist(`records red: ${open.join(', ')}`) }),
  });
  return null;
}

/**
 * The Tier-1 record layers over the record commit. The plan reads the record
 * diff, so a project that names `gates.recordLayers` runs those layers and their
 * prerequisites and nothing else; a project that names none runs what its
 * declared ground selects (ADR-0075).
 */
async function runRecordLayers(ctx, base, { cycle, sha, changed }) {
  const events = runEvents(ctx);
  const plan = cyclePlan(events, {
    cycle,
    pass: currentPass(events),
    layers: base.layers,
    changed,
    recordPaths: base.recordPaths,
    recordLayers: base.recordLayers,
  });
  return runSpectrum(ctx, {
    layers: base.layers,
    commands: base.commands,
    cwd: base.worktree,
    env: base.env,
    cycle,
    sha,
    run: plan.run,
    skip: plan.skip,
    prior: plan.prior,
    groups: configuredGroups(base.config),
    credentials: base.config.credentials ?? [],
    flakeRerun: base.config?.gates?.flakeRerun ?? 'narrowed',
  });
}

/**
 * The set one cycle reviews, stamped once and read on every entry.
 *
 * One seat runs per record and its name is the index in this list, so a list
 * the tree shrinks between two entries of one cycle would rename the seats and
 * lose the answers behind the record it dropped (ADR-0078).
 *
 * The kept records ride the answer beside the dispatched ones. The render names
 * both, because the set a cycle stood over is the reading, and a reader of the
 * dispatched list alone would count a kept record as a record nobody holds
 * (ADR-0079).
 * @returns {Promise<{records: string[], kept: string[]}>}
 */
async function reviewSet(ctx, base, { cycle, sha, window, changed }) {
  const events = runEvents(ctx);
  const stamped = events.find((e) => e.event === 'reconcile-review-set' && e.cycle === cycle);
  if (stamped) {
    return { records: stamped.records ?? [], kept: (stamped.kept ?? []).map((k) => k.record) };
  }
  const scope = await stageScope(base, window, changed);
  const split = await reviewSplit(base, events, { records: scope.records, sha });
  ctx.store.append('reconcile-review-set', {
    actor: ACTOR,
    cycle,
    records: split.records,
    skipped: scope.skipped,
    ...(split.kept.length > 0 && { kept: split.kept }),
  });
  return { records: split.records, kept: split.kept.map((k) => k.record) };
}

/**
 * What one cycle reads, and what it keeps.
 *
 * The first cycle of a pass reads every active record of the window, and so
 * does the cycle a moved default branch buys: neither has a green review of
 * this tree to stand on. Every later cycle reads the records the last round
 * changed and the records an open finding names, and keeps every other record
 * whose text has not moved since its last green review.
 *
 * A fresh seat over an unchanged green record raises findings on unchanged
 * sentences and spends the cap on them. The `consistent` criterion is still
 * read from the moved side, and a kept record a finding names is dispatched by
 * the round that answers it (ADR-0079).
 * @returns {Promise<{records: string[], kept: Array<{record: string, cycle: number}>}>}
 */
async function reviewSplit(base, events, { records, sha }) {
  const rendered = lastRendered(events);
  const rerun = rendered
    ? events.some(
        (e) =>
          e.event === 'pre-verdict-update' && e.records?.answer === 'rerun' && e.seq > rendered.seq,
      )
    : false;
  if (!rendered || rerun) return { records, kept: [] };
  const written = writtenSince(events, rendered.seq);
  const open = openRecords(events, rendered);
  // A record the last cycle dispatched and no seat read. It holds no green
  // review to stand on, so it is read again (ADR-0080).
  const unreviewed = new Set(rendered.unreviewed ?? []);
  const dispatched = [];
  const kept = [];
  for (const record of records) {
    const green =
      written.has(record) || open.has(record) || unreviewed.has(record)
        ? null
        : lastGreenReview(events, record);
    const before = green === null ? null : await showAt(base.worktree, green.sha, record);
    const after = green === null ? null : await showAt(base.worktree, sha, record);
    if (before === null || after === null || before !== after) {
      dispatched.push(record);
      continue;
    }
    kept.push({ record, cycle: green.cycle });
  }
  return { records: dispatched, kept };
}

/** The records the rounds since one render wrote, replacements included. */
function writtenSince(events, seq) {
  const out = new Set();
  for (const e of events) {
    if (e.event !== 'reconciliation-written' || e.seq < seq) continue;
    for (const record of e.rewritten ?? []) out.add(record);
    for (const entry of e.records ?? []) out.add(entry.record);
  }
  return out;
}

/** The records the open findings of one render name, on either side. */
function openRecords(events, rendered) {
  const index = findingIndex(events);
  const out = new Set();
  for (const id of rendered?.open ?? []) {
    const finding = index.get(id);
    if (!finding) continue;
    if (finding.file) out.add(finding.file);
    if (finding.file2) out.add(finding.file2);
  }
  return out;
}

/**
 * The newest render that read one record and raised nothing against it, with
 * the sha it judged. Null where no cycle of this pass has read it green.
 *
 * A render that listed the record under `unreviewed` read nothing about it, so
 * it is no green to stand on (ADR-0080).
 */
function lastGreenReview(events, record) {
  const index = findingIndex(events);
  let found = null;
  for (const e of events) {
    if (e.event !== 'reconcile-rendered' || !(e.records ?? []).includes(record)) continue;
    if ((e.unreviewed ?? []).includes(record)) continue;
    const against = (e.open ?? []).some((id) => {
      const finding = index.get(id);
      return finding && (finding.file === record || finding.file2 === record);
    });
    if (!against) found = { sha: e.sha, cycle: e.cycle };
  }
  return found;
}

/**
 * The record set of this cycle: every record the run's window holds, on every
 * cycle, until the stage is green. The window opens at the merge base of the
 * run branch and the default branch, so a record an early round rewrote is read
 * again by the round that follows it, and a record the default branch gained
 * meanwhile belongs to nobody here (ADR-0079).
 *
 * The scope and the fallback behind it both go through the active filter. The
 * layers still read the whole record diff, because the form gate is about the
 * file a closure changed as much as about the file a write added (ADR-0078).
 * @returns {Promise<{records: string[], skipped: Array<object>}>}
 */
async function stageScope(base, window, changed) {
  const scope = await recordScope(base.worktree, base.recordPaths, {
    lifecycle: base.recordLifecycle,
    defaultBranch: base.defaultBranch,
    window,
  }).catch(() => null);
  const files = scope ? scope.files : [];
  return activeOf(base.worktree, files.length > 0 ? files : changed);
}

function unitsFor(base, records) {
  const out = {};
  for (const record of records) {
    const text = readText(join(base.worktree, record));
    out[record] = text === null ? [] : recordUnits(text);
  }
  return out;
}

function neighboursFor(base, records) {
  const out = {};
  for (const record of records) {
    out[record] = recordNeighbours(base.worktree, record, base.recordPaths);
  }
  return out;
}

/**
 * The units this round moved, per record: the ids whose head text the write
 * changed since the tree the last cycle judged. The review's brief names them,
 * so a seat reads the sentences that moved before it reads the rest (ADR-0073).
 *
 * The comparison sha is the previous render's own, and the window's base on the
 * first cycle. Both are commits the run holds, so the read survives a restart
 * and needs no field of its own.
 */
async function movedFor(base, records, priorRender, window = null) {
  const from = priorRender?.sha ?? window?.base ?? base.rangeFrom;
  const out = {};
  if (typeof from !== 'string' || from.length === 0) return out;
  for (const record of records) {
    const after = readText(join(base.worktree, record));
    if (after === null) continue;
    const before = await showAt(base.worktree, from, record);
    out[record] = before === null ? [] : matchUnits(before, after).moved;
  }
  return out;
}

/** One file as a commit held it, or null where the commit did not hold it. */
async function showAt(worktree, sha, file) {
  try {
    return await git(['show', `${sha}:${file.replaceAll('\\', '/')}`], { cwd: worktree });
  } catch {
    return null;
  }
}

// -- the correction ----------------------------------------------------------

/**
 * One corrective round: a writer per record, briefed with the findings its
 * review raised against the tree, under the record cap.
 *
 * It stamps `reconcile-round` and never `repair-round`. The two caps never read
 * each other's rounds, and nothing here reaches the verdict: a corrective record
 * round changes no code and buys no code cycle (ADR-0075).
 */
async function correctStep(ctx, base, next) {
  const events = runEvents(ctx);
  const judged = judgment(events);
  const rendered = lastRendered(events);
  const anchor = cycleAnchor(events);
  const index = findingIndex(events);
  const open = (rendered?.open ?? []).map((id) => index.get(id)).filter(Boolean);
  const layers = (rendered?.open ?? []).filter(
    (id) => !index.has(id) && !id.startsWith(UNWRITTEN),
  );
  const round = roundsSince(events, judged.seq) + 1;
  const held = reviewedRecords(events, anchor);
  // The records a seat may answer for. A closed one takes no writer, so the
  // question of who owes an answer is asked over the active set alone: a red
  // layer that names a closed record names nobody, and the round widens
  // (ADR-0079).
  const active = activeOf(base.worktree, held).records;
  const set = await dispatchSet(ctx, base, {
    round,
    since: rendered.seq,
    records: held,
    owed: correctiveRecords(events, rendered, active),
    advisory: recordRemarks(events, active, judged.seq),
  });
  // A red render with nothing to dispatch over is the cap. Every record of the
  // set is closed, no seat may answer for one, and a round that spawns none
  // buys nothing (ADR-0078).
  if (set.records.length === 0) return stallStep(ctx, base, next, { rounds: 0, empty: true });
  const records = set.records;
  // The remarks this round hands over, rebuilt from the set it stamped. A
  // remark rides the brief of the record it is about and nothing else.
  const remarks = advisoryIndex(events);
  const remarksFor = (record) =>
    (set.advisory.find((entry) => entry.record === record)?.ids ?? [])
      .map((id) => remarks.get(id))
      .filter(Boolean);
  const outcome = await writeRound(ctx, roundBase(base, set), {
    records,
    since: rendered.seq,
    // A corrective invocation lists the ids it answered; the first write of a
    // run answers no finding and is asked for no such list.
    answered: true,
    buildRole: (record, brief) =>
      correctiveRole(
        base,
        {
          ...judged,
          records: [record],
          neighbours: recordNeighbours(base.worktree, record, base.recordPaths),
        },
        {
          findings: open.filter((f) => f.file === record || f.file2 === record),
          advisory: remarksFor(record),
          brief: layerBrief(layers, brief),
        },
      ),
  });
  if (outcome.stopped) return null;
  // The remarks the writers say they answered ride the stamp beside the
  // findings the round was opened for. A later round hands over every remark
  // this list does not name, so a remark stands until a writer answers it and
  // never after (ADR-0007). A finding the writer disputed is answered as far as
  // the round is concerned: the next fresh reviewer either raises it again or
  // does not (ADR-0080).
  const handed = new Set(set.advisory.flatMap((entry) => entry.ids));
  const answered = [
    ...new Set(outcome.reports.flatMap((r) => (r.answered ?? []).map((a) => a.id))),
  ].filter((id) => handed.has(id));
  await stampWritten(ctx, base, {
    entries: outcome.entries,
    reports: outcome.reports,
    corrective: [...open.map((f) => f.id), ...answered],
  });
  const failed = outcome.entries.filter((entry) => entry.failed === true).map((e) => e.record);
  ctx.store.append('reconcile-round', {
    actor: ACTOR,
    round,
    records,
    findings: rendered.open ?? [],
    ...(failed.length > 0 && { failed }),
  });
  return null;
}

/**
 * The remarks each record still holds: every advisory record finding this pass
 * raised on it that no write of the pass says it answered.
 *
 * A remark holds no render red, so nothing else reads it. It is collected here
 * because the round that writes the record for a HIGH is the one seat that is
 * reading that record anyway, and a remark thrown away comes back as the HIGH
 * of a later run (ADR-0007).
 *
 * `records` is the set a dispatch may answer for, and a remark on any other
 * record is left where it stands. `null` is every record: the readers that ask
 * what the whole run still holds take that, because a set read from any one
 * stamp leaves out a record another stamp named.
 * @param {object[]} events the run's ledger, in order
 * @param {string[]|null} records the records a seat may answer for, or null
 * @param {number} since the seq the pass's judgment stands at
 * @returns {Array<{record: string, ids: string[]}>}
 */
export function recordRemarks(events, records, since) {
  const answered = new Set();
  for (const e of events) {
    if (e.event !== 'reconciliation-written') continue;
    for (const id of e.answered ?? []) answered.add(id);
  }
  const held = records === null ? null : new Set(records);
  const out = new Map();
  for (const e of events) {
    if (e.event !== 'finding' || e.record !== true || e.advisory !== true) continue;
    if (e.seq <= since || answered.has(e.id)) continue;
    if (held !== null && !held.has(e.file)) continue;
    if (!out.has(e.file)) out.set(e.file, []);
    out.get(e.file).push(e.id);
  }
  return [...out].map(([record, ids]) => ({ record, ids }));
}

/**
 * The heading a ticket lists the remarks under, in both lanes. One heading, so
 * a person who reads two tickets reads one word for one thing.
 */
export const REMARKS_HEADING = '## Remarks not answered';

/**
 * The remarks a run carries out of its record work, as findings: the advisory
 * record findings of the pass no write says it answered.
 * @returns {object[]}
 */
export function remarksOf(events, records, since) {
  const index = advisoryIndex(events);
  return recordRemarks(events, records, since)
    .flatMap((entry) => entry.ids)
    .map((id) => index.get(id))
    .filter(Boolean);
}

/**
 * The remarks of a whole run: every advisory record finding of the pass that no
 * write says it answered, whatever record it names.
 *
 * One derivation, three readers: the cap's ticket, the close's ticket and the
 * close's own stamp. It takes no record set, because every set a stamp holds
 * leaves out a record another stamp named. The judge names the records it found
 * owed, and a birth writes records it never owed; a write stamp names the
 * records that dispatch wrote, and a corrective round dispatches the records an
 * open finding names and no others. A remark on any of them is a remark the run
 * ships with (ADR-0007).
 * @param {object[]} events the run's ledger, in order
 * @returns {object[]}
 */
export function runRemarks(events) {
  return remarksOf(events, null, recordPassSeq(events));
}

/**
 * The seq the pass's record work opens at: its own judgment, which is the
 * ticketless one since the last `fresh-pass`.
 *
 * Every reading over the pass's findings starts here, in this module and in the
 * center's own. A reading that started at nought would count a discarded pass's
 * findings as this pass's, and a reading that started at the close-out's
 * ticketed stamp would count none at all (ADR-0077).
 * @param {object[]} events the run's ledger, in order
 * @returns {number}
 */
export function recordPassSeq(events) {
  return judgment(events)?.seq ?? 0;
}

/**
 * The records a corrective round owes a seat: every record an open finding
 * names, and every record a red layer names in the output it captured.
 *
 * Seven of sixteen seats owed nothing on the run this rule comes from. A seat
 * over a record no finding names reads the record, writes nothing, and costs
 * the round a dispatch (ADR-0079).
 *
 * A red layer that names no active record of the set dispatches nothing. The
 * widening it used to buy sent every record of a batch to a writer over a red no
 * seat could clear, at a round's whole cost. The empty set stalls at once, and
 * the run merges with the layer named (ADR-0080).
 * @param {object[]} events the run's ledger, in order
 * @param {object} rendered the render this round answers
 * @param {string[]} records the active records the round stands over
 * @returns {Set<string>} the records a seat may answer for
 */
export function correctiveRecords(events, rendered, records) {
  const index = findingIndex(events);
  const ids = rendered?.open ?? [];
  const open = ids.map((id) => index.get(id)).filter(Boolean);
  const layers = ids.filter((id) => !index.has(id) && !id.startsWith(UNWRITTEN));
  const unwritten = new Set(
    ids.filter((id) => id.startsWith(UNWRITTEN)).map((id) => id.slice(UNWRITTEN.length)),
  );
  const owed = new Set(
    records.filter(
      (record) =>
        unwritten.has(record) || open.some((f) => f.file === record || f.file2 === record),
    ),
  );
  const named = layerRecords(events, rendered?.cycle, records);
  for (const record of named) owed.add(record);
  return owed;
}

/**
 * The records a red layer of one cycle named in its captured output. The form
 * gate prints the record path and the line it refused, so the round reads the
 * layer's own answer rather than dispatching every record behind it.
 */
function layerRecords(events, cycle, records) {
  const named = new Set();
  for (const e of events) {
    if (e.event !== 'layer-result' || e.cycle !== cycle || e.status !== 'red') continue;
    const texts = [e.output ?? '', ...(e.parts ?? []).map((part) => part.output ?? '')];
    for (const text of texts) {
      for (const match of String(text).matchAll(/[\w./\\-]+\.md/g)) {
        const path = match[0].replaceAll('\\', '/');
        const hit = records.find((record) => path === record || path.endsWith(`/${record}`));
        if (hit) named.add(hit);
      }
    }
  }
  return named;
}

/** The red layers a corrective round is answering, stated to the seat. */
function layerBrief(layers, brief) {
  if (layers.length === 0) return brief;
  const lines = [
    'These Tier-1 layers are red over the record commit. Read the layer command output and',
    'answer what it names in the records:',
    ...layers.map((layer) => `- ${layer}`),
  ];
  return brief ? [lines.join('\n'), ...(Array.isArray(brief) ? brief : [brief])] : lines.join('\n');
}

// -- the recheck -------------------------------------------------------------

/**
 * Whether a repair round landed past this green render. A green reconciliation
 * answered the run's diff; a repair round changes that diff, so the stage owes
 * the recheck of point 14 before the run goes on (ADR-0075).
 */
function recheckOwed(events, rendered) {
  const repaired = [...events]
    .reverse()
    .find((e) => e.event === 'repair-round' && e.seq > rendered.seq);
  if (!repaired) return false;
  return !events.some((e) => e.event === 'reconcile-recheck' && e.seq > repaired.seq);
}

/**
 * The recheck a repair owes a green reconciliation.
 *
 * The judge reads the delta alone and says whether it implicates a record not
 * already answered by this run. A record it names is re-reviewed whole, by the
 * cycle the stage runs for every write. A delta that implicates no record stamps
 * `kept` and costs one seat.
 *
 * It used to re-answer the units whose evidence path the delta touched. Nothing
 * carries a per-unit evidence path any more, and a record is one screen: the
 * seat that reads it whole answers the question the intersection was narrowing
 * (ADR-0080).
 */
async function recheckStep(ctx, base) {
  const events = runEvents(ctx);
  const rendered = lastRendered(events);
  const impl = [...events]
    .reverse()
    .find((e) => e.event === 'implementation-committed' && e.seq > rendered.seq);
  const delta = impl?.baseSha && impl?.sha ? { from: impl.baseSha, to: impl.sha } : null;
  const touched = delta
    ? await changedInRange(base.worktree, delta.from, delta.to).catch(() => [])
    : [];
  const judge = await recheckJudge(ctx, base, { delta, touched });
  if (judge.fail) return judge.fail;
  // A record the last render stood over is already this run's, whether a seat
  // read it or its last green review answers for it. Only a record outside that
  // set is newly owed (ADR-0079).
  const held = new Set([...(rendered.records ?? []), ...(rendered.kept ?? [])]);
  const owed = (judge.records ?? []).filter((record) => !held.has(record));
  const stamp = {
    actor: ACTOR,
    delta: delta ? `${delta.from}..${delta.to}` : null,
    judge: judge.reason ?? 'no judgment',
  };
  if (owed.length === 0) {
    // The recheck that found nothing is stamped too: it is the evidence that the
    // rule is not too narrow, and the yield reads every other word as work the
    // recheck did (ADR-0075).
    ctx.store.append('reconcile-recheck', { ...stamp, result: 'kept' });
    return null;
  }
  ctx.store.append('reconcile-recheck', { ...stamp, records: owed, result: 'owed' });
  ctx.store.append('reconciliation-judged', {
    actor: ACTOR,
    ok: true,
    owed: true,
    records: owed,
    reason: judge.reason ?? 'a repair round moved the code this reconciliation read',
    born: [],
    late: owed,
    recheck: true,
    gist: gist(`recheck owes: ${owed.join(', ')}`),
  });
  return null;
}

/** The judge over the delta alone: does it implicate a record not already owed. */
async function recheckJudge(ctx, base, { delta, touched }) {
  const result = await ctx.runSeat({
    seat: 'reconcile-judge',
    roleBlock: recheckRole(base, { delta, touched }),
    reportPath: runReportPath(ctx.paths, ctx.runId, `reconcile-judge-recheck-${lastSeq(runEvents(ctx))}`),
    schema: RECHECK_JUDGE_SCHEMA,
    cwd: base.worktree,
    env: base.env,
    constitution: base.constitution,
    styleFiles: base.styleFiles,
  });
  if (!result.ok) return { records: [], reason: 'the recheck judge could not answer' };
  return { records: result.report.owed ? result.report.records : [], reason: result.report.reason };
}

function recheckRole(base, { delta, touched }) {
  return [
    'A repair round changed this run after the decision records were judged green.',
    'Judge that change alone; change nothing.',
    ...(delta
      ? [`The change is the range below. Read it with:`, `git diff ${delta.from}..${delta.to}`]
      : ['The change has no recorded range; read the run branch as it stands.']),
    ...(touched.length > 0
      ? ['The files it touched:', ...touched.slice(0, 40).map((file) => `- ${file}`)]
      : []),
    'owed=true when this change implements, contradicts or deviates from a decision',
    'record that is not already answered by this run. List those record paths in',
    'records. Where it implicates no further record, answer owed=false with the reason.',
  ].join('\n');
}

// -- the ending --------------------------------------------------------------

/**
 * The stall at the cap: loud, and answered by the harness itself.
 *
 * Nobody is asked, on any lane. The stage spent its round and something is still
 * open, so the run pushes and merges with what is still wrong named on the close
 * stamp and in the request body. A record never blocks a lane (ADR-0080).
 *
 * A red render over a dispatch set that holds nothing reaches the same stall
 * with no round spent. It stamps `rounds: 0` and the gist says why: no seat of
 * the set can answer the render (ADR-0078).
 * @param {{rounds?: number, empty?: boolean}} [opts]
 */
async function stallStep(ctx, base, next, { rounds = null, empty = false } = {}) {
  const events = runEvents(ctx);
  const judged = judgment(events);
  const rendered = lastRendered(events);
  const open = rendered?.open ?? [];
  ctx.store.append('reconcile-stall', {
    actor: ACTOR,
    rounds: rounds ?? roundsSince(events, judged.seq),
    open,
    gist: gist(
      empty
        ? `the record set holds nothing to dispatch and ${open.length} stay open: ` +
            open.join(', ')
        : `the record rounds are spent with ${open.length} open: ${open.join(', ')}`,
    ),
  });
  return fallbackStep(ctx, base, { cause: RECORD_CAP, residual: open, next });
}

/**
 * The fallback stamp, and the route behind it: the update, on every lane.
 *
 * `reconcileCertification` reads a fallback behind a red render as the stage's
 * answer, so the update and the ship admit the tree and the run merges. The
 * records lane used to keep its work here and ask a person for more rounds; a
 * park asks a person for a number the harness already has, and the owner's rule
 * is push and merge (ADR-0080).
 */
async function fallbackStep(ctx, base, { cause, residual = [], next = NEXT_STAGE }) {
  const index = findingIndex(runEvents(ctx));
  const findings = residual.filter((id) => index.has(id));
  ctx.store.append('reconciliation-written', {
    actor: ACTOR,
    ok: false,
    // The cause is checked against the registry at the one moment it could still
    // be a new word: a tripwire counts these, and a count that reads a word one
    // writer spells its own way is a count of nothing (ADR-0008).
    cause: assertReconcileCause(cause),
    ...(cause === RECORD_CAP && { partial: true, residual: findings }),
    gist: gist(`the record write ended in a fallback: ${cause}`),
  });
  return { next };
}

/**
 * The records this run holds that no round wrote, by path. The request body
 * names them and the close stamps them (ADR-0080).
 * @param {object[]} events the run's ledger, in order
 * @returns {string[]}
 */
export function unwrittenOf(events) {
  const out = new Set();
  const since = recordPassSeq(events);
  for (const e of events) {
    if (e.event === 'merge-round') {
      // A record the merge round dropped the run's own change to. The default
      // branch's version stands, so this run wrote nothing to it (ADR-0080).
      for (const record of e.recordsDropped ?? []) out.add(record);
      continue;
    }
    if (e.event !== 'record-written' || e.seq <= since) continue;
    // A dispatch that delivered nothing, and a dispatch whose report claimed a
    // rewrite the tree does not hold, are one fact here: this record has no
    // write of this run (ADR-0080).
    if (e.failed === true || (e.dropped ?? []).includes(e.record)) out.add(e.record);
    else out.delete(e.record);
  }
  return [...out];
}

/**
 * The records of this run's last render that no review seat read. A later cycle
 * that read one takes it out of the set, because the render that stands is the
 * stage's answer (ADR-0080).
 * @param {object[]} events the run's ledger, in order
 * @returns {string[]}
 */
export function unreviewedOf(events) {
  return lastRendered(events)?.unreviewed ?? [];
}
// -- the base ----------------------------------------------------------------

/**
 * What the stage reads: the tree, the record tree and its lifecycle, the seat
 * environment, the Tier-1 layers the record diff selects, and the range the
 * record scope opens at.
 */
async function reconcileBase(ctx) {
  const config = await loadProjectConfig(ctx);
  const worktree = ctx.payload.worktree;
  const events = runEvents(ctx);
  const cardPath = typeof ctx.payload.card === 'string' ? ctx.payload.card : null;
  const ticket = answeredPath(events, 'ticket-missing') ?? ctx.payload.ticket;
  const mode = cardPath !== null ? 'story' : ctx.lane === 'records' ? 'records' : 'repair';
  const defaultBranch = ctx.payload.defaultBranch ?? 'main';
  const base = recordBase({
    config,
    worktree,
    mode,
    branch: ctx.payload.branch,
    defaultBranch,
    layers: config.gates.tier1 ?? [],
    commands: config.commands,
    recordLayers: config.gates?.recordLayers ?? [],
    testPaths: config.repo.testPaths ?? [],
    allowlistPaths: config.gates?.allowlistPaths ?? [],
    cap: config.gates?.reconcileRounds ?? DEFAULT_RECONCILE_ROUNDS,
    born: recordsCommitted(events)?.paths ?? [],
    specRef: cardPath ? join(ctx.paths.runs, ctx.runId, 'spec.md') : specPath(worktree, ticket),
    constitution: readConstitution(worktree, config),
    rangeFrom: await rangeStart(ctx, events, { worktree, defaultBranch }),
  });
  // The seat environment carries the range, so the record layer's own gate reads
  // the pass's opening sha and never a CI variable no run sets (ADR-0075).
  return { ...base, env: runEnv(ctx, config, base) };
}

function specPath(worktree, ticket) {
  if (typeof ticket !== 'string' || ticket.length === 0) return null;
  return ticket.startsWith('/') || /^[A-Za-z]:[\\/]/.test(ticket) ? ticket : join(worktree, ticket);
}

/**
 * The sha every record read of this stage opens at, and the sha the record
 * layer's own gate command is given.
 *
 * It is the merge base of the run branch and the default branch, computed here
 * (ADR-0079). CI judges a request against that same commit, so the in-run gate
 * and the CI gate read one set. A merge base the read cannot answer falls back
 * to the sha the pass opened at, which is what the stage read before.
 */
async function rangeStart(ctx, events, { worktree, defaultBranch }) {
  const window = await runWindow({ worktree, defaultBranch });
  if (window.base) return window.base;
  const lane =
    typeof ctx.payload.baseSha === 'string'
      ? ctx.payload.baseSha
      : (recordsCommitted(events)?.sha ?? null);
  return passOpeningSha(events, lane);
}
