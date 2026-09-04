# ADR-0016: Windows process lifecycle

Status: accepted (2026-08-14, the POSIX group 2026-09-04)

## Decision

Windows has no process groups a signal can address and no kill that reaches a
descendant. The corrections below follow from that, and the platform branch for
all of them lives in one module (`src/engine/processes.mjs`), the way
`resolveArgv` owns the executable branch (ADR-0013).

Off Windows one hole is the same hole for the same reason — a signal to one pid
reaches one process — and POSIX already has the answer Windows lacks. So the
harness spawns the children it ends as trees into process groups there and ends
the group. `detached` means opposite things on the two platforms, and this
module is where that is stated once: on Windows it is `DETACHED_PROCESS` and it
is never taken, and off Windows it is `setsid`, which is a session and a group
and nothing about a console.

- **A child the harness ends as a tree spawns onto a console that has no
  window, or into a process group.** `treeSpawnOptions` is that one decision,
  and every such child takes it: a seat, and every command a gate layer or a
  probe runs. On Windows it is `windowsHide`, which is `CREATE_NO_WINDOW`: the
  child is handed a console of its own with no window on it, and its whole
  descendant tree inherits that console instead of opening one. One shape
  covers both seat shapes, the tool that spawns directly and the shim that runs
  under `cmd.exe`. `detached` is not taken there: it is `DETACHED_PROCESS`,
  which leaves the child with no console at all, and a console program that has
  none opens a visible one. Off Windows it is `detached`, which makes the child
  a process-group leader whose group the kill can address. The child is not
  unref'd on either platform, so the daemon still waits on it as before.
- **Nothing the harness starts shows a window.** The seat spawn, the
  project-config command runner, git, compose and the notifier command each
  carry `windowsHide` at the call itself, after the caller's own options so
  that none of them can drop it. `test/processes.test.mjs` reads every
  child-process call site under `src/` and fails on one that does not.
- **The daemon does not die on a console break.** `SIGBREAK` is listened for
  and dropped. It is the signal a group-addressed console event delivers, it
  carries no indication of which member it was meant for, and the daemon has a
  stop path of its own. `SIGINT`, `SIGTERM` and `SIGHUP` still stop it.
- **A deliberate termination kills the tree.** Every place the daemon ends a
  child on purpose — the run kill, the cost ceiling, a stop, a command that ran
  past its bound — runs `taskkill /PID <pid> /T /F` on Windows and signals the
  negative pid off it, which is the child's own process group. A failed or
  unavailable `taskkill`, and a group that has already gone, both fall back to
  the direct kill, so the child never outlives the call.
- **A release sweeps before it removes.** Workspace release enumerates the
  processes standing inside the run's workspace, ends each one, and only then
  removes the worktrees. Standing inside it is three separate things: a command
  line that names the workspace, an image loaded out of it, and a working
  directory inside it. What it ended is stamped on `workspace-released` as
  `swept: {count, names}`. A sweep is refused outright on a root that is
  relative or shorter than four characters. What the removal does when the
  sweep is not enough is ADR-0004.
- **The same enumeration, without the kill, names a holder.** A workspace that
  survived the whole release is read once more, and the pid, image name and
  matching signal of everything standing in it go onto the record of it
  (ADR-0004). It is the sweep's own query under the same root guard; it ends
  nothing, it never throws, and it answers what outlived the kill — which on
  this harness is usually a seat's surviving descendant. The signal is on the
  record because the three do not mean the same thing: a command-line match may
  be a process that merely mentions the path, and a working-directory match is
  a process that is physically in the way of the `rmdir`.
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
and with no listener, the daemon's own shape, it died with exit code
`0xC000013A`, `STATUS_CONTROL_C_EXIT`, having written nothing. Repeating the
measurement with the child on a console of its own, the event ended the child
and the process that raised it, and the parent lived.

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

## Why the console is the boundary and not the process group

A seat's descendants are console programs in their own right: git, `cmd.exe`, a
build tool, a shell. The harness does not spawn any of them, so none of them
takes an option from it. What each one gets is settled one generation up,
because a child inherits its parent's console. The seat's console is the only
place the question can be answered at all.

Three shapes were measured on the host, each with a seat that ran a console
program of its own and reported the console it was handed.

- A plain spawn. The descendant inherits the daemon's console, and a console
  control event addressed to the seat reaches the daemon. That is the failure
  above.
- `DETACHED_PROCESS`. The seat has no console, so the descendant opened one:
  `GetConsoleWindow` returned a handle and `IsWindowVisible` returned true. A
  window on the operator's screen, one for every console program a seat runs.
  `CREATE_NO_WINDOW` was set on that same spawn and changed nothing, because
  Windows ignores it next to `DETACHED_PROCESS`.
- `CREATE_NO_WINDOW` alone. The seat is handed a console of its own that has no
  window, and the descendant reported that same console and no window.
  `GetConsoleProcessList` showed the seat and its descendant on one console and
  the parent on another.

The third answers both questions at once. Nothing appears on the operator's
screen, and a console control event raised on a seat's console cannot reach the
daemon, because delivery goes only to the processes attached to the console the
sender is attached to. Measured: a break addressed to such a seat ended the seat
and the process that raised it, and the parent lived.

It also keeps the seat's stdout, which `DETACHED_PROCESS` does not. Measured on
the shim shape the resolver produces: under `DETACHED_PROCESS` the batch file
runs and its own `echo` reaches the pipe, and the tool it starts writes nowhere;
under `CREATE_NO_WINDOW` both arrive. A console with no window is still a
console, so the interpreter has one to pass on and its child has usable standard
handles. A seat's stdout is where its cost, its session id and its refusal to do
the work arrive, so nothing that costs it is taken.

Termination is untouched by any of this on Windows. A deliberate end there is
`taskkill /PID <pid> /T /F`, which walks the parent-child tree the kernel
records; it never read a process group, so a seat that is not detached is ended
exactly as before, descendants included.

Off Windows the group is the mechanism, because there is no `taskkill` and
`child.kill()` reaches one pid. A seat is `cmd.exe` running a shim on Windows
and a shell running a tool elsewhere, and a gate command is a sequence of its
own on every platform: in both shapes the work is a grandchild, and killing the
handle alone answers the caller while the thing that hung carries on. The group
is what a signal can address, `detached` is what puts the child in one of its
own, and the negative pid is what reaches every member. The console reasoning
above does not apply: a POSIX `setsid` child has no console to lose and opens
no window, which is why the same word is safe on one platform and refused on
the other.

Dropping `SIGBREAK` stays. It is the same guarantee reached from the other end,
it costs nothing, and it covers whatever reaches the daemon's own console. The
price is that Ctrl+Break at that console no longer stops the daemon.
`olympusd stop` and Ctrl+C both do, and neither was ever the accident.

## Why a natural exit needs a sweep and a kill does not

A seat the daemon kills is now killed as a tree, so nothing survives it. A seat
that exits on its own leaves no signal behind for the descendants it started,
and those are the ones that hold the workspace: a build tool with its working
directory inside the run worktree keeps that directory undeletable, because
Windows will not remove a directory a process is standing in. One dead run left
fourteen of them, `git worktree remove` failed `EBUSY` twice, and the manual
recovery was to find them and kill them.

So the release performs that recovery itself, in the same order a human does:
end what is standing in the workspace, then remove the workspace.

## Why the sweep reads a working directory

Command line and image path are the two things Windows reports about a process,
and matching on them alone leaves the holder that matters invisible. Measured on
the host: a node started with `cwd` inside a workspace, a relative argument and
the shared `node.exe` as its image is reported by neither field, `rmdir` on
every directory above it fails `EBUSY`, and the enumeration returns nothing. The
instance ledger has the same shape in it — twenty-one releases that cleared
nothing, the last ones `EBUSY` on an application directory inside the tree, with
a sweep that had just ended four processes and a leftover record that named no
holder at all. One workspace took six release attempts across twenty hours and
was still there.

A working directory is only in the process's own memory, so the sweep reads it:
the PEB holds the parameter block and the block holds the directory as a counted
UTF-16 string. The read is a P/Invoke compiled inside the same PowerShell the
enumeration already runs, and the cost is the price of the answer — measured at
about 300 ms to read every process on the machine, on top of a query that was
already spawning PowerShell. Everything it can be refused by, it answers nothing
for: another user's process, a protected process, a process that exits between
the listing and the read. A PowerShell that cannot compile the reader keeps the
other two signals, because a narrower answer is the answer the query gave before
and a release has to run either way.

Everything the query matches is ended, the working-directory match included. A
process whose working directory is inside a run workspace is inside a tree the
harness is deleting, and there is no reading of that under which it should
survive the delete.

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

What did explain them: git refusing a removal the operating system performs.
The answer is not a git setting at all — the release deletes the tree itself
when git will not, and every delete the harness performs goes in the
extended-length path form (ADR-0004).

If the POSIX process group proves wrong — a child that must stay in the
daemon's group, or a host where `setsid` costs something the harness needs —
`treeSpawnOptions` returns an empty object off Windows again and
`terminateTree` falls back to the direct kill it always had, which is the
behaviour that shipped before this. Trigger: a child whose group kill reached
something it should not have, or a signal path that stopped working. Reversal
cost: two branches in `src/engine/processes.mjs`, one structural test, and this
record.

## Fallback paths

If a console event reaches the daemon through a path that neither the seat's own
console nor the `SIGBREAK` drop covers, the spawn moves to a job object, which
separates the kill boundary from the console boundary entirely. Trigger: a
daemon exit with no `daemon-stopped` and a seat kill in front of it. Reversal
cost: moderate, a native binding or a launcher process is required either way,
which is why it is not the first answer.

If the PowerShell enumeration proves too slow at release time, the sweep moves
to a native handle query. Trigger: a release whose sweep dominates its
duration. Reversal cost: low, `listPathHolders` is one function behind a stable
return shape.

If the working-directory read proves unavailable on a host — a PowerShell that
refuses to compile a type, a policy that refuses the memory read — the sweep is
already what it was without it: the two reported fields, and a leftover record
for what they miss. That degradation is the fallback and it needs no change to
reach. If instead the read proves unavailable often enough that leftovers come
back, the answer is a job object at spawn, which makes the whole descendant tree
killable without enumerating anything. Trigger: leftover records whose holders
are empty on a host where the reader did not run. Reversal cost: moderate, a
native binding or a launcher process is required either way.

If `daemon-crash-detected` proves to need an operator's attention rather than a
reader's, it joins the loud stream and takes a paired `resolved` like every
other loud item. Trigger: a crash that goes unnoticed until it repeats.
Reversal cost: low, one entry in `LOUD_EVENTS` and a `gist` on the append.

If `core.longPaths` proves to be dead weight across every git the harness meets,
the flag goes and `gitArgv` collapses to the identity. Trigger: no supported
git build that needs it. Reversal cost: trivial.
