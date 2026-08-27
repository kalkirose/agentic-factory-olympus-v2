# ADR-0042: The replay probe, and credential-absent attribution

Status: accepted (2026-08-27)

## The condition

The machine's credentials follow the ability to execute the project's suite and
nothing else (ADR-0023). Verdict triage and the Fury verifier hold none of them,
which is right: they read a diff and classify a red, and a credential in either
seat can only leak.

It also left them blind. A Tier-1 layer that needs a payment key runs, goes red,
and hands triage a tail of output. Triage cannot run that layer again — its own
environment has no key — so it classifies a red it cannot reproduce. It writes a
sentence about what probably happened, and a sentence is what the response
ladder then acts on.

The reds that need reproducing most are exactly the ones a judgment seat cannot
reproduce. A suite that stops at an absent credential prints a stop, not a
defect; a provider that answers differently under a test key than under none
prints a difference no diff shows.

Beside it, a second and simpler gap: the harness knew nothing about which layer
needed which credential, so an absent variable produced a red with no
attribution at all, and the first thing anybody could say about it was whatever
a seat guessed.

## Decision

### The declaration

A project's `credentials` entry gains `layers`: the Tier-1 gate layers whose
work needs that variable.

```jsonc
"credentials": [
  { "name": "stripe", "env": "STRIPE_SECRET_KEY", "probe": "stripe-probe",
    "layers": ["acceptance"] }
]
```

A layer name that no `gates.tier1` entry carries is refused at config load. A
declaration that attributes no red and gates no replay reads like coverage and
is a typo.

### Mechanical attribution

A layer this declaration names, that goes red, on a host where the variable is
absent or empty, has the variable's name written onto its own `layer-result`
as `credentialAbsent`. It is read before the layer runs and written at the
runner's single settle point, so it is a fact about the host the attempt started
on. A green layer is never annotated: the absence did not stop it, whatever the
declaration says.

The name reaches triage at the head of that layer's evidence, before the output.
It decides what the rest of the output is worth.

### The replay probe

A judgment seat may ask the daemon to run one Tier-1 layer of its own run again
and read the output.

- **It names a layer, never a command.** The request is
  `{"layer": "<name>", "reason": "<what it settles>"}`, a field on the report
  the seat already writes. The form carries no argv, no arguments, and no
  environment field of any kind.
- **The daemon runs it exactly as the spectrum does**: the project's own command
  for that layer, in the run's worktree, with the run's stack environment over
  the host environment whole. Credentials included.
- **The seat gets the output.** It never gets an environment value, and every
  value this host calls a secret is replaced in that output by the name it came
  from, so a command that prints a key hands the seat `[redacted:STRIPE_SECRET_KEY]`.
- **Every request is stamped**, the refused ones too: `probe-run` carries the
  layer, the seat that asked, the round, the exit code, and the file the output
  was written to. The output itself is never a ledger field.

Three rules refuse a request, and the vocabulary of them is closed
(`PROBE_REFUSALS`): a name that is not a Tier-1 layer of this project's gate
table; a layer that needs a credential this host does not declare probe-eligible;
a request after the round budget is spent. The seats it is open to are closed
too — verdict triage and the Fury verifier — and a call for any other seat
throws, because that is a defect in the caller and not a state of a run.

The budget is two rounds per seat session. Each round costs a whole layer run
and a fresh seat session on top of it, and the seat is told how many it has left.

### Eligibility is the host's statement

Instance config gains `probeCredentials`: the exact names of the credentials
this host holds in a form a replay may carry. Absent, no credential is eligible
and a layer that declares one cannot be replayed.

Exact names only. `secretEnv` admits a `*` at an end because a pattern there
widens what is stripped and fails safe; a pattern here would widen what is
exposed and fails open. So a name enters this list one deliberate edit at a time.

## Why this machinery and no other

The seat already writes a JSON report, a deterministic process already reads it,
and a defect in it already buys one re-invocation carrying a brief. The probe
rides all three: a field on the report, a rule in the process, an answer in the
brief. Nothing new was needed for the seat to ask, for the daemon to hear, or
for the answer to arrive.

The alternatives all cost more and buy less. A tool on the seat — a shell, an
allowlisted command — needs credentials in the seat's environment, which is the
one thing this must not do. A control-channel request needs an inbound path to a
running stage, which the engine deliberately does not have: every lane
re-derives its position from the ledger and holds no cross-stage memory. A park
would wait on a human, and the whole point is that no human is needed to re-run
a command the harness runs by itself every cycle.

The round loop sits outside the contract loop rather than inside it. Inside, a
probe would spend the corrective invocation the seat needs for a defective
report, and one probe would cost the seat its only correction. Outside, each
round is a fresh invocation under its own label, the report of a settled round
is never bought twice, and the corrective allowance is whole in every round.

A report that asks for a probe it can still have is not judged on coverage. It
is superseded by the report of the round its answer opens, and holding it to the
coverage rules would spend the correction on findings the seat has not written
yet and then fail the seat for not writing them. Past the budget the report is
the verdict whatever it asks for, and the rules are back.

## Why the eligibility list is not in project config

The ownership test places it (ADR-0023). Which layer needs which variable is a
fact about the project's code and ships in the project repo. Whether the value
this host holds in `STRIPE_SECRET_KEY` is a test key or a live one is a fact
about the machine, and the same project runs on both. A project that could
declare its own credentials probe-eligible would be granting itself the
exposure; a host that declares it is stating what it holds.

Instance config is also edited live, so an operator who rotates a test key into
a live one takes the name off the list in the same sitting and the next probe
is refused.

## Why the ledger carries the exit code and not the output

The output of a Tier-1 layer is minutes of a build. The ledger is a
line-oriented record a person reads and quotes, and ADR-0027 already keeps a
credential probe's own output out of it. So the output goes to a file beside the
run's reports, inside the run directory, and archives with the run that judged
on it. The stamp names the file.

The redaction runs before the file is written, so the copy on disk is the copy
the seat reads. It replaces the longest value first, so a value that contains
another cannot be cut in half by the shorter one, and it leaves values under
eight characters alone: a three-character credential matches half the words in a
build log, and redacting them would destroy the evidence the probe was run to
produce.

## Fallback paths

**The probe.** Remove `probeCredentials` from the instance config. No credential
is eligible, every layer that declares one is refused, and a project that
declares none is back to a probe that runs the layer the spectrum was going to
run anyway. To close it completely, empty `PROBE_SEATS`: every request is then
unreachable and the two seats behave exactly as they did before this decision.
Trigger: any evidence of a credential reaching a seat report, a transcript, or a
tree. Reversal cost: one config edit on the host for the first, one line and an
amendment here for the second.

**The attribution.** Remove `layers` from the project's credential entries. The
`credentialAbsent` field stops being written, every red reads as it did before,
and nothing else changes: no route branches on the field, and every reader of it
treats absence as "nothing known". Trigger: a declaration that attributes reds
to a credential the layer does not really need. Reversal cost: one config edit,
shipped like any other project-config change.

**The budget.** `PROBE_ROUNDS` is one constant in `src/lanes/replay.mjs`. Lower
it to 1 if the rounds turn out to buy less than they cost; a seat is told its
budget, so nothing else has to change.
