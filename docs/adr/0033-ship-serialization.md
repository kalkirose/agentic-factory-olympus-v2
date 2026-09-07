# ADR-0033: Ship serialization and the pre-verdict update

Status: accepted (2026-08-16, the two certifications 2026-09-07)

## The condition

Runs of one project parallelize cleanly through spec, suite, adversary,
implementation and verdict. The merge is the one stage that does not. A
protected default branch that requires its requests current makes every
concurrent pair pay for the other's merge: the first merge lands, the second
request goes behind its base or into conflict with it, and the second run buys a
branch update, a full CI round, and a dev pass when the two sides touched the
same lines. The cost is structural, not a symptom of a busy repository, and it
grows with the number of runs in flight.

Two things were wrong at once. A candidate was judged against the base it was
born on and met the current base only at the forge, so the verdict certified a
tree that was not the tree that would land. And nothing ordered the merges, so
which run paid for which merge was an accident of timing.

## Decision

**One `update` stage, behind the reconciliation and in front of the ship.**
`shipStep` supplies four stages: `reconcile`, `update`, `ship`, `close-out`. A
green verdict hands the run to `reconcile`, which judges the decision records
(ADR-0075), and the stage hands it to `update`. The update takes the project's
ship token, merges the default branch into the run tree under it, and hands the
run on: to `verdict` when the incoming work re-opens the code question, to
`reconcile` when it re-opens the record question, and to `ship` when it opens
neither. The verdict loop treats a `pre-verdict-update` that ran as it treats an
implementation commit: the tree changed, so the render behind it is stale and a
new cycle runs. The tree that opens a request is therefore a tree a verdict
certified, and no run of the project merges between the two.

**The admission gate reads two certifications, each at its own sha.**
`certifiedTrees` returns the code tree at the run's last code commit and the
record tree at its last record commit, and `admitted` requires every one the lane
holds to be green. A green `verdict-rendered` at the head sha is not the
question, because the reconcile stage commits records after the verdict's final
green and no code render ever stands at that head again. A lane that owes no
reconciliation certifies no records, and a records-lane run renders no code
verdict; `null` says the lane holds no such certification and never that one
failed.

**The ship token is derived from the run ledgers.** One token per project. A run
holds it from its `ship-token` (acquired) or `pr-opened` stamp until it releases
it, merges, or closes; every other open run of the project that stamped
`ship-token` (waiting) is in the queue. `shipTokenState` folds that from the
live run ledgers on every read. There is no token file, no lock, and no
in-memory registry: a restart re-derives the same holder and the same queue from
the same ledgers, and a token nobody wrote down can be neither lost nor
duplicated. Closed runs are excluded and the archive is never read, because a
run that is over can neither merge nor wait.

**The token covers the merge and the request, and no more.** The window runs
from the update stage's merge of the default branch to the merge of the request.
Every exit from the update stage that is not the ship stage gives the token back
first: a fast path that refused, a project that runs no fast path, a tree no
certification covers, a merge conflict that buys a fresh pass, and a park. The
reconcile stage runs in front of the token altogether, so a whole reconciliation
holds no other run of the project out of its merge. None of that work reads the
default branch, and a run that held the token through it charged every other run
the whole of it. The merge round that resolves a conflict is the one piece of
work before the request that keeps the token, for the reason stated under the
conflict route below. The release stamps `ship-token` (released) with a reason
out of a closed set, because a machine cycle and a wait on a person are different
costs and a count that mixes them is a count of nothing.
`SHIP_TOKEN_RELEASE_REASONS` in `src/ship/token.mjs` holds `re-verdict` and
`park`. The record re-run's own reason, `re-reconcile`, is not yet implemented:
the update stage names it at the release and the closed set refuses it, so that
release throws.

**A released run queues again at the back.** The release clears the run's
`queuedAt` as well as its hold, so its next wait stamp is a new position. The run
already had its turn. A released run that kept its first stamp would re-enter
ahead of every run that queued during its hold, and it would then hold the token
again for a whole ship, so a run that fell back twice could hold twice before any
waiter held once. Under the back of the queue no waiter is overtaken: a free
token goes to the front of the queue and to nobody else, so a waiter holds after
at most as many turns as there were runs ahead of it, and that count is bounded
by the open runs the slot cap allows.

**The gate is one synchronous step.** `takeShipToken` reads the token and
appends its stamp without an await between the two, so two runs of one daemon
never read the same free token: the second reads the first's acquire. A run that
already holds the token takes nothing and stamps nothing, so both the update
stage and the ship stage may ask, as often as they like. `releaseShipToken` is
the mirror: a run that holds nothing stamps nothing, so a caller may release as
often as it likes.

**Queue order is deterministic.** The waiters are ordered by the stamp they
queued with, and a tie falls to the lower run id. A free token goes to the front
of the queue and to nobody else, so a run that arrives late never jumps a run
that has been waiting. The order is a reading of the ledgers, so a restart
derives the order it derived before.

**Bounded updates, then the ship-stage route.** `UPDATE_CAP` (2) bounds the
updates one implementation pass takes before its final verdict. Past the bound
the stage stamps `pre-verdict-update` with `capped` and hands the run to `ship`,
where the branch update behaves exactly as it did before this stage existed. The
capped run keeps the token, because it is on its way to the request. A record
re-run spends that cap as a code re-judgment does: the run has merged twice under
one pass either way.

**One merge, two questions, one stamp.** `groundVerdict` lists the incoming files
once and answers each certification on its own ground (ADR-0056). The stamp lands
after both answers are known, because the answers are what it carries: `code` is
`kept` or `rejudge`, `records` is `kept` or `rerun`, and each carries the files
that decided it. The code answer routes first where both were redone, because the
reconcile stage stands behind the verdict in every lane graph and reads its own
re-run off this stamp.

**Conflicts take the route they always took, one stage earlier.** The
pre-verdict update calls the same `branchUpdate`, the same merge round, the same
stall and fresh-pass ladder as the ship stage. It differs in two flags: it pushes
nothing (no request exists yet, and a branch pushed here would meet a later fresh
pass's rewrite with a plain push), and it leaves the `branch-update` stamp to the
ship stage, because its own stamp carries the shas. A conflict therefore surfaces
before the request, where the repair costs no CI round and the verdict that
follows covers the merged result.

The round itself runs under the token, and that is the one piece of work before
the request that keeps it. A round resolves conflicts against one default-branch
head, so a competing merge under it can make the resolution stale and the seats
repeat their work. A verdict cycle has no such tie: it judges a tree, and a
branch that moves under it is answered by the next update and its fast path. The
human wait behind a failed round is outside the hold either way, because the
stall parks and the park releases.

**Two run events.** `ship-token` (`state`: `waiting` with the holder and the
number of runs ahead, `acquired`, or `released` with its reason) and
`pre-verdict-update` (`pass`, `ran`, `mainSha`, the shas when it ran, `code` and
`records` with the files that decided each, `capped` when the bound refused it).
One wait stamp per wait, not one per poll. The update stamps whether it ran or
found the base where the run left it: a run that merges the default branch into
its own tree on its own authority says so either way.

**The suite restore anchors on the merged tree.** Every story-mode restore of the
test paths checks out from `restoreAnchor`: the freeze commit until the tree
merges the default branch, the merge commit after that, and the commit a fresh
pass was born on after a reset. A ship-stage `branch-update` re-anchors exactly
as the pre-verdict update does, and a re-freeze authored on the merged tree takes
the anchor back to itself.

**The slot cap is unchanged.** It stays the concurrency knob for everything
before the ship. The token serializes the last stretch of each run rather than
the runs, and it holds a slot while it waits, because the run is alive and its
worktree and stack are up.

## Why the token is derived and never stored

A stored token is a second source of truth about a state the ledgers already
hold, and it fails in the two ways a harness cannot afford: a crash between the
write and the merge leaks it, and a restart that rebuilds it from memory
duplicates it. Ledger derivation has neither failure. The stamps are records of
what the machine did, not the storage of a right, so the token survives a restart
for the same reason every stage does: the run ledger is the memory.

## Why the update stage reads a release before it takes the token

The release is the last thing the stage does before it hands the run to the
verdict, and the stage transition behind it is a separate write. A restart in
that window re-enters the update stage. So the stage asks first whether its own
last token stamp is a release with no green render after it, and returns to the
verdict at once when it is. Without that question the run would take the token
back, or stand in the queue for it, only to be told to go and judge its tree.
That is the exact cost the release exists to remove, re-created inside a crash
window.

The reason is half the question, which is what makes the closed set load-bearing
rather than decorative. A release for a park stopped the run AT this stage, and
the answer resumes the stage to finish the update it could not finish. Reading
that release as a re-verdict would send the answered run to judge a tree it never
merged, and buy a whole cycle to arrive back here with the same merge still owed.

The reason also names which journey the run left for. `releasedForVerdict`
answers `verdict` for a `re-verdict` release with no green code render behind it,
and `reconcile` for a `re-reconcile` release with no green record render behind
it. The two certifications stand on two trees, so a green of the wrong kind
answers neither release (ADR-0075).

A daemon stop is not an exit from the stage. The handler returns no directive,
the run keeps the token, and the restart hands it the same token back.

## Why the holder keeps the token through a repair behind an open request

The hold from the request to the merge covers a CI red and the repair round it
earns. Releasing there buys nothing: the request is open, so a competing merge
under it still costs the branch update it was going to cost, and the released run
would re-queue behind the runs it was ahead of. So a run whose ledger carries
`pr-opened` never releases, whatever route it takes afterwards, and the rule sits
in the token rather than at a call site.

The window before the request is the opposite case. There the run holds no
request, has nothing to update, and the work in front of it is a verdict cycle or
a person.

## Why a released run may buy a cycle, and why that is the right trade

A run that gives the token back can meet a competing merge when it comes back. If
that merge touches ground its certification rests on, the run judges its tree
again, where the run that never released would not have.

That cycle is honest work about a real change. A certification has to be true of
the tree that lands. If a competing merge invalidates it, the harness has to
judge again, and holding the token merely moves the competing merge to after this
run's ship and charges the competitor the whole wait. The bound is one extra
cycle per other open run of the project, because a run merges once and is then
gone, and the slot cap bounds the open runs. The wait the release removes has no
work in it at all.

## Why the verdict re-renders after an update that moved the tree

The point of moving the update ahead of the final verdict is that the verdict
certifies the tree that lands. A render behind a merge certifies a tree that no
longer exists. The re-render costs one Tier-1 cycle: the judgment seats fire once
per implementation pass and the merge starts no new pass, so the second cycle is
the deterministic spectrum and nothing else. A red it turns up enters the ladder
like any other red, which is the correct answer: the default branch broke this
candidate, and the run repairs it before the request rather than after a CI
round.

## Why the restore anchor is the merged tree and not the freeze

The restore that voids test tampering covers the whole of the test paths, not the
file list the freeze recorded. That is what makes it structural: a write to any
test-path file is undone whether or not the freeze authored the file, so no seat
quiets a test by writing one the freeze never named. The price of that reach is
that the anchor decides the content of every test-path file the run never wrote,
and those files belong to the default branch.

The freeze commit describes the default branch as it stood when the run launched.
Once the update merges, that tree no longer exists: the merge commit holds the
frozen suite and everything the default branch shipped since, and it is the tree
the request will land. Restoring from the freeze there reverts every test-path
file the default branch advanced, such as other stories' shipped tests, their
recorded fixtures and their registries, over source files the merge left current.
The result is a deterministic red that belongs to no candidate: the tests are
weeks old, the code beside them is current, and neither the candidate nor its
suite is wrong. A run met it as a merge of six such files across three earlier
merges, and the reds it raised named the two layers those files cover.

The merge commit is the honest anchor for both halves of the same reason. It
carries the frozen suite, because the branch it merged into carries nothing else
under the test paths; and it carries the default branch's later work, because git
merged it in. So the restore against it still voids every seat write to a test
path and reverts nothing else.

A fresh pass resets the tree, and the anchor follows the reset. A pass reset to
the pre-implementation commit drops the merge with it and anchors on the freeze
again, because restoring merged tests over a pre-merge tree would mix two trees
that never existed together, and it merges again on its own way to its own
verdict.

A merge-born pass is reset onto the updated default branch itself, because that
is where the conflict it was called for dissolves, and there no sha the run holds
names the tree it needs: the freeze commit reverts everything the branch advanced
under the test paths, and the branch carries no frozen suite. So the pass composes
one. It carries the suite commit's own test-path files onto the reset tree, which
is the files the freeze changed since the two trees last shared a commit and not
the whole of the test paths, commits that, and stamps the commit on its
`fresh-pass`. The commit carries both halves for the reason the merge commit does,
and every restore behind it answers to the tree the candidate ships onto. Without
it the pass reverts the branch's test paths from its own birth to its next
update, which is the same silent reversion one stage further on.

## Why the wait is not a timeout

A waiting run polls the ledgers for a state change, which is the merge or the
release that ends the holder's turn, exactly as the check watcher polls the
forge. `pollMs` is the cadence of the reading. No span of wall-clock time decides
anything here, and the wait stamp says what the run is waiting on and who holds
it, so a queue that stops moving is visible in the ledger rather than inferred
from silence.

The same rule bounds the hold. A hold ends at a state change and never at a
timer. What watches it is a reading rather than a rule: `ship-token-hold` is the
longest single hold of the last runs that held the token, and `ship-token-wait`
is the longest queue wait beside it.

## What the close-out card sweep does with the token

Nothing. The sweep pushes planning cards straight to the default branch after the
story merged, where the sweeping run holds nothing and the token is already free
for the next run. A sweep that queued for the token would hold a slot and a
worktree behind the next run's whole ship path, and the planning text the next
launch reads would land hours after the story it describes. The token orders
merges of requests, and the sweep is not one.

The cost is that a sweep can move a holder's base. The holder's next update
merges it and asks its fast path whether the move touches ground its
certification rests on. A cards-only move that the project declares inert is
carried; anything else buys the holder a verdict cycle, and the holder buys it
without the token.

## Fallback paths

If the single token starves one lane behind the other, such as a repair waiting
on a story merge, the token splits per lane: the derivation keys on the launching
lane beside the project, and the queue becomes one per lane. Trigger: a repair
waiting on a story merge in the duration history. Reversal cost: low, one key in
the derivation, and no change to the gate or the stamps.

If the pre-verdict update churns on a busy default branch, the cap is what stops
it: past `UPDATE_CAP` the run falls through to the ship-stage update it took
before, and the `capped` stamp says so. Trigger: two updates in one pass in the
ledgers. Reversal cost: low, one constant, and the route under it does not
change. Setting the cap to zero disables the pre-verdict update entirely and
leaves the token doing its own job.

If the release costs more than the queue did, which would show as released runs
that reliably buy an extra verdict cycle a competing merge did not earn, the
release narrows to the fast-path refusal alone or goes away: the stage keeps the
token on every exit, and the fold reads a state nothing stamps. Trigger: extra
cycles behind releases that outweigh the queue waits they removed, read from
`ship-token-hold` and `ship-token-wait` over the same window. Reversal cost: low,
one call in the update handler; the derivation, the stamps and the queue order do
not change.

If a project needs the frozen suite pinned across a merge, such as a repository
whose default branch rewrites shared test scaffolding often enough that the
merged version is the less stable one, the anchor narrows: the merge commit
answers for the test-path files the freeze did not name, and the freeze commit
answers for the ones it did, from the file list the freeze already records.
Trigger: a post-update red whose evidence is a merged test file the freeze
authored. Reversal cost: low, one derivation and a second restore pass; the
stages, the stamps and the freeze record do not change.

If the token proves too coarse, such as a project whose merges are cheap enough
that serializing them costs more than the concurrent pairs did, the gate moves
behind an instance-config flag per project, defaulting on, and a project that
turns it off keeps the pre-verdict update and queues for nothing. Trigger: ship
waits in the duration history that outweigh the update rounds they saved.
Reversal cost: low, one config read at the gate; the stages, the derivation and
the stamps do not change.
