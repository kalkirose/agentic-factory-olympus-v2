# ADR-0015: Terminal-state discipline

Status: accepted (2026-08-15)

Three things in the harness reach a terminal state and stay there: a run, the
directory the closed run leaves behind, and a loud record. All three are
governed here, because they go wrong the same way — a machine ends something
on its own authority that the owner wanted to decide, or leaves something open
that nothing will ever close.

## Decision: how a run ends

A run reaches `run-closed` through three routes only:

1. the ship step's close-out, which closes `shipped`;
2. a human kill, which closes `killed`;
3. a human answering any park with `abandon`, which closes `failed`.

Every other condition that a lane meets on its own parks the run. A refusal
that happens before provisioning throws at the console or at the daemon
handler and opens no run at all, so it stamps nothing.

- **Every park type offers the abandon.** The engine writes it into the
  answer-forms declaration of every park record, so no park site can raise a
  question the owner cannot end (ADR-0029). The route is one, whatever the
  park was about.
- **Three recovery park types** are in the closed catalog: `seat-failure` (a
  seat work product past its corrective invocation), `stage-blocked` (a stage
  precondition the run cannot settle itself), and `command-error` (a
  configured command that could not run). Each one offers `retry` beside the
  abandon, and a text slot for what the operator changed. A recovery park is
  the same `park` event under a new type; it is no new ledger event.
- **The park carries the close it replaced.** The park event holds `reason`
  and `detail`, which are the close directive the condition would have taken.
  `abandon` closes on that record, so the run fails on the original reason
  with its original fields, whatever the resumed stage meets afterwards. A
  decision park records no close of its own, so it closes on the condition its
  type names: a `second-stall` park answered `abandon` fails on
  `second-stall`.
- **The abandon guard runs at stage entry.** `withAbandonGuard` wraps every
  handler of every lane, and reads the run's latest park of any type. An
  answered abandon closes the run before the stage spends anything else, so
  the answer never buys one more seat, and no park type needs a close
  directive of its own.
- **One answer buys one attempt.** A bought retry re-enters the stage once.
  The failure that follows it parks again, and the next answer is a fresh
  decision. Nothing loops on its own authority, and no arm counts elapsed
  time.
- **The retry carries the evidence.** In a lane contract loop the bought
  retry is one invocation with the recorded defect list in its brief, not a
  second corrective round. The corrective round already ran before the park.
  A resume-by-report shortcut is bypassed for that invocation: the stamped
  report is the one the checks refused, so replaying it buys nothing.
- **The ledger is the only state.** The retry budget, the abandon answer and
  the original reason all derive from the run ledger. A daemon restart
  replays to the same position, and a parked run waits on the human across
  the restart.
- **Judging seats are covered.** A triage or verifier seat that fails its own
  deterministic checks parks under `seat-failure`. A judge that cannot
  deliver a usable verdict is not the run failing.
- **A corrected intake ticket may ride the answer.** A `stage-blocked` answer
  whose text is an absolute path replaces the repair lane's ticket path. The
  verdict stage and the ship step both read it from the ledger.
- **A structural test holds the closed set.** It scans the source for every
  close directive, asserts the set of `state:reason` routes, and asserts that
  `run-closed` is stamped in the engine alone, from the directive route and
  the kill. The set is two entries: the ship close-out, and the abandon route
  with the reason its park recorded. A new close route fails CI until it is
  added deliberately.

The decision parks keep their own affirmative options: `round` at
`spec-gate-stalled`, which is the one park the spec gate raises (ADR-0020),
`strengthen-again` at `second-zero-kill`, `accept-spec-indifferent` at
`unkilled-gap-survivor`, `repair-again` and `fresh-pass` at `second-stall`,
`retry` at a provisioning gate over the substrate and `ack` at one over a
harness defect (ADR-0068). The way out is the same `abandon` at all of them.

## Decision: how a closed run reaches the archive

A close ends by moving the run's directory — ledger and artifacts together —
to `archive/runs/<runId>`. It follows `run-closed`, it never runs for an open
run, and it is the only step of a close that touches a path a process outside
the harness can be holding.

- **The rename retries first.** Five attempts, with a backoff that grows by
  20 ms per attempt: about a fifth of a second in all. A reader that is
  passing over the ledger — a tail, an editor, a scanner — is gone inside that
  window, and the move lands as the move.
- **Then the move copies.** A rename the ladder could not complete becomes a
  recursive copy of the directory into the archive, and a delete of the
  source. Copying reads the files rather than renaming their parent, so it
  gets past the class of hold that blocks a rename outright.
- **A copy the source outlives is still an archive.** If the delete fails, the
  copy is the authority from that moment and the live directory left behind is
  named on the archive stamp. Readers already resolve a run id to the archive,
  so the copy is where the run lives whether or not the leftover ever goes.
  Nothing about it is loud: there is no decision in it for the owner.
- **A failed copy leaves nothing half-written.** A partial archive directory
  reads as a finished archive, both to the guard that refuses a second archive
  and to every reader that falls back to the archive. A copy that throws takes
  its own directory with it, and the run stays exactly where it was.
- **A blocked move is stamped, and the daemon carries on.** `archive-failed`
  on the instance ledger, loud, one open record per run, carrying the run id
  and what the filesystem said. Nothing else about the close changes: the run
  closed in its recorded state, its slot is free, and its ledger is complete
  where it stands.
- **The next start sweeps.** Daemon start walks `runs/`, and a closed run
  sitting there is archived before anything else runs. The hold belonged to
  another process and rarely survives the gap between two daemons. The archive
  stamp that lands is what answers the loud record.
- **The same sweep clears a leftover.** A closed run whose archive directory
  already exists is the source of a copy, so the start deletes it — against
  proof that the copy is whole, which is an archived ledger no shorter than
  the live one. An archive shorter than that is not the run, and the sweep
  says so loud instead of deleting anything.
- **The guards do not move.** An open run is refused, an already-archived id
  is refused, and both answers come before the first filesystem call: a
  refused archive never spends a retry ladder on a run it was never going to
  move.

## Decision: what a stamp behind the close costs

A run's ledger closes at `run-closed`, and the archive moves the directory
behind it. An append that arrives after that lands nowhere, answers null to
its caller, and produces one quiet `late-append` record on the instance
ledger. It is never a throw.

- **The tolerance is the closed ledger, and nothing else.** A late append is
  refused for every reason a live one is: an event no registry holds throws,
  a stream-classed event without a gist throws. Only the closed descriptor is
  forgiven, and only for a store the harness closed on purpose. The ledger
  primitive under the store still refuses an append to a closed file, so a
  writer that holds one directly is unchanged.
- **It covers every run-scoped append, not the seat exit alone.** The
  tolerance sits in the telemetry store, so the terminated child's exit
  stamp, the progress line its stdout was still carrying, a poll the ship
  watcher had in flight, and a semaphore grant handed over by another run's
  release are all one case with one answer. A kill that had to be patched
  per call site would be a kill that faults at the next call site added.
- **The record names the run, the event and the seat.** `late-append` carries
  the run id, the event that did not land and the actor and seat behind it —
  enough to read what was dropped, and none of the payload, which can be a
  stderr tail or a report. It is quiet: it opens no queue line and no alert,
  and it takes no resolution, because it asks nobody for anything.
- **A late append with nowhere to record is still not a fault.** The instance
  ledger closes at the daemon's own stop, and a seat can outlive that too.
  The drop stands on its own; the record is best effort behind it.
- **The kill does not wait.** Terminating the seats and closing the run stay
  one synchronous act, so a kill lands when the operator asks for it rather
  than when the last child agrees to die.

## Decision: how a loud record ends

Every loud class names the event that owns it, in one table
(`src/ledger/resolution.mjs`). An owned record resolves the moment its owning
event lands.

- **The table is complete and structurally held.** Every event in
  `LOUD_EVENTS` has an entry, and every entry either names the ledger event
  that owns it or states in prose who else settles it. A loud class that says
  neither fails CI.
- **The sweep is keyed on the append, not on the call site.** The engine
  hooks every run-ledger append; an append of an owning event sweeps the
  ledger and pairs every resolution its own events owe. No lane has to
  remember to clear a record another lane opened, and a resolution never fails
  the append it followed. An instance-scoped class pairs the same way, at the
  one place its owning event is stamped.
- **The owner must land behind the record.** A candidate owner is an event of
  the named type at a higher seq, judged by the rule's own predicate where
  the class needs one. A record already carrying a `resolved` is skipped, so
  the sweep is idempotent across a restart.
- **The four run-scoped pairings.** A capture refusal is owned by
  `implementation-committed`, the capture that got through. A capture
  take-back is owned by `re-freeze`, which re-takes the frozen surface the
  write reached. A green-but-no-merge alert is owned by `merged`. A harness
  finding is owned by the first `verdict-rendered` whose open set no longer
  holds it.
- **A red-merge breach is owned across ledgers**, by the fix of every escape
  it ticketed. The repair run's close-out pairs it back onto the breached
  run, live path first and then the archive, and only onto a run that already
  closed. It is best effort: the breach record is a fact either way, and a
  repair that shipped never fails on the bookkeeping of the run it repaired.
- **A blocked archive is owned by the archive that lands.** The record says a
  closed run is still sitting in `runs/`; the `run-archived` stamp of the same
  run says it no longer is. The pairing is by run id, because another run
  reaching the archive says nothing about this one. The owning event is
  instance-scoped, so the sweep runs where that stamp is appended.
- **Two classes have no ledger owner.** A budget breach asks nothing of
  anyone, so its life ends when the run it reported on does. A liveness
  violation says the run stopped being a run, so only the human clears it.
- **The close-out sweep is the backstop.** At `run-closed` the run pairs a
  `resolved` to every open record in `CLOSE_RESOLVED_EVENTS` — a budget breach
  and a capture record — whose owner never landed. The note names the state
  the run closed in.

## Why a recoverable failure is a decision, not a defect

Three runs died to conditions that a human could have cleared in a minute.

A suite seat returned a report that did not validate twice, and the run
closed. That run held a frozen suite and a full verdict. A triage seat named
a persisting finding id that was not in the open prior set, which is a
bookkeeping mismatch in one field of one report, and the run closed after a
complete dev pass. The two closes discarded more than $150 of sound work.

None of the three conditions said anything about the story, the spec or the
tree. Each one said that a seat had a bad minute, or that an input was in the
wrong place. The harness answered a cheap defect with the most expensive
action it has: it threw away everything the run had earned, and the relaunch
paid for all of it again.

A close is cheap only while a run holds nothing. Before the first seat runs, a
close costs a provisioning cycle. After the freeze, a run holds a validated
spec, a suite proven red and killed against adversaries, one or more dev
passes and a rendered verdict. Re-deriving that set costs the whole run. The
machine cannot weigh that, because it knows neither what the artifacts are
worth nor what a relaunch would cost. The owner knows both.

So the failure stops the run and waits. The park frees the slot like every
other park, the evidence is already in the ledger, and the owner spends one
answer to buy a retry or to abandon the run on purpose.

## Why the spec-gate precedent generalizes

The spec gate reached this conclusion one milestone earlier, on the same kind
of evidence: a run closed on a list of known findings with about $21 of seat
work in it, and the fresh birth that replaced it re-derived every one of them.
The gate's answer was to park with `round` and `abandon` instead of closing,
and to read whether the round it granted was spent off the answered parks in
the ledger.

That answer never depended on anything specific to the spec gate. Its
premises are that the run holds work the condition does not invalidate, that
the machine cannot price the relaunch, and that an unbounded retry is unsafe.
All three hold for an invalid report, a work-product defect, a missing input
and a command that will not spawn. The shapes carry over one for one: the
options are two, the grant is exactly one attempt, the count comes from the
answered parks, and the ledger replays it.

The one shape that does not carry over is the key on the round. The gate
spends rounds that can succeed, so a bought round must be spent before the same
condition asks again, and the gate keys its park on the round that raised it. A
recovery park needs no key: the failure itself proves that the last retry was
spent, and an abandoned park closes the run at the next stage entry, so no
stale answer can survive.

## Why a blocked move is never the daemon's fault

A run closed shipped. Every seat had reported, the merge had landed, the
close-out had run. The rename that moves the directory to the archive answered
EPERM, because a process outside the harness was holding the run ledger open.
The daemon read the throw as a fault of its own and stopped.

Two costs sat on either side of that throw, and they are not the same size. A
run directory in the wrong place costs a reader nothing: every reader already
resolves a run id to the live path first and then the archive, because it has
to. A daemon that stops costs every open run in the instance, every queued
launch behind them, and the human's next free hour. The harness answered the
cheaper of the two conditions with the more expensive of the two actions,
which is the same error the close routes above were written to prevent.

The hold is also never the harness's own. The run's store is closed before the
move — that is the discipline the archive step has always carried — so the
handle belongs to an editor, a tail, a scanner, a backup pass. Nothing the
harness does makes another process let go. Waiting is therefore the entire
cure for the readers that pass, and copying the files instead of renaming
their parent is the cure for most of the rest, and neither one is a decision
the owner needs to make.

What the owner does need is to be told. An archive that quietly did not happen
leaves a closed run in a directory that means "running", and nobody finds it
until something else goes wrong. So the block is loud, once per run, and the
start-time sweep exists to answer it: the record is not a chore for the human,
it is a statement that the harness owes itself a retry and will take it at the
next opportunity it has.

## Why a late stamp is dropped rather than kept

A kill closed a run and the archive moved its directory, both in the act the
operator asked for. A moment later the terminated seat's process finally
ended, its exit handler stamped the seat's terminal event into the ledger the
close had shut, and the append threw. The daemon read the throw as a fault of
its own, recorded the death and stopped. The kill worked; it cost a restart.

That is the blocked move again, in a second place: the harness answered the
cheaper of two conditions with the most expensive action it has. A stamp that
arrives after a close changes nothing a reader will ever ask for. A daemon
that stops takes every other open run in the instance with it — and a kill is
exactly the moment an operator is dealing with one problem and can least
afford a second.

Keeping the stamp is worse than dropping it. Reopening the live ledger
recreates a run directory the archive just moved, and a directory under
`runs/` is what the next start reads as a run to resume. Writing into the
archive gives a finished run a tail written after its own close, when every
reader of a run treats `run-closed` as the last word. And the content is not
missed: the close already recorded what ended the seat, with the state and the
actor. The child's own exit adds the exit code of a process the harness itself
told to die.

What is worth keeping is the fact of the drop. A machine that discards a write
says so somewhere, or nobody can tell a tolerated race from a lost stamp. The
instance ledger is where that record belongs — it is the ledger of the daemon,
not of a run, and the run in question is over. The record also measures the
window between a close and the exits behind it, which is the one number that
would decide whether a kill should ever wait.

## Why a loud record ends at its owner, not at the run

The loud strip is the one surface the owner is shown before being asked to
look for anything. Its value is entirely in what it does not hold. A strip
that carries four items all day, three of them business the harness itself
settled hours ago, is a strip the owner learns to scroll past — and the fourth
item is the one that mattered.

Resolving at run close was the wrong instinct dressed as caution. It is true
that a finished run's alerts should not survive it. It does not follow that
they should survive until then. A take-back is answered the moment the verdict
re-freezes the surface the write reached: from that stamp on, the record
describes a handled case, and every minute it stays open is a minute of the
owner's attention spent on nothing.

The general form is that each loud class already has an event that answers it.
Two classes had that event wired at their own call site, one class had it
wired for one of its two record shapes, and the rest waited for the close.
Naming the owner per class in one table makes the question answerable rather
than remembered: what does this record wait for, and did that happen? A class
whose honest answer is "nothing in the ledger" says so, in the table, and
takes the close backstop or the human.

Keying the sweep on the append rather than on the call site follows the rule
the stream indexes already hold to: a pairing that must be remembered by the
site that opened the record is a pairing that goes missing the first time a
new route opens one. The engine sees every append. It is where the guarantee
can be structural instead of conventional.

## Fallback paths

If a recovery type costs more human attention than it saves, that type
returns to a close. Trigger: three consecutive parks of one type answered
`abandon`. Reversal cost: low. The helper returns a close directive again and
the catalog entry can stay.

If one attempt per answer proves too coarse for a seat that fails in bursts,
the option set gains a counted grant like the spec gate's `round`, with the
same ledger-derived accounting. Trigger: two runs in which the owner answers
`retry` three or more times for one seat. Reversal cost: low. One counter and
one option string.

If three types prove too coarse for the console queue, `stage-blocked` splits
per stage so the queue line says what the answer must fix. Trigger: an
operator cannot tell from the queue what an answer costs. Reversal cost: low.
Catalog entries plus the call sites that name them.

If the park detail on the ledger grows past a readable line, the close keeps
the reason alone and the detail stays in the park record. Trigger: a park
event that no console can render. Reversal cost: low. One spread disappears
from the abandon route.

If the retry ladder proves too short for the holds this harness actually meets
— a scanner that keeps a directory for seconds rather than milliseconds — the
attempt count and the backoff grow, and the ladder moves off the close path
into a deferred sweep so the close never waits on it. Trigger: two blocked
moves that a longer wait would have cleared. Reversal cost: low. Two numbers,
or one call site.

If the ledger-length proof behind a leftover delete turns out to be too weak —
a copy that lost an artifact while the ledger travelled whole — the proof
becomes a per-file comparison of the two directories. Trigger: one leftover
deleted over an archive that was missing something. Reversal cost: low. One
comparison, at the place that already walks `runs/`.

If a dropped stamp turns out to carry something a reader needed — a cost a
closed run never recorded — the kill waits a bounded moment for the children
it terminated before it closes, and the drop keeps the payload it names.
Trigger: one closed run whose recorded cost is short of what its seats spent.
Reversal cost: low. One await on the close path, or one field on the record.

If an owning-event pairing proves too eager — a record cleared while the
condition it reported still holds — that class loses its owner and returns to
the close backstop or the human. Trigger: one case where the owner had to
re-open a record the sweep resolved. Reversal cost: low. One entry in the
table drops its `owner` and gains a `by`.

If the per-append sweep becomes a cost on long run ledgers, it moves to the
handler-settle point, where the engine already re-reads the ledger for the
liveness check. Trigger: measurable append latency attributable to the sweep.
Reversal cost: low. The same function, called from one place instead of the
store hook, at the price of resolutions landing a stage later.
