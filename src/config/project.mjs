// Project config: one JSON versioned in the project repo. The daemon reads
// it from the default branch in its bare clone at each run launch, so config
// changes ship through the same PR path as the code they describe. The
// ownership test places every value: describes the project's code → here;
// describes the machine → instance config.
import { TRIPWIRE_METRICS, BREACH_OPS } from '../tripwires/registry.mjs';
import { RUN_EVENTS, INSTANCE_EVENTS, ESCAPES_EVENTS } from '../ledger/registry.mjs';

const KNOWN_EVENTS = new Set([...RUN_EVENTS, ...INSTANCE_EVENTS, ...ESCAPES_EVENTS]);

export const DEFAULT_PROJECT_CONFIG_PATH = '.olympus/project.json';

export function defaultProjectConfig() {
  return {
    version: 1,
    // repo facts the harness enforces: path prefixes, relative to the repo root
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
}

function validateStack(stack, err) {
  if (stack === undefined || stack === null) return;
  if (!isPlainObject(stack)) {
    err('stack', 'must be an object');
    return;
  }
  if (typeof stack.composeFile !== 'string' || stack.composeFile.length === 0) {
    err('stack.composeFile', 'required string');
  } else if (/^([a-zA-Z]:)?[\\/]/.test(stack.composeFile)) {
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
  } else if (/^([a-zA-Z]:)?[\\/]/.test(graph.cardsDir)) {
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

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}
