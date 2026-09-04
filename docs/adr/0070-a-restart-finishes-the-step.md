# ADR-0070: A restart finishes the step it interrupted, and a hold governs the start

Status: accepted (2026-09-04)

## Decision

A daemon stop lands wherever the work is, and the work of the verdict stage is
mostly a seat that has been thinking for a quarter of an hour. Two rules, one
for each end of a restart.

### The verdict stage's entry reads the ledger before it runs a layer

The stage handler asks one question before its loop: which step of the ladder
never finished? It is read from the run ledger and from nothing else
(`interruptedStep`, `src/lanes/verdict.mjs`), and two shapes answer it.

- **A `fresh-pass` stamp that nothing implemented.** When the newest of
  `fresh-pass`, `repair-round` and `verdict-rendered` is a `fresh-pass`, and no
  `implementation-committed` follows it, the pass was born and never written:
  the tree under it is the one the pass was born on, the freeze with the frozen
  suite carried onto it. The stage enters `freshPass` again. The stamp is
  already on the ledger, so the reset and the suite carry inside it are skipped,
  because they ran before the stamp.
- **A repair round with no commit behind it.** When the newest `seat-spawned`
  for `repair-dev` after the last render has no `implementation-committed`
  behind it, the round never reached its own stamp, and the stage runs it again
  with the same open set. It stamps `repair-round` once, because that stamp
  comes after the seat.

Neither rule asks how the step ended, and that is the whole of the second one.
The endings do not all leave a record: a stop with the child alive stamps
`seat-terminated` with reason `daemon-stopped`; a stop while the seat stood in
a wait leaves a `waiting-ended` and no termination at all, because the child
had already died of the provider and the seat was on its ladder (ADR-0069); a
stop while that wait stood at the hold barrier leaves a wait that reads
`elapsed`, which is the documented restart recipe of hold, wait for boundaries,
stop; and a crash leaves nothing at all. A rule keyed on any of those records
answers some of the endings and sends the rest into a cycle over a tree nobody
implemented, which is the failure this decision exists to remove. A round that
ended in a `seat-failure` park is included by the same rule and costs nothing:
the answer to that park re-dispatches exactly the round the ladder would.

A `dev` seat of this stage belongs to a fresh pass, which stamps before it
spawns, so the first rule answers it and there is no second rule for it.
`waiting` pairs between a `fresh-pass` and the dev report are stepped over by
both scans, because a wait is none of the stamps that bound a step.

**The tree goes back to its last commit before the step is dispatched again.**
A seat that died mid-edit leaves what it had written. The candidate capture
restores the test paths and nothing else, so those writes stand, and the
`git add -A` behind the next seat would commit half of a dead session and half
of a live one as one implementation. So the resume resets the worktree hard to
its head and cleans it before either step: the commit under the run at that
point is the tree the step was dispatched over, the pass's own birth commit for
a fresh pass and the render's tree for a repair round. The run cache is
excluded from git and survives the clean (ADR-0048).

Every other resume runs the layers as it always did. A stop inside the
spectrum, inside triage, inside a review seat: those are judgments of a tree
that exists, the cycle re-runs, and the layers with judged results are skipped
(ADR-0034). The implementation stage already behaved this way for its own
seat, and the resume rules above give the verdict stage the same reading.

The re-dispatch is a fresh seat session. A restart resumes into no transcript,
and the seat's own ladder position is read from the ledger per seat, so a
provider outage across a restart does not begin again at the first rung
(ADR-0069).

### A run the start finds held holds where it stands

A hold stops a run from entering what comes next. Until now the daemon start
was the one entry it did not cover: `resumeOpenRuns` re-entered the recorded
stage of every run that was not parked, violated, or already standing at a
boundary — including runs of a project the operator was holding.

A run the start finds under any hold now takes the branch an answered park
takes: `holdAt` with its current stage, `resumed: true`. It stamps
`stage-held` with the stage it did not run, and the release re-executes that
stage rather than entering the next one. A run that already recorded
`stage-held` before the stop keeps that record and its deferred stage, exactly
as before.

The readers do not change. `restoreAnchor` and `currentPass` derive from the
same stamps; `layer-abandoned` with reason `unclosed-at-recovery` still closes
a layer attempt the dead instance left open; `holdAt` and `deferredResume`
already carried the flag for the answered-park case.

## Why the stamps alone are not enough

The verdict loop derives its position from three facts: the last render, the
triggers after it, and the ladder's own records. That is complete for a stop
between two steps and wrong for a stop inside one, because the trigger of the
step in flight is a stamp another arm of the same ladder run already wrote.

The ledger shows it. A run took a stall, reset its tree for the fresh pass,
stamped the pass, and dispatched the dev seat; an earlier arm of the same
ladder run had already stamped an `operational-fix` against that render. The
daemon was restarted while the seat was thinking. The next instance read a
trigger after the last render, called for a cycle, and ran an acceptance layer
against the freeze sha with no implementation on it — twice, because the cycle
it rendered fed the same reading again. Every layer of it was red, every red
was an artefact of a tree nobody had implemented, and the seat that was
interrupted had produced nothing anybody could see.

The hold is the same failure at the other end. A hold stops a stage at its
boundary; the start crosses a boundary of its own that the hold was not
written for, so an instance started under a standing hold re-entered its runs'
stages and spent seats and layers nobody had released. An operator who holds
an instance and then restarts it is asking for exactly one thing — nothing
runs until I say so — and the restart was the one moment that did not honour
it.

Both rules are ledger reads, so they hold across as many restarts as a person
needs: the second start after a stop mid-seat finds the same shape as the
first, and dispatches the same step.

## Fallback paths

If the re-dispatch proves wrong for a seat that had nearly finished — a
provider that keeps a transcript the harness could resume into after a
restart, so the second dispatch buys work the first had done — the rule keeps
its shape and gains the session: the re-dispatch resumes the session named on
the interrupted `seat-spawned` instead of opening a new one. Trigger: a
measured cost of re-dispatched steps above the cost of the interrupted ones
across five restarts. Reversal cost: low — the session id is already on the
spawn stamp.

If holding a resumed run at its stage proves too coarse — an operator wants a
run that was mid-stage to finish that stage and stop at its boundary, the way
a hold taken while the daemon was up behaves — the start gains a second scope:
hold the entry, or run the stage and hold the boundary behind it. Trigger: an
operator asks for a restart that finishes what was in flight. Reversal cost:
moderate — the hold command grows a scope and the resume reads it.
