# ADR-0053: Covered is a test of necessity, not of naming

Status: accepted (2026-08-30)

## The condition

A card authorizes a supersede when its scope covers a frozen-surface collision
(ADR-0044). The classification brief asked the seat one question: does the
card's scope cover this collision? Seats read that as "does the card name this
surface", and answered no whenever the card did not mention the test.

A card never mentions a test. A card states what the story must do. It says
"send a confirmation when the order is placed"; it does not say "the test that
counts the messages this flow sends will have to count one more". So a card
whose whole purpose was a new message read as SILENT about the test that
counted messages, the run parked, and the owner was asked a question the card
had already answered in its acceptance criteria.

Naming is the wrong question because it asks about the card's vocabulary. The
right question is about the card's consequences.

## Decision

**Covered means the card mandates a behavior whose implementation necessarily
changes what the pinned clause asserts, and the executed amendment must restate
the pin's protected guarantee in its new form.**

Two halves, and both are load-bearing.

The first half is a necessity test. A card that never names the test file still
covers the collision when no implementation of the mandated behavior can leave
the pinned assertion true. A card that DOES name the surface covers nothing when
the mandated behavior can be built with that assertion intact. The question is
answerable from the two documents the run already holds, which is what makes it
arithmetic rather than intent.

The second half is what stops a supersede from becoming a deletion. A pin
protects a guarantee: a set is closed, a count is exact, a path is the only one.
The mandate changes the FORM of that guarantee, never the fact that it is
guaranteed. A pin that asserted a closed set of two becomes a pin that asserts
the closed set of three the card mandates. An amendment that removes the
assertion has not superseded it, and the brief, the ruling and the review all
say so in the same words.

### Where the mandate is quoted from

A mandate lives in the acceptance criteria, so the authorization may rest on
that section as well as on the two that bound scope. The clause set becomes
`acceptance`, `scope-boundary`, `decisions` and `foreseen`.

`foreseen` is the fourth because a close-out sweep that already found this
collision wrote the mandating line onto the card as a foreseen-amendment note
(ADR-0052). The note is consumable evidence: it is the machine's own reading of
the card, quotable word for word like any other card line. It answers the
necessity test; it does not excuse it. A seat that finds a note still has to
decide that the mandate reaches the assertion in front of it.

### The honesty guards do not move

Widening what "covered" means widens what a stretched classification could
authorize, so nothing that contains it changes.

1. **The verbatim quote check.** The quoted line must appear in the card
   section the claim names, word for word, whitespace normalized and nothing
   else. The minimum quote length is unchanged. The check runs at the one site
   the authorization event is appended from.
2. **The adversarial review of every executed amendment.** The panel's spec lens
   reads the amendment nobody was asked about, with the executed supersedes in
   its brief. It now also fails an amendment that dropped the guarantee instead
   of restating it.
3. **The supersede count as an eval metric.** Every authorization is one stamp,
   counted per run across the eval window. A run far above the window, or a
   window whose count keeps climbing, is a classifier stretching scope.
4. **The owner pin.** A pinned test parks whatever the card says.

The claim is still the same four facts and still has no `covered` boolean: a
report that names no test, no assertion, no quote and no clause has said the
card is silent, and silence parks.

## Why not the alternatives

**Keep "does the card name this surface".** It is cheap to judge and wrong in
the common case. The cards it classifies correctly are the ones whose authors
happened to think about test files while writing intent.

**Ask the seat for a `covered` boolean and trust it.** A field whose only proof
is the seat's own word is a field the seat can always say yes in. The quote is
what makes the claim checkable at all.

**Declare, per test, what it pins, and compute coverage.** A declaration schema
would move this from prose reading toward arithmetic and is worth having. It is
not worth waiting for: when one lands, the classifier reads it instead of the
prose and every other part of this decision stands.

**Let the amendment delete the pin.** Then a supersede is indistinguishable
from a seat removing a test that was in its way, and the record of what was
protected is lost with the assertion.

## Fallback paths

**The whole decision.** `lanes.story.cardAuthorizedSupersede: false` still
returns the lane to the old default, where every frozen-surface collision parks.
Trigger: a window whose supersede count says the classifier cannot be trusted on
this repository. Reversal cost: one config key.

**The wider clause set.** `acceptance` and `foreseen` are two entries in one
frozen list and two patterns in one table. Dropping either narrows what a claim
may rest on and parks whatever it refuses, which is the safe direction. Trigger:
authorizations that quote a criterion whose mandate does not reach the change.
Reversal cost: one list entry and one pattern each; every other check is
untouched.

**The restatement duty.** It is one line in the classification brief, one line
in the ruling the re-freeze carries, and one line in the review's verification
duty. Removing them returns the amendment to "as far as the quoted card line
reaches and no further". Trigger: amendments that keep a guarantee the card
plainly retired, and reviews that block on it. Reversal cost: three lines, and
no record shape changes.

**The necessity wording.** The brief is a constant list. If seats read
"necessarily" as licence rather than as a bound, the wording tightens in one
place and every guard behind it is unchanged. Trigger: a rise in HIGH spec-lens
findings against card-authorized amendments. Reversal cost: one constant.
