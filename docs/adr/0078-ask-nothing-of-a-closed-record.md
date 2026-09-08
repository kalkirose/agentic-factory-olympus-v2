# ADR-0078: Ask nothing of a closed record, and dispatch the set you stamped

Status: accepted (2026-09-08)

## Context

One record seat wrote sixteen decision records in a single dispatch. Six
accepted records it replaced took their new status line in the same write. The
seat listed those six in `rewritten`, because it had changed the files. The unit
check then enumerated the whole body of each one and asked for an answer per
unit.

No answer to such a unit passes. An old body holds claims the tree now
contradicts, so the honest verdict is `fails`, and a writer that reports `fails`
is refused. The seat filed them as rationale instead. A head that names a path,
a symbol or one of the closed verbs is a claim, so that is refused too. The
report was refused twice and the run parked. The write was right.

Every record list the reconcile stage dispatched over was read from the tree at
the moment of the read. A list built that way shrinks between two entries of one
round, because a seat closes the record it was given. A seat name is the index in
that list. So a resumed round renamed every seat behind the closure, and a
record nobody had written was counted as written.

## Decision

**The filter.** `activeOf` in `src/lanes/units.mjs` answers the records of a
list the worktree still holds open, and the ones a closed status line drops with
the word each of them read. A file it cannot read stays in the list, so the unit
check still refuses a record it cannot enumerate. A file with no status line
stays, because a record nobody marked is a record nobody closed. The lifecycle
does not gate the filter. A record closed by hand under `rewrite` traps a seat
exactly as a superseded one does, and every drop is stamped.

**The unit set.** `unitRecords` in `src/lanes/records.mjs` counts the active
records of the dispatch, plus the records this dispatch added that name one of
its judged records on a `Supersedes` line. Every unit of such a replacement is
the writer's. An entry in `units` about a dropped record is dropped with it and
never refused. `stampUnits` in `src/lanes/records-stage.mjs` and in
`src/lanes/reconcile.mjs` stamps one `record-units` event per record the check
counted, and none for a record it dropped. A counted record the seat answered no
unit for takes its stamp with an empty list, because the stamp says which
records a dispatch was answerable for.

**The declaration.** `divergenceDefects` reads the same counted set. A judged
write that supersedes its record declares about the record it added, and one
entry about the record it closed is read rather than refused. A birth judges no
record and declares none, which is what its brief asks for.

**The closure.** A record whose status line a write closed is accounted for by a
replacement of the same round, or by an entry in `unchanged` with the reason it
was retired. The round's range runs from the sha the round opened at to the
worktree, so a replacement a peer seat of the round committed counts. A closure
with neither is refused, and the defect names the routes. Under `rewrite` it
names the one route that lifecycle holds. The same check runs at a birth over
the record files the birth changed. `lifecycleLines` states the rule to the seat
under either lifecycle, because the filter and this check are not gated on one,
so the brief and the check say one thing.

**The range.** One read serves the closure rule and the sibling answers.
`siblingChecks` accepts the record that replaces a superseded sibling anywhere in
that range, because a merge round leaves it in a peer seat's commit. A range
read that fails is never an empty range: an empty one reads a legal supersession
as a bare closure, so the failure is stated as a defect that names the read, and
no closure and no sibling answer is judged on it.

**The dispatched set.** `reconcile-write-set` and `reconcile-review-set` carry
the list a round or a cycle dispatched, in dispatch order, and the records the
filter dropped with the status word behind each. Each is stamped before the
first seat of its round or its cycle spawns. Every later entry dispatches the
stamped list, so each seat keeps its index and its name across a restart.
`cycleStepOf` measures the review against the stamped set rather than against
the anchor, whose list holds the closed records too.

**The commit.** The subject one write dispatch signs names the record beside the
seat and the ledger position the round opened at. `writtenAlready` matches on
the record and never on the seat name alone. A ledger written before the two
dispatch events holds neither of them. Its round derives the list from the tree
as it always did, and the record in the subject is what keeps such a resume from
counting one record's commit for another.

**The stall.** A red render whose dispatch set is empty takes the cap fallback
at once, with `rounds: 0` and a gist that names the empty set. Every record of
that set is closed, no seat may answer for one, and a round that spawns no seat
buys nothing.

## Consequences

Every list build reads one file per listed record. The commit already pays that
read. Two events land per reconcile round and per cycle, and every reader of the
closed run registry gains two names.

A run a daemon restart carries across this change holds no dispatch stamp. Its
round derives its list from the tree, as it did before, and matches its commits
by record. A commit an earlier pin signed names no record, so such a round
dispatches that record again rather than counting a peer's write for it.

A seat that answers a closed record's units spends tokens on answers the harness
drops. The brief tells it not to, and the drop costs the report nothing.

A run a restart carries mid-cycle across this change holds no review set either.
Its cycle derives the list from the tree, where a record the pass closed is
gone. A seat can then take a name a peer already stamped under, and one
record's review answer is lost. The write side falls back on the record in its
commit subject, and the review side holds no such fact.

A record every seat is barred from is a record the review never reads. The form
gate still reads it, because the layers run over the whole record diff and the
closure changed that file.

## Rejected options

- Tell the seat to leave the old record out of `rewritten`. A brief is a
  request and the check is the rule. The seat listed the file under the rule as
  it was written, twice.
- Accept `fails` on a closed record's units. The rule is right for a writer.
  The answer is not to ask.
- Filter the tree at every reader and stop there. A list read from the tree
  shrinks between two entries of one round, and index-named seats then resume on
  the wrong record.
- Name the seats by record instead of stamping the set. A seat name is the key
  of the attempt budget, the cost series and the failure record, so a path in it
  changes every reader of those.
- Gate the filter on the supersede lifecycle. A status line closed by hand under
  `rewrite` traps a seat the same way, and a hidden drop is worse than a stamped
  one.
- Skip the status-line edit at the commit and leave it off the born stamp. The
  reconcile stage reads a set with the old record in it, because the form gate
  needs that file in its diff.
- Let a closure with no replacement and no reason pass. A write seat then
  discharges a judged record unread.
- Read the replacement from the uncommitted diff alone. Two seats of one round
  that merge two records into one leave the second seat's replacement in the
  first seat's commit.

## Fallback path

The alternative is the filter alone, with every round dispatching the whole
judged list and the check refusing each closed record. The switch trigger is a
stamped set a reader cannot reconcile with the seats the ledger then spawned.
The reversal cost is two events and one derivation.

## References

- ADR-0073, ADR-0074, ADR-0075, ADR-0077
- `src/lanes/units.mjs`
- `src/lanes/records.mjs`
- `src/lanes/records-stage.mjs`
- `src/lanes/reconcile.mjs`
- `src/ledger/registry.mjs`
