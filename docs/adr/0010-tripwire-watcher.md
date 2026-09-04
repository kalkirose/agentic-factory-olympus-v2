# ADR-0010: Tripwire watcher shapes

Status: accepted (2026-08-10)

## Decision

The tripwire registry, the standing metrics, the watcher, and the baseline
proposals get these concrete shapes:

- **The metric set is closed as code.** `src/tripwires/registry.mjs` names
  every metric the daemon implements, with its window unit, default window,
  default trigger events, and the params it takes. Project-config validation
  imports the set; a registry entry that names anything else refuses the
  launch that read it. A new metric enters with its implementation, in one
  change.
- **A narrowing param is validated against the vocabulary it narrows.** A
  metric that takes one declares the closed set by name — `defect kind`, `park
  type`, `wait kind` — and the validator resolves that name to the set the
  harness already writes those values from. A param the metric does not take is
  refused rather than ignored, because a misspelt narrowing reads as no
  narrowing and the entry then measures something wider than its band was set
  for. A value outside the set is refused for the reason the sets exist: a
  reading keyed on a name nothing carries answers zero for ever, and a metric
  that never breaches looks exactly like a metric that is fine.
- **Registry entry.** `id` (unique), `metric` (closed set), `window` (a
  positive state count — ships, freezes, or verdicts; the width metric
  evaluates current state and takes no window), `breach` (`{op, value}`,
  op one of `>` `>=` `<` `<=`), `triggerEvents` (validated against the event
  registries; per-metric defaults), `answer` (required: the restore target or
  the answering review), `params` (metric-specific; `fury-lens-yield`
  requires `params.lens`). `standingTripwires()` ships the design-given
  entries — escapes ceiling 0.5 over 10 ships, CI p50 over 25 minutes,
  frontier width under 2, more than 3 failed workspace releases in 10, a
  workspace leftover older than 4 hours — seedable at config seeding.
  Kill-rate and lens-yield bands are self-baselined, so their entries land by
  PR after the proposal.
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
  - `workspace-release-failures`: releases of the project that did not clear
    their workspace, counted over the last N `workspace-released` events. The
    window unit is the release itself — a close and a sweep tick each make
    one. The value is a count, so a window that is not full yet can only
    undercount, and the metric is eligible from the first release. The detail
    carries the runs and the image names the failures named, which is what the
    answer is read from.
  - `workspace-leftover-age`: the oldest open `workspace-leftover` of the
    project, in hours. Current state, so no window; eligible only while an
    open record exists. A duration as value, an append as trigger — every
    sweep that acts on a leftover stamps one.
  - `verdict-cycles`: the most rendered verdicts any one run spent, over the
    last N runs of the project that rendered any. The worst run rather than
    the mean: a run re-judged ten times is the reading, and four quick ships
    beside it do not make it less so.
  - `ship-token-wait`: the longest ship-token queue wait of the last N runs
    that queued, in minutes. A run still waiting is measured up to the read,
    because a queue nobody has cleared is what the metric exists for. It is
    the reading of what serial merges cost, kept out of the update-stage
    duration band so no band learns a queue wait as a stage's work
    (ADR-0039).
  - `layer-peak-headroom`: the worst gate layer's measured peak memory as a
    fraction of the ceiling its project declared, over the last N runs
    (ADR-0045). The worst reading in the window rather than the last, and
    eligible only where some layer declares a ceiling.
  - `layer-peak-trend`: how many runs in a row one layer's peak has climbed,
    worst layer over the last N runs (ADR-0045). The tail streak, because a
    climb that stopped is history; noise-floored at 2% and 16 MB, because a
    layer wanders between identical runs. It needs no declaration of any kind,
    which is what covers every layer on the day it ships. Both read once per
    verdict render rather than once per layer result: the metrics walk every
    run ledger, and a cycle stamps thirty layer results.
  - `parks-window`: parks per run over the last N launched runs of the project,
    keyed on `park` and `answer`. Every park counts, answered or not: a stop a
    person answered in a minute still cost that person the minute and the run
    the wait. `params.type` narrows it to one park type, which is how a project
    watches the one stop it is repairing without losing the total. The detail
    carries the types, because the type is what is repaired, and the runs,
    because that is where the questions and the answers are written.
  - `gate-rounds-window`: the most spec-gate rounds any one story of the last N
    freezes spent, keyed on `spec-gate-round`. The worst story rather than the
    mean, for the reason `verdict-cycles` reads the worst run: the gate has no
    round cap and parks only when it stops closing findings (ADR-0020), so the
    story that kept the gate open is the reading, and four quick freezes beside
    it do not make that one cheaper. The mean rides in the detail. A run that
    froze twice is two readings, each counting the rounds stamped before its
    own freeze.
  - `waits-window`: wait spans per run over the last N launched runs, keyed on
    `waiting`, with the share of those spans whose ladder ended without asking
    a person. `params.kind` narrows it to one wait kind. The value is what the
    harness answered for itself; the share is whether the answer was right,
    because a ladder that ran out and parked anyway was a wait too short for
    the world it was waiting on (ADR-0069). Every span counts, whatever ended
    it: a span the daemon closed at a stop is the record the next start resumes
    the ladder from, so filtering it would make a provider outage across a
    restart look like a shorter one.
  - `allowlist-findings-window`: confirmed spec-lens findings on an allowlist
    path, across the runs holding the last N verdicts, keyed on
    `verdict-rendered`. Watched for FALLING, and the second metric here that
    is. A cross-cutting rule that used to be a story test is a static gate with
    an allowlist, and a story extends the codebase by adding a line to that
    allowlist in its own diff; nothing mechanical judges whether the card
    covered the addition, and the spec lens reading the whole diff is what does
    (ADR-0066). So a window full of allowlist additions and empty of findings
    is not a clean window, it is a lens nobody is feeding, and no other reading
    here can tell those two apart.
- **Baseline proposals.** At the 5th freeze the watcher stamps a kill-rate
  proposal (observed kills, waves, per-freeze rates, and the observed floor
  as the suggested band); at the 5th verdict a per-lens yield proposal,
  zero-filled across all lenses. `baseline-proposal` joins the instance
  registry, queued-classed and resolvable — the human commits the band to
  the project registry by PR, then resolves the queue item. Stamped once per
  project and metric, checked against the instance ledger.

## Where the allowlist word is assigned

Whether a finding sits on an allowlist path is decided where the finding is
stamped, in `src/lanes/review.mjs`, against the project's
`gates.allowlistPaths`. The `finding` event gains two fields: `file`, the one
file the lens named, and `allowlist: true` when that file falls under one of
those entries. The review report already carried an optional `file`; the ledger
dropped it, so nothing downstream could count anything about where a finding
sat. The role text now asks every review seat for it.

It is assigned at the stamp and never read back out of the seat's sentence, for
the reason every closed vocabulary in the ledger is: a fact carried as prose
counts as nothing when somebody comes to count it. It also keeps the metric
readable from the ledgers alone, which is what lets the status page print it
with no daemon and no clone behind it.

A project that arms this metric and declares no allowlist path reads zero and
breaches its floor at once. That is the intended answer rather than a silent
ineligibility: the config line and the band ship together, the way a cut and
its tripwire do, and a project that armed one without the other is told so.

## Why the four stop readings are on the status page

`olympusctl status` prints all four under each project, with the metric
registry's own default windows, and an em-dash where a reading is not eligible:
the difference between "no run parked" and "no run" is the whole of what a cold
window means.

They are printed rather than left behind a breach because three of the four are
numbers a plan argued from after somebody read ninety-four parks off the run
ledgers by hand. A band is set from readings that were watched first, and a
reading nobody can see is a reading nobody sets a band from. The four
implementations are plain functions beside their entries in the metric table,
so the status page and the watcher read exactly the same number.

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

## Where the two workspace numbers come from

The instance ledger over five ships: sixteen releases that did not clear their
workspace, three of five ships blocked on their first release, and one
directory that took six attempts across some twenty hours. Grouped by window
of ten releases, the bad stretch ran at eight failures in ten and the healthy
one at one. More than three in ten sits between them: it does not fire on a
release that failed and cleared on the next sweep, and it fired throughout the
stretch nobody noticed at the time.

The leftover records that a sweep did clear were answered in twelve and in
forty-five minutes — the hold passed, which is what holds do. Four hours is
sixteen sweeps deep, well past every leftover this harness has ever cleared
and well short of the twenty-hour one that nothing came back to. So the age
band separates a hold that is passing from a hold that is permanent, which is
the only distinction the record cannot make for itself.

Both take the machinery's own escalation semantics and nothing beside it: a
queued breach that opens once, stays open until a human resolves it, and
re-arms at the resolution. Neither stops a run, releases a workspace, or
launches anything. The leftover record underneath stays quiet and stays swept
— the tripwire is what says the sweeping is not working, which ADR-0004 left
as a fallback path and this is.

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

If the ladder attribution in `waits-window` proves wrong — a park settled
against a ladder that had already done its work, or a ladder read as green that
ended at a human — the share leaves the detail and the value stays, which is a
count of spans and needs no attribution at all. Trigger: a green share that
disagrees with the parks the same window shows. Reversal cost: one function;
the spans are counted from the `waiting` stamps either way.

If `allowlist: true` proves too narrow, because the lens names the allowlist in
its evidence and not in `file`, the stamp can fall back to the paths the
evidence holds. It does not do that today: a generous reading of a sentence is
how a count stops meaning one thing, and the floor would then be met by
findings that were about something else. Trigger: allowlist additions the
window shows and findings the metric does not. Reversal cost: one function in
`review.mjs`; the metric and the field are unchanged.

If the four stop readings crowd the status page, or the four ledger walks they
cost make the page slow on a long-lived home, they move behind a flag on
`olympusctl status` and the metrics stay exactly as they are. Trigger: an
operator who reads past them, or a status render a person waits for. Reversal
cost: one line in the renderer.
