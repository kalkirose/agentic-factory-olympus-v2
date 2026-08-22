// Finding acknowledgments: the standing statement that one harness defect is
// known, is held elsewhere, and does not block a run.
//
// A finding has no identity past the run that raised it — the id is per-run
// bookkeeping — so an ack keys on a fingerprint derived from what the finding
// says: its class, its summary and the source its evidence cites, all
// normalized. The same defect, raised again by a fresh triage seat in another
// run, reaches the same fingerprint. That is the whole point: the operator
// answered the question once, and the second gate is the same question.
//
// Acks are derived, never stored. The instance ledger's `finding-ack` and
// `finding-ack-revoked` events are the record, and a standing ack is an ack
// with no later revoke of the same project and fingerprint behind it. A
// restart re-derives the same set from the same file, because a restart
// proves nothing about a defect nobody fixed.
import { createHash } from 'node:crypto';
import { readEvents } from './ledger.mjs';

/** The option that answers a gate and records what the gate named. */
export const ACK_OPTION = 'ack';

// The classes an ack may cover. A harness finding is a defect of the machinery
// that judges, and the harness team already holds it; the second gate for it
// asks the operator a question they have answered.
//
// Nothing else is coverable. An env finding is a statement about this host at
// this moment, and the host changes under the harness between two runs — the
// gate is there so a human looks. A code-defect or suite-defect finding is a
// statement about the product, and no standing answer covers one: a product
// defect is what the run exists to find.
export const ACKABLE_CLASSES = new Set(['harness']);

const FINGERPRINT_HEX = 12;

/** True when a finding's class may be covered by an ack at all. */
export function isAckable(finding) {
  return ACKABLE_CLASSES.has(finding?.class);
}

/**
 * The stable identity of a finding across cycles, runs and restarts: its
 * class, its normalized summary and its normalized evidence, digested.
 * @param {{class?: string, summary?: string, evidence?: string}} finding
 * @returns {string} `<class>:<hex>` — readable enough to carry in a park line
 *   and in a revoke command
 */
export function findingFingerprint(finding) {
  const cls = typeof finding?.class === 'string' ? finding.class : 'unclassed';
  return `${cls}:${digest([cls, normalize(finding?.summary), normalize(finding?.evidence)])}`;
}

/**
 * The identity of a finding record that carries no class and no id of its own
 * — a spec-gate finding, named by the section it sits in and the defect it
 * states. Its words are the identity as written, and only case and whitespace
 * are normalized away: a gate round carries the previous round's findings
 * verbatim (ADR-0020), so a defect that is still open comes back in the text
 * that raised it, and one stated differently is a different statement. The
 * incidentals a triage fingerprint normalizes out are the identity here —
 * "claim 1" and "claim 2" are two findings, not one raised twice.
 * @param {...string} parts
 */
export function textIdentity(...parts) {
  return digest(parts.map(flatten));
}

function flatten(text) {
  return typeof text === 'string' ? text.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

function digest(parts) {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, FINGERPRINT_HEX);
}

// What a second run says differently about the same defect: another run id in
// a path, another line number, another exit code, another sha. None of it is
// the defect, so none of it reaches the digest. A path keeps its last segment
// alone — the file that carries the defect, without the home, the worktree or
// the run that held it. What survives is the words.
function normalize(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[a-z]:\//g, '/')
    .replace(/(?:[^\s/]+\/)+([^\s/]*)/g, '$1')
    .replace(/\b[0-9a-f]{7,}\b/g, '#')
    .replace(/\d+/g, '#')
    .replace(/[^a-z#]+/g, ' ')
    .trim();
}

/**
 * The acks standing for one project, fingerprint → the `finding-ack` event
 * that recorded it. Folded from the instance ledger in order, so a revoke
 * removes exactly the fingerprint it names and leaves every other ack
 * standing.
 * @param {Array<object>} events the instance ledger, in order
 * @param {string} project
 * @returns {Map<string, object>}
 */
export function standingAcks(events, project) {
  return fold(events).get(project) ?? new Map();
}

/** Every standing ack on the instance, for the console's read. */
export function standingAckList(events) {
  return [...fold(events).values()].flatMap((acks) => [...acks.values()]);
}

/** @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths */
export function standingAcksFor(paths, project) {
  return standingAcks(readEvents(paths.instanceLedger), project);
}

/**
 * The ack that covers a finding, or null. The class rule is enforced here
 * rather than at the recording sites, so no caller can reach coverage for a
 * class an ack may not cover.
 * @param {Map<string, object>} standing
 * @param {object} finding
 */
export function coveringAck(standing, finding) {
  if (!isAckable(finding)) return null;
  return standing.get(findingFingerprint(finding)) ?? null;
}

function fold(events) {
  const byProject = new Map();
  for (const e of events ?? []) {
    const recorded = e.event === 'finding-ack';
    if (!recorded && e.event !== 'finding-ack-revoked') continue;
    if (typeof e.project !== 'string' || typeof e.fingerprint !== 'string') continue;
    if (!byProject.has(e.project)) byProject.set(e.project, new Map());
    const acks = byProject.get(e.project);
    if (recorded) acks.set(e.fingerprint, e);
    else acks.delete(e.fingerprint);
  }
  return byProject;
}
