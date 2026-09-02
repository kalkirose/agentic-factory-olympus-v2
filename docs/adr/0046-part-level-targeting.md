# ADR-0046: Part-level targeting inside a gate layer

Status: accepted (2026-08-28)

## Decision

A verdict cycle re-runs the parts of a gate layer that its diff could have
reached, and carries the rest of that layer's greens forward, marked. The rule
applies to every Tier-1 layer whose command names its parts. The acceptance
layer is the one that pays for it today, and nothing in the mechanism knows
which layer that is.

- **A layer's command declares its own parts, and their inputs.** The marker
  protocol a command prints (`::olympus part`, `::olympus part-failed`) carries
  two lines for this: `::olympus part-ok <name>`, which says a part finished
  and passed, and `::olympus part-inputs <entry> …`, which names the
  repo-relative path entries that could change what the part in flight
  decides. The entries are read in the same vocabulary as the rest of the
  project config, a plain prefix or a glob. The harness holds no map of its own
  and learns nothing about a project's layout: a step that knows its workspace
  filter is the only thing that can state that step's input set, so it states
  it.
- **A part is affected unless the diff falls FULLY outside its input set.**
  A part that declared no input set is affected by everything. A changed path
  no part's input set claims, such as a lockfile, a shared package, a
  migration, a config file, or a path nobody thought about, makes every part of
  that layer affected. Doubt always re-runs.
- **A part that was not proven green never carries.** A red part re-runs, and
  so does a part that said nothing about itself inside a failure. A part is
  green on its own `part-ok`, or on an exit code of zero for the whole command,
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
- **The certifying cycle proves every part at its own sha, and buys only the
  parts nothing proved there.** The confirmation sweep (ADR-0022) will not
  stand on a result that carried anything. What it re-runs of such a layer is
  the carried parts alone, named in `OLYMPUS_PARTS`. The parts the cycle
  already ran at this sha it keeps, each carrying the `attempt` and the ledger
  `seq` of the pass that ran it, and the parts the sweep itself ran carry
  `confirmation`. The merged result holds no `carriedFrom` on any part, so no
  green verdict ever rests on a part that did not run at the sha the record is
  about.
- **Every carry and every keep is visible.** `layer-result.parts[]` is the
  layer's whole part table: each part's name, what it decided, what could
  change that, and its provenance. `carriedFrom` names the cycle whose
  execution earned a carried green; `attempt` and `seq` name the execution of
  THIS cycle that earned a kept one. The verdict record states `run` or
  `carried` per part with the same provenance, the repair seat's layer line
  names how many parts of a layer it is reading were carried and from where,
  and the verdict record and the `verdict-rendered` event state
  `confirmationParts` (`ran`, `kept`) for what the sweep bought and what it
  stood on.
- **The seats spend from the same clock.** The dev and repair briefs name the
  mapping and the variable, so a seat checking its own work narrows the layer
  the same way the cycle that judges it will.

The derivation lives in `partPlan()` in `src/lanes/parts.mjs`, which is pure
and reads a standing result and a file list. The cycle's per-layer diffs live
in `partTargets()` in `src/lanes/verdict.mjs`, beside the plan it extends. The
protocol lives in `src/lanes/exec.mjs` with the markers it grew from, and the
narrowing, the merge and the sweep's own plan live in `src/lanes/spectrum.mjs`.

## What this is for

ADR-0022 stopped a cycle re-running the layers a repair could not have
reached. It left the layers themselves all-or-nothing. On the reference
project, two measured verdicts spent 197 and 235 minutes in gate commands, and
the acceptance layer alone was 138 and 166 of those: about twenty-one suites,
each paying a full application boot and a full migration chain before its
first assertion. A repair that changed one email template re-bought all of it.

The saving is the repair cycles in between, which is where the repeated hours
are, and the slices of the certifying cycle that the cycle before it already
proved.

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

The three classes ADR-0022 named as the reason not to map files, a config
file, a lockfile and a shared fixture, are exactly the paths no step's filter
covers. That makes them recognizable without recognizing them: a path under no
declared input set is a path the mapping cannot speak about, and the only
sound thing to say about it is that it could reach anything. The rule needs no
list of dangerous paths, so it cannot be wrong about a dangerous path nobody
put on the list.

## Why a part's green needs its own word inside a failure

The win this decision is about is the red layer, not the green one: a green
layer is already carried whole. A red layer's exit code says one of its parts
failed, and says nothing about the others, which is precisely the case the
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
the carry says nothing false about it, because the part was green at the sha it
names, but it is stale.

Both are bounded by the same rule that bounds every other gap here: the cycle
whose green ships proves the layer whole, so a new part runs before any verdict
rests on it and a removed part leaves the table on the same pass. The worst
case is a red found one cycle later than a full re-run would have found it,
which is the trade ADR-0022 already made at layer granularity.

## Why the sweep buys the carried parts and keeps the rest

Carrying is sound for a red verdict and unsound for the last cycle before
green, which is the moment the record becomes a claim about the whole tree.
ADR-0022 answered that at layer granularity with the confirmation sweep. The
same answer at part granularity is one condition: a result that carried a part
is not yet a result about this sha.

What that condition does NOT justify is re-running the parts the same cycle
already ran. Those parts ran against this commit, this freeze and this machine,
minutes earlier, and buying them again produces the same answer at the price of
the layer. So the sweep asks for the difference: the carried parts, and nothing
else. The record it writes is the whole table either way, because the claim the
verdict ships on is about every part of the layer and not about the parts the
sweep happened to execute.

The re-run stays idempotent by construction. The stamp it writes carries
nothing, so a daemon that comes back reads a result with no carry in it and
runs nothing again. A result that carried a part and ran none of its own is the
degenerate case, and it takes the whole re-run: there is nothing to keep.

## Why the record holds the whole part table

A verdict record is read as evidence, and a carried green that reads like a
fresh one is the failure mode this whole family of decisions is written
against. So a layer's parts are recorded whether they ran or not, each with
what it decided and where its answer came from. The output stays on the
evidence subset alone: a triage brief that read out twenty passing parts to
reach the failing one would bury the failure it exists to surface.

`confirmationParts` exists for the same reason one level up. A sweep that
quietly stopped narrowing would cost the same hours this decision removed and
would look, in every other field of the record, exactly like a sweep that
worked. `ran` reaching a layer's whole part count while `kept` is nought is
that failure, as a number a tripwire can read.

## Replay

The plan reads the ledger and the git tree, and holds no position. Its inputs
are the standing `layer-result` of each layer the cycle runs, the last
`re-freeze` line, and the diff between two shas. A daemon that dies mid-cycle
re-derives the same plan when it comes back, and the layers already stamped
under this cycle are skipped as they always were. A daemon that dies inside
the confirmation sweep reads the carrying result still standing, plans the same
narrowed re-run, and runs the layer it was going to run.

## Fallback paths

If part-level carrying ever ships a defect the confirmation sweep then found,
such as a part a diff reached that the mapping said it could not, the project
sets `gates.partTargeting: false` and every layer re-runs whole again, exactly
as before this decision. Trigger: one such red. Reversal cost: none, one config
field; the code stays and goes inert.

If the sweep's own narrowing is the half that proves unsound, because a part's
green depends on a part running beside it in the same execution, the retreat is
the one condition in `planLayer()`: a same-cycle result that carried anything
is discarded whole and the layer runs entire, which is what the sweep did
before. Trigger: a red found after a merge whose part was green in a narrowed
pass and would have been red in a whole one. Reversal cost: low, one rule in
one function, and no config or record shape changes with it.

If the input declarations prove unreliable for one project while another is
fine, the flag is per project already, because it is project config. The
narrower reversal is a runner that stops printing `part-inputs`: a part with
no declared input set is affected by everything, so a project retreats one
part at a time by deleting one line.

If the exit-code reading of a green proves too generous, meaning a command that
exits zero while a part it opened did not actually run, the reading drops and a
part is green only on its own `part-ok`. Trigger: one carried part whose
carried green was later contradicted by the sweep. Reversal cost: none, one
clause in `recordedParts()`, and every adopting runner already prints the
line the stricter rule needs.

If the per-part diff proves too coarse for a project whose parts share a
source tree, so that every part declares the same directory and nothing ever
carries, the declaration grows rather than the rule: the parts state narrower
entries. Nothing in the harness changes, because the harness holds no opinion
about what a part's inputs are.
