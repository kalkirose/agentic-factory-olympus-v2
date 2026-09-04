// The eval review. Every five ships of any lane the daemon fires one eval
// seat: Fable 5.1 at high, instance-scoped — no worktree, no stack, seat
// events in the instance ledger. The seat reads the ledgers since the last
// review and reports proposals only; every change lands by PR or a
// map-level decision. Nothing self-executes: the scheduler stamps the
// report artifact and the queued `eval-review` event, and no code path
// parses a proposal into an action.
//
// Event-keyed: a run of any lane that closes shipped notifies the scheduler;
// daemon start notifies once, which fires a review owed from before a
// restart. A failed seat stamps seat-failure and leaves the trigger owed —
// the next matching event retries with a fresh session. Wall-clock never
// triggers.
//
// The window is every ship merged after the newest ship the last review
// named. It is derived from the run ids on the last `eval-review` stamp,
// never from a count: a repair that merged in the past enters the ship list
// beside the stories, and a count-based slice would push a story out for it.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '../ledger/ledger.mjs';
import { DEFECT_KINDS } from '../ledger/registry.mjs';
import { listShips } from '../telemetry/readers.mjs';
import { runSeat } from '../seats/runner.mjs';
import { superviseSeat } from '../engine/supervise.mjs';

const ACTOR = 'eval-scheduler';
const GIST_MAX = 120;

// Ships between reviews, any lane, counted across the whole instance.
export const EVAL_INTERVAL = 5;

// The proposal shapes are a closed set — a report that names anything else
// fails validation and burns the seat's one corrective re-prompt.
export const EVAL_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'proposals'],
  properties: {
    summary: { type: 'string', description: 'state of the window in one short paragraph' },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['shape', 'title', 'evidence', 'change'],
        properties: {
          shape: {
            type: 'string',
            enum: [
              'cut-candidate',
              'new-tripwire',
              'band-change',
              'vocabulary-promotion',
              'duration-drift',
            ],
          },
          title: { type: 'string' },
          evidence: { type: 'string', description: 'ledger references that back the proposal' },
          change: { type: 'string', description: 'the change a human lands by PR or map decision' },
          project: { type: 'string' },
        },
      },
    },
  },
};

/** @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths */
export function evalReportPath(paths, review) {
  return join(paths.evalReports, `review-${review}.json`);
}

/** The last `eval-review` stamp, or null before the first review. */
export function lastEvalReview(paths) {
  const reviews = readEvents(paths.instanceLedger).filter((e) => e.event === 'eval-review');
  return reviews.length > 0 ? reviews[reviews.length - 1] : null;
}

export class EvalScheduler {
  /**
   * @param {{paths: object, ledger: import('../telemetry/stores.mjs').TelemetryStore,
   *   semaphores?: import('../seats/semaphore.mjs').ModelSemaphores,
   *   seatDefaults?: () => object}} opts
   *   ledger: the instance store — seat events and the review stamp to it.
   *   seatDefaults: machine-scoped runSeat options, read fresh per dispatch.
   */
  constructor({ paths, ledger, semaphores, seatDefaults }) {
    this.paths = paths;
    this.ledger = ledger;
    this.semaphores = semaphores ?? null;
    this.seatDefaults = seatDefaults ?? (() => ({}));
    this.seats = new Set();
    this.chain = Promise.resolve();
    this.stopped = false;
  }

  /**
   * The event key: a ship close of any lane, or daemon start. Checks chain,
   * so a ship that lands while a review runs re-checks after it completes —
   * an accumulated backlog fires the next review without a new event.
   */
  notify() {
    if (this.stopped) return;
    const next = this.chain.then(() => this.check()).catch(() => {});
    this.chain = next;
    return next;
  }

  /** Terminates an in-flight eval seat and drains the chain. */
  async stop() {
    this.stopped = true;
    for (const seat of this.seats) seat.terminate('daemon-stopped');
    await this.chain;
  }

  async check() {
    if (this.stopped) return;
    const ships = listShips(this.paths);
    const last = lastEvalReview(this.paths);
    const window = evalWindow(ships, last);
    if (window.length < EVAL_INTERVAL) return;
    const review = (last?.review ?? 0) + 1;
    const reportPath = evalReportPath(this.paths, review);
    // A failed attempt can leave a stale file; it must never validate as a
    // fresh report.
    rmSync(reportPath, { force: true });
    const result = await runSeat(this.ledger, {
      ...this.seatDefaults(),
      semaphores: this.semaphores ?? undefined,
      seat: 'eval',
      roleBlock: roleBlock({ review, window, last, paths: this.paths }),
      reportPath,
      schema: EVAL_REPORT_SCHEMA,
      cwd: this.paths.home,
      supervise: (opts) => {
        const seat = superviseSeat(this.ledger, opts);
        this.seats.add(seat);
        if (this.stopped) seat.terminate('daemon-stopped');
        return seat.done.finally(() => {
          this.seats.delete(seat);
        });
      },
    });
    // A failed seat already stamped seat-failure; the trigger stays owed.
    if (!result.ok) return;
    const proposals = result.report.proposals.length;
    const lanes = lanesOf(window);
    this.ledger.append('eval-review', {
      actor: ACTOR,
      review,
      // The total at dispatch. Information for a reader; the next window is
      // derived from `ships`, never from this number.
      shipCount: ships.length,
      ships: window.map((s) => s.runId),
      lanes,
      report: reportPath,
      proposals,
      ...(typeof result.model === 'string' && { model: result.model }),
      gist: gist(
        `eval review ${review}: ${window.length} ships ` +
          `(${lanes.story} story, ${lanes.repair} repair), ${proposals} proposals`,
      ),
    });
  }
}

/**
 * The ships a review owes: every ship merged after the newest ship the last
 * review named, in ship order. With no last review, every ship. The boundary
 * is resolved from the run ids the stamp holds to their merge time, so an
 * old stamp needs no new field, and a ship the last review named is never
 * reviewed twice even when it shares a merge time with the boundary.
 * @param {ReturnType<typeof listShips>} ships in ship order
 * @param {object|null} last the last `eval-review` stamp
 */
export function evalWindow(ships, last) {
  const named = new Set(Array.isArray(last?.ships) ? last.ships : []);
  let boundary = null;
  for (const ship of ships) {
    if (named.has(ship.runId) && (boundary === null || ship.ts > boundary)) boundary = ship.ts;
  }
  if (boundary === null) return ships;
  return ships.filter((s) => s.ts >= boundary && !named.has(s.runId));
}

/** Ships per lane over a window. Story and repair always appear, zero-filled. */
function lanesOf(window) {
  const lanes = { story: 0, repair: 0 };
  for (const ship of window) lanes[ship.lane] = (lanes[ship.lane] ?? 0) + 1;
  return lanes;
}

function roleBlock({ review, window, last, paths }) {
  const prior = last
    ? `The prior eval report is at ${last.report}; compare against it for drift.`
    : 'This is the first review; no prior report exists.';
  return [
    `You are eval review ${review} over the harness ledgers.`,
    `The window: ${window.length} ships since the last review, every lane:`,
    ...window.map((s) => `- ${s.runId} (${s.project}, ${s.lane}${repairNote(s)}, merged ${s.ts})`),
    'The rule: a story run has a card; a repair run has a ticket; a repair',
    'with an escape is a fix of a defect the harness already counted, and a',
    'maintenance repair is a ticket launched with no escape behind it.',
    'Judge the repairs on their own line: the drift between the ticket and',
    'the diff, the rounds spent, and whether a maintenance repair should have',
    'been a story.',
    'Read these stores as read-only evidence:',
    `- instance ledger: ${paths.instanceLedger}`,
    `- escapes ledger: ${paths.escapesLedger}`,
    `- run ledgers: <run id>/ledger.jsonl under ${paths.runs} and ${paths.archivedRuns}`,
    `- stream indexes: ${paths.queuedStream} and ${paths.loudStream}`,
    prior,
    'Judge the window: gate and lens yield, escapes with their categories and',
    'detection sources, repair rounds and stalls, durations against earlier',
    'runs, and free-text notes that recur in vocabulary fields.',
    'A `stall` carries one of four reasons: `no-progress` (a repair round that',
    'closed none of the open findings), `re-freeze-no-progress`, `cap-exhausted`',
    'and, in the ship lane, `merge-conflict`. A fresh pass stands on one of them,',
    'or on the `second-stall` answer that granted an extra one, so a window whose',
    'passes come from one reason is a window naming the step that stops working.',
    'A finding about the shape of the implementation takes a repair round like',
    'any other finding and buys no pass of its own.',
    'A defect the harness recognizes in itself carries a closed `kind` on the',
    `record that met it: ${[...DEFECT_KINDS].join(', ')}. Count a recurrence of`,
    'one of those by kind, never by wording, and read a class that still',
    'recurs after its fix off that count.',
    'Count the `supersede-authorized` stamps of every run in the window. Each',
    'one is a frozen test a run amended on its card\'s authority with no human',
    'asked, so a run far above the rest of the window, or a window whose count',
    'keeps climbing, is a classifier stretching scope rather than a set of cards',
    'that got broader. Cite the runs and the tests.',
    'A run that waited stamps `waiting` and `waiting-ended` with a `kind`:',
    '`seat` (a provider killed a seat), `layer` (a red from outside the tree),',
    '`substrate` (an env finding that survived its fix), `external` (a declared',
    'service that was down). Read them as answers the harness gave itself: a',
    'ladder that ended green is a park nobody had to answer, and a ladder that',
    'ended in a park is a wait that was too short or a condition a wait cannot',
    'fix. Name both, with the runs and the kinds.',
    'Read a run length off `activeMs` on its `run-closed` stamp, never off the',
    'wall clock: `wallMs` beside it counts the hours the run sat parked on a',
    'human, inert under a violation, held at a stage boundary by an operator,',
    'or waiting on a provider or a host, and none of those is the harness',
    'working.',
    'Cite the wall only when the gap between the two is itself the finding.',
    'Report proposals only, each in one of these shapes:',
    '- cut-candidate: a gate, lens, or step with zero yield over the window.',
    '- new-tripwire: a metric that deserves standing coverage.',
    '- band-change: a tripwire threshold change backed by observed values.',
    '- vocabulary-promotion: a recurring free-text note worth a closed value.',
    '- duration-drift: a duration trend against earlier runs.',
    'Cite ledger evidence in every proposal. An empty proposal list is valid.',
    'You execute nothing; every change lands by PR or a map-level decision.',
  ].join('\n');
}

/** The repair qualifier on a ship line: the escape it fixes, or maintenance. */
function repairNote(ship) {
  if (ship.lane !== 'repair') return '';
  return Number.isInteger(ship.escapeSeq) ? `, escape #${ship.escapeSeq}` : ', maintenance';
}

function gist(text) {
  return text.length > GIST_MAX ? text.slice(0, GIST_MAX - 1) + '…' : text;
}
