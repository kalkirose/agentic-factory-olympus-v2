// Project config: one JSON versioned in the project repo. The daemon reads
// it from the default branch in its bare clone at each run launch, so config
// changes ship through the same PR path as the code they describe. The
// ownership test places every value: describes the project's code → here;
// describes the machine → instance config.
import { TRIPWIRE_METRICS, BREACH_OPS } from '../tripwires/registry.mjs';
import { ALL_LENSES, DEFAULT_LENSES } from '../lanes/lenses.mjs';
import {
  RUN_EVENTS,
  INSTANCE_EVENTS,
  ESCAPES_EVENTS,
  DEFECT_KINDS,
  PARK_TYPES,
} from '../ledger/registry.mjs';
import { WAIT_KINDS } from '../lanes/waiting.mjs';

const KNOWN_EVENTS = new Set([...RUN_EVENTS, ...INSTANCE_EVENTS, ...ESCAPES_EVENTS]);

export const DEFAULT_PROJECT_CONFIG_PATH = '.olympus/project.json';
export const DEFAULT_CONSTITUTION_PATH = '.olympus/constitution.md';

// How long a credential probe may run before the harness kills it and answers
// for it. A probe is one read-only question to a service, and every one the
// harness has seen answers in seconds; a minute is long enough for a slow
// service on a bad day and short enough that a probe which never returns does
// not hold the control drain or a frontier sweep behind it (ADR-0068).
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

// A path that starts at a root, POSIX or Windows. Most path entries here are
// repo-relative and this rejects them; the close-out block is the exception
// and this is what it requires.
const ABSOLUTE_PATH = /^([a-zA-Z]:)?[\\/]/;

/**
 * The paths whose content no review seat is given: lockfiles and files a
 * generator wrote. A judgment seat reviews what a person wrote. A lockfile
 * records what a package manager decided, in thousands of lines nobody reads,
 * and it lands in the same candidate diff as the twenty lines under judgment.
 * The seat is still told these files changed and by how much; only the patch
 * text is held back (ADR-0066).
 *
 * Each pattern opens with a recursive segment because a lockfile belongs to
 * whatever package it sits beside: a monorepo holds one per workspace, and a
 * list anchored at the repo root would filter the top one and hand the seat
 * the rest.
 */
export const DEFAULT_DIFF_EXCLUSIONS = [
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/*.generated.*',
];

/**
 * How much of the candidate diff a review brief carries inline.
 *
 * The whole diff goes to a file the brief names, and this is the excerpt in
 * front of it: enough that a seat starts reading the work in its first token,
 * short enough that the lenses, the spec reference and the duties around it
 * are not pushed out of the brief. The seat opens the file for the rest
 * (ADR-0066).
 */
export const DEFAULT_EXCERPT_CHARS = 12_000;

export function defaultProjectConfig() {
  return {
    version: 1,
    // repo facts the harness enforces: path entries relative to the repo
    // root — plain prefixes, or glob patterns (see isGlobEntry). `routesRoot`
    // is the directory a route id in a spec resolves under (ADR-0067): a plain
    // repo-relative path, defaulted to the storefront layout, or null for a
    // project whose specs name no routes. `componentsRoot` is the same fact
    // for a design-system component the spec's Components section names, read
    // as folder-per-component. A root the tree does not hold turns its rule
    // off for that project, and so does `null`.
    repo: {
      testPaths: [],
      uiPaths: [],
      routesRoot: 'apps/storefront/src/routes',
      componentsRoot: 'apps/storefront/src/lib/components',
    },
    // command name → argv; the single home for every runnable command
    commands: {},
    // deterministic gate layers; `command` names a key in `commands`.
    // `partTargeting: false` turns off part-level carrying inside a layer
    // (ADR-0046); absent leaves it on. `concurrencyGroups` names the layers
    // that may hold the machine together (ADR-0047); absent is the strict
    // sequence. `fastPathShip: true` lets a ship carry its certification over
    // a provably disjoint merge, `breadthGround` names the ground every suite
    // depends on whatever it declared, and `inertGround` names the ground the
    // project states no suite can reach (ADR-0056); all absent is today's
    // behaviour. `groundlessPaths` names the ground the project states no
    // suite READS, which a verdict cycle drops out of its diff before it
    // attributes a path to a part (ADR-0059). `flakeRerun: "whole"` returns
    // the flake filter's re-run to a whole re-run of the layer; absent, it
    // asks only for the parts and the files that failed.
    // `transientPatterns` adds this project's own wording for a cause outside
    // the tree to the closed signature set, and `proofDebt: true` offers the
    // owner's trade at the external gate; both absent is the default, which is
    // the closed set alone and no trade (ADR-0069). `allowlistPaths` names the
    // files that carry a cross-cutting gate's allowlist, so a spec-lens finding
    // on one is countable afterwards; absent, that reading is a standing zero
    // and the project is told so by its own band (ADR-0010).
    gates: { tier1: [] },
    // one convention per line; prompt assembly consumes these
    conventions: [],
    // the lenses the judgment review carries; naming a lens the default panel
    // leaves out is what puts it back. `excludeFromDiff` names the paths whose
    // content the review seat is not given (see DEFAULT_DIFF_EXCLUSIONS);
    // stating it replaces the default list rather than adding to it.
    // `excerptChars` is how much of the diff the brief carries inline; the
    // whole diff is a file the brief names, whatever this value is.
    review: {
      lenses: [...DEFAULT_LENSES],
      excludeFromDiff: [...DEFAULT_DIFF_EXCLUSIONS],
      excerptChars: DEFAULT_EXCERPT_CHARS,
    },
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
    // command that proves it, and the hosts its service answers on; an empty
    // list probes nothing and declares no host
    credentials: [],
    // how a credential probe is bounded
    probes: { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS },
    // label rules: one label and the diff path entries that require it; an
    // empty list leaves every request unlabelled
    labels: [],
    // the workflow files the daemon watches on the default branch — the runs
    // no request path covers; an empty list watches nothing
    watchedWorkflows: [],
    // optional close-out extras the project asks for after a shipped story;
    // null = the close-out is exactly what it always was
    closeout: null,
    // the per-run cache directory the harness offers a run's commands
    // (ADR-0048); `false` offers none, absent leaves it on
    runCache: true,
  };
}

/**
 * Validates a parsed project config. Returns a list of errors, each with a
 * `path` and a `message`. An empty list means valid.
 *
 * `launch` arms the rules that bind only where a run is created. A live run
 * re-parses the blob it pinned at launch at every lane stage, and a rule born
 * after that pin would fault the run mid-flight — so a strict launch rule
 * stays out of the permissive default.
 */
export function validateProjectConfig(config, { launch = false } = {}) {
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
  validateReview(config.review, err);
  validateLanes(config.lanes, config.commands, err);
  validateStack(config.stack, err);
  validateGraph(config.graph, err);
  validateTripwires(config.tripwires, err);
  validateDiffPolicy(config.diffPolicy, err);
  validateBudgets(config.budgets, err);
  validateConstitutionPath(config.constitutionPath, err);
  validateCredentials(config.credentials, config.commands, config.gates, err);
  validateProbes(config.probes, err);
  validateLabels(config.labels, err);
  validateWatchedWorkflows(config.watchedWorkflows, err);
  validateCloseout(config.closeout, err);
  // The fallback path of ADR-0048: `false` offers a run's commands no cache
  // directory, and every command transforms and builds from zero as it did
  // before the directory existed.
  if (config.runCache !== undefined && typeof config.runCache !== 'boolean') {
    err('runCache', 'must be a boolean');
  }
  if (isPlainObject(config.lanes) && isPlainObject(config.lanes.story)) {
    if (!Array.isArray(config.repo?.testPaths) || config.repo.testPaths.length === 0) {
      err('repo.testPaths', 'the story lane requires at least one test path');
    }
    if (launch) validateSuiteIsGated(config.gates, config.lanes.story, err);
  }
  return errors;
}

/**
 * The frozen suite has to be a Tier-1 layer. A verdict runs `gates.tier1` and
 * nothing else, while the lane's `suiteCommand` runs only before an
 * implementation exists: the freeze red-state check, the inherited-base
 * red-state check, and the adversary waves in their disposable trees. So a
 * suite command no layer carries runs against the pre-implementation tree and
 * never against the candidate, and the green verdict is silent about the one
 * suite the run was created to satisfy. The match is on the command, not the
 * layer name: a layer may call the suite whatever the project's gate
 * vocabulary calls it. Launch-only: see `validateProjectConfig`.
 */
function validateSuiteIsGated(gates, story, err) {
  const suite = story.suiteCommand;
  const tier1 = isPlainObject(gates) ? gates.tier1 : undefined;
  // Both shapes are reported by their own rules; this one needs them sound.
  if (typeof suite !== 'string' || !Array.isArray(tier1) || tier1.length === 0) return;
  if (tier1.some((layer) => isPlainObject(layer) && layer.command === suite)) return;
  err(
    'lanes.story.suiteCommand',
    `no gates.tier1 layer runs it (${suite}); the verdict runs the Tier-1 layers alone, ` +
      'so the frozen suite would never run against the implemented tree',
  );
}

function validateRepo(repo, err) {
  if (repo === undefined) return;
  if (!isPlainObject(repo)) {
    err('repo', 'must be an object');
    return;
  }
  validateStringList(repo.testPaths, 'repo.testPaths', err);
  validateStringList(repo.uiPaths, 'repo.uiPaths', err);
  // The two roots a spec claim about the tree resolves under. They are
  // validated by one rule because they are one kind of value: a plain
  // repo-relative directory the lint reads the tree under, or null to turn
  // that lint rule off by name (ADR-0067).
  validateTreeRoot(repo.routesRoot, 'repo.routesRoot', err);
  validateTreeRoot(repo.componentsRoot, 'repo.componentsRoot', err);
}

function validateTreeRoot(value, path, err) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || value.length === 0) {
    err(path, 'must be a non-empty repo-relative path, or null');
  } else if (/^([A-Za-z]:)?[\\/]/.test(value) || isGlobEntry(value)) {
    err(path, 'must be a plain repo-relative directory path, not a glob');
  }
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

/** What `gates.flakeRerun` may say. Closed, and the absent value is the first. */
const FLAKE_RERUN = new Set(['narrowed', 'whole']);

function validateGates(gates, commands, err) {
  if (gates === undefined) return;
  if (!isPlainObject(gates)) {
    err('gates', 'must be an object');
    return;
  }
  // The fallback path of ADR-0046: `false` returns every gate layer to a
  // whole re-run per cycle, whatever its command says about its own parts.
  // Absent is the decision, which is that a part a diff cannot reach carries.
  if (gates.partTargeting !== undefined && typeof gates.partTargeting !== 'boolean') {
    err('gates.partTargeting', 'must be a boolean');
  }
  // What the flake filter's one re-run asks for. `whole` is the re-run every
  // project ran before this key existed and is the one-line revert; absent is
  // the decision, which is that a re-run asks for the parts and the files the
  // replaced attempt failed on.
  if (gates.flakeRerun !== undefined && !FLAKE_RERUN.has(gates.flakeRerun)) {
    err('gates.flakeRerun', `must be one of: ${[...FLAKE_RERUN].join(', ')}`);
  }
  // The clean-rebase fast path (ADR-0056). Off is the default and absent is
  // off: a ship whose incoming default branch moved takes the full re-verdict
  // exactly as it always has. `breadthGround` is the ground that belongs to
  // every suite whatever any suite declared, and the fast path refuses to fire
  // for a project that declares none.
  if (gates.fastPathShip !== undefined && typeof gates.fastPathShip !== 'boolean') {
    err('gates.fastPathShip', 'must be a boolean');
  }
  if (gates.breadthGround !== undefined && !isStringList(gates.breadthGround)) {
    err('gates.breadthGround', 'must be an array of path entries');
  }
  // `inertGround` is the other side of the same claim: ground the project
  // states no suite of it can reach. A change on the default branch that lands
  // outside it is ground nobody described, and the fast path refuses rather
  // than reading silence as safety.
  if (gates.inertGround !== undefined && !isStringList(gates.inertGround)) {
    err('gates.inertGround', 'must be an array of path entries');
  }
  // `groundlessPaths` is a THIRD list and a different claim (ADR-0059). Read
  // the three side by side, because two of them look alike and are not:
  //
  //   breadthGround    every suite depends on this, whatever it declared
  //   inertGround      the DEFAULT BRANCH may move this and a certified ship
  //                    still stands. Read at ship time, by fastpath.mjs alone.
  //   groundlessPaths  no suite of this project READS this. Read at verdict
  //                    time, by parts.mjs alone, to decide what a change can
  //                    reach.
  //
  // The two questions are different and their answers may differ. A file the
  // ship path may ignore over a merge is not automatically a file no suite
  // opens, and a file no suite opens may still be one a ship must re-verdict
  // over. So neither list is derived from the other, neither reader consults
  // the other's list, and a project earns each entry of each by its own proof.
  if (gates.groundlessPaths !== undefined && !isStringList(gates.groundlessPaths)) {
    err('gates.groundlessPaths', 'must be an array of path entries');
  }
  // What this project's runners print when the cause of a red is outside the
  // tree. It adds to the closed signature set and never replaces it: a
  // runner's wording is the project's fact, and the set itself grows by
  // decision (ADR-0069). Each entry is a regular expression, matched
  // case-insensitively over a failed part's own output, so a pattern that will
  // not compile is refused here rather than dropped inside a verdict cycle.
  if (gates.transientPatterns !== undefined) {
    if (!isStringList(gates.transientPatterns)) {
      err('gates.transientPatterns', 'must be an array of regular expressions');
    } else {
      gates.transientPatterns.forEach((source, i) => {
        try {
          new RegExp(source, 'i');
        } catch (error) {
          err(`gates.transientPatterns[${i}]`, `is not a regular expression: ${error.message}`);
        }
      });
    }
  }
  // A FOURTH list, and a different claim again: the files that carry a
  // cross-cutting gate's allowlist. A story that extends the codebase adds a
  // line to one of them in its own diff, so nothing here blocks a write and
  // nothing here narrows a re-run. The list exists to be counted: it is what
  // tells the `allowlist-findings-window` metric which of a run's confirmed
  // spec-lens findings are findings about an allowlist addition, and a project
  // that declares none gets no reading rather than a standing zero (ADR-0010).
  if (gates.allowlistPaths !== undefined && !isStringList(gates.allowlistPaths)) {
    err('gates.allowlistPaths', 'must be an array of path entries');
  }
  // The owner's speed-over-residual-safety trade: with it on, a service that
  // stays down past the external wait offers `defer-proof` at its gate and a
  // ship may go out with a proof owed. Off is the default and absent is off
  // (ADR-0069).
  if (gates.proofDebt !== undefined && typeof gates.proofDebt !== 'boolean') {
    err('gates.proofDebt', 'must be a boolean');
  }
  if (gates.tier1 !== undefined && !Array.isArray(gates.tier1)) {
    err('gates.tier1', 'must be an array of layers');
    return;
  }
  const seen = new Set();
  (gates.tier1 ?? []).forEach((layer, i) => {
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
    // What this layer's process tree may hold, in mebibytes. Optional, and a
    // statement rather than a limit: the harness enforces nothing with it, and
    // a runner's own `--max-old-space-size` is still the thing that decides
    // when the process aborts. What declaring it buys is a warning before that
    // happens — a layer with a ceiling is watched as a fraction of it, and a
    // layer without one is watched for a climb alone (ADR-0045).
    if (layer.memoryCeilingMb !== undefined) {
      if (typeof layer.memoryCeilingMb !== 'number' || !(layer.memoryCeilingMb > 0)) {
        err(at('memoryCeilingMb'), 'must be a positive number of mebibytes');
      }
    }
    if (typeof layer.name === 'string') seen.add(layer.name);
  });
  validateConcurrencyGroups(gates, seen, err);
}

// The layers this project lets hold the machine together (ADR-0047). Every
// rule below refuses a config that would buy nothing or mean two things, and
// none of them decides anything about the machine: the harness runs what the
// project named and measures none of it.
//
// A group of one is the sequence, so it is a typo rather than a statement. A
// name no layer answers to is a group that would silently never form. A name
// in two groups has no answer to which group it runs in. A layer that `needs`
// another layer of its own group is a contradiction on the face of it: the
// prerequisite has to have settled before the dependent starts.
function validateConcurrencyGroups(gates, layerNames, err) {
  const groups = gates.concurrencyGroups;
  if (groups === undefined) return;
  if (!Array.isArray(groups)) {
    err('gates.concurrencyGroups', 'must be an array of layer-name groups');
    return;
  }
  const needs = new Map();
  for (const layer of gates.tier1 ?? []) {
    if (isPlainObject(layer) && typeof layer.name === 'string') {
      needs.set(layer.name, isStringList(layer.needs) ? layer.needs : []);
    }
  }
  const claimed = new Map();
  groups.forEach((group, i) => {
    const at = `gates.concurrencyGroups[${i}]`;
    if (!isStringList(group)) {
      err(at, 'must be an array of non-empty layer names');
      return;
    }
    if (group.length < 2) {
      err(at, 'must name at least two layers; a group of one is the sequence');
      return;
    }
    const members = new Set(group);
    group.forEach((name, j) => {
      if (!layerNames.has(name)) {
        err(`${at}[${j}]`, `must name a gates.tier1 layer: ${name}`);
        return;
      }
      const owner = claimed.get(name);
      if (owner !== undefined) {
        err(`${at}[${j}]`, `layer ${name} is already in group ${owner}`);
        return;
      }
      claimed.set(name, i);
      const blocked = (needs.get(name) ?? []).filter((need) => members.has(need));
      for (const need of blocked) {
        err(`${at}[${j}]`, `layer ${name} needs ${need}, so the two cannot run together`);
      }
    });
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
  // The project's own check that every suite file declares the ground that can
  // change its answer. It runs over the suite as a seat left it, before any
  // commit and before the freeze (ADR-0060). The argv is the project's, so the
  // project is what makes it strict: the entry names the strict form of the
  // check, not the lenient one a gate layer runs. A project that names none
  // skips the step, which is what every project had before the field existed.
  if (lane.groundCommand !== undefined) {
    if (typeof lane.groundCommand !== 'string' || !names[lane.groundCommand]) {
      err('lanes.story.groundCommand', 'must name a key in commands');
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
  // The fallback path of ADR-0044: `false` returns the lane to the old default,
  // where every frozen-surface collision is an owner question. Absent is the
  // decision, which is that the card settles what its scope covers.
  if (lane.cardAuthorizedSupersede !== undefined && typeof lane.cardAuthorizedSupersede !== 'boolean') {
    err('lanes.story.cardAuthorizedSupersede', 'must be a boolean');
  }
}

// The judgment panel: the lenses the Fury round and the generalist seat carry.
// The set is closed — the review implements every name it admits — and an
// unknown name is refused rather than ignored, because ignoring it shrinks the
// panel silently. A shrunk panel judges less and still says green, which is the
// dangerous direction for a gate to be wrong in.
function validateReview(review, err) {
  if (review === undefined || review === null) return;
  if (!isPlainObject(review)) {
    err('review', 'must be an object');
    return;
  }
  for (const key of Object.keys(review)) {
    if (key !== 'lenses' && key !== 'excludeFromDiff' && key !== 'excerptChars') {
      err(`review.${key}`, 'unknown key: lenses | excludeFromDiff | excerptChars');
    }
  }
  // A value that is not a list of path entries is refused rather than ignored,
  // for the reason an unknown lens is: a filter nobody applied hands the seat a
  // diff the project meant to keep out of it, and the round still says green.
  if (review.excludeFromDiff !== undefined && !isStringList(review.excludeFromDiff)) {
    err('review.excludeFromDiff', 'must be an array of non-empty path entries');
  }
  // The inline excerpt is a length, and a length is a positive integer. Zero
  // and below are refused because the brief would open on nothing at all: the
  // seat's first read of the work is the excerpt, and the file behind it is
  // what a seat opens second.
  if (
    review.excerptChars !== undefined &&
    (!Number.isInteger(review.excerptChars) || review.excerptChars < 1)
  ) {
    err('review.excerptChars', 'must be a positive integer: characters of the diff carried inline');
  }
  if (review.lenses === undefined) return;
  if (!isStringList(review.lenses) || review.lenses.length === 0) {
    err('review.lenses', 'must be a non-empty array of lens names');
    return;
  }
  const seen = new Set();
  review.lenses.forEach((lens, i) => {
    if (!ALL_LENSES.includes(lens)) {
      err(`review.lenses[${i}]`, `must name a lens the review implements: ${ALL_LENSES.join(' | ')}`);
    } else if (seen.has(lens)) {
      err(`review.lenses[${i}]`, `duplicate lens: ${lens}`);
    }
    seen.add(lens);
  });
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

/**
 * The closed sets a tripwire's narrowing param may name, by the name the
 * metric registry uses for each. Nothing is redefined here: each set is the
 * one the harness already writes those values from, and a unit test holds the
 * table to every vocabulary the registry names.
 */
export const PARAM_VOCABULARIES = {
  'defect kind': DEFECT_KINDS,
  'park type': PARK_TYPES,
  'wait kind': WAIT_KINDS,
};

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
    // A param the metric does not take. It is refused rather than ignored:
    // a misspelt narrowing reads as no narrowing, and the entry then measures
    // something wider than the band was set for.
    const takes = new Set([...(metric.requiredParams ?? []), ...(metric.optionalParams ?? [])]);
    for (const param of Object.keys(isPlainObject(entry.params) ? entry.params : {})) {
      if (!takes.has(param)) {
        err(
          at(`params.${param}`),
          `metric ${entry.metric} takes ${takes.size > 0 ? [...takes].join(', ') : 'no params'}`,
        );
      }
    }
    // A metric narrowed to a closed name is validated against that set. A
    // reading keyed on a name nothing carries answers zero for ever and never
    // breaches, which looks exactly like a metric that is fine (ADR-0068).
    // The metric names the vocabulary its narrowing param takes; the sets
    // themselves live where the thing they name is defined.
    for (const [param, vocabulary] of Object.entries(metric.paramVocabulary ?? {})) {
      const value = entry.params?.[param];
      if (value === undefined) continue;
      const known = PARAM_VOCABULARIES[vocabulary];
      if (known && !known.has(value)) {
        err(at(`params.${param}`), `unknown ${vocabulary}: ${value}`);
      }
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
// `recapturablePaths` and `sweptPaths` ride the same block and are not tiers:
// they block nothing and admit nothing. `recapturablePaths` classes the writes
// the capture takes back from frozen paths, so a take-back on an artifact a
// re-freeze re-takes is recorded quietly rather than as an open loud item.
// `sweptPaths` names where a red test run drops generated artifacts, so a file
// the freeze never held is cleared instead of reported as a take-back
// (ADR-0017).
const LANES = ['story', 'repair'];
const POLICED_LANES = new Set(LANES);
const TIER_KEYS = [
  'deniedPaths',
  'declaredPaths',
  'forbiddenPatterns',
  'recapturablePaths',
  'sweptPaths',
];

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
    validateStringList(tiers.sweptPaths, at('sweptPaths'), err);
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
// works, the Tier-1 layers whose work needs it, and the surfaces beyond this
// host that will also need it. The probe is required: a declared credential
// with nothing behind it reads as covered and is not. The variable is one
// name, never a pattern — the probe answers for exactly the value it was
// given.
//
// `layers` is what makes a credential-absent red attributable by machine. A
// Tier-1 layer named here needs this variable to judge anything, so a red of
// that layer on a host where the variable is absent is reported with the
// variable's name on the layer result itself, before a seat reasons about it
// (ADR-0042). It also bounds the replay probe: a layer that needs a credential
// is replayable only where the host declares that credential probe-eligible.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_CI_KEYS = ['secret', 'workflows'];

/**
 * How a credential probe is bounded. One key today, and a section rather than
 * a loose `probeTimeoutMs` because the probe is a thing with rules of its own
 * and the next one belongs beside this one.
 */
function validateProbes(probes, err) {
  if (probes === undefined) return;
  if (!isPlainObject(probes)) {
    err('probes', 'must be an object');
    return;
  }
  for (const key of Object.keys(probes)) {
    if (key !== 'timeoutMs') err(`probes.${key}`, 'unknown key');
  }
  if (probes.timeoutMs === undefined) return;
  if (!Number.isInteger(probes.timeoutMs) || probes.timeoutMs <= 0) {
    err('probes.timeoutMs', 'must be a positive integer of milliseconds');
  }
}

/**
 * A hostname and nothing else: labels and dots, no scheme, no port, no path. A
 * signature is matched against these by equality or by suffix, so a URL here
 * would match nothing and read as a declaration that works.
 */
const HOSTNAME = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

function validateCredentials(credentials, commands, gates, err) {
  const tier1 = isPlainObject(gates) && Array.isArray(gates.tier1) ? gates.tier1 : [];
  const layerNames = new Set(tier1.filter(isPlainObject).map((layer) => layer.name));
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
    if (entry.layers !== undefined) {
      if (!isStringList(entry.layers) || entry.layers.length === 0) {
        err(at('layers'), 'must be a non-empty array of Tier-1 layer names');
      } else {
        // A layer name nothing runs is a declaration that attributes no red
        // and gates no replay: it reads like coverage and is a typo.
        entry.layers.forEach((layer, j) => {
          if (!layerNames.has(layer)) {
            err(at(`layers[${j}]`), `must name a gates.tier1 layer: ${layer}`);
          }
        });
      }
    }
    // The hosts this credential's service answers on. A red that names one of
    // them is that service being down, and the wait for it is this
    // credential's own probe (ADR-0069). A credential that declares none gets
    // no external wait, which is what every project had before the key
    // existed.
    if (entry.hosts !== undefined) {
      if (!isStringList(entry.hosts) || entry.hosts.length === 0) {
        err(at('hosts'), 'must be a non-empty array of hostnames');
      } else {
        entry.hosts.forEach((host, j) => {
          if (!HOSTNAME.test(host)) {
            err(at(`hosts[${j}]`), `must be a hostname, not a URL or a path: ${host}`);
          }
        });
      }
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
    review: { ...base.review, ...config.review },
    probes: { ...base.probes, ...config.probes },
    stack: config.stack ?? null,
    graph: config.graph ? { phases: [{ name: 'launch' }], ...config.graph } : null,
    closeout: config.closeout ?? null,
  };
}

/**
 * Parses and validates project config text (as read from the bare clone).
 * Throws with every validation error; the launch that read it fails. `opts`
 * passes through to `validateProjectConfig` — only the run launch parses
 * with `{launch: true}`.
 */
export function parseProjectConfig(text, source, opts) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`project config is not valid JSON: ${source}`, { cause });
  }
  const errors = validateProjectConfig(parsed, opts);
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
