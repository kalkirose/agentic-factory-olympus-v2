// The seat map: model, effort, and tool policy per seat. Closed like the
// event registry — a new seat or a policy change enters only by a
// design-level decision recorded in an ADR, never ad hoc from a call site.
//
// Default: Opus 5 at xhigh, all seats. Named exceptions run on Fable 5 at
// xhigh: verdict triage, the Fury verifier, and the eval seat — the
// certification spine. Effort is the cost control and stays constant inside
// a seat session; no seat sits below xhigh.
export const DEFAULT_MODEL = 'claude-opus-5';
export const CERTIFICATION_MODEL = 'claude-fable-5';
export const DEFAULT_EFFORT = 'xhigh';

// web: web search allowed (spec birth and the two dev seats only).
// explore: max read-only Explore subagents; 0 = all subagents banned.
// instanceScoped: runs without a worktree or a stack, stamps to the
// instance ledger.
function seat(overrides = {}) {
  return Object.freeze({
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    web: false,
    explore: 0,
    instanceScoped: false,
    ...overrides,
  });
}

export const SEATS = Object.freeze({
  // story lane, pre-freeze
  'spec-birth': seat({ web: true }),
  'spec-gate': seat(),
  suite: seat(),
  adversary: seat(),
  // implementation
  dev: seat({ web: true, explore: 2 }),
  'repair-dev': seat({ web: true, explore: 2 }),
  // verdict
  'verdict-triage': seat({ model: CERTIFICATION_MODEL }),
  'fury-spec': seat(),
  'fury-code-shape': seat(),
  'fury-operational': seat(),
  'fury-security': seat(),
  'fury-interface': seat(),
  'fury-verifier': seat({ model: CERTIFICATION_MODEL }),
  'generalist-review': seat(),
  // ship
  'card-sweep': seat(),
  // instance-scoped
  eval: seat({ model: CERTIFICATION_MODEL, instanceScoped: true }),
});

/** Resolves a seat definition; an unknown seat is an error, never a default. */
export function seatDef(name) {
  const def = SEATS[name];
  if (!def) throw new Error(`unknown seat: ${name}`);
  return def;
}
