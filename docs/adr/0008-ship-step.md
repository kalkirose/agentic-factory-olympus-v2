# ADR-0008: Ship-step shapes

Status: accepted (2026-08-10)
Superseded in part by ADR-0024: a red-merge breach tickets each escape and
enqueues its repair for the frontier sweep. `shipStep` takes `enqueueRepair`
in place of `spawnRepair`, and nothing in the lane graph launches a run.
Superseded in part by ADR-0033: `shipStep` supplies three stages — `update`,
`ship`, `close-out`. The branch update runs before the final verdict, so the
verdict certifies the tree that lands, and only the holder of the project's
ship token opens or merges a request.
Superseded in part by ADR-0041: a check attempt is identified by its check-run
id, the authoritative run of a name is the latest attempt, a cancel is neither
red nor green, and the evidence of a required check that is not green is
captured when the watcher observes it rather than when a seat reads it.

## Decision

The ship step — PR open through ledger close — gets these concrete shapes:

- **Lane composition.** `shipStep({forgeFor, pollMs, spawnRepair})` supplies
  the two stages after the verdict: `ship` and `close-out`. It plugs into
  `postFreeze({afterVerdict})` and `repairLane({afterVerdict})` unchanged; a
  mode flag derived from the launch payload (`card` present = story) selects
  the differences (card sweep, test-edit boundary, re-freeze stamps).
  `lanes/assemble.mjs` builds the whole graph — story as
  `storyLane → postFreeze → shipStep`, repair as `repairLane → shipStep` —
  and the daemon binary registers it on the engine at start.
- **The forge interface.** All forge traffic goes through one injected
  object: `preflight`, `openPr` (idempotent per head branch, and the carrier
  of the request's labels), `applyLabels`,
  `ciSecrets`, `armAutoMerge`, `prState`, `checkRuns`, `workflowRun`,
  `latestCompletedRun`, `rerunFailed`, `checkOutput`. The last of the reads is
  the one no ship stage calls: the workflow watcher outside the lanes uses the
  same interface, because a forge is a forge whoever is asking (ADR-0035).
  `ship/forge.mjs`
  implements it over the `gh` CLI with an injectable runner; tests substitute
  a fake with the same shape. A forge for another host is one new module.
  `prState` is where the host's own words about a request become the states
  the ship loop routes on: open, merged or closed; behind its base; in
  conflict with its base. The gh adapter reads the last one off both answers
  that carry it (`mergeable === 'CONFLICTING'`, `mergeStateStatus === 'DIRTY'`)
  and hands the loop a boolean, so a forge on another host classifies in its
  own vocabulary and the ship step keeps one.
  A check is named after the job behind it, while a workflow run is named
  after its workflow, so `checkOutput` resolves the failed job through the
  commit's check runs — the same read the watcher stamps from — and takes the
  job link found there to the log. That link also names the run, which is why
  `checkRuns` carries `run` on every check and `workflowRun(id)` answers for
  the run's own status. `checkOutput` is total over every forge condition:
  when no log can be read it answers with the reason, because that string is
  the triage input and an absence with no reason reads as a check that told
  nobody anything. It refuses exactly one thing, and by exception rather than
  by reason string — a log asked for before its workflow run finished.
- **A red check is not a finished workflow run.** A check reports one job. A
  job that fails early turns its check terminal and leaves the rest of the run
  executing, and the forge serves that run's logs out of one archive that is
  only whole when the run is over. The watcher therefore reads two states
  before it acts on a red: the check's, and the run's. A red whose run is
  still executing is held — no failed-jobs re-run, which the forge would
  refuse anyway while it holds the jobs, and no triage — and the poll after
  the run ends is where the red is acted on, exactly as a red on a finished
  run always was. The hold stamps `triage-wait` once per head sha and workflow
  run, never once per poll; the CI verdict that ends the wait carries `waited`,
  which is the one moment the span of the wait is known. The bar is the run's
  own report of a `completed` status: a run the forge would not answer for is
  held on the same terms, because a read nobody could make is not a report that
  the run is over. The dispatch takes the same read for itself, immediately
  before the first log it asks for, so the guarantee holds for every route into
  it and not only for the watcher above it. Underneath, the log
  fetch asserts the same fact for itself and throws `PartialLogRefusal` when it
  is reached anyway: the assert is on the read that would produce the wrong
  evidence, so no future caller can reintroduce the defect by taking a
  different route to the log.
- **The forge is per run, not per graph.** The engine registers lanes once at
  daemon start, while one instance holds many projects, each with its own
  repository. `shipStep` therefore takes a resolver, `forgeFor(ctx)`, and the
  ship stages resolve the forge from the run's project on entry, out of the
  live instance config — a forge bound at composition would send every
  project's PRs to one repository. Resolution is the first act of
  `shipBase`, before any clone read, so a project the instance cannot forge
  for fails on the cheapest fact. The gh argv is instance config
  (`ghCommand`, default `['gh']`): by the ownership test it describes the
  machine, like `composeCommand` and `claudeCommand`.
- **Preflight, then label, then arm at open.** Before the PR opens, the
  preflight requires auto-merge allowed and a non-empty required-check set on
  the base branch. Anything less parks `provisioning-gate` — hands-off ship
  without branch protection would merge unverified work. Auto-merge (squash)
  arms at PR open; the `pr-opened` stamp records the pr number, head sha, and
  the required set, so every later judgment derives from the ledger.
- **The request is created carrying its labels.** A project whose check
  requires a label on a request gets that label from the ship step, on the
  create call itself — a required check only a human can answer is a hands-off
  ship with a human in it. The rule is project config: `labels` is a list of
  entries, each one `label` plus the `paths` that require it, in the same path
  vocabulary as `repo` (a plain prefix, or a glob). The harness holds no label
  names of its own, because a label vocabulary is a fact about a project.
  Derivation reads the request's diff against the default branch, from the
  commit the two last shared — the same evidence the project's own check reads,
  so both answer one question from one input, and it runs before the request
  exists so its answer can ride the open. `openPr` takes the labels and answers
  `labelled`; the post-open `applyLabels` call is the fallback for a forge
  whose create cannot carry them and for a create that found the request
  already open. `pr-labeled` stamps at every open either way, the empty set
  included, and `at` names which of the two paths applied them. A label the
  forge refuses is a repository that does not define it: substrate the daemon
  never self-clears, so the request opens bare and the apply path parks
  `provisioning-gate` naming the labels and the forge's own reason. A label no
  rule derives is neither a park nor a guess — it stays a red check, which is
  the one authority that can say a human has to look.
- **The check watcher is a stamping process.** The ship stage polls the
  forge and stamps `check-transition` on every observed state change —
  normalized status per check, `required` flag, duration from the forge's
  own timestamps on terminal states. Pending is a state, never a verdict;
  no wall-clock timeout detects anything; `pollMs` is cadence only. All
  terminal states are covered: per-check, PR merged, PR closed (run fails
  `pr-closed`), merge-commit checks, and green-but-no-merge. Two states of
  the forge are classified before the watcher reads any check, because the
  watcher would read either as a check that has yet to arrive: a request in
  conflict with its base, and a head sha the forge carries no check run of
  any name for. Each stamps `forge-anomaly` — one kind, one head sha, one
  stamp — and takes the route named below.
- **One red regime.** A red required check gets one automatic re-run of the
  failed jobs (`rerun-requested` stamp per check; a green re-run stamps
  `ci-flake`, never a finding). Persistent reds enter the shared four-class
  triage (`triageStep`, layers `ci:<check>`) and render a red verdict with
  `source: 'ci'`; the ship stage then re-enters the verdict stage, whose
  ladder applies the same routes and the same budgets as in-run reds. An
  `operational-fix` stamp grants the next re-run.
- **A flake reading expires at the third flake.** `FLAKE_LIMIT` ci-flakes for
  one check on one head sha reclassify that check deterministic-red:
  `gate-integrity` kind `deterministic-red` (loud, once per pair), no further
  `ci-flake` classification, and no automatic re-run of that check on that sha
  whatever grant stands behind it. The rule is derived from the ledger in
  `src/ledger/cycles.mjs` beside the re-run budget it overrides. What a re-run
  tests is the claim that the red was the substrate and the green is the tree;
  a check that has made that claim three times over a tree which did not move
  between any of them is a check whose answer is about something else, and the
  greens are what is not credible. The pair is the whole key: two head shas on
  one check are two trees, and two checks on one head sha are two questions —
  both stay ordinary flakes. A new head sha therefore starts clean, which is
  what makes the repair route the way out. The record is answered by a human,
  because a later green is one more of the answers it is about and the red
  merge it warns of is the cost rather than the answer.
- **The re-run budget belongs to the run and the finding.** `RERUN_BUDGET` is
  counted against the pair of the run and the failing check's name — across
  head shas, attempts, merge rounds and verdict cycles — and never against the
  head sha alone. A cancelled attempt spends the budget and never refreshes
  it. An exhausted budget takes the escalation the red was headed for anyway:
  the CI triage, its ladder, its own budgets. Only an `operational-fix`
  stamped after everything the finding spent grants the next re-run, because
  that fix is a deliberate act and the re-run is the test of it (ADR-0022).
  The merge-commit re-run counts the same budget over its own stamps, with the
  answered gate as the grant. The constant and the rule that reads it live in
  `src/ledger/cycles.mjs`: a repeated verdict cycle spends the same one
  automatic retry, on the same terms, and two allowances for one flake is the
  shape this budget exists to refuse.
- **Green but no merge.** Required set green and auto-merge disarmed is a
  harness-class red: `gate-integrity` (loud) once per sha, one re-arm
  attempt (`operational-fix`, kind `auto-merge-rearm`), then
  `provisioning-gate`. The merge landing appends the paired `resolved`.
- **A defect the harness recognizes has a name, not a sentence.** A defect of
  the machinery carries a `kind` from `DEFECT_KINDS` in the ledger registry,
  checked at the stamp. The word is assigned where the harness observes the
  defect and never read back out of a seat's sentence about it, because a
  sentence drifts with every run and a count does not.

  `GATE_INTEGRITY_KINDS` are the four the `gate-integrity` record classifies.
  The record is loud and its kind decides who answers it, so every one of them
  owns a rule in the ownership table: `auto-merge` above; `pr-label-missing`,
  stamped once per request that did not carry its labels out of the create,
  whether the apply call rescued it or not, and answered by the merge of that
  request; `triage-log-missing`, stamped once per check on one head sha when
  the forge answers a log with a reason instead of the log, and answered by
  nobody; and `deterministic-red`, the check whose flake reading expired.

  `OBSERVED_DEFECT_KINDS` are the ones a step stamps on the record it was
  already writing about the defect it just met: `layer-log-truncated` on a red
  `layer-result` whose evidence is a bounded tail with no part carrying the
  failure, and `capture-takeback` on both records a candidate capture writes
  for a reverted frozen write (ADR-0017). These classify a record that already
  exists and already has whatever loudness it is owed, so they raise no alert
  and owe no ownership rule: the word is there to be counted, not answered.

  The escapes ledger takes any word in the set on `escape-recorded`, so a
  defect the harness named before the merge is recorded under that name when
  the merge carries it into the product (ADR-0024). The set grows only here,
  in an ADR.
- **Competing merges ride the update path.** A PR behind its base and a PR
  the forge calls conflicting get the same daemon-driven update: fetch, merge
  the default branch into the run branch (never a rebase, never a
  force-push), push, `branch-update` stamp with `fromSha`/`toSha`/`mainSha` —
  later check transitions on `toSha` are the update's re-run linkage. The
  conflicting state stamps `forge-anomaly` (kind `merge-conflicting`) before
  the update runs, and it is a route rather than a wait for a reason the
  watcher cannot see: the forge builds no merge ref for a request in
  conflict, so it starts no pull-request workflow, the head sha carries no
  check that could ever turn green or red, and a watcher holding out for the
  required set holds out for something nobody will send. Re-delivering the
  request changes none of that; taking the base into the branch is what does.
- **Merge round on textual conflicts, once.** A conflicting request meets
  this round by definition, and a competing merge meets it when the two sides
  touched the same lines; the round is the same either way.
  Conflict hunks split by path:
  test-path conflicts go to the suite seat and commit as a re-freeze
  (`suite-committed` phase `re-freeze` + `re-freeze` stamp moving the suite
  sha); the rest goes to a fresh dev seat with a conflict brief (hunk list,
  spec ref, incoming commits). A failed round aborts the merge, stamps
  `merge-round` `resolved: false`, and takes the stall route: `stall`
  (`merge-conflict`), then the run's one fresh pass born on updated main —
  reset to the fetched main head, frozen suite carried forward — where the
  conflict dissolves. A second stall parks `second-stall`.
- **A head with no check at all is a forge state.** On an open request the
  forge does not call conflicting, an empty check-run answer for the current
  head means the sha was never delivered: the required checks are not late,
  they do not exist, and a poll that keeps asking will keep hearing the same
  nothing. The watcher counts the poll outcomes that saw no check
  (`CHECKLESS_POLLS`), then stamps `forge-anomaly` (kind `checkless-sha`,
  with the count) and spends one recovery: an `operational-fix` of kind
  `check-redelivery` and the update path, which is the one push this stage
  owns that leaves the run's work exactly as it stands. A default branch that
  moved hands the forge a new head to build for; one that did not leaves the
  branch where it was, and the `branch-update` stamp says which of the two
  happened. The next bound with that re-delivery already spent parks
  `provisioning-gate`, naming the sha, the request and the required set. An
  answered gate grants the next re-delivery, exactly as it grants the next
  failed-jobs re-run and the next auto-merge re-arm.
- **Push discipline.** Loop pushes carry an explicit lease on the remote
  head the loop just observed (`--force-with-lease=branch:sha`) — a fresh
  pass rewrites the run branch's history, and the lease forces over exactly
  the observed value. All other pushes are plain. The bare
  `--force-with-lease` is banned: with the clone's `refs/heads/*` fetch
  refspec, git derives the lease from the local branch itself and rejects
  every push after the first. A rejected push parks `provisioning-gate`.
- **Red-merge breach.** `merged` stamps with `red: true` when a required
  check is red at the observed merge. Close-out then records the breach:
  open findings of the last red verdict convert to escapes-ledger entries
  (class-mapped categories, detection source `harness-self`, attributed to
  the story), or one entry for the red checks when no findings are open;
  `spawnRepair` launches one repair-lane run per escape (ticket in the
  daemon home, absolute path; the repair lane accepts absolute tickets); the
  `red-merge-breach` stamp (loud) carries the escape seqs and spawned run
  ids. A spawn failure leaves the open escape as the tracking record.
- **Close-out order.** Breach conversion → merge-commit checks to terminal
  (`merge-commit-check` stamps; a red gets one `operational-fix` re-run,
  persistence parks `provisioning-gate`) → card sweep (story lane) → escape
  fix-back (`escape-fixed` when the payload names `escapeSeq`) → close
  `shipped`. The engine archives the ledger at close as before.
- **Card sweep.** The worktree resets to the merge commit; the card-sweep
  seat updates edges, sources, and open decisions on the cards in the
  launched card's directory (one corrective round on out-of-scope changes,
  then the sweep records the miss without un-shipping the run). Card changes
  commit and push straight to the default branch — cards are planning
  artifacts; a rejected push is recorded in the `card-sweep` stamp, never
  retried blindly. An invalidated card parks `card-invalidated` in the
  **instance ledger** (new: `park` joins `INSTANCE_EVENTS`) — it blocks that
  card's launch (the frontier milestone consumes it), never the run that
  shipped.
- **Fetch refspec pinned.** The bare clone's fetch refspec covers the
  default branch only, re-pinned on every `ensureBareClone`. The prior
  `+refs/heads/*:refs/heads/*` refspec with prune deleted the local `run/*`
  branches of every live run at any fetch — fatal once the ship step fetches
  mid-run.

## Why CI reds re-enter the verdict stage instead of a ship-local ladder

The map requires one red regime: CI reds take the same triage classes,
routes, and budgets as in-run reds. Rendering a `source: 'ci'` verdict and
returning to the verdict stage reuses the ladder verbatim — repair rounds,
re-freeze, operational fixes, stall and fresh-pass rules, second-stall —
with zero duplicated policy. The prior-open handoff keeps finding ids stable
across the seam, so an env red that survives its fix still converges on
`provisioning-gate` instead of looping the fix arm.

## Why the labels ride the create call

The forge triggers a request's checks at creation. A label applied a moment
later therefore races them, and the race is not a coin toss: a check that reads
the request as the creation event described it can never see the label, however
long it runs and however many times it is replayed. The cost is not one red
either — the label check goes red, the red is judged, the ship re-runs, and the
next attempt sees the label only because the request has since stopped being
new. Every part of that is avoidable by not creating a state that has to be
corrected: the labels are derived from the same diff before the request exists,
and the create carries them.

The apply call stays, because it answers a different question. A forge on
another host may take no labels at creation, and a create that finds the
request already open — the idempotent case a resumed run relies on — applied
nothing. Both say so with `labelled: false` and take the path that always
existed. The label refusal keeps that path too: on GitHub an undefined label
fails the create outright, so the adapter opens the request bare and lets the
apply call produce the forge's own reason for the park. A park that names the
refusal is worth more than a stage that fails with no request to name.

## Why the re-run budget belongs to the finding and not to the head sha

The budget exists to buy one answer to one question: was that red a flake? The
head sha is not what makes the question new — the finding is. Keyed on the sha,
the budget renews every time anything moves the head, and moving the head is
the cheapest thing in the system: a repair push, a branch update, an empty
commit, a human cancel that manufactures a fresh failed attempt. Each of those
handed the same red check a fresh entitlement, and the ship could re-run itself
in circles over one finding — which it did, past an explicit stop.

A cancel spends the budget rather than earning one for the same reason. A
cancelled attempt is somebody deciding the work should stop; an automatic
re-run is the harness deciding the opposite, on no evidence at all. Reading the
cancel as a red to be re-tried inverts the one instruction in it.

Nothing is lost at exhaustion, because the exhausted path is not a dead end: it
is the triage the red was headed for anyway, with the four classes, the routes
and the ladder budgets that already bound it. The operational fix inside that
ladder is what grants the next re-run, so a substrate repair is still tested by
CI — the grant is now an act somebody took, never a side effect of the head
moving.

## Why the checkless bound counts polls and not minutes

No wall-clock span detects anything here: a stage that has waited twenty
minutes has learned nothing a stage that waited two has not. What the
checkless route acts on is a repeated observation — the forge was asked for
the checks of one sha and answered with none, N times — and that is evidence.
`pollMs` stays cadence, and the bound stays a count of answers.

The count itself lives in the stage entry, not in the ledger: a stamp per
barren poll would fill the ledger with one fact repeated, and the ledger's
job here is to hold the classification and the recovery step spent on it. So
a restart counts again from zero and re-earns the bound. It cannot lose the
park, because both stamps outlive the restart — the second bound still finds
the re-delivery spent and parks on it. The cost of a restart is one more
round of polling, and nothing else.

## Why a forge anomaly is a quiet record

Both kinds have a route that runs without the owner: the conflicting state
dissolves in the update path, and the checkless state spends its one
re-delivery and then parks — and that park is already a queued item whose
question names the anomaly. A loud record would ask for eyes the route does
not need, and it would owe an owning event to answer it. The event exists for
the opposite reason to an alert: no ship stage may sit on a state of the
forge and say nothing about it.

## Why the log fetch throws where everything beside it answers with a reason

Every other absence in `checkOutput` is the forge's business: a check of that
name does not exist, the check did not fail, no workflow job stands behind it,
the host refused the read. The triage seat can act on all four, so each travels
to it as a sentence. A partial log is not one of them. It is well-formed
evidence about the wrong thing, and a seat handed the first half of a run's
output has no way to tell that a half is what it got — it reads the steps that
passed and concludes about the ones it cannot see. A reason string would put
that conclusion one careless caller away, because a caller that ignores the
string gets the string as the log. The exception is also the loud channel: a
throw out of a ship stage is a `liveness-violation`, which is what a defect in
the harness's own reading of a gate should cost.

The watcher's hold and the fetch's assert are deliberately the same fact
checked twice. The hold is the behavior — it keeps the run moving and costs a
poll — and the assert is the guarantee, on the one call that can produce the
wrong answer. Neither is sufficient alone: a hold with no assert is a rule the
next caller does not know about, and an assert with no hold turns an ordinary
CI race into a stopped run.

## Why the dispatch checks the run state a third time

The hold sits in the watcher, one caller above the triage. That is where the
behavior belongs — it is a poll outcome, and holding is what a poll outcome
does — but it leaves the property stated about a caller rather than about the
thing being protected. A property held by whoever calls in is a property the
next caller has to be told about, and the cost of not telling them is the same
gate judged on the same half a log. So the dispatch reads the run states of its
own reds immediately before it asks for the first byte of any log, and holds on
the same terms. In the ordinary path the read is redundant and costs one API
call per triage. That is the price of the rule being about the triage.

The bar moved with it. A run the forge would not answer for used to read as a
run that was over, on the reasoning that a state nobody could read is not a
statement that the run is still going. True, and the wrong question: what the
dispatch needs is not "is it still going" but "did it say it was done". An
unreadable run said nothing, and the log behind it is exactly as partial as the
log of a run that reported `in_progress`. Holding costs a poll, and the poll
asks again — the stage heartbeat says what the stage waits on throughout, and a
stage that waits past its band is already an overrun the watcher reports
(ADR-0034).

## Why a log the forge will not serve is a counted defect

The fetch is total: every absence it cannot fill comes back as a sentence, and
that sentence is genuinely useful to the triage seat — a red check told why its
log is missing judges better than one told nothing. What it was not is
countable. Two triages in one window ran on `(no failure log ...)` while the
logs were retrievable, and nothing in any ledger said so, because a sentence
that varies with the reason reads as two unrelated events. The gate judged a
red on the absence of the evidence for it, twice, invisibly.

So the reason still travels to the seat, unchanged, and the absence is stamped
under `triage-log-missing` beside it. Loud, because a gate that judged without
its evidence is a gate-integrity defect and those are zero-tolerance here.
Owned by nobody, because nothing in a ledger brings back a log the forge did
not serve: no route repairs it, no later stamp is evidence about it, and the
only reader who can decide what the missing evidence cost is the human the
record was raised for.

## Why the label defect is counted where its fix already landed

The labels ride the create call now, which is the fix; a request that opens
carrying them stamps nothing. `pr-label-missing` is not that defect being
tolerated again — it is the instrument that says whether the fix is holding.
The condition is narrow and unambiguous: the create did not carry the labels,
so the request existed bare for the one moment that decides a label check. On a
forge whose create takes no labels that condition is permanent and the record
says so every ship, which is correct — that forge has the race the fix removed
here, and the operator should be able to read it as a number rather than infer
it from a check that goes red sometimes.

The merge of the request answers it. The record reports a window that has
closed and cannot reopen; what it costs is a label check judging a bare
request, and the request landing is the evidence it cost nothing this time. The
count stays in the ledger, which is the whole point of a kind.

## Why two of the kinds are stamped where nobody is asked to read them

The first four kinds all classify a `gate-integrity` record, and that record is
a claim on the owner's attention. It was tempting to keep the shape: give every
recurring defect its word by giving it a loud record. Two classes make that the
wrong move.

Both were already recorded. A red layer whose evidence is a bounded tail
already writes a `layer-result`; a capture that reverts a frozen write already
writes a take-back record. Neither defect was invisible — what was missing was
the word, and a second record for the same fact would have bought the count at
the price of an alert per occurrence.

Both were already answered. A window of five ships met the truncated-evidence
class five times across three runs under two fingerprints, and the stale
screenshot take-backs in four runs of five. Every one of those cost the owner a
gate touch, and standing acknowledgments now hold the classes. A loud record
per occurrence would have re-raised, once per cycle, exactly what the owner had
already answered.

So the word goes on the record the step was writing anyway. The class is
counted from the moment it recurs, no alert strip grows, and the acknowledgment
machinery is untouched, because a kind is a fact about a defect and never a
question about it. The two sets are separate in the registry for the one thing
that follows from the difference: a kind that reaches a loud record owes an
ownership rule, and a kind that classifies a record already owned does not.

## Why the wait is one quiet stamp and not a heartbeat

The stage heartbeat already says the ship stage is alive and what it waits on
(ADR-0034), so the wait needs no liveness telemetry of its own. What it needs
is an account of a decision: the ledger says a required check went red, and the
next thing the ledger would otherwise say is a triage that happened minutes
later for no recorded reason. One stamp closes that gap and stays out of the
way — quiet, because holding a red for the run behind it is ordinary work with
a route already running, and once per wait, because a stamp per poll would bury
the run's own events to say one thing repeatedly.

## Why the breach conversion lives in close-out

Ship stamps `merged` with the red flag and hands over; close-out converts.
A crash between the two stamps then resumes into close-out, which re-derives
the breach from `merged.red` and the escapes ledger (entries keyed by
`refs.runId` are reused, never doubled). Putting conversion before the
`merged` stamp would lose the breach on the same crash.

## Why the sweep pushes straight to the default branch

Cards are planning artifacts, not gated product code; the frontier reads
them from `main` at launch, so sweep results must land there to take effect.
Routing card edits through a PR would recurse the ship machinery over
non-code content. The push is honest about failure: a protected or raced
push lands in the `card-sweep` stamp and the report artifact survives in the
run archive.

## gh CLI verification items

The adapter is built against documented `gh` behavior; these want a live
check at cutover, like the claude CLI items in ADR-0005:

- `gh pr create` exit behavior when an open PR for the branch exists (the
  adapter tolerates failure and re-views by branch).
- `pr view --json autoMergeRequest` as the armed signal,
  `mergeStateStatus === 'BEHIND'` as the behind signal, and
  `mergeable === 'CONFLICTING'` with `mergeStateStatus === 'DIRTY'` as the
  conflicting signal on the chosen plan.
- `repos/{repo}/branches/{base}/protection/required_status_checks` shape for
  rulesets vs classic protection (rulesets may need a different endpoint).
- `gh run rerun --failed` coverage when a commit has several workflow runs.
- `gh pr edit --add-label` exit behavior on a label the repository does not
  define (the adapter reads the refusal as a reason and parks on it).
- `gh pr create --label` on a label the repository does not define: the
  adapter assumes the create opens nothing at all and retries it bare, so that
  the refusal is read by the apply call that has a request to park about.
- `repos/{repo}/actions/secrets` scope requirements for the daemon's token
  (an unreadable list must read as unproven, never as absent).
- Auto-merge surviving a leased force-push of the head branch.

## Fallback paths

If the observed-lease push still races (remote moved between observe and
push), the push rejection parks `provisioning-gate` — safe but noisy.
Trigger: repeated push parks on the same run. Fix: re-derive `expected` from
a fresh `prState` inside the retry; cost low, one call.

If the checkless bound proves too tight — a forge that routinely takes longer
than `CHECKLESS_POLLS` cadences to create the first check run of a sha — the
constant rises, or it becomes instance config beside `ghCommand`, which is
where the ownership test puts a fact about the host. Trigger: `forge-anomaly`
stamps of kind `checkless-sha` on shas whose checks then arrive by
themselves. Reversal cost: low — one constant, and the route under it does
not change.

If waiting for the whole workflow run proves too slow — a run whose remaining
jobs take far longer than the job that failed, on a repository where the two
share no logs worth reading together — the wait narrows from the run to the
job: `workflowRun` gives way to a per-job state read, and the fetch asks for
one job's log rather than a slice of the run's archive. Trigger: `triage-wait`
stamps whose `waited` on the CI verdict is a large part of the ship stage.
Reversal cost: low — one forge method and the predicate in `runsNotDone`; the
stamp, the hold and the assert all stay where they are.

If `FLAKE_LIMIT` proves too tight — a repository whose CI genuinely flaps
three times on one head sha and is green on the merits — the constant rises,
or the classification stops the re-runs and leaves the check's own state
alone, which is the record without the withdrawal. Trigger:
`deterministic-red` records on shas whose check then merges green with no
repair behind it. Reversal cost: low — one constant in `src/ledger/cycles.mjs`
and one predicate in the re-run filter; the record, the stamp site and the
routes under them do not change.

A forge with no workflow concept is untouched by the hold: its checks name no
run, so there is nothing to read and nothing to wait for. The hold bites only
where a check names a run and that run's state cannot be read, and there it
holds. If that proves to cost real time — a host whose run endpoint fails often
enough that ships wait on nothing — the predicate takes a bounded number of
unreadable answers before it treats the run as done, which is the old posture
with a ceiling on it. Trigger: `triage-wait` stamps carrying
`status: 'unreadable'` that clear on a later poll with no other change.
Reversal cost: low — one counter in `runsNotDone`, and the dispatch's own read
already takes the same predicate.

If a kind stamped on the record of the step that met the defect proves too
quiet — a class that recurs for a whole window and nobody reads the count until
the eval review does — it graduates to `GATE_INTEGRITY_KINDS` with a rule of
its own, stamped once per run rather than once per occurrence. Trigger: a class
whose count grows across a window and whose first reader is the review.
Reversal cost: low; the word and the sites that assign it stay, and what is
added is one stamp and one ownership rule.

If `layer-log-truncated` proves to fire on reds whose tail did hold the
failure — a runner that prints its failures last, so the bound cuts only green
noise — the condition narrows from "the stream outgrew the bound" to a read of
what the kept tail contains, or the layer opts out in project config the way
the parts protocol is opted into. Trigger: records of the kind whose triage
found the failure in the tail anyway. Reversal cost: low, one predicate at one
stamp site. **Taken, for the other reason** (ADR-0043): every command now
streams its whole output to a file, so the tail is no longer all the harness
holds. The condition is now "no part carries the failure and no file holds the
stream" — one predicate at the same stamp site, and the word still means output
the harness cannot produce.

If the dispatch's own read proves redundant in practice — no route into the
triage ever arrives without the watcher's hold behind it — it is one call per
triage to keep, and keeping it is what makes the property belong to the
dispatch. Removing it returns the guarantee to the fetch's assert, which stops
the run instead of holding it.

If direct card pushes prove unlandable (org-wide protection on the default
branch), route the sweep through a `cards/<runId>` branch with its own
armed auto-merge. Trigger: `card-sweep` stamps with `pushed: false` on
protection errors. Reversal cost: moderate — one more watcher pass at
close-out.

If label derivation from paths proves too coarse — a label a project decides
on the content of a diff rather than on where it lands — the rule gains a
second key beside `paths` and the derivation reads both. Trigger: one label
whose path rule fires on requests that do not need it. Reversal cost: low, one
config key and one predicate; a project that names no such rule is unaffected.
Removing the `labels` list entirely returns the ship step to opening
unlabelled requests, which is what it did before this decision.

If creation-time labels prove unusable on a host — a create that refuses the
whole request for a reason the labels only hint at, or a forge that applies
them silently wrong — `openPr` answers `labelled: false` for every call and
the apply path carries the labels again, which is what it did before this
decision. Trigger: `pr-labeled` stamps with `at: 'create'` on requests the
label check then judges bare. Reversal cost: low — one flag out of one forge
method; the ship step already runs both paths.

If the per-finding re-run budget proves too tight — a project whose CI is
flaky enough that one automatic re-run per finding per run leaves real work
parked on infrastructure — `RERUN_BUDGET` rises, or it becomes project config
beside the gate definitions. Trigger: CI verdicts whose triage classes the
same check `env` repeatedly inside one run. Reversal cost: low — one constant;
the key stays the pair, because the pair is what made the count mean anything.

If a defect kind proves noisy rather than countable — `pr-label-missing`
stamping every ship on a forge whose create genuinely cannot carry labels, or
`triage-log-missing` stamping for a class of absence nobody would act on — the
kind narrows at its stamp site rather than leaving the set: a vocabulary that
loses words stops being comparable across windows. Trigger: one kind
dominating the loud strip with records that resolve to the same known cause.
Reversal cost: low — one predicate at one call site; the word, the tests and
the ownership rule stay.

If a kind wants to be quiet rather than loud, that is a move out of
`gate-integrity` and not a flag on it: every record of that event is loud by
the decision this ADR records, and a quiet gate-integrity record would say the
gate failed and ask nobody to look.

If a forge for a non-GitHub host is needed, the interface in `ship/forge.mjs`
is the contract; the ship step never imports the gh adapter directly. A forge
whose check output cannot be told apart from its reasons breaks
`triage-log-missing` and nothing else: `noLogReason` is the one reader of that
shape, and it lives beside the one writer of it.

If per-run forge resolution proves too costly (a forge that must authenticate
or cache per repository), the resolver memoizes per project inside
`lanes/assemble.mjs` and drops the cached entry on a config change. Trigger:
measurable ship-stage latency in the forge calls, or a forge implementation
that holds a session. Reversal cost: low — the resolver signature does not
change, and the lanes stay assembled once.
