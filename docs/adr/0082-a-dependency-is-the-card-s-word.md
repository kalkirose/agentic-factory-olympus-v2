# ADR-0082: A dependency the card does not name is one question, answered on the card

Status: accepted (2026-09-12)

## Context

The constitution says no new dependency, service or vendor enters unless the
intent card names it. That rule is right and it had no route. A story whose spec
could not be written without one package had two endings: the run was abandoned
and a repair run was launched to install the package, or the seat worked around
the absence and the spec carried the workaround.

Both endings are expensive in the same way. The repair run is a second launch, a
second verdict, a second review and a second rebase for every run queued behind
it, all to add one line to a manifest. The workaround is worse, because it ships.

The authorization itself is cheap. It is one owner decision of one word, and the
card is where it belongs: a card outlives the run, and the next reader of the
card is the next story that touches the same area.

## Decision

**A package the launched card does not name is one question to the owner, and the
answer is written onto the card.**

- **The birth seat refuses to author.** `SPEC_BIRTH_SCHEMA` carries a top-level
  `dependencies` array of `{importer, name, reason}`, and a birth that cannot
  write the spec without an unnamed package reports the outcome
  `dependency-needed` with that list and no spec. The field is top level because
  the report contract nests objects one level, and a list of objects under
  another object would not validate. The work-product check exempts that outcome
  from the non-empty-spec rule, exactly as it exempts a grounding conflict, and
  refuses a report that names the outcome with an empty list: the contract
  carries no minimum length, and a question nobody can read is not a question.
- **`importer` is the lockfile's own spelling of a workspace package.** The root
  package therefore has a spelling of its own, and the grant that admits the
  install later compares the same word the card carries.
- **The park is raised before anything is stamped for the birth.** So the answer
  re-enters a stage that still has its seat to run, and the re-entry spawns a
  fresh seat against the card as the worktree then holds it.
- **`dependency-decision` offers `approve` and `refuse`**, with one question line
  per package, `<importer>: <name> (<reason>)`, and a reference to the card. It
  is a decision park: it names its condition in its type, and it is an owner call
  by a rule the constitution already states.
- **`approve` writes the card and pushes it.** The text is a `## Dependencies`
  heading and one line per package, `- <importer>: <name>`. The lines are plain,
  because the project's card lint reads every unfenced line of a card and a
  harness word or a dash inside one would be a defect the sweep then has to
  answer. `parseIntentCard` reads that section back, so the card states the
  authorization to every later reader, the grant included.
- **One writer pushes to the default branch by path.** `pushCardPaths` in
  `src/lanes/cards.mjs` stages the named paths and never the tree, commits,
  pushes, and on a rejected push refetches, resets to the head that beat it,
  re-applies the paths, runs the project's card lint over them and pushes once
  more. It is the same writer the close-out card sweep uses, because two writers
  to one branch are two containment rules and two race answers.
- **The run's tree moves to the pushed head.** The amendment is a commit on the
  default branch, so the run's own branch carries none of it and the lane's diff
  policy never sees a write to ground it denies. The refresh stamps
  `tree-refreshed` against the park that bought it, which is the same refresh
  every other blocked stage takes on a retry.
- **`card-amended` carries the card, the packages, the sha, whether the push
  landed, and the park it answers.** The park seq is what makes the write
  idempotent: a stop between the push and the re-entry finds the stamp and does
  not write the card twice.
- **A failed amendment parks with the run tree clean.** The tree is reset to the
  launch base first, so no card commit is left on the run branch to ride into a
  request unjudged, and then the stage blocks: one reason for a push lost to the
  branch moving twice, another for an amendment the project's own lint or
  containment refused. Either answer retries the write.
- **`refuse` closes the run.** The story cannot be built, the card says so, and
  the state is a failure with that reason.
- **The birth brief states the one rule a spec gets wrong here.** A criterion
  that needs a named package is tested through the surface it changes and never
  by importing the package, because the suite is authored and type checked before
  anything is installed.

## Consequences

The harness pushes to the default branch in one more place. It is staged by
path, confined to the card directory, and reset off the run branch when it
fails, which is the containment the card sweep already stands on.

An approved dependency is on the card before the spec exists, so the spec, the
suite and the capture all read one authorization. A card amended this way also
tells the next story that the package is available, which is the durable half of
the answer.

The owner is asked once per package per story, and the question arrives with the
importer, the name and the seat's reason, so it is answerable from the record
alone.

A run whose owner never answers holds a slot for nobody: the park frees the slot
like every other park.

## Rejected options

- **Widen the repair lane and let dependencies in through a ticket.** That is
  the ending this replaces. It costs a second run and a rebase for everyone
  behind it, and it splits one story's work across two ledgers.
- **Let the birth seat add the package.** The constitution makes a dependency an
  owner decision. A seat that adds one has answered a question that was not its
  to answer, and no later reader can tell an authorized package from an assumed
  one.
- **Record the approval in the run's own ledger.** The ledger archives with the
  run. The next story would ask again, and the audit of what this project
  depends on would live in run directories.
- **Write the card on the run branch.** The lane denies that ground, so the
  commit would either be refused at the capture or ride into the request as an
  unjudged change to a card.

## Fallback path

The alternative is the park with no writer behind it: the owner is asked, and
the owner edits the card by hand before answering. The switch trigger is a push
from this route that lands text the project's card lint later refuses, which
would mean the write is not safe in the harness's hands. The reversal cost is one
call and one option, and the park stays as it is.

## References

- ADR-0006, ADR-0017, ADR-0018, ADR-0019, ADR-0055, ADR-0063, ADR-0083
- `src/lanes/story.mjs`
- `src/lanes/card.mjs`
- `src/lanes/cards.mjs`
- `src/ledger/parks.mjs`
- `src/ledger/registry.mjs`
