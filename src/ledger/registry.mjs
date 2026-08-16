// Closed event registries. A new event type enters only by a design-level
// decision recorded in an ADR — never ad hoc from a call site.

// Seat events appear in run ledgers and, for instance-scoped jobs, in the
// instance ledger.
const SEAT_EVENTS = [
  'seat-spawned',
  'seat-progress',
  'seat-report',
  'seat-failure',
  'seat-terminated',
  'model-substituted',
  'model-degraded',
  'semaphore-wait',
  'semaphore-granted',
];

// The events that end a seat invocation. Everything a seat spent before one
// of these is a snapshot; the terminal stamp is the invocation's final word.
export const SEAT_TERMINAL_EVENTS = new Set([
  'seat-report',
  'seat-failure',
  'seat-terminated',
]);

export const RUN_EVENTS = new Set([
  // run lifecycle
  'run-launched',
  'stage-entered',
  // What a stage that runs no seat says while it polls: what it waits on, the
  // poll outcomes behind the stamp, and its time in the stage. One stamp per
  // batch of poll outcomes, so a stage that settles quickly stamps none and a
  // stage that waits for hours stamps a handful. Quiet — waiting is not a
  // fault — but never silent, because a stage nothing stamps for reads the
  // same at one minute as at three hours (ADR-0034).
  'stage-heartbeat',
  'run-closed',
  ...SEAT_EVENTS,
  // One read-only probe of one external credential, at the launch gate or at
  // the ship gate: `ok` carries the answer, and both answers are stamped, so
  // a run always says which credentials it proved and when. The probe's own
  // output is never carried — it can hold the credential (ADR-0027).
  'credential-probe',
  // spec + suite
  'spec-born',
  'spec-gate-round',
  'suite-committed',
  'adversary-wave',
  'survivor-disposition',
  'red-state-check',
  'freeze',
  // A launch that inherited a prior run's freeze instead of deriving one.
  // A resumed run never stamps `freeze`: it did not earn one.
  'freeze-inherited',
  // verdict
  'implementation-committed',
  'layer-result',
  'flake',
  'finding',
  'verdict-rendered',
  'repair-round',
  'stall',
  'fresh-pass',
  're-freeze',
  'operational-fix',
  // The gate answered itself on a standing acknowledgment: every finding it
  // would have asked about is a harness defect an operator already recorded as
  // known. Quiet, because the gate is answered and the run proceeds as it does
  // on any answer — but never silent, because the run took a human's authority
  // without asking the human. It names the findings, the fingerprints, the ack
  // events and who recorded them, and the `operational-fix` beside it carries
  // `source: 'ack'` (ADR-0032).
  'finding-ack-used',
  // gate integrity (loud)
  'gate-integrity',
  // The run passed the budget its lane was given. Loud, because the owner is
  // watching money leave and nothing else in the run will say so — and
  // informational, because a threshold never parks, blocks, or closes
  // anything (ADR-0021). The run pairs its own `resolved` at close.
  'budget-breach',
  // A candidate capture the diff policy refused, or one that took a frozen
  // write back. Loud, because both mean the tree the run judges is not the
  // tree the seat believed it left behind (ADR-0017). A refusal is owned by
  // the capture that got through; a take-back by the re-freeze that re-takes
  // the frozen surface (ADR-0015).
  'diff-policy-violation',
  // A capture that took a write back from a path the lane declared
  // re-capturable. Quiet: the revert, the record and the downstream statement
  // are the same as any take-back, but the verdict's re-freeze already owns
  // the artifact, so an alert would report a handled case (ADR-0017).
  'diff-policy-recapture',
  // ship
  // The per-project ship token, at the two moments a run's own ledger is what
  // says where the token went: the wait, and the acquire. The token itself is
  // derived from these stamps and from `pr-opened`/`merged` across the open
  // runs of a project, never from a file — so a restart re-derives the holder
  // it had, and a stamp records a move rather than storing a right (ADR-0033).
  'ship-token',
  // The branch update the run takes under the token, just before its final
  // verdict: the tree the verdict certifies is then the tree that lands.
  // Stamped whether it ran or found the base where the run left it — a run
  // that merges the default branch into its own tree on its own authority
  // says so either way — and `capped` is the pass that stopped chasing a
  // moving base and left the update to the ship stage (ADR-0033).
  'pre-verdict-update',
  'pr-opened',
  'check-transition',
  'ci-flake',
  'branch-update',
  // One state of the forge that is not a state of a check: a pull request in
  // conflict with its base, for which the forge builds no merge ref and runs
  // no workflow, or a head sha it carries no check run of any name for. The
  // watcher would read either as a check that has yet to arrive, so each is
  // named here and routed (ADR-0008). Quiet — every kind has a route, and the
  // route stamps what it did — but never silent, because a run that waits on
  // the forge must say what it waits on.
  'forge-anomaly',
  'merge-round',
  'merged',
  'merge-commit-check',
  'red-merge-breach',
  'card-sweep',
  // The close-out judgment on decision-record reconciliation: owed or not,
  // with the records named and the ticket written when owed (ADR-0026). A
  // failed judgment stamps ok:false — an unjudged ship is visible, never a
  // silent skip.
  'reconciliation-judged',
  // The close-out learning artifact a project asks for in its config: `ok`
  // with the artifact paths the seat reported, or ok:false with the reason
  // (ADR-0031). Quiet either way — the story shipped, and nothing here can
  // stop or slow the close — but never silent, because a feature that fails
  // without a record is a feature nobody can tell is broken.
  'learning-lesson',
  // escalation
  'park',
  'answer',
  'resume',
  // liveness (loud)
  'liveness-violation',
  // paired resolution append for loud items and breaches
  'resolved',
]);

export const INSTANCE_EVENTS = new Set([
  'daemon-started',
  'daemon-stopped',
  // A start that found no clean stop behind it: the previous instance died
  // where the ledger goes silent, and the seq it carries is that point
  // (ADR-0016). Every ordinary exit path stamps `daemon-stopped`, so this
  // event means a death no exit path saw.
  'daemon-crash-detected',
  // One defect in the environment this instance's seats will run in, found by
  // the start-time check and stamped once: a runner the host cannot execute, a
  // path its CLI will not trust, a clone whose git cannot hold the harness's
  // own path lengths. Informational — the daemon starts on every one of them,
  // and a clean host stamps none (ADR-0030).
  'seat-environment',
  'launch',
  // A launch the daemon refused. The console's reason file says why to
  // whoever asked; this says it to everyone reading the instance ledger.
  'launch-rejected',
  // A closed run reached the archive: at its close, or at the start that
  // swept it up afterwards. It carries how the directory travelled (`rename`
  // or `copy`) and the live directory a copy could not delete, and it is the
  // event that answers an `archive-failed` record for the same run.
  'run-archived',
  // A closed run that did not reach the archive. Loud, because the run is
  // over and the move is the one part of a close that a process outside the
  // harness can block: the daemon carries on, and the record is what says a
  // run directory is sitting where no run lives (ADR-0015).
  'archive-failed',
  // A push notification that did not get through: the transport failed, the
  // target answered with an error, or it ran past its timeout. The event a
  // reader can no longer trust the push for is named, so the pull surfaces
  // stay the authority they always were (ADR-0028).
  'notify-failed',
  // One operator statement that a harness defect is known and deferred, and
  // the revoke that ends it. Together they are the whole store of standing
  // acknowledgments: the set is folded from this pair, so it survives every
  // restart and changes only when somebody says so (ADR-0032). The revoke
  // names one fingerprint and carries the fix it stands on.
  'finding-ack',
  'finding-ack-revoked',
  'workspace-released',
  // A run workspace the release could not delete, naming the directory that
  // stayed behind. Quiet: the run is over, every reader already looks past
  // the workspace root, and the answer is a retry the harness owes itself
  // rather than a decision for the owner. It stays open until a sweep deletes
  // what it names, and the `resolved` beside it is that sweep (ADR-0004).
  'workspace-leftover',
  'arming-changed',
  'config-changed',
  'factory-starvation',
  // Ticketed breach escapes the sweep may not launch, because the project is
  // paused or was never armed. Loud, because the pause is the owner's and the
  // daemon never bypasses it; the sweep appends the paired `resolved` when
  // the repairs launch (ADR-0024).
  'repairs-owed',
  'tripwire-breach',
  // A stage of one run past the duration band the same stage of the same lane
  // built in the ledgers. It sits in the instance ledger because the watcher
  // wrote it, and the watcher holds no run: detection that cannot reach into a
  // run cannot change one (ADR-0034).
  'stage-overrun',
  'baseline-proposal',
  'eval-review',
  // Instance-scoped escalations: a park that waits on the human but belongs
  // to no open run (card-invalidated from the ship-time sweep). The paired
  // `answer` clears the park and unblocks the card; runs park and answer
  // through the engine.
  'park',
  'answer',
  ...SEAT_EVENTS,
  'resolved',
]);

// The escape lifecycle: recorded → ticketed (the repair ticket the harness
// wrote for it, absolute path) → fixed. The ticket stamp follows the file it
// names, so a ticketed escape always has a ticket to repair from (ADR-0024).
// An escape ends one of two ways and the ledger says which: `escape-fixed` is
// a repair run's close-out, `escape-marked-fixed` is an operator's statement
// that the defect is out of the product, with the evidence it stands on.
export const ESCAPES_EVENTS = new Set([
  'escape-recorded',
  'escape-ticketed',
  'escape-fixed',
  'escape-marked-fixed',
]);

// Stream classing. Every stream-classed append also lands as a pointer in
// the matching stream index. The full event lives only in its source ledger.
export const QUEUED_EVENTS = new Set([
  'park',
  'tripwire-breach',
  // One stage of one run past the duration band of that stage, read from the
  // heartbeat the stage stamped. Queued, because it asks the operator to look
  // and asks the run for nothing: the record names the stage, the elapsed and
  // the band it left, and the run carries on untouched. It opens once per
  // stage and closes when the stage moves on (ADR-0034).
  'stage-overrun',
  'baseline-proposal',
  'eval-review',
]);
export const LOUD_EVENTS = new Set([
  'liveness-violation',
  'gate-integrity',
  'diff-policy-violation',
  'red-merge-breach',
  'factory-starvation',
  'repairs-owed',
  'budget-breach',
  'archive-failed',
]);

// The close-out backstop. A loud record resolves at the event that owns it
// (`resolution.mjs`); these two are the classes a run may also close on its
// own when no owner ever landed. They ask the owner for no decision — the run
// they reported on is over — so leaving them open would build the owner an
// alert strip of finished runs (ADR-0021).
export const CLOSE_RESOLVED_EVENTS = new Set(['budget-breach', 'diff-policy-violation']);

export function streamOf(event) {
  if (QUEUED_EVENTS.has(event)) return 'queued';
  if (LOUD_EVENTS.has(event)) return 'loud';
  return null;
}

// Closed park catalog — the only states that wait on the human. A new park
// type enters only by a design-level decision, never ad hoc from a seat.
export const PARK_TYPES = new Set([
  'open-decisions', // open decisions at build start
  'grounding-conflict', // spec birth
  'intent-conflict', // spec gate
  'spec-gate-exhausted', // spec gate, counted rounds spent
  // The gate stopped short of the cap because its blocking set did not
  // shrink. Same options as exhaustion, different condition — and a decision
  // park names its condition in the type, because `reason` on a park already
  // carries the close an answered recovery park takes (ADR-0020).
  'spec-gate-stalled',
  'unkilled-gap-survivor', // adversary survivor without a killing test
  'second-zero-kill', // second 0/N adversary round
  'second-stall', // response ladder
  'card-invalidated', // ship-time card sweep
  'provisioning-gate',
  // Terminal-state discipline (ADR-0015): a recoverable failure parks with
  // `retry` / `abandon` instead of closing the run.
  'seat-failure', // a seat work product past its machine retry allowance
  'stage-blocked', // a stage precondition the run cannot settle itself
  'command-error', // a configured command could not run at all
]);

// Terminal run states. Every one of them stamps `run-closed`. A run reaches
// one of them through the ship path, a human kill, or a human answering a
// park with its abandon option — never through a condition the run met on
// its own (ADR-0015).
export const CLOSE_STATES = new Set(['shipped', 'failed', 'killed']);
