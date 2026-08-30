# ADR-0051: A run worktree is created over the run's own residue

Status: accepted (2026-08-30)

## Decision

Every worktree a run creates for itself is created over whatever that run left
at the same path before. The two creation functions in
`src/isolation/worktrees.mjs` own this, so every stage step that creates a
worktree gets it, and no step carries a guard of its own.

- **The residue is cleared before the add, and again after a refused one.**
  The state is readable, so the ordinary case never depends on matching the
  words of an error message: a path that exists, or a registration the clone
  holds for that path, is cleared first. The message match stays behind it, as
  the answer to a state that changed between the read and the add.
- **Clearing means all three traces.** `git worktree remove --force`, then a
  direct delete of the directory in the extended-length path form (ADR-0004),
  then `git worktree prune`. A registration outlives a directory that git did
  not remove itself, and a directory outlives a registration that was pruned,
  so a clearing that took only one of the two would leave the other.
- **The run worktree resets its branch.** Residue of a crash carries the run
  branch as well as the directory, and `worktree add -b` refuses a branch that
  exists. The recreation uses `-B`, which resets the branch to the base. That
  is what recreating the worktree means.
- **The bound is the run's own workspace root.** `assertInRunWorkspace`
  refuses any path that is not strictly inside `<worktrees>/<runId>`, and it
  runs at the top of the creation, at the top of the clearing, and therefore
  before anything is read or deleted. The workspace root itself, the root of
  every workspace, another run's workspace, the clone store and the daemon
  home are all outside the bound. The shared project checkout is not even in
  the same tree.

## What this eliminates

A stage step that crashed between creating its worktree and using it could not
retry. The step asked git for a worktree, git answered that the path was
already spoken for, and the step failed the same way on every attempt until a
person cleared the directory by hand. The run was stopped by residue that was
not work: the tree had been created and nothing had read it.

The three shapes a crash leaves are the directory with its registration, the
registration with the directory gone, and the directory with the registration
pruned. Measured: a plain `worktree add` over the second shape answers
`fatal: '<path>' is a missing but already registered worktree`. All three are
cleared the same way, and `test/worktree-residue.test.mjs` stages each one
against a real repository.

## Why the primitive and not the call site

A guard at one call site answers for one call site. The next step that needs a
worktree either repeats the guard or reopens the wedge, and a guard written at
a call site tends to check only the shape that was seen: a step that looks for
a directory does not see a registration whose directory is gone. The
primitive is the one place every creation passes through, so the property is
carried by construction and cannot be forgotten by a new caller.

## Why deleting on a retry is safe

The only directory this can delete is one the run made for itself, inside the
workspace root that carries the run's own id, and the workspace root is
created at provision and deleted at close. A run id names one launch: the
daemon refuses a launch whose run already has a ledger, so a path under a run's
workspace root at creation time is residue of that same run and of nothing
else. Nothing the run earned lives there either. A worktree that is being
created has not been read yet, and the work a run keeps lives in commits on
its branch and in the artifacts under its run directory, neither of which is
inside the tree being cleared.

## Adversarial reading

The risk this adds is a delete on a path a caller names. The containment is
the bound, which is asserted in code rather than documented, and which is
tested from the outside: a clearing pointed at a directory beside the
workspace is refused and that directory still holds its file afterwards. The
risk it removes is a run that no retry can move.

## Fallback paths

If a residue clearing is ever found to have deleted something a run still
needed, the clearing narrows from the whole path to a rename: the residue is
moved aside inside the workspace root instead of deleted, and the release at
close takes it. Trigger: a run that lost work at a stage retry. Reversal cost:
low, one call in `clearWorktreeResidue`, at the price of a workspace that
carries its own dead trees until close.

If the extra `worktree list` that the creation reads proves to cost a
measurable part of provisioning on a clone with many worktrees, the read moves
behind the add: the add runs first and the clearing happens only on the
message match. Trigger: a provision whose worktree step is dominated by the
list. Reversal cost: trivial, the two halves of `addWorktree` swap order, at
the price of depending on git's wording for the ordinary case.

If git ever answers a residue condition in words this does not match, the
match list grows. Trigger: a stage that fails an add with the directory
already gone. Reversal cost: trivial, one phrase in `RESIDUE`. The proactive
clearing already covers every state that is readable, so the list is the
second line of the answer and not the first.
