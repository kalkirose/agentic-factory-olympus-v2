# ADR-0090: A record states a decision, and the judge has two places to stand

Status: accepted (2026-09-13)

## Context

Every run that ships code paid a record bill before it could ship. The judge
read the diff and said which decision records it touched. One writer seat per
record rewrote them, the record layers ran, one review seat per record judged
each rewrite, and a corrective round repeated the pair for every open finding.
The stage stood in front of the ship token, so the code waited on the records.

The bill was large because of what a record was held to say. A record stated
every unbuilt part of its decision as not yet implemented, and named every
divergence between the tree and the decision. So the run that built a part
always moved the record past what it said, the judge always owed, and under a
supersede lifecycle every rewrite was a new record that closed the old one. The
record tree grew with the code, and a large share of it was closed records.

Two costs came out of one rule. The seat count is the visible one: one judge,
N writers, N reviewers, then N more writers per corrective round. The other is
the record tree itself, which grows by one file per rewrite and is read by
every seat that writes code.

There was also no way to stop paying. Emptying the record path list kills the
record reads in every brief and makes the records lane refuse every ticket. The
round cap refuses zero. The lifecycle word says how a record is changed, never
whether one is. A project that needed the bill to stop had to change the
harness.

## Decision

**A record states a decision and nothing about the state of the tree, and the
judge owes only where the diff contradicts one or decides what no record
holds.**

**A record carries no implementation status.** `RECORD_RULE` in
`src/lanes/lenses.mjs` says it, the `truth` criterion holds a record to it, and
the birth brief, the write rules and the reconciliation ticket say it in the
words a seat reads. The decision is the whole content. The code landing changes
no record, so the run that builds a decision owes that decision's record
nothing. A record the tree has not caught up with is still the record.

**The criterion has two grounds and no third.** `OWED_CRITERION` in
`src/lanes/reconcile.mjs` is one text with three readers: the stage's judge, the
recheck a repair round owes, and the judge that reads the merge. Owed is
`contradicts`, where the diff moves past what an active record decides, or
`undecided`, where the diff makes a decision whose reason and rejected options a
reader of the code cannot recover. A diff that builds what an active record
decides owes nothing.

**Every owed record names its ground.** `reconciliation-judged` carries
`causes`, one word per record in the order `records` names them, and the words
are closed in the ledger registry. `records` stays a list of paths, because six
readers take it as strings. A judgment whose causes do not answer for its
records is stamped as one the seat could not make, and the stage buys the cycle
over the born set behind it: the ledger never carries an owed record whose
ground nobody can read.

**One writer, one reviewer, one corrector.** The write step spawns one
`reconcile-write` seat with the whole owed set and the neighbourhood the set
shares. The review step spawns one `record-review` seat over the records the
cycle holds. A corrective round spawns one writer with every open finding and
every red layer. Two or three records in one writer's context is a gain: the
writer sees the set and cannot write two that decide one point differently, and
the reviewer answers the `consistent` criterion across the set rather than
across a list it was told about. Each seat carries the slot suffix at one, so
the budget, the cost line and the failure record are keyed as they always were.

**The resume reads the commit body.** One round makes one commit, with the
subject `reconcile: <run> <seat> @<since>` and the records it wrote in the body,
one path per line. `roundCommits` reads that body. `record-written` is stamped
once per record from the one report, and a record the report answers for in
neither list is stamped `failed` with the word `unreported`. So a stop between
the commit and the stamps re-reads the body and stamps from it, and the seat is
dispatched again never; and `writtenAlready`, `unwrittenOf` and the centre read
what they always read. A record the round left out rides the render as
`unwritten:<record>` and the next round dispatches it by name; that is not the
fallback route, which belongs to a round that delivered no report at all.

**`gates.reconcile` says where the judge runs.** `full` runs the stage in front
of the ship token, with everything above. `advisory` takes the stage out of that
path: it runs the record layers once over the born set, stamps
`reconcile-skipped {mode, layers}` and hands the run on, spawning no seat and
fetching nothing. The layers run because that stage is the one place a project's
form gate reads a born record before it merges, and a red one rides the request
body under "Records" and blocks nothing. Every downstream reader already takes a
missing record certification as "the lane certifies no records", so the
admission gate, the update stage, the fast path, the merged stamp and the close
need no change. The records lane runs `full` in either mode, because its diff is
the records and its birth is the judgment.

**Under `advisory` the judge runs after the merge.** In the close-out, after the
merge commit is watched to terminal and before anything else resets the tree, one
judge seat reads `git diff <mergeSha>^1 <mergeSha>` on the same criterion, and
stamps `reconciliation-judged` with `advisory: true`. `reconcileClose` then
writes the ticket it already writes, into `<home>/tickets/drift/drift-<run>.md`,
and the ticketed line carries `advisory: true` too. The judge is derived from
the ledger and never remembered: a stamp with that field says it ran, so a
daemon restart inside the close-out spawns no second one. Every failure is
quiet and the close proceeds, because a record blocks no run and one the harness
could not judge blocks nothing either.

**The drift set waits for a person.** `owedReconciliations` skips a judged stamp
with `advisory: true`, and skips one whose ticket file is absent at the stamped
path: a ticket the owner moved into the drift set by hand is held for the same
reason, and reading the file rather than a second stamp is what makes that move
the whole of the action. The sweep returns at once where the project's word is
`advisory`. So nothing auto-launches a drift ticket under either word, and a
project that flips back to `full` launches none of the ones it already holds.
The owner applies the set by launching the records lane on a ticket, and the
daemon stamps `run-launched.driftTicket` from the path.

**Two refusals stand at the launch door under `advisory`.** A records launch the
frontier asked for is refused, and the same ticket from the console runs. A
repair ticket that names records beside code is refused with the word in the
reason: no reconcile writer runs in that mode and the dev seat is denied the
record paths, so the records would ride nowhere. That is a narrowing of the
repair lane, and the ticket is split before it launches. The records lane's own
readiness asks the first question again from the config the run pinned.

**The brief says what is true.** The record block a seat reads closes with the
sentence its run earns: where the stage judges, a record is written by a record
seat and the reconciliation stage owns every change to one; where the judge runs
after the merge, these records are context and no seat of the run writes or
edits one.

**Two measures and one alarm.** The centre's records tile reads the record seats
per shipped run over the last twenty ships, beside the records those runs wrote,
and the drift count: the tickets under the drift directory no run has launched.
The `record-owed-window` metric is the share of the last twenty ships whose
judge owed, over the ships whose judge ran before the merge, with a standing
band above half. A breach says the criterion has drifted back to owing on
everything, and the causes on the judgments say through which word.

## Consequences

The criterion "a decision the code cannot show" is a judgment, and a judge that
reads it loosely owes on everything again. The cause field and the
`record-owed-window` band are what catch that, and neither catches it inside one
run.

A record that states an unbuilt part goes stale the day the code lands and stays
stale until its own decision changes. Nothing rewrites it for the sentence. The
decision it states is still right, which is what a record is for.

One writer over a set is one context that can run long. The attempt budget and
the cost line are the set's rather than a record's, so a wide set spends its
budget on the set: `record-write-time` is the reading, and its answer is the
width of the set rather than the order of the writes.

One reviewer over a set can sample it. The first-read measure beside the
standing findings is what says so: a `later` count that grows against a flat
`firstRead` is one seat reading three documents as one.

Under `advisory` a merge can contradict an active record and ship. The drift
ticket is the only trace, and nothing reads it until the owner launches it. The
held count against `gates.driftHeld` is the one alarm.

Under `advisory` a born record ships with one layer run and no review seat. A
form defect is caught. A wrong decision in a born record is caught by nothing
before the merge, and the judge after it reads contradiction and undecided, not
the record's own quality. That is the trade the word buys.

The close-out holds the run's slot a few minutes longer under `advisory`, for
the judge. No ship, no verdict and no other run waits on it. The stage's own
duration band sees a stage that spends almost nothing and a close-out that
spends more, until the history holds enough of each.

## Rejected options

- Turn the stage off and record nothing. The drift is then unknown, and a return
  to `full` starts from a tree nobody can trust.
- A post-merge watcher outside the run. It needs a checkout primitive, a ticket
  writer that works with no run ledger, and a second liveness contract. The
  close-out already holds the merge commit and the ticket writer.
- Remove the stage from the lane lists. Lanes are composed once per daemon from
  instance config and cannot read a project config, so removing the stage needs
  a retired-stage entry on every lane. That is a one-way door, and this word is
  two config lines in either direction.
- A third value on `repo.recordLifecycle`. The lifecycle word says how a record
  is changed. Using it for whether the harness changes one loses `supersede` on
  the way out.
- Keep one seat per record. Per-record budgets bought little at three records
  and cost several times the seats at eight, and a per-record writer cannot see
  the set it is splitting a decision across.
- Put the cause inside the records list. Six readers take that list as strings,
  and every one of them would have to change to read a field none of them wants.
- Refuse a judgment whose causes are wrong at the ledger. The stamp would throw
  inside the stage and fault the run over a document. The words are closed in
  the registry and the judgment is stamped as one the seat could not make, so
  the run goes on and the ledger stays true.

## Fallback path

The alternative is the word: a project that finds the drift set piling up past
its threshold sets `gates.reconcile` back to `full`, and the stage runs in front
of the ship token again on the next launch. The switch trigger is the held drift
count against `gates.driftHeld`, or a merge that contradicted an active record
and cost a later run. The reversal cost is one config line and no harness
change. The alternative to the single writer is the per-record dispatch, whose
switch trigger is a `record-write-time` band breach with a wide set behind it.

## References

- ADR-0007, ADR-0026, ADR-0074, ADR-0076, ADR-0080, ADR-0086, ADR-0089
- Superseded on the named points by this record: ADR-0075 (one seat per record),
  ADR-0079 (a dispatch per record with its own budget)
- `src/lanes/reconcile.mjs`
- `src/lanes/records.mjs`
- `src/lanes/records-stage.mjs`
- `src/lanes/review.mjs`
- `src/lanes/lenses.mjs`
- `src/lanes/units.mjs`
- `src/lanes/ship.mjs`
- `src/config/project.mjs`
- `src/daemon/daemon.mjs`
- `src/daemon/home.mjs`
- `src/frontier/reconciliations.mjs`
- `src/frontier/autolaunch.mjs`
- `src/ledger/registry.mjs`
- `src/center/snapshot.mjs`
- `src/tripwires/registry.mjs`
