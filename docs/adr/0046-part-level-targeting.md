# ADR-0046: Part-level targeting inside a gate layer

Status: accepted (2026-08-28)

## Decision

A verdict cycle re-runs the parts of a gate layer that its diff could have
reached, and carries the rest of that layer's greens forward, marked. The rule
applies to every Tier-1 layer whose command names its parts — the acceptance
layer is the one that pays for it today, and nothing in the mechanism knows
which layer that is.

- **A layer's command declares its own parts, and their inputs.** The marker
  protocol a command already prints (`::olympus part`, `::olympus part-failed`)
  gains two lines: `::olympus part-ok <name>`, which says a part finished and
  passed, and `::olympus part-inputs <entry> …`, which names the repo-relative
  path entries that could change what the part in flight decides. The entries
  are read in the same vocabulary as the rest of the project config — a plain
  prefix or a glob. The harness holds no map of its own and learns nothing
  about a project's layout: a step that knows its workspace filter is the only
  thing that can state that step's input set, so it states it.
- **A part is affected unless the diff falls FULLY outside its input set.**
  A part that declared no input set is affected by everything. A changed path
  no part's input set claims — a lockfile, a shared package, a migration, a
  config file, a path nobody thought about — makes every part of that layer
  affected. Doubt always re-runs.
- **A part that was not proven green never carries.** A red part re-runs; so
  does a part that said nothing about itself inside a failure. A part is green
  on its own `part-ok`, or on an exit code of zero for the whole command,
  which speaks for everything that command ran.
- **The narrowing is asked for, never imposed.** The parts a cycle wants are
  named in `OLYMPUS_PARTS` on the layer command's environment. A command that
  does not read it runs everything, which costs the cycle time and costs the
  record nothing: what a result holds is what the stream said ran, and a part
  the command ran anyway keeps its own fact over any carry.
- **The carry is cycle-to-cycle, inside one pass, against one frozen suite.**
  The diff a part is judged against runs from the sha that earned its green to
  the sha this cycle judges, per layer. A re-freeze invalidates every carry:
  the amendment moves the suite the parts were judged against, and that half of
  the pair is not visible in a diff of the candidate tree.
- **The certifying cycle runs every part.** The confirmation sweep (ADR-0022)
  refuses to reuse a result that carried anything: the layer runs again, whole,
  and the stamp it leaves carries nothing. So no green verdict ever rests on a
  part that did not run at the sha the record is about.
- **Every carry is visible.** `layer-result.parts[]` is the layer's whole part
  table — each part's name, what it decided, what could change that, and, on a
  carried part, `carriedFrom`: the cycle whose execution earned the green. The
  verdict record states `run` or `carried` per part with the same provenance,
  and the repair seat's layer line names how many parts of a layer it is
  reading were carried and from where.
- **The seats spend from the same clock.** The dev and repair briefs name the
  mapping and the variable, so a seat checking its own work narrows the layer
  the same way the cycle that judges it will.

The derivation lives in `partPlan()` in `src/lanes/parts.mjs`, which is pure
and reads a standing result and a file list. The cycle's per-layer diffs live
in `partTargets()` in `src/lanes/verdict.mjs`, beside the plan it extends. The
protocol lives in `src/lanes/exec.mjs` with the markers it grew from, and the
narrowing, the merge and the sweep's refusal live in `src/lanes/spectrum.mjs`.

## What this is for

ADR-0022 stopped a cycle re-running the layers a repair could not have
reached. It left the layers themselves all-or-nothing. On the reference
project, two measured verdicts spent 197 and 235 minutes in gate commands, and
the acceptance layer alone was 138 and 166 of those — about twenty-one suites,
each paying a full application boot and a full migration chain before its
first assertion. A repair that changed one email template re-bought all of it.

The saving is the repair cycles in between, which is where the repeated hours
are. The certifying cycle is untouched in what it proves and in what it costs.

## Why the command declares the mapping, and not the config

ADR-0022 rejected a file-to-layer map on the ground that no project config
holds one and no harness can infer one without being wrong somewhere. That
argument still stands for a map the harness would write. It does not stand for
a map the runner already has: a suite runner that dispatches per workspace
knows the filter it dispatched with, and the filter is the input set. Asking
the command to print what it already knows costs the project a line per part
and costs the harness no knowledge of the project at all.

A config-held map would also drift. A config entry and a runner step are two
statements of one fact, and the config copy is the one nobody edits when a
suite moves. The declaration rides the run that dispatched it, so a part that
moved declares where it moved to on the next cycle that runs it.

## Why an unattributable path re-runs everything

The three classes ADR-0022 named as the reason not to map files — a config
file, a lockfile, a shared fixture — are exactly the paths no step's filter
covers. That makes them recognizable without recognizing them: a path under no
declared input set is a path the mapping cannot speak about, and the only
sound thing to say about it is that it could reach anything. The rule needs no
list of dangerous paths, so it cannot be wrong about a dangerous path nobody
put on the list.

## Why a part's green needs its own word inside a failure

The win the plan is about is the red layer, not the green one: a green layer
is already carried whole. A red layer's exit code says one of its parts
failed, and says nothing about the others — which is precisely the case the
part markers were introduced for. So the parts that passed have to say so
themselves. A part that opened, printed, and never reported an outcome is
`unknown`: the runner may have died in it, and a status inferred from silence
is the one way this rule could ship a false green.

The one inference kept is the whole command's exit code of zero. A command
that exited zero passed everything it ran, and reading that as a green for
each part it opened is reading the command's own claim rather than filling in
a gap.

## Why a part the table does not hold is the sweep's business

The table a cycle narrows from is the one the layer's last execution wrote, so
a part a repair round *adds* is in no table and is named in no narrowing: the
command is asked for the parts that existed, and the new one does not run. A
part a repair *removes* is carried under a name the command no longer has, and
the carry says nothing false about it — the part was green at the sha it names
— but it is stale.

Both are bounded by the same rule that bounds every other gap here: the cycle
whose green ships runs the layer whole, so a new part runs before any verdict
rests on it and a removed part leaves the table on the same pass. The worst
case is a red found one cycle later than a full re-run would have found it,
which is the trade ADR-0022 already made at layer granularity.

## Why the confirmation sweep refuses a carried result

Carrying is sound for a red verdict and unsound for the last cycle before
green, which is the moment the record becomes a claim about the whole tree.
ADR-0022 answered that at layer granularity with the confirmation sweep. The
same answer at part granularity is one condition: a result that carried a part
is not a result about this sha, so the sweep does not accept it.

The cost is one full run of the narrowed layers on the certifying cycle, which
is what the harness paid on every cycle before this decision. The saving is
every red cycle before it. The re-run is idempotent by construction — the
stamp it writes carries nothing, so a daemon that comes back reads a full
result and runs nothing again.

## Why the record holds the whole part table

A verdict record is read as evidence, and a carried green that reads like a
fresh one is the failure mode this whole family of decisions is written
against. So a layer's parts are recorded whether they ran or not, each with
what it decided and, where it did not run, the cycle whose execution earned
it. The output stays on the evidence subset alone: a triage brief that read
out twenty passing parts to reach the failing one would bury the failure it
exists to surface.

## Replay

The plan reads the ledger and the git tree, and holds no position. Its inputs
are the standing `layer-result` of each layer the cycle runs, the last
`re-freeze` line, and the diff between two shas. A daemon that dies mid-cycle
re-derives the same plan when it comes back, and the layers already stamped
under this cycle are skipped as they always were. A daemon that dies inside
the confirmation sweep finds the carrying result still standing, refuses it
again, and runs the layer it was going to run.

## Fallback paths

If part-level carrying ever ships a defect the confirmation sweep then found —
a part a diff reached that the mapping said it could not — the project sets
`gates.partTargeting: false` and every layer re-runs whole again, exactly as
before this decision. Trigger: one such red. Reversal cost: none, one config
field; the code stays and goes inert.

If the input declarations prove unreliable for one project while another is
fine, the flag is per project already, because it is project config. The
narrower reversal is a runner that stops printing `part-inputs`: a part with
no declared input set is affected by everything, so a project retreats one
part at a time by deleting one line.

If the exit-code reading of a green proves too generous — a command that exits
zero while a part it opened did not actually run — the reading drops and a
part is green only on its own `part-ok`. Trigger: one carried part whose
carried green was later contradicted by the sweep. Reversal cost: none, one
clause in `recordedParts()`, and every adopting runner already prints the
line the stricter rule needs.

If the per-part diff proves too coarse for a project whose parts share a
source tree — every part declaring the same directory, so nothing ever carries
— the declaration grows rather than the rule: the parts state narrower
entries. Nothing in the harness changes, because the harness holds no opinion
about what a part's inputs are.
