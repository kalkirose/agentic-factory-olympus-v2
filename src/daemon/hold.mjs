// The operator hold: the moment a maintainer asks for, in which no seat is
// live and nothing is lost. A hold interrupts nothing. Every run finishes the
// stage it is in, and the engine stops at the one place stages chain, so the
// factory drains itself down to boundaries and parks and then stands still
// until somebody releases it (ADR-0040).
//
// There are three scopes and they are three separate statements: one run
// (`hold --run`), one project (`hold --project`), and the instance
// (`hold --all`, which is what a restart takes). A run is held while any of
// them stands, so the widest hold governs and a release ends the one it names.
// An operator who held the instance and then released one project asked for one
// project, and the instance hold is still the reason the rest of the factory is
// quiet; an operator who released a project never asked to free the one run
// they had stopped by hand, so that run stays stopped (ADR-0057).
//
// The two wide scopes are flags in the instance ledger. A run's own hold is a
// stamp in that run's ledger, where the run's other state already lives, so it
// travels with the run and needs no index of its own.
//
// Nothing is held in memory that a ledger does not say. Every transition
// stamps, and a start folds the stamps back, so a hold survives the restart it
// was taken for, which is the whole point of it.
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
   * @param {{runId?: string, project?: string, all?: boolean}} target
   * @param {boolean} held
   * @param {string} actor
   * @returns {boolean} whether this call changed the state
   */
  set({ runId, project, all }, held, actor) {
    if (typeof actor !== 'string' || actor.length === 0) {
      throw new Error('a hold requires an actor');
    }
    const named = [runId !== undefined, project !== undefined, all === true].filter(Boolean);
    if (named.length > 1) {
      throw new Error('a hold names one run, one project or the instance, never two of them');
    }
    if (named.length === 0) {
      throw new Error(
        'a hold names one run (--run), one project (--project) or the instance (--all)',
      );
    }
    if (runId !== undefined) return this.setRun(runId, held, actor);
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

  /**
   * One run's own hold. The stamp lands in that run's ledger, through the
   * engine that owns it, so a per-run hold reads and replays exactly where the
   * rest of the run's state does.
   *
   * A release is refused while a wider hold stands. Lifting the narrow one
   * under the wide one would answer the operator with a run that still cannot
   * move, and the operator would read the release as a release; the refusal
   * names the hold that is actually stopping the run, so the next command is
   * the right one (ADR-0057).
   * @returns {boolean} whether this call changed the run
   */
  setRun(runId, held, actor) {
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new Error('a run hold names one run (--run <id>)');
    }
    const run = this.daemon.engine?.runs.get(runId);
    if (!run || run.closed) throw new Error(`unknown open run: ${runId}`);
    if (!held) {
      if (this.isScopeHeld(INSTANCE_SCOPE)) {
        throw new Error(
          `run ${runId} is held by the instance hold; release --all before this run`,
        );
      }
      if (this.isScopeHeld(run.project)) {
        throw new Error(
          `run ${runId} is held by the ${run.project} project hold; ` +
            `release --project ${run.project} before this run`,
        );
      }
    }
    return this.daemon.engine.setRunHold(runId, held, actor);
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
