# ADR-0007: Verdict, repair, and review shapes

Status: accepted (2026-08-10, the approach finding and the repair heading
2026-09-04, the records out of the verdict 2026-09-07, one severity rule
2026-09-10)

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
  (`F<n>`) and the ground it rests on, which is the files and directories the
  claim is about (ADR-0085). The split that decides what a round blocks on is
  severity, on every lane and whatever the finding is about. A HIGH blocks when
  it is confirmed; a finding below HIGH stamps `advisory` and blocks nothing. A
  code round confirms a HIGH through the verifier, and a refuted one stamps
  `confirmed: false` beside the verifier's evidence. A record round confirms a
  HIGH as its reviewer raised it and spawns no verifier (ADR-0080). A finding
  about a decision record carries `record: true`, the `criterion` it cites, and
  the unit it is about (`unit`, `head`, `line`, and a second place on a
  `consistent` finding), at every grade. A HIGH one enters the open set of the
  render it belongs to. One below HIGH is a remark: the render lists it under
  `advisory`, the corrective round that writes that record for a HIGH hands it
  to the writer, and the run records what it ships with at the close. Every run
  names on `run-closed.remarks` the findings it left standing, by id: the
  remarks, and the confirmed HIGHs no round answered. The finding stamp keeps
  `confirmed: true` on the second kind, so a reader tells them apart, and the
  merged request's body lists them under two headings. A ticket is owed for a
  record the judge owed and no round wrote, and for nothing else. A record
  finding is raised by the record review of the reconcile stage and by no code
  lens (ADR-0026, ADR-0075). The verdict's own open set travels in
  `verdict-rendered.open`. The record file (`runs/<id>/verdict-<cycle>.json`)
  carries the spectrum, the open and just-resolved findings, and the flake list.
  It holds confirmed findings only; advisory material stays in the ledger.
- **Review composition per cycle.** First cycle of an implementation pass:
  the Fury fan-out over the panel the project declares (`review.lenses`),
  fully parallel, then the verifier on that round's items. The default panel
  is spec, operational and interface, with the security lens riding the
  operational seat and the interface seat conditional on a diff under
  `repo.uiPaths` (ADR-0038). Repair cycles: the generalist review seat over
  the repair diff plus a verifier resolution-check on prior confirmed
  findings; new items go through confirm-to-block. Cycles after only a
  re-freeze or an operational fix fire no judgment seats, because the tree did
  not change. No re-fan-out over a judged tree, in either lane. The repair lane
  uses the generalist seat from cycle one and never the fan-out. No review of
  this stage reads a decision record: the code review's file list drops every
  record path at the caller, and the record round of the reconcile stage is the
  one reader of one (ADR-0026).
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
  it left open, measured on finding identity (ADR-0022). Open findings past the
  cap stall (`cap-exhausted`). State-based, never wall-clock.
  `repairStalled` is exported, because the reconcile stage counts its own rounds
  under the same rule.
- **One cap, and it is the code cap of 3.** No diff this stage judges is a record
  diff. A record is judged in the reconcile stage and nowhere else, and that
  stage counts its own `reconcile-round` stamps against `gates.reconcileRounds`
  (ADR-0075). The two counts never read each other's rounds: a pass that spent
  code rounds keeps its record rounds, and a pass that spent record rounds keeps
  its code rounds. Every `repair-round` stamp carries the `cap` it counted
  against.
- **A record round never reaches this ladder.** The verdict reads no record
  stamp at all. It stamps no `implementation-committed` with `phase:
  'reconcile'`, it derives its `moved` clause without a record read, and it holds
  no reconcile arm. A corrective record round therefore buys no code cycle, and a
  repair round leaves the record certification to the recheck the stage owes it.
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
  the daemon appends the paired `resolved` line. At the close of a merged run,
  in both lanes, the harness counts the HIGH findings that carry
  `advisory: true` on a file under `repo.recordPaths`. The count is always zero,
  because a HIGH on a record is confirmed as its reviewer raised it and takes no
  advisory word. A count above zero stamps
  `gate-integrity` under the `record-finding-shipped` kind: loud, and owned by a
  person. It says the split above stopped classifying, or that the project's
  record paths name a tree its reviews do not read. A remark on a record is
  outside this count: it is advisory by rule, and the ticket carries it.
- **Test-edit boundary, both directions.** Story-lane dev seats carry the deny
  rules over the test paths and the record paths, and the evaluation path
  restores the test paths from the frozen sha before every commit and every
  spectrum run. The repair-lane fix seat carries the record paths alone: the
  regression test is its work, and no decision record is (ADR-0074).
- **Parallel seats.** The engine tracks a run's in-flight seats as a set:
  the liveness invariant, kill, and stop cover every child of a parallel
  fan-out.

## Why one severity rule covers every lane

The grade is what a round costs. A HIGH says the finding must block, and a
confirmed one buys the round that answers it. Everything below HIGH is a remark:
it is worth less than a round, so nobody must act on it, and the rule reads the
same whether the finding is about a diff or about a document.

A rule that read severity **or** record buys a round for every grade a review
writes about a document. A cycle over a set of records raises a few sentences the
tree contradicts and many remarks about wording, and each of them dispatches a
writer over its record and buys the cycle that reads it again. The work is the
few; the cost is the many. Under the one rule the round dispatches the records a
HIGH names and the cycle reads those.

A remark is not thrown away, which is the other half of the rule. It is stamped
with the record word, the criterion and the unit, so it names one sentence. The
corrective round that writes its record for a HIGH is handed it in the same
brief, under one line that says it holds no render red; the writer answers it in
the write it is making anyway, or lists its id under `answered` where the record
is right as written. The render it belongs to lists it under `advisory`, and the
run records at its close what it shipped standing. A remark thrown away is a
finding the next run raises again, at whatever grade that run reads it.

What this accepts is that MED is the grade nobody must answer. A record can ship
with a sentence the tree contradicts, if a review graded that sentence MED. Three
things stand against it: the review brief states what HIGH means, so the grade is
a definition and not a feeling; the close records the remarks that shipped; and
the eval seat reads that set by criterion and unit, where a `truth` remark on a
sentence of a Decision is the reading that says the grade rule needs tightening.

A confirmed HIGH the round could not answer ships the same way. The harness
blocks no run on a record (ADR-0080), so the ending is a merge with the finding
named: the request body lists it under "Findings not answered", the close stamps
its id, and the finding stamp keeps `confirmed: true`. The eval question is
whether a later run raises the same unit again.

The guard against a wrong block on a record is the writer's own dispute. A
review can read a record's own explanation of an inversion as the inversion, and
a writer that reads the finding and finds the record right says so under the
finding's id, in one sentence. The next cycle's reviewer reads that record fresh
and either raises the finding again or does not. On a code round the guard is
still the verifier: the tripwires in ADR-0010 read the refuted share over the
findings it answered.

## Why this ladder counts one cap

A round that rewrites a document and a round that rewrites code are two kinds of
work under one name, and each has its own number. The record rounds run in a
stage of their own, over a tree of their own, at a sha of their own (ADR-0075),
so this ladder judges code and counts one cap.

Three is the number for that work. A code round buys a dev seat over a candidate
tree and a full cycle behind it, and a fourth round that has closed nothing says
the tree is the suspect rather than the brief.

Five is the number for the other work, and the reconcile stage holds it. A record
round is one seat per record and the record layers behind it. On a project whose
layers declare their grounds that is one layer, which takes seconds. What stands
behind that cap is expensive: a ticketed rewrite in a run of its own. So five
rounds cost less than the ending, and the progress rule stops a round that is
going nowhere at once.

The counts stay apart by construction rather than by a derivation. A story that
spent two code rounds keeps its record rounds, because the two arms read two
event names.

A record round never buys a fresh pass. A pass resets the tree to the commit it
was born on, which throws away an implementation a verdict already certified,
over a document. The stage's own fallback keeps the certified code instead.

## Why an approach finding buys a repair round and not the pass

The pass is the expensive thing on this ladder. A repair round is one seat
over a tree that already exists; a fresh pass throws that tree away and buys
the whole implementation again, and it is the run's only one.

An immediate discard costs every other finding the render left open. One
confirmed finding about one input can stand beside a dozen the repair round
would have carried, and none of them reaches the tree that replaces it: the
fresh pass begins from the freeze with a stall brief, and the rest come back as
whatever the new implementation raises. The run then buys a second
implementation to answer a finding a repair round could have answered, and it
spends its one pass on it, so a stall that comes later has nothing left to buy.

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

If the one severity rule proves to ship contradictions as remarks, grade by
criterion instead: a `truth` finding on a sentence of a Decision is a HIGH by
rule, whatever the seat wrote. Trigger: a shipped remark that a later run raises
again as a confirmed HIGH on the same unit. Reversal cost: low, one condition in
the split, and the `record` word and the criterion stay on the finding either
way.

If the reconcile stage proves too expensive for the story that pays it, set
`gates.reconcileRounds` to 1: one corrective round, then the fallback and the
ticket. The same value bounds a records-lane run, which then takes one round and
stalls. Trigger: an owner who wants the shorter arm. Reversal cost: one config
value.

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
