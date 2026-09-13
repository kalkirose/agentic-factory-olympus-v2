# ADR-0081: Readiness judges the launched card and the cards behind it

Status: accepted (2026-09-12)

## Context

The readiness stage of the story lane runs the project's own card lint. That
command reads a directory, because a directory is what the card files sit in.
Its exit code therefore answers a question about every card in the project, and
the stage read that answer as a verdict on the run it was holding.

So a launch stops on an error in a card the run never opens. The card that
carries the error may be months from its own launch. The run that pays for it
has a valid card, a clean worktree and every credential proven, and the only way
past is a pull request against somebody else's card. The stage is scoping its
work by the container the change sits in instead of by what the run reads.

The error beyond the run is still worth reporting. A card directory that is red
stays red until somebody looks at it, and the stage that ran the lint is the one
place in the day where a person is already being told something.

## Decision

**Readiness judges the launched card and the cards it is blocked by, and reports
the rest.**

- **The harness computes the closure.** `cardClosure(cardsDir, cardPath,
  {shipped})` in `src/lanes/card.mjs` walks `blocked-by` from the launched card,
  breadth first, and stops at a shipped key: a shipped card is settled and so is
  everything behind it. The shipped set is a parameter, because which keys
  shipped is run history and the frontier owns that; a closure computed in two
  places is two closures. A key that resolves to no card file adds no path,
  since that dangling edge is a defect of the card that carries it and the
  readers that own it report it there.
- **The lint is told which cards it is answering for.** The stage appends one
  `--card <path>` per closure card to the argv the project configured. A
  configured command is plain argv, so the append is the harness's and no
  project writes the rule twice. A lint that does not know the flag ignores it
  and reads the whole directory, which parks on any red: a harness ahead of its
  script is safe in the direction that stops.
- **Errors outside the set arrive as text, not as an exit code.** The script
  exits 0 for them and prints one block last, on standard output: the line
  `beyond the card:` and one line per error. The stage reads the block from the
  last such line to the end of the output, because a card is prose and could
  carry the marker itself, and because the script writes the block after
  everything else it has to say.
- **The output is kept whole for that read.** The call asks for the command's
  whole output and for the log to be kept, since the default is a bounded tail
  and a green command's log file is deleted the moment it settles. A block cut
  by a tail is a block that is missing exactly where a long report needs it.
- **Three outcomes.** A red inside the set parks the stage, as any blocked
  precondition does. A clean set with a block stamps one loud
  `readiness-lint-beyond` carrying the cards judged, the error lines, the count of
  block lines the harness could not read as an error, and a gist,
  and the run goes on. A clean set with no block is a clean directory.
- **One record per run.** Readiness re-runs whole on every park answer and on
  every resume, and one directory read many times is one report. The stamp is
  guarded on the run's own ledger.
- **The run's own close resolves the record.** `readiness-lint-beyond` is
  close-resolved: no run event fixes another card, so nothing else can pair it,
  and the record is a report to a person for the life of the run that made it.
  The card directory is held to clean by the project's own check over a card
  change, which is where a fix belongs.
- **The close-out card sweep asks the same way.** The sweep lints the cards it
  wrote, by name, so a red on a card it never touched cannot fail the push that
  carries a story's own supersede record. It passes only cards the tree holds,
  because a lint asked about a path with no file behind it answers with an error
  about the question rather than about the cards.

## Consequences

A red card can sit in the directory for as long as nobody launches it. The loud
record says it is there, on every run until somebody clears it, and the project's
own check over the next card change refuses to add to it. What is gone is the
run that paid for it.

The closure is only as good as `blocked-by`. A card that omits an edge is
judged without the card behind it, and the lint's own cross-reference rules are
what catch a card that names a key nothing holds.

The stage reads the command's whole output rather than a tail, so a project
whose lint prints a large report per card holds that text in memory once per
readiness entry.

## Rejected options

- **The script computes the closure.** The harness already parses `blocked-by`
  and already knows which keys shipped. Two computations of one closure drift,
  and the one in the script cannot see run history at all.
- **The lint reads only the named cards.** Duplicate keys, edge resolution and
  cross-references are corpus questions: a parse narrowed to one card cannot
  answer them. So the parse stays corpus wide and only the reported set
  narrows.
- **A run event owns the beyond-card record.** Nothing the run does fixes
  another card, so no event of the run could ever pair it and the item would
  stand open until the close either way.
- **Silence outside the set.** The information is free at that moment and
  expensive to rediscover: the next reader of a red card is the launch that
  needs it.

## Fallback path

The alternative is the whole directory as the verdict again: the stage stops
appending the flag, and an error anywhere parks the run. The switch trigger is a
beyond-card record that stands open across a wave of runs, which says the report
is not being read and the park was what made anybody look. The reversal cost is
one append and one branch.

## References

- ADR-0006, ADR-0044, ADR-0052, ADR-0054, ADR-0063, ADR-0068
- `src/lanes/card.mjs`
- `src/lanes/story.mjs`
- `src/lanes/cards.mjs`
- `src/ledger/registry.mjs`
