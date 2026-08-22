# ADR-0036: Parked time is not active time

Status: accepted (2026-08-22)

## The condition

Every duration a reader could get out of a run was wall clock: the launch stamp
to the merge, or to the close. Across one review window of five ships the reads
were 5.7 to 17.3 hours, and one of those ships had spent 8.8 of its 17.3 hours
parked on a gate waiting for a human to answer. The number that reads as a slow
harness was mostly a person asleep.

The reads that number feeds are the ones that matter. The command center puts a
median against a four-hour target and draws a bar per ship. The eval seat reads
durations across its window and proposes drift. An operator looking at either
one was being shown the sum of the harness's work and the harness's waiting,
with no way to tell which half moved. A target set against that number cannot
be met by making the harness faster, and a target that answers to something the
harness does not control is not a target.

The same is true of a run sitting inert. A liveness violation means the
invariant found no in-flight child, no parked escalation and no transition in
progress: the run is stopped and waiting for a human to resolve it or kill it.
Those hours are the substrate's or the operator's, never the machine's pace.

## Decision

**A run has two durations and the close-out record carries both.** `run-closed`
stamps `wallMs`, from the launch stamp to the close, and `activeMs`, the same
stretch with every inactive span taken out. Two numbers rather than one, because
a run that waited nine hours on a human did not take nine hours of harness, and
because the gap between them is itself worth reading: it is the size of the
answer the operator owed.

**A span is inactive when the run is waiting on a human or sitting inert.** The
rule, in the ledger's own vocabulary: a span opens at `park` and closes at the
`answer` behind it, or at the `resume` if a ledger carries no answer stamp; a
span opens at `liveness-violation` and closes at the `resolved` that names its
seq. Nothing else opens one. A span still open where the reading stops runs to
that end, so an unanswered park at a kill counts to the close stamp and an
unresolved violation does too. Spans are unioned before they are subtracted: a
park inside an open violation is one stretch of waiting, not two.

**Daemon downtime is not in the rule.** A run whose daemon died and started
again is inactive for the gap, and the run ledger cannot see it — the daemon's
own stop and start live in the instance ledger. Reading across two ledgers to
recover it would make the number depend on a file the run does not own. When the
gap is long enough to matter the invariant stamps a violation on the next sweep,
and the violation is in the rule.

**The derivation is the ledger and nothing else.** `runDuration(events)` folds
one run's lines and holds no state between calls; the daemon remembers no
timers and no accumulated spans. A restart mid-run changes nothing, because
there was nothing in memory to lose, and an archived ledger answers the same
numbers years later. A reading may stop early — the command center's ship stat
stops at the merge, as it always did — and an explicit end clamps the spans with
it rather than counting past it.

**Every duration read that keys on run length keys on active time.** The command
center's per-ship `hours`, the median it draws against the target, and the
target itself are active hours; `wallHours` rides beside each ship and a median
wall sits under the hero, so the waiting is visible rather than hidden. The eval
seat is told to read `activeMs` and to cite the wall only when the gap between
the two is the finding. The band VALUES do not move here: four hours is still
four hours, and what changed is which number it is four hours of.

**Stage duration is untouched.** The stage band already excluded the human's
wait by construction — a stage visit restarts at the `resume` behind an answered
park (ADR-0034) — and it keys on a stage, not on a run.

## Why the close computes it rather than a reader

The close-out record is where a run says what it was, and a duration is the
plainest thing it has to say. A number only ever derived at read time is a
number every reader has to agree about, and the harness already has three
readers of run length. Stamping it once, at the moment the run ends, gives the
operator, the eval seat and any later tool the same answer without any of them
implementing the rule.

The stamp is not a second source of truth: it is the derivation's output,
written down. Anyone can re-run the derivation over the archived ledger and get
it back, and that is what makes the stamp safe to trust rather than a cache to
go stale.

## Why the close reads its own clock

The close computes the two durations from the ledger and from a clock read taken
one write ahead of the `run-closed` stamp it is about to make, because that
stamp does not exist to be read yet. A later reader anchors on the stamp's own
`ts`, so the two ends differ by the length of one append. On a run measured in
hours that is nothing, and on the number that matters it is exactly nothing: a
run closing on an open span has its parked span and its wall ending on the same
moment, so its active time is the same whichever end the reader anchors on.

## Why not count the whole wait as the harness's

It is tempting to keep one number and call the waiting the harness's problem,
on the argument that a harness which parks less is a better harness. Parking
less is a real goal and it has its own measures — the park count per ship, the
kinds it parks on. But folding it into the duration measures two things with one
number, and when that number moves nobody can say which one moved. The gap
between wall and active is the honest form of the same pressure: it says how
long the humans took, in their own column.

## Fallback paths

If a class of wait shows up that is neither a park nor a violation — a substrate
outage the run rides through without stamping either — its event joins the two
that open a span. Trigger: a review window where wall and active agree and an
operator can point at hours that were nobody's work. Reversal cost: low — one
set in `src/ledger/durations.mjs`, and every past ledger re-derives under the
new rule because nothing was ever cached.

If the daemon-downtime gap proves worth counting, the derivation takes the
instance ledger's `daemon-stopped` and `daemon-started` stamps as a second
source and clips them to the run's own window. Trigger: restarts long enough
that active time reads high and the invariant did not catch them. Reversal cost:
medium — the derivation gains a second input, and its callers gain a path to it.

If two numbers on the close prove one too many for a reader, `activeMs` stays
and `wallMs` goes, because the wall is re-derivable from the launch and close
stamps by anyone. Trigger: none foreseen; the wall costs one integer. Reversal
cost: low — one field.
