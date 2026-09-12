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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Where one certification's verdict record is now. A stamp carries the record
 * file's name and never a path: the run that wrote it archives, and the
 * directory it was written in is gone by the time anybody reads the stamp.
 */
function recordPath(paths, runId, file) {
  if (typeof file !== 'string' || file.length === 0) return null;
  const live = join(paths.runs, runId, file);
  return existsSync(live) ? live : join(paths.archivedRuns, runId, file);
}

function answer(paths, stamp, row) {
  return {
    baseSha: stamp.sha,
    certifiedSeq: stamp.seq,
    runId: stamp.runId,
    status: row.status,
    elapsedMs: row.elapsedMs ?? null,
    record: recordPath(paths, stamp.runId, row.verdict),
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
 * Whether one layer is already certified for the tree at `sha`, and on what.
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
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {string} project
 * @param {string} sha the tree the run is asking about
 * @param {string} layer
 * @param {string[]} ground the layer's declared ground, repo-relative
 * @param {string} cloneDir the project's clone, where the diff is read
 * @returns {Promise<{baseSha: string, certifiedSeq: number, runId: string,
 *   status: string, elapsedMs: number|null, record: string|null}|null>}
 */
export async function certifiedAt(paths, project, sha, layer, ground, cloneDir) {
  const held = certifications(paths, project);
  const here = held.filter((stamp) => stamp.sha === sha && rowOf(stamp, layer)).pop();
  if (here) {
    const row = rowOf(here, layer);
    return row.status === 'green' ? answer(paths, here, row) : null;
  }
  if (!Array.isArray(ground) || ground.length === 0) return null;
  const earlier = held
    .filter((stamp) => stamp.sha !== sha && rowOf(stamp, layer)?.status === 'green')
    .pop();
  if (!earlier) return null;
  let changed;
  try {
    changed = await changedInRange(cloneDir, earlier.sha, sha);
  } catch {
    return null;
  }
  if (changed.some((file) => ground.some((entry) => underEntry(file, entry)))) return null;
  return answer(paths, earlier, rowOf(earlier, layer));
}
