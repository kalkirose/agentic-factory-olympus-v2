import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitArgv } from '../src/isolation/git.mjs';
import { scaffoldHome } from '../src/daemon/home.mjs';
import { ensureBareClone } from '../src/isolation/clones.mjs';
import { addRunWorktree, removeRunWorktrees, workspaceRoot } from '../src/isolation/worktrees.mjs';
import { tempDir, removeDir, initOriginRepo } from './helpers.mjs';

const ON_WINDOWS = process.platform === 'win32';
const WINDOWS_ONLY = ON_WINDOWS ? false : 'runs on Windows only';

test('off Windows git runs the argv the caller wrote, unchanged', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(gitArgv(['worktree', 'prune'], platform), ['worktree', 'prune']);
  }
});

test('on Windows every git invocation carries long-path support of its own', () => {
  assert.deepEqual(gitArgv(['worktree', 'remove', '--force', 'C:\\x'], 'win32'), [
    '-c',
    'core.longPaths=true',
    'worktree',
    'remove',
    '--force',
    'C:\\x',
  ]);
});

test('a failure names the command the caller asked for, not the one built', async (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  await assert.rejects(() => git(['rev-parse', 'no-such-ref'], { cwd: dir }), (error) => {
    assert.match(error.message, /^git rev-parse no-such-ref failed:/);
    return true;
  });
});

test('a call the caller bounded in time is killed at the bound', async (t) => {
  // `hash-object --stdin` reads standard input until it closes, and nothing
  // here ever writes to it, so the call would hang for as long as the caller
  // waited. A caller holding something another run needs states a bound, and
  // the bound is what ends the call.
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const started = Date.now();
  await assert.rejects(
    () => git(['hash-object', '--stdin'], { cwd: dir, timeout: 250 }),
    (error) => {
      assert.match(error.message, /^git hash-object --stdin failed: timed out after 250ms$/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 15_000, 'the bound did not end the call');
});

// What this asserts is the round trip, not the flag. Which git builds need
// `core.longPaths` to reach a path this long is a property of the host, and a
// host that does not need it cannot demonstrate that it works — so the test
// pins the outcome the harness depends on and leaves the cause to ADR-0016.
test(
  'a worktree past the legacy path limit is created and removed',
  { skip: WINDOWS_ONLY },
  async (t) => {
    const root = tempDir();
    t.after(() => removeDir(root));
    // The shape that overflows in practice: an ordinary run id under the
    // daemon home, and a package tree deep enough that the checked-out file
    // clears 260 characters even though the repository it came from does not.
    const deep = join(
      'apps',
      'service',
      'node_modules',
      '@scope',
      'a'.repeat(46),
      'b'.repeat(46),
      'c'.repeat(46),
      'entry.txt',
    );
    const origin = initOriginRepo(join(root, 'origin'), { [deep]: 'v1\n' });
    const paths = scaffoldHome(join(root, 'home'));
    const clone = await ensureBareClone(paths, 'alpha', origin, 'main');
    const runId = 'a-long-project-name-mf3k92x-7';
    const { path } = await addRunWorktree(clone, paths, runId, 'main');
    const file = join(path, deep);
    assert.ok(file.length > 260, `expected a path past the limit, got ${file.length}`);
    assert.ok(existsSync(file));
    await removeRunWorktrees(clone, paths, runId);
    assert.ok(!existsSync(workspaceRoot(paths, runId)));
  },
);
