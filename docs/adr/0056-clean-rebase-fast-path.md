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
  run last met it is tested against four sets: the story's own changed files,
  every declared input of every suite in the certified verdict, the suite files
  (`repo.testPaths`), and the project's shared breadth list
  (`gates.breadthGround`). One hit refuses. A suite that declared no inputs
  refuses. A change the harness cannot read as a file of this repository, a
  submodule bump above all, refuses.
- **Both answers agree or the run takes the full re-verdict.** There is no
  third ending.

A fast-path ship stamps `fast-path-ship` with `taken: true`, the default-branch
commits it examined, the declaration version they were checked against, and the
certification it reuses. The close carries `fastPath: true`. A refusal stamps
the same event with `taken: false` and one word from a closed refusal set, so a
flag that fires for nothing is readable as one.

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

## Failure is never a wedge

Every ending of the check that is not a clean yes is the full re-verdict. A
throw inside the check itself, an unreadable record, a git command that fails, a
path vocabulary that will not compile, is caught at the lane, stamped as
`internal-error`, and the run proceeds exactly as it would have if this path had
never been written. The fast path can only remove work. A defect in it makes a
ship slow and can never make one wrong.

## Measuring what the trade costs

This is a gate cut, so the doctrine rule applies: a cut names its metric, its
watch window and its breach condition in the same change, and a breach restores
the cut by default.

`fast-path-escape` is a closed defect kind (ADR-0008). An escape recorded
against a merge that a fast-path ship carried takes that word, with the run, the
request and the merge commit on its refs. The attribution is derived from the
ledgers, not from what the reporter believed: the console route is
`olympusctl escape --pr <n>` or `--merge <sha>`, and the harness decides.

The `fast-path-escapes` tripwire counts that kind over the last ten shipped
story-lane runs. Two in ten breaches, and the answer it carries is the config
line that turns the flag off. The band is deliberately tight, because the owner
traded away a guarantee on the belief that escapes would be rare, and two in ten
is the reading that says the belief was wrong.

## Adversarial reading

Declarations become load-bearing for correctness at ship time, not only for
speed. A declaration that is stale is caught by the project-side gate that
resolves every glob; a declaration that is merely too narrow is caught by
nothing but the escape metric, after the fact. That is the sharp edge of this
decision and it does not have a mechanical answer.

The breadth list is a single point of forgetting. Ground that belongs on it and
is not there weakens every fast-path decision at once, silently. Its edits
deserve the review weight of a frozen test.

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

A narrower fallback, if the ground question turns out to be the weak half: keep
question one and require that the default branch gained nothing at all outside a
project-declared inert list. That is a stricter rule over the same machinery and
it needs no new concept.

A wider one, if declarations prove trustworthy and the residual never
materialises: the same two questions could carry a certification across the
ship-stage update as well, which today always re-runs CI without a re-verdict.
That is deliberately not done here; one thinned guarantee at a time.
