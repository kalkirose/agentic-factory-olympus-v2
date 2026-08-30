# ADR-0050: The daemon start detaches from the console that gave it

Status: accepted (2026-08-30)

## Decision

`olympusd start` starts the daemon and returns. The daemon it starts is a
detached process: it leads a session of its own, it takes its standard streams
from files under the home, and the process that spawned it is gone a moment
later. Nothing that ends the console can reach it.

`olympusd run` is the foreground form and is unchanged behaviour: it is the
daemon itself, in the process that was given the command. A service manager
wires `run`, because a service manager supervises the process it starts and
owns the restart. A person types `start`.

The two forms share every line of the daemon. The only thing `start` adds is
the spawn, the wait, and the two log files.

- **The spawn shape.** `daemonSpawnOptions()` is platform-split: `detached`
  off Windows, `windowsHide` alone on Windows. It is the one shape in the
  harness that separates from the shell. A seat takes the opposite shape for
  the opposite reason (ADR-0016): a seat is waited on and ended as a tree, so
  it stays attached, while the daemon must outlive the shell, so it does not.
  `test/processes.test.mjs` reads every child-process call site under `src/`
  and `bin/` and fails on a second one that separates.
- **Windows: one windowless console, never no console (corrected
  2026-08-30, learned live).** The first build used `DETACHED_PROCESS`,
  which leaves the daemon with no console at all. That kept the shell's
  console control events away, but it broke the silence property one level
  down: a console-subsystem descendant that starts without the hide flag
  then makes the system allocate a FRESH console session, and a desktop
  whose default terminal is a windowed host puts every one of them on
  screen. Operator desktops filled with terminal windows within the hour.
  The corrected shape is `CREATE_NO_WINDOW` (`windowsHide`) without
  `DETACHED_PROCESS`: the daemon holds one console of its own with no
  window on it, and the whole descendant tree inherits that windowless
  console, so no depth of the tree can put a window on a screen. The
  shell-survival property is unchanged: the daemon's console is its own,
  not the shell's, so closing the starting terminal delivers nothing to
  it, and the starting process exits a moment later, so a tree kill of the
  shell has nothing left to walk to.
- **Off Windows.** `detached` is `setsid`. The daemon leads a new session and
  a new process group, so a signal addressed to the shell's group does not
  name it, and a terminal hangup does not reach it.
- **Where the output goes.** `<home>/logs/daemon.out.log` and
  `daemon.err.log`, appended and never truncated, so the log of the instance
  before this one is the record of how that one ended. The starting process
  prints the pid, the home and the path of the output file, and nothing else.
- **What a start waits for.** The home's lock file, holding the pid the start
  spawned. The lock is the daemon's own statement that it came up, so a start
  that reports success reports a daemon that took it. A daemon that exits
  before it takes the lock ends the wait at once, and the start prints the
  tail of the error log with the reason.
- **The home is absolute.** Every command resolves `--home` before it uses
  it, because the started daemon runs from the home rather than from the
  caller's directory, and a relative home would name a different place in the
  child than it did in the command. The daemon holds no handle on the
  directory the command was typed in.

## Why the console was the danger

A daemon started in the foreground of a shell is a child of that shell, and
three ordinary things end a child of a shell.

- A console control event. ADR-0016 measured this: the event goes to the
  console process group, not to the process it names, and a daemon that shares
  the shell's console shares its group.
- A tree kill. Windows records a parent for every process and `taskkill /T`
  walks that record, so a cleanup aimed at the shell walks straight into the
  daemon. Measured on the host: a daemon run in the foreground of a stand-in
  shell dies with a tree kill of that shell, every time.
- A job object, or a terminal hangup off Windows. Both are addressed to a set
  the child is in by inheritance.

Detaching answers the first two completely. The daemon leaves the console and
the group at creation, and by the time any cleanup runs its parent has exited,
so the kernel's parent record no longer joins it to the shell.
`test/daemon-detach.test.mjs` stages exactly that accident: a stand-in shell
runs `olympusd start`, the whole shell tree is ended the way a cleanup ends
one, and the daemon is asked whether it is still there. The control experiment
is on the record above: the same test shape against the foreground form kills
the daemon.

## The honest limit

A job object with kill-on-close is not answered by this. Node offers no way to
ask for `CREATE_BREAKAWAY_FROM_JOB`, so a daemon started inside such a job
stays inside it and dies when the job closes. The service-manager wiring is
the answer for a host where that is a real risk: a service is started by the
service control manager and is in no caller's job. This limit is stated here
rather than worked around, because the workarounds available without native
code (creating the process through a system service, for example) each cost
the environment the caller passed, which the daemon needs.

## Fallback paths

If a host is found where a job object takes the daemon down, the start moves
to creating the process through a launcher that breaks away from the job.
Trigger: a daemon exit with no `daemon-stopped` stamp, on a host whose shell
runs jobs. Reversal cost: moderate. A native binding or a helper process is
needed either way, which is why it is not the first answer.

If the detached daemon proves hard to read on a host because its output is in
a file rather than on a terminal, `olympusd run` is already the answer and
needs no change to reach: it is the same daemon in the foreground. Trigger: an
operator who wants the stream live. Reversal cost: none.

If the log files prove to grow without bound on a long-lived instance, they
gain rotation at the start: the start renames the previous pair before it
opens the new one. Trigger: a home whose log directory outgrows its ledgers.
Reversal cost: trivial, one rename in `spawnDetachedDaemon`.

If a start ever has to report more than the lock can say, the wait moves from
the lock file to the instance ledger's `daemon-started` stamp, which carries
the runs the instance resumed. Trigger: a start that has to print what came
back up. Reversal cost: low, one reader swapped in `awaitDaemonStart`.
