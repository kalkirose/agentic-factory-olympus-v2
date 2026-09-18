// The edit boundary at the tool level: deny rules from the project's test paths
// and record paths, carried into the seat's own settings file as its deny list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editDenyRules, testEditDenyRules } from '../src/seats/boundary.mjs';
import { claudeSeatCommand } from '../src/seats/claude.mjs';
import { seatDef } from '../src/seats/seatmap.mjs';
import { tempDir, removeDir, writeTree } from './helpers.mjs';

// One rule per pattern. An `Edit(path)` rule holds every built-in tool that
// edits that path, so a rule naming a second editing tool states the boundary
// again and is consulted by nothing (ADR-0095).
test('one deny rule covers each test path', () => {
  const rules = testEditDenyRules(['tests', 'e2e/']);
  assert.deepEqual(rules, ['Edit(tests/**)', 'Edit(e2e/**)']);
  assert.ok(!rules.some((r) => r.startsWith('Write(') || r.startsWith('NotebookEdit(')));
  assert.deepEqual(testEditDenyRules([]), []);
  assert.deepEqual(testEditDenyRules(undefined), []);
});

test('a glob entry passes through unsuffixed; a prefix keeps its suffix', () => {
  const rules = testEditDenyRules(['tests/', 'src/**/*.test.ts', '**/*.spec.ts']);
  assert.deepEqual(rules, ['Edit(tests/**)', 'Edit(src/**/*.test.ts)', 'Edit(**/*.spec.ts)']);
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
  assert.deepEqual(rules, edits);
  assert.ok(!rules.some((r) => r.includes('harness.mjs')));
  // Without the tree there is nothing to walk, so the boundary stays whole.
  assert.deepEqual(
    testEditDenyRules(['tests'], { except: ['tests/support/harness.mjs'] }),
    ['Edit(tests/**)'],
  );
  // An exemption under no test path changes nothing.
  assert.deepEqual(
    testEditDenyRules(['tests'], { except: ['src/feature.mjs'], worktree: root }),
    ['Edit(tests/**)'],
  );
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

// A decision record is written by a record seat and by nothing else, so the
// record paths join the frozen paths at the same boundary the test paths use.
test('the record paths are denied beside the test paths, in that order', () => {
  const rules = editDenyRules({ testPaths: ['tests'], recordPaths: ['docs/adr'] });
  assert.deepEqual(rules, ['Edit(tests/**)', 'Edit(docs/adr/**)']);
  // Either list alone, and neither list at all.
  assert.deepEqual(editDenyRules({ recordPaths: ['docs/adr'] }), ['Edit(docs/adr/**)']);
  assert.deepEqual(editDenyRules({}), []);
  assert.deepEqual(editDenyRules(), []);
  // One path in both lists is denied once.
  assert.deepEqual(
    editDenyRules({ testPaths: ['docs/adr'], recordPaths: ['docs/adr/'] }),
    ['Edit(docs/adr/**)'],
  );
});

// An exclusion names a file that is not a record. The entry it was carved out
// of already denies that file, so denying it again would state a claim on it
// the record tree does not make.
test('an exclusion entry is not a deny rule', () => {
  const rules = editDenyRules({
    recordPaths: ['docs/adr', '!docs/adr/TEMPLATE.md'],
  });
  assert.deepEqual(rules, ['Edit(docs/adr/**)']);
  assert.ok(!rules.some((r) => r.includes('!')));
  assert.ok(!rules.some((r) => r.includes('TEMPLATE')));
  // Nothing but exclusions denies nothing.
  assert.deepEqual(editDenyRules({ recordPaths: ['!docs/adr/TEMPLATE.md'] }), []);
});

// H5's sites still call the boundary with the test paths alone, and they get
// the rules they always got.
test('the old positional call is the test half of the same boundary', () => {
  assert.deepEqual(testEditDenyRules(['tests', 'e2e']), editDenyRules({ testPaths: ['tests', 'e2e'] }));
  assert.deepEqual(testEditDenyRules(['tests']), ['Edit(tests/**)']);
});

// The deny list is the size of the project's test tree, and a command line
// holds only what the harness bounds. So no caller can put a rule on argv: the
// builder emits the seat definition's own tool policy and nothing else, and the
// rules ride the settings file the runner writes (ADR-0095).
test('no caller rule reaches the command line', () => {
  const { args } = claudeSeatCommand({
    prompt: 'P',
    model: 'claude-opus-5',
    effort: 'high',
    def: seatDef('spec-gate'),
    denyTools: testEditDenyRules(['tests', 'docs/adr']),
  });
  assert.ok(!args.some((a) => a.startsWith('Edit(')));
  const at = args.indexOf('--disallowedTools');
  assert.notEqual(at, -1);
  // The value list runs to the flag that closes it; the prompt is last. What
  // stands in it is the definition's policy: this seat has no web tools and no
  // subagents.
  const disallowed = args.slice(at + 1, args.indexOf('--dangerously-skip-permissions'));
  assert.deepEqual(disallowed, ['WebSearch', 'WebFetch', 'Task']);
});

// A dev seat has web tools and a subagent budget, so its policy list is empty
// and the flag that would carry it is omitted. The settings file that carries
// the bound and the rules still rides between the flags and the prompt.
test('a seat whose policy denies nothing carries no deny flag at all', () => {
  const { args } = claudeSeatCommand({
    prompt: 'P',
    model: 'claude-opus-5',
    effort: 'high',
    def: seatDef('dev'),
    denyTools: testEditDenyRules(['tests']),
    settingsPath: '/home/runs/r1/seats/dev-1.settings.json',
  });
  assert.ok(!args.includes('--disallowedTools'));
  assert.equal(args.at(-1), 'P');
  assert.equal(args.at(-2), '--dangerously-skip-permissions');
  assert.equal(args.at(-3), '/home/runs/r1/seats/dev-1.settings.json');
  assert.equal(args.at(-4), '--settings');
});
