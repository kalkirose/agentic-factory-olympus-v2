import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultInstanceConfig,
  validateInstanceConfig,
  withDefaults,
  loadInstanceConfig,
} from '../src/config/instance.mjs';
import { tempDir, removeDir } from './helpers.mjs';

test('the default config is valid', () => {
  assert.deepEqual(validateInstanceConfig(defaultInstanceConfig()), []);
});

test('a missing file is scaffolded with defaults', (t) => {
  const home = tempDir();
  t.after(() => removeDir(home));
  const config = loadInstanceConfig(home);
  assert.ok(existsSync(join(home, 'instance.json')));
  assert.equal(config.version, 1);
});

test('validation reports labeled paths', () => {
  const errors = validateInstanceConfig({
    version: 2,
    logLevel: 'loud',
    semaphores: { 'model-x': 0 },
    projects: { demo: { defaultBranch: 7 } },
  });
  const paths = errors.map((e) => e.path);
  assert.ok(paths.includes('version'));
  assert.ok(paths.includes('logLevel'));
  assert.ok(paths.includes('semaphores.model-x'));
  assert.ok(paths.includes('projects.demo.repoUrl'));
  assert.ok(paths.includes('projects.demo.defaultBranch'));
});

test('withDefaults fills project defaults without mutation', () => {
  const raw = { version: 1, projects: { demo: { repoUrl: 'https://example.invalid/demo.git' } } };
  const filled = withDefaults(raw);
  assert.equal(filled.projects.demo.defaultBranch, 'main');
  assert.equal(filled.projects.demo.slotCap, 1);
  assert.equal(filled.projects.demo.projectConfigPath, '.olympus/project.json');
  assert.equal(raw.projects.demo.defaultBranch, undefined);
});

test('the machine argv keys default and validate alike', () => {
  const filled = withDefaults({ version: 1 });
  assert.deepEqual(filled.composeCommand, ['docker', 'compose']);
  assert.deepEqual(filled.claudeCommand, ['claude']);
  assert.deepEqual(filled.ghCommand, ['gh']);
  const errors = validateInstanceConfig({ version: 1, ghCommand: 'gh' });
  assert.deepEqual(
    errors.map((e) => e.path),
    ['ghCommand'],
  );
  assert.deepEqual(validateInstanceConfig({ version: 1, ghCommand: ['gh', '--repo-cache'] }), []);
});

test('worktreeRoot is optional, absolute, and passes through untouched', () => {
  // Absent by default — a config that never names one keeps the home layout.
  assert.equal(defaultInstanceConfig().worktreeRoot, undefined);
  assert.equal(withDefaults({ version: 1 }).worktreeRoot, undefined);
  const root = process.platform === 'win32' ? 'D:\\oly' : '/srv/oly';
  assert.deepEqual(validateInstanceConfig({ version: 1, worktreeRoot: root }), []);
  assert.equal(withDefaults({ version: 1, worktreeRoot: root }).worktreeRoot, root);
  for (const bad of ['worktrees', './w', '', 7]) {
    assert.deepEqual(
      validateInstanceConfig({ version: 1, worktreeRoot: bad }).map((e) => e.path),
      ['worktreeRoot'],
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('secretEnv is optional and holds name patterns the matcher can honor', () => {
  // Absent by default: no configuration means no stripping anywhere.
  assert.equal(defaultInstanceConfig().secretEnv, undefined);
  assert.equal(withDefaults({ version: 1 }).secretEnv, undefined);
  const patterns = ['PAY_SECRET_*', '*_TOKEN', 'ADMIN_PASSWORD', '*'];
  assert.deepEqual(validateInstanceConfig({ version: 1, secretEnv: patterns }), []);
  assert.deepEqual(withDefaults({ version: 1, secretEnv: patterns }).secretEnv, patterns);
  assert.deepEqual(validateInstanceConfig({ version: 1, secretEnv: [] }), []);
  for (const bad of ['PAY_*', ['PAY_*', ''], [7], { PAY: true }]) {
    assert.deepEqual(
      validateInstanceConfig({ version: 1, secretEnv: bad }).map((e) => e.path),
      ['secretEnv'],
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
  // A star the matcher cannot honor is refused at load, not matched against
  // nothing: a rejected edit is loud, a silent non-match leaks.
  assert.deepEqual(
    validateInstanceConfig({ version: 1, secretEnv: ['PAY_*_KEY', '*PAY*'] }).map((e) => e.path),
    ['secretEnv.PAY_*_KEY', 'secretEnv.*PAY*'],
  );
});

test('an invalid file throws with detail', (t) => {
  const home = tempDir();
  t.after(() => removeDir(home));
  writeFileSync(join(home, 'instance.json'), '{"version": 3}');
  assert.throws(() => loadInstanceConfig(home), /version: must be 1/);
  writeFileSync(join(home, 'instance.json'), 'not json');
  assert.throws(() => loadInstanceConfig(home), /not valid JSON/);
});
