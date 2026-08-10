# ADR-0006: Story-lane pre-freeze chain shapes

Status: accepted (2026-08-10)

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
- **Spec-gate accounting.** Cap 2 counted rounds: round 1 reviews the whole
  spec; the birth seat amends; round 2 re-checks the amended sections only.
  An intent conflict stamps no round — it parks, the answer directs one
  amendment, and the counted ladder resumes with its budget intact. Findings
  open after round 2 close the run `failed` (`spec-gate-exhausted`); the
  relaunched run births a fresh spec, so repair-in-place buys nothing.
- **Lane-level contract loop.** A deterministic defect in a seat's work
  product — a change outside the test paths, a declared suite file that does
  not exist, an expected red not classed `feature-absence`, a survivor with
  neither killing test nor disposition — takes the same route as an invalid
  report: one corrective invocation with the defect list, then
  `seat-failure`. Any seat-failure closes the run `failed`; the response
  ladder that refines this arrives with the verdict milestone.
- **`suite-committed` event** (new in the run registry): sha, file list, and
  phase — `author`, `amendment`, `strengthening`, or `fix`. It is the
  resume anchor for the adversary stage and the audit trail for every suite
  change between birth and freeze.
- **Adversary evaluation.** Three waves per round, each in a disposable
  worktree detached at the current suite sha, each evaluated to verdict.
  Before the suite runs in a wave tree, the harness restores the test paths
  from the sha (checkout + clean), so a tampered or deleted test is
  structurally void — no detection, no trust. Kill = suite red. Killed
  trees are removed at verdict; survivor trees persist as amendment
  evidence (report + working-tree diff) until their disposition.
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
  disposition per wave, and the red-state result with the declared reds.
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

## Why the gate closes on exhaustion instead of parking

The touchpoint catalog is closed at eight park events, and cap-2 exhaustion
is not one of them. A spec that still fails its gate after one amendment is
a birth defect; the cheap route is a fresh birth on relaunch, not a human
repairing a bad spec through a queue. The close state and reason are
stamped, so the pattern is visible if it recurs.

## Why suite-defect fixes are capped pre-freeze

The map leaves pre-freeze suite fixes unbounded. An unbounded seat loop on
a deterministic check invites a silent token burn; the contract-loop shape
(one corrective, then fail) already governs report defects and carries the
same logic: the second failure is evidence the seat cannot fix it, and a
failed run is cheap to relaunch. Deterministic re-runs (the red-state
command itself) stay unlimited — they judge nothing and cost minutes.

## Fallback paths

If accept/fail proves too coarse for unkilled gaps (the human wants another
amendment round instead), add an `amend-again` option resolving to one more
amendment cycle. Trigger: gap parks answered `fail` where a retry was
wanted. Reversal cost: moderate — per-round amendment bookkeeping.

If closing on spec-gate exhaustion churns relaunches on the same card,
convert the exhaustion to a park by map-level decision (a ninth catalog
entry). Trigger: repeated `spec-gate-exhausted` closes on one card.
Reversal cost: low — the close directive becomes a park directive.

If the `--disallowedTools` rule syntax does not hold at the live shakedown,
the ADR-0005 fallback applies: a deny hook in the seat's settings file. The
restore-before-evaluate step keeps the evaluation path safe either way.

If restore-before-evaluate hides tamper attempts the eval seat should see,
stamp a pre-restore diff of the test paths as a ledger event. Trigger: an
eval review asks who tampers. Reversal cost: low — additive stamp.
