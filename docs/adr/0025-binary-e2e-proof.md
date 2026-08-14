# ADR-0025: The binary end-to-end proof

Status: accepted (2026-08-14)

## Decision

CI drives the assembled daemon through a whole run, twice, on every push. The
entry points are the shipped binaries; the only substitutes are the two
external tools a build machine cannot hold.

- **The binaries are the subject.** `npm run test:e2e` starts
  `bin/olympusd.mjs` as a child process and drives it with
  `bin/olympusctl.mjs`: the real control inbox, the real instance config, the
  real lane assembly, the real ledgers. No scenario imports a lane, a seat or
  the engine, and no scenario constructs a `Daemon`. Every fact a scenario
  asserts is read afterwards from the ledgers, the run artifacts and the
  fixture repository.
- **Two tools are stubbed, both through configuration seams the production
  code already carries.** `claudeCommand` names a node script that answers the
  seat contract (stream-json init, progress and result lines; the artifacts the
  seat owes; the JSON report at the path the prompt names). `ghCommand` names a
  node script that answers every forge call the ship step makes. Nothing in
  `src/` knows either of them exists.
- **Everything else is real.** A bare git origin, a bare clone, run worktrees,
  three disposable adversary worktrees, commits, a push, a merge commit, a
  fetch, the project's four configured commands, and an acceptance suite that
  is red before the implementation and green after it.
- **Two scenarios.** The story lane carries one intent card from launch to
  `run-closed: shipped`: readiness parks on the card's open decision and the
  console answers it, the spec is born and passes a clean gate round, the suite
  is authored, three adversary waves are killed, the freeze records the kill
  count, the dev pass leaves one red layer, triage classes it, one repair round
  clears it, the second cycle is targeted with a confirmation sweep, the Fury
  round and the generalist review come back clean, the PR opens, the checks
  transition, the merge lands and close-out sweeps the cards. The repair lane
  carries a committed intake ticket from `olympusctl launch --lane repair`
  through fix, verdict and ship to the same close.
- **The claims are sequences and states, never wall-clock.** Each scenario
  asserts a milestone sequence over its ledger, the per-layer results of both
  cycles, the seat argv the supervisor spawned, the gate commands that really
  ran, the forge calls the ship step made, and the merge as a ref in the
  fixture origin. Every wait polls a file-derived state with a bounded attempt
  count, and any state that can no longer reach the condition (a refused
  launch, an unanswered recovery park, a run closed anything but shipped) ends
  the wait at once with the ledger tail.
- **It is its own job.** `e2e` runs beside `test` in the CI workflow, on every
  push and every pull request. `npm test` is untouched: the e2e files sit
  outside `test/`, so the unit runner never discovers them.

## What this is for

The suite held 436 unit and integration tests and every one of the eight worst
production defects lived between the parts they proved: the binary registered
no lanes, the console could not pass a repair ticket, seats spawned with an
argv that ate the prompt, a configured command could not spawn at all. None
was reachable, because a fixture assembles the graph it wants and spawns
`node` directly. Each one cost a live run and a day.

The gap is structural rather than a matter of coverage. A unit fixture proves
a part against the graph the fixture built; only the binary proves the graph
the binary builds. So the countermeasure is not more unit tests, it is one
proof that starts where an operator starts.

## Why a stub seat rather than a recorded transcript

A recorded transcript would pin the run to one model's output and would go
stale the first time a prompt changed. The stub reads the prompt instead: it
takes its seat name from the shared core block, its report path from the file
contract, and its red layers from the triage brief. A prompt that stops
carrying one of those is a failure, which is the point — the prompt assembly
is part of the wiring under test.

What the stub cannot judge, it does not pretend to. It answers every judgment
seat clean, so the scenarios prove the routes, not the verdicts.

## Why the forge merges for real

The stub answers the forge protocol with canned JSON, but the merge itself is
a git operation on the fixture origin: a commit with two parents and the
branch's tree, then a ref update. A fast-forward would have left the merge sha
equal to the head sha, and the three readers after the merge (the fetch, the
close-out check watcher, the card sweep's reset) would have been judged
against a commit the clone already held.

## What this does not exercise

Named here because a green e2e job is read as a proof, and a proof that is not
bounded is a false one.

- **Docker stacks.** The fixture project declares `stack: null`, so no compose
  command runs and `stackUp`/`stackDown` never fire. Proven instead by
  `test/stacks.test.mjs` and the compose-runner substitution in
  `test/launch-isolation.test.mjs`.
- **A real forge.** Branch protection, auto-merge behaviour, check-run
  scheduling and the GitHub API's own error shapes are the stub's canned
  answers. The argv builders and the response parsing are proven by
  `test/ship.test.mjs`; the rest is proven only by a live shakedown.
- **Real model seats.** Judgment quality, tool policy, the corrective
  re-prompt, the availability degrade and the cost ceiling do not run. Proven
  instead by `test/runner.test.mjs`, `test/supervise.test.mjs` and
  `test/contract.test.mjs`, all of which drive the same code paths with
  scripted children.
- **Windows process lifecycle.** The job runs on ubuntu, where
  `seatSpawnOptions` is empty, `terminateTree` is a plain kill and
  `sweepPathHolders` returns nothing. The Windows branches are proven by
  `test/processes.test.mjs` and by ADR-0016; the e2e also runs unchanged on a
  Windows developer machine, which is where that behaviour is observed.
- **The red routes.** A CI red, the red-merge breach, the escape ticket, the
  frontier's repair launch, a stalled verdict, a killed run and a daemon
  restart mid-run are all lane machinery the scenarios walk past. They stay
  with the unit suite (`test/ship.test.mjs`, `test/repairs.test.mjs`,
  `test/terminal-state.test.mjs`, `test/resume.test.mjs`).
- **The command center.** `bin/olympus-center.mjs` serves a read-only page and
  is proven by `test/center.test.mjs`.

## Cost

Both scenarios run in parallel under one node test runner: about 25 seconds of
wall clock, of which 30 seconds across the two runs is the ship stage's own
15-second poll interval, waited once per lane. The ceiling that matters is the
attempt bound on each wait, not the observed time.

## Fallback paths

If the e2e turns flaky on the CI runner rather than on the code, the job keeps
running and stops gating: `continue-on-error: true` on the job, and the flake
is a defect of its own. Trigger: two unexplained reds in a row on unchanged
code. Reversal cost: one line.

If the two scenarios grow slow enough to hold up a push, they move to a
schedule plus a pull-request trigger, and the push job keeps the unit suite
alone. Trigger: an e2e job past ten minutes. Reversal cost: low, the workflow
triggers only.
