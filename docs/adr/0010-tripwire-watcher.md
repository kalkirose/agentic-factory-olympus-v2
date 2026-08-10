# ADR-0010: Tripwire watcher shapes

Status: accepted (2026-08-10)

## Decision

The tripwire registry, the standing metrics, the watcher, and the baseline
proposals get these concrete shapes:

- **The metric set is closed as code.** `src/tripwires/registry.mjs` names
  every metric the daemon implements, with its window unit, default window,
  default trigger events, and required params. Project-config validation
  imports the set; a registry entry that names anything else refuses the
  launch that read it. A new metric enters with its implementation, in one
  change.
- **Registry entry.** `id` (unique), `metric` (closed set), `window` (a
  positive state count — ships, freezes, or verdicts; the width metric
  evaluates current state and takes no window), `breach` (`{op, value}`,
  op one of `>` `>=` `<` `<=`), `triggerEvents` (validated against the event
  registries; per-metric defaults), `answer` (required: the restore target or
  the answering review), `params` (metric-specific; `fury-lens-yield`
  requires `params.lens`). `standingTripwires()` ships the design-given
  entries — escapes ceiling 0.5 over 10 ships, CI p50 over 25 minutes,
  frontier width under 2 — seedable at config seeding. Kill-rate and
  lens-yield bands are self-baselined, so their entries land by PR after the
  proposal.
- **The event key holds by construction.** `TelemetryStore` takes an
  `onAppend` hook that fires after every append; the hook owns its errors.
  The engine opens every run store with the hook bound to the run's project
  and hands lane handlers the same key as `ctx.onAppend` for stores they
  open themselves (the escapes ledger in the ship step). The instance store's
  hook attributes by the line's `project` field; an instance event without
  one keys nothing. No call site remembers to notify the watcher.
- **The watcher is an in-daemon process, chained per project.** `notify`
  filters against the cached registry and the baseline points, then chains
  the evaluation — two appends never race the open-breach check. The launch
  path hands over the freshly read config (the registry that just shipped);
  between launches and after a restart the watcher reads the registry from
  the bare clone without fetching, retrying a failed read at the next
  matching append. Daemon stop drains the chains before the ledger closes.
- **Breach lifecycle.** A breach opens once: while an unresolved
  `tripwire-breach` for the same project and tripwire id exists, evaluation
  returns before reading a single metric. The paired `resolved` (restore
  executed, or a recorded human exception) re-arms it; the next matching
  append evaluates fresh. The breach stamp carries value, breach condition,
  window, detail, and the registry's `answer` — answerable from the record
  alone, queued stream.
- **Metric semantics.**
  - `escapes-window`: ships filtered to the project; counted escapes
    (`product-escape`, `spec-deviation` final) recorded at or after the
    oldest ship in the window; divisor is the window size. Recency-based —
    unknown origin still counts.
  - `kill-rate`: kills over initial adversary waves, summed across the last
    N freeze records — a weighted mean, so a two-wave freeze cannot swing
    the band the way a per-freeze average would.
  - `fury-lens-yield`: confirmed findings for one lens across the runs
    holding the last N verdicts. Zero with verdicts in the window is a live
    value — the zero-yield lane is the cut candidate.
  - `ci-critical-path`: per merge, the longest green required-check duration
    for the merged sha; the value is the median across the window, in
    minutes. The median is what makes the target "warm-cache": a cold
    outlier cannot move it.
  - `frontier-width`: `computeFrontier` gains `width` — unshipped cards
    whose blockers all shipped and whose phase is open, regardless of run
    history or parks. Eligible only while `unfinished > minUnshipped`
    (default 5).
- **Baseline proposals.** At the 5th freeze the watcher stamps a kill-rate
  proposal (observed kills, waves, per-freeze rates, and the observed floor
  as the suggested band); at the 5th verdict a per-lens yield proposal,
  zero-filled across all lenses. `baseline-proposal` joins the instance
  registry, queued-classed and resolvable — the human commits the band to
  the project registry by PR, then resolves the queue item. Stamped once per
  project and metric, checked against the instance ledger.

## Why re-arm waits for the next trigger instead of re-evaluating at resolve

A width breach can close as an honest pinch — a recorded human judgment
with no action. Re-evaluating at the resolve would re-open that breach in
the same second, converting the exception into a nag loop. Waiting for the
next matching append keeps the judgment standing until the graph actually
changes state, and the judgment stays event-keyed.

## Why the escapes count stays central in a multi-project home

The window is the project's ships, but the count reads the whole escapes
ledger — recency-based, per the quality bar: unknown origin still counts.
In a home running several projects, one project's escape can land in
another's window. That is the conservative direction (a breach fires early,
never late), and per-project attribution of escapes would re-introduce the
attribution dependency the bar deliberately dropped.

## Why width counts spent and open cards

The tripwire watches for a manufactured pinch — edges forcing serial work —
and its answer is a card-edge review. A card whose blockers shipped is
possible parallelism whether a run is on it, failed on it, or waits parked;
none of that is the graph's doing. Excluding those states would breach on
human latency and run history, which the card-edge review cannot fix.

## Fallback paths

If clone reads per lazy registry load grow noticeable, cache by the
default-branch head sha — one memo, same authority. Trigger: registry-read
duration visible in duration history.

If the central escapes count proves wrong for a genuinely multi-project
home, add a `project` field to `escape-recorded` at the two write sites and
filter in the metric; the window math is untouched. Trigger: a breach whose
counted escapes belong to another project's stories.

If per-append evaluation grows expensive on large ledgers, the open-breach
check and the metrics can read a tail index instead of full ledgers; the
watcher interface is unchanged. Trigger: evaluation duration visible in
duration history.
