# ADR-0026: Decision-record reconciliation rides the ship

Status: accepted (2026-08-15, the pre-ship placement 2026-09-06)

## Decision

Every shipped story run gets a fresh-context judgment on whether its diff
implements or contradicts any decision record. Where it does, the same run
rewrites those records on its own branch and ships them in its own pull
request. The default branch moves once per shipped story.

- **The judgment is the head of the update stage.** After the final green
  verdict and before the run takes the ship token, the story lane runs
  `reconcile-judge` against the run branch's diff with the default branch
  (`git diff <defaultBranch>...HEAD`), in the run worktree. The default
  branch is fetched first, so the merge base behind that diff is the branch
  as it stands and work the run merged in earlier does not read as its own.
  The seat locates the repository's decision-record tree itself (commonly
  `docs/adr/`); a repository without one is judged not-owed with that as the
  reason. Implementation counts even when the diff never touches the record
  files, which is the case a path filter can never see and the reason this is
  a seat and not a glob.
- **Both verdicts stamp.** `reconciliation-judged` carries `owed`, the judged
  `records`, and the `reason`. A failed judgment stamps `ok: false` with the
  cause: an unjudged ship is a recorded miss, never a silent skip. No outcome
  blocks the ship.
- **Owed writes the records on the run branch.** The `reconcile-write` seat
  runs in the run worktree, in fresh context, and rewrites the judged records:
  implemented parts become standalone present-tense fact, the rationale and
  the fallback paths stay, unimplemented parts stay explicit open sections, a
  divergence between the diff and a recorded decision is named verbatim and
  never absorbed, and nothing outside the record tree is edited. The seat
  reports the records it rewrote, the records it left alone with the reason for
  each, and one divergence entry per judged record. Its checks, on the lane
  contract loop: every changed file sits under the directory of a judged record,
  every judged record is accounted for once, every record it calls rewritten
  really changed, no other file was touched, every judged record has exactly one
  divergence entry, and every entry the seat marks `named` carries a statement
  the record file holds. `reconciliation-written` records the outcome and the
  declaration; a commit stamps `implementation-committed` with
  `phase: 'reconcile'`, so the diff the review reads is the record change alone.
- **The divergence declaration is proved against the files.** Each entry names
  a judged record, the word `none` or `named`, and a statement. For `named` the
  statement is the sentence the seat wrote into the record, and the check finds
  that sentence in the file. Records wrap at 80 columns, so the comparison
  normalises whitespace on both sides: every run of whitespace, line breaks
  included, reads as one space. For `none` the statement is the seat's
  one-sentence reason it found no divergence. What no check can see is a
  divergence nobody named, and the review below judges that under its
  `divergence` criterion.
- **A ground-keyed cycle certifies code and records together.** The cycle
  behind the record commit runs the layers whose declared ground that commit
  reached (ADR-0056), the layers with no standing green, and the layers no
  source declared a ground for, and it carries the rest. Its judgment seat is
  the generalist review over the record diff; the Fury fan-out does not run
  again, because the code it judged did not change. The cycle runs no
  confirmation sweep: a targeted carry stands on work the cycle did not reach,
  and this carry stands on the project's own statement of what each layer reads.
  Part-level narrowing stays off, so a layer that runs, runs whole. A red takes
  the response ladder, and a red about the records takes the reconcile arm of
  it (ADR-0007).
- **A record diff is reviewed through the record lens and nothing else.** The
  review of the reconciliation cycle carries the lens set `['record']` and no
  code lens. Its brief lists the six record criteria, its schema requires the
  `file` and the `criterion` on every finding, and it is briefed with the
  divergence declaration the write seat made. Every finding of that review is a
  record finding, whatever any path list says: the write seat's own containment
  check refused any file outside the record tree.
- **`repo.recordPaths` names the record tree for the reviews.** It is an
  optional list of path entries in the project config, in the vocabulary of
  `repo.testPaths` and `repo.uiPaths`, and it defaults to `['docs/adr']`. It
  decides two things and no more: which review findings are record findings, and
  which diffs the record lens reads. Neither the reconciliation judge nor the
  write seat's containment check reads it, so discovery still decides which
  records get rewritten and where the seat may write. Three rules answer
  "is this a record finding", in order. A review of a reconciliation cycle
  raises record findings and nothing else. A review whose diff touches at least
  one file and no file outside `repo.recordPaths` does the same. On a mixed diff
  the finding's own `file` field decides, the brief names the record files in
  the diff, and a finding that leaves the path out is graded on severity as any
  other finding is.
- **A confirmed record finding buys a corrective rewrite.** The ladder does not
  call `repair-dev` on this cycle: that seat implemented the code, and the
  context that implemented the work never reconciles the records against it. The
  reconcile arm dispatches `reconcile-write` again instead, in the run worktree,
  with the open findings as its brief and the standing divergence declaration
  beside them. The corrective report carries `answered`, the finding ids it
  answered. The stamp is `reconciliation-written` with `corrective: true`. The
  cap, the progress rule and the stall are in ADR-0007.
- **A stall of those rounds takes one of two fallbacks, and asks nobody.**
  Where every layer is green and only record findings stand open, the record
  commit stays in the tree and ships: `reconciliation-written` carries
  `ok: true`, `partial: true`, `cause: 'record-findings'` and `residual`, the
  ids of the confirmed record findings still open. That stamp earns a cycle. The
  cycle judges the same tree, so it fires no judgment seat and plans on the same
  ground; its open set subtracts the residual ids and it renders green over the
  record commit, which is the certification the ship needs. `merged` carries
  `reconciled: true` and `residual`. Where a layer is red on the record commit
  past the stall, the worktree resets to the sha the last green verdict
  certified, `reconciliation-written` carries `ok: false`,
  `cause: 'record-layer-red'`, `reset` and `discarded`, and the run ships the
  code it earned. That stamp earns a cycle too, over the tree that goes out.
  `reconcileCommit` reads a `reconciliation-written` with `ok: false` behind the
  commit as a tree that no longer holds the rewrite, so every reader of it sees
  no record commit. The derivation of prior open findings subtracts every id a
  `reconciliation-written` names as `discarded` or `residual`: a fresh pass drops
  its findings by moving the pass number, and these fallbacks move no pass.
- **The ship needs a verdict over the records.** The run leaves the update
  stage for the verdict after the record commit, and returns to take the ship
  token only when a green verdict certifies that commit. The tree that opens a
  request is a tree a verdict certified, and a record commit is a commit.
- **The round is in front of the token.** The judgment, the rewrite and the
  cycle all run before the run queues for the ship token, so none of them
  holds another run of the project out of its merge.
- **A write nobody can make never costs the run its code.** A work-product
  defect past its corrective round takes the discard fallback with no person
  asked, on both the first write and a corrective one. A seat that never
  delivered a report parks `seat-failure` offering `retry`,
  `ship-without-records` and `abandon`; `ship-without-records` takes the same
  fallback and requires the operator's reason (ADR-0062). The fallback resets
  the worktree to the sha the last green verdict certified, stamps
  `reconciliation-written` with `ok: false` and the cause, and lets the run
  ship the code it earned.
- **The close writes the ticket for records that did not ride.** The close-out
  judges nothing. Where the run was judged owed and no record commit rode the
  merge, it writes `tickets/reconcile-<runId>.md` naming the merge commit, the
  judged records and the rewrite rules, then stamps a second
  `reconciliation-judged` line carrying the ticket and the cause. Where the
  records rode the merge with a residual, it writes the same ticket for those
  findings alone: each residual finding's id, criterion, text, evidence and
  verifier confirmation, and the record it is about. The ticket before the
  stamp: a stamped ticket always exists to launch from (ADR-0024's ordering).
  The rule reads the ledger and not the route, so it covers both fallbacks and
  any other way the records could have been lost. A ticket the close cannot
  write stamps `gate-integrity` under the `reconciliation-lost` defect kind:
  loud, and owned by a person.
- **The sweep launches the ticketed ones.** The owed set derives at every
  sweep from the run ledgers alone: shipped story runs whose judgment carries
  a ticket, minus the ships some reconciliation run's launch stamp
  (`reconcilesRunId`) already names. It is stored nowhere and is
  restart-idempotent (the owed-repairs shape, ADR-0024). The pass runs after
  breach repairs and before the story frontier: defects on shipped code first,
  record hygiene second, new work third. A slot-blocked reconciliation stands
  the story pass down, stays owed, and the next sweep launches it.
- **The ticketed rewrite is a repair-lane run.** The ticket is the spec; the
  lane's gates and generalist review run in full and the rewrite ships through
  its own pull request. A launched-and-failed reconciliation is not owed
  again: like a spent repair, it is a console decision.
- **A fresh pass owes the round again.** A fresh pass resets the tree to the
  commit the pass is born on, so the judgment, the write and the record commit
  are all statements about a tree that is gone. Every one of them is read as
  live only while no `fresh-pass` stamp follows it.

## Why a seat and not automation on paths

The trigger condition, "the diff implements or contradicts a recorded
decision", is semantic. The common case is a diff that implements a decision
without touching the record tree at all; a path filter reads that as nothing
happened. A live cutover run shipped exactly that shape: a payment story
implementing several recorded decisions, records untouched, and no mechanism
anywhere that would ever have noticed. The judgment costs one read-only seat
per ship and buys the guarantee that every ship is either reconciled or
visibly owed.

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

## Why a record diff gets its own lens and none of the code lenses

The review that reads a record diff used to read it through the panel the
project judges code with. A security lens asked to find input trust and secrets
in a markdown document finds something to say about it, and a spec lens asked
whether the diff implements the validated spec finds that a document does not.
While those findings were advisory they were noise in the ledger. Once every
record finding blocks a ship they are a source of wrong blocks.

The answer is not a better instruction to the same lenses. It is to stop asking
them. The record lens carries six criteria and they are the whole of what a
record is held to: the implemented parts read as standalone fact, every claim is
true against the tree, unimplemented parts stay open sections, a divergence is
named and never absorbed, every name and path and symbol the record cites
exists, and the record reads as one document rather than a trail of amendments.
A seat that is not asked to read a record for failure paths does not report
them.

The criterion is load-bearing for the same reason. The verifier is briefed with
the criterion the finding cites and with the list it comes from, and it refutes a
finding whose evidence does not reach that criterion. A finding that cites
`whole` or `fact` and names no sentence of the record is refuted for want of
evidence. Taste is not a criterion.

The lens is not project config and no seat spawns for it. A project cannot name
it in `review.lenses`, and the diff is what puts it on a review: the whole diff
is records, or the finding's own file is one.

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

## Why the partial fallback keeps the record commit

The judge found the old records owed. Discarding the rewrite ships those: more
known drift, and a ticket that asks a whole run to do the whole rewrite again.
Keeping the rewrite ships the corrected records with a short list of what is
still wrong, and the run behind that list is small.

Under either ending the residual is not fixed before the ship. This is the ending
that ships less drift and costs less to finish.

The discard is kept for the other shape. A layer that is still red on the record
commit is a tree CI would refuse too, so that one goes back to the sha the last
green verdict certified.

## Why the write seat is contained by checks and not by deny rules

A deny rule cannot say "everything except these directories" without walking
the whole repository and naming every file in it. So the boundary is a check
over what the seat left in the tree, run before anything is committed, in the
shape the card sweep already uses for its own directory. The judged records
are the harness's own list, so their directories are the boundary and no
project has to declare where its records live.

## Why the reconciliation cycle carries on ground

A layer's ground is the project's statement of what that layer reads
(ADR-0056). A record commit that touches no file of that ground cannot change
what the layer decided. That is the same claim the ship fast path carries a
whole certification on, asked here of one commit inside the run instead of a
moved base. It fails towards running: a layer with no standing green runs, a
layer no source declared a ground for runs, and the ground itself is read as
the widest union of the two sources.

A project whose layers declare no ground therefore runs the full spectrum for
the reconciliation cycle. That is one cycle inside the story run, against a
whole second run with two of them.

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
The field exists and the reviews read it; the two seats that decide which
records get rewritten do not. Trigger: a judged-not-owed ship whose repository
holds records somewhere unusual. Reversal cost: low, two role blocks and one
check.

If the in-run rewrite proves too expensive for the story that pays it, return
the rewrite to the sweep: the judgment stays where it is, an owed judgment
writes the ticket at the close instead of running the write seat, and the
repair-lane path behind the ticket is untouched. Trigger: the
`reconcile-fallbacks-window` tripwire breaching, which is two or more of the
last ten owed ships ending in a fallback (ADR-0010). The trigger is the
fallbacks and not the reds: a red about the records is what the reviews are for,
and the reading that matters is whether the in-run rewrite can finish what they
raise. Reversal cost: low, the ticket route is the fallback and stays live.

If the ground-keyed carry proves wrong, give the reconciliation cycle the
confirmation sweep every targeted cycle takes. Trigger: a defect that reaches
the default branch through a layer the reconciliation cycle carried.
Reversal cost: low, one condition, and it costs the full spectrum.
