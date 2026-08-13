# ADR-0016: Windows process lifecycle

Status: accepted (2026-08-14)

## Decision

Windows has no process groups a signal can address and no kill that reaches a
descendant. Four corrections follow, and the platform branch for all of them
lives in one module (`src/engine/processes.mjs`), the way `resolveArgv` owns
the executable branch (ADR-0013). Off Windows every path below is byte for byte
what shipped before.

- **A seat spawns into its own process group where it can.** On Windows
  `detached` is `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`, and the group is
  what a console control event addresses. A seat that spawns directly takes it.
  A seat that has to run under `cmd.exe` does not, for the reason below. The
  child is not unref'd, so the daemon still waits on it exactly as before.
- **The daemon does not die on a console break.** `SIGBREAK` is listened for
  and dropped. It is the signal a group-addressed console event delivers, it
  carries no indication of which member it was meant for, and the daemon has a
  stop path of its own. `SIGINT`, `SIGTERM` and `SIGHUP` still stop it.
- **A deliberate termination kills the tree.** Every place the daemon ends a
  seat on purpose — the run kill, the cost ceiling, a stop — runs
  `taskkill /PID <pid> /T /F` on Windows. A failed or unavailable `taskkill`
  falls back to the direct kill, so the child never outlives the call.
- **A release sweeps before it removes.** Workspace release enumerates the
  processes whose command line or image path sits inside the run's workspace,
  ends each one, and only then removes the worktrees. What it ended is stamped
  on `workspace-released` as `swept: {count, names}`. A sweep is refused
  outright on a root that is relative or shorter than four characters.
- **Every exit stamps.** `daemon-stopped` is written by the control stop, by
  SIGINT, SIGTERM, SIGBREAK and SIGHUP, by `process.on('exit')` as the floor
  under all of them, and by a fault handler that stamps and then exits
  nonzero. A start whose instance ledger does not end in a clean stop stamps
  `daemon-crash-detected` with the last seq the dead instance wrote.
- **A refused launch stamps.** A launch the daemon rejects appends
  `launch-rejected` with the reason, the requester, and the run id the run
  would have had. The console's reason file is unchanged.

`daemon-crash-detected` and `launch-rejected` enter the closed instance
registry; nothing else is added, and neither is stream-classed. Both are
records of something that already finished, not items that wait on a human,
and a crash that repeats surfaces as a repeated stamp rather than as a queue
the operator has to clear.

`shell: true` appears nowhere, here as everywhere (ADR-0013). `taskkill` and
`powershell.exe` are spawned as resolved executables with argument arrays.

## Why a console kill of a run took the daemon with it

Measured on the host, not inferred. A parent spawned a child the way
`superviseSeat` did, and a console control event was addressed to the **child's**
pid. The parent received it: with a listener attached it reported `SIGBREAK`,
and with no listener — the daemon's own shape — it died with exit code
`0xC000013A`, `STATUS_CONTROL_C_EXIT`, having written nothing. Repeating the
measurement with `detached` set, the parent received nothing at all.

That is the whole mechanism. A child spawned without `detached` shares its
parent's console and its parent's console process group, and a console control
event is delivered to the group, not to the process it names. So every way of
ending a seat through its console — Ctrl+Break, a console closing, any tool
that attaches to the console and raises an event — was also a way of ending the
daemon. The daemon handled `SIGINT` and `SIGTERM` and nothing else, so the
event that arrived had a default action, and the default action is termination
before any handler, any drain and any stamp. The instance ledger showed the
result three times: a `launch`, then a `daemon-started`, and no `daemon-stopped`
between them.

The kill path itself was never the problem. `killRun` calls `terminate`, which
called `child.kill()`, which is `TerminateProcess` on the one process the
handle names — it cannot reach the daemon. It also cannot reach the tool. A
Windows seat is usually `cmd.exe` running a shim (ADR-0013), so the process the
handle names is the interpreter and everything of interest is a generation
below it. Measured on the same host: after `child.kill()`, the direct child was
gone and the tool it started was still running.

## Why the isolation is two measures and not one

`detached` alone would have been the whole answer, and it is not available to
every seat. Measured, on the same shim shape the resolver produces: a batch
file spawned with `DETACHED_PROCESS` runs and its own `echo` reaches the pipe,
but the tool it launches writes nothing anywhere. The interpreter has no
console to pass on, and its child ends up with no usable standard output. A
seat's stdout is where its cost, its session id and its refusal to do the work
arrive, so losing it would trade a visible failure for a silent one.

So the seats that can be isolated are, and the daemon stops dying for the ones
that cannot. Dropping `SIGBREAK` is the same guarantee reached from the other
end: the event still arrives, and it no longer means anything. The cost is that
Ctrl+Break at the daemon's own console no longer stops it. `olympusd stop` and
Ctrl+C both do, and neither was ever the accident.

## Why a natural exit needs a sweep and a kill does not

A seat the daemon kills is now killed as a tree, so nothing survives it. A seat
that exits on its own leaves no signal behind for the descendants it started,
and those are the ones that hold the workspace: a build tool with its working
directory inside the run worktree keeps that directory undeletable, because
Windows will not remove a directory a process is standing in. One dead run left
fourteen of them, `git worktree remove` failed `EBUSY` twice, and the manual
recovery was to find them and kill them.

So the release performs that recovery itself, in the same order a human does:
end what is standing in the workspace, then remove the workspace. The
enumeration matches on command line and image path because those are the two
things Windows will report about a process; a working directory is not
reachable without reading another process's memory, which is a price this does
not pay. A tool run out of the worktree is matched by its command line, which
covers the case that was observed.

The sweep is best effort and says so. What it cannot enumerate is reported as
an error on the release rather than thrown, because a sweep that fails must not
turn a release that would have worked into one that does not.

## Why the sweep needs a floor under its root

The sweep ends every process it matches. A root of `""` matches every command
line on the machine, and a root of `C:\` matches nearly as many. Neither can
arise from a correct call, and both are catastrophic, so an unsafe root is
refused before anything is enumerated rather than trusted to the caller.

## Why every exit stamps, and what a start infers from silence

A daemon that dies without a stamp is invisible: the only trace is a
`daemon-started` with no `daemon-stopped` in front of it, which a reader has to
notice by absence. Absence is the wrong thing to build a diagnosis on, so a
start reads the tail of the instance ledger and writes what it finds. The seq
it carries is the last thing the dead instance managed to write, which is where
a reader starts looking.

The `exit` handler is the floor because it is the one hook that runs for paths
no one anticipated, and a ledger append is a synchronous write to an already
open descriptor — the only kind of work an exit handler can still do. It cannot
run after a `SIGKILL` or a `taskkill /F`, and nothing can. That case is what
`daemon-crash-detected` is for.

## On `core.longPaths`

Every Windows git invocation passes `-c core.longPaths=true`. The user-global
config does not reliably reach the daemon's git spawns, which run under
whatever account the service manager provides.

Honest limit: on the host this was written on — Git 2.53.0.windows.1, with the
OS `LongPathsEnabled` policy off — the flag changes nothing that could be
measured. `worktree add` and `worktree remove` both succeeded on a 439
character path with the flag explicitly off. This git build reaches long paths
without help, so the setting is defence for the builds that do not, and the
release failures that reported "Filename too long" are **not** explained by it.
The `EBUSY` failures are explained, and are fixed by the sweep.

## Fallback paths

If the seats that run under `cmd.exe` need real isolation rather than the
daemon's refusal to die, the spawn moves to a job object, which separates the
kill boundary from the console boundary entirely. Trigger: a console event that
reaches the daemon through a path `SIGBREAK` does not cover. Reversal cost:
moderate, a native binding or a launcher process is required either way, which
is why it is not the first answer.

If the PowerShell enumeration proves too slow at release time, the sweep moves
to a native handle query. Trigger: a release whose sweep dominates its
duration. Reversal cost: low, `listPathHolders` is one function behind a stable
return shape.

If `daemon-crash-detected` proves to need an operator's attention rather than a
reader's, it joins the loud stream and takes a paired `resolved` like every
other loud item. Trigger: a crash that goes unnoticed until it repeats.
Reversal cost: low, one entry in `LOUD_EVENTS` and a `gist` on the append.

If `core.longPaths` proves to be dead weight across every git the harness meets,
the flag goes and `gitArgv` collapses to the identity. Trigger: no supported
git build that needs it. Reversal cost: trivial.
