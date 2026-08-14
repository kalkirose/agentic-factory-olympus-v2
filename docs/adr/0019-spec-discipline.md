# ADR-0019: Spec discipline — a fixed template, a deterministic lint, and the freeze's exclusions

Status: accepted (2026-08-14)

## Decision

The story spec has a fixed shape, a mechanical check on that shape, and one
structured field the freeze acts on.

- **The template is stated where the spec is written.** The spec-birth role
  block names the parts and their order: a header (card key, base sha, the
  scope exclusions the card states); one section per acceptance criterion on
  the card, in card order, each titled with the criterion id and holding the
  intent (three sentences at most), a `Test mapping:` list whose items open
  with the planned test file path, a `Named constants:` list of `NAME = value`
  entries, and a `Supersedes:` list of frozen tests the criterion contradicts
  (`<path> — keep|supersede — <replacement clause>`); then exactly one
  ` ```touched-paths ` block; then an environment section naming only the
  environment variables the card names. The whole document runs to 400 lines
  at most. The role block also states the rule the template serves: the card
  defines what ships, the spec adds only how plus the test encoding, and a
  requirement with no acceptance criterion behind it is a defect.
- **A criterion has an id, and the card is where it comes from.** The intent
  card's acceptance section is parsed into an ordered id set. A criterion that
  opens with an identifier carrying a digit takes that identifier; one that
  does not takes its position (`AC-1`, `AC-2`). The card is the only source of
  the set, so the spec cannot invent a section and cannot drop one.
- **The lint is deterministic, and it runs at birth and after every
  amendment**, before any judging seat spawns. Eight rules, each with a
  message that names the defect and the file:
  (a) every card criterion id appears as exactly one section, in card order,
  none missing, none extra;
  (b) the document is within the 400-line cap;
  (c) exactly one touched-paths block, closed, non-empty, every path
  repo-relative and syntactically clean, every owner tag `dev` or `suite`;
  (d) every declared-tier path (`diffPolicy.declaredPaths`) the spec plans to
  touch appears in that block;
  (e) every test file in a test mapping sits under a configured acceptance
  test path;
  (f) every file a supersedes entry names exists in the worktree;
  (g) every touched-paths entry owned by `dev` under a test path names one
  file, never a directory and never a glob;
  (h) no touched-paths entry and no test-mapping path matches a
  `forbiddenPatterns` shape.
- **A touched-paths entry is a literal path; a config path entry is a glob.**
  Inside the block, only `*` and `?` mark a pattern. Brackets, parentheses,
  braces and spaces are characters the path carries, because they are
  characters real directories carry — a framework whose routes are directories
  named `[param]` and `(group)` writes them into every path a story touches.
  Clean, for rule (c), is therefore: repo-relative, no leading `/`, no
  backslash, no `.` or `..` segment, no trailing `/`. Rule (g) refuses an entry
  that holds `*` or `?`, ends in `/`, or is a directory in the worktree; an
  entry with nothing at it yet is a file the story will create. Every consumer
  of an entry compares it to a path character for character: the capture's
  declared set, the freeze's exclusions, the narrowed deny rules, and the
  restore's exclude pathspecs, which carry `literal` magic so git does not
  wildmatch them either. The tiers of `diffPolicy` and the `repo` path entries
  are config, and they keep glob semantics untouched.
- **The lint reads structured entries only.** Prose is never scanned. A rule
  that judged sentences would be a second spec gate, and judging the spec is
  the gate seat's work.
- **A lint failure is a work-product defect, not a judgment round.** It routes
  through the lane's existing contract loop: one corrective invocation
  carrying the exact failures, then the `seat-failure` park with the cause
  `spec-defect`. The spec gate's rounds, its criteria and its cap are
  untouched, and a template defect never spends one.
- **The freeze records its exclusions.** Every touched-paths entry owned by
  `dev` that sits under a test path lands in `freeze.json` as
  `frozenExclusions`. Downstream, exactly three things read it: the dev seats'
  tool deny rules exempt those files, every story-mode `restorePaths` call
  leaves them alone, and the capture stops counting them as changes it took
  back. The adversary keeps the whole boundary — its restore covers the full
  test-path set, exclusions included — because an adversary editing a
  dev-owned test-infrastructure file is still tampering. The suite seat's own
  checks are unchanged.
- **An exemption narrows the deny rules; it never rides beside them.** A
  denied tool call is denied whatever else the invocation allows, and the rule
  patterns carry no negation. So `testEditDenyRules` walks the entry's subtree
  and denies every path but the exempt file, collapsing every subtree that
  holds no exemption back to one rule. Without a worktree to walk, the
  boundary stays whole: a run that cannot narrow keeps the guarantee it had.
- **A restore with exclusions cleans file by file.** `git clean -d` collapses
  a wholly untracked directory to the directory itself, and an exclude
  pathspec inside it does not save its contents — so an exempt file in a new
  directory would be deleted with the directory. With exclusions present the
  restore lists the untracked files and removes them one at a time. Without
  exclusions the call is exactly what it was.

## Why a template, and why a lint under it

Cards of about 56 lines with seven acceptance criteria produced specs of 741
to 969 lines, with 10 to 23 sub-clauses per criterion and up to 156 tests.
Every invented clause bound three parties at once: the suite that had to
encode it, the implementer that had to satisfy it, and the review that scored
against it. None of it was ever traced back to a criterion, because nothing
mechanical read the spec.

The worst inventions were not subtle in hindsight — platform-specific baseline
files, an unauthenticated debug endpoint, a CI reconfiguration — and they all
entered as spec or suite text. The diff-policy gate (ADR-0017) catches such a
path at the capture, which is the last possible moment: the run has already
paid for the spec, the suite, the implementation and the review. Catching the
same class at the spec is cheaper by every measure, and it is decidable there:
the path is written down, the policy is configured, and both are readable
before a single test exists.

That is the split this decision draws. The gate seat judges meaning: is the
claim grounded, is the scope the card's, is the clause assertable. The lint
judges shape: does every section trace to a criterion, does every planned path
survive the policy the capture will apply, does every planned test live where
the suite command can run it. Shape questions have one right answer, so they
belong in code that runs every time and costs nothing. Putting them in a seat
means they get asked sometimes.

The cap is part of the same argument. A 900-line spec is not a more precise
spec; it is a document no reader holds whole, and every reader after it —
suite, dev, Fury, judge — reasons from a fragment. 400 lines is the point at
which the document stays readable and the sections stay one criterion deep.

## Why the freeze names exclusions

A spec assigned a test-infrastructure file to the implementing pass while the
freeze locked the whole test directory. The result was a deadlock nobody had
declared: the dev seat could not write the file its own spec required, the
suite seat had no defect to fix, and no lane could reach the one sanctioned
home for the change. The run died holding a sound spec.

The test-edit boundary is right by default, and the incident does not weaken
it. What it shows is that the boundary was expressed as a fact about
directories when it is really a fact about ownership: everything under the
test paths belongs to the suite seat *except* what the spec deliberately
handed to the implementing pass. Once the spec says which files those are, in
a form a machine reads, the freeze can record them and every consumer can
apply the same list.

The freeze is the right place to record it because the freeze is where the
frozen set is fixed. Deriving the exclusions later, from the spec, would mean
every consumer re-parses a document that later stages may amend, and two
consumers could disagree about what the boundary is. One record, written
once, read by all three consumers.

The adversary is the deliberate exception. Its restore covers the full set,
including exclusions, because the adversary's job is to be wrong in a way the
suite fails to catch — and a wrong implementation that quietly rewrites a
shared test harness is exactly the tampering the restore exists to void.

## Correction, 2026-08-14

The first production run found two defects in the lint as it was first written.

Rules (c) and (g) read `[` and `]` as glob syntax, and rule (c) also refused a
space. Route directories are named with exactly those characters, so the lint
called two real files patterns and refused them. The seat did what the lint
asked: it deleted both from its touched-paths block and re-declared one of them
as a named constant. A rule that makes a seat distort a sound spec is worse
than no rule, so the marker set is now `*` and `?` alone, and every other
character in an entry is a character of the path. Rule (g)'s file-extension
heuristic went with it: it guessed from a name what only the worktree knows,
and it refused extensionless files the story was about to create.

The same confusion was audited across every consumer of an entry. Only one
other place held it: the restore's exclude pathspecs were bare, and git
wildmatches a bare pathspec, so an exclusion for a path holding `[` would spare
every sibling the character class matched and the suite restore would silently
stop covering them. They now carry `literal` magic.

Rule (a) was decidable but not readable. It requires the section titles to be
the card's criterion ids, and the failure text said so without saying what the
ids were. A seat renumbered its sections positionally and failed all seven at
once, with seven messages that each named one id it had not written. The
message now carries the list the card actually holds, and the template line
states that a title is the card's id copied verbatim, never renumbered.

The runs after it found two more, both on the path from the card to rule (a).

The card parse read list items alone, so a card that writes its criteria as
bold ids at the start of a line — `**AC-3.6.1** the text`, which is how real
cards write them — yielded an empty id set, and every spec section answered no
criterion whatever its title. A criterion id now counts wherever it opens a
line under the acceptance heading: bold, bare, bare with a colon, a list item
of any of those, or a deeper sub-heading. `parseIntentCard` stays the one card
parser, so readiness, the card sweep, the frontier and the lint read a card the
same way.

An empty criterion set is a machinery or card defect, never a spec defect, so
it no longer routes as one. Rule (a) answers it with a single message that
names the card and the heading it read, and the lane parks it `stage-blocked`
(ADR-0015) at readiness and at the two stages that lint a spec. No seat is
asked to correct it: a seat cannot fix a parse, and the corrective invocation
it would spend is spent on a document that was never the problem.

## Fallback paths

If the template proves too rigid for a class of story — one where the natural
unit is not the criterion — the lint's rule (a) relaxes to "every criterion is
answered somewhere in the document", checked by id occurrence rather than by
section. Trigger: two runs whose spec seat cannot express a criterion in one
section and says so in its summary. Reversal cost: low, one rule changes shape
and the template line follows it.

If the 400-line cap parks specs that are genuinely that large, the cap moves
to project config with 400 as the default. Trigger: one park a human answers
by widening the scope rather than by cutting the spec. Reversal cost: low, one
constant becomes one config field.

If narrowed deny rules grow past what an invocation can carry — a flat test
directory of hundreds of files with an exemption inside it — the deny set
falls back to naming the frozen suite files from the freeze record instead of
walking the tree. Trigger: one seat invocation refused for argument length.
Reversal cost: medium, the rule source changes and new files under the test
paths are then covered by the structural restore alone.

If the exclusions prove to be a route around the test-edit boundary rather
than a relief valve for it, the lint gains a rule capping their number, and a
spec that exceeds it parks for a human. Trigger: one spec that lists more than
a handful of dev-owned test-path files, or any exclusion that names a file
holding acceptance assertions. Reversal cost: low, one rule and one constant.
