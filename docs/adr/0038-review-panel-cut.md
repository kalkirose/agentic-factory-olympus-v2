# ADR-0038: The judgment panel is a configured lens set

Status: accepted (2026-08-26)

## Decision

The lenses the judgment review carries are project config, and the default set
is smaller than the vocabulary.

- **A closed lens vocabulary, in one registry.** `src/lanes/lenses.mjs` holds
  every lens the review implements (`spec`, `architecture`, `minimality`,
  `operational`, `security`, `interface`), the criteria line each one states to
  a seat, the seat each one rides, and the default panel. It imports nothing:
  the review machinery builds the panel from it and the project-config
  validator refuses a lens name against it, and neither module imports the
  other.
- **The panel is `review.lenses`.** An absent entry takes the default panel. A
  declared entry replaces it — that is the whole flip. A name outside the
  vocabulary, a duplicate, or an empty list fails the launch; nothing is
  dropped quietly, because a dropped name shrinks the panel and a shrunk panel
  judges less while still saying green.
- **The default panel is spec, operational, security, interface.**
  Architecture and minimality are out of it. Across ten ships those two lenses
  raised 82 findings and the verifier confirmed none of them.
- **A seat spawns only for the lenses the panel kept.** `fury-code-shape`
  carries architecture and minimality, so the default panel spawns no
  code-shape seat at all; the seat definition, its model, its effort and its
  prompt policy stay exactly as they were. A panel that names one of its two
  lenses spawns it for that lens alone.
- **Security has no seat of its own; it rides `fury-operational`.** One
  confirmed HIGH across the same ten ships does not pay for a seat. The lens
  itself stays on the panel, on a seat that always runs.
- **The adversary waves carry the security dimensions.** The wave brief names
  authorization on every entry point, input trust, secrets and trust
  boundaries beside the behavior the spec states. The dimensions are one list
  in the registry, read by the lens criteria and by the wave brief, so the two
  surfaces cannot drift.

The default panel is three seats where it was five, and the fan-out is the
only place in a run where seats spawn in parallel.

## Why the two lenses go and security stays

The two decisions read alike and are not alike, and the difference is what a
lens does when it is right.

An architecture or a minimality finding is an opinion about shape. Ten ships of
evidence say the verifier refuses every one of them against the code: 82 raised,
0 confirmed. A lens with no confirmations blocks nothing, so its whole output is
advisory material — and advisory material is exactly what the run gets for free
from the seats that stayed. The panel paid two seats a pass for it.

A security finding is a claim about behavior, and the same window holds one
confirmed HIGH from it. One confirmation is not a rate that justifies a seat.
It is proof that the lens can block, and a lens that can block is not the same
object as a lens that cannot. So the lens survives the cut and the seat does
not.

## Why the fold keeps a route to a block

Adversary waves test the suite. A wave writes a wrong implementation, the
frozen suite either kills it or does not, and a survivor buys a killing test.
Nothing in that loop looks at the candidate. A design that moved security
probing into the waves and took the lens off the panel would leave a security
defect in the shipped diff with no reader at all, and the one confirmed HIGH of
the window is the evidence that such a defect happens.

So the fold is two-sided, and each side answers a different failure.

- **On the candidate**: the security lens rides `fury-operational`, an
  always-on seat. A HIGH under it goes to the verifier like any other HIGH, and
  a confirmed HIGH enters `verdict-rendered.open`, turns the verdict red and
  takes the code arm of the ladder. The route a security defect needs to stop
  a ship is the route it always had, minus the seat.
- **On the suite**: the wave brief names the dimensions, so a suite that
  asserts nothing about authorization shows a survivor. The amendment round
  turns that survivor into a frozen test, and every candidate after it is
  judged by that test at Tier-1.

The first side blocks this ship. The second side makes the next one cheaper.

## Why config and not a code deletion

A cut with no way back is a bet that ten ships of evidence generalize. They may
not: the ten ships are one project, one language and one team's code. Reading
the panel out of project config makes the cut a per-project statement and makes
restoring it a one-line edit that ships through the same PR path as the code it
judges. The seat definitions stay in the map for the same reason — a restored
lens needs a seat to ride, and a seat map entry costs nothing to keep.

## Fallback paths

If a defect escapes to production and its fix is architectural or a
duplication, restore the two lenses: `review.lenses` names all six, the
code-shape seat returns with both, and the panel is what it was. Trigger: an
escapes-ledger entry whose fix ref names a structural change, inside the watch
window. Reversal cost: one config line, at the next launch.

If the folded security lens under-reports — the operational seat's own findings
crowd it out — split it back onto a seat of its own: one entry in the seat map,
one entry in the lens registry's seat table, one line in the prompt seat sets.
Trigger: a confirmed security HIGH found by the adversary waves or after a ship,
that the operational seat saw the diff for and did not raise. Reversal cost:
low, and the panel config does not change.

If the security dimensions crowd the adversary's spec-behavior probing instead
of adding to it — kill rates fall while survivors cluster on security wrongness
the spec never named — move them to a dedicated wave: the wave loop already
runs `lanes.story.adversaryWaves` per round, so the change is which brief wave
1 gets. Trigger: two consecutive freezes whose survivors are all security-shaped
and spec-indifferent. Reversal cost: moderate, one branch in the wave loop.
