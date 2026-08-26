# ADR-0039: A duration band counts work, not wall clock

Status: accepted (2026-08-26)

## The condition

The stage-duration band answers one question: did this stage do something no
completed visit of the same stage of the same lane ever did? It answered it by
comparing wall clock against wall clock, and a stage that is waiting is not a
stage that is doing anything.

The update stage is where that broke in the open. A run reached `update`, asked
for the project's ship token, and another run of the project was holding it, so
it polled. Five minutes in, the watcher read the heartbeat against a band whose
median was 1.8 seconds and whose top was 119 seconds, and opened a record. The
record was not wrong about the number; it was wrong about the subject, because
the stage had done nothing at all for those five minutes. Then the visit ended
and became a sample. Eight hours later a second run stood 115 minutes in the
same stage, and the band's top had grown to 112 minutes — the queue wait had
taught the band that this is what an update takes. The band had learned the
pathology it exists to flag, and the second run's stall sat comfortably inside
it. Both records closed the same way: the token holder left the verdict stage,
and the wait ended.

The park had a smaller version of the same hole. A visit already restarts at
the `resume` behind an answered park, so an answered wait was out. A park nobody
answered before the run closed was not: the visit ran to the close stamp, and
every hour a human took became a sample of what the stage takes.

Nothing counted the queue wait anywhere else, either. The cost of serial merges
(ADR-0033) is real and it is worth reading, and the only place it showed up was
inside a band that then mistook it for work.

A third reading was missing outright. Across one review window the runs spent
2, 7, 3, 10 and 7 verdict cycles, and roughly nine of those 29 re-judged defects
of the harness rather than of the product. A run being judged for the tenth time
is the clearest signal the harness produces that a gate cannot close what it
keeps opening, and no tripwire read it.

## Decision

**A wait has a class, and there is one derivation of waits.** `WAIT_CLASSES` in
`src/ledger/durations.mjs` names them. `human` is the run waiting on a person or
on a dead substrate: a park to its answer, and a liveness violation to its
`resolved`. `queue` is the run waiting on another run of its own project: the
`ship-token` waiting stamp to the acquire behind it. A caller states which
classes its reading counts as waiting, and the same fold answers every reading —
the classes are the extension point, and a new kind of wait is one entry.

**A duration band counts work.** A stage visit's sample is the wall of the visit
less every span of the band's classes inside it, and the band's classes are
`human`, `queue` and `hold` (ADR-0040). The live reading is converted the same
way and from the same ledger: the heartbeat says the stretch it has stood for,
its own window is that stretch back from its stamp, and the run's ledger says
how much of the window was waiting. So a run five minutes into a queue wait is
compared as a run that has done nothing, which is what it is.

**The record carries both halves.** `stage-overrun` keeps `elapsed` meaning what
it always meant — the stretch the stage has stood — and gains `work` and, when
they differ, `waited`. A stage that worked for two hours and a stage that queued
for two hours are different reports, and an operator should not have to open the
run ledger to tell them apart.

**A run's two durations do not move.** `activeMs` on the close stamp still means
the wall less the human's wait (ADR-0036), and the gap between the two numbers
still means what the humans owed. A queue wait is the harness waiting on itself,
which is the harness's own pace, and it belongs inside the harness's own number.
The two readings differ because the questions differ: a run duration asks how
long this took, and a band asks what this stage usually does.

**The queue wait is a metric of its own.** `ship-token-wait` is the longest
queue wait of the last N runs of the project that queued, in minutes. A run
still waiting is measured up to the read, because a queue nobody has cleared is
exactly the condition the metric exists for, and a metric that waits for the
wait to end goes quiet when it matters. Its standing entry breaches above 30
minutes.

**Verdict cycles are a metric of their own.** `verdict-cycles` is the highest
cycle count of any one run over the last N runs of the project that rendered a
verdict. Its standing entry breaches above five: every run in the observed
window that was judged more than five times was re-judging something a gate
could not close, and the answer names that rather than the run.

**Detection only, unchanged.** Nothing here reads a clock to decide anything.
The band is still the history, the trigger is still an append, the cold-start
silence under five completed visits still holds, and the watcher still holds no
run and writes into no run ledger.

## Why the band takes the queue out and the run duration leaves it in

It is tempting to have one definition of "active" and use it everywhere. The two
readings would then agree, and nobody would have to remember which is which.

They would agree on a number that answers neither question. A run duration is
read to ask how fast the harness ships; the harness chose to serialize its
merges, so the queue that choice creates is part of what shipping costs, and
hiding it in a second column would flatter the number. A band is read to ask
whether this stage is behaving like itself; the queue is not something the stage
does, and any minute of it in the samples is a minute the band will forgive
later. Same word, two jobs. The classes exist so that each reading can say which
job it is doing.

## Why the worst run rather than the mean

A window of five runs with cycle counts 2, 3, 2, 3, 10 has a mean of four, which
breaches nothing and describes no run that happened. The ten is the reading. The
metric reports it and names the run, because the answer an operator needs is
which run to open, and an average has no run to point at.

## Fallback paths

If a stage's poll wait on the forge turns out to be waiting rather than work —
a ship stage that sat four hours because CI was slow is not a ship stage doing
something unusual — `checks` joins `WAIT_CLASSES` with the poll stamps that
bound it, and its name joins `BAND_CLASSES`. Trigger: repeated update or ship
overrun records an operator reads and closes as "the forge was slow". Reversal
cost: low — one entry and one name, and every past ledger re-derives under the
new rule because nothing was ever cached.

If taking the waits out makes a band too tight — a stage whose work is genuinely
bursty now sits above a band built from its quiet visits — `BAND_CLASSES`
narrows to `human` alone and the queue returns to the samples. The queue reading
does not go dark when it does, because `ship-token-wait` carries it
independently. Trigger: overrun records on stages an operator inspects and finds
healthy. Reversal cost: low — one array in `src/tripwires/duration.mjs`.

If the verdict-cycle threshold of five proves wrong for a project, it is a
registry entry like any other and moves by PR. If it proves wrong for every
project, the metric takes the self-baselined route the kill rate takes: a
proposal stamped at the fifth judged run, carrying the observed counts, and the
band committed by a human. Trigger: a project whose honest cycle count sits
above five for reasons nobody wants changed. Reversal cost: low for the value,
medium for the route — the proposal path already exists and gains one metric.

If a run's own `activeMs` proves to need the queue out as well, `RUN_CLASSES`
gains `queue`. The cost is that `wallMs - activeMs` stops meaning "what the
humans owed", so the close would carry a third number rather than redefine the
second one. Trigger: a review window where the queue dominates a run's length
and the eval seat cannot say so from `activeMs` and the queue metric together.
Reversal cost: medium — one array, one new field on the close stamp, and the
readers that want it.
