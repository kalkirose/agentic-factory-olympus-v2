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
  // Defects that reached the default branch through a ship which carried its
  // certification over a moved base (ADR-0056), counted over the last N
  // shipped story-lane runs. The reading is what turns the owner's
  // speed-over-residual-safety trade into a number, and the band is where the
  // trade stops paying.
  'fast-path-escapes': {
    unit: 'ships',
    defaultWindow: 10,
    defaultTriggers: ['escape-recorded', 'merged'],
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
  // The worst gate layer's peak memory as a fraction of the ceiling its
  // project declared for it, over the last N runs. A layer at four fifths of
  // its ceiling dies on whatever is added to it next; the two runs that found
  // this class died at a ceiling nobody was watching (ADR-0045). A project
  // that declares no ceiling anywhere is never eligible — the trend metric
  // below is what watches those.
  'layer-peak-headroom': {
    unit: 'runs',
    defaultWindow: 5,
    // Read once per cycle rather than once per layer: every layer of the cycle
    // has stamped by the render, and the metric walks every run ledger.
    defaultTriggers: ['verdict-rendered', 'run-closed'],
  },
  // How many runs in a row one layer's peak has climbed, worst layer over the
  // last N runs. It needs no declaration of any kind: a memory that rises
  // every single run is going somewhere, and the reading says where it is
  // going before the ceiling says it has arrived.
  'layer-peak-trend': {
    unit: 'runs',
    defaultWindow: 5,
    defaultTriggers: ['verdict-rendered', 'run-closed'],
  },
  // The mean carried share of the last N verdict cycles that narrowed: how
  // much of the part work of a cycle the cycle did not have to do (ADR-0058).
  // It reads the targeted cycles alone. A first cycle has nothing to carry
  // from and a confirming cycle runs everything on purpose, so counting either
  // would read the design as a decay.
  //
  // The band is a FLOOR, which makes this the one metric here that is watched
  // for falling. Every other reading in this table is a count of something
  // wrong; this one is a count of something right, and its failure mode is
  // that it quietly stops happening. A family that loses its input
  // declaration re-runs for ever and reddens nothing, so no other metric in
  // this table can see it.
  'carry-share-window': {
    unit: 'verdicts',
    defaultWindow: 10,
    defaultTriggers: ['verdict-rendered'],
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
    // The one-line revert, proposed by the machine that measures the trade.
    // Two escapes in ten ships is the reading that says the fast path is
    // carrying defects the certification would have caught, and the answer is
    // the config line that turns it off (ADR-0056).
    {
      id: 'fast-path-escapes',
      metric: 'fast-path-escapes',
      window: 10,
      breach: { op: '>', value: 1 },
      answer:
        'set gates.fastPathShip to false: the fast path is carrying defects ' +
        'past the certification, and the trade it was turned on for is losing',
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
    {
      id: 'layer-peak-headroom',
      metric: 'layer-peak-headroom',
      window: 5,
      // Four fifths. Below it a layer has room for the work of several stories;
      // above it the next test added to the layer is the one that kills a run,
      // and which test that is nobody chooses.
      breach: { op: '>', value: 0.8 },
      answer:
        'raise the layer ceiling or bound what the layer runs; a layer this ' +
        'close to its ceiling dies on whatever is added to it next',
    },
    {
      id: 'layer-peak-trend',
      metric: 'layer-peak-trend',
      window: 5,
      // Four runs of the window of five. Three would fire on a pair of ordinary
      // stories; five could only fire on a full window, which is one run before
      // the reading stops being a forecast.
      breach: { op: '>=', value: 4 },
      answer:
        'read the peaks the layer recorded: a memory that climbs every run ' +
        'reaches its ceiling on a run nobody picked',
    },
    {
      id: 'carry-share-floor',
      metric: 'carry-share-window',
      window: 10,
      // Zero, which no share can fall below, so this entry cannot fire. That
      // is deliberate and it is temporary. The honest floor is the share the
      // project actually holds when its declarations are sound, and nobody
      // knows that number until ten narrowed cycles have been measured under
      // this metric; a floor guessed before them would either cry on every
      // ordinary red run or sit under every decay it exists to catch. The
      // project raises this one value in its own registry once the ten cycles
      // are on the ledger.
      breach: { op: '<', value: 0 },
      answer:
        'read the part reasons of the last cycles: a carry share this low is ' +
        'an input declaration that went missing, not a repair that got wider',
    },
  ];
}

/** The metric that measures the one guarantee a project can trade away. */
const FAST_PATH_METRIC = 'fast-path-escapes';

/**
 * The tripwires one project runs under: the registry it wrote, plus the
 * standing fast-path counter when it turned the fast path on and did not name
 * one itself.
 *
 * This is the doctrine rule for a gate cut, enforced rather than asked for: a
 * cut names its metric, its watch window and its breach condition in the same
 * change. `gates.fastPathShip` is a cut, and a project that turns it on without
 * the counter has traded a guarantee for speed with nothing measuring what the
 * trade costs and nothing able to propose the revert. The escapes still take
 * the closed kind, and nobody ever reads them.
 *
 * The arming is the answer rather than a config refusal, because the flag is
 * opt-in and a refusal would wedge the whole project over it: the launch reads
 * the config, an invalid config launches nothing, and a project would be dark
 * until somebody landed a PR. Arming cannot wedge anything, it is visible in
 * the same board the project's own wires show in, and a project that wants
 * another band writes its own entry, which this then leaves alone (ADR-0056).
 * @param {object} config a validated project config
 */
export function armedTripwires(config) {
  const entries = config?.tripwires ?? [];
  if (config?.gates?.fastPathShip !== true) return entries;
  if (entries.some((entry) => entry.metric === FAST_PATH_METRIC)) return entries;
  const standing = standingTripwires().find((entry) => entry.metric === FAST_PATH_METRIC);
  return [...entries, standing];
}
