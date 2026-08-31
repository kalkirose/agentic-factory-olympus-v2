# ADR-0060: The declared ground is checked before the freeze

Status: accepted (2026-08-31)

## Decision

A project may name, in `lanes.story.groundCommand`, the command that checks the
declared ground of its own test suite. Every suite write of the pre-freeze chain
runs it, over the tree as the seat left it and before anything is committed.

- **A red is a work-product defect.** It re-briefs the suite seat with the
  check's own output, on the contract loop the lane already has: one corrective
  invocation, then the seat-failure park.
- **A command that could not run is not a defect of the suite.** It is stamped
  and it parks under `command-error`, which is where every unrunnable command
  goes. The seat is not asked to repair a host.
- **The stamp is `ground-check`**, carrying the phase of the write and one of
  `green`, `red`, `unrun`.
- **A project that names no command runs no step**, stamps nothing, and behaves
  exactly as it did before the field existed.
- **The strictness belongs to the project.** The argv is the project's own, so
  the entry names the strict form of the check rather than the lenient form a
  gate layer may run.

## What this is for

Declared ground is what lets a verdict cycle skip a test file: the file names
the repository paths that can change its answer, and a cycle whose diff misses
all of them carries the file's last green instead of running it again.

A suite file that declares nothing costs a skip and nothing else. It is a lost
saving, never a wrong answer — an undeclared file is affected by every change,
which is the conservative direction.

The check that finds such a file is the project's, and it used to run in one
place: as a gate layer, after the freeze. That is the worst possible moment. The
file is frozen by then, so the correction is not an edit; it is a repair round
against a frozen surface, a re-freeze, and a second verdict. Three runs paid
that inside one week, for files that asserted exactly what they were supposed to
assert.

Running the same check while the seat that wrote the file is still live turns
the whole of that into one line in a brief.

## Why every suite write, not only the authoring round

The pre-freeze chain writes a suite four times: the authoring round, an
amendment after an adversary survivor, a strengthening round after a zero-kill
round, and the red-state fix. Each of them can add a file, and a file added by
any of the last three would reach the freeze past a check that ran only at the
first.

The cost of asking four times is one static sweep per suite-seat invocation. The
cost of asking once is the class staying open for three of the four writers.

## Why an unrunnable command is not a defect of the seat

A check that could not start says nothing about the suite. Handing that to the
seat as a defect spends a corrective invocation on a brief no seat can answer,
and then parks the run under a seat failure that names the wrong thing. The two
answers are kept apart at the stamp — `red` against `unrun` — and the route
follows the stamp: a red goes to the seat, an unrun goes to the operator with
the environment defect it is.

## What a reader can ask of this

The reds are the saving: each one is a repair round, a re-freeze and a verdict
cycle that did not happen. They are counted off the `ground-check` stamps.

The failure signal is a story run that reaches `freeze` with no `ground-check`
behind it, in a project whose config names the command. That means the step
stopped running, and nothing else in the ledger would say so. A run of `unrun`
stamps says the same about the host.

If the reds stay at zero over many runs and no repair round after a freeze ever
cites declared ground, the class is gone and the step is cheap insurance. If a
declared-ground defect is found after a freeze even once while this runs, the
check is not strict enough, and the fix is in the command, not here.

## Fallback paths

If the check proves too slow or too noisy for a project, the project deletes
`lanes.story.groundCommand`. The step disappears, the class comes back, and the
project's gate layer finds the defect after the freeze as it did before.
Trigger: a step that costs more per run than the repair rounds it saves.
Reversal cost: one config line.

If a project wants the check at the authoring round alone, it does not get it
here: the four writers are one class, and a rule that covers one of them is the
condition this record exists to remove.
