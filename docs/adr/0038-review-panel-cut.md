# ADR-0038: The judgment panel is a configured lens set

Status: accepted (2026-08-26, the record seat 2026-09-07)

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
- **The record criteria sit beside the code lenses and outside the panel.** The
  same registry holds `record` and its criteria, `RECORD_CRITERIA`: a keyed list
  of three, data only. `truth` holds every present-tense claim of the record
  against the tree as it stands: a part the tree does not hold is stated as not
  built, a divergence between the tree and the decision is named in the record,
  and every name the record cites means what the record says it means.
  `consistent` holds an open part of the record against the open parts of the
  active records beside it. `form` is a defect of the project standard the
  project's form gate cannot read, by rule number. The list is the harness's own
  and holds no project rule.
- **Three, because a criterion nobody can decide is a criterion nobody can
  answer.** The keys that left were readings of one question. A part not built,
  a divergence absorbed and a name that means something else are three ways for
  a present-tense claim to be untrue, and `truth` states all three; a record
  that reads as a trail of amendments and a record whose implemented parts do
  not read as fact are form, and the project's gate reads the form it can read
  (ADR-0080). A finding whose criterion a seat had to choose between two near
  keys named the same defect twice.
- **The criteria carry the rule they serve.** `RECORD_RULE` sits above them
  wherever they are stated: a record never conflicts with the code, everything
  it states is either true of the tree now or marked as not yet built, there
  is no third kind of claim, and a sentence that states why, or what was
  rejected, or what would trigger a reversal, is rationale and is neither. A
  claim the tree contradicts fails `truth`, whether or not the sentence changed
  in the diff under review.
- **The second criterion is about two records.** `consistent` asks whether an
  open part of this record contradicts an open part of an active record in its
  neighbourhood. The tree settles what is built and settles nothing about what is
  not, so two active records can decide one unbuilt part two ways and no code
  reading finds it. A `consistent` finding therefore carries a second place,
  `file2`, `unit2` and `head2`, and a finding that names one record is a
  work-product defect rather than a finding.
- **One definition of the criteria, four readers.** The record review seat's
  brief, the verifier's brief for a record item of a code round, and the birth,
  reconciliation and corrective briefs of the seats that write records all state
  the list from the registry. A writer is a reader because it is judged against
  it: a paraphrase in the brief that writes the records and the list in the brief
  that reviews them are two statements of one rule, and the writer would meet a
  criterion at the review that its own brief never named.
- **A record is judged by a seat of its own, and never by a lens.** `record` is
  outside `ALL_LENSES`, so `review.lenses` cannot name it and the project-config
  validator refuses it there. `furyPanel` never seats it. What reads a record is
  `recordReviewRound`, one `record-review:<n>` seat per record file, and the code
  lenses hold no record path at all: `furyRound` drops them from its fan-out and
  the verdict drops them from the file list it hands over (ADR-0026). The lens
  name survives as the word a record finding carries into the ledger, so a
  reading that counts by lens still tells the two populations apart.
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
  authorization on every entry point, input trust, secrets and trust boundaries
  beside the behavior the spec states.
- **One definition of the dimensions, six readers.** The list lives in the lens
  registry and imports nothing. The lens criteria read it for the verdict panel.
  The wave brief reads it for the adversary. The suite brief and the re-freeze
  brief read it for the surface map every suite write owes, and the
  deterministic check over that map reads it again in each of the two lanes that
  hold a suite write (ADR-0072). Six readers of one list, so no surface can
  narrow what another one still probes. The list is not project config: a
  project that drops the security lens from its panel still gets the dimensions
  in its waves and in its maps.

The default panel is three seats where it was five. Two rounds spawn seats in
parallel: this fan-out, and the record review's one seat per record.

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

The suite side has a second half. A survivor names one member of a set, and a
seat that closes the member and never lists the set makes the adversary an
enumeration device, at a full round per member. So every suite write also maps
the story's own surface along the same four dimensions, and the map is checked
before the write commits (ADR-0072). The wave stays the measure of whether the
map is the surface, and it is never shown the map.

## Why the record criteria are not on the panel

The panel is what a project judges its code with, and a project restores a cut
lens by naming it. The record criteria are neither of those. They judge a
document against the tree the document describes, and which reviews carry them is
not a project's decision: the reconcile stage carries them and nothing else does.

They also seat for the opposite reason security folds. A code lens shares a seat
because the seats read one diff. A record seat reads one document whole, with the
harness's enumeration of it and a neighbourhood beside it, and one seat over four
records samples them (ADR-0073). So the record review pays a seat per record and
the panel pays a seat per group of lenses.

Keeping `record` out of `ALL_LENSES` also keeps two readings honest. The
lens-yield metric zero-fills every lens in that list and counts confirmations,
and a name that is always excluded from the count would read as a permanent cut
candidate. Record findings have their own reading (ADR-0010).

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

If the record criteria prove too narrow, and real record defects fall outside all
three, a criterion joins `RECORD_CRITERIA` with its line. The key is what a
reader judges a finding against, so a defect nobody can key is a defect nobody
can weigh. Trigger: findings a reader agrees with that name no key. Reversal
cost: one entry in the registry; the schema enum and every brief read the list.

If the seat per record proves too expensive on a wide reconciliation, the round
batches: one seat over several records, with the addresses of all of them.
Trigger: a stage whose review seats cost more than the ship they hold.
Reversal cost: moderate, one loop in `recordReviewRound`.

If the security dimensions crowd the adversary's spec-behavior probing instead
of adding to it — kill rates fall while survivors cluster on security wrongness
the spec never named — move them to a dedicated wave: the wave loop already
runs `lanes.story.adversaryWaves` per round, so the change is which brief wave
1 gets. Trigger: two consecutive freezes whose survivors are all security-shaped
and declared spec-indifferent. A freeze whose survivors were all closed by
tests does not meet it: those survivors were spec-relevant, and they were real
gaps in the suite. Reversal cost: moderate, one branch in the wave loop.
