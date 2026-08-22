# ADR-0022: Targeted verdict re-runs, carried greens, and the confirmation sweep

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
- **Nothing else moves.** The flake filter stays one red-only re-run inside a
  cycle. Green stays zero reds and zero open findings. Triage, the response
  ladder, the repair budget, and the park machinery read the same record they
  always read.

**ADR-0007 had every Tier-1 layer run to completion per cycle. That part of it
is superseded here.**

The plan lives in `cyclePlan()` in `src/lanes/spectrum.mjs`, beside the graph
walk it shares. The out-of-tree route lives in the response ladder in
`src/lanes/verdict.mjs`, beside the operational fix it stamps, and the probe
lives in `src/lanes/substrate.mjs`, in front of it.

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

If a project's Tier-1 layers do reach what an out-of-tree finding names — a
smoke layer that calls the same external service the CI check calls, or a
layer that asserts the project's own label rule — the skip drops and every
operational fix takes its cycle again. Trigger: one env or harness finding a
local layer could have proven or disproven. Reversal cost: none, one condition
in the ladder. The narrower reversal is the same condition minus one class, if
only the harness half proves wrong.
