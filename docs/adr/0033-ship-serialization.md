# ADR-0033: Ship serialization and the pre-verdict update

Status: accepted (2026-08-16)

## The condition

Runs of one project parallelize cleanly through spec, suite, adversary,
implementation and verdict. The merge is the one stage that does not. A
protected default branch that requires its requests current makes every
concurrent pair pay for the other's merge: the first merge lands, the second
request goes behind its base or into conflict with it, and the second run buys
a branch update, a full CI round, and — when the two sides touched the same
lines — a dev pass. The cost is structural, not a symptom of a busy repository,
and it grows with the number of runs in flight.

Two things were wrong at once. A candidate was judged against the base it was
born on and met the current base only at the forge, so the verdict certified a
tree that was not the tree that would land. And nothing ordered the merges, so
which run paid for which merge was an accident of timing.

## Decision

**One `update` stage, between the verdict and the ship.** `shipStep` supplies
three stages now: `update`, `ship`, `close-out`. A green verdict hands the run
to `update`, which takes the project's ship token, merges the default branch
into the run tree under it, and hands the run on: to `verdict` when the merge
moved the tree, to `ship` when it did not. The verdict loop treats a
`pre-verdict-update` that ran as it treats an implementation commit — the tree
changed, so the render behind it is stale and a new cycle runs. The tree that
opens a request is therefore a tree a verdict certified, and no run of the
project can merge between the two.

**The ship token is derived from the run ledgers.** One token per project. A
run holds it from its `ship-token` (acquired) or `pr-opened` stamp until its
`merged` stamp or its close; every other open run of the project that stamped
`ship-token` (waiting) is in the queue. `shipTokenState` folds that from the
live run ledgers on every read. There is no token file, no lock, and no
in-memory registry: a restart re-derives the same holder and the same queue
from the same ledgers, and a token nobody wrote down can be neither lost nor
duplicated. Closed runs are excluded and the archive is never read — a run that
is over can neither merge nor wait.

**The gate is one synchronous step.** `takeShipToken` reads the token and
appends its stamp without an await between the two, so two runs of one daemon
never read the same free token: the second reads the first's acquire. A run
that already holds the token takes nothing and stamps nothing, so both the
update stage and the ship stage may ask, as often as they like.

**Queue order is deterministic.** The waiters are ordered by the stamp they
queued with, and a tie falls to the lower run id. A free token goes to the
front of the queue and to nobody else, so a run that arrives late never jumps a
run that has been waiting. The order is a reading of the ledgers, so a restart
derives the order it derived before.

**Bounded updates, then the ship-stage route.** `UPDATE_CAP` (2) bounds the
updates one implementation pass takes before its final verdict. Past the bound
the stage stamps `pre-verdict-update` with `capped` and hands the run to
`ship`, where the branch update behaves exactly as it did before this stage
existed. Under the token the base moves only when a human merges, so the second
update in one pass is already the sign of a tree chasing a branch it will not
catch.

**Conflicts take the route they always took, one stage earlier.** The
pre-verdict update calls the same `branchUpdate`, the same merge round, the
same stall and fresh-pass ladder as the ship stage. It differs in two flags: it
pushes nothing (no request exists yet, and a branch pushed here would meet a
later fresh pass's rewrite with a plain push), and it leaves the `branch-update`
stamp to the ship stage, because its own stamp carries the shas. A conflict
therefore surfaces before the request, where the repair costs no CI round and
the verdict that follows covers the merged result.

**Two new run events.** `ship-token` (`state`: `waiting` with the holder and
the number of runs ahead, or `acquired`) and `pre-verdict-update` (`pass`,
`ran`, `mainSha`, the shas when it ran, `capped` when the bound refused it).
One wait stamp per wait, not one per poll. The update stamps whether it ran or
found the base where the run left it: a run that merges the default branch into
its own tree on its own authority says so either way.

**The slot cap is unchanged.** It stays the concurrency knob for everything
before the ship. The token serializes the last stretch of each run rather than
the runs, and it holds a slot while it waits, because the run is alive and its
worktree and stack are up.

## Why the token is derived and never stored

A stored token is a second source of truth about a state the ledgers already
hold, and it fails in the two ways a harness cannot afford: a crash between the
write and the merge leaks it, and a restart that rebuilds it from memory
duplicates it. Ledger derivation has neither failure. The stamps are records of
what the machine did, not the storage of a right, so the token survives a
restart for the same reason every stage does — the run ledger is the memory.

## Why the verdict re-renders after an update that moved the tree

The point of moving the update ahead of the final verdict is that the verdict
certifies the tree that lands. A render behind a merge certifies a tree that no
longer exists. The re-render costs one Tier-1 cycle: the judgment seats fire
once per implementation pass and the merge starts no new pass, so the second
cycle is the deterministic spectrum and nothing else. A red it turns up enters
the ladder like any other red, which is the correct answer — the default branch
broke this candidate, and the run repairs it before the request rather than
after a CI round.

## Why the holder keeps the token through a repair

The hold runs from the update that precedes the final verdict to the merge, and
that window includes a CI red and the repair round it earns. Releasing there
would buy nothing: the request is open, so a competing merge under it still
costs the update it was going to cost, and the released run would re-queue
behind the runs it was ahead of. The bound on the window is the run itself, and
a run that cannot converge parks for the human on its own ladder.

## Why the wait is not a timeout

A waiting run polls the ledgers for a state change — the merge that ends the
holder's turn — exactly as the check watcher polls the forge. `pollMs` is the
cadence of the reading. No span of wall-clock time decides anything here, and
the wait stamp says what the run is waiting on and who holds it, so a queue
that stops moving is visible in the ledger rather than inferred from silence.

## Fallback paths

If the single token starves one lane behind the other — a repair waiting on a
story merge — the token splits per lane: the derivation keys on the launching
lane beside the project, and the queue becomes one per lane. Trigger: a repair
waiting on a story merge in the duration history. Reversal cost: low — one key
in the derivation, and no change to the gate or the stamps.

If the pre-verdict update churns on a busy default branch, the cap is what
stops it: past `UPDATE_CAP` the run falls through to the ship-stage update it
took before, and the `capped` stamp says so. Trigger: two updates in one pass
in the ledgers. Reversal cost: low — one constant, and the route under it does
not change. Setting the cap to zero disables the pre-verdict update entirely
and leaves the token doing its own job.

If the token proves too coarse — a project whose merges are cheap enough that
serializing them costs more than the concurrent pairs did — the gate moves
behind an instance-config flag per project, defaulting on, and a project that
turns it off keeps the pre-verdict update and queues for nothing. Trigger: ship
waits in the duration history that outweigh the update rounds they saved.
Reversal cost: low — one config read at the gate; the stages, the derivation
and the stamps do not change.
