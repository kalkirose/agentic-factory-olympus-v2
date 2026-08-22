# ADR-0020: Spec-gate convergence — a scoped re-check and an identity-keyed progress rule

Status: accepted (2026-08-14)

## Decision

A spec-gate round past the first is a re-check of what moved, and the gate
holds itself to progress the way the repair ladder does.

- **The re-check is scoped, and the scope is computed.** Every counted round
  copies the spec it judges to `runs/<runId>/spec-round-<n>.md` before its seat
  spawns. Round *n+1* diffs that copy against the spec as it stands and names
  the parts whose text moved: one part per acceptance-criterion section
  (ADR-0019 gives the spec one section per card criterion), plus the
  touched-paths block and the environment section as parts of their own. Blank
  lines and trailing whitespace are not a move. A part only one version carries
  counts as moved. The list travels in the seat's role block. Round 1, and any
  round whose predecessor left no copy, reviews the whole spec.
- **The amendment's own account of its scope is not the scope.** The amending
  seat still reports `amendedSections` for the run record, and the gate
  ignores it. A declaration that understates the edit would narrow a re-check
  to less than what changed, which is the one failure the scope must not have.
- **The previous round's findings travel verbatim.** Section, severity,
  finding and evidence, as reported. The re-check answers each one closed or
  still open, and a still-open finding keeps the severity it carried.
- **A new defect in an unamended section is a note.** The role block states
  it: that text was read and passed a round ago, so re-opening it is not a
  finding the spec must answer before the suite exists. The one exception is
  blocking wherever it is found — a clause that contradicts a higher authority
  (the constitution, then the intent card, ADR-0018), with the contradicted
  document named in the evidence.
- **Every counted round past the first must close a blocking finding the round
  before it raised.** The comparison is between the two rounds' blocking sets
  by identity, and a round that closes none of the previous round's findings
  parks the run at once, before the cap is consulted and without spending what
  the cap has left. Zero blocking findings passes the gate exactly as before.
- **A gate finding's identity is its section and the defect it states,
  digested as written.** The round stamp carries the set, so the next round's
  rule reads the ledger and a restart mid-gate reaches the same verdict. Only
  case and whitespace are normalized away: the previous round's findings travel
  verbatim, so a defect that is still open comes back in the text that raised
  it, and two defects that differ by a numeral are two defects. A round stamped
  before the identities were recorded judges nothing, and the gate spends its
  cap as it did before the rule existed.
- **The comparison reads blocking gate findings and nothing else.** Notes are
  outside it: they do not hold the spec, and they travel to the suite seat as
  proof obligations. Spec-lint failures are outside it: a template defect
  routes through the lane's contract loop and never stamps a round
  (ADR-0019). An intent conflict is outside it: it stamps no round, its
  findings ride into the amendment beside the answer, and the counted ladder
  resumes with its budget intact (ADR-0006).
- **Non-convergence is its own park type: `spec-gate-stalled`.** It offers
  what the exhaustion park offers — `round` buys exactly one amendment plus
  one re-check, `abandon` closes the run `failed` on the park's own reason —
  and a `round` answered at either park counts the same in the gate's round
  accounting. The question names both counts and the round each came from, so
  the answer needs nothing else.

## Why the type, and not a reason field

`reason` on a park is already load-bearing and already spoken for. A
recoverable failure carries the close it would have taken in that field, and
the abandon route reads it back when the human answers (ADR-0015). Decision
parks — open decisions, grounding conflict, intent conflict, unkilled-gap
survivor, second zero kill — name their condition in the type instead, and
carry no reason at all. Non-convergence is a decision park, so it takes a
type. The catalog stays closed, and one park type keeps meaning one condition.

## Why a scoped re-check, and why a shrink rule under it

The gate was measured across real runs. One run reported 6, 8, 4 and 5
findings on successive rounds; another reported 4, 2, 1, 2 and 0. Two runs
needed five rounds each, and the round-cap park was answered "buy another
round" within a minute six separate times.

The shape of those numbers is the diagnosis. A gate that converges produces a
falling sequence, because each round closes findings and opens none. These
sequences do not fall, and the reason is mechanical rather than a matter of
judgment: an amendment rewrites spec text to close a finding, and a full
re-review reads the rewritten text as surface it has never seen. Every round
therefore manufactured its own next round's work. The seat was not wrong to
report what it found — it was asked to review a document, and the document was
different every time.

Two changes follow from that, and they only work together. Scoping the
re-check stops new surface from entering: the parts that moved get a full
re-check, everything else was already passed, and a defect found there is
recorded as a note rather than allowed to hold the spec. Computing the scope
mechanically is what makes the scope trustworthy — a seat that under-reports
its own edit would otherwise hand the next round a blind spot, and the
template already gives the document a shape a machine can diff. The authority
exception is the one case worth re-opening settled text for: a clause that
contradicts the constitution or the card is not a matter of gate opinion, and
the run must not ship it whatever round found it.

The progress rule is what makes the failure visible instead of expensive. The
repair ladder has held the same rule since ADR-0007: a round that closes
nothing is not progress, and more rounds of the same thing are not the answer.
The spec gate had a cap but no progress rule, so it could only fail by running
out — and the owner, seeing a park that said nothing except "the rounds are
spent", bought more rounds. A park that says the amendment closed nothing is a
different question, and it is the question the owner was never asked.

What the rule may not do is park a gate that is working, and the count did
exactly that. A count cannot tell three findings closed and three found from
three findings reported twice; it calls both of them a stall. Two runs in one
week were parked while converging on a document that was moving under them,
argued past by hand, and passed the round the argument bought. So the
comparison reads identities. Three against three with one survivor is a round
that closed two, and the gate carries on to its cap. Three against the same
three is a round nobody needed, and it parks with the cap unspent. The same
keying answers the same question one stage later, where a verdict cycle that
repeats itself parks a run (ADR-0022): one harness, one answer to "has
anything moved".

Stopping short of the cap is deliberate. A cap answers "how much is this worth
spending"; a progress rule answers "is spending it going to work". When the
second answer is no, the first one stops being relevant, so the remaining
rounds go unspent and the decision goes to the owner immediately.

## Fallback paths

If scoping proves to hide real defects — a spec whose amendment in one section
invalidates a claim in another — the scope grows a dependency rule: a section
that names a constant or a test file another section names is re-checked with
it. Trigger: one run where a blocking defect reached the suite in a section
the gate had scoped out, traceable to a change elsewhere. Reversal cost: low,
the diff already parses the structured entries the rule would key on.

If the identity rule still parks runs that were about to converge — a round
that closes nothing while the amendment moved real text — the comparison
relaxes to a weighted one, where a finding closed counts against a finding
opened and only a net non-improvement parks. Trigger: two parks a human
answers "round" where the bought round then passes. Reversal cost: low, one
comparison changes and the park question follows it.

If the identity proves too easy to slip — a gate that re-words a finding it
never closed, so a stuck round reads as progress — the identity drops the
prose for the section and the structured entry the finding names, and the
words become evidence rather than identity. Trigger: one park the cap raised
where the rounds behind it reported the same defect in different words.
Reversal cost: low, one function in `src/ledger/acks.mjs` and the round stamp
that carries what it returns.

If the note channel becomes the route around the gate — unamended-section
defects piling into notes the suite cannot prove — the note severity for an
unamended section gains a cap, and a re-check past it parks for a human
instead. Trigger: one suite seat reporting more than a handful of notes as
unprovable. Reversal cost: low, one count and one park question.
