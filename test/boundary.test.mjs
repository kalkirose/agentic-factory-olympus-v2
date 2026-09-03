// The test-edit boundary at the tool level: deny rules from the project's
// test paths, carried into the claude argv as disallowed tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testEditDenyRules } from '../src/seats/boundary.mjs';
import { claudeSeatCommand } from '../src/seats/claude.mjs';
import { seatDef } from '../src/seats/seatmap.mjs';
import { tempDir, removeDir, writeTree } from './helpers.mjs';

test('deny rules cover every edit tool per test path', () => {
  const rules = testEditDenyRules(['tests', 'e2e/']);
  assert.deepEqual(rules, [
    'Edit(tests/**)',
    'Write(tests/**)',
    'NotebookEdit(tests/**)',
    'Edit(e2e/**)',
    'Write(e2e/**)',
    'NotebookEdit(e2e/**)',
  ]);
  assert.deepEqual(testEditDenyRules([]), []);
  assert.deepEqual(testEditDenyRules(undefined), []);
});

test('a glob entry passes through unsuffixed; a prefix keeps its suffix', () => {
  const rules = testEditDenyRules(['tests/', 'src/**/*.test.ts', '**/*.spec.ts']);
  assert.deepEqual(rules, [
    'Edit(tests/**)',
    'Write(tests/**)',
    'NotebookEdit(tests/**)',
    'Edit(src/**/*.test.ts)',
    'Write(src/**/*.test.ts)',
    'NotebookEdit(src/**/*.test.ts)',
    'Edit(**/*.spec.ts)',
    'Write(**/*.spec.ts)',
    'NotebookEdit(**/*.spec.ts)',
  ]);
});

test('a freeze exclusion narrows the rules to everything but that file', (t) => {
  const root = tempDir('olympus-boundary-');
  t.after(() => removeDir(root));
  writeTree(root, {
    'tests/a.test.mjs': 'a\n',
    'tests/b.test.mjs': 'b\n',
    'tests/unit/c.test.mjs': 'c\n',
    'tests/support/harness.mjs': 'h\n',
    'tests/support/util.mjs': 'u\n',
  });
  const rules = testEditDenyRules(['tests'], {
    except: ['tests/support/harness.mjs'],
    worktree: root,
  });
  const edits = rules.filter((r) => r.startsWith('Edit('));
  assert.deepEqual(edits, [
    'Edit(tests/a.test.mjs)',
    'Edit(tests/b.test.mjs)',
    // Only the directory holding the exemption is walked; the rest collapses.
    'Edit(tests/support/util.mjs)',
    'Edit(tests/unit/**)',
  ]);
  assert.ok(rules.includes('Write(tests/support/util.mjs)'));
  assert.ok(!rules.some((r) => r.includes('harness.mjs')));
  // Without the tree there is nothing to walk, so the boundary stays whole.
  assert.deepEqual(testEditDenyRules(['tests'], { except: ['tests/support/harness.mjs'] }), [
    'Edit(tests/**)',
    'Write(tests/**)',
    'NotebookEdit(tests/**)',
  ]);
  // An exemption under no test path changes nothing.
  assert.deepEqual(testEditDenyRules(['tests'], { except: ['src/feature.mjs'], worktree: root }), [
    'Edit(tests/**)',
    'Write(tests/**)',
    'NotebookEdit(tests/**)',
  ]);
});

test('a bracketed exclusion is narrowed by its path, not by what it would match', (t) => {
  const root = tempDir('olympus-boundary-');
  t.after(() => removeDir(root));
  writeTree(root, {
    'tests/plain.test.mjs': 'p\n',
    'tests/routes/(shop)/[step]/page.test.mjs': 'a\n',
    'tests/routes/(shop)/s/page.test.mjs': 'b\n',
    'tests/routes/other/x.test.mjs': 'c\n',
  });
  const rules = testEditDenyRules(['tests'], {
    except: ['tests/routes/(shop)/[step]/page.test.mjs'],
    worktree: root,
  });
  const edits = rules.filter((r) => r.startsWith('Edit('));
  // Only the exempt file leaves the boundary. Its sibling `s` — the directory
  // a character-class reading of `[step]` would have covered — stays denied.
  assert.deepEqual(edits, [
    'Edit(tests/plain.test.mjs)',
    'Edit(tests/routes/(shop)/s/**)',
    'Edit(tests/routes/other/**)',
  ]);
  assert.ok(!rules.some((r) => r.includes('[step]')));
});

test('denyTools ride the claude argv as disallowed tools', () => {
  const def = seatDef('adversary');
  const { args } = claudeSeatCommand({
    prompt: 'P',
    model: 'claude-fable-5-1',
    effort: 'high',
    def,
    denyTools: testEditDenyRules(['tests']),
  });
  const at = args.indexOf('--disallowedTools');
  assert.notEqual(at, -1);
  // The value list runs to the flag that closes it; the prompt is last.
  const disallowed = args.slice(at + 1, args.indexOf('--dangerously-skip-permissions'));
  assert.ok(disallowed.includes('Edit(tests/**)'));
  assert.ok(disallowed.includes('Write(tests/**)'));
  assert.ok(disallowed.includes('NotebookEdit(tests/**)'));
  // The adversary seat has no web tools and no subagents.
  assert.ok(disallowed.includes('WebSearch'));
  assert.ok(disallowed.includes('Task'));
});
