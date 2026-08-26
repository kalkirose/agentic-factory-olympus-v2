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
  // The most verdict cycles any one run of the last N judged runs spent. A
  // cycle is one rendered verdict, so the value is how many times the worst run
  // in the window was judged again after a judgment that did not close.
  'verdict-cycles': {
    unit: 'runs',
    defaultWindow: 5,
    defaultTriggers: ['verdict-rendered'],
  },
  // The longest ship-token queue wait of the last N runs that queued, in
  // minutes. Serial merges are the design (ADR-0033) and the queue is what they
  // cost; this is the reading of that cost, kept out of the update-stage band
  // so a band never learns a queue wait as work.
  'ship-token-wait': {
    unit: 'runs',
    defaultWindow: 5,
    defaultTriggers: ['ship-token', 'merged'],
  },
  // Releases that did not clear their workspace, counted over the last N
  // release attempts. The unit is the release itself: a close and a sweep tick
  // each make one, and a release is the state change the metric is about.
  // The value is a count, so a window that is not full yet can only undercount.
  'workspace-release-failures': {
    unit: 'releases',
    defaultWindow: 10,
    defaultTriggers: ['workspace-released'],
  },
  // The oldest workspace no release has cleared, in hours. Current state, so
  // no window. The value is a duration, which is legal metric data; the
  // trigger stays an append — every sweep that acts on a leftover makes one.
  'workspace-leftover-age': {
    unit: null,
    defaultWindow: null,
    defaultTriggers: ['workspace-released', 'workspace-leftover'],
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
    {
      id: 'verdict-cycles',
      metric: 'verdict-cycles',
      window: 5,
      // Five is the observed ceiling of a run that was judged and closed;
      // above it the window's runs were re-judging defects of the harness
      // rather than of the product.
      breach: { op: '>', value: 5 },
      answer:
        'read the cycles the run spent: past five, the gate is being asked ' +
        'the same question it already failed to close',
    },
    {
      id: 'ship-token-wait',
      metric: 'ship-token-wait',
      window: 5,
      breach: { op: '>', value: 30 },
      answer:
        'read what the token holder was doing: the queue costs every waiting ' +
        'run the whole of the holder\'s ship path',
    },
    {
      id: 'workspace-release-failures',
      metric: 'workspace-release-failures',
      window: 10,
      breach: { op: '>', value: 3 },
      answer:
        'read the holders the failed releases name; a repeat holder is a ' +
        'process the sweep does not match',
    },
    {
      id: 'workspace-leftover-age',
      metric: 'workspace-leftover-age',
      breach: { op: '>', value: 4 },
      answer: 'end the processes the leftover record names, or delete the directory by hand',
    },
  ];
}
