# ADR-0009: Frontier, escalation queue, console shapes

Status: accepted (2026-08-10)

## Decision

The frontier, the escalation queue, and the console get these concrete
shapes:

- **Graph source.** The project config gains a `graph` section:
  `cardsDir` (intent cards, one `.md` per story, top level only — an archive
  subdirectory stays out) and `phases` (ordered; the first phase is ungated,
  every later phase names the card whose ship opens it; default one `launch`
  phase). Cards gain an optional `phase` frontmatter field (absent = first
  phase). The daemon reads config and cards from the default branch in the
  bare clone at every sweep, fetched first — the graph the launcher acts on
  is the graph on the remote.
- **Roadmap order is derived, never stored.** Kahn's topological order over
  the card edges; the ready set is picked by phase index, then unlock count
  (direct dependents, descending — hubs land early), then key. The pre-v2
  fixed order carries no authority; a card edit re-derives the order at the
  next sweep.
- **Card states, mutually exclusive.** `defect` (no key, duplicate key,
  parse error, unknown phase, unknown blocker, cycle) → `shipped` → `open` →
  `spent` (a run closed failed or killed) → `parked` (unanswered
  card-invalidated park) → `blocked` (a blocker unshipped) → `gated` (phase
  closed) → `launchable`. Run history keys on the `storyKey` launch payload
  (fallback: the freeze stamp). A `spent` card never auto-relaunches —
  relaunch is a console decision; a defect card never launches. A blocker
  that shipped and left the card set still satisfies its edge.
- **The phase gate is an auto-launch rule, never an edge.** A gated card
  stays out of the launchable set regardless of its edges; the graph itself
  carries no sequencing edges.
- **Arming state machine.** Per project, disarmed at birth; `arm` / `pause`
  control commands toggle it; only a transition stamps `arming-changed`
  (actor, project, armed); the state replays from the instance ledger at
  daemon start. Pause stops new launches only — open runs continue, and
  pause resolves any open starvation (a paused factory is idle by decision).
- **Event-keyed sweeps, serialized.** A sweep fills free slots from the
  launchable frontier in roadmap order. Triggers: daemon start, arm, run
  close, run park (new engine hook `onParked` — a park frees its slot),
  config change, and the answer / launch / resolve commands. Never a timer.
  Sweeps chain per project; one failed launch ends the sweep (the next
  trigger retries — no hammering a broken remote). Auto-launched runs carry
  `card` and `storyKey` in the payload; the manual `launch` command reads
  the key from the clone, best-effort.
- **Factory starvation, open once, daemon-resolved.** After the last queued
  sweep settles: zero active runs and nothing launchable while unfinished
  cards (or parked runs) exist stamps `factory-starvation` (loud, with
  reason) — an unreadable graph counts, the alarm must not depend on the
  graph being readable. Only the last queued sweep judges; an episode opens
  once and the daemon appends the paired `resolved` itself when activity
  returns or on pause. All cards shipped = quiet idle, no event.
- **Clone lock.** `RunIsolation.withClone(project, fn)` serializes all git
  work on a project's bare clone: provision (through worktree add; the stack
  rises outside the lock), release's worktree removal, prune, the sweep's
  graph read, the launch command's card read. Concurrent git commands on one
  repository collide on its internal locks and fail spuriously — the
  auto-launcher made teardown-vs-provision races routine.
- **Escalation queue.** `escalationQueue(paths)` joins the open queued-stream
  items with their full source records — answerable from the record alone
  (question, refs, options). Openness is derived: a park closes on its paired
  `answer` (or when its run closes — a killed run's park is moot); a breach
  closes on its paired `resolved`. Presentation FIFO by arrival with a
  roadmap-position tiebreak (story key or card path), then seq. No priority
  machinery.
- **Instance answers.** `answer` joins `INSTANCE_EVENTS`. The `answer`
  command targets a run park (`runId`) or an instance park (`seq`); the
  daemon validates like the engine (offered options only, else answer text;
  no double answer) and stamps who and when. An answered card-invalidated
  park unblocks its card at the next sweep. Batch answering is several
  independent commands — each answer is its own state change.
- **Resolve command.** Routes by target: an open run resolves through the
  engine — clearing a run's last open liveness violation re-enters its
  recorded stage (the same recovery a restart replay performs); a closed
  run's ledger resolves in place (live path, then archive); an instance item
  resolves through the daemon's ledger. Nothing else writes `resolved` for
  the human.
- **Console surface.** `olympusctl` (status, queue, frontier, answer, arm,
  pause, launch, kill, resolve) over the daemon home: reads render from the
  ledgers and stream indexes, loud first, then the queue; commands go
  through the control inbox (write-then-rename via the shared
  `control.mjs`); feedback is the done/ and rejected/ directories. The
  frontier render reads the clone without fetching — a console never writes
  the daemon home. The `olympus-console` skill wraps the CLI for a Claude
  session and covers the live instance-config edit (edit `instance.json`,
  verify the `config-changed` stamp).

## Why roadmap order is computed instead of read from a file

The map derives the order from the re-cut graph (topological, unlock-count
tiebreak) and has the card sweep maintain it "as edges change". A stored
order is a second authority that drifts from the edges it mirrors; deriving
it at every sweep makes the card files the only authority and the sweep's
edge edits take effect without a second artifact. The derivation is
deterministic (phase, unlock count, key), so two sweeps over the same cards
agree.

## Why a spent card leaves the auto-launch frontier

A run that closed `failed` exhausted its caps or a human chose `fail`;
`killed` is a human abort. Auto-relaunching either burns compute in a loop
the catalog has no park for, and "no default answers" forbids the daemon
from deciding the failure differently. The console relaunches with one
command; the frontier render names the card `spent` so the decision is
visible.

## Why starvation judgment waits for the chain to drain

A sweep's settle can observe "zero active, work remains" in the instant
between a run's close and the successor sweep that close queued — the next
card launches milliseconds later. Letting only the last queued sweep judge
removes the false episode without a timer; the judgment stays event-keyed
because every trigger queues a sweep and the last one always settles.

## Fallback paths

If per-sweep card reads grow too slow on a large graph (a fetch plus one
`git show` per card), cache by the default-branch head sha — same
authority, one fetch to invalidate. Trigger: sweep duration visible in the
duration history. Cost: low, one memo.

If FIFO-with-tiebreak presentation proves wrong for deep queues, the queue
reader is one sort function (`sortQueue`) behind the render; no store
changes. Trigger: the human reorders by hand routinely.

If the `spent` rule starves real throughput (transient failures needing
routine relaunch), add an explicit console `relaunch` that clears the spent
state with a stamp — never an automatic retry. Trigger: repeated manual
relaunches of the same shape.
