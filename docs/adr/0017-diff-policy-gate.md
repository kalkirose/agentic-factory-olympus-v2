# ADR-0017: The diff-policy gate at candidate capture

Status: accepted (2026-08-14)

## Decision

The candidate capture judges the set of changed paths before the tree becomes
an implementation commit. Two conditions stop it, and both are work-product
defects the dev seat answers through the lane's existing contract loop: one
corrective invocation carrying the exact paths, then the `seat-failure` park.

- **Three tiers, declared per lane in project config.** The optional
  `diffPolicy` block keys tiers by lane name (`story`, `repair`). A changed
  path matching `deniedPaths` is a violation. A path matching
  `declaredPaths` is a violation unless the run declared it. A path matching
  `forbiddenPatterns`, a regular expression over the repo-relative path, is
  always a violation. Everything else is allowed, and the test-path rules
  that already governed the seats are unchanged.
- **An absent block means the feature is off.** A project that declares no
  `diffPolicy` captures exactly what it captured before. A lane the block
  omits is unpoliced.
- **The gate reads paths, never content.** A file the policy names violates
  it whatever the change inside says. The point of the gate is that the seat
  under judgment cannot move the ground it is judged on, and no reading of
  the change itself can settle that question.
- **The declaration is machine-readable.** A spec declares paths in a fenced
  ` ```touched-paths ` block, one repo-relative path per line, with an
  optional owner after a dash. Prose naming a path declares nothing. A
  missing block and an unterminated block both declare nothing, which is
  conservative in the safe direction: an undeclared match blocks the capture.
- **The repair lane declares by its ticket.** That lane has no born spec, so
  its intake ticket answers: a path the ticket names verbatim is declared.
- **Every discard is stamped.** `diff-policy-violation` is one new run event,
  loud-classed and resolvable. It carries every violating path with the rule
  and pattern that caught it, and every path the capture took back. A later
  capture that clears the record pairs a `resolved` append, so a run that
  answered itself leaves no open loud item.
- **The structural suite restore is no longer silent.** A story-lane seat
  that reaches a test path past its tool deny still gets that write reverted,
  unconditionally, because the frozen suite is the thing being judged
  against. What changed is that the revert is now recorded and named in the
  corrective brief. This holds with no `diffPolicy` block present: the drop
  record is not a policy tier.
- **`changedFiles` lists untracked files, not untracked directories.** Git's
  default porcelain output collapses a wholly untracked directory to the
  directory itself. Every caller of that helper judges paths, so the
  collapsed form defeats them all: a gate that sees `scripts/` instead of
  `scripts/gate.mjs` matches no rule and passes the change through. The
  helper passes `-uall`.

Nothing else changes. The park machinery, the suite seat's own checks, the
adversary restore and every seat prompt are untouched; the corrective brief
rides plumbing that already existed.

## Why a mechanical gate, and not a reviewer

Three incidents produced this decision, and no reviewer stopped any of them.

A dev seat committed platform-specific baseline images that an earlier
decision had deliberately removed. The change was small, plausible, and
inside a directory the seat had every reason to touch. It shipped because
nothing mechanical examined the set of paths in the diff.

A dev seat changed the repository's install topology and reconfigured the CI
workflow, in a run whose spec said nothing about either. Both files sit far
from the story's subject. A judgment seat scoring a diff reads what the diff
does; it has no cheap way to ask whether this run was ever entitled to touch
this file at all.

Those two say the same thing. Whether a path belongs in a run's diff is a
question about the run's mandate, not about the quality of the change. It is
decidable from the path and the spec alone, so it belongs in a deterministic
check that runs every time and costs nothing, not in a seat that reasons
about it sometimes.

The third incident is sharper. A seat wrote a fix outside its boundary, the
capture reverted the write, and stamped nothing. The seat's report said the
fix had landed. The verdict re-found the identical red. The run then spent a
full repair round rediscovering a change that the harness itself had thrown
away. A silent discard is worse than a refusal, because every later stage
reasons from a tree that nobody described.

So the rule is that nothing leaves the capture without a record, and the
record is loud. A refusal costs one corrective invocation, and at worst a
park the owner clears with one answer. A silent drop costs a repair round, a
misleading report, and the owner's confidence in every other report.

## Why the code that judges belongs behind the gate

Gate scripts, package script definitions and test-runner configuration decide
whether a candidate is green. Until now the seat being judged could edit all
of them. Nothing in the harness noticed, because those files are ordinary
repository files and the capture had no opinion about paths.

That is a straightforward conflict of interest, and it does not need evidence
of abuse to be worth closing. A seat under pressure from a red gate has an
obvious cheaper move available than fixing the code, and the harness offered
no resistance to it. The `deniedPaths` tier exists mainly to remove that
move: a project lists the files that constitute its judgment, and the story
lane cannot ship a change to them without a human seeing a park.

The `declaredPaths` tier is the softer case, for files a story legitimately
touches but should not touch by accident: manifests, shared contracts, the
seams between packages. Requiring the spec to name them first turns a
surprise into a decision made before the seat started.

## Why the tiers live in project config

The path sets are facts about one repository's layout. They fail the
ownership test for harness code the same way test paths and gate layers do,
and they change when the repository changes. Putting them in the project's
own config means they ship through the same review path as the code they
describe, and a project that wants none of this changes nothing.

## Fallback paths

If the gate parks runs on paths that turn out to be legitimate more often
than it catches real breaches, the offending globs move from `deniedPaths` to
`declaredPaths`, which keeps the record and the decision but lets a spec
authorize the change up front. Trigger: two parks in one wave that the owner
answers by widening the policy. Reversal cost: low, one config edit.

If the touched-paths block proves too heavy for spec authors, `declaredPaths`
falls back to matching the path anywhere in the spec text, which is the rule
the repair lane already uses for its ticket. Trigger: specs that carry the
block but leave it stale. Reversal cost: low, one helper swaps for a
substring test, and the parser stays for the lane that still wants it.

If a corrective invocation proves unable to undo its own out-of-policy writes
often enough to matter, the capture reverts the violating paths itself before
re-invoking, and the brief becomes a notification rather than an instruction.
Trigger: three consecutive policy parks whose corrective invocation left the
same path in place. Reversal cost: medium, the revert must be surgical about
paths the run legitimately owns.

If the drop record proves noisy on the repair lane, where the seat may write
tests by design, the record narrows to lanes that run a structural restore.
Trigger: drop records with no corresponding defect in any run. Reversal cost:
low, one condition at the record site.

## Correction (2026-08-14): a take-back is not a defect

The decision above treats a violation and a take-back as one thing: two
conditions, both work-product defects, both answered through the corrective
invocation and the `seat-failure` park behind it. That is wrong for the
take-back, and it parks runs that should never have stopped.

A violation is a defect. The seat wrote a path its mandate does not cover, and
the corrective invocation asks it to do something it can do: put the file back
and ship the rest. A take-back is a different kind of fact. The path is frozen
for the lane, the write is gone, and no seat under that freeze can make the
same write legal by trying again. Sending it back with a defect list gives it
one legal move it will not find and one illegal move it already made.

Both halves of that failure ran in one live story run, twice, identically.

A dev seat re-rendered a UI surface and updated the visual baseline file that
surface is compared against. The baseline sits under a frozen test path and
the spec had not declared it, so the capture reverted the write and refused
the commit. The corrective brief told the seat that whatever the change was
meant to fix "is still unfixed". The seat re-ran its own checks, saw the
visual layer red without the file, wrote the file again, and was taken back
again. Second refusal, `seat-failure` park, run stopped. A later repair-dev
seat, fresh context, reached the identical position from the identical brief
and stopped the run a second time. Two parks, two seats, one file, zero
information the seats could have acted on: the brief named the offending path
and never named the route.

The same run then proved the route it never named. On a later cycle the
visual layer went red, the verdict triaged it as a suite defect, the spec
amendment ran, the suite seat re-committed the surface's baseline, and the
re-freeze landed. No human touched it. The harness already owns undeclared
changes to frozen surfaces; the seat-side loop was buying nothing and
spending everything.

So the semantics split:

- **Violations keep the whole gate.** A denied path, an undeclared declarable
  path, a forbidden path shape: capture blocked, one corrective invocation
  carrying the exact paths, then the `seat-failure` park. Unchanged.
- **Take-backs stop blocking.** The revert stays unconditional, the loud
  record stays, and the capture proceeds to commit the allowed set. No
  corrective invocation, no park. A capture holding both blocks — the
  violation decides, and the brief states the take-back as a fact rather than
  as a defect.
- **The take-back reaches downstream on the record.** The capture record
  carries the dropped paths and the wording; the implementation commit record
  carries the dropped paths of its own pass, including a take-back from an
  attempt a violation later blocked; the verdict record carries what the tree
  it judges lost. Triage and repair briefs state it. The failure this ADR was
  written to prevent — a stage reasoning from a tree nobody described — is
  prevented by the record, and it never needed the park.
- **The wording carries the route.** Every statement of a take-back says the
  path is frozen for this lane, that the write was reverted and ships from no
  implementation seat, and that a change the surface genuinely needs is routed
  by the verdict through a re-freeze. The old sentence asserted the opposite:
  that something was still owed from the seat.
- **The loud item pairs at close.** A take-back record blocks nothing, so no
  later capture clears it. The run pairs its own `resolved` when it closes,
  the way a budget breach does (ADR-0021). A record that carried a violation
  still resolves at the capture that cleared it.

The spec template gained the matching line, because the cheapest place to
settle a baseline is before any seat runs: a story that changes a rendered
surface enumerates that surface's existing visual baseline files as dev-owned
touched-paths entries, and they join the freeze exclusions. An undeclared
baseline is not a disaster after this correction — it costs the run one
verdict round-trip instead of a park — but it is still a round-trip nobody
needed to buy.

### Fallback path

If take-backs turn out to hide real losses — a seat's genuine work vanishing
into a frozen path with nothing downstream reacting — the capture stops at a
`stage-blocked` park that names the paths and asks the owner whether to route
them through a re-freeze, instead of returning the seat a defect list it
cannot answer. Trigger: a run that ships with a take-back whose surface a
later run has to fix. Reversal cost: low; the record and its wording already
exist, and the park replaces one early return in the capture.
