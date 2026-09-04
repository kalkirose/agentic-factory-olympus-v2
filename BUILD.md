# Build order

This file is the tracker across build sessions. The locked design spec lives
outside this repo; [docs/architecture.md](docs/architecture.md) restates it
generically. Work the milestones in order — each one depends on the ones
above it. Update the status line and the session log in the same commit as
the work.

Status: `open` · `in progress` · `done`

## M0 — Foundation — done

Repo scaffold: README, doctrine, architecture, ADR-0001 (runtime), package
manifest, CI (`node --check` + `node:test`), gitignore.
Done when: CI is green on a trivial test.

## M1 — Daemon core + instance config — done

- Ledger envelope primitive: append-only JSONL writer/reader, per-ledger
  monotonic `seq`, crash-safe open (truncated-tail repair).
- Instance config: schema, validation, defaults; loaded from the daemon home;
  live edit pickup with a `config-changed` stamp; invalid edit keeps the old
  config.
- Daemon lifecycle: `olympusd start|run|stop|status` (`start` detaches from
  the calling console, `run` stays in the foreground for a service manager);
  single-instance lock with pid liveness; `daemon-started` (runs resumed) /
  `daemon-stopped` stamps; clean shutdown on stop command and on signals.
- Control channel skeleton: file inbox in the daemon home; parse, validate,
  dispatch interface; concrete commands land with their milestones.
- Service-manager wiring docs: systemd unit + Windows service examples.

Done when: the daemon starts from an empty daemon home, scaffolds the stores,
stamps lifecycle events, survives a hard kill + restart with consistent seq,
picks up config edits, and the tests cover lock, resume, and config paths.

## M2 — Telemetry stores — done

- Closed event registries (run + instance) as code; unknown event = error.
- Stream classing; queued/loud stream index appends (pointer + gist).
- Escapes ledger: schema, two-event lifecycle (`escape-recorded` /
  `escape-fixed`), category and detection-source vocabularies.
- Paired `resolved` appends for loud items and breaches; derivable open set.
- Per-run ledger layout; archive-with-run at close.
- Reader API: tail, filter by event, open-loud query, escapes-window math.

Done when: every registry event round-trips writer → reader, stream-classed
events index correctly, and the open-set queries answer from files alone.

## M3 — Run engine — done

- Run state machine: stages as internal states; transitions stamped;
  `run-launched` / `stage-entered` / `run-closed` on every terminal state.
- Child supervision: spawn, exit-event transitions, seat-failure path,
  per-seat cost ceiling as guardrail.
- Resume: daemon restart resumes every open run at its recorded stamp.
- Liveness invariant checker (event-keyed): every open run holds an in-flight
  child, a parked escalation, or a transition in progress; violation = loud.
- Park / answer / resume: escalation records, slot freeing, answer validation
  with who/when stamps.
- Slot accounting per project; lane-agnostic.

Done when: a scripted dummy run walks all stages, survives daemon restart
mid-stage, parks and resumes on an answer, and a provoked violation lands
loud.

## M4 — Project config + run isolation — done

- Project config: schema (repo facts, commands, gates, conventions, lane
  specifics, tripwire registry section), read from `main` in the bare clone
  at run launch.
- Bare clone management per project; fetch discipline.
- Run worktrees: create at launch, absolute path to seats, remove at close;
  disposable worktrees for adversary waves.
- Run stacks: per-run compose project named by run id, from the project's
  compose template; env derivation, no fixed host ports; teardown at close.

Done when: a run launch on a fixture repo yields a clean worktree + stack,
and close removes both; config changes on `main` apply at the next launch.

## M5 — Seat runtime — done

- Headless seat child runner over the `claude` CLI; two-block prompt assembly
  (shared core + per-seat role block).
- Seat map: model + effort per seat; named exceptions; model-switch flags off;
  actual model recorded from the transcript; substitute-model events.
- File contracts: JSON report to a named ledger path; deterministic
  validation (flat draft-07-safe schemas); one corrective re-prompt, then
  seat-failure.
- Global model semaphores; `semaphore-wait` / `semaphore-granted` stamps.
- Web-tool policy per seat; Explore-subagent allowance (dev seats, cap 2).

Done when: a fixture seat completes the contract loop end to end, a broken
report triggers exactly one re-prompt then seat-failure, and semaphore waits
stamp correctly under contention.

## M6 — Story-lane pre-freeze chain — done

- Readiness process (mechanical checks; self-park at spec-birth escalation).
- Spec-birth seat (grounded authoring from the intent card; AFK; two
  escalation cases).
- Spec gate: one fresh-context round, amended-sections re-check, no round
  cap; intent conflict escalates.
- Suite-authoring seat; test-edit boundary enforcement (deny dev-seat test
  edits at the tool level).
- Adversary: 3 waves in disposable worktrees, all to verdict; survivor
  amendment round (killing tests); dispositions; 0/3 routes.
- Red-state check with reason classification (feature-absence only).
- Freeze process + freeze record as completion signal.

Done when: a fixture story reaches a valid freeze record with kill count and
dispositions, and every escalation case parks correctly.

## M7 — Verdict, repair, review — done

- Tier-1 full-spectrum runner (processes; not-runnable attribution).
- Flake filter (one red-only re-run; flake events).
- Verdict triage seat (four classes, cited evidence; gate-integrity lines).
- Response ladder: repair rounds (progress rule, cap 3), stall detection,
  fresh pass (one, stall brief), re-freeze step, operational fixes; budgets
  meter implementation attempts only.
- Fury round: five seats / six lenses, conditional interface seat, per-lens
  reporting; verifier confirm-to-block; no re-fan-out over judged trees.
- Generalist review seat; repair-lane variant wiring.

Done when: seeded defect fixtures route down each ladder arm correctly and
the verdict record carries the full spectrum + confirmed findings only.

## M8 — Ship step — done

- PR open + arm auto-merge (squash); branch-protection preflight.
- Check watcher process: every state transition stamped, per-check durations,
  all terminal states, merge-commit checks, "green but no merge" detection.
- CI red route: one failed-jobs re-run, then shared four-class triage.
- Competing-merge branch update (merge main in, re-run linkage stamps).
- Merge round on textual conflicts (conflict brief; test hunks → suite seat).
- Red-merge breach: detection, loud event, escapes conversion, repair-lane
  spawn.
- Close-out: merge-commit checks to terminal, card sweep seat, ledger close +
  archive.

Done when: a fixture PR ships green hands-off; a forced red-merge and a
competing merge both produce the specified stamps and routes.

## M9 — Frontier, escalation queue, console — done

- Graph frontier from the project repo's intent cards: edges, roadmap order,
  phase gate.
- Frontier auto-launch: slot filling in roadmap order; arming state machine
  (`arming-changed`); factory-starvation event.
- Escalation queue: FIFO + roadmap tiebreak, answerable-from-record, batch
  answers.
- Console skill: status render (loud first, then queue), pause / kill /
  launch / answer commands, live instance-config edit.

Done when: a multi-card fixture launches in order under the slot cap, parks
free slots, answers resume runs, and starvation lands loud.

## M10 — Tripwire watcher — done

- Registry parsing from project config; standing metrics implemented
  (escapes rolling-10, per-lens yield, kill-rate band, CI p50 warm-cache,
  frontier width).
- Event-keyed evaluation; breach open-once / resolve / re-arm lifecycle.
- Baseline proposals stamped at the 5th freeze and 5th verdict (queued).

Done when: fixture ledgers trip each standing metric exactly once per breach
condition and re-arm only after resolution.

## M11 — Command center — done

- Read-only GET server: daemon-home rooted, path-guarded, dependency-free.
- Page per the accepted layout: status chips, loud strip, run cards,
  escalations, build health, run-time stats, ledger tail; 60 s poll +
  manual refresh.

Done when: the page renders live fixture state end to end over the server.

## M12 — Eval seat — done

- Every-5-ships trigger; instance-scoped job (no worktree, no stack).
- Ledger window since last review; report artifact + `eval-review` event.
- Proposal shapes: cut candidates, new tripwires, band changes, vocabulary
  promotions, duration-drift flags. Proposals only.

Done when: a fixture ledger set produces a valid report + queued event, and
no proposal self-executes.

## Out of scope here

Project onboarding (config seeding, CI cache changes, per-PR service
provisioning in a project's own infra) belongs to that project's cutover
effort, private side. The harness ships the config schemas and hooks; it
never carries a project's specifics.

## Session log

- 2026-08-09 — Repo initialized. Build order derived from the locked spec.
  M0 done. M1 done: ledger envelope + closed registries, instance config with
  live edit pickup, daemon lifecycle (lock, lifecycle stamps, control inbox,
  CLI), service-wiring docs. Verified by 25 tests plus a manual hard-kill +
  restart with consistent seq. Next: M2 (telemetry stores).
- 2026-08-10 — M2 done: telemetry stores over the ledger primitive. Stream
  indexes (pointer + gist, appended in the same call as the source event),
  escapes ledger with the two-event lifecycle and both vocabularies, paired
  `resolved` appends with writer-side checks, run archive after `run-closed`,
  reader API (filter, open-loud, open-breaches, ships, escapes-window math).
  ADR-0002 records the shapes. 46 tests green. Next: M3 (run engine).
- 2026-08-10 — M3 done: run engine. Lanes as stage lists + handlers with a
  one-directive contract (next / park / close); child supervision over stdout
  progress lines with the cost ceiling as guardrail; restart resume from the
  ledger alone (`resumed` stamps, parked and violated runs wait); event-keyed
  liveness invariant at the handler settle, violations loud and never
  auto-killed; park/answer/resume with option validation and who/when stamps;
  per-project lane-agnostic slot accounting that gates launch only. Control
  inbox gained `answer` and `kill`. ADR-0003 records the shapes. 60 tests
  green. Next: M4 (project config + run isolation).
- 2026-08-10 — M4 done: project config schema v1 (commands as the single argv
  home, gates reference commands, tripwire section shape-checked), read from
  the default branch in the bare clone at every launch; fetch with prune
  first — a failed fetch or an invalid config refuses the launch before any
  worktree exists. Run worktrees off the bare clone (`worktrees/<id>/tree` on
  branch `run/<id>`, disposables detached at a sha), per-run compose stacks
  (`oly-<id>`, derived env, teardown by name alone), workspace record as a
  run artifact, teardown at close via the engine `onClosed` hook with a
  `workspace-released` stamp, orphan sweep at daemon start. ADR-0004 records
  the shapes. 88 tests green. Next: M5 (seat runtime).
- 2026-08-10 — M5 done: seat runtime under `src/seats/`. Seat map as a closed
  registry (Opus 5 xhigh default; verdict triage, Fury verifier, eval on
  Fable 5; web + Explore allowances per policy); file contracts with an owned
  flat draft-07-safe validator, one corrective re-prompt (session resume when
  the transcript names a session id) then seat-failure; global per-model
  semaphores with `semaphore-wait`/`semaphore-granted` pairing and live-edit
  pickup; claude CLI adapter (argv builder, no fallback flags; stream-json →
  progress + actual model) with `model-substituted` (new registry event) and
  model-mismatch as seat-failure; `ctx.runSeat` dispatch keeps the liveness
  invariant seeing the child. ADR-0005 records the shapes and names the CLI
  verification items. 117 tests green. Next: M6 (story-lane pre-freeze
  chain).
- 2026-08-10 — M6 done: story-lane pre-freeze chain under `src/lanes/`.
  `storyLane({afterFreeze})` composes readiness → spec birth → spec gate →
  suite → adversary → freeze; every handler re-derives its position from
  ledger + git (restart-safe). Readiness parses the intent card (frontmatter
  + open-decisions section) and runs the reference lint. Born spec is a run
  artifact at `runs/<id>/spec.md`. Spec gate: as many rounds as it converges
  for, amended-sections re-check, intent conflict parks without burning a
  round, a stall parks and an abandon closes failed. Suite seat under a
  lane-level contract loop (one corrective on boundary/red-class/coverage
  defects, then seat-failure);
  commits stamped `suite-committed` (new registry event; phases author /
  amendment / strengthening / fix). Adversary: 3 waves in disposable
  worktrees at the suite sha, test paths restored from the sha before every
  evaluation (tamper structurally void), survivor amendment with killing
  tests + dispositions, 0/3 → strengthen then `second-zero-kill` park,
  unkilled gaps park with accept/fail options. Red-state check with one fix
  round; freeze record (sha, file set, kill counts, dispositions, red
  state) as the completion signal. Test-edit boundary: deny rules over
  test paths ride the claude argv (`denyTools`). Command runner scrubs
  `NODE_TEST_CONTEXT` (inherited context turns a red `node --test` child
  into a false green). ADR-0006 records the shapes. 136 tests green. Next:
  M7 (verdict, repair, review).
- 2026-08-10 — M7 done: verdict, repair, review. `postFreeze({afterVerdict})`
  adds implementation → verdict to the story lane; `repairLane` wires the
  variant (ticket = spec, generalist review, test edits free). Full-spectrum
  runner with not-runnable attribution through the needs chain; flake filter
  (one red-only re-run, `flake` stamps). Verdict triage on persistent reds
  only (four classes + suite-defect depth, prior findings handed in, coverage
  checks on the contract loop); harness findings stamp `gate-integrity` loud
  with paired resolution. Fury round: five parallel seats / six lenses,
  interface conditional on UI diffs, verifier confirm-to-block; repair cycles
  get generalist review + resolution-check, never a re-fan-out. Response
  ladder: batched routes per red verdict — repair rounds (size-based progress
  rule, cap 3), re-freeze (spec-deep amends the born spec; intent parks),
  operational fix then `provisioning-gate`, one fresh pass off a hard reset
  to the freeze sha, `second-stall` park with granted-extension options.
  Verdict records carry the full spectrum + confirmed findings only. Engine
  tracks in-flight seats as a set (parallel fan-out under liveness/kill/
  stop); new registry events `implementation-committed`, `verdict-rendered`.
  ADR-0007 records the shapes. 152 tests green. Next: M8 (ship step).
- 2026-08-10 — M8 done: ship step. `shipStep({forge})` supplies `ship` +
  `close-out` behind the verdict; all forge traffic goes through one
  injected interface (`src/ship/forge.mjs` implements it over the gh CLI,
  argv-tested; live verification items named in the ADR). Preflight parks
  `provisioning-gate` without protection + auto-merge; auto-merge (squash)
  arms at PR open; the check watcher stamps every observed transition with
  forge-side durations, final states stamped at merge observation too.
  CI reds: one failed-jobs re-run (`ci-flake` on green), then the shared
  `triageStep` renders a `source: 'ci'` red verdict and the run re-enters
  the verdict stage — same ladder, same budgets. Competing merges: daemon
  merges main in, plain push, `branch-update` linkage; textual conflicts
  get one merge round (test hunks → suite seat as a re-freeze; failed round
  → stall → the one fresh pass born on updated main). Green-but-no-merge:
  loud `gate-integrity`, one re-arm, resolved at merge. Red-merge breach:
  `merged {red}` → close-out converts open findings to escapes
  (`harness-self`, story-attributed), spawns repair runs via the injected
  spawner, stamps the loud breach; repair-lane close-out stamps
  `escape-fixed`. Card sweep resets to the merge commit, edits cards only,
  pushes straight to the default branch, and parks invalidated cards in the
  instance ledger (`park` joins `INSTANCE_EVENTS`) — the card blocks, never
  the shipped run. Two latent hazards fixed: the bare-clone fetch refspec
  pins to the default branch (wide refspec + prune deleted live `run/*`
  branches), and bare `--force-with-lease` is banned (the clone shape makes
  git self-lease; loop pushes carry an explicit observed-head lease).
  ADR-0008 records the shapes. 166 tests green. Next: M9 (frontier,
  escalation queue, console).
- 2026-08-10 — M9 done: frontier, escalation queue, console. Project config
  gains a `graph` section (cardsDir + ordered phases; a later phase names
  the card whose ship opens it); cards gain a `phase` field. Frontier under
  `src/frontier/`: roadmap order derived per sweep (topological,
  unlock-count tiebreak — hubs early, phase index first, key last), card
  states shipped/open/spent/parked/blocked/gated/launchable/defect; spent
  (failed/killed) never auto-relaunches. Auto-launch: per-project arming
  state machine (disarmed at birth, `arming-changed` on transitions,
  ledger-replayed), event-keyed sweeps serialized per project (start, arm,
  close, park via new engine `onParked` hook, config change, console
  commands), `factory-starvation` loud open-once with daemon-side
  resolution — only the last queued sweep judges, so mid-chain seams stamp
  no false episode. New clone lock (`RunIsolation.withClone`) serializes
  provision, release, and graph reads on a project's bare clone — the
  launcher made teardown-vs-provision git races routine. Escalation queue
  reader joins open queued items with full records (FIFO + roadmap
  tiebreak); `answer` joins `INSTANCE_EVENTS` — instance parks answer by
  seq, unblocking the card; `resolve` command routes to open runs (liveness
  recovery re-enters the stage), closed-run ledgers, or the instance
  ledger. Console: `olympusctl` (status loud-first, queue, frontier
  no-fetch, answer, arm, pause, launch, kill, resolve) plus the
  `olympus-console` skill; control writes shared via `control.mjs`.
  ADR-0009 records the shapes. 184 tests green. Next: M10 (tripwire
  watcher).
- 2026-08-10 — M10 done: tripwire watcher under `src/tripwires/`. The metric
  set is closed as code (registry.mjs: unit, default window, default
  triggers, required params); project-config validation imports it — unknown
  metric, bad breach op, unknown trigger event, or a missing answer refuses
  the launch. Standing metrics: escapes-window (per-project ships, central
  recency-based count), kill-rate (kills over initial waves across the
  freeze window), fury-lens-yield (confirmed findings per lens over the
  runs holding the last N verdicts), ci-critical-path (median of the longest
  green check per merge, minutes), frontier-width (`computeFrontier` gains
  `width`: possible-not-forced parallelism, `minUnshipped` guard). Event key
  by construction: `TelemetryStore` gains an `onAppend` hook — engine run
  stores bind it to the run's project, `ctx.onAppend` covers handler-opened
  stores (escapes in the ship step), the instance store keys by the line's
  project. Watcher chains per project; registry handed over at launch, lazy
  no-fetch clone read between launches; breach open-once / paired resolved /
  re-arm at the next matching append (an honest pinch stands until state
  changes). Baseline proposals at the 5th freeze and 5th verdict
  (`baseline-proposal` joins the instance registry, queued + resolvable),
  once per project and metric; the kill-rate proposal suggests the observed
  floor. `standingTripwires()` ships the three design-given entries.
  ADR-0010 records the shapes. 202 tests green. Next: M11 (command center).
- 2026-08-10 — M11 done: command center under `src/center/` + the
  `olympus-center` bin. Read-only GET server (node:http, dependency-free):
  `/` page, `/snapshot.json` derived view, `/state/...` raw store files with
  JSON directory listings — path-guarded through symlinks, 405 on every
  non-GET, no-store. `buildSnapshot` assembles the whole display through the
  existing pull-only readers (run replay, open-loud/queue joins, escapes
  window, kill-rate + lens-yield collectors, frontier compute), so the page
  holds formatting only; clone-backed sections (registry board, frontier)
  read the clone no-fetch and degrade to null before the first launch. Page
  per the accepted layout: chips, loud strip, run cards with stage pipeline,
  escalations, build health, run-time stats, ledger tail; 60 s poll +
  manual refresh as display cadence only; all ledger text lands via
  textContent. Negative ts pairs read as no duration. ADR-0011 records the
  shapes. 206 tests green; page verified rendering a seeded fixture home
  end to end in the browser. Next: M12 (eval seat).
- 2026-08-10 — M12 done: eval seat under `src/eval/`. Scheduler keyed on
  story-lane ship closes (daemon `onClosed`) plus one check at daemon start;
  owed when total ships minus the last review's `shipCount` reaches 5; a
  backlog lands in one review. Instance-scoped job through the standard
  runner against the instance store (Fable semaphore, corrective loop,
  model integrity all apply); cwd = daemon home; stop terminates the seat
  and drains. Report contract closes the five proposal shapes
  (cut-candidate, new-tripwire, band-change, vocabulary-promotion,
  duration-drift), artifact at `eval/review-<n>.json` (stale file removed
  before dispatch); `eval-review` stamps only after the report validates,
  joins the resolvable set. Failed seat = trigger stays owed, next event
  retries the whole window. No code path reads a proposal. ADR-0012 records
  the shapes. 214 tests green. All milestones done — next effort: cutover
  (private side, out of scope here).
- 2026-08-11 — shakedown defect: a configured command whose tool exists only
  as a Windows shim could not run. `spawn` without a shell cannot execute a
  `.cmd`, and Node does no PATHEXT lookup, so a bare `pnpm` threw
  `spawn pnpm ENOENT` and every Tier-1 gate layer failed on a host without
  `pnpm.exe`. One resolver (`src/engine/executable.mjs`) now stands between
  config and every spawn of a configured argv: project commands
  (`lanes/exec.mjs`, and the forge through it), seat commands
  (`engine/supervise.mjs`, so `claudeCommand`), and the compose command
  (`isolation/stacks.mjs`). Real executables win over shims across the whole
  PATH; a shim runs under `cmd.exe /d /s /c` with a command line the resolver
  escapes for both parses, never `shell: true`; arguments carrying a newline
  or NUL are refused instead of truncated. Off Windows nothing changes.
  ADR-0013 records the rule. 257 tests green; CI covers the search rule, the
  escaping, and the pass-through, and Windows-only tests cover the real spawn.
- 2026-08-11 — shakedown defect: a seat died in under three seconds with
  nothing in the ledger but `reason: exit, code: 1, cost: 0`, and the run
  closed failed. The ledger held no evidence, so the cause took a hand-run of
  the CLI to find. Three changes, one theme — a seat that dies must say why,
  and one seat must not take a run down.
  First, `--disallowedTools` takes a variadic value list, which consumed the
  trailing prompt: every seat with a tool policy died at argument parsing,
  while the dev seats (no policy, so no flag) ran fine. A boolean flag now
  closes the list, asserted in the seat-map test.
  Second, every `seat-failure` now carries a bounded tail of what the child
  emitted — the last 600 characters of stderr, the last 3 stdout lines
  clipped to 200 each. The defect above reads straight off that tail.
  Third, a seat whose model refuses the work degrades once to the default
  model at the same effort and stamps `model-degraded` (`requested`, `used`,
  `reason`, `resetsAt`), rather than failing the run; `seat-spawned` names
  the model that actually ran. Detection reads two structured stream fields —
  a `rate_limit_event` at status `rejected`, and the synthetic assistant
  message carrying `error: "rate_limit"` — never the exit code, which was
  measured as both 0 and 1 for the same rejection, and never the message
  text. The default model refusing too is a loud failure with the evidence.
  ADR-0005 records all three. 269 tests green.
- 2026-08-13 — shakedown gap: every defect found so far lives after the freeze,
  and each one costs a full re-derivation of spec, suite and adversary waves to
  reach again. A killed run left its branch, its spec and its freeze record
  behind, and nothing could use any of it. A story launch now takes
  `--resume-from <runId>`: it provisions on the frozen commit off that run's
  branch, carries the born spec and the freeze record into the new run
  directory, stamps `freeze-inherited` (never a `freeze` it did not earn), and
  enters at the first post-freeze stage with no pre-freeze seat. A run that
  closes without shipping now keeps its branch — that branch is the only copy
  of what it derived. Refusals are named and land before provisioning: no
  ledger, still open, shipped, no freeze anchor, unreadable record, no born
  spec, no card, wrong project, branch or commit gone from the clone. An
  advanced default branch is merged in and the red-state gate re-runs; an
  advance into the test paths, a merge conflict, or a suite that goes green
  closes the run with the diverged files named. Open findings do not travel —
  they are evidence about a discarded tree — but the stamp names them, and
  escapes never lived in a run ledger. ADR-0014 records the shapes. 282 tests
  green.
- 2026-08-13 — shakedown defect: three runs died to conditions a human could
  have cleared in a minute. A suite seat's second invalid report closed a run
  that held a frozen suite and a full verdict; a triage seat named a persisting
  finding id that was not in the open prior set, and that bookkeeping mismatch
  closed a run after a complete dev pass. The two closes discarded more than
  $150 of sound work. A run now reaches `run-closed` through the ship path, a
  human kill, or a human answering a park with its abandon option, and nothing
  else. Every other failure parks under one of three new types — `seat-failure`,
  `stage-blocked`, `command-error` — each offering `retry` and `abandon`. The
  park carries the close it replaced (`reason` and `detail`), so `abandon`
  fails the run on the original reason; an abandon guard at every stage entry
  applies the answer before the stage spends anything. One answer buys one
  attempt, counted from the answered parks in the ledger the way the spec-gate
  cap counts its rounds, and the failure that follows parks again. Judging
  seats are covered: a triage or verifier seat that fails its own checks parks,
  because a judge is not the run. A structural test asserts the whole closed
  set, so a future close path fails CI until it is added deliberately.
  ADR-0015 records the rule. 294 tests green.
- 2026-08-14 — shakedown defect: Windows process lifecycle. A console kill of a
  run took the daemon with it three times, and the instance ledger showed it
  only as a `launch` followed by a `daemon-started` with no `daemon-stopped`
  between. Measured on the host: a child spawned without `detached` shares its
  parent's console process group, a console control event is delivered to the
  group rather than to the process it names, and a daemon that listens for
  neither SIGBREAK nor SIGHUP dies of the default action with nothing written
  (exit `0xC000013A`). A separate measurement on the same host: `child.kill()`
  is `TerminateProcess` on the one process the handle names, and a Windows seat
  is usually `cmd.exe` running a shim, so the tool and everything it started
  survived the kill and held the run worktree — fourteen orphans from one dead
  run, `git worktree remove` refused twice. A seat now spawns into its own
  process group wherever it can, the daemon listens for SIGBREAK and drops it,
  every deliberate termination is a tree kill, and workspace release ends what
  is standing in the workspace before it removes anything, stamping the count
  and the image names on `workspace-released`. Every exit path stamps
  `daemon-stopped`, down to an `exit` handler and a fault handler that stamps
  and leaves nonzero; a start whose ledger does not end in a clean stop stamps
  `daemon-crash-detected` with the last seq the dead instance wrote. A launch
  the daemon refuses stamps `launch-rejected` with the reason and the run id it
  would have had, so a refusal is no longer a reason file and nothing else.
  ADR-0016 records the measurements and their limits. 319 tests green.
- 2026-09-04 — the harness waits for the world instead of asking about it. One
  wait mechanism (`waiting` / `waiting-ended`, kinds `seat`, `layer`,
  `substrate`, `external`) behind four entry points, with two ladders named
  once: seats wait 5, 15 and 45 minutes past their crash retries, and a layer
  waits 1, 5 and 15. A red whose failed parts all show a signature from a
  closed set and no assertion or compile error is read as a cause outside the
  tree, stamps `layer-transient` and climbs the layer ladder with a narrowed
  re-run at every step, so no seat is spawned for a dropped connection; an env
  finding that survives its operational fix climbs the same ladder with the
  substrate probe in front of every step. A transient red that names a host of
  a declared credential frees its slot and waits on that credential's own
  probe for a day, loudly after an hour, and parks with the history at the end.
  Three project-config keys are new: `credentials[].hosts`, without which a
  credential earns no external wait; `gates.transientPatterns`, which adds a
  project's own runner wording to the closed set; and `gates.proofDebt`, off by
  default, which is what offers `defer-proof` at that park and puts the
  deferred-proof watcher behind the ship. Off Windows every child the harness
  ends as a tree now leads a process group and the kill addresses the group.
  ADR-0069 is new; ADR-0005, ADR-0016, ADR-0022 and ADR-0065 carry the ladders,
  the group and the narrowing as standing fact.
