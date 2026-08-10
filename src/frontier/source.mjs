// Reads the story-graph source from a project's bare clone: project config
// plus every intent card, both from the default branch head. The sweep
// fetches first so it launches from the graph as it stands on the remote;
// a console render skips the fetch — it reads, never writes the clone.
import { existsSync } from 'node:fs';
import {
  cloneDir,
  ensureBareClone,
  fetchClone,
  readBlobFromBranch,
  listTreeFiles,
} from '../isolation/clones.mjs';
import { parseProjectConfig } from '../config/project.mjs';
import { parseIntentCard } from '../lanes/card.mjs';

/**
 * Returns `{config, cards}` or null when the project config has no `graph`
 * section (manual launches only). Throws when the clone, the config, or the
 * cards directory cannot be read — the caller decides how loud that is.
 * The daemon serializes its calls through the isolation clone lock; the
 * no-fetch console path is read-only and needs no lock.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {string} project
 * @param {{repoUrl: string, defaultBranch: string, projectConfigPath: string}} entry
 */
export async function readGraphSource(paths, project, entry, { fetch = true } = {}) {
  const dir = cloneDir(paths, project);
  if (fetch) {
    await ensureBareClone(paths, project, entry.repoUrl, entry.defaultBranch);
    await fetchClone(dir);
  } else if (!existsSync(dir)) {
    throw new Error(`no clone for ${project} yet — the daemon clones at the first sweep or launch`);
  }
  const { text } = await readBlobFromBranch(dir, entry.defaultBranch, entry.projectConfigPath);
  const config = parseProjectConfig(text, `${entry.defaultBranch}:${entry.projectConfigPath}`);
  if (!config.graph) return null;
  const names = await listTreeFiles(dir, entry.defaultBranch, config.graph.cardsDir);
  const cards = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const path = `${config.graph.cardsDir}/${name}`;
    const { text: cardText } = await readBlobFromBranch(dir, entry.defaultBranch, path);
    const { card, errors } = parseIntentCard(cardText);
    cards.push({ key: card.key, path, phase: card.phase, blockedBy: card.blockedBy, errors });
  }
  return { config, cards };
}
