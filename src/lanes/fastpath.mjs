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
// A layer's ground has two sources and one derivation, and the derivation is
// `layerGround()` in parts.mjs. The layer's own command states it, part by
// part, in the part protocol. The project states it on the layer entry of its
// config. A layer neither source declares refuses the whole check, and the
// launch rule makes that refusal unreachable for a project that turned the
// flag on.
//
// A run carries two certifications and each has a ground of its own. The code
// verdict's ground is what the suites declare. The reconciliation's ground is
// the run's own records and their neighbourhood, which the caller computes at
// the merge. So the incoming work is listed once and asked two questions, and
// each answer is kept or redone on its own: a moved code file re-judges the
// code and leaves the records standing, and a moved record of the
// neighbourhood re-runs the reconciliation and leaves the code standing. A
// lane with one certification is asked one question. A record the run itself
// wrote is a re-run of the reconciliation and never a refusal, because the
// stage that owns it answers a conflict on it.
//
// Every refusal costs the run the re-verdict it would have taken anyway. The
// fast path can only remove work, so a defect in this module makes a ship
// slow and can never make one wrong.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PROJECT_CONFIG_PATH,
  groundEntries,
  groundEntry,
  isGlobEntry,
  underEntry,
} from '../config/project.mjs';
import { MAX_DIFF_BYTES, git } from '../isolation/git.mjs';
import { layerGround, partGround, recordMatch } from './parts.mjs';
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
  // A Tier-1 layer of the certified verdict holds no green result to carry.
  // Defensive: the update stage runs behind a green verdict.
  'no-standing-green',
  // A Tier-1 layer whose ground neither source declares: its own command said
  // nothing about what it depends on, and the project config states nothing
  // for it either. The launch rule refuses such a config, so this word is
  // unreachable for a project with `gates.fastPathShip: true`. One occurrence
  // means the validator and this reader disagree about what a declared ground
  // is, and that is a defect of the mechanism rather than of a project.
  'undeclared-suite',
  // The certification carries a proof nobody could run: a service was down
  // past the external wait and an operator let the ship go without it
  // (ADR-0069). A carry stands on a certification that proved the tree, and
  // this one states in writing that part of the tree is unproven.
  'deferred-proof',
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
  // The default branch moved a record the run's reconciliation rests on: one
  // of the run's own records, or a record of their neighbourhood. The code
  // certification may still stand, and the answer says so; the run goes to the
  // reconciliation rather than to the request.
  'records-rerun',
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
 * The declared ground of the certified verdict: the whole ground of every
 * Tier-1 layer, from both sources, read through the one derivation
 * (`layerGround` in parts.mjs).
 *
 * A layer's ground comes from its own command, part by part, in the
 * part-targeting contract's shape (ADR-0046), or from the project config, or
 * from both. The two are unioned and read the same way. A layer neither source
 * declares refuses the whole check: the default is always safety, because a
 * layer that says nothing about its ground is a layer this module must assume
 * depends on everything, and a fast path over that assumption is no proof at
 * all. The launch rule makes that refusal unreachable for a project that
 * turned the flag on, so one occurrence is a disagreement between the
 * validator and this reader.
 *
 * A layer with no standing green and a certification carrying a deferred proof
 * each refuse with a word of their own.
 *
 * The standing green is read per layer, from the last cycle that RAN that
 * layer, and never from the last cycle alone. A cycle runs the layers its own
 * plan named and carries or skips the rest, so a layer a record-only cycle
 * left out keeps the green it earned, and the record it earned it on is the
 * one holding its declaration (`priorStatus` in spectrum.mjs).
 * @param {Array<{name: string, ground?: string[]}>} layers the project's
 *   Tier-1 layers
 * @param {Map<string, object>} prior each layer's standing `layer-result`
 * @param {{deferred?: object[], breadth?: string[], recordPaths?: string[]}}
 *   [options] `breadth` is `gates.breadthGround`, which belongs to every
 *   layer's ground; `recordPaths` keeps a record out of that shared list
 */
export function declaredGround(
  layers,
  prior,
  { deferred = [], breadth = [], recordPaths = [] } = {},
) {
  // A deferred part is a proof the ship went out without. Whatever the
  // declarations say about the ground it rests on, the certification does not
  // hold for it, so there is nothing here to carry over a moved base.
  if (deferred.length > 0) {
    const named = deferred
      .map((entry) => `${entry.layer}/${(entry.parts ?? []).join(', ')}`)
      .join('; ');
    return refusal('deferred-proof', `the certification defers a proof: ${named}`);
  }
  if (layers.length === 0) {
    return refusal('undeclared-suite', 'the certified verdict names no Tier-1 layer');
  }
  const suites = [];
  const entries = new Set();
  const groundLines = [];
  // The layers whose own COMMAND declared a ground. Only those are walked by
  // `declarationSources`: their markers come out of the run's own tree, and a
  // config ground is produced in no tree at all (item 6a of ADR-0056).
  const selfDeclaring = [];
  const counts = { declared: 0, config: 0 };
  for (const layer of layers) {
    const record = prior.get(layer.name);
    if (!record || record.status !== 'green') {
      return refusal('no-standing-green', `no green result stands for layer ${layer.name}`);
    }
    const ground = layerGround(layer, record, breadth, recordPaths);
    // The part refusal comes first, because it is the narrower diagnosis: a
    // layer that declares most of itself and holds one silent part is repaired
    // in a different place from a layer nobody described at all.
    for (const part of record.parts ?? []) {
      // A part that declared no inputs stands on the layer's floor, which is
      // the config ground and the breadth list. A sibling part's declaration
      // speaks for that sibling alone, so it is not a ground this part may
      // rest a certification on.
      if (partGround(part, ground).length === 0) {
        return refusal(
          'undeclared-suite',
          `${layer.name}/${part.name} declared no inputs, and no ground answers for it`,
        );
      }
      suites.push(`${layer.name}/${part.name}`);
    }
    // The breadth list is never a layer's whole ground: it is what belongs to
    // every suite ON TOP of what that suite declared. So the question here is
    // whether either source spoke, and not whether the union is non-empty.
    if (!ground.sources.declared && !ground.sources.config) {
      return refusal('undeclared-suite', `no source declares the ground of layer ${layer.name}`);
    }
    if (ground.sources.declared) {
      counts.declared += 1;
      selfDeclaring.push(layer);
    }
    if (ground.sources.config) {
      counts.config += 1;
      for (const entry of groundEntries(layer.ground)) groundLines.push(`${layer.name} ${entry}`);
    }
    for (const entry of ground.entries) entries.add(entry);
  }
  return {
    ok: true,
    suites: suites.sort(),
    entries: [...entries].sort(),
    ground: groundLines.sort(),
    selfDeclaring,
    counts,
  };
}

/** How many files one layer's declaration surface may reach before it refuses. */
export const IMPORT_LIMIT = 500;

/** The suffixes a specifier may name a file under. */
const IMPORT_EXTENSIONS = ['', '.mjs', '.js', '.cjs', '.ts', '/index.mjs', '/index.js'];

// The static forms: a `from` clause and a bare side-effect import. Both take a
// literal and nothing else, so a match is the whole specifier.
const STATIC_FORMS = [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g];

// A module load written as a call: `import(...)` and `require(...)`. The lookbehind
// keeps a method of that name (`db.import(x)`) out, and nothing else is excluded:
// what follows the paren decides, and it decides by proof.
const CALL_FORM = /(?<![.\w$])(import|require)\s*\(/g;

// The proof a call's argument is a specifier and not an expression: one quoted
// string, then the end of the argument. `import('./x', {with: …})` is a load of
// './x'; `import('./dir/' + name)` and `import(`./${d}`)` are not loads of
// anything this can name, so they are refused rather than skipped. A form that
// is neither followed nor refused is the hole this shape exists to close.
const LITERAL_ARGUMENT = /^\s*(['"])((?:[^'"\\]|\\.)*)\1\s*[),]/;

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
 *
 * The walk covers the layers whose own COMMAND declared a ground, and no
 * others. That is the whole reason the set exists: a config ground is produced
 * in no tree, so a story cannot narrow it, so there is nothing to bound. A
 * layer with a config-only ground may therefore run a command that names no
 * file of this repository. This narrows the scope of the walk and never its
 * strictness: every layer whose markers decide a skip is still walked, and
 * every edge the walk cannot read still refuses.
 * @param {Array<{name: string, command: string}>} layers the self-declaring
 *   Tier-1 layers; an empty list is a project whose ground is all config, and
 *   it bounds nothing because nothing in the run's tree declared anything
 * @param {Record<string, string[]>} commands the project's command table
 * @param {(path: string) => string|null} readSource one repo-relative file's
 *   text, or null for a file that is not there
 * @param {(path: string) => boolean} isLinkPath whether a repo-relative path
 *   reaches its content through a symlink, at any segment of it
 */
export function declarationSources(layers, commands, readSource, isLinkPath = () => false) {
  const entries = new Set();
  // No layer declared a ground of its own, so no marker of the run's tree
  // decides this skip and there is no surface to hold equal.
  if (layers.length === 0) return { ok: true, entries: [] };
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
      const reached = reachableSources(path, readSource, isLinkPath);
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
function reachableSources(entry, readSource, isLinkPath) {
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
    // A path that reaches its content through a link is a path whose name is
    // not its content. The guard compares names: the story's diff and the
    // branch's diff both name the target, and this set would name the link, so
    // an edit to the file the gate actually loads would pass the guard
    // untouched. What a link points at is also ground the ground question
    // classifies as unreadable, and the two readings have to agree.
    const link = linkedSegment(path, isLinkPath);
    if (link !== null) {
      return refusal(
        'self-declared-ground',
        `the declaration source ${path} reaches its content through a symlink ` +
          `(${link}), so the file it names is not the file it loads`,
      );
    }
    const text = readOne(readSource, path);
    if (text === null) {
      return refusal('self-declared-ground', `the declaration source ${path} will not read`);
    }
    const named = specifiersOf(text);
    if (named.ok !== true) {
      return refusal(
        'self-declared-ground',
        `${path} loads a module it names at run time (${named.form}), so what its ` +
          'declarations come out of cannot be enumerated',
      );
    }
    for (const specifier of named.specifiers) {
      if (!specifier.startsWith('.')) continue; // a dependency, not a file here
      const resolved = resolveSpecifier(path, specifier, readSource);
      if (resolved.ok !== true) {
        return refusal('self-declared-ground', `${path} imports ${specifier}, which ${resolved.why}`);
      }
      queue.push(resolved.path);
    }
  }
  return { ok: true, files: [...files] };
}

/**
 * The first segment of one path that is a symlink, or null.
 *
 * Every prefix is asked and not the last one only: a link in the middle of the
 * path moves the whole subtree under it, and the file at the end would read
 * perfectly well while living somewhere else entirely.
 */
function linkedSegment(path, isLinkPath) {
  const segments = path.split('/');
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('/');
    if (isLinkPath(prefix)) return prefix;
  }
  return null;
}

/**
 * Every module specifier one source file names, or the first call whose
 * argument is not one.
 *
 * The two answers partition every load the file writes. A static form takes a
 * literal and nothing else. A call form is proved a load of a named module or
 * it is refused: there is no third reading, because a form that is neither
 * followed nor refused is a module the walk misses in silence.
 * @returns {{ok: true, specifiers: Set<string>}|{ok: false, form: string}}
 */
export function specifiersOf(text) {
  const specifiers = new Set();
  for (const form of STATIC_FORMS) {
    form.lastIndex = 0;
    let match;
    while ((match = form.exec(text)) !== null) specifiers.add(match[1]);
  }
  CALL_FORM.lastIndex = 0;
  let call;
  while ((call = CALL_FORM.exec(text)) !== null) {
    const argument = text.slice(call.index + call[0].length);
    const literal = LITERAL_ARGUMENT.exec(argument);
    if (literal === null) {
      const shown = `${call[1]}(${argument.slice(0, 24).split('\n')[0]}`;
      return { ok: false, form: shown };
    }
    specifiers.add(literal[2]);
  }
  return { ok: true, specifiers };
}

/**
 * One relative specifier as the repo-relative file it names, or why it is not
 * one file.
 *
 * Every suffix is tried and every hit is kept, because the first hit is not the
 * answer: which of `x.mjs`, `x.js` and `x/index.js` a runtime loads depends on
 * the module kind and the package the file sits in, and a probe that guessed
 * would record a file the gate never loads while the real one stayed outside
 * the guard. Two candidates is therefore a refusal and not a choice.
 * @returns {{ok: true, path: string}|{ok: false, why: string}}
 */
function resolveSpecifier(from, specifier, readSource) {
  const base = from.split('/').slice(0, -1);
  const found = [];
  for (const extension of IMPORT_EXTENSIONS) {
    const candidate = resolveAgainst(base, specifier + extension);
    if (candidate === null || found.includes(candidate)) continue;
    if (readOne(readSource, candidate) !== null) found.push(candidate);
  }
  if (found.length === 0) return { ok: false, why: 'resolves to no file this check can read' };
  if (found.length > 1) {
    return { ok: false, why: `resolves to more than one file (${found.join(', ')})` };
  }
  return { ok: true, path: found[0] };
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
 * The ground half of the answer, for each certification the lane holds: what
 * the incoming work did to the code verdict, and what it did to the
 * reconciliation. One list of files, two questions, two answers.
 *
 * The code answer is `kept` when every file the default branch gained is
 * ground the project declared inert, and `rejudge` otherwise. Two reasons live
 * there and they are opposites. A file a claim reaches is ground the
 * certification rests on, and the certification was never earned over it. A
 * file NO claim reaches is ground nobody described, and the part machinery's
 * rule for that is the one this follows: doubt re-runs. The project config the
 * run pinned is one of the sets, because the config carries the ground of
 * every layer. A run judges against the blob it pinned at its launch; if the
 * default branch has since widened a layer's ground, the decision was made
 * under a claim the merge target no longer makes.
 *
 * A record leaves every one of those sets. The project states which layers
 * read a record, no suite is one of them, and a record the branch moved is the
 * second question's alone: reading it against the code sets would re-judge the
 * code for a file the code cannot see.
 *
 * The records answer is `rerun` when an incoming file is one of the run's own
 * records or a record of their neighbourhood, and `kept` otherwise. A record
 * outside the neighbourhood is a decision this run's records do not touch and
 * do not cite. A record the run itself wrote is a re-run and never a refusal:
 * the stage that owns it resolves the conflict and reviews it again over the
 * merged tree.
 *
 * @param {{files: string[], unclassifiable: string[]}} incoming what the
 *   default branch gained since the run last met it
 * @param {{code: {storyChanged: string[], entries: string[],
 *   testPaths: string[], breadth: string[], sources?: string[],
 *   inert?: string[], configPath?: string}|null,
 *   records: {neighbourhood?: string[], own?: string[],
 *   recordPaths?: string[]}|null}} questions the ground of each certification
 *   the lane holds; null for a certification it does not hold
 * @returns {{code: {answer: 'kept'|'rejudge', reason?: string,
 *   detail?: string, files: string[]}|null,
 *   records: {answer: 'kept'|'rerun', reason?: string, detail?: string,
 *   files: string[]}|null}}
 */
export function groundVerdict(incoming, { code = null, records = null } = {}) {
  return {
    code: code === null ? null : codeAnswer(incoming, code, records),
    records: records === null ? null : recordsAnswer(incoming, records),
  };
}

/** The code verdict's answer over the incoming files that are not records. */
function codeAnswer(
  incoming,
  {
    storyChanged,
    entries,
    testPaths,
    breadth,
    sources = [],
    inert = [],
    configPath = DEFAULT_PROJECT_CONFIG_PATH,
  },
  records,
) {
  const isRecord = (records === null ? null : recordMatch(records.recordPaths ?? [])) ?? never;
  // A change this module cannot read is never a record: the second question
  // reads a path and this one reads a file, and a name neither can classify
  // belongs to the question that refuses on doubt.
  if (incoming.unclassifiable.length > 0) {
    return rejudge(
      'unclassifiable-change',
      `the default branch changed ground this check cannot read: ${list(incoming.unclassifiable)}`,
      incoming.unclassifiable,
    );
  }
  const story = new Set(storyChanged);
  // The order decides which claim the answer names, and nothing else: one hit
  // in any set re-judges. The specific claims come first. A layer's ground is
  // the union of the config's claim, the commands' claims and the breadth
  // list, so `a declared suite input` reaches every file the three sets before
  // it reach, and a record that named it first would stop naming the list that
  // actually claimed the file.
  const sets = [
    ['the story\'s own diff', (file) => story.has(file)],
    ['a declaration source', (file) => sources.some((entry) => underEntry(file, entry))],
    [
      'the project config the run pinned',
      (file) => typeof configPath === 'string' && underEntry(file, configPath),
    ],
    ['a suite file', (file) => testPaths.some((entry) => underEntry(file, entry))],
    ['the shared breadth list', (file) => breadth.some((entry) => underEntry(file, entry))],
    ['a declared suite input', (file) => entries.some((entry) => underEntry(file, entry))],
  ];
  const unclaimed = [];
  for (const file of incoming.files) {
    if (isRecord(file)) continue;
    for (const [name, hit] of sets) {
      if (hit(file)) return rejudge('ground-intersects', `${file} is ${name}`, [file]);
    }
    if (!inert.some((entry) => underEntry(file, entry))) unclaimed.push(file);
  }
  if (unclaimed.length > 0) {
    return rejudge(
      'unclaimed-ground',
      `the default branch changed ground no claim in this project reaches: ${list(unclaimed)}`,
      unclaimed,
    );
  }
  return { answer: 'kept', files: [] };
}

/** The reconciliation's answer over the run's records and their neighbours. */
function recordsAnswer(incoming, { neighbourhood = [], own = [] }) {
  const mine = new Set(own);
  const named = [];
  const neighbours = [];
  // A path this module cannot read as a file is asked the same question: the
  // name is what the neighbourhood is stated in, and a record reached through
  // a link or a mode flip is still that record moving.
  for (const file of [...incoming.files, ...incoming.unclassifiable]) {
    if (mine.has(file)) named.push(file);
    else if (neighbourhood.some((entry) => underEntry(file, entry))) neighbours.push(file);
  }
  if (named.length > 0) {
    return {
      answer: 'rerun',
      reason: 'own-record',
      detail: `the default branch moved a record this run wrote: ${list(named)}`,
      files: [...named, ...neighbours],
    };
  }
  if (neighbours.length > 0) {
    return {
      answer: 'rerun',
      reason: 'neighbourhood',
      detail: `the default branch moved a record of the run's neighbourhood: ${list(neighbours)}`,
      files: neighbours,
    };
  }
  // A record outside the neighbourhood is no answer at all, and it must not
  // read as one: the reconciliation never rested on it. The word is stamped
  // because a records answer that stands where the code answer fell is a
  // half-carry, and a reader of the stamp has to see which half and why.
  return { answer: 'kept', reason: 'no-record-moved', files: [] };
}

/**
 * The review finding that stops a carry, or null where none does.
 *
 * A finding rests on the files the seat that raised it named, and the question
 * is the question every other claim is asked: did the default branch move that
 * ground. A finding that names none is the old refusal, unchanged: nothing in
 * this project can say the branch left its ground alone, so the certification
 * it rides is earned again.
 *
 * The incoming names this check cannot read as files of this repository are
 * not asked, because the code answer refuses them by the word that names what
 * is wrong with them.
 */
function lensRefusal(lensFindings, incoming) {
  const groundless = lensFindings.filter((f) => !(f.ground?.length > 0));
  if (groundless.length > 0) {
    return refusal(
      'lens-ground',
      'the certification carries review findings that declare no ground: ' +
        list(groundless.map((f) => f.id)),
    );
  }
  for (const file of incoming.files) {
    const hit = lensFindings.find((f) => f.ground.some((entry) => underEntry(file, entry)));
    if (hit) {
      return refusal(
        'lens-ground',
        `the default branch changed ${file}, the ground of review finding ${hit.id}`,
      );
    }
  }
  return null;
}

/** One code answer that says the verdict must judge the tree again. */
function rejudge(reason, detail, files) {
  return { answer: 'rejudge', reason: assertFastPathRefusal(reason), detail, files };
}

/** The matcher a lane with no record tree behind it stands on. */
const never = () => false;

/**
 * The version of the declarations this decision was checked against. It moves
 * when a declaration moves and at no other time, so two fast-path records
 * carrying one digest were decided under one set of claims.
 */
export function declarationDigest({
  suites,
  entries,
  testPaths,
  breadth,
  inert = [],
  sources = [],
  ground = [],
}) {
  const lines = [
    ...suites.map((suite) => `suite ${suite}`),
    ...entries.map((entry) => `input ${entry}`),
    ...[...testPaths].sort().map((entry) => `test ${entry}`),
    ...[...breadth].sort().map((entry) => `breadth ${entry}`),
    ...[...inert].sort().map((entry) => `inert ${entry}`),
    ...[...sources].sort().map((entry) => `source ${entry}`),
    // One line per config ground entry, named by its layer. The config half of
    // a layer's ground is a claim like any other, so the version moves when it
    // moves.
    ...[...ground].sort().map((entry) => `ground ${entry}`),
  ].sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
}

/**
 * The whole decision, from facts alone. Pure: every git read is the caller's,
 * so the routes are testable without a repository.
 *
 * The lane says which certifications it holds. `certification` is the code
 * verdict's, or null for a lane that renders no code verdict; `records` is the
 * reconciliation's ground, or null for a lane that reconciles nothing. Every
 * check that answers for the code certification runs only where that
 * certification exists: a records lane has no declared suite ground, no lens
 * findings and no suite files to ask about, and asking anyway would refuse
 * every ship it takes.
 *
 * Both answers ride every ending, refusals included, so the caller reads two
 * answers whatever happened. A refusal is a certification this check could not
 * carry, and the answer under it says the same thing in the caller's words.
 * The two refusals that belong to one side alone are the exception: they leave
 * the other side to its own evidence.
 *
 * `recordsSettled` is the records answer the caller already holds, which is the
 * reconciliation it cannot show. The code question is asked anyway, because a
 * records fact says nothing about the code.
 * @param {{certification: object|null,
 *   records: {neighbourhood?: string[], recordPaths?: string[]}|null,
 *   recordsSettled: object|null,
 *   layers: Array<{name: string, ground?: string[]}>,
 *   prior: Map<string, object>, commands: object, testPaths: string[],
 *   breadth: string[], inert: string[],
 *   lensFindings: Array<{id: string, ground: string[]}>,
 *   configPath: string, readSource: (path: string) => string|null,
 *   storyDiffBefore: string, storyDiffAfter: string,
 *   mainChanged: {files: string[], unclassifiable: string[]},
 *   storyChanged: string[]}} input
 * @returns {{taken: boolean, refusal?: string, detail?: string,
 *   code?: object|null, records?: object|null,
 *   declaration?: object, certification?: object}}
 */
export function fastPathVerdict({
  certification,
  records = null,
  recordsSettled = null,
  layers,
  prior,
  commands,
  testPaths,
  breadth,
  inert = [],
  lensFindings = [],
  configPath = DEFAULT_PROJECT_CONFIG_PATH,
  readSource = () => null,
  isLinkPath = () => false,
  storyDiffBefore,
  storyDiffAfter,
  mainChanged,
  storyChanged,
}) {
  const scope = {
    code: Boolean(certification),
    records: records !== null || recordsSettled !== null,
  };
  if (!scope.code && !scope.records) {
    return refusal('no-certification', 'no green verdict stands for this tree');
  }
  // The records answer this call already holds, carried under every refusal
  // below so a code refusal never overwrites a records fact.
  const settled = recordsSettled === null ? {} : { records: recordsSettled };
  // The reconciliation's own answer over the incoming work, for the refusals
  // that are the code's alone. The run's own records are a re-run and never a
  // refusal: the stage that wrote them answers a conflict on them.
  const recordsOwn = () =>
    records === null
      ? null
      : recordsAnswer(mainChanged, {
          neighbourhood: records.neighbourhood ?? [],
          own: ownRecords(storyChanged, records.recordPaths ?? []),
        });
  // Question one. The cheapest of them, and the one that holds whatever any
  // declaration claims: a tree that is not the branch plus the run's own patch
  // was never certified, by anybody, in any shape.
  if (storyDiffBefore !== storyDiffAfter) {
    return answered(
      refusal('diff-changed', 'the update changed the story\'s own diff'),
      scope,
      settled,
    );
  }
  let code = null;
  let declared = null;
  let sources = { ok: true, entries: [] };
  if (scope.code) {
    // The breadth list is what keeps the ground question from being answered
    // by the declarations alone. A project that declares none has not made the
    // claim this path stands on, so nothing here can fire (ADR-0056).
    if (breadth.length === 0) {
      return answered(
        refusal('no-breadth-ground', 'the project declares no shared breadth ground'),
        scope,
        settled,
      );
    }
    // The suite files are one of the six sets the code question asks. A
    // project that names none is answering a sixth of that question with an
    // empty list while the record reads like a whole answer.
    if (testPaths.length === 0) {
      return answered(
        refusal('no-suite-ground', 'the project names no suite files of its own'),
        scope,
        settled,
      );
    }
    // The certification is a deterministic gate result AND a review panel's
    // reading of the tree (ADR-0022). A finding names the ground it rests on,
    // so a branch that moved that ground costs the run its code certification
    // and a branch that moved none of it leaves the findings standing. Where
    // the panel raised nothing, the certification rests on declared ground
    // alone and the questions below cover it.
    //
    // This one is the code's alone. A finding is a reading of the code, and
    // the reconciliation never rested on it, so the records answer is computed
    // on the records' own evidence rather than copied from this refusal.
    const lens = lensRefusal(lensFindings, mainChanged);
    if (lens !== null) return answered(lens, scope, { records: recordsOwn(), ...settled });
    declared = declaredGround(layers, prior, {
      deferred: deferredOf(certification.record),
      breadth,
      recordPaths: records?.recordPaths ?? [],
    });
    if (declared.ok !== true) return answered(declared, scope, settled);
    // The self-declaring layers alone. A layer whose ground is config-only is
    // produced in no tree, so a story cannot narrow it and there is nothing
    // here to bound (ADR-0056).
    sources = declarationSources(declared.selfDeclaring, commands, readSource, isLinkPath);
    if (sources.ok !== true) return answered(sources, scope, settled);
    // The declarations decide this skip and they came off the run's own tree.
    // A story that moved the ground they are produced from would be judged
    // against its own narrowing, so it is refused before the ground question
    // is asked.
    const moved = storyChanged.filter((file) =>
      sources.entries.some((entry) => underEntry(file, entry)),
    );
    if (moved.length > 0) {
      return answered(
        refusal(
          'self-declared-ground',
          `the story's own diff moves the declarations that decide this skip: ${list(moved)}`,
        ),
        scope,
        settled,
      );
    }
    code = {
      storyChanged,
      entries: declared.entries,
      testPaths,
      breadth,
      sources: sources.entries,
      inert,
      configPath,
    };
  }
  // Question two, once, for both certifications.
  const ground = groundVerdict(mainChanged, {
    code,
    records:
      records === null
        ? null
        : {
            neighbourhood: records.neighbourhood ?? [],
            recordPaths: records.recordPaths ?? [],
            // The run's own records, off its own diff. They are a re-run of
            // the reconciliation and never a refusal: the stage that wrote
            // them answers a conflict on them.
            own: ownRecords(storyChanged, records.recordPaths ?? []),
          },
  });
  const answers = { code: ground.code, records: recordsSettled ?? ground.records };
  const kept = answers.code?.answer !== 'rejudge' && answers.records?.answer !== 'rerun';
  if (!kept) {
    const refused =
      answers.code?.answer === 'rejudge'
        ? { refusal: answers.code.reason, detail: answers.code.detail }
        : { refusal: recordsWord(answers.records), detail: answers.records.detail };
    return {
      taken: false,
      refusal: assertFastPathRefusal(refused.refusal),
      detail: refused.detail,
      ...answers,
    };
  }
  return {
    taken: true,
    ...answers,
    ...(declared !== null && {
      declaration: {
        // The tree the suites declared these inputs at: the certified
        // verdict's own sha, because that is the execution the declarations
        // came out of.
        sha: certification.sha,
        digest: declarationDigest({
          suites: declared.suites,
          entries: declared.entries,
          testPaths,
          breadth,
          inert,
          sources: sources.entries,
          ground: declared.ground,
        }),
        suites: declared.suites,
        entries: declared.entries.length,
        // How many Tier-1 layers each source answered for. A layer both
        // answered counts in both. A project whose reading moves from
        // `{declared: 8, config: 40}` to `{declared: 7, config: 40}` has a
        // runner that stopped printing its markers, and nothing else in the
        // record says so.
        ground: declared.counts,
      },
      certification,
    }),
  };
}

/** The run's own records, out of its own diff. */
function ownRecords(storyChanged, recordPaths) {
  const isRecord = recordMatch(recordPaths);
  return isRecord === null ? [] : storyChanged.filter(isRecord);
}

/**
 * The word a records rerun is refused under: the closed refusal the records
 * answer already carries, or the word for a record this run rests on moving.
 * `own-record` and `neighbourhood` say which record moved and are not refusals
 * of this check.
 */
function recordsWord(answer) {
  return FAST_PATH_REFUSALS.has(answer.reason) ? answer.reason : 'records-rerun';
}

/**
 * One refusal with the answer it is for each certification in scope. A refusal
 * is a certification this check could not carry over the moved tree, so every
 * answer under it says the caller must earn that certification again.
 *
 * `settled` is the answer one side has already reached on its own evidence. A
 * refusal that belongs to one certification says nothing about the other, and
 * copying it there costs the run a journey nothing asked for.
 */
function answered(out, scope, settled = {}) {
  const copy = (answer) => ({ answer, reason: out.refusal, detail: out.detail, files: [] });
  return {
    ...out,
    code: settled.code ?? (scope.code ? copy('rejudge') : null),
    records: settled.records ?? (scope.records ? copy('rerun') : null),
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
  // The two full-patch reads carry the harness's diff cap. A story diff is the
  // only read here that grows with the work, and the runner's default cap is a
  // megabyte. A story past the cap throws, which is the internal-error route,
  // which is the full re-verdict: the wrong answer is never one of the endings.
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
 * The proofs a certification records as deferred, or an empty list. A record
 * this cannot read answers with none, and the read that follows it — the lens
 * findings — throws on the same file, which is the internal-error route and
 * the full re-verdict (ADR-0069).
 */
function deferredOf(recordPath) {
  try {
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    return Array.isArray(record.deferred) ? record.deferred : [];
  } catch {
    return [];
  }
}

/**
 * The review-lens findings one certification carries, open or resolved.
 *
 * The record is the verdict's own file. A finding a lens raised carries the
 * lens that raised it; a finding triage raised carries its class instead, and
 * that one rests on a gate result whose ground the declarations do name.
 *
 * Each one comes back with the ground the seat that raised it named, so the
 * check can ask the same question of a lens finding it asks of a suite: did
 * the branch move what this claim rests on.
 * @param {string} path the verdict record
 * @returns {Array<{id: string, ground: string[]}>}
 */
export function lensFindingsOf(path) {
  const record = JSON.parse(readFileSync(path, 'utf8'));
  return (record.findings ?? [])
    .filter((finding) => typeof finding.lens === 'string' && finding.lens.length > 0)
    .map((finding) => ({
      id: `${finding.lens}/${finding.id ?? 'unnamed'}`,
      // A record written before a finding carried its ground answers with
      // none, which is the refusal this check always gave.
      ground: Array.isArray(finding.ground) ? finding.ground : [],
    }));
}

/**
 * The certification the code question is asked about, from the lane's own
 * statement of what it certified and the ledger's record of it.
 *
 * A lane that says nothing takes the last green render, which is what every
 * caller took before a run held two certifications. A lane that names the code
 * tree it certified is answered from the render at that sha: the render
 * carries the cycle whose execution the declarations came out of, and the
 * record file the deferred proofs and the lens findings are read from.
 *
 * @param {object[]} events the run ledger
 * @param {{ok: boolean, sha: string}|null|undefined} certified
 *   `certifiedTrees.code`; undefined for a caller that names no lane
 * @returns {{cycle: number, sha: string, record: string}|null}
 */
export function codeCertification(events, certified) {
  const back = [...events].reverse();
  if (certified === undefined) {
    const last = back.find((e) => e.event === 'verdict-rendered');
    return last?.verdict === 'green' ? carried(last) : null;
  }
  if (certified === null || certified.ok !== true) return null;
  const render = back.find(
    (e) => e.event === 'verdict-rendered' && e.verdict === 'green' && e.sha === certified.sha,
  );
  return render ? carried(render) : null;
}

/** One render, as the check reads a certification off it. */
function carried(render) {
  return { cycle: render.cycle, sha: render.sha, record: render.record };
}

/**
 * The decision for one run, ready to stamp. Reads the run's own ledger for the
 * certification it would carry, the project config for the ground it is judged
 * against, and the worktree for the text.
 *
 * `certification` is the lane's `certifiedTrees`: the code tree it certified
 * and the record tree it certified, either of which may be absent, because a
 * records lane renders no code verdict and a lane with no records reconciles
 * nothing. `no-certification` is refused for a certification the lane HAS and
 * cannot show, and never for one it does not have. A caller that names neither
 * is a caller from before this, and it takes the last green render as it
 * always did.
 * @param {object} base the ship base (config, worktree, testPaths)
 * @param {object[]} events the run ledger
 * @param {{fromSha: string, toSha: string, mainSha: string}} shas
 * @param {{certification?: {code?: object|null, records?: object|null},
 *   records?: {neighbourhood?: string[], recordPaths?: string[]}}} [lane]
 *   `records.neighbourhood` is the run's own records and the records they
 *   name, by path, computed at the merge
 */
export async function fastPathDecision(
  base,
  events,
  { fromSha, toSha, mainSha },
  { certification: certified = null, records: neighbourhood = null } = {},
) {
  const certification = codeCertification(events, certified?.code);
  const reconciled = certified?.records ?? null;
  const scope = { code: certified?.code !== null, records: reconciled !== null };
  if (!scope.code && !scope.records) {
    return refusal('no-certification', 'the lane certifies nothing');
  }
  // The lane holds this certification and cannot show a green for it. That is
  // the defensive route it always was, and it is now asked once per
  // certification instead of once for the run.
  if (scope.code && !certification) {
    return answered(refusal('no-certification', 'no green verdict stands for this tree'), scope);
  }
  // The reconciliation this lane holds and cannot show. It is a records fact
  // and it says nothing about the code, so where the lane also holds a code
  // certification the code question is asked and this answer rides beside it.
  // A lane with no code certification has nothing left to ask, and ends here
  // before the first git read.
  const recordsSettled =
    scope.records && reconciled.ok !== true
      ? {
          answer: 'rerun',
          reason: 'no-certification',
          detail: 'no green reconciliation stands for this tree',
          files: [],
        }
      : null;
  if (recordsSettled && !scope.code) {
    return answered(refusal('no-certification', recordsSettled.detail), scope);
  }
  // The reconciliation's ground rides on even where its answer is settled: the
  // code question reads the record paths to know which incoming files are not
  // its own, and a code answer that judged a record would refuse every ship a
  // record tree touches.
  const records =
    reconciled === null
      ? null
      : {
          neighbourhood: neighbourhood?.neighbourhood ?? [],
          recordPaths: neighbourhood?.recordPaths ?? base.config?.repo?.recordPaths ?? [],
        };
  const facts = await fastPathFacts(base.worktree, { fromSha, toSha, mainSha });
  const verdict = fastPathVerdict({
    certification,
    records,
    recordsSettled,
    layers: base.config.gates.tier1 ?? [],
    // The certified cycle's own results included, and every earlier cycle's
    // last word on a layer that cycle did not run: a green a later cycle
    // carried or skipped keeps the stamp of the cycle that earned it, and that
    // stamp is the one holding the declaration.
    prior: certification ? priorStatus(events, certification.cycle + 1) : new Map(),
    commands: base.config.commands ?? {},
    testPaths: base.testPaths ?? [],
    breadth: base.config.gates.breadthGround ?? [],
    // `inertGround` and NOT `gates.groundlessPaths`. This is the only reader
    // of `inertGround`, and it asks one question: may the default branch move
    // this file while a certified ship keeps its certification? The other list
    // answers a different question at a different moment: may a change to this
    // file reach a test suite? Only `src/lanes/parts.mjs` reads that one, and
    // neither list is derived from the other (ADR-0056, ADR-0059).
    inert: base.config.gates.inertGround ?? [],
    // The project config the run pinned at its launch. The config carries the
    // ground of every layer, so a default branch that moved it decided this
    // run's claims under a version the merge target no longer states.
    configPath: base.configPath ?? DEFAULT_PROJECT_CONFIG_PATH,
    // A record this cannot read throws, and a throw is the internal-error
    // route, which is the full re-verdict. A lane with no code certification
    // has no verdict record to read and no lens to answer for.
    lensFindings: certification ? lensFindingsOf(certification.record) : [],
    // The declaration surface is walked in the run's own worktree, which is
    // where the layer commands run and where the modules they import live.
    readSource: worktreeReader(base.worktree),
    isLinkPath: worktreeLinks(base.worktree),
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

/**
 * Whether one repo-relative path of one worktree is itself a symlink. The walk
 * asks about every segment of a path in turn, so this answers about the one it
 * is given and nothing under it.
 *
 * A path that cannot be stat-ed at all answers false. It is not a link; it is
 * a file that is not there, and the read that follows says so in the words that
 * fact deserves.
 */
export function worktreeLinks(worktree) {
  return (path) => {
    const canonical = groundEntry(path);
    if (canonical === null) return false;
    try {
      return lstatSync(join(worktree, canonical)).isSymbolicLink();
    } catch {
      return false;
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
