# ADR-0079: One window on the run's record work, and a records run that can still act

Status: superseded by ADR-0080 (2026-09-10)

## Context

A records-lane run wrote sixteen decision records, closed the six they replace,
and reached its corrective round. One seat was refused twice on a check that
reads the dispatch's own uncommitted diff and asks whether the parent of a
replacement is closed. The parent closed one commit earlier, in the birth. No
answer passes that check. The refusal ended the run with nothing merged.

That check is one of several readers of the run's record work, and each opened a
different window. The closure and sibling reads opened at the round's first
commit, which excludes the commit the round opened on. The review set opened at
the launch sha, so a merge of a moved default branch put records this run never
wrote into its set. The corrective dispatch set read the write stamp, which
holds no born record where the judge owed one.

The lane also ended where a seat could still act. One refused dispatch ended the
whole round. The cap closed the run. Neither pushed the branch, so the work
stood in the local clone alone, and the ticket the close wrote launched a fresh
birth from the default branch.

## Decision

**The window.** `runWindow` in `src/lanes/records.mjs` answers `{base, files,
error}`. `base` is the merge base of `HEAD` and the default branch, computed at
the read. `files` is every record path the run changed from that base to the
worktree, committed or not. A read that fails answers `error` and never an empty
window, because an empty one reads a legal supersession as a bare closure.

**Every reader takes it.** The supersession pairing, the closure accounting, the
sibling answers, the record scope, the layer plan's changed set, the moved-unit
read and the fast path's record ground all open here. `recordScope` takes the
worktree and the record paths and no range. `rangeStart` and the ship base
answer the window's base, so `OLYMPUS_BASE_SHA` is the merge base and the in-run
gate reads the set CI reads.

**The pairing asks the tree.** `supersedesBackDefects` drops its test over what
one dispatch changed. A parent that stands open at the merge base and closed in
the worktree passes, wherever the closure was made. A parent already closed at
the merge base is refused as a supersession of a closed record.
`acceptedEditDefects` runs over every accepted record the window changed, so a
replacement the birth wrote answers a closure the birth made.

**The brief carries every list the check refuses on.** The birth reads the
ticket's own touched records and is briefed with the records that cite them and
the neighbourhood around them. The brief names the layers that read the form at
the render, and the cost of a defect there, and asks the seat to check its own
files against the constitution first. Its environment carries the window's base.
The schema asks for `siblings` only where the forecast holds one, and the brief
states an empty forecast in one sentence.

**A corrective round dispatches the records that owe an answer.**
`correctiveRecords` reads the render: every active record an open finding names
in `file` or `file2`, and every active record a red layer names in the output it
captured. A red layer that names none of them widens to the whole set. The rest
are stamped `kept` on `reconcile-write-set`, with the reason.

**A cycle after the first reviews what moved.** The first cycle of a pass reads
every active record of the window, and so does the cycle a moved default branch
buys. Every later cycle reads the records the last round changed and the records
an open finding names. Every other record is stamped `kept` on
`reconcile-review-set` with the cycle of its green review, and a record whose
text moved since that review is read again.

**A refused dispatch ends itself.** A write seat that spends its budget on a
deterministic defect leaves the tree at its last commit. Its entry carries
`failed` and the defects, the round goes on to the next record, and the render
carries `unwritten:<record>` in its open set. The next round dispatches that
record with the defects in its brief. The story and repair lanes keep the ticket
route for a judged write; the records lane has no code to ship without its
records, so it isolates there as every corrective round does.

**The cap keeps the work.** A records-lane run at its cap pushes the run branch
to the origin, writes the ticket with every record, every open finding, every
failed dispatch and the branch, stamps `reconcile-stall`, and parks
`reconcile-cap`. An answered `rounds` stamps `reconcile-cap-extended`, raises
the cap by that count, and re-enters the corrective round. `abandon` closes the
run through the one route every park owes.

**Every review seat resumes by report.** A record review seat takes the report
the ledger holds for its own label after the cycle's dispatch stamp, runs the
checks over it, and spawns nothing when they pass. Each seat stamps its units as
it settles rather than after the whole fan-out.

## Consequences

Every record check makes two git reads: one merge base and one name-only diff,
both in the run worktree. A stale local default branch gives an older base and a
wider window, which reads more accepted records and refuses nothing it should
pass.

A kept record is not read again by a fresh seat while its text stands. Its last
green review is the answer of record, at the recheck as much as at the cycle: a
record the render kept is this run's own and never newly owed. A `consistent`
finding raised from the moved side still dispatches the kept record it names.

A parked run holds its slot decision open until a person answers. The forge then
holds a `run/` branch with no request behind it, and the branch stays until the
run closes.

A failed dispatch leaves its record's finding open for one more cycle, which
costs one review seat and one write seat.

The form of a born record is first read by the record layer at the render, over
the commit. No command a birth seat can run proves the form of a file it has not
committed. So the brief states the cost of a defect, and the seat reads its own
work against the constitution. A form defect therefore still costs one cycle and
one corrective round.

A story run that starts on a prior run's frozen commit inherits that run's
records on its own branch. The window opens at the merge base, so those records
are in it, and the stage reviews them beside the ones this run writes. That is
the window's meaning for a resumed run, and it is the safe direction: a record
the branch carries to the merge is a record this run ships.

## Rejected options

- Read the round's own range. `git diff A..B` excludes the commit A, and the
  round opens at or after the birth commit, so the parent stays outside it.
- Skip the pairing in a corrective round. A corrective seat may add a
  replacement, and the pairing has to hold for it.
- Keep the whole-set review on every cycle. A fresh reader of an unchanged green
  record raises findings on unchanged sentences and spends the cap on them.
- Dispatch every record every round. Most seats of such a round owe nothing, and
  each one costs a dispatch.
- Close at the cap and continue from the branch in a new run. No launch shape
  continues a records run, and one would need a second inheritance path, a
  second ledger and a re-judge.
- Ship with the findings open at the cap. A confirmed finding blocks the ship,
  and the records are the whole work of this lane.

## Fallback path

The alternative is the round range every reader took before, with the records
lane closing at its cap and ticketing from its branch. The switch trigger is a
window read that fails on every check of a run, which leaves the stage refusing
closures it cannot judge. The reversal cost is one function and one stamp.

## References

- ADR-0026, ADR-0073, ADR-0074, ADR-0075, ADR-0077, ADR-0078
- `src/lanes/records.mjs`
- `src/lanes/records-stage.mjs`
- `src/lanes/reconcile.mjs`
- `src/lanes/review.mjs`
- `src/lanes/shared.mjs`
- `src/lanes/units.mjs`
- `src/ledger/registry.mjs`
