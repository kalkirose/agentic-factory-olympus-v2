# ADR-0065: A flake re-run asks only what failed

Status: accepted (2026-09-03)

## Decision

Every red Tier-1 layer gets one red-only re-run before the harness calls the
red the layer's answer. That re-run asks for the failure and for nothing else.

- **The re-run's scope comes from the replaced attempt's own part table.** A
  layer command that names its parts says which of them passed (`::olympus
  part-ok`) and which failed (`::olympus part-failed`). The parts that did not
  pass are the parts the re-run asks for, in `OLYMPUS_PARTS`. The parts that
  passed are not bought again.
- **A part may also name the files that failed inside it.** The marker
  protocol carries one more line, `::olympus part-failed-files <part>
  <path>[,<path>…]`, printed from the framework's own summary rather than
  guessed at. The harness passes those files back in `OLYMPUS_FAILED_FILES`,
  as `<part>=<path>,<path>;<part>=…`, and the command runs that part through
  its own path filter. A part that named no file runs whole.
- **The record is one complete part table at one sha.** The greens of the
  replaced attempt ride the re-run's `layer-result`, each carrying the
  `attempt` that earned it, beside the parts the re-run itself ran. Nothing in
  such a table is `carriedFrom`: a carry is an older sha's green, and every
  part here was proven at this one. The result also carries `narrowedTo`
  (`parts`, `files`), which is what that attempt was asked for.
- **Every doubt buys the whole layer.** A layer that named no part narrows
  nothing. A part that said nothing about itself did not pass, so it re-runs. A
  re-run whose every part is red and file-less is the whole layer, and it asks
  for the layer. A part name or a path that holds a separator of the encoding
  cannot be stated in it, so that part re-runs whole. An empty variable is no
  variable: the harness sets neither variable where it has nothing to say.
- **The narrowing is asked for, never imposed.** A command that reads neither
  variable runs everything and is recorded for everything it ran. What the
  execution states always beats what the harness kept.
- **The disposition is unchanged.** A green re-run stamps `flake` and never a
  finding; a red re-run is the layer's answer and enters triage. The replaced
  attempt is still stamped `superseded-by-rerun` with its own output and its
  own log file.

The loop lives in `runLayer()` in `src/lanes/spectrum.mjs`, the scope decision
in `narrowRerun()` beside it, the merge in `partTable()` in the same file, and
the encoding in `failedFileNarrowing()` in `src/lanes/parts.mjs`. The marker
line is parsed in `src/lanes/exec.mjs` with the four markers it grew from.

## What this is for

The flake filter exists because a first red is often the host and not the
tree. Its cost is a second run of the layer. On the reference project the
acceptance layer is 88 minutes of 43 test files, and a host name-lookup stall
that failed seven of them bought all 43 again: 88 minutes to re-ask a question
seven files could answer in twenty seconds. The filter's value is in the
answer, and the answer is about the files that failed. Everything else the
re-run bought was already proven at that sha, in that attempt, minutes before.

The saving is every red layer of every cycle, which on a story is four to
eleven of them.

## Why the file and not the test

The file is the unit both test frameworks filter by from the command line, and
it is the unit that boots an application. Below the file the work is inside one
boot and cheap; above it the whole part is the unit, which is what the harness
asked for before this. So the file is where a narrowing buys the minutes.

## Why the runner names the files and the harness does not parse them

The harness holds no knowledge of a project's test frameworks and gains none
here. A runner that dispatched a framework knows what that framework's summary
said; the harness reading the same summary would be a parser per framework, in
the harness, drifting behind every upgrade. So the runner prints what it
already knows, and the harness carries the names back verbatim.

The failure mode of that division is the safe one. A framework that changes its
summary breaks the runner's own parse, the runner names no file, and the part
re-runs whole, which is the behaviour of every layer before this decision.

## Why a narrowed re-run proves enough

It proves less about the layer than a whole re-run and exactly as much about
the tree. The parts and files it does not buy were green at this sha in the
attempt it replaces, and nothing changed between the two attempts: the tree is
the same commit, the suite is the same freeze, the same machine ran both. A
green that a second run of the same bytes would repeat is not evidence a
verdict needs twice.

What a whole re-run would additionally catch is a test that passes and then
fails on identical inputs. That is a flake in the other direction, and one
this filter never claimed to find, because it only ever re-ran the reds.

## Why the merged table names the attempt

A part table is read as evidence. Two attempts of one layer produce two partial
tables, and a reader handed either one alone would either miss the parts the
other proved or read a green of the first attempt as a result of the second.
So the record holds one table, and every line of it names the attempt behind
it. The alternative, leaving the second attempt's table partial, would make
the layer's own record incomplete at the sha it judged, which is the property
every later cycle's carry is derived from.

## Fallback paths

If a narrowed re-run ever calls a layer green where a whole re-run would have
found it red, such as a part whose pass depends on another part running beside
it or a file whose pass depends on a file before it, the project sets
`gates.flakeRerun: "whole"` and every re-run buys the whole narrowing it was
given, exactly as before this decision. Trigger: one such red, found by the
confirmation sweep or after a merge. Reversal cost: none, one config field;
the code stays and goes inert.

If only the file half proves unsound while the part half holds, the retreat is
narrower and belongs to the runner: it stops printing `part-failed-files`, the
harness sets no `OLYMPUS_FAILED_FILES`, and the re-run buys whole parts. One
line, in the project that owns the runner.

If a project's parts are so unequal that the narrowing buys nothing, with one
part holding every file, the declaration grows rather than the rule: the runner
opens more parts. Nothing in the harness changes, because the harness holds no
opinion about what a part is.
