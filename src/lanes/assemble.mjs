// The lane graph the daemon runs: story and repair, assembled from the lane
// composers. The daemon registers lanes once at start, so the graph is built
// once — but one instance holds many projects, and each project ships to its
// own repository. The forge is therefore resolved per run from the run's
// project, out of the live instance config; nothing here binds a repository
// at assembly time.
import { storyLane } from './story.mjs';
import { postFreeze, repairLane } from './verdict.mjs';
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
 *   story  → storyLane → postFreeze → shipStep
 *   repair → repairLane → shipStep
 * @param {{instanceConfig: () => object}} opts `instanceConfig` reads the
 *   live config, so a config edit reaches the next forge resolution.
 */
export function assembleLanes({ instanceConfig } = {}) {
  if (typeof instanceConfig !== 'function') {
    throw new Error('assembleLanes requires an instanceConfig reader');
  }
  // `spawnRepair` stays unset: a red-merge breach records its escapes and
  // spawns nothing, so an open escape is the only tracking record until the
  // spawner lands.
  const ship = shipStep({
    forgeFor: (ctx) => projectForge(instanceConfig(), ctx.project),
  });
  return {
    story: storyLane({ afterFreeze: postFreeze({ afterVerdict: ship }) }),
    repair: repairLane({ afterVerdict: ship }),
  };
}
