// The lockfile grant: the content half of the dependency tier.
//
// The diff policy judges a path. One path cannot be judged that way: the pnpm
// lockfile is a single file that carries every dependency of every workspace
// package, so "the lane may write it" and "the lane may not write it" are both
// wrong. The lane may write exactly the dependency the card names, and nothing
// else in the file. That is a question about content, and this module answers
// it: given the file before the change, the file after it, and the grants the
// card earned, the grant either admits the change or names the block that
// broke it.
//
// It is a line reader over the lockfile's fixed shape, not a YAML parser. The
// harness carries zero runtime dependencies, and a parser is the wrong tool
// anyway: the grant holds the exact bytes of the lines that state a dependency,
// and a parser that round-tripped the file would throw those bytes away.
//
// What the grant does not hold is as deliberate as what it holds. `version:`
// lines inside an importer and the whole `snapshots` block move on any install,
// because pnpm rewrites peer suffixes across the tree when one package lands.
// Holding them would refuse pnpm's own output. They reach the verdict instead:
// a lockfile change grounds every layer, so the suite is what says the tree
// still works.

/** The one pnpm lockfile format this reader understands. */
export const LOCKFILE_VERSION = '9.0';

/**
 * The blocks a dependency install is allowed to touch. Everything else at the
 * top level states a policy of the repository, not a fact about one package,
 * and an install that moved one moved something the card never asked for.
 */
const INSTALL_BLOCKS = new Set(['importers', 'packages', 'snapshots']);

/**
 * The four indents the `importers` and `packages` blocks are written at. An
 * importer key and a packages entry key sit at the first, a dependency group
 * and a packages field at the second, a package inside a group at the third,
 * and a specifier or a version at the fourth.
 */
const KEY_INDENT = 2;
const GROUP_INDENT = 4;
const ENTRY_INDENT = 6;
const FIELD_INDENT = 8;

/** A top-level key: an identifier at column 0, with or without a value. */
const TOP_KEY = /^([^\s:]+):(?:\s.*)?$/;

const VERSION_LINE = /^version:/;
const SPECIFIER_LINE = /^specifier:/;
const RESOLUTION_LINE = /^resolution:/;

/**
 * Split into lines and drop one trailing carriage return from each.
 *
 * The two sides of the grant come from two places: `before` is read out of a
 * git object and `after` out of a working tree. A host that rewrites line
 * terminators at checkout hands back the same lockfile with a different
 * terminator on every line, and a byte comparison would then refuse every
 * dependency change ever made on that host. A terminator is not a dependency.
 */
function splitLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** Strip one layer of matching YAML quotes. */
function unquote(token) {
  const t = token.trim();
  if (t.length < 2) return t;
  const q = t[0];
  if ((q === "'" || q === '"') && t.endsWith(q)) return t.slice(1, -1);
  return t;
}

/**
 * The key a mapping line declares, unquoted, and the rest of the line after
 * the colon. A package name is quoted when YAML needs it (`'@scope/name'`) and
 * bare when it does not, so the quotes are syntax and never part of the name a
 * card writes.
 */
function keyOf(line) {
  const t = line.trimStart();
  if (t.startsWith("'") || t.startsWith('"')) {
    const end = t.indexOf(t[0], 1);
    if (end > 0) return { key: t.slice(1, end), rest: t.slice(end + 1).replace(/^:\s*/, '') };
  }
  const colon = t.indexOf(':');
  if (colon < 0) return { key: t.trimEnd(), rest: '' };
  return { key: t.slice(0, colon), rest: t.slice(colon + 1).trim() };
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Read a lockfile into its top-level blocks.
 *
 * Every line of the file lands in exactly one block, including any line before
 * the first key, which lands under the empty name. Nothing sits outside a
 * block, so the grant's byte comparison of the blocks it holds sees every byte
 * of the file it holds.
 *
 * @param {string} text
 * @returns {{version: string|null, blocks: Map<string, {name: string, line: number, lines: string[]}>}}
 *   `line` is 1-based and `lines` holds the key line first.
 */
export function readLockfile(text) {
  const lines = splitLines(text);
  const blocks = new Map();
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const match = TOP_KEY.exec(lines[i]);
    const name = match ? match[1] : current;
    if (name === null) {
      current = '';
      blocks.set('', { name: '', line: 1, lines: [] });
    } else if (!blocks.has(name)) {
      blocks.set(name, { name, line: i + 1, lines: [] });
      current = name;
    } else {
      current = name;
    }
    blocks.get(current).lines.push(lines[i]);
  }
  const head = blocks.get('lockfileVersion');
  const version = head ? unquote(keyOf(head.lines[0]).rest) || null : null;
  return { version, blocks };
}

/**
 * The importers of one lockfile: importer key to its entries, each entry keyed
 * by its group and name together. A package that moves between `dependencies`
 * and `devDependencies` moves which installs carry it, so the group is part of
 * the entry's identity and not a detail of where it is written.
 */
function readImporters(block) {
  const importers = new Map();
  if (!block) return importers;
  let importer = null;
  let group = null;
  let entry = null;
  for (let i = 0; i < block.lines.length; i++) {
    const raw = block.lines[i];
    if (!raw.trim()) continue;
    const indent = indentOf(raw);
    if (indent === KEY_INDENT) {
      const { key } = keyOf(raw);
      importer = { key, line: block.line + i, entries: new Map() };
      importers.set(key, importer);
      group = null;
      entry = null;
    } else if (indent === GROUP_INDENT && importer) {
      group = keyOf(raw).key;
      entry = null;
    } else if (indent === ENTRY_INDENT && importer && group !== null) {
      const { key } = keyOf(raw);
      entry = { group, name: key, line: block.line + i, lines: [raw] };
      importer.entries.set(`${group}\n${key}`, entry);
    } else if (indent >= FIELD_INDENT && entry) {
      entry.lines.push(raw);
    }
  }
  return importers;
}

/**
 * The packages of one lockfile: entry key to the `resolution:` block under it.
 * The resolution is the integrity claim, the one statement in the block that
 * says which bytes an install fetches. The rest of an entry is metadata the
 * resolver derives from those bytes.
 */
function readPackages(block) {
  const packages = new Map();
  if (!block) return packages;
  let entry = null;
  let inResolution = false;
  for (let i = 0; i < block.lines.length; i++) {
    const raw = block.lines[i];
    if (!raw.trim()) continue;
    const indent = indentOf(raw);
    if (indent === KEY_INDENT) {
      entry = { key: keyOf(raw).key, line: block.line + i, resolution: [] };
      packages.set(entry.key, entry);
      inResolution = false;
    } else if (indent === GROUP_INDENT && entry) {
      inResolution = RESOLUTION_LINE.test(raw.trimStart());
      if (inResolution) entry.resolution.push(raw);
    } else if (indent > GROUP_INDENT && entry && inResolution) {
      entry.resolution.push(raw);
    }
  }
  return packages;
}

/** The lines of an importer entry the grant holds: all of them but the version. */
function heldLines(entry) {
  return entry.lines.filter((line) => !VERSION_LINE.test(line.trimStart())).join('\n');
}

function hasSpecifier(entry) {
  return entry.lines.some((line) => SPECIFIER_LINE.test(line.trimStart()));
}

function refuse(block, line, reason) {
  return { ok: false, block, line, reason };
}

/** The union of two ordered key sets, in the first set's order, then the rest. */
function unionKeys(after, before) {
  const keys = [...after.keys()];
  for (const key of before.keys()) if (!after.has(key)) keys.push(key);
  return keys;
}

/**
 * Judge one lockfile change against the dependencies the card names.
 *
 * The checks run in the order the blocks appear in the file, and the first
 * block that breaks is the answer. One install wrote the file, so one
 * violation names what the seat has to put back.
 *
 * `line` is 1-based into `after`. When the refusal is an absence, and an
 * absence has no line of its own, it is the line of the structure that should
 * have held it.
 *
 * @param {string} before The lockfile as the run's base holds it.
 * @param {string} after The lockfile as the worktree holds it.
 * @param {Array<{importer: string, name: string}>} grants The dependencies the card names.
 * @returns {{ok: boolean, block: string|null, line: number|null, reason: string|null}}
 */
export function lockfileGrant(before, after, grants) {
  const named = Array.isArray(grants) ? grants : [];
  const a = readLockfile(after);
  const b = readLockfile(before);

  const versionLine = a.blocks.get('lockfileVersion')?.line ?? 1;
  for (const [side, read] of [
    ['the worktree', a],
    ['the base', b],
  ]) {
    if (read.version !== LOCKFILE_VERSION) {
      return refuse(
        'lockfileVersion',
        versionLine,
        `lockfileVersion: ${side} declares ${read.version === null ? 'no version' : read.version}, and the grant reads lockfile ${LOCKFILE_VERSION} alone.`,
      );
    }
  }

  for (const name of unionKeys(a.blocks, b.blocks)) {
    if (INSTALL_BLOCKS.has(name)) continue;
    const here = a.blocks.get(name);
    const there = b.blocks.get(name);
    if (here && there && here.lines.join('\n') === there.lines.join('\n')) continue;
    return refuse(
      name,
      here?.line ?? 1,
      `${name}: the block moved, and an install changes importers, packages and snapshots alone.`,
    );
  }

  const afterImporters = readImporters(a.blocks.get('importers'));
  const beforeImporters = readImporters(b.blocks.get('importers'));
  const importersLine = a.blocks.get('importers')?.line ?? 1;
  for (const key of unionKeys(afterImporters, beforeImporters)) {
    const here = afterImporters.get(key);
    const there = beforeImporters.get(key);
    const anchor = here?.line ?? importersLine;
    for (const [entryKey, entry] of there?.entries ?? []) {
      const now = here?.entries.get(entryKey);
      if (!now) {
        return refuse(
          'importers',
          anchor,
          `importers: ${key} no longer holds ${entry.name} under ${entry.group}, and a story removes no dependency.`,
        );
      }
      if (heldLines(now) !== heldLines(entry)) {
        return refuse(
          'importers',
          now.line,
          `importers: the ${key} entry for ${entry.name} moved, and only its version line may move.`,
        );
      }
    }
    for (const [entryKey, entry] of here?.entries ?? []) {
      if (there?.entries.has(entryKey)) continue;
      if (!named.some((g) => g.importer === key && g.name === entry.name)) {
        return refuse(
          'importers',
          entry.line,
          `importers: ${key} gained ${entry.name}, which the card does not name.`,
        );
      }
      if (!hasSpecifier(entry)) {
        return refuse(
          'importers',
          entry.line,
          `importers: the ${key} entry for ${entry.name} carries no specifier.`,
        );
      }
    }
  }

  // A grant the file does not hold means the card was answered and the package
  // never arrived, which leaves the lockfile changed for a reason nobody named.
  // An unchanged file says nothing either way, so it is nothing to answer for.
  if (splitLines(before).join('\n') !== splitLines(after).join('\n')) {
    for (const grant of named) {
      const holder = afterImporters.get(grant.importer);
      const held = [...(holder?.entries.values() ?? [])].some((e) => e.name === grant.name);
      if (held) continue;
      return refuse(
        'importers',
        holder?.line ?? importersLine,
        `importers: the card names ${grant.name} on ${grant.importer}, and that importer does not hold it.`,
      );
    }
  }

  const afterPackages = readPackages(a.blocks.get('packages'));
  const beforePackages = readPackages(b.blocks.get('packages'));
  for (const [key, entry] of afterPackages) {
    const was = beforePackages.get(key);
    if (!was) continue;
    if (entry.resolution.join('\n') === was.resolution.join('\n')) continue;
    return refuse(
      'packages',
      entry.line,
      `packages: ${key} moved its resolution, and an install resolves an existing package once.`,
    );
  }

  return { ok: true, block: null, line: null, reason: null };
}
