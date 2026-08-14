# ADR-0023: Secret environment narrowing

Status: accepted (2026-08-14)

## Decision

The machine's credentials follow the ability to execute the project's suite,
and nothing else.

- **The instance config names the secrets.** `secretEnv` is an optional array
  of environment-variable name patterns: an exact name (`ADMIN_PASSWORD`), one
  `*` at an end (`PAY_SECRET_*`, `*_TOKEN`), or `*` for every name.
  Case-sensitive, because environment names are. Absent, the feature is off and
  every seat inherits exactly what the daemon holds.
- **The seat map decides who keeps them.** `executesSuite` is a per-seat flag
  in `src/seats/seatmap.mjs`, carried by `dev`, `repair-dev`, and `suite` —
  the seats that run gate and suite commands to check their own work. Every
  other seat is spawned with every matching variable removed: spec birth, the
  spec gate, the adversary, every review seat, the Fury verifier, verdict
  triage, the card sweep, and the eval seat. A seat name the map does not hold
  reads false and is stripped, so being wrong about the policy is safe.
- **A strip, never an allowlist.** Only the matching names go. The seat command
  needs its own auth and system environment to run at all, and no list of what
  a CLI requires would stay true.
- **Project-config commands keep the environment whole.** Everything through
  `runCommand` — the Tier-1 spectrum, suite runs, lint — is spawned with the
  full host environment, whatever the patterns say. The verdict has to be able
  to run payment tests.
- **The ledger carries a count.** `seat-spawned` gains `envStripped: <n>` when
  the strip removed at least one variable, and carries nothing when it removed
  none. The count only, never the names.

The strip sits at the one place a seat's environment is assembled,
`superviseSeat()` in `src/engine/supervise.mjs`, beside the spawn it feeds.

## What this is for

The daemon host holds a payment provider's test-mode keys and other
credentials as user-scope environment variables, because the project's gate
commands and its test suite need them to run at all. Every spawned process
inherited the whole host environment. So the adversary seat, which writes
deliberately wrong implementations into a throwaway tree, held the same
credentials as the seat that runs the tests, and so did every judging seat that
only ever reads a diff.

That is a wide blast radius for no gain. A seat that never executes a command
against the project cannot spend a credential on anything the harness wants;
it can only leak one — into a prompt, a report, a transcript, or a file in a
tree the run later discards.

## Why the seat map, and not a list at the spawn site

The seat map is the single home for per-seat policy: model, effort, web tools,
subagent allowance. A name list next to the spawn call would put a security
rule in a file nobody opens when they add a seat, and the failure mode of
forgetting it is silent and generous.

In the map the rule sits beside every other statement about the seat, and the
default is the safe one: a seat gets no credentials until someone declares that
it runs the suite, in the same object where they declare everything else.

## Why instance config, and not project config

Which names hold secrets is a fact about the machine, like `claudeCommand` or
the compose argv. The same project runs on a host that holds the keys and on a
host that does not, and the project repository is the wrong place to publish
part of a machine's credential inventory. Instance config is also editable
live, so an operator who adds a secret to the host adds its pattern in the same
sitting, and the next seat spawn honors it.

A pattern shape the matcher cannot honor — a `*` in the middle of a name — is
rejected at config load instead of matched against nothing. A rejected edit is
loud. A pattern that silently matches nothing reads like protection and gives
none.

## Why a count and not the names

The ledger is evidence a person reads, quotes in an escalation, and pastes into
an issue. The names of a host's secret variables are not the secrets, but they
are an inventory of them, and an inventory is worth something to anyone who
later gets a shell.

The count answers the only question a reader has here — did this seat run
without the machine's credentials, and how many did it lose — and names
nothing.

## Fallback paths

If a stripped seat turns out to need a credential the harness cannot otherwise
give it, remove `secretEnv` from the instance config. Every seat inherits the
full environment again, exactly as before this decision, at the next spawn.
Trigger: one seat failing on a missing credential it has a legitimate use for.
Reversal cost: one config edit on the host, no code change, no run affected
beyond the ones in flight.

If instead the seat genuinely executes the suite, it takes `executesSuite: true`
in the seat map. Trigger: a seat whose role acquires a gate command. Reversal
cost: one field and an amendment here, because a change to who holds the
machine's credentials is a design decision, not a call-site fix.
