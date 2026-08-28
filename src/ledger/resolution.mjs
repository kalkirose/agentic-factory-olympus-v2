// Loud-item lifecycle: which event owns each loud record.
//
// A loud record is a request for the owner's eyes. It stops being one at the
// moment the event that answers it lands — the re-freeze that re-takes an
// artifact a capture took back, the merge that fires after a gate said it did
// not, the commit that clears a refusal. Waiting for the run to close instead
// leaves the strip holding finished business all day (ADR-0015).
//
// The table below is the whole answer, one entry per loud class. Every loud
// event in the registry has an entry, and an entry either names the ledger
// event that owns the record or says in `by` who else settles it. A class with
// an owner needs no call-site discipline: the sweep runs where the owning
// event is appended — the run ledger for a run-scoped class, the instance
// ledger for an instance-scoped one.
import { LOUD_EVENTS } from './registry.mjs';

/**
 * @typedef {object} OwnershipRule
 * @property {string} name the record class, for readers of this table
 * @property {(item: object) => boolean} [match] which records of the event
 *   type this rule covers; absent means all of them
 * @property {string} [owner] the ledger event that answers the record
 * @property {(item: object, owner: object) => boolean} [owns] whether a
 *   candidate owner answers this record; absent means the first one does
 * @property {(item: object) => object} [fields] payload the resolution carries
 * @property {string} [by] who settles a class no ledger event owns
 */

/** @type {Record<string, OwnershipRule[]>} */
export const LOUD_OWNERSHIP = {
  // A refusal blocked a capture, so the capture that got through answers it.
  // A take-back blocked nothing, and no later capture speaks to it: the frozen
  // surface it wrote to is re-taken by the verdict's re-freeze, and that is
  // the event that owns it (ADR-0017).
  'diff-policy-violation': [
    {
      name: 'refusal',
      match: (item) => (item.violations ?? []).length > 0,
      owner: 'implementation-committed',
    },
    {
      name: 'take-back',
      match: (item) => (item.violations ?? []).length === 0,
      owner: 're-freeze',
    },
  ],
  // One class per kind in `GATE_INTEGRITY_KINDS`, plus the seat's own harness
  // finding, which names a finding instead of a kind. A green-but-no-merge
  // alert is answered by the merge landing. A harness finding is answered by
  // the first verdict whose open set no longer holds it. The kinds a step
  // stamps on its own record are not here: they classify a record that already
  // has its owner, and a `diff-policy-violation` is owned by what it holds
  // rather than by the word for the defect it holds (ADR-0008).
  'gate-integrity': [
    {
      name: 'auto-merge',
      match: (item) => item.kind === 'auto-merge',
      owner: 'merged',
    },
    {
      name: 'harness-finding',
      match: (item) => typeof item.findingId === 'string',
      owner: 'verdict-rendered',
      owns: (item, render) => !(render.open ?? []).includes(item.findingId),
      fields: (item) => ({ findingId: item.findingId }),
    },
    // The request was open without the labels its diff asked for. The record
    // reports a window, and a window that has closed cannot be reopened by
    // anything: what it costs is a label check judging a bare request, so the
    // merge of that request is the evidence it cost nothing here. The count
    // stays in the ledger either way — that is what the record is for.
    {
      name: 'pr-label-missing',
      match: (item) => item.kind === 'pr-label-missing',
      owner: 'merged',
      owns: (item, merged) => merged.pr === item.pr,
      fields: (item) => ({ pr: item.pr }),
    },
    // A log the forge did not serve is evidence that is gone. No later stamp
    // brings it back and no route repairs it, so nothing in a ledger can
    // answer this record: the gate judged a red on the reason its log was
    // absent, and a human is the only reader who can decide what that cost.
    {
      name: 'triage-log-missing',
      match: (item) => item.kind === 'triage-log-missing',
      by: 'the human, from a console',
    },
    // The check answers both ways over a tree that never moved. A later green
    // is one more of the answers the record is about, and a red merge is the
    // cost rather than the answer, so nothing a ledger stamps settles it: the
    // reader who can go and look at the check is the one who closes it.
    {
      name: 'deterministic-red',
      match: (item) => item.kind === 'deterministic-red',
      by: 'the human, from a console',
    },
    // The layer died of memory. What answers that is the same layer judging
    // the tree again and passing — a raised ceiling, a bounded runner, a
    // smaller step — so the owner is that layer's own green, in this run.
    // A run that never gets one leaves the record open, which is the true
    // report: the layer is still dying and nobody has fixed it (ADR-0045).
    {
      name: 'resource-exhaustion',
      match: (item) => item.kind === 'resource-exhaustion',
      owner: 'layer-result',
      owns: (item, result) => result.layer === item.layer && result.status === 'green',
      fields: (item) => ({ layer: item.layer }),
    },
  ],
  // A red merge stays loud while the defect is still in the product. The
  // repair run's close-out fixes the escapes it ticketed, and pairs the
  // resolution back onto this record then — a cross-ledger owner, so the ship
  // lane does it rather than the run-ledger sweep (ADR-0024).
  'red-merge-breach': [{ name: 'breach', by: 'the escape fix of every escape it ticketed' }],
  // A threshold informs and asks nothing, so the run it reported on closing is
  // the whole of its life (ADR-0021).
  'budget-breach': [{ name: 'threshold', by: 'the run close' }],
  // The run stopped being a run. Nothing the run can stamp answers that.
  'liveness-violation': [{ name: 'stall', by: 'the human, from a console' }],
  // The run closed and its directory did not move. What answers that is the
  // move landing, so the owner is the archive stamp of the same run — the one
  // the next daemon start writes when it sweeps up what was left behind. A
  // different run reaching the archive says nothing about this one, which is
  // what the predicate holds (ADR-0015).
  'archive-failed': [
    {
      name: 'blocked-move',
      owner: 'run-archived',
      owns: (item, archived) => archived.runId === item.runId,
      fields: (item) => ({ runId: item.runId }),
    },
  ],
  // A red the workflow itself answers. The next completed run of the same
  // workflow, green, is the only evidence anybody could resolve this on, so
  // the recovery record carrying it is the owner rather than a human who read
  // one (ADR-0035). A green closes every open red of that workflow: the
  // workflow is passing or it is not.
  'workflow-red': [
    {
      name: 'watched-red',
      owner: 'workflow-recovered',
      owns: (item, recovered) =>
        recovered.project === item.project && recovered.workflow === item.workflow,
      fields: (item) => ({ project: item.project, workflow: item.workflow }),
    },
  ],
  // Instance-scoped, and both are conditions rather than records: the frontier
  // re-evaluates them on every sweep and pairs the resolution when the
  // condition lifts.
  'factory-starvation': [{ name: 'starvation', by: 'the frontier sweep' }],
  'repairs-owed': [{ name: 'owed', by: 'the frontier sweep' }],
};

/** The events that can answer a loud record. The engine's sweep key. */
export const OWNER_EVENTS = new Set(
  Object.values(LOUD_OWNERSHIP)
    .flat()
    .map((rule) => rule.owner)
    .filter(Boolean),
);

/**
 * The resolutions a ledger's own events already owe: every open loud record
 * whose owning event has landed behind it, in ledger order.
 * @param {object[]} events
 * @returns {{resolves: number, owner: string}[]}
 */
export function ownedResolutions(events) {
  const resolved = new Set(events.filter((e) => e.event === 'resolved').map((e) => e.resolves));
  const owed = [];
  for (const item of events) {
    if (!LOUD_EVENTS.has(item.event) || resolved.has(item.seq)) continue;
    for (const rule of LOUD_OWNERSHIP[item.event] ?? []) {
      if (!rule.owner) continue;
      if (rule.match && !rule.match(item)) continue;
      const owner = events.find(
        (e) => e.seq > item.seq && e.event === rule.owner && (rule.owns?.(item, e) ?? true),
      );
      if (!owner) continue;
      owed.push({ resolves: item.seq, owner: rule.owner, ...(rule.fields?.(item) ?? {}) });
      break;
    }
  }
  return owed;
}

/**
 * Pairs every resolution a store's own events owe. Idempotent: a record the
 * ledger already resolved is skipped, so a replay after a restart settles the
 * same set once.
 * @param {import('../telemetry/stores.mjs').TelemetryStore} store
 * @param {{actor: string}} opts
 */
export function settleOwnedLoud(store, { actor }) {
  for (const owed of ownedResolutions(store.events())) store.resolve({ actor, ...owed });
}
