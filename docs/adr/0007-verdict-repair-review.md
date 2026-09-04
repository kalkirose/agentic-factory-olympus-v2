# ADR-0007: Verdict, repair, and review shapes

Status: accepted (2026-08-10, the approach finding and the repair heading
2026-09-04)

## Decision

The post-freeze chain — implementation, verdict, response ladder, judgment
review — gets these concrete shapes:

- **Lane composition.** `postFreeze({afterVerdict})` builds the story-lane
  continuation: `implementation` → `verdict` → a caller-supplied ship
  continuation. `repairLane({afterVerdict})` builds the repair lane: `fix` →
  `verdict` → continuation. The two lanes share the verdict machinery; a
  mode flag selects the differences (below).
- **Two registry events anchor the chain.** `implementation-committed` (pass,
  phase `initial` | `fresh` | `repair`, baseSha, sha) anchors every dev-seat
  commit and names the diff base for the review seats.
  `verdict-rendered` (cycle, pass, sha, verdict, open finding ids, record
  path) is the cycle boundary and the resume anchor of the verdict loop.
- **Verdict cycles.** Cycle number = rendered verdicts + 1. A new cycle runs
  when no verdict exists yet or when a cycle trigger landed after the last
  one: `implementation-committed`, `re-freeze`, or `operational-fix`. The
  ladder acts only on a rendered red verdict with no pending trigger, so a
  daemon restart re-derives its place from the ledger alone. Two conditions
  outrank a trigger: a render whose open suite defects have earned no
  `re-freeze` yet still owes that amendment, and the ladder re-enters to
  deliver it before any cycle starts; and a step of the ladder a stop
  interrupted is dispatched again before anything is judged (ADR-0070).
- **The spectrum per cycle.** Every Tier-1 layer (project config
  `gates.tier1`) the cycle runs runs to completion; the first cycle of an
  implementation pass runs the full set and a later cycle runs the targeted
  set and carries the greens no red reaches (ADR-0022). A layer whose
  prerequisite failed stamps `not-runnable`, attributed through the `needs`
  chain to the root red. The flake filter re-runs each red layer once, asking
  for the parts and the files the replaced attempt failed on (ADR-0065); a
  green re-run stamps `flake` and never a finding. Layer results stamp per
  layer under the cycle, so a restart mid-spectrum skips judged layers. A
  layer command that cannot spawn parks the run (`command-error`, reason
  `gate-command-error`): an environment defect is not a verdict, and it is not
  a close either (ADR-0015).
- **Verdict triage.** Fires only on persistent reds. The seat clusters reds
  into findings by root cause and classes each — `code-defect` |
  `suite-defect` | `env` | `harness` — with cited evidence; suite-defect
  findings carry a depth (`test` | `spec` | `intent`). Prior open triage
  findings are handed in with ids; the seat lists persisting ids and reports
  only new findings. Deterministic checks (every red layer covered, depths
  present, persisting ids known) take the contract-loop route: one
  corrective invocation, then the `seat-failure` park. A green spectrum
  resolves triage findings mechanically — their evidence is gone.
- **Findings.** Every finding stamps a `finding` event with a run-scoped id
  (`F<n>`). Sub-HIGH review findings stamp `advisory` and never block or
  verify. HIGHs go to the verifier; a refuted HIGH stamps advisory, a
  confirmed HIGH blocks. The open set travels in `verdict-rendered.open`;
  the record file (`runs/<id>/verdict-<cycle>.json`) carries the spectrum,
  the open and just-resolved findings, and the flake list — confirmed
  findings only, advisory material stays in the ledger.
- **Review composition per cycle.** First cycle of an implementation pass:
  the Fury fan-out over the panel the project declares (`review.lenses`),
  fully parallel, then the verifier on that round's HIGHs. The default panel
  is spec, operational and interface, with the security lens riding the
  operational seat and the interface seat conditional on a diff under
  `repo.uiPaths` (ADR-0038). Repair cycles: the generalist review seat over
  the repair diff plus a verifier resolution-check on prior confirmed HIGHs;
  new HIGHs go through confirm-to-block. Cycles after only a re-freeze or an
  operational fix fire no judgment seats — the tree did not change. No
  re-fan-out over a judged tree, in either lane. The repair lane uses the
  generalist seat from cycle one and never the fan-out.
- **Response ladder.** Order per red verdict: intent conflicts park
  (`intent-conflict`); env/harness findings get one `operational-fix` stamp
  each, and a finding that persists past its fix climbs the substrate ladder
  and parks `provisioning-gate` only when the waiting is spent (ADR-0069);
  suite defects re-freeze; code-defect and confirmed review findings take a
  repair round. A batch may combine routes; every route re-enters through a
  fresh cycle.
- **Repair rounds.** The repair-dev seat fixes the candidate tree in place
  with the verdict and open findings as brief. Progress rule: a round is a
  stall (`no-progress`) when it closed none of the findings the render before
  it left open, measured on finding identity (ADR-0022). Cap 3 rounds per
  implementation; open findings past the cap stall (`cap-exhausted`).
  State-based, never wall-clock.
- **A finding about the shape rides the repair brief.** A confirmed finding
  that names the implementation structure as wrong against the spec
  (`approach: true`) is a code finding like any other on the ladder. It rides
  the repair brief ahead of the rest, under the heading "structural finding:
  the reviewer names the implementation shape as wrong against the spec" and
  one line that says the round may change the shape rather than patch around
  it. It buys no pass of its own; what buys a pass is the round behind it
  that closed nothing.
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
  rides the spec amendment alone.
- **Fresh pass.** Trigger: a stall, of any of its reasons. One per run. The
  worktree hard-resets to the freeze sha, the current frozen suite is carried
  forward, and the dev seat gets born spec + frozen suite + stall brief —
  never the prior tree. The reset precedes the `fresh-pass` stamp, so a
  restart between them redoes the idempotent reset. Findings of the discarded
  pass drop from the open set at the next render.
- **Second stall.** Parks `second-stall` with options `repair-again` (one
  granted round past the cap) and `fresh-pass` (one granted extra pass),
  beside the `abandon` every run park offers. Grants are counted from answer
  events; no default answers.
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

## Why an approach finding buys a repair round and not the pass

The pass is the expensive thing on this ladder. A repair round is one seat
over a tree that already exists; a fresh pass throws that tree away and buys
the whole implementation again, and it is the run's only one.

The ledger says what the immediate discard cost. One confirmed interface-lens
finding about a single form input discarded a pass that had twelve other
findings open against it. Every one of those twelve was work the repair round
would have carried, and none of them reached the tree that replaced it: the
fresh pass began from the freeze with a stall brief, and the twelve came back
as whatever the new implementation raised. The run bought a second
implementation to answer a finding a repair round could have answered, and it
spent its one pass on it, so the stall that came later had nothing left to buy.

The severity of a structural finding is real, and it is answered by saying so
in the brief rather than by discarding the work. A repair seat told that the
shape is wrong, in a heading of its own, may rewrite the shape; it holds
everything else the round already knows. If the round cannot answer it, the
round closes nothing, and the progress rule takes the pass on the next render
— one cycle later, on evidence rather than on a flag.

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

## Why operational fixes never loop

The map bounds repair rounds and fresh passes but not operational fixes. An
env red that survived its re-run would loop the fix arm forever. One fix per
finding; past it the finding climbs the substrate ladder, which re-runs the
layers behind the host's own probe and ends either green or spent (ADR-0069).
A spent ladder is provisioning work, and the provisioning rule stands — report
and wait, never self-clear.

## Fallback paths

If the repair round proves unable to answer structural findings — rounds that
close every finding but the approach one, cycle after cycle — the immediate
fresh pass returns as a route the ladder takes when the approach finding is
the only one left open. Trigger: three runs whose repair rounds close every
other finding and leave the approach finding standing. Reversal cost: low —
one condition in the code arm, and the heading stays either way.

If resetting the run branch for the fresh pass proves too destructive in
practice (evidence wanted from discarded trees), tag the old head
(`refs/olympus/pass-<n>`) before the reset. Trigger: an eval review asks for
a discarded tree. Reversal cost: low — one tag command before `resetHard`.

If the repair lane needs the full fan-out for a class of tickets, route by a
ticket label to `postFreeze`'s review mode. Trigger: an escaped defect whose
fix ref traces to a repair-lane run inside the first 10. Reversal cost:
moderate — mode becomes per-run instead of per-lane.
