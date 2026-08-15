// The start-time seat-environment check: the runner the host must be able to
// execute, the trust the runner CLI records for the paths seats work in, and
// the long-path support a seat's own git needs in a project clone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { checkSeatEnvironment } from '../src/daemon/environment.mjs';
import { scaffoldHome } from '../src/daemon/home.mjs';
import { cloneDir } from '../src/isolation/clones.mjs';
import { tempDir, removeDir, gitSync } from './helpers.mjs';

const PROJECT = { repoUrl: 'unused', defaultBranch: 'main' };
// A name no host holds an executable for, so the runner check has one answer.
const ABSENT_RUNNER = 'olympus-fixture-runner';

/** A daemon home with a home directory of its own for the fixture files. */
function fixture(t) {
  const root = tempDir();
  t.after(() => removeDir(root));
  const paths = scaffoldHome(join(root, 'home'));
  const host = join(root, 'host');
  mkdirSync(host, { recursive: true });
  return { root, paths, host };
}

/**
 * The host environment a check reads. The daemon's own environment is the
 * base, because git runs in it; the fixture states only what it is about to
 * ask questions of.
 */
function hostEnv(host, { command = ABSENT_RUNNER, trusted, gitConfig = true } = {}) {
  const name = basename(command, extname(command));
  const env = {
    ...process.env,
    [`${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CONFIG_DIR`]: host,
  };
  if (trusted !== undefined) {
    const projects = {};
    for (const path of trusted) projects[path] = { hasTrustDialogAccepted: true };
    writeFileSync(join(host, `.${name}.json`), JSON.stringify({ projects }) + '\n');
  }
  if (!gitConfig) {
    // A git that reads no config file of its own holds the setting nowhere,
    // whatever the machine running this test carries.
    env.GIT_CONFIG_GLOBAL = join(host, 'absent.gitconfig');
    env.GIT_CONFIG_SYSTEM = join(host, 'absent.gitconfig');
    env.GIT_CONFIG_NOSYSTEM = '1';
  }
  return env;
}

/** A bare clone in the home, the way a launch leaves one. */
function clone(paths, project) {
  const dir = cloneDir(paths, project);
  gitSync(['init', '--bare', dir], paths.home);
  return dir;
}

function findings(list, check) {
  return list.filter((f) => f.check === check);
}

test('an instance with no project has no seat environment to answer for', async (t) => {
  const { paths, host } = fixture(t);
  const found = await checkSeatEnvironment({
    paths,
    config: { projects: {}, claudeCommand: [ABSENT_RUNNER] },
    platform: 'linux',
    env: hostEnv(host, { trusted: [] }),
    home: host,
  });
  assert.deepEqual(found, []);
});

test('a seat runner the host cannot execute is a blocking finding', async (t) => {
  const { paths, host } = fixture(t);
  const found = await checkSeatEnvironment({
    paths,
    config: { projects: { alpha: PROJECT }, claudeCommand: [ABSENT_RUNNER] },
    env: hostEnv(host, { trusted: [paths.home] }),
    home: host,
  });
  const runner = findings(found, 'runner-command');
  assert.equal(runner.length, 1);
  assert.equal(runner[0].severity, 'blocking');
  assert.equal(runner[0].reason, 'unresolvable');
  assert.equal(runner[0].path, ABSENT_RUNNER);
  assert.match(runner[0].gist, /every seat spawn will fail/);
});

test('a seat runner that resolves to an executable file says nothing', async (t) => {
  const { paths, host } = fixture(t);
  const found = await checkSeatEnvironment({
    paths,
    config: { projects: { alpha: PROJECT }, claudeCommand: [process.execPath, '--version'] },
    env: hostEnv(host, { command: process.execPath, trusted: [paths.home] }),
    home: host,
  });
  assert.deepEqual(findings(found, 'runner-command'), []);
});

test('a path the runner CLI holds no trust record for is a finding per path', async (t) => {
  const { paths, host } = fixture(t);
  const found = await checkSeatEnvironment({
    paths,
    config: { projects: { alpha: PROJECT }, claudeCommand: [ABSENT_RUNNER] },
    platform: 'linux',
    env: hostEnv(host, { trusted: [join(host, 'elsewhere')] }),
    home: host,
  });
  const trust = findings(found, 'runner-trust');
  assert.deepEqual(
    trust.map((f) => f.path).sort(),
    [paths.worktrees, cloneDir(paths, 'alpha')].sort(),
  );
  assert.ok(trust.every((f) => f.reason === 'untrusted' && f.severity === 'degraded'));
  assert.equal(trust.find((f) => f.project === 'alpha').path, cloneDir(paths, 'alpha'));
  assert.match(trust[0].gist, /permissions the harness configured/);
});

test('trust of a directory above the paths covers them', async (t) => {
  const { paths, host } = fixture(t);
  const found = await checkSeatEnvironment({
    paths,
    config: { projects: { alpha: PROJECT }, claudeCommand: [ABSENT_RUNNER] },
    platform: 'linux',
    env: hostEnv(host, { trusted: [paths.home] }),
    home: host,
  });
  assert.deepEqual(findings(found, 'runner-trust'), []);
});

test('a workspace the store lists without a trust decision is untrusted', async (t) => {
  const { paths, host } = fixture(t);
  const env = hostEnv(host, { trusted: [] });
  writeFileSync(
    join(host, `.${ABSENT_RUNNER}.json`),
    JSON.stringify({ projects: { [paths.home]: { history: ['x'] } } }) + '\n',
  );
  const found = await checkSeatEnvironment({
    paths,
    config: { projects: { alpha: PROJECT }, claudeCommand: [ABSENT_RUNNER] },
    platform: 'linux',
    env,
    home: host,
  });
  assert.equal(findings(found, 'runner-trust').length, 2);
});

test('a trust store this host does not hold is one finding, not one per path', async (t) => {
  const { paths, host } = fixture(t);
  const found = await checkSeatEnvironment({
    paths,
    config: { projects: { alpha: PROJECT, beta: PROJECT }, claudeCommand: [ABSENT_RUNNER] },
    platform: 'linux',
    env: hostEnv(host),
    home: host,
  });
  const trust = findings(found, 'runner-trust');
  assert.equal(trust.length, 1);
  assert.equal(trust[0].reason, 'store-unreadable');
  assert.equal(trust[0].path, join(host, `.${ABSENT_RUNNER}.json`));
});

test('a Windows clone without long-path support is a finding', async (t) => {
  const { paths, host } = fixture(t);
  const dir = clone(paths, 'alpha');
  const found = await checkSeatEnvironment({
    paths,
    config: { projects: { alpha: PROJECT }, claudeCommand: [ABSENT_RUNNER] },
    platform: 'win32',
    env: hostEnv(host, { trusted: [paths.home], gitConfig: false }),
    home: host,
  });
  const long = findings(found, 'git-long-paths');
  assert.equal(long.length, 1);
  assert.equal(long[0].reason, 'unset');
  assert.equal(long[0].severity, 'degraded');
  assert.equal(long[0].project, 'alpha');
  assert.equal(long[0].path, dir);
  assert.match(long[0].gist, /seat's own git/);
});

test('a Windows clone that holds long-path support says nothing', async (t) => {
  const { paths, host } = fixture(t);
  const dir = clone(paths, 'alpha');
  gitSync(['config', 'core.longPaths', 'true'], dir);
  const found = await checkSeatEnvironment({
    paths,
    config: { projects: { alpha: PROJECT }, claudeCommand: [ABSENT_RUNNER] },
    platform: 'win32',
    env: hostEnv(host, { trusted: [paths.home], gitConfig: false }),
    home: host,
  });
  assert.deepEqual(findings(found, 'git-long-paths'), []);
});

test('a project with no clone yet is answered for by the host', async (t) => {
  const { paths, host } = fixture(t);
  const found = await checkSeatEnvironment({
    paths,
    config: { projects: { alpha: PROJECT }, claudeCommand: [ABSENT_RUNNER] },
    platform: 'win32',
    env: hostEnv(host, { trusted: [paths.home], gitConfig: false }),
    home: host,
  });
  const long = findings(found, 'git-long-paths');
  assert.equal(long.length, 1);
  assert.equal(long[0].path, paths.home);
  assert.match(long[0].gist, /will inherit no long-path support/);
});

test('the long-path question is not asked off Windows', async (t) => {
  const { paths, host } = fixture(t);
  clone(paths, 'alpha');
  const found = await checkSeatEnvironment({
    paths,
    config: { projects: { alpha: PROJECT }, claudeCommand: [ABSENT_RUNNER] },
    platform: 'linux',
    env: hostEnv(host, { trusted: [paths.home], gitConfig: false }),
    home: host,
  });
  assert.deepEqual(findings(found, 'git-long-paths'), []);
});

test('a clean host is silent', async (t) => {
  const { paths, host } = fixture(t);
  const dir = clone(paths, 'alpha');
  gitSync(['config', 'core.longPaths', 'true'], dir);
  const found = await checkSeatEnvironment({
    paths,
    config: { projects: { alpha: PROJECT }, claudeCommand: [process.execPath] },
    env: hostEnv(host, { command: process.execPath, trusted: [paths.home] }),
    home: host,
  });
  assert.deepEqual(found, []);
});
