# ADR-0005: Seat runtime shapes

Status: accepted (2026-08-10)

## Decision

The seat runtime — seat map, file contracts, model semaphores, prompt
assembly, and the headless runner — gets these concrete shapes:

- **Seat map as code.** `src/seats/seatmap.mjs` is a closed registry: seat →
  model, effort, web-tool allowance, Explore-subagent allowance. Default:
  Opus 5 at xhigh, every seat. Named exceptions on Fable 5 at xhigh: verdict
  triage, the Fury verifier, and the eval seat. Web search: spec birth and
  the two dev seats only. Explore subagents: the two dev seats only, cap 2.
  An unknown seat is an error, never a default. A change enters by ADR.
- **File contract.** The runner names the report path in the prompt
  (`runs/<runId>/reports/<name>.json` — a run artifact, archived with the
  run). After the child exits clean, a deterministic process validates the
  file. One corrective re-prompt on failure — into the same session where
  the transcript named a session id — then a `seat-failure` event with
  reason `report-invalid`. A missing file and bad JSON take the same route.
- **Schema subset.** Report schemas are a flat draft-07-safe subset: a
  top-level object of primitive fields, arrays of primitives, arrays of
  flat objects, or one level of flat object; `enum` on primitives; every
  object level states `additionalProperties` explicitly (the draft-07
  default is open — the explicit boolean keeps owned validation identical
  to any draft-07 validator). The runner refuses a schema outside the
  subset before any spawn.
- **Semaphores.** `ModelSemaphores` holds one global counter per model id,
  limits from instance config, across all runs. Stamps go to the acquiring
  seat's own ledger: `semaphore-wait` when the seat must wait (holders +
  queue depth), `semaphore-granted` at every grant under a cap (`waited`,
  and `waitSeq` pairing the wait stamp). Waiters are granted first come,
  first served. A model without a configured limit has no semaphore and no
  stamps. A live config edit re-arms the limits and grants what a raised
  cap allows; seats granted while a model was uncapped are not counted
  against a cap added later.
- **Model integrity.** A substitute dispatch (outage route, chosen by the
  orchestrator) stamps `model-substituted` (new registry event) with
  `from`, `to`, and a required reason — before the spawn. The supervisor
  captures the actual model from the transcript init event; a transcript
  model that differs from the request is a `seat-failure` with reason
  `model-mismatch` — never a silent downgrade. The claude argv builder
  never emits a fallback-model flag.
- **Prompt assembly.** Two blocks. Block one is the shared core: role line,
  scope discipline, narration cadence, ledger discipline, the tool policy
  lines, and the file contract with path and schema. Block two is the
  per-seat role block the lane supplies. No verification scaffolding, no
  forced progress summaries, no reasoning-echo asks.
- **Supervision extension.** `superviseSeat` takes a `parseLine` adapter
  (child stdout dialect → `{cost, note, meta}`) and `spawnFields` (model,
  effort, attempt on the `seat-spawned` stamp). Only `cost` and `note`
  stamp the ledger; `meta` accumulates into the result for the runner.
  The claude adapter maps stream-json: init → model + session id,
  assistant text → note gist, result → cumulative cost.
- **Dispatch through the engine.** Lane handlers call `ctx.runSeat`; the
  engine passes its tracked supervisor, so the liveness invariant sees the
  seat as an in-flight child, and the semaphore wait sits inside the
  handler transition. `claudeCommand` (argv) is instance config, like
  `composeCommand` — it describes the machine.

## Why the corrective re-prompt resumes the session

A fresh context would re-read the whole task to fix a format defect; the
session that wrote the report already holds the content. Resume is cheaper
and keeps effort constant inside the seat session. When no session id was
captured, the corrective prompt stands alone — it carries the errors, the
path, and the schema.

## Why the runner refuses a bad schema instead of failing the seat

A schema outside the subset is a harness defect, not a seat outcome. A
seat-failure would route it to the seat ladder and hide the real cause;
the throw surfaces it at the call site, before any token is spent.

## Named verification items (first live shakedown)

- The `--effort` flag on the claude CLI, and its accepted values.
- The `--disallowedTools` value syntax for multiple tools.
- Whether WebFetch runs client-side on Opus 5 (map: named item).
- Explore-subagent scoping: the argv allows `Task` for dev seats; the cap
  of 2 and the read-only type hold at the prompt level until a tool-level
  deny ships with M6.

## Fallback paths

If prompt-level subagent caps leak (a dev seat spawns more than 2 or a
non-Explore subagent), enforce at the tool level with a deny hook in the
seat's settings. Trigger: a transcript shows a leak. Reversal cost: low —
additive, rides the M6 test-edit deny mechanism.

If session resume proves unreliable for the corrective re-prompt, send the
corrective prompt as a fresh invocation with the report errors inline (the
code path already handles a missing session id). Trigger: resumed sessions
fail or drift in the shakedown. Reversal cost: none — drop the resume arg.

If the flat schema subset cannot express a lane's report, widen the subset
one construct at a time by ADR, keeping the explicit-additionalProperties
rule. Trigger: a report schema that cannot state its content flat.
Reversal cost: low — the checker names the construct it refuses.
