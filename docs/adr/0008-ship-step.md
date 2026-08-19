# ADR-0008: Ship-step shapes

Status: accepted (2026-08-10)
Superseded in part by ADR-0024: a red-merge breach tickets each escape and
enqueues its repair for the frontier sweep. `shipStep` takes `enqueueRepair`
in place of `spawnRepair`, and nothing in the lane graph launches a run.
Superseded in part by ADR-0033: `shipStep` supplies three stages — `update`,
`ship`, `close-out`. The branch update runs before the final verdict, so the
verdict certifies the tree that lands, and only the holder of the project's
ship token opens or merges a request.

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
  object: `preflight`, `openPr` (idempotent per head branch), `applyLabels`,
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
  which is the one moment the span of the wait is known. Underneath, the log
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
- **The request arrives carrying its labels.** A project whose check requires
  a label on a request gets that label from the ship step, applied between the
  open and the arm — a required check only a human can answer is a hands-off
  ship with a human in it. The rule is project config: `labels` is a list of
  entries, each one `label` plus the `paths` that require it, in the same path
  vocabulary as `repo` (a plain prefix, or a glob). The harness holds no label
  names of its own, because a label vocabulary is a fact about a project.
  Derivation reads the request's diff against the default branch, from the
  commit the two last shared — the same evidence the project's own check reads,
  so both answer one question from one input. `pr-labeled` stamps at every
  open, the empty set included. A label the forge refuses is a repository that
  does not define it: substrate the daemon never self-clears, so it parks
  `provisioning-gate` naming the labels. A label no rule derives is neither a
  park nor a guess — it stays a red check, which is the one authority that can
  say a human has to look.
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
  `operational-fix` stamp grants the next re-run for the same sha.
- **Green but no merge.** Required set green and auto-merge disarmed is a
  harness-class red: `gate-integrity` (loud) once per sha, one re-arm
  attempt (`operational-fix`, kind `auto-merge-rearm`), then
  `provisioning-gate`. The merge landing appends the paired `resolved`.
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
Reversal cost: low — one forge method and the predicate in `executingRuns`;
the stamp, the hold and the assert all stay where they are.

If a forge answers no run state at all (a host with no workflow concept), the
hold never fires and the fetch never refuses, which is the behavior the ship
step had before this. That is the deliberate posture for an unreadable state
too: an unanswered read is not a statement that a run is executing, and
treating it as one would stop runs over a single refused call.

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

If a forge for a non-GitHub host is needed, the interface in `ship/forge.mjs`
is the contract; the ship step never imports the gh adapter directly.

If per-run forge resolution proves too costly (a forge that must authenticate
or cache per repository), the resolver memoizes per project inside
`lanes/assemble.mjs` and drops the cached entry on a config change. Trigger:
measurable ship-stage latency in the forge calls, or a forge implementation
that holds a session. Reversal cost: low — the resolver signature does not
change, and the lanes stay assembled once.
