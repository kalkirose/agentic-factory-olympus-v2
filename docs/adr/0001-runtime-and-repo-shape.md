# ADR-0001: Runtime and repository shape

Status: accepted (2026-08-09)

## Decision

The harness is one Node.js package: ESM, Node ≥ 22, **zero runtime
dependencies**. Tests run on `node:test`. Syntax checks run on `node --check`.
CI is one GitHub Actions workflow that runs both.

Layout: `bin/` entry points, `src/` modules, `test/` suites, `docs/` with
ADRs. No build step: the source runs as written.

## Why Node

- The daemon's core job is child-process supervision, file I/O, and small
  HTTP servers. The Node standard library (`node:child_process`, `node:fs`,
  `node:http`, `node:test`) covers all of it.
- Everything the harness drives is a CLI: `claude`, `git`, `gh`, `docker
  compose`. No SDK dependency earns its place.
- One runtime for daemon, tools, and the command-center server keeps the
  layer count minimal (doctrine: minimize layers).

## Why zero dependencies

- The repo is public; a zero-dependency tree is auditable and has no supply
  chain to compromise.
- The components that tempt dependencies (schema validation, JSONL stores,
  process supervision) are small enough to own, and owned code follows the
  harness's own rules (append-only discipline, closed registries).

## Fallback path

If zero-dependency proves too costly for a component, admit a single-purpose
dependency by a new ADR, one at a time. Trigger: owned code for one concern
grows past the size of a focused audit (roughly a thousand lines) or develops
correctness bugs a mature library has already solved. Reversal cost: low —
dependencies add behind the same module seams.
