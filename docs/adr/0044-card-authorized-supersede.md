# ADR-0044: The card authorizes a supersede

Status: accepted (2026-08-28)

## The condition

A story that extends a surface an earlier story pinned collides with the frozen
suite by construction. The story's criterion needs a second export; a frozen
test says the export set is closed; no implementation satisfies both. Until now
every one of those collisions was an intent question. The run found it at the
spec gate or in verdict triage, parked `intent-conflict`, and waited for a
human.

The price was paid twice over, and one run paid all of it. The collision was
found. It was ruled. The ruling was re-delivered after a daemon restart, carried
into the frozen suite through the re-freeze route, and then the run was killed
— and the ruling died with it, because an answer binds the run it was given to.
The next launch would have asked the same question about the same two documents.
The obvious repair, surfacing dropped rulings for re-approval, is not a repair:
it still asks a human to approve, once per run, what the story's own card
already sanctioned.

The defect is not the park. The defect is the default. The gate treats EVERY
frozen-surface collision as an intent question, and most of them are not. A card
that says in its scope boundary "this story extends the export set an earlier
story closed" has already ruled on the collision. Whether the card covers it is
arithmetic between two documents the harness is already holding, and arithmetic
is not the owner's job.

## Decision

**A collision the card's scope covers is an authorized supersede. Park only
when the card is silent.**

An authorized supersede takes no park. The run amends the frozen test through
the re-freeze route a human ruling already travels, and it records what it did:
the amended test, the assertion that changed, and a verbatim quote of the card
line the authorization rests on. Recorded, auditable, never asked.

A collision the card's scope does not cover is a genuine intent gap. That park
is legitimate and it is rare, and its answer flow is unchanged.

Because authorization derives from the card, it is re-derivable in every run.
Nothing has to survive a dead run, because nothing needs to: the source document
outlives every run by design. The owner's touch moves to card-authoring time,
once, where intent is written — never to run time.

### Where the classification happens

Both sites that find a frozen-surface collision gain the same step, and it is
the seat that already reads the two documents that takes it.

- **The spec gate**, before the suite is frozen, against the pin an earlier
  story left in the repository. A covered collision runs one spec amendment on
  the card's own words and burns no counted round, exactly as an answered
  ruling's amendment does.
- **The verdict ladder**, on an intent-depth suite defect. A covered collision
  becomes the ruling the re-freeze carries.

The claim is four facts in the seat's report: the frozen test, the assertion
that changes, the card line quoted, and which section it came from
(`scope-boundary` or `decisions`). There is no `covered` boolean beside them.
The dangerous direction here is the one that skips the owner, so the claim is
the four facts or it is nothing: a report that names none of them has said the
card is silent, and silence parks. A boolean would be a fifth thing that can
disagree with the other four.

### The ruling, and why it is not a new route

The re-freeze route was built to carry one ruling into the frozen suite. It
reads that ruling off an event seq, an actor, and a sentence naming the files;
the `re-freeze` stamp records which ruling it carried, and that record is what
makes the ruling spent — one ruling, one amendment.

A card citation is a second source of exactly that, so it travels the same
route rather than a parallel one. The authorization stamp is the seq, `card` is
the actor, and the sentence names the tests and quotes the card. `source: 'card'`
on the `re-freeze` stamp is what tells the two apart; a record written before
this decision carries no `source` and reads as a human answer, which is what it
was.

### The honesty guards

Classification is a judgment by a reasoning seat, and the failure mode is a seat
stretching a scope line to dodge a park. Four containments, all of them existing
machinery.

1. **The record must quote the card, and the quote is checked.** The quoted line
   must appear in the card section the claim names, word for word. Only
   whitespace is normalized — a card wraps its prose over lines and a seat
   copies the sentence — and every other character has to be the character the
   card carries. A quote shorter than 24 characters is refused whatever it
   matches: a three-word fragment appears in every card ever written and
   authorizes nothing. The check runs at the one site the event is appended
   from, so no call site can stamp an authorization it did not earn.
2. **A judgment seat reads the amendment nobody was asked about.** The quote
   check proves the words are in the card. Whether the words REACH the assertion
   that changed is a judgment, and the panel's spec lens is the reader that
   makes it. A re-freeze behind a human ruling was judged by the human who
   ruled; a re-freeze on the card's authority was judged by nobody, so the cycle
   behind it reviews that amendment's own diff, with the executed supersedes and
   the verification duty in the brief. One seat, only where nobody was asked. A
   stretched authorization is a HIGH on the spec lens, and confirm-to-block
   (ADR-0038) does the rest.
3. **The count is a metric.** Every authorization is one stamp. The eval review
   counts them per run across its window, because a run far above the rest of
   the window, or a window whose count keeps climbing, is a classifier
   stretching scope rather than a set of cards that got broader.
4. **The claim must name a test the run actually froze**, and a claim about a
   test the check cannot read is refused. The safe direction is always the park:
   a claim this machinery cannot check is a claim it does not take.

### The owner pin

A test may pin itself to the owner: one marker, `olympus:owner-pinned`, placed
by hand in the test file. A legal gate, a money path, anything whose change is
the owner's call and no seat's. An owner-pinned collision ALWAYS parks, card or
no card.

The pin lives in the test file because that is what outlives the run, and the
freeze writes down which frozen files carried it, so the answer is fixed where
the frozen set is fixed. A file the check cannot read counts as pinned: the pin
exists to stop a machine deciding, and a check that cannot see the file has not
seen that it may decide.

The default is card-decides. The pin is the exception, and it has to be placed
deliberately.

### Where the record lives

Three places, each for as long as it is worth keeping.

- The **run ledger** holds every `supersede-authorized` stamp: the site, the
  finding, the test, the assertion, the quote, the clause, the card.
- The **verdict record** carries them beside the findings, so a reviewer reads
  the record and the card side by side.
- The **card** is the durable home. The ship-time close-out sweep appends every
  executed supersede to the story's own card under a `## Supersedes` heading —
  the sweep is the one mechanism already allowed to write a card on the default
  branch, and the card is what the next story reads.

### What does not change

The `intent-conflict` park stays in the catalog and keeps its answer flow. It
fires on silence, on an owner pin, and on every refusal above. The park question
now names which check refused, so the owner reading the escalation can go and
look at the same two documents.

## Why not the alternatives

**Surface dropped rulings for re-approval.** It still asks a human, once per
run, to approve what the card already sanctioned. It makes the symptom cheaper
and leaves the default wrong.

**Persist the ruling across runs.** A ruling stored outside a run is a second
authority that has to be kept true as cards change, and it answers a question
the card can answer for itself. Authorization derived from the card is
re-derivable, which is strictly better than durable.

**Formalize what a test pins first, then compute coverage.** A declaration
schema would sharpen `covered` and `silent` from prose reading toward
arithmetic, and it is worth having. It is not worth waiting for: this decision
is run-time-first and nothing in it blocks on a schema landing later. When one
does, the classifier reads it instead of the prose and every other part of this
stands.

**Let the seat decide with a boolean and no quote.** A field whose only proof is
the seat's own word is a field the seat can always say yes in. The quote is what
makes the claim checkable at all.

## Fallback paths

**The whole decision.** `lanes.story.cardAuthorizedSupersede: false` in the
project config returns the lane to the old default: every frozen-surface
collision parks `intent-conflict`, the classification duty leaves the seat
briefs, and no authorization is stamped. Trigger: a project whose cards do not
carry real scope sections, or a window whose supersede count says the classifier
cannot be trusted on this repository. Reversal cost: one config key; no record
shape changes, because every field this decision adds is additive and absent
reads as "nothing known".

**The quote rule.** `MIN_QUOTE_CHARS` is one constant and the normalization is
one expression. If verbatim proves too strict for how a project's cards are
written — a card that carries the same sentence in two spellings — the
normalization widens or the length moves, in one place, and the park stays the
answer for everything the check still refuses. Trigger: refusals on quotes a
human reads as correct. Reversal cost: one constant.

**The judgment seat behind a card-authorized amendment.** The extra review is
one branch in the cycle. Removing it returns the run to the shape it had, with
the quote check and the eval-review count as the remaining guards. Trigger: a
window where that seat confirms nothing across many supersedes and the seat is
not paying for itself, on the evidence a cut-candidate proposal is made from
(ADR-0038). Reversal cost: one branch.

**The owner pin.** The marker is one string. A project that wants a different
word, or a pin expressed some other way, changes the constant and the freeze
records whatever the new rule finds. Trigger: a marker that collides with
something a project already writes in its tests. Reversal cost: one constant.

**The card as the durable home.** The sweep instruction is one block in the
sweep's role. If cards prove to be the wrong home — a card lint that refuses the
section, or a card that grows unreadable — the block comes out and the run
ledger and verdict record stay the record they already are. Trigger: a card
whose supersede history is longer than its intent. Reversal cost: one block in
one role, and no reader loses a field.
