# Doctrine

These rules shaped the v2 design. They bind every component. A change to one
of them is a design decision, not an implementation detail.

## Runs and evidence

- **Run self-evidence.** Every run writes a complete, trustworthy, append-only
  run ledger as a first-class output: state stamps, per-seat telemetry,
  verdicts, findings, learnings. Stamps cover every terminal state.
  Instrumentation exists from the first run. v3 gets designed from v2's
  ledgers.
- **No timeout-as-detection.** Wall-clock is never a trigger or a detector.
  Liveness = ledger state stamps compared with duration history. Completion =
  pushed results (a validated file, a stamped event). Watchers key on state
  changes and cover all terminal states. Durations are legal telemetry.
- **Continuous run.** A story is one run from intent card to merged PR.
  Stages are internal states. No idle seams between phases: the invoker never
  leaves.

## Tests and quality

- **Frozen-suite discipline.** Tests exist before implementation. The suite
  freezes at a SHA. Story-lane dev seats cannot edit any test file; every
  test change routes through the suite seat. The repair lane is exempt for
  its own regression test.
- **Fresh-context implementation.** One implementation pass per story is the
  primitive. No run-until-green loop, no tournament, no multi-candidate
  judging.
- **One verdict per pass.** Findings feed into the verdict before it renders,
  never as a post-hoc overlay over a green tree.
- **Confirm-to-block.** A judgment finding blocks only after a verifier
  confirms it against the code. Sub-HIGH findings never block.
- **No ungated path to main.** Every change ships through a lane with
  deterministic gates and a verdict.
- **Every gate cut ships with a tripwire.** A cut names its metric, watch
  window, and breach condition at cut time, in the same PR. Breach restores
  the cut by default; an exception is a recorded human decision.

## Seats and processes

- **Seats only where judgment happens.** Deterministic work runs as processes
  under the orchestrator. No relay seats.
- **File contracts.** A seat's final act writes its JSON report to the path
  the orchestrator names. A process validates the file; the valid file is the
  completion signal. One corrective re-prompt on failure, then a seat-failure
  event.
- **Model integrity.** No silent model swaps. The ledger records each seat's
  actual model from the transcript, never from config. A substitute model is
  an explicit ledger event. A seat whose model is unavailable degrades to the
  default model at the same effort rather than failing the run — stamped,
  never silent. Effort never drops.
- **A failed seat leaves evidence.** Every seat failure records a bounded
  tail of what the seat emitted. Nothing that runs unattended may die in a
  way that only a human at a terminal can diagnose.
- **No unlinted writer.** An automated writer passes every mechanical check
  that binds the equivalent human path, before the write leaves the machine.
  The check is the project's own command, not a rule the harness holds about
  somebody else's document. A writer that skips a check a person passes turns
  a private mistake into a public block: the output sits where the next reader
  meets it, and the gate that would have caught it runs for everybody except
  the machine that wrote it (ADR-0054).

## The human

- **No default answers.** No escalation expires or self-clears. The daemon
  never picks an option in the human's absence. Absence tolerance is
  structural: park frees the slot, the frontier continues, an empty frontier
  idles quietly with a starvation event.
- **Closed touchpoint catalog.** Only a named, closed set of park events may
  wait on the human. A new park state enters only through a design-level
  decision, never ad hoc from a seat.
- **Never ask what a document already answers.** Where the answer is
  arithmetic between two artifacts the harness holds, the harness does the
  arithmetic and records what it did, with the source quoted. The human's
  touch belongs where the intent is written, once, not at every run that meets
  its consequence. What derives from a document survives a dead run, because
  the document does. An automated writer obeys the same rule in the other
  direction: it never writes a question onto a document that the document
  already answers. A planted question wakes a human at every launch behind it
  (ADR-0052).
- **Pull, not push.** Notifications are two ledger streams (queued, loud)
  read by console sessions. No push channel.

## The repository

- **Generic-only rule.** The public harness repo holds no project-specific
  content. Project knowledge lives in the project's config and repo. The
  ownership test places every config value: describes the project's code →
  project config; describes the machine → instance config.
- **Minimize layers.** No new vendor or dependency without its own recorded
  decision. Zero runtime dependencies is the default.
