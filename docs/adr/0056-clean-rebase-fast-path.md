# ADR-0056: A ship over a provably disjoint merge keeps the certification it earned

Status: accepted (2026-08-30, the two ground sources and the launch rule
2026-09-05, the second question 2026-09-07)

## The trade this makes, stated plainly

A run merges the default branch into its tree before it opens its request, so
the verdict certifies the tree that lands (ADR-0033). When that merge moves the
tree, the run is judged again, from the top. This decision lets one class of
moved tree skip that second judgment: the class where two mechanical checks
prove the incoming work and the story cannot interact.

The guarantee that thins is real and it is worth naming. Before this, a merged
tree was certified against the exact bytes that land. After it, a fast-path
merge is certified against a tree that differs from the one that lands in ways
the project's own declarations claim cannot reach any suite. A hidden coupling
outside declared ground, a shared table, a global config value, an implicit
ordering, ships a defect the old rule would have caught before the merge. The
owner made that trade knowingly, for speed. What is bought is hours of re-proof
on every story, and a ship queue that stops serialising every waiting run
behind that re-proof. What is paid is a residual risk, and the whole of this
decision is about making that risk measured and reversible.

Detection is delayed, not removed. A scheduled full run on the default branch is
the backstop, and the harness already reads one: a watched workflow no request
path covers, whose red opens a loud item (ADR-0035). The `fast-path-escape` kind
is the measurement, and the standing tripwire over it is the machine that
proposes the revert.

## Decision

`gates.fastPathShip` gates the whole path. Absent or `false` is the older
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
  against six sets: the story's own changed files, the files the declarations
  themselves are produced from, the project config the run pinned, the suite
  files (`repo.testPaths`), the project's shared breadth list
  (`gates.breadthGround`), and the whole declared ground of every Tier-1 layer.
  One hit refuses, because a suite that depends on the file was never run over
  it. A file NO set reaches also refuses, unless the project declared it inert
  (`gates.inertGround`). A layer whose ground neither source declares refuses. A
  change the harness cannot read as a file of this repository refuses.
- **Each answer is settled on its own evidence.** A refusal that belongs to one
  certification says nothing about the other, so the two are not copied across
  (ADR-0086). A half-carry is stamped as one: `taken` stays false, the update
  stage routes to the stage whose question re-opened, and the record says which
  half stood and under which word.
- **The ground question is asked once and answered twice.** `groundVerdict` lists
  the incoming files once and answers each certification the lane holds on its
  own ground (ADR-0075). The code answer is the six sets above, with every record
  path out of every one of them: the project states which layers read a record,
  no suite is one of them, and a code re-judgment over a file no code layer sees
  buys nothing. The record answer is the run's own records and the records their
  neighbourhoods name, computed at the merge. An incoming record outside that
  neighbourhood costs nothing; one inside it, or one the run itself wrote,
  answers `rerun`. A record re-run is the record review over the merged tree and
  never a refusal, because the stage that owns those records resolves the
  conflict and judges them again.
- **`declaredGround` reads a standing green per layer.** The green comes from the
  last cycle that RAN that layer, never from the last cycle. A cycle runs the
  layers its own plan named and skips the rest, so a layer a record-only cycle
  left out keeps the green it earned and the record holding its declaration is
  the record that earned it. A layer that carried the default branch's own
  certification is such a green (ADR-0088), and it stands on the project config
  ground alone: its part table belongs to another run, a part's declared inputs
  do not survive into a verdict record, and the config ground is the claim the
  carry itself was taken on. Each carried green names the tree it was earned at,
  so the declaration sha is per layer where a layer carried.

A fast-path ship stamps `fast-path-ship` with `taken: true`, the default-branch
commits it examined, the declaration version they were checked against, and the
certification it reuses. The close carries `fastPath: true`. A refusal stamps
the same event with `taken: false` and one word from a closed refusal set, so a
flag that fires for nothing is readable as one.

## A layer's ground has two sources and one derivation

A Tier-1 layer states what it reads in one of two places, and the harness reads
the two the same way.

- **The layer's own command states it, part by part.** The part-targeting
  markers carry `::olympus part-inputs <entry> …` per part (ADR-0046). A runner
  that dispatches per workspace knows the filter it dispatched with, and the
  filter is the input set.
- **The project states it on the layer entry of its config.** `ground` is an
  array of path entries beside `command`, `needs` and `memoryCeilingMb`.

`layerGround()` in `src/lanes/parts.mjs` is the one derivation, and every reader
calls it. It answers three things about one layer.

- `entries` is the union of the config list, every input every part of that
  layer declared, and the shared breadth list. It is the widest ground the layer
  might read, and it is what the ground question tests a changed file against.
  A wider set refuses more and never fewer, so the union fails in the safe
  direction.
- `floor` is the layer's config list widened by the breadth list, and it is what
  a part that declared no inputs stands on. A sibling part's declaration is a
  statement about that sibling and about nothing else, so it is not in the
  floor. The breadth list is not a floor of its own either: it is ground that
  belongs to every suite ON TOP of what that suite declared, never a description
  of what a layer reads. A layer the config does not describe therefore has no
  floor, and a part of it that declared nothing is affected by everything, as
  ADR-0046 has it.
- `sources` says which of the two spoke, which is what decides the scope of the
  declaration-source walk below.

`partGround()` is the other half: a part's own canonical inputs where it
declared any, and the layer's floor where it declared none. The stream wins
wherever it spoke. A config entry that overrode a live declaration would make
the copy nobody edits the authority, and ADR-0046 settled that argument for the
map itself.

**Why a field on the layer, and not a map keyed by layer name.** A map writes
each layer's name twice and the two copies drift. An ordered list beside the
fact it describes carries the same information with nothing to keep in step
(ADR-0071).

**Why the breadth list is unioned at read time.** A runner that already prints
its parts commonly unions the shared ground into every part it prints. A config
ground that had to repeat the same entries per layer would be one fact written
forty times. The harness does the union where it reads, so a project states each
layer's own ground and the shared list once.

**Why not teach every runner the part protocol instead.** Most Tier-1 layers on
a real project are single-purpose gate scripts that run one check and exit. A
part protocol inside each declares one part per script, which is the layer, so
it states exactly what a config line states and costs an edit, a review and a
permanent duty on every new gate. ADR-0046's argument for the runner holding the
map is about a runner that DISPATCHES, because such a runner knows the filter it
dispatched with. A script that scans one tree knows nothing the config does not.

**Why not infer a layer's ground from its command.** A package script names no
tree, and the tree it walks is decided inside a source file at run time. An
inferred ground is a guess with a failure mode nobody reads. The same argument
rules out deriving `ground` from `inertGround` or `groundlessPaths`: two lists
that look alike answer different questions, and a derivation makes every future
entry of one a claim about the other that its reviewer never considered
(ADR-0059).

**Why not read a layer's ground off the run's own worktree.** It reopens the
exact hole the narrowing rule below closes: a story would be judged against
ground it wrote.

## The launch refuses a groundless layer

`validateProjectConfig(config, {launch: true})` requires every `gates.tier1`
entry to carry a non-empty `ground` list, and it requires every entry of that
list to canonicalise to something. The rule is armed by
`gates.fastPathShip === true` and by nothing else. The error names the layer.

Without it, a project that turns the flag on and runs one layer whose command
prints no part markers gets a refusal for every ship, for ever, and the only
sign of it is one word in a ledger. That was observed: a spectrum of forty
layers where eight printed their parts and thirty-two did not refused on the
first of the thirty-two, every time, and paid a full verdict cycle for it while
holding the ship token.

**Why armed by the flag, and why hard once armed.** An invalid config launches
nothing, so a validation rule can take a whole project dark until a pull request
merges. That risk is not worth running for a project that has not opted into the
fast path, and such a project is validated exactly as it was before this field
existed. It IS worth running for a project that HAS opted in, because there the
alternative to a loud refusal is the silent permanent refusal above, and a
project that pays for a check it can never take is worse off than one that is
told so at the config. The revert stays one line: `gates.fastPathShip` back to
`false` disarms the rule with the feature.

**Why the requirement covers the self-declaring layers too.** The validator
cannot see what a command will print. It can see only the config. And a layer
that self-reports is not a layer with a complete ground: a layer whose runner
declares six parts may hold two prerequisite steps that are not suites and state
no families, so those two print no inputs at all. A ground on every layer is the
floor under exactly that case.

**Why not leave the launch rule out and refuse at ship time with a better
word.** That is the state this rule repairs: a refusal nobody reads.

## Why silence is not safety

A rule that refuses on a hit and passes everything else would read like a proof
while being the opposite of one. A file no declaration names is not ground that
reaches no suite; it is ground about which nobody has said anything at all, and
the two are the same only if silence is evidence.

The part machinery already answers this exact question and it answers it the
other way (`src/lanes/parts.mjs`). A changed path no part ground claims, a
lockfile, a shared package, a migration, a config file, a path nobody thought
about, makes EVERY part affected there. Doubt always re-runs. A ship carrying a
whole certification cannot hold a weaker rule than a single layer carrying one
part of itself.

So the pass needs a positive claim, and `gates.inertGround` is that claim: the
path entries the project states no suite of it can reach. It is the same kind of
statement as the breadth list, made in the other direction, and it earns the
same review weight. A project that declares none never fast-paths, which is the
safe default and the state every project starts in.

The same rule is why a layer nobody described refuses the whole check rather
than being skipped past. A layer nobody described could read anything, and a
fast path that stepped over it would carry a certification over ground nobody
spoke for.

## Why a story may not narrow its own inputs

The part-input markers are printed by the layer commands running in the RUN's
worktree. That makes them the branch's own report about itself. A story that
added `::olympus part-inputs src/tiny` to a gate would be judged against the
narrowing it wrote, and the narrowing would earn it the skip.

The check closes that by requiring main's copy of every file a declaration comes
out of to be the run's copy: the story's own diff may not touch a layer
command's argv paths or the directory each one sits in, and the branch moving
under those paths is an intersection like any other. When both sides hold the
same bytes, the run's report is the merge target's report, which is the side
that must decide the skip.

**The walk covers the layers whose own COMMAND declared a ground, and no
others.** That is the whole reason the set exists. A config ground is produced in
no tree: a story cannot narrow it, and there is nothing to hold equal. So a
layer whose ground is config-only may run a command that names no file of this
repository, and a layer whose markers decide a skip is walked exactly as
before. This is a narrowing of scope and never of strictness: every declaration
that decides a skip is still bounded, and every edge the walk cannot read still
refuses. A project where no layer declares anything of its own bounds nothing
and refuses nothing, because no marker of the run's tree decided anything.

The surface is the command's own file, every module that file reaches through a
relative import, transitively, and the directory each one sits in. The walk is
what makes the guard match where the markers are actually printed: a gate script
that prints them from a helper it imports has its declarations produced in the
helper, and a guard that stopped at the gate's own directory would watch the
wrong file while the story edited the right one.

Every edge the walk cannot read refuses, because an edge nobody can enumerate is
a surface with an unknown boundary: a command that names no file of this
repository, an argv path that is a glob rather than a file, a file that will not
read, a relative specifier that resolves to nothing, one that resolves to more
than one thing, a path that reaches its content through a symlink, and a load
whose argument is not a written literal. A bare specifier is the one thing
followed nowhere and refused nowhere: it names a dependency and not a file of
this repository, and a dependency moving is what the shared breadth list is for.

Three of those deserve their reasons written down.

**A load is proved or refused, and there is no third reading.** Matching the
literal forms and refusing an obviously computed one leaves a gap in the middle,
and `import('./dir/' + name)` sits in it: it begins with a quote, so it reads as
neither. A module the walk neither follows nor refuses is a module it misses in
silence, which is the one outcome this check may never have. So the rule is
stated the other way round: every `import(` and `require(` must be PROVED a load
of one written literal, and everything else refuses. Import attributes after the
specifier are still a proof; a template literal, a concatenation, a variable and
a conditional are not.

**A specifier that could be more than one file is not resolved by guessing.**
Which of `x.mjs`, `x.js` and `x/index.js` a runtime loads depends on the module
kind and the package the file sits in. A probe that took the first hit would
record a file the gate never loads while the real one stayed outside the guard,
so more than one candidate is a refusal rather than a choice. A specifier with
its extension written, which is the ordinary ESM case, has exactly one.

**A symlink is refused rather than followed.** The guard compares names: the
story's diff and the branch's diff both name the target of a link, never the
link, so a set holding the link would watch a path neither of them ever touches
while the real file moved under `inertGround`. Recording the target instead was
the alternative and it was rejected as a second vocabulary: the ground question
already reads a symlink as ground it cannot classify, and the two readings have
to agree. Every segment of a path is asked, not the last one only, because a
link in the middle moves the whole subtree under it.

One bound remains and it is worth stating. The walk reads specifiers, not
semantics: a module reached only through a runtime path this parse cannot see is
outside it. Every shape that hides one, though, is itself a refusal, so what is
left is a module reached by a literal relative specifier the static forms miss.

## The pinned project config is ground

A run judges against the project config blob it pinned at its launch. That file
now carries the ground of every Tier-1 layer, so a default branch that has moved
it since decided this run's claims under a version the merge target no longer
states. The config path the run pinned is therefore one of the six sets, and a
branch that moved it refuses with `ground-intersects`.

## Why a lens finding is asked about its own ground

A certification is two things: the deterministic gate results, and a review
panel's reading of the tree (ADR-0022). The gates declare their ground, and so
does a finding: the seat that raises one names the files and directories the
claim is about (ADR-0085). So a finding is asked the question every other claim
here is asked. An incoming file under any finding's ground refuses, naming the
finding and the file. No hit, and the findings stand with the rest of the
certification.

A finding that names no ground refuses the whole check, naming the findings that
declared nothing. That is the honest answer for a claim with no surface: nothing
in this project can say the branch left ground alone that was never stated. Every
certification written before a finding carried ground reads that way, and so
does one from a seat whose list reached the record empty.

The refusal is deliberately the reviewer's own claim rather than a measurement. A
narrow ground carries a finding a rebase should have re-judged. The verifier may
replace the ground on a confirmed HIGH, which is where the claim is worth the
most, and below that grade the ground is the lens's word.

## One canonical path, everywhere

Declarations, config lists, argv words, import specifiers and git's own output
all name files, and they name the same file in different hands: `./docs`,
`docs//`, `docs`. The comparison this check runs is a prefix comparison, so two
spellings compare as two different paths, and a declaration written
`./docs/fixtures` would clear every check that asks whether a declaration exists
while matching no file at all. There is therefore one canonical form and one
function that produces it, `groundEntry()` in `src/config/project.mjs`, beside
the glob vocabulary it belongs to. Every path meets it before anything compares
it: separators forward, `.` and empty segments dropped, no trailing slash, and
null for a name that canonicalises to nothing or climbs out of the repository.

`.` is the entry that matters most. The path vocabulary compares a plain entry
as a prefix, no repo-relative path is `.` and none begins `./`, so an entry of
`.` reads like a declaration of the whole repository and matches nothing. Such
an entry is dropped, a part left with no entry at all is refused as the
undeclared suite it is, and a `ground` list holding one is refused at the launch
by name.

## The refusal vocabulary

The set is closed, because a refusal outside it is prose again and a count of
prose is nothing (ADR-0008). Two of the words name facts that read alike and are
not.

- `no-standing-green`: a Tier-1 layer holds no green result to carry. It is
  defensive, because the update stage runs behind a green verdict.
- `undeclared-suite`: a layer, or a part of one, whose ground neither source
  declares. The launch rule makes it unreachable for a project with
  `gates.fastPathShip: true`, so one occurrence means the validator and the ship
  reader disagree about what a declared ground is, and that is a defect of this
  mechanism rather than of a project.

They have different causes and different repairs, so a count that mixed them
would be a count of nothing.

One word is not a refusal of the code answer at all. `records-rerun` says the
code certification stands and the record one does not, so the run goes to the
reconcile stage rather than to the verdict. It rides the same closed set because
`taken: false` needs a word, and a reader that counted it as a refused fast path
would read a working path as a broken one.

## What a taken record does not settle

A run can take the fast path over one moved base and still render the full
verdict afterwards: a red at the request sends it back, and so does a second
moved base at the ship stage. That verdict judges the tree that lands, which is
the whole of what the fast path skipped, so the run earned the certification it
ships and the trade was never made. A taken record with a GREEN verdict rendered
after it therefore marks nothing: the close carries no `fastPath`, an escape
behind that merge is the ordinary escape, and the tripwires that measure the
trade do not count that ship. The record itself stays in the ledger, because the
check did run and did answer.

Green, and nothing weaker. A red render certifies nothing, and the env-only CI
route renders one deliberately: it carries a failure the tree is not to blame
for, the run recovers, and it ships on the certification the fast path carried.
Reading that red as a re-certification would take the mark off the close, the
word off every escape behind the merge, and the ship out of the count, which is
the whole of the evidence the flag is judged on.

## What the check may not do to the ship queue

The whole check runs inside the ship token, so anything it holds it holds for
every run waiting to ship. Every git read it takes is bounded at
`GIT_TIMEOUT_MS` (two minutes); a read that hits the bound is killed, the call
throws, and the throw is the `internal-error` route, which is the full
re-verdict. A hang is not one of the endings. The ground derivation itself is
pure list work over the layers and their entries: it reads no file and runs no
git command.

The ledger record names the default-branch commits examined, and the list is
capped at 200. A range past the cap carries `truncated: true` beside the true
`commitCount`, because a reader of a 200-line list cannot otherwise tell a range
of exactly 200 from a range the record stopped writing down.

## Why the merge proves the rebase

A rebase in the run worktree would rewrite a branch the request is already built
on, and the harness ships merges, not rebases. What matters is not the shape of
the operation but the tree that lands, and the two patches above are a proof
about exactly that tree: they say the merged tree equals the branch with the
story's patch applied unchanged, which is the property a clean rebase would have
established. The check is therefore about the artefact under judgment rather
than about a rehearsal of it.

A merge that conflicts never reaches the check: the conflict route runs one
stage in front, resolves the conflict with a dev seat, and the resolved tree
fails question one on the seat's own edit.

## Why declarations and not inference

Suites that exercise HTTP routes and database state have coupling no import
tracer can see. A declared input is an auditable claim a reviewer can check; an
inferred one is a guess with a failure mode nobody reads.

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
have a sixth of the ground question answered by an empty list while the record
read like a whole answer.

## Failure is never a wedge

Every ending of the check that is not a clean yes is the full re-verdict. A
throw inside the check itself, an unreadable record, a git command that fails, a
path vocabulary that will not compile, is caught at the lane, stamped as
`internal-error`, and the run proceeds exactly as it would have if this path had
never been written. The fast path can only remove work. A defect in it makes a
ship slow and can never make one wrong.

The stage around it has one more ending, and it belongs to the stage rather than
to the check. Every write the stage makes has a crash window behind it: after a
resolved merge round, after the update stamp, after a fast-path REFUSAL. A merge
is idempotent, so every one of those resumes meets a merge that answers "already
up to date" and a base that reads exactly like one which never moved. A route
decided on that reading takes the run to the request over a tree nothing judged,
and the last window turns a recorded refusal into a carried certification.

So the route is decided on what the ledger PROVES about the trees the run holds.
For the code tree there are exactly two proofs: a green verdict rendered at the
last code commit's sha, or a taken fast-path record for it. For the record tree
there is one: a green `reconcile-rendered` at the last record commit's sha, or the
run's own spent cap fallback, which is the decision that the records ride with
their residual ticketed (ADR-0075). A stamp that merely carries a sha is not a
proof; it says a tree was built, never that anything stood behind it. A tree with
no proof that this call's merge did not build goes to the full re-verdict and
never to the fast path, because the shas the check reads went with the lost
record, and a decision over shas the run cannot name is not the decision it would
have made.

## Measuring both halves of the trade

This is a gate cut, so the doctrine rule applies: a cut names its metric, its
watch window and its breach condition in the same change, and a breach restores
the cut by default. Two readings are needed and not one, because a cost of
nought over a check that never fires reads exactly like a cut that works.

- `fast-path-escapes` counts what the trade costs: defects that reached the
  default branch through a ship which carried its certification, over the last
  ten shipped runs of ONE project. Two in ten breaches, and the answer it
  carries is the config line that turns that project's flag off. The band is
  deliberately tight, because the guarantee was traded away on the belief that
  escapes would be rare, and two in ten is the reading that says the belief was
  wrong.
- `fast-path-takes` counts what the trade buys: the share of the fast-path
  records of that window which carried the certification instead of refusing.
  It is eligible only where at least three runs of the window met a moved base,
  because one moved base that refused is an ordinary busy branch and a rate over
  nothing is not a reading about anything. A rate of nought over an eligible
  window says the check refuses everything and pays for itself with nothing.
  Its answer names the refusal histogram, because each word names a different
  repair: a run of `ground-intersects` means the ground lists are right and the
  branch is busy, a run of `unclaimed-ground` means `inertGround` is too thin,
  and one `undeclared-suite` means the validator and the reader disagree.

Both are armed rather than required. A project that sets `gates.fastPathShip`
and registers neither has the standing entries armed for it, at the standing
bands, wherever the registry is read. Arming is the answer rather than a config
refusal because the flag is opt-in and a refusal there would wedge the whole
project over it. Arming cannot wedge anything, it shows in the same board the
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

## What the record carries

A taken record's `declaration` names the tree the declarations came out of, the
version they were checked against, the suites they cover, how many entries the
whole declared ground holds, and `ground: {declared, config}`, which is how many
Tier-1 layers each source answered for. A layer both sources answered counts in
both. A project whose reading moves from `{declared: 8, config: 40}` to
`{declared: 7, config: 40}` has a runner that stopped printing its markers, and
nothing else in the record says so.

The version is a digest over every claim the decision rested on: the suites, the
whole declared ground, the suite files, the breadth list, the inert list, the
declaration sources, and one `ground <layer> <entry>` line per config entry. It
moves when a claim moves and at no other time, so two records carrying one
digest were decided under one set of claims. A record written before the config
ground existed carries a digest computed without those lines, and a reader
comparing an old digest with a new one gets a difference that is real: the
claims did change.

## Adversarial reading

Declarations become load-bearing for correctness at ship time, not only for
speed, and the surface they cover is now every Tier-1 layer rather than two
project-wide lists. A `ground` list is a claim about what a command reads, and
only a reader of that command's script can check it. A list that is too wide
costs refusals, which is cheap. A list that is too narrow lets the fast path
pass a change that could reach the layer, and lets a part carry that should have
run. Nothing catches that but the escape metric, after the fact. That is the
sharp edge of this decision and it does not have a mechanical answer.

The breadth list is a single point of forgetting. Ground that belongs on it and
is not there weakens every fast-path decision at once, silently. Its edits
deserve the review weight of a frozen test. The inert list is the same surface
with the failure inverted: ground listed there that a suite CAN reach turns a
refusal into a pass. Forgetting the breadth list costs proof; over-claiming the
inert list costs the same proof, and neither is caught by anything but review.

The project config file is load-bearing at ship time in a second way now. It
carries the ground of every layer, so an edit to it deserves the review weight
of a frozen test, and a main-side move of it refuses a fast path outright.

A launch-time refusal can take a project dark. A `gates.tier1` layer that lands
with no `ground` refuses every launch of that project until a config change
merges. A project-side config lint that carries the same rule reduces that to a
CI failure; it does not remove it. `gates.fastPathShip: false` is the one-line
escape and it is the same line the revert uses.

A symlink, a submodule and a mode-only change are all read as ground this check
cannot classify, so every one of them refuses. A declaration names a path's
content; nothing in any project claims the bit that says a file is executable,
or what a link points at.

Two commits that each land on inert ground can interact with each other in a way
neither interacts with the story. That is out of scope here: the question this
check asks is about the story and the branch, and the branch's own consistency
is what the branch's own checks are for.

## Fallback paths

The revert is one config line: `gates.fastPathShip` back to `false`, or removed.
The next ship takes the full re-verdict, no state has to be unwound, no ledger
has to be rewritten, the launch rule disarms with it, and the records of the
ships that did fast-path stay readable. The standing tripwire proposes exactly
this line, so the reversal is the answer the machine already hands over.

A narrower fallback, if the ground question turns out to be the weak half: empty
`gates.inertGround` while leaving the flag on. Every moved file is then ground
no claim reaches, every ship refuses with `unclaimed-ground`, and the reason is
in the ledger rather than in a config line nobody reads. It is the same one-line
revert with the record kept.

A narrower one again, if the config ground turns out to answer for nothing: the
`ground` lists come off the layers and the flag comes off with them, because
without the lists the silent layers refuse every ship. The trigger is a window
where `groundFrom: "config"` never appears on a part that carried and every take
was decided by markers alone.

A wider one, if declarations prove trustworthy and the residual never
materialises: the same two questions could carry a certification across the
ship-stage update as well, which today always re-runs CI without a re-verdict.
That is deliberately not done here; one thinned guarantee at a time.

If the record neighbourhood proves too wide, because a re-run fires as often as a
code re-judgment and finds no `consistent` finding, the record ground narrows to
the run's own records and drops the neighbours. Trigger: a re-run share near the
re-judgment share over ten moved-base ships, with no `consistent` finding behind
any of them. Reversal cost: low, one list at the call site; the question, the
answers and the stamp do not change.
