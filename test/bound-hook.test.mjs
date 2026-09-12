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
