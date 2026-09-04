// The production lane graph: the composition the daemon registers, and the
// per-run forge resolution that lets one graph serve every project of an
// instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { assembleLanes, projectForge } from '../src/lanes/assemble.mjs';
import { PRE_FREEZE_STAGES } from '../src/lanes/story.mjs';
import { LANE_STAGES } from '../src/center/snapshot.mjs';
import { withDefaults } from '../src/config/instance.mjs';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome } from '../src/daemon/home.mjs';
import { tempDir, removeDir, NO_WAIT } from './helpers.mjs';

const STORY_STAGES = [
  ...PRE_FREEZE_STAGES,
  'implementation',
  'verdict',
  'update',
  'ship',
  'close-out',
];
const REPAIR_STAGES = ['fix', 'verdict', 'update', 'ship', 'close-out'];

function twoProjectConfig() {
  return withDefaults({
    version: 1,
    projects: {
      alpha: { repoUrl: 'https://github.com/acme/widgets' },
      beta: { repoUrl: 'git@github.com:globex/gadgets.git' },
    },
  });
}

/** Records the gh argv instead of spawning it. */
function recordingRunner() {
  const calls = [];
  const runner = async (argv) => {
    calls.push(argv);
    return { code: 0, output: '{}', error: null };
  };
  runner.calls = calls;
  return runner;
}

test('the assembled graph carries the story and repair lanes end to end', () => {
  const lanes = assembleLanes({ instanceConfig: () => twoProjectConfig() });
  assert.deepEqual(Object.keys(lanes).sort(), ['repair', 'story']);
  assert.deepEqual(lanes.story.stages, STORY_STAGES);
  assert.deepEqual(lanes.repair.stages, REPAIR_STAGES);
  for (const [name, lane] of Object.entries(lanes)) {
    for (const stage of lane.stages) {
      assert.equal(typeof lane.handlers[stage], 'function', `${name}/${stage} has no handler`);
    }
  }
});

test('the assembled stages match the pipeline display', () => {
  const lanes = assembleLanes({ instanceConfig: () => twoProjectConfig() });
  assert.deepEqual(lanes.story.stages, LANE_STAGES.story);
  assert.deepEqual(lanes.repair.stages, LANE_STAGES.repair);
});

test('assembly refuses to build without a config reader', () => {
  assert.throws(() => assembleLanes(), /instanceConfig reader/);
});

test('each project forges against its own repository', async () => {
  const config = twoProjectConfig();
  const alpha = recordingRunner();
  const beta = recordingRunner();
  await projectForge(config, 'alpha', { runner: alpha }).preflight('main');
  await projectForge(config, 'beta', { runner: beta }).preflight('main');
  assert.ok(alpha.calls.every((argv) => argv.join(' ').includes('acme/widgets')));
  assert.ok(beta.calls.every((argv) => argv.join(' ').includes('globex/gadgets')));
  assert.ok(alpha.calls.length > 0 && beta.calls.length > 0);
  assert.equal(alpha.calls[0][0], 'gh');
});

test('the gh argv comes from the instance config', async () => {
  const config = { ...twoProjectConfig(), ghCommand: ['gh-wrapper', '--profile', 'factory'] };
  const runner = recordingRunner();
  await projectForge(config, 'alpha', { runner }).preflight('main');
  assert.deepEqual(runner.calls[0].slice(0, 3), ['gh-wrapper', '--profile', 'factory']);
});

test('a project the instance cannot forge for names its defect', () => {
  const config = twoProjectConfig();
  assert.throws(() => projectForge(config, 'ghost'), /no instance-config entry for project: ghost/);
  assert.throws(
    () => projectForge({ projects: { local: { repoUrl: '/srv/repos/local.git' } } }, 'local'),
    /no GitHub repository/,
  );
});

test('the ship stage resolves its forge per run, from the live config', async (t) => {
  const home = tempDir();
  t.after(() => removeDir(home));
  const paths = scaffoldHome(home);
  const ctx = { project: 'gamma', runId: 'r1', paths };
  let config = twoProjectConfig();
  let reads = 0;
  const lanes = assembleLanes({
    instanceConfig: () => {
      reads++;
      return config;
    },
  });
  // The stage resolves through the run's project; an instance that holds no
  // such project fails there, before any clone read.
  await assert.rejects(
    () => lanes.story.handlers.ship(ctx),
    /no instance-config entry for project: gamma/,
  );
  assert.equal(reads, 1);
  // A config edit reaches the next resolution: nothing is bound at assembly.
  config = withDefaults({ version: 1, projects: { gamma: { repoUrl: '/srv/repos/gamma.git' } } });
  await assert.rejects(
    () => lanes.repair.handlers.ship(ctx),
    /project gamma has no GitHub repository/,
  );
  assert.equal(reads, 2);
});

test('a started daemon holds both assembled lanes', async (t) => {
  const home = tempDir();
  const paths = scaffoldHome(home);
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({
      version: 1,
      projects: { alpha: { repoUrl: 'https://github.com/acme/widgets' } },
    }) + '\n',
  );
  const lanes = assembleLanes({ instanceConfig: () => daemon.config });
  const daemon = new Daemon(home, { waitSleep: NO_WAIT, lanes });
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  assert.deepEqual([...daemon.engine.lanes.keys()].sort(), ['repair', 'story']);
  assert.deepEqual(daemon.engine.lanes.get('story').stages, STORY_STAGES);
  assert.deepEqual(daemon.engine.lanes.get('repair').stages, REPAIR_STAGES);
  // The config the lanes read is the config the start loaded.
  assert.deepEqual(daemon.config.ghCommand, ['gh']);
});
