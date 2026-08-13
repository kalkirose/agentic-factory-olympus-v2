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
- **Availability degrade.** A seat whose model refuses the work retries once
  on `DEFAULT_MODEL` at the same effort, and stamps `model-degraded` (new
  registry event: `requested`, `used`, `reason`, `attempt`, and `resetsAt`
  when the stream named one) before the retry spawn. `seat-spawned` names
  the model that actually ran, so no reader is misled about who judged the
  work. Effort never drops. The default model refusing too is a
  `seat-failure` with reason `model-unavailable`, carrying the evidence —
  never a second retry.
- **Unavailability is read from the stream.** Two structured signals mark a
  model unavailable: a `rate_limit_event` whose `rate_limit_info.status` is
  `rejected`, and the synthetic assistant message the CLI substitutes for
  the answer (`error: "rate_limit"` with `is_api_error_message: true`).
  Never the exit code, and never the message text.
- **Argv order is load-bearing.** `--disallowedTools` takes a variadic value
  list, which consumes every following argument up to the next flag. The
  prompt is a trailing positional (`-p` is a boolean), so a boolean flag has
  to close the list: `--dangerously-skip-permissions` is emitted last, after
  the tool list and after any `--resume`.
- **Failure evidence.** Every `seat-failure` the supervisor stamps carries a
  bounded tail of what the child emitted: the last 600 characters of stderr
  and the last 3 stdout lines, each clipped to 200 characters. A seat that
  dies is diagnosable from the run's own ledger, with nothing re-run by hand.
- **Prompt assembly.** Two blocks. Block one is the shared core: role line,
  scope discipline, narration cadence, ledger discipline, the tool policy
  lines, the one-turn execution rule, and the file contract with path and
  schema. Block two is the per-seat role block the lane supplies. No
  verification scaffolding, no forced progress summaries, no reasoning-echo
  asks.
- **One-turn execution.** Every seat is told to run each command
  synchronously and read its result in the same turn: no background work, no
  armed watcher, no wait on an event from outside the turn. A long command is
  allowed; a wait for a command the seat cannot see finish is not. The report
  is written before the seat stops. When a report is missing rather than
  malformed, the corrective brief names the missing report as the cause and
  restates the rule.
- **Supervision extension.** `superviseSeat` takes a `parseLine` adapter
  (child stdout dialect → `{cost, note, meta}`) and `spawnFields` (model,
  effort, attempt on the `seat-spawned` stamp). Only `cost` and `note`
  stamp the ledger; `meta` accumulates into the result for the runner.
  The claude adapter maps stream-json: init → model + session id,
  assistant text → note gist, result → cumulative cost, a rejection →
  `meta.unavailable`. One outcome stamps nothing in the supervisor: an
  unavailable model resolves with reason `model-unavailable` and leaves the
  stamp to the runner, which owns the choice between a degrade and a
  failure.
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

## Why the one-turn rule sits in the core block

A headless session ends when the model stops, and the machine kills every
child command the seat left behind. A seat cannot read that fact off its own
environment: from inside the turn, a backgrounded command and an armed
watcher look like sound practice. The failure they produce is the worst shape
available — the seat spends a full session, the command dies unrecorded, and
the contract sees only a missing report. So the rule is stated to every seat
rather than left to the seat that happens to run a long gate.

## Why the exit code carries no part of the availability decision

The CLI answers a refused model with exit 0 from a terminal and exit 1 from
the harness's piped spawn — both measured on the same rejection, minutes
apart. The result event of that same stream reports `subtype: "success"`.
The two structured fields are the only stable signal, and they are the whole
signal. Message text is user-facing copy and can be rewritten at any release,
so matching on it would make a release note a harness outage.

## What the degrade costs, and what it holds

The degrade moves a seat from the certification model to the default model.
That is a capability reduction, not an upgrade: the certification model is
the more capable of the two, which is why the seats that judge are pinned to
it in the first place. The degrade buys availability and pays for it in
judgment quality.

Two things it does not cost. The seat's configured effort is held, so the
effort floor stands. And the default model is not below the tier a judging
seat is allowed to run on, so no seat lands somewhere doctrine forbids. A
degrade in the other direction has no code to run down.

This is why the stamp is load-bearing rather than decorative. A reader of the
ledger has to be able to see that a given verdict was certified by the
fallback model rather than the configured one, because the two are not
equivalent. An unstamped degrade would silently lower the bar on exactly the
seats whose judgment the run's certification rests on.

## Why a degrade does not remember the rejection window

A rejected request costs nothing and returns in about two seconds, so every
later seat on the refused model re-pays two seconds and no money. Remembering
the window until `resetsAt` would buy that back, and would cost more than it
saves: a remembered rejection degrades a seat on cached state rather than on
its own evidence, which is the one failure mode worth fearing here — a seat
that quietly changes who judged the work. The window stays reconstructable:
`resetsAt` is on every `model-degraded` stamp, so the evidence for building
this later is in the ledger if the arithmetic ever changes.

## Why the runner refuses a bad schema instead of failing the seat

A schema outside the subset is a harness defect, not a seat outcome. A
seat-failure would route it to the seat ladder and hide the real cause;
the throw surfaces it at the call site, before any token is spent.

## Named verification items (first live shakedown)

Settled by measurement against the installed CLI:

- `--effort` is accepted, and a seat runs at the level it names.
- `--disallowedTools` takes a variadic list. It consumed the trailing prompt
  and killed every seat with a tool policy — the shakedown's first seat
  failure. The argv order above is the fix.
- A refused model is visible only in the stream, not the exit code.

Still open:

- Whether WebFetch runs client-side on Opus 5 (map: named item).
- Explore-subagent scoping: the argv allows `Task` for dev seats; the cap
  of 2 and the read-only type hold at the prompt level until a tool-level
  deny ships with M6.

## Fallback paths

If prompt-level subagent caps leak (a dev seat spawns more than 2 or a
non-Explore subagent), enforce at the tool level with a deny hook in the
seat's settings. Trigger: a transcript shows a leak. Reversal cost: low —
additive, rides the M6 test-edit deny mechanism.

If the two rejection signals stop appearing — the CLI drops the
`rate_limit_event` or renames the error value — seats stop degrading and
fail the way they did before this decision, loudly and with the evidence in
the ledger. Trigger: a `seat-failure` whose recorded tail shows a rejection
that raised no degrade. Reversal cost: low — the detection is two field
comparisons in the stream parser.

If a degrade ever fires on a healthy seat, drop the assistant-message signal
and keep the `rate_limit_event` alone, which no healthy stream carries at
status `rejected`. Trigger: a `model-degraded` stamp whose seat had a working
model. Reversal cost: none — delete one condition.

If session resume proves unreliable for the corrective re-prompt, send the
corrective prompt as a fresh invocation with the report errors inline (the
code path already handles a missing session id). Trigger: resumed sessions
fail or drift in the shakedown. Reversal cost: none — drop the resume arg.

If the flat schema subset cannot express a lane's report, widen the subset
one construct at a time by ADR, keeping the explicit-additionalProperties
rule. Trigger: a report schema that cannot state its content flat.
Reversal cost: low — the checker names the construct it refuses.
