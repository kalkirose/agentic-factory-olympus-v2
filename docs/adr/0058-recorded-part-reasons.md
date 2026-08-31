# ADR-0058: A verdict cycle records what it skipped and why

Status: accepted (2026-08-31)

## Decision

Every verdict cycle that plans a gate layer in parts records, on that layer's
own result, why each part of it ran. The parts it did not run are already on
the record. What was missing was the other half: the reason the rest of them
did.

- **Five reasons, and no sixth.** A part that ran carries exactly one word:
  `touched` (a changed path is under this part's declared ground),
  `undeclared` (the part declared no ground, so every change reaches it),
  `blind` (a changed path is under no part's ground at all), `not-green` (the
  standing result for this part was not a proven green), or `no-record` (the
  standing result holds no entry for this part). The set is closed in code, a
  word outside it throws where it is stamped, and the value of the field is
  that a reader can count it.
- **A carried part carries no reason.** It did not run. What it holds is
  `carriedFrom`, the cycle whose execution earned its green, exactly as before.
- **A defect of the mapping outranks an honest reason.** Several clauses hold
  at once often. The record names `undeclared` over `blind`, `blind` over
  `not-green`, and `not-green` over `touched`. An honest reason is read and
  forgotten. A missing declaration that hides behind one is repaired by nobody,
  and it is the condition the record exists to name. Remove the causes in that
  order and each part falls through to the next true clause, until what is left
  is the floor the layer costs whatever anybody declares.
- **A blind result names the paths.** Up to three changed paths the plan could
  attribute to no part ride the `layer-result` and the verdict record. Three,
  because the record is a diagnosis and not a diff.
- **A reason is only ever given where a plan was derived.** A confirmation
  sweep runs every part by design and a full spectrum has nothing to carry
  from, so neither derives a plan and neither result carries a word. A layer
  the cycle dropped out of its map (a range git could not answer, a result with
  no sha, a result older than the last re-freeze) ran whole for a reason that
  is not about its parts, and none of its parts is given one.
- **The cycle states the share.** The verdict record and the `verdict-rendered`
  event carry `partsRun`, `partsCarried` and `carryShare`, over every layer of
  the cycle. A layer the cycle carried whole carried every part in it. A cycle
  that recorded no part carries no share at all: nought over nought is not a
  share.
- **The share is watched from below.** The `carry-share-window` metric is the
  mean `carryShare` of the last N verdict cycles of a project that narrowed,
  and the `carry-share-floor` tripwire breaches under a configured floor. It is
  the one band in the registry that watches a number for falling.
- **The operator sees it without opening a file.** `olympusctl status` prints
  the last recorded share on the line of every run standing in the verdict
  stage.

The derivation lives in `partReasons()` and `partPlan()` in
`src/lanes/parts.mjs`, both pure. `partTargets()` in `src/lanes/verdict.mjs`
builds the per-layer plans, `src/lanes/spectrum.mjs` stamps them onto the
results, and `src/tripwires/metrics.mjs` reads the shares back out of the
ledgers.

## What this is for

Part-level carrying saves the repair cycles of a run, which on the reference
project is most of the hours a run spends in gate commands. The saving has one
failure mode, and it is silent: a part that stops carrying re-runs for ever,
costs the same hours the mechanism was built to remove, and turns nothing red.

The conditions that cause it are ordinary. A suite that carries no input
declaration costs its whole family's declaration, so every part of that layer
runs on every cycle. A changed path no part claims does the same for one cycle,
and a lockfile, a shared package or a config file is such a path.

Neither left a trace. The conservative branch of the derivation wrote nothing
at all: it decided to re-run everything and recorded no event, no field and no
log line saying which clause decided it or which path it could not attribute.
The only evidence was the minutes the cycle spent.

No other reading in the tripwire registry can see it. The escape metrics count
defects that reached the default branch, and nothing escapes. The layer-peak
metrics count memory, and the memory is unchanged. The verdict-cycle metric
counts re-judgments, and the run is judged the ordinary number of times. The
cycles simply cost what they cost before the carrying existed.

So the mechanism now states its own decision. A skip nothing names is a saving
nobody can measure and a loss nobody can see.

## Why the reason is one closed word and not a sentence

A sentence is written once and read never. The point of this field is the
count: how many parts of the last ten cycles ran because a declaration was
missing, and how many because the diff honestly reached them. A count needs a
vocabulary a comparison can hold, so the set is closed in code and a word
outside it throws at the stamp. That is the same rule the defect kinds and the
abandon reasons already follow.

Five is what the derivation actually distinguishes. Every clause of the rule
has exactly one word, and no clause has two.

## Why the defect of the mapping wins the tie

`not-green` and `touched` are both true of a red part whose ground the diff
also reached. `undeclared` and `blind` are both true of an undeclared part on a
blind cycle. Something has to decide, and the choice is between reporting the
cause a reader can remove and reporting the cause that is most local to the
part.

The record reports the cause a reader can remove. A red part is repaired by the
run in flight; a diff is the diff. Neither is a condition anybody acts on. A
family with no declaration and a path nobody attributed are both repaired by an
edit, and both are invisible everywhere else. If `not-green` outranked
`undeclared`, every undeclared part of every red run would read `not-green`,
and red runs are exactly the cycles the carrying exists for.

The order is stable under repair. Fix the declarations and the `undeclared`
parts read `blind` or fall through to the honest words. Fix the ground and the
`blind` parts read `not-green` or `touched`. What is left when nothing is
removable is the floor.

## Why `blind` is reported per part and the paths are reported per layer

A blind cycle re-runs every part, so `blind` is the only reason that is a fact
about the cycle's diff rather than about the part. It is still written per part,
because the count is per part and a reader comparing "how many parts ran for
this reason" needs every reason on the same footing.

The paths are not written per part. They are identical for every part of the
layer, and a record that repeated a lockfile path across sixty-four parts would
be sixty-four copies of one fact. Three of them ride the layer.

## Why the share leaves out the cycles that run whole on purpose

The metric reads targeted cycles alone. A full sweep is the first cycle of a
pass and has nothing to carry from. A confirming cycle runs every layer at its
own sha so the green it certifies rests on no carry (ADR-0046). Both are the
design working, and both record a share of zero.

Counting them would read the design as a decay, and it would drag the mean down
hardest on the runs that reached green fastest, which is exactly backwards. The
record still states the share on those cycles, because the record is a fact
about what the cycle did. The metric is a reading, and the reading names what
it is about.

## Why the floor is not set here

A floor is a claim about what a healthy project carries, and nobody has
measured that yet under this metric. A floor guessed before the measurement
would either cry on every ordinary red run or sit under every decay it exists
to catch, and a band that cries is a band an operator learns to ignore.

The standing entry therefore ships at zero, which no share can fall below, so
it cannot fire. It is a placeholder with the machinery behind it working, and
the project raises the one value in its own registry once ten narrowed cycles
stand on the ledger. That is the same self-baselining path the kill-rate and
lens-yield bands take (ADR-0010), with the proposal done by hand because the
reading has no baseline stamp of its own.

## Replay

Nothing here holds state. The reasons are derived from the standing
`layer-result` of each layer, the last `re-freeze` line, and a diff between two
shas, which is what the plan already read. A daemon that dies mid-cycle
re-derives the same reasons when it comes back, and the layers already stamped
under this cycle are skipped as they always were.

The share is derived from the results of the spectrum the record reports, at
the moment the record is written. A cycle that ran the confirmation sweep
reports the sweep's tally, because the sweep is the spectrum that record is
about.

A render written before this decision carries no share. The metric reads a
missing field as no reading rather than as a zero, so an old ledger keeps the
band quiet instead of breaching it.

The one new cost is a layer whose standing result holds no part table. It used
to leave the derivation before the diff was read; it stays now, so the cycle
buys one bounded `git diff --name-only` for it. That is what makes `no-record`
observable at all, and it is the whole price of the record on a project that
runs no layer in parts.

## Fallback paths

If the reasons prove noisy on a project whose layers run in many parts, the
field costs one word per part and the reader ignores it. There is nothing to
turn off, because there is nothing being decided on it: no route reads a
reason, no gate branches on one, and a wrong reason costs a wrong diagnosis and
never a wrong skip. `gates.partTargeting: false` still returns every layer to a
whole re-run, and the plan then derives nothing at all.

If the precedence proves to hide a condition somebody needs, the order is four
lines in one function and the record is rewritten from the next cycle on. No
history is invalidated: the words are per cycle, and a window of ten cycles
refreshes inside one run.

If the carry-share band proves to fire on honest repair work once a floor is
set, the floor is one number in the project's own registry and the entry is
removable like any other. The record stays whatever the band does, because the
record is what the diagnosis is read from.
