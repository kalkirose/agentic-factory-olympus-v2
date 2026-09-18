# ADR-0094: A finding about a frozen pin takes the amendment route, whoever finds it

Status: accepted (2026-09-18)

## Context

The harness holds exactly one structured shape for "this frozen pin must
change": the test, the assertion that is superseded, the card line the mandate
rests on, and the section it came from. ADR-0044 made the card the authority for
it and ADR-0091 made it one obligation with one record at three sites. The spec
carries that shape at birth, the spec gate carries it, a verdict triage finding
carries it, and an implementing seat's `suiteConflicts` entry carries it.

A review finding carried none of it. A review seat judges a diff and files a
finding with a lens, a severity, a sentence and its ground, and nothing in that
shape says whether the repair belongs in the code or in a frozen test. So a
review finding about a frozen pin had no way into the amendment route at all.

The route it took instead was the code route, and every step of that route made
the next one worse.

A confirmed review finding is a code finding by definition, so it reached a
repair seat. That seat may not edit a test file. It reported that the tree was
unchanged and it wrote down, under `suiteConflicts`, which of the claimed files
it had measured green and which one was the real collision. The harness read
none of it: conflicts were read from the first implementing pass alone, and only
behind a red suite.

The empty repair commit still stamped `implementation-committed`, which every
reader of the code head takes as a moved tree, so the loop bought a whole review
cycle over a diff byte for byte identical to the one the render had already
judged. The same finding twice is `no-progress`, `no-progress` spends the run's
one automatic fresh pass, and the fresh pass resets the tree and starts a new
implementing seat from nothing.

The end of that route is a run that discards a finished implementation over a
finding no implementation could ever have answered. The one report that said so
was thrown away three steps earlier.

Two facts bound the repair.

The first is that the claim shape already exists and every other finder of a pin
collision already carries it. What was missing was a review finding that states
it.

The second is that the seat that found the right answer wrote it down. A route
that reads its own seat reports learns the truth one round later instead of
discarding the work.

## Decision

**A finding about a frozen pin carries the claim the card checks, whoever finds
it, and every seat report that names a pin is read.** Suite work takes the suite
arm: the card check, the spec amendment, the suite amendment, the
re-verification. It never enters a repair round. A repair round that moved
nothing plans no cycle and buys no budget it did not earn. The one automatic
fresh pass stays reachable from code findings, and from a suite defect that
survived its own re-freeze, and from nothing else.

**A review finding states where its fix lives.** `reviewSchema` in
`src/lanes/review.mjs` requires `fix`, which is `code` or `suite`, on every
finding of every lane, and a suite fix may carry the four claim fields of
`SUPERSEDE_CLAIM_PROPERTIES` beside it. One finding names one frozen test: one
amendment is authorized, written and reviewed per test, so a collision across
several files is several findings.

**The round's own check loop holds the shape the route can act on.** In a lane
with a frozen suite, `suiteClaimDefects` refuses a suite fix whose ground names
more than one frozen test, one whose ground names none, one on a pin an earlier
story wrote that carries no claim, and one whose claim names a different file
than its ground. It refuses a `code` fix whose ground is frozen tests and
nothing else. Each is a defect in the work product and costs one corrective
answer.

The refusal about an earlier story's pin rests on a set read from the tree, not
from a declaration. `suiteSets` derives the run's own frozen tests as the frozen
set less what the tree held at the launch base sha. A suite write's declared
file list names files it never touched and files an earlier story pinned, so
either declaration would class another story's pin as this run's own and skip
the card check on it. Absence at the base sha cannot. A run with no readable
listing there owns nothing beyond the set below, and every other suite finding
in it needs a claim.

A test the card already authorized this run to amend joins that set. The reason
is the review duty ADR-0044 put on the panel: a seat reads the amendment and
reports that it reached further than the card line does. Its ground is that one
test and the repair is in that test, so a rule that asked it for a fresh card
claim would refuse the one finding the round exists to raise. The authority is
already in the ledger, one stamp per test per run, and the rule of one amendment
per defect bounds what a second finding on the same test can buy.

**The harness runs the round's suite claims before the verifier judges them.**
`src/lanes/claims.mjs` runs the project's own suite command once per review
round, in the run worktree, narrowed by `OLYMPUS_FILES` to the claimed files and
by `OLYMPUS_PARTS` to the parts whose recorded ground covers them. It goes
through `runCommand` and never through the spectrum: a run through the spectrum
would stamp `layer-started` and `layer-result` and become the cycle's standing
acceptance result, which is a green or a red the cycle did not judge. It keeps
its own log, under its own name, whatever the exit code, because the selection
line of a green run is the evidence.

The reading is per file and it is not the exit code. A file a part reported
among its reds is `red`. A file whose part passed AND whose part said it
selected it is `green`. Everything else is `unselected`, which covers a file no
gate of the project runs and a command that reads no narrowing and prints no
selection line. A `red` confirms the claim's premise and the verifier judges the
claim. A `green` makes the finding advisory whatever the verifier says, and
`claim-unproven` carries the claim to the triage of a later red in that file. An
`unselected` file leaves the verifier's own reading in force.

**A confirmed suite fix is stamped as a suite defect with a derived depth.**
`settleFindings` writes `class: 'suite-defect'`, the claim under `supersede`,
and `depth: 'test'` where the test is one of the run's own, `depth: 'intent'`
otherwise. The run's own test mis-encodes the run's own spec, so the suite seat
amends it and no card line is owed; a pin an earlier story wrote and the card
has not yet ruled on is the card's to authorize.

**A suite defect is never in the code set.** `openSets` in
`src/lanes/verdict.mjs` keeps a `suite-defect` out of the code set in the story
lane whatever `confirmed` says, so `refreezeOwed` and `cardSupersedes` read a
review finding exactly as they read a triage one. The repair lane freezes no
suite and its fix seat may edit a test, so a suite fix there stays an ordinary
code finding and none of these rules fire.

**One derivation feeds the ladder and the resume.** `ladderSets` returns the
render's open sets widened by the suite defect that survived its own re-freeze
and by the findings a conflict triage raised inside the entry. `ladder` and the
interrupted-step resume both read it, so a step dispatched again is dispatched
over the set the step it replaces had.

**An implementing seat's conflicts are read whatever the suite said.**
`acceptedConflicts` keeps the red gate for the first implementing pass, where a
red with no attribution is unfinished work, and drops it for a repair seat. That
seat reports on the findings it was given over a tree it may have left exactly
as it found it, so its conflicts are about those findings and not about the
suite. `suiteStateDefects` keeps its refusal of a red that names no conflict and
runs the frozen-set check over whatever a report names.

**A conflict an implementing seat reports is judged by a seat of its own.**
`conflict-triage` enters the seat map on the default definition, the report
schema is the triage shape without the fields a spectrum puts in it, and its
checks hold three things: every entry is answered by exactly one finding, the
entry number is in range, and a suite-defect finding carries a depth. Its brief
states the entries verbatim, the card, the classification duty, and the rule
that a pin an implementation can satisfy is a code-defect finding whatever the
reporting seat said.

It is dispatched by the stamp it answers and never by the cycle, because two
sites reach it and the cycle number differs between them. `answers`, the seq of
the `dev-suite-conflict` it settles, is the label, the resume anchor and the
idempotency key of everything it writes.

The two sites are the open of a cycle, where the first implementing pass's
collision is answered before a single gate layer runs, and the ladder, where a
repair round's collision is answered before the entry routes anything. One
derivation triggers both: the newest `dev-suite-conflict` no `conflict-triage`
answers and no `re-freeze` has spent.

**The card decides all or nothing before anything is stamped.** At the
cycle-open site the step asks the pure check of every intent finding's claim
first. One refusal sends the whole set to the render, where the ladder parks the
owner as it does today. Without that guard a partial set would leave
authorizations behind and the ladder would stamp a second one for the same test
at its next entry, because the verdict site passes no already-authorized list on
purpose.

`cardSupersedes` therefore takes the seq the caller stands on rather than the
render: the render on the ladder, the conflict-triage stamp at the open of a
cycle, where no render of that cycle exists yet. `refreezeStep` takes the same
seq for the spec amendment, because on the first cycle the render seq is nought
and the spec birth's own report would satisfy the check.

**A repair round that moved nothing stamps that it moved nothing.**
`runDevSeat` stamps `repair-no-change` instead of `implementation-committed` for
a repair seat whose commit left the head where it found it, and the round stamp
carries `changed: false`. `repair-no-change` moves no code head and is not on
the list in `src/lanes/codehead.mjs`: the tree did not move, so nothing in the
run should read that it did. The round still counts, so the cap, the stall and
the fresh pass reach it exactly as they reach a round that moved the tree. The
interrupted-step resume reads either stamp as a finished round. The fresh pass
keeps its own stamp whatever the tree did, because the pass is read off it and a
pass that rebuilt an identical tree has still spent the pass.

`repairStalled` does not count a round that moved nothing and whose collision a
re-freeze then answered. That round was never the thing that had to move the
findings; the amendment was, and it landed.

A repair round that changed nothing and named no pin is refused once by the
check loop. The common cause is a seat that did not know it could name a pin,
and one corrective answer is the cheap and usually right correction. A second
such report is accepted and the run takes the route it already has for a repair
seat that cannot move the tree. The invocation is spent per dispatch and per
defect class, because a key on the render would accept every later round with no
correction and a key on the seat alone would let an earlier refusal of another
kind answer this one.

**Every re-freeze that carried a confirmed finding owes the amendment review.**
A triage-sourced suite defect resolves mechanically: the findings are re-derived
from the cycle's reds and a green spectrum yields none. A confirmed review
finding does not. It is carried forward by the prior-open set, and the only
thing that drops it is a verifier that resolution-checks it inside a review
round. So `amendmentBlocks` returns every re-freeze after the newest of the last
render and the last fresh pass that has a card ruling OR names a finding the
ledger stamped confirmed. The fresh-pass bound is load-bearing: a pass resets
the tree, and a commit before it is then reachable through the reflog alone.

Each owed amendment is read over its own `baseSha..sha` range, into its own diff
file, and the generalist seat takes an ordered list of labelled blocks: the
repair diff first where the cycle has one, then one block per amendment. A
single range from the first to the last would swallow whatever was committed
between them, and a repair round between two amendments is exactly that. The
seat joins the cycle's one round, so one verifier label and one resume guard
cover it: the verifier label and the guard are keyed by cycle, and a second
round would read the first round's stamps.

**The re-freeze settles every obligation the run holds.** Every
`suite-committed` stamp carries `changed`, the paths its own commit moved, read
from git where both shas are still live. `owedSupersedes` asks two questions of
every authorized supersede with no settlement: did a suite write of this run
move that file, and did it move between the launch base sha and the freeze
anchor. An entry both answers say no to is owed to this write and the write is
refused without it, with the entry named in the seat's brief. Every entry the
write leaves is stamped `supersede-settled`, once per test for the life of the
run.

The second question is owed to the freeze, which accepts a target the DEFAULT
BRANCH amended: its own check asks whether the file moved since the launch base
sha, and a merge brings main's edit in. With the first question alone, no suite
write of this run holds that file, every later write would be refused for it,
and the seat would be asked to amend a file that is already correct, which is a
park nobody earned.

**Three alarms, each a loud `gate-integrity` at threshold nought.**
`fresh-pass-suite-route` is a fresh pass taken over a suite defect no re-freeze
of the run carried, whatever the trigger; that second half is the whole of the
test, and it keeps the alarm off the legitimate route, where a stalled defect
rides the repair brief by design and is in the open set of the pass behind it.
`report-unconsumed` is a collision an implementing seat reported that no
judgment answered, read once per cycle without the re-freeze guard, so it stays
live for the shape where a later re-freeze retires a stamp unread.
`claim-unrun` is a confirmed suite finding with no claim run. Each carries its
findings under `findings` and never a `findingId`, because the harness-finding
rule in `src/ledger/resolution.mjs` keys on that field and the ownership walk
stops at the first match: a stamp carrying both would be owned by the render and
would resolve at the moment the alarm is about. Each is owned by `run-closed`,
so a loud record never outlives the run that raised it.

## Consequences

Every review seat states `fix` on every finding, in both lanes. A seat that
omits it fails schema validation and spends a corrective re-prompt. That is one
field on every finding of every review round from the first one.

The `fix: 'code'` ground rule is weak and is meant to be. A seat that files a
suite fix as code and names one code file in its ground is not caught by it.
What catches that one is no longer the review seat at all: the repair seat it
reaches reports the collision, the conflict triage judges it, the card routes
it, and the round that moved nothing plans no cycle and buys no fresh pass. The
cost of the miss is one repair dispatch.

A review round that carries a suite claim pays one run of the project's
acceptance layer before its verifier spawns. Where the project's runner ignores
the narrowing, that is the whole of every part the claimed files sit in, every
file reads `unselected`, and the routing is correct and slow.

A claim about a race is green when the harness runs it. Such a finding becomes
advisory, the test it names is amended only when a later red in that file
reaches a triage, and a race that never shows in the run's own cycles ships
unamended, as it does today.

A claimed file no gate of the project runs can be neither proven nor refuted
here. It reads `unselected`, the verifier's reading stands, and the card check
bounds what that reading can buy.

The claim run is silent for its whole length except for two stamps: one at the
start, and one per finding at the end. A claim run that hangs reads as a long
one until the seat-silence machinery ends it.

The conflict triage adds one seat invocation at the open of a cycle that carries
conflicts, and after every repair round that moved nothing. A seat that classes
a real code red as an intent conflict is bounded by the card check; a seat that
classes a real conflict as code sends the run through one spectrum and the
ordinary triage, which is the path it already had.

A suite defect that survives its own re-freeze rides the repair brief. That is
the intended route, and it hands a repair seat a finding it may not answer in
the test. The seat answers it in the code or reports it again under
`suiteConflicts`, where the conflict triage reads it.

Every re-freeze that carried a confirmed finding now spawns a generalist seat
and a verifier. ADR-0044 spawned one only where nobody had been asked; this
widens it to a human-ruled amendment and to one at depth `test`. The alternative
is the fresh pass such a run took, which discards a whole implementation.

A confirmed review finding's fingerprint changes, because the class is digested
into it. A finding stamped before this and re-raised after it reads as two
identities. The effect is bounded to a run resumed across the upgrade and it
falls in the soft direction: the progress rule reads progress where there is
none, so the run spends another repair round instead of a fresh pass.

Load-bearing now: the freeze record's file list and its exclusions, the launch
base sha, the `changed` list on every suite write, the ledger's authorized
supersedes, the stability of the verifier item order across a restart, and the
runner's own selection and failed-file marker lines.

## Rejected options

- Route a review finding by the files it names. A finding's ground holds code
  files and test files together and the stamp carries no single file, so every
  such finding routes to code; and a routed finding still parks, because the
  card check needs a claim the finding does not carry.
- Key the check on a `file` field. A finding that names no file never meets the
  check it exists for, and a seat evades it by naming a code file. The seat
  states `fix` outright instead.
- Let the verifier confirm a suite claim by reading alone. A reading that is
  wrong amends tests that did not need amending, and the command can answer the
  same question in one run.
- Let the verifier run the file itself and report that it did. The harness runs
  it before the seat spawns and stamps the result, so the seat judges with the
  run in hand, no report field is owed, and no alarm is needed for a seat that
  forgot to run.
- One claim run per finding. A collision across five files is five runs of one
  acceptance layer, serial, before any verifier spawns. One run per round
  carries every claimed file.
- Narrow the claim run by the failed-file variable. A step that variable narrows
  to a file its framework selects nothing for is turned red by the runner with a
  stated reason, so the claim run would read a false red on exactly the file the
  route exists for. The variable also means "the files that were red last
  cycle", which a claim run is not.
- Read a claim run's green from the exit code. A green whole part says nothing
  about one file inside it, and a narrowed run of a file nothing selects exits
  zero. Green needs the runner's own word that the framework reported the file.
- Read the claim off the cycle's own acceptance result instead of running
  anything. A command that exited zero has its log deleted, so a green
  acceptance layer leaves no selection evidence at all. Keeping every layer's
  log is a change to the evidence policy of the spectrum.
- A second `settleFindings` call for the amendment's review. The verifier label
  and the resume guard are keyed by cycle, so a second call reads the first
  call's stamps and its verifier report. The amendment's seat joins the cycle's
  one round.
- A refutation channel on the repair report. It adds a report field, a second
  verifier round, a stamp and an alarm, and it leaves the ladder with no render
  to act on when a refutation empties the open set. Reading that seat's own
  conflicts is the same evidence through a route the harness already has.
- Settle every earlier supersede from git alone. After a fresh pass the suite
  write commits are reachable through the reflog only, because the freeze makes
  no commit of its own. The recorded `changed` list needs no reachability later.
- Stamp `depth: 'intent'` on every suite finding. A finding about the run's own
  test would reach the card check, find the card silent about a file the run
  itself wrote, and park for nothing.
- Park the owner when a review finding is suite-scoped. ADR-0044 removed that
  touchpoint; the card answers it.
- Let a repair seat edit tests when the finding is suite-scoped. The freeze
  exists so no seat moves the ground it is judged on (ADR-0091).
- Park on a repair round that changed nothing and named no pin. The refusal
  costs one corrective invocation and no more; the stall and the fresh pass
  already answer a seat that cannot move the tree.
- Share the verdict-triage seat for the conflict triage. The probe key, the
  retry budget and the attempt limit are keyed on the seat name, so the two
  would spend each other's budget inside one cycle.
- Give the conflict triage the certification model at the certification effort.
  The certification spine is a named set of three seats that decide whether a
  run may ship, and its model is an ADR-level decision (ADR-0005). This seat
  judges a report and certifies nothing, so it takes the default definition
  every other judging seat takes.

## Fallback path

`lanes.story.cardAuthorizedSupersede: false` turns the card's authority off at
every site, as it did before this. The routing then still holds: a suite finding
takes the suite arm, and a repair round that moved nothing plans no cycle. Every
collision the card would have settled parks for the owner instead. The
switch trigger is a window of amended pins whose card lines do not reach the
change, read off the spec-lens findings. The reversal cost is one config line
and no harness change.

The claim run has a narrower fallback of its own. A project whose suite command
prints no selection marker reads every claimed file `unselected`, the verifier's
own reading stands for all of them, and the routing is unchanged. Nothing has to
be switched off to get there: it is what the absence of the marker already
means.

## References

- ADR-0005, ADR-0007, ADR-0008, ADR-0015, ADR-0017, ADR-0022, ADR-0034,
  ADR-0042, ADR-0044, ADR-0046, ADR-0053, ADR-0056, ADR-0070, ADR-0073,
  ADR-0091, ADR-0092, ADR-0093
- `src/lanes/review.mjs`
- `src/lanes/claims.mjs`
- `src/lanes/verdict.mjs`
- `src/lanes/supersede.mjs`
- `src/lanes/story.mjs`
- `src/lanes/ship.mjs`
- `src/lanes/codehead.mjs`
- `src/isolation/tree.mjs`
- `src/seats/seatmap.mjs`
- `src/seats/prompt.mjs`
- `src/ledger/registry.mjs`
- `src/ledger/resolution.mjs`
- `src/eval/review.mjs`
