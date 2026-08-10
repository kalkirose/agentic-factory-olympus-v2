import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stackName, stackEnv, stackUp, stackDown } from '../src/isolation/stacks.mjs';
import { fakeComposeRunner } from './helpers.mjs';

const COMPOSE = ['docker', 'compose'];

test('stackName derives a compose-safe name from the run id', () => {
  assert.equal(stackName('alpha-m3k9-1'), 'oly-alpha-m3k9-1');
  assert.equal(stackName('Alpha Run#7'), 'oly-alpha-run-7');
  assert.equal(stackName('--weird'), 'oly-weird');
});

test('stackEnv carries the derivation vars and static template env', () => {
  const env = stackEnv({ runId: 'r1', worktree: '/w/r1/tree', extra: { NODE_ENV: 'test' } });
  assert.equal(env.COMPOSE_PROJECT_NAME, 'oly-r1');
  assert.equal(env.OLYMPUS_RUN_ID, 'r1');
  assert.equal(env.OLYMPUS_WORKTREE, '/w/r1/tree');
  assert.equal(env.NODE_ENV, 'test');
});

test('stackUp runs compose against the template inside the worktree', async () => {
  const runner = fakeComposeRunner();
  const name = await stackUp({
    runId: 'r1',
    worktree: '/w/r1/tree',
    composeFile: 'compose.harness.yml',
    composeCommand: COMPOSE,
    runner,
  });
  assert.equal(name, 'oly-r1');
  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0];
  assert.equal(call.cmd, 'docker');
  assert.deepEqual(call.args, [
    'compose',
    '-p',
    'oly-r1',
    '-f',
    join('/w/r1/tree', 'compose.harness.yml'),
    'up',
    '-d',
  ]);
  assert.equal(call.env.COMPOSE_PROJECT_NAME, 'oly-r1');
});

test('stackDown works from the project name alone — no compose file', async () => {
  const runner = fakeComposeRunner();
  await stackDown({ runId: 'r1', composeCommand: COMPOSE, runner });
  const call = runner.calls[0];
  assert.deepEqual(call.args, ['compose', '-p', 'oly-r1', 'down', '--volumes', '--remove-orphans']);
  assert.ok(!call.args.includes('-f'));
});

test('a missing composeCommand is refused', async () => {
  await assert.rejects(
    () => stackDown({ runId: 'r1', composeCommand: [], runner: fakeComposeRunner() }),
    /composeCommand/,
  );
});
