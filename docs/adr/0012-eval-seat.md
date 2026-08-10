# ADR-0012: Eval seat shapes

Status: accepted (2026-08-10)

## Decision

The eval review — the periodic judgment pass over the harness ledgers —
gets these concrete shapes:

- **Trigger math.** The scheduler counts shipped story-lane runs across the
  whole instance (`listShips`, ledger-derived, live + archived). Each
  `eval-review` stamp records `shipCount`, the total at dispatch. A review
  is owed when the current total minus the last recorded `shipCount` reaches
  five. The window is every ship after the covered count — a backlog larger
  than five lands in one review, not several.
- **Event key.** A story-lane run that closes shipped notifies the
  scheduler through the daemon's `onClosed` hook; daemon start notifies
  once, so a review owed from before a restart fires without a new ship.
  Checks chain on one promise — a ship that lands during a review re-checks
  after it completes. Wall-clock never triggers.
- **Instance-scoped job.** The seat runs through the standard runner
  (`runSeat`) against the instance store: seat events, the one corrective
  re-prompt, and the model-integrity checks all apply unchanged. No
  worktree, no stack; the child's working directory is the daemon home.
  The Fable semaphore applies — the eval seat queues behind verdict seats.
  Daemon stop terminates an in-flight eval seat (`seat-terminated`) and
  drains the chain before the ledger closes.
- **Report contract.** The report schema is the closed proposal-shape set:
  `cut-candidate`, `new-tripwire`, `band-change`, `vocabulary-promotion`,
  `duration-drift` — each proposal carries a title, its ledger evidence,
  and the change a human lands by PR or map-level decision. An empty
  proposal list is a valid report. The artifact lands at
  `eval/review-<n>.json` in the daemon home; a stale file from a failed
  attempt is removed before dispatch so it can never validate as fresh.
- **The `eval-review` stamp.** Queued-classed, appended only after the
  report validates: review index, `shipCount`, the covered run ids, the
  report path, the proposal count, and the judging model from the
  transcript. It joins the resolvable set — the human triages the
  proposals, then resolves the queue item; open reviews are derivable like
  every other queued item.
- **Failure route.** A failed seat (invalid report after the corrective,
  exit, cost ceiling) has already stamped `seat-failure`; the scheduler
  stamps nothing. The trigger stays owed and the next matching event
  retries with a fresh session over the whole owed window.
- **Nothing self-executes.** No code path reads a proposal. The scheduler's
  only writes are the report artifact (via the seat) and the `eval-review`
  append; config, tripwire registries, and vocabularies change only by PR
  or map-level decision.

## Why ships count across the instance, not per project

The review judges the harness — gate yield, ladder behavior, vocabulary
drift — and harness evidence accumulates across every project the instance
runs. Per-project counting would stall reviews on a quiet project while a
busy one piles up unreviewed ships, and two concurrent reviews would read
the same instance ledger twice. One counter, one review, whole-window
evidence. This mirrors the central escapes count (ADR-0010).

## Why the stamp waits for a validated report

The stamp is the completion signal and the next review's window boundary.
Stamping at dispatch would advance the boundary even when the seat dies,
silently dropping five ships from all future review windows. Stamping at
validation means a failed review leaves the window intact — pushed results,
not started work, move state (doctrine: completion = pushed results).

## Why a failed review waits for the next event instead of retrying

An immediate retry loop on a persistently failing seat would burn sessions
against the same defect. The seat-failure stamp is the record; the owed
trigger is durable state derived from the ledgers, so the retry costs
nothing to remember and fires on the next real state change. A silent
harness (no ships) surfaces the failure at the next daemon start's check.

## Fallback paths

If one review per instance proves wrong for a genuinely multi-project home
(one project's noise drowning another's signal), key the counter and the
window per project and fan out one seat per owed project; the report
contract is unchanged. Trigger: a review whose proposals repeatedly
concern only one project's lanes.

If whole-ledger reads per check grow expensive, `listShips` can read a
ships index maintained at close instead of walking run directories; the
scheduler interface is unchanged. Trigger: check duration visible in
duration history.

If five ships proves the wrong cadence, the interval can move to instance
config with the current constant as default. Trigger: an eval review or a
human notes review windows too thin or too stale to judge.
