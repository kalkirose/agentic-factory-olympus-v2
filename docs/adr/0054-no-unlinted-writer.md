# ADR-0054: An automated writer passes the checks that bind a person

Status: accepted (2026-08-30)

## Decision

Where the harness writes to a repository, it clears every mechanical check
that binds a person writing the same file, before the write leaves the
machine. The rule is general and it is stated in the doctrine; this record
covers the one writer that has it today.

The close-out card sweep is that writer. It is the single mechanism allowed to
land text on the default branch without a request behind it (ADR-0044), so it
is the single writer whose output no gate reads. Its self-check now ends with
the project's own card lint:

- **The command is the project's.** `lanes.story.lintCommand` already names the
  check the launch gate runs over the same cards. The sweep runs that command,
  in the sweep worktree, over the cards the seat just wrote. The harness holds
  no rule about card text: it runs what the project named.
- **Red fails the attempt.** A red lint is a work-product defect. It joins the
  defect list, so it re-briefs the seat on the two-attempt loop the sweep
  already had, and the sweep pushes nothing while a defect stands. Nothing red
  reaches the default branch.
- **A sweep that wrote nothing runs no lint.** The rule binds writes. The tree
  as it was merged is not this sweep's answer to give, and a red it inherited
  is not a defect the seat can repair.
- **A command that could not run fails the attempt too.** It is not a red, but
  it is not a green either, and a push behind it is a push of cards no check
  read. It joins the defect list on the same loop, so nothing unlinted reaches
  the default branch. The `card-sweep` stamp carries `lint` on every sweep
  (`green`, `red`, `unrun`, `unwritten`, or `undeclared`), so the reader of a
  ledger can always tell a refused card from a host that could not answer.
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

The lint judges the whole tree, not the diff, so a red that was already on the
default branch fails a sweep attempt that did not cause it. The sweep then
spends both attempts and records `ok: false`; the story still ships, and the
supersedes the run owed the card are lost for that run. That is the accepted
trade: a project whose default branch fails its own card lint is already
holding every launch, and the sweep's silence is the smaller loss. The
`unwritten` case keeps the common shape of this out of the loop entirely.

An unrunnable command fails an attempt the seat cannot repair, and the re-brief
tells it something it cannot act on. The sweep then loses that run's card
writes. That is the accepted trade: a lint the host cannot start is a host the
sweep cannot trust to check anything, and a card written past a check nobody
ran is the exact defect this record exists to stop. The recorded miss names the
spawn error, so the host defect is visible and fixable.

The check costs one local command run per sweep attempt, seconds, on a path
that has already merged a pull request.

## Fallback paths

If the whole-tree reading proves too blunt, the check narrows to the cards the
sweep wrote: the command runs, and a red is a defect only when its output names
a file the sweep touched. Trigger: a sweep failing on a red it inherited.
Reversal cost: low, one filter in `cardLint`, at the price of depending on the
command's output naming its files.

If failing on an unrunnable command costs more card writes than it saves, the
`unrun` case stops failing the attempt: the sweep pushes as it would with no
lint declared, and the stamp carries `lint: 'unrun'` as the reason there is no
green to report. Trigger: sweeps lost to a host defect the seat cannot repair,
on a project whose lint is otherwise green. Reversal cost: trivial, one branch
in `cardLint`, at the price of a push no check read.

If a project wants the sweep to write without its lint, it removes
`lanes.story.lintCommand`, and the sweep behaves exactly as it did before this
record: no lint, `lint: 'undeclared'` on the stamp. Trigger: a lint that cannot
run in the daemon's environment. Reversal cost: trivial, one config key, at the
price of the class this record eliminates.
