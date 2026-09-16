# ADR-0092: A cycle runs the files that changed

Status: accepted (2026-09-16)

## Decision

The harness can name the FILES a gate command must run, and every caller that
knows which files its question is about says so.

- **One contract carries it.** `OLYMPUS_FILES` holds repo-relative test paths,
  comma-separated and forward-slashed. It is flat where `OLYMPUS_FAILED_FILES`
  is per part, because the callers that set it know which files they are asking
  about and do not know which part holds them.
- **The command answers the other half.** A command that honours the variable
  runs the named files inside every part whose own trees hold one, and runs a
  part whose trees hold NONE of them whole, because the list says nothing about
  that part. The list never skips a part. Skipping stays the job of
  `OLYMPUS_PARTS`, which is decided from declared ground.
- **A re-freeze narrows the part plan; it does not discard it.** The part plan
  used to drop any layer whose standing result predated the last re-freeze, on
  the ground that an amendment moves the suite the parts were judged against and
  a diff of the candidate tree cannot see it. The diff does see it: a re-freeze
  COMMITS the amendment, so the amended files are inside the range the plan
  already reads and are attributed to parts exactly as code files are.
- **A diff that is suite files and nothing else names its files.** The plan then
  sets `OLYMPUS_FILES` to the changed files plus the files the standing result
  left red in the parts that run. Four conditions have to hold, and each one
  that fails runs the layer whole: the standing result holds a part table and
  the plan derived at least one reason; every changed path is under the
  project's test paths AND is a suite file by shape; every part that runs is
  `touched`, or `not-green` with a red-file list that is non-empty and was not
  cut; and a part that carries contributes nothing.
- **A short red list says so.** The command reader bounds a part's red-file list
  three ways: an over-long path, the count bound, and a marker line the stream
  reader cut. Each sets `failedFilesCut` on the part, the mark travels with the
  list through every merge and every re-run, and every reader that would take a
  short list for a complete one refuses instead. Without the mark, reading a
  subset as the whole set reads a red file as green.
- **The red-state check asks about the write's own files, and reads per file.**
  The freeze's check runs the suite command narrowed to the run's own suite
  writes, filtered to files under the test paths, of suite shape, and held by
  the tree at the sha it judges. It passes when the exit is nonzero AND every
  NEW test file of the write is among the files the command reported failed.
  Four cases fall back to the exit code alone, and each is a case with no
  per-file question to ask: a runner that printed no part marker, a runner that
  failed a part and named no file inside it, a run with no base listing to say
  which file is new, and a new file missing from a list a bound cut.
- **An implementation seat is told its own test files and refused the bare
  suite.** The brief names the files this run's suite writes wrote and the two
  narrowing forms. The seat bound carries `suiteNarrowed`, and the hook then
  refuses the suite layer unless a narrowing variable is assigned inline in
  front of the command. The hook matches a layer by its config argv and by the
  project's own script names for the same run, derived from the project's script
  table; a match on the config spelling alone is a refusal nobody meets.
- **The minutes are on the record.** Every `verdict-rendered` carries
  `layerMs: {run, carried, abandoned}` in milliseconds. A `layer-started` and a
  `layer-result` carry `narrowedTo` wherever the attempt was asked for less than
  the whole layer. A layer the plan narrowed whose command started it whole
  raises the loud `whole-rerun-after-refreeze`.

The plan derivation is `fileTargets()` in `src/lanes/parts.mjs`, the encoding
`fileNarrowing()` beside it, the environment build `runLayer()` in
`src/lanes/spectrum.mjs`, the measure `layerTime()` in the same file, the
red-state reading `redStateReading()` in `src/lanes/story.mjs`, and the refusal
`refusalReason()` in `src/seats/bound-hook.mjs`.

## What this is for

A gate layer is the largest single cost of a verdict cycle, and most of what it
spends is work the run has already done. Four shapes of it, and all four have
one cause: the harness knew which files had changed and had no way to say so to
the command it ran.

A cycle after a re-freeze ran every layer whole, because the plan dropped every
carry behind the amendment. A part plan that did survive narrowed to the PART a
diff could reach, and the part then ran every file it held, so an amendment of a
few test files bought a part of dozens. The red-state check ran the whole suite
of the project to prove that a handful of new files are red. And a seat could
spend the whole of its time bound on a suite it could not narrow, because the
only file variable the runner read was the per-part one and the seat had no way
to spell it.

A suite layer of any size costs far more whole than it costs over the files one
cycle changed, and the harness paid the difference at every re-freeze cycle and
at every freeze.

## Why a flat list and not one per part

The per-part encoding already exists and is right for its own caller: the flake
filter knows which part reported which file, because the part reported it. The
three callers here know the opposite. A cycle knows which files its diff moved;
the freeze knows which files the write wrote; a seat knows which files define
its story. None of them knows the project's part table, and none should: the
part table is the command's statement about itself.

So the harness states the files and the command attributes them. The runner
already holds the tree-to-step mapping it needs for that, because it is the
thing that dispatches the frameworks.

## Why a part with no named file runs whole, and never nothing

A step whose trees hold none of the named files could plausibly be skipped: the
list does not name it, so why run it? Because the list is not a statement about
that step. A step that reads test files as DATA, a lint over every suite file, a
declaration gate over every tree, has no per-file answer at all, and a step that
reported green without running would carry a green nothing earned. Running whole
is slower and always true.

That is also why the narrowing is asked for and never imposed: a command that
ignores the variable runs the layer as it always did, and the record holds what
the stream said ran.

## Why a file list may not be shortened at the byte cap

The two encodings meet a host's environment bound differently, and the
difference is the whole of what each one means.

A per-part entry that will not fit is left out, and the part it names runs
whole. That costs minutes and can never be wrong.

A file list that will not fit may not be shortened at all. The command runs
exactly the files it is handed, so a dropped path is a file nothing ran under a
green the layer then reports. There the whole narrowing is refused and the layer
runs whole. Same bound, opposite answer, for the same reason: every doubt buys
more work and never a weaker claim.

## Why a `not-green` part may be narrowed at all

The soundness rule is not "only parts the diff touched". A re-freeze amends a
frozen test BECAUSE that test was red, so the part holding it is red in the
standing result, and the reason vocabulary gives `not-green` precedence over
`touched`. A `touched`-only rule would therefore never fire on the case this
decision exists for.

A `not-green` part runs the changed files plus its own recorded red files. What
it leaves out is every file that was green at the standing result's sha and that
the diff did not touch, and the standing result proves those only while its red
list is the part's WHOLE red list. That is exactly what `failedFilesCut` is for.
A part whose list was cut, a part with an empty list, and a part that is blind,
undeclared or unrecorded hold no file-level claim, and each refuses the whole
narrowing.

A chain of test-only diffs composes the same way: each link's range is read
against the previous result's own sha, so a file proven green two cycles back
and untouched since is untouched in every range between.

## What this does not prove

A file-narrowed green is not re-proven whole before the ship. The confirmation
sweep re-runs the parts a cycle CARRIED and keeps the parts it ran, so a part
that ran narrowed is kept. That is already true of the flake filter's narrowed
re-run, and this decision does not change it.

The residual is a suite file that another suite file imports, amended or
deleted: the amendment can change what a sibling decides, and no file list names
the sibling. The guards are the shape filter, which refuses the moment a diff
holds a helper or a fixture, and a project's own suite-scope rule, which is what
makes a spec that imports another spec rare.

A part the standing result did not hold at all is the second residual. The plan
cannot see it, so a genuinely new part whose trees hold a named file runs those
files alone. It is the same class as the first: a narrowed green that the next
cycle's whole run would refute.

## Why the seat refusal reads no duration

The obvious rule, refuse the suite when the certified base timed it above the
seat cap, is dead on the day it ships. The certified reading for a suite layer
is usually a NARROWED re-run's, because the flake filter narrows and the
certification takes the reading the last attempt produced, and a narrowed
reading is far under any cap. So the rule would pass the whole suite most of
the time.

The refusal is therefore unconditional on the form: in the lane that has a
frozen suite, the whole of it belongs to the verdict stage, and a seat runs it
narrowed or not at all.

What the hook still cannot see is a framework slice the gate table does not
name, such as a workspace's own test script. The brief forbids it, the hook
cannot enforce it, and nothing counts it.

## Fallback paths

If a file-narrowed cycle ever calls a layer green where the whole layer would
have been red, the retreat is per project and needs no code: the project's
runner stops reading `OLYMPUS_FILES`. Every narrowing is then derived, recorded
and inert, and the layers run whole. `whole-rerun-after-refreeze` does not fire
on that, because the harness still asks; `layerMs` is what the retreat costs and
where it is read. Trigger: one such red, found by a confirmation sweep or after
a merge. Reversal cost: one line in the runner.

If the derivation itself proves wrong while the contract holds, the harness half
retreats at `fileTargets()`: the conditions tighten, or the function answers an
empty list and the plan narrows by part alone, which is the behaviour before
this decision. Trigger: a narrowed green refuted at the same sha, more than once
over a window of runs.

If the per-file red-state reading refuses correct suite writes, the check falls
back to the exit code everywhere by treating every run as one that reported no
part. Trigger: a corrective suite round whose brief named a file the seat then
showed was legitimately green, more than once over a window of runs. Reversal
cost: one condition in `redStateReading()`; the narrowing of the command stays,
because it is sound on its own.

If the seat refusal costs more rounds than it saves minutes, the bound stops
carrying `suiteNarrowed` and the hook passes the suite exactly as it did before.
Trigger: several `seat-command-refused` with `narrowed: true` on one seat,
repeatedly, after the brief has been corrected once. Reversal cost: one field.
