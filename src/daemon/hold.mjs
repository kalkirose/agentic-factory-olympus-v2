// The operator hold: the moment a maintainer asks for, in which no seat is
// live and nothing is lost. A hold interrupts nothing. Every run finishes the
// stage it is in, and the engine stops at the one place stages chain, so the
// factory drains itself down to boundaries and parks and then stands still
// until somebody releases it (ADR-0040).
//
// The state is a per-scope flag and nothing else. A scope is one project, or
// the instance — `hold --all`, which is what a restart takes. The two are
// separate statements and a run is held while either stands: a release ends
// the one it names, never both, because an operator who held the instance and
// then released one project asked for one project, and the instance hold is
// still the reason the rest of the factory is quiet.
//
// Nothing is held in memory that the ledger does not say. Every transition
// stamps `hold-changed`, and a start folds the stamps back, so a hold survives
// the restart it was taken for — which is the whole point of it.
import { readEvents } from '../ledger/ledger.mjs';

/** The scope of a hold over every project of the instance. */
export const INSTANCE_SCOPE = '*';

export class OperatorHold {
  /** @param {import('./daemon.mjs').Daemon} daemon */
  constructor(daemon) {
    this.daemon = daemon;
    this.scopes = new Map();
  }

  /** Rebuilds the hold state from the instance ledger. Runs at start. */
  replay() {
    this.scopes = holdState(readEvents(this.daemon.paths.instanceLedger));
  }

  /** Whether one scope is held. The instance scope is `INSTANCE_SCOPE`. */
  isScopeHeld(scope) {
    return this.scopes.get(scope) === true;
  }

  /** Whether a run of this project may enter its next stage. */
  isHeld(project) {
    return projectHeld(this.scopes, project);
  }

  /**
   * Applies a hold/release command. Idempotent: only a transition stamps, so a
   * second `hold` on a held project is not news and answers false.
   * @param {{project?: string, all?: boolean}} target
   * @param {boolean} held
   * @param {string} actor
   * @returns {boolean} whether this call changed the state
   */
  set({ project, all }, held, actor) {
    if (typeof actor !== 'string' || actor.length === 0) {
      throw new Error('a hold requires an actor');
    }
    if (all !== true && (typeof project !== 'string' || project.length === 0)) {
      throw new Error('a hold names one project (--project) or the instance (--all)');
    }
    if (all === true && project !== undefined) {
      throw new Error('a hold names one project or the instance, never both');
    }
    if (all !== true && project === INSTANCE_SCOPE) {
      // The instance scope is a key in the same fold, so a project of that
      // name would hold everything under a command that named one thing.
      throw new Error(`${INSTANCE_SCOPE} is the instance scope; hold it with --all`);
    }
    if (all !== true && !this.daemon.config.projects[project]) {
      throw new Error(`unknown project: ${project}`);
    }
    const scope = all === true ? INSTANCE_SCOPE : project;
    if (this.isScopeHeld(scope) === held) return false;
    this.scopes.set(scope, held);
    this.daemon.ledger.append('hold-changed', {
      actor,
      held,
      ...(all === true ? { all: true } : { project }),
    });
    return true;
  }
}

/**
 * The hold state a console reads, folded from an instance ledger the same way
 * the daemon folds it. The map is keyed by scope, with `INSTANCE_SCOPE` for the
 * instance-wide hold.
 * @param {object[]} events the instance ledger, in order
 * @returns {Map<string, boolean>}
 */
export function holdState(events) {
  const scopes = new Map();
  for (const e of events) {
    if (e.event === 'hold-changed') {
      scopes.set(e.all === true ? INSTANCE_SCOPE : e.project, e.held === true);
    }
  }
  return scopes;
}

/** Whether a project's runs are held, from a folded state. */
export function projectHeld(scopes, project) {
  return scopes.get(INSTANCE_SCOPE) === true || scopes.get(project) === true;
}
