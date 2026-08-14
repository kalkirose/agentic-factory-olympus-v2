# ADR-0017: The diff-policy gate at candidate capture

Status: accepted (2026-08-15)

## Decision

The candidate capture judges the set of changed paths before the tree becomes
an implementation commit. Two different things can stand between the tree and
the commit, and the gate keeps them apart.

A **violation** is a change the lane's diff policy refuses. It is a
work-product defect the dev seat answers through the lane's existing contract
loop: one corrective invocation carrying the exact paths, then the
`seat-failure` park.

A **take-back** is a write to a path the lane froze. The revert is
unconditional, because the frozen suite is the thing the candidate is judged
against, and no seat under that freeze can make the write legal by trying
again. It is not a defect, it blocks nothing, and the capture commits the
allowed set.

- **Three tiers, declared per lane in project config.** The optional
  `diffPolicy` block keys tiers by lane name (`story`, `repair`). A changed
  path matching `deniedPaths` is a violation. A path matching
  `declaredPaths` is a violation unless the run declared it. A path matching
  `forbiddenPatterns`, a regular expression over the repo-relative path, is
  always a violation. Everything else is allowed, and the test-path rules
  that already governed the seats are unchanged.
- **An absent block means the tiers are off.** A project that declares no
  `diffPolicy` captures exactly what it captured before. A lane the block
  omits is unpoliced. The take-back record is not a tier and holds either
  way: it is the capture refusing to discard a seat's work in silence.
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
- **Every violation is stamped loud.** `diff-policy-violation` carries every
  violating path with the rule and pattern that caught it. A later capture
  that clears the record pairs a `resolved` append, so a run that answered
  itself leaves no open loud item.
- **A take-back is stamped in one of two classes.** The loud
  `diff-policy-violation` carries it by default, and the run pairs its own
  `resolved` at close, because no later capture can clear a record that
  blocked nothing. A path the lane declared `recapturablePaths` stamps the
  quiet `diff-policy-recapture` instead: a run event, no loud stream, no
  resolution owed.
- **The hard tiers outrank the quiet class.** A take-back that `deniedPaths`
  or `forbiddenPatterns` also match stays loud whatever `recapturablePaths`
  says. Tamper protection sits on the code and config that decide whether a
  candidate is green, and no glob widening reaches it.
- **A take-back reaches downstream on the record, in both classes.** The
  capture record carries the dropped paths and the wording; the
  implementation commit record carries the drops of its own pass, including a
  take-back from an attempt a violation later blocked; the verdict record
  carries what the tree it judges lost; the triage and repair briefs state
  it. Every statement says the same three things and asks for nothing: the
  path is frozen for this lane, the write is reverted and ships from no
  implementation seat, and a change the surface genuinely needs is routed by
  the verdict through a re-freeze.
- **A capture holding both blocks.** The violation decides. The corrective
  brief still states the take-backs, because the seat is about to re-read a
  tree that no longer holds its write.
- **`changedFiles` lists untracked files, not untracked directories.** Git's
  default porcelain output collapses a wholly untracked directory to the
  directory itself. Every caller of that helper judges paths, so the
  collapsed form defeats them all: a gate that sees `scripts/` instead of
  `scripts/gate.mjs` matches no rule and passes the change through. The
  helper passes `-uall`.

The spec template carries the matching line, because the cheapest place to
settle a baseline is before any seat runs: a story that changes a rendered
surface enumerates that surface's existing visual baseline files as dev-owned
touched-paths entries, and they join the freeze exclusions. A file the spec
declares that way is never taken back at all.

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

So the rule is that nothing leaves the capture without a record. A refusal
costs one corrective invocation, and at worst a park the owner clears with one
answer. A silent drop costs a repair round, a misleading report, and the
owner's confidence in every other report.

## Why a take-back is not a defect

Sending a take-back back to the seat as a defect asks it to do something it
cannot do. The path is frozen, so the write it is being asked to justify has
no legal form under this freeze. The seat has one legal move it will not find
and one illegal move it already made.

A live run proved both halves of that. A dev seat re-rendered a UI surface and
updated the visual baseline the surface is compared against. The baseline sits
under a frozen test path and the spec had not declared it, so the capture
reverted the write and refused the commit. The corrective brief told the seat
that whatever the change was meant to fix "is still unfixed". The seat re-ran
its own checks, saw the visual layer red without the file, wrote the file
again, and was taken back again. Second refusal, `seat-failure` park, run
stopped. A later repair-dev seat, fresh context, reached the identical
position from the identical brief and stopped the run a second time. Two
parks, two seats, one file, and no information either seat could act on: the
brief named the offending path and never named the route.

The same run then proved the route the brief never named. On a later cycle the
visual layer went red, the verdict triaged it as a suite defect, the spec
amendment ran, the suite seat re-committed the surface's baseline, and the
re-freeze landed. No human touched it. The harness already owns undeclared
changes to frozen surfaces, so the seat-side loop was buying nothing and
spending the run.

The record is what the third incident actually needed. A stage reasoning from
a tree nobody described is prevented by the record, and it never needed the
park.

## Why one class of take-back is quiet

The loud stream is the owner's alert strip. Everything in it is a claim on
attention, and a claim that turns out to be a handled case teaches the owner
to skim the strip. That is the whole cost of noise here, and it is paid on
every run.

A frozen test is authored work. A write to it says a seat tried to change what
it was judged by, and the owner should see that even though the write is gone.
A frozen artifact that a machine re-takes says something much smaller. The
baseline of a re-rendered surface is not an opinion about the acceptance
criteria; it is an output of them. When it moves, the verdict's re-freeze
route re-takes it, and that route runs unattended.

One live run shipped four loud items, and three were the same visual baseline
taken back on three passes. Every one of them named a case the harness had
already handled. The class exists so that the loud strip keeps meaning what it
says.

Quiet is a record class and nothing else. The revert is unchanged, the ledger
event is unchanged in content, and every downstream brief states the take-back
in the same words. The only difference is that the owner is not asked to read
it.

The class is a per-lane list of path globs in project config, next to the
tiers, for the same reason the tiers live there: which frozen paths hold
machine-re-taken artifacts is a fact about one repository's layout. It cannot
be a spec declaration, because a spec declares literal paths for one run and
this is a standing property of a directory. A spec that does name the file
gets a better outcome anyway, since a declared baseline is a freeze exclusion
and survives the capture whole.

## Why the code that judges belongs behind the gate

Gate scripts, package script definitions and test-runner configuration decide
whether a candidate is green. Until this decision the seat being judged could
edit all of them. Nothing in the harness noticed, because those files are
ordinary repository files and the capture had no opinion about paths.

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

It is also why the quiet class stops at the hard tiers. A denied path is
denied because shipping it corrupts the judgment, and a take-back on one is
the same event as a violation on one: the seat reached the ground it stands
on. A project that lists a wide glob of re-capturable artifacts must not
quiet that by accident.

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

If take-backs turn out to hide real losses — a seat's genuine work vanishing
into a frozen path with nothing downstream reacting — the capture stops at a
`stage-blocked` park that names the paths and asks the owner whether to route
them through a re-freeze, instead of returning the seat a defect list it
cannot answer. Trigger: a run that ships with a take-back whose surface a
later run has to fix. Reversal cost: low; the record and its wording already
exist, and the park replaces one early return in the capture.

If the quiet class turns out to hide a take-back the owner needed, the class
narrows to a counted one: the first take-back of a re-capturable path in a run
stamps loud and the repeats stamp quiet, so a novel loss is still announced
and a re-rendered surface is announced once. Trigger: one run that ships a
wrong artifact whose only trace was a quiet record. Reversal cost: low, one
count over the run's own events at the record site.
