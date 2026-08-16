# ADR-0034: Stage liveness telemetry

Status: accepted (2026-08-16)

## The condition

The no-timeout doctrine answers "is this alive?" with two things: telemetry
stamps, and the duration history to read them against. Only the first half
existed, and only for part of the run. A seat stamps its own progress, so a
stage that supervises one is never silent for long. The stages that run no seat
— the ones that poll a forge, or another run's ledger — stamped their entry and
then said nothing until they were done. A stage that sat for hours read exactly
like a stage that sat for a minute.

Nothing could watch that. The tripwire watcher keys on appends, and a poll loop
that changes nothing appends nothing, so a stalled stage produced no state
change for a watcher to notice. The liveness invariant did not cover it either:
the invariant asks whether a run holds a child, a park, or a running handler,
and a stage stuck in its own poll loop holds a running handler and passes. The
one condition the harness could not see was silence, which is the condition a
stall produces.

The banned answer is a clock. A stage killed at a threshold is a stage that
loses a merge to a slow forge, and the threshold becomes the thing the harness
is tuned around. The doctrine's answer is the one taken here: make the silence
speak, and read what it says against what the same stage did before.

## Decision

**A polling stage stamps a heartbeat, one per batch of poll outcomes.**
`stageHeartbeat(ctx)` opens at the top of a stage handler and beats once per
poll outcome that changed nothing. Every twentieth beat becomes a
`stage-heartbeat` stamp: the stage, what it waits on, the poll outcomes behind
the stamp, the time in the stage, and the evidence of the wait (the request and
the head sha, the merge commit). The three poll loops of the ship step beat —
the ship-token wait, the check watch, the merge-commit check watch — because
those are the loops that run no seat.

**The batch is the volume control, and it is a count of poll outcomes.** A
stage that settles inside its first batch stamps nothing at all, so the ledger
of a run that never stalls keeps the shape it always had. At the shipped poll
cadence a batch is about five minutes, so an hour of waiting costs twelve
stamps and a stall of any length costs a stamp every few minutes. The cadence
of the reading stays the project's; the cadence of the record is the harness's,
and one is not allowed to set the other.

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
stage itself.

## Why the record is not written into the run

The run ledger is the run's own account of itself, and everything in it is
something the run did. An overrun is somebody else's reading of the run, taken
from outside, and the reader is a watcher that must never be able to touch a
run. Writing from the watcher into a live run ledger would also put a second
writer on a file the engine owns, which is the one way an append-only ledger
loses its ordering. The instance ledger is where cross-run observations already
live, and the queued stream carries the record to the operator from there.

## Why a heartbeat rather than a duration metric on the watcher alone

A watcher that timed stages by itself would need a clock of its own, and a
clock in the watcher is a wall-clock trigger wearing a different coat: it would
fire on the passage of time rather than on an append. The heartbeat keeps the
whole mechanism event-keyed. It also earns its place without the tripwire at
all — a stage that says what it waits on every few minutes is readable by a
human tailing the ledger, and the run's own record now shows what the run was
doing during a wait it used to spend in silence.

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

If the queued record proves too quiet for a stall that blocks a whole project,
the class moves from queued to loud, where it joins the liveness violation on
the alert strip. Trigger: an overrun that sat unread while the frontier
starved. Reversal cost: low — one entry moves between two sets in the event
registry, and the ownership rule that closes it moves with it.
