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
  'pr-opened',
  'check-transition',
  'ci-flake',
  'branch-update',
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
  'launch',
  // A launch the daemon refused. The console's reason file says why to
  // whoever asked; this says it to everyone reading the instance ledger.
  'launch-rejected',
  // A push notification that did not get through: the transport failed, the
  // target answered with an error, or it ran past its timeout. The event a
  // reader can no longer trust the push for is named, so the pull surfaces
  // stay the authority they always were (ADR-0028).
  'notify-failed',
  'workspace-released',
  'arming-changed',
  'config-changed',
  'factory-starvation',
  // Ticketed breach escapes the sweep may not launch, because the project is
  // paused or was never armed. Loud, because the pause is the owner's and the
  // daemon never bypasses it; the sweep appends the paired `resolved` when
  // the repairs launch (ADR-0024).
  'repairs-owed',
  'tripwire-breach',
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
export const ESCAPES_EVENTS = new Set([
  'escape-recorded',
  'escape-ticketed',
  'escape-fixed',
]);

// Stream classing. Every stream-classed append also lands as a pointer in
// the matching stream index. The full event lives only in its source ledger.
export const QUEUED_EVENTS = new Set([
  'park',
  'tripwire-breach',
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
