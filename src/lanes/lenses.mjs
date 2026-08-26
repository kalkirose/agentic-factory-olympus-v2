// The review lens vocabulary: what a judgment seat looks for, which lenses the
// verdict panel carries, and which Fury seat carries which lens. Closed like
// the event registry — a lens enters the vocabulary, moves seat, or leaves the
// default panel by a design decision recorded in an ADR, never from a call
// site (ADR-0038).
//
// Data only, and it imports nothing: the review machinery reads it to build the
// panel, and the project-config validator reads it to refuse a lens name the
// panel could not spawn. Neither module can import the other.

/** Every lens the review implements, in panel order. */
export const ALL_LENSES = Object.freeze([
  'spec',
  'architecture',
  'minimality',
  'operational',
  'security',
  'interface',
]);

/**
 * The panel a project gets when it declares none. Architecture and minimality
 * are out of it: across ten ships they raised 82 findings and the verifier
 * confirmed none, so the two seats' worth of work bought no block (ADR-0038).
 * A project restores them by naming them in `review.lenses`.
 */
export const DEFAULT_LENSES = Object.freeze(['spec', 'operational', 'security', 'interface']);

/**
 * The dimensions a security probe covers. The verdict panel reads them as one
 * lens over the candidate diff; the adversary waves read them as directions to
 * be wrong in, so the frozen suite grows tests that hold them (ADR-0038). One
 * list, so the two surfaces cannot drift apart.
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
