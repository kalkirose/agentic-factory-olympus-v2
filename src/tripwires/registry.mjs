// The closed tripwire-metric set. A registry entry in project config may
// name only these metrics; a new metric enters by a design-level decision,
// with its implementation, in one change. This module is pure data so config
// validation can import it without pulling the telemetry readers in.

/**
 * Per metric: the window unit (`ships`, `freezes`, `verdicts`, or null for a
 * metric over current state), the default window and trigger events, and the
 * params the entry must carry. Windows count state, never wall-clock.
 */
export const TRIPWIRE_METRICS = {
  // Escaped defects per story: counted escapes over the last N shipped
  // story-lane runs, divided by the window size. Recency-based — unknown
  // origin still counts.
  'escapes-window': {
    unit: 'ships',
    defaultWindow: 10,
    defaultTriggers: ['escape-recorded', 'escape-fixed', 'merged'],
  },
  // Adversary kill rate at freeze: kills over initial waves, summed across
  // the last N freeze records. The band is a floor set from the baseline.
  'kill-rate': {
    unit: 'freezes',
    defaultWindow: 5,
    defaultTriggers: ['freeze'],
  },
  // Confirmed findings for one review lens across the runs holding the last
  // N verdicts. A zero-yield lens over the window is a cut candidate.
  'fury-lens-yield': {
    unit: 'verdicts',
    defaultWindow: 5,
    defaultTriggers: ['verdict-rendered'],
    requiredParams: ['lens'],
  },
  // Green CI critical path: median across the last N merges of the longest
  // green required-check duration, in minutes. Durations are legal metric
  // data; wall-clock as trigger stays banned.
  'ci-critical-path': {
    unit: 'ships',
    defaultWindow: 5,
    defaultTriggers: ['merged'],
  },
  // Possible-not-forced parallelism of the story graph, evaluated on current
  // state (no window). Breaches only while more than `minUnshipped` stories
  // remain (default 5); an honest pinch closes the breach with no action.
  'frontier-width': {
    unit: null,
    defaultWindow: null,
    defaultTriggers: ['merged', 'card-sweep'],
  },
};

export const BREACH_OPS = new Set(['>', '>=', '<', '<=']);

/** Fills window and trigger defaults into a validated entry. No mutation. */
export function withTripwireDefaults(entry) {
  const metric = TRIPWIRE_METRICS[entry.metric];
  return {
    ...entry,
    ...(metric.defaultWindow !== null && { window: entry.window ?? metric.defaultWindow }),
    triggerEvents: entry.triggerEvents ?? metric.defaultTriggers,
  };
}

/**
 * The standing tripwires with design-given numbers, seedable at project
 * config seeding. Kill-rate and lens-yield bands are self-baselined — their
 * entries land by PR after the baseline proposal, so they are not here.
 */
export function standingTripwires() {
  return [
    {
      id: 'escapes-ceiling',
      metric: 'escapes-window',
      window: 10,
      breach: { op: '>', value: 0.5 },
      answer: 'restore the gate cut behind the escapes; keeping it is a recorded human exception',
    },
    {
      id: 'ci-critical-path-p50',
      metric: 'ci-critical-path',
      window: 5,
      breach: { op: '>', value: 25 },
      answer: 'review the check set and caches against the CI budget',
    },
    {
      id: 'frontier-width',
      metric: 'frontier-width',
      breach: { op: '<', value: 2 },
      answer: 'card-edge review; an honest pinch closes the breach with no action',
    },
  ];
}
