# ADR-0008: Ship-step shapes

Status: accepted (2026-08-10)
Superseded in part by ADR-0024: a red-merge breach tickets each escape and
enqueues its repair for the frontier sweep. `shipStep` takes `enqueueRepair`
in place of `spawnRepair`, and nothing in the lane graph launches a run.

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
  object: `preflight`, `openPr` (idempotent per head branch), `armAutoMerge`,
  `prState`, `checkRuns`, `rerunFailed`, `checkOutput`. `ship/forge.mjs`
  implements it over the `gh` CLI with an injectable runner; tests substitute
  a fake with the same shape. A forge for another host is one new module.
  A check is named after the job behind it, while a workflow run is named
  after its workflow, so `checkOutput` resolves the failed job through the
  commit's check runs — the same read the watcher stamps from — and takes the
  job link found there to the log. It is total: when no log can be read it
  answers with the reason, because that string is the triage input and an
  absence with no reason reads as a check that told nobody anything.
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
- **Preflight, then arm at open.** Before the PR opens, the preflight
  requires auto-merge allowed and a non-empty required-check set on the base
  branch. Anything less parks `provisioning-gate` — hands-off ship without
  branch protection would merge unverified work. Auto-merge (squash) arms at
  PR open; the `pr-opened` stamp records the pr number, head sha, and the
  required set, so every later judgment derives from the ledger.
- **The check watcher is a stamping process.** The ship stage polls the
  forge and stamps `check-transition` on every observed state change —
  normalized status per check, `required` flag, duration from the forge's
  own timestamps on terminal states. Pending is a state, never a verdict;
  no wall-clock timeout detects anything; `pollMs` is cadence only. All
  terminal states are covered: per-check, PR merged, PR closed (run fails
  `pr-closed`), merge-commit checks, and green-but-no-merge.
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
- **Competing merges ride the update path.** A PR behind its base gets the
  daemon-driven update: fetch, merge the default branch into the run branch
  (never a rebase, never a force-push), push, `branch-update` stamp with
  `fromSha`/`toSha`/`mainSha` — later check transitions on `toSha` are the
  update's re-run linkage.
- **Merge round on textual conflicts, once.** Conflict hunks split by path:
  test-path conflicts go to the suite seat and commit as a re-freeze
  (`suite-committed` phase `re-freeze` + `re-freeze` stamp moving the suite
  sha); the rest goes to a fresh dev seat with a conflict brief (hunk list,
  spec ref, incoming commits). A failed round aborts the merge, stamps
  `merge-round` `resolved: false`, and takes the stall route: `stall`
  (`merge-conflict`), then the run's one fresh pass born on updated main —
  reset to the fetched main head, frozen suite carried forward — where the
  conflict dissolves. A second stall parks `second-stall`.
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
- `pr view --json autoMergeRequest` as the armed signal, and
  `mergeStateStatus === 'BEHIND'` as the behind signal on the chosen plan.
- `repos/{repo}/branches/{base}/protection/required_status_checks` shape for
  rulesets vs classic protection (rulesets may need a different endpoint).
- `gh run rerun --failed` coverage when a commit has several workflow runs.
- Auto-merge surviving a leased force-push of the head branch.

## Fallback paths

If the observed-lease push still races (remote moved between observe and
push), the push rejection parks `provisioning-gate` — safe but noisy.
Trigger: repeated push parks on the same run. Fix: re-derive `expected` from
a fresh `prState` inside the retry; cost low, one call.

If direct card pushes prove unlandable (org-wide protection on the default
branch), route the sweep through a `cards/<runId>` branch with its own
armed auto-merge. Trigger: `card-sweep` stamps with `pushed: false` on
protection errors. Reversal cost: moderate — one more watcher pass at
close-out.

If a forge for a non-GitHub host is needed, the interface in `ship/forge.mjs`
is the contract; the ship step never imports the gh adapter directly.

If per-run forge resolution proves too costly (a forge that must authenticate
or cache per repository), the resolver memoizes per project inside
`lanes/assemble.mjs` and drops the cached entry on a config change. Trigger:
measurable ship-stage latency in the forge calls, or a forge implementation
that holds a session. Reversal cost: low — the resolver signature does not
change, and the lanes stay assembled once.
