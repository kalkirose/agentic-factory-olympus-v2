// Instance config: machine-scoped values in the daemon home. The console
// edits the file live; the daemon validates every edit and keeps the old
// config when an edit is invalid. Never versioned in a project repo.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { SEAT_SILENCE_MS } from '../engine/supervise.mjs';
import { STORE_KINDS } from '../daemon/credentials.mjs';

export const INSTANCE_CONFIG_FILE = 'instance.json';

export function defaultInstanceConfig() {
  return {
    version: 1,
    logLevel: 'info',
    // model id → max concurrent seats across all runs. Empty by default, and
    // an absent key reads the same: no model is capped, every seat runs at
    // once. A project that wants a cap adds one key per model id (ADR-0005).
    semaphores: {},
    // argv that runs compose on this machine
    composeCommand: ['docker', 'compose'],
    // argv that runs the claude CLI on this machine
    claudeCommand: ['claude'],
    // argv that runs the gh CLI on this machine (the forge adapter)
    ghCommand: ['gh'],
    // how long a seat child may emit nothing before it is taken to be dead
    seatSilenceMs: SEAT_SILENCE_MS,
    // project name → project entry
    projects: {},
    // notification-stream wiring; consoles read the stream indexes directly
    streams: {},
    // Absent by default, so the layout stays the home's own: `worktreeRoot`,
    // an absolute path, provisions run workspaces there instead of under
    // `<home>/worktrees`. A machine whose path ceiling a run's deepest test
    // artifact would cross sets a short root and every run path shortens with
    // it.
    //
    // Absent by default too: `secretEnv`, the env-var name patterns this host
    // holds credentials in. Named, they are stripped from every seat that does
    // not execute the project's suite (ADR-0023). Absent, no seat's
    // environment differs from the daemon's own.
    //
    // And absent by default: `notifier`, one push target for the events an
    // idle factory turns on — `{url}` for a webhook or `{command}` for an
    // argv, with an optional `timeoutMs` (ADR-0028). The argv names the
    // machine's own binary, like `claudeCommand` and `ghCommand` do, and is
    // resolved the same way. Absent, the daemon pushes nothing and behaves
    // exactly as it did before the field existed.
    //
    // Absent by default too: `probeCredentials`, the exact names of the
    // credentials this host holds in a form a judgment seat's replay probe may
    // carry — test-mode keys, never live ones. Absent, no credential is
    // probe-eligible and a Tier-1 layer that declares one cannot be replayed
    // (ADR-0042).
    //
    // And absent by default: `credentialStore`, where this host keeps the
    // values of the credentials the projects declare. `{kind:
    // 'windows-user-env'}` reads the current user's stored environment,
    // `{kind: 'env-file', path}` reads a dotenv-style file. Named, every
    // declared value is read from that store at the moment of use, so a
    // password changed while the daemon runs is seen without a restart.
    // Absent, the daemon hands out the copy of the environment it inherited
    // from the window that started it, exactly as it did before the field
    // existed (ADR-0064).
  };
}

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates a parsed instance config. Returns a list of errors, each with a
 * `path` and a `message`. An empty list means valid.
 */
export function validateInstanceConfig(config) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    err('$', 'config must be an object');
    return errors;
  }
  if (config.version !== 1) err('version', 'must be 1');
  if (config.logLevel !== undefined && !LOG_LEVELS.has(config.logLevel)) {
    err('logLevel', `must be one of: ${[...LOG_LEVELS].join(', ')}`);
  }
  if (config.semaphores !== undefined) {
    if (!isPlainObject(config.semaphores)) err('semaphores', 'must be an object');
    else {
      for (const [model, max] of Object.entries(config.semaphores)) {
        if (!Number.isInteger(max) || max < 1) {
          err(`semaphores.${model}`, 'must be an integer >= 1');
        }
      }
    }
  }
  if (config.projects !== undefined) {
    if (!isPlainObject(config.projects)) err('projects', 'must be an object');
    else {
      for (const [name, project] of Object.entries(config.projects)) {
        validateProject(name, project, err);
      }
    }
  }
  if (config.streams !== undefined && !isPlainObject(config.streams)) {
    err('streams', 'must be an object');
  }
  // Absolute only: the daemon's working directory is the service manager's
  // business, so a relative root would name a different place per start.
  if (config.worktreeRoot !== undefined) {
    if (typeof config.worktreeRoot !== 'string' || config.worktreeRoot.length === 0) {
      err('worktreeRoot', 'must be a non-empty string');
    } else if (!isAbsolute(config.worktreeRoot)) {
      err('worktreeRoot', 'must be an absolute path');
    }
  }
  // Which names hold credentials is machine knowledge, like the argv keys: the
  // same project runs on a host that has them and a host that does not.
  if (config.secretEnv !== undefined) {
    const patterns = config.secretEnv;
    const ok =
      Array.isArray(patterns) && patterns.every((p) => typeof p === 'string' && p.length > 0);
    if (!ok) err('secretEnv', 'must be an array of non-empty name patterns');
    else {
      // A pattern the matcher cannot honor is refused here rather than matched
      // against nothing: a rejected edit is loud, a silent non-match leaks.
      for (const pattern of patterns) {
        const stars = pattern.split('*').length - 1;
        if (stars > 1 || (stars === 1 && !pattern.startsWith('*') && !pattern.endsWith('*'))) {
          err(`secretEnv.${pattern}`, 'may hold one `*`, at the start or the end');
        }
      }
    }
  }
  // Which of this host's credentials a replay probe may carry into a command a
  // judgment seat reads the output of. Exact names only, and the asymmetry
  // with `secretEnv` is the reason: a pattern there widens what is stripped
  // and fails safe, a pattern here widens what is exposed and fails open. So a
  // `*` is refused rather than honored, and a name enters this list one
  // deliberate edit at a time (ADR-0042).
  if (config.probeCredentials !== undefined) {
    const names = config.probeCredentials;
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string' && n.length > 0)) {
      err('probeCredentials', 'must be an array of environment-variable names');
    } else {
      const seen = new Set();
      for (const name of names) {
        if (!ENV_NAME.test(name)) {
          err(`probeCredentials.${name}`, 'must be one environment-variable name, with no pattern');
        } else if (seen.has(name)) {
          err(`probeCredentials.${name}`, 'duplicate name');
        }
        seen.add(name);
      }
    }
  }
  // A machine may move the deadline; it may not remove it. An unattended
  // factory with no silence ceiling is the condition this exists for, so there
  // is no value that turns it off (ADR-0037).
  if (config.seatSilenceMs !== undefined) {
    if (!Number.isInteger(config.seatSilenceMs) || config.seatSilenceMs < 1) {
      err('seatSilenceMs', 'must be an integer >= 1');
    }
  }
  for (const key of ['composeCommand', 'claudeCommand', 'ghCommand']) {
    if (config[key] === undefined) continue;
    if (!isArgv(config[key])) err(key, 'must be a non-empty argv array of strings');
  }
  if (config.notifier !== undefined) validateNotifier(config.notifier, err);
  if (config.credentialStore !== undefined) validateCredentialStore(config.credentialStore, err);
  return errors;
}

/**
 * Where this host keeps the values of the credentials its projects declare.
 * One kind, named exactly, because the two kinds read two different places and
 * a config that named neither cleanly would fall back to the inherited copy
 * without saying so. That silence is the condition the store exists to end, so
 * a malformed declaration is refused here rather than honored as an absence
 * (ADR-0064).
 */
function validateCredentialStore(store, err) {
  if (!isPlainObject(store)) {
    err('credentialStore', 'must be an object');
    return;
  }
  if (!STORE_KINDS.includes(store.kind)) {
    err('credentialStore.kind', `must be one of: ${STORE_KINDS.join(', ')}`);
    return;
  }
  if (store.kind === 'env-file') {
    // Absolute only, for the reason `worktreeRoot` is absolute: the daemon's
    // working directory belongs to the service manager, so a relative path
    // would name a different file per start.
    if (typeof store.path !== 'string' || store.path.length === 0) {
      err('credentialStore.path', 'required for an env-file store');
    } else if (!isAbsolute(store.path)) {
      err('credentialStore.path', 'must be an absolute path');
    }
  } else if (store.path !== undefined) {
    err('credentialStore.path', 'a windows-user-env store names no path');
  }
}

/**
 * One target, named one way. A config that names both a URL and a command
 * says nothing about which one the operator meant, and a config that names
 * neither is an empty section pretending to be wiring: both are refused here
 * rather than half-honored at the first park.
 */
function validateNotifier(notifier, err) {
  if (!isPlainObject(notifier)) {
    err('notifier', 'must be an object');
    return;
  }
  const hasUrl = notifier.url !== undefined;
  const hasCommand = notifier.command !== undefined;
  if (hasUrl === hasCommand) err('notifier', 'takes exactly one of url and command');
  if (hasUrl) {
    const ok = typeof notifier.url === 'string' && /^https?:\/\/\S/.test(notifier.url);
    if (!ok) err('notifier.url', 'must be an http or https URL');
  }
  if (hasCommand && !isArgv(notifier.command)) {
    err('notifier.command', 'must be a non-empty argv array of strings');
  }
  if (notifier.timeoutMs !== undefined) {
    if (!Number.isInteger(notifier.timeoutMs) || notifier.timeoutMs < 1) {
      err('notifier.timeoutMs', 'must be an integer >= 1');
    }
  }
}

function isArgv(value) {
  return (
    Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.length > 0)
  );
}

function validateProject(name, project, err) {
  const at = (key) => `projects.${name}.${key}`;
  if (!isPlainObject(project)) {
    err(`projects.${name}`, 'must be an object');
    return;
  }
  if (typeof project.repoUrl !== 'string' || project.repoUrl.length === 0) {
    err(at('repoUrl'), 'required string');
  }
  if (project.defaultBranch !== undefined && typeof project.defaultBranch !== 'string') {
    err(at('defaultBranch'), 'must be a string');
  }
  if (project.projectConfigPath !== undefined && typeof project.projectConfigPath !== 'string') {
    err(at('projectConfigPath'), 'must be a string');
  }
  if (project.slotCap !== undefined && (!Number.isInteger(project.slotCap) || project.slotCap < 0)) {
    err(at('slotCap'), 'must be an integer >= 0');
  }
}

/** Fills defaults into a valid config without mutation. */
export function withDefaults(config) {
  const filled = {
    ...defaultInstanceConfig(),
    ...config,
    projects: {},
  };
  for (const [name, project] of Object.entries(config.projects ?? {})) {
    filled.projects[name] = {
      defaultBranch: 'main',
      projectConfigPath: '.olympus/project.json',
      slotCap: 1,
      ...project,
    };
  }
  return filled;
}

/**
 * Loads the instance config from a daemon home. A missing file is scaffolded
 * with defaults. Throws on an invalid file — the caller decides whether an
 * old config stays live.
 */
export function loadInstanceConfig(home) {
  const path = join(home, INSTANCE_CONFIG_FILE);
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(defaultInstanceConfig(), null, 2) + '\n');
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(`instance config is not valid JSON: ${path}`, { cause });
  }
  const errors = validateInstanceConfig(parsed);
  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`instance config invalid: ${detail}`);
  }
  return withDefaults(parsed);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
