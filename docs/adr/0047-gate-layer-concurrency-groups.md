# ADR-0047: Gate layers that hold the machine together

Status: accepted (2026-08-29)

## Decision

A project may name groups of Tier-1 layers that are allowed to run at the same
time. The groups run in order, the layers of one group run together, and a
project that names none runs the strict sequence it ran before this decision.
The harness measures nothing and decides nothing about which layers those are.

- **The field is `gates.concurrencyGroups`: a list of lists of layer names.**
  Absent is the sequence. That is the whole of the configuration surface, so
  arming the concurrency, tuning it and reverting it are edits of one field
  and no edit of any code.
- **Batching merges neighbours; it never reorders.** The layers keep the
  positions the project declared them in. A layer joins the batch in flight
  only when it follows one of its own group immediately in that order, so
  every `needs` still points at a layer that settled in an earlier batch. A
  group whose members the declared order separates buys nothing for the
  separated member, which is the sequence it would have had: the degradation
  is always toward the behaviour of an absent field.
- **A layer never runs beside a layer it needs.** The config check refuses the
  contradiction, and the runner refuses it again on its own, because
  `runSpectrum` answers callers that read no config. Both check the direct
  `needs` and that is enough: a prerequisite reached through another layer has
  that layer between the two in declared order, because `needs` may only name
  an earlier layer, and two layers with something between them are not
  neighbours and never batch.
- **Every layer keeps everything that was its own.** Its own start stamp and
  terminal stamp, its own attempt numbering and flake filter, its own log
  file, its own part table, and its own resource reading, which is measured
  over that layer's process tree alone (ADR-0045). Nothing about a layer's
  record depends on what ran beside it.
- **What a concurrent layer says beyond that is who it ran beside.**
  `concurrentWith` rides `layer-started`, the terminal stamp, the spectrum
  result and the verdict record. It names the layers of the batch that
  actually executed beside this one, and only those: a batch-mate this cycle
  had already stamped, one that carries a green forward, and one its
  prerequisite made not-runnable all hold the machine for none of it. So the
  batch is decided whole before any of it is dispatched, and what is left is
  what really ran together. The field is absent for every layer that ran
  alone, which is every layer of every project that named no group.
- **A result set stays in declared order.** The batch is decided before
  anything is recorded, so the record reads the same whichever child finished
  first, and a command that could not run at all ends the spectrum at the
  first such layer in declared order rather than at whichever one failed
  first.

The batching lives in `layerBatches()` in `src/lanes/schedule.mjs`, which is
pure and reads a layer list and a group list. The runner's half is the batch
loop in `src/lanes/spectrum.mjs`; the config's half is
`validateConcurrencyGroups()` in `src/config/project.mjs`.

## What this is for

On the reference project, two measured verdicts spent 197 and 235 minutes in
gate commands. Two of the layers in them, on different substrates, spent about
22 and about 20 minutes each and used the machine in different ways. Run
together they cost the wall of the longer one.

This is a trial, and it ships as one. The engine change is generic scheduling
against a config field; which layers a project tries, for how many verdicts,
and whether it keeps them are decisions the project makes in its own config
and records in its own execution record. Nothing in the harness knows that a
trial is running.

## Why the field is a list of groups and not a width

A concurrency width ("run two layers at a time") is a statement about the
machine, and the harness would then be choosing which layers to pair. The
choice is the whole risk: two layers that share a database, a port, a
container name or a docker daemon are exactly the pair that must not be
chosen, and no property the harness can read says which pair that is. A named
group is the project stating what it knows about its own substrates, which is
the same shape every other gate decision here takes: the project declares, the
harness runs what was declared.

It also makes the revert exact. A width would have a safe value and a set of
unsafe ones; a group list has one absent state that is the old behaviour, and
removing a group removes exactly the concurrency it named.

## Why the record has to say what overlapped

A duration read from a ledger is the span between a start stamp and an end
stamp. Two spans that overlap are not two spans that followed each other, and
nothing else in the ledger distinguishes them: without `concurrentWith`, the
sum of a cycle's layer durations would read as the cycle's wall, and the trial
this field exists for would be measured with the instrument it broke.

The same holds for memory. Each layer's peak is measured over its own process
tree, so a concurrent layer's reading is still that layer's own honest peak.
What changes is the host: two trees at their peaks at the same time cost the
machine the sum. A reader who wants the host figure needs to know which
readings overlapped, and only the runner knows.

That is also why the field names what executed rather than what the group
holds. A trial is read by summing the peaks of the layers a record says ran
together; a carried layer in that list would add a peak nothing paid for, and
the reading would be wrong in the direction that hides a problem.

## Why the sequence has to be provably untouched

Every project that has ever run this harness ran the strict sequence, and the
one thing a scheduling change must not do is change what a gate decides. The
absent field is therefore not a default that happens to behave the old way: it
produces batches of one layer, and a batch of one awaits exactly the one call
the loop awaited before. The tests hold both halves of that: with no group
declared no two layer commands overlap in time, and the decision a cycle
reports is the same one either way.

## Replay

A daemon that dies mid-batch comes back and reads the ledger, as it always
did. A layer stamped under this cycle reports `run` whatever the plan says, so
the layers of a batch that finished are skipped and the rest run again. Two
layers of one batch that both died leave two unpaired `layer-started` stamps,
which the recovery guard closes independently (ADR-0034): the pairing is keyed
by cycle, layer and attempt, and never by adjacency in the ledger.

## Fallback paths

If a trialed group produces a red that triage attributes to contention, or the
host's memory goes over the ceiling the project stated for the trial, the
project deletes the group from `gates.concurrencyGroups`. That is the whole
revert: the layers return to the sequence, the engine keeps the capability and
goes inert. Trigger: one contention-attributed red, or one measurement over
the ceiling. Reversal cost: none, one config field.

If one layer of a group is the problem and the rest are fine, the group loses
that name and keeps the others, which is the same edit at a finer grain.

If concurrency proves sound but the machine is the limit, the answer is fewer
layers per group rather than a new mechanism: the group list already expresses
every width a project can want, one group at a time.

If the record's `concurrentWith` ever proves insufficient for reading a trial,
for a group whose layers overlap only partly and whose peaks may or may not
have coincided, the reading that answers it is a sampled host total, which is a
measurement decision of its own and not a change to this one. Nothing here
would have to be undone for it.
