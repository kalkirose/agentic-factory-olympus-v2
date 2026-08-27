# ADR-0034: Stage liveness telemetry

Status: accepted (2026-08-16)
Extended (2026-08-22): the net covered the polling stages and left the stages
that hold a seat outside it. The stage beat closes that, and the tripwire fires
on the shape that got through.
Extended (2026-08-26): the band and the reading against it are work, not wall
clock. A visit's waits come out of its sample and out of the live elapsed alike
(ADR-0039); everything else here stands.
Extended (2026-08-27): a layer start with no ending was half a record. Every
attempt now stamps how it ended, at one settle point in the runner; everything
else here stands.

## The condition

The no-timeout doctrine answers "is this alive?" with two things: telemetry
stamps, and the duration history to read them against. Only the first half
existed, and only for part of the run. The stages that run no seat — the ones
that poll a forge, or another run's ledger — stamped their entry and then said
nothing until they were done. A stage that sat for hours read exactly like a
stage that sat for a minute. The verdict stage was silent for a second reason:
it runs no seat and polls nothing while a gate layer runs, and a gate layer is
one child process that can hold the run for an hour.

Nothing could watch that. The tripwire watcher keys on appends, and a poll loop
that changes nothing appends nothing, so a stalled stage produced no state
change for a watcher to notice. The liveness invariant did not cover it either:
the invariant asks whether a run holds a child, a park, or a running handler,
and a stage stuck in its own poll loop holds a running handler and passes. The
one condition the harness could not see was silence, which is the condition a
stall produces.

The stages that hold a seat were left out of the first cut on the ground that a
seat stamps its own progress, so a stage supervising one is never silent. That
ground turned out to be an assumption about the seat rather than a property of
the stage. A seat went quiet at 13:55Z and stayed alive; its stage went four
hours with nothing appended to the run at all, and the whole apparatus built
here — the heartbeat, the band, the queued record — sat unused, because the one
stage that needed it was the one stage that did not beat. A stage's liveness
cannot be delegated to what the stage is holding: the thing being watched
cannot be the thing that reports.

The start stamp then produced a second condition of its own. A start with no
ending is half a record. An acceptance attempt started at 20:40, ran for 38
minutes, and vanished: no result, no reason, nothing. The next line for that
layer was a second start, and the second attempt replaced the first without a
word about either. A reader of that ledger cannot say whether the first attempt
went red, was killed, or is still running somewhere. The telemetry rule the rest
of the harness holds to — every terminal state stamps — covered runs and the
daemon and stopped at the layer.

The runner had five ways to end an attempt and stamped after two of them. That
is the shape of the defect, not the count: a rule each path has to remember is
a rule the next path added will not.

The banned answer is a clock that decides. A stage killed at a threshold is a
stage that loses a merge to a slow forge, and the threshold becomes the thing
the harness is tuned around. The doctrine's answer is the one taken here: make
the silence speak, and read what it says against what the same stage did
before.

## Decision

**A polling stage stamps a heartbeat, one per batch of poll outcomes.**
`stageHeartbeat(ctx)` opens at the top of a stage handler and beats once per
poll outcome that changed nothing. Every twentieth beat becomes a
`stage-heartbeat` stamp: the stage, what it waits on, the poll outcomes behind
the stamp, the time in the stage, and the evidence of the wait (the request and
the head sha, the merge commit). The three poll loops of the ship step beat —
the ship-token wait, the check watch, the merge-commit check watch — because
those are the loops with an outcome to report.

**The engine opens a stage beat over every handler it runs.** `stagePulse`
starts where `executeStage` starts and closes where the handler settles, and it
stamps `stage-heartbeat` on a five-minute interval for as long as the handler
runs: the stage, what it waits on (`seat`, naming the seats in flight, or
`handler`), the intervals it has stood for, and the time in the stage. Every
stage of every lane is covered by this one wiring, because the condition —
a run whose ledger says nothing for hours — belongs to no particular kind of
stage, and a list of the stages that need it is a list somebody has to keep
right.

**The stage beat stands down for any other voice.** It reads the seq of the
last `stage-heartbeat` the run recorded; a seq that moved since its last tick
means a polling handler has already said what this beat would say, and the beat
skips the interval. So a polling stage keeps its own richer record, no stage
stamps twice for one interval, and the guarantee an operator can rely on is the
cadence rather than the source: a stage in progress says something at least
every five minutes.

**Every gate-layer execution stamps its start.** `layer-started` carries the
cycle, the layer, the sha, and the attempt — the flake filter's red-only re-run
is the second — and it lands before the process does. A layer is one child that
can hold a run for an hour, and the runner stamped nothing between the route
that ordered the cycle and the first `layer-result`. One observed run went 70
minutes with a silent ledger there, and the only way to prove it alive was to
find the test process by hand. With the stamp, that hour reads as the layer it
is spending, from the moment it starts.

**The stamp is a record, never state.** The spectrum resumes off `layer-result`
exactly as it did: a layer already stamped with a result is skipped, and a
layer caught mid-execution runs again and stamps a second start for the second
execution. Nothing in the engine reads a start, so a lost one costs a reader a
line and costs the run nothing.

**Every `layer-started` pairs with exactly one terminal stamp.** An attempt that
judged the tree stamps `layer-result`, which now carries the attempt it belongs
to. Every other ending stamps `layer-abandoned`: the reason from a closed
vocabulary, what the attempt had printed by then, and the seq of the start it
closes. The vocabulary is six words — the red a re-run replaced, a command that
could not spawn, a child a signal took, a throw in the runner, a path that
decided nothing, and a start recovered after a death — and it grows the way
every registry in this harness does.

**The terminal stamp is written at one settle point, never per path.** The
attempt body records what it learned and stamps nothing. One function reads that
record, decides what the ending was, and writes the stamp, and it is called from
the `finally` that every ending of the attempt leaves through: an exit code, a
throw, and a `return` a later change adds. So "no attempt ends without a record"
is a property of the runner rather than a rule at each call site. A structural
test holds it: one append of a `layer-` event in the runner, one call of the
settle point, and that call inside the `finally`.

**A red the flake filter replaces is an ending like any other.** The first red
is not the layer's answer — the filter owes it one red-only re-run — so it
stamps `layer-abandoned` with its exit code and its output tail rather than a
result. The layer's own result still comes from the attempt that decided it, and
the resume still reads `layer-result` alone, so nothing about carrying and
skipping changes.

**An attempt above the first names what it replaced.** The start of attempt N
carries `retryOf`, the seq of the start it retries, and the trigger that spawned
it. A replacement is never silent, and the abandonment of the attempt it
replaced sits between the two.

**A start a dead instance left open is closed at recovery.** The daemon start
reads every open run ledger it resumes and stamps `unclosed-at-recovery` for
every unpaired start, before the stage re-enters and starts anything of its own.
The orphan sweep does the same for an open ledger the engine does not hold. Both
carry the sweep that found the attempt, which is the reader's only clue about
when it was closed. A closed run is left alone: it said its last word at
`run-closed`, and every reader treats that as the last word (ADR-0015).

**The pairing reader tolerates the older shape.** A `layer-result` written
before this decision carries no attempt, and one such result closed the layer
for its cycle however many attempts had run. It therefore pairs with every open
start of its layer and cycle. Without that rule the first recovery pass over an
existing home would invent an abandonment for every layer the harness ever ran.

**The batch is the volume control, and it is a count of poll outcomes.** A
stage that settles inside its first batch — or, for the stage beat, inside its
first interval — stamps nothing at all, so the ledger of a run that never
stalls keeps the shape it always had. At the shipped poll cadence a batch is
about five minutes, which is the stage beat's interval too, so an hour of
waiting costs twelve stamps whichever voice makes them and a stall of any
length costs a stamp every few minutes. The cadence of the reading stays the
project's; the cadence of the record is the harness's, and one is not allowed
to set the other.

**The clock starts where the stage starts work.** The handler opens its own
heartbeat, and a handler runs after the `stage-entered` stamp or after the
`resume` behind an answered park. A stage that waited on a human therefore
measures the machine's time and not the human's.

**The stage-duration tripwire keys on the heartbeat.** The watcher reads the
elapsed the stamp carries against the band that stage of that lane built in the
other runs of the project, live and archived. A stage past the band appends
`stage-overrun` to the instance ledger, queued, with the stage, the elapsed,
the band and the sample count. It opens once per stage — the condition holds
for as long as the stage does, and the operator asked to be told, not counted
at — and it closes when the stage ends, because a record that names a stage the
run has left is asking about business that is over.

**The band is the history, never a constant.** A visit runs from the entry (or
the resume) to the next stage or the run close. Visits still open are not
samples. A resumed entry ends no visit: the daemon was down, and the gap is the
daemon's rather than the stage's. The top of the band is the slower of the
slowest completed visit and four times the median, so a stage outside it did
something no completed visit of that stage ever did. The lane is part of the
key, because two lanes that share a stage name do not share its work.

**Cold start is silence.** Under five completed visits there is no band, and
the watcher says nothing. A harness with four ships has no statement to make
about the fifth, and a queued record built on a guess teaches an operator to
ignore the record.

**Detection only, by construction.** The watcher holds no run, opens no run
store and returns no directive. It cannot kill a run, move it, or change what
it waits for, and the run whose stage overran carries on exactly as it would
have. No span of wall-clock time appears in the condition: the band is the
history, and the trigger is the heartbeat — a state change, appended by the
stage itself. The stage beat does not change that. It writes a record and reads
nothing; the interval it runs on decides which millisecond the record lands in
and decides nothing else.

## Why the record is not written into the run

The run ledger is the run's own account of itself, and everything in it is
something the run did. An overrun is somebody else's reading of the run, taken
from outside, and the reader is a watcher that must never be able to touch a
run. Writing from the watcher into a live run ledger would also put a second
writer on a file the engine owns, which is the one way an append-only ledger
loses its ordering. The instance ledger is where cross-run observations already
live, and the queued stream carries the record to the operator from there.

## Why the stage beat runs on an interval and the poll beat counts outcomes

A poll loop has a natural unit: each poll is an outcome, and a batch of them is
a quantity of reading the ledger can report. A handler holding a seat has no
such unit — there is nothing to count, which is exactly why the stage was
silent. The only honest thing such a beat can say is "this stage is still in
progress, and it has been for this long", and the only cadence available for
saying it is one the harness picks. That is a clock in the writer, not a clock
in the condition: nothing reads the interval, nothing compares against it, and
a beat that never fires costs a reader a line.

The two cadences are set to the same five minutes on purpose. An operator
reading a run ledger should not have to know which voice a heartbeat came from
to know how long a gap between two of them means.

## Why the beat names the seats rather than trusting them

The four silent hours were a seat that was there and doing nothing, so a stage
that reports "I hold a seat" is reporting the fact that misled everybody. It is
still the right thing to record, because it is what an operator needs first —
which child to look at. The difference is who is speaking: the stage says what
it is holding, and the seat's own silence beside that reads as the evidence it
is. Two voices that agree on a running seat, and one voice that carries on
after the other stops.

## Why a heartbeat rather than a duration metric on the watcher alone

A watcher that timed stages by itself would need a clock of its own, and a
clock in the watcher is a wall-clock trigger wearing a different coat: it would
fire on the passage of time rather than on an append. The heartbeat keeps the
whole mechanism event-keyed. It also earns its place without the tripwire at
all — a stage that says what it waits on every few minutes is readable by a
human tailing the ledger, and the run's own record now shows what the run was
doing during a wait it used to spend in silence.

## Why a layer says it started rather than beating while it runs

A poll loop has something new to report every few minutes, because each poll is
an outcome. A gate layer has one thing to say and one moment to say it: this
layer, at this sha, from now. A beat behind a running child would repeat that
one fact at a cadence the harness chose, and the duration it would carry is
already derivable from the start and the result that closes it. The cheap
record is the one that reads correctly at any length of silence: a ledger whose
last line is `layer-started <layer> 06:33Z` says what the run is doing at 06:34
and at 07:33 alike.

## Why the ending is stamped at a settle point rather than on each path

The obvious repair for a missing stamp is to add the stamp where it is missing.
That repair was available on the day the start stamp landed, and it is the
repair that produced the defect: two of the five endings stamped, because two
call sites were the two somebody thought of. The other three were a spawn that
failed, a child a signal took, and a throw — each of them a path somebody wrote
without asking what the ledger owed.

A settle point inverts who has to remember. The body of an attempt cannot stamp,
because it has no writer. The only writer runs in a `finally`, so it runs for
every ending the language has. A path added tomorrow that returns early is
stamped `unstamped-exit` — a reason in the vocabulary, so the defect arrives as
a countable record rather than as another gap.

This is the same rule the loud-resolution sweep is built on and the same rule
the stream indexes are built on: a guarantee that a call site must remember is a
guarantee that goes missing at the next call site added.

## Why a replaced attempt is abandoned rather than given a result

A first red could have stamped a red `layer-result` and let the re-run overwrite
it. That would put a red under the cycle that the resume reads, and a restart
between the two attempts would then read the layer as red and skip the re-run
the flake filter owes it. The filter would quietly stop existing across a
restart.

The record and the verdict are therefore different things. `layer-result` is the
layer's verdict for the cycle, and exactly one attempt earns it. Everything else
an attempt produced is evidence, and evidence is what `layer-abandoned` carries.
The 38 minutes that vanished were evidence: an output tail from that attempt
would have said in one line what a human then spent an evening reconstructing.

## Why a signalled child is not a red

A child a signal took returns no exit code, and the runner used to read that as
a command that could not run. The operator saw "a Tier-1 gate command could not
run: undefined" for a layer that ran for half an hour and was killed by the
daemon's own stop. Neither half of that sentence was true.

A signal is somebody ending the process, and the run is usually going down with
it. The attempt is over and says so, the reason names the signal, and the exit
is never read as the command's answer about the tree. The layer runs again when
the run resumes, from attempt 1, and the abandonment is what makes the two
executions readable as two.

## Fallback paths

If the batch proves too coarse for a stage whose poll cadence is much slower
than the ship step's, the batch becomes a per-stage number rather than one
constant: the stage passes `every` when it opens its heartbeat. Trigger: a
stage whose first stamp lands long after an operator would want it. Reversal
cost: low — one argument at the call site, and no change to the stamp or to
the tripwire that reads it.

If the band proves too wide — a stall that stays inside four times the median
because one earlier visit was pathological — the top drops to a percentile of
the history rather than the maximum. Trigger: an overrun an operator found by
hand that the band did not open. Reversal cost: low — one function in
`src/tripwires/duration.mjs`, with the stamped `band` on every past record to
re-read the decision against.

If a start stamp per layer proves too coarse for a layer that runs for hours,
the layer runner opens a heartbeat over its child like a poll loop does, and
beats on the child's own output rather than on a clock. Trigger: an operator
who cannot tell a running layer from a hung one. Reversal cost: low — the
heartbeat helper already exists, and the start stamp stays what it is. The
stage beat covers the stage the layer runs in meanwhile, so the ledger is not
silent while this stays undone.

If the stage beat proves too loud for long stages — a run whose ledger is more
heartbeat than run — the interval becomes a per-lane or per-stage number rather
than one constant, read where the engine opens the beat. Trigger: heartbeat
stamps outnumbering the run's own events in a shipped ledger. Reversal cost:
low — one argument at one call site; the stamp, the stand-down rule and the
tripwire that reads it do not change.

If the abandonment stamps prove too loud — a spectrum whose ledger is more
abandonment than result, because every red layer of every cycle now writes two
records instead of one — the `superseded-by-rerun` stamp drops its output tail
and keeps the exit code alone. Trigger: a run ledger an operator cannot read for
the volume of replaced attempts. Reversal cost: low — one field in the
disposition, and the pairing does not change.

If `unclosed-at-recovery` turns out to fire on attempts that were not dead — a
second writer on one run ledger, or a recovery pass that ran while a layer was
still executing — the guard moves behind proof that the process is gone rather
than behind the instance being gone. Trigger: one recovery stamp followed by a
result for the same attempt. Reversal cost: medium — the guard needs the child's
pid on the start stamp, which is one more field written where the attempt
begins.

If the closed reason vocabulary proves too coarse — one word covering two
conditions an operator answers differently — it splits, the way the defect kinds
do. Trigger: two abandonments with one reason that need two different answers.
Reversal cost: low — one entry in the set, and the disposition that names it.

If the queued record proves too quiet for a stall that blocks a whole project,
the class moves from queued to loud, where it joins the liveness violation on
the alert strip. Trigger: an overrun that sat unread while the frontier
starved. Reversal cost: low — one entry moves between two sets in the event
registry, and the ownership rule that closes it moves with it.
