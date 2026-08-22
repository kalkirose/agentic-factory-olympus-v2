// Progress-keyed cycling: what a verdict cycle is fingerprinted on, and the
// one automatic retry a repeated fingerprint spends.
//
// A cycle's outcome is fixed by four things and nothing else: the tree it
// judges, the suite it judges it against, the findings it carries in, and —
// for a verdict the CI checks rendered — the state of those checks. Two cycles
// that agree on all four cannot end differently, so the second one is a re-run
// of the first and the third is a loop. The exception is on the record rather
// than in the fingerprint: a human's answer says a substrate changed where no
// component of this can see it, and it grants the cycle that tests the claim.
//
// Counts are never the key. A cap prices repetition and persistence the same
// way, so a hard story that moves something every cycle pays for the loops of
// the story before it. A fingerprint prices repetition alone: productive
// cycles are unlimited, and a futile one is over at the third (ADR-0022).
//
// The open findings enter by identity, never by id and never by count. A
// triage seat that finds the same defect again gives it a fresh id every
// cycle, so an id-keyed set reads six identical cycles as six different ones —
// which is exactly how six of them ran.
import { createHash } from 'node:crypto';
import { findingFingerprint } from './acks.mjs';

const FINGERPRINT_HEX = 12;

/** The automatic re-runs one subject is entitled to before it escalates. */
export const RERUN_BUDGET = 1;

/**
 * Whether a budget stands open, given what its subject has spent as ledger
 * seqs in order, and the seq of the last grant behind it. A grant stamped
 * after everything the subject spent earns the next one — an operational fix
 * on the ship path, a human's `retry` at a park — because the grant is a
 * deliberate act and the re-run is the test of it. Nothing else refreshes a
 * budget: a moved head sha, a fresh attempt, another cycle of the same loop.
 */
export function budgetOpen(spent, granted) {
  if (spent.length < RERUN_BUDGET) return true;
  return granted > spent[spent.length - 1];
}

/**
 * The fingerprint of one rendered verdict: the implementation pass, the
 * candidate sha, the suite sha, the open findings by identity, and — on a
 * verdict the CI checks rendered — the conclusion of every check on that head
 * sha. Derived from the ledger alone, so a restart re-reads the same
 * fingerprint for the same render.
 *
 * The pass is in there because a fresh pass can rebuild a tree byte for byte
 * and, committed in the same second onto the same parent, reach the same sha.
 * That run has not looped: it has spent a bounded resource the response ladder
 * grants once and a human grants after that, and the ladder's own ceiling —
 * the second stall — is the better question to put to the owner. Every other
 * route holds the pass still, so a loop cannot buy a new fingerprint with it.
 * @param {Array<object>} events the run ledger, in order
 * @param {object} render a `verdict-rendered` line
 */
export function cycleFingerprint(events, render) {
  return createHash('sha256')
    .update(
      [
        `pass ${render.pass ?? ''}`,
        `sha ${render.sha ?? ''}`,
        `suite ${render.suiteSha ?? ''}`,
        `open ${openIdentities(events, render).join(',')}`,
        `checks ${checkState(events, render).join(',')}`,
      ].join('\n'),
    )
    .digest('hex')
    .slice(0, FINGERPRINT_HEX);
}

/**
 * What to do with the cycle a response ladder is about to act on.
 * `proceed` — the fingerprint is new, or this render already holds its retry.
 * `retry` — it repeats a fingerprint the run has judged before, and the budget
 * is open: one more cycle, spent from the budget, because the cheapest
 * explanation of a repeat is a flake.
 * `park` — the retry is spent and the repeat came back anyway.
 * @param {Array<object>} events the run ledger, in order
 * @param {Array<object>} renders every `verdict-rendered` line in it
 * @param {object} last the render the ladder is acting on
 */
export function cycleRepeat(events, renders, last) {
  const fingerprint = cycleFingerprint(events, last);
  const occurrences = renders
    .filter((r) => r.seq <= last.seq && cycleFingerprint(events, r) === fingerprint)
    .map((r) => ({ cycle: r.cycle, seq: r.seq, ...(r.record && { record: r.record }) }));
  if (occurrences.length < 2) return { fingerprint, occurrences, action: 'proceed' };
  // One render earns one retry. The ladder re-derives its position from the
  // ledger at every entry, and a retry already granted for this render is a
  // decision, not a question to ask again.
  if (events.some((e) => e.event === 'cycle-retry' && e.render === last.seq)) {
    return { fingerprint, occurrences, action: 'proceed' };
  }
  const spent = events
    .filter((e) => e.event === 'cycle-retry' && e.fingerprint === fingerprint)
    .map((e) => e.seq);
  return {
    fingerprint,
    occurrences,
    action: budgetOpen(spent, lastAnswered(events)) ? 'retry' : 'park',
  };
}

/**
 * The open findings of a render, by identity, in a stable order. One
 * derivation serves both progress guards: this file asks whether two cycles
 * carry the same set, and the repair ladder asks whether a round closed
 * anything in it (ADR-0022). Neither invents a second identity.
 * @param {Array<object>} events the run ledger, in order
 * @param {object} render a `verdict-rendered` line
 */
export function openIdentities(events, render) {
  const open = new Set(render.open ?? []);
  const identities = [];
  for (const e of events) {
    if (e.event !== 'finding' || e.advisory || !open.has(e.id)) continue;
    identities.push(findingFingerprint(e));
  }
  return identities.sort();
}

/**
 * The external check state a CI verdict rests on: the last conclusion the
 * ledger stamped for every check of that head sha, as of that render. A local
 * verdict rests on no external state, so it carries none.
 */
function checkState(events, render) {
  if (render.source !== 'ci') return [];
  const state = new Map();
  for (const e of events) {
    if (e.seq > render.seq) break;
    if (e.event !== 'check-transition' || e.sha !== render.sha) continue;
    state.set(e.check, e.status);
  }
  return [...state]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([check, status]) => `${check}=${status}`);
}

/**
 * The seq of the run's most recent answered park. Any answer is a deliberate
 * act by somebody who sees what the harness cannot — a substrate repaired by
 * hand, a gate cleared, a decision taken outside the tree — so it grants the
 * next cycle exactly as an operational fix grants the next check re-run. The
 * ordering is what makes it a grant and not a standing permission: an answer
 * older than the retry already spent refreshes nothing.
 */
function lastAnswered(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === 'answer') return events[i].seq;
  }
  return 0;
}
