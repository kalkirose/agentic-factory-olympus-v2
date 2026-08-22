# ADR-0022: Targeted verdict re-runs, carried greens, the confirmation sweep, and progress-keyed cycling

Status: accepted (2026-08-15)

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
- **A CI verdict whose open findings all point outside the tree runs no cycle
  at all.** When a verdict the CI checks rendered holds open findings and every
  one of them is env or harness class, the operational fix hands the run
  straight back to the ship stage, and the CI re-run the fix earns is the test.
  The `operational-fix` stamp carries `sweep: 'skipped'`, the findings it
  covers, and the reason, so the missing cycle reads as a decision. The stamped
  reason names both classes. One open finding of another class — code-defect,
  suite-defect — puts the cycle back, because those are defects the local
  layers judge. An acknowledgment answers a future gate and never enters this
  computation.
- **An operational fix on an env finding probes the substrate before it earns
  a cycle.** The probe reads the run stack's published ports back from the
  compose project itself and asks every one of them the same question on both
  loopback families — connect, write a few bytes, read an answer, inside one
  bounded deadline. A failed probe parks `provisioning-gate` immediately,
  carrying the probe's own output as the evidence, and no `operational-fix` is
  stamped and no layer runs. A clean probe stamps the fix and the cycle runs as
  it always did. Two answers are failures: one family answers while the other
  accepts the connection and relays nothing, or no family accepts a connection
  at all. Silence on both families is not one, and neither is a refusal beside
  an answer. A probe that cannot read the stack, a project with no stack, and a
  fix on harness-class findings alone all leave the route exactly as it was.
  The probe stamps `substrate-probe` either way. It does not run where the
  route skips the sweep: nothing local runs there, and the substrate a CI
  finding names is not this host's.
- **A cycle that repeats a fingerprint buys one retry, then the owner
  decides.** Every verdict cycle is fingerprinted on what settles its outcome
  and on nothing else: the implementation pass, the candidate sha, the suite
  sha, the open findings by identity, and — where the CI checks rendered the
  verdict — the head sha and the last conclusion of every check on it. The
  pass is a component because a fresh pass can rebuild a tree byte for byte
  and land on the same sha, and that run has spent a bounded resource rather
  than looped; the second stall is the ceiling that owns it. The response ladder reads the
  fingerprint of the render it is about to act on before it acts. A first
  repeat stamps `cycle-retry` and carries on: it spends the same
  one-per-subject budget an automatic CI re-run spends (`RERUN_BUDGET`,
  ADR-0008). An answered park grants the next one, exactly as an operational
  fix grants the next check re-run — any answer, because a human who answers
  has changed something the ledger cannot see, and the gate routes re-run the
  same layers against the same tree on purpose. An answer older than the retry
  it would refresh grants nothing. A second repeat parks `cycle-repeat`, which the
  notifier pushes to the owner like every other park (ADR-0028), carrying every
  occurrence of the fingerprint as its evidence and offering `retry` and
  `abandon`. Never a kill: the run holds a candidate, a suite and a verdict
  history, and a park holds all of it at zero cost.
- **Counts are not the key, anywhere in this rule.** A cycle that moves any
  component of its fingerprint is a new cycle, and a run may spend as many of
  those as its story needs. A cap prices repetition and persistence the same
  way, so the run that keeps moving pays for the run that does not.
- **The open findings enter by identity.** Class, summary and evidence,
  normalized and digested — the identity a standing acknowledgment already keys
  on (ADR-0032) — never the finding id and never the count. Triage raises the
  same defect under a fresh id in every cycle that finds it, so an id-keyed
  set reads a stuck run as a moving one.
- **The spec gate's progress rule takes the same keying.** A counted round past
  the first is a stall when it closes none of the blocking findings the round
  before it raised, by identity, rather than when its count fails to shrink
  (ADR-0020).
- **The repair ladder's progress rule takes it too.** A repair round is a stall
  when it closes none of the findings the render before it left open, rather
  than when the size of the open set fails to shrink (ADR-0007). One closed
  finding is progress however many the review surfaces beside it: the round did
  what it was given, and the run keeps its fresh pass for a round that did not.
  Both renders resolve their open sets through the same derivation the
  fingerprint reads, so the harness holds one answer to "is this the same
  finding" and not three. The comparison is over occurrences of an identity and
  not membership of it: the identity normalizes numerals away, so two findings
  can reach one, and an identity that comes back fewer times than it went in is
  a closed finding.
- **Nothing else moves.** The flake filter stays one red-only re-run inside a
  cycle. Green stays zero reds and zero open findings. Triage, the response
  ladder, the repair budget, and the park machinery read the same record they
  always read.

**ADR-0007 had every Tier-1 layer run to completion per cycle, and it measured
repair progress as the size of the open set. Both parts of it are superseded
here.**

The plan lives in `cyclePlan()` in `src/lanes/spectrum.mjs`, beside the graph
walk it shares. The out-of-tree route lives in the response ladder in
`src/lanes/verdict.mjs`, beside the operational fix it stamps, and the probe
lives in `src/lanes/substrate.mjs`, in front of it. The fingerprint and the
budget it spends live in `src/ledger/cycles.mjs`, which is ledger derivation
and holds no lane; the ladder reads it at its own first line, so a CI verdict
and a local one meet the same guard on the way to the same routes. The open
set of a render is one exported derivation in that file, and `repairStalled()`
in `src/lanes/verdict.mjs` reads it for the round comparison.

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

## Why a CI verdict of out-of-tree findings is worth no local layers

An env finding on a CI verdict names substrate this tree does not hold: a
stale credential, a registry that refused, a runner the project does not own.
A harness finding on the same verdict names the machinery around the tree: a
request opened without a label the project's own rule required, metadata on the
forge, a step of the ship the daemon wired wrong. Both remedies land outside
the tree the local spectrum runs on.

Two facts about that verdict decide the route. Every Tier-1 layer was green at
this sha, because a green verdict is what sent the run to ship. The red layers
are CI checks, and the local spectrum does not hold them. A cycle behind either
fix would therefore re-prove 28 layers that are proven already and reach
nothing the finding names. On the reference project that is ten minutes per
fix, and one run can be granted the fix more than once. One observed round paid
twenty-two, on a sha the same run had certified green two days earlier, because
one harness finding about a missing request label sat beside an otherwise
env-only set.

The cost is the smaller half. A green spectrum resolves the findings the last
verdict left open, on the rule that their evidence is gone. For an env finding
a CI red raised, the evidence is not gone: the spectrum that just ran never
went near it, so a cycle here would close the finding on a proof it never
earned. The skip leaves the finding open, hands the run back to ship, and lets
the CI re-run answer it — green, and the PR merges; red again, and the same
triage renders the finding again and the second one parks the provisioning
gate for the human.

The red render stands while the run is back in the ship stage, and that is the
honest state: nothing has proven the substrate yet. The ship stage would
ordinarily bounce a red render back to the verdict, so it reads the skip stamp
and stays. That stamp is the only thing between the two stages, which is why
it names the findings and the reason rather than a bare flag.

The two classes part company nowhere on this route, which is the part the
first version of the rule had wrong. It read every harness finding as a
gate-integrity defect in the machinery this tree runs and sent it to the local
layers. Some harness defects are that. The ones a CI verdict raises are the
ship step's own conduct on the forge, and no layer of any project's spectrum
holds an opinion about a label on a request. So the rule keys on the two
classes together, which is the set the operational route already collects: the
skip fires exactly when the ladder has nothing but operational work to do.

An acknowledgment changes none of it. An ack answers the provisioning gate a
persisting finding raises, one gate at a time and on an operator's authority
(ADR-0032). It says nothing about which layers could test a fix, so it stays
out of this computation and the class of the finding decides alone.

## Why the substrate is asked before the layers, and not after them

An env finding says the failure sits outside the tree. The route's answer is to
record the fix and judge the layers again, and that re-run is the most
expensive statement the harness can make: on the reference project the two
integration layers behind one env finding cost 1 h 28 m. The re-run is also the
one statement the harness already knows the answer to, whenever the host is
still broken. One observed run paid the full price and then parked with the
probe evidence a human gathered by hand, ninety minutes after the daemon could
have gathered it in seconds.

The probe holds no port list, because there is none to hold. The stack
publishes ephemeral ports so that two runs never collide, and the project
resolves them from the compose project name. The probe resolves them the same
way, off the compose document, so it asks about exactly the ports this run's
tests reach and it needs no new project config.

Both loopback families, because the failure lived in the difference between
them. A stale host relay held the IPv6-loopback binds of a dead stack: `::1`
accepted every connection and forwarded nothing while `127.0.0.1` relayed
fine, and the relay outlived a restart of the container engine. A test client
that resolves `localhost` reaches the wedged family first and fails; a probe
that asked one family would have called that host healthy.

The write and the read are what make the answer a fact. A connect alone
succeeds against a relay that relays nothing, which is the whole shape of this
failure. So the probe writes a few bytes and waits for bytes back, on the same
port, with the same payload, on each family. The deadline bounds one socket
exchange and judges nothing on its own: the verdict is the comparison between
the two families, never the passage of time, and no route here reads elapsed
time as evidence of anything (the no-timeout doctrine, ADR-0034).

The comparison is also what keeps the probe from parking a healthy host. No
payload draws an answer from every protocol — a length-prefixed server waits
for a complete message and says nothing, honestly — so silence on both
families proves nothing and is not a failure. A family that refuses while the
other answers is not one either: a project may publish on one family by design.
What is left is one family relaying and the other not, and a published port no
family accepts at all. Both are the host, and a park is the cheapest thing the
harness can do about either.

The false-negative side is deliberate. A probe that answers clean on a broken
host costs exactly what the harness costs today, and a probe that parks a
healthy run costs the owner a night.

## Why a fingerprint, and not a cycle cap

One run rendered six verdicts in a row. Every one of them judged the same
candidate sha, carried the same defect, and read the same replayed check state.
The run ended when a human pushed an empty commit. Nothing in the harness was
going to end it: each cycle stamped an operational fix, each fix granted the
next CI re-run, and each re-run came back the way the one before it did.

A cap is the obvious answer and the wrong one. A cap counts cycles, and the
count is not what is going wrong. A hard story that moves something every cycle
— a finding closed here, a repair sha there, a check that flipped — is doing
what the harness exists to do, and a cap stops it at the same number that stops
a loop. The number would be tuned against the loop, so the working run would
pay for it.

The fingerprint prices repetition instead of persistence. Four things settle
what a cycle concludes: the tree it judges, the suite it judges against, the
findings it carries in, and the external checks, where those rendered the
verdict. Move any of them and the next cycle can end differently, so it costs
nothing to allow. Move none of them and the next cycle cannot end differently,
so it is worth one retry — a check that flakes is the one honest reason the
same inputs get a second look — and after that it is worth a question.

The retry is the allowance that already exists, not a second one. `RERUN_BUDGET`
is one automatic retry per subject, and only a deliberate act refreshes it: an
operational fix for a red check, a human's answer for a repeated cycle. Two
independent allowances for one flake are how the loop kept its fuel — every
cycle's operational fix handed the same red check a fresh re-run, and nothing
counted the cycle around it at all.

The answer has to count as the grant, and the daemon's own fix must not. Two
routes deliberately re-run identical inputs: the provisioning gate, where a
human repairs a substrate the ledger cannot see and answers, and the standing
acknowledgment that answers such a gate on an operator's earlier authority.
Both produce a cycle the fingerprint reads as a repeat, because the thing that
changed is outside every component of it. An answer is the record of that
change, so it grants the cycle that tests it. The automatic fix the daemon
stamps for itself is not a change at all, and granting on that is precisely the
loop.

## Why identity, and not the finding id

Those six cycles carried six different open sets by id and one open set by
identity. A finding id is per-run bookkeeping, minted by the triage that raises
the finding: the same seat, shown the same red one cycle later, raises the same
defect and numbers it one higher. A guard keyed on the id would be blind to
exactly the case it exists for. The identity is the one standing
acknowledgments already key on — class, summary and evidence, normalized
against the paths, shas and line numbers that change while the defect does not
— so the harness holds one answer to "is this the same finding" rather than
two.

A spec-gate finding carries no class and no id at all. Its identity is the
section it sits in and the defect it states, digested as written, because the
gate hands each round the previous round's findings verbatim: a defect that is
still open comes back in the words that raised it. Normalizing those words
would be wrong here — "claim 1" and "claim 2" are two findings, and the
digit is the difference.

## Why two guards read one identity set, and where the line runs

The repair rule and the cycle fingerprint ask different questions of the same
findings. The repair rule asks about one round: did it close anything? A round
that closed nothing says the tree, or the plan behind it, is the suspect, and
the ladder's answer is the fresh pass — throw the tree away and implement it
again. The fingerprint asks about a whole cycle: were the inputs identical?
Identical inputs say every component that could change the outcome is where it
was, and the ladder's answer is a park, because nothing left in the harness
moves it and the owner is the one who can.

The ladder reads the fingerprint first, so where both would fire the park wins:
a question costs the owner a minute and a fresh pass costs the run an
implementation. The two rarely meet, because a fresh pass moves the pass
component and rebuilds the tree, so the cycle after a stall carries a new
fingerprint by construction. What is left for the fingerprint is the loop the
repair rule cannot see — cycles the ladder reaches by the operational and gate
routes, which commit nothing and re-run the same layers on purpose.

The false-stall case is the one both let through. A repair round that closes
the defect it was given while the review names the next one holds the open
count and moves every identity in it: progress to the repair rule, a new
fingerprint to the cycle guard, and under the count rule a stall that spent the
run's one fresh pass on a tree that was working.

The comparison counts occurrences because the identity is deliberately coarse.
It normalizes the
numerals out of a summary so that a line number or a run id cannot make one
defect look like two, and the price is that two defects can look like one: four
gate layers failing as `m1` through `m4` reach a single identity between them.
A membership test over that set reads a round that closed three of them as a
round that closed nothing, and takes the fresh pass away from a run that was
converging. Counting the occurrences of each identity keeps the rule honest at
both ends, and it is not the count rule returning: the open set may grow all it
likes as long as something in it closed.

The count rule was not wrong about the case it was written for. ADR-0007 chose
cardinality against a proper-subset rule, which would have called a round that
fixed everything and surfaced one new finding a stall. One closed finding is
the rule both of them miss: it passes the round that trades up and fails the
round that reports its input back. The one live stall this rule was read
against was true under either key — the open count grew and not one identity
closed — so the re-key changes what the harness does with the other shape and
nothing about that one.

## Why the second repeat parks, and never kills

A run that meets this guard is not a failed run. It holds a candidate tree, a
frozen suite, a verdict history and, in the observed case, a green
implementation pass. It has also proven one thing worth knowing: more of the
same will not settle it. Ending the run throws the work away to save nothing,
and a run may not reach a terminal state on a condition it met by itself
(ADR-0015). A park costs nothing to hold — it frees the run's slot, so the
factory schedules around it — and the notifier puts the question in front of
the owner at the second repeat rather than after a night of cycles.

## Replay

The plan reads the ledger and nothing else: the last `verdict-rendered` for
the sweep, and the `layer-result` stamps of the cycles before this one for the
targeted set. Stamps of the cycle being planned are excluded by construction,
so a daemon that dies mid-cycle derives the same set when it comes back, and
the layers already stamped are skipped as they always were. A restart after
the confirmation sweep sees every layer stamped, re-derives the same clean
result, and writes the same record.

The out-of-tree route replays the same way. Its inputs are the last render's
source, the classes of the findings that render left open, and the
`operational-fix` stamp that follows it. A daemon that dies between the stamp
and the stage transition finds the stamp when it comes back, and the ship
stage takes the run from there.

The cycle guard holds no position either. Its inputs are the
`verdict-rendered` lines, the `finding` lines their open sets name, the
`check-transition` lines of the head sha, and its own `cycle-retry` stamps —
ledger, all of it, and all in order. A daemon that dies between the retry stamp
and the cycle it bought finds the stamp when it comes back and does not buy a
second one; the stamp names the render it was granted for, so the ladder
re-entering on that render reads a decision rather than a question. A daemon
that dies at the park re-derives the same fingerprint and asks the same
question, and the answer to it is keyed on the fingerprint the park record
carries.

The repair rule holds no position either, and reads no more than the guard
above it: the last two `verdict-rendered` lines, the `finding` lines their open
sets name, and the `repair-round` stamps between them. A daemon that dies
between a repair round and the render that judges it comes back to a window
with no render to compare, and the cycle that follows makes the comparison the
ladder would have made.

The probe holds no position of its own. It runs where the route reaches it,
which is in front of an operational fix that has not been stamped yet, so a
daemon that dies between the probe and the stamp asks the host again when it
comes back — a read-only question with no state behind it. A daemon that dies
after the stamp finds the fix recorded and never probes for it again.

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

If the probe ever parks a healthy host, the two failure rules narrow one at a
time: the unreachable rule drops first, because a port nothing accepts has
honest causes the probe cannot see (a service that binds late, a stack the run
never needed up), and the wedge rule is the one the evidence is about. Trigger:
one park an operator answered with "nothing was wrong". Reversal cost: none,
one condition in `probeSubstrate()`.

If the family list proves wrong for a host — a project whose tests reach the
stack by a name that resolves to neither loopback address — the probe asks the
resolver instead of the constant, and reads `localhost` for the families the
tests would get. Trigger: a wedge the probe called clean. Reversal cost: low,
one function in `src/lanes/substrate.mjs`, with the stamped `addresses` on
every past probe to re-read the decision against.

If the cycle fingerprint proves too coarse — a park an owner answers `retry`
whose bought cycle then ends differently, twice — the composition grows the
component it was missing rather than the budget: the fingerprint is a
statement about what settles an outcome, and a wrong statement is corrected,
not compensated for. Trigger: two such parks. Reversal cost: none, one line in
`cycleFingerprint()`.

If one closed identity per round proves too lenient — rounds that trade one
finding for another until the cap is the only thing that stops them — the rule
asks for both halves and a round must close more than it raises. The cap is the
backstop meanwhile, and it is unchanged. Trigger: two runs whose cap exhaustion
followed rounds that each closed one and raised one. Reversal cost: none, one
comparison in `repairStalled()`.

If one retry proves too tight for a CI that flakes twice on the same head,
`RERUN_BUDGET` is the number that moves, and both subjects move with it: the
automatic check re-run and the repeated cycle share the allowance by design.
Trigger: two runs whose bought retry then went green. Reversal cost: none, one
constant — but it doubles the ceiling on a futile loop as well, which is the
trade the constant is there to make visible.

If a project's Tier-1 layers do reach what an out-of-tree finding names — a
smoke layer that calls the same external service the CI check calls, or a
layer that asserts the project's own label rule — the skip drops and every
operational fix takes its cycle again. Trigger: one env or harness finding a
local layer could have proven or disproven. Reversal cost: none, one condition
in the ladder. The narrower reversal is the same condition minus one class, if
only the harness half proves wrong.
