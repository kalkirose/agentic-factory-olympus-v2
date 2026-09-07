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
// - A part is affected unless the diff falls FULLY outside its ground.
// - A part that declared no input set takes the layer's declared ground, and
//   is affected by everything only where no ground exists at all.
// - A changed path no part's ground claims — a lockfile, a shared package,
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
// Two other narrowings share this vocabulary and are decided elsewhere, in
// `spectrum.mjs`. The flake filter's re-run asks only for the parts the
// replaced attempt did not pass, and only for the files those parts named; the
// confirmation sweep asks only for the parts the cycle carried. Neither reads
// a diff, so neither belongs to the derivation above. What they take from here
// is the two environment variables, the merge, and the shapes a kept part and
// a carried part hold.
//
// One class of path is attributed by the project and not by a declaration. A
// record of a decision is read by the record layers the project names in
// `gates.recordLayers` and by no other layer, whatever any ground says. So a
// record path leaves the diff of every other layer exactly as a groundless
// path does, and the shared breadth list never carries one to a layer at all.
// The rule is one derivation here (`recordAttribution`) and three readers: the
// mapping below, the layer selection in spectrum.mjs, and the ship fast path.
//
// Nothing here knows what a workspace is, what a suite is, or what any
// project calls its trees. A layer's ground has two sources and this module
// owns the one derivation both readers use: the command states it part by part
// in the marker protocol (exec.mjs), and the project states it on the layer
// entry of its own config. Both are written in the same path vocabulary as
// every other path list — a plain prefix or a glob.
import { groundEntries, groundEntry, underEntry } from '../config/project.mjs';

/**
 * Whether one repo-relative path is a record of this tree, from
 * `repo.recordPaths`. Null for a project that names none, so every reader
 * below keeps the behaviour it had before the key existed.
 *
 * An entry that begins `!` is an exclusion: a path is a record when an
 * inclusion holds it and no exclusion does. That is how a project keeps one
 * file of its record tree, a template, outside the rule.
 *
 * @param {string[]} [recordPaths]
 * @returns {((file: string) => boolean)|null}
 */
export function recordMatch(recordPaths = []) {
  const include = [];
  const exclude = [];
  for (const entry of recordPaths) {
    if (typeof entry !== 'string') continue;
    const excluded = entry.startsWith('!');
    const norm = groundEntry(excluded ? entry.slice(1) : entry);
    if (norm === null) continue;
    (excluded ? exclude : include).push(norm);
  }
  if (include.length === 0) return null;
  return (file) =>
    include.some((entry) => underEntry(file, entry)) &&
    !exclude.some((entry) => underEntry(file, entry));
}

/**
 * How this project attributes a record path, or null where it states no such
 * rule. `isRecord` is the matcher above; `layers` is the closed set of Tier-1
 * layers a record path may reach.
 *
 * Both halves must be stated for the rule to exist. A project that names no
 * record layer has not said which layer reads its records, and a project that
 * names no record path has not said what a record is; either way the layer
 * question is answered exactly as it was before this existed.
 *
 * @param {{recordPaths?: string[], recordLayers?: string[]}} [declaration]
 * @returns {{isRecord: (file: string) => boolean, layers: Set<string>}|null}
 */
export function recordAttribution({ recordPaths = [], recordLayers = [] } = {}) {
  if (recordLayers.length === 0) return null;
  const isRecord = recordMatch(recordPaths);
  return isRecord === null ? null : { isRecord, layers: new Set(recordLayers) };
}

/**
 * One layer's whole ground: every path entry that could change what the layer
 * decides, from both sources, canonical and sorted.
 *
 * Three lists go in. Two of them are the layer's own sources, and the third
 * belongs to every layer of the project.
 *
 * - `config` is the layer's own `gates.tier1[].ground` list.
 * - `stated` is the union of the inputs the layer's parts declared about
 *   themselves in the last execution.
 * - `breadth` is `gates.breadthGround`, the ground the project states belongs
 *   to every suite whatever any suite declared. It joins every layer's ground
 *   here rather than in forty config lists, because a project that had to
 *   repeat it per layer would be writing one fact forty times.
 *
 * `entries` is the union of all three: the widest ground the layer might read.
 * That is the honest answer to the question the ship path asks, because a
 * wider set refuses more and never fewer, so it fails in the safe direction.
 *
 * `floor` is what a part that declared nothing takes: the layer's own config
 * ground, widened by the breadth list. The distinction from `entries` is the
 * whole of the carry half. A sibling part's declaration is a statement about
 * that sibling and about nothing else, so a part that says nothing may not
 * stand on it. The breadth list is not a floor of its own either: it is ground
 * that belongs to every suite ON TOP of what that suite declared, never a
 * description of what a layer reads. So a layer the config does not describe
 * has no floor at all, and a part with no ground is affected by everything,
 * exactly as it was before this field existed (ADR-0046).
 *
 * `sources` says which of the two spoke. The ship path walks the declaration
 * surface of a layer whose COMMAND spoke, because those markers come out of
 * the run's own tree and a story may not narrow its own inputs; a config
 * ground is produced in no tree at all (ADR-0056).
 *
 * The breadth list never carries a record. It is the one list that belongs to
 * every layer whatever that layer declared, so a record entry inside it would
 * give every suite in the project ground over the record tree and undo the
 * attribution above in one line of config. A breadth entry that lies under a
 * record path is dropped from both sets; every other entry joins as it always
 * did, and a project that declares no record path loses nothing.
 *
 * @param {{ground?: string[]}} layer the project's Tier-1 layer entry
 * @param {{parts?: Array<{inputs?: string[]}>}} record the layer's standing
 *   `layer-result`
 * @param {string[]} [breadth] `gates.breadthGround`
 * @param {string[]} [recordPaths] `repo.recordPaths`
 * @returns {{entries: string[], floor: string[],
 *   sources: {declared: boolean, config: boolean}}}
 */
export function layerGround(layer, record, breadth = [], recordPaths = []) {
  const config = groundEntries(layer?.ground ?? []);
  const stated = groundEntries((record?.parts ?? []).flatMap((part) => part.inputs ?? []));
  const wide = recordFreeBreadth(breadth, recordPaths);
  const floor = config.length > 0 ? groundEntries([...config, ...wide]) : [];
  return {
    entries: groundEntries([...config, ...stated, ...wide]),
    floor,
    sources: { declared: stated.length > 0, config: config.length > 0 },
  };
}

/** The breadth entries that name no record of this tree. */
function recordFreeBreadth(breadth, recordPaths) {
  const isRecord = recordMatch(recordPaths);
  if (isRecord === null) return breadth;
  return breadth.filter((entry) => typeof entry !== 'string' || !isRecord(entry));
}

/**
 * One part's effective input set: what the part declared about itself, or the
 * layer's ground where the part declared nothing.
 *
 * The stream wins wherever it spoke. A part that named its own inputs keeps
 * them, and a config entry never narrows or widens them: the runner holds the
 * fact, and a config copy of a fact the runner already states is the copy
 * nobody edits when a suite moves (ADR-0046). The layer ground is the floor
 * under a part that says nothing, never a correction of one that speaks.
 *
 * @param {{inputs?: string[]}} part
 * @param {{floor: string[]}} ground the layer's ground
 * @returns {string[]}
 */
export function partGround(part, ground) {
  const own = groundEntries(part?.inputs ?? []);
  return own.length > 0 ? own : (ground?.floor ?? []);
}

/**
 * The environment variable the caller narrows a layer command with: the parts
 * it is asking for, by name, comma-separated. Absent means every part, which
 * is what a command sees today and what it must keep doing.
 */
export const PARTS_ENV = 'OLYMPUS_PARTS';

/**
 * The environment variable the flake filter's re-run narrows a part with: the
 * files that part reported red, as `<part>=<path>,<path>;<part>=…`. Absent
 * means every file of every part it runs, which is what a command sees today
 * and what it must keep doing.
 */
export const FAILED_FILES_ENV = 'OLYMPUS_FAILED_FILES';

// What the encoding cannot carry. The separators are the vocabulary, so a name
// or a path that holds one of them cannot be stated in it. Such a part is left
// out of the variable and re-runs whole, which is the direction every doubt in
// this module falls in.
const UNENCODABLE = /[;,=]/;

/**
 * The narrowing a re-run asks for inside the parts it runs: the variable's
 * value, and how many files it names. Empty for a set of parts that reported
 * no files, and then the re-run runs those parts whole.
 *
 * @param {Array<{name: string, failedFiles?: string[]}>} parts the parts the
 *   re-run is about to run, as the replaced attempt reported them
 * @returns {{value: string, files: number}}
 */
export function failedFileNarrowing(parts = []) {
  const named = [];
  let files = 0;
  for (const part of parts) {
    if (UNENCODABLE.test(part.name)) continue;
    const paths = (part.failedFiles ?? []).filter((path) => !UNENCODABLE.test(path));
    if (paths.length === 0) continue;
    named.push(`${part.name}=${paths.join(',')}`);
    files += paths.length;
  }
  return { value: named.join(';'), files };
}

/**
 * Why one part of a layer ran instead of carrying. The set is closed, and it
 * is closed on purpose: a vocabulary that grows a word per case is a log line,
 * and the whole value of this field is that a reader can count it.
 *
 * Every entry is a reason to RUN. A part that carried holds no reason; it
 * holds a provenance (`carriedFrom`), which is the older cycle its green was
 * earned in.
 *
 * - `touched`     a changed path is under this part's ground
 * - `undeclared`  neither source declared a ground for this part, so every
 *                 change reaches it
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
 * A record path is groundless for every layer outside `recordLayers`. The
 * project states which layers read its records, so a record path that reached
 * another layer's parts would be attributed against that statement, and a
 * record path no part of that layer claims would blind the layer and re-run
 * every part of it. Inside a record layer the path is attributed like any
 * other, so a record its parts do not claim still re-runs the whole layer.
 *
 * @param {{parts?: Array<{name: string, status?: string, inputs?: string[]}>}} prior
 *   the layer's standing `layer-result`
 * @param {string[]} changed repo-relative paths that moved since it was earned
 * @param {{groundless?: string[], layer?: object, breadth?: string[],
 *   recordPaths?: string[], recordLayers?: string[]}} [options]
 *   `groundless` is the ground the project states no suite of it reads
 *   (ADR-0059); `layer` is the project's Tier-1 entry, which carries the
 *   config half of this layer's ground; `breadth` is `gates.breadthGround`;
 *   `recordPaths` and `recordLayers` are the record attribution above
 * @returns {{reasons: Map<string, string>, blindPaths: string[],
 *   groundFrom: Map<string, string>}} two Maps and not objects, because a part
 *   name is whatever a command printed after `::olympus part`. A part called
 *   `constructor` reads a reason off the object prototype it never had, and a
 *   part called `__proto__` silently keeps none at all, which would carry a
 *   part that has to run.
 */
export function partReasons(
  prior,
  changed,
  { groundless = [], layer, breadth = [], recordPaths = [], recordLayers = [] } = {},
) {
  const parts = prior?.parts ?? [];
  // With no part table there is no mapping, so there is nothing to be blind
  // against: every path is unattributed and naming three of them would report
  // a hole that is not there. The absent parts answer for themselves, in
  // `withPartReasons`, where the names are known.
  if (parts.length === 0) return { reasons: new Map(), blindPaths: [], groundFrom: new Map() };
  const ground = layerGround(layer, prior, breadth, recordPaths);
  // A record path outside this layer's attribution is groundless here, for the
  // same reason and by the same filter: the project says this layer does not
  // read it, so it must neither blind the cycle nor reach a part.
  const records = recordAttribution({ recordPaths, recordLayers });
  const foreign =
    records !== null && !records.layers.has(layer?.name) ? records.isRecord : () => false;
  // The groundless list leaves the diff first, before anything is attributed:
  // a path the project swears no suite reads must neither blind the cycle nor
  // reach a part (ADR-0059).
  const moved = changed.filter(
    (file) => !foreign(file) && !groundless.some((entry) => underEntry(file, entry)),
  );
  // Each part's effective ground, derived once. A part that declared its own
  // inputs keeps them; a part that declared none takes the layer's.
  const groundOf = new Map(parts.map((part) => [part.name, partGround(part, ground)]));
  const attributed = (file) =>
    parts.some((part) => groundOf.get(part.name).some((entry) => underEntry(file, entry)));
  // A path under no part's ground is a path this mapping cannot attribute. One
  // of them is enough to re-run everything.
  const blindPaths = moved.filter((file) => !attributed(file)).slice(0, BLIND_PATHS_NAMED);
  const reasons = new Map();
  const groundFrom = new Map();
  for (const part of parts) {
    const inputs = groundOf.get(part.name);
    // The fallback, on the record, so it is countable. A part whose own
    // command stated nothing and whose ground the config answered for is the
    // one line that says the config half bought something.
    if (groundEntries(part.inputs ?? []).length === 0 && ground.sources.config) {
      groundFrom.set(part.name, 'config');
    }
    if (inputs.length === 0) reasons.set(part.name, assertPartReason('undeclared'));
    else if (blindPaths.length > 0) reasons.set(part.name, assertPartReason('blind'));
    else if (part.status !== 'green') reasons.set(part.name, assertPartReason('not-green'));
    else if (moved.some((file) => inputs.some((entry) => underEntry(file, entry)))) {
      reasons.set(part.name, assertPartReason('touched'));
    }
  }
  return { reasons, blindPaths, groundFrom };
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
 * @param {{groundless?: string[], layer?: object, breadth?: string[],
 *   recordPaths?: string[], recordLayers?: string[]}} [options]
 *   as `partReasons`
 * @returns {{reasons: Map<string, string>, blindPaths: string[],
 *   groundFrom: Map<string, string>,
 *   narrow: {run: string[], carry: Array<object>}|null}}
 */
export function partPlan(prior, changed, options = {}) {
  const { reasons, blindPaths, groundFrom } = partReasons(prior, changed, options);
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
  return { reasons, blindPaths, groundFrom, narrow };
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
 * The parts of a result that its own execution ran, as a later pass of the
 * same cycle keeps them: the part with the attempt that earned it and the
 * ledger seq of the result it was stamped on.
 *
 * A kept part is not a carried part. A carry is a green of an older sha and
 * says so (`carriedFrom`); a keep is a green of THIS sha that a narrowed pass
 * of this same cycle already earned, and the provenance says which pass. That
 * is why a merged record holds no `carriedFrom` and still names, per part, the
 * execution behind it.
 */
export function keptParts(record) {
  return (record?.parts ?? [])
    .filter((part) => part.carriedFrom === undefined)
    .map((part) => ({
      ...part,
      ...(part.attempt === undefined &&
        record.attempt !== undefined && { attempt: record.attempt }),
      ...(record.seq !== undefined && { seq: record.seq }),
    }));
}

/**
 * The parts a layer's own execution proved and the parts an earlier execution
 * earned, merged into one table. What the execution said always wins: a
 * command that ignored the narrowing and ran a part anyway has stated a fact
 * about this sha, and everything merged in is a statement about an earlier
 * execution — an older cycle's carry, or an earlier attempt or pass of this
 * one.
 */
export function mergeParts(ran = [], earlier = []) {
  if (earlier.length === 0) return ran;
  const stated = new Set(ran.map((part) => part.name));
  const added = earlier.filter((part) => !stated.has(part.name));
  return added.length === 0 ? ran : [...ran, ...added];
}

/**
 * The part table a result records, with the reason each part that ran was run
 * for. `reasons` is what the cycle's own plan derived for this layer; a layer
 * the cycle derived no plan for takes the table unchanged.
 *
 * That condition is the whole guard against a false word. A full spectrum has
 * nothing to carry from, and a confirmation sweep runs what the cycle has not
 * run at this sha rather than what a diff could reach, so neither derives a
 * plan, and stamping `no-record` on their parts would report a hole in a
 * record that was never consulted. A part a confirmation keeps holds the
 * reason of the pass that ran it, which is the pass the `seq` on it names.
 *
 * Inside a layer the plan did cover, a part the plan holds no reason for and
 * the execution ran anyway is a part the standing result did not hold: the
 * command opened a part that is new, or `PART_LIMIT` evicted it. That is
 * `no-record`, and it is derived here rather than in the plan because the plan
 * reads the standing result and only the execution knows the names.
 *
 * A part whose ground the config answered for also carries `groundFrom`, so
 * the fallback is countable. It rides a carried part as well as a part that
 * ran, because the reading it feeds is about the carries: a window where it
 * never appears on a part that carried says the fallback answers nothing. It
 * is a read rather than a stamp of anything, so the part's `inputs` stay
 * exactly what the command said, which is empty, because a record holds what
 * the stream said and nothing else (ADR-0046).
 *
 * @param {Array<object>} parts the merged part table of one result
 * @param {Map<string, string>} [reasons] the plan's reasons for this layer
 * @param {Map<string, string>} [groundFrom] the plan's ground source per part
 */
export function withPartReasons(parts, reasons, groundFrom) {
  if (!reasons) return parts;
  return parts.map((part) => {
    const source = groundFrom?.get(part.name);
    const ground = source === undefined ? {} : { groundFrom: source };
    return part.carriedFrom !== undefined
      ? { ...part, ...ground }
      : { ...part, reason: assertPartReason(reasons.get(part.name) ?? 'no-record'), ...ground };
  });
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

/**
 * What the confirmation sweep executed of the layers it narrowed, and what it
 * stood on instead: the parts it ran itself, and the parts an earlier pass of
 * the same cycle had already run at this sha.
 *
 * Only a merged confirmation record carries the two marks this reads, so the
 * count covers exactly the layers the sweep narrowed. A layer it ran whole is
 * outside the measure: it ran whole because this cycle had run none of it, and
 * counting it would drown the number this exists to expose. Null for a sweep
 * that narrowed no layer.
 *
 * @param {Array<{parts?: Array<object>}>} results the sweep's spectrum results
 * @returns {{ran: number, kept: number}|null}
 */
export function confirmationTally(results = []) {
  let ran = 0;
  let kept = 0;
  for (const layer of results) {
    for (const part of layer.parts ?? []) {
      if (part.confirmation === true) ran += 1;
      else if (part.seq !== undefined) kept += 1;
    }
  }
  return ran + kept === 0 ? null : { ran, kept };
}
