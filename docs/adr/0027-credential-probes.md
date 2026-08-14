# ADR-0027: External-credential probes

Status: accepted (2026-08-15)

## Decision

An external credential is proven by a read-only probe at both gates where the
next step costs money, and a probe that answers no parks the run as a
provisioning gate.

- **The project config names them.** `credentials` is a list of entries, each
  with a `name` (the credential as people speak of it), an `env` (the one
  environment variable that carries it) and a `probe` (a key in `commands`).
  All three are required: a declared credential with no probe behind it reads
  as covered and is not. The variable is one name, never a pattern, because
  the probe answers for exactly the value it was given. The list holds no
  value and never could — it ships in the project's repository like every
  other line of project config.
- **Two gates.** Story-lane readiness, as the last check before the first
  seat, and the ship stage, before the PR is opened. A run that launched on an
  inherited freeze asks the question on its own route, because it hands its
  tree straight to a dev seat.
- **The exit code is the whole answer.** Zero means the credential works.
  Nonzero parks a `provisioning-gate` naming the credential, the variable and
  the gate. A variable that is unset or empty parks the same way without
  spending the round trip. A probe that could not run at all takes the
  `command-error` route with `retry` and `abandon`, because a spawn failure is
  a defect of this machine and not a verdict on the key.
- **The probe's output is never recorded.** Not in the ledger, not in the park
  text, not in a tail.
- **Both answers stamp.** `credential-probe` carries the phase, the credential,
  the variable and `ok`; a failure adds the reason (`absent`, `refused`,
  `unrunnable`) and the exit code. A run states which credentials it proved and
  when, and nothing about a credential happens silently.
- **The probe runs the way the suite runs.** It goes through the
  project-command runner, so it holds the whole host environment — seats lose
  the machine's secrets, configured commands never do (ADR-0023) — and it
  carries its own time limit in its own argv, because how long a provider may
  take is a fact about that provider.
- **An answer re-probes.** The gate keeps no memory of an answered park: the
  stage re-enters and asks the provider again. A credential is proven at the
  gate it stands in front of, never asserted by a human at an earlier one.

## What this is for

A credential in an environment variable fails silently. It expires, it is
rotated somewhere else, it is pasted back one character short, and nothing on
the machine changes appearance. The first thing that notices is whatever tries
to use it, and in a harness run that is a paid seat pass or a full CI round —
the two most expensive questioners available, both of which answer in a form
that first has to be triaged back to "the key is dead".

A read-only call to the provider asks the same question in one round trip for
a fraction of a cent, and answers it in one bit.

## Why two gates and not one

Launch and ship are the two edges of the run's spending. The launch gate puts
the first seat behind a working credential. The ship gate exists because a run
lives for hours and a credential can be rotated, revoked, or expire inside that
window; the key the launch proved is not evidence about the key CI will use.
Ship is also the last cheap moment on the way out: everything past the PR is a
CI round, and a red one costs a triage on top of the round.

Between those two edges nothing probes. A gate that stands where no decision
follows it buys nothing, and the ship gate catches whatever went stale in the
build.

## Why a provisioning-gate park

The daemon can neither mint nor rotate a credential, and it never self-clears a
gate it cannot settle. The provisioning gate is the existing shape for exactly
that condition: the run holds its sound work, states what a human must fix, and
waits. A recovery park would offer `retry`, which here would mean retrying an
answer that has not changed.

## Why the probe's output is never recorded

The probe process holds a credential, and what it prints is chosen by the
provider's client and by whoever wrote the command. A verbose HTTP client
prints its own request headers. An error body can echo the value it rejected.
The harness cannot know which characters of a tail are safe, and a ledger is
read, quoted in escalations, and pasted into issues.

The exit code answers the only question the gate asks. The person who must
replace the credential runs the command in their own terminal, where the
output belongs.

## Why the variable name is recorded, though

The names of a host's secret variables stay out of the ledger, because a list
of them is an inventory of what the machine holds (ADR-0023). This name is not
that. The project publishes it in its own repository, in the config entry that
declares the probe, so the ledger repeats a published fact. A park that will
not say which credential failed cannot be acted on.

## Why project config and not instance config

The ownership test settles it: which external services the work needs is a
fact about the code, and it ships with the code. The instance config states
what the machine holds; the project config states what the work requires. They
meet in the run — the project says "prove this variable", and the machine
either holds a working value or the run parks in front of the money.

## Fallback paths

If a probe parks runs for reasons other than the credential — a provider
outage, a network the daemon host cannot reach — remove its entry from
`credentials`. Nothing probes, and launch and ship behave exactly as they did
before this decision. Trigger: two parks whose cause was the path to the
provider rather than the value. Reversal cost: one config edit through the
project's own PR path, no code change, no run affected beyond the ones in
flight.

If a failed probe needs more diagnosis than an exit code, the answer is not to
record the output. The project wraps the probe in its own script whose stdout
is safe by construction, and the exit code stays the contract. Trigger: a park
whose cause the exit code did not settle. Reversal cost: a script in the
project repository, no harness change.

If a lane that spends before ship needs its own gate — a repair run reaching a
dev seat against a dead credential — the call is the same three lines at that
stage entry. Trigger: one such run. Reversal cost: low, one call site and an
amendment here, because where the machine spends money without asking is a
design statement rather than a call-site detail.
