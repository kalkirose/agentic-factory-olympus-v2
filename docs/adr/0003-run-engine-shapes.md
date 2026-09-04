# ADR-0003: Run engine shapes

Status: accepted (2026-08-10)
Superseded in part by ADR-0015: the park catalog holds twelve types, and
the close directive is reserved for the ship path, a kill, and an abandoned
park.

## Decision

The run engine from the locked design gets these concrete shapes:

- **Lanes and directives.** A lane is an ordered stage list plus one handler
  per stage, registered as code. A handler returns one directive: `next`
  (a stage in the lane), `park` (an escalation record), or `close` (a
  terminal state from the closed set `shipped` / `failed` / `killed`).
  The engine stamps `stage-entered` on every entry and `run-closed` on
  every terminal state.
- **Liveness detection point.** The invariant check keys on the handler
  settle: a handler that throws, returns no directive, or returns an
  invalid one leaves the run with no child, no park, and no transition —
  the engine stamps `liveness-violation` (loud) at that point. A sweep
  (`checkLiveness`) backs the same rule for consoles and resume.
- **Violated runs stay open.** A violation alerts, never auto-kills: the
  run holds its slot and waits inert. The console resolves the loud item
  or kills the run.
- **Cost ceiling on child stdout.** A seat child reports progress as JSON
  lines on stdout; `cost` is cumulative. Only `cost` and `note` cross into
  the ledger — a child cannot shadow envelope fields. A ceiling breach
  terminates the child and stamps `seat-failure`. `seat-terminated` is
  reserved for deliberate orchestrator termination (run kill, daemon stop)
  and is not a failure.
- **Slot semantics.** A slot counts active runs per project: open and not
  parked, any lane. The cap gates launch only; an answer always resumes.
  A transient over-cap after answers blocks new launches, never a resume.
- **Restart resume.** The daemon derives each open run's state from its
  ledger alone. A run no hold covers re-enters its recorded stage with a
  `resumed: true` stamp. A run any hold covers — the instance's, its
  project's, or its own — holds instead, at the boundary it was standing at or
  at the stage the stop caught it in, with `resumed` on the `stage-held`
  stamp, and the release runs that stage. Parked and violated runs stay
  waiting on the human. A run the engine cannot resume (unknown lane or stage)
  violates loud instead of vanishing. ADR-0070 owns the rules a resumed stage
  reads.
- **Answer validation.** An answer applies only to a parked run and must
  name an offered option or carry answer text. The `answer` stamp carries
  who (actor) and when (ts); `resume` re-runs the parked stage with the
  answer in context.
- **Park catalog as code.** The nine park types live in the closed
  registry beside the event sets. An off-catalog park is a liveness
  violation, not a new touchpoint.

## Why directives instead of engine calls from handlers

A handler that returns a value cannot half-transition: the engine applies
exactly one directive after the handler settles, so every transition is
stamped and the invariant has one checkpoint. Handlers that could call
`enterStage` themselves would scatter the transition points and the check.

## Why stdout progress lines

The seat runner (M5) drives the `claude` CLI, which already emits JSON
lines on stdout in stream mode. Supervision and the seat runtime then share
one channel, and a fixture child in tests is a two-line node script.

## Fallback path

If in-process handlers prove wrong for long stages (memory growth, blocking
work), move stage execution into spawned processes and keep the directive
contract at the process boundary. Trigger: daemon telemetry shows stage
handlers starving the event loop. Reversal cost: medium — the directive
shapes and stamps stay; only execution placement moves.

If stdout progress proves wrong for the real seat runner (M5), switch to a
progress file beside the seat report; the supervisor interface keeps the
same stamps. Trigger: the CLI stream cannot carry cost reliably. Reversal
cost: low — one function changes.
