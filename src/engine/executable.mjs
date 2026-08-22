// Resolves the executable of a configured argv against the host.
//
// A command table names a tool the way the project knows it (`pnpm`, `gh`,
// `docker`) — the machine's install layout is not project knowledge, so the
// harness, not the config, carries the resolution. On Windows a tool often
// exists only as a `.cmd` shim: CreateProcess cannot run one, so a plain
// spawn of the bare name fails with ENOENT. This module finds the file the
// name stands for and returns a spec that the host can actually execute.
//
// Resolution order: a real executable (`.exe`, `.com`) anywhere on PATH wins
// over a shim, because a real executable spawns directly with no interpreter
// between the harness and the tool. A shim is the fallback.
//
// A shim needs `cmd.exe`, which is a command-injection surface: passing an
// argument through cmd unescaped lets `&`, `|` or a stray quote start a
// second command (CVE-2024-27980). Two rules keep that shut:
//   1. Arguments never reach a shell verbatim. Each one is escaped for both
//      cmd parses (the command line, then the batch file's own re-parse of
//      `%*`) by the qntm.org/cmd algorithm, then handed over with
//      `windowsVerbatimArguments` so no other layer re-quotes it.
//   2. `shell: true` is never set. The harness spawns `cmd.exe` itself with a
//      command line it built, so nothing is interpolated behind its back.
// Carriage return, line feed and NUL survive no escaping cmd understands, so
// an argument that carries one is refused by name rather than truncated.
import { existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

// Directly spawnable by the OS. `.com` rides along because PATHEXT lists it.
const DIRECT_EXTS = ['.exe', '.com'];
// Shims: an interpreter (cmd.exe) has to run these.
const BATCH_EXTS = ['.cmd', '.bat'];
const KNOWN_EXTS = [...DIRECT_EXTS, ...BATCH_EXTS];

// Every character cmd.exe treats as syntax rather than text.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * The ceiling on one command line. Windows hands CreateProcess a single
 * string of at most 32767 UTF-16 units, and libuv refuses a longer one with
 * `ENAMETOOLONG` before the OS is ever asked — a spawn error with no child,
 * no transcript and no seat to blame.
 *
 * The number is a Windows fact and it is applied on every platform. A
 * command that cannot spawn on the host the daemon runs on must not pass
 * quietly on a build machine with a roomier limit; one bound keeps the
 * refusal reproducible wherever the tests run.
 */
export const COMMAND_LINE_MAX = 32767;

/**
 * An upper bound on the command line an argv spawns as, before the host is
 * asked to resolve anything. The quoter adds a separator and a pair of quotes
 * per argument, and doubles each backslash and quote it has to escape; the
 * bound charges all of that unconditionally, so it is never lower than the
 * line the OS is handed. A caller under this bound is under the real one.
 *
 * A shim route (`cmd.exe`) escapes a second time and can run longer still,
 * but that route already refuses an argument holding a newline, which every
 * seat prompt does, so no seat reaches it.
 *
 * @param {string[]} argv command and arguments, unresolved
 * @returns {number} characters, counted high
 */
export function commandLineLength(argv) {
  let total = 0;
  for (const arg of argv ?? []) {
    const value = String(arg);
    total += value.length + 3 + (value.match(/["\\]/g)?.length ?? 0);
  }
  return total;
}

/**
 * Turns a configured argv into a spec the host can spawn.
 * @param {string[]} argv
 * @param {{platform?: string, env?: object}} [opts] injection points for tests
 * @returns {{file: string, args: string[], windowsVerbatimArguments?: boolean}}
 *   On any platform but Windows, and for any Windows command that already
 *   names a real executable, this is the argv split in two — unchanged.
 */
export function resolveArgv(argv, { platform = process.platform, env = process.env } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('resolveArgv requires a non-empty argv');
  }
  const [command, ...args] = argv;
  if (platform !== 'win32') return { file: command, args };
  const found = findExecutable(command, {
    pathValue: env.PATH ?? env.Path ?? '',
    isFile: fileExists,
  });
  // Nothing found: hand the name back untouched and let the spawn report the
  // miss, so a typo still reads as ENOENT on the name the config declared.
  if (!found) return { file: command, args };
  if (!isBatchFile(found)) return { file: found, args };
  return {
    file: env.ComSpec || 'cmd.exe',
    // The outer quotes are cmd's own `/s` convention: it strips the first and
    // last character of the command string and runs the rest as written.
    args: ['/d', '/s', '/c', `"${batchCommandLine(found, args)}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Finds the file a Windows command name stands for. Real executables first,
 * across the whole PATH, then shims. `isFile` is injected so the search rule
 * is testable on any platform.
 * @param {string} command
 * @param {{pathValue?: string, isFile: (path: string) => boolean}} opts
 * @returns {string|null} the resolved path, or null when nothing matches
 */
export function findExecutable(command, { pathValue = '', isFile }) {
  if (typeof command !== 'string' || command.length === 0) return null;
  const ext = extname(command).toLowerCase();
  // An explicit known extension names the file itself; PATHEXT does not apply.
  if (KNOWN_EXTS.includes(ext)) {
    return searchDirs(command, [''], commandDirs(command, pathValue), isFile);
  }
  // Any other extension (`.ps1`, `.py`) needs an interpreter this module does
  // not choose. Leave it alone rather than guess.
  if (ext.length > 0) return null;
  const dirs = commandDirs(command, pathValue);
  return (
    searchDirs(command, DIRECT_EXTS, dirs, isFile) ?? searchDirs(command, BATCH_EXTS, dirs, isFile)
  );
}

/**
 * Builds the command line that runs a batch shim under `cmd.exe /d /s /c`.
 * Exported for tests: the escaping is the security-relevant part.
 * @param {string} file the shim's path
 * @param {string[]} args
 * @returns {string}
 */
export function batchCommandLine(file, args) {
  return [escapeCommand(file), ...args.map((arg) => escapeArgument(arg))].join(' ');
}

// The command needs no quoting: caret-escaping every metacharacter (spaces
// included) makes the whole path literal to cmd.
function escapeCommand(file) {
  return String(file).replace(CMD_META, '^$&');
}

// From the qntm.org/cmd algorithm (as shipped by cross-spawn, MIT). Two
// parsers read the same text: the program's own argv parser wants backslash
// escaping and surrounding quotes; cmd.exe wants a caret before every
// metacharacter. Doing both leaves cmd with nothing but literal text, and
// leaves the program with a correctly quoted argument. A batch file re-parses
// what `%*` expands to, so every caret is doubled to survive that second read.
function escapeArgument(arg) {
  const value = String(arg);
  if (/[\0\r\n]/.test(value)) {
    const shown = JSON.stringify(value.slice(0, 60));
    throw new Error(`cannot pass an argument with a newline or NUL to a Windows shim: ${shown}`);
  }
  let escaped = value
    .replace(/(\\*)"/g, '$1$1\\"') // a run of backslashes before a quote doubles
    .replace(/(\\*)$/, '$1$1'); // and so does one that ends the argument
  escaped = `"${escaped}"`;
  return escaped.replace(CMD_META, '^$&').replace(CMD_META, '^$&');
}

function isBatchFile(file) {
  return BATCH_EXTS.includes(extname(file).toLowerCase());
}

// A command that carries a path is looked up where it points, never on PATH.
function commandDirs(command, pathValue) {
  if (/[\\/]/.test(command) || /^[a-zA-Z]:/.test(command)) return [null];
  return String(pathValue)
    .split(';')
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter((dir) => dir.length > 0);
}

function searchDirs(command, exts, dirs, isFile) {
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir === null ? command + ext : join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function fileExists(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
