// The seat map: model, effort, and tool policy per seat. Closed like the
// event registry: a new seat or a policy change enters only by a
// design-level decision recorded in an ADR, never ad hoc from a call site.
//
// Seats run Claude Opus 5 at xhigh effort. The certification spine (verdict
// triage, the Fury verifier over a code item, the eval seat) runs Claude Fable
// 5.1 at high,
// named through CERTIFICATION_MODEL and CERTIFICATION_EFFORT. FALLBACK_MODEL is the substitute a refused seat
// degrades to, and it names Opus 5: a certification seat whose model is refused
// runs on Opus 5 at the same effort, and a seat already on Opus 5 has no
// substitute below it, so its rejection is the failure. Effort is the cost
// control and stays constant inside a seat session: xhigh on every Opus 5
// seat, high on the three Fable 5.1 seats (ADR-0005).
export const DEFAULT_MODEL = 'claude-opus-5';
export const CERTIFICATION_MODEL = 'claude-fable-5-1';
export const FALLBACK_MODEL = DEFAULT_MODEL;
export const DEFAULT_EFFORT = 'xhigh';
export const CERTIFICATION_EFFORT = 'high';

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
  // pre-freeze: writes the decision records the validated spec decides, before
  // the suite is frozen and before any code exists. It reads the spec, the
  // record tree and the neighbourhood, and it writes documents, so it takes the
  // policy of the record writer beside it: no gate command, no web, no
  // subagents (ADR-0074).
  'record-author': seat(),
  suite: seat({ executesSuite: true }),
  adversary: seat(),
  // implementation
  dev: seat({ web: true, explore: 2, executesSuite: true }),
  'repair-dev': seat({ web: true, explore: 2, executesSuite: true }),
  // verdict. Which of the Fury seats a run spawns follows the project's
  // review panel: the code-shape seat sits out of the default panel and
  // returns with the lenses it carries (ADR-0038).
  'verdict-triage': seat({ model: CERTIFICATION_MODEL, effort: CERTIFICATION_EFFORT }),
  'fury-spec': seat(),
  'fury-code-shape': seat(),
  'fury-operational': seat(),
  'fury-interface': seat(),
  'fury-verifier': seat({ model: CERTIFICATION_MODEL, effort: CERTIFICATION_EFFORT }),
  // The verifier of a record item. It is the one verifier that reads no code
  // diff: it reads a decision record whole and the tree the record describes,
  // and it takes the model the rest of the records lane runs on. Its tool
  // policy is the code verifier's, the replay probe included (ADR-0005,
  // ADR-0042).
  'record-verifier': seat(),
  'generalist-review': seat(),
  // ship
  'card-sweep': seat(),
  // pre-ship: judges whether the run's own diff implements or contradicts any
  // decision record; read-only, reports only (ADR-0026)
  'reconcile-judge': seat(),
  // pre-ship: rewrites the judged records inside the run worktree, under the
  // rules the record tree binds its editors to. It writes documents and runs
  // no gate command, so it needs no suite credentials, no web and no
  // subagents: what it reads is one diff of one branch (ADR-0026).
  'reconcile-write': seat(),
  // pre-ship: judges one decision record whole, unit by unit, against the tree.
  // It reads one record and no diff, and it reports findings, so it takes the
  // policy of the review seat it stands beside (ADR-0073).
  'record-review': seat(),
  // close-out: writes the learning artifact for a shipped story, under the
  // instructions the project configured; optional, judges nothing, and writes
  // only inside the workspace it is given (ADR-0031)
  learning: seat(),
  // instance-scoped
  eval: seat({ model: CERTIFICATION_MODEL, effort: CERTIFICATION_EFFORT, instanceScoped: true }),
});

// A stage that dispatches one seat per record runs the same seat several times,
// and each dispatch owns its attempt budget, its cost line and its failure
// record. So a dispatch carries a slot suffix, `<seat>:<n>` from 1, and that
// whole name is the seat identity in the ledger. The map is keyed by the base
// name, because model, effort and tool policy are the seat's and not the
// slot's (ADR-0073).
const SLOT = /^[1-9][0-9]*$/;

/** The seat a name belongs to: everything before the slot suffix. */
export function seatBase(name) {
  const id = String(name);
  const at = id.indexOf(':');
  return at === -1 ? id : id.slice(0, at);
}

/** The slot a name carries, as a number, or null where it carries none. */
export function seatSlot(name) {
  const id = String(name);
  const at = id.indexOf(':');
  if (at === -1) return null;
  const slot = id.slice(at + 1);
  return SLOT.test(slot) ? Number(slot) : null;
}

/**
 * Resolves a seat definition from a seat name or a slotted seat name; an
 * unknown seat is an error, never a default. A suffix that is not a slot number
 * is an unknown seat too: the registry is closed on both halves of the name.
 */
export function seatDef(name) {
  const id = String(name);
  const def = SEATS[seatBase(id)];
  if (!def || (id.includes(':') && seatSlot(id) === null)) throw new Error(`unknown seat: ${id}`);
  return def;
}

/**
 * Whether a seat executes the project's suite. The one reader is the secret
 * strip at the spawn site, and it answers false for a name the map does not
 * hold: a seat nobody declared gets no credentials, which is the safe way to
 * be wrong about a security policy.
 */
export function seatExecutesSuite(name) {
  return SEATS[seatBase(name)]?.executesSuite === true;
}
