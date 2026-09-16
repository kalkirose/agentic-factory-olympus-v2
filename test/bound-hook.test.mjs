// The seat bound at the tool call: the hook runs as its own process, reads the
// CLI's call on stdin, and answers exit 0 with a marker or exit 2 with the
// layer and the reason. Every case here spawns the real script over a real
// repository, because the bound is computed from a live diff and a stdin
// contract, and neither survives a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitTree, gitSync, initOriginRepo, removeDir, tempDir, writeTree } from './helpers.mjs';

const HOOK = fileURLToPath(new URL('../src/seats/bound-hook.mjs', import.meta.url));

const CAP_MS = 300000;

// A spectrum with one setup layer, one frozen suite, two layers over the cap
// and a `needs` chain, so one fixture answers every clause of the bound.
const LAYERS = [
  {
    name: 'install',
    argv: ['node', 'scripts/install.mjs'],
    ground: ['**/package.json'],
    needs: [],
    setup: true,
  },
  {
    name: 'contracts-build',
    argv: ['pnpm', '--filter', 'contracts', 'build'],
    ground: ['packages/contracts/**'],
    needs: ['install'],
    setup: false,
  },
  {
    name: 'backend-unit',
    argv: ['pnpm', 'run', 'test:backend'],
    ground: ['apps/api/**'],
    needs: ['contracts-build'],
    setup: false,
  },
  {
    name: 'storefront-e2e',
    argv: ['pnpm', 'run', 'test:storefront'],
    ground: ['apps/web/**'],
    needs: ['contracts-build'],
    setup: false,
  },
  {
    name: 'slow-scan',
    argv: ['pnpm', 'run', 'scan'],
    ground: ['apps/api/**'],
    needs: [],
    setup: false,
  },
  {
    name: 'acceptance',
    argv: ['pnpm', 'run', 'acceptance'],
    ground: ['tests/acceptance/**'],
    needs: [],
    setup: false,
  },
];

// `install`, `slow-scan` and `acceptance` are over the cap, so the setup
// clause, the suite clause and the cap itself are each provable on one bound.
const ELAPSED = {
  install: 420000,
  'contracts-build': 20000,
  'backend-unit': 30000,
  'storefront-e2e': 60000,
  'slow-scan': 480000,
  acceptance: 900000,
};

const BASE_TREE = {
  'package.json': '{"name":"fixture"}\n',
  'scripts/install.mjs': 'export const install = 1;\n',
  'packages/contracts/src/index.ts': 'export const contract = 1;\n',
  'apps/api/handler.ts': 'export const handler = 1;\n',
  'apps/web/page.svelte': '<p>page</p>\n',
  'tests/acceptance/buy.test.ts': 'export const buys = 1;\n',
};

/**
 * A worktree at a base commit with the seat's work on top, and the bound file
 * the runner would have written beside it.
 */
function fixture(t, { committed = {}, uncommitted = {}, bound = {} } = {}) {
  const root = tempDir('olympus-bound-hook-');
  t.after(() => removeDir(root));
  const worktree = join(root, 'repo');
  initOriginRepo(worktree, BASE_TREE);
  const baseSha = gitSync(['rev-parse', 'HEAD'], worktree).trim();
  if (Object.keys(committed).length > 0) commitTree(worktree, committed, 'seat work');
  writeTree(worktree, uncommitted);
  const boundPath = join(root, 'bound.json');
  writeFileSync(
    boundPath,
    JSON.stringify({
      worktree,
      baseSha,
      layers: LAYERS,
      suite: 'acceptance',
      declared: ['apps/api/**'],
      elapsedMs: ELAPSED,
      capMs: CAP_MS,
      ...bound,
    }),
  );
  return { root, worktree, boundPath };
}

/** Runs the hook the way the CLI runs it: argv path, call on stdin. */
function runHook(boundPath, { command, tool = 'Bash', cwd = '' }) {
  const call = {
    session_id: 'fixture-session',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { command, description: 'a seat command' },
    tool_use_id: 'fixture-tool-use',
  };
  return spawnSync(process.execPath, boundPath === null ? [HOOK] : [HOOK, boundPath], {
    input: JSON.stringify(call),
    encoding: 'utf8',
    windowsHide: true,
  });
}

/** The REPL's own call shape: source in `code`, and no command string at all. */
function replHook(boundPath, input) {
  return spawnSync(process.execPath, [HOOK, boundPath], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'REPL', tool_input: input }),
    encoding: 'utf8',
    windowsHide: true,
  });
}

function refusals(boundPath) {
  return readFileSync(`${boundPath}.refusals.jsonl`, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** The work every case starts from: one committed edit under `apps/api`. */
const API_EDIT = { 'apps/api/handler.ts': 'export const handler = 2;\n' };

test('a layer whose ground the diff touches passes, and the marker carries the bound digest', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT });
  const result = runHook(boundPath, { command: 'pnpm run test:backend' });
  assert.equal(result.status, 0);
  const digest = createHash('sha256').update(readFileSync(boundPath)).digest('hex');
  assert.equal(result.stdout, `olympus-bound ${digest}\n`);
  assert.equal(result.stderr, '');
});

test('a layer the diff does not reach is refused, naming the layer and the reason', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT });
  const result = runHook(boundPath, { command: 'pnpm run test:storefront' });
  assert.equal(result.status, 2);
  assert.equal(
    result.stderr,
    'storefront-e2e is outside your bound: the diff does not touch its ground. The verdict runs it.\n',
  );
  assert.equal(result.stdout, '');
});

test('a setup layer passes whatever its ground and its reading say', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT });
  const result = runHook(boundPath, { command: 'node scripts/install.mjs' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^olympus-bound [0-9a-f]{64}\n$/);
});

test('the frozen suite passes whatever its ground and its reading say', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT });
  assert.equal(runHook(boundPath, { command: 'pnpm run acceptance' }).status, 0);
  // The same layer with no suite named is judged by ground and cap like any
  // other, so the pass above is the suite clause and not the ground.
  const other = fixture(t, { committed: API_EDIT, bound: { suite: null } });
  const result = runHook(other.boundPath, { command: 'pnpm run acceptance' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^acceptance is outside your bound: the diff does not touch its ground\./);
});

test('the suite is refused without a narrowing in front of it, and passes with one', (t) => {
  // A bound that says the suite is narrowed. The whole of it belongs to the
  // verdict stage, so the bare command is refused however long the layer takes
  // and however the seat spells it (ADR-0092).
  const { boundPath } = fixture(t, { committed: API_EDIT, bound: { suiteNarrowed: true } });
  const bare = runHook(boundPath, { command: 'pnpm run acceptance' });
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /^acceptance runs whole in the verdict stage alone\./);
  assert.match(bare.stderr, /OLYMPUS_FILES=/);
  // The refusal is about the form, and the ledger reads that word apart from
  // a refusal about the bound.
  const [line] = refusals(boundPath);
  assert.equal(line.narrowed, true);
  assert.equal(line.layer, 'acceptance');
  // An assignment in front of the command on the same line passes.
  for (const command of [
    'OLYMPUS_FILES=tests/acceptance/buy.test.ts pnpm run acceptance',
    'OLYMPUS_PARTS=api pnpm run acceptance',
    'cd repo && OLYMPUS_FILES=a.spec.ts pnpm run acceptance',
  ]) {
    assert.equal(runHook(boundPath, { command }).status, 0, command);
  }
  // An empty assignment narrows nothing, and a mention that is not an
  // assignment is not one either.
  for (const command of [
    'OLYMPUS_FILES= pnpm run acceptance',
    'echo OLYMPUS_FILES; pnpm run acceptance',
    'pnpm run acceptance OLYMPUS_FILES=a.spec.ts',
  ]) {
    assert.equal(runHook(boundPath, { command }).status, 2, command);
  }
});

test('a bound that does not say the suite is narrowed passes it exactly as before', (t) => {
  // The repair lane holds no suite at all, and a story bound written before the
  // word existed carries none: both keep the behaviour they had.
  const { boundPath } = fixture(t, { committed: API_EDIT });
  assert.equal(runHook(boundPath, { command: 'pnpm run acceptance' }).status, 0);
  const off = fixture(t, { committed: API_EDIT, bound: { suiteNarrowed: false } });
  assert.equal(runHook(off.boundPath, { command: 'pnpm run acceptance' }).status, 0);
});

test('a layer is matched by the project\'s own name for it, as a whole word', (t) => {
  const layers = LAYERS.map((layer) =>
    layer.name === 'acceptance'
      ? { ...layer, aliases: ['pnpm test:acceptance', 'pnpm run test:acceptance'] }
      : layer,
  );
  const { boundPath } = fixture(t, {
    committed: API_EDIT,
    bound: { layers, suiteNarrowed: true },
  });
  // The canonical spelling is refused, which is the whole point: a refusal
  // that only matched the config argv is a refusal nobody meets.
  assert.equal(runHook(boundPath, { command: 'pnpm test:acceptance' }).status, 2);
  assert.equal(runHook(boundPath, { command: 'pnpm run test:acceptance' }).status, 2);
  assert.equal(
    runHook(boundPath, { command: 'OLYMPUS_FILES=a.spec.ts pnpm test:acceptance' }).status,
    0,
  );
  // A longer script name is a different command. A word-character boundary
  // would match inside it, because a colon is not a word character.
  assert.equal(runHook(boundPath, { command: 'pnpm test:acceptance:e2e' }).status, 0);
  // Reading the file is not running the layer.
  assert.equal(runHook(boundPath, { command: 'cat scripts/test-acceptance.ts' }).status, 0);
});

test('a layer inside the bound whose reading reaches the cap is refused', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT });
  const result = runHook(boundPath, { command: 'pnpm run scan' });
  assert.equal(result.status, 2);
  assert.equal(
    result.stderr,
    `slow-scan is outside your bound: it took 480000 ms on the certified base, at or over the ${CAP_MS} ms cap. The verdict runs it.\n`,
  );
});

test('a layer with no reading has no cap to fail', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT, bound: { elapsedMs: null } });
  assert.equal(runHook(boundPath, { command: 'pnpm run scan' }).status, 0);
});

test('a PowerShell command is judged as a Bash command is', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT });
  const result = runHook(boundPath, { command: 'pnpm run test:storefront', tool: 'PowerShell' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^storefront-e2e is outside your bound:/);
});

test('a layer named inside a longer shell line, over any whitespace, is judged', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT });
  const result = runHook(boundPath, {
    command: 'cd /repo &&  pnpm   run\ttest:storefront --reporter dot > out.txt',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^storefront-e2e is outside your bound:/);
});

test('a command that names no layer passes', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT });
  const result = runHook(boundPath, { command: 'git status --short' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^olympus-bound [0-9a-f]{64}\n$/);
});

test('a bound that names no layer passes every command, and reads no tree', (t) => {
  const { boundPath } = fixture(t, {
    committed: API_EDIT,
    // A base no repository holds: nothing matches, so nothing is diffed.
    bound: { layers: [], suite: null, baseSha: 'not-a-commit' },
  });
  const result = runHook(boundPath, { command: 'pnpm run test:storefront' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^olympus-bound [0-9a-f]{64}\n$/);
});

test('a tool input that carries neither a command nor code names no layer', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT });
  const result = replHook(boundPath, { file_path: 'notes.md' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^olympus-bound [0-9a-f]{64}\n$/);
});

test('the code a REPL call runs is read like a command line', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT });
  assert.equal(replHook(boundPath, { code: '1 + 1' }).status, 0);
  const result = replHook(boundPath, { code: "execSync('pnpm run test:storefront')" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^storefront-e2e is outside your bound:/);
});

// The same invocation, spelled the three ways a seat writes it. The layer's
// argv names a script path, which is where the spellings differ.
const SUITE_ARGV = ['pnpm', 'exec', 'tsx', 'scripts/run-suite.ts', 'storefront-e2e'];

function suiteFixture(t) {
  return fixture(t, {
    committed: API_EDIT,
    bound: {
      layers: LAYERS.map((l) => (l.name === 'storefront-e2e' ? { ...l, argv: SUITE_ARGV } : l)),
    },
  });
}

test('a path separator and a quoted path do not carry a layer past the hook', (t) => {
  const { boundPath } = suiteFixture(t);
  for (const tool of ['Bash', 'PowerShell']) {
    for (const command of [
      'pnpm exec tsx scripts/run-suite.ts storefront-e2e',
      'pnpm exec tsx scripts\\run-suite.ts storefront-e2e',
      'pnpm exec tsx "scripts/run-suite.ts" storefront-e2e',
      "pnpm exec tsx 'scripts/run-suite.ts' storefront-e2e",
    ]) {
      const result = runHook(boundPath, { command, tool });
      assert.equal(result.status, 2, `${tool}: ${command}`);
      assert.match(result.stderr, /^storefront-e2e is outside your bound:/, command);
    }
  }
});

test('a prerequisite of a bound layer is in the bound', (t) => {
  // The diff reaches `backend-unit` alone. `contracts-build` is upstream of it
  // and its own ground never moved, so without the prerequisite closure the
  // seat could not build what the layer it may run reads.
  const { boundPath } = fixture(t, { committed: API_EDIT });
  const result = runHook(boundPath, { command: 'pnpm --filter contracts build' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^olympus-bound [0-9a-f]{64}\n$/);
});

// A spectrum shaped like a real project's: one layer installs the workspace,
// every other layer needs it, and none of them declares `setup`.
const NO_SETUP_LAYERS = [
  {
    name: 'lockfile',
    argv: ['node', 'scripts/install-frozen.mjs'],
    ground: ['**/package.json'],
    needs: [],
    setup: false,
  },
  {
    name: 'typecheck',
    argv: ['pnpm', 'run', 'typecheck'],
    ground: ['src/**'],
    needs: ['lockfile'],
    setup: false,
  },
  {
    name: 'acceptance',
    argv: ['pnpm', 'run', 'acceptance'],
    ground: ['tests/acceptance/**'],
    needs: ['lockfile'],
    setup: false,
  },
];

test('the install a project declares as an ordinary layer is in the bound', (t) => {
  const { boundPath } = fixture(t, {
    committed: { 'src/service.ts': 'export const service = 1;\n' },
    bound: { layers: NO_SETUP_LAYERS, elapsedMs: null },
  });
  // Nothing under the install layer's ground moved and nothing declares setup,
  // so the seat reaches it as the prerequisite of the two layers it may run.
  assert.equal(runHook(boundPath, { command: 'node scripts/install-frozen.mjs' }).status, 0);
  assert.equal(runHook(boundPath, { command: 'pnpm run typecheck' }).status, 0);
});

test('every refusal appends one line beside the bound file', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT, bound: { seat: 'dev-1' } });
  runHook(boundPath, { command: 'pnpm run test:storefront' });
  runHook(boundPath, { command: 'pnpm run scan' });
  runHook(boundPath, { command: 'pnpm run test:backend' });
  const lines = refusals(boundPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].seat, 'dev-1');
  assert.equal(lines[0].layer, 'storefront-e2e');
  assert.equal(lines[0].command, 'pnpm run test:storefront');
  assert.equal(lines[0].reason, 'the diff does not touch its ground');
  assert.match(lines[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(lines[1].layer, 'slow-scan');
  assert.match(lines[1].reason, /at or over the 300000 ms cap$/);
});

test('an uncommitted file widens the bound', (t) => {
  const { boundPath } = fixture(t, {
    committed: API_EDIT,
    uncommitted: { 'apps/web/panel.svelte': '<p>panel</p>\n' },
  });
  assert.equal(runHook(boundPath, { command: 'pnpm run test:storefront' }).status, 0);
});

test('a layer downstream of a touched layer is in the bound', (t) => {
  const { boundPath } = fixture(t, {
    committed: { 'packages/contracts/src/index.ts': 'export const contract = 2;\n' },
  });
  // `storefront-e2e` needs `contracts-build`, whose ground the diff touches.
  assert.equal(runHook(boundPath, { command: 'pnpm run test:storefront' }).status, 0);
  // Nothing under `apps/api` moved, so a layer off that chain stays outside.
  const result = runHook(boundPath, { command: 'pnpm run scan' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^slow-scan is outside your bound: the diff does not touch its ground\./);
});

test('a git command that fails refuses the call and names the cause', (t) => {
  const { boundPath } = fixture(t, {
    committed: API_EDIT,
    bound: { baseSha: '0000000000000000000000000000000000000000' },
  });
  const result = runHook(boundPath, { command: 'pnpm run test:backend' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^the seat bound cannot be computed: git diff/);
  assert.equal(refusals(boundPath)[0].layer, null);
});

test('an unreadable bound file refuses the call', (t) => {
  const { root } = fixture(t, { committed: API_EDIT });
  const missing = join(root, 'absent.json');
  const result = runHook(missing, { command: 'pnpm run test:backend' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^the seat bound cannot be computed: ENOENT/);
});

test('a bound file that names no worktree refuses the call', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT, bound: { worktree: '' } });
  const result = runHook(boundPath, { command: 'pnpm run test:backend' });
  assert.equal(result.status, 2);
  assert.equal(
    result.stderr,
    'the seat bound cannot be computed: the bound file states no worktree\n',
  );
});

test('a bound file that is not JSON refuses the call', (t) => {
  const { boundPath } = fixture(t, { committed: API_EDIT });
  writeFileSync(boundPath, 'not json at all\n');
  const result = runHook(boundPath, { command: 'pnpm run test:backend' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^the seat bound cannot be computed: /);
});

test('a hook spawned with no bound path refuses the call', (t) => {
  fixture(t, { committed: API_EDIT });
  const result = runHook(null, { command: 'pnpm run test:backend' });
  assert.equal(result.status, 2);
  assert.equal(
    result.stderr,
    'the seat bound cannot be computed: the hook was given no bound file path\n',
  );
});
