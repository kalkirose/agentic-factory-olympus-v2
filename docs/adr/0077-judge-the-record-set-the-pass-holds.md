# ADR-0077: Judge the record set the pass holds, born or written

Status: superseded by ADR-0080 (2026-09-10)

## Context

A records-lane run wrote two decision records and opened its request. Between
the record commit and the ship the harness read none of them. The ledger held
no record layer, no review seat, no verifier and no render. The only reads were
the writer's own unit answers and the deterministic birth checks.

The reconcile stage opened its cycle on a `reconciliation-written` stamp alone.
The judge leaves out a born record that still stands. On the records lane the
whole diff is the birth write. So the judge answered `owed: false`, the stage
was done, and the born records left the run uncertified. The admission gate
then read a null record certification as a lane with nothing to certify.

The story and repair lanes hid the hole. Their judge usually finds a late
record in the code diff. A cycle starts, and the stage scope widens to the
pass's whole record range. The born records rode in by that accident.

## Decision

The reconcile stage judges the record set the pass holds. That set comes from
the born stamp or from the write stamp.

**The anchor.** `cycleAnchor` in `src/lanes/reconcile.mjs` answers with the
`reconciliation-written` stamp since the last `fresh-pass`. Where the pass
holds none, it answers with the run's `records-committed` stamp that decided
something. The born stamp takes the write stamp's shape: `{seq, ok: true, born:
true, paths}`. `reconcileStep` takes `write` only where the judgment owes
records and no write stands behind it. Every step past that reads the anchor,
and so do `cycleStep` and `correctStep`. An `owed: false` judgment over a born
set therefore buys the whole cycle. That is the record layers, one review seat
per record, the verifier and a render. It ends at `done`, `correct` or `stall`,
as a written reconciliation does.

**The gate.** `admitted` in `src/lanes/ship.mjs` refuses a records-lane tree
whose record certification is null. That lane's whole work is records. A null
there is unjudged, and never nothing to judge. The update stage parks the run
`stage-blocked` with reason `records-uncertified`. The question names the
render the run does not hold. The anchor above makes the park unreachable, and
the park is the loud answer where it is not.

**The stamp.** `commitRecords` in `src/lanes/records-stage.mjs` names every
record path the birth commit changed, read from the tree. The seat's
`rewritten` list alone is not enough. `unreported` names the paths the seat did
not report. A superseded record's status-line edit is such a path: the write is
legal and it owes no units. A cycle cannot read a path the stamp does not name.

**The readings.** `writerMissRate` in `src/center/snapshot.mjs` counts a
writer's `holds` only where a review answered the same unit. `lateShare` reads
the `born` and `late` lists of every judgment. An `owed: false` judgment now
carries both: the born paths, and nothing late.

**The title.** The ship stage titles a records-lane request `records: <runId>`.
`LANE_TITLE_WORD` in `src/lanes/ship.mjs` maps the lane to the word.

## Consequences

Every records-lane run pays a record cycle. That is one review seat per record,
the verifier and the record layers. A story or repair run with born records and
nothing owed pays the same cycle. ADR-0075 states that cost for a written
reconciliation, and the born set now pays it too. A resumed story run pays it as
well. `src/lanes/story.mjs` stamps the inherited records `decided: true`, so the
run reads records it did not write.

A red render over a born anchor buys a corrective round under
`gates.reconcileRounds`. The round writes the born paths and stamps a write.
The pass anchors on that write from there, and the stage runs as before. At the
cap the stage stalls and tickets, which is unchanged.

This record is superseded when a record cycle over a born set raises no finding
across twenty ships. The cycle then costs a seat per record and reads nothing
the birth checks did not.

## Rejected options

- The judge names the born set: it answers about the diff, and the birth write
  is that whole diff.
- The record layers alone over the born set: a layer checks a form. A false
  claim passes every form.
- The ship gate alone: a park at the ship stops the run, and the cycle is the
  work.
- A second write of every born record: it spends a seat and states nothing new.

## Fallback path

The alternative is the write anchor alone, with the ship-gate refusal kept. The
records lane then parks at the gate, and a person answers it. The switch
trigger is a record cycle that costs more than the lane it guards. The reversal
cost is one helper.

## References

- ADR-0073, ADR-0074, ADR-0075
- `src/lanes/reconcile.mjs`
- `src/lanes/records-stage.mjs`
- `src/lanes/ship.mjs`
- `src/center/snapshot.mjs`
