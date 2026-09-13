# ADR-0085: A review finding names the ground it rests on

Status: accepted (2026-09-12)

## Context

Every other claim in a certification declares what it rests on. A gate layer
states its ground, in its config entry or through its own command's markers, and
the ship path asks whether the default branch moved that ground before it lets a
green stand over a moved base (ADR-0056).

A review finding declared nothing. So the honest answer for a certification that
carried one was to refuse the carry outright: nothing in the project could say
the branch had left the finding's ground alone, because the finding had no
ground. One advisory remark about one file was enough to buy a full re-judgment
of the code and of the records behind it, over an incoming change that touched
neither.

The seat that raises a finding always knows the answer. It read files, it names a
file in the finding text, and it can name the set.

## Decision

**Every review finding carries the ground it rests on, and the seat that raises
it names that ground.**

- **`ground` is a required field on a finding item**, an array of repo-relative
  paths and directories. The report contract carries no minimum length, so the
  harness checks non-emptiness after the schema validates, and the check runs on
  every seat that raises findings on any lane.
- **A finding with no ground is a work-product defect.** The seat is refused once,
  with the finding ids named, and a second refusal is the failure every other
  work-product defect takes. Every entry is canonicalised and read with the same
  path vocabulary the declarations use, so two spellings of one directory are one
  entry and an entry that names nothing at all is a defect rather than a silent
  pass.
- **Ground is files and directories, never a name.** A finding about a package
  names the manifest that declares it or the file that imports it. The question
  the ground answers is whether a diff reached the claim, and a diff is a list of
  files.
- **The ground travels wherever the finding travels.** The finding's ledger
  event carries it, the verdict record carries it, and every reader that
  rebuilds a finding from the ledger, whether a resume, a later cycle or the
  ship path, rebuilds the ground with it. A claim that lost its ground on the
  way to a record would be groundless again at exactly the moment the record is
  read.
- **The verifier may replace the ground on a HIGH it confirms.** Its brief asks
  it to name the files the evidence it read lives in. A confirmed HIGH is the
  claim that blocks, so it is the claim worth the most care, and the verifier read
  the code to confirm it.
- **The ship path asks the finding the same question it asks a layer.** An
  incoming file under any finding's ground refuses the carry, naming the finding
  and the file. No hit, and the findings stand with the rest of the
  certification. A finding that declares no ground refuses the whole check, which
  is the only honest answer for a claim with no stated surface.
- **A record finding carries ground and refuses nothing.** It reaches no verdict
  record, and the lane that raises it holds no code certification, so its ground
  is there for the ledger and for the eval rather than for a gate.

## Consequences

The ground is the reviewer's own claim, not a measurement. A narrow ground
carries a finding that a rebase should have re-judged. The verifier's replacement
covers the grade where that matters most, and below it the ground is the lens's
word. That is the same trust the design already places in a lens's severity.

Every certification written before findings carried ground reads as groundless
and refuses the carry. Nothing has to be backfilled, and nothing reads a missing
field as an empty one.

A seat that writes a finding writes one more field per finding. The cost is a
line, and the reason is stated in the brief beside it.

## Rejected options

- **Make the field optional and treat an absent list as the whole repository.**
  Then a seat that skips the field silently buys the old refusal, and the
  difference between a lens that declared nothing and one that declared
  everything is invisible in the record.
- **Derive the ground from the finding's file reference.** A finding names one
  file in its text and rests on more than that: the call site it came from, the
  configuration it read, the test that should have caught it. A derived ground
  would be narrower than the claim and would carry a rebase past a real
  interaction.
- **Give each lens a declared surface in project config.** The surface a lens
  reads is the repository around the diff. A smaller list written into config
  would not make it true, and it would be one list for every finding the lens
  ever raises.
- **Keep refusing every certification that carries a finding.** That is the cost
  this removes, and the refusal was never about the finding's content: it was
  about a missing field.

## Fallback path

The alternative is the blanket refusal again: any review finding on a
certification stops the carry, whatever ground it names. The switch trigger is an
escape that came in through a ship whose carry stood on a finding's ground, where
the incoming change interacted with the finding and the ground did not say so.
The reversal cost is one clause in the ship path's reader; the field stays, and it
stays worth having for the ledger.

## References

- ADR-0007, ADR-0022, ADR-0038, ADR-0056, ADR-0059, ADR-0086
- `src/lanes/review.mjs`
- `src/lanes/lenses.mjs`
- `src/lanes/fastpath.mjs`
- `src/lanes/verdict.mjs`
- `src/config/project.mjs`
