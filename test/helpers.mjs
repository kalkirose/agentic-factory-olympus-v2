import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { longPath, isRetryableRemoval } from '../src/isolation/removal.mjs';

// The ladder a fixture teardown removes under, and the path form it removes
// in. Both are the production ones (ADR-0004): a fixture tree is a checked-out
// repository with worktrees under it, and on Windows a file inside it can
// still be held when the test that made it ends — a git process a moment from
// exiting, an indexer, a scanner. The hold belongs to another process and it
// passes on its own, so a teardown that reports the first EBUSY reds a suite
// for a condition that was over a second later.
const ATTEMPTS = 10;
const DELAY_MS = 250;

export function tempDir(prefix = 'olympus-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Deletes a fixture tree, waiting out a transient hold. Synchronous, because
 * every teardown that calls it reads that way; the wait costs nothing at all
 * when nothing holds the tree.
 */
export function removeDir(dir) {
  const target = longPath(dir);
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 5 });
      return;
    } catch (error) {
      if (attempt >= ATTEMPTS || !isRetryableRemoval(error)) throw error;
      sleepSync(DELAY_MS * attempt);
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Polls `check` until it returns a truthy value. Test-only convenience. */
export async function waitFor(check, { attempts = 50, intervalMs = 100, label = 'condition' } = {}) {
  for (let i = 0; i < attempts; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out in test helper: ${label}`);
}

// -- git fixtures ------------------------------------------------------------

export function gitSync(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

export function writeTree(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Commits a file tree into a fixture repo. Returns the commit sha. */
export function commitTree(dir, files, message) {
  writeTree(dir, files);
  gitSync(['add', '-A'], dir);
  gitSync(['-c', 'commit.gpgsign=false', 'commit', '-m', message], dir);
  return gitSync(['rev-parse', 'HEAD'], dir).trim();
}

/** Creates a fixture origin repo with an initial commit on main. */
export function initOriginRepo(dir, files) {
  mkdirSync(dir, { recursive: true });
  gitSync(['init', '-b', 'main', '.'], dir);
  gitSync(['config', 'user.email', 'harness@test.invalid'], dir);
  gitSync(['config', 'user.name', 'Harness Test'], dir);
  commitTree(dir, files, 'init');
  return dir;
}

// -- story fixtures ----------------------------------------------------------

/**
 * The acceptance-criteria section the fixture intent cards carry. The
 * criterion is written the way real cards write one — a bold id at the start
 * of the line — so a parser that reads list items alone fails the lane suite.
 */
export const FIXTURE_ACCEPTANCE = `
## Acceptance criteria

**AC-1** f(x) returns 2*x for every number x.
`;

/**
 * A spec that holds the template (ADR-0019) for a fixture card with one
 * acceptance criterion: a header, one criterion section with its mapping,
 * constants and supersedes, one touched-paths block, an environment section.
 */
export const FIXTURE_SPEC = `# alpha-1 spec

Base sha: the launch base. Scope exclusions: none the card states.

## AC-1

f(x) returns twice its input. The suite asserts it on one number.

Test mapping:
- tests/feature.test.mjs — f(2) is 4

Named constants:
- FACTOR = 2

Supersedes:
- None

## Touched paths

\`\`\`touched-paths
src/feature.mjs — dev
tests/feature.test.mjs — suite
\`\`\`

## Environment

None; the card names none.
`;

/** A valid project config JSON body; override sections per test. */
export function projectConfigJson(overrides = {}) {
  return (
    JSON.stringify(
      {
        version: 1,
        commands: { test: ['node', '--test'] },
        stack: { composeFile: 'compose.harness.yml' },
        ...overrides,
      },
      null,
      2,
    ) + '\n'
  );
}

/** Records compose invocations instead of running them. */
export function fakeComposeRunner({ failOn } = {}) {
  const calls = [];
  const runner = async (cmd, args, env) => {
    calls.push({ cmd, args, env });
    if (failOn && args.includes(failOn)) throw new Error(`compose ${failOn} failed (fixture)`);
  };
  runner.calls = calls;
  return runner;
}
