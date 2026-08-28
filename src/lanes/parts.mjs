// Part-level targeting inside one gate layer (ADR-0046).
//
// The layer sweep already carries a green LAYER between cycles (ADR-0022).
// Inside a layer that runs in parts, the same question has a finer answer: a
// repair diff that touched one template cannot have changed what the twenty
// other suites in that layer decided, so those parts carry and the reached
// one runs. This module is the whole derivation, and it is pure: it reads a
// layer's standing result and the files that moved since that result was
// earned, and it says which parts must run and which may carry.
//
// The rule is conservative by construction, and every clause of it re-runs:
//
// - A part is affected unless the diff falls FULLY outside its input set.
// - A part that declared no input set is affected by everything.
// - A changed path no part's input set claims — a lockfile, a shared package,
//   a migration, a config file, a path nobody thought about — makes EVERY
//   part affected. Doubt always re-runs.
// - A part that was not proven green is affected. A red part never carries.
// - A part the record does not hold at all is not carryable, so a layer with
//   no part record runs whole.
//
// Nothing here knows what a workspace is, what a suite is, or what any
// project calls its trees. The input set of a part is what that part's own
// command declared about itself, in the marker protocol (exec.mjs), in the
// same path vocabulary the rest of the project config uses — a plain prefix
// or a glob.
import { underEntry } from '../config/project.mjs';

/**
 * The environment variable the caller narrows a layer command with: the parts
 * it is asking for, by name, comma-separated. Absent means every part, which
 * is what a command sees today and what it must keep doing.
 */
export const PARTS_ENV = 'OLYMPUS_PARTS';

/**
 * What one layer's next execution must run, and what it may carry.
 *
 * @param {{cycle: number, parts?: Array<{name: string, status?: string,
 *   inputs?: string[], carriedFrom?: number}>}} prior the layer's standing
 *   `layer-result`, from the cycles before this one
 * @param {string[]} changed repo-relative paths that moved between the sha
 *   `prior` was earned at and the sha this cycle judges
 * @returns {{run: string[], carry: Array<object>}|null} null means run the
 *   whole layer: either there is nothing to carry, or nothing is known well
 *   enough to carry it.
 */
export function partPlan(prior, changed) {
  const parts = prior?.parts ?? [];
  if (parts.length === 0) return null;
  // A path under no part's declared inputs is a path this mapping cannot
  // attribute. One of them is enough to re-run everything.
  const attributed = (file) =>
    parts.some((part) => (part.inputs ?? []).some((entry) => underEntry(file, entry)));
  const blind = changed.some((file) => !attributed(file));
  const run = [];
  const carry = [];
  for (const part of parts) {
    const inputs = part.inputs ?? [];
    const reached =
      blind ||
      inputs.length === 0 ||
      changed.some((file) => inputs.some((entry) => underEntry(file, entry)));
    if (part.status !== 'green' || reached) run.push(part.name);
    else carry.push(carriedPart(part, prior.cycle));
  }
  // Nothing to run, or nothing to save: either way the narrowing buys nothing
  // and the layer runs as it always did.
  if (run.length === 0 || carry.length === 0) return null;
  return { run, carry };
}

/**
 * A carried part's record. The provenance is the cycle that RAN the part, not
 * the cycle it was last carried through: a green is worth the sha it was
 * earned at, and a chain of carries does not make it fresher.
 */
function carriedPart(part, cycle) {
  return {
    name: part.name,
    status: 'green',
    ...(part.inputs?.length > 0 && { inputs: part.inputs }),
    carriedFrom: part.carriedFrom ?? cycle,
  };
}

/** The parts of a result that were carried rather than run. */
export function carriedParts(record) {
  return (record?.parts ?? []).filter((part) => part.carriedFrom !== undefined);
}

/**
 * The parts a layer's own execution proved and the parts it carried, merged
 * into one record. What the execution said always wins: a command that
 * ignored the narrowing and ran a part anyway has stated a fact about this
 * sha, and a carry is only ever a statement about an older one.
 */
export function mergeCarried(ran = [], carry = []) {
  if (carry.length === 0) return ran;
  const stated = new Set(ran.map((part) => part.name));
  const added = carry.filter((part) => !stated.has(part.name));
  return added.length === 0 ? ran : [...ran, ...added];
}
