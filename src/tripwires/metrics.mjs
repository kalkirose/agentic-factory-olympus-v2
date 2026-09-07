// The standing tripwire metrics. Every metric evaluates from the ledgers
// alone (the width metric also reads the story graph through an injected
// source reader). Each returns `{value, eligible, detail}`; an ineligible
// evaluation never breaches. Windows count state — ships, freezes, verdicts,
// releases — never wall-clock. A duration may be a value (the CI critical
// path, a leftover's age); it is never what triggers a reading.
import { readEvents } from '../ledger/ledger.mjs';
import { inactiveMs } from '../ledger/durations.mjs';
import {
  listShips,
  listRunEvents,
  openWorkspaceLeftovers,
  storyRunsByKey,
} from '../telemetry/readers.mjs';
import {
  readEscapeSet,
  escapesWindow,
  fastPathEscapesWindow,
  kindEscapesWindow,
} from '../telemetry/escapes.mjs';
import { computeFrontier } from '../frontier/graph.mjs';
import { ALL_LENSES } from '../lanes/lenses.mjs';
import { harnessPinTs, recordRenders } from '../ledger/cycles.mjs';

// Mirrors the check watcher's green set; a red duration never measures the
// green critical path.
const GREEN_CHECKS = new Set(['success', 'neutral', 'skipped']);

/**
 * How many runs of the window must have met a moved default branch before the
 * fast path's take rate is a reading about anything.
 *
 * Three. One moved base that refused is an ordinary busy branch. Three that
 * all refused is the shape of a check that cannot fire, which is what the band
 * exists to catch.
 */
const MOVED_BASE_FLOOR = 3;

// The seat that writes one record inside the reconcile stage. The write wall
// clock is the span this seat opens, so the reading names it.
const RECORD_WRITE_SEAT = 'reconcile-write';

/**
 * Evaluates one metric.
 *
 * `pinTs` is derived here, once per evaluation, rather than by each metric that
 * reads a record render: it is one read of the instance ledger and the answer
 * is the same for every run of every project. A caller may state it, which is
 * how a test pins a ledger that straddles the harness pin.
 * @param {string} metric name from the closed set
 * @param {{paths: object, project: string, window?: number, params?: object,
 *   now?: number, pinTs?: string|null,
 *   readSource?: (project: string) => Promise<object|null>}} input
 *   `now` is the clock the one duration-valued metric reads; it defaults to
 *   the wall clock and exists so a test can state an age.
 * @returns {Promise<{value: number|null, eligible: boolean, detail: object}>}
 */
export async function evaluateMetric(metric, input) {
  const impl = IMPLEMENTATIONS[metric];
  if (!impl) throw new Error(`unknown tripwire metric: ${metric}`);
  const pinTs =
    input.pinTs !== undefined
      ? input.pinTs
      : harnessPinTs(readEvents(input.paths?.instanceLedger));
  return impl({ ...input, pinTs });
}

const IMPLEMENTATIONS = {
  'escapes-window': async ({ paths, project, window, params }) => {
    const ships = listShips(paths).filter((s) => s.project === project);
    const escapes = projectEscapes(paths, project);
    // Named a kind, the reading is a count of that kind over the window. The
    // quality bar counts final categories and answers a rate; a kind names a
    // defect the harness recognises in itself, and there the question is how
    // many, never what share (ADR-0068).
    if (typeof params?.kind === 'string') {
      const w = kindEscapesWindow({ kind: params.kind, ships, escapes, windowSize: window });
      return {
        value: w.counted,
        eligible: ships.length > 0,
        detail: { ships: w.ships, counted: w.counted, kind: params.kind, escapes: w.escapes },
      };
    }
    const w = escapesWindow({ ships, escapes, windowSize: window });
    return {
      value: w.rate,
      eligible: ships.length > 0,
      detail: { ships: w.ships, counted: w.counted },
    };
  },

  // The same window as `escapes-window` under a kind, kept as an entry of its
  // own because a project config names it and a registry is a closed set: the
  // reading is identical, and `fastPathEscapesWindow` is that call.
  'fast-path-escapes': async ({ paths, project, window }) => {
    const ships = listShips(paths).filter((s) => s.project === project);
    const escapes = projectEscapes(paths, project);
    const w = fastPathEscapesWindow({ ships, escapes, windowSize: window });
    return {
      value: w.counted,
      // The same eligibility the quality-bar window has: with no ship in the
      // ledgers there is no window, and a count of zero over nothing is not a
      // reading about anything.
      eligible: ships.length > 0,
      detail: { ships: w.ships, counted: w.counted, escapes: w.escapes },
    };
  },

  // What the fast path bought over the same window: the share of its records
  // that carried the certification. A record per moved base, `taken: true` over
  // all of them.
  //
  // The window is the shipped runs, so this reading and `fast-path-escapes`
  // are about one set of ships and can be read side by side. Eligibility is the
  // moved bases inside it, and not the ships: a window whose runs never met a
  // moved default branch asked the check nothing, and a zero over that would
  // read as a check that refuses everything.
  'fast-path-takes': async ({ paths, project, window }) => {
    const ships = listShips(paths).filter((s) => s.project === project);
    const ids = new Set(ships.slice(-window).map((s) => s.runId));
    // Keyed on a plain object, which is safe here and only here: a refusal word
    // reaches a stamp through `assertFastPathRefusal`, so the keys come from a
    // closed set that holds no name of the object prototype.
    const refusals = {};
    let records = 0;
    let taken = 0;
    let moved = 0;
    for (const { runId, events } of listRunEvents(paths, { project })) {
      if (!ids.has(runId)) continue;
      const decisions = events.filter((e) => e.event === 'fast-path-ship');
      if (decisions.length === 0) continue;
      moved += 1;
      records += decisions.length;
      for (const decision of decisions) {
        if (decision.taken === true) taken += 1;
        else if (typeof decision.refusal === 'string') {
          refusals[decision.refusal] = (refusals[decision.refusal] ?? 0) + 1;
        }
      }
    }
    return {
      value: records > 0 ? round(taken / records) : null,
      eligible: moved >= MOVED_BASE_FLOOR,
      // The histogram is the answer's own evidence: each word names a different
      // repair, so a reader of a breach needs the counts and not the rate.
      detail: { ships: ids.size, runs: moved, records, taken, refusals },
    };
  },

  'kill-rate': async ({ paths, project, window }) => {
    const freezes = collectFreezes(paths, project).slice(-window);
    const kills = freezes.reduce((n, f) => n + f.kills, 0);
    const waves = freezes.reduce((n, f) => n + f.waves, 0);
    return {
      value: waves > 0 ? kills / waves : null,
      eligible: waves > 0,
      detail: { freezes: freezes.length, kills, waves },
    };
  },

  'fury-lens-yield': async ({ paths, project, window, params }) => {
    const lens = params?.lens;
    const { verdicts, byLens } = collectYield(paths, project, window);
    return {
      value: byLens[lens] ?? 0,
      eligible: verdicts > 0,
      detail: { verdicts, lens },
    };
  },

  'ci-critical-path': async ({ paths, project, window }) => {
    const minutes = [];
    for (const { events } of listRunEvents(paths, { project })) {
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
          minutes.push({ ts: merged.ts, minutes: Math.max(...durations) / 60000 });
        }
      }
    }
    minutes.sort(byTs);
    const sample = minutes.slice(-window).map((m) => m.minutes);
    return {
      value: sample.length > 0 ? median(sample) : null,
      eligible: sample.length > 0,
      detail: { merges: sample.length },
    };
  },

  'verdict-cycles': async ({ paths, project, window, pinTs }) => {
    const runs = judgedRuns(paths, project, pinTs).slice(-window);
    // The worst run in the window, not the average of it: a run that was
    // re-judged ten times is the thing worth reading, and four quick ships
    // beside it do not make it less so.
    const worst = runs.reduce((a, b) => (b.cycles > a.cycles ? b : a), { cycles: -Infinity });
    return {
      value: runs.length > 0 ? worst.cycles : null,
      eligible: runs.length > 0,
      detail: { runs: runs.length, ...(runs.length > 0 && { run: worst.runId }) },
    };
  },

  'carry-share-window': async ({ paths, project, window }) => {
    const readings = carryShares(paths, project).slice(-window);
    const mean =
      readings.length > 0
        ? readings.reduce((sum, r) => sum + r.share, 0) / readings.length
        : null;
    return {
      value: mean === null ? null : round(mean),
      // Below one reading there is no share to be under a floor. Quiet, the
      // way every cold window here is quiet: a project that runs no layer in
      // parts, and a project whose ledgers predate the field, both report
      // nothing rather than reporting a zero they did not measure.
      eligible: readings.length > 0,
      detail: {
        cycles: readings.length,
        ...(readings.length > 0 && { run: readings.at(-1).runId }),
      },
    };
  },

  'gate-acks-window': async ({ paths, project, window }) => {
    const runs = runsByLaunch(paths, project).slice(-window);
    const acks = runs.flatMap(({ runId, events }) =>
      events.filter((e) => e.event === 'gate-acknowledged').map((e) => ({ runId, gate: e.gate })),
    );
    return {
      value: acks.length,
      // A window with no run in it is no reading. A window of runs that
      // acknowledged nothing is a reading of zero, which is the answer.
      eligible: runs.length > 0,
      detail: {
        runs: runs.length,
        // The gates, because the gate is the thing to repair, and the runs,
        // because that is where the reasons are written.
        gates: [...new Set(acks.map((a) => a.gate))].sort(),
        acked: [...new Set(acks.map((a) => a.runId))],
      },
    };
  },

  'run-reconfigures-window': async ({ paths, project, window }) => {
    const runs = runsByLaunch(paths, project).slice(-window);
    const repinned = runs.filter(({ events }) =>
      events.some((e) => e.event === 'run-reconfigured'),
    );
    // Runs, not events: a run repinned twice in one sitting is one run whose
    // launch pin was wrong, and counting the second would read a correction as
    // a second fault.
    return {
      value: repinned.length,
      eligible: runs.length > 0,
      detail: { runs: runs.length, repinned: repinned.map((r) => r.runId) },
    };
  },

  'ship-token-wait': async ({ paths, project, window, now = Date.now() }) => {
    const waits = tokenWaits(paths, project, now).slice(-window);
    // The longest, for the same reason the leftover metric reads the oldest:
    // one run that stood two hours in the queue is the condition, and a second
    // short wait beside it does not make it better.
    const longest = waits.reduce((a, b) => (b.minutes > a.minutes ? b : a), { minutes: -Infinity });
    return {
      value: waits.length > 0 ? longest.minutes : null,
      eligible: waits.length > 0,
      detail: { waits: waits.length, ...(waits.length > 0 && { run: longest.runId }) },
    };
  },

  'ship-token-hold': async ({ paths, project, window, now = Date.now() }) => {
    const holds = tokenHolds(paths, project, now).slice(-window);
    // The longest, for the same reason the wait beside it reads the longest:
    // one run that held the token two hours is the condition, and the short
    // holds around it do not make it better.
    const longest = holds.reduce((a, b) => (b.minutes > a.minutes ? b : a), { minutes: -Infinity });
    return {
      value: holds.length > 0 ? longest.minutes : null,
      eligible: holds.length > 0,
      detail: { runs: holds.length, ...(holds.length > 0 && { run: longest.runId }) },
    };
  },

  'workspace-release-failures': async ({ paths, project, window }) => {
    const releases = workspaceReleases(paths, project).slice(-window);
    const failed = releases.filter((e) => e.ok === false);
    return {
      value: failed.length,
      eligible: releases.length > 0,
      detail: {
        releases: releases.length,
        runs: [...new Set(failed.map((e) => e.runId))],
        // The image names across the failures. One name on every one of them
        // is the answer the tripwire exists to hand over.
        holders: [...new Set(failed.flatMap((e) => (e.holders ?? []).map((h) => h.name)))].sort(),
      },
    };
  },

  'workspace-leftover-age': async ({ paths, project, now = Date.now() }) => {
    const open = [...openWorkspaceLeftovers(paths).values()].filter((e) => e.project === project);
    const aged = open
      .map((e) => ({ runId: e.runId, hours: (now - Date.parse(e.ts)) / 3600000 }))
      .filter((e) => Number.isFinite(e.hours));
    // The oldest, not the count: one directory nothing will ever release is
    // the condition, and a second one does not make it worse.
    const oldest = aged.reduce((a, b) => (b.hours > a.hours ? b : a), { hours: -Infinity });
    return {
      value: aged.length > 0 ? oldest.hours : null,
      eligible: aged.length > 0,
      detail: { open: open.length, ...(aged.length > 0 && { oldest: oldest.runId }) },
    };
  },

  'layer-peak-headroom': async ({ paths, project, window }) => {
    const history = layerPeakHistory(paths, project, window);
    let worst = null;
    for (const [layer, readings] of history) {
      for (const reading of readings) {
        if (typeof reading.ceilingMb !== 'number' || reading.ceilingMb <= 0) continue;
        const fraction = reading.peakRssMb / reading.ceilingMb;
        // The worst reading in the window, not the last one: a layer that
        // touched its ceiling once has a ceiling problem, and a quieter run
        // after it does not make the touch go away.
        if (!worst || fraction > worst.fraction) worst = { layer, fraction, ...reading };
      }
    }
    return {
      value: worst ? round(worst.fraction) : null,
      eligible: worst !== null,
      detail: worst
        ? {
            layer: worst.layer,
            peakRssMb: worst.peakRssMb,
            ceilingMb: worst.ceilingMb,
            run: worst.runId,
            runs: countedRuns(history),
          }
        : {},
    };
  },

  'layer-peak-trend': async ({ paths, project, window, params }) => {
    const history = layerPeakHistory(paths, project, window);
    const growth = params?.growth ?? PEAK_GROWTH;
    const floorMb = params?.floorMb ?? PEAK_FLOOR_MB;
    let worst = null;
    let readable = false;
    for (const [layer, readings] of history) {
      if (readings.length >= 2) readable = true;
      const streak = climbingTail(readings, { growth, floorMb });
      if (!worst || streak > worst.streak) {
        worst = { layer, streak, peaks: readings.map((r) => r.peakRssMb) };
      }
    }
    return {
      value: worst ? worst.streak : null,
      // Below two readings there is no direction at all, so there is nothing
      // to be wrong about. Quiet, the way a cold duration band is quiet.
      eligible: readable,
      detail: worst
        ? { layer: worst.layer, peaks: worst.peaks, runs: countedRuns(history) }
        : {},
    };
  },

  'parks-window': async ({ paths, project, window, params }) =>
    parksReading(paths, project, { window, type: params?.type }),

  'gate-rounds-window': async ({ paths, project, window }) =>
    gateRoundsReading(paths, project, { window }),

  'waits-window': async ({ paths, project, window, params }) =>
    waitsReading(paths, project, { window, kind: params?.kind }),

  'allowlist-findings-window': async ({ paths, project, window }) =>
    allowlistFindingsReading(paths, project, { window }),

  'record-refuted-share': async ({ paths, project, window, pinTs }) =>
    recordRefutedReading(paths, project, { window, pinTs }),

  'reconcile-fallbacks-window': async ({ paths, project, window }) =>
    reconcileFallbacksReading(paths, project, { window }),

  'record-cycles': async ({ paths, project, window, pinTs }) =>
    recordCyclesReading(paths, project, { window, pinTs }),

  'record-write-time': async ({ paths, project, window }) =>
    recordWriteTimeReading(paths, project, { window }),

  'frontier-width': async ({ paths, project, params, readSource }) => {
    const source = await readSource(project);
    if (!source) return { value: null, eligible: false, detail: {} };
    const frontier = computeFrontier({
      cards: source.cards,
      phases: source.config.graph.phases,
      runs: storyRunsByKey(paths, { project }),
    });
    const minUnshipped = params?.minUnshipped ?? 5;
    return {
      value: frontier.width,
      eligible: frontier.unfinished > minUnshipped,
      detail: { unfinished: frontier.unfinished, minUnshipped },
    };
  },
};

// -- the stops, and the answers the harness gives itself ----------------------
//
// The four readings of what still stops a run for a person, and of what the
// harness answers for itself instead: parks, spec-gate rounds, waits, and
// whether anybody is reading the allowlist additions that replaced a set of
// cross-cutting story tests.
//
// They are plain functions beside their entries in the table above, because
// the status page prints all four and answers from the files with no daemon
// behind it. One reading, two callers. Each takes the runs it reads, so a
// caller that wants all four walks the ledgers once.

/**
 * Every run of one project, in launch order, with its events. The one read
 * the four readings below share.
 */
export function projectRuns(paths, project) {
  return runsByLaunch(paths, project);
}

/**
 * Parks per run over the last `window` launched runs of one project, and the
 * park types behind the number.
 *
 * Every park is counted, answered or not: the metric is about the stops the
 * harness raised, and a stop a person answered in a minute still cost that
 * person the minute and the run the wait.
 * @param {{window?: number, type?: string, runs?: object[],
 *   instanceEvents?: object[]}} [opts] `type` narrows to one park type;
 *   absent counts them all.
 */
export function parksReading(paths, project, { window = 10, type, runs, instanceEvents } = {}) {
  const inWindow = (runs ?? projectRuns(paths, project)).slice(-window);
  const ids = new Set(inWindow.map((r) => r.runId));
  const wanted = (e) => e.event === 'park' && (type === undefined || e.type === type);
  const parks = inWindow.flatMap(({ runId, events }) =>
    events.filter(wanted).map((e) => ({ runId, type: e.type })),
  );
  // The two parks that belong to a card rather than to a run are stamped on
  // the instance ledger by the ship of the run that raised them (ADR-0008,
  // ADR-0052). They carry that run id and that project, so they belong in the
  // same window; a reading that walked the run ledgers alone would answer zero
  // for two park types its own `params.type` admits.
  for (const e of instanceEvents ?? readEvents(paths.instanceLedger)) {
    if (!wanted(e) || e.project !== project || !ids.has(e.runId)) continue;
    parks.push({ runId: e.runId, type: e.type });
  }
  return {
    value: inWindow.length > 0 ? round(parks.length / inWindow.length) : null,
    // A window with no run in it is no reading. A window of runs that parked
    // nothing is a reading of zero, which is the answer.
    eligible: inWindow.length > 0,
    detail: {
      runs: inWindow.length,
      parks: parks.length,
      ...(type !== undefined && { type }),
      // The types, because the type is what is repaired, and the runs,
      // because that is where the questions and the answers are written.
      types: [...new Set(parks.map((p) => p.type))].sort(),
      parked: [...new Set(parks.map((p) => p.runId))],
    },
  };
}

/**
 * The most spec-gate rounds any one story of the last `window` freezes spent.
 *
 * The worst story, not the mean, for the reason `verdict-cycles` reads the
 * worst run: the gate has no round cap and parks only when it stops closing
 * findings (ADR-0020), so the story that kept the gate open is the reading,
 * and four quick freezes beside it do not make that one cheaper. The mean
 * rides in the detail for the reader who wants the window's shape.
 */
export function gateRoundsReading(paths, project, { window = 5, runs } = {}) {
  const freezes = [];
  for (const { runId, lane, events } of runs ?? projectRuns(paths, project)) {
    if (lane !== 'story') continue;
    const rounds = events.filter((e) => e.event === 'spec-gate-round');
    for (const freeze of events.filter((e) => e.event === 'freeze')) {
      freezes.push({
        runId,
        ts: freeze.ts,
        rounds: rounds.filter((r) => r.seq < freeze.seq).length,
      });
    }
  }
  const counted = freezes.sort(byTs).slice(-window);
  const worst = counted.reduce((a, b) => (b.rounds > a.rounds ? b : a), { rounds: -Infinity });
  const mean =
    counted.length > 0 ? counted.reduce((sum, f) => sum + f.rounds, 0) / counted.length : null;
  return {
    value: counted.length > 0 ? worst.rounds : null,
    eligible: counted.length > 0,
    detail:
      counted.length > 0
        ? { freezes: counted.length, run: worst.runId, mean: round(mean) }
        : { freezes: 0 },
  };
}

/**
 * Wait spans per run over the last `window` launched runs, and the share of
 * those spans whose ladder ended without asking a person.
 *
 * The value is what the harness answered for itself. The share is whether the
 * answer was right: a ladder that ran out and parked anyway was a wait too
 * short for the world it was waiting on, and a share that falls says so before
 * the park counts do (ADR-0069).
 *
 * Every span counts, whatever ended it. A span the daemon closed at a stop
 * (`waiting-ended` with outcome `daemon-stopped`) is the record the next start
 * resumes the ladder from, so it is read and never filtered: dropping it would
 * make a provider outage across a restart look like a shorter one.
 * @param {{window?: number, kind?: string, runs?: object[]}} [opts] `kind`
 *   narrows to one wait kind; absent counts them all.
 */
export function waitsReading(paths, project, { window = 10, kind, runs } = {}) {
  const inWindow = (runs ?? projectRuns(paths, project)).slice(-window);
  const spans = inWindow.flatMap(({ runId, events }) =>
    waitLadders(events).flatMap((ladder) =>
      ladder.spans.map(() => ({ runId, kind: ladder.kind, green: ladder.green })),
    ),
  );
  const counted = kind === undefined ? spans : spans.filter((s) => s.kind === kind);
  const green = counted.filter((s) => s.green).length;
  return {
    value: inWindow.length > 0 ? round(counted.length / inWindow.length) : null,
    eligible: inWindow.length > 0,
    detail: {
      runs: inWindow.length,
      waits: counted.length,
      ...(kind !== undefined && { kind }),
      green,
      ...(counted.length > 0 && { greenShare: round(green / counted.length) }),
      kinds: [...new Set(counted.map((s) => s.kind))].sort(),
      waited: [...new Set(counted.map((s) => s.runId))],
    },
  };
}

/**
 * Confirmed spec-lens findings on an allowlist path, across the runs holding
 * the last `window` verdicts.
 *
 * Watched for falling. A cross-cutting rule that used to be a story test is a
 * static gate with an allowlist, and a story extends the codebase by adding a
 * line to that allowlist in its own diff. Nothing mechanical judges whether
 * the card covered the addition; the spec lens reading the whole diff does
 * (ADR-0066). So a window full of allowlist additions and empty of findings is
 * not a clean window, it is a lens nobody is feeding.
 *
 * Both halves of that sentence are read off the ledger. The additions are the
 * allowlist files each candidate capture touched, carried on
 * `implementation-committed`; the findings carry `allowlist: true`, assigned
 * at the stamp against the project's `gates.allowlistPaths` and never inferred
 * here from the sentence a seat wrote. A window with no addition in it is not
 * eligible, because a window in which no story touched an allowlist says
 * nothing at all about whether anybody reads them.
 */
export function allowlistFindingsReading(paths, project, { window = 5, runs } = {}) {
  const all = runs ?? projectRuns(paths, project);
  const { verdicts, runIds } = verdictWindow(all, window);
  const touched = new Set();
  let additions = 0;
  const found = [];
  for (const { runId, events } of all) {
    if (!runIds.has(runId)) continue;
    const mine = new Set();
    for (const e of events) {
      if (e.event === 'implementation-committed') {
        for (const path of e.allowlists ?? []) mine.add(path);
        continue;
      }
      if (e.event !== 'finding' || e.lens !== 'spec') continue;
      if (e.confirmed !== true || e.allowlist !== true) continue;
      found.push({ runId, id: e.id, file: e.file });
    }
    // Per run: the same allowlist extended by two stories is two additions,
    // and each of them is a judgment the lens owed.
    additions += mine.size;
    for (const path of mine) touched.add(path);
  }
  return {
    value: found.length,
    eligible: additions > 0,
    detail: {
      verdicts,
      additions,
      findings: found.length,
      allowlists: [...touched].sort(),
      runs: [...new Set(found.map((f) => f.runId))],
    },
  };
}

/**
 * The share of record findings the verifier refuted, across the runs holding
 * the last `window` record renders that carried a record finding.
 *
 * Every finding on a decision record reaches the verifier, at every grade, and
 * a confirmed one blocks the ship (ADR-0007). The guard that keeps a wrong
 * remark from blocking is the verifier itself, and this is the reading of how
 * often it has to use it. Above a half the review seat is reading documents the
 * way it reads code, and the answer is the record criteria and the brief.
 *
 * The window is the record renders that hold a record finding, not every
 * render: a project whose stories touch no record says nothing about how its
 * seat reads one, and a share over nothing is not a reading about anything.
 * Both render shapes count, so the reading does not change under the ledger it
 * is measured over.
 */
export function recordRefutedReading(paths, project, { window = 10, runs, pinTs = null } = {}) {
  const all = runs ?? projectRuns(paths, project);
  const carrying = [];
  // The key holds the event as well as the cycle. A record finding of stage
  // cycle 2 and a code verdict of cycle 2 are two different judgments about two
  // different trees, and a key of run and cycle alone would join the first to
  // the second in any ledger where the two counters ever met (ADR-0075).
  const key = (runId, render) => `${runId}#${render.event}#${render.cycle}`;
  const rendered = new Map();
  for (const { runId, events } of all) {
    const findings = events.filter((f) => f.event === 'finding' && f.record === true);
    for (const render of recordRenders(events, pinTs)) {
      rendered.set(`${runId}#${render.cycle}`, render);
      if (findings.some((f) => f.cycle === render.cycle)) {
        carrying.push({ ts: render.ts, runId, key: key(runId, render) });
      }
    }
  }
  carrying.sort(byTs);
  const inWindow = carrying.slice(-window);
  const keys = new Set(inWindow.map((v) => v.key));
  let raised = 0;
  let refuted = 0;
  const runIds = new Set();
  for (const { runId, events } of all) {
    for (const e of events) {
      if (e.event !== 'finding' || e.record !== true) continue;
      const render = rendered.get(`${runId}#${e.cycle}`);
      if (!render || !keys.has(key(runId, render))) continue;
      raised += 1;
      if (e.confirmed !== true) refuted += 1;
      runIds.add(runId);
    }
  }
  return {
    value: raised > 0 ? round(refuted / raised) : null,
    eligible: raised > 0,
    detail: {
      verdicts: inWindow.length,
      findings: raised,
      refuted,
      confirmed: raised - refuted,
      runs: [...runIds],
    },
  };
}

/**
 * Ships whose in-run record write ended in a fallback, over the last `window`
 * ships of the project that were judged owed.
 *
 * Every fallback counts and they count the same, whatever the cause. A cap
 * stall ships the records with findings open, an operator ended the write, a
 * work-product defect survived its attempts: each ends with the work on a
 * ticket, which is the load the in-run write was built to take off the sweep
 * (ADR-0026). A metric that named the causes it counts would go quiet on the
 * day a new one landed, which is exactly when it is worth reading.
 *
 * The window is the owed ships. A ship whose records were not owed asked the
 * write nothing, and counting it would read a quiet quarter as a healthy one.
 */
export function reconcileFallbacksReading(paths, project, { window = 10, runs } = {}) {
  const owed = [];
  for (const { runId, events } of runs ?? projectRuns(paths, project)) {
    const merged = events.find((e) => e.event === 'merged');
    if (!merged) continue;
    const judged = events.find(
      (e) => e.event === 'reconciliation-judged' && e.ok === true && e.owed === true,
    );
    if (!judged) continue;
    const fallback = events.find(
      (e) => e.event === 'reconciliation-written' && (e.partial === true || e.ok === false),
    );
    owed.push({
      runId,
      ts: merged.ts,
      fallback: fallback ? (fallback.cause ?? 'unstated') : null,
      partial: fallback?.partial === true,
    });
  }
  owed.sort(byTs);
  const inWindow = owed.slice(-window);
  const fell = inWindow.filter((s) => s.fallback !== null);
  const causes = {};
  for (const s of fell) causes[s.fallback] = (causes[s.fallback] ?? 0) + 1;
  return {
    value: inWindow.length > 0 ? fell.length : null,
    eligible: inWindow.length > 0,
    detail: {
      ships: inWindow.length,
      fallbacks: fell.length,
      // The causes behind the number. Each word names a different repair, so a
      // reader of a breach needs the histogram and not the count alone. The
      // partial count is beside it because that shape is the one that ships the
      // records and tickets the rest, which is a different loss.
      causes,
      partial: fell.filter((s) => s.partial).length,
      runs: fell.map((s) => s.runId),
    },
  };
}

/**
 * The mean record cycles per reconciliation, over the last `window` stage runs
 * of the project.
 *
 * A stage run is bounded by its own `stage-entered`: a re-run after a moved
 * base and a recheck after a repair each enter the stage again and each opens a
 * count of its own (ADR-0075). The value is what the stage costs when it is
 * asked one question, and the number that says the mechanism works is a green
 * inside two cycles.
 *
 * The mean and not the worst, which is where this reading differs from
 * `verdict-cycles` beside it. A code verdict is one question asked again until
 * it closes, so the worst run is the condition. A reconciliation is asked once
 * per stage run and there are several of them in a ship, so the reading that
 * says whether the stage converges is the average of them; the worst rides in
 * the detail for the reader who wants the tail.
 */
export function recordCyclesReading(paths, project, { window = 5, runs, pinTs = null } = {}) {
  const stageRuns = [];
  for (const { runId, events } of runs ?? projectRuns(paths, project)) {
    const renders = recordRenders(events, pinTs);
    if (renders.length === 0) continue;
    // The entries the stage made, oldest first. A render belongs to the last
    // entry before it; a render with no entry behind it belongs to the first,
    // which is the shape of every ledger written before the stage existed.
    const entries = events
      .filter((e) => e.event === 'stage-entered' && e.stage === 'reconcile' && !e.resumed)
      .map((e) => e.seq);
    const counts = new Map();
    for (const render of renders) {
      const opened = entries.filter((seq) => seq < render.seq).at(-1) ?? 0;
      counts.set(opened, {
        cycles: (counts.get(opened)?.cycles ?? 0) + 1,
        ts: render.ts,
        runId,
      });
    }
    stageRuns.push(...counts.values());
  }
  stageRuns.sort(byTs);
  const counted = stageRuns.slice(-window);
  const worst = counted.reduce((a, b) => (b.cycles > a.cycles ? b : a), { cycles: -Infinity });
  const mean =
    counted.length > 0 ? counted.reduce((sum, s) => sum + s.cycles, 0) / counted.length : null;
  return {
    value: mean === null ? null : round(mean),
    eligible: counted.length > 0,
    detail:
      counted.length > 0
        ? { reconciliations: counted.length, worst: worst.cycles, run: worst.runId }
        : { reconciliations: 0 },
  };
}

/**
 * The mean wall clock of the record write, in minutes, over the last `window`
 * stage runs of the project that wrote anything.
 *
 * The writers run one record at a time, in one worktree, each with its own seat
 * identity and its own commit (ADR-0073). That is the owner's decision and this
 * is the reading that says when it stops paying: the span from the first write
 * seat of a stage run to the last `reconciliation-written` of it. A mean over
 * the band says the answer is to review whether the writers should run in
 * parallel.
 *
 * Wall clock and not work: what the reading is about is how long a person or a
 * queued run waits for the records, and a wait inside the span is part of that.
 */
export function recordWriteTimeReading(paths, project, { window = 5, runs } = {}) {
  const spans = [];
  for (const { runId, events } of runs ?? projectRuns(paths, project)) {
    let span = null;
    const close = () => {
      if (span?.first != null && span.last != null) {
        const minutes = (Date.parse(span.last) - Date.parse(span.first)) / 60000;
        // An out-of-order pair is recording data and not a duration.
        if (Number.isFinite(minutes) && minutes >= 0) {
          spans.push({ runId, ts: span.first, minutes });
        }
      }
      span = null;
    };
    for (const e of events) {
      if (e.event === 'stage-entered') {
        // A resumed entry ends nothing: the daemon restarted and the stage run
        // is the one the writers were already in.
        if (e.stage !== 'reconcile') close();
        else if (!e.resumed) close();
        if (e.stage === 'reconcile') span ??= { first: null, last: null };
        continue;
      }
      if (span === null) continue;
      if (e.event === 'seat-spawned' && writeSeat(e.seat)) span.first ??= e.ts;
      else if (e.event === 'reconciliation-written') span.last = e.ts;
    }
    close();
  }
  spans.sort(byTs);
  const counted = spans.slice(-window);
  const longest = counted.reduce((a, b) => (b.minutes > a.minutes ? b : a), { minutes: -Infinity });
  const mean =
    counted.length > 0 ? counted.reduce((sum, s) => sum + s.minutes, 0) / counted.length : null;
  return {
    value: mean === null ? null : round(mean),
    eligible: counted.length > 0,
    detail:
      counted.length > 0
        ? { writes: counted.length, longest: round(longest.minutes), run: longest.runId }
        : { writes: 0 },
  };
}

/**
 * Whether a seat name is a record writer's. A write is dispatched once per
 * record, so the name a spawn stamps carries a slot suffix and the seat behind
 * it is the name before the colon (ADR-0073). The name is read here and never
 * written, the way the repair ladder reads its own dev seat's name.
 */
function writeSeat(seat) {
  return typeof seat === 'string' && seat.split(':')[0] === RECORD_WRITE_SEAT;
}

/**
 * The wait ladders of one run, in ledger order, each with its spans and
 * whether it ended without a park.
 *
 * A ladder is the run of waits one condition bought: a `waiting` of the same
 * kind carrying an attempt past the first continues the standing one, and
 * anything else opens a new one. What settles a ladder is the first thing the
 * run does after it: a `park` settles it red, and a new wait or a fresh stage
 * entry settles it green. A resumed stage entry settles nothing — the daemon
 * restarted and the run is still in the stage the ladder belongs to — and nor
 * does a hold at that stage. A ladder the ledger simply ends on is green,
 * because nothing was asked.
 *
 * The stage boundary is what keeps the attribution honest: a park two stages
 * later is that stage's park, not this ladder's.
 */
function waitLadders(events) {
  const ladders = [];
  let standing = null;
  const settle = (green) => {
    if (standing) standing.green = green;
    standing = null;
  };
  for (const e of events ?? []) {
    if (e.event === 'waiting') {
      if (!(standing && standing.kind === e.kind && (e.attempt ?? 1) > 1)) {
        settle(true);
        standing = { kind: e.kind, spans: [], green: true };
        ladders.push(standing);
      }
      standing.spans.push(e);
      continue;
    }
    if (standing === null || e.event === 'waiting-ended') continue;
    if (e.event === 'park') settle(false);
    else if (e.event === 'stage-entered' && e.resumed !== true) settle(true);
  }
  return ladders;
}

// -- baselines ----------------------------------------------------------------
// At the 5th freeze and the 5th verdict the watcher stamps a baseline
// proposal (queued); the human commits the band to the registry by PR.

export const BASELINE_WINDOW = 5;

export function countFreezes(paths, project) {
  return collectFreezes(paths, project).length;
}

/** Observed kill-rate data over the last BASELINE_WINDOW freezes. */
export function killRateBaseline(paths, project) {
  const freezes = collectFreezes(paths, project).slice(-BASELINE_WINDOW);
  const kills = freezes.reduce((n, f) => n + f.kills, 0);
  const waves = freezes.reduce((n, f) => n + f.waves, 0);
  const perFreeze = freezes.map((f) => (f.waves > 0 ? f.kills / f.waves : 0));
  return {
    freezes: freezes.length,
    kills,
    waves,
    rate: waves > 0 ? kills / waves : 0,
    perFreeze,
  };
}

export function countVerdicts(paths, project) {
  let count = 0;
  for (const { events } of listRunEvents(paths, { project })) {
    count += events.filter((e) => e.event === 'verdict-rendered').length;
  }
  return count;
}

/**
 * Confirmed-finding counts per lens over the runs holding the last
 * BASELINE_WINDOW verdicts. Every known lens appears, zero-filled — a
 * zero-yield lens is the cut candidate the proposal exists to show.
 */
export function furyYieldBaseline(paths, project) {
  const { verdicts, byLens } = collectYield(paths, project, BASELINE_WINDOW);
  return { verdicts, byLens };
}

// -- layer peak memory --------------------------------------------------------
//
// What a step of a climb has to be before it counts as one. A gate layer's
// memory moves a little between identical runs — a different allocation order,
// a cache that filled — and a rule with no noise floor would read that as a
// trend and cry every window. Both have to be cleared: two per cent of the
// reading before it, and sixteen mebibytes.

const PEAK_GROWTH = 0.02;
const PEAK_FLOOR_MB = 16;

/**
 * Per-layer peak-memory readings over the last `window` runs of a project that
 * measured anything, oldest run first.
 *
 * One reading per layer per run — the largest peak that layer reached in it.
 * A layer runs several times inside one run (the flake filter's re-run, a
 * later cycle, the confirmation sweep) and those are one story about one tree,
 * not four data points; the largest of them is what the run is worth to a
 * forecast. Abandoned attempts count: the flake filter's replaced red is often
 * the first death of a pair, and a history that skipped it would learn the
 * layer's memory from half its runs.
 * @returns {Map<string, Array<{runId: string, peakRssMb: number,
 *   ceilingMb: number|null}>>}
 */
function layerPeakHistory(paths, project, window) {
  const runs = [];
  for (const { runId, events } of listRunEvents(paths, { project })) {
    const byLayer = new Map();
    let ts = null;
    for (const e of events) {
      if (e.event !== 'layer-result' && e.event !== 'layer-abandoned') continue;
      const peakRssMb = e.resources?.peakRssMb;
      // A ledger written before the measurement existed carries no reading, and
      // reads here as a run that measured nothing rather than as a zero.
      if (typeof peakRssMb !== 'number' || typeof e.layer !== 'string') continue;
      if (ts === null) ts = e.ts;
      const ceilingMb =
        typeof e.resources.ceilingMb === 'number' ? e.resources.ceilingMb : null;
      const standing = byLayer.get(e.layer);
      if (!standing || peakRssMb > standing.peakRssMb) {
        byLayer.set(e.layer, {
          runId,
          peakRssMb,
          ceilingMb: ceilingMb ?? standing?.ceilingMb ?? null,
        });
      }
    }
    if (byLayer.size > 0) runs.push({ ts, byLayer });
  }
  runs.sort(byTs);
  const history = new Map();
  for (const run of runs.slice(-window)) {
    for (const [layer, reading] of run.byLayer) {
      if (!history.has(layer)) history.set(layer, []);
      history.get(layer).push(reading);
    }
  }
  return history;
}

/** How many runs the readings came from. Detail for the operator, not a value. */
function countedRuns(history) {
  return new Set([...history.values()].flat().map((r) => r.runId)).size;
}

/**
 * How many readings the layer has climbed for, counting back from the latest.
 * The tail and not the longest streak anywhere in the window: a climb that
 * stopped three runs ago is history, and this metric is a forecast.
 */
function climbingTail(readings, { growth, floorMb }) {
  if (readings.length === 0) return 0;
  let length = 1;
  for (let i = readings.length - 1; i > 0; i--) {
    const step = readings[i].peakRssMb - readings[i - 1].peakRssMb;
    if (step < floorMb || step < readings[i - 1].peakRssMb * growth) break;
    length += 1;
  }
  return length;
}

// -- shared collectors --------------------------------------------------------

/**
 * The escapes of one project. The escapes ledger is instance-scoped and every
 * metric over it is a reading about one project, so the filter belongs here
 * rather than at each call: without it a second project's defects breach this
 * project's band, and the answer the breach hands over names this project's
 * config line for a defect that is not in this project's repository.
 *
 * Every record the harness writes carries the project on its refs. One that
 * does not is older than the ref and belongs to no project this can name, so it
 * counts for none; a defect nothing can attribute is not evidence against a
 * project the reader happened to ask about.
 */
function projectEscapes(paths, project) {
  return readEscapeSet(paths.escapesLedger).filter((e) => e.refs?.project === project);
}

/**
 * Workspace releases of one project, in ledger order. A release with no
 * project on it keys nothing, exactly as every other instance event does — the
 * daemon reads the owner off the workspace record so a sweep's release carries
 * one too.
 */
function workspaceReleases(paths, project) {
  return readEvents(paths.instanceLedger).filter(
    (e) => e.event === 'workspace-released' && e.project === project,
  );
}

/**
 * Every run of one project, in launch order, with its events.
 *
 * The order is the launch stamp rather than the last event, because the two
 * metrics that read this count what happened inside a run, and an open run that
 * is still being written would otherwise walk to the end of the window on every
 * append and push a closed run out of it.
 */
function runsByLaunch(paths, project) {
  return listRunEvents(paths, { project })
    .map((run) => ({ ...run, ts: run.events[0]?.ts ?? '' }))
    .sort(byTs);
}

/**
 * Runs of one project that rendered a code verdict, in the order their last
 * render landed, each with the number of cycles it spent. A cycle is one
 * rendered verdict, and a run's count is what the eval seat reads as
 * re-judgment: the same tree, judged again, because the last judgment did not
 * close.
 *
 * The record renders are taken out, by set and not by subtraction. Before the
 * reconcile stage a record render WAS a `verdict-rendered`, so a run that spent
 * three code cycles and two record cycles reads five here and always has; after
 * it the record renders are their own event and the count never held them. Both
 * shapes answer three, which is what the band judges.
 */
function judgedRuns(paths, project, pinTs) {
  const runs = [];
  for (const { runId, events } of listRunEvents(paths, { project })) {
    const records = new Set(recordRenders(events, pinTs).map((r) => r.seq));
    const renders = events.filter((e) => e.event === 'verdict-rendered' && !records.has(e.seq));
    if (renders.length === 0) continue;
    runs.push({ runId, ts: renders.at(-1).ts, cycles: renders.length });
  }
  return runs.sort(byTs);
}

/**
 * Ship-token queue waits of one project, in the order the runs queued, in
 * minutes. A run still waiting is measured up to `now` — a wait nobody has
 * ended is the one worth reading, and leaving it out until it ends is how the
 * metric would go quiet exactly when the queue is stuck.
 */
function tokenWaits(paths, project, now) {
  const waits = [];
  for (const { runId, events } of listRunEvents(paths, { project })) {
    const queued = events.find((e) => e.event === 'ship-token' && e.state === 'waiting');
    if (!queued) continue;
    const end = events.find((e) => e.event === 'run-closed')?.ts ?? new Date(now).toISOString();
    const ms = inactiveMs(events, { start: queued.ts, end, classes: ['queue'] });
    waits.push({ runId, ts: queued.ts, minutes: ms / 60000 });
  }
  return waits.sort(byTs);
}

/**
 * Ship-token holds of one project, in the order the runs took the token, in
 * minutes. One reading per run: the longest hold that run took, because a
 * waiter pays one hold and never a run's sum.
 *
 * A hold opens at an `acquired` stamp, or at `pr-opened` for a run that opened
 * a request without one, and it closes at the release, the merge, or the run's
 * close. A hold nobody has ended is measured to `now`, for the same reason an
 * open wait is: leaving it out until it ends is how the metric would go quiet
 * exactly when the token is stuck.
 */
function tokenHolds(paths, project, now) {
  const holds = [];
  for (const { runId, events } of listRunEvents(paths, { project })) {
    let openedAt = null;
    let longest = -Infinity;
    let first = null;
    const close = (at) => {
      if (openedAt === null) return;
      const ms = Date.parse(at) - Date.parse(openedAt);
      openedAt = null;
      // An out-of-order pair is recording data and not a duration, exactly as
      // `readBounds` reads one (durations.mjs).
      if (Number.isFinite(ms) && ms >= 0) longest = Math.max(longest, ms);
    };
    for (const e of events) {
      if (e.event === 'ship-token' && e.state === 'acquired') openedAt ??= e.ts;
      else if (e.event === 'pr-opened') openedAt ??= e.ts;
      else if (e.event === 'ship-token' && e.state === 'released') close(e.ts);
      else if (e.event === 'merged' || e.event === 'run-closed') close(e.ts);
      if (openedAt !== null && first === null) first = openedAt;
    }
    close(new Date(now).toISOString());
    if (first === null || !Number.isFinite(longest)) continue;
    holds.push({ runId, ts: first, minutes: longest / 60000 });
  }
  return holds.sort(byTs);
}

/**
 * The carried share of each verdict cycle of one project that narrowed, in
 * ledger order.
 *
 * Two cycles are left out, and both by the same rule: a cycle the harness runs
 * whole on purpose says nothing about the narrowing. A full sweep is the first
 * cycle of a pass and has nothing to carry from; a confirming cycle runs every
 * layer at its own sha so the green it certifies rests on no carry (ADR-0046).
 * Counting either would read the design as a decay and would drag the mean
 * down hardest on the runs that went green fastest.
 *
 * A render written before the share existed carries no number and is no
 * reading, which is how this metric stays quiet over old ledgers.
 */
function carryShares(paths, project) {
  const readings = [];
  for (const { runId, events } of listRunEvents(paths, { project })) {
    for (const e of events) {
      if (e.event !== 'verdict-rendered') continue;
      if (e.sweep !== 'targeted' || e.confirmation === true) continue;
      if (typeof e.carryShare !== 'number') continue;
      readings.push({ runId, ts: e.ts, share: e.carryShare });
    }
  }
  return readings.sort(byTs);
}

/** Freeze records in ts order: kills and initial-wave count per freeze. */
function collectFreezes(paths, project) {
  const freezes = [];
  for (const { events } of listRunEvents(paths, { project, lane: 'story' })) {
    const waves = events.filter(
      (e) => e.event === 'adversary-wave' && e.phase === 'initial',
    ).length;
    for (const f of events.filter((e) => e.event === 'freeze')) {
      freezes.push({ ts: f.ts, kills: f.killCount, waves });
    }
  }
  return freezes.sort(byTs);
}

/**
 * The runs holding the last `window` rendered verdicts, and how many verdicts
 * that window holds. Two readings ask this one question — the per-lens yield
 * and the allowlist findings — and a second copy of it would be a second
 * definition of what a verdict window is.
 * @returns {{verdicts: number, runIds: Set<string>}}
 */
function verdictWindow(runs, window) {
  const verdicts = [];
  for (const { runId, events } of runs) {
    for (const v of events) {
      if (v.event === 'verdict-rendered') verdicts.push({ ts: v.ts, runId });
    }
  }
  verdicts.sort(byTs);
  return {
    verdicts: Math.min(verdicts.length, window),
    runIds: new Set(verdicts.slice(-window).map((v) => v.runId)),
  };
}

/**
 * Confirmed findings per lens across the runs holding the last N verdicts.
 *
 * Record findings are excluded. The reading behind them asks whether a lens
 * pays for the seat it rides, and it answers with confirmations; a finding on a
 * decision record is a different population and the record rule makes it
 * numerous, because every grade of it is verified (ADR-0007). Counted together,
 * documentation findings could argue a cut lens back onto the panel. They have
 * their own reading in `record-refuted-share`.
 */
function collectYield(paths, project, window) {
  const runs = listRunEvents(paths, { project });
  const { verdicts, runIds } = verdictWindow(runs, window);
  const byLens = Object.fromEntries(ALL_LENSES.map((lens) => [lens, 0]));
  for (const { runId, events } of runs) {
    if (!runIds.has(runId)) continue;
    for (const f of events.filter(
      (e) => e.event === 'finding' && e.confirmed === true && e.record !== true,
    )) {
      byLens[f.lens] = (byLens[f.lens] ?? 0) + 1;
    }
  }
  return { verdicts, byLens };
}

/** Ledger order across ledgers: the stamp's own time, ascending. */
function byTs(a, b) {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
}

/** A fraction a person can read, and a breach comparison that is stable. */
function round(value) {
  return Math.round(value * 1000) / 1000;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
