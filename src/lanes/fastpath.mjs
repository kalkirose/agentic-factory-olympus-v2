// The clean-rebase fast path (ADR-0056).
//
// A run reaches the ship path with a green verdict and takes the branch update
// under the ship token. When that update moves the tree, the tree the verdict
// certified is no longer the tree that lands, so the run goes back to the
// verdict and earns its certification a second time. That repeat costs hours,
// and it serialises the ship queue behind it: every run waiting for the token
// waits for the whole of the holder's second certification.
//
// This module answers one question. Can the certification the run already
// earned stand over the tree the update just built? It answers yes only when
// two mechanical checks agree that the two sides cannot interact. Nothing here
// is a judgment, and no seat is asked.
//
// Check one, the text. The tree that ships must be the default branch plus the
// story's own patch and nothing else. The update merges rather than rebases,
// so the proof is a comparison of two patches: the story's own diff before the
// merge, and the story's own diff against the default branch after it. Byte
// equality says the merge put the story's patch on top of the branch and
// changed no line of it, which is the result a clean rebase would have
// produced. A merge that conflicts never arrives here, because the conflict
// takes the merge round one stage earlier.
//
// Check two, the ground. Every file the default branch gained since the run
// last met it is tested against four sets: the story's own changed files,
// every declared input of every suite in the certified verdict, the suite
// files, and the project's shared breadth list. One hit refuses. A suite that
// declared no inputs refuses, because a suite that says nothing about its
// ground can depend on anything. A change this module cannot read as a
// repo-relative file of this repository refuses for the same reason.
//
// Every refusal costs the run the re-verdict it would have taken anyway. The
// fast path can only remove work, so a defect in this module makes a ship
// slow and can never make one wrong.
import { createHash } from 'node:crypto';
import { underEntry } from '../config/project.mjs';
import { git } from '../isolation/git.mjs';
import { priorStatus } from './spectrum.mjs';

/**
 * The closed refusal vocabulary. A refusal outside it is prose again, and a
 * count of prose is nothing (ADR-0008).
 */
export const FAST_PATH_REFUSALS = new Set([
  // No green verdict stands for this tree, so there is no certification to
  // carry. Defensive: the update stage runs behind a green one.
  'no-certification',
  // The story's own diff is not what it was before the update.
  'diff-changed',
  // The project declares no shared breadth ground, so the ground check has no
  // floor under it and every answer it gave would be worth less than it reads.
  'no-breadth-ground',
  // A suite of the certified verdict said nothing about what it depends on.
  'undeclared-suite',
  // A change on the default branch this module cannot read as a file of this
  // repository: a submodule, or a path it cannot normalise.
  'unclassifiable-change',
  // The default branch moved on ground the certification rests on.
  'ground-intersects',
  // Anything thrown inside the check itself.
  'internal-error',
]);

/** The refusal, or a throw naming it. The only way a refusal reaches a stamp. */
export function assertFastPathRefusal(refusal) {
  if (!FAST_PATH_REFUSALS.has(refusal)) {
    throw new Error(`unknown fast-path refusal: ${refusal}`);
  }
  return refusal;
}

/**
 * The file mode git gives a submodule. What such an entry points at lives in
 * another repository, so no declaration in this one can name its ground.
 */
const GITLINK = '160000';

/** How many commits of the examined range one record names. */
export const COMMIT_LIMIT = 200;

/** How many paths a refusal detail names before it stops listing them. */
const DETAIL_PATHS = 5;

/**
 * The output cap on the two full-patch reads. A story diff is the only read
 * here that grows with the work, and the runner's default cap is a megabyte.
 * A story past this cap throws, which is the internal-error route, which is
 * the full re-verdict: the wrong answer is never one of the endings.
 */
const MAX_DIFF_BYTES = 32 * 1024 * 1024;

/**
 * Reads one `git diff --raw -z` stream into the files it names and the records
 * this module cannot classify.
 *
 * The raw form is what carries the modes, and the modes are what say a record
 * is a submodule rather than a file. `-z` keeps every path exact: a path with
 * a quote, a backslash or a non-ASCII byte in it arrives whole, where the
 * default form would arrive quoted and this parse would compare the quoting
 * rather than the path.
 * @param {string} out git's stdout
 * @returns {{files: string[], unclassifiable: string[]}}
 */
export function parseRawDiff(out) {
  const fields = String(out)
    .split('\0')
    .filter((field) => field.length > 0);
  const files = [];
  const unclassifiable = [];
  let i = 0;
  for (; i + 1 < fields.length; i += 2) {
    const meta = fields[i];
    const path = fields[i + 1];
    const parts = meta.startsWith(':') ? meta.slice(1).split(' ').filter(Boolean) : null;
    if (!parts || parts.length < 5) {
      unclassifiable.push(path);
      continue;
    }
    const [srcMode, dstMode] = parts;
    if (srcMode === GITLINK || dstMode === GITLINK) {
      unclassifiable.push(path);
      continue;
    }
    const norm = normalizePath(path);
    if (norm === null) unclassifiable.push(path);
    else files.push(norm);
  }
  // A record the pairing did not close. Nothing here knows what it is, which
  // is exactly what the unclassifiable set is for.
  if (i < fields.length) unclassifiable.push(fields[i]);
  return { files, unclassifiable };
}

/**
 * A repo-relative path in the vocabulary the rest of the config uses, or null
 * for a name this module will not compare: an absolute path, a path that
 * climbs out of the repository, or an empty one.
 */
function normalizePath(path) {
  if (typeof path !== 'string') return null;
  const norm = path.replaceAll('\\', '/').trim();
  if (norm.length === 0) return null;
  if (norm.startsWith('/') || /^[A-Za-z]:\//.test(norm)) return null;
  if (norm.split('/').includes('..')) return null;
  return norm;
}

/**
 * The declared ground of the certified verdict: every input every suite of
 * every Tier-1 layer named about itself, in the part-targeting contract's own
 * shape (ADR-0046).
 *
 * A layer without a standing green, a layer that reported no parts, and a part
 * that declared no inputs each refuse. The default is always safety: a suite
 * that says nothing about its ground is a suite the module must assume depends
 * on everything, and a fast path over that assumption is no proof at all.
 * @param {Array<{name: string}>} layers the project's Tier-1 layers
 * @param {Map<string, object>} prior each layer's standing `layer-result`
 */
export function declaredGround(layers, prior) {
  const suites = [];
  const entries = new Set();
  for (const layer of layers) {
    const record = prior.get(layer.name);
    if (!record || record.status !== 'green') {
      return refusal('undeclared-suite', `no green result stands for layer ${layer.name}`);
    }
    const parts = record.parts ?? [];
    if (parts.length === 0) {
      return refusal('undeclared-suite', `layer ${layer.name} reported no suite of its own`);
    }
    for (const part of parts) {
      const inputs = part.inputs ?? [];
      if (inputs.length === 0) {
        return refusal('undeclared-suite', `${layer.name}/${part.name} declared no inputs`);
      }
      for (const entry of inputs) entries.add(entry);
      suites.push(`${layer.name}/${part.name}`);
    }
  }
  if (suites.length === 0) {
    return refusal('undeclared-suite', 'the certified verdict names no suite');
  }
  return { ok: true, suites: suites.sort(), entries: [...entries].sort() };
}

/**
 * The ground half of the answer: null when the default branch moved nowhere
 * the certification rests on, a refusal otherwise.
 * @param {{mainChanged: {files: string[], unclassifiable: string[]},
 *   storyChanged: string[], entries: string[], testPaths: string[],
 *   breadth: string[]}} input
 */
export function groundVerdict({ mainChanged, storyChanged, entries, testPaths, breadth }) {
  if (mainChanged.unclassifiable.length > 0) {
    return refusal(
      'unclassifiable-change',
      `the default branch changed ground this check cannot read: ${list(mainChanged.unclassifiable)}`,
    );
  }
  const story = new Set(storyChanged);
  const sets = [
    ['the story\'s own diff', (file) => story.has(file)],
    ['a declared suite input', (file) => entries.some((entry) => underEntry(file, entry))],
    ['a suite file', (file) => testPaths.some((entry) => underEntry(file, entry))],
    ['the shared breadth list', (file) => breadth.some((entry) => underEntry(file, entry))],
  ];
  for (const file of mainChanged.files) {
    for (const [name, hit] of sets) {
      if (hit(file)) return refusal('ground-intersects', `${file} is ${name}`);
    }
  }
  return null;
}

/**
 * The version of the declarations this decision was checked against. It moves
 * when a declaration moves and at no other time, so two fast-path records
 * carrying one digest were decided under one set of claims.
 */
export function declarationDigest({ suites, entries, testPaths, breadth }) {
  const lines = [
    ...suites.map((suite) => `suite ${suite}`),
    ...entries.map((entry) => `input ${entry}`),
    ...[...testPaths].sort().map((entry) => `test ${entry}`),
    ...[...breadth].sort().map((entry) => `breadth ${entry}`),
  ].sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
}

/**
 * The whole decision, from facts alone. Pure: every git read is the caller's,
 * so the routes are testable without a repository.
 * @param {{certification: object|null, layers: Array<{name: string}>,
 *   prior: Map<string, object>, testPaths: string[], breadth: string[],
 *   storyDiffBefore: string, storyDiffAfter: string,
 *   mainChanged: {files: string[], unclassifiable: string[]},
 *   storyChanged: string[]}} input
 * @returns {{taken: boolean, refusal?: string, detail?: string,
 *   declaration?: object, certification?: object}}
 */
export function fastPathVerdict({
  certification,
  layers,
  prior,
  testPaths,
  breadth,
  storyDiffBefore,
  storyDiffAfter,
  mainChanged,
  storyChanged,
}) {
  if (!certification) {
    return refusal('no-certification', 'no green verdict stands for this tree');
  }
  // Question one. The cheapest of the two, and the one that holds whatever the
  // declarations claim: a tree that is not the branch plus the story's own
  // patch was never certified, by anybody, in any shape.
  if (storyDiffBefore !== storyDiffAfter) {
    return refusal('diff-changed', 'the update changed the story\'s own diff');
  }
  // The breadth list is what keeps the ground question from being answered by
  // the declarations alone. A project that declares none has not made the
  // claim this path stands on, so nothing here can fire (ADR-0056).
  if (breadth.length === 0) {
    return refusal('no-breadth-ground', 'the project declares no shared breadth ground');
  }
  const declared = declaredGround(layers, prior);
  if (declared.ok !== true) return declared;
  // Question two.
  const ground = groundVerdict({
    mainChanged,
    storyChanged,
    entries: declared.entries,
    testPaths,
    breadth,
  });
  if (ground) return ground;
  return {
    taken: true,
    declaration: {
      // The tree the suites declared these inputs at: the certified verdict's
      // own sha, because that is the execution the declarations came out of.
      sha: certification.sha,
      digest: declarationDigest({
        suites: declared.suites,
        entries: declared.entries,
        testPaths,
        breadth,
      }),
      suites: declared.suites,
      entries: declared.entries.length,
    },
    certification,
  };
}

/**
 * The git facts the decision reads. One merge base, two raw diffs, two
 * patches, and the commit list of the examined range.
 * @param {string} tree the run worktree
 * @param {{fromSha: string, toSha: string, mainSha: string}} shas the update's
 *   own three: the tree before it, the tree after it, and the branch it merged
 */
export async function fastPathFacts(tree, { fromSha, toSha, mainSha }) {
  const at = { cwd: tree };
  const baseSha = (await git(['merge-base', fromSha, mainSha], at)).trim();
  const mainChanged = parseRawDiff(
    await git(['diff', '--raw', '--no-renames', '-z', `${baseSha}..${mainSha}`], at),
  );
  const story = parseRawDiff(
    await git(['diff', '--raw', '--no-renames', '-z', `${baseSha}..${fromSha}`], at),
  );
  const wide = { ...at, maxBuffer: MAX_DIFF_BYTES };
  const storyDiffBefore = await git(['diff', '--no-renames', `${baseSha}..${fromSha}`], wide);
  // Two dots, and not three: the merge holds the branch, so this is the story's
  // own patch as it now sits on top of it.
  const storyDiffAfter = await git(['diff', '--no-renames', `${mainSha}..${toSha}`], wide);
  const revs = (await git(['rev-list', `${baseSha}..${mainSha}`], at))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reverse();
  return {
    baseSha,
    mainChanged,
    // The story's side keeps whatever this module could not classify: a name
    // it will not compare is a name it must treat as reached.
    storyChanged: [...story.files, ...story.unclassifiable],
    storyDiffBefore,
    storyDiffAfter,
    commits: revs.slice(-COMMIT_LIMIT),
    commitCount: revs.length,
  };
}

/**
 * The decision for one run, ready to stamp. Reads the run's own ledger for the
 * certification it would carry, the project config for the ground it is judged
 * against, and the worktree for the text.
 * @param {object} base the ship base (config, worktree, testPaths)
 * @param {object[]} events the run ledger
 * @param {{fromSha: string, toSha: string, mainSha: string}} shas
 */
export async function fastPathDecision(base, events, { fromSha, toSha, mainSha }) {
  const render = [...events].reverse().find((e) => e.event === 'verdict-rendered');
  const certification =
    render && render.verdict === 'green'
      ? { cycle: render.cycle, sha: render.sha, record: render.record }
      : null;
  if (!certification) {
    return refusal('no-certification', 'no green verdict stands for this tree');
  }
  const facts = await fastPathFacts(base.worktree, { fromSha, toSha, mainSha });
  const verdict = fastPathVerdict({
    certification,
    layers: base.config.gates.tier1 ?? [],
    // The certified cycle's own results included: a green a later cycle carried
    // keeps the stamp of the cycle that earned it, and that stamp is the one
    // holding the declaration.
    prior: priorStatus(events, certification.cycle + 1),
    testPaths: base.testPaths ?? [],
    breadth: base.config.gates.breadthGround ?? [],
    storyDiffBefore: facts.storyDiffBefore,
    storyDiffAfter: facts.storyDiffAfter,
    mainChanged: facts.mainChanged,
    storyChanged: facts.storyChanged,
  });
  const examined = {
    baseSha: facts.baseSha,
    commits: facts.commits,
    commitCount: facts.commitCount,
  };
  return verdict.taken === true
    ? { ...verdict, ...examined }
    : { ...verdict, baseSha: facts.baseSha };
}

function refusal(kind, detail) {
  return { taken: false, refusal: assertFastPathRefusal(kind), detail };
}

function list(paths) {
  const shown = paths.slice(0, DETAIL_PATHS).join(', ');
  return paths.length > DETAIL_PATHS ? `${shown} (+${paths.length - DETAIL_PATHS} more)` : shown;
}
