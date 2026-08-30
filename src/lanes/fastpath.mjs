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
// last met it must be answered by a claim somebody made. A file a claim reaches
// refuses, because a suite that depends on it was never run over it. A file NO
// claim reaches also refuses, because nothing said what depends on it and the
// part machinery's own rule is that doubt re-runs (parts.mjs). The one ending
// that passes is a file the project declared inert: ground it states no suite
// can reach. A change this module cannot read as a repo-relative file of this
// repository refuses for the same reason as an unclaimed one.
//
// Every refusal costs the run the re-verdict it would have taken anyway. The
// fast path can only remove work, so a defect in this module makes a ship
// slow and can never make one wrong.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isGlobEntry, underEntry } from '../config/project.mjs';
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
  // The project names no suite files, so a quarter of the ground question has
  // nothing behind it.
  'no-suite-ground',
  // A suite of the certified verdict said nothing about what it depends on.
  'undeclared-suite',
  // The declarations that decide this skip come off the run's own tree, and the
  // run's own tree moved the ground they are produced from.
  'self-declared-ground',
  // The certification carries a review-lens finding, and a lens declares no
  // ground, so no claim in this project can say the branch did not reach it.
  'lens-ground',
  // A change on the default branch this module cannot read as a file of this
  // repository: a submodule, a symlink, a mode flip, or a path it cannot
  // normalise.
  'unclassifiable-change',
  // The default branch moved on ground the certification rests on.
  'ground-intersects',
  // The default branch moved on ground no claim in this project reaches.
  'unclaimed-ground',
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

/**
 * The file mode git gives a symlink. The path in the record is the link, and
 * what it reaches is a path this module never reads; a declaration that names
 * the target says nothing about the link and the other way round.
 */
const SYMLINK = '120000';

/** The mode git gives the absent side of an addition or a deletion. */
const ABSENT = '000000';

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
 * The wall-clock bound on every git read this check takes.
 *
 * The check runs inside the ship token. A git that hangs, on a lock another
 * process holds or a filesystem that stopped answering, would hold the token
 * for as long as it hangs, and every run waiting to ship would wait with it.
 * A bounded read turns that into the ending this module already has for every
 * other failure: the call throws, the lane stamps `internal-error`, and the run
 * takes the full re-verdict.
 */
export const GIT_TIMEOUT_MS = 120_000;

/**
 * Reads one `git diff --raw -z` stream into the files it names and the records
 * this module cannot classify.
 *
 * The raw form is what carries the modes, and the modes are what say a record
 * is a submodule, a symlink, or a file whose mode alone moved. `-z` keeps every
 * path exact: a path with a quote, a backslash or a non-ASCII byte in it
 * arrives whole, where the default form would arrive quoted and this parse
 * would compare the quoting rather than the path.
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
    if (!readableModes(srcMode, dstMode)) {
      unclassifiable.push(path);
      continue;
    }
    const norm = groundEntry(path);
    if (norm === null) unclassifiable.push(path);
    else files.push(norm);
  }
  // A record the pairing did not close. Nothing here knows what it is, which
  // is exactly what the unclassifiable set is for.
  if (i < fields.length) unclassifiable.push(fields[i]);
  return { files, unclassifiable };
}

/**
 * Whether a record's two modes leave it a plain file this module may compare.
 *
 * A submodule and a symlink are ground it cannot read at all. A record whose
 * two modes differ while both sides exist is a change in what the path IS: a
 * file that became executable, a file that became a symlink. A
 * declaration that names the path claims its content, never its mode. An
 * addition and a deletion carry the absent mode on one side, and both of those
 * are ordinary changes to the path's content.
 */
function readableModes(srcMode, dstMode) {
  for (const mode of [srcMode, dstMode]) {
    if (mode === GITLINK || mode === SYMLINK) return false;
  }
  if (srcMode !== dstMode && srcMode !== ABSENT && dstMode !== ABSENT) return false;
  return true;
}

/**
 * The one canonical form every path in this module is compared in, or null for
 * a name it will not compare at all.
 *
 * Every path here meets the same vocabulary: git's own output, a suite's
 * declared input, a layer command's argv, an import specifier a gate script
 * holds. They arrive written differently for the same file, and a comparison
 * of two spellings is not a comparison of two paths. `./docs` is the entry this
 * exists for: it reads like a declaration of `docs` and it matches nothing,
 * because the path vocabulary compares a plain entry as a prefix and no
 * repo-relative path begins `./`. A declaration that matches nothing is the
 * undeclared case wearing a declaration's clothes.
 *
 * The form: separators forward, `.` and empty segments dropped (which strips
 * every `./` prefix and collapses every `//`), no trailing slash. Null for an
 * absolute path, a path that climbs out of the repository, and a name that
 * canonicalises to nothing at all (`.`, `./`, `/`, an empty string).
 */
export function groundEntry(entry) {
  if (typeof entry !== 'string') return null;
  const raw = entry.replaceAll('\\', '/').trim();
  if (raw.length === 0) return null;
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) return null;
  const parts = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    parts.push(segment);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

/**
 * The declared ground of the certified verdict: every input every suite of
 * every Tier-1 layer named about itself, in the part-targeting contract's own
 * shape (ADR-0046).
 *
 * A layer without a standing green, a layer that reported no parts, a part that
 * declared no inputs, and a part whose every input names ground no path can
 * match each refuse. The default is always safety: a suite that says nothing
 * about its ground is a suite the module must assume depends on everything, and
 * a fast path over that assumption is no proof at all.
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
      const inputs = (part.inputs ?? []).map(groundEntry).filter((entry) => entry !== null);
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

/** How many files one layer's declaration surface may reach before it refuses. */
export const IMPORT_LIMIT = 500;

/** The extensions a specifier without one is tried under, in order. */
const IMPORT_EXTENSIONS = ['', '.mjs', '.js', '.cjs', '.ts', '/index.mjs', '/index.js'];

// Every literal module specifier a source file names. Static `from` clauses,
// bare side-effect imports, literal dynamic imports, and literal requires.
const SPECIFIER_FORMS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

// A specifier this module cannot read: an import or a require whose argument is
// not a literal string. What it reaches is decided at run time, and a surface
// decided at run time is a surface nothing can enumerate.
const COMPUTED_FORMS = [/\bimport\s*\(\s*[^'")\s]/, /\brequire\s*\(\s*[^'")\s]/];

/**
 * The files a Tier-1 layer's declarations are produced from: the command's own
 * argv paths, every module those files reach through a relative import, and the
 * directory each one sits in.
 *
 * The declarations that decide this skip are printed by the layer commands, and
 * those commands run in the RUN's worktree. That makes them the branch's own
 * report about itself, and a story that narrowed its inputs would be judged
 * against the narrowing it wrote. This set is how that is closed: the story's
 * diff may not touch it, so main's copy of every file a declaration comes out
 * of is byte for byte the run's copy, and the run's report is main's report.
 *
 * The argv path alone is not that set. A gate script that prints its markers
 * from a helper it imports has its declarations produced in the helper, and a
 * story editing the helper would narrow its own inputs with the guard looking
 * elsewhere. So the walk follows every relative specifier, transitively.
 *
 * Anything the walk cannot enumerate refuses. A layer whose command names no
 * file of this repository, a path that is a glob rather than a file, a file
 * that will not read, a relative specifier that resolves to nothing, an import
 * whose argument is computed rather than written: each is a surface with an
 * unknown edge, and an unknown edge is what this check exists to refuse.
 * A bare specifier is not followed and does not refuse: it names a dependency
 * rather than a file of this repository, and the shared breadth list is what
 * covers a dependency moving (ADR-0056).
 * @param {Array<{name: string, command: string}>} layers
 * @param {Record<string, string[]>} commands the project's command table
 * @param {(path: string) => string|null} readSource one repo-relative file's
 *   text, or null for a file that is not there
 */
export function declarationSources(layers, commands, readSource) {
  const entries = new Set();
  for (const layer of layers) {
    const argv = commands?.[layer.command] ?? [];
    const paths = argv.filter(looksLikeRepoPath).map(groundEntry).filter(Boolean);
    if (paths.length === 0) {
      return refusal(
        'self-declared-ground',
        `layer ${layer.name} runs a command that names no file of this repository, ` +
          'so the ground its declarations are produced from cannot be bounded',
      );
    }
    for (const path of paths) {
      const reached = reachableSources(path, readSource);
      if (reached.ok !== true) return reached;
      for (const file of reached.files) {
        entries.add(file);
        const dir = file.split('/').slice(0, -1).join('/');
        if (dir.length > 0) entries.add(dir);
      }
    }
  }
  if (entries.size === 0) {
    return refusal('self-declared-ground', 'no layer names the file its declarations come from');
  }
  return { ok: true, entries: [...entries].sort() };
}

/**
 * Every file one command path reaches, itself included, or a refusal naming the
 * edge the walk could not read.
 */
function reachableSources(entry, readSource) {
  if (isGlobEntry(entry)) {
    return refusal(
      'self-declared-ground',
      `${entry} names a set of files by pattern, so the modules its declarations ` +
        'come out of cannot be enumerated',
    );
  }
  const files = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift();
    if (files.has(path)) continue;
    if (files.size >= IMPORT_LIMIT) {
      return refusal(
        'self-declared-ground',
        `the declaration surface of ${entry} passes ${IMPORT_LIMIT} files`,
      );
    }
    files.add(path);
    const text = readOne(readSource, path);
    if (text === null) {
      return refusal('self-declared-ground', `the declaration source ${path} will not read`);
    }
    for (const form of COMPUTED_FORMS) {
      if (form.test(text)) {
        return refusal(
          'self-declared-ground',
          `${path} imports a module it names at run time, so what its declarations ` +
            'come out of cannot be enumerated',
        );
      }
    }
    for (const specifier of specifiersOf(text)) {
      if (!specifier.startsWith('.')) continue; // a dependency, not a file here
      const resolved = resolveSpecifier(path, specifier, readSource);
      if (resolved === null) {
        return refusal(
          'self-declared-ground',
          `${path} imports ${specifier}, which resolves to no file this check can read`,
        );
      }
      queue.push(resolved);
    }
  }
  return { ok: true, files: [...files] };
}

/** Every literal module specifier one source file names. */
function specifiersOf(text) {
  const out = new Set();
  for (const form of SPECIFIER_FORMS) {
    form.lastIndex = 0;
    let match;
    while ((match = form.exec(text)) !== null) out.add(match[1]);
  }
  return out;
}

/**
 * One relative specifier as a repo-relative file, or null when nothing under
 * the extensions this understands is there. A specifier that climbs out of the
 * repository canonicalises to null and answers null here, which refuses.
 */
function resolveSpecifier(from, specifier, readSource) {
  const base = from.split('/').slice(0, -1);
  for (const extension of IMPORT_EXTENSIONS) {
    const candidate = resolveAgainst(base, specifier + extension);
    if (candidate === null) continue;
    if (readOne(readSource, candidate) !== null) return candidate;
  }
  return null;
}

/**
 * One relative specifier against the segments of the importing file's
 * directory. `..` pops a segment here rather than nulling the path, which is
 * what a specifier means by it; a `..` that pops past the repository root
 * leaves the tree this check can read and answers null.
 */
function resolveAgainst(baseSegments, specifier) {
  const parts = [...baseSegments];
  for (const segment of specifier.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

/** One file's text, or null. A reader that throws is a file that is not there. */
function readOne(readSource, path) {
  try {
    const text = readSource(path);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * An argv word that names a path inside this repository rather than a flag.
 * The whole argv is read and not the tail of it: a command may be a script of
 * this repository run directly, in which case the first word is the path. A
 * word written `./gate.mjs` names a file here even after the prefix is
 * canonicalised away, and the raw spelling is what says so.
 */
function looksLikeRepoPath(word) {
  if (typeof word !== 'string' || word.startsWith('-')) return false;
  const norm = groundEntry(word);
  if (norm === null) return false;
  return norm.includes('/') || /^\.\//.test(word.replaceAll('\\', '/').trim());
}

/**
 * The ground half of the answer: null when every file the default branch gained
 * is ground the project declared inert, a refusal otherwise.
 *
 * Two refusals live here and they are opposites. A file a claim reaches is
 * ground the certification rests on, and the certification was never earned
 * over it. A file NO claim reaches is ground nobody described, and the part
 * machinery's rule for that is the one this follows: doubt re-runs.
 * @param {{mainChanged: {files: string[], unclassifiable: string[]},
 *   storyChanged: string[], entries: string[], testPaths: string[],
 *   breadth: string[], sources: string[], inert: string[]}} input
 */
export function groundVerdict({
  mainChanged,
  storyChanged,
  entries,
  testPaths,
  breadth,
  sources = [],
  inert = [],
}) {
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
    ['a declaration source', (file) => sources.some((entry) => underEntry(file, entry))],
  ];
  const unclaimed = [];
  for (const file of mainChanged.files) {
    for (const [name, hit] of sets) {
      if (hit(file)) return refusal('ground-intersects', `${file} is ${name}`);
    }
    if (!inert.some((entry) => underEntry(file, entry))) unclaimed.push(file);
  }
  if (unclaimed.length > 0) {
    return refusal(
      'unclaimed-ground',
      `the default branch changed ground no claim in this project reaches: ${list(unclaimed)}`,
    );
  }
  return null;
}

/**
 * The version of the declarations this decision was checked against. It moves
 * when a declaration moves and at no other time, so two fast-path records
 * carrying one digest were decided under one set of claims.
 */
export function declarationDigest({ suites, entries, testPaths, breadth, inert = [], sources = [] }) {
  const lines = [
    ...suites.map((suite) => `suite ${suite}`),
    ...entries.map((entry) => `input ${entry}`),
    ...[...testPaths].sort().map((entry) => `test ${entry}`),
    ...[...breadth].sort().map((entry) => `breadth ${entry}`),
    ...[...inert].sort().map((entry) => `inert ${entry}`),
    ...[...sources].sort().map((entry) => `source ${entry}`),
  ].sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
}

/**
 * The whole decision, from facts alone. Pure: every git read is the caller's,
 * so the routes are testable without a repository.
 * @param {{certification: object|null, layers: Array<{name: string}>,
 *   prior: Map<string, object>, commands: object, testPaths: string[],
 *   breadth: string[], inert: string[], lensFindings: string[],
 *   readSource: (path: string) => string|null,
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
  commands,
  testPaths,
  breadth,
  inert = [],
  lensFindings = [],
  readSource = () => null,
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
  // The suite files are one of the five sets the ground question asks. A
  // project that names none is answering a quarter of that question with an
  // empty list while the record reads like a whole answer.
  if (testPaths.length === 0) {
    return refusal('no-suite-ground', 'the project names no suite files of its own');
  }
  // The certification is a deterministic gate result AND a review panel's
  // reading of the tree (ADR-0022). A lens declares no inputs and reads the
  // whole repository around the diff, so no claim in this project can say the
  // branch did not move ground a lens finding rests on. Where the panel raised
  // nothing, the certification rests on declared ground alone and the two
  // questions below cover it.
  if (lensFindings.length > 0) {
    return refusal(
      'lens-ground',
      `the certification carries review-lens findings whose ground nothing declares: ${list(lensFindings)}`,
    );
  }
  const declared = declaredGround(layers, prior);
  if (declared.ok !== true) return declared;
  const sources = declarationSources(layers, commands, readSource);
  if (sources.ok !== true) return sources;
  // The declarations decide this skip and they came off the run's own tree. A
  // story that moved the ground they are produced from would be judged against
  // its own narrowing, so it is refused before the ground question is asked.
  const moved = storyChanged.filter((file) =>
    sources.entries.some((entry) => underEntry(file, entry)),
  );
  if (moved.length > 0) {
    return refusal(
      'self-declared-ground',
      `the story's own diff moves the declarations that decide this skip: ${list(moved)}`,
    );
  }
  // Question two.
  const ground = groundVerdict({
    mainChanged,
    storyChanged,
    entries: declared.entries,
    testPaths,
    breadth,
    sources: sources.entries,
    inert,
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
        inert,
        sources: sources.entries,
      }),
      suites: declared.suites,
      entries: declared.entries.length,
    },
    certification,
  };
}

/**
 * The git facts the decision reads. One merge base, two raw diffs, two
 * patches, and the commit list of the examined range. Every read is bounded in
 * time: this runs inside the ship token, and a read that never returns would
 * hold the token for every run behind it.
 * @param {string} tree the run worktree
 * @param {{fromSha: string, toSha: string, mainSha: string}} shas the update's
 *   own three: the tree before it, the tree after it, and the branch it merged
 * @param {{run?: typeof git}} [deps] the git runner, so a test can state what
 *   every read answered and what options it was given
 */
export async function fastPathFacts(tree, { fromSha, toSha, mainSha }, { run = git } = {}) {
  const at = { cwd: tree, timeout: GIT_TIMEOUT_MS };
  const baseSha = (await run(['merge-base', fromSha, mainSha], at)).trim();
  const mainChanged = parseRawDiff(
    await run(['diff', '--raw', '--no-renames', '-z', `${baseSha}..${mainSha}`], at),
  );
  const story = parseRawDiff(
    await run(['diff', '--raw', '--no-renames', '-z', `${baseSha}..${fromSha}`], at),
  );
  const wide = { ...at, maxBuffer: MAX_DIFF_BYTES };
  const storyDiffBefore = await run(['diff', '--no-renames', `${baseSha}..${fromSha}`], wide);
  // Two dots, and not three: the merge holds the branch, so this is the story's
  // own patch as it now sits on top of it.
  const storyDiffAfter = await run(['diff', '--no-renames', `${mainSha}..${toSha}`], wide);
  const revs = (await run(['rev-list', `${baseSha}..${mainSha}`], at))
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
    // The list is capped and the record has to say so. Without the marker a
    // reader of a 200-line list cannot tell a range of exactly 200 from a range
    // the record stopped writing down.
    ...(revs.length > COMMIT_LIMIT && { truncated: true, commitLimit: COMMIT_LIMIT }),
  };
}

/**
 * The review-lens findings one certification carries, open or resolved.
 *
 * The record is the verdict's own file. A finding a lens raised carries the
 * lens that raised it; a finding triage raised carries its class instead, and
 * that one rests on a gate result whose ground the declarations do name.
 * @param {string} path the verdict record
 */
export function lensFindingsOf(path) {
  const record = JSON.parse(readFileSync(path, 'utf8'));
  return (record.findings ?? [])
    .filter((finding) => typeof finding.lens === 'string' && finding.lens.length > 0)
    .map((finding) => `${finding.lens}/${finding.id ?? 'unnamed'}`);
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
    commands: base.config.commands ?? {},
    testPaths: base.testPaths ?? [],
    breadth: base.config.gates.breadthGround ?? [],
    inert: base.config.gates.inertGround ?? [],
    // A record this cannot read throws, and a throw is the internal-error
    // route, which is the full re-verdict.
    lensFindings: lensFindingsOf(certification.record),
    // The declaration surface is walked in the run's own worktree, which is
    // where the layer commands run and where the modules they import live.
    readSource: worktreeReader(base.worktree),
    storyDiffBefore: facts.storyDiffBefore,
    storyDiffAfter: facts.storyDiffAfter,
    mainChanged: facts.mainChanged,
    storyChanged: facts.storyChanged,
  });
  const examined = {
    baseSha: facts.baseSha,
    commits: facts.commits,
    commitCount: facts.commitCount,
    ...(facts.truncated && { truncated: true, commitLimit: facts.commitLimit }),
  };
  return verdict.taken === true
    ? { ...verdict, ...examined }
    : { ...verdict, baseSha: facts.baseSha };
}

/**
 * A reader of one repo-relative file of one worktree. The path is canonical by
 * the time it arrives here, so it names a file under the tree and nowhere else;
 * anything that will not read answers null, which the walk refuses on.
 */
export function worktreeReader(worktree) {
  return (path) => {
    const canonical = groundEntry(path);
    if (canonical === null) return null;
    try {
      return readFileSync(join(worktree, canonical), 'utf8');
    } catch {
      return null;
    }
  };
}

function refusal(kind, detail) {
  return { taken: false, refusal: assertFastPathRefusal(kind), detail };
}

function list(paths) {
  const shown = paths.slice(0, DETAIL_PATHS).join(', ');
  return paths.length > DETAIL_PATHS ? `${shown} (+${paths.length - DETAIL_PATHS} more)` : shown;
}
