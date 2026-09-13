# ADR-0054: An automated writer passes the checks that bind a person

Status: accepted (2026-08-30)

## Decision

Where the harness writes to a repository, it clears every mechanical check
that binds a person writing the same file, before the write leaves the
machine. The rule is general and it is stated in the doctrine; this record
covers the one writer that has it today.

The card writer is that writer. It is the single mechanism allowed to land text
on the default branch without a request behind it (ADR-0044), so it is the
single writer whose output no gate reads. The project's own card lint runs
inside it, over the commit, before the push leaves the machine, and it runs
again over a replayed result before a second push:

- **The command is the project's.** `lanes.story.lintCommand` names the check
  the launch gate runs over the same cards. The writer runs that command, in
  the worktree it is pushing from, over the cards its caller named. The harness
  holds no rule about card text: it runs what the project named.
- **Red pushes nothing.** The writer refuses with the lint's own output, and the
  commit goes with the refusal, so no card text stays on a branch a gate does
  not read. A caller with a seat behind it takes the red as a work-product
  defect as well, which re-briefs the seat on the loop it already has. Nothing
  red reaches the default branch.
- **A caller that wrote nothing runs no lint.** The rule binds writes. A write
  that changed no byte is not a write, the tree as it stood is not this
  writer's answer to give, and a red it inherited is not a defect its seat can
  repair.
- **A command that could not run refuses too.** It is not a red, but it is not
  a green either, and a push behind it is a push of cards no check read. It
  refuses the same way, so nothing unlinted reaches the default branch. The
  `card-sweep` stamp carries `lint` on every sweep (`green`, `red`, `unrun`,
  `unwritten`, or `undeclared`), so the reader of a ledger can always tell a
  refused card from a host that could not answer.
- **The seat is told.** The role block says the lint runs over everything it
  writes, so the check is a condition of the work rather than a surprise at the
  end of it.

## What this eliminates

A card the project's own lint refuses, sitting on the default branch, put there
by the harness. Every launch that reads that card then parks at the readiness
gate on a red lint, and every one of those parks is a person woken up for a
defect the machine wrote and could have caught in seconds. One sweep can hold
every later run of the project.

The class is wider than the sweep: any automated writer that skips a check its
human equivalent passes turns a private mistake into a public block. The
doctrine states it once so the next writer inherits the rule instead of
rediscovering the incident.

## Why the project's command and not a rule of the harness

Card conventions belong to the project: which characters a card may carry, what
frontmatter it needs, how a heading is spelled. A rule held here would be a
second opinion about somebody else's document, and it would drift from the one
the project enforces. Running the project's own command means the sweep passes
exactly the check a person passes, forever, with no rule to keep in step.

## Adversarial reading

The question put to the lint is about the cards the writer wrote and no others,
so a red somebody else left on the default branch does not fail a write that did
not cause it. The cost is that this check alone does not hold the directory
clean: a card the writer never touches stays red until the project's own cards
check on a pull request catches it, and the launch gate reports it as an error
beyond the launched card. The `unwritten` case keeps a sweep that wrote nothing
out of the loop entirely.

An unrunnable command fails an attempt the seat cannot repair, and the re-brief
tells it something it cannot act on. The sweep then loses that run's card
writes. That is the accepted trade: a lint the host cannot start is a host the
sweep cannot trust to check anything, and a card written past a check nobody
ran is the exact defect this record exists to stop. The recorded miss names the
spawn error, so the host defect is visible and fixable.

The check costs one local command run per sweep attempt, seconds, on a path
that has already merged a pull request.

## Fallback paths

If the per-card reading lets a defect through that a whole-tree reading would
have caught, the writer stops passing the card flags and the command reads the
whole directory. Trigger: a card the writer landed breaking a launch behind it
anyway, because the defect it carried is one only the corpus shows. Reversal
cost: low, one argument in `cardLint`, at the price of a writer that a red on
somebody else's card can hold.

If failing on an unrunnable command costs more card writes than it saves, the
`unrun` case stops failing the attempt: the sweep pushes as it would with no
lint declared, and the stamp carries `lint: 'unrun'` as the reason there is no
green to report. Trigger: sweeps lost to a host defect the seat cannot repair,
on a project whose lint is otherwise green. Reversal cost: trivial, one branch
in `cardLint`, at the price of a push no check read.

If a project wants the writer to write without its lint, it removes
`lanes.story.lintCommand`: no lint runs, and `lint: 'undeclared'` rides the
sweep stamp. Trigger: a lint that cannot run in the daemon's environment.
Reversal cost: trivial, one config key, at the price of the class this record
eliminates.
