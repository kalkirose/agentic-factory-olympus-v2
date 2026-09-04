# ADR-0005: Seat runtime shapes

Status: accepted (2026-08-10, seat models and cap 2026-09-03, effort and the
seat ladder 2026-09-04)

## Decision

The seat runtime — seat map, file contracts, model semaphores, prompt
assembly, and the headless runner — gets these concrete shapes:

- **Seat map as code.** `src/seats/seatmap.mjs` is a closed registry: seat →
  model, effort, web-tool allowance, Explore-subagent allowance. Seats run
  Claude Opus 5 (`claude-opus-5`) at xhigh effort. The certification spine
  (verdict triage, the Fury verifier, the eval seat) runs Claude Fable 5.1
  (`claude-fable-5-1`) at high, named through `CERTIFICATION_MODEL` and
  `CERTIFICATION_EFFORT`. `FALLBACK_MODEL`
  is the substitute a refused seat degrades to, and it names Claude Opus 5: a
  certification seat whose model is refused runs on Opus 5 at the same effort,
  and a seat already on Opus 5 has no substitute below it, so its rejection is
  the failure. Web search: spec birth and the two dev seats only. Explore
  subagents: the two dev seats only, cap 2. An unknown seat is an error, never
  a default. A change enters by ADR.
- **File contract.** The runner names the report path in the prompt
  (`runs/<runId>/reports/<name>.json` — a run artifact, archived with the
  run). After the child exits clean, a deterministic process validates the
  file. One corrective re-prompt on failure — into the same session where
  the transcript named a session id — then a `seat-failure` event with
  reason `report-invalid`. A missing file and bad JSON take the same route.
- **Crash retries.** A child that dies on a nonzero exit is re-dispatched in
  place, on the prompt in force, up to 3 times per seat session — one budget
  shared across the contract attempts and a degrade re-dispatch. The
  re-dispatch resumes the session the dying child named in its transcript, so
  the work that session already bought is still there; a child that died
  before it named a session is re-dispatched fresh. Each crashed dispatch
  stamps its own `seat-failure` (reason `exit`) with the evidence before the
  next spawn, and every retry spawn carries `retry` with its ordinal,
  `resumed` with the shape it took, and `session` with the id when it resumed
  — the ledger holds the full history, and no reader has to infer the shape
  from an absent field. The allowance covers the two reasons a child stops
  without a verdict, `exit` and `silence`: a deliberate termination, a
  cost-ceiling breach, and a spawn refusal are never retried.
- **The seat ladder.** Past those three retries the seat waits rather than
  fails: 5, 15 and 45 minutes, one wait and one re-dispatch a step, resuming
  the session where one was named (ADR-0069). A model the vendor refused, on a
  seat with no substitute below it, waits until the vendor's own `resetsAt`
  plus one minute and re-dispatches once on that model; without a reset instant
  it takes the same ladder. Only a spent ladder fails the seat, and the
  `seat-failure` park behind it is the park it always was. A wait stamps no
  `seat-failure` and spends nothing, so both budgets above and the cost ledger
  read exactly what they read before it existed; the spawn behind a step
  carries `afterWait` with the step's ordinal.
- **Schema subset.** Report schemas are a flat draft-07-safe subset: a
  top-level object of primitive fields, arrays of primitives, arrays of
  flat objects, or one level of flat object; `enum` on primitives; every
  object level states `additionalProperties` explicitly (the draft-07
  default is open — the explicit boolean keeps owned validation identical
  to any draft-07 validator). The runner refuses a schema outside the
  subset before any spawn.
- **No model is capped by default.** The instance file carries no
  `semaphores` entry, and every seat runs at once: a run spawns each seat
  the moment its stage is ready, and the only bounds on concurrency are the
  project's slot cap and the vendor's own limits. `ModelSemaphores` stays
  in the daemon as the mechanism a project reaches for when it wants a cap:
  one global counter per model id, limits from instance config, across all
  runs. An absent key and an empty object read the same, and the runner
  treats an absent semaphore set the same way: `acquire` finds no limit and
  returns at once, no seat waits, and no `semaphore-wait` or
  `semaphore-granted` is stamped. Under a cap, stamps go to the acquiring
  seat's own ledger: `semaphore-wait` when the seat must wait (holders +
  queue depth), `semaphore-granted` at every grant (`waited`, and
  `waitSeq` pairing the wait stamp). Waiters are granted first come, first
  served. The limits are keyed by exact model id, so a cap that bounds the
  harness is `"semaphores": { "claude-opus-5": <n> }`; a key under
  `"claude-fable-5-1"` bounds the certification spine only. A live
  config edit re-arms the limits: a removed key or a raised cap grants what
  it allows, and seats granted while a model was uncapped are not counted
  against a cap added later.
- **Model integrity.** A substitute dispatch (outage route, chosen by the
  orchestrator) stamps `model-substituted` (new registry event) with
  `from`, `to`, and a required reason — before the spawn. The supervisor
  captures the actual model from the transcript init event; a transcript
  model that differs from the request is a `seat-failure` with reason
  `model-mismatch` — never a silent downgrade. The claude argv builder
  never emits a fallback-model flag.
- **Availability degrade.** A seat whose model refuses the work retries once
  on `FALLBACK_MODEL` (Claude Opus 5) at the same effort, and stamps
  `model-degraded` (new registry event: `requested`, `used`, `reason`,
  `attempt`, and `resetsAt` when the stream named one) before the retry
  spawn. `seat-spawned` names the model that actually ran, so no reader is
  misled about who judged the work. Effort never drops. A seat already on the
  fallback model has nothing below it, so it takes the seat ladder instead: the
  vendor's reset instant where the stream named one, then 5, 15 and 45 minutes.
  The `seat-failure` with reason `model-unavailable` is what a spent ladder
  stamps, carrying the evidence — never a second degrade.
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
- **A prompt never rides an unbounded command line.** Before each dispatch
  the runner measures the argv it built against `COMMAND_LINE_MAX` (32767,
  the Windows CreateProcess ceiling, applied on every platform). Over the
  ceiling, the prompt is written to `runs/<runId>/reports/<name>.prompt-<n>.txt`
  and the command line carries a pointer to that file instead. The
  substitution stamps `prompt-spilled` (new registry event: seat, attempt,
  path, characters) before the spawn. Under the ceiling the prompt rides argv
  byte for byte, unchanged.
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

## Why every re-dispatch resumes the session, when one exists

A seat session is an asset the run has already paid for: the task it read,
the files it opened, the findings it reached. A fresh child holds none of
that and buys all of it again, at the same effort, for the same money. So
both re-dispatch routes resume where the transcript named a session id.

The corrective re-prompt resumes because the defect it answers is format,
not knowledge — the session that wrote the report already holds the content,
and only the shape has to change.

The crash retry resumes because the loss it answers is the whole session.
Measured on a live run: a verifier had verified every finding it was given
and spent $1.73 when the API connection dropped as it wrote its report. A
fresh child re-buys that entire session to recover one file write; a resume
loses the dropped turn and nothing else. The gap grows with the seat — the
longest, most expensive seats are exactly the ones most exposed to a
connection that lasts long enough to drop.

Where no session id was captured, the re-dispatch stands alone: a corrective
prompt carries the errors, the path, and the schema, and a crash retry
carries the prompt in force. A rejected model wrote no transcript at all, so
the degrade re-dispatch never carries a resume.

## Why a nonzero exit buys retries, then waits, and the other failures do not

A nonzero exit is the one failure class whose cause is usually outside the
seat: a dropped API connection, a killed stream. The work product is absent,
not defective, and another child on the same prompt answers it. A live run
proved the shape twice in one story, and each time the only route was a
human park answer that bought exactly the dispatch a machine could have
bought.

Three retries in place bound the immediate spend to a known worst case, and the
bound is a constant rather than config because no project has a reason to want
a different one. What comes after them is the seat ladder, for the same reason
the retries exist and one more: the ledger of 2026-09-04 held sixteen
`seat-failure` parks and every one of them was answered `retry`, between one
minute and seventy hours later. Three retries inside a second answer a dropped
connection; they do not answer a provider that is refusing work for the next
half hour, and that is what the ladder waits out (ADR-0069).

The other classes carry their own answer already. A termination is the
orchestrator's own decision. A cost-ceiling breach re-run would spend the
same money again. A spawn refusal is a host defect no respawn changes. An
unavailable model takes the degrade route first, which reads the vendor's own
window instead of re-buying the rejection, and the ladder only where the
degrade has nowhere to go.

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

## Why Fable 5.1 is the certification spine, not the whole harness

Every seat ran Claude Fable 5.1 for part of 2026-09-03. The account's session
limit was exhausted within hours: the harness spawns seats by the dozen per
run, and one model carrying all of them spends the window faster than it
refills. So the model split is back. Seats run Claude Opus 5. The three seats
whose judgment a run's certification rests on (verdict triage, the Fury
verifier, the eval seat) run Fable 5.1. The spine is where the more capable
model buys the most, and it is a small enough share of the seats to sit inside
the window.

Effort follows the model, by the owner's decision of 2026-09-04: every Opus 5
seat runs at xhigh, and the three Fable 5.1 seats run at high. The day at
high on every seat (2026-09-03) was a half revert of the July assignment, and
this restores it whole. Each level names itself, not a floor another level may
satisfy. A refused certification seat degrades to Opus 5 and keeps its own
level, high, because the runner holds effort inside a session.

`CERTIFICATION_MODEL` names the spine's model, so the three seats read as a
decision in the map rather than three ad-hoc overrides. `FALLBACK_MODEL` names
the same id as `DEFAULT_MODEL`, which is what makes the degrade route
one-directional: a certification seat that is refused lands on Opus 5, and an
Opus 5 seat that is refused has nothing below it and fails.

## Why no model is capped by default

The per-model cap exists because of one incident: on 2026-07-09 a fan-out
of Fable subagents, all spawned at once, burned a session limit and stopped
every seat behind it. The semaphore was the answer: a global counter per
model id, so a factory could not exhaust its own vendor window by spawning
faster than the window refilled.

The owner retired the cap on 2026-09-03. The condition it guarded against
now has a better answer inside the harness: a refused model is read from
the stream, the seat degrades to the fallback model at the same effort, and
a run that holds the vendor's reset instant degrades later seats at the
spawn (ADR-0021). A rejected request costs nothing, and the ledger records
every degrade. Against that, the cap cost real time on every run: a
verdict stage spawns its Fury seats together, and a cap of four on the model
most of them run serialized what was designed to run in parallel. The
owner's instruction is to run every seat at once, so the instance file
carries no `semaphores` key and nothing waits.

The mechanism stays because the reason for it is a property of a vendor
window, not of this harness, and another project on another window may
want the counter back. Removing it would make that a code change; keeping
it makes it one instance-file key.

A cap, where a project sets one, is keyed by exact model id, so the harness is
bounded under `"claude-opus-5"` and the certification spine under
`"claude-fable-5-1"`. Neither key is set by default.

## What the degrade costs, and what it holds

The degrade moves a certification seat from Claude Fable 5.1 to Claude Opus 5.
That is a capability reduction: Fable 5.1 is the more capable of the two, which
is why the spine runs it. The degrade buys availability and pays for it in
judgment quality, and it reaches only the three seats that run Fable 5.1.

Two things it does not cost. The seat's configured effort is held, so the
effort floor stands. And Claude Opus 5 is not below the tier a judging seat
is allowed to run on, so no seat lands somewhere doctrine forbids. A seat
already on Claude Opus 5 has no model below it, and its rejection stands as
the failure.

This is why the stamp is load-bearing rather than decorative. A reader of the
ledger has to be able to see that a given verdict was certified by the
fallback model rather than the configured one, because the two are not
equivalent. An unstamped degrade would silently lower the bar on exactly the
seats whose judgment the run's certification rests on.

## Why a degrade does not remember the rejection window

Superseded by ADR-0021: a run now degrades on its own recorded rejection while
the vendor's `resetsAt` is still ahead.

A rejected request costs nothing and returns in about two seconds, so every
later seat on the refused model re-pays two seconds and no money. Remembering
the window until `resetsAt` would buy that back, and would cost more than it
saves: a remembered rejection degrades a seat on cached state rather than on
its own evidence, which is the one failure mode worth fearing here — a seat
that quietly changes who judged the work. The window stays reconstructable:
`resetsAt` is on every `model-degraded` stamp, so the evidence for building
this later is in the ledger if the arithmetic ever changes.

## Why the prompt moves to a file rather than being trimmed

A prompt is content the harness assembles but does not own the size of. The
correction brief carries one line per defect, and a capture can hold as many
defects as the tree has files. The constitution is a project document. The
tool deny list grows with the test tree. Every one of them is legitimate, and
none of them has a bound the harness can pick.

The command line does have one, and it is hard. A run measured it: a dev seat
spawned at 23,257 characters and worked; its corrective dispatch, carrying one
line per reverted path, reached 40,110 and died `spawn ENAMETOOLONG` one
millisecond after `seat-spawned` stamped. No child ran, so there was no
transcript, no cost and no seat outcome — only a stage handler that failed,
and a run left inert holding a finished green pass.

Trimming the prompt to fit would answer the wrong question. What the seat is
told would then depend on how long the paths in its brief happen to be, and a
seat silently given less than the lane wrote is worse than a seat that cannot
start. A file has no such limit, the seat already reads files by path (its
spec, its report contract), and the run directory already archives everything
the seat was given. So the content stays whole and the command line stays
short.

The ceiling is applied on every platform rather than only on Windows. The
daemon runs on Windows; a bound that relaxes elsewhere would let a prompt pass
its tests on one host and refuse to spawn on the host that matters.

## Why the runner refuses a bad schema instead of failing the seat

A schema outside the subset is a harness defect, not a seat outcome. A
seat-failure would route it to the contract loop and hide the real cause;
the throw surfaces it at the call site, before any token is spent.

## Named verification items (first live shakedown)

Settled by measurement against the installed CLI:

- `--effort` is accepted, and a seat runs at the level it names.
- `--disallowedTools` takes a variadic list. It consumed the trailing prompt
  and killed every seat with a tool policy — the shakedown's first seat
  failure. The argv order above is the fix.
- A refused model is visible only in the stream, not the exit code.

Still open:

- Whether WebFetch runs client-side on Claude Fable 5.1 (map: named item).
- Explore-subagent scoping: the argv allows `Task` for dev seats; the cap
  of 2 and the read-only type hold at the prompt level until a tool-level
  deny ships with M6.

## Fallback paths

If Claude Fable 5.1 is refused, the runner already has the answer: the
certification seat degrades to Claude Opus 5 at the same effort, stamped
`model-degraded`, and a run that holds the vendor's reset instant degrades
later seats at the spawn. No config change and no restart. Trigger: a
`model-degraded` stamp, or a `seat-failure` with reason `model-unavailable`.
Reversal cost: none; the next seat after the reset instant runs on Fable 5.1
again. If Claude Opus 5 is refused there is no substitute, so the seat waits on
the vendor's own instant and then on the ladder, and a spent ladder is the
failure with the evidence in its ledger.

If the seat ladder proves wrong — a provider whose outages outlast 45 minutes,
or a run that should have reached a human sooner — the numbers are one array in
`src/lanes/waiting.mjs` and the park behind them is unchanged. Trigger: a
`seat-failure` park whose provider was back minutes later, or a ladder that
spends an hour on a seat somebody wanted to abandon. Reversal cost: one array,
ADR-0069, and this record.

If the harness has to run one model on every seat again (the session limit
proves to have another cause, or the owner names one model), point
`CERTIFICATION_MODEL` at `DEFAULT_MODEL` in `src/seats/seatmap.mjs`, which is
one constant. `FALLBACK_MODEL` must then name a model that is not the default,
or the degrade has nowhere to go. Trigger: the owner's decision. Reversal cost:
one line and this ADR.

If either model has to move (one is withdrawn, or the owner names another),
`DEFAULT_MODEL` and `CERTIFICATION_MODEL` are one line each. An instance file
that caps the old id has to rename the key, or the cap it meant stops
applying. Trigger: the owner's decision. Reversal cost: one line per constant,
this ADR, and one instance-file key where a cap is set.

If one seat needs a different effort, `seat()` in the map already takes an
`effort` override, the same way it takes `web` and `explore`; the runner
passes whatever the map names and holds it for the session. Trigger: the
owner names a seat and a level. Reversal cost: one field on one seat, and
this ADR, because the map is closed and a change enters by decision.

If a model has to be capped again (a vendor window that refuses a fan-out
faster than the degrade route can absorb, or a project on a shared key),
add `"semaphores": { "<model id>": <n> }` to the instance file. The daemon
picks the edit up live, the counter arms for grants after the edit, and
seats already in flight are not counted against it. Trigger: repeated
`model-degraded` stamps whose `resetsAt` the run keeps crossing, or a
vendor limit the owner wants to stay under. Reversal cost: none; the
mechanism is in place and the key is one edit, removed the same way.

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

If session resume proves unreliable, dispatch both re-dispatch routes fresh:
the corrective prompt carries the report errors inline, the crash retry
carries the prompt in force. Both paths already handle a missing session id,
so nothing new has to be written. Trigger: a resumed session fails, or
answers something other than the work it was resumed into. Reversal cost:
none — drop the resume argument.

If a seat handles a spilled prompt worse than an inline one — it reads the
file late, or treats the pointer as the whole brief — put the prompt on the
child's stdin instead and keep the file as the archived copy. Trigger: a seat
whose `prompt-spilled` dispatch produces a worse report than its inline
dispatches. Reversal cost: low — the spill point is one branch in the runner,
and the file it writes is already the exact prompt text.

If the flat schema subset cannot express a lane's report, widen the subset
one construct at a time by ADR, keeping the explicit-additionalProperties
rule. Trigger: a report schema that cannot state its content flat.
Reversal cost: low — the checker names the construct it refuses.
