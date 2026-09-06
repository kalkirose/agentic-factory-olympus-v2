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
  // Escaped defects per ship: counted escapes over the last N shipped runs
  // of any lane, divided by the window size. Recency-based — unknown origin
  // still counts.
  //
  // `params.kind` narrows it to one closed defect kind, and the reading
  // becomes a count rather than a rate: a kind names a defect the harness
  // recognises in itself, and the question about one of those is how many
  // there were, never what share of the ships carried one (ADR-0068).
  'escapes-window': {
    unit: 'ships',
    defaultWindow: 10,
    defaultTriggers: ['escape-recorded', 'escape-fixed', 'merged'],
    optionalParams: ['kind'],
    paramVocabulary: { kind: 'defect kind' },
  },
  // Defects that reached the default branch through a ship which carried its
  // certification over a moved base (ADR-0056), counted over the last N
  // shipped runs of any lane. The reading is what turns the owner's
  // speed-over-residual-safety trade into a number, and the band is where the
  // trade stops paying.
  'fast-path-escapes': {
    unit: 'ships',
    defaultWindow: 10,
    defaultTriggers: ['escape-recorded', 'merged'],
  },
  // What the fast path buys: the share of its records that carried the
  // certification instead of refusing, over the last N shipped runs of one
  // project. `fast-path-escapes` reads what the trade costs; this reads what it
  // pays, and a cut with only the cost measured cannot be judged at all.
  //
  // The reading is eligible only where the window holds at least three runs
  // with a moved base. A project whose branch never moved under a run bought
  // nothing and lost nothing, and a standing zero over that would read as a
  // check that refuses everything.
  'fast-path-takes': {
    unit: 'ships',
    defaultWindow: 10,
    defaultTriggers: ['fast-path-ship', 'merged'],
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
  // The longest single ship-token hold of the last N runs that held it, in
  // minutes. The wait above says what the queue cost; this says what bought it.
  // A hold is the update stage's merge to the merge of the request, so an
  // ordinary reading is one request's CI. A reading far above that is a run
  // holding the token over work that does not merge, which is the whole cost
  // the queue pays for (ADR-0033).
  'ship-token-hold': {
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
  // Gates an operator walked a run past on their own written authority, over
  // the last N runs of the project (ADR-0062). The option exists because a gate
  // can be wrong about the world and `retry` only asks it again; the count
  // exists because the same option, used often, is a gate nobody is repairing.
  'gate-acks-window': {
    unit: 'runs',
    defaultWindow: 10,
    defaultTriggers: ['gate-acknowledged'],
  },
  // Runs that replaced the project config they launched under, over the last N
  // runs of the project (ADR-0061). One is a config that moved under a long
  // run. Several say the launch is pinning a config its own runs cannot use.
  'run-reconfigures-window': {
    unit: 'runs',
    defaultWindow: 10,
    defaultTriggers: ['run-reconfigured'],
  },
  // The four readings of the stops the harness raises for a person, and of
  // the answers it now gives itself instead. Every one of them reads the run
  // ledgers, and every one of them exists because no plan's alarm had a
  // reader: the park counts, the gate rounds and the waits were argued from
  // ledgers somebody went and read by hand.
  //
  // Parks per run over the last N launched runs. `params.type` narrows it to
  // one park type, which is how a project watches the one stop it is
  // repairing without losing the total. Both `park` and `answer` trigger it:
  // an answered park is still a park that was raised, and the answer is the
  // append that says the window has settled.
  'parks-window': {
    unit: 'runs',
    defaultWindow: 10,
    defaultTriggers: ['park', 'answer'],
    optionalParams: ['type'],
    paramVocabulary: { type: 'park type' },
  },
  // The most spec-gate rounds any one story of the last N freezes spent. The
  // worst story rather than the mean, for the reason `verdict-cycles` reads
  // the worst run: the gate has no round cap any more (ADR-0020), so the
  // reading that matters is the story that kept the gate open, and four quick
  // freezes beside it do not make that one cheaper. The mean rides in the
  // detail for the reader who wants the window's shape.
  'gate-rounds-window': {
    unit: 'freezes',
    defaultWindow: 5,
    defaultTriggers: ['spec-gate-round'],
  },
  // Waits per run over the last N launched runs, with the share of those
  // spans whose ladder ended without asking a person. `params.kind` narrows
  // it to one wait kind. The value counts what the harness answered for
  // itself; the share in the detail says how often that answer was right,
  // and a share that falls is a ladder too short for the world it waits on
  // (ADR-0069).
  'waits-window': {
    unit: 'runs',
    defaultWindow: 10,
    defaultTriggers: ['waiting'],
    optionalParams: ['kind'],
    paramVocabulary: { kind: 'wait kind' },
  },
  // Confirmed spec-lens findings on an allowlist path, across the runs
  // holding the last N verdicts. It is the one metric here watched for
  // FALLING: a cross-cutting gate's allowlist is a file a story extends in
  // its own diff, and the only thing that judges whether the card covers the
  // addition is the spec lens reading the whole diff (ADR-0066). A window of
  // allowlist additions with no finding on any of them is not a clean
  // window — it is a lens that is not reading them, and no other reading here
  // can tell those two apart.
  //
  // Whether a finding sits on an allowlist path is decided where the finding
  // is stamped, against the project's `gates.allowlistPaths`, and never read
  // back out of the sentence the seat wrote. So the metric reads one field
  // and the config line and the band ship together, as a cut and its tripwire
  // do: a project that arms this and declares no allowlist path reads zero,
  // breaches its floor at once, and is told so.
  'allowlist-findings-window': {
    unit: 'verdicts',
    defaultWindow: 5,
    defaultTriggers: ['verdict-rendered'],
  },
  // The share of record findings the verifier refuted, across the runs holding
  // the last N verdicts that carried one. Every finding on a decision record
  // goes to the verifier and a confirmed one blocks the ship (ADR-0007), so a
  // review seat that is noisy about documents now costs rounds. This is the
  // reading that says so on the day it happens, and the answer is the record
  // criteria and the brief, which is a prompt-only change.
  //
  // A window with no record finding in it is not eligible: a project whose
  // stories touch no record says nothing about how the seat reads one.
  'record-refuted-share': {
    unit: 'verdicts',
    defaultWindow: 10,
    defaultTriggers: ['verdict-rendered'],
  },
  // Ships whose in-run record rewrite ended in a fallback, over the last N
  // ships that were judged owed. A fallback is the rewrite giving up: the
  // partial ships the records with findings open, the discard puts the tree
  // back. Either way the ticket carries the work, which is the load this
  // mechanism moved off the sweep in the first place (ADR-0026).
  'reconcile-fallbacks-window': {
    unit: 'ships',
    defaultWindow: 10,
    defaultTriggers: ['reconciliation-written', 'merged'],
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
    // The other half of the same trade. A take rate of nought, over a window
    // that held at least three moved bases, says the check refuses everything
    // and pays for itself with nothing. The answer is the refusal histogram,
    // because each word names a different repair: `ground-intersects` says the
    // ground lists are right and the branch is busy, `unclaimed-ground` says
    // the inert list is too thin, and `undeclared-suite` says the launch
    // validator and the ship reader disagree.
    {
      id: 'fast-path-takes',
      metric: 'fast-path-takes',
      window: 10,
      breach: { op: '<=', value: 0 },
      answer:
        'read the refusal histogram of the window: the fast path refused every ' +
        'moved base, so it is buying nothing for the guarantee it thinned',
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
      id: 'ship-token-hold',
      metric: 'ship-token-hold',
      window: 5,
      // Ninety minutes. A hold is the request stretch, which is one CI round
      // and a merge. A hold that carries a CI red and its repair round adds one
      // verdict cycle on top, and that is the most expensive hold the design
      // allows. Above this bound the run is holding the token over work that
      // does not merge, and every other run of the project is paying for it.
      breach: { op: '>', value: 90 },
      answer:
        'read the holder\'s stamps between its acquire and its merge: a hold ' +
        'this long is work that does not need the branch to stand still',
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
    // The two levers an operator can pull on any project, each with the band
    // that says it has stopped being an exception. One in ten runs is a gate
    // that was wrong once. Two is a pattern, and a pattern has a repair.
    {
      id: 'gate-acks',
      metric: 'gate-acks-window',
      window: 10,
      breach: { op: '>', value: 1 },
      answer:
        'read the gate each ack named: a gate wrong about the world twice in ' +
        'ten runs is a gate to repair, not one to acknowledge again',
    },
    {
      id: 'run-reconfigures',
      metric: 'run-reconfigures-window',
      window: 10,
      breach: { op: '>', value: 1 },
      answer:
        'read the reason each reconfigure carried: a pin replaced twice in ten ' +
        'runs says the launch is pinning a config its own runs cannot use',
    },
    // The two readings of the record rule. One watches the review seat, the
    // other watches whether the in-run rewrite can finish what the review
    // raises. Half the findings refuted is a seat reading documents the way it
    // reads code; the answer is the criteria and the brief.
    {
      id: 'record-refuted-share',
      metric: 'record-refuted-share',
      window: 10,
      breach: { op: '>', value: 0.5 },
      answer:
        'tighten the record criteria and the review brief: more than half the ' +
        'record findings were refuted against the tree, so the seat is noisy ' +
        'about documents and every one of them costs a verifier item',
    },
    // Two fallbacks in ten owed ships. One is a story whose records were hard.
    // Two says the in-run rewrite cannot finish what the reviews raise, and the
    // tickets are carrying the load the rewrite was meant to take off them.
    // This is also the trigger that returns the rewrite to the sweep.
    {
      id: 'reconcile-fallbacks',
      metric: 'reconcile-fallbacks-window',
      window: 10,
      breach: { op: '>=', value: 2 },
      answer:
        'return the record rewrite to the sweep: the judgment stays where it ' +
        'is, an owed judgment writes the ticket at the close, and the ' +
        'repair-lane run behind the ticket does the rewrite',
    },
  ];
}

/**
 * The metrics that measure the one guarantee a project can trade away: what
 * the trade costs, and what it buys. A cut with only one of the two measured
 * cannot be judged, because a cost of nought over a check that never fires
 * reads exactly like a cut that works.
 */
const FAST_PATH_METRICS = ['fast-path-escapes', 'fast-path-takes'];

// The metrics that count an operator walking a run past a check. They are
// armed on every project, because the levers they count are on every project:
// any gate that states a judgment about the world can be acknowledged, and any
// run can be repinned. A counter that had to be opted into would be absent from
// exactly the projects nobody is watching (ADR-0061, ADR-0062).
const LEVER_METRICS = ['gate-acks-window', 'run-reconfigures-window'];

// The two readings of the record rule. They are armed on every project for the
// reason the lever counters are: the rule is on every project, it needs no
// config line to run, and a counter that had to be opted into would be absent
// from exactly the projects nobody is watching (ADR-0007, ADR-0026).
const RECORD_METRICS = ['record-refuted-share', 'reconcile-fallbacks-window'];

/**
 * The tripwires one project runs under: the registry it wrote, plus the
 * standing counters the harness arms on its behalf.
 *
 * This is the doctrine rule for a gate cut, enforced rather than asked for: a
 * cut names its metric, its watch window and its breach condition in the same
 * change. `gates.fastPathShip` is a cut, and a project that turns it on without
 * the two counters has traded a guarantee for speed with nothing measuring what
 * the trade costs, nothing measuring what it buys, and nothing able to propose
 * the revert. The escapes still take
 * the closed kind, and nobody ever reads them. The two operator levers are cuts
 * of the same shape, taken one run at a time rather than declared in a config,
 * so their counters are armed whatever the config says.
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
  const own = config?.tripwires ?? [];
  const wanted = [...LEVER_METRICS, ...RECORD_METRICS];
  if (config?.gates?.fastPathShip === true) wanted.unshift(...FAST_PATH_METRICS);
  const missing = wanted.filter((metric) => !own.some((entry) => entry.metric === metric));
  if (missing.length === 0) return own;
  const standing = standingTripwires();
  return [...own, ...missing.map((metric) => standing.find((entry) => entry.metric === metric))];
}
