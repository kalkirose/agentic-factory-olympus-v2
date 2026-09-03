// The end-to-end fixture: a throwaway project repository, a daemon home, and
// the drivers that run the two binaries as child processes. Nothing here
// imports a lane, a seat or the engine: the assembled daemon is the thing
// under test, so the only entry points are bin/olympusd.mjs and
// bin/olympusctl.mjs, and the only observation surfaces are the control
// files, the ledgers and the run artifacts on disk.
//
// Two stub tools stand in for the two processes a run cannot spawn in CI: the
// seat CLI (instance config `claudeCommand`) and the forge CLI (`ghCommand`).
// Both are configuration seams the production code already carries. Every
// other command a run runs is real: git, the project's gate commands, the
// acceptance suite.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../src/ledger/ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
const OLYMPUSD = join(REPO_ROOT, 'bin', 'olympusd.mjs');
const OLYMPUSCTL = join(REPO_ROOT, 'bin', 'olympusctl.mjs');
const SEAT_STUB = join(HERE, 'stub', 'seat.mjs');
const GH_STUB = join(HERE, 'stub', 'gh.mjs');

// The remote the instance config names. No request leaves the machine: git
// rewrites this prefix to the fixture's own bare repository through the
// insteadOf entry the daemon environment carries. The URL still has to be a
// GitHub one, because the forge is resolved from it.
export const REPO_URL = 'https://github.com/olympus-e2e/fixture.git';
export const PROJECT = 'fixture';
export const CARD_PATH = '.olympus/cards/alpha-1.md';
export const TICKET_PATH = '.olympus/tickets/greeting.md';
// A ticket whose touched-paths block names ground the repair lane is denied.
// The daemon refuses it at launch (ADR-0067).
export const FORBIDDEN_TICKET_PATH = '.olympus/tickets/forbidden.md';
export const DENIED_GATES = '.olympus/gates';
export const SECRET_NAME = 'E2E_SECRET_TOKEN';
export const REQUIRED_CHECK = 'ci';

// -- the fixture project -----------------------------------------------------

// The `smoke` gate is the one here that stands in for a real layer's shape
// rather than its job: it holds an allocation, and it holds it for longer than
// the harness's own peak-memory sampler takes to produce a reading (ADR-0045).
// A gate that answers in five milliseconds is under the sampling floor on every
// host, and a fixture made only of those would leave the measurement untestable
// through the assembled binaries.
export const SMOKE_HELD_MB = 48;
export const SMOKE_CEILING_MB = 512;
const SMOKE_HOLD_MS = 1400;

/** The project config the origin is born with. Exported so a scenario that
 * needs a different section can amend that one and keep the rest. */
export const PROJECT_CONFIG = {
  version: 1,
  // The routes root is where a route id in a spec resolves (ADR-0067); the
  // fixture tree holds one route under it.
  repo: { testPaths: ['tests'], uiPaths: [], routesRoot: 'routes' },
  commands: {
    lint: ['node', '.olympus/gates/lint.mjs'],
    suite: ['node', '.olympus/gates/suite.mjs'],
    smoke: ['node', '.olympus/gates/smoke.mjs'],
    cardlint: ['node', '.olympus/gates/cardlint.mjs'],
  },
  gates: {
    tier1: [
      { name: 'lint', command: 'lint' },
      { name: 'suite', command: 'suite' },
      // The one layer that declares what it may hold, so the e2e proves the
      // declaration reaches the reading in the ledger (ADR-0045).
      { name: 'smoke', command: 'smoke', needs: ['suite'], memoryCeilingMb: SMOKE_CEILING_MB },
    ],
  },
  lanes: { story: { suiteCommand: 'suite', lintCommand: 'cardlint' } },
  conventions: ['One exported function per module.'],
  stack: null,
  graph: { cardsDir: '.olympus/cards' },
  tripwires: [],
  diffPolicy: {
    story: { deniedPaths: [DENIED_GATES], declaredPaths: ['src'] },
    repair: { deniedPaths: [DENIED_GATES], declaredPaths: ['src'] },
  },
  budgets: { story: 50, repair: 50 },
  constitutionPath: '.olympus/constitution.md',
};

const CARD = `---
key: alpha-1
title: Doubling helper
phase: launch
---

## Goal

Provide f(x) in src/feature.mjs, which doubles the number it is given.

## Scope boundary

src/feature.mjs and its test only.

## Open decisions

- Does f reject a value that is not a number?

## Acceptance criteria

**AC-1** f(x) returns 2*x for every number x.
`;

const TICKET = `# Repair ticket: greet returns the wrong text

## The defect

greet() in src/greeting.mjs answers "hi". It must answer "hello".

## Scope

Repair src/greeting.mjs and leave a regression test under tests/.
`;

// The ticket the daemon refuses: its block names a gate script, and the
// repair lane's diff policy denies the gates directory.
const FORBIDDEN_TICKET = `# Repair ticket: loosen the suite gate

## The defect

The suite gate is too strict.

## Touched paths

\`\`\`touched-paths
.olympus/gates/suite.mjs — dev
src/greeting.mjs — dev
\`\`\`
`;

const CONSTITUTION = `# Constitution

- A module exports one function.
- A test asserts behaviour, never an implementation detail.
`;

// Every gate command leaves a mark, so the scenario can prove the command
// spawned from the project config table rather than infer it from a verdict.
// The readiness lint stamps no event at all when it passes, and a command that
// cannot spawn is one of the failures this suite exists to catch.
const MARK = `import { appendFileSync } from 'node:fs';

export function mark(name) {
  if (process.env.OLYMPUS_E2E_MARKS) appendFileSync(process.env.OLYMPUS_E2E_MARKS, name + '\\n');
}
`;

// A Tier-1 layer that reads the tree and passes. It is the layer the targeted
// cycle carries forward, and the one the confirmation sweep re-runs.
//
// It is also the fixture's cache consumer (ADR-0048): it keeps a file in the
// directory the harness named it, and marks whether it found one there. The
// first execution of a run marks it cold and every later one marks it warm, so
// the scenario proves the cache survives a cycle and that the tree the run
// ships never holds it.
const LINT_GATE = `import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mark } from './mark.mjs';

mark('lint');
const cache = process.env.OLYMPUS_CACHE_DIR;
if (cache) {
  const kept = join(cache, 'lint-cache');
  mark(existsSync(kept) ? 'cache-warm' : 'cache-cold');
  mkdirSync(cache, { recursive: true });
  writeFileSync(kept, 'kept between cycles\\n');
} else {
  mark('cache-absent');
}
const files = readdirSync('src').filter((name) => name.endsWith('.mjs'));
console.log(\`lint: \${files.length} source file(s)\`);
`;

// The acceptance suite runner. A directory argument is not a recursive sweep
// on every supported runtime, so the runner names the test files itself.
//
// It runs in parts, and it speaks both halves of the protocol the harness
// narrows with. A part is one family of test files — the file name up to the
// first '-' or '.', with the source module of the same name — and it declares
// that ground, says whether it passed, and, when it failed, names the files
// that failed. It honours `OLYMPUS_PARTS` (the parts to run) and
// `OLYMPUS_FAILED_FILES` (the files to run inside a part), so a narrowed
// re-run and a narrowed confirmation sweep are proved end to end here rather
// than asserted about a fake command.
const SUITE_GATE = `import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mark } from './mark.mjs';

mark('suite');
const files = readdirSync('tests').filter((name) => name.endsWith('.test.mjs')).sort();
if (files.length === 0) {
  console.error('suite: no test file under tests/');
  process.exit(1);
}
const family = new Map();
for (const name of files) {
  const part = name.split(/[-.]/)[0];
  if (!family.has(part)) family.set(part, []);
  family.get(part).push('tests/' + name);
}
const only = (process.env.OLYMPUS_PARTS || '').split(',').map((n) => n.trim()).filter(Boolean);
const narrow = new Map();
for (const entry of (process.env.OLYMPUS_FAILED_FILES || '').split(';')) {
  const at = entry.indexOf('=');
  if (at <= 0) continue;
  const paths = entry.slice(at + 1).split(',').filter(Boolean);
  if (paths.length > 0) narrow.set(entry.slice(0, at), paths);
}
let bad = 0;
for (const [part, all] of family) {
  if (only.length > 0 && !only.includes(part)) continue;
  const asked = narrow.get(part);
  const narrowed = asked ? all.filter((path) => asked.includes(path)) : [];
  const paths = narrowed.length > 0 ? narrowed : all;
  console.log('::olympus part ' + part);
  console.log('::olympus part-inputs ' + all.join(' ') + ' src/' + part + '.mjs');
  console.log('suite: ' + part + ', ' + paths.length + ' of ' + all.length + ' file(s)');
  const failed = [];
  for (const path of paths) {
    const one = spawnSync(process.execPath, ['--test', path], { encoding: 'utf8' });
    process.stdout.write((one.stdout || '') + (one.stderr || ''));
    if ((one.status || 0) !== 0) failed.push(path);
  }
  if (failed.length > 0) {
    console.log('::olympus part-failed-files ' + part + ' ' + failed.join(','));
    console.log('::olympus part-failed ' + part);
    bad = 1;
  } else {
    console.log('::olympus part-ok ' + part);
  }
}
process.exit(bad);
`;

// A test the origin is born with: it belongs to a part of its own, and it is
// therefore the green a narrowed cycle carries and the confirmation sweep has
// to buy back. It asserts the shape of src/base.mjs and never its value, so a
// scenario that moves that value on the default branch is testing what it came
// to test rather than fighting this file.
const BASE_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';

test('the base module publishes a factor', async () => {
  const { FACTOR } = await import('../src/base.mjs');
  assert.equal(typeof FACTOR, 'number');
});
`;

const SMOKE_GATE = `import { mark } from './mark.mjs';

mark('smoke');
const held = [];
for (let i = 0; i < ${SMOKE_HELD_MB}; i++) held.push(Buffer.alloc(1024 * 1024, 1));
setTimeout(() => {
  console.log('smoke: ok, ' + held.length + ' MB held');
}, ${SMOKE_HOLD_MS});
`;

const CARD_LINT_GATE = `import { readdirSync, readFileSync } from 'node:fs';
import { mark } from './mark.mjs';

mark('cardlint');
let checked = 0;
for (const name of readdirSync('.olympus/cards')) {
  if (!name.endsWith('.md')) continue;
  if (!readFileSync(\`.olympus/cards/\${name}\`, 'utf8').startsWith('---')) {
    console.error(\`card lint: \${name} carries no frontmatter\`);
    process.exit(1);
  }
  checked++;
}
console.log(\`card lint: \${checked} card(s)\`);
`;

/** The tree the fixture origin holds on its default branch. */
export function fixtureTree() {
  return {
    '.olympus/project.json': JSON.stringify(PROJECT_CONFIG, null, 2) + '\n',
    '.olympus/constitution.md': CONSTITUTION,
    '.olympus/cards/alpha-1.md': CARD,
    '.olympus/tickets/greeting.md': TICKET,
    [FORBIDDEN_TICKET_PATH]: FORBIDDEN_TICKET,
    '.olympus/gates/mark.mjs': MARK,
    '.olympus/gates/lint.mjs': LINT_GATE,
    '.olympus/gates/suite.mjs': SUITE_GATE,
    '.olympus/gates/smoke.mjs': SMOKE_GATE,
    '.olympus/gates/cardlint.mjs': CARD_LINT_GATE,
    'src/base.mjs': 'export const FACTOR = 2;\n',
    'src/greeting.mjs': "export const greet = () => 'hi';\n",
    // One route under the routes root, so a spec that names a route the tree
    // holds passes the lint and one that names a phantom is refused.
    'routes/[lang=lang]/shop/+page.mjs': 'export const page = "shop";\n',
    'tests/.keep': 'The acceptance suite lives here.\n',
    'tests/base.test.mjs': BASE_TEST,
    'README.md': '# Fixture project\n',
  };
}

// -- git ---------------------------------------------------------------------

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function writeTree(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

// -- build -------------------------------------------------------------------

/**
 * Builds one fixture: a bare origin holding the project tree, a daemon home
 * with an instance config that points at the two stubs, and the scenario file
 * the stub seat reads.
 *
 * `tree` amends the project tree the origin is born with, path by path. Every
 * fixture builds its own temporary directory, so one scenario's amendment
 * reaches nothing but that scenario. `slotCap` is the project's slot cap: one
 * run at a time unless a scenario is about two of them side by side.
 * @param {{prefix: string, scenario: object, tree?: Record<string, string>,
 *   slotCap?: number}} opts
 */
export function buildFixture({ prefix, scenario, tree = {}, slotCap = 1 }) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const seed = join(root, 'seed');
  const origin = join(root, 'origin.git');
  const home = join(root, 'home');
  const calls = join(root, 'seat-calls');

  mkdirSync(seed, { recursive: true });
  git(['init', '-b', 'main', '.'], seed);
  git(['config', 'user.email', 'fixture@olympus.invalid'], seed);
  git(['config', 'user.name', 'Olympus Fixture'], seed);
  writeTree(seed, { ...fixtureTree(), ...tree });
  git(['add', '-A'], seed);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], seed);
  git(['clone', '--bare', '--quiet', seed, origin]);

  mkdirSync(home, { recursive: true });
  mkdirSync(calls, { recursive: true });
  writeFileSync(
    join(home, 'instance.json'),
    JSON.stringify(
      {
        version: 1,
        logLevel: 'info',
        // One seat of the default model at once, so the Fury fan-out queues on
        // the semaphore instead of running the panel wide.
        semaphores: { 'claude-opus-5': 1, 'claude-fable-5-1': 2 },
        claudeCommand: ['node', SEAT_STUB],
        ghCommand: ['node', GH_STUB],
        secretEnv: ['E2E_SECRET_*'],
        projects: {
          [PROJECT]: {
            repoUrl: REPO_URL,
            defaultBranch: 'main',
            projectConfigPath: '.olympus/project.json',
            slotCap,
          },
        },
      },
      null,
      2,
    ) + '\n',
  );

  const scenarioPath = join(root, 'scenario.json');
  // `stallMarker` is where a stalled seat reports its own pid. A scenario that
  // names no `stallSeat` never writes it.
  const stallMarker = join(root, 'stall.pid');
  writeFileSync(
    scenarioPath,
    JSON.stringify(
      { ...scenario, callDir: calls, secretName: SECRET_NAME, stallMarker },
      null,
      2,
    ) + '\n',
  );
  const forgeState = join(root, 'forge.json');
  writeFileSync(
    forgeState,
    JSON.stringify(
      {
        origin,
        base: 'main',
        check: REQUIRED_CHECK,
        head: null,
        armed: false,
        merged: false,
        mergeSha: null,
        prStateCalls: 0,
        checkCalls: 0,
      },
      null,
      2,
    ) + '\n',
  );
  const callLog = join(root, 'forge-calls.jsonl');
  const marks = join(root, 'gate-marks.txt');

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // the daemon is not a test runner child
  delete env.OLYMPUSD_HOME; // every command names its home explicitly
  Object.assign(env, {
    OLYMPUS_E2E_SCENARIO: scenarioPath,
    OLYMPUS_E2E_FORGE: forgeState,
    OLYMPUS_E2E_FORGE_LOG: callLog,
    OLYMPUS_E2E_MARKS: marks,
    [SECRET_NAME]: 'fixture-credential',
    // Every git child of the daemon resolves the GitHub URL to the local bare
    // repository. The rewrite rides the environment, so no machine-level git
    // config is touched.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${origin.replaceAll('\\', '/')}.insteadOf`,
    GIT_CONFIG_VALUE_0: REPO_URL,
  });

  return {
    root,
    seed,
    origin,
    home,
    calls,
    marks,
    scenarioPath,
    stallMarker,
    forgeState,
    callLog,
    env,
    daemon: null,
  };
}

// -- the binaries ------------------------------------------------------------

/**
 * Starts the daemon in the foreground and waits for the daemon-started stamp
 * this start writes. The count is taken first, so a second instance over the
 * same home (the restart a hold is taken for) waits for its own stamp rather
 * than reading the previous one's.
 *
 * `run` and not `start`: `start` detaches the daemon on purpose (ADR-0050),
 * and this suite supervises the daemon as its own child so that it can end it,
 * read its streams and see how it exited. `run` is the same daemon and the
 * same code path from the assembled binary; it is the form a service manager
 * wires, and the detach itself is proven on the host in the unit suite.
 */
export async function startDaemon(fx) {
  const started = () => instanceEvents(fx).filter((e) => e.event === 'daemon-started').length;
  const before = started();
  const child = spawn(process.execPath, [OLYMPUSD, 'run', '--home', fx.home], {
    env: fx.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fx.daemon = child;
  fx.stdout = '';
  fx.stderr = '';
  child.stdout.on('data', (chunk) => {
    fx.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    fx.stderr += chunk;
  });
  await pollFor('the daemon to stamp its start', () => started() > before);
  return child;
}

/** Runs `olympusd stop` and waits for the daemon process to leave. */
export async function stopDaemon(fx) {
  if (!fx.daemon || fx.daemon.exitCode !== null) return;
  execFileSync(process.execPath, [OLYMPUSD, 'stop', '--home', fx.home], {
    env: fx.env,
    encoding: 'utf8',
  });
  await pollFor('the daemon process to exit', () => fx.daemon.exitCode !== null);
}

/**
 * Ends the daemon the way a crash ends it: no control command, no signal it
 * handles, nothing stamped. What the run left on disk is what a restart finds.
 */
export async function crashDaemon(fx) {
  if (!fx.daemon || fx.daemon.exitCode !== null) return;
  fx.daemon.kill('SIGKILL');
  // A process a signal ended reports the signal, not an exit code: `exitCode`
  // stays null for it, so a wait on that alone would never end.
  await pollFor(
    'the daemon process to die',
    () => fx.daemon.exitCode !== null || fx.daemon.signalCode !== null,
  );
}

/** Whether a pid names a live process. */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Ends a process the fixture started indirectly, and waits for it to go. */
export async function endProcess(pid) {
  if (!alive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // It went between the question and the signal.
  }
  await pollFor(`process ${pid} to exit`, () => !alive(pid));
}

/** Rewrites the scenario file the stub seat reads before its next call. */
export function updateScenario(fx, patch) {
  const held = JSON.parse(readFileSync(fx.scenarioPath, 'utf8'));
  writeFileSync(fx.scenarioPath, JSON.stringify({ ...held, ...patch }, null, 2) + '\n');
}

/** Runs one olympusctl command and returns its stdout. */
export function ctl(fx, args) {
  return execFileSync(process.execPath, [OLYMPUSCTL, ...args, '--home', fx.home], {
    env: fx.env,
    encoding: 'utf8',
  });
}

/** Runs one olympusctl command that is expected to be refused. */
export function ctlRefused(fx, args) {
  return spawnSync(process.execPath, [OLYMPUSCTL, ...args, '--home', fx.home], {
    env: fx.env,
    encoding: 'utf8',
  });
}

export function cleanup(fx) {
  if (fx.daemon && fx.daemon.exitCode === null) fx.daemon.kill();
  // A kept fixture is how a failed scenario is read afterwards: the home holds
  // every ledger, artifact and control file the run left.
  if (process.env.OLYMPUS_E2E_KEEP) {
    console.error(`e2e fixture kept at ${fx.root}`);
    return;
  }
  try {
    rmSync(fx.root, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // A temporary directory that will not go is not a test failure.
  }
}

// -- reading the state the run leaves ---------------------------------------

export function instanceEvents(fx) {
  return readEvents(join(fx.home, 'instance.ledger.jsonl'));
}

export function escapeEvents(fx) {
  return readEvents(join(fx.home, 'escapes.ledger.jsonl'));
}

/** A run's ledger, live or archived. */
export function runEvents(fx, runId) {
  const live = join(fx.home, 'runs', runId, 'ledger.jsonl');
  return readEvents(existsSync(live) ? live : join(fx.home, 'archive', 'runs', runId, 'ledger.jsonl'));
}

/** A run's directory, live or archived. */
export function runDir(fx, runId) {
  const live = join(fx.home, 'runs', runId);
  return existsSync(live) ? live : join(fx.home, 'archive', 'runs', runId);
}

export function rejectedControlFiles(fx) {
  try {
    return readdirSync(join(fx.home, 'control', 'rejected'));
  } catch {
    return [];
  }
}

/** Every stub-seat invocation, in the order the seats were spawned. */
export function seatCalls(fx) {
  return readdirSync(fx.calls)
    .map((name) => JSON.parse(readFileSync(join(fx.calls, name), 'utf8')))
    .sort((a, b) => a.at - b.at);
}

/** Every gate command that actually spawned, in the order it ran. */
export function gateMarks(fx) {
  if (!existsSync(fx.marks)) return [];
  return readFileSync(fx.marks, 'utf8').split('\n').filter((line) => line.length > 0);
}

/** Every stub-forge invocation. */
export function forgeCalls(fx) {
  if (!existsSync(fx.callLog)) return [];
  return readFileSync(fx.callLog, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

// -- polling on state, never on the clock ------------------------------------

/**
 * Polls a file-derived condition. Every wait in this suite is bounded by an
 * attempt count and keyed on a state change (a ledger stamp, a file, a process
 * exit); no wait stands in for a detector.
 *
 * `abort` is the second half of that rule: a state that will never reach the
 * condition ends the wait at once, with what the ledgers say. Waiting out the
 * attempt count for a run that is parked on a human is a timeout standing in
 * for a diagnosis.
 */
export async function pollFor(
  label,
  check,
  { attempts = 480, intervalMs = 250, diagnose, abort } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = check();
    if (value !== undefined && value !== null && value !== false) return value;
    const stop = abort?.();
    if (stop) throw new Error(`e2e stopped waiting for ${label}: ${stop}\n${diagnose?.() ?? ''}`);
    await delay(intervalMs);
  }
  throw new Error(`e2e gave up waiting for ${label}${diagnose ? `\n${diagnose()}` : ''}`);
}

// The parks a run cannot leave without a human. A scenario that meets one is
// over: it never reaches the state it was waiting for.
const RECOVERY_PARKS = new Set(['seat-failure', 'stage-blocked', 'command-error']);

/**
 * Why a run will not reach what a scenario waits for, or null while it still
 * can: an unanswered recovery park, a refused launch, a run that closed any
 * way but shipped.
 */
export function stalled(fx, runId = null) {
  if (fx.daemon && fx.daemon.exitCode !== null) {
    return `the daemon exited (code ${fx.daemon.exitCode})`;
  }
  const rejected = instanceEvents(fx).find((e) => e.event === 'launch-rejected');
  if (rejected) return `the launch was rejected: ${rejected.reason}`;
  if (!runId) return null;
  const events = runEvents(fx, runId);
  const park = [...events].reverse().find((e) => e.event === 'park');
  if (
    park &&
    RECOVERY_PARKS.has(park.type) &&
    !events.some((e) => e.event === 'answer' && e.parkSeq === park.seq)
  ) {
    return `the run parked on ${park.type} (${park.reason ?? 'no reason'})`;
  }
  const closed = events.find((e) => e.event === 'run-closed');
  if (closed && closed.state !== 'shipped') return `the run closed ${closed.state}`;
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The tail of a run ledger, for a failure message. */
export function ledgerTail(fx, runId, n = 25) {
  const events = runId ? runEvents(fx, runId) : instanceEvents(fx);
  return events
    .slice(-n)
    .map((e) => `  ${e.seq} ${e.event} ${JSON.stringify(rest(e)).slice(0, 220)}`)
    .join('\n');
}

function rest({ seq, ts, event, ...payload }) {
  return payload;
}

/** Everything a stuck run leaves behind, for the message of a timed-out wait. */
export function diagnostics(fx, runId = null) {
  const rejected = rejectedControlFiles(fx).map((name) => {
    const path = join(fx.home, 'control', 'rejected', name);
    return `  ${name}: ${name.endsWith('.txt') ? readFileSync(path, 'utf8').trim() : ''}`;
  });
  return [
    'instance ledger:',
    ledgerTail(fx, null),
    ...(runId ? ['run ledger:', ledgerTail(fx, runId)] : []),
    ...(rejected.length > 0 ? ['rejected control files:', ...rejected] : []),
    `daemon stderr: ${fx.stderr?.slice(-1200) ?? ''}`,
  ].join('\n');
}

/** A ref in the fixture origin, for proving the merge landed. */
export function originSha(fx, ref) {
  return git(['rev-parse', ref], fx.origin).trim();
}

/** Every path a ref of the fixture origin holds. */
export function originTree(fx, ref) {
  return git(['ls-tree', '-r', '--name-only', ref], fx.origin)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// -- shared assertions -------------------------------------------------------

/**
 * The invariants both scenarios owe, whatever the lane did: no wiring failure
 * of the kinds this suite exists to catch.
 * @param {object} assert node:assert/strict
 */
export function assertNoWiringFailure(assert, fx, runId) {
  const events = runEvents(fx, runId);
  const instance = instanceEvents(fx);
  assert.deepEqual(
    events.filter((e) => e.event === 'seat-failure').map((e) => [e.seat, e.reason]),
    [],
    'a seat failed',
  );
  assert.deepEqual(
    instance.filter((e) => e.event === 'seat-failure').map((e) => [e.seat, e.reason]),
    [],
    'an instance-scoped seat failed',
  );
  const commandParks = events.filter((e) => e.event === 'park' && e.type === 'command-error');
  assert.deepEqual(commandParks, [], 'a configured command could not run');
  assert.deepEqual(
    events.filter((e) => e.event === 'liveness-violation'),
    [],
    'the run went inert',
  );
  const loud = join(fx.home, 'streams', 'loud.jsonl');
  assert.equal(
    existsSync(loud) ? readFileSync(loud, 'utf8').trim() : '',
    '',
    'the run left a loud item open',
  );
  assert.deepEqual(
    instance.filter((e) => e.event === 'launch-rejected'),
    [],
    'a launch was rejected',
  );
  assert.deepEqual(
    instance.filter((e) => e.event === 'daemon-crash-detected'),
    [],
    'an unstamped daemon exit was found',
  );
  assert.deepEqual(rejectedControlFiles(fx), [], 'the daemon rejected a console command');
  assert.ok(!fx.stderr.includes('unknown lane'), `daemon stderr names an unknown lane:\n${fx.stderr}`);
}

/**
 * Asserts that the named events appear in the ledger in this order. Other
 * events may sit between them; the sequence is the claim.
 */
export function assertMilestones(assert, events, milestones) {
  const names = events.map((e) => e.event);
  let at = 0;
  for (const milestone of milestones) {
    const found = names.indexOf(milestone, at);
    assert.ok(
      found !== -1,
      `milestone ${milestone} is missing after position ${at}\nledger: ${names.join(', ')}`,
    );
    at = found + 1;
  }
}

/** The status render, checked for the parts a console reader depends on. */
export function assertStatusRenders(assert, text) {
  assert.match(text, /^daemon running \(pid \d+\)/, `status did not render:\n${text}`);
  assert.match(text, /RUNS \(\d+ open\)/, `status has no runs section:\n${text}`);
  assert.match(
    text,
    new RegExp(`\\s${PROJECT}: (armed|paused)(, held)?, slot cap 1`),
    `status has no project line:\n${text}`,
  );
}

/**
 * The seat argv the supervisor actually spawned. Every recorded invocation
 * must carry the model, the permission flag last before the prompt, and a
 * prompt that survived the flag list.
 */
export function assertSeatArgv(assert, call) {
  const { argv } = call;
  assert.ok(argv.includes('-p'), `seat ${call.seat} lost the print flag: ${argv.join(' ')}`);
  const model = argv[argv.indexOf('--model') + 1];
  assert.match(model, /^claude-/, `seat ${call.seat} spawned without a model: ${argv.join(' ')}`);
  assert.equal(
    argv[argv.length - 2],
    '--dangerously-skip-permissions',
    `seat ${call.seat} does not carry the prompt last: ${argv.join(' ')}`,
  );
  assert.ok(
    call.prompt.includes(call.reportPath),
    `seat ${call.seat} was not told where to report`,
  );
}
