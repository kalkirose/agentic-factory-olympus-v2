# ADR-0057: A hold names one run, and the widest hold governs

Status: accepted (2026-08-30)

## The condition

The operator hold acts on a project or on the instance (ADR-0040). That is the
right shape for maintenance and the wrong shape for the queue.

When several runs are finished or nearly finished behind one that is about to
ship, the operator has two moves and neither is the one they want. Releasing
the project releases everything, so the runs race: whichever ships second
re-proves itself against a base the first one moved, and whichever ships third
re-proves itself against both. Each of those passes is a full verification the
factory pays for and learns nothing from. Leaving the project held stops the
run that is ready as well as the ones that are not.

So the harness could say "nothing moves" and "everything moves", and could not
say "this one moves". The waste is measured in verification passes, and it
recurs whenever more than two runs are in flight at once.

## Decision

**A hold names one run, one project or the instance, and the three are three
separate statements.** `olympusctl hold --run <id>` and
`olympusctl release --run <id>` join the two forms that were already there, on
the same control inbox, with the same done/rejected trace. A per-run hold
settles at the stage boundary exactly as a project hold does: the run finishes
the stage it is in, stamps `stage-held` with the stage it did not enter, and
idles there holding its slot. A per-run release enters that stage and stamps
`stage-released`. Nothing about the transition is new, which is the point: the
scope is what changed, and the engine reads all three at the one place stages
chain.

**A run's own hold lives in that run's ledger.** The stamp is
`run-hold-changed`, an ordinary append-only run event carrying the actor and,
in the envelope, the instant. It is the whole store of a per-run hold: the
start folds it back with the rest of the run's state, so the hold outlives the
instance that took it, and a ledger written before this event existed folds to
a run with no hold of its own, which is what those runs had. The state does not
sit in the instance ledger, because it is not a statement about the instance:
it belongs to one run, it dies with that run, and an archived run ledger should
be able to answer on its own why it stood still for an hour.

**The widest standing hold governs, and a release ends the one it names.** A
run is held while any of the three scopes covers it. So a project release lifts
the project's hold and nothing else: a run an operator stopped by name stays
stopped, because releasing a project is not a statement about the one run
somebody singled out. This is the rule the instance and project scopes already
followed, extended by one scope rather than rebuilt.

**A per-run release under a wider hold is refused, and the refusal names the
hold that is stopping the run.** Lifting the narrow statement under the wide
one would answer the operator with a run that still cannot move, and the
operator would read the release as a release. The refusal says which hold to
lift instead, so the next command is the right one. The refusal is on release
only: a hold is never refused, because a wide hold is a reason for a run to
stand still and no reason at all to refuse a narrower statement that it stands
still too.

**Status names who held a run and when.** A run held in its own right renders
`[held:<next-stage> by <actor> at <instant>]`, and a run whose per-run hold has
not reached its boundary yet renders `[holding by <actor> at <instant>]`. A run
the project stopped renders exactly what it rendered before, because the
project line already carries that hold. The header still counts held runs apart
from active ones. A per-run hold is the one an operator can forget, and a
forgotten hold starves a run in silence; naming the hand and the hour on the
run's own line is what makes a forgotten hold something a reader trips over.

## Why the scope and not an order

A priority or ordering field on the queue was rejected. Ordering decides who
goes first among runs that are all allowed to move, and the waste here comes
from motion rather than from order: two runs released together each pay a full
verification pass whichever of them the queue would have preferred. The lever
the operator needs is permission to move, and that is the lever the hold
already is.

Killing the waiting runs and relaunching them after the first one ships was
rejected. It discards work the factory has already paid for, and it pays for it
again at the relaunch.

Waiting for the clean-rebase fast path (ADR-0056) to make re-verdicts cheap was
rejected as the only answer. That path skips a re-verdict only for provably
disjoint merges; two runs that touch neighbouring ground still pay the full
pass that staggering would have avoided.

## Why the run's ledger and not a fourth flag

The instance ledger holds statements about the instance and its projects: the
arming state, the project holds, the standing acknowledgments. Those outlive
every run. A per-run hold does not: it is born with a run, it is answered by
that run's release, and it is meaningless the moment the run closes. Putting it
where the run's other resumable state already lives means the fold that
restores it is the fold that was already running, the archive keeps it with the
run it describes, and no index has to be kept in step with the set of open
runs.

## Fallback paths

If the three scopes prove too many to hold in the head, with an operator
releasing a project and finding runs still held, the fallback is the
project-wide forms alone, which this decision leaves untouched. `--run` is
additive at every layer: one branch in the console, one branch in the hold, one
field on the run. Trigger: refusals or repeated releases that show the operator
did not know which scope was standing. Reversal cost: low. Remove the console
option and the run branch; project and instance holds are unchanged code paths,
and a `run-hold-changed` stamp in an old ledger folds to a field nothing reads.

If a forgotten per-run hold starves a run despite the status line, the hold
gains an age: `status` marks a per-run hold older than a threshold as loud, the
way an unanswered park is. Trigger: a run held by name for longer than the
work behind it was worth. Reversal cost: low. The stamp already carries the
instant, so the threshold is a reading and not new state.

If the refusal proves to be the wrong answer for a per-run release under a
project hold, for an operator who means "let this one out of the project
hold", the alternative is an exemption rather than a release: a run marked
exempt moves while its project stays held. It is not the first design here,
because an exemption is a fourth state to reason about and the refusal is a
sentence. Trigger: repeated refusals followed by a project release and an
immediate re-hold. Reversal cost: medium. It adds a second per-run field, and a
precedence rule that no longer resolves in one direction only.
