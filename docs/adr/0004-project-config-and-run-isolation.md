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
  archived ledger records the base sha. The root the runs sit under is the
  daemon home's own unless instance config names another (`worktreeRoot`, an
  absolute path) — it describes the machine, like `composeCommand`, and it
  exists because a platform path ceiling is measured from the root down: a
  project whose deepest test artifact is long needs the part above it short.
  The layout settles when the daemon starts, so a live edit applies at the
  next start and no open run has its workspace moved under it.
- **Per-run stacks.** Each run's compose project is named `oly-<runId>`
  (sanitized). The template comes from the run worktree, so it rides the
  same sha as the code. The stack derives every name and connection string
  from the env the daemon passes (`COMPOSE_PROJECT_NAME`, `OLYMPUS_RUN_ID`,
  `OLYMPUS_WORKTREE`, plus static template env); no fixed host ports.
  Teardown works from the project name alone, so it survives worktree
  removal. The compose argv is instance config (`composeCommand`) — it
  describes the machine, not the project.
- **The run env reaches every execution.** The same env the stack rose from
  is passed to every project-config command run and every seat spawned
  inside the run (`runEnv` in the lane helpers). Port discovery stays on the
  project side: the template publishes container ports to ephemeral host
  ports, and the project's own test plumbing resolves the published port at
  run time from the container runtime's port table, keyed on
  `COMPOSE_PROJECT_NAME` (compose labels its containers with the project
  and service names). The harness never resolves or injects port numbers —
  a service→variable map would be project knowledge in instance config, and
  a port file written at `up` time would be state that can go stale; the
  runtime's port table is the single source of truth and survives daemon
  restarts. With the stack env unset, project test configs fall back to
  their fixed local-dev defaults, so humans and CI see no change.
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

## Decision: a workspace removal that a hold refuses

The workspace is a checked-out application, so its removal is the step of a
close most exposed to a file another process is holding. What the release does
about that is settled here.

- **Every removal retries.** Five attempts, with a backoff that grows by
  250 ms per attempt: two and a half seconds in all. The ladder wraps the
  `git worktree remove` pass and each directory delete behind it, so one hold
  is asked again wherever it lands.
- **Only a hold is retried.** The retryable set is the answers a passing hold
  gives — `EPERM`, `EACCES`, `EBUSY`, `ENOTEMPTY`, and the prose forms git
  reports the same conditions in, because a failed `worktree remove` reaches
  the caller as git's stderr rather than as an errno. Every other answer is
  reported at the first attempt.
- **The process sweep still comes first.** It ends what the harness itself
  left standing in the workspace (ADR-0016). The ladder is for the holds no
  sweep can reach: a scanner, an indexer, a watcher outside the run.
- **A workspace that survives every attempt is named.** The release returns
  it as `leftover`, and the daemon stamps `workspace-leftover` on the
  instance ledger with the run id, the directory and what the filesystem
  said. Quiet, one open record per run, and the daemon carries on: the run
  closed as it closed, and a directory under the workspace root belongs to no
  run.
- **Both sweeps consume the record.** The start sweep and the periodic sweep
  release the union of the workspace directories with no open run and the run
  ids of the open leftover records. A release that leaves nothing behind
  pairs the `resolved` onto the record it answered, which makes
  `workspace-leftover` a resolvable event in the store alongside the loud
  classes.
- **A periodic sweep runs every fifteen minutes.** A leftover clears without
  waiting for a restart. A tick stamps only what it acted on, so an instance
  with nothing left behind writes nothing for as long as it runs.
- **A sweep touches no workspace anybody claims.** The open set is the
  engine's runs plus the run ids of the launches that are provisioning: a run
  workspace exists before the engine holds the run, and one release at a time
  per run id, so a sweep tick and a close-time teardown never delete one tree
  twice.

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

## Why a workspace that will not delete is not an alert

Three closes in one night failed their worktree removal, each on a file inside
the checked-out application and each after the process sweep had already ended
what it could find. Every one of them stamped `workspace-released ok:false`,
and every one of them left its tree where it was. Nothing ever came back to
them: the only sweep in the harness ran at daemon start, and the daemon had
been up for days. The trees accumulated under the workspace root, and the
disk was the only thing that would eventually report it.

A single removal is the wrong place to decide that a directory is stuck. The
hold is another process's, it is usually a scanner or a watcher passing over
the tree, and it is gone a second or a minute later. What the release knows at
the moment it fails is only that the hold was there just then. So the release
asks again a few times, and then hands the question to something that will ask
again later, instead of writing a failure and forgetting the directory.

That makes the leftover record a note the harness writes to itself. It is not
a decision for the owner: there is nothing to choose, the run closed in its
recorded state, and no reader resolves anything through the workspace root. A
loud record would put a chore on the one strip the owner is shown before being
asked to look at anything, and it would sit there until a human deleted a
directory by hand. Quiet, resolvable and swept is the honest shape — the
record says the harness owes itself a retry, and the sweep is the retry.

The periodic sweep is what makes the promise true. Start-only sweeping is
correct for the conditions a restart clears anyway, but the daemon is meant to
run for weeks: a leftover that waits for the next start waits as long as the
instance lives. Fifteen minutes is low enough that the sweep costs nothing
next to a run, and short enough that a hold which passed in a minute is
cleared in the same hour it appeared.

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

If the removal ladder proves too short for the holds this harness meets — a
scanner that keeps a tree for minutes rather than seconds — the attempt count
and the backoff grow, or the ladder leaves the close path entirely and every
blocked removal becomes a leftover for the sweep at once. Trigger: two
leftovers that a longer wait on the close path would have cleared. Reversal
cost: low. Two numbers, or one call site.

If the fifteen-minute period proves wrong in either direction, it becomes an
instance-config field, like every other value that describes the machine
rather than the project. Trigger: a host where leftovers routinely outlive an
hour, or a sweep whose enumeration shows up against a run. Reversal cost: low
— one constant becomes one validated field.

If a leftover turns out to need a human after all — a workspace no sweep ever
clears because the hold is permanent — the record gains a loud escalation
after a counted number of failed sweeps, rather than being loud from the
first. Trigger: one leftover that survives a day of sweeps. Reversal cost:
low. One count, at the place that already writes the record.
