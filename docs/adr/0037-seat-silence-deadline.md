# ADR-0037: The seat silence deadline

Status: accepted (2026-08-22)

## The condition

A seat child went silent at 13:55Z and stayed alive. It had emitted a normal
stream of progress up to that line, it held its slot, it held the run, and it
accumulated 55 seconds of CPU across the next four hours. The run's ledger
recorded nothing after the last progress stamp. At 17:54Z a human found the
process and killed it; the kill exited nonzero, the runner read that as a
crash, re-dispatched into the session the dead child had named, and the seat
finished its work in ninety seconds.

Everything in the recovery already existed. The only thing missing was
somebody to notice. The harness's four liveness layers all passed the run:
child supervision saw a living child, the liveness invariant saw an in-flight
child, the cost ceiling saw no spend, and the duration history had no append
to key on. A dead child is invisible to every one of them, because all four
ask what the run holds and none asks whether what it holds is doing anything.

The banned answer is a runtime limit. A seat that is killed for taking too
long is a seat the harness has decided the shape of, and the number becomes
the thing the work is tuned around. The evidence says the same thing: across
every archived run of this instance, healthy children have gone 86, 54, 47 and
44 minutes between stream frames, all of them holding one long command open,
and all of them right to.

## Decision

**A child that emits nothing for the deadline is killed.** `superviseSeat`
arms a timer at the spawn and re-arms it on every chunk of the child's stdout
or stderr. Past the deadline it kills the process tree, exactly as the cost
ceiling does. The close stamps `seat-failure` with reason `silence` and the
deadline that was in force.

**The deadline reads the raw streams, not the progress stamps.** Only a line
carrying a cost or a note becomes `seat-progress`; a tool call, a system line
and a warning on stderr become nothing. All of them are the child speaking, so
all of them count. This makes the detector strictly less trigger-happy than
the measurements it was set from, which were taken from the stamps.

**Two hours, from the ledgers.** Across 4593 measured gaps between one child's
frames, four passed 45 minutes and the longest was 86. Two hours sits well
above the longest thing a working seat has ever done here and well below the
four hours the one dead seat spent idle. `seatSilenceMs` in the instance config
moves it for a host whose seats work differently; there is no value that turns
it off, because an unattended factory with no ceiling on silence is the exact
condition this exists for.

**The reason is its own.** `silence` is not `exit`, `cost-ceiling` or
`terminated`. The eval seat reads the ledgers for how the harness behaves, and
"the harness killed a seat that had stopped" is a different fact from "the
seat's process died". A reader who wants the count can have it; a reader who
wants to know whether the deadline is set right has the `silenceMs` on both the
spawn stamp and the failure stamp to read it against.

**A silent child is a crash, and a crash buys a fresh one.** `silence` joins
`exit` in the runner's retryable set, so the kill takes the route the human's
kill took: up to `CRASH_RETRIES` children per seat session, resumed into the
session the dead child named when it named one. Nothing else about the seat
session changes. Past the allowance the failure stands and the lane's own
seat-failure route runs, which is where a seat that keeps dying belongs.

**Elapsed runtime stays unbounded.** No total is measured, no total is
compared, and a child that emits a frame every hour for a day is never
touched. The only quantity with a ceiling is the length of a silence.

## Why the deadline is not a heartbeat the seat has to send

The obvious alternative is to require the child to say something on a cadence,
and treat a missed beat as death. It would work, and it would make the
detector depend on the cooperation of the thing being detected. A child whose
event loop has stopped, whose connection has dropped, or whose process is
wedged is precisely the child that cannot send its beat — and adding a
requirement to a CLI the harness does not own puts the detector at the mercy
of the vendor's next release. Reading the stream the child already writes
needs nothing from the child at all.

## Why the kill is retried rather than escalated

The observed incident is the argument. The human's kill produced a re-dispatch
that resumed the session, and the seat closed its work in ninety seconds for a
few cents. Escalating instead would have parked the run for a human, which is
the expensive answer to a condition that repairs itself. A seat that goes
silent three times running is a different matter, and the retry allowance is
what tells the two apart without anybody deciding in advance which one this is.

## Why this is not the no-timeout doctrine breaking

The doctrine bans a clock that decides how long work may take. It does not ban
a clock that decides how long a corpse may hold a slot. The distinction is what
the number is measured against: a runtime limit is compared to the work, which
the harness cannot know the size of, and a silence deadline is compared to the
gap between two frames, which the harness has 4593 samples of. The first is a
guess about the future; the second is a reading of the past.

## Fallback paths

If the deadline proves too tight — a project whose seats hold single commands
open for longer than any run has yet — the number moves in the instance config,
and the `silenceMs` on every spawn stamp and every silence failure says what
was in force when it did not fit. Trigger: a `seat-failure` on reason `silence`
whose child was demonstrably working. Reversal cost: none — one integer in a
file the console edits live.

If the deadline proves too loose — an operator who still finds dead seats by
hand — the number drops toward the observed maximum rather than above it, and
the retry allowance absorbs the false kills it buys. Trigger: a dead seat found
by a human before the deadline reached it. Reversal cost: none, the same
integer.

If the retry proves wrong for a particular seat — one whose session cannot be
resumed usefully, so the re-dispatch pays for the whole session again — the
retryable set becomes a property of the seat map rather than one set for every
seat. Trigger: a silence retry that re-bought work the ledger shows was already
done. Reversal cost: low — one field on the seat definition and one read in the
runner; the deadline and its stamps do not change.
