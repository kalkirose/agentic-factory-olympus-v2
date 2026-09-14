# ADR-0091: A supersede is one obligation wherever the run finds it

Status: accepted (2026-09-14)

## Context

A story that extends a surface an earlier story pinned collides with that
earlier story's frozen test. ADR-0044 settled who rules on the collision: the
intent card, when the card mandates a behavior whose implementation necessarily
changes what the pinned clause asserts. ADR-0053 settled how that is read:
covered is a test of necessity, not of naming.

The harness had three places where the need for such an amendment can be found,
and only one of them executed it.

The spec can state the supersede at birth. Its `Supersedes:` clause named the
frozen test and the clause that replaces it. No card check ran on that entry and
no seat owed the amendment: the entry was read by the spec lint alone, to admit
the path under the diff policy.

The spec gate can find the collision. It ran the card check, stamped the
authorization, and briefed one spec amendment. The amendment stated the entry in
the spec, and then nothing amended the test either.

The verdict triage can find the collision after the freeze. That route worked
end to end: the card check, the stamp, a re-freeze that amends the file, a check
that the named file changed, and the ladder re-entering.

The third route was unreachable from the second. A dev seat reports what the
frozen suite said as `green` or `red` and nothing else, and a red report was
refused as a work-product defect before any verdict ran. A dev seat that has
found a collision it may not touch had one legal answer, and the harness read
that answer as unfinished work: one corrective invocation, then a seat-failure
park.

So a run could state a supersede at birth, have it verified at the gate, freeze
the unchanged test, hand the tree to a dev seat, and park on a collision the
card had already authorized and the spec had already written down.

## Decision

**A supersede is one obligation with one record, wherever the run finds it.**
Three sites can find it, the same card check runs at each, the same
`supersede-authorized` event is stamped once per test per run, and the amendment
is executed by a suite seat and checked by the daemon.

**A stated supersede carries the card words it rests on, and is authorized where
it is stated.** The template line in `templateLines` of `src/lanes/story.mjs`
writes a supersede entry as `<path> — supersede — <the clause that replaces
it> — <section>: "<the card line, verbatim>"`, where `<section>` is one of
`SUPERSEDE_CLAUSES`. A `keep` entry keeps its own form: it claims nothing and
owes nothing. The parser in `src/lanes/speclint.mjs` reads the two fields off
the entry's last field rather than off a position, so a replacement clause may
carry a dash of its own. Rule (p) of `lintSpec` reports a `supersede` entry with
no section and no quote, which buys the same corrective spec round every lint
defect buys.

**The pre-freeze lint is where a stated supersede is authorized.**
`specLintDefects` in `src/lanes/story.mjs` runs `authorizeSupersede` for every
stated `supersede` entry at site `spec-birth`, after birth and after every
amendment. The frozen-set check has no freeze to read yet, so it reads the tree
the spec was written against: the supersede targets that exist at the base sha
under the test paths, which `supersedeBaseFiles` already answered for rule (f).
A quote the card does not hold is a lint defect. An owner-pinned target parks
`intent-conflict`, as it does at the gate, and the park names the tests it is
about so a second read of the same clause asks nothing. One stamp per test per
run: an entry the gate already stamped reads as authorized, and a stamp at birth
satisfies the gate.

**Rule (p) belongs to the pre-freeze lint and to no other.** The same lint runs
on the spec amendment a re-freeze makes, and the authority there can be an
owner's answer to a park, which is in no card. `quotedSupersedes` on `lintSpec`
is the flag, and the story lane is the only caller that passes it.

**The suite seat owes every authorized supersede.** `suiteReportLines` in
`src/lanes/story.mjs` states one line per `supersede-authorized` event of sites
`spec-birth` and `spec-gate`: the file, the guarantee the pin protects, the duty
to restate it and never delete it, and the card line the authorization rests on.
Every pre-freeze suite write carries them, because each one runs in fresh
context. `suiteChecks` reports one defect per authorized target the run has not
amended, and the corrective invocation and the seat-failure park are the
existing ones.

**A target counts as amended when the run moved it, in a commit or in the
working tree.** `unamendedSupersedes` is one derivation with two callers, so the
check that refuses a suite write and the check that refuses a freeze cannot
disagree. It reads `changedFiles` for the write in front of it and
`changedSince(base sha, HEAD)` for the writes already committed, so the
red-state fix write is never asked to amend a file the author write already
amended.

**A supersede the run stated and no seat executed cannot freeze.**
`freezeHandler` refuses the freeze record when any authorized target is
byte-identical to the base sha: it appends `freeze-refused` with `reason:
'supersede-unamended'` and the files, and parks through `seatFail` on the suite
seat. A run whose payload carries no base sha cannot make the check at all and
refuses the same way, reason `no-base-sha`. The freeze record gains
`supersedes`: the authorized targets at the freeze, each with the site that
stamped it, beside the exclusions and the owner pins a later reader already
takes off that one file.

**A red the dev seat attributes to the frozen suite is a verdict input, not a
defect of the seat.** `DEV_SCHEMA` in `src/lanes/verdict.mjs` gains an optional
`suiteConflicts`: a flat array of `{test, assertion, reason, quote, clause}`.
`suiteStateDefects` refuses a `red` report that names no conflict, exactly as
before; it accepts a `red` report whose every entry names a file in the run's
frozen suite outside the freeze exclusions, and reports the entries that name
anything else. An accepted report appends `dev-suite-conflict {files, count}`
and the stage proceeds to the verdict as it does on a green report. The repair
lane has no frozen suite, so `devSchema('repair')` strips the field with
`suiteState`.

**The dev seat is told the route before it needs it, never by the refusal.**
`devRole` states the field and when to use it. A seat that learned it from the
refusal would have spent the one corrective invocation the run had, which is the
shape of the failure this record removes.

**The triage reads the attribution as evidence and rules on it.** `triageRole`
carries the entries from the dev report of the pass that produced the tree: the
file, the pinned clause, the seat's reason and the card line where it gave one.
The seat classes each as a `suite-defect` finding at depth `intent` with the
supersede claim where the card covers it, or as a `code-defect` finding where an
implementation can satisfy the pin. From there nothing is new: `cardSupersedes`
authorizes at site `verdict`, the re-freeze amends the file and checks it, the
ladder re-enters with a fresh dev pass, and an unauthorized claim parks
`intent-conflict` with the refusal named.

**Every reader of the stamp reads every site.** The spec-lens verification duty
in `src/lanes/review.mjs` selects `supersede-authorized` events without a site
filter, so an amendment made before the freeze is verified as one made after it.
The eval-review brief in `src/eval/review.mjs` reads the three sites apart, and
reads two counts per run: the pre-freeze stamps against the freeze record's
`supersedes` whose file moved against the base sha, and the seat-failure parks
whose refused dev report carried `suiteState: red` beside a non-empty
`suiteConflicts`, which is zero when this route works.

## Consequences

Spec authors must quote the card for every stated supersede. That is more lint
defects at birth until the seats learn the form, each a mechanical corrective
round inside the existing allowance.

The suite seat now edits another story's frozen test before the freeze. The
guarantee that pin protected can be dropped in the amendment instead of
restated. The lens duty and the one-amendment-per-test rule bound it, and the
re-freeze route already lives with the same exposure.

A dev seat can name conflicts to escape work. The cost is one spectrum cycle:
the triage classes the reds `code-defect`, the code arm re-briefs a fresh dev
pass with the finding, and a `dev-suite-conflict` whose triage classed every
named file `code-defect` is the count that says so.

The base sha is load-bearing for the freeze. A run without one refuses to freeze
a supersede and says why, rather than freezing a file nothing verified.

The suite check reads the write in front of it, so a later write can still undo
an amendment an earlier write made. The freeze reads the whole run against its
base sha, which is why it is the backstop and not a repetition.

## Rejected options

- Let the dev seat amend frozen tests on the card's authority. The freeze exists
  so no seat moves the ground it is judged on, and a dev seat that edits the pin
  it fails against judges its own work.
- A new owner park for a post-freeze collision. ADR-0044 removed that touchpoint
  on purpose. The card answers most of these, and the arithmetic between the
  card and the suite is not the owner's job.
- Drop `suiteStateDefects` and let every red reach the verdict. A red with no
  evidence spends a spectrum cycle to learn what the seat already knew. The
  refusal stays for the case it was built for.
- A better spec gate alone. A `keep` entry can fail by timing, which no reader
  of two documents predicts. The run has to have a route for the collisions the
  tree reveals.
- Rule (p) on every lint. The post-freeze spec amendment can rest on an owner's
  answer, and a rule that demanded a card quote there would refuse a spec no
  seat could write.

## Fallback path

`lanes.story.cardAuthorizedSupersede: false` turns the card's authority off in
one config line, at every site. Nothing is then authorized, so nothing is owed,
nothing is refused at the freeze, and every frozen-surface collision parks for
the owner as it did before ADR-0044. The switch trigger is a window of amended
pins whose card lines do not reach the change, read off the spec-lens findings
and the per-site counts in the eval review. The reversal cost is one config line
and no harness change.

## References

- ADR-0015, ADR-0019, ADR-0020, ADR-0044, ADR-0053, ADR-0055, ADR-0067,
  ADR-0071, ADR-0072
- `src/lanes/supersede.mjs`
- `src/lanes/speclint.mjs`
- `src/lanes/story.mjs`
- `src/lanes/verdict.mjs`
- `src/lanes/review.mjs`
- `src/eval/review.mjs`
- `src/isolation/tree.mjs`
- `src/ledger/registry.mjs`
