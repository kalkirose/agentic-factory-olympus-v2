# ADR-0013: Executable resolution for configured commands

Status: accepted (2026-08-11)

## Decision

Config names a tool; the harness resolves which file that name stands for on
the host it runs on. Every site that spawns a configured argv goes through one
resolver (`src/engine/executable.mjs`), so the rule is the same for project
commands, seat commands, the compose command, and the forge command.

The rule:

- Off Windows, the argv passes through untouched. The resolver splits it into
  file and arguments and changes nothing else.
- On Windows, a real executable (`.exe`, `.com`) is preferred, and it wins
  over a shim anywhere on PATH, not only inside the same directory. A real
  executable spawns directly, with no interpreter between the harness and the
  tool.
- A shim (`.cmd`, `.bat`) is the fallback. It runs under `cmd.exe /d /s /c`
  with a command line the resolver builds itself.
- An extensionless file is never a candidate. Windows cannot execute one, and
  the npm install layout ships one next to every shim.
- A name with any other extension (`.ps1`, `.py`) resolves to nothing: it
  needs an interpreter this harness does not choose. The name reaches the
  spawn as configured, and the spawn reports the miss.
- An unresolvable name is passed through as written, so the failure still
  names the command the config declared.

## Why the harness owns this and config does not

A command table entry describes the project's toolchain, so `pnpm test`
belongs in project config (ADR-0004). Which file `pnpm` is on one machine is
install-layout knowledge, and it changes per host. Writing an absolute path
into a project's command table would move machine facts into the repo and
break every other host that reads the same config. The ownership test settles
it: the harness resolves, the project declares.

## Why the shim path cannot be an injection

Node refuses to spawn a `.cmd` or `.bat` without a shell precisely because
`cmd.exe` re-reads its arguments as syntax; an unescaped `&` or a stray quote
in an argument starts a second command (CVE-2024-27980). Two rules close it:

1. **No `shell: true`, anywhere.** The resolver spawns `cmd.exe` itself with
   arguments it built, and sets `windowsVerbatimArguments`. No layer below
   re-quotes or re-joins what the escaping settled, and no argument is ever
   interpolated into a string a shell then parses.
2. **Every argument is escaped for both readers.** The program's own argument
   parser wants a quoted argument with backslash escaping; `cmd.exe` wants a
   caret before every metacharacter. Doing both leaves `cmd.exe` with nothing
   but literal text (the qntm.org/cmd algorithm). A batch file re-parses what
   `%*` expands to, so every caret is doubled to survive that second read.

Carriage return, line feed, and NUL survive no escaping `cmd.exe` understands:
a command line carrying one is truncated at the break. An argument that
contains one is refused by name instead, and the refusal surfaces as a normal
run failure (`code: null` with the reason) rather than a silently shortened
command. The refusal can only be reached through a shim; a tool with a real
executable takes arguments of any shape.

## Why prefer a real executable over PATH order

Windows itself searches per directory, so a shim early on PATH would beat a
real executable later. The resolver inverts that on purpose: the direct spawn
has no interpreter, no escaping, and no argument-shape limit, so it is the
safer of two files that answer to the same name. Two different tools sharing
one name across PATH directories is the case this trades away, and a command
table can name the file exactly when that happens.

## Fallback path

If a project must run a tool that exists only as `.ps1`, or must pass
multi-line arguments to a shim, add an explicit interpreter argv to the
command table (the tool becomes `powershell` plus arguments) rather than
teaching the resolver a second interpreter. Trigger: a command table that
cannot express its tool as a real executable or a batch shim. Reversal cost:
low, the resolver already passes unknown extensions through untouched.
