// The test-edit boundary at the tool level: deny rules from the project's
// test paths, carried into the claude argv as disallowed tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testEditDenyRules } from '../src/seats/boundary.mjs';
import { claudeSeatCommand } from '../src/seats/claude.mjs';
import { seatDef } from '../src/seats/seatmap.mjs';

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

test('denyTools ride the claude argv as disallowed tools', () => {
  const def = seatDef('adversary');
  const { args } = claudeSeatCommand({
    prompt: 'P',
    model: 'claude-opus-5',
    effort: 'xhigh',
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
