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
- Daemon lifecycle: `olympusd start|stop|status`; single-instance lock with
  pid liveness; `daemon-started` (runs resumed) / `daemon-stopped` stamps;
  clean shutdown on stop command and on signals.
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

## M5 — Seat runtime — open

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

## M6 — Story-lane pre-freeze chain — open

- Readiness process (mechanical checks; self-park at spec-birth escalation).
- Spec-birth seat (grounded authoring from the intent card; AFK; two
  escalation cases).
- Spec gate: one fresh-context round, amended-sections re-check, cap 2;
  intent conflict escalates.
- Suite-authoring seat; test-edit boundary enforcement (deny dev-seat test
  edits at the tool level).
- Adversary: 3 waves in disposable worktrees, all to verdict; survivor
  amendment round (killing tests); dispositions; 0/3 routes.
- Red-state check with reason classification (feature-absence only).
- Freeze process + freeze record as completion signal.

Done when: a fixture story reaches a valid freeze record with kill count and
dispositions, and every escalation case parks correctly.

## M7 — Verdict, repair, review — open

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

## M8 — Ship step — open

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

## M9 — Frontier, escalation queue, console — open

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

## M10 — Tripwire watcher — open

- Registry parsing from project config; standing metrics implemented
  (escapes rolling-10, per-lens yield, kill-rate band, CI p50 warm-cache,
  frontier width).
- Event-keyed evaluation; breach open-once / resolve / re-arm lifecycle.
- Baseline proposals stamped at the 5th freeze and 5th verdict (queued).

Done when: fixture ledgers trip each standing metric exactly once per breach
condition and re-arm only after resolution.

## M11 — Command center — open

- Read-only GET server: daemon-home rooted, path-guarded, dependency-free.
- Page per the accepted layout: status chips, loud strip, run cards,
  escalations, build health, run-time stats, ledger tail; 60 s poll +
  manual refresh.

Done when: the page renders live fixture state end to end over the server.

## M12 — Eval seat — open

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
