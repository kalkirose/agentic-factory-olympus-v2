# ADR-0022: Targeted verdict re-runs, carried greens, and the confirmation sweep

Status: accepted (2026-08-14)

## Decision

A verdict cycle re-runs what the last cycle left unproven, not the whole
Tier-1 spectrum, and no green verdict rests on a result the cycle did not earn.

- **The first cycle of an implementation pass runs the full spectrum.** So
  does the first cycle after a CI red, whose red checks name no Tier-1 layer
  of this tree. A fresh pass discards the tree, so its first cycle is a first
  cycle again.
- **Every later cycle runs the targeted set.** That set is every layer the
  cycles before it did not prove green — red, not-runnable, or never judged —
  plus every layer downstream of one of those through `gates.tier1[].needs`,
  transitively. The graph is the one the spectrum already walks to attribute a
  not-runnable layer to its root red. Repair rounds, re-freeze steps, and
  operational fixes all take this rule; their subject layers are red by
  definition, so the set is never empty by accident.
- **Every other green carries forward, marked.** The result carries the stamp
  of the cycle that earned it. It stamps nothing new, and the verdict record
  gives every layer a `mode` of `run` or `carried`. A layer stamped under this
  cycle reads `run` whatever the plan said, because the stamp is the fact.
- **A clean targeted cycle sweeps before it turns green.** Zero reds and zero
  open findings on a targeted spectrum triggers the confirmation sweep: every
  layer this cycle has not yet run, at this sha. A red it turns up enters
  triage exactly like a first-cycle red. The record and the `verdict-rendered`
  stamp carry `sweep` and, where it fired, `confirmation`.
- **Nothing else moves.** The flake filter stays one red-only re-run inside a
  cycle. Green stays zero reds and zero open findings. Triage, the response
  ladder, the repair budget, and the park machinery read the same record they
  always read.

**ADR-0007 had every Tier-1 layer run to completion per cycle. That part of it
is superseded here.**

The plan lives in `cyclePlan()` in `src/lanes/spectrum.mjs`, beside the graph
walk it shares.

## What this is for

The verdict stage runs every layer of the spectrum every cycle. On the
reference project that is 28 layers; measured verdict-stage wall-clock ran
from 36 minutes to 3h42m per run, and one run held four cycles. A repair round
typically changes a handful of files, and the cycle that judges it re-pays for
27 layers that no edit could have reached and one that could.

The cost is not only time. A cycle that takes an hour is a cycle the owner
cannot watch, and a run holding a workspace for four of them is a run the
factory cannot schedule around.

## Why the dependency graph, and not the changed files

The obvious rule is to re-run the layers whose inputs the diff touched. That
rule needs a map from files to layers, which no project config holds and no
harness can infer without being wrong somewhere — a config file, a lockfile,
or a shared fixture reaches layers nothing in its path suggests.

The `needs` graph is different: the project already declared it, the spectrum
already trusts it enough to refuse to run a layer behind a red one, and it
answers exactly the question that matters here. A layer downstream of a red
either reported not-runnable, which is not a result at all, or was judged
green against a prerequisite that has since changed, which is a result about a
tree that no longer exists. Neither is a green worth carrying, so both re-run,
however far down the chain they sit.

## Why a carried green is honest only when it is marked

A verdict record is read as evidence. The Minos judge scores against it, the
repair seat plans against it, and a human reading a shipped run reads it as
what the tree did at that sha. An unmarked carried green would say the layer
passed at this sha when the layer did not run at this sha, and the reader
would have no way to tell the two apart.

So the record names the mode of every layer, the repair seat's prompt says
which greens it is reading were carried and not re-run, and a carried result
stamps no `layer-result` of its own. The ledger holds one stamp per real
execution, which keeps it a record of what happened rather than a record of
what was believed.

## Why the confirmation sweep, and why it is not a second full cycle

Carrying greens is sound for a red verdict — the run is going back for another
repair round either way — and unsound for the last cycle before green, which
is the one moment the record becomes a claim about the whole tree. A repair
edit can break a layer no red pointed at, and a targeted set derived from reds
cannot see that coming.

The sweep costs nothing in the common case, because the confirmation runs only
the layers this cycle has not run yet. A cycle that targets four layers and
then confirms the other twenty-four executes twenty-eight layers once, at one
sha — the same work the old full-every-cycle rule did, moved to the one cycle
that needs it. The saving is every red cycle in between, which is where the
repeated hours were.

It also bounds the one gap targeting opens. A re-freeze that changes test files
could in principle turn a carried lint layer red, and the targeted set would
not know. The sweep runs before green, so the worst case is a red found one
cycle later than a full sweep would have found it. A false green is not
reachable.

## Replay

The plan reads the ledger and nothing else: the last `verdict-rendered` for
the sweep, and the `layer-result` stamps of the cycles before this one for the
targeted set. Stamps of the cycle being planned are excluded by construction,
so a daemon that dies mid-cycle derives the same set when it comes back, and
the layers already stamped are skipped as they always were. A restart after
the confirmation sweep sees every layer stamped, re-derives the same clean
result, and writes the same record.

## Fallback paths

If targeting ever ships a defect a full cycle would have caught — a red the
confirmation sweep found that the run had already reported as green work in a
seat prompt or a park question — the plan returns `{ sweep: 'full' }`
unconditionally and every cycle pays the spectrum again. Trigger: one such
red. Reversal cost: none, one early return in `cyclePlan()`.

If some projects want targeting and others do not, the same return reads a
`gates.targetedReruns` flag from project config, defaulting to on. Trigger: a
project whose layers share state the `needs` graph does not declare. Reversal
cost: low, one config field and one condition.
