# ADR-0086: The update stage's two questions are answered apart

Status: accepted (2026-09-12)

## Context

A run holds two certifications over two trees at two shas: the code verdict over
the code commit, and the reconciliation over the record commit. When the default
branch moves under a run at the ship seam, the update stage asks one question per
certification and routes on the answers, back to the verdict where the code
question re-opened and back to the reconciliation where the record question did
(ADR-0033, ADR-0075).

The two questions were asked apart and answered together. One helper copied every
refusal onto both answers, on the reasoning that a refusal is a fact about the
tree and a tree is one thing. Most refusals are exactly that. Two are not.

So a refusal that belonged to one certification sent the run back through the
other. A review finding on the code side bought a whole record cycle. A records
fact bought a code re-judgment. Each of those is a stage, a fan-out of seats and
a place for the base to move again while the run pays for a question nobody
asked.

## Decision

**A refusal is copied to both answers only where it names a fact both
certifications rest on. Where it belongs to one, the other answer is computed on
its own evidence.**

- **Two refusals belong to one side.** A review finding whose ground the incoming
  diff reached is a fact about the code certification, since a review reads code
  and the record certification rests on the record tree. A missing certification
  on the records side is a fact about the records, and it says nothing about
  whether the code still stands.
- **The other side is then settled, not copied.** The records answer comes from
  the run's own records and the records their neighbourhoods name, computed at the
  merge, and the code answer comes from the rest of the ladder. Both were already
  computed for their own sake; the change is that neither is overwritten by the
  other's word.
- **Every other refusal still copies.** A story diff that is not what it was, a
  project with no breadth ground, a change the harness cannot read as a file of
  this repository: each of those says the reading itself cannot be trusted, and a
  reading that cannot be trusted is untrustworthy for both.
- **A kept records answer states why it was kept.** The word is that no record the
  run rests on moved, and the update stamp carries it, so a reader of a half-carry
  sees which half stood and under which word rather than inferring it from what is
  absent.
- **A half-carry is not a taken fast path.** The flag that says the path was taken
  stays false unless both questions carried, and the measurement of what the path
  buys keeps counting whole carries. The stamp is where a half-carry is read,
  because a half-carry saved one certification and spent the other.
- **The routing is unchanged.** The stage takes the run to the verdict, to the
  reconciliation, or to the ship, on the two answers it holds. Where both
  refuse, the sentence a person reads is the code's, because that is the arm the
  run enters first.

## Consequences

A run whose lens finding was reached by the incoming diff re-judges its code and
keeps its records. A run whose record neighbourhood moved re-judges its records
and keeps its code. Each is one stage instead of two.

The two answers can disagree, which is a shape no reader of the stamp met before.
The reason field on each half is what makes the disagreement readable, and the
taken flag stays honest about what the path actually saved.

One of the two split refusals is defensive: the records-side missing
certification is unreachable from the ship's own path, because a lane with no
record certification leaves the fast path earlier. It stays in the split because
the alternative is a branch that reads as live and behaves differently from the
one beside it.

## Rejected options

- **Copy everything, as before.** That is the cost this removes, and the copy was
  never a claim about the trees: it was one helper filling two fields.
- **Copy nothing and let each side stand alone.** Most refusals name a defect in
  the reading rather than a fact about a tree. A reading that failed answers for
  neither side, and a side that carried on it would carry on nothing.
- **Make the records answer the code answer's default.** Then a lane with no
  records would read as a lane whose records carried, and the admission gate
  would be asking about a certification nobody holds.
- **Treat a half-carry as taken.** The measurement behind the path is what it
  buys against what it costs. A half-carry that counted as taken would read as a
  saving the run did not get.

## Fallback path

The alternative is the single answer again: one refusal, copied, and the run takes
both arms. The switch trigger is a ship that carried one certification over a base
that had in fact moved it, where the other certification's refusal would have
caught it. The reversal cost is one argument in the helper that fills the two
answers.

## References

- ADR-0026, ADR-0033, ADR-0056, ADR-0075, ADR-0085
- `src/lanes/fastpath.mjs`
- `src/lanes/ship.mjs`
- `src/lanes/reconcile.mjs`
