# ADR-0006: Story-lane pre-freeze chain shapes

Status: accepted (2026-08-10)
Superseded in part by ADR-0015: a seat-failure parks the run instead of
closing it, and every readiness refusal parks as well.

## Decision

The pre-freeze chain — readiness, spec birth, spec gate, suite authoring,
adversary, freeze — gets these concrete shapes:

- **Lane composition.** `storyLane({afterFreeze})` builds the lane: the six
  pre-freeze stages plus a caller-supplied continuation. The freeze stage
  hands over to the continuation's first stage. The post-freeze stages land
  with their milestones; until then only tests compose the lane.
- **Ledger-derived position.** Every handler re-derives its position from
  the run ledger and the git state — no cross-stage memory. The adversary
  round number is `1 + strengthening commits`; judged waves are skipped by
  their stamps; the suite sha is the run branch HEAD. A daemon restart
  re-enters the recorded stage and continues.
- **Intent-card contract.** The harness reads three things from a card:
  frontmatter (`key`, `title`, `blocked-by`), and the list items under an
  "Open decisions" heading ("None" counts as empty). Everything else is
  seat-facing prose. Readiness fails the run on a missing or key-less card
  and on a red reference lint; it parks (`open-decisions`) only when the
  card holds open decisions and no answer exists yet.
- **Born spec as a run artifact.** The birth seat writes markdown to
  `runs/<runId>/spec.md` (absolute path in the prompt) and reports
  `spec-born` or `grounding-conflict`. A valid report whose spec file is
  missing or empty is a seat contract breach (`artifact-missing`), not a
  park. The spec archives with the run and is never written back.
- **Spec-gate accounting.** The gate runs on its own authority for as long as
  it converges, with no round cap: round 1 reviews the whole spec; the birth
  seat amends; every later round re-checks the amended sections only. An intent
  conflict stamps no round — it parks, the answer directs one amendment, and
  the ladder resumes. The conflict is a boolean in the seat report, never the
  presence of text: a field whose only "no" is emptiness collects prose that
  means "no conflict", and that prose stops the run. The parking round stamps
  nothing, so its findings ride into the amendment beside the conflict answer
  instead of dying with the round. What stops the gate is a round that stopped
  closing findings, by either of two rules — a round that closed none of the
  previous round's blocking set, or a round whose blocking count is not below
  the count two rounds back — and that is one park, `spec-gate-stalled`, with
  options `round` and `abandon` (ADR-0020). `round` buys exactly one more
  amendment plus re-check, and a round that stalls again parks again;
  `abandon` closes the run `failed` with the same reason. The park question
  carries both blocking counts with the rounds they came from, the note count,
  and the spec path, so the answer needs nothing else.
- **Two finding channels at the gate.** Every gate finding carries a
  `severity`. `blocking` means the spec is wrong, a clause is not assertable,
  or the shape it states would force a defective implementation; it holds the
  spec and buys an amendment round. `note` means prose the suite can prove
  against running code — a count of occurrences in the tree, the size of a
  pattern set, a name the code carries; it does not hold the spec. The field
  is optional in the schema and an omitted value reads as blocking, so a seat
  that never learned the field cannot weaken the gate. Only blocking findings
  reach an amendment brief, on either route into it. Notes are collected
  across every round from the ledger and delivered to the suite seat — author,
  amendment, strengthening and red-state fix alike — as obligations: prove the
  fact with a test and name that test, or report it as unprovable. A note is
  never a waiver, and the `spec-gate-round` stamp counts the two channels
  apart.
- **The spec seat is told what runs the suite.** The birth role block carries
  the suite command and the test paths, the same two facts the suite seat
  gets. The spec writes the test plan, so a spec without them can name a
  runner the suite seat is not allowed to reach.
- **The suite report contract.** Every suite write of this chain reports the
  files it wrote, the expected reds with their class, and the surface map: the
  story's own items along the four security dimensions, each row closed by the
  test that kills a wrong implementation of it or by a stated reason the spec
  does not constrain it (ADR-0072). The amendment write adds a killing test or a
  disposition per survivor. The map is required at all four pre-freeze writes
  and at the re-freeze after the freeze, because each seat runs in fresh context
  and each one can drop what the write before it earned.
- **Lane-level contract loop.** A deterministic defect in a seat's work product
  takes the same route as an invalid report: one corrective invocation with the
  defect list, then `seat-failure`. The defects are a change outside the test
  paths, a declared suite file that does not exist, an expected red not classed
  `feature-absence`, a survivor with neither killing test nor disposition, and a
  surface map that leaves a dimension unaccounted for, closes a row twice or not
  at all, names a test no declared suite file holds, leaves a survivor wave on
  no row, or drops an item of the previous map. Any seat-failure closes the run
  `failed`; the response ladder that refines this arrives with the verdict
  milestone.
- **`suite-committed` event** (new in the run registry): sha, file list, and
  phase — `author`, `amendment`, `strengthening`, or `fix`. It is the
  resume anchor for the adversary stage and the audit trail for every suite
  change between birth and freeze.
- **Adversary evaluation.** One wave a round, each wave in a disposable
  worktree detached at the current suite sha, each evaluated to verdict. The
  count is `lanes.story.adversaryWaves` in project config, a positive integer;
  the lane defaults it to one, so an entry is only ever a raise, and the launch
  pins the config blob, so a raise lands at the next launch and never mid-run.
  Before the suite runs in a wave tree, the harness restores the test paths
  from the sha (checkout + clean), so a tampered or deleted test is
  structurally void — no detection, no trust. Kill = suite red. Killed
  trees are removed at verdict; survivor trees persist as amendment
  evidence (report + working-tree diff) until their disposition.
- **The amendment and strengthening briefs carry every round, not the last.**
  The current round's survivors ride with their report and their tree diff.
  Every earlier round of the run rides beside them, newest first, with its
  approach and its wrongness and no diff, because the lane drops each survivor
  tree when it ends a round. A seat in fresh context cannot see a pattern across
  rounds that nobody puts in front of it, and three rounds read together are one
  instruction where three rounds read apart are three requests to add one test
  (ADR-0072).
- **Survivor resolution.** The amendment report covers every survivor with
  a killing test or a disposition. Killing-test waves re-run against the
  amended sha; a re-run that stays green becomes an `unkilled-gap`
  disposition. Gaps park (`unkilled-gap-survivor`); spec-indifferent
  dispositions record and proceed.
- **Park option sets.** `second-zero-kill`: `strengthen-again` | `fail`.
  `unkilled-gap-survivor`: `accept-spec-indifferent` | `fail` — acceptance
  stamps a superseding `spec-indifferent` disposition with the answering
  human as actor. The three spec-phase parks take free-text answers. An
  answer that picks no option on an option park re-parks with the same
  options; the daemon never interprets prose as a choice.
- **Red-state at freeze.** The suite runs against the pre-implementation
  tree and must be red. Green takes one suite fix round (committed as phase
  `fix`), then a re-check; a second green is a seat-failure
  (`red-state-green`). The declared-red classification is enforced at every
  suite report; the red-state process enforces the part a declaration
  cannot: that the suite actually fails without the feature.
- **Freeze record.** `runs/<runId>/freeze.json`: story key, born-spec ref,
  suite sha and file set (from `ls-tree` under the test paths), every wave
  verdict with its sha, final-round kill count, amendment kills, latest
  disposition per wave, the surface map and the dimensions declared out of
  scope, and the red-state result with the declared reds. The map and the reds
  come off the same source, the last suite report, because the record is where
  the frozen set is fixed and every later reader takes them off one document.
  The `freeze` event carries the sha and the counts. The valid record is
  the chain's completion signal.
- **Test-edit boundary.** `testEditDenyRules(testPaths)` produces
  `Edit`/`Write`/`NotebookEdit` deny rules over every test path;
  `runSeat({denyTools})` carries them into the claude argv as disallowed
  tools. A plain prefix entry covers its subtree (`prefix/**`); a glob
  entry is already a complete pattern and passes through unsuffixed. The
  adversary seat gets them now; the dev seats get the same rules when they
  land. The restore-before-evaluate step backs the tool-level deny with a
  structural guarantee on the evaluation path: the restore rides git
  pathspecs (`:(glob)` magic for glob entries), and every other test-path
  read (suite checks, conflict-hunk routing, the freeze file set) matches
  entries with the same semantics.
- **Command environment.** The lane command runner strips
  `NODE_TEST_CONTEXT` from the child environment: under an inherited test
  context a child `node --test` reports exit 0 for a red suite — a false
  green on the evaluation path. The daemon's own runtime context must never
  leak into a verdict.

## Why the gate has two finding channels

A gate that parks on any finding parks on every spec. A run stopped that way
on a gate report whose own summary called its findings none blocking: the
harness could count findings, but it could not read them. One channel forces
a choice between two failures. The gate either blocks bad specs and blocks
good ones with them, or it drops the bar and lets an unassertable clause
through. Neither is acceptable, so the channel splits.

The split is by the place a defect can be settled, not by how much it
matters. A wrong claim, a clause no test can assert, a shape that would force
a defective implementation — each is a defect in the document, and the
document is the only place to repair it. Those still block, and the
convergence rules over them are unchanged.

The other kind is a claim about the tree. The spec says the tree holds three
helpers; the tree holds two. A round of document repair settles that for one
minute: a human retypes the number, the next commit moves it, and no part of
the run ever checks it again. A test checks it on every run. So the note goes
to the seat that writes tests, and the suite proves the fact against running
code or reports it as unprovable. A fact about the tree is proven by a test,
never by prose that a human retypes each round.

Nothing is waived and nothing is dropped. The round stamp counts notes apart
from blocking findings, the ledger holds them, and every suite invocation
that can delete the test which discharges a note gets the note first. The
default guards the bar: an omitted severity reads as blocking, so the channel
opens only when the gate names it.

## Why the gate parks on exhaustion instead of closing

The original rule closed the run, on the reasoning that a spec which still
fails after one amendment is a birth defect and a fresh birth is cheaper than
human repair. The first real story disproved the premise. The gate had
verified the grounding of a 741-line spec across four passes, its own summary
called that grounding strong, and the run closed with a list of five known
findings and about $21 of seat work in it. A fresh birth does not inherit any
of that: it starts from the card and re-derives everything, including the
defects the gate already named.

So exhaustion is a decision, not a defect. The human knows what a relaunch
costs and what the last report says; the machine knows neither. The park
carries the round count, the finding count, and the spec path, and offers
`round` or `abandon`. It frees the slot like any other park.

The cap still holds. `round` grants exactly one more round, counted by the
answered parks themselves, so the ledger is the only state and a restart
replays it. Nothing is unbounded: every extra round costs the owner an
explicit answer.

## Why suite-defect fixes are capped pre-freeze

The map leaves pre-freeze suite fixes unbounded. An unbounded seat loop on
a deterministic check invites a silent token burn; the contract-loop shape
(one corrective, then fail) already governs report defects and carries the
same logic: the second failure is evidence the seat cannot fix it, and a
failed run is cheap to relaunch. Deterministic re-runs (the red-state
command itself) stay unlimited — they judge nothing and cost minutes.

## Why one wave a round

A wave is a full seat pass plus a full suite run in a worktree of its own. The
first wave answers the question the stage exists to ask: does a plausible wrong
implementation pass this suite. Every wave after it asks the same question of a
different wrongness. That is sample size for the kill rate, not a second signal
about the freeze. On the last three-wave story the round cost about $75 and
ninety minutes, and scored 3/3.

What the reduction costs is named here rather than discovered later. Two thirds
of the per-story kill-rate evidence is gone. A round now reports 1/1 or 0/1,
and the kill-rate tripwire weights each freeze by its wave count (ADR-0010), so
the eval seat's history thins at the rate it accumulates. A suite the second
wrongness would have killed and the first does not now freezes green, and
whatever it lets through is found downstream.

Nothing else about the stage moves. A survivor is still a demonstrated suite
gap, and it still sends the suite back: zero kills buys the strengthening round
and a fresh round of waves, exactly as before. The reduction applies only while
the suite kills.

What no wave count buys is coverage of a surface. A wave finds one wrong
implementation. It does not enumerate the set that wrongness belongs to, and a
seat shown one member closes that member. So the enumeration is asked of the
suite seat itself, as a surface map checked before the write commits
(ADR-0072), and the wave stays the independent measure of whether the map is
the surface.

The count is config rather than a constant so that the raise is one line in the
project that wants it, and so that it lands where it is safe. The launch pins
the config blob it read, and every stage resolves its settings from that blob,
so a raise on the default branch cannot reach a run already under way. A run
that started at one wave finishes at one wave, and its freeze record reads as
what the run did.

## Fallback paths

If the note channel becomes an escape hatch — the gate classes a real spec
defect `note` and the suite cannot prove it — the channel closes and every
finding blocks again. Trigger: two runs in which a note reaches the suite seat
and the suite reports that note unprovable. Reversal cost: low —
`blockingFindings` returns the whole list and the gate role loses four lines.

If a discharged note cannot be told apart from an ignored one, the suite
report gains a structured field for it (one entry per note, with the test that
proves it or the reason it is unprovable) and the lane checks the entries
against the note list. The summary carries that answer today, which keeps the
suite schema and every fixture unchanged. Trigger: an eval review that cannot
tell from the report whether a note was discharged. Reversal cost: low —
one optional field plus one deterministic check in `suiteChecks`.

If accept/fail proves too coarse for unkilled gaps (the human wants another
amendment round instead), add an `amend-again` option resolving to one more
amendment cycle. Trigger: gap parks answered `fail` where a retry was
wanted. Reversal cost: moderate — per-round amendment bookkeeping.

If the exhaustion park costs more human attention than it saves — the owner
answers `abandon` nearly every time, or the parks queue up unanswered — the
directive returns to a close. Trigger: three consecutive exhaustion parks
answered `abandon`. Reversal cost: low — the park directive becomes a close
directive again, and the catalog entry can stay.

If one wrongness proves too small a sample, `lanes.story.adversaryWaves` goes
back to three in project config. Trigger: either of two observations — an
escape that traces to a suite gap, or a survived wave against a suite that had
already frozen green. Reversal cost: none — one config line, effective at the
next story launch and at no point inside a run.

If the `--disallowedTools` rule syntax does not hold at the live shakedown,
the ADR-0005 fallback applies: a deny hook in the seat's settings file. The
restore-before-evaluate step keeps the evaluation path safe either way.

If restore-before-evaluate hides tamper attempts the eval seat should see,
stamp a pre-restore diff of the test paths as a ledger event. Trigger: an
eval review asks who tampers. Reversal cost: low — additive stamp.
