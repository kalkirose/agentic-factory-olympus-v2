# ADR-0055: A retry on a blocked stage runs against the branch head

Status: accepted (2026-08-30)

## Decision

A `stage-blocked` park answered with anything but `abandon` refreshes the run's
tree to the default branch head before the blocked stage runs again. The guard
is `withTreeRefresh` in `src/lanes/shared.mjs`, applied at each lane root,
inside the abandon guard.

- **One park, one refresh.** The guard acts on the run's latest park when that
  park is `stage-blocked` and carries an answer, and it stamps `tree-refreshed`
  once per park. Every later entry of a stage reads the ledger and stops, so
  the tree moves once per answer and a daemon restart repeats nothing.
- **The reach is the tree the run has written nothing to.** The refresh runs
  only on a clean working tree whose HEAD the default branch already holds. A
  tree with uncommitted changes or with commits of its own keeps them; the
  stamp carries the cause, and the stage runs against the tree it had.
- **The refusals are stamped too.** `moved` says whether the tree moved, `from`
  and `to` carry the shas, and `cause` names why a tree stayed where it was.
  A run's inputs changed between two attempts, so provenance says by how much.
- **The refresh never fails a stage.** A fetch or a reset that throws is
  recorded with its cause and nothing else happens: the stage runs exactly as
  it did before this guard existed.
- **Abandon comes first.** The guard sits inside the abandon guard (ADR-0015),
  so a run being closed refreshes nothing.

## What this eliminates

An answer that cannot succeed. A `stage-blocked` park is the class of failure
the run cannot repair itself: an intent card that does not parse, a card the
project's lint refuses, a config that names no gate layer. Every one of those
repairs lands on the default branch, because that is where the file lives and
where a person can write. The run's tree is pinned at launch, so the retry that
asked for the repair re-ran against a tree the repair never reached, and the
same park came back, with the same question, for ever. The only way out was to
abandon the run and launch again.

`retry` and `abandon` are the two answers every recovery park offers
(ADR-0015). An option that cannot succeed is worse than an option that is not
offered: the operator repairs the substrate, answers, and is told the repair
did not happen.

## Why the tree and not the payload

The run's launch payload keeps the base sha it was launched with. The refresh
moves the tree and leaves that record alone, because the payload is rebuilt
from the launch stamp at every daemon restart, and a value the harness mutates
in memory and cannot persist is a value two readers disagree about. The ledger
event is the durable statement that the tree moved, and it survives the run.

The consequence is bounded by the same rule that bounds the reset: the refresh
happens only where the run has written nothing, so the stages that read the
base sha to describe the run's own work have not run yet.

## Why the refusal is not an error

A run holding work of its own is exactly the run whose tree must not be reset:
the work is the thing a verdict is owed. The guard could park, or fail the
stage, or ask. It does none of them, because the retry is answerable either way
(the operator can repair in the tree, as the operator does today), and a new
park would be a touchpoint bought with a case that costs nothing.

## Adversarial reading

The refresh changes the inputs of a run in flight, which is the thing runs are
otherwise built to avoid. Three things bound it: the class of park (one), the
state of the tree (clean and behind the branch), and the answer (a human's).
The stamp makes the move readable afterwards, so a verdict rendered on a
refreshed tree can always be traced to the commit it was rendered on.

The refresh takes commits the operator did not name: everything the default
branch gained since the launch, not the repair alone. That is deliberate. A run
launched from the branch head is a run that would have started there anyway,
and taking a subset would leave a tree that never existed anywhere.

## Fallback paths

If refreshing the whole branch head proves too wide, the refresh narrows to a
merge of the default branch into the run's tree, which keeps the run's own
commits and stops the eligibility rule being needed. Trigger: a run that needed
its own commits and a refresh that refused it. Reversal cost: low, `resetHard`
becomes `mergeIntoTree` in `refreshForRetry`, at the price of a conflict route
inside a guard that today cannot fail.

If the refresh is ever unwanted for a lane, the lane root drops
`withTreeRefresh` and that lane behaves exactly as it did before this record.
Trigger: a lane whose stage-blocked parks are repaired inside the tree.
Reversal cost: trivial, one call, at the price of the class this record
eliminates.
