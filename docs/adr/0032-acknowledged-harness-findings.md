# ADR-0032: Acknowledged harness findings

Status: accepted (2026-08-15)

The provisioning gate asks the owner one question: the substrate this run
cannot touch is broken, so repair it and say so. It is the right question
about a broken host. It is the wrong question about a defect in the harness
itself, because the harness is not a substrate the operator can repair between
two cycles, and the answer does not change while the fix is being written.

## Decision

A harness finding can be acknowledged once. While the acknowledgment stands,
a gate whose findings are all acknowledged answers itself.

- **A finding has a fingerprint.** Its class, its summary and its evidence,
  normalized and digested: `harness:<12 hex>`. Normalization drops what the
  run contributed and keeps what the finding said. A path falls to its last
  segment, so the home, the worktree and the run id go. Digit runs and long
  hex runs become one character, so line numbers, exit codes, cycle numbers
  and shas go. Punctuation and case go. The per-run id (`F1`) names one run's
  bookkeeping; the fingerprint names the defect.
- **Only a harness finding may be acknowledged.** One function holds the
  class rule, and coverage is asked for through it, so no call site can reach
  coverage for a class an ack may not cover.
- **The gate offers the option only when it names one.** A provisioning gate
  with a harness finding declares `ack` beside `retry`, carries the
  fingerprints on the park record, and prints each one beside the finding it
  belongs to. A credential gate names no finding and offers nothing. This is
  the ADR-0029 contract: the record says what it takes back, and here it also
  says what the answer will record.
- **The first gate always reaches the human.** An acknowledgment is born at an
  answered gate and nowhere else. There is no route by which the harness
  records one for itself.
- **A repeat answers itself, and says so twice.** The lane stamps
  `finding-ack-used` with the findings, the fingerprints, the ack events and
  who recorded them, then stamps `operational-fix` with `source: 'ack'`. It
  then proceeds exactly as an answered gate proceeds. A gate with any unacked
  finding, or any finding of a class an ack may not cover, parks as it always
  did.
- **The standing set is derived, never stored.** `finding-ack` and
  `finding-ack-revoked` in the instance ledger are the whole record. The set
  is folded from them in order, per project. Two reads of one ledger give one
  answer, so a restart, a second console and a running daemon all agree.
- **A revoke ends one fingerprint.** `olympusctl revoke` takes the project,
  the fingerprint and the fix the revoke stands on, and stamps all three. No
  form clears a set. `olympusctl status` lists every acknowledgment the
  factory is currently allowed to walk past.

## Why the fingerprint is the finding's words

A finding id belongs to the run that raised it. Triage numbers its findings
from one, and the same defect is `F1` in one run and `F3` in the next. An
acknowledgment keyed on the id would cover the second gate of one run and
nothing after it, which is half of the problem.

What survives a run is what the finding says. Two triage seats looking at one
defect write the same sentence about it, in different words at the edges: a
different report path, a different cycle number, a different line. The
normalization strips the edges and digests the rest.

This is honest about its own limit. A triage seat that describes the defect in
genuinely different words reaches a different fingerprint, and the operator
meets the gate one more time. That is the safe direction for the error to
fall: an acknowledgment that fails to match costs a question, and one that
matches too eagerly costs a defect nobody looked at.

## Why only a harness finding

The three classes the gate can meet are not the same kind of statement.

A harness finding is a defect in the machinery that judges. The harness team
already holds it, the fix is a harness change, and no answer the operator
gives at a run's gate moves it. The second gate asks a question with a
recorded answer.

An env finding is a statement about this host at this moment. The host changes
under the harness between two runs, and it changes because people change it.
The gate exists so that a human looks at the host, and a standing answer about
a host is a statement nobody can make.

A code-defect or suite-defect finding is a statement about the product. That
is what the run exists to find. It never reaches this gate, and the class rule
means it never could.

## Why a restart clears nothing

An acknowledgment is a fact about a defect. A restart is a fact about a
daemon. The one says nothing about the other, and a harness problem nobody
fixed is exactly as unfixed after a restart as before it. Storing the set in
memory would have made every restart a silent revocation of every
acknowledgment, and the operator would answer the same gates again on the
morning after a crash.

The same rule holds sideways. Only a fix that targets an acknowledgment
removes it. An acknowledgment beside it, for a harness problem still unsolved,
keeps standing. That is why the revoke names one fingerprint and why no
command names all of them.

## Why the auto-answer is never silent

The lane takes a human's authority without asking the human at that moment. A
step that does that owes a full account of whose authority it took, so both
stamps land: the fix that was applied, and the acknowledgment it stood on with
the seq and the actor of the record that granted it. Reading the run ledger
answers "who let this through" without reading any other file.

The `operational-fix` stamp now carries three sources, and each names a
different authority: absent for the fix the lane applies on its own, `answer`
for the one a human confirmed at the gate, `ack` for the one that stood on a
recorded acknowledgment.

## Fallback paths

The decision is reversible one acknowledgment at a time, at any moment,
including mid-run: `olympusctl revoke --project <p> --fingerprint <f> --fix
<ref>`. The revoke lands in the instance ledger, the next gate re-derives the
standing set and finds nothing, and the finding parks exactly as it did before
the acknowledgment existed. Nothing waits for a run to end, and no other
acknowledgment is touched. The feature as a whole is off in a factory where
nobody has answered a gate with `ack`, because the set starts empty.

If a triage seat's re-wording defeats the fingerprint, and one operator ends
up acknowledging one defect under two of them, the ack answer gains an
operator-supplied fingerprint: the console takes `--fingerprint` beside
`--option ack` and records that instead of the derived one. Trigger: two
standing acknowledgments whose summaries an operator reads as one defect.
Reversal cost: low. One optional field on one command, and the fold does not
change.

If an acknowledged gate spins, the brake is gone with the human. The gate is
reached once per verdict cycle, and each cycle costs a spectrum run and a
triage seat, so an unfixable harness defect now spends money at machine speed
where it used to wait for an afternoon. The budget breach is loud and the
cycle count is in the ledger. Trigger: one run whose acked cycles cross its
budget. Reversal cost: low. Cap the auto-answers per run and park on the cap,
which returns the gate to the human without touching the acknowledgment.

If the project scope proves wrong, widen or narrow the key. A harness defect
is the harness's own, so one acknowledgment arguably covers every project on
the instance; the scope is per project because a project is the unit
everything else in the ledger is scoped to, and a wrong-way-narrow key costs
one extra answer rather than one missed defect. Trigger: the same fingerprint
acknowledged in two projects on one instance. Reversal cost: low. One key in
the fold.

If acknowledgments outlive their defects unnoticed, the standing list on
`status` is the read that catches it, and it is a passive one. Trigger: an
acknowledgment still standing after the commit that fixed it merged. Reversal
cost: low. A tripwire over the age of the standing set, which alerts and never
revokes, because a revocation is a claim about a fix and only a human can make
one.
