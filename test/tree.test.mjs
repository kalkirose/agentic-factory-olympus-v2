// Working-tree operations: change detection, daemon-identity commits,
// restore-from-sha (the tamper-void mechanism), evidence diffs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  changedFiles,
  commitAll,
  headSha,
  restorePaths,
  evidenceDiff,
  filesAt,
} from '../src/isolation/tree.mjs';
import { tempDir, removeDir, initOriginRepo, writeTree } from './helpers.mjs';

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
