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
//
// Where the project's `gates.reconcile` says `advisory`, the stage runs the
// record layers over a born set, stamps `reconcile-skipped` and hands the run
// on. It spawns no judge, no writer and no reviewer, and it blocks nothing: the
// judge runs after the merge in the close-out, and what it finds is a drift
// ticket the owner launches (ADR-0090). The records lane runs `full` in either
// mode, because its diff is the records and its birth is the judgment.
import { join } from 'node:path';
import { runReportPath } from '../daemon/home.mjs';
import {
  RECORD_CAP,
  SEAT_FAILURE,
  assertJudgeCause,
  assertReconcileCause,
} from '../ledger/registry.mjs';
import { DEFAULT_RECONCILE_ROUNDS, reconcileMode } from '../config/project.mjs';
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
  birthNeighbours,
  governingRecordLines,
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

/**
 * The judge's report: whether the diff owes a record rewrite, the records it
 * owes, and one cause per record.
 *
 * `causes` is a list beside `records` and not a field inside it. Six readers
 * take `records` as a list of paths, so the paths stay a list of paths and the
 * causes ride alongside, one word per record in the same order (ADR-0090).
 *
 * Three seats answer in it: the stage's judge, the recheck a repair round owes
 * and the close-out judge that reads a merge. One question, one shape.
 */
export const RECONCILE_JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    owed: { type: 'boolean' },
    records: { type: 'array', items: { type: 'string' } },
    causes: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['owed', 'records', 'causes', 'reason'],
};

const RECHECK_JUDGE_SCHEMA = RECONCILE_JUDGE_SCHEMA;

/**
 * What makes a record owed, stated once and read by every judge of the record
 * work: the stage's own, the recheck behind a repair round, and the close-out
 * judge that reads the merge under `advisory`.
 *
 * Owed is a contradiction or an undecided decision, and nothing else. A diff
 * that builds what an active record already decides owes no rewrite: the record
 * states the decision, and the decision did not change when the code landed. A
 * judge that also owed on "implements" owed on every diff, because a record
 * that named its unbuilt parts was made stale by the run that built them
 * (ADR-0090).
 *
 * The cause rides every owed record, so a judge that has drifted back to owing
 * on everything is readable: the words say which of the two grounds it used,
 * and the `record-owed-window` metric counts the runs that owed at all.
 */
export const OWED_CRITERION = [
  'owed=true for a record only where one of two things is true of the diff:',
  '- contradicts: the diff moves past what an active record decides. The',
  '  record says one thing and the code does another.',
  '- undecided: the diff makes a decision whose reason and rejected options a',
  '  reader of the code cannot recover. No active record holds that decision.',
  'A diff that builds exactly what an active record decides owes nothing: the',
  'decision is the record, and code landing changes no record. A record states',
  'no implementation status, so "the record says this part is not built and the',
  'diff built it" is not a ground and owes nothing.',
  'List every owed record path in records. In causes, put one word per record,',
  'in the same order: "contradicts" or "undecided". State the reason for the',
  'whole judgment in one or two sentences.',
];

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
    // The word first, from the run's pinned config blob, as every stage reads
    // its config. Under `advisory` the stage judges nothing here and the run
    // goes on; the close-out holds the judge (ADR-0090).
    if (skipsJudgment(base)) return advisoryStep(ctx, base, next);
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

/**
 * Whether this run's stage stands out of the ship path.
 *
 * The records lane never does, in either mode. Its diff is the records, its
 * birth is the judgment, and a lane that skipped its own work would ship a
 * record tree no review read (ADR-0090).
 * @param {{reconcile?: string, mode?: string}} base the lane base
 */
export function skipsJudgment(base) {
  return base?.reconcile === 'advisory' && base?.mode !== 'records';
}

/**
 * The stage under `advisory`: the record layers over the born set, one stamp,
 * and the run goes on.
 *
 * The layers run because this stage is the one place the project's form gate
 * reads a born record before it merges. They run over the born set alone: a run
 * in this mode rewrites no record, so there is nothing else of the record tree
 * this run changed. A red layer rides the request body and the drift ticket and
 * blocks nothing, which is what the word buys.
 *
 * The stamp is the resume boundary. A stop inside the layers leaves no stamp,
 * and the re-entry runs the cycle the spectrum already holds results for.
 */
async function advisoryStep(ctx, base, next) {
  const events = runEvents(ctx);
  if (events.some((e) => e.event === 'reconcile-skipped')) return { next };
  const born = recordsCommitted(events);
  const paths = born?.decided === true ? (born.paths ?? []) : [];
  let layers = [];
  if (paths.length > 0) {
    const spectrum = await runRecordLayers(ctx, base, {
      cycle: nextCycle(events),
      sha: await headSha(base.worktree),
      changed: paths,
    });
    if (spectrum.error) {
      return commandError(
        ctx,
        'gate-command',
        `A Tier-1 record layer could not run: ${spectrum.error}\nRepair the command, then answer.`,
      );
    }
    layers = (spectrum.results ?? []).map((r) => ({ layer: r.layer, status: r.status }));
  }
  const red = layers.filter((layer) => layer.status === 'red').map((layer) => layer.layer);
  ctx.store.append('reconcile-skipped', {
    actor: ACTOR,
    mode: 'advisory',
    layers,
    ...(red.length > 0 && { gist: gist(`the record layers are red and the run goes on: ${red.join(', ')}`) }),
  });
  return { next };
}

/**
 * The record layers one skipped stage left red, by name. The request body names
 * them: where the judge runs after the merge, that layer run is the whole of
 * what the harness read about these records before the request opened, and a
 * red it blocked nothing on is a red the request has to carry (ADR-0090).
 * @param {object[]} events the run's ledger, in order
 * @returns {string[]}
 */
export function skippedReds(events) {
  const skipped = sinceFreshPass(events, (e) => e.event === 'reconcile-skipped');
  return (skipped?.layers ?? []).filter((l) => l.status === 'red').map((l) => l.layer);
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
 *
 * That reading is what lets the update stage keep a code proof over records the
 * cap closed. This stage answers every pass it judged, green or fallen back, so
 * the stages behind it meet a certification either way and never a red
 * reconciliation beside a standing verdict (ADR-0086).
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
  // A judgment whose causes do not answer for its records is no judgment. It is
  // stamped as one the seat could not make, and the stage buys the cycle over
  // the born set behind it, exactly as it does for a seat that died: the ledger
  // never carries an owed record whose ground nobody can read (ADR-0090).
  const causes = judgeCauses(result.report);
  if (causes === null) {
    ctx.store.append('reconciliation-judged', {
      actor: ACTOR,
      ok: false,
      owed: false,
      cause: UNCAUSED_JUDGMENT,
      born,
      late: [],
      gist: gist(UNCAUSED_JUDGMENT),
    });
    return null;
  }
  const bornPaths = new Set(born);
  ctx.store.append('reconciliation-judged', {
    actor: ACTOR,
    ok: true,
    owed: true,
    records,
    causes,
    reason,
    born,
    late: records.filter((record) => !bornPaths.has(record)),
    gist: gist(`reconciliation owed: ${records.join(', ')}`),
  });
  return null;
}

/**
 * The causes of one judgment, one word per owed record, or null where the
 * report does not answer for every record it owes.
 *
 * Every word goes through the registry, which is the one place the vocabulary
 * lives. A judge that invented a third ground is a judge reading the criterion
 * loosely, and the count the alarm reads would be a count of nothing (ADR-0090).
 */
function judgeCauses(report) {
  const records = report?.records ?? [];
  const causes = report?.causes ?? [];
  if (causes.length !== records.length) return null;
  try {
    return causes.map((cause) => assertJudgeCause(cause));
  } catch {
    return null;
  }
}

/** What a judgment that named no ground for its records is stamped with. */
const UNCAUSED_JUDGMENT =
  'the judge owed records and named no cause for them: every owed record carries one word, ' +
  'contradicts or undecided';

function judgeRole(base) {
  const born = recordEntriesOf(base.born);
  // The active tree by path, minus the records the brief names below. A judge
  // told to find the tree itself read closed records, and a closed record is a
  // decision nobody owes an answer for (ADR-0089).
  const tree = governingRecordLines(base.worktree, [], base.recordPaths ?? [], {
    exclude: born,
    reconcile: base.reconcile,
  });
  return [
    'Judge whether the diff of this run contradicts any decision record (ADR),',
    'or decides something no record holds. You judge only; change nothing.',
    `The diff is this branch against ${base.defaultBranch}. Read it with:`,
    `git diff ${base.defaultBranch}...HEAD`,
    ...OWED_CRITERION,
    ...(tree.length > 0
      ? tree
      : ['The project declares no decision-record tree: owed=false with that as the reason.']),
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
 * The judged records, written by one seat over the whole set, in the one run
 * worktree (ADR-0090).
 *
 * One seat and not one per record. Two or three records in one writer's context
 * is a gain: the writer sees the set and cannot write two that decide one point
 * differently. The commit is the durable half and the `record-written` stamps
 * behind it are the recorded half, one per record: a stop between the two
 * re-reads the commit body and stamps from it, and the seat is dispatched again
 * never.
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
    buildRole: (given, brief) =>
      writeRole(base, { ...judged, records: given, neighbours: setNeighbours(base, given) }, brief),
  });
  if (outcome.stopped) return null;
  await stampWritten(ctx, base, { entries: outcome.entries, reports: outcome.reports });
  // The story and repair lanes ship code beside their records, and a seat that
  // delivered nothing is the one thing a later round cannot answer: the records
  // are owed and no report says a word about them. Their own ending takes it,
  // which is a merge with the records ticketed (ADR-0080). The records lane has
  // no code, so it carries them on the render as unwritten and the cycle goes
  // on. A seat that answered and left a record out is a different fact: the
  // render carries that record and the next round dispatches it.
  //
  // The test reads the entries and not the round's own return, because a stop
  // between the failure stamps and this line resumes here, and the stamps are
  // what the resume holds.
  if (base.mode !== 'records' && outcome.entries.some(seatFailedEntry)) {
    return fallbackStep(ctx, base, { cause: SEAT_FAILURE, next });
  }
  return null;
}

/** A record whose round delivered no report at all, as against one it left out. */
function seatFailedEntry(entry) {
  return entry?.failed === true && entry.reason !== UNREPORTED;
}

/**
 * The neighbourhood one write set shares: every active record that cites one of
 * the set or is cited by one, minus the set itself.
 *
 * The set is given to one seat, so it is given one neighbourhood. A record of
 * the set that ranks into another's neighbourhood is dropped: the seat already
 * holds it, and a path named twice reads as two duties (ADR-0089).
 */
function setNeighbours(base, records) {
  const held = new Set(records.map((record) => String(record).replaceAll('\\', '/')));
  const near = birthNeighbours(base.worktree, records, base.recordPaths ?? []);
  return { neighbours: near.neighbours.filter((file) => !held.has(file)), dropped: near.dropped };
}

/**
 * The set one write round dispatches over, and the tree it opened on.
 *
 * The round filters the list it was given and stamps what it dispatches and
 * what it dropped, once. A re-entry reads that stamp rather than the tree: the
 * round's own seat closes records as it writes them, so a list derived again
 * from the tree would be a different list, and the round would answer for a set
 * nobody dispatched it over (ADR-0078).
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
 * One write round: one seat over the whole set, one commit, one stamp per
 * record. Returns the per-record ledger entries and the report behind them.
 *
 * A seat that fails ends the round and nothing else. The tree goes back to its
 * last commit and every record of the set carries the reason. No round of this
 * stage parks a run: a record nobody wrote rides the render as unwritten, and
 * the run's ending names it (ADR-0080).
 *
 * The set is what the seat is given and the set is what it answers for. A
 * record the report names in neither `rewritten` nor `unchanged` is unwritten,
 * with the round's own word for it: the seat had the record, said nothing about
 * it, and the next round dispatches it by name (ADR-0090).
 * @returns {Promise<{entries: object[], reports: object[], stopped?: boolean}>}
 */
async function writeRound(ctx, base, { records, since, buildRole, answered = false }) {
  const seat = `${WRITE_SEAT}:1`;
  // What this round has already committed, read off the commit the seat's write
  // rides. The commit is the durable half of a write and the stamps behind it
  // are the recorded half, so a stop between the two is read off the tree and
  // never repeated (ADR-0090).
  const committed = await roundCommits(base, ctx.runId, since);
  const done = await writtenAlready(ctx, runEvents(ctx), { seat, records, since, committed });
  if (done) return { entries: done.entries, reports: done.reports };
  // A seat that died mid-edit leaves whatever it had written, and the next
  // dispatch must be the same dispatch as the first (ADR-0070). The tree's own
  // last commit is that dispatch's tree.
  await resetHard(base.worktree, await headSha(base.worktree));
  const spawnedAt = lastSeq(runEvents(ctx));
  const outcome = await seatWithChecks(ctx, {
    seat,
    schema: reconcileWriteSchema({ answered }),
    cwd: base.worktree,
    env: base.env,
    constitution: base.constitution,
    styleFiles: base.styleFiles,
    // What ended the last write dispatch of this pass, where a round before
    // this one spent its budget. The seat that reads it is a fresh dispatch
    // with a budget of its own (ADR-0079).
    brief: refusedDefects(runEvents(ctx)),
    buildRole: (brief) => buildRole(records, brief),
    checks: (report) => writeChecks(ctx, { ...base, seat }, records, report),
  });
  if (outcome.fail) {
    // A seat that delivered nothing and one whose work product could not stand
    // are the same fact here: this round wrote no record (ADR-0080).
    const failure = seatFailureAfter(runEvents(ctx), seat, spawnedAt);
    await resetHard(base.worktree, await headSha(base.worktree));
    const attempts = attemptsOf(runEvents(ctx), seat, spawnedAt);
    const entries = records.map((record) => ({
      record,
      seat,
      failed: true,
      reason: failure?.reason ?? 'seat-failure',
      attempts,
      ...(Array.isArray(failure?.defects) && { defects: failure.defects }),
    }));
    for (const entry of entries) stampWrite(ctx, entry);
    return { entries, reports: [] };
  }
  // A stop between the seat's report and its commit leaves the write for the
  // restart. The tree is one worktree and the daemon that comes back holds it,
  // so a commit from a stopped run would race the run's own resume.
  if (ctx.stopped()) return { stopped: true };
  const before = await headSha(base.worktree);
  const changed = await changedFiles(base.worktree);
  // A record the round closed is answered: the tree says so, and the seat is
  // told to list such a record in neither report list (ADR-0078). The read is
  // taken before the commit, over the set the round was dispatched on, and
  // every record of that set stood active when the round opened.
  const closed = new Set(activeOf(base.worktree, records).skipped.map((entry) => entry.record));
  const wrote = writtenOf(records, outcome.report, closed);
  const sha =
    changed.length > 0
      ? await commitAll(base.worktree, commitMessage(ctx, seat, wrote, since))
      : before;
  const entries = roundEntries(records, outcome.report, {
    seat,
    closed,
    attempts: attemptsOf(runEvents(ctx), seat, spawnedAt),
    ...(sha !== before && { sha }),
    ...(typeof outcome.cost === 'number' && { cost: outcome.cost }),
  });
  for (const entry of entries) stampWrite(ctx, entry);
  return { entries, reports: [outcome.report] };
}

/** The mark a record no answer of the round covers carries. */
const UNREPORTED = 'unreported';

/**
 * The records one round answers for: the ones the seat rewrote, the ones it
 * read and left alone with the reason, and the ones it closed.
 *
 * The three are the three legal answers. A record the round superseded is
 * listed in neither report list by rule, because its status line is a fact of
 * the tree and not a rewrite (ADR-0078).
 *
 * The dropped list counts with the rewritten one. `writeChecks` moves a rewrite
 * the tree does not hold onto it, and that is a note and never a refusal
 * (ADR-0080): the seat read the record and said so, and a round that read a
 * record and changed no line of it has answered for it.
 *
 * What is left is a record the report says nothing about. The seat held it and
 * did not answer, so the render carries it and the next round dispatches it by
 * name (ADR-0090).
 */
function writtenOf(records, report, closed = new Set()) {
  const named = new Set([
    ...(report.rewritten ?? []),
    ...(report.dropped ?? []),
    ...(report.unchanged ?? []).map((u) => u.record),
  ]);
  return records.filter((record) => named.has(record) || closed.has(record));
}

/**
 * One entry per record of the set: what the round did with it, or the word that
 * says it did nothing. The cost rides every entry of the round, because one
 * dispatch spent it over the whole set and no split of it would be a fact.
 */
function roundEntries(records, report, { seat, attempts, sha, cost, closed = new Set() }) {
  const named = new Set(writtenOf(records, report, closed));
  const dropped = report.dropped ?? [];
  return records.map((record) =>
    named.has(record)
      ? {
          record,
          seat,
          ...(typeof cost === 'number' && { cost }),
          attempts,
          ...(sha && { sha }),
          ...(dropped.includes(record) && { dropped: [record] }),
        }
      : {
          record,
          seat,
          failed: true,
          reason: UNREPORTED,
          ...(typeof cost === 'number' && { cost }),
          attempts,
          ...(dropped.includes(record) && { dropped: [record] }),
        },
  );
}

/**
 * One record's write, stamped right after the round's commit. One per record,
 * whatever the round dispatched: it is what a resume reads beside the commit
 * body, and it is what the centre and the close read (ADR-0080, ADR-0090).
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
 * The message one round signs its commit with: the run, the seat identity and
 * the ledger position the round opened at on the subject, and the records the
 * round wrote in the body, one path per line.
 *
 * The body carries the set because the subject is one line and a round writes
 * several records. It is what a resume reads to tell a write this round already
 * made from one it still owes, so the paths are the round's own answer and not
 * a list read from the tree (ADR-0090).
 */
function commitMessage(ctx, seat, records, since) {
  return [`reconcile: ${ctx.runId} ${seat} @${since}`, '', ...records].join('\n');
}

/**
 * The records this round has already committed a write for, read from the body
 * of its own commit.
 *
 * A commit whose body names no record answers for no record, and the round
 * dispatches its set again over the tree that commit left. That is the same
 * dispatch as the first, which is what a resume of a half-made write owes
 * (ADR-0070).
 */
async function roundCommits(base, runId, since) {
  const log = await git(['log', '--format=%s%n%b%x1e', '-n', '200'], {
    cwd: base.worktree,
  }).catch(() => '');
  const mark = `reconcile: ${runId} `;
  const tail = ` @${since}`;
  const records = new Set();
  for (const commit of log.split('\x1e')) {
    const lines = commit
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) continue;
    const [subject, ...body] = lines;
    if (!subject.startsWith(mark) || !subject.endsWith(tail)) continue;
    for (const path of body) records.add(path);
  }
  return records;
}

/**
 * The write this round already made, or null.
 *
 * Two facts say so and either one is enough. The `record-written` stamps of
 * this round are the whole record of a finished write, whether it wrote or
 * failed. The round's commit body is the other, and it covers the stop that
 * fell between the commit and the stamps: the tree holds the write, so the seat
 * is dispatched again never, and the stamps are written here from the body
 * (ADR-0070, ADR-0090).
 *
 * The two are merged rather than read in turn, because the stamps land one per
 * record and a stop can fall between any two of them. A record the stamps
 * answer for takes its stamp; every other record of the set takes the body.
 * @returns {Promise<{entries: object[], reports: object[]}|null>}
 */
async function writtenAlready(ctx, events, { seat, records, since, committed }) {
  const stamped = new Map();
  for (const e of events) {
    if (e.event !== 'record-written' || e.seat !== seat || e.seq <= since) continue;
    const { event: _event, seq: _seq, ts: _ts, actor: _actor, gist: _gist, ...entry } = e;
    stamped.set(e.record, entry);
  }
  if (stamped.size === 0 && committed.size === 0) return null;
  // A round that failed left no report, and a report file the run can no longer
  // read is the same fact. Either way the readers behind this get a report that
  // says the round answered nothing, because a resume that hands them a hole
  // reads it as one (ADR-0080). A round that committed and left no readable
  // report is answered by its own commit body, which names what it wrote.
  const held = readJson(lastSeatReportEvent(events, seat)?.path);
  const report =
    held ??
    (committed.size > 0
      ? { rewritten: [...committed], unchanged: [], answered: [] }
      : emptyReport());
  const attempts = attemptsOf(events, seat, since);
  const entries = [];
  for (const record of records) {
    const entry = stamped.get(record);
    if (entry) {
      entries.push(entry);
      continue;
    }
    const written = committed.has(record) || writtenOf([record], report).length > 0;
    const fresh = written
      ? { record, seat, attempts }
      : { record, seat, failed: true, reason: UNREPORTED, attempts };
    stampWrite(ctx, fresh);
    entries.push(fresh);
  }
  return { entries, reports: entries.some((e) => e.failed !== true) ? [report] : [] };
}

/**
 * The report of a dispatch that answered nothing. Every reader of a round's
 * reports takes an object, so a dispatch with no report of its own is read as
 * one that rewrote nothing and answered nothing (ADR-0080).
 */
function emptyReport() {
  return { rewritten: [], unchanged: [], answered: [] };
}

/**
 * The defects that ended the last write dispatch of this pass, or null.
 *
 * A round that spends its budget leaves the reason on its entries. The round
 * that dispatches again reads it there, so the seat starts from what refused
 * its predecessor rather than from nothing (ADR-0079). One seat writes the
 * whole set, so one list of defects ended it and every entry of that round
 * carries it (ADR-0090).
 */
function refusedDefects(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== 'reconciliation-written') continue;
    const entry = (e.records ?? []).find(
      (r) => r.failed === true && Array.isArray(r.defects) && r.defects.length > 0,
    );
    return entry ? entry.defects : null;
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
  const rewritten = [...new Set(reports.flatMap((r) => r.rewritten ?? []))];
  const unchanged = [...new Set(reports.flatMap((r) => (r.unchanged ?? []).map((u) => u.record)))];
  const dropped = [...new Set(reports.flatMap((r) => r.dropped ?? []))];
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
 * One seat reads the whole list, and the list is what the cycle's derivation
 * counts its per-record stamps against. A list the tree shrinks between two
 * entries of one cycle would leave the derivation waiting on a record no seat
 * was ever given (ADR-0078).
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
 * What one write did to a record's units, per record: `moved` is the ids whose
 * head text the write changed since the tree the last cycle judged, and `map`
 * carries every id the write kept, from the number the last cycle used to the
 * number this one uses.
 *
 * The review's brief names the moved ones, so a seat reads the sentences that
 * moved before it reads the rest (ADR-0073). The round reads the map, so a
 * finding a fresh seat raises on a sentence a prior finding already named is one
 * finding and not two: ids are positional and a write above a sentence renumbers
 * it (ADR-0080).
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
    out[record] = before === null ? { moved: [], map: new Map() } : matchUnits(before, after);
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
 * One corrective round: one writer over the records that owe an answer, briefed
 * with every open finding and every red layer, under the record cap.
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
  // The remarks this round hands over, rebuilt from the set it stamped. One
  // writer holds the whole set, so it holds every remark the set carries.
  const remarks = advisoryIndex(events);
  const remarksFor = (given) => {
    const held = new Set(given);
    return set.advisory
      .filter((entry) => held.has(entry.record))
      .flatMap((entry) => entry.ids)
      .map((id) => remarks.get(id))
      .filter(Boolean);
  };
  const outcome = await writeRound(ctx, roundBase(base, set), {
    records,
    since: rendered.seq,
    // A corrective invocation lists the ids it answered; the first write of a
    // run answers no finding and is asked for no such list.
    answered: true,
    buildRole: (given, brief) =>
      correctiveRole(
        base,
        { ...judged, records: given, neighbours: setNeighbours(base, given) },
        {
          findings: open.filter((f) => given.includes(f.file) || given.includes(f.file2)),
          advisory: remarksFor(given),
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
 * A round that dispatched every record spent most of its seats on records no
 * finding named. A seat over such a record reads the record, writes nothing, and
 * costs the round a dispatch (ADR-0079).
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
    causes: owed.map((record) => judge.causes.get(record)),
    reason: judge.reason ?? 'a repair round moved the code this reconciliation read',
    born: [],
    late: owed,
    recheck: true,
    gist: gist(`recheck owes: ${owed.join(', ')}`),
  });
  return null;
}

/**
 * The judge over the delta alone: does it implicate a record not already owed.
 *
 * A report whose causes do not answer for its records owes nothing. The recheck
 * then stamps `kept`, which is what it stamps for a judge that could not answer
 * at all: neither is a record this stage can name a ground for (ADR-0090).
 * @returns {Promise<{records: string[], causes: Map<string, string>, reason: string}>}
 */
async function recheckJudge(ctx, base, { delta, touched }) {
  const none = (reason) => ({ records: [], causes: new Map(), reason });
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
  if (!result.ok) return none('the recheck judge could not answer');
  if (!result.report.owed) return none(result.report.reason);
  const causes = judgeCauses(result.report);
  if (causes === null) return none(UNCAUSED_JUDGMENT);
  const records = result.report.records;
  return { records, causes: new Map(records.map((r, i) => [r, causes[i]])), reason: result.report.reason };
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
    ...OWED_CRITERION,
    'Judge only records this run has not already answered. Where the change',
    'implicates no further record, answer owed=false with the reason.',
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
  const wrote = new Set();
  const since = recordPassSeq(events);
  for (const e of events) {
    // The whole reading opens at the pass the judgment began. A fresh pass
    // writes its records again, so a drop or a failure a pass before this one
    // speaks about a record this pass never touched.
    if (e.seq <= since) continue;
    if (e.event === 'merge-round') {
      // A record the merge round dropped the run's own change to. The default
      // branch's version stands, so this run wrote nothing to it (ADR-0080).
      for (const record of e.recordsDropped ?? []) {
        wrote.delete(record);
        out.add(record);
      }
      continue;
    }
    if (e.event !== 'record-written') continue;
    // A dispatch that delivered nothing, and a dispatch whose report claimed a
    // rewrite the tree does not hold, are one fact here: this dispatch wrote
    // nothing. The record is unwritten only where no dispatch of the pass wrote
    // it, because a corrective dispatch that changes no line leaves what an
    // earlier dispatch wrote standing in the tree (ADR-0080).
    if (e.failed === true || (e.dropped ?? []).includes(e.record)) {
      if (!wrote.has(e.record)) out.add(e.record);
      continue;
    }
    wrote.add(e.record);
    out.delete(e.record);
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
 * environment, the Tier-1 layers the record diff selects, the range the record
 * scope opens at, and where this project's judge runs.
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
    // Where this project's judge runs. Every brief and every step of the stage
    // reads it from here, so no two of them can read one config two ways.
    reconcile: reconcileMode(config),
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
