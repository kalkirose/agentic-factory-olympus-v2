// The machine's credential store: what each kind reads, what a read records,
// and what a start and a status page make of it. The class under test is a
// credential the harness holds that differs from the credential the machine
// stores, silently (ADR-0064).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { homePaths, scaffoldHome } from '../src/daemon/home.mjs';
import { ensureBareClone } from '../src/isolation/clones.mjs';
import {
  WINDOWS_USER_ENV_KEY,
  credentialEnv,
  declaredNames,
  declaredStore,
  fingerprint,
  lastFingerprints,
  parseEnvFile,
  parseRegValue,
  readCredentials,
} from '../src/daemon/credentials.mjs';
import { validateInstanceConfig } from '../src/config/instance.mjs';
import { credentialStoreState, renderStatus } from '../src/console/status.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { initOriginRepo, projectConfigJson, removeDir, tempDir } from './helpers.mjs';

const WINDOWS_ONLY = process.platform === 'win32' ? false : 'runs on Windows only';

// A value with the three shapes a naive parser loses: an inner space, an equals
// sign, and a trailing space.
const AWKWARD = 'sk live=1 two words ';

function envFileStore(t, table) {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const path = join(dir, 'creds.env');
  writeFileSync(
    path,
    Object.entries(table)
      .map(([name, value]) => `${name}="${value}"`)
      .join('\n') + '\n',
  );
  return { kind: 'env-file', path };
}

// -- the fingerprint ---------------------------------------------------------

test('a fingerprint names a value without revealing it', () => {
  const mark = fingerprint(AWKWARD);
  assert.match(mark, /^[0-9a-f]{12}$/);
  assert.equal(fingerprint(AWKWARD), mark);
  assert.notEqual(fingerprint(AWKWARD + 'x'), mark);
  // Not the value, not a part of it, and not its length.
  assert.ok(!AWKWARD.includes(mark));
  assert.ok(!mark.includes(String(AWKWARD.length)));
  // Nothing to fingerprint reads as nothing, never as an empty value.
  assert.equal(fingerprint(''), null);
  assert.equal(fingerprint(undefined), null);
});

// -- the env-file kind -------------------------------------------------------

test('the env-file store answers with the bytes the file holds', (t) => {
  const store = envFileStore(t, { PAY_KEY: AWKWARD, OTHER_KEY: 'plain' });
  const { values, records } = readCredentials(store, ['PAY_KEY'], { inherited: {} });
  assert.deepEqual(values, { PAY_KEY: AWKWARD });
  assert.deepEqual(records, [
    { name: 'PAY_KEY', source: 'store', fingerprint: fingerprint(AWKWARD) },
  ]);
  // Exactly the declared names: nothing else in the file is read out.
  assert.equal(values.OTHER_KEY, undefined);
});

test('an env file reads comments, blank lines and export prefixes', () => {
  const table = parseEnvFile(
    ['# a comment', '', 'export PAY_KEY=one', 'BARE = two ', "QUOTED='  three  '", 'novalue'].join(
      '\n',
    ),
  );
  assert.equal(table.PAY_KEY, 'one');
  // An unquoted value is trimmed; a quoted one keeps every byte inside.
  assert.equal(table.BARE, 'two');
  assert.equal(table.QUOTED, '  three  ');
  assert.equal(table.novalue, undefined);
});

test('a declared name the store does not hold falls back to the inherited copy', (t) => {
  const store = envFileStore(t, { PAY_KEY: 'from-the-store' });
  const { values, records } = readCredentials(store, ['PAY_KEY', 'OLD_KEY', 'GONE_KEY'], {
    inherited: { OLD_KEY: 'from-the-window' },
  });
  assert.deepEqual(values, { PAY_KEY: 'from-the-store' });
  assert.deepEqual(
    records.map((r) => [r.name, r.source]),
    [
      ['PAY_KEY', 'store'],
      ['OLD_KEY', 'inherited'],
      ['GONE_KEY', 'absent'],
    ],
  );
  // The fallback is fingerprinted too; a name nothing holds has no fingerprint.
  assert.equal(records[1].fingerprint, fingerprint('from-the-window'));
  assert.equal(records[2].fingerprint, undefined);
});

test('the store beats the copy the daemon inherited, freshest last', (t) => {
  const store = envFileStore(t, { PAY_KEY: 'the-new-one' });
  const { values } = readCredentials(store, ['PAY_KEY'], {
    inherited: { PAY_KEY: 'the-stale-one' },
  });
  assert.equal(values.PAY_KEY, 'the-new-one');
});

test('a home that declares no store reads nothing and records nothing', (t) => {
  const home = tempDir();
  t.after(() => removeDir(home));
  const paths = scaffoldHome(home);
  assert.equal(declaredStore(paths), null);
  assert.deepEqual(credentialEnv(paths, ['PAY_KEY']), {});
  assert.deepEqual(readCredentials(null, ['PAY_KEY']), { values: {}, records: [] });
});

test('a store the daemon home declares is read from the file, live', (t) => {
  const home = tempDir();
  t.after(() => removeDir(home));
  const paths = scaffoldHome(home);
  const store = envFileStore(t, { PAY_KEY: 'first' });
  writeFileSync(paths.instanceConfig, JSON.stringify({ version: 1, credentialStore: store }));
  assert.deepEqual(credentialEnv(paths, ['PAY_KEY']), { PAY_KEY: 'first' });
  // A value replaced while the process runs is the value the next read gets:
  // nothing here is cached for the life of the daemon.
  writeFileSync(store.path, 'PAY_KEY=second\n');
  assert.deepEqual(credentialEnv(paths, ['PAY_KEY']), { PAY_KEY: 'second' });
});

// -- the windows-user-env kind ----------------------------------------------

test(
  'the windows stored environment round-trips a value through reg.exe',
  { skip: WINDOWS_ONLY },
  (t) => {
    const name = `OLYMPUS_TEST_CRED_${process.pid}`;
    const written = spawnSync(
      'reg.exe',
      ['add', WINDOWS_USER_ENV_KEY, '/v', name, '/t', 'REG_SZ', '/d', AWKWARD, '/f'],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(written.status, 0, written.stderr);
    t.after(() =>
      spawnSync('reg.exe', ['delete', WINDOWS_USER_ENV_KEY, '/v', name, '/f'], {
        windowsHide: true,
      }),
    );
    const { values, records } = readCredentials({ kind: 'windows-user-env' }, [name], {
      inherited: {},
    });
    assert.equal(values[name], AWKWARD);
    assert.equal(records[0].source, 'store');
    assert.equal(records[0].fingerprint, fingerprint(AWKWARD));
  },
);

test(
  'a stored value the registry marks expandable is expanded',
  { skip: WINDOWS_ONLY },
  (t) => {
    const name = `OLYMPUS_TEST_EXPAND_${process.pid}`;
    const written = spawnSync(
      'reg.exe',
      ['add', WINDOWS_USER_ENV_KEY, '/v', name, '/t', 'REG_EXPAND_SZ', '/d', '%OLYMPUS_TEST_ROOT%\\k', '/f'],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(written.status, 0, written.stderr);
    t.after(() =>
      spawnSync('reg.exe', ['delete', WINDOWS_USER_ENV_KEY, '/v', name, '/f'], {
        windowsHide: true,
      }),
    );
    const { values } = readCredentials({ kind: 'windows-user-env' }, [name], {
      inherited: { OLYMPUS_TEST_ROOT: 'C:\\root' },
    });
    assert.equal(values[name], 'C:\\root\\k');
  },
);

test(
  'a name the stored environment does not hold reads as no value',
  { skip: WINDOWS_ONLY },
  () => {
    const { values, records } = readCredentials(
      { kind: 'windows-user-env' },
      [`OLYMPUS_TEST_ABSENT_${process.pid}`],
      { inherited: {} },
    );
    assert.deepEqual(values, {});
    assert.equal(records[0].source, 'absent');
  },
);

test('the reg.exe value field is read to the end of its line', () => {
  const answer = ['', 'HKEY_CURRENT_USER\\Environment', `    PAY_KEY    REG_SZ    ${AWKWARD}`, ''].join(
    '\r\n',
  );
  assert.equal(parseRegValue(answer, 'PAY_KEY'), AWKWARD);
  // A name that is the start of a longer one is not this value.
  assert.equal(parseRegValue(answer, 'PAY'), null);
  // A type this store cannot hand a process is no value at all.
  assert.equal(parseRegValue('    PAY_KEY    REG_DWORD    0x1', 'PAY_KEY'), null);
});

// -- the declaration ---------------------------------------------------------

test('exactly the variables the project declares are read', () => {
  const config = {
    credentials: [
      { name: 'payments', env: 'PAY_KEY' },
      { name: 'forge', env: 'FORGE_TOKEN' },
      { name: 'payments-webhook', env: 'PAY_KEY' },
    ],
  };
  assert.deepEqual(declaredNames(config), ['PAY_KEY', 'FORGE_TOKEN']);
  assert.deepEqual(declaredNames({}), []);
});

test('the instance config refuses a store it could not read', () => {
  const at = (store) =>
    validateInstanceConfig({ version: 1, credentialStore: store }).map((e) => e.path);
  const absolute = process.platform === 'win32' ? 'C:\\creds.env' : '/creds.env';
  assert.deepEqual(at({ kind: 'windows-user-env' }), []);
  assert.deepEqual(at({ kind: 'env-file', path: absolute }), []);
  assert.deepEqual(at({ kind: 'registry' }), ['credentialStore.kind']);
  assert.deepEqual(at({ kind: 'env-file' }), ['credentialStore.path']);
  assert.deepEqual(at({ kind: 'env-file', path: 'creds.env' }), ['credentialStore.path']);
  assert.deepEqual(at({ kind: 'windows-user-env', path: '/x' }), ['credentialStore.path']);
  assert.deepEqual(at('windows-user-env'), ['credentialStore']);
});

// -- the record --------------------------------------------------------------

test('the last fingerprint of a name is folded from the instance ledger', () => {
  const held = lastFingerprints([
    { event: 'daemon-started' },
    { event: 'credential-fingerprints', variables: [{ name: 'A', source: 'store', fingerprint: 'aaa' }, { name: 'B', source: 'absent' }] },
    { event: 'credential-rotated', name: 'A', from: 'aaa', to: 'bbb' },
  ]);
  assert.equal(held.get('A'), 'bbb');
  assert.equal(held.get('B'), null);
  assert.equal(held.has('C'), false);
});

test('a start records where each declared credential came from', async (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const origin = initOriginRepo(join(root, 'origin'), {
    '.olympus/project.json': projectConfigJson({
      repo: { testPaths: ['tests'] },
      commands: { suite: ['node', '--test'], probe: ['node', '-e', 'process.exit(0)'] },
      lanes: { story: { suiteCommand: 'suite' } },
      stack: null,
      credentials: [
        { name: 'payments', env: 'OLYMPUS_TEST_PAY', probe: 'probe' },
        { name: 'forge', env: 'OLYMPUS_TEST_FORGE', probe: 'probe' },
        { name: 'mail', env: 'OLYMPUS_TEST_MAIL', probe: 'probe' },
      ],
    }),
  });
  const home = join(root, 'home');
  const paths = scaffoldHome(home);
  const store = envFileStore(t, { OLYMPUS_TEST_PAY: 'live' });
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({
      version: 1,
      credentialStore: store,
      projects: { proj: { repoUrl: origin } },
    }) + '\n',
  );
  // The clone the reader reads the declaration from. A launch makes one; this
  // test makes one directly, because the declaration is all it needs.
  await ensureBareClone(paths, 'proj', origin, 'main');
  const inherited = process.env.OLYMPUS_TEST_FORGE;
  process.env.OLYMPUS_TEST_FORGE = 'from-the-window';
  t.after(() => {
    if (inherited === undefined) delete process.env.OLYMPUS_TEST_FORGE;
    else process.env.OLYMPUS_TEST_FORGE = inherited;
  });
  const daemon = new Daemon(home);
  t.after(() => daemon.stop());
  await daemon.start();
  const stamped = readEvents(paths.instanceLedger).find(
    (e) => e.event === 'credential-fingerprints',
  );
  assert.equal(stamped.project, 'proj');
  assert.equal(stamped.store, 'env-file');
  assert.deepEqual(
    stamped.variables.map((v) => [v.name, v.source]),
    [
      ['OLYMPUS_TEST_PAY', 'store'],
      ['OLYMPUS_TEST_FORGE', 'inherited'],
      ['OLYMPUS_TEST_MAIL', 'absent'],
    ],
  );
  // The fingerprint, never the value.
  assert.equal(stamped.variables[0].fingerprint, fingerprint('live'));
  assert.ok(!JSON.stringify(stamped).includes('from-the-window'));

  // And the status page says the same thing in one line.
  const state = credentialStoreState(paths);
  assert.equal(state.kind, 'env-file');
  assert.deepEqual(state.projects, [
    { project: 'proj', store: 1, inherited: 1, absent: 1 },
  ]);
  assert.match(renderStatus(paths), /credential store env-file · proj 1 stored \/ 1 inherited \/ 1 absent/);
});

test('a home that declares no store stamps nothing and prints the status it always printed', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  const paths = homePaths(home);
  assert.ok(!readEvents(paths.instanceLedger).some((e) => e.event.startsWith('credential-')));
  assert.equal(credentialStoreState(paths), null);
  assert.ok(!renderStatus(paths).includes('credential store'));
});
