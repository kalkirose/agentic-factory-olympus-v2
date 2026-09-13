// What the default branch of one project is already certified for, read from
// the instance ledger.
//
// A ship's close-out stamps `base-certified`: the layers that stood green at
// the sha the branch became. Two later readers ask this file about it. A seat
// bound asks what one layer costs on the clock, so it can refuse a command
// that would spend an hour the verdict is going to spend anyway. A verdict's
// first cycle asks whether a layer has already answered for the tree under it,
// so it runs the layers the change reaches and carries the rest.
//
// It sits beside the ledger rather than in the pull-only reader API
// (`telemetry/readers.mjs`), because the second question is not answered from
// the files alone: a certification at an older sha stands only while the
// branch between the two shas leaves the layer's ground alone, and that is a
// diff in the project's clone.
import { readEvents } from './ledger.mjs';
import { underEntry } from '../config/project.mjs';
import { changedInRange } from '../isolation/tree.mjs';

/**
 * The base certifications one project holds, oldest first.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 */
function certifications(paths, project) {
  return readEvents(paths.instanceLedger).filter(
    (event) => event.event === 'base-certified' && event.project === project,
  );
}

/** The layer's row of one certification, or undefined. */
function rowOf(stamp, layer) {
  return (stamp.layers ?? []).find((row) => row.name === layer);
}

function answer(stamp, row) {
  return {
    baseSha: stamp.sha,
    certifiedSeq: stamp.seq,
    runId: stamp.runId,
    status: row.status,
    elapsedMs: row.elapsedMs ?? null,
  };
}

/**
 * The newest base certification of one project, or null.
 *
 * `sha` narrows the answer to the certification of one branch head, which is
 * the question a carry asks. Absent, the answer is the newest certification
 * the project holds whatever its sha, which is the question a duration asks: a
 * layer takes about as long as it took last time, and the sha it took that
 * long at says nothing about the number.
 *
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {string} project
 * @param {string} [sha]
 * @returns {object|null} the ledger event
 */
export function newestBaseCertification(paths, project, sha) {
  const held = certifications(paths, project).filter(
    (stamp) => sha === undefined || stamp.sha === sha,
  );
  return held.length > 0 ? held[held.length - 1] : null;
}

/**
 * Which of a set of layers are already certified for the tree at `sha`, and on
 * what.
 *
 * Two ways it can be. A certification at that sha names the layer: the answer
 * is that row, and no ground claim is involved, because the layer ran against
 * this tree. Otherwise the newest certification that holds the layer green
 * stands, but only while the branch between the two shas left the layer's
 * ground alone. The layer's answer follows its ground, and a diff that
 * touches none of it cannot have changed the answer.
 *
 * Three refusals, all of them the same rule: doubt runs the layer.
 *
 * A certification at `sha` that holds the layer red refuses. It is a
 * measurement of this tree, and no claim about an older one outranks it.
 *
 * A layer with no declared ground refuses, unless a certification at `sha`
 * itself answers. Ground is the whole of what a carry rests on; a layer that
 * declares none has claimed nothing, and an empty list would otherwise read as
 * a list nothing can touch.
 *
 * Only the newest green certification is tried. A diff against an older one is
 * normally wider and refuses too, and walking every certification a project
 * ever stamped would cost one diff each. A refusal costs one layer execution,
 * which is what the run would have spent anyway.
 *
 * The question is asked of a whole layer set at once, because that is how a
 * verdict asks it. One read of the instance ledger answers for every layer, and
 * the ancestry diff is per ancestor sha and not per layer: a project with forty
 * layers certified at one earlier sha costs one diff, where a reader that took
 * one layer at a time cost forty parses and forty subprocesses on every first
 * cycle.
 *
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {string} project
 * @param {string} sha the tree the run is asking about
 * @param {Array<{name: string, ground: string[]}>} layers
 * @param {string} cloneDir the project's clone, where the diff is read
 * @returns {Promise<Map<string, {baseSha: string, certifiedSeq: number,
 *   runId: string, status: string, elapsedMs: number|null}>>} the layers that
 *   are certified, by name
 */
export async function certifiedAtAll(paths, project, sha, layers, cloneDir) {
  const held = certifications(paths, project);
  // One diff per ancestor sha, computed on the first layer that needs it. A diff
  // git cannot answer is remembered as null, so a broken clone costs one attempt
  // and not one per layer.
  const diffs = new Map();
  const changedSince = async (from) => {
    if (!diffs.has(from)) {
      try {
        diffs.set(from, await changedInRange(cloneDir, from, sha));
      } catch {
        diffs.set(from, null);
      }
    }
    return diffs.get(from);
  };
  const certified = new Map();
  for (const { name, ground } of layers) {
    const here = held.filter((stamp) => stamp.sha === sha && rowOf(stamp, name)).pop();
    if (here) {
      const row = rowOf(here, name);
      if (row.status === 'green') certified.set(name, answer(here, row));
      continue;
    }
    if (!Array.isArray(ground) || ground.length === 0) continue;
    const earlier = held
      .filter((stamp) => stamp.sha !== sha && rowOf(stamp, name)?.status === 'green')
      .pop();
    if (!earlier) continue;
    const changed = await changedSince(earlier.sha);
    if (changed === null) continue;
    if (changed.some((file) => ground.some((entry) => underEntry(file, entry)))) continue;
    certified.set(name, answer(earlier, rowOf(earlier, name)));
  }
  return certified;
}

/**
 * One layer's answer to the same question.
 *
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {string} project
 * @param {string} sha
 * @param {string} layer
 * @param {string[]} ground the layer's declared ground, repo-relative
 * @param {string} cloneDir
 * @returns {Promise<{baseSha: string, certifiedSeq: number, runId: string,
 *   status: string, elapsedMs: number|null}|null>}
 */
export async function certifiedAt(paths, project, sha, layer, ground, cloneDir) {
  const certified = await certifiedAtAll(paths, project, sha, [{ name: layer, ground }], cloneDir);
  return certified.get(layer) ?? null;
}
