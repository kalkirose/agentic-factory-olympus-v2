# ADR-0060: A suite write is checked while the seat that wrote it is live

Status: accepted (2026-09-05)

## Decision

Every write of a suite file in a story run runs the project's own checks over
the tree as the seat left it, before anything is committed.

A story run writes its suite five times: the authoring round, an amendment
after an adversary survivor, a strengthening round after a zero-kill round, the
red-state fix, and the re-freeze amendment that answers a suite defect after
the freeze. Each of the five can add a file or change one, so each of the five
runs the checks.

- **A red is a work-product defect.** It re-briefs the seat with the check's
  own output, on the contract loop the lane already has: one corrective
  invocation, then the seat-failure park.
- **A command that could not run is not a defect of the suite.** It is stamped
  and it parks under `command-error`, which is where every unrunnable command
  goes. The seat is not asked to repair a host.
- **The stamp is `suite-check`**, one per check, carrying the command, the
  write it ran over, how long it took, and one of `green`, `red`, `unrun`.
- **A project that names no checks runs no step**, stamps nothing, and behaves
  exactly as it did before the field existed.
- **The strictness belongs to the project.** The argv is the project's own, so
  an entry names the strict form of a check rather than the lenient form a gate
  layer may run.

## What this is for

The same check costs two different amounts, and the difference is where the
repair lands.

Run here, the file is not committed and the seat that wrote it is still in the
run. The correction is one line in a brief, and the seat is the one that made
the fault.

Run after the freeze, as the gate layer it also is, the file is frozen. No seat
may edit it. The correction is a triage seat to classify the red, a repair
round against a frozen surface, a re-freeze amendment, and a second verdict
cycle over every layer. The reds are attributed to the implementation pass that
was running, which never wrote the file, so the record of the run is wrong
about its own cost as well.

That difference is paid per defect, and the defects are ordinary ones: a cast a
type checker refuses, an unused constant, a character a linter forbids. They
are the cheapest class of fault to fix and the most expensive to find late.

## Why every suite write, and not the authoring round alone

Four of the five writes come after the first. An amendment answers an adversary
survivor, a strengthening round answers a zero-kill round, the red-state fix
answers a red the freeze refused, and the re-freeze answers a suite defect the
verdict found. Every one of them may write a new file or edit an old one.

A check at the authoring round alone covers one writer and leaves the class
open for four. The cost of asking at all five is one static sweep per suite-seat
invocation. The cost of asking once is the class staying open for the other
four, and the re-freeze is the worst of them: it is the amendment that repairs
one gate red, and without the checks it can freeze a second one.

## Why an unrunnable command is not a defect of the seat

A check that could not start says nothing about the suite. Handing that to the
seat as a defect spends a corrective invocation on a brief no seat can answer,
and then parks the run under a seat failure that names the wrong thing. The two
answers are kept apart at the stamp, `red` against `unrun`, and the route
follows the stamp: a red goes to the seat, an unrun goes to the operator with
the environment defect it is.

## What a reader can ask of this

The reds are the saving. Each one is a triage seat, a repair round, a re-freeze
and a verdict cycle that did not happen, and they are counted off the
`suite-check` stamps. The `ms` field beside them is the price: the seconds this
step adds to a suite write, against the minutes a verdict cycle costs.

The failure signal is a story run that reaches `freeze` with no `suite-check`
behind it, in a project whose config names checks. That means the step stopped
running, and nothing else in the ledger would say so. A run of `unrun` stamps
says the same about the host.

If a defect a Tier-1 layer judges is found after a freeze even once while this
runs, the answer is in the project's list rather than here: the layer that
found it is a layer the list does not hold.

## Fallback paths

If a check proves too slow or too noisy for a project, the project removes that
entry from its list. The step for that check disappears, its class of defect
goes back to being found after the freeze, and every other check is unchanged.
Trigger: a check that costs more per suite write than the repair rounds it
saves. Reversal cost: one config line.

If a check reds on a suite for a reason the seat must not repair, the same
removal applies and is the only correct answer. A pre-freeze tree holds the
suite and no implementation, so a check that needs the implementation to be
present is a check this step cannot carry. Trigger: a red the corrective round
cannot close without writing outside the test paths. Reversal cost: one config
line.
