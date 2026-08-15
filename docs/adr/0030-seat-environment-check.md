# ADR-0030: The seat environment, checked at start

Status: accepted (2026-08-15)

## Decision

The daemon reads the environment its seats will run in once, at start, and
stamps every defect it finds to the instance ledger. It repairs nothing and
refuses nothing.

- **Three checks, all read-only.** The configured `claudeCommand` resolves to
  a file this host can execute. The runner CLI records trust for the paths
  seats work in. Git in each project clone holds `core.longPaths` on Windows.
- **The paths asked about are roots.** A run worktree does not exist until the
  run that owns it launches, so no human could have trusted it in advance. The
  check asks about the run-workspace root and each project's bare clone, and
  trust of a directory above a path counts as trust of the path.
- **The trust store is derived, never hardcoded.** The instance config names
  the command; the command names the CLI; the CLI's config file is
  `.<name>.json` under the directory `<NAME>_CONFIG_DIR` names, or under the
  home directory. Any true flag whose name speaks of trust counts as the
  recorded decision, because the key belongs to the CLI's schema and not to
  this harness.
- **One quiet event per defect, once per instance.** `seat-environment`
  carries the check, a severity, the machine-readable reason, the path asked
  about and the project it belongs to. A clean host stamps nothing. Nothing
  re-asks: a live config edit, a launch and a run close all leave the record
  as the start wrote it.
- **Severity, not a park.** `blocking` means no seat can run at all (an
  unresolvable runner); `degraded` means seats run with less than the harness
  configured for them. Both start the daemon.
- **An instance with no project stamps nothing.** It launches no run, so it
  spawns no seat, and it has no seat environment to answer for. A project
  added to a running instance is checked at the next start.
- **The console shows this start's findings.** `olympusctl status` carries them
  under the projects, from the last `daemon-started` onward.

## What this is for

Every seat of one recent run carried "Ignoring 4 permissions.allow entries:
workspace has not been trusted" on its stderr. Nothing failed. The permissions
the harness had configured for those seats were dropped on the floor, once per
spawn, for the length of the run, and the only reader was a stderr stream that
nobody keeps.

That is the shape of all three of these defects. They are properties of the
host rather than of a run, they are the same for every seat, and they degrade
silently: the seat starts, the work happens, and what the harness asked for is
quietly not what it got. A per-seat warning is the worst place to put such a
signal — it arrives at the moment nobody is reading, it repeats until it is
wallpaper, and it belongs to no record.

The instance ledger is the record of what this machine did with its factory.
A statement made once, at the start, in the place a reader already looks, is
worth more than the same statement made two hundred times where nobody does.

## Why these three

They are the host facts a seat cannot survive or cannot notice.

The runner command is the whole factory: an unresolvable name fails at the
spawn of every seat of every run, as an ENOENT that names a string with no
statement of where it came from. `core.longPaths` is the setting the harness
gives its own git invocations because a run worktree nests a run id and a
workspace under the daemon home, which clears 260 characters on an ordinary
tree (ADR-0016). A seat's git and a project's own commands get no such
argument: they take the setting from the repository they run in, so a clone
without it hands a seat less than the harness gives itself, on the git builds
where the setting still decides the outcome. Trust is the one that fails
without failing at all.

Everything else a seat needs is either project config, which the launch
already proves by reading it, or a credential, which has its own gate in front
of the money (ADR-0027).

## Why a stamp and not a park, and not a refused start

The daemon never self-clears a provisioning gate, so a park here would be
correct in spirit and wrong in effect: a park stops work and waits, and two of
these three defects cost a run nothing but its configured permissions and a
path ceiling. Parking the factory over a condition the owner may already know
about, on a host that has been running fine, trades a real cost for a
theoretical one.

A refused start is worse. The daemon is a service the OS restarts; a start
that refuses on an environment defect turns a degraded factory into a restart
loop, and the loop's evidence is the same stderr nobody reads.

So the blocking finding stays a stamp too. A daemon whose runner cannot spawn
will say so again at the first seat, loudly, through the machinery that already
owns that failure (a seat failure, a park, an alert). This check exists to name
the cause before the seat pays for it, not to become a second authority over
whether the factory may run.

## Why not a loud record

A loud record is a request for the owner's eyes that ends at the event which
answers it (ADR-0015). No event here answers one: the daemon cannot see a PATH
edit, a trust dialog, or a `git config` at some later minute. The record would
sit on the strip until a human resolved it by hand, and the next start would
open it again.

The start-time stamp is self-clearing instead. The daemon that starts after
the fix says nothing, and the status render shows only what the current start
found — so an empty section is evidence, not an absence.

## Why the check reads the CLI's own config

The trust decision is the CLI's, recorded in the CLI's own file, and the
harness has no business writing there. It also has no business hardcoding
where "there" is: the instance config names the command, so the command names
the file. A harness that spawns a different runner tomorrow asks that runner's
store the same question, and a host that moves its config directory says so
through the environment name that CLI already reads.

## Fallback paths

If the trust check reports a store this host does not hold on every start —
a runner CLI that keeps no such file, or keeps it somewhere the convention
does not reach — the check's derivation is one function. Point it at the file
the CLI actually uses, or drop the check to the two that remain. Trigger: a
`store-unreadable` finding on a host whose seats are demonstrably trusted.
Reversal cost: low, one function in `daemon/environment.mjs`, no ledger or
console change.

If the long-path finding becomes standing noise because operators would rather
the harness fix it than report it, the fix is one `git config` in
`ensureBareClone`, and the check then reports a condition that cannot occur.
Trigger: the same finding surviving two starts. Reversal cost: low, but it is
a real change of stance — the daemon would then write to a repository's config
on the operator's behalf, which is why it is not the first answer.

If a blocking finding turns out to be missed in practice — a factory left
running for hours on a runner that cannot spawn — promote that one class to a
loud record settled by the human from a console, the way a stall is
(ADR-0015). Trigger: one such episode. Reversal cost: a registry line, an
ownership entry, and a test; the check itself does not change.
