# ADR-0087: The adversary stage is removed, and a lane maps a stage it no longer runs

Status: accepted (2026-09-12)

## Context

The story lane held a stage between the suite and the freeze that wrote a
plausible wrong implementation of the story in a throwaway worktree and ran the
frozen suite against it. A suite that failed the wrong implementation was said to
kill it. A wrong implementation the suite passed was a survivor, and a survivor
was a demonstrated gap in the suite: it bought an amendment round, and the
amendment added the test the gap needed.

Two things about that loop were true at once. A kill tells nobody anything the
suite does not already assert: the suite was written from the spec, the wrong
implementation was written from the same spec, and the suite failing it is the
suite doing what it says it does. A survivor does tell something, and what it
tells is one member of a set. A seat shown one member closes that member and
leaves its siblings on the same file, which is why the enumeration of the surface
was asked of the suite seat itself (ADR-0072).

Once the suite owes that enumeration before it freezes, the stage's one real
signal is bought earlier, more completely, and without a seat pass and a full
suite run per round behind it. What the stage costs is a seat, a worktree, a suite
run and, on a survivor, another seat and another suite run. What it adds is a
second reading of a question the freeze already answers.

## Decision

**The story lane runs no adversary stage.** The suite stage hands to the freeze.

- **The enumeration is the measure.** Every suite write maps the story's surface
  along the security dimensions and closes each row with the test a wrong
  implementation of that item fails, or with the reason the spec does not
  constrain it. The map is checked before the write commits. The dimensions reach
  the suite brief as the dimensions the suite asserts on.
- **Everything the stage owned goes with it**: the stage and its handler, the
  rounds, the strengthening round, the amendment, the survivor evidence and its
  dispositions, the seat and its brief, the throwaway worktree and the one
  primitive that created one, the report schemas, and the two parks the stage
  could raise. A park type nothing can raise is a touchpoint the catalog claims
  and the machine cannot deliver.
- **A lane states the stages it no longer runs.** `retired` maps such a stage to
  the stage that now follows the one before it. The engine's resume guard reads
  that map before it refuses a stage the lane does not list, so a run standing in
  a removed stage re-enters at the mapped stage and stamps `stage-retired`. A run
  the operator held against a removed stage maps the same way. A lane whose map
  names a stage the lane does not hold is refused when the lane is registered,
  because a broken map is a resume that fails later and further from the cause.
- **A retired event name stays in the registry.** The ledger refuses an event the
  registry does not name, and an archived run holds the events the stage stamped.
  So the names stay, marked as written by nothing, and a reader of an old ledger
  still reads it.
- **A retired metric name stays in the metric table.** A run pins the project
  config it launched with, and config validation refuses a metric the table does
  not name, so a blob written before the retirement still has to parse. The
  reading behind the name is gone and the watcher evaluates nothing under it. The
  freeze record, the inherited freeze and the command centre drop the counts the
  stage produced.
- **The config key that set the round count is accepted and ignored.** A project
  that still carries it launches; nothing reads it.

## Consequences

A wrong implementation the suite would have passed is no longer found before the
freeze. What finds it is a defect that ships: a red check on the merge commit, or
a repair ticket against the shipped behaviour, on an item the map did not list.
That reads as a map that was not the surface, and it is the trigger the map's own
fallback path names.

The security dimensions keep two readers rather than three. The verdict panel's
security lens reads them against the candidate, and the suite brief reads them
against the story. Neither depends on the stage.

The retired-stage map is a permanent seam. Every stage removal after this adds a
line to it, and that is the price of never refusing a resume: a run that sat in a
stage for an hour before the harness changed under it is a run whose work is
worth more than the tidiness of a stage list.

The freeze record is smaller, and a reader of two records from either side of this
sees different fields in them. The record's own shape is what says which.

## Rejected options

- **Keep the stage and read it as one number.** The number is the suite's
  discriminating power against one wrongness per round, and the suite already
  asserts what it asserts. A reading nobody acts on is a seat pass nobody needed.
- **Keep the stage and run fewer rounds.** The round count was already one by
  default. The cost is not the count, it is the stage.
- **Keep the stage and show it the map.** Then a kill proves the suite covers what
  the map declared, which is a measurement of self-consistency and reads high for
  ever.
- **Remove the stage and leave the stage name in the lane's list with a handler
  that does nothing.** A stage that is entered and stamped and does nothing is a
  stage a reader of the ledger has to be told to ignore.
- **Remove the stage and let a resume in it fail.** A run that was standing there
  holds a validated spec, a frozen suite and a base. Refusing its resume throws
  all of that away over a stage list.

## Fallback path

The alternative is the stage restored: one seat writing one wrong implementation
in a worktree of its own, the frozen suite run against it, and a survivor buying
an amendment. The switch trigger is a wave of ships whose escapes are all
behaviour the frozen suite passed and the map had listed, which would say the
map's rows are written without reading the tree and an independent reader is worth
its cost. The reversal cost is high and honest: one stage, one seat, one worktree
primitive, two parks and the records behind them.

## References

- ADR-0006, ADR-0010, ADR-0015, ADR-0019, ADR-0038, ADR-0051, ADR-0072
- `src/lanes/story.mjs`
- `src/lanes/surfacemap.mjs`
- `src/engine/engine.mjs`
- `src/isolation/worktrees.mjs`
- `src/tripwires/registry.mjs`
- `src/ledger/registry.mjs`
