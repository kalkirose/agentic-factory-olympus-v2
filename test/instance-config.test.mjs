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

test('an invalid file throws with detail', (t) => {
  const home = tempDir();
  t.after(() => removeDir(home));
  writeFileSync(join(home, 'instance.json'), '{"version": 3}');
  assert.throws(() => loadInstanceConfig(home), /version: must be 1/);
  writeFileSync(join(home, 'instance.json'), 'not json');
  assert.throws(() => loadInstanceConfig(home), /not valid JSON/);
});
