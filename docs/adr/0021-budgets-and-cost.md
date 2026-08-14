# ADR-0021: One cost derivation, informational budgets, and a per-run quota memo

Status: accepted (2026-08-14)

## Decision

Money gets one derivation, one threshold that only ever speaks, and one memo
that stops a run paying twice for the same refusal.

- **`runCost(events)` is the only answer to what a run spent.** Per seat
  invocation, the terminal stamp (`seat-report`, `seat-failure`,
  `seat-terminated`) supersedes that invocation's progress snapshots; an
  invocation that ended without a terminal stamp contributes its last
  snapshot; a terminal stamp carrying no figure falls back to the snapshots
  its own invocation left. Every display and every threshold reads it. It
  lives in `src/ledger/cost.mjs`, beside the ledger it derives from.
- **A project may give a lane a budget, in US dollars.** `budgets.story` and
  `budgets.repair` in project config, positive numbers, validated at launch
  like everything else there. No block, no thresholds — the feature is off.
- **A crossing informs and never gates.** After every seat terminal stamp the
  run re-derives its cost. The first one at or past the lane's threshold
  stamps `budget-breach` once, carrying the threshold, the cost at crossing,
  and the stage. The run then continues exactly as it would have. A threshold
  never parks, blocks, or closes anything (owner decision, 2026-08-13).
- **`budget-breach` is loud, and the run pairs its own resolution at close.**
- **A run remembers a refused model for as long as the vendor said it would.**
  When the run's ledger already holds a rejection for the model a seat is
  configured to run on, and the `resetsAt` that came with it has not arrived,
  the seat degrades at the spawn. The stamp is the same `model-degraded` the
  fresh path writes, with `memo: true` and the recorded `resetsAt`. Past the
  reset instant, or with no instant recorded, the seat spawns on its
  configured model exactly as before.

## Why one derivation, and what it fixes

Cost reaches a ledger by three routes and they overlap. A `seat-progress`
line carries the cumulative cost of its invocation to date. A terminal stamp
carries the final figure, which repeats the last snapshot. And an invocation
that ends without a terminal stamp — a corrective re-prompt's first dispatch,
a model that refused, a child the daemon lost — leaves its spend in a snapshot
and nowhere else.

Summing every `cost` field therefore double-counts every seat that finished
and undercounts nothing, while dropping a snapshot-only invocation loses real
money: one measured set of ledgers held $19.68 across 7 such invocations. Both
errors are silent, and both would have been baked into whatever a threshold
compared against. The derivation is small; the point is that there is exactly
one of it, so no two readers can disagree about what a run cost.

## Why the threshold informs instead of gating

A gate on money would be the first thing in the harness that stops a run on a
condition the run met by itself. Terminal-state discipline (ADR-0015) exists
because the alternative was measured and it was worse: a run that dies on a
condition throws away sound work, and the relaunch pays for that work a second
time. A budget stop is the same shape with a worse trigger, because the cost
already spent is exactly the cost that would be lost.

That leaves the owner's actual question, which is not "should this run stop"
but "is this run costing what I expected". A stamp answers it while the run is
still spending, and the decision to kill stays where every other kill lives:
with the human, through the console.

## Why loud, and not queued

The queued stream is the escalation queue: its items wait on a human, a park
until it is answered, a breach until it is resolved, and the frontier and the
console both read it as work owed. A budget breach owes nothing. Put there, it
would sit in the queue asking for an action that changes nothing, and the
queue would stop meaning what it means.

The loud stream is what the owner is shown at once. That is precisely the
requirement — the owner is watching money leave and nothing else in the run
will mention it. The one thing loud carries that a breach does not need is the
paired resolution, so the run appends it at close: the alert did its work
while the run was live, and a strip of alerts about finished runs would train
the owner to ignore the strip.

That close is now a shared route rather than a budget special case. The
capture take-back (ADR-0017) reports the same way — loud while the run is
live, answerable by nobody, over when the run is over — so both events sit in
one registry set the close reads.

## Why a memo now, and what it supersedes

ADR-0005 decided that a degrade does not remember the rejection window, on the
arithmetic that a rejection costs nothing and returns in about two seconds.
The arithmetic was right and the conclusion no longer holds: one run was
measured making four identical model-unavailable-then-degrade cycles, because
every seat rediscovered the same wall, and the run's own ledger already held
the answer each time. **That section of ADR-0005 is superseded here.**

What the earlier decision was protecting is kept whole. Its fear was a seat
that quietly changes who judged the work — a degrade on cached state rather
than on evidence. The memo is not cached state: it is the run's ledger, read
back, which is the same record a resumed run reads to know anything at all. It
is replay-safe by construction, and it stamps `model-degraded` exactly as the
fresh path does, with `memo: true` naming the evidence it stood on. A reader
of the ledger still sees every degrade, and now also sees which ones cost a
spawn to discover.

`resetsAt` is the one time comparison this adds, and it is a fact rather than
a measurement: the vendor declared the instant, and the memo asks whether the
instant has arrived. Nothing here measures elapsed time, and no state expires
on a clock of the harness's own. Without a recorded instant there is no memo,
and the seat tries its model.

## Fallback paths

If a threshold turns out to be wanted as a decision point after all — the
owner repeatedly killing runs seconds after a breach — the breach grows a park
option behind an explicit `parkOnBreach` flag, defaulting off, so gating is a
project's stated choice and never the default. Trigger: three breaches
followed by a human kill inside a few minutes. Reversal cost: low, one
directive at the crossing.

If one stamp per run proves too quiet on a run that keeps climbing — a breach
at $160 and a close at $500 — the stamp gains multiples of the threshold, one
stamp per multiple, still informational. Trigger: one run closing past twice
its budget. Reversal cost: low, the crossing test reads a multiplier.

If the memo degrades a seat the vendor would have served — a `resetsAt`
that overstates the window, or a quota that returns early — drop the memo and
pay the rejection back, exactly as ADR-0005 had it. Trigger: a `model-degraded`
stamp with `memo: true` on a run where the same model later served another
seat. Reversal cost: none, delete one condition at the spawn.
