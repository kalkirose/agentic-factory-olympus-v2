// Project config: one JSON versioned in the project repo. The daemon reads
// it from the default branch in its bare clone at each run launch, so config
// changes ship through the same PR path as the code they describe. The
// ownership test places every value: describes the project's code → here;
// describes the machine → instance config.
import { TRIPWIRE_METRICS, BREACH_OPS } from '../tripwires/registry.mjs';
import { RUN_EVENTS, INSTANCE_EVENTS, ESCAPES_EVENTS } from '../ledger/registry.mjs';

const KNOWN_EVENTS = new Set([...RUN_EVENTS, ...INSTANCE_EVENTS, ...ESCAPES_EVENTS]);

export const DEFAULT_PROJECT_CONFIG_PATH = '.olympus/project.json';
export const DEFAULT_CONSTITUTION_PATH = '.olympus/constitution.md';

// A path that starts at a root, POSIX or Windows. Most path entries here are
// repo-relative and this rejects them; the close-out block is the exception
// and this is what it requires.
const ABSOLUTE_PATH = /^([a-zA-Z]:)?[\\/]/;

export function defaultProjectConfig() {
  return {
    version: 1,
    // repo facts the harness enforces: path entries relative to the repo
    // root — plain prefixes, or glob patterns (see isGlobEntry)
    repo: { testPaths: [], uiPaths: [] },
    // command name → argv; the single home for every runnable command
    commands: {},
    // deterministic gate layers; `command` names a key in `commands`
    gates: { tier1: [] },
    // one convention per line; prompt assembly consumes these
    conventions: [],
    // lane name → lane-specific settings; consuming milestones validate deeper
    lanes: {},
    // compose template for the per-run stack; null = the project has no stack
    stack: null,
    // story graph: where the intent cards live and how phases gate the
    // launchable frontier; null = no auto-launch, manual launches only
    graph: null,
    // tripwire registry; the watcher milestone owns the metric semantics
    tripwires: [],
    // lane name → the diff-policy tiers the candidate capture enforces;
    // an absent lane leaves that lane's capture unpoliced
    diffPolicy: {},
    // lane name → the run cost, in US dollars, past which the run says so
    // once and keeps going; an absent lane sets no threshold
    budgets: {},
    // the standing policy file, relative to the repo root; an absent file
    // leaves every seat prompt exactly as it was
    constitutionPath: DEFAULT_CONSTITUTION_PATH,
    // external credentials the project's work needs, each with the read-only
    // command that proves it; an empty list probes nothing
    credentials: [],
    // label rules: one label and the diff path entries that require it; an
    // empty list leaves every request unlabelled
    labels: [],
    // the workflow files the daemon watches on the default branch — the runs
    // no request path covers; an empty list watches nothing
    watchedWorkflows: [],
    // optional close-out extras the project asks for after a shipped story;
    // null = the close-out is exactly what it always was
    closeout: null,
  };
}

/**
 * Validates a parsed project config. Returns a list of errors, each with a
 * `path` and a `message`. An empty list means valid.
 */
export function validateProjectConfig(config) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });

  if (!isPlainObject(config)) {
    err('$', 'config must be an object');
    return errors;
  }
  if (config.version !== 1) err('version', 'must be 1');
  validateRepo(config.repo, err);
  validateCommands(config.commands, err);
  validateGates(config.gates, config.commands, err);
  validateStringList(config.conventions, 'conventions', err);
  validateLanes(config.lanes, config.commands, err);
  validateStack(config.stack, err);
  validateGraph(config.graph, err);
  validateTripwires(config.tripwires, err);
  validateDiffPolicy(config.diffPolicy, err);
  validateBudgets(config.budgets, err);
  validateConstitutionPath(config.constitutionPath, err);
  validateCredentials(config.credentials, config.commands, err);
  validateLabels(config.labels, err);
  validateWatchedWorkflows(config.watchedWorkflows, err);
  validateCloseout(config.closeout, err);
  if (isPlainObject(config.lanes) && isPlainObject(config.lanes.story)) {
    if (!Array.isArray(config.repo?.testPaths) || config.repo.testPaths.length === 0) {
      err('repo.testPaths', 'the story lane requires at least one test path');
    }
  }
  return errors;
}

function validateRepo(repo, err) {
  if (repo === undefined) return;
  if (!isPlainObject(repo)) {
    err('repo', 'must be an object');
    return;
  }
  validateStringList(repo.testPaths, 'repo.testPaths', err);
  validateStringList(repo.uiPaths, 'repo.uiPaths', err);
}

function validateCommands(commands, err) {
  if (commands === undefined) return;
  if (!isPlainObject(commands)) {
    err('commands', 'must be an object');
    return;
  }
  for (const [name, argv] of Object.entries(commands)) {
    if (!isStringList(argv) || argv.length === 0) {
      err(`commands.${name}`, 'must be a non-empty argv array of strings');
    }
  }
}

function validateGates(gates, commands, err) {
  if (gates === undefined) return;
  if (!isPlainObject(gates)) {
    err('gates', 'must be an object');
    return;
  }
  if (gates.tier1 === undefined) return;
  if (!Array.isArray(gates.tier1)) {
    err('gates.tier1', 'must be an array of layers');
    return;
  }
  const seen = new Set();
  gates.tier1.forEach((layer, i) => {
    const at = (key) => `gates.tier1[${i}].${key}`;
    if (!isPlainObject(layer)) {
      err(`gates.tier1[${i}]`, 'must be an object');
      return;
    }
    if (typeof layer.name !== 'string' || layer.name.length === 0) {
      err(at('name'), 'required string');
    } else if (seen.has(layer.name)) {
      err(at('name'), `duplicate layer name: ${layer.name}`);
    }
    if (typeof layer.command !== 'string' || !isPlainObject(commands) || !commands[layer.command]) {
      err(at('command'), 'must name a key in commands');
    }
    if (layer.needs !== undefined) {
      if (!isStringList(layer.needs)) {
        err(at('needs'), 'must be an array of layer names');
      } else {
        for (const need of layer.needs) {
          // A prerequisite must come earlier; this also rules out cycles.
          if (!seen.has(need)) err(at('needs'), `must name an earlier layer: ${need}`);
        }
      }
    }
    if (typeof layer.name === 'string') seen.add(layer.name);
  });
}

function validateLanes(lanes, commands, err) {
  if (lanes === undefined) return;
  if (!isPlainObject(lanes)) {
    err('lanes', 'must be an object');
    return;
  }
  for (const [name, lane] of Object.entries(lanes)) {
    if (!isPlainObject(lane)) {
      err(`lanes.${name}`, 'must be an object');
      continue;
    }
    if (name === 'story') validateStoryLane(lane, commands, err);
  }
}

// The story lane's settings, validated as deep as the pre-freeze chain reads.
function validateStoryLane(lane, commands, err) {
  const names = isPlainObject(commands) ? commands : {};
  if (typeof lane.suiteCommand !== 'string' || !names[lane.suiteCommand]) {
    err('lanes.story.suiteCommand', 'must name a key in commands');
  }
  if (lane.lintCommand !== undefined) {
    if (typeof lane.lintCommand !== 'string' || !names[lane.lintCommand]) {
      err('lanes.story.lintCommand', 'must name a key in commands');
    }
  }
  // Adversary waves per round. The lane defaults it, so the entry is only
  // ever a raise; a zero or a fraction would read as a raise and disarm the
  // stage instead, which is why the figure is validated rather than clamped.
  if (lane.adversaryWaves !== undefined) {
    if (!Number.isInteger(lane.adversaryWaves) || lane.adversaryWaves < 1) {
      err('lanes.story.adversaryWaves', 'must be a positive integer wave count');
    }
  }
}

function validateStack(stack, err) {
  if (stack === undefined || stack === null) return;
  if (!isPlainObject(stack)) {
    err('stack', 'must be an object');
    return;
  }
  if (typeof stack.composeFile !== 'string' || stack.composeFile.length === 0) {
    err('stack.composeFile', 'required string');
  } else if (ABSOLUTE_PATH.test(stack.composeFile)) {
    err('stack.composeFile', 'must be a path relative to the repo root');
  }
  if (stack.env !== undefined) {
    if (!isPlainObject(stack.env)) {
      err('stack.env', 'must be an object');
    } else {
      for (const [name, value] of Object.entries(stack.env)) {
        if (typeof value !== 'string') err(`stack.env.${name}`, 'must be a string');
      }
    }
  }
}

// The story graph section: intent-card location and phase gates. The phase
// gate is an auto-launch rule, never an edge — a later phase enters the
// launchable frontier only after its named card ships.
function validateGraph(graph, err) {
  if (graph === undefined || graph === null) return;
  if (!isPlainObject(graph)) {
    err('graph', 'must be an object');
    return;
  }
  if (typeof graph.cardsDir !== 'string' || graph.cardsDir.length === 0) {
    err('graph.cardsDir', 'required string');
  } else if (ABSOLUTE_PATH.test(graph.cardsDir)) {
    err('graph.cardsDir', 'must be a path relative to the repo root');
  }
  if (graph.phases === undefined) return;
  if (!Array.isArray(graph.phases) || graph.phases.length === 0) {
    err('graph.phases', 'must be a non-empty array of phases');
    return;
  }
  const seen = new Set();
  graph.phases.forEach((phase, i) => {
    if (!isPlainObject(phase)) {
      err(`graph.phases[${i}]`, 'must be an object');
      return;
    }
    if (typeof phase.name !== 'string' || phase.name.length === 0) {
      err(`graph.phases[${i}].name`, 'required string');
    } else if (seen.has(phase.name)) {
      err(`graph.phases[${i}].name`, `duplicate phase name: ${phase.name}`);
    } else {
      seen.add(phase.name);
    }
    if (i === 0) {
      if (phase.after !== undefined) err('graph.phases[0].after', 'the first phase takes no gate');
    } else if (typeof phase.after !== 'string' || phase.after.length === 0) {
      err(`graph.phases[${i}].after`, 'a later phase must name the card that opens it');
    }
  });
}

// A cut and its tripwire land in one PR; this validation is what "no cut
// without a tripwire" leans on. The metric set is closed — the daemon
// implements every name it admits.
function validateTripwires(tripwires, err) {
  if (tripwires === undefined) return;
  if (!Array.isArray(tripwires)) {
    err('tripwires', 'must be an array');
    return;
  }
  const seen = new Set();
  tripwires.forEach((entry, i) => {
    const at = (key) => `tripwires[${i}].${key}`;
    if (!isPlainObject(entry)) {
      err(`tripwires[${i}]`, 'must be an object');
      return;
    }
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      err(at('id'), 'required string');
    } else if (seen.has(entry.id)) {
      err(at('id'), `duplicate tripwire id: ${entry.id}`);
    } else {
      seen.add(entry.id);
    }
    const metric = TRIPWIRE_METRICS[entry.metric];
    if (!metric) {
      err(at('metric'), `must name a metric the daemon implements: ${entry.metric}`);
      return;
    }
    if (entry.window !== undefined) {
      if (metric.unit === null) {
        err(at('window'), `metric ${entry.metric} evaluates current state and takes no window`);
      } else if (!Number.isInteger(entry.window) || entry.window <= 0) {
        err(at('window'), 'must be a positive integer state count');
      }
    }
    if (
      !isPlainObject(entry.breach) ||
      !BREACH_OPS.has(entry.breach.op) ||
      typeof entry.breach.value !== 'number' ||
      !Number.isFinite(entry.breach.value)
    ) {
      err(at('breach'), 'required: {op: > | >= | < | <=, value: number}');
    }
    if (entry.triggerEvents !== undefined) {
      if (!isStringList(entry.triggerEvents) || entry.triggerEvents.length === 0) {
        err(at('triggerEvents'), 'must be a non-empty array of event names');
      } else {
        for (const event of entry.triggerEvents) {
          if (!KNOWN_EVENTS.has(event)) err(at('triggerEvents'), `unknown event: ${event}`);
        }
      }
    }
    if (typeof entry.answer !== 'string' || entry.answer.length === 0) {
      err(at('answer'), 'required: the restore target or the answering review');
    }
    if (entry.params !== undefined && !isPlainObject(entry.params)) {
      err(at('params'), 'must be an object');
    }
    for (const param of metric.requiredParams ?? []) {
      const value = entry.params?.[param];
      if (typeof value !== 'string' || value.length === 0) {
        err(at(`params.${param}`), `metric ${entry.metric} requires params.${param}`);
      }
    }
  });
}

// The diff policy the candidate capture enforces, per lane. Only the lanes
// that run a dev seat take one; a name outside that set is a typo the launch
// must not swallow, because a policy nobody reads protects nothing.
// `recapturablePaths` rides the same block and is not a tier: it blocks
// nothing and admits nothing. It classes the writes the capture takes back
// from frozen paths, so a take-back on an artifact a re-freeze re-takes is
// recorded quietly rather than as an open loud item (ADR-0017).
const LANES = ['story', 'repair'];
const POLICED_LANES = new Set(LANES);
const TIER_KEYS = ['deniedPaths', 'declaredPaths', 'forbiddenPatterns', 'recapturablePaths'];

function validateDiffPolicy(policy, err) {
  if (policy === undefined) return;
  if (!isPlainObject(policy)) {
    err('diffPolicy', 'must be an object keyed by lane name');
    return;
  }
  for (const [lane, tiers] of Object.entries(policy)) {
    const at = (key) => `diffPolicy.${lane}.${key}`;
    if (!POLICED_LANES.has(lane)) {
      err(`diffPolicy.${lane}`, `must name a lane with a dev seat: ${LANES.join(' | ')}`);
      continue;
    }
    if (!isPlainObject(tiers)) {
      err(`diffPolicy.${lane}`, 'must be an object');
      continue;
    }
    for (const key of Object.keys(tiers)) {
      if (!TIER_KEYS.includes(key)) err(at(key), `unknown tier: ${TIER_KEYS.join(' | ')}`);
    }
    validateStringList(tiers.deniedPaths, at('deniedPaths'), err);
    validateStringList(tiers.declaredPaths, at('declaredPaths'), err);
    validateStringList(tiers.recapturablePaths, at('recapturablePaths'), err);
    if (tiers.forbiddenPatterns === undefined) continue;
    if (!isStringList(tiers.forbiddenPatterns)) {
      err(at('forbiddenPatterns'), 'must be an array of non-empty strings');
      continue;
    }
    tiers.forbiddenPatterns.forEach((pattern, i) => {
      try {
        new RegExp(pattern);
      } catch (cause) {
        err(at(`forbiddenPatterns[${i}]`), `must be a valid regular expression: ${cause.message}`);
      }
    });
  }
}

// Per-lane budget thresholds, in US dollars. A threshold informs and never
// gates (ADR-0021), so the only thing validation protects is the reading: a
// lane name outside the closed set, or a figure that is not a positive amount
// of money, is a typo that would leave the owner believing a budget was set.
function validateBudgets(budgets, err) {
  if (budgets === undefined) return;
  if (!isPlainObject(budgets)) {
    err('budgets', 'must be an object keyed by lane name');
    return;
  }
  for (const [lane, value] of Object.entries(budgets)) {
    if (!POLICED_LANES.has(lane)) {
      err(`budgets.${lane}`, `must name a lane: ${LANES.join(' | ')}`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      err(`budgets.${lane}`, 'must be a positive number of US dollars');
    }
  }
}

// The constitution's location. The file is read from the run's worktree, so
// the path is repo-relative like every other path entry here; an absolute
// path would reach outside the tree the run was given.
function validateConstitutionPath(path, err) {
  if (path === undefined) return;
  if (typeof path !== 'string' || path.length === 0) {
    err('constitutionPath', 'must be a non-empty string');
  } else if (ABSOLUTE_PATH.test(path)) {
    err('constitutionPath', 'must be a path relative to the repo root');
  }
}

// The optional close-out extras, one section today: `learning`, the artifact
// a shipped story leaves behind for a human reader. Both of its entries are
// absolute host paths on purpose — the instructions file is the owner's, and
// the workspace outlives every run, while the run's worktree is created at
// launch and removed at close. The section is validated like any other,
// because the feature itself fails quietly by design: a block the owner
// believes is configured and is not would otherwise never say so.
const LEARNING_KEYS = ['instructions', 'workspace'];

function validateCloseout(closeout, err) {
  if (closeout === undefined || closeout === null) return;
  if (!isPlainObject(closeout)) {
    err('closeout', 'must be an object');
    return;
  }
  for (const key of Object.keys(closeout)) {
    if (key !== 'learning') err(`closeout.${key}`, 'unknown section: learning');
  }
  const learning = closeout.learning;
  if (learning === undefined) return;
  if (!isPlainObject(learning)) {
    err('closeout.learning', 'must be an object');
    return;
  }
  for (const key of Object.keys(learning)) {
    if (!LEARNING_KEYS.includes(key)) {
      err(`closeout.learning.${key}`, `unknown key: ${LEARNING_KEYS.join(' | ')}`);
    }
  }
  for (const key of LEARNING_KEYS) {
    const value = learning[key];
    if (typeof value !== 'string' || value.length === 0) {
      err(`closeout.learning.${key}`, 'required string');
    } else if (!ABSOLUTE_PATH.test(value)) {
      err(`closeout.learning.${key}`, 'must be an absolute path');
    }
  }
}

// The external credentials the project's work needs, each named with the one
// environment variable that carries it, the read-only command that proves it
// works, and the surfaces beyond this host that will also need it. The probe
// is required: a declared credential with nothing behind it reads as covered
// and is not. The variable is one name, never a pattern — the probe answers
// for exactly the value it was given.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_CI_KEYS = ['secret', 'workflows'];

function validateCredentials(credentials, commands, err) {
  if (credentials === undefined) return;
  if (!Array.isArray(credentials)) {
    err('credentials', 'must be an array');
    return;
  }
  const seen = new Set();
  credentials.forEach((entry, i) => {
    const at = (key) => `credentials[${i}].${key}`;
    if (!isPlainObject(entry)) {
      err(`credentials[${i}]`, 'must be an object');
      return;
    }
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      err(at('name'), 'required string');
    } else if (seen.has(entry.name)) {
      err(at('name'), `duplicate credential name: ${entry.name}`);
    } else {
      seen.add(entry.name);
    }
    if (typeof entry.env !== 'string' || !ENV_NAME.test(entry.env)) {
      err(at('env'), 'must name one environment variable');
    }
    if (typeof entry.probe !== 'string' || !isPlainObject(commands) || !commands[entry.probe]) {
      err(at('probe'), 'must name a key in commands');
    }
    if (entry.ci !== undefined) validateCredentialCi(entry.ci, at, err);
  });
}

// The CI surface of one credential: the name the forge holds the secret
// under, and every workflow that must reference it. Both are required
// together, because either one alone still leaves a job running without the
// value. A credential with no `ci` block declares no CI surface, and nothing
// is checked for it there — an omission is a statement, never a default.
function validateCredentialCi(ci, at, err) {
  if (!isPlainObject(ci)) {
    err(at('ci'), 'must be an object');
    return;
  }
  for (const key of Object.keys(ci)) {
    if (!CREDENTIAL_CI_KEYS.includes(key)) {
      err(at(`ci.${key}`), `unknown key: ${CREDENTIAL_CI_KEYS.join(' | ')}`);
    }
  }
  if (typeof ci.secret !== 'string' || !ENV_NAME.test(ci.secret)) {
    err(at('ci.secret'), 'must name one CI secret');
  }
  if (!isStringList(ci.workflows) || ci.workflows.length === 0) {
    err(at('ci.workflows'), 'must be a non-empty array of workflow paths');
  } else {
    ci.workflows.forEach((path, j) => {
      if (ABSOLUTE_PATH.test(path)) {
        err(at(`ci.workflows[${j}]`), 'must be a path relative to the repo root');
      }
    });
  }
}

// The labels a request must carry, and what makes each one required. A rule
// names one label and the diff path entries that ask for it, in the same path
// vocabulary as `repo` — a plain prefix, or a glob. The label vocabulary
// belongs to the project, so the rule does too: the harness derives, it never
// holds a list of label names.
//
// The rules are the whole derivation. A label nothing here covers is not
// guessed at ship time; it stays whatever the project's own check makes of it.
function validateLabels(labels, err) {
  if (labels === undefined) return;
  if (!Array.isArray(labels)) {
    err('labels', 'must be an array');
    return;
  }
  const seen = new Set();
  labels.forEach((entry, i) => {
    const at = (key) => `labels[${i}].${key}`;
    if (!isPlainObject(entry)) {
      err(`labels[${i}]`, 'must be an object');
      return;
    }
    if (typeof entry.label !== 'string' || entry.label.length === 0) {
      err(at('label'), 'required string');
    } else if (seen.has(entry.label)) {
      err(at('label'), `duplicate label: ${entry.label}`);
    } else {
      seen.add(entry.label);
    }
    if (!isStringList(entry.paths) || entry.paths.length === 0) {
      err(at('paths'), 'must be a non-empty array of path entries');
    }
  });
}

// The workflows the daemon watches on the default branch. Each entry is the
// workflow file, because that is the id the forge lists a workflow's runs
// under; a display name is not addressable. A duplicate is refused rather than
// collapsed: two entries for one workflow would read as two things being
// watched, and only one of them is.
function validateWatchedWorkflows(workflows, err) {
  if (workflows === undefined) return;
  if (!isStringList(workflows)) {
    err('watchedWorkflows', 'must be an array of workflow file names');
    return;
  }
  const seen = new Set();
  workflows.forEach((file, i) => {
    if (seen.has(file)) err(`watchedWorkflows[${i}]`, `duplicate workflow: ${file}`);
    seen.add(file);
  });
}

function validateStringList(value, path, err) {
  if (value === undefined) return;
  if (!isStringList(value)) err(path, 'must be an array of non-empty strings');
}

/** Fills defaults into a valid config without mutation. */
export function withProjectDefaults(config) {
  const base = defaultProjectConfig();
  return {
    ...base,
    ...config,
    repo: { ...base.repo, ...config.repo },
    gates: { ...base.gates, ...config.gates },
    stack: config.stack ?? null,
    graph: config.graph ? { phases: [{ name: 'launch' }], ...config.graph } : null,
    closeout: config.closeout ?? null,
  };
}

/**
 * Parses and validates project config text (as read from the bare clone).
 * Throws with every validation error; the launch that read it fails.
 */
export function parseProjectConfig(text, source) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`project config is not valid JSON: ${source}`, { cause });
  }
  const errors = validateProjectConfig(parsed);
  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`project config invalid (${source}): ${detail}`);
  }
  return withProjectDefaults(parsed);
}

// -- repo path entries -------------------------------------------------------
//
// A `repo` path entry (`testPaths`, `uiPaths`) is a plain path prefix, or a
// glob pattern when it carries a metacharacter. Glob semantics follow git's
// `:(glob)` pathspec magic: `*` and `?` never match `/`; `**/` at a segment
// boundary matches zero or more directories; a trailing `/**` matches
// everything inside; `[...]` is a character class (`[!...]` negates).

const GLOB_CHARS = /[*?[\]]/;
const REGEXP_SPECIALS = '.^$+(){}|\\';
const globCache = new Map();

/** True when a path entry is a glob pattern rather than a plain prefix. */
export function isGlobEntry(entry) {
  return GLOB_CHARS.test(entry);
}

/** Compiles a glob entry to an anchored RegExp (semantics above). Cached. */
export function globRegExp(pattern) {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      let j = i;
      while (pattern[j] === '*') j++;
      const atBoundary = i === 0 || pattern[i - 1] === '/';
      if (j - i >= 2 && atBoundary && pattern[j] === '/') {
        re += '(?:[^/]+/)*';
        i = j + 1;
      } else if (j - i >= 2 && atBoundary && j === pattern.length) {
        re += '.+';
        i = j;
      } else {
        // Asterisks not slash-bounded act as regular asterisks.
        re += '[^/]*';
        i = j;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 2);
      if (close === -1) {
        re += '\\[';
        i++;
      } else {
        const body = pattern.slice(i + 1, close);
        re += '[' + (body[0] === '!' ? '^' + body.slice(1) : body).replaceAll('\\', '\\\\') + ']';
        i = close + 1;
      }
    } else {
      re += REGEXP_SPECIALS.includes(ch) ? '\\' + ch : ch;
      i++;
    }
  }
  const compiled = new RegExp(re + '$');
  globCache.set(pattern, compiled);
  return compiled;
}

/** True when a repo-relative file falls under a path entry. */
export function underEntry(file, entry) {
  const norm = file.replaceAll('\\', '/');
  const e = entry.replaceAll('\\', '/');
  if (isGlobEntry(e)) return globRegExp(e).test(norm);
  const prefix = e.replace(/\/+$/, '');
  return norm === prefix || norm.startsWith(prefix + '/');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}
