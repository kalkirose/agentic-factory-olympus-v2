# ADR-0093: The code head is one definition, and a quiet stage cycle stops loud

Status: accepted (2026-09-17)

## Context

A run on the ship path holds one tree and four readers ask one question of it:
has the tree this run holds been judged?

The admission gate asks it before it opens a request. The verdict stage asks it
to decide whether a cycle is owed. The suite restore asks it to know which tree
its frozen paths belong to. The update stage asks it under the ship token. Each
of them answered from a set of stamps of its own.

The sets agree while the run's last commit is its implementation commit. They
stop agreeing the moment a commit that is not a dev pass lands after it. A suite
amendment commits tests and no implementation, so it stamps no
`implementation-committed`. A merge this stage makes under the token commits the
default branch into the run's tree. Both are commits the run ships, and a gate
that read the last implementation commit asked for a green over a tree the run
will never ship.

A disagreement between two of those readers is not one wrong answer in one
place. The verdict stage reads its last render as green and the tree as unmoved,
so it renders nothing and hands the run on. The reconcile stage finds nothing
owed and hands the run on. The update stage reads the token it gave back, finds
no green render behind the release, and sends the run to the verdict. Every
handler is right on its own evidence, nothing is stamped, and the three stages
pass the run round for as long as the daemon runs. The engine sees a run that
always has a transition in progress, which is exactly what liveness asks for.

The same shape stood on the record side. A merge that asked for a record re-run
over a reconciliation that was already a fallback sent the run to a stage whose
last word that fallback was, and the stage answered `done` without rendering.

And the update stage had crash windows behind every write it makes. A merge is
idempotent, so a stop between the merge and the stamp resumes into a merge that
answers "already up to date" and a base that reads exactly like one that never
moved. The route then rested on a certification earned over the tree before the
merge.

## Decision

**The code head is one definition, and every reader takes it from there.**
`src/lanes/codehead.mjs` holds `CODE_HEAD_STAMPS`: one entry per stamp that
moves the code head, each with two readings of itself. `moved(e)` is whether the
stamp put a different tree under the run, which is what buys a verdict cycle.
`sha(e)` is the head the tree stands at afterwards, or null.

Three stamps are on the list. `implementation-committed` moves always and names
`sha`. `re-freeze` moves always and names `sha`, except a re-freeze a merge round
wrote, which names none. `pre-verdict-update` moves under `ran: true` or
`unnamedHead: true` and names `toSha` there. `codeHead(events)` is the last
non-null sha over the ledger.

There is no fourth because of the route. The verdict renders at the worktree
head. Every route back to the verdict from the ship path carries a red render or
a new implementation commit. A `fresh-pass` reset and a `freeze` are each
followed by an implementation commit before any stage decides anything.
`operational-fix` commits nothing: it moves the verdict's reading and names no
sha, so the verdict keeps it beside the list rather than in it.

**The record commits are outside the head and named all the same.** The reconcile
stage commits its records after the verdict's final green (ADR-0075). A head that
followed them would stand at a sha no green render names, and every ship would
buy a verdict cycle over a tree the code never changed.

**`branch-update` is not a head, in either of its writers.** The pre-freeze one
is always followed by an implementation commit. The ship-stage one lands under an
open request, where the forge's checks certify the tree (ADR-0033), and the
verdict does not read that stamp as moved: reading its sha as the head would send
such a run through a full local cycle the forge already ran. A merge round's
re-freeze inside the ship stage is the same tree under the same request and is
excluded for the same reason, which is why that stamp carries `source:
'merge-round'`. In the update stage the `pre-verdict-update` behind it carries
the same sha, so the exclusion costs nothing there.

**The four readers.** `codeTree` in `src/lanes/ship.mjs` reads `codeHead` and
asks for a green `verdict-rendered` at that sha or a `fast-path-ship` that
carried the certification onto it. The verdict stage's moved check reads
`moved(e)` off the list. `restoreAnchor` in `src/lanes/verdict.mjs` reads the
`pre-verdict-update` entry's `sha(e)`, so an unnamed head judged at the merge sha
restores its frozen paths from that tree and not from the commit before the
merge, which is the revert that anchor exists to prevent (ADR-0033). The update
stage reads the head it finds under itself.

**A head the ledger cannot name is stamped and judged.** Whenever the update
stage finds its base unmoved, it compares the worktree head to `namedHeads`: the
code head, every `branch-update.toSha`, the `toSha` of every carried
`fast-path-ship`, the sha of every record commit (`reconcile-rendered`,
`record-written`, `reconciliation-written`, `records-committed`) and the `to` of
every `tree-refreshed` that moved. A sha some judgment, some carry or some record
commit stands behind, and nothing else.

Five stamps carry a sha and are refused by name, each because it names a tree the
run holds that nothing has judged: `merge-round.sha`, a merge-round
`re-freeze.sha`, `suite-committed.sha`, the `toSha` of a `fast-path-ship` that
carried nothing, and `fresh-pass.sha`. A head named by one of those alone is
exactly the tree a stop left unjudged.

A head in none of the set stamps `unnamedHead: true` with every certification the
lane holds asked again, and routes to the stage that certifies the lane. The
check is unconditional: gating it on the gate admitting the tree would send an
uncertified tree at an unnamed head to a verdict that reads it as unmoved.

**The resume rule reads the certifications.** `releasedForVerdict` answers null
for a `re-verdict` release when a green render stands after it OR when the code
certification stands over the code head, and null for a `re-reconcile` release
when a green `reconcile-rendered` stands after it OR when the fallback write does
(ADR-0080). A re-run asked over a fallback stalls at the cap it already spent.

**A re-run the stage decided and never handed on is still owed.** `rerunOwed`
reads the last `pre-verdict-update` or `fast-path-ship` since the fresh pass
whose records answer is `rerun`, and answers true while no green
`reconcile-rendered` and no fallback write stands after it. Both stamps are read
because both are written before the transition, and the reconcile stage cannot
answer for a re-run it is never entered to see.

**A fast-path decision stamped and not carried into a route is completed, not
retaken.** A `fast-path-ship` newer than the last `pre-verdict-update` is the
stop that caught the update stage between its two writes. The stage states the
merge as the merge it was, with the answers that record holds, once the worktree
confirms it still stands at that sha. Taking the check again against a default
branch that has moved since would answer a different question and lose this one.

**A fresh pass the update stage's merge round bought is finished by the verdict
stage.** The `fresh-pass` stamp lands before the seat runs, so a stop inside the
seat leaves a reset tree with no implementation on it. The update stage routes
such a run to the verdict, which resumes the interrupted step at its entry. The
route gives the ship token back, because the pass is a whole dev seat and every
other run of the project would otherwise wait through it (ADR-0033).

**A fallback is never re-run.** Where the record certification is a fallback and
the decision asks for a re-run, the update stage folds the answer to `{answer:
'kept', reason: 'fallback-stands'}` before it stamps. One funnel where the stage
decides, rather than seven inside the check, so the check's own record keeps what
the check said.

**A carried code answer is a carry.** The check answers the code question and the
record question apart (ADR-0086), so a record refused for a record reason can
hold a code answer of `kept`. That answer is the check's own certification of the
merged tree. `carriedFastPath` is the one predicate for it, and every reader of a
carried ship takes it: the admission gate, `fastPathTaken` behind the close mark
and the escape attribution, the telemetry list of fast-path ships and the trade
counter. A carry none of them could see would be a ship that skipped a certifying
pass and said so nowhere (ADR-0056). Such a record carries `certification`, the
render the carry stands on, so `codeCertification` can answer for a merged tree
no verdict rendered at.

**A quiet stage cycle is a loud liveness violation.** Every handler decides from
the ledger, the worktree and the forge, and every decision that changes anything
stamps. So a run that enters a stage it has already entered since its last
appended line of any other kind has made the same decision from the same evidence
and would make it again. The engine keeps `quiet`, the stages entered since the
last other line, folded the same way at replay and carried over a restart.
`chainStage` refuses a `next` the streak holds: one `liveness-violation` on the
loud stream whose detail begins `stage cycle:` and writes the loop out, and the
run stands inert as every violated run does.

The operator hold is read first. A held run is standing still by a person's word
and is chaining nothing; reading the cycle first would leave it violated with no
`stage-held` behind it, so no release would find it and a resolve would run its
stage under the hold. The streak restarts at the release and a cycle that
survives the hold is refused three transitions after it.

**A resolve is not a recovery.** `resolve` re-executes the stage of a violated
run once every violation is cleared, so a stage-cycle violation resolved with its
cause in place re-trips within three transitions. The recovery for a cycle is the
fix of the disagreement that made it, on a new pin, and the line names the stages
that disagreed.

## Consequences

Two lists must be kept. A stamp that moves the head and does not join
`CODE_HEAD_STAMPS` is caught at the next update entry as an unnamed head, judged
from the right anchor and counted. The cost of that miss is one verdict cycle and
one counted line, against a silent ship on an older green. A writer that moves
the worktree and stamps nothing `namedHeads` reads buys one verdict cycle at that
head, and the stamp says which sha. A writer added to `namedHeads` that names its
sha before the tree is judged re-opens a crash window for itself alone, which is
why the list states what qualifies.

A rule can refuse an honest chain. A stage that passes through twice with nothing
stamped between stops the run loud. That is a held run and not a lost run, and
the fix is one stamp in the stage that decided something.

New load-bearing fields. `pre-verdict-update.toSha` under `ran: true` or
`unnamedHead: true` decides the code certification and the suite restore's
anchor, and a `fast-path-ship` code answer of `kept` marks a ship. Both are
written by the stage from the merge it just made and the check it just ran.

A carried refusal reads as a fast-path ship. The close mark, the escape
attribution and the trade counter treat it as one. That is the trade ADR-0056
describes, taken by halves, and the record keeps its refusal word beside its code
answer so the two are still told apart.

A fallback now ships without a re-run. A moved base that touched a record in a
capped run's neighbourhood is merged with the residual named and no further
round. That is ADR-0080's rule applied one stage later than it was.

Replay folds one more field off the ledger. The daemon start already reads every
open run's file whole.

## Rejected options

- Stamp `implementation-committed` at the re-freeze. The re-freeze commits tests
  and no implementation. Every reader of that stamp would read a suite amendment
  as a dev pass, and a test edit would spend the fresh-pass budget.
- Render the verdict again at the implementation sha. That tree is not the head;
  the run would judge a tree it will never ship.
- Read the certification off the last green render, as before ADR-0075. The
  stale-ship case that record names returns: a repair round after a green
  reconciliation ships under an old render.
- Fix the gate and leave the resume rule counting renders. The rule answers
  before the gate is asked, so the run never reaches the fixed gate.
- Fold the fallback answer inside the check's own functions. A re-run is built in
  one place and copied from seven refusals. One funnel where the stage decides
  covers them all and leaves the check's record honest.
- Compare the worktree head to the code head alone. An honest ship-stage merge
  with an environment-only red check reads as an unnamed head and buys a full
  local cycle the forge already ran.
- Read every sha the ledger writes after the head stamp as a named head. The
  update stage's own merge round and a refused check each name the merge sha
  before the stamp that records the merge, so a stop between them would read as
  named and ship the merge unjudged.
- Stamp the merge before the check's questions. That stamp would move the head
  for the check's own certification read, which is taken before it on purpose.
  Comparing the head to what the ledger names closes the same window with no new
  stamp.
- Finish the interrupted fresh pass inside the update stage. The pass is a whole
  dev seat and the stage holds the ship token: every other run of the project
  would wait through it.
- A cap on stage entries per run, or a time window on transitions. A number tuned
  to nothing that a long honest run could reach and a short spin could sit under;
  and timing is not evidence, because a slow cycle is still a cycle.
- Leave the loop guard out and fix the disagreements alone. The next disagreement
  between two stages spins the same way, and only a person stops it.

## Fallback path

`CODE_HEAD_STAMPS` is one map and `codeHead` one reader: a head definition that
reads wrong for a project is reverted by taking a stamp off the map, at which
point the unnamed-head check catches what the map no longer names and the run
takes one verdict cycle instead of a wrong ship. The switch trigger is a window
of `unnamedHead` stamps whose shas all come from one writer. The cycle rule
reverts by removing the `quiet` test from `chainStage`, at the cost of the
condition it catches; its switch trigger is a stage-cycle violation on a chain
that was not a cycle, and the chain is named in the line. Both reversals are a
few lines and no ledger change: every field the rules write stays readable.

## References

- ADR-0022, ADR-0033, ADR-0034, ADR-0040, ADR-0056, ADR-0075, ADR-0080,
  ADR-0086
- `src/lanes/codehead.mjs`
- `src/lanes/ship.mjs`
- `src/lanes/verdict.mjs`
- `src/lanes/fastpath.mjs`
- `src/engine/engine.mjs`
- `src/engine/replay.mjs`
- `src/center/snapshot.mjs`
- `src/telemetry/readers.mjs`
- `src/tripwires/metrics.mjs`
- `src/ledger/registry.mjs`
