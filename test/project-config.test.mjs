import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProjectConfig,
  withProjectDefaults,
  parseProjectConfig,
} from '../src/config/project.mjs';

function valid() {
  return {
    version: 1,
    repo: { testPaths: ['test/'], uiPaths: ['src/ui/'] },
    commands: { lint: ['run-lint'], test: ['node', '--test'] },
    gates: {
      tier1: [
        { name: 'lint', command: 'lint' },
        { name: 'test', command: 'test', needs: ['lint'] },
      ],
    },
    conventions: ['write to the ledger'],
    lanes: { story: { suiteCommand: 'test', greenTarget: 1 } },
    stack: { composeFile: 'compose.harness.yml', env: { NODE_ENV: 'test' } },
    tripwires: [
      {
        id: 'escapes',
        metric: 'escapes-window',
        window: 10,
        breach: { op: '>', value: 0.5 },
        answer: 'restore the cut',
      },
    ],
  };
}

function errorPaths(config) {
  return validateProjectConfig(config).map((e) => e.path);
}

test('a full config validates clean', () => {
  assert.deepEqual(validateProjectConfig(valid()), []);
});

test('version must be 1', () => {
  assert.deepEqual(errorPaths({ ...valid(), version: 2 }), ['version']);
});

test('commands must be non-empty argv arrays of strings', () => {
  const config = valid();
  config.commands.empty = [];
  config.commands.notArgv = 'run-lint';
  const paths = errorPaths(config);
  assert.ok(paths.includes('commands.empty'));
  assert.ok(paths.includes('commands.notArgv'));
});

test('a gate layer must name a key in commands', () => {
  const config = valid();
  config.gates.tier1.push({ name: 'build', command: 'missing' });
  assert.deepEqual(errorPaths(config), ['gates.tier1[2].command']);
});

test('a gate prerequisite must name an earlier layer', () => {
  const config = valid();
  config.gates.tier1[0].needs = ['test']; // later layer — order violation
  assert.deepEqual(errorPaths(config), ['gates.tier1[0].needs']);
});

test('duplicate layer names and tripwire ids are refused', () => {
  const config = valid();
  config.gates.tier1.push({ name: 'lint', command: 'lint' });
  config.tripwires.push({ id: 'escapes', metric: 'other' });
  const paths = errorPaths(config);
  assert.ok(paths.includes('gates.tier1[2].name'));
  assert.ok(paths.includes('tripwires[1].id'));
});

test('a tripwire requires an id and a metric', () => {
  const config = valid();
  config.tripwires = [{ id: 'x' }];
  assert.deepEqual(errorPaths(config), ['tripwires[0].metric']);
});

test('stack: composeFile must be repo-relative, env values strings', () => {
  const absolute = valid();
  absolute.stack.composeFile = '/etc/compose.yml';
  assert.deepEqual(errorPaths(absolute), ['stack.composeFile']);
  const winAbsolute = valid();
  winAbsolute.stack.composeFile = 'C:\\compose.yml';
  assert.deepEqual(errorPaths(winAbsolute), ['stack.composeFile']);
  const badEnv = valid();
  badEnv.stack.env = { PORT: 5432 };
  assert.deepEqual(errorPaths(badEnv), ['stack.env.PORT']);
});

test('defaults fill every missing section', () => {
  const filled = withProjectDefaults({ version: 1 });
  assert.deepEqual(filled.repo, { testPaths: [], uiPaths: [] });
  assert.deepEqual(filled.commands, {});
  assert.deepEqual(filled.gates, { tier1: [] });
  assert.deepEqual(filled.conventions, []);
  assert.deepEqual(filled.lanes, {});
  assert.equal(filled.stack, null);
  assert.deepEqual(filled.tripwires, []);
});

test('parseProjectConfig names every validation error', () => {
  assert.throws(
    () => parseProjectConfig(JSON.stringify({ version: 2, commands: { x: [] } }), 'fixture'),
    /version: must be 1.*commands\.x/s,
  );
});

test('parseProjectConfig rejects broken JSON with the source named', () => {
  assert.throws(() => parseProjectConfig('{not json', 'alpha main:.olympus/project.json'), {
    message: /not valid JSON.*alpha main/,
  });
});

test('parseProjectConfig returns a defaults-filled config', () => {
  const config = parseProjectConfig(JSON.stringify({ version: 1 }), 'fixture');
  assert.equal(config.stack, null);
  assert.deepEqual(config.gates.tier1, []);
});

test('the story lane names its commands and requires test paths', () => {
  const noSuite = valid();
  delete noSuite.lanes.story.suiteCommand;
  assert.deepEqual(errorPaths(noSuite), ['lanes.story.suiteCommand']);
  const badLint = valid();
  badLint.lanes.story.lintCommand = 'nope';
  assert.deepEqual(errorPaths(badLint), ['lanes.story.lintCommand']);
  const noTests = valid();
  noTests.repo.testPaths = [];
  assert.deepEqual(errorPaths(noTests), ['repo.testPaths']);
  const okLint = valid();
  okLint.lanes.story.lintCommand = 'lint';
  assert.deepEqual(validateProjectConfig(okLint), []);
});
