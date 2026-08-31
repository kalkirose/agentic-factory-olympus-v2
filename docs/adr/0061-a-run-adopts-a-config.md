# ADR-0061: A run adopts a project config, on the record

Status: accepted (2026-08-31)

## Decision

An open run may be repinned to a different project config, by an operator, with
a reason. `olympusctl reconfigure --run <id> [--blob <sha>] --reason <text>`
queues it, and the daemon stamps `run-reconfigured` on that run's ledger.

- **The launch record is never edited.** `run-launched` keeps the blob the run
  launched with, for ever. Replay applies the newest `run-reconfigured` over it,
  so the current pin is derivable from the ledger alone and the launch stays a
  true statement about the launch.
- **The reason is required.** An empty one is refused at the console and again
  at the daemon.
- **The blob is proven before anything is stamped.** Without `--blob` the daemon
  fetches and reads the project config on the default branch at the time of the
  command; with one it reads the blob out of the project's bare clone. Either
  way it is parsed and validated first, so a run is never pinned to a config no
  stage could load.
- **The run re-enters no stage.** It continues where it stands. A parked run
  stays parked and meets the new config on the answer that follows.
- **Only the config blob moves.** Every other launch value is a fact about the
  launch and stays as recorded.

## What this is for

A run pins its project config at launch and every stage reads that pin. The pin
is what makes a run reproducible: the gate table, the credential declarations,
the diff policy and the budgets a run is judged against cannot change under it
while it is being judged.

The same pin is what leaves a run judging the world against a config nobody
holds any more. A run whose config named two CI workflow files parked at a
credential gate after both files were deliberately retired. The gate offered two
answers. `retry` re-read the same blob and parked again. `abandon` threw away a
spec, a frozen suite and a green verdict. Neither is an answer, so the run was
cleared by hand-editing `run-launched` in its ledger — which worked, and left
that run's own history stating a launch condition that never held. It was done
three times in one day.

This is the honest form of that operation. The run gets a config that exists,
the ledger keeps saying what actually happened, and the change carries a name
and a sentence.

## Why the newest event wins, rather than a rewrite

An append-only ledger has one rule that everything else here rests on: what is
written is what happened. A rewrite of `run-launched` breaks it silently — the
file still parses, every reader still works, and the run's history is a lie that
nothing can detect afterwards.

Applying the newest `run-reconfigured` over the launch value costs one case in
the replay and one line in the event registry. The run's whole config history is
then readable in order: what it launched with, what it was moved to, when, by
whom, and why.

## Why the run does not re-enter a stage

A reconfigure states which config the run reads. It states nothing about the
work the run has done, and re-running a stage on the strength of a config change
would throw away results the run earned under a config that was not wrong about
them.

A stage already in flight keeps the config it loaded and reads the new blob at
its next load. That is why the stamp carries the stage and whether the run was
parked: an operator who wants the change to land on a boundary reconfigures a
parked or a held run, and the record says which of the three it was.

## Why the project's tripwire registry is not touched

The registry the watcher evaluates is scoped to a project, and it is set from
the config each launch reads. A reconfigure is about one run. Moving a
project-wide registry from a per-run command would let a repin of one run change
the bands every other run of that project is watched against, and a `--blob`
naming an older config would move them backwards. The next launch sets the
registry, as it always did.

## What a reader can ask of this

The event is the record: the blob before, the blob after, the actor, the source
(the default branch, or a blob somebody named), the stage, and the reason.

The measure is the standing `run-reconfigures` tripwire: the runs that repinned
over the last ten runs of the project. One is a config that moved under a long
run. Two says the launch is pinning a config its own runs cannot use, and the
repair is in whatever writes that config rather than in the runs.

The reasons are what a review reads. If every one of them says a declaration was
retired, the answer is a rule about retiring declarations while runs hold them,
not a faster way to repin.

## Fallback paths

If the command proves to be a way of steering runs by hand rather than an
exception, the reading that says so is its own tripwire, and the answer is a
project rule about config changes during open runs. The command stays: the
alternative to it is the hand edit it replaced.

If a run must not adopt a config at all, the operator abandons it and launches
again, which is exactly what was available before this existed.
