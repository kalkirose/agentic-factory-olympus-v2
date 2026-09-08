# ADR-0079: One window on the run's record work, and a records run that can still act

Status: accepted (2026-09-08)

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
ticket's own touched records and is briefed with the records that cite them, the
neighbourhood around them, and the record layers' commands with their
prerequisites first. Its environment carries the window's base. The schema asks
for `siblings` only where the forecast holds one, and the brief states an empty
forecast in one sentence.

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
green review is the answer of record. A `consistent` finding raised from the
moved side still dispatches the kept record it names.

A parked run holds its slot decision open until a person answers. The forge then
holds a `run/` branch with no request behind it, and the branch stays until the
run closes.

A failed dispatch leaves its record's finding open for one more cycle, which
costs one review seat and one write seat.

## Rejected options

- Read the round's own range. `git diff A..B` excludes the commit A, and the
  round opens at or after the birth commit, so the parent stays outside it.
- Skip the pairing in a corrective round. A corrective seat may add a
  replacement, and the pairing has to hold for it.
- Keep the whole-set review on every cycle. A fresh reader of an unchanged green
  record raises findings on unchanged sentences and spends the cap on them.
- Dispatch every record every round. Seven of sixteen seats owed nothing on the
  run this record comes from, and each cost a dispatch.
- Close at the cap and continue from the branch in a new run. No launch shape
  continues a records run, and one would need a second inheritance path, a
  second ledger and a re-judge.
- Ship with the findings open at the cap. A confirmed finding blocks the ship,
  and the records are the whole work of this lane.

## Fallback path

The alternative is the window alone, with the round range kept for the closure
and the sibling reads and the cap closing as it did. The switch trigger is a
supersession refusal on a corrective write over a born replacement, or a cap
park nobody answers. The reversal cost is one function and one stamp.

## References

- ADR-0026, ADR-0073, ADR-0074, ADR-0075, ADR-0077, ADR-0078
- `src/lanes/records.mjs`
- `src/lanes/records-stage.mjs`
- `src/lanes/reconcile.mjs`
- `src/lanes/review.mjs`
- `src/lanes/shared.mjs`
- `src/lanes/units.mjs`
- `src/ledger/registry.mjs`
