# ADR-0040: An operator hold stops the stage chain, and nothing else

Status: accepted (2026-08-27)

## The condition

Maintenance needs a moment with no live seat. Before this the harness offered
two levers and neither one is that moment.

A project pause governs launching. It stops the frontier from filling a free
slot and leaves every run already in flight exactly as it was, so a paused
factory can still hold four seats deep in a verdict for the next hour.

A clean stop governs the process. It terminates every seat mid-work and stamps
each one `seat-terminated`; the run resumes its stage at the next start, and
what the seat had done inside that stage is gone with the child. The cost is
real work and re-spawn time, and it is invisible in advance: the operator
cannot see when a stop is cheap. The 2026-08-23 restart was timed by hand,
reading heartbeats until the seats happened to be idle.

So the harness had no way to be asked for the state a maintainer actually
wants: every in-flight run finishing what it started, and nothing new starting
after it.

## Decision

**A hold is a statement about the stage chain and about nothing else.** It
interrupts no seat, ends no command, and refuses no launch. The engine reads it
at the one place stages chain — the handler settle in `executeStage` /
`enterStage` — and, instead of entering the next stage, stamps `stage-held`
with the stage that settled and the stage that did not start, and idles the
run. `release` enters the deferred stage of every run the release frees and
stamps `stage-released`. The two stamps bound the wait, and they are ordinary
append-only run-ledger events: a reader of an archived ledger sees exactly what
an operator stopped and when it started again.

**The console surface is `hold` and `release`, over a project or the
instance.** `olympusctl hold --project <p>` and `--all`, through the control
inbox like every command, with the usual done/rejected trace. The instance
scope and a project scope are separate statements, and a run is held while
either stands: a release ends the one it names. An operator who held the
instance and then released one project asked for one project, and the instance
hold is still the reason the rest of the factory is quiet.

**A hold survives a restart, because that is what it is for.** The state is an
instance-ledger event, `hold-changed`, folded at every daemon start the way
`arming-changed` is. The restart recipe is then: hold, wait for every run to
reach a boundary or a park, stop with zero live seats, start, release. A held
run resumes as a held run — the stage it completed is not run again, and the
stage behind the boundary waits exactly as it did before the process died.

**A held run keeps its slot.** A hold is operational, not scheduling. Freeing
the slots it stops would let the frontier launch into them, and every one of
those launches would be a run competing for a slot the moment somebody
releases. A park frees its slot because the run may wait on a human for a day;
a hold is measured in the minutes a maintainer needs.

**Held time is waiting, not work.** `hold` joins `WAIT_CLASSES`
(`src/ledger/durations.mjs`) with `stage-held` opening a span and
`stage-released` closing it. It is in the run's own classes, so `activeMs` on
the close stamp excludes it, and in the band's classes, so a stage that stood
through a hold contributes the work it did and not the hours it waited. This is
the same split ADR-0039 made for the ship-token queue, extended by one entry
rather than rebuilt.

**The quiet is telemetry, not silence.** The stage beat keeps running over a
held run with `waitingOn: 'hold'` and the deferred stage as its detail, so
liveness telemetry reads intentional quiet rather than death. The liveness
invariant gains a fourth allowed state: an open run holds an in-flight child, a
parked escalation, an operator hold, or a transition in progress. The silence
deadline is untouched — it is armed by a seat child, and a held run has none.

**Auto-launch and the hold stay independent.** Pause governs entry, a hold
governs progression, and `hold --all` on a paused project is the full freeze. A
launch under a hold enters its first stage: entry is not a chain, and an
operator who wants nothing to start says so with the lever that means that.

**Observability.** `olympusctl status` marks a held run `[held:<next-stage>]`,
counts held runs apart from active ones in the header, and carries a hold on
the project line whether or not a run is standing on one. The command center
badges a held run with the stage a release will enter.

## Why the boundary rather than an interrupt

A hold that ended work would be the clean stop with extra steps. The whole
value is that the operator gets the moment without paying for it: a seat that
is nine minutes into a suite run finishes, its ledger keeps what it earned, and
the run stops at the next place where stopping costs nothing. The price is that
a hold is not instant — a stage that takes an hour takes an hour — which is why
`status` says what each run is waiting on and the beat keeps proving it alive.

## Why the answer to a park is recorded under a hold

A run that parks while held parks normally, and its answer records the moment
the human gives it. Refusing the answer would make the hold a lever over the
human rather than over the machine, and the answer is information the run owes
its ledger whenever it arrives. What the hold stops is the step behind it: the
resumed stage enters at the release, and the run holds at the boundary it is
already standing on.

## Fallback paths

If holding at the stage boundary proves too coarse — a lane whose stages run
for hours, where the operator waits too long for the moment — the chain point
gains a second, finer one: a lane may declare a hold-check inside a stage, at a
step of its own choosing, and the engine's `chainStage` is what that step
calls. Trigger: recorded holds where the wait to the boundary is longer than
the maintenance it was taken for. Reversal cost: low — the transition,
the stamps and the release path are unchanged, and only the set of places that
consult the hold grows.

If a held run's slot turns out to be worth freeing — a long hold on a project
whose repairs then starve — `activeCount` skips held runs, and the frontier
gains a release-time check that refuses to oversubscribe. Trigger: a hold long
enough that owed repairs pile up behind it. Reversal cost: medium — one line in
the engine, and a new rule in the launcher to keep the release from
oversubscribing.

If a hold ever needs to end work rather than let it finish, that is the clean
stop the harness already has, and the two stay separate commands. Nothing here
should grow a `--now` flag: a lever that sometimes interrupts and sometimes
does not is a lever an operator cannot use under pressure.

If the instance and project scopes prove confusing in practice — an operator
releasing `--all` and finding a project still held — the release grows a
report of what is still standing rather than a rule that clears everything.
Trigger: a release an operator repeats because nothing appeared to happen.
Reversal cost: low — the scope fold is one map, and `status` already renders it.
