# ADR-0007: Verdict, repair, and review shapes

Status: accepted (2026-08-10)
Superseded in part by ADR-0015: a seat-failure and a gate-command spawn
error park the run instead of closing it.
Superseded in part by ADR-0022: only the first cycle of an implementation
pass runs the full spectrum; later cycles run the targeted set and carry the
greens no red reaches.
Superseded in part by ADR-0038: the review panel is the project's
`review.lenses`, the default panel drops architecture and minimality, and the
security lens rides the operational seat instead of one of its own — so the
fan-out below is stated at a width the harness no longer runs by default.
Superseded in part by ADR-0022: the repair progress rule keys on finding
identities — a round is a stall when it closes none of the findings the render
before it left open — and not on the size of the open set, so the sections
below that measure progress as cardinality state a rule the harness no longer
runs.

## Decision

The post-freeze chain — implementation, full-spectrum verdict, response
ladder, judgment review — gets these concrete shapes:

- **Lane composition.** `postFreeze({afterVerdict})` builds the story-lane
  continuation: `implementation` → `verdict` → a caller-supplied ship
  continuation. `repairLane({afterVerdict})` builds the repair lane: `fix` →
  `verdict` → continuation. The two lanes share the verdict machinery; a
  mode flag selects the differences (below).
- **Two new registry events.** `implementation-committed` (pass, phase
  `initial` | `fresh` | `repair`, baseSha, sha) anchors every dev-seat
  commit and names the diff base for the review seats.
  `verdict-rendered` (cycle, pass, sha, verdict, open finding ids, record
  path) is the cycle boundary and the resume anchor of the verdict loop.
- **Verdict cycles.** Cycle number = rendered verdicts + 1. A new cycle runs
  when no verdict exists yet or when a cycle trigger landed after the last
  one: `implementation-committed`, `re-freeze`, or `operational-fix`. The
  ladder acts only on a rendered red verdict with no pending trigger, so a
  daemon restart re-derives its place from the ledger alone. One condition
  outranks a trigger: a render whose open suite defects have earned no
  `re-freeze` yet still owes that amendment, and the ladder re-enters to
  deliver it before any cycle starts.
- **Full spectrum** (ADR-0022 narrows this to the cycles that need it).
  Every Tier-1 layer (project config `gates.tier1`) runs
  to completion per cycle. A layer whose prerequisite failed stamps
  `not-runnable`, attributed through the `needs` chain to the root red. The
  flake filter re-runs each red layer once; a green re-run stamps `flake`
  and never a finding. Layer results stamp per layer under the cycle, so a
  restart mid-spectrum skips judged layers. A layer command that cannot
  spawn closes the run (`gate-command-error`) — an environment defect, not
  a verdict.
- **Verdict triage.** Fires only on persistent reds. The seat clusters reds
  into findings by root cause and classes each — `code-defect` |
  `suite-defect` | `env` | `harness` — with cited evidence; suite-defect
  findings carry a depth (`test` | `spec` | `intent`). Prior open triage
  findings are handed in with ids; the seat lists persisting ids and reports
  only new findings. Deterministic checks (every red layer covered, depths
  present, persisting ids known) take the contract-loop route: one
  corrective invocation, then seat-failure. A green spectrum resolves triage
  findings mechanically — their evidence is gone.
- **Findings.** Every finding stamps a `finding` event with a run-scoped id
  (`F<n>`). Sub-HIGH review findings stamp `advisory` and never block or
  verify. HIGHs go to the verifier; a refuted HIGH stamps advisory, a
  confirmed HIGH blocks. The open set travels in `verdict-rendered.open`;
  the record file (`runs/<id>/verdict-<cycle>.json`) carries the full
  spectrum, the open and just-resolved findings, and the flake list —
  confirmed findings only, advisory material stays in the ledger.
- **Review composition per cycle.** First cycle of an implementation pass:
  the five-seat Fury fan-out (six lenses; architecture + minimality merged
  on the code-shape seat with per-lens reporting; interface conditional on a
  diff under `repo.uiPaths`), fully parallel, then the verifier on that
  round's HIGHs. Repair cycles: the generalist review seat over the repair
  diff plus a verifier resolution-check on prior confirmed HIGHs; new HIGHs
  go through confirm-to-block. Cycles after only a re-freeze or an
  operational fix fire no judgment seats — the tree did not change. No
  re-fan-out over a judged tree, in either lane. The repair lane uses the
  generalist seat from cycle one and never the fan-out.
- **Response ladder.** Order per red verdict: intent conflicts park
  (`intent-conflict`); env/harness findings get one `operational-fix` stamp
  each, and a finding that persists past its fix parks `provisioning-gate`
  (the daemon never self-clears substrate); suite defects re-freeze;
  code-defect and confirmed review findings take a repair round. A batch may
  combine routes; every route re-enters through a fresh cycle.
- **Repair rounds.** The repair-dev seat fixes the candidate tree in place
  with the verdict and open findings as brief. Progress rule: the open set
  size must strictly shrink per round, else `stall` (`no-progress`). Cap 3
  rounds per implementation; open findings past the cap stall
  (`cap-exhausted`). State-based, never wall-clock.
- **Re-freeze step.** Depth-`spec` and answered-intent findings amend the
  born spec (birth seat) first; the suite seat then amends the tests under
  the contract loop (changes only under the test paths), committing as
  `suite-committed` phase `re-freeze` plus a `re-freeze` stamp that moves
  the suite sha. A spec amendment that failed its own lint is owed again: the
  step reads the seat's failure record beside its report, so a defective
  amendment never passes for a completed one. No budget, no judgment seats.
  Loop safety: a suite-defect finding that survives its re-freeze routes to
  the stall arm (`re-freeze-no-progress`) instead of a second re-freeze.
- **An intent ruling reaches the frozen suite, once, on the record.** The
  `intent-conflict` park asks the owner to name the frozen test file the
  ruling amends. The ruling then rides the re-freeze that follows it: the spec
  seat writes the supersede clause, the suite seat is briefed with the ruling
  verbatim and with every frozen suite file the ruling names, and a pass that
  leaves one of those files unchanged is a work-product defect by name. The
  `re-freeze` stamp records the ruling it carried (`ruling`: the park, the
  answer, the actor, the files), which is also what makes it spent — no later
  amendment carries the same answer twice. A ruling that names no frozen file
  rides the spec amendment alone, as it always did.
- **Fresh pass.** Triggers: any stall, or a confirmed approach-level finding
  (`approach: true` — the finding names the implementation structure as
  wrong against the spec; the approach flag only counts on confirmed
  findings). One per run. The worktree hard-resets to the freeze sha, the
  current frozen suite is carried forward, and the dev seat gets born spec +
  frozen suite + stall brief — never the prior tree. The reset precedes the
  `fresh-pass` stamp, so a restart between them redoes the idempotent reset.
  Findings of the discarded pass drop from the open set at the next render.
- **Second stall.** Parks `second-stall` with options `repair-again` (one
  granted round past the cap), `fresh-pass` (one granted extra pass), or
  `fail`. Grants are counted from answer events; no default answers.
- **Gate integrity.** A harness-class triage finding also stamps
  `gate-integrity` (loud, streamed). When the finding leaves the open set,
  the daemon appends the paired `resolved` line.
- **Test-edit boundary, both directions.** Story-lane dev seats carry the
  deny rules and the evaluation path restores the test paths from the
  frozen sha before every commit and every spectrum run. The repair-lane
  fix seat gets no deny rules — the regression test is its work.
- **Parallel seats.** The engine tracks a run's in-flight seats as a set:
  the liveness invariant, kill, and stop cover every child of a parallel
  fan-out.

## Why the ladder batches routes instead of one route per cycle

A verdict can carry findings of several classes. Serializing one route per
cycle would re-run the spectrum between the re-freeze, the operational
fix, and the repair — deterministic re-runs are cheap, but each cycle also
costs the triage seat. Batching applies every applicable route, then one
cycle re-judges the joined result.

A batch that stops between routes is the case this shape has to get right. An
arm that parks leaves the arms behind it unrun while the arms in front of it
have already stamped, and a stamp is a cycle trigger. Read as a trigger alone,
the resumed loop would start a cycle over inputs the unrun arm was about to
change — for the suite arm, a spectrum over an unamended suite, which renders
the finding again and parks the same question again, forever. So the ladder's
own preconditions outrank the trigger: an owed re-freeze re-enters the ladder,
and each arm reads its own record for this render to know it has already run.

## Why the progress rule compares set sizes

"Strictly shrink" is measured as cardinality: fixed findings minus new
findings must be net negative. Identity-based shrink (proper subset) would
stall a round that fixes every prior finding while the review surfaces one
new one — that is progress, not a stall. Size comparison keeps the rule
mechanical and resume-derivable from two `verdict-rendered` stamps.

## Why operational fixes park instead of looping

The map bounds repair rounds and fresh passes but not operational fixes. An
env red that survives its re-run would loop the fix arm forever. One fix per
finding, then `provisioning-gate`: substrate repair beyond a re-run is
provisioning work, and the provisioning rule stands — report and wait, never
self-clear.

## Fallback paths

If size-based progress proves too lenient (rounds churn by trading one
finding for another), switch to proper-subset shrink. Trigger: repeated
3-round cap exhaustions whose open sets rotate members. Reversal cost: low —
one comparison in the ladder.

If the merged code-shape seat under-reports one of its two lenses, the
per-lens yield tripwire (project config) restores the split seats; the seat
map change is one registry entry. Trigger: an escapes-ledger entry in the
merged lenses' categories inside the watch window.

If resetting the run branch for the fresh pass proves too destructive in
practice (evidence wanted from discarded trees), tag the old head
(`refs/olympus/pass-<n>`) before the reset. Trigger: an eval review asks for
a discarded tree. Reversal cost: low — one tag command before `resetHard`.

If the repair lane needs the full fan-out for a class of tickets, route by a
ticket label to `postFreeze`'s review mode. Trigger: an escaped defect whose
fix ref traces to a repair-lane run inside the first 10. Reversal cost:
moderate — mode becomes per-run instead of per-lane.
