# ADR-0095: The command line holds only what the harness bounds, and a spawn the host refuses is a seat failure

Status: accepted (2026-09-18)

## Context

A seat is a child process, and every child process is asked for with one
command line. The host puts a ceiling on that line. Over the ceiling nothing
starts: no child, no transcript, and no seat to ask what happened.

Two arguments of a seat dispatch are not the harness's to size. The prompt is
content: a brief carries one line per defect, and a constitution grows with the
project. The edit boundary is a list: one deny rule per path entry, and one per
sibling along the path to a file a freeze exempts, because a deny rule carries
no exception and an exemption is expressed by naming everything around it
(ADR-0019). The size of that list is the size of the directories the exempt
file sits in, which no rule of the harness decides.

The prompt already had an answer: over the ceiling it moves to a file and the
line carries the path (ADR-0005). The measurement that decided this ran once,
before the substitution, so a line still over the ceiling afterwards reached
the host with the ledger saying the prompt had been handled.

What the host does with such a line is the second half. A spawn refused for a
reason about the command line, and not about the file it names, is raised where
the call stands rather than on the child's error event: the child does not
exist, so nothing can raise an event for it. A supervisor that catches only the
event does not catch this. The throw then leaves the seat dispatch, the stage
handler and the engine, and the run stops on a liveness violation that names a
seat nobody dispatched and an argument nobody can see. Only a person can move a
run in that state.

## Decision

**No argument the harness does not bound rides the command line, and a spawn
the host refuses is a seat failure with its evidence.**

- **The command line of a seat holds what the harness sizes.** The command, its
  fixed flags, the model, the effort, the seat definition's own tool policy, at
  most one session id, one settings path, and one prompt or one prompt-file
  reference. Every one of those is bounded by a definition or by a constant.
- **The edit boundary rides the settings file.** The caller's deny rules are
  written as `permissions.deny` in the settings file the dispatch already names
  on the line. A deny rule holds in every permission mode, and a file is the one
  shape that holds at any size. The command line carries one path, whatever the
  list weighs.
- **One file carries the bound and the boundary.** A settings file the CLI
  refuses is ignored in print mode with nothing said about it, and the hook's
  own marker line is what proves the file loaded (ADR-0084). One file means one
  proof: a seat that ran a command with no marker beside it is ended, and that
  ending says its edit rules never loaded either. So every seat that carries
  rules carries a bound, and every seat that writes code is one of them, in
  every lane.
- **A dispatch that carries rules and no bound still gets the file.** The rules
  are written, no bound file is written, nothing is stamped about a bound, and
  no load proof is armed, because no hook answers a call. The shape is handled
  so that a later caller cannot put rules back on the command line by leaving
  the bound out.
- **A deny rule names one tool per pattern.** An `Edit(path)` rule holds every
  built-in tool that edits that path. A rule naming a second editing tool states
  the same boundary again, is consulted by nothing, and warns at startup.
- **The runner measures the line it will spawn, after every substitution.** The
  first measurement decides whether the prompt moves to a file. The second one
  decides the spawn. A line still over the ceiling is refused: nothing is
  spawned, the runner stamps `seat-failure` with the reason `spawn`, the
  measured length, and the argument that carries the excess, and the dispatch
  returns failed. A spawn refusal is not retried, so the lane routes it as it
  routes every seat that cannot run.
- **The refused argument is named by its flag or by its position, never by its
  content.** The longest argument of a seat dispatch is a prompt, a path or a
  rule list. A ledger a reader outside the machine may hold says which argument
  grew, not what was in it.
- **The supervisor catches the throw.** A synchronous throw from the spawn call
  is the same `seat-failure` with the reason `spawn` that the child's error
  event stamps, carrying the host's own words. The dispatch is already stamped
  before the attempt, so a reader sees the spawn, the failure, and the lane's
  route. The layer runner takes the same shape, and answers a refused spawn with
  the answer it already gives for one: no exit code, and the reason.
- **The ceiling is one constant on every platform.** A command that cannot spawn
  on the host the daemon runs on must not pass quietly on a build machine with a
  roomier limit (ADR-0005).
- **A command line built from a path set is built in batches.** A set that grows
  with the tree is split into invocations no line is too long for. Where a
  caller cannot split one, the refusal is raised with the command named, and no
  caller may swallow it: a refused command answered nothing, and a caller that
  read it as "nothing to do" would carry on over a step that never ran.
- **Two readings ride the spawn stamp.** `seat-spawned` carries `argv`, the
  measured length of the line, and `denyRules`, the number of caller rules the
  settings file carried, omitted where there were none. The first says the line
  stayed inside what the harness bounds; the second names the list that would
  otherwise have grown it.

## Consequences

The settings file is load-bearing for the boundary as well as for the bound. A
runner CLI that stopped reading `permissions.deny` from it would leave an
implementing seat free to edit the frozen suite, and the stream would not say
so. The hook's marker proves the file loaded; it does not prove the permissions
block was honoured. The capture that takes frozen writes back, and the
suite-tamper reading beside it, stay the second line (ADR-0017, ADR-0074).

The refusal path leaves two sequences, and both are readable. A refusal the
runner raises stands after `seat-bound`, where a bound exists, and
`prompt-spilled`, with no `seat-spawned` between: no child was asked for. A
refusal the supervisor catches stands after `seat-spawned`, because the attempt
was made. The invocation count counts spawns, so a retry bought after a runner
refusal is the same invocation number and overwrites that number's files. The
refused dispatch wrote no report, so nothing a reader needs is lost.

A seat that carries rules carries a bound, so the seat that resolves a merge
conflict meets the hook when it runs a layer to check its own resolution. Its
brief carries the layers of its bound and the rule behind a refusal, as every
other implementing seat's brief does.

## Rejected options

- **Spill the deny list to a second file and name it on the line.** There is no
  flag that reads tool rules from a file of their own. The settings file is that
  file, and the dispatch already names it.
- **Collapse the narrowing so that an exemption costs one rule.** A deny rule
  carries no exception, and a negation cannot reopen a file inside a directory a
  rule blocks as a whole. Any collapse would either deny the exempt file or open
  its siblings.
- **Refuse an exemption whose directory is large.** That moves a fact about the
  host into the gate that judges a specification, and a specification would be
  refused for the size of a directory.
- **Raise the ceiling where the platform is roomier.** A bound that differs per
  host is a refusal that reproduces on one machine and not on the other.
- **Give a code seat rules and no bound.** The rules would ride a file nothing
  proves loaded, and that seat would be the one code seat the bound does not
  hold.
- **Let the host refuse the line and read the throw.** The throw names the
  condition and nothing else: not the seat, not the argument, and not the
  length. A run that stops there stops for a person to read.

## Fallback path

The alternative to the second measurement is the host's own refusal, caught by
the supervisor alone: the spawn is attempted, the throw is stamped as the seat
failure, and the ledger says which seat but not which argument. The switch
trigger is a measurement that refuses a line the host would have carried, which
would show as a seat failure whose length sits near the ceiling on a host that
never refused one. The reversal cost is one block in the runner.

The alternative to the rules in the settings file is the rules on the command
line, which holds for as long as the list stays small. The switch trigger is a
CLI that stops reading a deny list from a settings file. The reversal cost is
one list in the argv builder and one block in the settings writer; the
measurement above then refuses the dispatch instead of the host refusing it.

## References

- ADR-0005, ADR-0006, ADR-0016, ADR-0019, ADR-0074, ADR-0084
- `src/seats/runner.mjs`
- `src/seats/claude.mjs`
- `src/seats/boundary.mjs`
- `src/engine/supervise.mjs`
- `src/engine/executable.mjs`
- `src/lanes/exec.mjs`
- `src/lanes/ship.mjs`
- `src/isolation/git.mjs`
- `src/ledger/registry.mjs`
