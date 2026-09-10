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
  states, as prose, the neighbourhood by path, the lifecycle rule, the project's
  own form gate command, the duty to check every present-tense sentence against
  the tree and to name every divergence in the record, and that nothing outside
  the record tree is edited. The seat reports the records it rewrote and the
  records it left alone with the reason for each, and no reading of its own
  sentences (ADR-0080).
- **Two readings of what the write left, and neither refuses.** `writeChecks` in
  `src/lanes/records.mjs` reverts a changed file outside the record tree and
  stamps it, because a record run must not ship code and a revert costs no
  attempt; and it drops a record the report calls rewritten that the tree did not
  change, with the note on the stamp. `reconciliation-written` records the
  outcome and one entry per record with its seat, cost and attempts.
- **The record set is the pass's whole record diff.** `recordScope(worktree,
  recordPaths, {lifecycle, defaultBranch})` in `src/lanes/records.mjs` reads the
  record files the run changed through the window: the merge base of the run
  branch and the default branch, computed at the read. Every record the pass has
  touched is read on every cycle until the stage is green. Under the supersede
  lifecycle a closed record leaves the scope. The code review's file list holds
  no record path: a record is judged in this stage and nowhere else.
- **A record is reviewed by a seat of its own, and no seat is given a diff.**
  `recordReviewRound` in `src/lanes/review.mjs` fans out one `record-review:<n>`
  per record file, in parallel, as the Fury panel fans out per lens. Each brief
  carries the record path, the harness's unit list as the addresses a finding
  names, the criteria under `RECORD_RULE`, the spec or ticket, the neighbourhood
  by path with the count above the cap, and the unit heads this round moved. It
  carries no diff text. The seat answers with findings and nothing else. Two
  findings are work-product defects rather than findings, and the seat corrects
  them in its own attempt: a `consistent` finding that names one record, and a
  finding on a superseded or retired record where the project runs the supersede
  lifecycle. A seat that could not deliver leaves its record `unreviewed` for
  this cycle and parks nothing (ADR-0080).
- **`repo.recordPaths` names the record tree.** It is an optional list of path
  entries in the project config, in the vocabulary of `repo.testPaths` and
  `repo.uiPaths`, and it defaults to `['docs/adr']`. An entry may carry an `!`
  prefix for an exclusion, which is how a record tree keeps its template outside
  the rule; an exclusion wins over every entry that includes it.
  `recordPathIncludes` in `src/config/project.mjs` answers the membership
  question for the record readers, and `recordMatch` in `src/lanes/parts.mjs`
  answers it for the ground readers. The list decides the scope of the
  reconciliation, the tree the dev seats are denied (ADR-0074), the layers a
  record path is attributed to (ADR-0046), and the neighbourhood the criteria
  are read against. Neither the reconciliation judge nor the write seat's
  containment check reads it, so discovery still decides which records get
  rewritten and where the seat may write.
- **A confirmed record finding buys a corrective round.** The ladder does not
  call `repair-dev`: that seat implemented the code, and the context that
  implemented the work never reconciles the records against it. The stage
  dispatches `reconcile-write:<n>` again instead, per record, with the open
  findings and the remarks that record holds. The corrective report carries
  `answered`, the finding ids it answered, each with the reason where the writer
  disputes it. The round stamps `reconcile-round` and counts against
  `gates.reconcileRounds`, default 1 (ADR-0080). The verdict's own repair cap
  never reads these rounds.
- **A stall at the cap takes the fallback, and asks nobody.**
  `reconciliation-written` carries `ok: false` with a cause from the closed set
  `record-cap`, `seat-failure`, `operator` and `work-product-defect`. The cap
  fallback carries `partial: true` and `residual`, the ids of the confirmed
  record findings still open, and the record commit ships on every lane: the
  judge found the old records owed, and discarding the rewrite would ship those.
  `reconcile-stall` is a loud item, and the routes behind the fallback are
  ADR-0075 and ADR-0080.
- **The ship needs a green over the records.** `certifiedTrees` reads two
  certifications, each at its own sha, and the admission gate requires both the
  lane holds. A tree that opens a request is a tree a verdict certified and a
  record tree a reconciliation certified.
- **The stage is in front of the token.** The judgment, the writes and the
  cycles all run before the run queues for the ship token, so none of them holds
  another run of the project out of its merge.
- **A write nobody can make never costs the run its code, and never asks
  anybody.** A dispatch that fails stamps `record-written {failed: true}` and the
  round goes on to the next record. The render carries `unwritten:<record>` until
  a round writes it, and the run's own ending names it (ADR-0080).
- **The close writes the ticket for a record no round wrote.** The close-out
  judges nothing. Where the judge owed a record and no round wrote it, it writes
  `tickets/reconcile-<runId>.md` naming the merge commit, that record and the
  rewrite rules, then stamps a second `reconciliation-judged` line carrying the
  ticket and the cause. A confirmed finding that stands on a record this run did
  write buys no ticket: the record shipped, and the finding rides the request
  body and the close stamp (ADR-0080). The ticket before the stamp: a stamped
  ticket always exists to launch from (ADR-0024's ordering). The rule reads the
  ledger and not the route, so it covers every way the records could have been
  lost. A ticket the close cannot write stamps `gate-integrity` under the
  `reconciliation-lost` defect kind: loud, and owned by a person.
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
those findings were advisory they were noise in the ledger. Once a confirmed one
blocks a ship they are a source of wrong blocks.

The answer is not a better instruction to the same lenses. It is to stop asking
them, and to give the record a seat that reads nothing else. The record criteria
carry one rule and three criteria under it, and together they are the whole of
what a record is held to. The rule is that a record never conflicts with the
code: everything it states is either true of the tree now, or marked as not yet
built, and a sentence that states why is rationale and is neither. `truth`
divides that rule into what a seat can judge over one record: every
present-tense claim is true against the tree, a part the tree does not hold is
stated as not built, a divergence is named and never absorbed, and every name
the record cites means what the record says it means. `consistent` holds it
against the neighbours. `form` is what the project's own gate cannot read.

The criterion is load-bearing for the same reason. A finding that names no
sentence of the record reaches nothing a writer can answer, and the brief says
so. Taste is not a criterion.

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
the harness's own unit list gives the sentences their addresses, one line names
the units this round moved, and the seat is given no diff at all.

The code lenses keep the opposite rule, and keep it for the same reason. A code
diff is the work, and a seat that widens into the repository around it reports
on decisions nobody made this time. A record is not the work: it is a statement
about the work, and the statement is judged whole.

## Why the divergence rule is the writer's and the review's

The rule "a divergence is never absorbed silently" was carried in two briefs and
enforced nowhere. A live reconciliation named three divergences in its report and
absorbed a fourth; the review caught the one it dropped, and nothing turned that
catch into work.

A declaration in the report and a check over it looked mechanical and was not: it
proved that a sentence the seat named is in the file, which the seat could always
satisfy, and it never saw a divergence nobody wrote about. The rule is now one
line of every write brief and one clause of the `truth` criterion, and the review
seat is what finds a divergence the writer absorbed (ADR-0080).

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
