// The machine's credential store, read at the moment of use.
//
// A daemon inherits a copy of the environment from the window that started it,
// and that window took its own copy when it opened. A password changed after
// either copy was taken is invisible to the daemon for the whole life of the
// process: every probe, every seat and every suite reads the stale copy, and
// nothing says so. The store closes that gap. The instance names where this
// host keeps its credentials, the harness reads that place at every use, and
// each read leaves a fingerprint of what it found (ADR-0064).
//
// Two kinds, because two hosts keep credentials in two places. A Windows host
// keeps them in the user's stored environment, which lives in the registry and
// is read with `reg.exe`. Never with PowerShell: PS 5.1 appends a CRLF to a
// piped value and has corrupted exact-byte values before. Every other host, CI
// and the unit tests use a dotenv-style file.
//
// Nothing here mutates `process.env`. The fresh values ride the merged
// environment of each spawn, so a seat the strip removes secrets from cannot
// pick one up through the parent.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * How much of the hash identifies a value. Twelve hex characters name a value
 * without revealing it: two reads of the same password read as one value, and
 * a rotation to a new one reads as a change. Never the value, and never its
 * length.
 */
export const FINGERPRINT_CHARS = 12;

/** The registry key that holds a Windows user's stored environment. */
export const WINDOWS_USER_ENV_KEY = 'HKCU\\Environment';

/** The store kinds an instance config may name. */
export const STORE_KINDS = ['windows-user-env', 'env-file'];

// The two registry value types a stored environment variable is written as.
// Anything else in that key is not a string this harness can hand a process.
const STRING_TYPES = new Set(['REG_SZ', 'REG_EXPAND_SZ']);

/**
 * The fingerprint of one value, or null for a value that is not there.
 * @param {unknown} value
 * @returns {string|null}
 */
export function fingerprint(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, FINGERPRINT_CHARS);
}

/**
 * The store the daemon home declares, or null when it declares none. Read from
 * the file rather than from a daemon field, because the readers here run in
 * lane code that holds no daemon. An unreadable or invalid file names no store,
 * which is the behaviour of a host that never named one.
 * @param {ReturnType<import('./home.mjs').homePaths>} paths
 * @returns {{kind: string, path?: string}|null}
 */
export function declaredStore(paths) {
  const file = paths?.instanceConfig;
  if (typeof file !== 'string') return null;
  try {
    const store = JSON.parse(readFileSync(file, 'utf8'))?.credentialStore;
    return isStore(store) ? store : null;
  } catch {
    return null;
  }
}

/**
 * The variable names a project config declares, in declaration order and
 * without repeats. Exactly these names are read from the store: a store read is
 * a read of somebody's password, and the project's own declaration is the whole
 * list of the ones this harness has business with.
 * @param {object} config a parsed project config
 * @returns {string[]}
 */
export function declaredNames(config) {
  const seen = new Set();
  for (const credential of config?.credentials ?? []) {
    if (typeof credential?.env === 'string' && credential.env.length > 0) seen.add(credential.env);
  }
  return [...seen];
}

/**
 * One read of the store for the declared names.
 *
 * `values` is what a caller merges into an environment, and it holds only the
 * names the store answered for. A declared name the store does not hold falls
 * back to the inherited copy, which is what every caller had before this
 * existed; the fallback is recorded rather than silent.
 *
 * `records` is the read itself, one entry per declared name: where the value
 * came from and which value it was. `source` is `store` for a value the store
 * answered, `inherited` for the fallback, and `absent` for a name neither holds.
 * @param {{kind: string, path?: string}|null} store
 * @param {string[]} names
 * @param {{inherited?: object}} [opts]
 * @returns {{values: object, records: Array<{name: string, source: string,
 *   fingerprint?: string}>}}
 */
export function readCredentials(store, names, { inherited = process.env } = {}) {
  const values = {};
  const records = [];
  if (!isStore(store)) return { values, records };
  const read = storeReader(store);
  for (const name of names) {
    const stored = read(name, inherited);
    if (typeof stored === 'string') {
      values[name] = stored;
      records.push({ name, source: 'store', fingerprint: fingerprint(stored) });
      continue;
    }
    const held = inherited[name];
    if (typeof held === 'string' && held.length > 0) {
      records.push({ name, source: 'inherited', fingerprint: fingerprint(held) });
    } else {
      records.push({ name, source: 'absent' });
    }
  }
  return { values, records };
}

/**
 * The fresh values for the declared names, ready to merge freshest-last into an
 * environment. An empty object for a home that declares no store, so every
 * caller of a storeless home builds the environment it always built.
 * @param {ReturnType<import('./home.mjs').homePaths>} paths
 * @param {string[]} names
 * @returns {object}
 */
export function credentialEnv(paths, names) {
  if (names.length === 0) return {};
  return readCredentials(declaredStore(paths), names).values;
}

/**
 * The fingerprint this instance last recorded per variable name, folded from
 * the instance ledger. It is what a later read compares itself against, so a
 * rotation is stamped once rather than at every read after it.
 * @param {object[]} events instance-ledger events
 * @returns {Map<string, string|null>}
 */
export function lastFingerprints(events) {
  const held = new Map();
  for (const e of events) {
    if (e.event === 'credential-fingerprints') {
      for (const variable of e.variables ?? []) {
        if (typeof variable?.name === 'string') held.set(variable.name, variable.fingerprint ?? null);
      }
    } else if (e.event === 'credential-rotated' && typeof e.name === 'string') {
      held.set(e.name, e.to ?? null);
    }
  }
  return held;
}

/** True for a store declaration this module can read. */
function isStore(store) {
  if (typeof store !== 'object' || store === null || Array.isArray(store)) return false;
  if (store.kind === 'windows-user-env') return true;
  return store.kind === 'env-file' && typeof store.path === 'string' && store.path.length > 0;
}

/**
 * The reader for one store kind. It is built per read pass, so a file store
 * reads its file once for the whole pass and reads it again at the next use.
 */
function storeReader(store) {
  if (store.kind === 'windows-user-env') return readWindowsUserEnv;
  let table = null;
  return (name) => {
    if (table === null) table = parseEnvFile(fileText(store.path));
    return Object.hasOwn(table, name) ? table[name] : null;
  };
}

// -- the Windows stored environment -----------------------------------------

/**
 * One variable of the current user's stored environment, through `reg.exe`.
 * The query names the one variable, so no other value of that key is read.
 * A variable the key does not hold makes `reg.exe` exit nonzero, which is the
 * same answer as a host that cannot run it: this store holds no value for that
 * name, and the caller falls back.
 */
function readWindowsUserEnv(name, inherited) {
  if (process.platform !== 'win32') return null;
  let result;
  try {
    result = spawnSync('reg.exe', ['query', WINDOWS_USER_ENV_KEY, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch {
    return null;
  }
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  return parseRegValue(result.stdout, name, inherited);
}

/**
 * The value field of a `reg.exe query /v` answer.
 *
 * The output indents each value line and separates the name, the type and the
 * value with runs of spaces. Only the indent is trimmed: the value runs to the
 * end of the line, so a value that ends in a space keeps it. A name that is the
 * start of a longer name is not this line, because the separator run has to
 * follow the name exactly.
 * @returns {string|null} null when the answer holds no string value for the name
 */
export function parseRegValue(stdout, name, inherited = {}) {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line.startsWith(name)) continue;
    const match = /^ {2,}(REG_[A-Z_]+) {2,}([\s\S]*)$/.exec(line.slice(name.length));
    if (!match) continue;
    const [, type, value] = match;
    if (!STRING_TYPES.has(type)) return null;
    return type === 'REG_EXPAND_SZ' ? expand(value, inherited) : value;
  }
  return null;
}

/**
 * A `REG_EXPAND_SZ` value with its references filled in, the way the shell that
 * reads that type fills them in. A reference to a name the host does not hold
 * stays as written, because that is what the reader of this type does with one.
 */
function expand(text, inherited) {
  return text.replace(/%([^%]+)%/g, (whole, name) => {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(inherited)) {
      if (key.toLowerCase() === lower && typeof value === 'string') return value;
    }
    return whole;
  });
}

// -- the env file -----------------------------------------------------------

function fileText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * A dotenv-style file: one `NAME=value` per line, blank lines and `#` lines
 * ignored, an optional `export ` in front of the name. A quoted value keeps
 * every byte between the quotes, which is how a value that ends in a space is
 * written down; an unquoted value is trimmed at both ends.
 * @param {string|null} text
 * @returns {object}
 */
export function parseEnvFile(text) {
  const table = {};
  if (typeof text !== 'string') return table;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const cut = line.indexOf('=');
    if (cut === -1) continue;
    const name = line.slice(0, cut).trim().replace(/^export\s+/, '');
    if (name.length === 0) continue;
    table[name] = unquote(line.slice(cut + 1));
  }
  return table;
}

function unquote(value) {
  const text = value.trim();
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.length >= 2 && text.at(-1) === quote) {
    return text.slice(1, -1);
  }
  return text;
}
