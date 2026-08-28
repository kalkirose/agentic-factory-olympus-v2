# ADR-0049: Every step of a run's setup is timed

Status: accepted (2026-08-29)

## Decision

Provisioning times every step it performs, and the timings ride the run's own
`run-launched` stamp as `setup`. Nothing reads them.

- **The steps are the ones provisioning has**: the wait on the project's clone
  lock (`lockMs`), the clone and fetch (`cloneMs`), the config read from the
  default branch (`configMs`), the run worktree and its cache directory
  (`worktreeMs`), and the stack coming up (`stackMs`, absent for a project
  with no stack). `totalMs` is the whole of provision, so the parts and the
  whole can be read against each other.
- **The field is additive and the reading is a record.** No route, no gate and
  no tripwire consults it. A ledger written before this existed carries no
  `setup`, and every reader of a run-launched stamp is unchanged.

The timing lives in `RunIsolation.provision()`; the carry to the stamp is one
spread in `Daemon.launchRun()`. The same record is written to the run's
`workspace.json`, which archives with the run.

## What this is for

A run pays for a clone, a config read, a worktree and a stack before any seat
or gate does anything, and nobody knows what that costs. The next evaluation
review is meant to rank that cost against the others it already has data for,
and it cannot rank what nothing measured. This decision buys the data and
builds nothing on it: whether any of these steps is worth attacking, and how,
is a later decision that will have numbers under it.

## Why the launch stamp and not a new event

`run-launched` is already the stamp about the launch, it is already the first
line of every run ledger, and it already carries the facts provisioning
produced (the worktree, the branch, the base sha, the stack). A separate
`workspace-provisioned` event would add a registry entry, a reader, and a
second place to look for one run's launch facts, in exchange for nothing: the
provisioning either completed, in which case the launch stamp is written
immediately after it, or it failed, in which case no run exists to hold either
stamp.

## Why the clone lock is one of the steps

Provisioning serializes on the project's bare clone, so a run launched while
another run is provisioning waits before it fetches anything. That wait is
wall the run spent and is invisible in every other step. Timing from the fetch
would produce a `totalMs` that does not match the sum of the parts, and the
first question anybody asks of a slow launch is which part was slow.

## Why image pull is not its own figure

The named costs behind this measurement were clone, install, image pull and
stack boot. Two of them are not steps the harness performs. An image pull
happens inside `docker compose up`, and separating it would mean asking compose
to pull first, which changes what the harness does rather than measuring it; so
the pull is inside `stackMs` and this ADR says so rather than leaving a reader
to assume otherwise. A dependency install is a project command, not a
provisioning step, and every command the harness runs is already timed by the
stamps around it.

The rule this follows is the one that keeps a measurement honest: measure the
steps that exist, name what is inside each figure, and do not restructure the
work to make a prettier breakdown.

## Fallback paths

There is nothing to revert: the field is additive, no code reads it, and a
consumer that ignores it behaves exactly as it did. If the timing itself ever
became a cost, the `stepTimer()` calls come out and the stamp loses one field.
Trigger: none foreseen. Reversal cost: none.

If a later plan wants a finer breakdown, the fetch apart from the first clone
or the worktree apart from the cache, it is one more call of the same
timer, and the field grows the way it was designed to.
