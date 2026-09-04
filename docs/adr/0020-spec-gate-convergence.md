# ADR-0020: Spec-gate convergence — a scoped re-check, a progress rule, and no round cap

Status: accepted (2026-09-04)

## Decision

A spec-gate round past the first is a re-check of what moved. The gate runs for
as long as it is getting closer to a spec that passes, and it parks when it
stops getting closer. It has no round cap.

- **The re-check is scoped, and the scope is computed.** Every round copies the
  spec it judges to `runs/<runId>/spec-round-<n>.md` before its seat spawns.
  Round *n+1* diffs that copy against the spec as it stands and names the parts
  whose text moved: one part per acceptance-criterion section (ADR-0019 gives
  the spec one section per card criterion), plus the touched-paths block and
  the environment section as parts of their own. Blank lines and trailing
  whitespace are not a move. A part only one version carries counts as moved.
  The list travels in the seat's role block. Round 1, and any round whose
  predecessor left no copy, reviews the whole spec.
- **The amendment's own account of its scope is not the scope.** The amending
  seat still reports `amendedSections` for the run record, and the gate ignores
  it. A declaration that understates the edit would narrow a re-check to less
  than what changed, which is the one failure the scope must not have.
- **The previous round's findings travel verbatim.** Section, severity, finding
  and evidence, as reported. The re-check answers each one closed or still
  open, and a still-open finding keeps the severity it carried.
- **A new defect in an unamended section is a note.** The role block states it:
  that text was read and passed a round ago, so re-opening it is not a finding
  the spec must answer before the suite exists. The one exception is blocking
  wherever it is found — a clause that contradicts a higher authority (the
  constitution, then the intent card, ADR-0018), with the contradicted document
  named in the evidence.
- **Two conditions stop the gate, and either one parks it.**
  - *Identity.* A round that closed none of the blocking findings the round
    before it raised. The comparison is between the two rounds' blocking sets
    by identity, never by count.
  - *Count over two rounds.* A round whose blocking count is not below the
    count of the round two back.

  Zero blocking findings passes the gate exactly as before.
- **A gate finding's identity is its section and the defect it states,
  digested as written.** The round stamp carries the set, so the next round's
  rule reads the ledger and a restart mid-gate reaches the same verdict. Only
  case and whitespace are normalized away: the previous round's findings travel
  verbatim, so a defect that is still open comes back in the text that raised
  it, and two defects that differ by a numeral are two defects. A round stamped
  before the identities were recorded judges nothing under the identity rule,
  and the count rule still reads it.
- **The comparison reads blocking gate findings and nothing else.** Notes are
  outside it: they do not hold the spec, and they travel to the suite seat as
  proof obligations. Spec-lint failures are outside it: a template defect
  routes through the lane's contract loop and never stamps a round (ADR-0019).
  An intent conflict is outside it: it stamps no round, its findings ride into
  the amendment beside the answer, and the ladder resumes (ADR-0006).
- **`spec-gate-stalled` is the one gate park.** It offers `round`, which buys
  exactly one amendment plus one re-check, and `abandon`, which closes the run
  `failed` on the park's own reason. The question names both counts and the
  round each came from, so the answer needs nothing else. The park is keyed on
  the round that raised it: a bought round is spent, and the next park asks
  again rather than reading the answer that bought it.
- **The cost informs and stops nothing.** The budget-breach record (ADR-0021)
  is the cost signal for a gate that spends many rounds, and the gate-rounds
  reading is where a gate that is habitually long shows up.

## Why the type, and not a reason field

`reason` on a park is already load-bearing and already spoken for. A
recoverable failure carries the close it would have taken in that field, and
the abandon route reads it back when the human answers (ADR-0015). Decision
parks — open decisions, grounding conflict, intent conflict, unkilled-gap
survivor, second zero kill — name their condition in the type instead, and
carry no reason at all. Non-convergence is a decision park, so it takes a type.
The catalog stays closed, and one park type keeps meaning one condition.

## Why a scoped re-check

The gate was measured across real runs. One run reported 6, 8, 4 and 5 findings
on successive rounds; another reported 4, 2, 1, 2 and 0.

The shape of those numbers is the diagnosis. A gate that converges produces a
falling sequence, because each round closes findings and opens none. These
sequences do not fall, and the reason is mechanical rather than a matter of
judgment: an amendment rewrites spec text to close a finding, and a full
re-review reads the rewritten text as surface it has never seen. Every round
therefore manufactured its own next round's work. The seat was not wrong to
report what it found — it was asked to review a document, and the document was
different every time.

Scoping the re-check stops new surface from entering: the parts that moved get
a full re-check, everything else was already passed, and a defect found there
is recorded as a note rather than allowed to hold the spec. Computing the scope
mechanically is what makes the scope trustworthy — a seat that under-reports
its own edit would otherwise hand the next round a blind spot, and the template
already gives the document a shape a machine can diff. The authority exception
is the one case worth re-opening settled text for: a clause that contradicts
the constitution or the card is not a matter of gate opinion, and the run must
not ship it whatever round found it.

## Why two progress conditions, and why no cap

The progress rule is what makes the failure visible instead of expensive. The
repair ladder has held the same rule since ADR-0007: a round that closes
nothing is not progress, and more rounds of the same thing are not the answer.

Identity is what makes the rule honest. A count cannot tell three findings
closed and three found from three findings reported twice; it calls both of
them a stall. Two runs in one week were parked while converging on a document
that was moving under them, argued past by hand, and passed the round the
argument bought. Three against three with one survivor is a round that closed
two. Three against the same three is a round nobody needed. The same keying
answers the same question one stage later, where a verdict cycle that repeats
itself parks a run (ADR-0022): one harness, one answer to "has anything moved".

Identity alone is not enough, and the count over two rounds is why. A gate that
closes one finding and opens one every round passes the identity rule for ever.
Over two rounds a gate that is working produces a lower count, because that is
what closing findings does; a gate trading one for one does not. Two rounds and
not one, because closing two and opening two inside a single round is a
document moving under a gate that is working, and the round after it says
which.

The cap is gone because the ledger says it was never the mechanism. Eleven
gates reached the cap of two counted rounds or the stall park. Ten of them
passed once the owner bought the rounds — at rounds three, four and five — and
the answer at the park was `round` fourteen times in fifteen, given within one
to four minutes. A cap answers "how much is this worth spending"; a progress
rule answers "is spending it going to work". The second question is the one the
gate can decide, and the ledger shows the first one being answered the same way
every time by a person reading a park that said nothing except "the rounds are
spent". The owner's standing rule is that a budget informs and never stops, and
a cap that parks is a budget that stops.

## Fallback paths

If scoping proves to hide real defects — a spec whose amendment in one section
invalidates a claim in another — the scope grows a dependency rule: a section
that names a constant or a test file another section names is re-checked with
it. Trigger: one run where a blocking defect reached the suite in a section the
gate had scoped out, traceable to a change elsewhere. Reversal cost: low, the
diff already parses the structured entries the rule would key on.

If the two conditions still park gates that were about to converge, the
identity comparison relaxes to a weighted one, where a finding closed counts
against a finding opened and only a net non-improvement parks, and the count
condition widens from two rounds to three. Trigger: two parks a human answers
`round` where the bought round then passes. Reversal cost: low, one comparison
and one index, and the park question follows them.

If no cap proves too expensive — a gate that closes one finding a round for
eight rounds on a spec nobody would have bought eight rounds for — the fallback
is not the cap but the reading: the gate-rounds window over recent freezes,
with a band, so a gate that is habitually long is a proposal about the spec
template rather than a park in the middle of one run. Trigger: a median round
count above five over ten freezes. Reversal cost: none here; the reading is a
tripwire entry.

If the identity proves too easy to slip — a gate that re-words a finding it
never closed, so a stuck round reads as progress — the identity drops the prose
for the section and the structured entry the finding names, and the words
become evidence rather than identity. The count condition already bounds that
case at two rounds. Trigger: one park whose rounds reported the same defect in
different words. Reversal cost: low, one function in `src/ledger/acks.mjs` and
the round stamp that carries what it returns.

If the note channel becomes the route around the gate — unamended-section
defects piling into notes the suite cannot prove — the note severity for an
unamended section gains a cap, and a re-check past it parks for a human
instead. Trigger: one suite seat reporting more than a handful of notes as
unprovable. Reversal cost: low, one count and one park question.
