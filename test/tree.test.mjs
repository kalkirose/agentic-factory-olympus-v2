// Working-tree operations: change detection, daemon-identity commits,
// restore-from-sha (the tamper-void mechanism), the carry that composes a
// suite onto a tree that moved under it, evidence diffs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  carryPaths,
  changedFiles,
  commitAll,
  headSha,
  restorePaths,
  evidenceDiff,
  filesAt,
} from '../src/isolation/tree.mjs';
import { tempDir, removeDir, commitTree, gitSync, initOriginRepo, writeTree } from './helpers.mjs';

function repoFixture(t) {
  const root = tempDir();
  const repo = initOriginRepo(join(root, 'repo'), {
    'tests/a.test.mjs': 'base test\n',
    'src/a.mjs': 'base src\n',
  });
  t.after(() => removeDir(root));
  return repo;
}

test('changedFiles sees edits and new files; commitAll commits them', async (t) => {
  const repo = repoFixture(t);
  const before = await headSha(repo);
  assert.deepEqual(await changedFiles(repo), []);
  writeTree(repo, { 'src/a.mjs': 'edited\n', 'src/new.mjs': 'new\n' });
  const changed = await changedFiles(repo);
  assert.deepEqual(changed.sort(), ['src/a.mjs', 'src/new.mjs']);
  const sha = await commitAll(repo, 'work');
  assert.notEqual(sha, before);
  assert.deepEqual(await changedFiles(repo), []);
  // A clean tree commits nothing and returns the current head.
  assert.equal(await commitAll(repo, 'noop'), sha);
});

test('restorePaths reverts edits, deletions, and junk under the prefixes only', async (t) => {
  const repo = repoFixture(t);
  const sha = await headSha(repo);
  writeTree(repo, {
    'tests/a.test.mjs': 'tampered\n',
    'tests/junk.test.mjs': 'junk\n',
    'src/a.mjs': 'impl change\n',
  });
  rmSync(join(repo, 'tests', 'a.test.mjs'));
  writeFileSync(join(repo, 'tests', 'a.test.mjs'), 'tampered again\n');
  await restorePaths(repo, sha, ['tests']);
  const { readFileSync } = await import('node:fs');
  // The checkout may normalize line endings; the content is what matters.
  const restored = readFileSync(join(repo, 'tests', 'a.test.mjs'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(restored, 'base test\n');
  assert.ok(!existsSync(join(repo, 'tests', 'junk.test.mjs')));
  // Changes outside the prefixes stay.
  assert.equal(readFileSync(join(repo, 'src', 'a.mjs'), 'utf8'), 'impl change\n');
});

test('evidenceDiff shows the divergence, new files included', async (t) => {
  const repo = repoFixture(t);
  writeTree(repo, { 'src/wrong.mjs': 'export const f = () => 0;\n' });
  const diff = await evidenceDiff(repo);
  assert.ok(diff.includes('src/wrong.mjs'));
  assert.ok(diff.includes('() => 0'));
});

test('filesAt lists the files under the prefixes at a sha', async (t) => {
  const repo = repoFixture(t);
  const sha = await headSha(repo);
  assert.deepEqual(await filesAt(repo, sha, ['tests']), ['tests/a.test.mjs']);
});

test('carryPaths brings the suite commit\'s own files onto a tree that moved under it', async (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const repo = initOriginRepo(join(root, 'repo'), {
    'tests/kept.test.mjs': 'base kept\n',
    'tests/gone.test.mjs': 'base gone\n',
    'src/a.mjs': 'base src\n',
  });
  // The run's branch: the freeze adds a suite of its own and drops a test the
  // spec superseded. It never touches the rest of the test paths.
  gitSync(['checkout', '-b', 'run/alpha'], repo);
  rmSync(join(repo, 'tests', 'gone.test.mjs'));
  writeTree(repo, { 'tests/frozen.test.mjs': 'the frozen suite\n' });
  const suiteSha = await commitAll(repo, 'suite: freeze');
  // The default branch, meanwhile: a test path this run does not own advances,
  // another arrives, and the source beside them moves.
  gitSync(['checkout', 'main'], repo);
  const mainSha = commitTree(
    repo,
    {
      'tests/kept.test.mjs': 'main advanced this\n',
      'tests/shipped.test.mjs': 'a later story shipped this\n',
      'src/a.mjs': 'main advanced src\n',
    },
    'later stories ship',
  );
  // What a merge-born fresh pass does: reset onto the updated default branch,
  // then carry the frozen suite forward.
  gitSync(['checkout', 'run/alpha'], repo);
  gitSync(['reset', '--hard', mainSha], repo);
  await carryPaths(repo, suiteSha, ['tests']);
  const { readFileSync } = await import('node:fs');
  const content = (file) => readFileSync(join(repo, file), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(content('tests/frozen.test.mjs'), 'the frozen suite\n');
  assert.ok(!existsSync(join(repo, 'tests', 'gone.test.mjs')));
  // The half a restore gets wrong: the branch's own test paths stay where the
  // branch left them, beside the source they were shipped with.
  assert.equal(content('tests/kept.test.mjs'), 'main advanced this\n');
  assert.equal(content('tests/shipped.test.mjs'), 'a later story shipped this\n');
  assert.equal(content('src/a.mjs'), 'main advanced src\n');
  // The same paths restored from the same commit is the reverting shape: a
  // test the branch advanced goes back to the tree the run launched on.
  await restorePaths(repo, suiteSha, ['tests']);
  assert.equal(content('tests/kept.test.mjs'), 'base kept\n');
});

test('carryPaths leaves the freeze exclusions alone', async (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const repo = initOriginRepo(join(root, 'repo'), { 'tests/a.test.mjs': 'base a\n' });
  gitSync(['checkout', '-b', 'run/alpha'], repo);
  writeTree(repo, { 'tests/harness.mjs': 'the freeze wrote this\n' });
  const suiteSha = await commitAll(repo, 'suite: freeze');
  gitSync(['checkout', 'main'], repo);
  const mainSha = commitTree(repo, { 'tests/a.test.mjs': 'main advanced this\n' }, 'main moves');
  gitSync(['checkout', 'run/alpha'], repo);
  gitSync(['reset', '--hard', mainSha], repo);
  await carryPaths(repo, suiteSha, ['tests'], { except: ['tests/harness.mjs'] });
  // An exclusion is the dev seat's file: the carry does not hand it the
  // freeze's version any more than a restore does.
  assert.ok(!existsSync(join(repo, 'tests', 'harness.mjs')));
});

function globRepoFixture(t) {
  const root = tempDir();
  const repo = initOriginRepo(join(root, 'repo'), {
    'src/a.test.mjs': 'base a\n',
    'src/deep/b.test.mjs': 'base b\n',
    'src/code.mjs': 'base code\n',
    'tests/c.test.mjs': 'base c\n',
  });
  t.after(() => removeDir(root));
  return repo;
}

test('restorePaths leaves the freeze exclusions alone, and covers them without them', async (t) => {
  const repo = repoFixture(t);
  writeTree(repo, { 'tests/harness.mjs': 'base harness\n' });
  const sha = await commitAll(repo, 'harness');
  writeTree(repo, {
    'tests/a.test.mjs': 'tampered\n',
    'tests/harness.mjs': 'dev edit\n',
    // A new directory the dev pass made for its own file, and junk beside it.
    'tests/support/fixtures.mjs': 'a file the dev pass created\n',
    'tests/support/junk.mjs': 'junk\n',
    'tests/junk.test.mjs': 'junk\n',
  });
  const { readFileSync } = await import('node:fs');
  const content = (file) => readFileSync(join(repo, file), 'utf8').replace(/\r\n/g, '\n');
  await restorePaths(repo, sha, ['tests'], {
    except: ['tests/harness.mjs', 'tests/support/fixtures.mjs'],
  });
  // The frozen suite reverts; the exempt files keep their edits, and an exempt
  // file that is not at the sha at all survives the clean — even inside a
  // directory the pass created.
  assert.equal(content('tests/a.test.mjs'), 'base test\n');
  assert.ok(!existsSync(join(repo, 'tests', 'junk.test.mjs')));
  assert.ok(!existsSync(join(repo, 'tests', 'support', 'junk.mjs')));
  assert.equal(content('tests/harness.mjs'), 'dev edit\n');
  assert.equal(content('tests/support/fixtures.mjs'), 'a file the dev pass created\n');
  // The same restore without the exemption — the adversary's restore — covers
  // the whole set: the edit reverts and the new file goes.
  await restorePaths(repo, sha, ['tests']);
  assert.equal(content('tests/harness.mjs'), 'base harness\n');
  assert.ok(!existsSync(join(repo, 'tests', 'support', 'fixtures.mjs')));
});

test('restorePaths holds a bracketed exclusion to the one file it names', async (t) => {
  const root = tempDir();
  const repo = initOriginRepo(join(root, 'repo'), {
    'tests/routes/(shop)/[step]/page.test.mjs': 'base step\n',
    'tests/routes/(shop)/s/page.test.mjs': 'base s\n',
  });
  t.after(() => removeDir(root));
  const sha = await headSha(repo);
  writeTree(repo, {
    'tests/routes/(shop)/[step]/page.test.mjs': 'dev edit\n',
    'tests/routes/(shop)/[step]/junk.mjs': 'junk\n',
    'tests/routes/(shop)/s/page.test.mjs': 'tampered\n',
  });
  await restorePaths(repo, sha, ['tests'], {
    except: ['tests/routes/(shop)/[step]/page.test.mjs'],
  });
  const { readFileSync } = await import('node:fs');
  const content = (file) => readFileSync(join(repo, file), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(content('tests/routes/(shop)/[step]/page.test.mjs'), 'dev edit\n');
  // A bare pathspec is wildmatched too, so `[step]` would have spared the `s`
  // directory beside it and the suite restore would have stopped covering it.
  assert.equal(content('tests/routes/(shop)/s/page.test.mjs'), 'base s\n');
  assert.ok(!existsSync(join(repo, 'tests', 'routes', '(shop)', '[step]', 'junk.mjs')));
});

test('restorePaths takes glob entries: matching files revert, the rest stays', async (t) => {
  const repo = globRepoFixture(t);
  const sha = await headSha(repo);
  writeTree(repo, {
    'src/a.test.mjs': 'tampered\n',
    'src/deep/b.test.mjs': 'tampered\n',
    'src/code.mjs': 'impl change\n',
    'src/junk.test.mjs': 'junk\n',
    'src/junk.mjs': 'junk\n',
  });
  await restorePaths(repo, sha, ['src/**/*.test.mjs']);
  const { readFileSync } = await import('node:fs');
  const content = (file) => readFileSync(join(repo, file), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(content('src/a.test.mjs'), 'base a\n');
  assert.equal(content('src/deep/b.test.mjs'), 'base b\n');
  assert.ok(!existsSync(join(repo, 'src', 'junk.test.mjs')));
  // Files outside the glob keep their changes.
  assert.equal(content('src/code.mjs'), 'impl change\n');
  assert.equal(content('src/junk.mjs'), 'junk\n');
});

test('filesAt takes glob entries and mixed entry sets', async (t) => {
  const repo = globRepoFixture(t);
  const sha = await headSha(repo);
  assert.deepEqual(await filesAt(repo, sha, ['src/**/*.test.mjs']), [
    'src/a.test.mjs',
    'src/deep/b.test.mjs',
  ]);
  assert.deepEqual(await filesAt(repo, sha, ['tests', 'src/**/*.test.mjs']), [
    'src/a.test.mjs',
    'src/deep/b.test.mjs',
    'tests/c.test.mjs',
  ]);
});
