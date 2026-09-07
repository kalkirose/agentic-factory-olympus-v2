// The command-center snapshot: one derived view over the stores, assembled
// by the same pull-only readers the console uses. The center's server sends
// it as JSON; the page renders it. Display only — detection stays with the
// event-keyed watchers, and every number re-derives from the files on each
// build. Clone-backed sections (tripwire registry, frontier) read the bare
// clone without a fetch and degrade to null when no clone exists yet.
import { existsSync } from 'node:fs';
import { readEvents } from '../ledger/ledger.mjs';
import { LOUD_EVENTS, SEAT_TERMINAL_EVENTS } from '../ledger/registry.mjs';
import { runCost } from '../ledger/cost.mjs';
import { runDuration } from '../ledger/durations.mjs';
import { deriveRunState } from '../engine/replay.mjs';
import { readLock, pidAlive } from '../daemon/lock.mjs';
import { openLoud, listRunEvents, storyRunsByKey } from '../telemetry/readers.mjs';
import { escalationQueue, openCardParks } from '../telemetry/queue.mjs';
import { readEscapeSet, escapesWindow } from '../telemetry/escapes.mjs';
import { harnessPinTs, recordRenders } from '../ledger/cycles.mjs';
import {
  furyYieldBaseline,
  recordCyclesReading,
  recordWriteTimeReading,
  BASELINE_WINDOW,
} from '../tripwires/metrics.mjs';
import {
  armedTripwires,
  withTripwireDefaults,
  TRIPWIRE_METRICS,
} from '../tripwires/registry.mjs';
import { readInstanceConfig, armingState } from '../console/status.mjs';
import { holdState, projectHeld } from '../daemon/hold.mjs';
import { CRASH_RETRIES } from '../seats/runner.mjs';
import { computeFrontier, roadmapPositions } from '../frontier/graph.mjs';
import { readGraphSource } from '../frontier/source.mjs';
import { cloneDir, readBlobFromBranch } from '../isolation/clones.mjs';
import { parseProjectConfig } from '../config/project.mjs';
import { PRE_FREEZE_STAGES } from '../lanes/story.mjs';
import { RECORDS_LANE_STAGES } from '../lanes/records-stage.mjs';

// The design-given target for one shipped story, in hours of active time —
// the run's own hours, with the waiting on a human taken out (ADR-0036). The
// value is a map-level decision and this line is where it changes.
export const TARGET_HOURS = 4;

// Stage lists per lane, for the pipeline display. They mirror the lane
// composition (storyLane → postFreeze → shipStep; repairLane → shipStep;
// recordsLane → shipStep). A run on an unknown lane falls back to its observed
// stages.
export const LANE_STAGES = {
  story: [
    ...PRE_FREEZE_STAGES,
    'implementation',
    'verdict',
    'reconcile',
    'update',
    'ship',
    'close-out',
  ],
  repair: ['fix', 'verdict', 'reconcile', 'update', 'ship', 'close-out'],
  // The records lane: a record-only ticket is the whole work, so there is no
  // fix seat, no suite and no code verdict (ADR-0074).
  records: [...RECORDS_LANE_STAGES, 'reconcile', 'update', 'ship', 'close-out'],
};

const ENVELOPE_KEYS = new Set(['seq', 'ts', 'event', 'actor', 'stream', 'refs']);
const DETAIL_MAX = 140;
const TAIL_LINES = 40;
const SHIPS_WINDOW = 10;

/**
 * Builds the full snapshot. Every section answers from the files alone.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {{now?: Date}} [opts] `now` feeds elapsed-time display only.
 */
export async function buildSnapshot(paths, { now = new Date() } = {}) {
  const config = readInstanceConfig(paths);
  const lock = readLock(paths.lock);
  const running = lock !== null && pidAlive(lock.pid);
  const armed = armingState(paths);
  const allRuns = listRunEvents(paths);
  const open = allRuns
    .filter((r) => !r.archived && !r.events.some((e) => e.event === 'run-closed'))
    .map((r) => openRunView(r, now));
  const loud = openLoud(paths).map((item) => ({
    ...item,
    openMinutes: minutesBetween(item.ts, now),
  }));

  const projects = projectNames(config, allRuns);
  const sources = new Map();
  for (const name of projects) {
    sources.set(name, await readProjectSource(paths, name, config?.projects?.[name]));
  }
  const roadmap = mergedRoadmap(paths, sources);
  const queue = escalationQueue(paths, { roadmap }).map((item) => ({
    ...item,
    waitingMinutes: minutesBetween(item.ts, now),
  }));

  const ships = shipList(allRuns);
  const instanceEvents = readEvents(paths.instanceLedger);
  const holds = holdState(instanceEvents);
  const escapes = readEscapeSet(paths.escapesLedger);

  return {
    generatedAt: now.toISOString(),
    home: paths.home,
    instanceSeq: instanceEvents.at(-1)?.seq ?? 0,
    daemon: { running, ...(running && { pid: lock.pid }) },
    projects: projects.map((name) => projectView(name, config, armed, holds, open)),
    semaphores: semaphoreView(config, open, instanceEvents),
    loud,
    runs: open,
    queue,
    answeredToday: answeredToday(instanceEvents, allRuns, now),
    health: {
      openEscapes: escapes.filter((e) => !e.fixed).length,
      gateIntegrityOpen: loud.filter((item) => item.event === 'gate-integrity').length,
      byProject: projects.map((name) =>
        projectHealth(paths, name, ships, escapes, instanceEvents, sources.get(name)),
      ),
    },
    stats: statsView(allRuns, ships, harnessPinTs(instanceEvents)),
    tail: tailView(paths, allRuns),
  };
}

// -- runs ---------------------------------------------------------------------

function openRunView({ runId, project, lane, events }, now) {
  const state = deriveRunState(events);
  const launch = events.find((e) => e.event === 'run-launched');
  const seats = [];
  const inFlight = new Map();
  for (const e of events) {
    if (e.event === 'seat-spawned') {
      inFlight.set(e.seat, {
        seat: e.seat,
        model: e.model,
        effort: e.effort,
        // A crash retry re-spawns the same seat, so the chip would otherwise
        // show a seat that vanished and came back with nothing said. The
        // ordinal names how much of the machine allowance is spent, and the
        // shape says whether the retry resumed the dropped session.
        ...(typeof e.retry === 'number' && {
          retry: e.retry,
          retryMax: CRASH_RETRIES,
          resumed: e.resumed === true,
        }),
      });
    } else if (SEAT_TERMINAL_EVENTS.has(e.event)) {
      inFlight.delete(e.seat);
    }
  }
  seats.push(...inFlight.values());
  const repair = events.filter((e) => e.event === 'repair-round').at(-1) ?? null;
  const last = events.at(-1);
  const stages = LANE_STAGES[lane] ?? observedStages(events);
  const park = state.parked ? events.find((e) => e.seq === state.parkSeq) : null;
  return {
    runId,
    project,
    lane,
    storyKey: state.payload.storyKey ?? null,
    card: state.payload.card ?? null,
    stage: state.stage,
    stages,
    parked: state.parked,
    ...(park && { parkType: park.type, parkedMinutes: minutesBetween(park.ts, now) }),
    // A run standing at a boundary under an operator hold. Without it the page
    // shows a run at a stage with no seat and nothing moving, which is what a
    // dead run looks like (ADR-0040).
    held: state.held,
    ...(state.held && { heldNext: state.deferred }),
    violated: state.violated,
    elapsedMinutes: minutesBetween(launch.ts, now),
    cost: runCost(events),
    ...(typeof state.payload.budget === 'number' && { budget: state.payload.budget }),
    seats,
    ...(repair && { repair: { pass: repair.pass, round: repair.round } }),
    lastEvent: { seq: last.seq, ts: last.ts, event: last.event, detail: detailOf(last) },
  };
}

function observedStages(events) {
  const stages = [];
  for (const e of events) {
    if (e.event === 'stage-entered' && !stages.includes(e.stage)) stages.push(e.stage);
  }
  return stages;
}

// -- header chips -------------------------------------------------------------

function projectNames(config, allRuns) {
  const names = new Set(Object.keys(config?.projects ?? {}));
  for (const r of allRuns) if (r.project) names.add(r.project);
  return [...names].sort();
}

function projectView(name, config, armed, holds, open) {
  const entry = config?.projects?.[name];
  return {
    name,
    armed: armed.get(name) === true,
    held: projectHeld(holds, name),
    slotCap: entry?.slotCap ?? null,
    // A parked run frees its slot; a violated run and a held run still hold one.
    slotsBusy: open.filter((r) => r.project === name && !r.parked).length,
  };
}

function semaphoreView(config, open, instanceEvents) {
  const inFlight = new Map();
  // Instance-scoped seats (the eval seat) hold semaphores too.
  const held = new Map();
  for (const e of instanceEvents) {
    if (e.event === 'seat-spawned') held.set(e.seat, e.model);
    else if (SEAT_TERMINAL_EVENTS.has(e.event)) held.delete(e.seat);
  }
  for (const model of held.values()) {
    inFlight.set(model, (inFlight.get(model) ?? 0) + 1);
  }
  // Open-run seat counts ride the run views (already derived there).
  for (const run of open) {
    for (const seat of run.seats) {
      inFlight.set(seat.model, (inFlight.get(seat.model) ?? 0) + 1);
    }
  }
  const models = new Set([...Object.keys(config?.semaphores ?? {}), ...inFlight.keys()]);
  return [...models].sort().map((model) => ({
    model,
    max: config?.semaphores?.[model] ?? null,
    inFlight: inFlight.get(model) ?? 0,
  }));
}

// -- escalations --------------------------------------------------------------

function mergedRoadmap(paths, sources) {
  const roadmap = new Map();
  for (const [project, source] of sources) {
    if (!source?.graph) continue;
    const frontier = computeFrontier({
      cards: source.graph.cards,
      phases: source.graph.config.graph.phases,
      runs: new Map(),
      // This project's parks and no other project's. A card path is a
      // project's own word, and a shared set blocks a card here for a decision
      // left open in another repository.
      parkedCards: new Set(
        openCardParks(paths, { project }).map((p) => p.card).filter(Boolean),
      ),
    });
    for (const [key, position] of roadmapPositions(frontier)) {
      if (!roadmap.has(key)) roadmap.set(key, position);
    }
  }
  return roadmap.size > 0 ? roadmap : undefined;
}

function answeredToday(instanceEvents, allRuns, now) {
  const day = now.toISOString().slice(0, 10);
  let count = instanceEvents.filter(
    (e) => e.event === 'answer' && e.ts.slice(0, 10) === day,
  ).length;
  for (const { events } of allRuns) {
    count += events.filter((e) => e.event === 'answer' && e.ts.slice(0, 10) === day).length;
  }
  return count;
}

// -- build health -------------------------------------------------------------

function projectHealth(paths, project, ships, escapes, instanceEvents, source) {
  const projectShips = ships.filter((s) => s.project === project);
  // The ships are this project's and the escapes have to be too. The escapes
  // ledger is instance-scoped, so an unfiltered count reads a second project's
  // defects as this project's quality bar and shows this project in breach for
  // work in another repository. The instance-wide count is the tile above.
  const projectEscapes = escapes.filter((e) => e.refs?.project === project);
  const registry = source?.config ? armedTripwires(source.config).map(withTripwireDefaults) : null;
  const ceiling =
    registry?.find((t) => t.metric === 'escapes-window')?.breach?.value ?? 0.5;
  const window = escapesWindow({
    ships: projectShips,
    escapes: projectEscapes,
    windowSize: SHIPS_WINDOW,
    ceiling,
  });
  return {
    project,
    escapes: {
      rate: window.rate,
      counted: window.counted,
      ships: window.ships,
      ceiling: window.ceiling,
      breach: window.breach,
    },
    killRate: lastFreezeKillRate(paths, project),
    fury: { window: BASELINE_WINDOW, ...furyYieldBaseline(paths, project) },
    tripwires: tripwireBoard(instanceEvents, project, registry),
    frontier: frontierView(paths, project, source),
  };
}

function lastFreezeKillRate(paths, project) {
  let last = null;
  for (const { events } of listRunEvents(paths, { project, lane: 'story' })) {
    for (const f of events.filter((e) => e.event === 'freeze')) {
      if (last === null || f.ts > last.ts) {
        const waves = events.filter(
          (e) => e.event === 'adversary-wave' && e.phase === 'initial',
        ).length;
        last = { ts: f.ts, kills: f.killCount, waves, dispositions: f.dispositions };
      }
    }
  }
  return last;
}

function tripwireBoard(instanceEvents, project, registry) {
  const resolved = new Set(
    instanceEvents.filter((e) => e.event === 'resolved').map((e) => e.resolves),
  );
  const openBreach = new Map();
  for (const e of instanceEvents) {
    if (e.event === 'tripwire-breach' && e.project === project && !resolved.has(e.seq)) {
      openBreach.set(e.tripwire, e);
    }
  }
  const wires = (registry ?? []).map((entry) => ({
    id: entry.id,
    metric: entry.metric,
    breach: entry.breach,
    state: openBreach.has(entry.id) ? 'breach' : 'armed',
    ...(openBreach.has(entry.id) && { value: openBreach.get(entry.id).value }),
  }));
  // An open breach on a wire the registry no longer names still shows.
  for (const [id, e] of openBreach) {
    if (!wires.some((w) => w.id === id)) {
      wires.push({ id, metric: e.metric, breach: e.breach, state: 'breach', value: e.value });
    }
  }
  return { registryRead: registry !== null, wires };
}

function frontierView(paths, project, source) {
  if (!source?.graph) return null;
  const frontier = computeFrontier({
    cards: source.graph.cards,
    phases: source.graph.config.graph.phases,
    runs: storyRunsByKey(paths, { project }),
    parkedCards: new Set(
      openCardParks(paths, { project }).map((p) => p.card).filter(Boolean),
    ),
  });
  return {
    width: frontier.width,
    unfinished: frontier.unfinished,
    launchable: frontier.launchable.length,
  };
}

/**
 * Reads a project's config (always) and its graph source (when a graph
 * section exists) from the bare clone without fetching — the center reads,
 * never advances, the clone. No clone yet → null.
 */
async function readProjectSource(paths, project, entry) {
  if (!entry) return null;
  const dir = cloneDir(paths, project);
  if (!existsSync(dir)) return null;
  try {
    const { text } = await readBlobFromBranch(dir, entry.defaultBranch, entry.projectConfigPath);
    const config = parseProjectConfig(text, `${entry.defaultBranch}:${entry.projectConfigPath}`);
    let graph = null;
    if (config.graph) {
      graph = await readGraphSource(paths, project, entry, { fetch: false });
    }
    return { config, graph };
  } catch {
    return null;
  }
}

// -- run-time statistics ------------------------------------------------------

// `hours` is the ship's active time and it is what the target, the chart and
// the medians key on; `wallHours` is the same stretch on the clock on the
// wall. A ship reads as slow because the harness was slow, never because a
// human took a night to answer a park (ADR-0036).
function shipList(allRuns) {
  const ships = [];
  for (const { runId, project, events } of allRuns.filter((r) => r.lane === 'story')) {
    const merged = events.find((e) => e.event === 'merged');
    if (!merged) continue;
    const launch = events.find((e) => e.event === 'run-launched');
    const prOpened = events.find((e) => e.event === 'pr-opened');
    // The reading stops at the merge, as it always did: the close-out stage
    // runs behind it and is not the story's time to ship.
    const duration = runDuration(events, { end: merged.ts });
    if (duration === null) continue;
    ships.push({
      runId,
      project,
      storyKey: launch.storyKey ?? null,
      ts: merged.ts,
      hours: round(duration.activeMs / 3_600_000),
      wallHours: round(duration.wallMs / 3_600_000),
      cost: runCost(events),
      ...(prOpened && {
        shipMinutes: round((Date.parse(merged.ts) - Date.parse(prOpened.ts)) / 60_000),
      }),
    });
  }
  return ships.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

function statsView(allRuns, ships, pinTs) {
  const last = ships.slice(-SHIPS_WINDOW);
  const prior = ships.slice(-2 * SHIPS_WINDOW, -SHIPS_WINDOW);
  const shipMinutes = last.map((s) => s.shipMinutes).filter((m) => m !== undefined);
  return {
    targetHours: TARGET_HOURS,
    ships: last,
    medianHours: last.length > 0 ? round(median(last.map((s) => s.hours))) : null,
    medianWallHours: last.length > 0 ? round(median(last.map((s) => s.wallHours))) : null,
    medianCost: last.length > 0 ? round(median(last.map((s) => s.cost))) : null,
    priorMedianHours: prior.length > 0 ? round(median(prior.map((s) => s.hours))) : null,
    greenShipP50Minutes: shipMinutes.length > 0 ? round(median(shipMinutes)) : null,
    ciCriticalPathP50Minutes: ciCriticalPath(allRuns),
    stageMedians: stageMedians(allRuns, last),
    records: recordsView(allRuns, pinTs),
  };
}

// -- the record tree ----------------------------------------------------------
//
// The eight measures of the record stage, derived here because nothing else
// derives them: the eval seat reads ledgers and reports proposals, the
// close-out seat writes the story's own lesson, and a measure that lives in
// neither is a measure somebody re-derives by hand every time (ADR-0075).
//
// One window for all eight: the last runs that hold a record stamp of any kind.
// A run that touched no record says nothing about the stage, and a window of
// them would read a quiet quarter as a healthy one.

const RECORDS_WINDOW = 10;

// A run is in the record window when it holds one of these.
const RECORD_STAMPS = new Set([
  'records-committed',
  'record-units',
  'reconcile-round',
  'reconcile-rendered',
  'reconcile-recheck',
  'reconciliation-judged',
  'reconciliation-written',
]);

// The record seat that reviews. Every other record seat writes, and the miss
// rate is the writers' answers against the review's findings. A dispatch is
// one seat per record, so the stamped name carries a slot suffix (ADR-0075).
const RECORD_REVIEW_SEAT = 'record-review';

function recordsView(allRuns, pinTs) {
  const runs = allRuns
    .filter((r) => r.events.some((e) => RECORD_STAMPS.has(e.event)))
    .map((r) => ({ ...r, ts: r.events[0]?.ts ?? '' }))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    .slice(-RECORDS_WINDOW);
  // The two readings a band also judges are the band's own function, over the
  // window the band reads by default, so the tile and the breach cannot drift.
  // The runs are handed over, so neither opens a ledger of its own.
  const cycles = recordCyclesReading(null, null, {
    runs,
    window: TRIPWIRE_METRICS['record-cycles'].defaultWindow,
    pinTs,
  });
  const writeTime = recordWriteTimeReading(null, null, {
    runs,
    window: TRIPWIRE_METRICS['record-write-time'].defaultWindow,
  });
  return {
    runs: runs.length,
    // The number that says the change works: a reconciliation green inside two
    // cycles.
    cycles: {
      mean: cycles.value,
      reconciliations: cycles.detail.reconciliations,
      ...(cycles.detail.worst !== undefined && { worst: cycles.detail.worst }),
    },
    writerMiss: writerMissRate(runs),
    late: lateShare(runs),
    movedTree: movedTreeCost(runs),
    recheck: recheckYield(runs),
    gateMinutes: recordGateTime(runs, pinTs),
    writeMinutes: {
      mean: writeTime.value,
      writes: writeTime.detail.writes,
      ...(writeTime.detail.longest !== undefined && { longest: writeTime.detail.longest }),
    },
    tree: treeSeries(runs),
  };
}

/**
 * The writer's miss rate: the units a write seat reported `holds` that the
 * review then raised a finding on, over every unit a writer reported `holds`.
 *
 * It is the one reading that catches a seat which answered every unit without
 * reading it. The evidence check catches a fabricated path and the kind test
 * catches a claim filed as rationale; neither catches a lazy `holds`, and this
 * does, per unit (ADR-0073).
 *
 * The join is the record and the unit id. Both seats read one enumeration of
 * one file at one sha, so the ids are the same list; the head a finding carries
 * beside its id is what matches a finding across a write, which is a different
 * question.
 *
 * A unit no review ever answered is out of the denominator. The rate is the
 * share of the writer's `holds` a reader refuted. A hold nobody read reports
 * nothing about the writer. It would only make the rate look better
 * (ADR-0076).
 */
function writerMissRate(runs) {
  let holds = 0;
  let missed = 0;
  const records = new Set();
  for (const { runId, events } of runs) {
    const answers = new Map();
    const read = new Set();
    for (const e of events) {
      const key = (unit) => `${runId}|${e.record}|${unit.id}`;
      if (reviewSeat(e.seat)) {
        if (e.event === 'record-units') for (const unit of e.units ?? []) read.add(key(unit));
        continue;
      }
      if (e.event !== 'record-units') continue;
      for (const unit of e.units ?? []) answers.set(key(unit), unit.verdict);
    }
    holds += [...answers].filter(([key, verdict]) => verdict === 'holds' && read.has(key)).length;
    for (const e of events) {
      if (e.event !== 'finding' || e.record !== true || e.unit === undefined) continue;
      const key = `${runId}|${e.file}|${e.unit}`;
      // The numerator takes the denominator's guard. A finding on a unit no
      // review stamp answered is outside the holds this rate reads. A count of
      // it could put the share past one (ADR-0076).
      if (answers.get(key) !== 'holds' || !read.has(key)) continue;
      missed += 1;
      records.add(e.file);
    }
  }
  return { holds, missed, rate: holds > 0 ? round(missed / holds) : null, records: [...records] };
}

/** Whether a stamped seat name is the record review's, slot suffix and all. */
function reviewSeat(seat) {
  return typeof seat === 'string' && seat.split(':')[0] === RECORD_REVIEW_SEAT;
}

/**
 * The late share: the records the judge found owed after the freeze, over the
 * whole record set of the pass. `born` is every record the pass's own birth
 * wrote. `late` is every owed record the birth did not write. A high share says
 * the cards and the tickets do not state their decisions. The birth seat then
 * has nothing to write from (ADR-0074).
 *
 * Every judgment carries the two lists, the ones that owe nothing included. A
 * records-lane run whose birth stated every decision reports a share of nought.
 * A reading that counted no such run reported nothing at all (ADR-0076).
 */
function lateShare(runs) {
  let born = 0;
  let late = 0;
  for (const { events } of runs) {
    for (const e of events) {
      if (e.event !== 'reconciliation-judged') continue;
      born += (e.born ?? []).length;
      late += (e.late ?? []).length;
    }
  }
  const total = born + late;
  return { born, late, share: total > 0 ? round(late / total) : null };
}

/**
 * What a moved default branch cost: per update whose tree moved, whether the
 * code was re-judged, the records re-run, both or neither.
 *
 * Two certifications with two grounds answer one moved base separately
 * (ADR-0075). A re-run share near the re-judgment share says the record
 * neighbourhood is as wide as the whole suite ground, which is the reading that
 * would send the ground back for review.
 */
function movedTreeCost(runs) {
  let updates = 0;
  let rejudged = 0;
  let rerun = 0;
  let both = 0;
  for (const { events } of runs) {
    for (const e of events) {
      if (e.event !== 'pre-verdict-update' || e.ran !== true) continue;
      updates += 1;
      const code = e.code?.answer === 'rejudge';
      const records = e.records?.answer === 'rerun';
      if (code) rejudged += 1;
      if (records) rerun += 1;
      if (code && records) both += 1;
    }
  }
  return { updates, rejudged, rerun, both, neither: updates - rejudged - rerun + both };
}

/**
 * The recheck yield: the rechecks that re-answered anything, over every recheck
 * a repair round owed. A yield near nought over many rechecks says the
 * intersection rule may be widened; a moved unit a recheck missed says it must
 * be narrowed, and that one is a finding rather than a number (ADR-0075).
 */
function recheckYield(runs) {
  let rechecks = 0;
  let answered = 0;
  for (const { events } of runs) {
    for (const e of events) {
      if (e.event !== 'reconcile-recheck') continue;
      rechecks += 1;
      if (e.result !== 'kept') answered += 1;
    }
  }
  return { rechecks, answered, yield: rechecks > 0 ? round(answered / rechecks) : null };
}

/**
 * The record-diff gate time: what the layers of a record render spent, in
 * minutes, per render. A record change runs the record layers and no code suite
 * (ADR-0075), and this is the reading of what that costs on the clock.
 */
function recordGateTime(runs, pinTs) {
  const totals = [];
  for (const { events } of runs) {
    const layers = events.filter(
      (e) => e.event === 'layer-result' && typeof e.elapsedMs === 'number',
    );
    for (const render of recordRenders(events, pinTs)) {
      const spent = layers.filter((e) => e.cycle === render.cycle);
      if (spent.length > 0) {
        totals.push(spent.reduce((sum, e) => sum + e.elapsedMs, 0) / 60_000);
      }
    }
  }
  return {
    renders: totals.length,
    mean: totals.length > 0 ? round(totals.reduce((sum, m) => sum + m, 0) / totals.length) : null,
  };
}

/**
 * The tree series: the active record count each write left, with the
 * supersessions, splits and merges behind it. The record count grows under the
 * supersede lifecycle, and this is the only thing that says by how much and how
 * fast (ADR-0073).
 */
function treeSeries(runs) {
  const series = [];
  for (const { runId, events } of runs) {
    for (const e of events) {
      if (e.event !== 'reconciliation-written' || typeof e.active !== 'number') continue;
      series.push({
        runId,
        ts: e.ts,
        active: e.active,
        superseded: e.supersededCount ?? 0,
        split: e.split ?? 0,
        merged: e.merged ?? 0,
      });
    }
  }
  return series;
}

// Median of the longest green required-check duration per merge, minutes,
// over the last 5 merges — the same definition as the ci-critical-path
// tripwire metric.
const GREEN_CHECKS = new Set(['success', 'neutral', 'skipped']);
const CI_WINDOW = 5;

function ciCriticalPath(allRuns) {
  const perMerge = [];
  for (const { events } of allRuns) {
    for (const merged of events.filter((e) => e.event === 'merged')) {
      const durations = events
        .filter(
          (e) =>
            e.event === 'check-transition' &&
            e.sha === merged.sha &&
            GREEN_CHECKS.has(e.status) &&
            typeof e.duration === 'number',
        )
        .map((e) => e.duration);
      if (durations.length > 0) {
        perMerge.push({ ts: merged.ts, minutes: Math.max(...durations) / 60_000 });
      }
    }
  }
  perMerge.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const sample = perMerge.slice(-CI_WINDOW).map((m) => m.minutes);
  return sample.length > 0 ? round(median(sample)) : null;
}

function stageMedians(allRuns, lastShips) {
  const inWindow = new Set(lastShips.map((s) => s.runId));
  const byStage = new Map();
  for (const { runId, events } of allRuns) {
    if (!inWindow.has(runId)) continue;
    const entered = events.filter((e) => e.event === 'stage-entered');
    const closed = events.find((e) => e.event === 'run-closed');
    for (let i = 0; i < entered.length; i++) {
      const end = entered[i + 1]?.ts ?? closed?.ts;
      if (!end) continue;
      const minutes = (Date.parse(end) - Date.parse(entered[i].ts)) / 60_000;
      // ts is display data, never a trigger; an out-of-order pair (clock
      // skew, hand-edited fixture) is not a duration.
      if (minutes < 0) continue;
      const list = byStage.get(entered[i].stage) ?? [];
      list.push(minutes);
      byStage.set(entered[i].stage, list);
    }
  }
  const order = LANE_STAGES.story;
  return [...byStage.entries()]
    .sort((a, b) => orderOf(order, a[0]) - orderOf(order, b[0]))
    .map(([stage, list]) => ({ stage, minutes: round(median(list)) }));
}

function orderOf(order, stage) {
  const i = order.indexOf(stage);
  return i === -1 ? order.length : i;
}

// -- ledger tail --------------------------------------------------------------

function tailView(paths, allRuns) {
  const lines = [];
  const add = (ledger, events) => {
    for (const e of events.slice(-TAIL_LINES)) {
      lines.push({
        ledger,
        seq: e.seq,
        ts: e.ts,
        event: e.event,
        actor: e.actor,
        loud: LOUD_EVENTS.has(e.event),
        detail: detailOf(e),
      });
    }
  };
  add('instance', readEvents(paths.instanceLedger));
  add('escapes', readEvents(paths.escapesLedger));
  for (const { runId, events } of allRuns) add(`run:${runId}`, events);
  return lines
    .sort((a, b) => (a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : 0) || b.seq - a.seq)
    .slice(0, TAIL_LINES);
}

// -- shared -------------------------------------------------------------------

function detailOf(e) {
  if (typeof e.gist === 'string' && e.gist.length > 0) return e.gist;
  const parts = [];
  for (const [key, value] of Object.entries(e)) {
    if (ENVELOPE_KEYS.has(key) || key === 'gist') continue;
    parts.push(`${key}=${compact(value)}`);
  }
  const text = parts.join(' ');
  return text.length > DETAIL_MAX ? text.slice(0, DETAIL_MAX - 1) + '…' : text;
}

function compact(value) {
  if (typeof value === 'string') return value;
  const text = JSON.stringify(value);
  return text.length > 40 ? text.slice(0, 39) + '…' : text;
}

function minutesBetween(ts, now) {
  return Math.max(0, Math.round((now.getTime() - Date.parse(ts)) / 60_000));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
