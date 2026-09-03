# ADR-0012: Eval seat shapes

Status: accepted (2026-08-10, window rule 2026-09-02)

## Decision

The eval review is the periodic judgment pass over the harness ledgers. It
has these shapes.

- **The ship list.** `listShips` returns every merged run of every lane,
  live and archived, in merge order. Each entry carries the run id, the
  project, the lane, the merge time, and `escapeSeq` when the run was a
  repair launched against a recorded escape. A repair launched with a
  ticket and no escape carries no `escapeSeq`; that is a maintenance
  repair. Both fields come off `run-launched`. Nothing new is stamped.
- **The window.** A review covers every ship merged after the newest ship
  the last `eval-review` stamp names in its `ships` list. The boundary is
  derived from those run ids: each resolves to its merge time, and the
  newest merge time is the boundary. A ship named by the last review is
  never in the next window, even when it shares the boundary's merge
  time. A ship that shares that time and was not named is in the window.
  With no prior review, the window is every ship. A stamp whose named
  ships no ledger holds bounds nothing, so the next review reads every
  ship again rather than skipping any.
- **The trigger.** A review is owed when the window holds five ships or
  more. A backlog larger than five lands in one review, not several.
- **Event key.** A run of any lane that closes shipped notifies the
  scheduler through the daemon's `onClosed` hook. Daemon start notifies
  once, so a review owed from before a restart fires without a new ship.
  Checks chain on one promise: a ship that lands during a review re-checks
  after it completes. Wall-clock never triggers.
- **The role block.** The seat reads each ship on its own line: the run
  id, the project, the lane, and for a repair either `escape #<seq>` or
  `maintenance`. One line states the rule: a story run has a card, a
  repair run has a ticket, and a repair with an escape is a fix of a
  defect the harness already counted. The seat is asked to judge repairs
  on their own line: the drift between the ticket and the diff, the rounds
  spent, and whether a maintenance repair should have been a story.
- **Instance-scoped job.** The seat runs through the standard runner
  (`runSeat`) against the instance store: seat events, the one corrective
  re-prompt, and the model-integrity checks all apply unchanged. No
  worktree, no stack; the child's working directory is the daemon home.
  A per-model semaphore, where the instance file sets one, applies to the
  eval seat like any other; by default no model is capped and the eval seat
  runs alongside whatever is in flight (ADR-0005). Daemon stop terminates
  an in-flight eval seat (`seat-terminated`) and drains the chain before
  the ledger closes.
- **Report contract.** The report schema is the closed proposal-shape set:
  `cut-candidate`, `new-tripwire`, `band-change`, `vocabulary-promotion`,
  `duration-drift`. Each proposal carries a title, its ledger evidence,
  and the change a human lands by PR or map-level decision. An empty
  proposal list is a valid report. The artifact lands at
  `eval/review-<n>.json` in the daemon home. A stale file from a failed
  attempt is removed before dispatch so it can never validate as fresh.
- **The `eval-review` stamp.** Queued-classed, appended only after the
  report validates. It carries the review index, `ships` (the run ids the
  window held, in merge order), `lanes` (`{story: n, repair: n}` over the
  window), `shipCount` (the total number of ships at dispatch, information
  only), the report path, the proposal count, and the judging model from
  the transcript. It joins the resolvable set: the human triages the
  proposals, then resolves the queue item. Open reviews are derivable like
  every other queued item.
- **Failure route.** A failed seat (invalid report after the corrective,
  exit, cost ceiling) has already stamped `seat-failure`; the scheduler
  stamps nothing. The trigger stays owed and the next matching event
  retries with a fresh session over the whole owed window.
- **Nothing self-executes.** No code path reads a proposal. The
  scheduler's only writes are the report artifact (through the seat) and
  the `eval-review` append. Config, tripwire registries, and vocabularies
  change only by PR or map-level decision.

## Why every lane is in the window

A repair that merged is a ship. It can escape, it can drift from the
ticket that launched it, and it can repeat a pattern across several
tickets. A review that reads story ships only reports on the filter, not
on the harness: with fixes and chores routed down the repair lane, the
filter would hide most of what merges. The same list feeds the escape-rate
window and the fast-path escape window, so a shipped repair counts there
too. The freeze collector stays story-only, because a repair freezes
nothing.

The lane travels with each ship because the seat judges the two lanes on
different evidence. A story is judged against its card and its frozen
suite. A repair is judged against its ticket, and the presence of an
escape says whether the harness already counted the defect it fixes.

## Why the boundary is a named ship and not a count

The ship list is ordered by merge time and holds every lane. A repair that
merged in the past enters the list at its merge time, between stories a
review already covered. A window cut as "the next N by count" would then
start N positions from the front of a list whose front has moved, and
would hand the seat ships it already judged, or skip ships it never saw.
The last stamp's `ships` list names what was reviewed. Resolving those run
ids to their merge times gives a boundary that does not move when the list
grows behind it. Old stamps need no migration: they already hold the run
ids.

## Why ships count across the instance, not per project

The review judges the harness: gate yield, ladder behavior, vocabulary
drift. Harness evidence accumulates across every project the instance
runs. Per-project counting would stall reviews on a quiet project while a
busy one piles up unreviewed ships, and two concurrent reviews would read
the same instance ledger twice. One list, one review, whole-window
evidence. This mirrors the central escapes count (ADR-0010).

## Why the stamp waits for a validated report

The stamp is the completion signal and the next review's boundary.
Stamping at dispatch would advance the boundary when the seat dies, and
would drop the window's ships from every later review. Stamping at
validation means a failed review leaves the window intact. Pushed results
move state, not started work.

## Why a failed review waits for the next event instead of retrying

An immediate retry loop on a persistently failing seat would burn sessions
against the same defect. The seat-failure stamp is the record. The owed
trigger is durable state derived from the ledgers, so the retry costs
nothing to remember and fires on the next real state change. A silent
harness (no ships) surfaces the failure at the next daemon start's check.

## Fallback paths

If the review must read stories alone again, `listShips` takes back the
`lane: 'story'` filter on `listRunEvents`, and every reader of it follows.
Trigger: a repair-lane proposal that the owner rules out of the review's
scope. Reversal cost: one filter argument.

If one review per instance proves wrong for a multi-project home (one
project's noise drowning another's signal), key the window per project and
fan out one seat per owed project; the report contract is unchanged.
Trigger: a review whose proposals repeatedly concern only one project's
lanes.

If whole-ledger reads per check grow expensive, `listShips` can read a
ships index maintained at close instead of walking run directories; the
scheduler interface is unchanged. Trigger: check duration visible in
duration history.

If five ships proves the wrong cadence, the interval can move to instance
config with the current constant as default. Trigger: an eval review or a
human notes review windows too thin or too stale to judge.
