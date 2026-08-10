// The standing tripwire metrics. Every metric evaluates from the ledgers
// alone (the width metric also reads the story graph through an injected
// source reader). Each returns `{value, eligible, detail}`; an ineligible
// evaluation never breaches. Windows count state — ships, freezes, verdicts
// — never wall-clock.
import { listShips, listRunEvents, storyRunsByKey } from '../telemetry/readers.mjs';
import { readEscapeSet, escapesWindow } from '../telemetry/escapes.mjs';
import { computeFrontier } from '../frontier/graph.mjs';
import { ALL_LENSES } from '../lanes/review.mjs';

// Mirrors the check watcher's green set; a red duration never measures the
// green critical path.
const GREEN_CHECKS = new Set(['success', 'neutral', 'skipped']);

/**
 * Evaluates one metric.
 * @param {string} metric name from the closed set
 * @param {{paths: object, project: string, window?: number, params?: object,
 *   readSource?: (project: string) => Promise<object|null>}} input
 * @returns {Promise<{value: number|null, eligible: boolean, detail: object}>}
 */
export async function evaluateMetric(metric, input) {
  const impl = IMPLEMENTATIONS[metric];
  if (!impl) throw new Error(`unknown tripwire metric: ${metric}`);
  return impl(input);
}

const IMPLEMENTATIONS = {
  'escapes-window': async ({ paths, project, window }) => {
    const ships = listShips(paths).filter((s) => s.project === project);
    const escapes = readEscapeSet(paths.escapesLedger);
    const w = escapesWindow({ ships, escapes, windowSize: window });
    return {
      value: w.rate,
      eligible: ships.length > 0,
      detail: { ships: w.ships, counted: w.counted },
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
    minutes.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const sample = minutes.slice(-window).map((m) => m.minutes);
    return {
      value: sample.length > 0 ? median(sample) : null,
      eligible: sample.length > 0,
      detail: { merges: sample.length },
    };
  },

  'frontier-width': async ({ paths, project, params, readSource }) => {
    const source = await readSource(project);
    if (!source) return { value: null, eligible: false, detail: {} };
    const frontier = computeFrontier({
      cards: source.cards,
      phases: source.config.graph.phases,
      runs: storyRunsByKey(paths),
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

// -- shared collectors --------------------------------------------------------

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
  return freezes.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
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
  verdicts.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
