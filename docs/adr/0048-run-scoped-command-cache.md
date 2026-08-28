# ADR-0048: One cache directory per run, inside the worktree

Status: accepted (2026-08-29)

## Decision

A run's workspace holds one directory its commands may cache in. It is created
at provision, it is named to every command and every seat of the run, it is
invisible to git, and it goes away with the workspace at close.

- **`<worktree>/.olympus-cache`, named in `OLYMPUS_CACHE_DIR`.** Every command
  the harness runs inside a run gets the variable, and a command that has
  something expensive to keep between cycles points its own cache option at
  it. The harness knows nothing about what any of them keeps there.
- **Its life is the run's.** The worktree is created at launch and deleted at
  close, so the cache survives every cycle of one run and no part of it
  outlives that run. A new run starts cold by construction, with nothing to
  invalidate and nothing to sweep.
- **Git cannot see it.** The provision writes `/.olympus-cache/` into the
  clone's own `info/exclude`, once, idempotently, inside the clone lock. That
  file is the harness's, in the harness's clone, so nothing in the project
  repository is touched and no commit is needed to hold it.
- **It is the run's, not the tree's.** A command the run spawns in a
  disposable worktree (an adversary wave) is given the same directory, because
  the variable names the run's workspace and not the tree the command happens
  to sit in. That is right for the caches this is for, which are keyed by file
  content, and it is the same isolation boundary as everything else here: the
  run.
- **`runCache: false` turns it off**, and then no directory is created and no
  variable is set, which is what every command saw before this existed.

The directory and the exclusion live in `src/isolation/worktrees.mjs`, the
creation in `RunIsolation.provision()`, and the naming in `runEnv()` in
`src/lanes/shared.mjs`, which is the one place a run's command environment is
assembled.

## What this is for

A verdict cycle re-transforms and rebuilds from zero. On the reference project
the acceptance layer's runner transforms the same TypeScript on every cycle of
a run, and a repair cycle that changed one file pays the whole transform again.
The work is deterministic and content-keyed by the tools that do it, so the
second cycle is buying a result it already had.

The harness cannot do that caching itself, and should not try: the cache
formats belong to the runners. What it can do is offer one place with the
right lifetime, which is the part a command cannot arrange for itself. A
command that wrote its cache under the repository would have it committed; one
that wrote it under the home would have it outlive the run and need a sweep;
one that wrote it under the system temp would share it between runs that are
meant to be isolated.

## Why the run and not the machine

A cache that outlived the run would be faster still and would be the wrong
trade. Every guarantee this harness makes about a verdict is a guarantee about
one tree judged by one suite in one workspace, and a cache carried between runs
is state carried between runs: a false green traced to a stale cache entry
would cost more than every transform it ever saved. The run boundary is where
the workspace is already born and destroyed, so the cache inherits an
isolation the harness already proves rather than one it would have to add.

Within a run the same argument does not apply. The cycles of a run judge the
same tree as it moves, the tools' own keys are content keys, and a changed file
re-transforms by construction.

## Why inside the worktree, and why that needs the exclude

Inside the worktree is where a command can reach it under every layout a
project might run under, including one where the command runs against a
mounted copy of the tree. A path beside the worktree would be outside anything
mounted from it.

That choice has one hazard, and it is a real one: the candidate capture commits
the worktree with `git add -A`. A cache git can see is a cache that gets
committed to the run branch and pushed in the request. So the exclusion is not
a tidiness measure, it is the condition on which the location is allowed, and
it is written before the directory is created. The test holds it end to end: a
file written into the cache leaves `changedFiles` empty and reaches no commit.

`info/exclude` in the clone rather than a `.gitignore` in the tree, because a
`.gitignore` is a change to the project's tree, which the harness must not
make, and it would show up in the very diff the capture polices. The exclude
file belongs to the clone, which belongs to the harness.

## Why it is offered rather than applied

The harness sets a variable and creates a directory. It does not add a
`--cacheDirectory` to anybody's command, because it does not know what any
command is, and a command whose argv the harness edited would no longer be the
command the project declared. A project adopts the cache by reading the
variable in its own configuration, one command at a time, and a project that
reads it nowhere is exactly where it was.

## Fallback paths

If a cache ever produces a result the same tree would not have produced
without it, the project sets `runCache: false`. No directory is created, no
variable is set, and every command transforms and builds from zero as before.
Trigger: one verdict whose red or green could not be reproduced on a cold
tree. Reversal cost: none, one config field.

A project can also retreat one command at a time without touching the harness,
by dropping the variable from that command's own configuration: the directory
stays, and the command that stopped reading it stops using it.

If the exclusion ever fails on some git version or layout, the failure is
visible rather than silent: the cache appears in the capture's own diff report
and in the request. The narrower answer then is to move the directory beside
the worktree instead of inside it, which costs one line in `runCacheDir()` and
loses only the mounted-tree case.
