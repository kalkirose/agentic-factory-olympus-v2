# ADR-0071: The checks over a suite write are the project's own ordered list

Status: accepted (2026-09-05)

## Decision

`lanes.story.suiteChecks` is an ordered list of names from the project's
`commands` table. It is what runs over every suite write (ADR-0060).

- **The order is the project's, and it carries every dependency.** A type check
  that needs generated packages built names the build before it in the list. The
  harness runs the names in the order it reads them and holds no dependency
  graph of its own.
- **Every check runs, even after a red.** The lane gives a seat one corrective
  invocation and then parks. A list that stopped at the first red would hand the
  seat one fault, spend its round, and park on the second fault the next check
  would have named. One brief carries every red, each with its own command's
  output.
- **The list ends at a command that could not run.** Every check after it would
  run on the same broken host and could say nothing about the suite. One `unrun`
  stamp names the command, and the run parks under `command-error`.
- **A name the command table does not hold is refused at the launch.** The
  config validator reads the list against `commands`, and it refuses a name
  twice over, because a check that runs twice buys nothing the first run did
  not.
- **`lanes.story.groundCommand` is the one-entry form this replaced.** It is
  still read where no list is present, so a config written for the older harness
  keeps exactly the check it had. Where both are present, the list is what runs,
  and the validator holds the two to the same set.

## Why a list and not one command

A suite file is judged by every gate layer that reads a test path, and there
are many of them: type checks that compile the test trees, linters that lint
them, static gates that read them. The pre-freeze step used to run one command,
and one command is one of those layers. Every other layer first read the file
after the freeze, where reading it is expensive (ADR-0060).

So the shape of the old field was the defect. It let a project state that its
suite is checked before the freeze while all but one of the checks that judge
the suite still ran only after it. A project cannot name what it needs in one
string, and a harness that accepts one string has decided the answer for every
project that has more than one check.

The list is also the whole of the sequencing question. Checks depend on each
other, and the dependencies are the project's facts, not the harness's. A
harness that built a graph here would need a second declaration of what needs
what, beside the one the gate layers already carry, and the two would drift.
An ordered list carries the same information with nothing to keep in step.

## Why both fields are read for one release

A daemon runs a pinned copy of this code, and a project's config lives in that
project's repository. The two move on their own schedules, and one of them
moves first.

A daemon on the older code reads `groundCommand` and does not know the list. A
daemon on this code reads the list and falls back to `groundCommand`. So a
config that carries both is correct under either pin, and the project can merge
its config before the daemon moves or after it, with no window in which no
check runs.

The validator holds the two to the same set for the length of that window: a
check the list drops would still run under the older pin, and a difference
between two daemons that nobody declared is the kind of fact that is found by
a red nobody can explain.

## Why every check runs even after a red

The alternative is cheaper per write and more expensive per run. Stopping at
the first red saves the seconds of the checks behind it, and spends the seat's
single corrective round on one fault of the several the tree holds. The next
check then reds on the corrected tree, the seat has no round left, and the run
parks under a seat failure for a fault it was never told about.

The saving is seconds; the cost is a park and a human. The list runs to its end.

## Fallback paths

If running every check after a red proves wasteful for a project whose checks
are minutes rather than seconds, the rule gains a bound rather than an early
exit: the list runs to its end on the first invocation of a seat and stops at
the first red on later ones, when the seat has already been told what the tree
holds. Trigger: a measured pre-freeze check cost above the verdict cycles it
saves. Reversal cost: low, one condition in the loop.

If a project needs two different lists, one before the freeze and one at the
re-freeze, the field becomes two fields with the same validation and the same
stamps. Trigger: a check that is sound on a tree with no implementation and
wrong on one with an implementation, or the reverse. Reversal cost: low, one
config field and one call site.
