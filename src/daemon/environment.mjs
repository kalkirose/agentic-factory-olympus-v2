// The seat environment, checked once at daemon start. A seat runs a CLI in a
// run worktree off a project clone, and three properties of this host decide
// whether that CLI behaves the way the harness configured it. None of them
// belongs to a run, none of them changes between runs, and all three fail
// quietly: the seat still starts, and the defect reaches nobody but the
// process's own stderr (ADR-0030).
//
// The check reads; it never repairs and never refuses a start. Each finding is
// one stamp in the instance ledger, and a clean host says nothing at all.
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { findExecutable } from '../engine/executable.mjs';
import { cloneDir } from '../isolation/clones.mjs';
import { gitPlain } from '../isolation/git.mjs';

/**
 * @typedef {object} Finding
 * @property {string} check which check found it
 * @property {'blocking'|'degraded'} severity what the defect costs: `blocking`
 *   means no seat can run at all, `degraded` means seats run with less than
 *   the harness configured for them
 * @property {string} reason the machine-readable condition
 * @property {string} [path] the path the check asked about
 * @property {string} [project] the project the path belongs to
 * @property {string} gist one sentence for a human
 */

/**
 * Checks the environment the seats of this instance will run in.
 * @param {{paths: ReturnType<import('./home.mjs').homePaths>, config: object,
 *   platform?: string, env?: object, home?: string}} opts
 *   platform, env and home are the host facts the checks read; tests pass
 *   their own so the answers are the fixture's rather than the machine's.
 * @returns {Promise<Finding[]>} empty when the host is clean
 */
export async function checkSeatEnvironment({
  paths,
  config,
  platform = process.platform,
  env = process.env,
  home = homedir(),
}) {
  const projects = Object.keys(config?.projects ?? {});
  // An instance with no project launches nothing, so it spawns no seat and has
  // no seat environment to answer for. A project added to a running instance is
  // checked at the next start.
  if (projects.length === 0) return [];
  const command = config.claudeCommand?.[0];
  return [
    ...runnerFindings(command, { platform, env }),
    ...trustFindings({ paths, projects, command, platform, env, home }),
    ...(await longPathFindings({ paths, projects, platform, env })),
  ];
}

// -- the seat runner exists -------------------------------------------------

/**
 * The configured seat runner has to be a file this host can execute. An
 * unresolvable name fails at the spawn of every seat of every run, which is
 * the whole factory, and it fails there as an ENOENT with no statement of
 * where the name came from.
 */
function runnerFindings(command, { platform, env }) {
  if (resolveRunnerFile(command, { platform, env }) !== null) return [];
  const named = typeof command === 'string' && command.length > 0 ? command : '(none)';
  return [
    {
      check: 'runner-command',
      severity: 'blocking',
      reason: 'unresolvable',
      path: named,
      gist: `the seat runner ${named} resolves to no executable file on this host; every seat spawn will fail`,
    },
  ];
}

/**
 * The file a configured command name stands for, or null. Windows resolution
 * is the spawn path's own (ADR-0013), so the check answers for the file the
 * seat would actually run; elsewhere a PATH search asks for the execute bit.
 */
function resolveRunnerFile(command, { platform, env }) {
  if (typeof command !== 'string' || command.length === 0) return null;
  if (platform === 'win32') {
    return findExecutable(command, { pathValue: env.PATH ?? env.Path ?? '', isFile });
  }
  const dirs = command.includes('/') ? [null] : String(env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of dirs) {
    const candidate = dir === null ? command : join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

// -- the runner CLI trusts the paths seats work in --------------------------

// The config key that carries the decision is the CLI's own, so the check
// takes any flag whose name speaks of trust rather than one hardcoded field.
const TRUST_KEY = /trust/i;

/**
 * A CLI that records which workspaces a human trusted refuses the rest of its
 * configuration in the ones it holds no record for: the permissions the
 * harness ships in the seat's argv are dropped, and the seat runs on whatever
 * the default is. The paths asked about are the roots, because a run worktree does
 * not exist until the run that owns it launches — no human could have trusted
 * it in advance, and trust of a root covers everything under it.
 */
function trustFindings({ paths, projects, command, platform, env, home }) {
  const name = runnerName(command);
  if (name === null) return []; // the runner finding already carries this host
  const store = join(env[configDirVar(name)] ?? home, `.${name}.json`);
  let trusted;
  try {
    trusted = trustedPaths(readFileSync(store, 'utf8'));
  } catch {
    return [
      {
        check: 'runner-trust',
        severity: 'degraded',
        reason: 'store-unreadable',
        path: store,
        gist: `${name} records its trusted workspaces in ${store}, which this host does not hold or does not parse; no path can be shown as trusted`,
      },
    ];
  }
  const targets = [
    { path: paths.worktrees },
    ...projects.map((project) => ({ path: cloneDir(paths, project), project })),
  ];
  const findings = [];
  for (const target of targets) {
    if (isCovered(target.path, trusted, platform)) continue;
    findings.push({
      check: 'runner-trust',
      severity: 'degraded',
      reason: 'untrusted',
      path: target.path,
      ...(target.project !== undefined && { project: target.project }),
      gist: `${name} holds no trust record covering ${target.path}; seats there run with the permissions the harness configured for them ignored`,
    });
  }
  return findings;
}

/**
 * The CLI's own name, from the configured argv: the store is the CLI's, so the
 * command that runs it is what names it. Nothing about one vendor's layout is
 * written down here.
 */
function runnerName(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  const name = basename(command, extname(command));
  return name.length > 0 ? name : null;
}

// The environment name a CLI reads its config directory from, in the shape a
// CLI that takes one uses: the tool's name in upper case, then the suffix.
// Unset, the store sits in the home directory, which is the other half of the
// same convention.
function configDirVar(name) {
  return `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CONFIG_DIR`;
}

/** The workspace paths a trust store records a human decision for. */
function trustedPaths(text) {
  const store = JSON.parse(text);
  const workspaces = store?.projects;
  if (typeof workspaces !== 'object' || workspaces === null || Array.isArray(workspaces)) {
    throw new Error('the trust store holds no workspace record');
  }
  return Object.entries(workspaces)
    .filter(([, entry]) => recordsTrust(entry))
    .map(([path]) => path);
}

function recordsTrust(entry) {
  if (entry === true) return true;
  if (typeof entry !== 'object' || entry === null) return false;
  return Object.entries(entry).some(([key, value]) => value === true && TRUST_KEY.test(key));
}

/** True when the path itself, or a directory above it, is trusted. */
function isCovered(path, trusted, platform) {
  const target = comparable(path, platform);
  return trusted.some((entry) => {
    const root = comparable(entry, platform);
    return target === root || target.startsWith(root + sep);
  });
}

function comparable(path, platform) {
  const full = resolve(path);
  return platform === 'win32' ? full.toLowerCase() : full;
}

// -- git survives the paths the harness builds ------------------------------

/**
 * A run worktree nests a run id and a workspace path under the daemon home,
 * which clears 260 characters on an ordinary tree. The harness carries
 * `core.longPaths` on its own git invocations for that reason (ADR-0016). A
 * seat's git and a project's own commands carry no such argument: they take
 * the setting from the repository they run in, so a clone without it hands a
 * seat less than the harness gives itself.
 */
async function longPathFindings({ paths, projects, platform, env }) {
  if (platform !== 'win32') return []; // the ceiling is Windows's alone
  const findings = [];
  for (const project of projects) {
    const clone = cloneDir(paths, project);
    // No clone yet: the next launch makes one, and it will inherit whatever
    // the host itself is configured with. Asking the host answers for it.
    const cloned = existsSync(clone);
    const asked = cloned ? clone : paths.home;
    if ((await longPathsValue(asked, env)) === 'true') continue;
    findings.push({
      check: 'git-long-paths',
      severity: 'degraded',
      reason: 'unset',
      project,
      path: asked,
      gist: cloned
        ? `the clone of ${project} has core.longPaths unset, so a seat's own git meets the path ceiling the harness spares itself`
        : `git on this host has core.longPaths unset, so the clone of ${project} will inherit no long-path support`,
    });
  }
  return findings;
}

async function longPathsValue(cwd, env) {
  try {
    // Plain: the harness's own invocations set this very key, and one of them
    // would answer the question with its own argument.
    return (
      await gitPlain(['config', '--bool', '--get', 'core.longPaths'], { cwd, env })
    ).trim();
  } catch {
    return null; // unset, or a git that could not answer — both mean no support
  }
}

// -- file probes ------------------------------------------------------------

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutable(path) {
  try {
    if (!isFile(path)) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
