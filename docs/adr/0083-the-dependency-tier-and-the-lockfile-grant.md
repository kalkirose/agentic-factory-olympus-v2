# ADR-0083: One file is judged by its content: the dependency tier and the lockfile grant

Status: accepted (2026-09-12)

## Context

The diff-policy gate judges a changed path and never the change inside it
(ADR-0017). That is the right rule for a file whose meaning is its location: a
seat under judgment cannot be allowed to move the ground it is judged on, and no
reading of a diff settles that.

One file breaks the rule in both directions. A workspace lockfile is a single
file that states every dependency of every package in the repository. Denying it
denies a story the one write that makes an approved package real. Allowing it
hands one seat the whole dependency graph, which is the thing the constitution
puts under the owner's hand.

The question the file asks is not where it sits. It is whether the change inside
it is exactly the package the card names.

## Decision

**A lane may declare one tier of paths judged by content, and the lockfile is
what that tier is for.**

- **`dependencyPaths` is a diff-policy tier, and only the story lane may declare
  it.** The config validator refuses it on any other lane: the story lane is the
  one lane with a card behind it, and the card is the whole authorization. A
  project that declares the key nowhere keeps the gate it had.
- **The tier is neither denied nor declarable.** A path under it is not a
  violation by path, so the gate leaves it clean and the caller reads the file.
  It is not answered by the spec's own `touched-paths` block either: the
  permission lives on the card, and the spec lint refuses a spec that lists the
  file at all. Reading it as undeclarable would refuse every dependency story on
  the one declaration nobody is allowed to write.
- **A dependency path is guarded.** It outranks the re-capturable class and the
  swept class, so a lockfile change is never quietly reverted as a generated
  artifact or taken back as a write to a frozen path.
- **The spec carries the manifest and nothing else.** A card that names a package
  makes the spec list that importer's manifest under `touched-paths`, dev owned,
  and the spec lint refuses a spec that does not. The lockfile is the install's
  own output, not a planned edit.
- **`lockfileGrant(before, after, grants)` answers the content question.** It
  takes the file before the change, the file after it, and the packages the card
  earned, and it either admits the change or names the block that broke it.
- **It is a line reader over the file's fixed shape, not a parser.** The harness
  carries no runtime dependencies, and a parser is the wrong tool regardless: the
  grant holds the exact bytes of the lines that state a dependency, and a parser
  that round-tripped the file would throw those bytes away. It refuses a format
  version it does not understand rather than guessing at one.
- **What the grant holds.** Every top-level block other than the importer table,
  the package table and the snapshot table is byte identical: those blocks state
  a policy of the repository rather than a fact about one package, and an install
  that moved one moved something the card never asked for. In the named importer,
  exactly the named packages were added, each with its specifier line. No
  specifier line of any importer was removed or changed. No package already in
  the file changed the block that states where it resolves from.
- **What the grant deliberately does not hold.** Version lines inside an importer
  and the whole snapshot table move on any install, because the package manager
  rewrites peer suffixes across the tree when one package lands. Holding them
  would refuse the manager's own correct output. They reach the verdict instead: a
  lockfile change touches ground every layer declares, so the suite is what says
  the tree still works.
- **The comparison is by package name.** The card names a package; the file holds
  a specifier. The card is not asked to pin a version, because the version is the
  manager's answer and the suite is what judges it.
- **`before` is the file at the run's freeze.** That is the last commit before
  any implementation commit, and only a seat that writes code may touch the file,
  so the freeze is the last state nobody in the run had reached. `after` is the
  worktree as the capture reads it, and the grant runs in the capture on every
  pass.
- **A refusal names the block it broke.** The first block that breaks the grant
  is the refusal text, and it rides into the corrective brief as its own rule, so
  the seat is told which line of which block it may not have written rather than
  that a file is forbidden.
- **A package that needs more than an install is not this route.** A build
  permission or a workspace-wide change lives in files the story lane still
  denies, and the birth brief says so: that change goes through the repair lane.

## Consequences

The grant is a claim about one lockfile format from one package manager. A
release that rewrites more of the file than the grant admits stalls a dependency
story at its capture, loudly, naming the block. That is the safe direction and it
is a one-line repair in one module, but it is a coupling to a tool's output and it
is stated here rather than discovered.

A story that adds a package pays a full spectrum in its verdict, because the
lockfile is ground every layer reads. That is the honest cost of the change and
no part of this narrows it.

The tier makes one file's judgment content shaped, and the gate's own argument
for reading paths alone still holds everywhere else. The exception is defensible
only because the authorization is outside the seat's reach: the card is on the
default branch, the owner writes it, and the seat cannot amend it.

## Rejected options

- **Leave the lockfile denied and ship dependencies through the repair lane.**
  Two runs for one story, and the repair lane has no card to authorize against.
- **Allow the lockfile by path on the story lane.** One seat would hold the whole
  dependency graph with nothing reading what it did to it.
- **Read the lockfile as a resolved graph.** The grant is about what a person
  authorized, which is a package name in an importer. A resolved graph answers a
  different question and needs a parser this repository will not carry.
- **Let the spec declare the lockfile.** The declaration would be written by the
  seat whose work it authorizes, which is the shape the whole gate exists to
  refuse.
- **Hold the version lines and the snapshots too.** That refuses the package
  manager's own output on an ordinary install, so every dependency story would
  stall on a correct change.

## Fallback path

The alternative is the file denied on every lane, with a workspace change and an
install shipped by a repair ticket. The switch trigger is a grant that refuses an
honest install more than once for reasons the block cannot name, which says the
file's shape is not readable this way. The reversal cost is one config line and
one branch in the capture; the module stays for the reading it already did.

## References

- ADR-0017, ADR-0018, ADR-0019, ADR-0046, ADR-0082
- `src/lanes/lockfile.mjs`
- `src/seats/diffpolicy.mjs`
- `src/lanes/speclint.mjs`
- `src/lanes/verdict.mjs`
- `src/config/project.mjs`
