// Part-level targeting inside one gate layer (ADR-0046), and the record of why
// each part ran (ADR-0058).
//
// The layer sweep already carries a green LAYER between cycles (ADR-0022).
// Inside a layer that runs in parts, the same question has a finer answer: a
// repair diff that touched one template cannot have changed what the twenty
// other suites in that layer decided, so those parts carry and the reached
// one runs. This module is the whole derivation, and it is pure: it reads a
// layer's standing result and the files that moved since that result was
// earned, and it says which parts must run, which may carry, and why.
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
// Every one of those clauses now says so on the record. Before this, the
// conservative branch wrote nothing at all: a cycle that re-ran every part of
// a layer left no event, no field and no log line saying which clause decided
// it, or which path it could not attribute. A skip nothing names is a saving
// nobody can measure and a loss nobody can see, and the only evidence of the
// loss was the minutes a cycle spent. So the derivation carries a reason per
// part that runs, from a closed set of five, and the blind clause names the
// paths it could not attribute. Those paths are the diagnosis.
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
 * Why one part of a layer ran instead of carrying. The set is closed, and it
 * is closed on purpose: a vocabulary that grows a word per case is a log line,
 * and the whole value of this field is that a reader can count it.
 *
 * Every entry is a reason to RUN. A part that carried holds no reason; it
 * holds a provenance (`carriedFrom`), which is the older cycle its green was
 * earned in.
 *
 * - `touched`     a changed path is under this part's declared ground
 * - `undeclared`  the part declared no ground, so every change reaches it
 * - `blind`       a changed path is under no part's ground at all; the record
 *                 names the first of those paths
 * - `not-green`   the standing result for this part was not a proven green
 * - `no-record`   the standing result holds no entry for this part: the part
 *                 is new, or `PART_LIMIT` in exec.mjs evicted it
 */
export const PART_REASONS = new Set([
  'touched',
  'undeclared',
  'blind',
  'not-green',
  'no-record',
]);

/** The reason, or a throw naming it. The only way a reason reaches a stamp. */
export function assertPartReason(reason) {
  if (!PART_REASONS.has(reason)) throw new Error(`unknown part reason: ${reason}`);
  return reason;
}

// How many unattributed paths a blind record names. Three, because the record
// is a diagnosis and not a diff: one path is usually the whole answer, and a
// cycle that moved four hundred undeclared files would otherwise write four
// hundred of them onto every layer stamp it writes.
const BLIND_PATHS_NAMED = 3;

/**
 * Why each part of a layer must run, and the changed paths this mapping could
 * attribute to no part. A part absent from `reasons` is a part that may carry.
 *
 * PRECEDENCE. Several clauses hold at once often: a red part whose ground the
 * diff also reached, an undeclared part on a blind cycle. The record names the
 * defect of the mapping before the honest reason, because an honest reason is
 * read and forgotten while a defect that hides behind one is repaired by
 * nobody. So `undeclared` beats `blind`, `blind` beats `not-green`, and
 * `not-green` beats `touched`. Remove the causes in that order and each part
 * falls through to the next true clause, until what is left is the floor this
 * layer costs whatever anybody declares.
 *
 * @param {{parts?: Array<{name: string, status?: string, inputs?: string[]}>}} prior
 *   the layer's standing `layer-result`
 * @param {string[]} changed repo-relative paths that moved since it was earned
 * @param {{groundless?: string[]}} [options] `groundless` is the ground the
 *   project states no suite of it reads (ADR-0059)
 * @returns {{reasons: Map<string, string>, blindPaths: string[]}} a Map and
 *   not an object, because a part name is whatever a command printed after
 *   `::olympus part`. A part called `constructor` reads a reason off the
 *   object prototype it never had, and a part called `__proto__` silently
 *   keeps none at all, which would carry a part that has to run.
 */
export function partReasons(prior, changed, { groundless = [] } = {}) {
  const parts = prior?.parts ?? [];
  // With no part table there is no mapping, so there is nothing to be blind
  // against: every path is unattributed and naming three of them would report
  // a hole that is not there. The absent parts answer for themselves, in
  // `withPartReasons`, where the names are known.
  if (parts.length === 0) return { reasons: new Map(), blindPaths: [] };
  // The groundless list leaves the diff first, before anything is attributed:
  // a path the project swears no suite reads must neither blind the cycle nor
  // reach a part (ADR-0059).
  const moved = changed.filter((file) => !groundless.some((entry) => underEntry(file, entry)));
  const attributed = (file) =>
    parts.some((part) => (part.inputs ?? []).some((entry) => underEntry(file, entry)));
  // A path under no part's declared inputs is a path this mapping cannot
  // attribute. One of them is enough to re-run everything.
  const blindPaths = moved.filter((file) => !attributed(file)).slice(0, BLIND_PATHS_NAMED);
  const reasons = new Map();
  for (const part of parts) {
    const inputs = part.inputs ?? [];
    if (inputs.length === 0) reasons.set(part.name, assertPartReason('undeclared'));
    else if (blindPaths.length > 0) reasons.set(part.name, assertPartReason('blind'));
    else if (part.status !== 'green') reasons.set(part.name, assertPartReason('not-green'));
    else if (moved.some((file) => inputs.some((entry) => underEntry(file, entry)))) {
      reasons.set(part.name, assertPartReason('touched'));
    }
  }
  return { reasons, blindPaths };
}

/**
 * What one layer's next execution must run, what it may carry, and why.
 *
 * `narrow` is null when the layer runs whole: either nothing may carry, or
 * nothing needs to run, and naming parts on the command's environment buys
 * nothing in both cases. The reasons stand either way, and the layer that runs
 * whole is the layer this record exists for: a blind cycle re-runs every part,
 * so a blind reading is only ever readable off a whole run.
 *
 * @param {{cycle: number, parts?: Array<{name: string, status?: string,
 *   inputs?: string[], carriedFrom?: number}>}} prior the layer's standing
 *   `layer-result`, from the cycles before this one
 * @param {string[]} changed repo-relative paths that moved between the sha
 *   `prior` was earned at and the sha this cycle judges
 * @param {{groundless?: string[]}} [options] as `partReasons`
 * @returns {{reasons: Map<string, string>, blindPaths: string[],
 *   narrow: {run: string[], carry: Array<object>}|null}}
 */
export function partPlan(prior, changed, options = {}) {
  const { reasons, blindPaths } = partReasons(prior, changed, options);
  const parts = prior?.parts ?? [];
  const run = [];
  const carry = [];
  for (const part of parts) {
    if (reasons.has(part.name)) run.push(part.name);
    else carry.push(carriedPart(part, prior.cycle));
  }
  // Nothing to run, or nothing to save: either way the narrowing buys nothing
  // and the layer runs as it always did.
  const narrow = run.length === 0 || carry.length === 0 ? null : { run, carry };
  return { reasons, blindPaths, narrow };
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

/**
 * The part table a result records, with the reason each part that ran was run
 * for. `reasons` is what the cycle's own plan derived for this layer; a layer
 * the cycle derived no plan for takes the table unchanged.
 *
 * That condition is the whole guard against a false word. A confirmation sweep
 * runs every part by design (ADR-0046) and a full spectrum has nothing to
 * carry from, so neither derives a plan, and stamping `no-record` on their
 * parts would report a hole in a record that was never consulted.
 *
 * Inside a layer the plan did cover, a part the plan holds no reason for and
 * the execution ran anyway is a part the standing result did not hold: the
 * command opened a part that is new, or `PART_LIMIT` evicted it. That is
 * `no-record`, and it is derived here rather than in the plan because the plan
 * reads the standing result and only the execution knows the names.
 *
 * @param {Array<object>} parts the merged part table of one result
 * @param {Map<string, string>} [reasons] the plan's reasons for this layer
 */
export function withPartReasons(parts, reasons) {
  if (!reasons) return parts;
  return parts.map((part) =>
    part.carriedFrom !== undefined
      ? part
      : { ...part, reason: assertPartReason(reasons.get(part.name) ?? 'no-record') },
  );
}

/**
 * How much of a cycle's part work the cycle did not do: the parts it ran, the
 * parts it carried, and the carried share of the two.
 *
 * A layer the cycle carried whole carried every part in it, whatever the
 * part's own line says. The layer's mode is the fact about this cycle, and the
 * part table under it belongs to an older one. Null for a cycle that
 * recorded no part at all: nought over nought is not a share, and a metric
 * that read it as zero would report a decay in a project that runs no layer
 * in parts.
 *
 * @param {Array<{mode?: string, parts?: Array<object>}>} results the cycle's
 *   spectrum results
 * @returns {{partsRun: number, partsCarried: number, carryShare: number}|null}
 */
export function carryTally(results = []) {
  let partsRun = 0;
  let partsCarried = 0;
  for (const layer of results) {
    for (const part of layer.parts ?? []) {
      if (layer.mode === 'carried' || part.carriedFrom !== undefined) partsCarried += 1;
      else partsRun += 1;
    }
  }
  const total = partsRun + partsCarried;
  if (total === 0) return null;
  // Three places, the same rounding every other fraction in the harness gets:
  // a share a person can read, and a breach comparison that is stable.
  return {
    partsRun,
    partsCarried,
    carryShare: Math.round((partsCarried / total) * 1000) / 1000,
  };
}
