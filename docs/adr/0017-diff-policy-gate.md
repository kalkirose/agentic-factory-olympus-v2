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
