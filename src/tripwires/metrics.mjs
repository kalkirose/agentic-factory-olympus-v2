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

// Mirrors the check watcher's green set; a red duration never measures the
// green critical path.
const GREEN_CHECKS = new Set(['success', 'neutral', 'skipped']);

/**
 * Evaluates one metric.
 * @param {string} metric name from the closed set
 * @param {{paths: object, project: string, window?: number, params?: object,
 *   now?: number, readSource?: (project: string) => Promise<object|null>}} input
 *   `now` is the clock the one duration-valued metric reads; it defaults to
 *   the wall clock and exists so a test can state an age.
 * @returns {Promise<{value: number|null, eligible: boolean, detail: object}>}
 */
export async function evaluateMetric(metric, input) {
  const impl = IMPLEMENTATIONS[metric];
  if (!impl) throw new Error(`unknown tripwire metric: ${metric}`);
  return impl(input);
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

  'verdict-cycles': async ({ paths, project, window }) => {
    const runs = judgedRuns(paths, project).slice(-window);
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
 * Runs of one project that rendered a verdict, in the order their last render
 * landed, each with the number of cycles it spent. A cycle is one rendered
 * verdict, and a run's count is what the eval seat reads as re-judgment: the
 * same tree, judged again, because the last judgment did not close.
 */
function judgedRuns(paths, project) {
  const runs = [];
  for (const { runId, events } of listRunEvents(paths, { project })) {
    const renders = events.filter((e) => e.event === 'verdict-rendered');
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

/** Confirmed findings per lens across the runs holding the last N verdicts. */
function collectYield(paths, project, window) {
  const runs = listRunEvents(paths, { project });
  const verdicts = [];
  for (const { runId, events } of runs) {
    for (const v of events.filter((e) => e.event === 'verdict-rendered')) {
      verdicts.push({ ts: v.ts, runId });
    }
  }
  verdicts.sort(byTs);
  const inWindow = new Set(verdicts.slice(-window).map((v) => v.runId));
  const byLens = Object.fromEntries(ALL_LENSES.map((lens) => [lens, 0]));
  for (const { runId, events } of runs) {
    if (!inWindow.has(runId)) continue;
    for (const f of events.filter((e) => e.event === 'finding' && e.confirmed === true)) {
      byLens[f.lens] = (byLens[f.lens] ?? 0) + 1;
    }
  }
  return { verdicts: Math.min(verdicts.length, window), byLens };
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
