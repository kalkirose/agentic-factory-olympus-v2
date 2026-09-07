// The lane graph the daemon runs: story, repair and records, assembled from the
// lane composers. The daemon registers lanes once at start, so the graph is
// built once — but one instance holds many projects, and each project ships to
// its own repository. The forge is therefore resolved per run from the run's
// project, out of the live instance config; nothing here binds a repository
// at assembly time.
import { storyLane } from './story.mjs';
import { postFreeze, repairLane } from './verdict.mjs';
import { recordsLane } from './records-stage.mjs';
import { shipStep } from './ship.mjs';
import { gitHubForge, parseGitHubRepo } from '../ship/forge.mjs';

/**
 * Builds the forge of one project from an instance config. The gh argv is
 * instance config (`ghCommand`): it describes the machine, like
 * `composeCommand` and `claudeCommand`.
 * @param {object} config an instance config with defaults filled
 * @param {string} project
 * @param {{runner?: Function}} [opts] `runner` substitutes the gh child
 *   process (tests only).
 */
export function projectForge(config, project, { runner } = {}) {
  const entry = config?.projects?.[project];
  if (!entry) throw new Error(`no instance-config entry for project: ${project}`);
  const repo = parseGitHubRepo(entry.repoUrl);
  if (!repo) {
    throw new Error(`project ${project} has no GitHub repository: ${entry.repoUrl}`);
  }
  return gitHubForge({ repo, ghCommand: config.ghCommand, runner });
}

/**
 * Assembles the lanes the daemon registers:
 *   story   → storyLane → postFreeze → shipStep
 *   repair  → repairLane → shipStep
 *   records → recordsLane → shipStep
 * The records lane is the third one: a ticket that names decision records and
 * nothing else is a run of its own, with no fix seat, no suite and no code
 * verdict (ADR-0074).
 * @param {{instanceConfig: () => object,
 *   enqueueRepair?: (info: object) => unknown}} opts `instanceConfig` reads
 *   the live config, so a config edit reaches the next forge resolution.
 *   `enqueueRepair` hands a red-merge breach's ticketed escapes to the
 *   daemon's frontier; the daemon binary passes its sweep. Unset, a breach
 *   still tickets its escapes and the next sweep launches them one trigger
 *   later — nothing in the lane graph launches a run.
 */
export function assembleLanes({ instanceConfig, enqueueRepair = null } = {}) {
  if (typeof instanceConfig !== 'function') {
    throw new Error('assembleLanes requires an instanceConfig reader');
  }
  // One resolver for both lanes: the ship step opens the request with it, and
  // story readiness asks it what CI holds, so a credential is proven on every
  // surface before the first seat spawns (ADR-0027).
  const forgeFor = (ctx) => projectForge(instanceConfig(), ctx.project);
  const ship = shipStep({ forgeFor, enqueueRepair });
  return {
    story: storyLane({ afterFreeze: postFreeze({ afterVerdict: ship }), forgeFor }),
    repair: repairLane({ afterVerdict: ship }),
    records: recordsLane({ afterRecords: ship, forgeFor }),
  };
}
