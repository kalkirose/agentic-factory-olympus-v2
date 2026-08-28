# ADR-0045: A gate layer's memory is measured, classed, and forecast

Status: accepted (2026-08-28)

## The condition

The harness had no concept of resource exhaustion. A gate command's memory could
grow for weeks — a suite gains tests, a runner gains a fixture, a fixture gains a
database — and nothing in the harness measured it, warned at it, or recognized
the eventual death for what it was. The class was found by dying, twice.

Both deaths were the same shape. A layer ran for the better part of an hour, the
test runner under it reached its heap ceiling and aborted, the workspace tool
above it reported its own exit code, and what the harness recorded was a red with
`Exit status 134` somewhere in the tail. Two expensive runs were then abandoned
after judgment seats read that tail and reasoned their way to a sentence of the
form:

> The acceptance layer dies on heap exhaustion (exit 134), not on any test. The
> run and the replay both abort at about 3.85 GB, at the same point.

That is a fact about an exit code and a number, written by a seat, in prose, once
per run. It is not a defect the harness can count, and it arrived only after the
run had already spent the hour.

Three things were missing, and each of them is cheap where it belongs.

1. **Nothing measured.** The peak the layer reached was knowable while it ran,
   from the operating system, at no cost to the command. Nobody asked.
2. **Nothing classed.** Exit 134 and its kin are mechanical. Attribution did not
   need a seat and should never have reached one.
3. **Nothing forecast.** The peak had been climbing across runs before either
   death. Every one of those runs was green, and every one of them was evidence.

The project-side memory bounds that followed each death fix today's runner. They
cannot see the next one coming. The harness can, because every gate command in
this system already flows through one primitive.

## Decision

**Three additions, all at the primitive or at the ledger. Nothing about how a
run is routed changes.**

### 1. Measure

`runCommand` takes `resources: true` and answers a `resources` record — the same
additive shape the output file is (ADR-0043): an option to ask, a field on the
result, and nothing at all for the caller that does not ask. The spectrum asks
for every layer attempt. No other caller does: a forge read that runs for a
second is not worth a sampler.

The reading is the peak memory of the process tree the command spawned, and
neither platform is asked for a number it does not already keep.

- **Windows.** One PowerShell beside the command walks the tree from the spawned
  pid on its own clock and reports `Win32_Process.PeakWorkingSetSize` summed over
  it. The sampler is a process of its own, so the command's spawn, argv and
  environment are untouched.
- **Linux.** `/proc`, read in the daemon process. `VmHWM` per process, summed
  over the tree. No child is spawned at all.
- **Everywhere else.** Nothing, said as nothing: the field is absent, never zero.

Both `PeakWorkingSetSize` and `VmHWM` are kernel-maintained high-water marks, so
a sample is not a hope of catching the spike. Measured on Windows against a real
tree: a process that allocates 600 MB and gives it back reports a 62 MB working
set and a 648 MB peak, and the peak is what this records. **The floor is
therefore a whole process, not a spike** — one born and dead inside a single
interval takes its peak with it.

The interval differs by platform because the read does: 2 seconds on Windows,
where one process-table query costs 75 ms of a core, and 250 ms on Linux, where
a `/proc` walk costs a few milliseconds and spawns nothing. The Linux floor has
to be the lower one for a second reason — the first sample of a command is taken
before the command has done anything, and on Linux there is no sampler start-up
delay to hide that. Whichever floor applied is carried on every record as
`intervalMs`, so a reader never has to assume it.

The tree total is a **sum of high-water marks**, which is an upper bound on the
simultaneous footprint rather than an estimate of it. For a forecast whose job is
to warn early, both directions of that error are the safe one.

Two guards make a tree a tree. A process that started before the root is not in
the root's tree whatever its parent id says — process ids are reused, quickly on
Windows — and a cycle in the parent map ends the walk instead of running it
forever.

The measurement rides **every** ending: green results, red results, and the
abandoned attempts the flake filter replaces. Half of a dying layer's records are
abandonments, and a history that skipped them would learn the layer's memory from
its quieter runs. A green carries it for a stronger reason: the run before the
death is green, and it is the one the forecast reads.

### 2. Classify

`resource-exhaustion` joins the closed `GATE_INTEGRITY_KINDS` vocabulary. It is
stamped at the spectrum's single settle point — the same one every terminal
layer stamp goes through (ADR-0034) — so it covers every ending an attempt has
rather than the endings somebody remembered to handle.

An ending is classed as exhaustion, in this order, when the command failed and:

- the exit is `134` (128 + `SIGABRT`) or `3221225495` (Windows
  `STATUS_NO_MEMORY`), or the signal is `SIGABRT`; or
- the output holds a memory-death signature — `JavaScript heap out of memory`,
  `FATAL ERROR: Reached heap limit`, `Exit status 134`, `ENOMEM`,
  `Cannot allocate memory`; or
- the measured peak reached the ceiling the project declared for the layer.

The middle case is not decoration: it is the case the harness actually met. The
exit code the harness saw was `1`, and the abort was only ever in the text.

Three rules bound it. **A green is never classed** — a run that peaked against
its ceiling and still passed is a forecast's business, not a death. **A signal is
never evidence on its own** — `SIGKILL` is what the daemon sends a run it is
ending, and reading that as a memory death would put the word on every stopped
run. **One record per layer while it stands open** — the flake filter gives every
red a second death, and a strip that reports the same ceiling six times reports
it worse than once.

The record is loud, names the layer, the peak and the declared ceiling, and is
owned by that layer's own green in the same run (`resolution.mjs`). A run that
never gets one leaves it open, which is the true report: the layer is still dying
and nobody has fixed it.

The attribution also leads the triage brief, exactly as the credential-absent
attribution does (ADR-0042). The seat is told, never asked.

**One death, two endings.** A heap abort reaches the harness as an exit code on
Windows (134) and as `SIGABRT` with no code on POSIX. The spectrum has always
read those differently — an exit code is a verdict it judges, a signal is a
child something took, which it abandons as `terminated` rather than reading as
a red (ADR-0034) — so the same abort produces a red on one host and a parked
`command-error` on the other. That split predates this decision and this
decision does not close it: what it does is make the two endings carry the same
word, the same peak and the same loud record, so a reader of either ledger sees
the same class. Whether a memory death should route as a red at all is the open
routing question below.

### 3. Forecast

Two standing tripwires, on the existing registry mechanics (ADR-0039), evaluated
once per verdict render rather than once per layer result.

- **`layer-peak-headroom`** — the worst layer's peak as a fraction of the ceiling
  its project declared, over the last 5 runs. Band `> 0.8`. Four fifths is where
  a layer has stopped having room for the work of a story; above it, the next
  test added to the layer is the one that kills a run, and nobody chooses which.
  A project that declares no ceiling anywhere is never eligible.
- **`layer-peak-trend`** — how many runs in a row one layer's peak has climbed,
  worst layer over the last 5 runs. Band `>= 4`. It needs no declaration of any
  kind, which is what covers every layer of every project on the day this ships.
  A step counts as a climb only if it clears both 2% and 16 MB: a layer wanders
  by a few megabytes between identical runs, and a rule with no noise floor would
  breach every window. The reading is the **tail** streak, because a climb that
  stopped three runs ago is history and this is a forecast.

A layer may declare `memoryCeilingMb` in `gates.tier1`. It is optional, it is a
statement rather than a limit — the runner's own `--max-old-space-size` still
decides when a process aborts — and the declaration rides onto each reading in
the ledger. A forecast that fetched the ceiling from today's config would read
today's number against a history measured under yesterday's.

## Why not the alternatives

**Bound the runners and be done.** That is the project-side fix, it is right, and
it was done twice. It fixes the runner in front of you. This is about the one
after it.

**Ask a triage seat to attribute it.** That is the state this replaces. It cost
two abandoned runs, and the answer both times was an exit code and a number.

**Enforce the ceiling — kill the layer at the declared figure.** The harness
would then be deciding a run's fate on a sampled reading with a stated floor, and
a sampler that kills is a sampler whose false positive is an hour of work. The
runner already enforces its own limit, honestly and exactly. This measures and
reports.

**Park the run on a resource-exhaustion red instead of routing it as a red.**
Defensible — both real incidents ended in abandonment anyway — but it is a change
to what a run does, not to what the harness knows, and it is a product-intent
call. The class has to be countable before it is worth arguing about. Left out
deliberately; see the fallback paths.

**Measure inside the command.** An injected library or a wrapped argv changes the
thing being measured and can change whether it passes. A sampler outside the tree
cannot.

**A native module for the process table.** Faster, and one more thing to build
per platform. The measured cost of the PowerShell path is 75 ms of one core every
2 seconds against a layer that runs for an hour, and it is off the command
entirely.

## Fallback paths

**The measurement, per caller.** `resources` is an option with a default of
`false`, so one call site stops measuring by dropping one word. Trigger: a host
where the sampler is unwelcome — an environment that refuses PowerShell, a
process-table read that is slow enough to notice. Reversal cost: one option at
one call site.

**The measurement, everywhere.** The spectrum asks for it in one place. Removing
that word returns every record to the shape it had, and every reader already
treats an absent `resources` as "nothing known" — which is what it means for
every ledger written before this shipped. Reversal cost: one word, no record
shape change.

**The sampling interval.** `SAMPLE_INTERVAL_MS` is one table, one entry per
platform, and the floor it sets rides every record. Either entry moves in either
direction with no consumer change. Trigger: a host where the query cost matters,
or a layer whose helpers are short-lived enough to be missed. Reversal cost: one
number.

**The classification.** The signature set and the exit codes are one table in
`resources.mjs`, and `exhaustionOf` is pure. A signature that proves too broad —
`out of memory` printed by a test's own fixture data is the plausible one — comes
out of the table without touching a call site. Trigger: a record naming a layer
that did not die of memory. Reversal cost: one table entry.

**The kind.** `resource-exhaustion` classes a record that is loud on its own; the
stamp is one call at the settle point. If the record proves to be noise rather
than news, the stamp is removed and the attribution survives on the layer result,
where the triage brief already reads it. Trigger: a loud strip the operator stops
reading. Reversal cost: one call and one ownership rule.

**The ownership rule.** The record is answered by its layer's own green. If a
project's layers are red for long enough that the strip fills with records nobody
can clear, the rule narrows to `by: 'the human, from a console'` — the same
answer `deterministic-red` takes. Trigger: open records older than the runs that
raised them. Reversal cost: one rule.

**The bands.** Both tripwires are ordinary registry entries with numbers in
`standingTripwires()`. Either one is retuned, or removed from a project's
registry, without code. Trigger: a breach the operator answers with "that is
fine" twice. Reversal cost: one entry.

**The routing question, left open.** A resource-exhaustion red is routed today
exactly as any red is: triage runs, with the attribution handed to it. If the
records show that route spending money on a class the harness has already
answered, the next step is a park of its own — the run holds every result it
earned, and the owner decides whether to raise the ceiling or abandon. Trigger: a
triage round whose only finding is the one the `gate-integrity` record already
made. Reversal cost: one branch in the verdict ladder, and the park type to go
with it.
