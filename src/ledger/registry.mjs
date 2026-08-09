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
  'semaphore-wait',
  'semaphore-granted',
];

export const RUN_EVENTS = new Set([
  // run lifecycle
  'run-launched',
  'stage-entered',
  'run-closed',
  ...SEAT_EVENTS,
  // spec + suite
  'spec-born',
  'spec-gate-round',
  'adversary-wave',
  'survivor-disposition',
  'red-state-check',
  'freeze',
  // verdict
  'layer-result',
  'flake',
  'finding',
  'repair-round',
  'stall',
  'fresh-pass',
  're-freeze',
  'operational-fix',
  // gate integrity (loud)
  'gate-integrity',
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
  'launch',
  'arming-changed',
  'config-changed',
  'factory-starvation',
  'tripwire-breach',
  'eval-review',
  ...SEAT_EVENTS,
  'resolved',
]);

export const ESCAPES_EVENTS = new Set(['escape-recorded', 'escape-fixed']);

// Stream classing. Every stream-classed append also lands as a pointer in
// the matching stream index. The full event lives only in its source ledger.
export const QUEUED_EVENTS = new Set(['park', 'tripwire-breach', 'eval-review']);
export const LOUD_EVENTS = new Set([
  'liveness-violation',
  'gate-integrity',
  'red-merge-breach',
  'factory-starvation',
]);

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
  'unkilled-gap-survivor', // adversary survivor without a killing test
  'second-zero-kill', // second 0/N adversary round
  'second-stall', // response ladder
  'card-invalidated', // ship-time card sweep
  'provisioning-gate',
]);

// Terminal run states. Every one of them stamps `run-closed`.
export const CLOSE_STATES = new Set(['shipped', 'failed', 'killed']);
