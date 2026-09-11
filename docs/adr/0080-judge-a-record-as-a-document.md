# ADR-0080: Judge a record as a document: the gate reads its form and one seat reads its truth

Status: accepted (2026-09-10)

## Context

A decision record had four readers. The project's form gate read the form. The
harness read the form again with a tokenizer of its own, read every sentence a
second time with a verb list, and read the lifecycle a third time with checks
that mirror the gate's pairing. The review seat read the record a fourth time to
file a kind, a verdict and a path for every sentence.

Every mirror disagreed with the gate somewhere, and every disagreement refused a
record that was right. Almost every refusal the stamp recorded was on a record
the gate accepted and a person would accept. Each round of tuning the tokenizer
against the gate found the next difference. A mirror that has to equal the gate
is the gate, written twice.

The seat that filed a reading of every sentence answered a question nothing can
check: a sentence's kind is a reading of the sentence, and the harness can only
match words. Seventeen of twenty-one refusals on the verb list were rationale
sentences that hold the word "is".

A record also stopped runs. A review seat refused twice parked a run over the
reviewer's own bookkeeping. A cap parked a run and asked a person for a number
the harness already had. A record conflict at a merge bought a fresh pass over
certified code. None of those defects is about code, and none of them can be
answered by asking a person to look.

## Decision

**The harness reads no token, no verb and no path of a record.** The project's
form gate reads the form, in the seat's own shell before it reports and again at
the render over the committed bytes, which are the bytes CI would read
(ADR-0076). The review seat reads the truth. The harness reads the ledger: which
records a dispatch owns, which files a seat may change, and what the stamps say.

`recordUnits` in `src/lanes/units.mjs` stays as an address book. A finding names
a unit, a head and a line, so a writer and a reader reach one sentence by one
name, and `matchUnits` carries a finding across a write. No seat answers a unit
and no check reads one.

**The write report is the record.** `reconcileWriteSchema` in
`src/lanes/records.mjs` asks for the records the seat rewrote, the records it
left alone with the reason, and, on a corrective invocation, the finding ids it
answered. An `answered` entry carries `disputed` with one sentence where the
writer read the record and found it right; the next cycle's reviewer reads that
record fresh and either raises the finding again or does not.

**Three readings of what a seat left, and none refuses.** First, a commit the
seat made on top of the daemon's own is unwound into the working tree and
stamped `diff-policy-recapture` with `class: 'seat-commit'` and the shas. Both
readings after it read the dirty tree, and a seat commit empties that tree: every
record the seat wrote would be dropped as unwritten, and a write outside the
record tree would ride the commit past the revert. The floor of the unwind is
the newest first-parent ancestor of HEAD that the daemon authored or that is the
run's base sha, so the daemon's one commit, signed with its own identity, holds
what the seat wrote. The brief tells the seat not to commit; the unwind is what
makes the rule cost nothing when a seat does. Second, a changed file outside the
record tree is reverted to the tree's last commit and stamped
`diff-policy-recapture` with `class: 'record-seat'`: a record run must not ship
code, and a revert costs no attempt where a refusal costs one. Third, a record
the report lists as rewritten that the tree did not change is dropped from the
list, with the note on the stamp. The one refusal a record write still takes is
the runner's own: a report that is not the JSON the schema names is no report.

**The lifecycle has one implementation, and it is the project's.** The briefs
state rule 13 as the rule the seat writes to, and the form gate reads the
pairing. The harness holds no copy, so the two cannot disagree again. A project
with no gate and `recordLifecycle: supersede` gets no pairing check at all,
which is right: the harness enforces no project rule it does not run.

**Three criteria.** `RECORD_CRITERIA` in `src/lanes/lenses.mjs` holds `truth`,
`consistent` and `form`. `truth` states that every present-tense claim is true
against the tree, that a part not built is stated as not built, that a
divergence is named in the record, and that every name the record cites means
what the record says it means. `form` is a defect of the standard the gate
cannot read, by rule number.

**A record does not cite the standard.** It cites the records it relies on. The
line is a rule of the project's template and one line of every record brief, and
no check, no gate rule and no finding reads it.

**The records lane spawns no judge.** Its diff is the records, so "does this
diff move past a record" is answered by the birth. `judgeStep` stamps
`reconciliation-judged {ok: true, owed: false, born, late: [], source: 'born'}`
and the cycle runs over the born set. The story and repair lanes keep their
judge and its scope, because a story diff is code and the question is semantic
(ADR-0026). A judgment that failed on those lanes carries the born set too, so
the stage still buys the cycle over it rather than shipping it unread.

**A record round spawns no verifier.** `settleFindings` takes a `verify` flag;
the record round passes `false` and a HIGH is confirmed as its reviewer raised
it. The record verifier confirmed every item it was ever given, so the guard it
gave against a wrong block costs less as the writer's own dispute. A prior
confirmed finding resolves when a fresh seat reads that record in a later cycle
and raises nothing on the same sentence. The centre reads the first-read measure
beside the standing findings, so a reader sees what one read of a record catches
and what a later cycle catches after it.

**One corrective round on record content.** `DEFAULT_RECONCILE_ROUNDS` is one,
on every lane that reads a record. A second round asks a second writer the same
question about a document one writer already answered. `gates.reconcileRounds`
keeps its meaning for a project that names a number.

**Nothing blocks a run on a record.** A write dispatch that fails stamps
`record-written {failed: true, reason}` and the round goes on to the next
record. A review seat that fails stamps `record-unreviewed` and its record rides
the render under `unreviewed`, open for the next cycle. A red layer that names
no active record dispatches nothing and stalls at once. A record conflict at a
merge drops the run's own change to that file, which takes the default branch's
version. A birth that spends its ladder on the story and repair lanes stamps
`records-committed {birthFailed: true}` and the run goes on to its freeze; the
records lane keeps that one park, because a birth that delivered nothing leaves
that lane no work.

**Every lane ends in a merge.** `stallStep` stamps `reconcile-stall` and takes
`fallbackStep` with cause `record-cap` on every lane. The run pushes, the
request body names every confirmed finding that still stands under "Findings not
answered", the count of findings below HIGH per severity under "Remarks not
answered", and every record no round wrote and no seat read under their own
headings. A remark's own line stays on the ledger: it opened no round, it blocks
nothing, and a body that carried every one of them grew with the review past the
command line of the process that opens the request, so the request says how many
and the ledger says what. The close
stamps `run-closed {state: 'shipped', pr, remarks, unwritten?, unreviewed?}`,
where `remarks` holds the standing confirmed ids beside the advisory ones and
every finding stamp keeps its own `confirmed` flag. A merge round that drops a
record after the request opened writes the body again and stamps
`pr-body-rewritten`, so the body a reader opens names the same set the close
stamps. A forge that refuses the edit blocks nothing: the stamp carries the
reason, and the close names every record either way.

**The resume reads one stamp.** `record-written` lands right after each commit
and for each failed dispatch, and `writtenAlready` reads it and the round's
commit subject and nothing else. A failed entry is stepped over with its entry
copied, so a stop inside a round never re-dispatches a record the round already
spent. `record-reviewed` and `record-unreviewed` are the review's boundary.

**The gate runs where the seat can run it.** The readiness stage of the records
lane runs the `needs` closure of `gates.recordLayers` once in the worktree, so
the seat that is told to run the form gate has what the gate needs.

**Every reader of the run's record work opens at one window.** `runWindow` in
`src/lanes/records.mjs` is the merge base of the run branch and the default
branch, computed at the read. The record scope, the closure rule and the layer
plan read that window and not a round's own range. So a default branch that
moves during the run costs the run's readers nothing, and a record another run
merged meanwhile belongs to that run.

## Consequences

A lazy reviewer is caught later rather than sooner. The unit list made a skipped
sentence visible at the report; now it is visible when a later cycle raises it.
The standard's word cap and the no-diff brief bound the risk, and the centre
reads a HIGH a later cycle raises on a record an earlier cycle passed.

A writer may ship a contradiction it disputed. Without a verifier, a writer that
answers a HIGH with `disputed` and a wrong reason is caught by the next fresh
reviewer or not at all.

A confirmed contradiction can merge. A finding a reviewer graded HIGH and no
round answered ships in the record, named on the close stamp and in the request
body. The centre reads how many runs merged that way and how many findings they
carried.

A record-tree revert may drop a file a record cites. The gate's reference rule
then reds the render in the same cycle, and the writer answers it.

The story lane's recheck loses its unit intersection. A repair round past a
green render re-reviews whole the records the recheck judge names, at one review
seat per named record.

Three things are load-bearing: the project gate's own reading of a chain,
because it is the one reader of one; the `record-written` stamp, because the
resume reads it alone; and the record attribution of the layer plan, because a
records request's merge waits on what it says.

## Rejected options

- Keep the unit contract and tune the tokenizer. Every round of tuning found the
  next difference. The class is the second reader, and a tuning keeps the reader.
- Keep the units and make every check advisory. A check that refuses nothing
  measures a list nobody reads, and the seat still files four hundred entries.
- Move the tokenizer into a package the gate and the harness both import. The
  gate is the project's file, and a harness that imports a project's code judges
  every project by that project's rules. Running the gate is the shared package.
- Keep the sibling field and drop an entry that names the writer's own record.
  The field still asks forty boilerplate sentences per hub and decides nothing:
  a hundred and sixteen answers across four runs held no supersession.
- Bound the judge to the ticket's block. A judge that may owe only what the
  ticket names owes nothing on a records diff, so the seat is spent to say so.
- Keep the cap park and buy rounds. A park asks a person for a number the
  harness already has.
- A draft request that holds the work until a person marks it ready. It is a
  park by another name.
- Delete the review seat too and trust the gate. Twenty-two confirmed findings
  across two runs were sentences the tree contradicts, and no gate reads a
  sentence.
- One review seat over a whole batch. One seat over four records sampled them.

## Fallback path

The alternative is a verifier behind the record review and a park at the cap:
`settleFindings` verifies every round, and the stall asks a person for more
rounds instead of taking the merge. The switch trigger is a wave in which a
later run raises the same unit a merged run left standing more than once. The
reversal cost is one flag and one park type.

## References

- ADR-0007, ADR-0026, ADR-0038, ADR-0074, ADR-0075, ADR-0076
- Superseded by this record: ADR-0073, ADR-0077, ADR-0078, ADR-0079
- `src/lanes/records.mjs`
- `src/lanes/records-stage.mjs`
- `src/lanes/reconcile.mjs`
- `src/lanes/review.mjs`
- `src/lanes/lenses.mjs`
- `src/lanes/units.mjs`
- `src/lanes/ship.mjs`
- `src/ledger/registry.mjs`
- `src/config/project.mjs`
