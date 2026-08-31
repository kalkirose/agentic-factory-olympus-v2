# ADR-0062: A gate that judges the world can be acknowledged

Status: accepted (2026-08-31)

## Decision

A provisioning gate whose park states a judgment the harness formed about the
world offers a third answer beside `retry` and `abandon`: `ack`, with a written
reason. The answer records `gate-acknowledged` against the run and the run goes
past that gate.

- **The scope is a closed set in code.** `WORLD_GATES` in `src/lanes/shared.mjs`
  names the three checks that offer it: `credential-surface`,
  `credential-probe`, `substrate-probe`. A key may carry a subject after a colon,
  so an ack of one credential's probe is not an ack of another's. Nothing else
  offers the option, and adding a gate to the set is a decision taken there.
- **The reason is required.** The park record declares `ack` as a reasoned
  option, and an answer without the text is refused with the forms quoted.
- **The acknowledgment stands for one run and one gate.** It ends with the run.
  It covers no other gate, and it is standing policy about nothing.
- **The check still runs and still records.** What an ack changes is whether the
  run stops, never what the ledger says was read. The read's own stamp names the
  acknowledgment that let the run past.
- **It is disjoint from the finding acknowledgment.** A park declares a set of
  findings or a world gate, never both, and the engine refuses one that declares
  both.

## What this is for

A provisioning gate asks the operator to repair something the run cannot touch,
then to say so. Both of its answers assume the gate is right. `retry` re-reads
the world and parks again if it still disagrees; `abandon` closes the run.

A gate can be wrong. The credential-surface gate compares a declaration the run
pinned at launch against the surfaces as they now stand, and a surface
deliberately retired since the launch makes that comparison a statement about a
world that no longer exists. The credential probe reports what a
project-declared command made of a value, and the command can be as wrong as any
other. The substrate probe infers a broken host from two loopback families
answering differently, and a project may publish on one family by design.

For each of those, `retry` asks the same wrong question again and `abandon`
throws away everything the run earned. The run has one honest way out, and it
runs through a person: somebody who can see the world says the gate is wrong,
in writing, and takes the consequence.

## Why some gates and not others

The line is between a judgment and a refusal.

A gate states a **judgment** when the harness compared something it holds — a
pinned declaration, a project-declared probe's verdict, an inference over a live
read — against the world. A judgment can be stale or wrong, and the operator
standing in front of the world is the one who can say which.

A gate states a **refusal** when the world itself said no to an action the
harness took: a remote that rejected a push, a forge that would not arm
auto-merge, a label it would not apply, a check run it never delivered. An ack
cannot talk past one of those. The action did not happen, acknowledging it does
not perform it, and the step behind the gate needs it to have happened. A run
walked past a rejected push would open a request for a branch that is not there.

And no gate that reads the run's own tree offers it, whatever else it does,
because a tree cannot be stale against itself.

## Why the verdict lane's gate is deliberately absent

The verdict lane's operational-fix gate already answers itself on standing
finding acknowledgments: keyed per finding, held on the instance across runs,
and ended only by a revoke that names the fix it stands on. That is a finer
instrument than this one and it answers a different question — whether a named
harness defect is known — rather than whether a gate is wrong about the world.

Two acknowledgment rules at one gate would leave nobody able to say which of
them let a run through. So that gate keeps the one it has, this one does not
reach it, and the engine refuses any park that declares both.

## Why the acknowledgment lasts the run and no longer

A gate that judges the world wrongly at the launch judges it wrongly again at
the ship. Asking the same person the same settled question twice inside one run
is the loop the option exists to end, so an ack answers the gate rather than the
one park.

It reaches no further. Nothing here is policy: the next run reads the world
fresh, asks again, and gets its own answer. That is the difference between this
and a standing finding acknowledgment, and it is why this one needs no revoke —
it expires with the run that took it.

## What a reader can ask of this

The event carries the gate, the park it answers, the stage the run stood in, the
actor and the reason. The read that was walked past carries the seq of the ack,
so the two never have to be matched up by hand.

The measure is the standing `gate-acks` tripwire: acknowledgments over the last
ten runs of the project, with the gates they named. One is a gate that was wrong
once. Two is a pattern, and the breach says so.

The eval question is which gate the acks name. One gate dominating the count is
the check to repair — a declaration that keeps going stale, a probe command
nobody maintains, a probe whose inference does not fit the project. An
acknowledgment is a way past a gate for one run. It was never a repair, and a
count that stays high says it is being used as one.

## Fallback paths

If the option is used as a habit rather than an exception, the tripwire is what
says so, and the answer is the gate it names. Removing the option again is one
line: the gate's key leaves `WORLD_GATES` and the site's forms go back to
`retry` and `abandon`, which is exactly what those gates offered before.

If a gate outside the set turns out to need it, adding it is a line in the same
set plus the site's own forms — and the judgment-against-refusal rule above is
the question that has to be answered first.
