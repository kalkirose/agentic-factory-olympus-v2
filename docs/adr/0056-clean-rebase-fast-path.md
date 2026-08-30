# ADR-0056: A ship over a provably disjoint merge keeps the certification it earned

Status: accepted (2026-08-30)

## The trade this makes, stated plainly

A run merges the default branch into its tree before it opens its request, so
the verdict certifies the tree that lands (ADR-0033). When that merge moves the
tree, the run is judged again, from the top. This decision lets one class of
moved tree skip that second judgment: the class where two mechanical checks
prove the incoming work and the story cannot interact.

The guarantee that thins is real and it is worth naming. Today a merged tree is
certified against the exact bytes that land. After this, a fast-path merge is
certified against a tree that differs from the one that lands in ways the
project's own declarations claim cannot reach any suite. A hidden coupling
outside declared ground, a shared table, a global config value, an implicit
ordering, ships a defect the old rule would have caught before the merge. The
owner made that trade knowingly, for speed, on 2026-08-30. What is bought is
hours of re-proof on every story, and a ship queue that stops serialising every
waiting run behind that re-proof. What is paid is a residual risk, and the whole
of this decision is about making that risk measured and reversible.

Detection is delayed, not removed. A scheduled full run on the default branch is
the backstop, and the harness already reads one: a watched workflow no request
path covers, whose red opens a loud item (ADR-0035). The `fast-path-escape` kind
is the measurement, and the standing tripwire over it is the machine that
proposes the revert.

## Decision

`gates.fastPathShip` gates the whole path. Absent or `false` is today's
behaviour byte for byte: the flag is read once, after the `pre-verdict-update`
stamp, and nothing above or below that line changes.

With the flag on, a `pre-verdict-update` that moved the tree asks
`src/lanes/fastpath.mjs` two mechanical questions. Both are computed. No seat is
asked anything, and no answer is a judgment.

- **Question one, the text.** The tree that ships has to be the default branch
  plus the story's own patch and nothing else. The stage merges rather than
  rebases, so the proof is a comparison of two patches: the story's own diff
  before the merge (`merge-base..head`) and the story's own diff against the
  branch after it (`branch..merged`). Byte equality says the merge put the
  story's patch on top of the branch and changed no line of it, which is exactly
  the result a clean rebase would have produced. Any difference refuses.
- **Question two, the ground.** Every file the default branch gained since the
  run last met it has to be answered by a claim somebody made. It is tested
  against five sets: the story's own changed files, every declared input of
  every suite in the certified verdict, the suite files (`repo.testPaths`), the
  project's shared breadth list (`gates.breadthGround`), and the files the
  declarations themselves are produced from. One hit refuses, because a suite
  that depends on the file was never run over it. A file NO set reaches also
  refuses, unless the project declared it inert (`gates.inertGround`). A suite
  that declared no inputs refuses. A change the harness cannot read as a file of
  this repository refuses.
- **Both answers agree or the run takes the full re-verdict.** There is no
  third ending.

A fast-path ship stamps `fast-path-ship` with `taken: true`, the default-branch
commits it examined, the declaration version they were checked against, and the
certification it reuses. The close carries `fastPath: true`. A refusal stamps
the same event with `taken: false` and one word from a closed refusal set, so a
flag that fires for nothing is readable as one.

## Why silence is not safety

A rule that refuses on a hit and passes everything else would read like a proof
while being the opposite of one. A file no declaration names is not ground that
reaches no suite; it is ground about which nobody has said anything at all, and
the two are the same only if silence is evidence.

The part machinery already answers this exact question and it answers it the
other way (`src/lanes/parts.mjs`). A changed path no part input set claims, a
lockfile, a shared package, a migration, a config file, a path nobody thought
about, makes EVERY part affected there. Doubt always re-runs. A ship carrying a
whole certification cannot hold a weaker rule than a single layer carrying one
part of itself.

So the pass now needs a positive claim, and `gates.inertGround` is that claim:
the path entries the project states no suite of it can reach. It is the same
kind of statement as the breadth list, made in the other direction, and it earns
the same review weight. A project that declares none never fast-paths, which is
the safe default and the state every project starts in.

## Why a story may not narrow its own inputs

The declarations come off the part-targeting markers, and those markers are
printed by the layer commands running in the RUN's worktree. That makes them the
branch's own report about itself. A story that added
`::olympus part-inputs src/tiny` to a gate would be judged against the narrowing
it wrote, and the narrowing would earn it the skip.

The check closes that by requiring main's copy of every file a declaration comes
out of to be the run's copy: the story's own diff may not touch a Tier-1 layer
command's argv paths or the directory each one sits in, and the branch moving
under those paths is an intersection like any other. When both sides hold the
same bytes, the run's report is the merge target's report, which is the side
that must decide the skip.

The surface is the command's own file, every module that file reaches through a
relative import, transitively, and the directory each one sits in. The walk is
what makes the guard match where the markers are actually printed: a gate script
that prints them from a helper it imports has its declarations produced in the
helper, and a guard that stopped at the gate's own directory would watch the
wrong file while the story edited the right one.

Every edge the walk cannot read refuses, because an edge nobody can enumerate is
a surface with an unknown boundary: a command that names no file of this
repository (`npm test`), an argv path that is a glob rather than a file, a file
that will not read, a relative specifier that resolves to nothing under the
extensions a gate uses, and an import or require whose argument is computed
rather than written. A bare specifier is the one thing followed nowhere and
refused nowhere: it names a dependency and not a file of this repository, and a
dependency moving is what the shared breadth list is for.

One bound remains and it is worth stating. The walk reads specifiers, not
semantics: a module reached only through a runtime path this parse cannot see is
outside it. Every shape that hides one, though, is itself a refusal, so what is
left is a module reached by a literal relative specifier the regexes miss.

## Why a lens finding is not carried

A certification is two things: the deterministic gate results, and a review
panel's reading of the tree (ADR-0022). The gates declare their ground. A lens
declares nothing and reads the whole repository around the diff, so no claim in
this project can say the branch did not move ground a lens finding rests on.

The honest answer is therefore the narrow one: a certification whose record
carries any review-lens finding, open or resolved, is not carried. Where the
panel raised nothing, the certification rests on declared ground alone and the
two questions above cover it. The alternative considered was to give the lenses
a declared surface of their own, and it was rejected as a fiction: the surface a
lens reads is the repository, and writing a smaller one down would not make it
true.

## One canonical path, everywhere

Declarations, argv words, import specifiers and git's own output all name files,
and they name the same file in different hands: `./docs`, `docs//`, `docs`. The
comparison this check runs is a prefix comparison, so two spellings compare as
two different paths, and a declaration written `./docs/fixtures` would clear
every check that asks whether a declaration exists while matching no file at
all. There is therefore one canonical form and one function that produces it,
and every path in the module meets it before anything compares it: separators
forward, `.` and empty segments dropped, no trailing slash, and null for a name
that canonicalises to nothing or climbs out of the repository.

## What a taken record does not settle

A run can take the fast path over one moved base and still render the full
verdict afterwards: a red at the request sends it back, and so does a second
moved base at the ship stage. That verdict judges the tree that lands, which is
the whole of what the fast path skipped, so the run earned the certification it
ships and the trade was never made. A taken record with a verdict rendered after
it therefore marks nothing: the close carries no `fastPath`, an escape behind
that merge is the ordinary escape, and the tripwire that measures the trade does
not count that ship. The record itself stays in the ledger, because the check
did run and did answer.

## What the check may not do to the ship queue

The whole check runs inside the ship token, so anything it holds it holds for
every run waiting to ship. Every git read it takes is bounded at
`GIT_TIMEOUT_MS` (two minutes); a read that hits the bound is killed, the call
throws, and the throw is the `internal-error` route, which is the full
re-verdict. A hang is not one of the endings.

The ledger record names the default-branch commits examined, and the list is
capped at 200. A range past the cap carries `truncated: true` beside the true
`commitCount`, because a reader of a 200-line list cannot otherwise tell a range
of exactly 200 from a range the record stopped writing down.

## Why the merge proves the rebase

The plan this implements asks for a rebase. A rebase in the run worktree would
rewrite a branch the request is already built on, and the harness ships merges,
not rebases. What matters is not the shape of the operation but the tree that
lands, and the two patches above are a proof about exactly that tree: they say
the merged tree equals the branch with the story's patch applied unchanged,
which is the property a clean rebase would have established. The check is
therefore about the artefact under judgment rather than about a rehearsal of it.

A merge that conflicts never reaches the check: the conflict route runs one
stage in front, resolves the conflict with a dev seat, and the resolved tree
fails question one on the seat's own edit.

## Why declarations and not inference

Suites that exercise HTTP routes and database state have coupling no import
tracer can see. A declared input is an auditable claim a reviewer can check; an
inferred one is a guess with a failure mode nobody reads. The declarations ride
the part-targeting contract that already exists (ADR-0046): a suite says what it
depends on in its own output, in the path vocabulary the rest of the project
config uses. Nothing new is invented on the harness side, and a project that has
declared nothing yet gets nothing but refusals.

## Why a project with no breadth list never fires

Some ground belongs to every suite whatever any suite declared: the dependency
lockfile, the migration set, the shared contracts package, the environment
schemas. That is the shared breadth list, and it is the floor the ground
question stands on. A project that declares none has not made the claim this
path rests on, so the check refuses with `no-breadth-ground` rather than
answering a weaker question and reading like a strong one. The list is not
validated into existence, because a config error would wedge a project over an
opt-in flag; it is a refusal at ship time, which costs the run nothing it was
not already paying.

`repo.testPaths` is the same case one set along, and it refuses the same way
with `no-suite-ground`. A project that names no suite files of its own would
have a fifth of the ground question answered by an empty list while the record
read like a whole answer.

## What a declaration that matches nothing is

The stale-declaration gate on the project side catches a glob that resolves to
no existing path. It does not catch an entry that could never match any path of
any repository, and `.` is the one that matters: the path vocabulary compares a
plain entry as a prefix, no repo-relative path is `.` and none begins `./`, so a
suite declaring it has declared an input set that reaches no file while clearing
every check that asks whether a declaration exists. Such an entry is dropped,
and a part left with no entry at all is refused as the undeclared suite it is.

## Failure is never a wedge

Every ending of the check that is not a clean yes is the full re-verdict. A
throw inside the check itself, an unreadable record, a git command that fails, a
path vocabulary that will not compile, is caught at the lane, stamped as
`internal-error`, and the run proceeds exactly as it would have if this path had
never been written. The fast path can only remove work. A defect in it makes a
ship slow and can never make one wrong.

The stage around it has one more ending, and it belongs to the stage rather than
to the check. The merge and the record of the merge are two writes, and a crash
lands between them; on the resume the merge is already in the tree, so it
answers "already up to date" and the base reads as one that never moved. The
tree is the record that survived: a merge commit at the head of the run worktree
that no stamp of the run names is a merge the run took and never wrote down.
That routes to the full re-verdict and never to the fast path, because the shas
the check reads are the ones the lost stamp held, and a decision over shas the
run cannot name is not the decision it would have made.

## Measuring what the trade costs

This is a gate cut, so the doctrine rule applies: a cut names its metric, its
watch window and its breach condition in the same change, and a breach restores
the cut by default. The rule is enforced rather than asked for. A project that
sets `gates.fastPathShip` and registers no `fast-path-escapes` tripwire has the
standing one armed for it, at the standing band, wherever the registry is read.

Arming is the answer rather than a config refusal because the flag is opt-in and
a refusal would wedge the whole project over it: the launch reads the config, an
invalid config launches nothing, and the project would be dark until somebody
landed a PR. Arming cannot wedge anything, it shows in the same board the
project's own wires show in, and a project that wants a different band writes
its own entry, which the arming then leaves alone.

`fast-path-escape` is a closed defect kind (ADR-0008). An escape recorded
against a merge that a fast-path ship carried takes that word, with the run, the
request and the merge commit on its refs. There are two intakes and both write
it. An operator reports a defect and the attribution is derived from the
ledgers, not from what the reporter believed: the console route is
`olympusctl escape --pr <n>` or `--merge <sha>`, and the harness decides. A red
merge the harness converts itself takes the same word at the conversion, with
the ship's own run as the attribution, because the count is about the ships that
carried rather than about the stories that wrote the code.

Every escape record carries refs, whichever intake wrote it, and the project is
the ref that matters most: the escapes ledger is instance-scoped and nothing
else in a record says which repository the defect is in. Without it the repair
sweep has no repository to launch into and the escape is never owed by anybody.
The project is therefore required at the intake and not merely accepted: a
report that names only a request number would otherwise match whatever project
opened a request of that number. Every escape record also carries a repair
ticket, because the owed set is ticketed-and-not-fixed: a defect a person found
is owed exactly as much as one the harness found for itself.

The two intakes stay separable in the ledger. A red-merge conversion marks its
own records, and the conversion re-uses only records carrying that mark when a
crash makes it run twice. Matching on the run id alone would let a report
somebody filed between the merge and the close-out read as work already done,
and the breach would then record none of its own findings at all.

The `fast-path-escapes` tripwire counts that kind over the last ten shipped
story-lane runs of ONE project, filtered by the project on the record's refs.
Two in ten breaches, and the answer it carries is the config line that turns
that project's flag off. That is why a second project's defects may not reach
this reading. The band is deliberately tight, because the owner traded away a
guarantee on the belief that escapes would be rare, and two in ten is the
reading that says the belief was wrong.

## Adversarial reading

Declarations become load-bearing for correctness at ship time, not only for
speed. A declaration that is stale is caught by the project-side gate that
resolves every glob; a declaration that is merely too narrow is caught by
nothing but the escape metric, after the fact. That is the sharp edge of this
decision and it does not have a mechanical answer.

The breadth list is a single point of forgetting. Ground that belongs on it and
is not there weakens every fast-path decision at once, silently. Its edits
deserve the review weight of a frozen test. The inert list is the same surface
with the failure inverted: ground listed there that a suite CAN reach turns a
refusal into a pass. Forgetting the breadth list costs proof; over-claiming the
inert list costs the same proof, and neither is caught by anything but review.

A symlink, a submodule and a mode-only change are all read as ground this check
cannot classify, so every one of them refuses. A declaration names a path's
content; nothing in any project claims the bit that says a file is executable,
or what a link points at.

Two commits that each land on inert ground can interact with each other in a way
neither interacts with the story. That is out of scope here: the question this
check asks is about the story and the branch, and the branch's own consistency
is what the branch's own checks are for.

The fast path reads the certified verdict's layer results for declarations. A
project that runs a layer whose command prints no part markers gets a refusal
for every ship, for ever, and the only sign of it is the refusal reason in the
ledger. That is the safe direction, and the reason the refusal is stamped rather
than silent.

## Fallback paths

The revert is one config line: `gates.fastPathShip` back to `false`, or removed.
The next ship takes the full re-verdict, no state has to be unwound, no ledger
has to be rewritten, and the records of the ships that did fast-path stay
readable. The standing tripwire proposes exactly this line, so the reversal is
the answer the machine already hands over.

A narrower fallback, if the ground question turns out to be the weak half: empty
`gates.inertGround` while leaving the flag on. Every moved file is then ground
no claim reaches, every ship refuses with `unclaimed-ground`, and the reason is
in the ledger rather than in a config line nobody reads. It is the same one-line
revert with the record kept.

A wider one, if declarations prove trustworthy and the residual never
materialises: the same two questions could carry a certification across the
ship-stage update as well, which today always re-runs CI without a re-verdict.
That is deliberately not done here; one thinned guarantee at a time.
