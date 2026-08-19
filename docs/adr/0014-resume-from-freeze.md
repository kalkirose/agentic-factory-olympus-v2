# ADR-0014: Resume a launch from a prior run's freeze

Status: accepted (2026-08-13)
Superseded in part by ADR-0015: the base-divergence refusals park the run
instead of closing it; abandon closes on the same reason.

## Decision

A story launch may inherit a prior run's freeze instead of deriving its own.
It is a launch option on the story lane, not a second lane and not a mutation
of the prior run.

- **The option.** `olympusctl launch --project <name> --resume-from <runId>`,
  carried as `resumeFrom` in the run payload. The console refuses a resume on
  any other lane and a resume that also names a card; the daemon handler
  refuses both again on its own authority.
- **The card comes from the prior run.** The prior run's `run-launched` stamp
  supplies the card path and the story key. A caller may not name a different
  card: a spec is born for one story, and pairing it with another is the exact
  guess this design refuses.
- **Admission through readiness.** The story lane's readiness stage has two
  routes. A normal launch is admitted on its card. A resume is admitted on the
  inheritance, copies the artifacts, stamps it, and returns the post-freeze
  stage. No pre-freeze seat runs on that route, and the card gates are not
  re-run: the prior run passed them, and its answers are already written into
  the spec this run inherits.
- **Provisioning.** The run worktree is created on a fresh run branch at the
  frozen commit the prior run's anchor names, off the prior run's branch in the
  bare clone. Everything the prior run committed after the freeze —
  implementations, repairs, re-freezes — stays on that branch and is not
  inherited.
- **The branch survives a close that did not ship.** A shipped run's work is on
  the default branch, so its branch dies with its workspace as before. A run
  that closed `failed` or `killed` pushed nothing: its branch is the only copy
  of what it derived, so release keeps it. The orphan sweep applies the same
  rule and treats an unreadable close as not shipped.
- **`freeze-inherited`** (new in the run registry): `from`, `sha` (the tree the
  implementation starts on), `frozenSha`, `base`, `priorBase`, the carried spec
  and record paths, the suite file count, the kill count, and pointers to what
  stayed behind. A resumed run never stamps `freeze`. Every reader after the
  freeze takes either anchor (`freezeAnchor`), so the suite sha, the reset sha
  and the verdict loop need no other change.
- **What travels.** The born spec and the freeze record travel as files into
  the new run directory; the frozen suite travels as the git tree at the anchor
  sha. The record is copied verbatim — it names the run that earned it.
- **What stays behind.** Open findings do not travel. Every finding is evidence
  about the tree it was found on, and a resume discards that tree by
  construction; a finding carried without its tree can be neither confirmed nor
  resolved, which would break confirm-to-block. They stay open and readable in
  the prior run's archived ledger, and the inheritance stamp names their ids so
  the trail from the new run is one hop. Open loud items are named the same
  way and stay loud on the stream, which reads archived ledgers. Escapes need
  no carry at all: they live in the instance-scoped escapes ledger, which no
  run owns and no launch touches.
- **Refusals.** A resume refuses, by name, when the prior run has no ledger, is
  still open, shipped, is not a story run, has no freeze anchor, has no
  readable freeze record, has no born spec, launched without a card, records no
  base sha, belongs to another project, or when the clone no longer holds its
  branch or its frozen commit. Each of those refuses the launch before anything
  is provisioned. The base-divergence refusals close the run with a named
  reason and the diverged file list.
- **A resumed run counts no freeze.** Tripwire windows measured in freezes, and
  the kill-rate metric, read `freeze` events only. A resume earned none, so it
  adds none and re-counts none.

## Why a launch option and not a lane

The chain after the freeze is the same chain either way: implementation,
verdict, ladder, ship. A second lane would duplicate every one of those stages
to change one thing — where the run enters and what it starts from. Both are
launch facts. The stage list stays one list, and `storyLane` gained one
argument it already had a use for.

Readiness is where the route splits because readiness is already the admission
gate: it is the stage that decides whether a run may proceed and closes it
`failed` with a named reason when it may not. A resume is that same decision on
different evidence. Entering the lane at `readiness` and leaving it for the
post-freeze stage in one settle also keeps the ledger-derived position rule
intact — a daemon restart re-enters `readiness`, sees the stamp, and moves on.

## Why the base advance is merged and re-gated, not refused outright

A freeze is a claim about a tree: this suite fails against it, and it fails only
because the feature is absent. When the default branch advances, the claim is
about a tree that is no longer the merge target, so the harness may not simply
carry it. Refusing every advance was the alternative. It is safe and it is
never worse than today's cost, but it makes the option fire only when nothing
shipped in between, and a harness whose repair path expires on the first
competing merge is not a repair path.

So the advance is brought in and the claim is re-derived where re-derivation is
cheap and deterministic, and refused where it is not:

- **Main edited the frozen suite.** Refuse, naming the files. The suite that
  was proven against the adversary waves is not the suite that would run, and
  no deterministic check recovers that difference.
- **The merge conflicts.** Refuse, naming the files. Conflict resolution is
  judgment work over two intents, and it belongs to a run that owns its spec,
  not to an admission gate.
- **The merged tree passes the suite.** Refuse. Red state is the freeze's core
  claim, and a green suite says the behavior is already there.
- **Otherwise.** Merge, stamp `branch-update`, re-run the red-state gate, and
  stamp the inheritance at the merge head.

The merge follows the ship step's existing rule — merge the default branch in,
never rewrite the branch — so the frozen commit stays an ancestor of everything
after it. A rebase would rewrite it, and the freeze record's suite sha would
then name a commit outside the branch's history.

What this trades away is named: the adversary waves are not re-run against the
advanced tree. Their kills measure the suite's discriminating power, which
follows the suite's content, and the content is unchanged or the run refused.
The residual risk is that main's advance makes a wrong implementation survive a
suite that killed it before. The full-spectrum verdict, the Fury round and CI
all still run on the candidate tree, so that risk lands on the verdict rather
than on the merge.

## Why the record is copied verbatim

The carried `freeze.json` names the prior run as its `runId` and points at the
prior run's spec path. Rewriting those fields would make an inherited record
read as one this run earned, which is the one thing the ledger rule exists to
prevent. A reader who sees a `runId` that is not this run knows immediately
that the freeze was inherited, and the `freeze-inherited` stamp beside it names
the source, the base, and the shas.

## Fallback paths

If the merge-and-re-gate route lets a stale freeze through — a resumed run
ships work that a re-derived suite would have caught — the divergence rule
tightens to a refusal on any advance, and the option becomes useful only while
the base holds. Trigger: one escaped defect attributed to an inherited freeze
whose base had advanced. Reversal cost: low — the merge arm becomes a close
directive, and the refusal already names the files.

If retained branches accumulate faster than resumes consume them, add a
retention sweep at daemon start that deletes run branches of runs archived
beyond a configured age. Trigger: a clone whose `run/*` refs outnumber its
runs of the last month. Reversal cost: low — one sweep beside the orphan
workspace sweep, and nothing else reads those refs.

If inheriting only the plain freeze proves too coarse — a prior run's
re-freeze was the better suite and a resume re-derives it — the anchor becomes
the latest `re-freeze` with the implementation commits stripped. That is a
tree-surgery step, so it stays out until a run asks for it. Trigger: two
resumes whose first verdict re-raises the suite defect the prior run already
fixed. Reversal cost: moderate — the anchor resolution grows a case and the
provisioning commit is no longer a commit that exists.
