// Finding acknowledgments: the standing statement that one harness defect is
// known, is held elsewhere, and does not block a run.
//
// A finding has no identity past the run that raised it — the id is per-run
// bookkeeping — so an ack keys on a fingerprint. There are two of them here,
// for two readers.
//
// `ackFingerprint` is the identity a gate keys on: the defect's class and its
// subject, where the subject of a triage finding is the gate layer whose
// machinery holds the defect. A second triage seat writing a second sentence
// about the same layer reaches the same fingerprint, so a reworded recurrence
// of an acknowledged defect answers itself instead of costing the operator the
// question they already answered.
//
// `findingFingerprint` is what the finding says: its class, its summary and
// its evidence, normalized. It is the identity of a statement rather than of a
// defect, so the progress guards keep it — two findings that differ in words
// are two findings to a guard asking whether a repair round closed anything —
// and an ack recorded before the identity form existed still stands under it.
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

// What keeps an identity digest apart from a prose digest of the same class.
// Both are `<class>:<12 hex>` on the record, and a reader that meets one has
// no way to ask which it is; the tag makes the two spaces disjoint, so no
// identity can be mistaken for the words of some other finding.
const SUBJECT_TAG = 'subject';

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
  return `${classOf(finding)}:${digest([
    classOf(finding),
    normalize(finding?.summary),
    normalize(finding?.evidence),
  ])}`;
}

/**
 * The identity a gate keys an ack on: the defect's class and its subject.
 *
 * The subject is the gate layer the finding names. A harness finding says the
 * machinery that judges one layer is broken, and that is the thing an operator
 * answers for — not the sentence a seat wrote about it. Two triage seats
 * describing one broken layer write two sentences and mean one defect, and the
 * words drift with every run: a different check name in the evidence, a
 * different file the failure landed on, a different half of the same
 * explanation. Hashing the words made every drift a new question at the gate.
 *
 * A finding that names no layer has no subject to key on, so its words stay
 * its identity and it falls back to `findingFingerprint`.
 *
 * The layer set is sorted and de-duplicated, so an ack does not turn on the
 * order a seat listed a cluster in.
 *
 * @param {{class?: string, layers?: string[], summary?: string, evidence?: string}} finding
 * @returns {string} `<class>:<hex>`, the same shape a prose fingerprint carries
 */
export function ackFingerprint(finding) {
  const layers = [
    ...new Set(
      (Array.isArray(finding?.layers) ? finding.layers : [])
        .filter((l) => typeof l === 'string' && l.trim().length > 0)
        .map((l) => l.trim().toLowerCase()),
    ),
  ].sort();
  if (layers.length === 0) return findingFingerprint(finding);
  return `${classOf(finding)}:${digest([SUBJECT_TAG, classOf(finding), layers.join(' ')])}`;
}

/**
 * Every fingerprint an ack of this finding may stand under, most stable first:
 * the identity, then the words. The second form is what an ack recorded before
 * the identity existed was keyed on, and a defect nobody fixed is not answered
 * differently because the harness learned a better key for it. A finding whose
 * two forms agree — one that names no layer — offers the one.
 */
export function ackForms(finding) {
  const identity = ackFingerprint(finding);
  const words = findingFingerprint(finding);
  return identity === words ? [identity] : [identity, words];
}

function classOf(finding) {
  return typeof finding?.class === 'string' ? finding.class : 'unclassed';
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
 *
 * Coverage is asked of every form the finding answers to, so an ack recorded
 * under the words a run wrote months ago still answers the gate it was
 * recorded at. The ack that is found is returned whole, with the fingerprint
 * it was recorded under, because that is the fingerprint a revoke will name.
 * @param {Map<string, object>} standing
 * @param {object} finding
 */
export function coveringAck(standing, finding) {
  if (!isAckable(finding)) return null;
  for (const form of ackForms(finding)) {
    const ack = standing.get(form);
    if (ack) return ack;
  }
  return null;
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
