# Olympus v2

An autonomous development harness. One durable orchestrator daemon owns every
run from intent card to merged PR. Agent seats do judgment; supervised
processes do everything deterministic. Every run writes a complete, append-only
ledger as a first-class output.

Status: under construction. [BUILD.md](BUILD.md) is the build tracker.
[docs/architecture.md](docs/architecture.md) describes the system.
[docs/doctrine.md](docs/doctrine.md) states the rules that shaped it.

## What it does

- Runs a story as one **continuous run**: spec birth → suite → adversary →
  freeze → implementation → verdict → ship. Stages are internal states of the
  run, never separately invoked phases.
- Runs a defect or chore through the **repair lane**: fix, regression test,
  deterministic gates, one review, ship. There is no ungated path to main.
- Keeps ≥2 runs in flight with structural isolation: per-run git worktrees off
  a bare clone, and a per-run compose stack for services.
- Crosses every machine seam unattended, day and night. A run waits only at a
  named escalation, and a parked run frees its slot.
- Ships in-loop: auto-merge armed at PR open, a check watcher that stamps every
  terminal state, no human touch on the green path.

## Generic-only rule

This repository is public and holds only the generic harness. Nothing
project-specific lands here: no project names, no repo facts, no private
links, no evidence from private runs. Project knowledge lives in that
project's own config and repo. Scan every diff against this rule before
commit.

## Layout

- `bin/` — entry points (`olympusd`, tools)
- `src/` — harness source (ESM, Node ≥ 22, no runtime dependencies)
- `test/` — `node:test` suites
- `docs/` — architecture, doctrine, ADRs
