// The review lens vocabulary: what a judgment seat looks for, which lenses the
// verdict panel carries, and which Fury seat carries which lens. Closed like
// the event registry — a lens enters the vocabulary, moves seat, or leaves the
// default panel by a design decision recorded in an ADR, never from a call
// site (ADR-0038).
//
// Data only, and it imports nothing: the review machinery reads it to build the
// panel, and the project-config validator reads it to refuse a lens name the
// panel could not spawn. Neither module can import the other.

/** Every code lens the review implements, in panel order. */
export const ALL_LENSES = Object.freeze([
  'spec',
  'architecture',
  'minimality',
  'operational',
  'security',
  'interface',
]);

/**
 * The lens a decision record is read through. It is not a panel choice: a
 * project cannot name it in `review.lenses` and no seat spawns for it. The diff
 * decides it. A review whose whole diff is record files carries this lens and
 * no code lens, and a mixed diff carries it beside the panel's (ADR-0038).
 */
export const RECORD_LENS = 'record';

/**
 * What a decision record is held to, keyed. A record finding names the key it
 * fails, the verifier is briefed with the key and the list, and a finding whose
 * evidence does not reach its key is refuted. Data only, and closed like the
 * lens vocabulary beside it: a criterion enters by a recorded decision.
 *
 * Every record brief states it: the review seat that reads one record, the
 * verifier over a record item, and the three briefs of the seat that writes the
 * records. The writer is a reader because it is judged against this list, and a
 * paraphrase in its brief would drift from the list the review holds it to
 * (ADR-0038).
 *
 * The list is the harness's own. A project rule about record text is that
 * project's gate, not a criterion here.
 */
export const RECORD_CRITERIA = Object.freeze({
  truth:
    'truth: every present-tense claim in the record is true against the tree as it stands: what ' +
    'the code does, where it lives, what it is called. A part the tree does not hold is stated ' +
    'as not built. A divergence between the tree and the decision is named in the record. Every ' +
    'name the record cites means what the record says it means. A claim the tree contradicts ' +
    'fails, whether the sentence changed in this diff or not.',
  consistent:
    'consistent: an open part of this record does not contradict an open part of any active ' +
    'record in its neighbourhood. The tree settles what is built and settles nothing about ' +
    'what is not, so two active records can decide one unbuilt part two ways.',
  form:
    'form: a defect of the project standard the form gate cannot read, by rule number. The gate ' +
    'reads the form it can read, at every render; this criterion is what is left.',
});

/** The criterion keys, in the order the briefs and the schema state them. */
export const RECORD_CRITERION_KEYS = Object.freeze(Object.keys(RECORD_CRITERIA));

/**
 * The rule the seven criteria serve, stated above them wherever they are
 * stated.
 *
 * A seat that is given a list of criteria and no rule behind them grades each
 * sentence against the nearest key and stops. The rule is what tells it that a
 * sentence about work nobody has done yet is legal, and that the same sentence
 * written as present fact is not: a record either describes the tree as it
 * stands, or says the part is not built. There is no third kind of claim, and a
 * record that holds one conflicts with the code.
 *
 * The last sentence names the sentences that claim nothing. A record states why
 * it decided, what it rejected and what would reverse it, and none of those is
 * a claim about the tree. It is rationale, and the criteria say nothing against
 * it.
 */
export const RECORD_RULE =
  'A record never conflicts with the code. Everything it states is either true of the tree now, ' +
  'or marked as not yet built. There is no third kind of claim. A sentence that states why, or ' +
  'what was rejected, or what would trigger a reversal, is rationale and is neither.';

/** The criteria as a brief states them: the rule, then one line per criterion. */
export function recordCriteriaLines() {
  return [RECORD_RULE, ...RECORD_CRITERION_KEYS.map((key) => `- ${RECORD_CRITERIA[key]}`)];
}

/**
 * The ground duty, stated once for every brief that asks a seat for a finding.
 *
 * The ground is what decides whether a finding survives a moved base. A merge
 * that touches ground the finding rests on costs the run its code
 * certification; a merge that touches nothing the finding names leaves the
 * certification standing. A finding with no ground answers that question for
 * nothing, so every claim in the project has to re-earn itself.
 *
 * Paths, and not package names: a package is not a file of this repository and
 * no diff can be compared against it, while the manifest that declares it and
 * the file that imports it both are. A sentence is not a path either, so the
 * duty names the one legal form for a finding whose subject is the whole tree:
 * the glob every file matches. It is a claim that stands only while nothing at
 * all moves, and stating it that way makes the cost visible to the seat that
 * makes it, which a phrase like "the whole repository" never could.
 */
export const FINDING_GROUND_DUTY = Object.freeze([
  'Name the ground of every finding in "ground": the repo-relative paths or directories the',
  'finding is about, one entry each. Every entry is a path this tree holds, or a glob over such',
  'paths; a finding about a file the diff deletes names the directory it stood in. A finding',
  'about a package names the manifest that declares it or the file that imports it. A finding',
  'whose subject is the whole tree names "**", the one whole-tree ground, and it stands only',
  'while nothing at all moves. A finding that names no ground is refused, and so is an entry',
  'this tree has nothing at.',
]);

/**
 * The panel a project gets when it declares none. Architecture and minimality
 * are out of it: across ten ships they raised 82 findings and the verifier
 * confirmed none, so the two seats' worth of work bought no block (ADR-0038).
 * A project restores them by naming them in `review.lenses`.
 */
export const DEFAULT_LENSES = Object.freeze(['spec', 'operational', 'security', 'interface']);

/**
 * The dimensions a security probe covers, and one definition of them with
 * several readers (ADR-0038, ADR-0072). The verdict panel reads them as one
 * lens over the candidate diff. Every suite write reads them twice, once in
 * the brief that asks the seat to map the story's surface along them and once
 * in the deterministic check over the map that comes back, and the story lane
 * and the verdict lane each hold one of those two pairs. One list, so no
 * reader can narrow what another one still probes.
 *
 * They are not project config. A project that drops the security lens from its
 * verdict panel still gets the dimensions in every suite brief, because they
 * ride the map rule and not the panel.
 */
export const SECURITY_DIMENSIONS = Object.freeze([
  'authorization on every entry point',
  'input trust',
  'secrets',
  'trust boundaries',
]);

/** What each lens asks of a diff, as the role blocks state it. */
export const LENS_CRITERIA = Object.freeze({
  spec: 'spec: the diff implements exactly the validated spec — nothing missing, nothing extra.',
  architecture: 'architecture: placement, coupling, abstraction, domain language.',
  minimality: 'minimality: reinvention, unearned generality, dead weight, comment discipline.',
  operational: 'operational: failure paths, data-layer discipline, idempotency, observability.',
  security: `security: ${SECURITY_DIMENSIONS.join(', ')}.`,
  interface: 'interface: rendered screens against the design reference.',
});

/**
 * Which Fury seat carries which lens. Security rides the operational seat
 * rather than one of its own: one confirmed HIGH across ten ships does not pay
 * for a seat, and a lens on a seat that runs keeps the route a security defect
 * on the candidate needs to block a ship (ADR-0038).
 */
const SEAT_LENSES = Object.freeze({
  'fury-spec': ['spec'],
  'fury-code-shape': ['architecture', 'minimality'],
  'fury-operational': ['operational', 'security'],
  'fury-interface': ['interface'],
});

/**
 * The lenses one project config puts on the panel, in panel order. An absent
 * `review.lenses` takes the default panel; a declared one replaces it, which is
 * how a cut lens comes back.
 */
export function panelLenses(config) {
  const declared = config?.review?.lenses;
  const active = new Set(Array.isArray(declared) ? declared : DEFAULT_LENSES);
  return ALL_LENSES.filter((lens) => active.has(lens));
}

/**
 * Seat → the lenses it carries, over an active set. A seat whose every lens is
 * out of the set is absent from the panel: nothing assembles it, and no seat
 * spawns to report on nothing.
 *
 * The record lens has no entry here and never gets one: it rides the generalist
 * seat, which is the seat every record diff is reviewed by.
 */
export function furyPanel(lenses) {
  const active = new Set(lenses);
  const panel = {};
  for (const [seat, carried] of Object.entries(SEAT_LENSES)) {
    const kept = carried.filter((lens) => active.has(lens));
    if (kept.length > 0) panel[seat] = kept;
  }
  return panel;
}
