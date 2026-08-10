// Instance config: machine-scoped values in the daemon home. The console
// edits the file live; the daemon validates every edit and keeps the old
// config when an edit is invalid. Never versioned in a project repo.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const INSTANCE_CONFIG_FILE = 'instance.json';

export function defaultInstanceConfig() {
  return {
    version: 1,
    logLevel: 'info',
    // model id → max concurrent seats across all runs
    semaphores: {},
    // argv that runs compose on this machine
    composeCommand: ['docker', 'compose'],
    // argv that runs the claude CLI on this machine
    claudeCommand: ['claude'],
    // project name → project entry
    projects: {},
    // notification-stream wiring; consoles read the stream indexes directly
    streams: {},
  };
}

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

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
  for (const key of ['composeCommand', 'claudeCommand']) {
    if (config[key] === undefined) continue;
    const ok =
      Array.isArray(config[key]) &&
      config[key].length > 0 &&
      config[key].every((v) => typeof v === 'string' && v.length > 0);
    if (!ok) err(key, 'must be a non-empty argv array of strings');
  }
  return errors;
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
