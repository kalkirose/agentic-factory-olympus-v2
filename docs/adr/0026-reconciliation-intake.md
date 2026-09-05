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
  reports the records it rewrote and the records it left alone with the reason
  for each. Its checks, on the lane contract loop: every changed file sits
  under the directory of a judged record, every judged record is accounted for
  once, every record it calls rewritten really changed, and no other file was
  touched. `reconciliation-written` records the outcome; a commit stamps
  `implementation-committed` with `phase: 'reconcile'`, so the diff the review
  reads is the record change alone.
- **A ground-keyed cycle certifies code and records together.** The cycle
  behind the record commit runs the layers whose declared ground that commit
  reached (ADR-0056), the layers with no standing green, and the layers no
  source declared a ground for, and it carries the rest. Its judgment seat is
  the generalist review over the record diff, as on a repair round; the Fury
  fan-out does not run again, because the code it judged did not change. The
  cycle runs no confirmation sweep: a targeted carry stands on work the cycle
  did not reach, and this carry stands on the project's own statement of what
  each layer reads. Part-level narrowing stays off, so a layer that runs, runs
  whole. A red takes the response ladder like any other cycle.
- **The ship needs a verdict over the records.** The run leaves the update
  stage for the verdict after the record commit, and returns to take the ship
  token only when a green verdict certifies that commit. The tree that opens a
  request is a tree a verdict certified, and a record commit is a commit.
- **The round is in front of the token.** The judgment, the rewrite and the
  cycle all run before the run queues for the ship token, so none of them
  holds another run of the project out of its merge.
- **A write nobody can make never costs the run its code.** A work-product
  defect past its corrective round takes the fallback with no person asked. A
  seat that never delivered a report parks `seat-failure` offering `retry`,
  `ship-without-records` and `abandon`; `ship-without-records` takes the
  fallback and requires the operator's reason (ADR-0062). The fallback resets
  the worktree to the sha the last green verdict certified, stamps
  `reconciliation-written` with `ok: false` and the cause, and lets the run
  ship the code it earned.
- **The close writes the ticket for records that did not ride.** The close-out
  judges nothing. Where the run was judged owed and no record commit rode the
  merge, it writes `tickets/reconcile-<runId>.md` naming the merge commit, the
  judged records and the rewrite rules, then stamps a second
  `reconciliation-judged` line carrying the ticket and the cause. The ticket
  before the stamp: a stamped ticket always exists to launch from (ADR-0024's
  ordering). The rule reads the ledger and not the route, so it covers the
  fallback and any other way the records could have been lost. A ticket the
  close cannot write stamps `gate-integrity` under the `reconciliation-lost`
  defect kind: loud, and owned by a person.
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

If a project's record tree needs an explicit location, add an optional
project-config field and pass it into both role blocks; discovery stays the
default. Trigger: a judged-not-owed ship whose repository holds records
somewhere unusual. Reversal cost: low, an additive config field.

If the in-run rewrite proves too expensive for the story that pays it, or the
reconciliation cycle turns red on record diffs often enough to cost more than
the second merge did, return the rewrite to the sweep: the judgment stays
where it is, an owed judgment writes the ticket at the close instead of
running the write seat, and the repair-lane path behind the ticket is
untouched. Trigger: two stories whose reconciliation cycle red is about the
records rather than the code. Reversal cost: low, the ticket route is the
fallback and stays live.

If the ground-keyed carry proves wrong, give the reconciliation cycle the
confirmation sweep every targeted cycle takes. Trigger: a defect that reaches
the default branch through a layer the reconciliation cycle carried.
Reversal cost: low, one condition, and it costs the full spectrum.
