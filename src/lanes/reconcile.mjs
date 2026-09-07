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
// Eight steps, each derived from the stage's own stamps since the last
// `fresh-pass` and never remembered: judge, write, spectrum, review, verify,
// render, correct, and done or stall. A restart at any boundary resumes that
// step. Two of the eight are cheap on a resume rather than skipped: the
// spectrum re-uses every `layer-result` this cycle stamped, and the review
// re-uses every finding id this cycle assigned, so the work a stop interrupted
// is the only work a restart buys again.
//
// A stall at the cap takes the fallback on its own and asks nobody. The story
// and repair lanes ship the code and ticket the records; the records lane has
// no code, so the run closes on the cap and the ticket names the run branch.
// `reconcile-stall` is loud: nothing stops, and somebody reads why.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reconcileTicketPath, runReportPath } from '../daemon/home.mjs';
import {
  OPERATOR,
  RECORD_CAP,
  WORK_PRODUCT_DEFECT,
  assertReconcileCause,
} from '../ledger/registry.mjs';
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
  writeChecks,
  writeRole,
} from './records.mjs';
import { RECONCILE_STAGE, recordBase, recordsCommitted } from './records-stage.mjs';
import {
  activeRecords,
  citingRecords,
  matchUnits,
  readText,
  recordFiles,
  recordId,
  recordNeighbours,
  recordUnits,
  statusOf,
  supersedesOf,
} from './units.mjs';
import { currentPass, findingIndex, passOpeningSha, repairStalled } from './verdict.mjs';
import {
  ACTOR,
  answeredPath,
  blocked,
  commandError,
  gist,
  lastRecoveryPark,
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
 * The answer that ships the certified tree and leaves the records owed. It is
 * offered at the write seat's failure park alone, and it takes the operator's
 * reason, because it ships work a check did not cover (ADR-0062). The word says
 * what happens rather than what stops: an option opening with "abandon" reads at
 * a console like the option that closes the run.
 */
export const SHIP_WITHOUT_RECORDS = 'ship-without-records';

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
    case 'verify':
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
 * `spectrum`, `review`, `verify` and `render` are the four halves of one cycle
 * over the newest record commit: the cycle is owed until it renders, and each
 * name says how much of it the ledger already holds. `correct` and `stall` are
 * the two answers to a red render, and `recheck` is what a repair round past a
 * green render owes (ADR-0075).
 *
 * `done` is every ending: nothing owed, a spent fallback, or a green render
 * with no repair behind it. The stage then hands the run to the update.
 * @param {object[]} events the run's ledger, in order
 * @param {{cap?: number}} [opts] the record cap, `gates.reconcileRounds`
 * @returns {'judge'|'write'|'spectrum'|'review'|'verify'|'render'|'correct'|
 *   'recheck'|'stall'|'done'}
 */
export function reconcileStep(events, { cap = DEFAULT_RECONCILE_ROUNDS } = {}) {
  const judged = judgment(events);
  if (!judged) return 'judge';
  if (judged.ok !== true || judged.owed !== true) return 'done';
  const written = sinceFreshPass(events, (e) => e.event === 'reconciliation-written');
  if (!written || written.seq < judged.seq) return 'write';
  // A fallback is the stage's last word: the records are owed, the run said so,
  // and nothing here writes them a second time.
  if (written.ok !== true) return 'done';
  const rendered = lastRendered(events);
  // A record re-run: the update stage merged a default branch whose incoming
  // work touched a record in this run's neighbourhood, so the reconciliation is
  // asked again against the merged tree (ADR-0075).
  const rerun = sinceFreshPass(
    events,
    (e) => e.event === 'pre-verdict-update' && e.records?.answer === 'rerun',
  );
  if (!rendered || rendered.seq < written.seq || (rerun && rerun.seq > rendered.seq)) {
    return cycleStepOf(events, written);
  }
  if (rendered.verdict === 'green') {
    return recheckOwed(events, rendered) ? 'recheck' : 'done';
  }
  const rounds = roundsSince(events, judged.seq);
  const renders = rendersSince(events, judged.seq);
  const stalled = repairStalled(events, renders, rendered, { round: 'reconcile-round' });
  return rounds >= cap || stalled ? 'stall' : 'correct';
}

/** How much of the cycle over the newest write the ledger already holds. */
function cycleStepOf(events, written) {
  const cycle = nextCycle(events);
  if (!events.some((e) => e.event === 'layer-result' && e.cycle === cycle)) return 'spectrum';
  const records = reviewedRecords(written);
  const stamped = new Set(
    events.filter((e) => e.event === 'record-units' && e.cycle === cycle).map((e) => e.record),
  );
  if (records.length === 0 || records.some((record) => !stamped.has(record))) return 'review';
  // The verifier is the boundary behind the review seats. A cycle whose seats
  // have reported and whose verifier has not answered resumes at the verifier,
  // and the round it re-enters re-uses every finding id it already assigned.
  const lastUnits = [...events]
    .reverse()
    .find((e) => e.event === 'record-units' && e.cycle === cycle);
  const verified = events.some(
    (e) => e.event === 'seat-report' && e.seat === 'fury-verifier' && e.seq > lastUnits.seq,
  );
  return verified ? 'render' : 'verify';
}

/**
 * The records a cycle reviews, from the write that earned it. It is the widest
 * of the two lists the write holds: the records it rewrote, and the records it
 * was given and left alone. A record the round did not change is still a record
 * the pass touched, and the review reads every one of them on every cycle
 * (ADR-0075).
 */
function reviewedRecords(written) {
  const entries = Array.isArray(written?.records) ? written.records.map((r) => r.record) : [];
  return [...new Set([...(written?.rewritten ?? []), ...entries])];
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
 * The stamp splits what it found. `born` are the records this run's own records
 * stage wrote before the freeze, and `late` are the rest: a decision the card or
 * the ticket stated is born, and a decision only the diff shows is late. The
 * share of the two is the reading of whether the birth seat is working
 * (ADR-0074).
 */
async function judgeStep(ctx, base) {
  try {
    // The default-branch ref the diff is taken against. Without the fetch it is
    // the branch as it stood when this run last met it, and the merge base
    // behind that ref counts work this run merged in as its own.
    await fetchClone(cloneDir(ctx.paths, ctx.project));
  } catch (error) {
    ctx.store.append('reconciliation-judged', {
      actor: ACTOR,
      ok: false,
      cause: `fetch: ${error.message}`,
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
    ctx.store.append('reconciliation-judged', { actor: ACTOR, ok: false, cause: 'seat-failure' });
    return null;
  }
  const { owed, records, reason } = result.report;
  if (!owed) {
    ctx.store.append('reconciliation-judged', { actor: ACTOR, ok: true, owed: false, reason });
    return null;
  }
  const bornPaths = new Set(recordsCommitted(runEvents(ctx))?.paths ?? []);
  ctx.store.append('reconciliation-judged', {
    actor: ACTOR,
    ok: true,
    owed: true,
    records,
    reason,
    born: records.filter((record) => bornPaths.has(record)),
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

// -- the write ---------------------------------------------------------------

/**
 * The judged records, written one seat at a time, in sequence, in the one run
 * worktree (ADR-0075).
 *
 * Each dispatch has its own seat identity, its own hard reset, its own commit
 * and its own checks, so a seat sees its own files and no peer's, and N writers
 * in one run keep N budgets, N cost lines and N failure records. The commit is
 * the durable half and the `record-units` stamp behind it is the recorded half:
 * a stop between the two re-dispatches that one record over its own commit,
 * which is the same dispatch again, and every record the ledger already answered
 * is stepped over.
 */
async function writeStep(ctx, base, next) {
  const judged = judgment(runEvents(ctx));
  const records = judged.records ?? [];
  const asked = lastRecoveryPark(runEvents(ctx));
  if (
    asked?.answer?.option === SHIP_WITHOUT_RECORDS &&
    asked.park.type === 'seat-failure' &&
    asked.park.detail?.seat?.startsWith(WRITE_SEAT)
  ) {
    return fallbackStep(ctx, base, { cause: OPERATOR, next });
  }
  // What a recheck asked this write for, where the write is a recheck's. The
  // units the repair's delta touched are the sentences to re-answer; every other
  // unit of the record keeps the answer it already has (ADR-0075).
  const recheck = sinceFreshPass(
    runEvents(ctx),
    (e) => e.event === 'reconcile-recheck' && e.seq < judged.seq,
  );
  const outcome = await writeRound(ctx, base, {
    records,
    since: judged.seq,
    buildRole: (record, brief) =>
      writeRole(
        base,
        { ...judged, records: [record], ...recordContext(base, record, records) },
        recheckBrief(recheck, record, brief),
      ),
  });
  if (outcome.fail) return outcome.fail;
  if (outcome.stopped) return null;
  if (outcome.fallback) return fallbackStep(ctx, base, { cause: outcome.fallback, next });
  await stampWritten(ctx, base, { entries: outcome.entries, reports: outcome.reports });
  return null;
}

/**
 * The units a recheck asks one record's writer to answer again, or the brief it
 * was given. A repair moved the evidence some claims rest on, and those claims
 * are the work; the rest of the record keeps what it already answered.
 */
function recheckBrief(recheck, record, brief) {
  const ids = (recheck?.units ?? [])
    .filter((unit) => unit.startsWith(`${record}#`))
    .map((unit) => unit.split('#')[1]);
  if (ids.length === 0) return brief;
  const lines = [
    'A repair round moved the code these units of this record rest on. Read the change and',
    'answer them again against the tree as it now stands:',
    ...ids.map((id) => `- ${id}`),
    'Every other unit keeps the answer it already has, and you report all of them.',
  ];
  return brief ? [lines.join('\n'), ...(Array.isArray(brief) ? brief : [brief])] : lines.join('\n');
}

/**
 * One pass of per-record writers. Returns the per-record ledger entries and the
 * reports behind them, or the directive the round could not get past.
 */
async function writeRound(
  ctx,
  base,
  { records, since, buildRole, findings = [], answered = false },
) {
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
    const done = writtenAlready(ctx, runEvents(ctx), { seat, record, since, committed, base });
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
    const siblings = siblingsOf(base, record, records);
    const spawnedAt = lastSeq(runEvents(ctx));
    const outcome = await seatWithChecks(ctx, {
      seat,
      schema: reconcileWriteSchema({ units: true, answered, siblings: siblings !== null }),
      cwd: base.worktree,
      env: base.env,
      constitution: base.constitution,
      styleFiles: base.styleFiles,
      buildRole: (brief) => buildRole(record, brief),
      checks: (report) =>
        writeChecks(base, [record], report, { seat: 'writer', findings, siblings }),
      park: {
        options: [SHIP_WITHOUT_RECORDS],
        reasoned: [SHIP_WITHOUT_RECORDS],
        note:
          `Answer "${SHIP_WITHOUT_RECORDS}" with your reason to ship the code this run ` +
          'already certified: the records stay owed, the close writes the ticket, and the ' +
          'sweep launches the rewrite as a repair run.',
      },
    });
    if (outcome.fail) {
      // A work-product defect past its corrective round is the seat's answer,
      // and it is not a question for a person: the ticket is the route the
      // harness took for every story before this stage existed. A seat that
      // never delivered a report at all is the other shape, and that one parks.
      const failure = seatFailureAfter(runEvents(ctx), seat, spawnedAt);
      if (Array.isArray(failure?.defects)) return { fallback: WORK_PRODUCT_DEFECT };
      return { fail: outcome.fail };
    }
    // A stop between the seat's report and its commit leaves the write for the
    // restart. The tree is one worktree and the daemon that comes back holds it,
    // so a commit from a stopped run would race the run's own resume.
    if (ctx.stopped()) return { stopped: true };
    const before = await headSha(base.worktree);
    const changed = await changedFiles(base.worktree);
    const sha =
      changed.length > 0 ? await commitAll(base.worktree, commitMessage(ctx, seat, since)) : before;
    const entry = {
      record,
      seat,
      ...(typeof outcome.cost === 'number' && { cost: outcome.cost }),
      attempts: attemptsOf(runEvents(ctx), seat, spawnedAt),
      unitsAnswered: (outcome.report.units ?? []).filter((u) => u.record === record).length,
      ...(sha !== before && { sha }),
    };
    stampUnits(ctx, base, { seat, record, report: outcome.report, cost: outcome.cost });
    entries.push(entry);
    reports.push(outcome.report);
  }
  return { entries, reports };
}

/**
 * The message one dispatch signs its commit with: the run, the seat identity
 * and the ledger position the round opened at. It is what a resume reads to
 * tell a write this round already made from one it still owes, and it is unique
 * per record per round.
 */
function commitMessage(ctx, seat, since) {
  return `reconcile: ${ctx.runId} ${seat} @${since}`;
}

/** The dispatch messages this round has already committed. */
async function roundCommits(base, runId, since) {
  const log = await git(['log', '--format=%s', '-n', '200'], { cwd: base.worktree }).catch(
    () => '',
  );
  const mark = `reconcile: ${runId} `;
  return new Set(
    log
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith(mark) && line.endsWith(`@${since}`)),
  );
}

/**
 * The write of one record this round already made, or null.
 *
 * Two facts say so and either one is enough. The `record-units` stamp is the
 * whole record of a finished dispatch. The commit alone is a stop that fell
 * between the commit and the stamp: the tree holds the write, so the dispatch
 * is never made again, and the answers are stamped from the report the seat
 * left behind (ADR-0070).
 */
function writtenAlready(ctx, events, { seat, record, since, committed, base }) {
  const stamp = [...events]
    .reverse()
    .find(
      (e) =>
        e.event === 'record-units' && e.seat === seat && e.record === record && e.seq > since,
    );
  const report = readJson(lastSeatReportEvent(events, seat)?.path);
  if (!stamp) {
    if (!committed.has(commitMessage(ctx, seat, since)) || !report) return null;
    stampUnits(ctx, base, { seat, record, report });
    return { entry: entryOf(events, { seat, record, since, report }), report };
  }
  return {
    entry: {
      record,
      seat,
      ...(typeof stamp.cost === 'number' && { cost: stamp.cost }),
      attempts: attemptsOf(events, seat, since),
      unitsAnswered: (stamp.units ?? []).length,
    },
    report: report ?? { rewritten: [record], unchanged: [], units: [], divergences: [] },
  };
}

/** One per-record entry, rebuilt from the report a stop left behind. */
function entryOf(events, { seat, record, since, report }) {
  return {
    record,
    seat,
    attempts: attemptsOf(events, seat, since),
    unitsAnswered: (report.units ?? []).filter((u) => u.record === record).length,
  };
}

/** What one write seat answered, unit by unit, with what the dispatch cost. */
function stampUnits(ctx, base, { seat, record, report, cost }) {
  const units = (report.units ?? [])
    .filter((u) => u.record === record)
    .map((u) => ({
      id: u.id,
      kind: u.kind,
      verdict: u.verdict,
      ...(u.evidence !== undefined && { evidence: u.evidence }),
    }));
  const neighbours = recordNeighbours(base.worktree, record, base.recordPaths);
  ctx.store.append('record-units', {
    actor: ACTOR,
    seat,
    record,
    units,
    counts: {
      claims: units.filter((u) => u.kind === 'claim').length,
      holds: units.filter((u) => u.verdict === 'holds').length,
      fails: units.filter((u) => u.verdict === 'fails').length,
      notBuilt: units.filter((u) => u.verdict === 'not-built').length,
    },
    neighbours: neighbours.neighbours.length,
    neighboursDropped: neighbours.dropped,
    ...(typeof cost === 'number' && { cost }),
  });
}

/** The neighbourhood and the siblings one record's writer is briefed with. */
function recordContext(base, record, scope) {
  const siblings = siblingsOf(base, record, scope);
  return {
    neighbours: recordNeighbours(base.worktree, record, base.recordPaths),
    ...(siblings && { siblings }),
  };
}

/**
 * The active records that cite this one, minus the records this run's own scope
 * holds. Null under the rewrite lifecycle, where no write supersedes anything
 * and the report owes no sibling answer.
 */
function siblingsOf(base, record, scope) {
  if (base.recordLifecycle !== 'supersede') return null;
  return citingRecords(base.worktree, record, base.recordPaths, { scope });
}

function attemptsOf(events, seat, since) {
  return events.filter((e) => e.event === 'seat-spawned' && e.seat === seat && e.seq > since)
    .length;
}

function lastSeq(events) {
  return events.length > 0 ? events[events.length - 1].seq : 0;
}

/**
 * The write's own stamp: one entry per record with the seat, the cost, the
 * attempts and the units it answered, the divergences it declared, the siblings
 * it answered for, and the shape of the record tree behind it.
 */
async function stampWritten(ctx, base, { entries, reports, corrective = null }) {
  const rewritten = [...new Set(reports.flatMap((r) => r.rewritten ?? []))];
  const unchanged = [...new Set(reports.flatMap((r) => (r.unchanged ?? []).map((u) => u.record)))];
  const divergences = reports.flatMap((r) => r.divergences ?? []);
  const siblings = reports.flatMap((r) => r.siblings ?? []);
  const tree = await treeShape(base);
  ctx.store.append('reconciliation-written', {
    actor: ACTOR,
    ok: true,
    ...(corrective && { corrective: true, answered: corrective }),
    records: entries,
    rewritten,
    unchanged,
    divergences,
    ...(siblings.length > 0 && { siblings }),
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
 * per-record review, the verifier behind it, and the render.
 *
 * Each half is restart-safe on its own terms. `runSpectrum` re-uses every
 * `layer-result` this cycle stamped; the review round re-uses every finding id
 * this cycle assigned. So a stop inside the cycle costs the step it interrupted
 * and never the steps in front of it.
 */
async function cycleStep(ctx, base) {
  const events = runEvents(ctx);
  const written = sinceFreshPass(events, (e) => e.event === 'reconciliation-written');
  const cycle = nextCycle(events);
  const sha = await headSha(base.worktree);
  const changed = reviewedRecords(written);
  const spectrum = await runRecordLayers(ctx, base, { cycle, sha, changed });
  if (spectrum.error) {
    return commandError(
      ctx,
      'gate-command',
      `A Tier-1 record layer could not run: ${spectrum.error}\nRepair the command, then answer.`,
    );
  }
  const reds = persistentReds(spectrum.results ?? []);
  const records = await stageScope(base, sha, changed);
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
    moved: await movedFor(base, records, priorRender),
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
  ];
  ctx.store.append('reconcile-rendered', {
    actor: ACTOR,
    cycle,
    sha,
    verdict: open.length === 0 ? 'green' : 'red',
    open,
    records,
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
 * The record set of this cycle: every record the pass has touched, on every
 * cycle, until the stage is green (ADR-0075). The range opens at the pass's own
 * opening sha, so a record an early round rewrote is read again by the round
 * that follows it.
 */
async function stageScope(base, sha, changed) {
  const scope = await recordScope(base.worktree, base.rangeFrom, sha, base.recordPaths, {
    lifecycle: base.recordLifecycle,
  }).catch(() => null);
  const files = scope ? scope.files : [];
  return files.length > 0 ? files : changed;
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
 * The comparison sha is the previous render's own, and the pass's opening sha on
 * the first cycle. Both are commits the run holds, so the read survives a
 * restart and needs no field of its own.
 */
async function movedFor(base, records, priorRender) {
  const from = priorRender?.sha ?? base.rangeFrom;
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
 * One corrective round: a writer per record, briefed with the findings a review
 * raised and a verifier confirmed against the tree, under the record cap.
 *
 * It stamps `reconcile-round` and never `repair-round`. The two caps never read
 * each other's rounds, and nothing here reaches the verdict: a corrective record
 * round changes no code and buys no code cycle (ADR-0075).
 */
async function correctStep(ctx, base, next) {
  const events = runEvents(ctx);
  const judged = judgment(events);
  const rendered = lastRendered(events);
  const written = sinceFreshPass(events, (e) => e.event === 'reconciliation-written');
  const index = findingIndex(events);
  const open = (rendered?.open ?? []).map((id) => index.get(id)).filter(Boolean);
  const layers = (rendered?.open ?? []).filter((id) => !index.has(id));
  const records = reviewedRecords(written);
  const round = roundsSince(events, judged.seq) + 1;
  const divergences = Array.isArray(written?.divergences) ? written.divergences : [];
  const outcome = await writeRound(ctx, base, {
    records,
    since: rendered.seq,
    findings: open,
    // A corrective invocation lists the ids it answered; the first write of a
    // run answers no finding and is asked for no such list.
    answered: true,
    buildRole: (record, brief) =>
      correctiveRole(
        base,
        { ...judged, records: [record], ...recordContext(base, record, records) },
        {
          findings: open.filter((f) => f.file === record || f.file2 === record),
          divergences: divergences.filter((d) => d.record === record),
          brief: layerBrief(layers, brief),
        },
      ),
  });
  if (outcome.fail) return outcome.fail;
  if (outcome.stopped) return null;
  if (outcome.fallback) return fallbackStep(ctx, base, { cause: outcome.fallback, next });
  await stampWritten(ctx, base, {
    entries: outcome.entries,
    reports: outcome.reports,
    corrective: open.map((f) => f.id),
  });
  ctx.store.append('reconcile-round', {
    actor: ACTOR,
    round,
    records,
    findings: rendered.open ?? [],
  });
  return null;
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
 * The recheck a repair owes a green reconciliation, scoped to the repair's own
 * delta.
 *
 * Every `claim` unit carries the evidence path that answered it, so the units
 * the delta could have moved are the units whose evidence the delta touched. A
 * unit the delta did not touch keeps its answer. The judge reads the delta alone
 * and says whether it implicates a record not already owed; a delta that touches
 * no evidence path and implicates no record stamps `kept` and costs one seat.
 */
async function recheckStep(ctx, base) {
  const events = runEvents(ctx);
  const rendered = lastRendered(events);
  const repaired = [...events]
    .reverse()
    .find((e) => e.event === 'repair-round' && e.seq > rendered.seq);
  const impl = [...events]
    .reverse()
    .find((e) => e.event === 'implementation-committed' && e.seq > rendered.seq);
  const delta = impl?.baseSha && impl?.sha ? { from: impl.baseSha, to: impl.sha } : null;
  const touched = delta
    ? await changedInRange(base.worktree, delta.from, delta.to).catch(() => [])
    : [];
  const units = touchedUnits(events, touched);
  const judge = await recheckJudge(ctx, base, { delta, touched });
  if (judge.fail) return judge.fail;
  const owed = (judge.records ?? []).filter((record) => !(rendered.records ?? []).includes(record));
  const stamp = {
    actor: ACTOR,
    delta: delta ? `${delta.from}..${delta.to}` : null,
    units: units.map((u) => `${u.record}#${u.id}`),
    judge: judge.reason ?? 'no judgment',
  };
  if (units.length === 0 && owed.length === 0) {
    // The recheck that found nothing is stamped too: it is the evidence that the
    // intersection rule is not too narrow, and the yield reads every other word
    // as work the recheck did (ADR-0075).
    ctx.store.append('reconcile-recheck', { ...stamp, result: 'kept' });
    return null;
  }
  ctx.store.append('reconcile-recheck', {
    ...stamp,
    records: [...new Set([...units.map((u) => u.record), ...owed])],
    result: owed.length > 0 ? 'owed' : 're-answered',
  });
  // A record the judge names anew is a full reconciliation of that record; a
  // unit the delta touched is re-answered and re-reviewed under the same cycle
  // the stage runs for every write.
  ctx.store.append('reconciliation-judged', {
    actor: ACTOR,
    ok: true,
    owed: true,
    records: [...new Set([...units.map((u) => u.record), ...owed])],
    reason: judge.reason ?? 'a repair round moved the evidence this reconciliation read',
    born: [],
    late: owed,
    recheck: true,
    gist: gist(`recheck owes: ${[...new Set([...units.map((u) => u.record), ...owed])].join(', ')}`),
  });
  return null;
}

/** The units whose evidence path the delta touched, by record and id. */
function touchedUnits(events, touched) {
  const paths = new Set(touched);
  const out = [];
  const seen = new Set();
  for (const e of events) {
    if (e.event !== 'record-units') continue;
    for (const unit of e.units ?? []) {
      if (unit.kind !== 'claim' || typeof unit.evidence !== 'string') continue;
      const path = unit.evidence.split(':')[0].trim();
      if (!paths.has(path)) continue;
      const key = `${e.record}#${unit.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ record: e.record, id: unit.id });
    }
  }
  return out;
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

// -- the fallbacks -----------------------------------------------------------

/**
 * The stall at the cap: loud, and answered by the harness itself.
 *
 * Nobody is asked. The story and repair lanes ship the code the verdict already
 * certified and put the open findings on a ticket the close writes; the records
 * lane has no code, so the run closes on the cap and the ticket names the run
 * branch in place of a merge commit (ADR-0075).
 */
async function stallStep(ctx, base, next) {
  const events = runEvents(ctx);
  const judged = judgment(events);
  const rendered = lastRendered(events);
  const open = rendered?.open ?? [];
  ctx.store.append('reconcile-stall', {
    actor: ACTOR,
    rounds: roundsSince(events, judged.seq),
    open,
    gist: gist(`the record rounds are spent with ${open.length} open: ${open.join(', ')}`),
  });
  return fallbackStep(ctx, base, { cause: RECORD_CAP, residual: open, next });
}

/**
 * The fallback stamp, and the route behind it. The records ride the merge with
 * the open findings named, or the records lane closes on the cap.
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
  if (base.mode !== 'records') return { next };
  return closeOnCap(ctx, base, { cause, residual: findings, open: residual });
}

/**
 * The records lane's own ending at the cap. There is no code to ship and no
 * merge commit to name, so the ticket carries the run branch and the open
 * findings, and the run closes with the reason on its `run-closed` record.
 */
function closeOnCap(ctx, base, { cause, residual, open }) {
  const events = runEvents(ctx);
  const judged = judgment(events);
  const records = judged?.records ?? [];
  const index = findingIndex(events);
  const detail = residual.map((id) => index.get(id)).filter(Boolean);
  let ticket = null;
  try {
    ticket = reconcileTicketPath(ctx.paths, ctx.runId);
    writeFileSync(
      ticket,
      reconcileTicketFromBranch({
        ctx,
        base,
        records,
        reason: judged?.reason ?? '(none recorded)',
        residual: detail,
        open,
      }),
    );
  } catch (error) {
    return blocked(
      ctx,
      'stage-blocked',
      `The reconciliation ticket could not be written: ${error.message}\n` +
        'Repair the daemon home, then answer.',
    );
  }
  // The ticket before the stamp: a stamped ticket always exists to launch from,
  // and the stamp is what owns the loud stall (ADR-0024).
  ctx.store.append('reconciliation-judged', {
    actor: ACTOR,
    ok: true,
    owed: true,
    records,
    reason: judged?.reason ?? '(none recorded)',
    ticket,
    cause,
    ...(residual.length > 0 && { residual }),
    gist: gist(`reconciliation ticketed from the branch: ${records.join(', ')}`),
  });
  return { close: { state: 'failed', reason: 'reconcile-cap', ticket } };
}

/**
 * The reconciliation ticket a records-lane run writes at its cap. It names the
 * run branch and the open findings where the story lane's ticket names the pull
 * request and the merge commit: nothing merged, so the work stands on the branch
 * and the run that reads this ticket starts from there (ADR-0075).
 */
export function reconcileTicketFromBranch({ ctx, base, records, reason, residual = [], open = [] }) {
  const layers = open.filter((id) => !residual.some((f) => f.id === id));
  return [
    `# Reconciliation ticket: run ${ctx.runId}`,
    '',
    `The records-lane run ${ctx.runId} spent its record rounds with findings still open.`,
    'Nothing merged. The work stands on the run branch below, and this ticket is the spec',
    'of the run that finishes it.',
    '',
    '## Records to reconcile',
    '',
    ...records.map((r) => `- ${r}`),
    '',
    `Judged reason: ${reason}`,
    '',
    '## The branch',
    '',
    `- run branch: ${base.branch ?? '(none)'} (read it with git log)`,
    `- the run that wrote it: ${ctx.runId}`,
    ...(residual.length > 0
      ? ['', '## Findings to answer', '', ...residual.map((f) => `- ${findingLine(f)}`)]
      : []),
    ...(layers.length > 0
      ? ['', '## Red layers', '', ...layers.map((layer) => `- ${layer}`)]
      : []),
    '',
    '## Rules',
    '',
    '- Answer every finding above in the records, and every other unit of each',
    '  record is yours as well.',
    '- Parts the tree does not hold stay as explicit open sections.',
    '- Edit only the decision-record tree. No source, test, or config change',
    '  rides this run.',
    '',
  ].join('\n');
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
  const base = recordBase({
    config,
    worktree,
    mode,
    branch: ctx.payload.branch,
    defaultBranch: ctx.payload.defaultBranch ?? 'main',
    layers: config.gates.tier1 ?? [],
    commands: config.commands,
    recordLayers: config.gates?.recordLayers ?? [],
    testPaths: config.repo.testPaths ?? [],
    allowlistPaths: config.gates?.allowlistPaths ?? [],
    cap: config.gates?.reconcileRounds ?? DEFAULT_RECONCILE_ROUNDS,
    born: recordsCommitted(events)?.paths ?? [],
    specRef: cardPath ? join(ctx.paths.runs, ctx.runId, 'spec.md') : specPath(worktree, ticket),
    constitution: readConstitution(worktree, config),
    rangeFrom: rangeStart(ctx, events),
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
 * The sha the pass opened at, which is the start of every record range this
 * stage reads.
 *
 * The story and repair lanes open at the first implementation of the pass: that
 * commit's base is the tree before any of this run's work. The records lane
 * runs no dev seat, so it opens at the tree the run launched on, which is the
 * tree before its own records stage wrote a file.
 */
function rangeStart(ctx, events) {
  const lane =
    typeof ctx.payload.baseSha === 'string'
      ? ctx.payload.baseSha
      : (recordsCommitted(events)?.sha ?? null);
  return passOpeningSha(events, lane);
}
