# ADR-0004: Project config and run isolation shapes

Status: accepted (2026-08-10)

## Decision

Project config, bare clones, run worktrees, and per-run stacks get these
concrete shapes:

- **Project config schema (version 1).** One JSON in the project repo with
  the sections `repo` (path entries: `testPaths`, `uiPaths`; an entry is a
  plain prefix, or a glob pattern when it carries a metacharacter — git
  `:(glob)` pathspec semantics, so co-located test files are addressable
  without fencing whole source directories), `commands`
  (name → argv; the single home for every runnable command), `gates.tier1`
  (ordered layers; each names a key in `commands`; `needs` may name earlier
  layers only), `conventions` (one line each), `lanes` (per-lane settings),
  `stack` (`composeFile` relative to the repo root, optional static `env`),
  and `tripwires`. The tripwire section is shape-checked here (unique `id`,
  a `metric` string); the watcher milestone owns the metric semantics.
- **Config read at launch.** The daemon reads the config from
  `<defaultBranch>:<configPath>` in its bare clone at every run launch. An
  invalid config fails the launch before any worktree exists. The launch
  payload and the workspace record carry the config's git blob id — the
  ledger names the exact config a run started with.
- **Fetch discipline.** The bare clone (one per project, under the daemon
  home) pins a heads-only refspec; every launch fetches with prune first. A
  failed fetch fails the launch. No run starts on silently stale refs.
- **Worktree layout.** `worktrees/<runId>/tree` is the run worktree, on a
  fresh branch `run/<runId>` off the default branch head. Disposable
  worktrees (adversary waves) sit beside it as `worktrees/<runId>/<tag>`,
  detached at a named sha. At close, every worktree under the run root, the
  root, and the run branch go away. Shipped work lives on the remote; the
  archived ledger records the base sha.
- **Per-run stacks.** Each run's compose project is named `oly-<runId>`
  (sanitized). The template comes from the run worktree, so it rides the
  same sha as the code. The stack derives every name and connection string
  from the env the daemon passes (`COMPOSE_PROJECT_NAME`, `OLYMPUS_RUN_ID`,
  `OLYMPUS_WORKTREE`, plus static template env); no fixed host ports.
  Teardown works from the project name alone, so it survives worktree
  removal. The compose argv is instance config (`composeCommand`) — it
  describes the machine, not the project.
- **Workspace record.** Provision writes `workspace.json` into the run
  directory: project, worktree, branch, base sha, config blob, stack name.
  It archives with the run and makes release restart-safe — release reads
  it from the live run directory or the archive.
- **Teardown at close.** The engine calls an `onClosed` hook after the run
  archives; the daemon releases the workspace asynchronously and stamps
  `workspace-released` (new instance event) with `ok` and the collected
  errors. Release runs every step it can instead of stopping at the first
  error. At start, the daemon sweeps workspace directories whose run is not
  open — a daemon that died between close and teardown leaves exactly these.

## Why a failed fetch fails the launch

The alternative — launch on the last fetched state — makes "config changes
apply at the next launch" silently false on network trouble, and the staleness
would be invisible until a run built against dead code. A refused launch is
visible immediately and costs nothing: no worktree, no stack, no ledger.

## Why the run branch dies at close

A kept branch would accumulate in the bare clone with no reader: shipped work
is on the remote, and the archived ledger holds the base sha and the config
blob for any post-mortem. Forensics on a failed candidate tree happen inside
the run (stall brief, fresh pass), before close.

## Fallback paths

If per-launch fetch shows up as a launch-latency or flake sink in the
ledgers, move to a daemon-scheduled fetch with a freshness stamp the launch
checks. Trigger: fetch failures or fetch duration dominate launch telemetry.
Reversal cost: low — one call moves; the discipline stays.

If env derivation cannot carry a project's stack (secrets, multi-file
templates), add a per-run env file generated next to the workspace record.
Trigger: a project config that cannot express its stack in static env plus
derived names. Reversal cost: low — additive.

If deleting run branches loses needed forensics, keep them under a retention
sweep in the instance config. Trigger: a post-close investigation that the
archived ledger could not answer. Reversal cost: low — skip the delete.
