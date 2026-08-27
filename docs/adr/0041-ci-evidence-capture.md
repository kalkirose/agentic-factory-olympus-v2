# ADR-0041: CI evidence is captured when it is first seen

Status: accepted (2026-08-27)

## The condition

The verdict on a CI red was built from what the forge still held at the moment
a seat needed it. Between the check going red and the triage reading it there
was a gap, and the forge is not a store the harness owns: anybody with write
access to the repository can cancel a workflow run and start it again, and the
attempts the harness was going to read are replaced by the attempts of the new
run.

That happened. A ship went red, somebody outside the harness cancelled and
re-ran the workflow, and the triage that followed read cancellations, because
cancellations were all there was left to read. The run's own account of why it
failed was a paragraph about a state nobody had caused on purpose.

Two related defects were measured beside it.

A concurrency-group cancel read as a red. A cancel is terminal and it is not
green, so the watcher classified it with the failures: the re-run that followed
came back green, and the pair — a red, then a green, over a tree that never
moved — is the exact shape of a flake. One head sha carried 36 cancels and 34
successes, and the harness classified its way through all of them. The flake
ledger for that request is a record of somebody pushing.

The authoritative check run of a name was whichever the forge listed first.
`requiredRuns` resolved each required name with `runs.find(name)`, and a head
sha can carry several check runs on one name: one request's check name carried
success 59 times, failure 35 and skipped 31. Whether that request read green or
red depended on the order an API answer came back in.

## Decision

**The snapshot is taken at the observation, never at the read.** When the check
watcher first sees a required check in a state that is not green, it writes
that attempt's own metadata to `runs/<id>/ci/<check>/<checkRunId>-<attempt>/`
before any classification runs, and stamps `ci-evidence`. The directory is
inside the run, so the evidence archives with the run that judged on it. The
capture costs no forge call: the watcher is holding the check run already.

**The log follows at the first moment it is whole.** A log read out of a
workflow run still executing is a partial log that reads exactly like a
complete one, and refusing that read is the rule the ship path already stands
on (ADR-0008). So the metadata — which is what identifies an attempt after the
forge stops listing it — lands immediately, and the log lands at the first poll
where the run behind the check reports itself over. That is the same poll where
the watcher acts on the red, so the capture sits between the observation and
the classification, and the automatic re-run that replaces the attempt on the
forge happens after the harness has its copy. The `ci-evidence` stamp says
which of the two the run holds: `pending`, `captured` with the byte count, or
`absent` with the forge's own reason.

**An attempt is identified by its check-run id, never by the check's name.** A
name is the question; an id is one answer to it. The evidence directory, the
`ci-evidence` stamps, the `check-transition` stamps and the re-run request all
carry the id and the attempt number. A forge that serves no check-run id leaves
every attempt on a name tied, and the read falls back to what it always was:
one identity per name.

**The authoritative run of a name is the latest attempt, decided from the
attempts' own facts.** `checksByName` groups the forge's answer by name and
orders each group with `attemptOrder`: start time, with the check-run id as the
tie-break, because an id is minted when the attempt is created and the larger
one is later. The last of that order is the answer, because it is the one the
forge itself will merge on. Nothing reads the list order — the rule lives in
the forge adapter and the watcher imports it, so the fallback log fetch by name
picks the same attempt the watcher did. One check run per name reaches every classifier
below, so a stale attempt cannot write a name's state backwards, and a fresh
attempt that lands on the state its predecessor held still stamps — the same
red twice is two reds, and the ledger is where a reader counts them.

**A cancel is its own observed state: not red, not green.** Nobody ran the
check to an answer; somebody stopped it. It mints no `ci-flake`, so a
cancel-then-green cycle adds nothing to the deterministic-red count, and it
earns no automatic re-run — the re-run tests the claim that a red was the
substrate, and a cancel makes no claim. The watcher waits `CANCELLED_POLLS`
observations for the attempt that will answer: a re-run somebody asked for, a
concurrency group letting the job through. Past that bound nobody is going to
send one, and the cancel takes the escalation a red takes, with its evidence
already on disk. Waiting is counted in poll outcomes, never in wall-clock time,
like every other bound on this path.

**The flake key is unchanged.** `ciFlakes` and `deterministicRed` still count
the pair of one head sha and one check name (ADR-0008): two attempts at one
check on one tree are the same question asked twice, which is what the rule is
about. What changed is which observations reach the count — the cancels are out
of it, and one attempt is read per name — so the rule now counts the answers it
was always meant to count.

**Triage reads the snapshot first and the forge second.** The CI triage and the
red-merge repair ticket take the captured log when the run has one, and fall
back to a live fetch when it does not. A destroyed attempt still has its log on
disk, and the seat cites the failure rather than the cancellation that replaced
it. The live fetch stays, because a run that never captured anything must still
be able to ask.

**The capture is bounded by identity, not by polling.** One attempt is written
once and fetched once. A check that flaps for thirty polls on one head sha
writes two ledger lines, because the second observation of the same check run
is the same piece of news.

## Why the run directory and not a store of its own

The evidence answers one question — why did this run's ship go red — and it is
read by that run's triage and by the ticket that run writes. A store outside
the run would need a lifetime rule, a sweep, and an owner; inside the run it
inherits all three from the run. The archive move takes it, and a reader who
has the ledger has the paths, because every stamp names its directory.

## Why the metadata is worth writing even when the log is not

An attempt that has vanished from the forge cannot be named afterwards: the
check-run id, the workflow run behind it, the conclusion and the two timestamps
are the whole account of what the harness saw. A triage told "the attempt this
verdict is about was check run 41 on run 900, failure, and the forge no longer
lists it" judges better than one told nothing. The metadata costs a file write
and no network call, so there is no reason to make it conditional.

## Fallback paths

If `CANCELLED_POLLS` proves too tight — a repository whose cancels are routinely
replaced later than the bound, so cancels escalate that would have answered
themselves — the constant rises, or it becomes instance config beside
`ghCommand`, which is where the ownership test puts a fact about the host.
Trigger: CI verdicts whose red checks are cancels, on shas where a later
attempt then went green. Reversal cost: low — one constant, and the route under
it does not change.

If the captured evidence proves to cost real disk — a project whose logs are
large and whose ships are red often — the tail the capture writes shrinks to
the bound the triage already reads, or the capture keeps only the newest
attempts per check. Trigger: run directories whose `ci/` tree is a large part
of the archive. Reversal cost: low — one write site, and the readers take
whatever is on disk.

If the start-time-then-id order ever picks the wrong attempt — a forge that
mints ids out of order and reports no start time — the order takes a third
component from the forge, or the adapter asks for the workflow run's own
attempt number and carries it. Trigger: a `ci-evidence` stamp whose attempt
number falls between two polls. Reversal cost: low — one comparator, in the
adapter and in the watcher, and both are already the only readers of it.

If reading the snapshot first proves to hide a forge that would now serve a
better log — an attempt re-run into a longer, more useful failure — the triage
reads both and hands the seat the pair. Trigger: triage findings that name the
capture and are contradicted by the request's current state. Reversal cost:
low; the fetch is still there and the snapshot is a file the reader already
found.

If a cancel that never gets a replacement proves to be the common case rather
than the exception — a repository whose concurrency group cancels far more than
it releases — the escalation stops being a CI verdict and becomes an
`operational-fix` route that re-runs the cancelled attempt once, which is the
old posture with the flake bookkeeping left out of it. Trigger: CI verdicts
whose only red is a cancel, repeated across runs of one project. Reversal cost:
medium — one route, and the budget rule that a cancel spends the re-run would
have to be revisited with it.
