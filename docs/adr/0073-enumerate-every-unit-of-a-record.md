# ADR-0073: Enumerate every unit of a record and answer it by id

Status: accepted (2026-09-07, the reference kind 2026-09-10)

## Context

A decision record is a list of claims, and a confirmed finding on one blocks the
ship. Nothing stated what a claim is. No seat showed which claims it read, so
each seat answered the ones it reached. One cycle of a live reconciliation read a
record whole and passed over a false sentence. The next cycle graded it HIGH.

Two failures ride with it. A seat that edits an accepted record leaves a trail of
amendments, and the trail hides the current sentence. Two active records can also
decide one unbuilt part two ways, because the tree settles nothing about it.

## Decision

The harness enumerates the units of a record, and every record seat answers every
unit by id.

`recordUnits` in `src/lanes/units.mjs` splits a record into ordered units. The
title is `U0`. Then one unit per head-block line, paragraph, list item at any
depth, table row and top-level fenced block. A list item is one unit whatever it
holds. A heading, a blank line, a table header, a table rule and an HTML comment
are structure. `bin/olympus-units.mjs` prints the same list, so the seat and the
harness read one list. Ids are positional, so `matchUnits` carries a
finding across a write by head text and then by line.

Each report entry names the record, the unit id, a kind, a verdict and the
evidence. The kinds are `title`, `status`, `claim`, `open`, `rationale` and
`reference`. The verdicts are `holds`, `fails` and `not-built`.

The harness names three of the kinds itself. `title` and `status` come from the
head block. `reference` is every unit inside a reference section: the span runs
from a `## References` heading to the next heading of the same level or higher,
or to the end of the file, and a fenced block inside it is skipped whole, so a
heading in a fence opens no section and ends none. A reference states nothing
about the tree and gives no reason, so it is neither a claim nor rationale, and
one line of `unitKindLines` states that to the birth
brief, the two write briefs and the review's.

`unitChecks` in `src/lanes/records.mjs` refuses nine numbered defects: a missing
entry; an entry for no unit of the file; a doubled entry; a claim with no path in
the worktree; a rationale entry whose text reads as a claim; a writer's `fails`;
a review's `fails` with no finding; a finding on a unit the review reported
`holds`; and, as rule 9, a reference the tree does not answer. Rule 9 refuses any
kind but `reference` on a unit of the section and `reference` on any unit outside
one. On the names a reference carries it refuses two things and no third: an
`ADR-<n>` token that names no record of the record tree at any status, and a path
token, slash and all, the worktree does not hold. A bullet that names nothing the
record form gate checks is accepted, as that gate accepts it, so a link, a root
file cited by its bare name and a line of prose all pass. Rules 4 and 9 read
their path tokens from one function, which splits on whitespace alone, strips the
backticks and the punctuation at a token's two ends, and keeps every bracket,
parenthesis and plus inside it, as the record form gate does. Rule 5 never reads
a reference unit. A refusal buys the seat its one corrective attempt, and every
refused attempt stamps `seat-refused` with the seat, the attempt number and the
defects, so a reading counts the refusals a seat answered as well as the budgets
one spent.

`repo.recordLifecycle` is `rewrite` or `supersede`. Under `supersede` no seat
edits an accepted record. A change is a new record with a `Supersedes` line. The
old record keeps its body and takes a closed status line. `supersedeChecks`
computes the accepted set at the merge base of the run branch and the default
branch, per write.

`RECORD_CRITERIA.consistent` in `src/lanes/lenses.mjs` is the seventh criterion.
An open part of a record does not contradict an open part of an active record
beside it. `recordNeighbours` caps that neighbourhood at twelve, and the brief
states what the cap dropped.

## Consequences

A report grows with the record, one entry per unit. The writer miss rate catches
a seat that answers `holds` without reading; no check does. A one-word correction
to an accepted record costs a new record, so the tree grows.

A record that writes a reference bullet outside its reference section files that
bullet as a claim, as any other sentence. A record that writes prose inside the
section files it as a reference, and rule 9 asks nothing of it.

This record is superseded when the unit check refuses a correct report on more
than one reconciliation in five. That reading says the enumerator and the seats
disagree about what a unit is.

## Rejected options

- Coverage as a count from the seat: nobody can check a count.
- A reference filed as a claim, with the cited record's path as its evidence:
  the rule stays a rule the seat has to remember, and the day a brief is
  rewritten the guess returns.
- The reference section out of the enumeration: a cited path that does not exist
  is a defect worth catching, and the `reference` criterion reads the section.
- One larger review seat at higher effort: it sampled four records.
- A second review seat as a coverage adversary: it doubles the sample.
- Extraction by sentence: a split over paths and code spans is not deterministic.
- An amendment trail: the trail is the defect.

## Fallback path

The alternative is the criteria alone: no unit list, no per-unit answer. Nothing
calls `unitChecks`, and every brief drops its unit duty. The switch trigger is
the reversal trigger above. The reversal cost is low.

## References

- ADR-0026, ADR-0038, ADR-0074, ADR-0075
- `src/lanes/units.mjs`
- `src/lanes/records.mjs`
- `src/lanes/lenses.mjs`
- `src/config/project.mjs`
- `bin/olympus-units.mjs`
