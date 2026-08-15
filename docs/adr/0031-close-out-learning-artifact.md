# ADR-0031: The close-out learning artifact

Status: accepted (2026-08-15)

## Decision

A project may ask for one extra close-out seat on a shipped story: a seat
that writes a human-readable learning artifact about what shipped. The
harness wires the seat and records the outcome; the owner supplies the
conduct.

- **Optional, by project config.** `closeout.learning` names two absolute
  host paths: `instructions`, the file whose text is the seat's conduct,
  and `workspace`, the directory the artifact lives in. No block, no seat,
  no stamp, no behavior change of any kind. The block validates like every
  other section — an unknown key, a missing path, or a repo-relative path
  is a config error at launch.
- **Story-lane close-out only.** The seat runs after the card sweep and the
  reconciliation judgment (ADR-0026), against the merge commit, as the last
  act before the ledger closes. A repair-lane run never reaches it: a
  repair has no card, no story spec, and nothing to teach from.
- **The instructions are the conduct.** The harness reads the file and
  carries its text in the role block. It states what the artifact is, how
  the workspace is organized, and how the writing reads. The harness's own
  role text says only what the harness owns: write inside the workspace and
  nowhere else, change nothing in the repository, judge nothing about the
  code, and report the files written. The seat's inputs are the shipped
  story's identity — the run's spec, the card key, the merge commit, the PR
  number.
- **Fresh context, default seat.** Model and effort come from the seat map
  like every other seat. The seat carries no constitution: its authority is
  the instructions file, and a second policy document would compete with it.
- **Every failure is quiet and the close proceeds.** An unreadable
  instructions file, a workspace that cannot be created, a worktree that
  cannot be prepared, a seat that fails or dies: each one stamps
  `learning-lesson` with `ok: false` and the reason, and the close continues
  as if the block were absent. One attempt. No retry allowance above the
  seat runner's own crash allowance, no park, no loud item, no failed close.
  Success stamps `ok: true` with the artifact paths the seat reported.

## Why the harness holds no opinion about the artifact

What is worth learning from a ship is the owner's judgment, and it changes
as a project matures. A harness that encoded it would own a document it
cannot evaluate, and every change to the teaching would be a harness
change shipped through the harness's own pipeline. A file path instead
gives the owner the whole conduct — the artifact's shape, the workspace's
organization, the voice — and leaves the harness with the two things it is
good at: knowing when a story shipped, and recording what happened.

## Why the failure isolation is absolute

This is the only close-out step whose absence costs the project nothing.
The card sweep keeps the story graph honest; the reconciliation judgment
keeps the decision records honest; both earn their place in the close. A
learning artifact is a gift to a future reader. A gift may never delay a
merged story's close, park a run, or raise an alert the owner has to clear
at the end of work that already succeeded — so the step has exactly one
outcome shape: a stamp, and then the close.

## Why the stamp is never silent

A quiet feature and an invisible feature are different things. A block that
was configured but silently never ran would be indistinguishable from a
block that is working, for as long as nobody opens the workspace. Both
outcomes land in the run ledger, so the question "did the last ten ships
leave lessons" is a ledger read, and the eval seat can count the misses.

## Why absolute paths in project config

Every other path in project config is repo-relative, because the ownership
test puts repo facts in the project's repository. These two are absolute on
purpose: the run's worktree is created at launch and removed at close, so
an artifact written into it would not survive the run, and the instructions
are the owner's standing teaching rather than a file of the project's code.
The block still lives in project config because whether a project teaches
is a fact about that project, not about the machine that builds it.

## Fallback paths

If one artifact per ship proves too much (repetition, thin lessons), gate
the seat on a condition the ledger already holds — story size, a first ship
of a card, a cadence — with the same stamp and the same isolation. Trigger:
the workspace fills with lessons nobody reads. Reversal cost: low, a
condition at one call site.

If the workspace needs to be a repository of its own (versioned, shared,
reviewed), let the seat write into a clone the harness prepares and push it
like the card sweep pushes cards. Trigger: the owner asks for the lessons
to live where the team reads them. Reversal cost: medium — clone and push
machinery on a step that today touches nothing.

If quiet failure proves too quiet — misses accumulating unnoticed — leave
the run close untouched and let a tripwire watch the miss rate over a
window of ships (ADR-0021's shape). The escalation belongs to the watcher,
never to the close. Reversal cost: low, a tripwire entry.
