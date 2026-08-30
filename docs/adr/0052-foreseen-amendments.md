# ADR-0052: The close-out sweep classifies, and only a real choice reaches the owner

Status: accepted (2026-08-30)

## The condition

A story ships and freezes a suite. The close-out sweep then looks ahead at the
cards that are still unshipped and sees that a later card's work will collide
with the tests this ship just froze. Until now the sweep wrote that collision
onto the later card as an open decision: "decide at build time whether ...".

An open decision on a card parks the launch of that card at the readiness gate,
before any seat has read anything. So the line lands ahead of the machinery
that settles frozen-surface collisions from card authority (ADR-0044), and that
machinery never gets to run. The owner is asked, once per ship and for ever,
about collisions the later card's own acceptance criteria already answer.

The waste is not the park. The waste is that the sweep looked at a collision,
knew enough about it to write a sentence, and then wrote the sentence in the
one form that guarantees a human will be woken for it.

## Decision

**The sweep classifies every downstream collision it finds, and the class
decides the route.**

A collision the target card's own acceptance criteria MANDATE is a foreseen
amendment. The sweep writes a note on that card under a `Foreseen amendments`
heading: the clause the frozen tests pin, the file it lives in, and the card
line that mandates the change. The note is informational. The readiness gate
does not park on it, and the build-time classifier consumes it as evidence when
that card is built (ADR-0053).

A collision the target card genuinely leaves open is a question, and it goes to
the owner at close-out, while the context is fresh. It is a `card-decision`
park in the instance ledger. Like `card-invalidated` before it, that park
belongs to the CARD and not to a run: it holds the next launch of the card it
names, it offers no abandon because there is no run to close, and the story
that shipped closes `shipped` either way.

Nothing is planted on a card that a later launch has to be woken to remove.

### Where the note lives, and why on the card

The card is the durable home for anything the next story has to read. A run
ledger archives with its run; the card outlives every run by design, and the
sweep is already the one mechanism allowed to write a card on the default
branch (ADR-0044).

Two mechanical rules keep the note from becoming a question again:

1. **The heading.** The notes live under their own heading, so the section the
   readiness gate reads for open decisions never contains one.
2. **The marker.** Every note opens with `Foreseen amendment:`. The card parser
   filters any decisions-section item that carries the marker, so a note a
   writer put under the wrong heading still parks nothing. Structure and
   content both say the same thing, and the launch gate is safe if either one
   is right.

### What the sweep has to prove

The report is the sweep's claim; the card is the record. A claimed note whose
card does not carry it is a work-product defect: the sweep's existing
two-attempt loop re-briefs the seat with the defect, and a second miss records
the sweep as failed. It never touches the ship, which is already merged.

### Deliberate redundancy

The sweep classifies, and the build-time classifier classifies again when the
later card is built. That is not duplication by accident. The note is evidence;
the build-time classifier is the decision. A note that was never written, or
one that a card edit made stale, degrades the later run to plain ADR-0044
behavior. It never degrades it to a park.

## Why not the alternatives

**Keep planting open decisions and make readiness smarter.** Readiness would
have to read a sentence written for a human and decide whether it is a question.
That is the classification this decision moves to the sweep, where the run that
found the collision still holds the spec, the diff and the frozen suite.

**Batch the sweep's questions and ask the owner once a day.** The owner is still
in a loop that is arithmetic between two documents. Cheaper symptom, same
default.

**Ask nothing and let every collision be settled at build time.** A card that
genuinely leaves the choice open would then be settled by a seat that has no
authority to settle it. The park exists for exactly that case, and it stays.

**Park the shipping run instead of the card.** The story is merged. Holding it
open for a question about a different card would make a shipped run wait on a
human for work it already finished.

## Fallback paths

**The classification duty.** The sweep's report fields (`foreseen`,
`decisions`) are both optional, and the role lines that ask for them are one
block in one role. Removing the block returns the sweep to the shape it had:
edges, sources and invalidations only. Trigger: sweeps that classify badly
enough that the notes mislead the build-time classifier more often than they
help it, measured by the supersede count of ADR-0044. Reversal cost: one block
in one role; no reader loses a field, because absent already reads as "found
none".

**The note as card text.** The heading and the marker are two constants in the
card parser. A project whose card lint refuses the section, or whose cards grow
unreadable, changes the constants or drops the block, and the build-time
classifier falls back to reading the card's own criteria. Trigger: a card whose
foreseen history is longer than its intent. Reversal cost: two constants.

**The decisions-section filter.** The parser drops marker-carrying items from
the open-decisions set. If a project ever wants a note in that section to park
after all, the filter is one call. Trigger: a project that writes the marker in
questions it means to be asked. Reversal cost: one call, and the heading keeps
working on its own.

**The card-decision park.** It is one park type and one loop in the sweep.
Removing it returns those collisions to the old route, which was a planted open
decision on the card, with the launch-time park that comes with it. Trigger: a
window where close-out questions arrive faster than the owner answers them and
the cards pile up parked. Reversal cost: one park type; answered parks stay
answered and the frontier reads the same set it always did.
