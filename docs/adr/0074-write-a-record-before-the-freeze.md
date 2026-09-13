# ADR-0074: Write a record before the freeze, and never from a dev seat

Status: accepted (2026-09-07)

## Context

Six records of the live tree were written by the seat that wrote the code. Each
reads as a description of a diff. Such a record states what one change did, never
what the project decided. The context that wrote the code cannot judge a record
against its own work.

A new record also entered the tree only after a ship, through a reconciliation
ticket. Until then the dev seat read a tree whose decisions nobody had written
down.

## Decision

A seat that writes no code writes every record, and it writes it before the
freeze.

**The story lane.** `PRE_FREEZE_STAGES` in `src/lanes/story.mjs` is readiness,
spec-birth, spec-gate, records, suite, freeze. The `records` stage
dispatches one `record-author` seat over the validated spec and the birth
neighbourhood. The seat writes the records the spec decides and answers every
unit (ADR-0073). The files commit as `records: <key>` and stamp
`records-committed` with `sha`, `paths` and `decided`. A spec that decides
nothing stamps `decided: false` and commits nothing. The commit stands before the
suite seat. The frozen sha then carries the records, and the dev seat reads them
as it reads the tests.

**The records lane.** A ticket that names records alone runs on a lane of its
own: readiness, records, reconcile, update, ship, close-out. It holds no fix
seat, no suite and no code verdict. `ticketPathClass` in
`src/lanes/records-stage.mjs` reads the ticket's fenced touched-paths block. The
launch door refuses a record-only ticket on the repair lane and names the lane to
use. It refuses a ticket that names code on the records lane. A repair ticket
that names both dispatches the birth first and the dev seat second, with the
records frozen.

**The freeze.** `editDenyRules` in `src/seats/boundary.mjs` denies the record
tree to every seat that writes code. Both lanes carry the rules, and so does the
merge-conflict site. A record that reaches the capture is reverted to the run's
last commit and stamped `diff-policy-recapture` with `class: 'record'`. The two
take-back classes count apart.

**The carry.** A fresh pass resets the tree. `carriedPaths` carries the record
tree beside the frozen suite, and `carryRecords` re-stamps `records-committed`
with `carried: true`. An inherited freeze stamps it with `resumed: true`.

`reconciliation-judged` splits what it found. `born` names the records this run
wrote before its freeze; `late` names the rest.

## Consequences

Every story spends one seat before the freeze, and a project with no record tree
spends none. A dev seat that needs a record cannot write one. The reconcile stage
names it owed. A deny-rule refusal leaves no stamp. The seat runtime reports no
refused tool call, so the harness holds no count of the attempts. The take-back
is the recorded fact.

This record is superseded when the late share stays high over ten ships. That
reading says the cards and the tickets state no decisions. A birth before the
freeze then has nothing to read.

## Rejected options

- The dev seat writes the record beside its diff: six such records describe one.
- A repair run that skips stages for a record-only ticket: each skip is a park.
- A count of refused dev-seat writes: the runtime records no refusal.
- A record born after the ship: the dev seat then reads no decision.

## Fallback path

The alternative is the ticketed birth alone. The `records` stage leaves the stage
lists, the judge names every record late, and the sweep launches the rewrite. The
switch trigger is the reversal trigger above. The reversal cost is low.

## References

- ADR-0006, ADR-0017, ADR-0026, ADR-0073, ADR-0075
- `src/lanes/story.mjs`
- `src/lanes/records-stage.mjs`
- `src/seats/boundary.mjs`
- `src/lanes/verdict.mjs`
- `src/ledger/registry.mjs`
