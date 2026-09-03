// The seat map: model, effort, and tool policy per seat. Closed like the
// event registry: a new seat or a policy change enters only by a
// design-level decision recorded in an ADR, never ad hoc from a call site.
//
// Seats run Claude Opus 5 at high effort. The certification spine (verdict
// triage, the Fury verifier, the eval seat) runs Claude Fable 5.1, named
// through CERTIFICATION_MODEL. FALLBACK_MODEL is the substitute a refused seat
// degrades to, and it names Opus 5: a certification seat whose model is refused
// runs on Opus 5 at the same effort, and a seat already on Opus 5 has no
// substitute below it, so its rejection is the failure. Effort is the cost
// control and stays constant inside a seat session; the floor is high, and no
// seat sits below it (ADR-0005).
export const DEFAULT_MODEL = 'claude-opus-5';
export const CERTIFICATION_MODEL = 'claude-fable-5-1';
export const FALLBACK_MODEL = DEFAULT_MODEL;
export const DEFAULT_EFFORT = 'high';

// web: web search allowed (spec birth and the two dev seats only).
// explore: max read-only Explore subagents; 0 = all subagents banned.
// instanceScoped: runs without a worktree or a stack, stamps to the
// instance ledger.
// executesSuite: the seat runs the project's gate and suite commands to check
// its own work, so it needs whatever credentials those commands need. It is
// the one policy the machine's secrets follow (ADR-0023).
function seat(overrides = {}) {
  return Object.freeze({
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    web: false,
    explore: 0,
    instanceScoped: false,
    executesSuite: false,
    ...overrides,
  });
}

export const SEATS = Object.freeze({
  // story lane, pre-freeze
  'spec-birth': seat({ web: true }),
  'spec-gate': seat(),
  suite: seat({ executesSuite: true }),
  adversary: seat(),
  // implementation
  dev: seat({ web: true, explore: 2, executesSuite: true }),
  'repair-dev': seat({ web: true, explore: 2, executesSuite: true }),
  // verdict. Which of the Fury seats a run spawns follows the project's
  // review panel: the code-shape seat sits out of the default panel and
  // returns with the lenses it carries (ADR-0038).
  'verdict-triage': seat({ model: CERTIFICATION_MODEL }),
  'fury-spec': seat(),
  'fury-code-shape': seat(),
  'fury-operational': seat(),
  'fury-interface': seat(),
  'fury-verifier': seat({ model: CERTIFICATION_MODEL }),
  'generalist-review': seat(),
  // ship
  'card-sweep': seat(),
  // close-out: judges whether the shipped diff implements or contradicts any
  // decision record; read-only, reports only (ADR-0026)
  'reconcile-judge': seat(),
  // close-out: writes the learning artifact for a shipped story, under the
  // instructions the project configured; optional, judges nothing, and writes
  // only inside the workspace it is given (ADR-0031)
  learning: seat(),
  // instance-scoped
  eval: seat({ model: CERTIFICATION_MODEL, instanceScoped: true }),
});

/** Resolves a seat definition; an unknown seat is an error, never a default. */
export function seatDef(name) {
  const def = SEATS[name];
  if (!def) throw new Error(`unknown seat: ${name}`);
  return def;
}

/**
 * Whether a seat executes the project's suite. The one reader is the secret
 * strip at the spawn site, and it answers false for a name the map does not
 * hold: a seat nobody declared gets no credentials, which is the safe way to
 * be wrong about a security policy.
 */
export function seatExecutesSuite(name) {
  return SEATS[name]?.executesSuite === true;
}
