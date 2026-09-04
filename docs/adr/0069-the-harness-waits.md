# ADR-0069: The harness waits for the world instead of asking about it

Status: accepted (2026-09-04)

## Decision

A failure whose cause is outside the tree is answered by waiting. One
mechanism, four entry points, two ladders, and one park at the end of each —
raised only when the waiting is spent.

### The mechanism

`src/lanes/waiting.mjs` is the whole of it. A wait stamps `waiting`
(`kind`, `reason`, `until`, `attempt`) on the run ledger and `waiting-ended`
(`kind`, `outcome`, `waitSeq`) when it ends. `kind` is one of `seat`, `layer`,
`substrate`, `external`, and it names what the run is waiting for rather than
what raised it. `outcome` is `elapsed` for a span that ran out, `probe-green`
for a service that came back, `spent` for a poll that never got its answer, and
`killed` or `daemon-stopped` for a wait the machine ended.

A wait is a span inside a stage handler, so the run is executing and the
liveness invariant is satisfied by the handler itself. The engine holds the
live wait in `run.waits`, which is what gives the other readers their answers:

- **The heartbeat** says `waitingOn: <kind>` with the `until`, the reason and
  the ladder attempt in its detail, so a stage that stops for forty-five
  minutes says why for all of them.
- **The slot count** reads `freesSlot`. A `seat`, `layer` or `substrate` wait
  holds the slot, because the run is mid-stage and will carry on inside it. An
  `external` wait frees it, as a park does, and takes one again when it ends,
  as a released hold does.
- **A kill** ends every wait of the run it closes, and the wait writes its own
  `waiting-ended` from inside that call — a kill closes the ledger in the same
  turn, and a stamp written one tick later would land on a ledger that had
  already moved to the archive.
- **An operator hold** taken while a run waits holds the run at the re-dispatch
  the wait bought: the wait ends, its record lands, and the run enters nothing
  until the release (ADR-0040).
- **`run-closed activeMs`** subtracts waiting spans as it subtracts parked ones,
  and so does the stage duration band (ADR-0039). A ladder that sat out a
  provider outage is not the harness working.
- **`olympusctl status`** prints `waiting: <kind> <reason> until <time>` under
  the run and counts waiting runs apart from active ones in its header.
- **The cycle fingerprint** (ADR-0022) counts the waits a render stands behind,
  so a cycle after a wait is a new cycle by construction rather than a repeat
  the ladder would park on.

Nothing is stored anywhere else. The ladder position is one more than the waits
of that kind since the render or the answer the ladder starts from, so a
restart resumes a ladder where it stood and a human's answer buys a fresh one.
A span a dead instance left open is closed by the next start with outcome
`daemon-stopped`, the way an open gate-layer attempt is (ADR-0034).

**Two ladders, named once.** The **seat ladder** is 5, 15 and 45 minutes. The
**layer ladder** is 1, 5 and 15 minutes. Each step is one wait and one
re-dispatch or one narrowed re-run.

### A seat that dies of the provider waits

In `src/seats/runner.mjs`, past the three in-place crash retries (ADR-0005), a
result with reason `exit` or `silence` takes the seat ladder, resuming the
session where the dying child named one. A `model-unavailable` result on a seat
with no substitute below it — the degrade route runs first — waits until the
vendor's own `resetsAt` plus one minute and re-dispatches once on the same
model; without a reset instant it takes the seat ladder. Only a spent ladder
fails the seat, and the `seat-failure` park behind it is the park it always
was.

A wait stamps no `seat-failure`, so the corrective-round and crash-retry
budgets (`attemptLimit`, `boughtRetry`) read exactly what they read before, and
the cost ledger is untouched: a wait spends nothing.

### A transient red never reaches a seat

After the flake filter's own re-run goes red, `src/lanes/transient.mjs` reads
the red before any seat is spawned. The closed signature set is: `ECONNRESET`,
`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, an HTTP 429 or 5xx on a
line that also names a host, rate-limit wording, an image pull failure, a
Postgres or Redis connection refusal at startup, and the runner CLI's own
`api_retry` exhaustion. A project adds its own runner's wording in
`gates.transientPatterns`; it may not take anything out.

The read is deliberately narrow, and it refuses in four named ways. It needs
every red layer to have named the parts that failed and every red part to have
named the files that failed inside it (`no-failed-files`); every red part to
show a signature (`no-signature`); and nothing in the layer's output or its
parts to show an assertion failure or a compile error (`code-signature`). A red
that qualifies stamps `layer-transient` (`layer`, `parts`, `files`,
`signatures`) and takes the layer ladder, with a narrowed re-run of those parts
and those files at every step (ADR-0065). No finding is minted. Everything else
takes triage exactly as it did before, because the safe direction is the seat.

A red that survives the ladder reaches triage with the signatures in its brief,
and `triageChecks` refuses a code-defect finding whose only evidence is one of
them: the harness already re-ran those files three times and they failed the
same way, so the finding is env or it cites the tree's own answer. CI-source
verdicts are outside all of this — a red GitHub check has its own re-run in the
forge.

### An env finding waits before it asks

The operational route keeps its immediate re-run. An env-class finding that
survives it takes the layer ladder under the kind `substrate`, with a narrowed
re-run of the layers it names at every step. The substrate probe runs before
every step, and a host that refuses its own probe ends the ladder and parks at
once with the probe's evidence (ADR-0022): a host that will not answer a probe
will not pass its layers, and the ladder would spend an hour proving it. A
finding that survives the ladder parks the provisioning gate as it always did,
with the three attempts and their times in the question.

The harness half of that gate (ADR-0068) is asked when the env findings have
survived both the ladder and one answered substrate gate. Both halves are
needed: the identity comparison says the human's retry moved nothing, and the
spent ladder says the machine's own re-runs moved nothing either.

### A service down for a day is waited for

A transient red that survives the layer ladder and names a host of a declared
credential does not park. Each `credentials[]` entry may declare `hosts`, and a
host a signature names resolves to the credential whose declared host it equals
or ends with, on a label boundary. That credential's own probe is the readiness
signal.

The run enters an `external` wait: it frees its slot, and the probe is asked
every ten minutes for up to twenty-four hours. Nothing is stamped for an answer
of no — a service that is down says no a hundred and forty-four times, and a
stamp per poll would bury the run's own ledger. At one hour the instance ledger
carries a loud `external-outage` naming the project, the credential, the host
and the run. A green probe ends the wait `probe-green`, resolves that record,
takes a slot again and re-runs the red parts narrowed to their files. A day of
no ends it at a `provisioning-gate` park carrying the whole history.

That park offers `defer-proof` beside `retry`, and only where the project sets
`gates.proofDebt: true`. The answer stamps `proof-deferred` (the credential,
the parts and the files), carries those parts as `deferred` on the verdict
record beside `partsCarried`, and lets the ship proceed. The fast path refuses
to carry a certification that holds one (ADR-0056). The daemon keeps asking the
credential's probe (`src/lanes/proofdebt.mjs`); when it passes, it runs exactly
those parts against the default branch in a workspace of its own and stamps
`proof-settled`, with an `escape-recorded` of kind `deferred-proof` against the
ship that carried the debt when the proof does not hold. `gates.proofDebt`
defaults to false, and a project that never sets it never meets any of this.

## Why a wait rather than a park

Ninety-four parks over sixty-nine runs, read on 2026-09-04. Sixteen were
`seat-failure`, answered `retry` every time, with waits from one minute to
seventy hours. Fourteen were env-class provisioning gates, and nine of those
were host conditions that were green on a retry hours later. Every one of those
answers was a word the machine already held: try it again later.

A park and a wait say different things and the difference is the point. A park
says the run is waiting on a person and frees its slot; a waiting seat says the
run is waiting on the provider and holds its slot, because it is mid-stage and
will carry on where it stopped. The external wait is the one that says both:
the run is waiting on a service, nobody is being asked, and a day of a slot is
too much to hold, so it gives the slot up and takes one back at the end.

## Why two ladders and not one

A seat crash is a provider incident measured in minutes to an hour: an API
connection that dropped, a stream that stopped, a model window that refills. A
layer red is a host or a service measured in seconds to a day, and the external
wait follows it, so its steps are short and its tail is long. One ladder would
be wrong for one of them. Two ladders in one mechanism keeps every stamp, every
reader and every recovery rule shared.

## Why the signature set is closed, and how it grows

The set can be wrong in both directions. Too broad hides a real defect behind
twenty minutes of waiting and no seat; too narrow costs what today costs. Three
things bound the first: every failed part must show a signature, nothing may
show an assertion or a compile error, and the red that survives the ladder
reaches triage with the signatures named rather than hidden. The second is the
condition the set exists to improve on, so a missing signature is a wait nobody
took rather than a wrong answer.

The set grows by decision recorded here, never from a call site. A project's own
runner wording is the exception: `gates.transientPatterns` is a project's fact
about its own tools, it adds and never removes, and a pattern that will not
compile is refused by the config validator at the launch door.

## Why the ladder position comes from the ledger

A ladder held in memory restarts at its first step after every daemon restart,
and a run that meets a provider outage across a restart would climb it for
ever. Counting the waits of a kind since the render the route acts on makes the
position a derivation, so a restart resumes where the run stood and an archived
ledger says what the run actually tried. It also gives the human's answer its
proper meaning: an answer is a grant, so a `retry` buys a fresh ladder rather
than a fourth step on a spent one.

## Where the poll runs, and what an hour of it costs

The poll runs inside the stage handler that is waiting, not on a watcher tick
of the daemon's. The run is mid-cycle: it holds the spectrum results it has
earned, the read that classified them and the narrowing its re-run will ask
for, and none of that is in the ledger in a shape a watcher could act on. A
watcher would have to re-derive it, or the run would have to leave the handler
and come back through a resume — which is the mechanism a park already is.

The cost is that the hour before the loud record is six sleeps of ten minutes
plus up to six probe timeouts, so it is an hour of wall clock and a little
more, bounded by `probes.timeoutMs` per ask. The day is the same arithmetic a
hundred and forty-four times. Nothing else waits on the handler — the run gave
its slot up, and the poll count is what bounds the span rather than a clock the
harness reads.

One wait per ladder, and the second attempt is the gate. A restart closes the
open span, the stage re-enters and finds the ladder spent, and without that
bound the run would open a fresh twenty-four hours at every restart and reach
nobody. The loud record is read off the instance ledger for the same reason:
the call that opened it does not survive a restart, and a second record for one
outage is what a reader least needs.

## Why the external wait polls the credential's own probe

The project already wrote a read-only command that says whether that service is
taking work (ADR-0027), and it is the one question whose answer decides whether
re-running the layer is worth anything. Reading the layer again instead would
cost the layer's own minutes per attempt and would answer a broader question
than the one being asked. The probe's output is never recorded, because it can
carry the credential.

## Why `defer-proof` exists and why it is off

A service down past a day stops a story that is otherwise finished. The owner's
trade is speed against residual safety, and it is a trade only an owner may
make, so it is a config flag that defaults to off and an option that does not
appear where the flag is unset. What makes it honest is the record: the verdict
says which parts went unproven, the fast path refuses to carry that
certification, the daemon owes the proof and runs it when it can, and a proof
that does not hold is an escape of a named kind against the ship that carried
it. The flag can be measured by counting that kind.

## What the deferred trade costs after it is taken

A deferred verdict is green, and a green verdict ships. What it does not do is
end the run's ability to come back here: a later repair round re-runs the red
layer, meets the same service, reads the same signature and may enter the
ladder and the external wait again — another day, on the same service, in the
same run. The deferral is scoped to the cycle that took it precisely so a later
cycle judges a tree somebody changed rather than inheriting the trade; the
price of that scoping is the second wait.

Two things bound it. The gate that raised the trade offers `retry` beside it,
and a run that keeps meeting a dead service has an owner reading a loud
`external-outage` from the first hour of the first wait. And the trade is only
on the table where `gates.proofDebt` is armed, which is the owner's decision to
review when a story spends two days on one service.

## Fallback paths

If a ladder's numbers prove wrong — a provider whose outages are longer than 45
minutes, a host that is back in seconds — the two arrays in
`src/lanes/waiting.mjs` are the whole of it, and every reader derives from the
stamps rather than from the numbers. Trigger: a `seat-failure` park whose
provider was back minutes later, or a ladder that keeps spending 45 minutes on
a host nobody was going to fix. Reversal cost: one array, and this record.

If waiting seats hold too many slots — a provider outage idling three runs
where a park would have freed them — the seat wait can free its slot the way
the external wait does, at the cost of a stage that has to be re-entered rather
than resumed. Trigger: a project whose slots sit idle behind provider outages
while the frontier holds launchable work. Reversal cost: one flag on the wait,
plus the re-entry the seat stage would then need.

If the transient read is too broad — a defect hidden behind a ladder — narrow
it by removing the signature that matched, or turn the whole route off for a
project by removing `part-failed-files` from its runners, which is what the
read stands on. Trigger: a red the ladder cleared and a later run failed on.
Reversal cost: one entry in the set, or one line in the project's own runner.

If the transient read is too narrow, a project adds its runner's own wording in
`gates.transientPatterns` today, and a condition that recurs across projects
earns an entry in the closed set by an amendment to this record. Trigger: a
provisioning park whose evidence was a condition outside the tree that nothing
matched. Reversal cost: one config line, or one entry and this record.

If the external wait proves too long — a story held a day while somebody would
have wanted to know at four hours — the wait's span and its poll interval are
two constants, and the loud record at one hour already tells the operator
before the park does. Trigger: a park at the end of a day that a human would
have answered at the start of it. Reversal cost: one constant.

If `defer-proof` costs more than it buys, `gates.proofDebt: false` ends it at
the next launch, the option stops appearing, and the debts already recorded
still settle. Trigger: a `deferred-proof` escape, or two. Reversal cost: one
config line.

If the settle run cannot be trusted — the default branch has moved so far that
running the deferred parts against it says nothing about the ship that deferred
them — the watcher can stamp `proof-settled` with the reason and record the
escape unconditionally instead of running anything. Trigger: a settle run whose
red was about later work. Reversal cost: one branch in
`src/lanes/proofdebt.mjs`; the debt derivation and the records are unchanged.

If the wait mechanism itself has to be turned off in a hurry, every entry point
is one call: the seat ladder in `runSeat`, the two ladders in the verdict
lane's `outsideTheTree` and `substrateLadder`, and the external wait behind a
declared host. Removing the host declarations alone ends the external wait for
a project without touching the harness. Trigger: a wait that stops a run the
harness cannot recover. Reversal cost: one config edit for the external wait;
one call site each for the rest, and this record.
