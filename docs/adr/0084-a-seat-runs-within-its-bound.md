# ADR-0084: A seat runs within its bound, and the bound is its own footprint

Status: accepted (2026-09-12)

## Context

One stage judges a tree, and it is the verdict. Every layer of the project runs
there, at the sha that ships, and the run holds the result.

An implementation seat is told to check its own work before it reports, and the
brief names the project's gate commands. Nothing bounded that. A seat that read
"the gate commands" as "the battery" ran the battery: every suite of the
repository, over a diff that touched one part of it, for the better part of an
hour inside one seat session. The run then paid for the same layers again in the
verdict, because a seat's word is not a certification.

The cost is not only time. A seat that spends its session running other people's
suites is a seat that did not spend it on the work, and its report is late for a
reason nothing in the ledger explains.

What the seat's own work reaches is knowable: it is the footprint of the seat's
diff, which is the same computation the verdict uses to scope a cycle. The bound
is that footprint, and the tool call is where it can be enforced.

## Decision

**An implementation seat is spawned with a bound, and a command that runs a layer
outside it is refused before it starts.** The seats are the ones that write code
against a tree: the dev seat and the repair-dev seat. The suite seat runs its own
suite and is already held to the test paths; a judging seat runs no layer.

- **The runner writes two files at the spawn, inside the run directory.** The
  bound file states what cannot change inside one session: the worktree, the base
  commit, every Tier-1 layer with its command argv, its ground, its `needs` and
  whether it is a setup layer, the frozen suite's name where the lane has one,
  the paths the run declared, the per-layer durations of the certified base, and
  the cap. The settings file loads one pre-tool hook over the command tools,
  in the exec form, with the bound file's path as its argument.
- **A seat the two files cannot be written for does not spawn.** The settings
  file is the whole of the bound, and an unbounded seat is the thing the bound
  exists to prevent. The refusal is the same failure the runner stamps when the
  load cannot be proven.
- **The hook decides alone, on every call.** It reads the tool input as a shell
  string, normalises whitespace, and matches it against each layer's argv. A
  command that contains no layer's argv passes. For a matched layer it computes
  the bound from the worktree as it stands: the layers whose ground the live diff
  touches, closed over `needs`, plus every setup layer, plus the frozen suite.
  The bound is computed at the call and not at the spawn, because the seat's diff
  grows while it works and a bound fixed at the spawn would refuse the layer the
  seat's newest file needs.
- **Three readings pass whatever the diff says.** A setup layer is what makes a
  worktree runnable at all, so it is in the bound by declaration and its own
  ground decides nothing. The frozen suite is the seat's own question. A layer
  with no duration reading has no cap to fail, because a cap is a claim about
  time and needs a measurement behind it.
- **Anything else exits with a refusal the seat reads as the tool's own error**,
  naming the layer and the reason, and saying that the verdict runs it.
- **Doubt refuses.** An unreadable bound file, a bound file missing the worktree
  or the base commit, and a failed git read all refuse, naming the cause. A hook
  that passed on its own failure would leave the seat unbounded and say nothing
  about it.
- **The hook writes to a file, never to the ledger.** The run ledger has one
  in-process writer holding the sequence in memory. A second writer corrupts that
  sequence and bypasses every reader listening on an append. So a refusal is one
  JSON line beside the bound file, the runner reads the file when the seat ends,
  and the same fact reaches the ledger through the one writer.
- **Two stamps.** `seat-bound` at the spawn carries the bound file's digest and
  the layer names, and no path: the run archives, and a stamp naming a live
  directory would point at a directory that stopped existing. At the seat's end
  the runner stamps one `seat-command-refused` per refusal line, with the seat,
  the layer, the command and the reason, and the count rides the seat's own
  report so a reader lands on how often that seat fought its bound.
- **The load is proven from the stream, not from the write.** A settings file the
  runner CLI refuses is ignored in print mode with nothing said about it, so
  writing the file proves nothing. The hook prints one marker line on a pass, and
  the runner reads the stream for it: a command tool call that ran with no marker
  beside it ends the seat and stamps the failure. A hook-started line is not
  evidence, because the host's own settings raise one for the same event. A call
  a hook denied settles nothing and the next one is read instead, and the denial
  is read from the hook's own exit code rather than from any message text.
- **The brief tells the seat whose the other layers are.** It lists the layers of
  the bound at the spawn and states the rule: a refused layer is not a defect to
  work around, the verdict stage runs every layer of the project at the sha it
  ships, and a layer enters the bound when the seat's own work reaches what it
  reads. A refusal a seat was not warned about reads like a broken environment.
- **The story dev report states whether the frozen suite is green.** The check
  refuses a report that says red, the way a reported defect is refused: the seat's
  own question is the one layer it is always allowed to run, so a red answer there
  is a seat reporting work it knows is unfinished. The repair lane has no frozen
  suite and no such field.

## Consequences

The bound is a refusal, not a guarantee. A wrapper script that runs a layer
without the layer's argv in the command line is not matched and not refused. The
command is a shell string rather than an argument vector, so the match is textual
by necessity. What the bound buys is that the ordinary way to run a layer is
refused, and the refusal is counted.

A seat that fights its bound is visible. A refusal count above a couple on one
seat says the brief did not land, which is a defect of the brief and not of the
seat.

The cap is one constant for every layer until the duration history behind it is
worth trusting. The certified base is what fills that history, and the cap
becomes a per-layer question when it does.

On a lane with no frozen suite and an empty declared diff, the bound at the spawn
is the setup layers alone, and the seat's first call widens it from the live
tree. That is the correct reading of a seat that has not written anything yet.

## Rejected options

- **The hook writes its refusals to the run ledger.** A second writer to a ledger
  with one in-process writer corrupts the sequence and bypasses every append
  reader. A file the runner reads is the same fact with one writer.
- **A time budget from project config.** No per-layer duration history existed to
  compare a configured number against, so the number would have been a guess
  wearing a config key. A constant cap is honest until the history is there.
- **Bound the seat by the paths the spec declared.** The declaration is what the
  work was planned to touch. The bound has to follow what it does touch, which is
  why the hook reads the live diff.
- **Tell the seat the rule and check nothing.** The brief already told the seat to
  check its own work, and a brief is not a bound: the failure this replaces
  happened under a brief.
- **Let the seat run everything and stop asking.** Then the run pays twice for
  every layer and the seat's hour buys nothing the verdict does not buy again.

## Fallback path

The alternative is the brief alone: the settings file is not written, the hook is
not loaded, and the seat is asked to stay inside its footprint. The switch trigger
is a refusal that stops honest work more than once, which would mean the match is
catching commands that are not layer runs. The reversal cost is one option on the
seat call, and the stamps stay for what they already recorded.

## References

- ADR-0005, ADR-0016, ADR-0022, ADR-0046, ADR-0056, ADR-0088
- `src/seats/bound-hook.mjs`
- `src/seats/runner.mjs`
- `src/seats/claude.mjs`
- `src/lanes/verdict.mjs`
- `src/daemon/home.mjs`
- `src/ledger/registry.mjs`
