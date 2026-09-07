# ADR-0026: Decision-record reconciliation rides the ship

Status: accepted (2026-08-15, the pre-ship placement 2026-09-06, the stage of
its own 2026-09-07)

## Decision

Every shipped run gets a fresh-context judgment on whether its diff implements or
contradicts any decision record. Where it does, the same run rewrites those
records on its own branch and ships them in its own pull request. The default
branch moves once per shipped story.

- **The judgment opens a stage of its own.** `reconcile` stands between the
  verdict and the update in the story and repair lanes, and after `records` in
  the records lane. Its module is `src/lanes/reconcile.mjs` and its steps,
  restart rules and certification are ADR-0075. The stage's first step runs
  `reconcile-judge` against the run branch's diff with the default branch
  (`git diff <defaultBranch>...HEAD`), in the run worktree. The default branch is
  fetched first, so the merge base behind that diff is the branch as it stands
  and work the run merged in earlier does not read as its own. The seat locates
  the repository's decision-record tree itself, commonly `docs/adr/`; a
  repository without one is judged not-owed with that as the reason.
  Implementation counts even when the diff never touches the record files, which
  is the case a path filter can never see and the reason this is a seat and not a
  glob.
- **Both verdicts stamp.** `reconciliation-judged` carries `owed`, the judged
  `records`, and the `reason`. It splits the judged list into `born`, the records
  this run wrote before its freeze, and `late`, the rest (ADR-0074). A failed
  judgment stamps `ok: false` with the cause: an unjudged ship is a recorded
  miss, never a silent skip. No outcome blocks the ship.
- **Owed writes the records, one seat per record.** `reconcile-write:<n>` runs in
  the run worktree, in fresh context, once per judged record, in sequence. Its
  brief states the record criteria from the registry, verbatim, because those are
  the criteria the review reads its work against (ADR-0038); beside them it
  states the unit duty (ADR-0073), the neighbourhood by path, the lifecycle rule,
  that the divergence goes in the report as well as in the record, and that
  nothing outside the record tree is edited. The seat reports the records it
  rewrote, the records it left alone with the reason for each, one divergence
  entry per judged record, and one entry per unit.
- **The write is contained by checks.** `writeChecks` in `src/lanes/records.mjs`
  runs on the lane contract loop, before any commit: every changed file sits
  under the directory of a judged record, every judged record is accounted for
  once, every record the seat calls rewritten really changed, every judged record
  has exactly one divergence entry, and every entry the seat marks `named`
  carries a statement the record file holds. The unit checks, the supersede
  checks and the sibling checks run beside them. `reconciliation-written` records
  the outcome, the declaration and one entry per record with its seat, cost,
  attempts and units answered.
- **The divergence declaration is proved against the files.** Each entry names a
  judged record, the word `none` or `named`, a statement, and the evidence. For
  `named` the statement is the sentence the seat wrote into the record, and the
  check finds that sentence in the file. Records wrap at 80 columns, so the
  comparison normalises whitespace on both sides: every run of whitespace, line
  breaks included, reads as one space. For `none` the statement is the seat's
  one-sentence reason it found no divergence. What no check can see is a
  divergence nobody named, and the review judges that under its `divergence`
  criterion.
- **The record set is the pass's whole record diff.** `recordScope(worktree,
  from, to, recordPaths, {lifecycle})` in `src/lanes/records.mjs` reads the
  record files changed in a range. The range opens at the pass's own opening sha
  and ends at the sha the stage judges, so every record the pass has touched is
  read on every cycle until the stage is green. Under the supersede lifecycle a
  closed record leaves the scope. The code review's file list holds no record
  path: a record is judged in this stage and nowhere else.
- **A record is reviewed by a seat of its own, and no seat is given a diff.**
  `recordReviewRound` in `src/lanes/review.mjs` fans out one `record-review:<n>`
  per record file, in parallel, as the Fury panel fans out per lens. Each brief
  carries the record path, the harness's unit list, the criteria under
  `RECORD_RULE`, the spec or ticket, the neighbourhood by path with the count
  above the cap, and the unit heads this round moved. It carries no diff text.
  Each seat runs under the unit checks, so a report that leaves a unit unanswered
  reaches no verifier. A `consistent` finding that names one record, and a
  finding on a closed record, are work-product defects rather than findings.
- **`repo.recordPaths` names the record tree.** It is an optional list of path
  entries in the project config, in the vocabulary of `repo.testPaths` and
  `repo.uiPaths`, and it defaults to `['docs/adr']`. An entry may carry an `!`
  prefix for an exclusion, and `recordPathIncludes` in
  `src/config/project.mjs` is the one membership test. It decides the scope of
  the reconciliation, the tree the dev seats are denied (ADR-0074), the paths a
  record layer is attributed to (ADR-0022), and the neighbourhood the criteria
  are read against. Neither the reconciliation judge nor the write seat's
  containment check reads it, so discovery still decides which records get
  rewritten and where the seat may write.
- **A confirmed record finding buys a corrective round.** The ladder does not
  call `repair-dev`: that seat implemented the code, and the context that
  implemented the work never reconciles the records against it. The stage
  dispatches `reconcile-write:<n>` again instead, per record, with the open
  findings and the standing divergence declaration. The corrective report carries
  `answered`, the finding ids it answered. The round stamps `reconcile-round` and
  counts against `gates.reconcileRounds`, default 5. The verdict's own repair cap
  never reads these rounds.
- **A stall at the cap takes the fallback, and asks nobody.**
  `reconciliation-written` carries `ok: false` with a cause from the closed set
  `record-cap`, `operator` and `work-product-defect`. The cap fallback carries
  `partial: true` and `residual`, the ids of the confirmed record findings still
  open, and the record commit ships: the judge found the old records owed, and
  discarding the rewrite would ship those. `reconcile-stall` is a loud item, and
  the routes behind the fallback are ADR-0075.
- **The ship needs a green over the records.** `certifiedTrees` reads two
  certifications, each at its own sha, and the admission gate requires both the
  lane holds. A tree that opens a request is a tree a verdict certified and a
  record tree a reconciliation certified.
- **The stage is in front of the token.** The judgment, the writes and the
  cycles all run before the run queues for the ship token, so none of them holds
  another run of the project out of its merge.
- **A write nobody can make never costs the run its code.** A work-product defect
  past its corrective round takes the fallback with no person asked, on both the
  first write and a corrective one. A seat that never delivered a report parks
  `seat-failure` offering `retry`, `ship-without-records` and `abandon`;
  `ship-without-records` takes the same fallback and requires the operator's
  reason (ADR-0062).
- **The close writes the ticket for records that did not ride.** The close-out
  judges nothing. Where the run was judged owed and the records did not ride the
  merge whole, it writes `tickets/reconcile-<runId>.md` naming the merge commit,
  the judged records and the rewrite rules, then stamps a second
  `reconciliation-judged` line carrying the ticket and the cause. Where the
  records rode the merge with a residual, the ticket carries those findings
  alone: each id, criterion, text, evidence and verifier confirmation, and the
  record it is about. The ticket before the stamp: a stamped ticket always exists
  to launch from (ADR-0024's ordering). The rule reads the ledger and not the
  route, so it covers every way the records could have been lost. A ticket the
  close cannot write stamps `gate-integrity` under the `reconciliation-lost`
  defect kind: loud, and owned by a person.
- **The sweep launches the ticketed ones on the records lane.** The owed set
  derives at every sweep from the run ledgers alone: shipped story runs whose
  judgment carries a ticket, minus the ships some reconciliation run's launch
  stamp (`reconcilesRunId`) already names. Both ticketed lanes are read for that
  second half, because the reconciliations launched before the records lane
  existed ran on the repair lane. The set is stored nowhere and is
  restart-idempotent (the owed-repairs shape, ADR-0024). The pass runs after
  breach repairs and before the story frontier: defects on shipped code first,
  record hygiene second, new work third. A slot-blocked reconciliation stands the
  story pass down, stays owed, and the next sweep launches it.
- **The ticketed rewrite is a records-lane run.** The ticket is the spec, the
  lane holds no dev seat and no code verdict, and the rewrite ships through its
  own pull request. A launched-and-failed reconciliation is not owed again: like
  a spent repair, it is a console decision.
- **A fresh pass owes the round again.** A fresh pass resets the tree to the
  commit the pass is born on, so the judgment, the writes and the record commit
  are all statements about a tree that is gone. Every one of them is read as live
  only while no `fresh-pass` stamp follows it. The born records themselves survive
  the reset, because the pass carries them (ADR-0074).

## Why a seat and not automation on paths

The trigger condition, "the diff implements or contradicts a recorded decision",
is semantic. The common case is a diff that implements a decision without
touching the record tree at all; a path filter reads that as nothing happened. A
live cutover run shipped exactly that shape: a payment story implementing several
recorded decisions, records untouched, and no mechanism anywhere that would ever
have noticed. The judgment costs one read-only seat per ship and buys the
guarantee that every ship is either reconciled or visibly owed.

## Why the judgment moved in front of the ship

The judgment used to run at close-out, against the merge commit, and the
rewrite used to be a separate repair-lane run. Every reconciled story
therefore moved the default branch twice, and the second move cost a whole
run: an intake, a seat, a full Tier-1 spectrum, a review, a pull request, a
CI round, a merge and a close, plus a place in the ship-token queue that
every other run of the project waited behind.

The one reason the placement was after the merge is a rule about who writes:
the implementing context must not reconcile records against its own work.
That rule is about context, not about time. A fresh seat inside the story run
never saw the implementation seat's reasoning and reads the committed diff,
so it keeps the rule whole and costs one merge instead of two.

## Why a record gets a seat of its own and none of the code lenses

The review that reads a record used to read it through the panel the project
judges code with. A security lens asked to find input trust and secrets in a
markdown document finds something to say about it, and a spec lens asked whether
the diff implements the validated spec finds that a document does not. While
those findings were advisory they were noise in the ledger. Once every record
finding blocks a ship they are a source of wrong blocks.

The answer is not a better instruction to the same lenses. It is to stop asking
them, and to give the record a seat that reads nothing else. The record criteria
carry one rule and seven criteria under it, and together they are the whole of
what a record is held to. The rule is that a record never conflicts with the
code: everything it states is either true of the tree now, or marked as not yet
built, and a sentence that states why is rationale and is neither. The criteria
divide that rule into what a seat can judge: the implemented parts read as
standalone fact, every present-tense claim is true against the tree, a part the
tree does not implement is stated as not implemented, a divergence is named and
never absorbed, every name and path and symbol the record cites exists, the
record reads as one document rather than a trail of amendments, and no open part
of it contradicts an open part of an active neighbour.

The criterion is load-bearing for the same reason. The verifier is briefed with
the criterion the finding cites and with the list it comes from, and it refutes a
finding whose evidence does not reach that criterion. A finding that cites
`whole` or `fact` and names no sentence of the record is refuted for want of
evidence. Taste is not a criterion.

## Why the review reads the record and not the hunks

A decision record is a set of claims about the code, and a claim it makes is
true or false whether or not this change touched the sentence that makes it. A
seat handed the diff alone does what it is handed: it reads the changed hunks,
opens the code they name, and reports what it finds there. Nothing in that brief
reaches a stale claim three paragraphs above the change.

The ledger holds the cost of that. One reconciliation of four records spent four
review cycles on two of them. Cycle one raised four confirmed findings, cycle
two raised five, cycle three raised four of which two were errors the previous
rewrite had introduced, and cycle four raised two more. Every round closed
everything it was given, so the progress rule never fired, and what ended the
pass was the round cap. The pass that replaced it then rewrote all four records
with the fifteen findings in its brief, which is close to the read the first
review should have made.

Each cycle found the layer the round before it had just moved, because the diff
it was given was the previous round's change. That is the shape of a review
whose scope is the last edit rather than the document. Widening the diff does
not answer it: the whole record was never in any diff. So the file is the scope,
the harness's own unit list says what to answer, one line names the units this
round moved, and the seat is given no diff at all.

The code lenses keep the opposite rule, and keep it for the same reason. A code
diff is the work, and a seat that widens into the repository around it reports
on decisions nobody made this time. A record is not the work: it is a statement
about the work, and the statement is judged whole.

The verifier reads the record too. It is the seat that answers whether a record
and a tree disagree, and a finding it refuted for citing a sentence outside the
diff would refuse exactly the work this scope exists to buy. Its item line quotes
the unit head off the finding, so it opens at the sentence under judgment.

## Why half the divergence rule is mechanical and half is not

The rule "a divergence is never absorbed silently" was carried in two briefs and
enforced nowhere. A live reconciliation named three divergences in its report and
absorbed a fourth; the review caught the one it dropped, and nothing turned that
catch into work.

The half a check can see is whether the sentence the seat says it wrote is in the
file. That is now the declaration and the check over it, and a statement that is
not in the record buys a corrective round.

The half no check can see is whether a divergence exists that nobody wrote a
sentence about. No check can find a sentence nobody wrote. That is the review
seat's work under the `divergence` criterion, and the whole of the record rule is
that its answer now blocks.

## Why the cap fallback keeps the record commit

The judge found the old records owed. Discarding the rewrite ships those: more
known drift, and a ticket that asks a whole run to do the whole rewrite again.
Keeping the rewrite ships the corrected records with a short list of what is
still wrong, and the run behind that list is small.

Under either ending the residual is not fixed before the ship. This is the ending
that ships less drift and costs less to finish.

The old discard fallback is gone with the reset that fired it. A red record layer
is now a red render that a corrective round answers (ADR-0075), so the tree the
stage holds is never thrown away over a layer.

## Why the write seat is contained by checks and not by deny rules

A deny rule cannot say "everything except these directories" without walking
the whole repository and naming every file in it. So the boundary is a check
over what the seat left in the tree, run before anything is committed, in the
shape the card sweep already uses for its own directory. The judged records
are the harness's own list, so their directories are the boundary and no
project has to declare where its records live.

The opposite direction is a deny rule, because there the list is short and
closed: `repo.recordPaths` names the whole record tree, and every seat that
writes code carries it as a deny rule (ADR-0074).

## Why the stage runs the record layers and not the spectrum

A layer's ground is the project's statement of what that layer reads (ADR-0056).
A record commit that touches no file of that ground cannot change what the layer
decided. `gates.recordLayers` states the other half: the Tier-1 layers a changed
record path is attributed to, and no other. So a cycle over a record commit runs
those layers and their prerequisites, and the code layers keep the greens they
earned at their own sha.

A project that names no record layer keeps the selection it had before the key
existed.

## Why not-owed and failed are stamps, not silence

The state before this mechanism was manual intake, and its failure mode was
not a wrong judgment. It was no judgment, invisibly. Any mechanical filter
that silently skips rebuilds that failure mode inside the machine. Three
outcomes, all in the ledger: owed (with what happened to it), not owed (with
the reason), unjudged (with the cause). The eval seat can count all three.

## Why reconciliations sit between repairs and stories in the sweep

A breach repair is a defect users can hit; it outranks everything. A
reconciliation is hygiene on shipped work, but letting new stories launch
ahead of it lets record drift compound under exactly the runs that read those
records for grounding. The frontier is only consulted after both owed sets
are empty or slot-blocked.

## Fallback paths

If the judgment seat proves noisy (owed on every ship, or never), pin its
verdict rate on the eval seat's ledger review and tighten the role block. The
seat's contract (report schema, stamp) does not change. Reversal cost:
prompt-only.

If the judge needs an explicit record tree rather than discovery, pass
`repo.recordPaths` into its role block and the write seat's containment check.
The field exists and the stage reads it; the two seats that decide which
records get rewritten do not. Trigger: a judged-not-owed ship whose repository
holds records somewhere unusual. Reversal cost: low, two role blocks and one
check.

If the in-run rewrite proves too expensive for the story that pays it, return
the rewrite to the sweep: the judgment stays where it is, an owed judgment
writes the ticket at the close instead of running the write seats, and the
records-lane path behind the ticket is untouched. Trigger: the
`reconcile-fallbacks-window` tripwire breaching, which is two or more of the
last ten owed ships ending in a fallback (ADR-0010). The trigger is the
fallbacks and not the reds: a red about the records is what the reviews are for,
and the reading that matters is whether the in-run rewrite can finish what they
raise. Reversal cost: low, the ticket route is the fallback and stays live.

If the record-layer selection proves wrong, empty `gates.recordLayers` and the
stage's cycle plans on the declared ground as every other cycle does. Trigger: a
defect that reaches the default branch through a layer a record cycle skipped.
Reversal cost: one config line.

If the whole-record scope proves noisy rather than complete, return the record
review to the diff: the briefs drop the unit list and the duty to read the file,
and the criteria stay as they are. Trigger: `record-refuted-share` breaching over
a window whose reviews all read whole records, which says the seat is finding
sentences to write about rather than claims the tree contradicts. Reversal cost:
low, one block of lines in each brief.
