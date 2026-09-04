// The closed signature set (ADR-0069): what the harness reads as a cause
// outside the tree, what it refuses to read that way, and the declared hosts a
// signature resolves to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_SIGNATURES,
  TRANSIENT_SIGNATURES,
  credentialHostIn,
  readTransient,
  showsCode,
  showsTransient,
} from '../src/lanes/transient.mjs';
import { validateProjectConfig } from '../src/config/project.mjs';
import { openProofDebts, narrowEnv } from '../src/lanes/proofdebt.mjs';
import { PARTS_ENV, FAILED_FILES_ENV } from '../src/lanes/parts.mjs';

/** One red layer with one red part, in the shape a spectrum answers with. */
function red(output, { files = ['tests/api.test.ts'], layer = 'acceptance' } = {}) {
  return {
    layer,
    status: 'red',
    output: '',
    parts: [{ name: 'api', status: 'red', output, failedFiles: files }],
  };
}

test('every signature in the set has an id and a test, and the ids are unique', () => {
  const ids = [...TRANSIENT_SIGNATURES, ...CODE_SIGNATURES].map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const signature of [...TRANSIENT_SIGNATURES, ...CODE_SIGNATURES]) {
    assert.equal(typeof signature.test, 'function');
  }
});

test('the closed set reads the conditions the design names', () => {
  const cases = {
    ECONNRESET: 'Error: read ECONNRESET',
    ECONNREFUSED: 'connect ECONNREFUSED 127.0.0.1:9999',
    ETIMEDOUT: 'connect ETIMEDOUT',
    ENOTFOUND: 'getaddrinfo ENOTFOUND api.stripe.com',
    EAI_AGAIN: 'getaddrinfo EAI_AGAIN api.stripe.com',
    'http-429': 'GET https://api.stripe.com/v1/charges 429',
    'http-5xx': 'https://api.sanity.io/v1/data returned 503',
    'rate-limit': 'the request was rate-limited, try later',
    'image-pull': 'failed to pull image postgres:16',
    'db-startup': 'could not connect to server: Connection refused',
    'api-retry': 'API Error: max retries exceeded',
  };
  for (const [id, text] of Object.entries(cases)) {
    const signature = TRANSIENT_SIGNATURES.find((s) => s.id === id);
    assert.ok(signature, `no signature ${id}`);
    assert.ok(signature.test(text), `${id} did not read: ${text}`);
  }
});

test('a status with no host beside it is a number in somebody output, not a service', () => {
  const http429 = TRANSIENT_SIGNATURES.find((s) => s.id === 'http-429');
  assert.equal(http429.test('expected 429 to equal 200'), false);
  assert.equal(http429.test('GET https://api.stripe.com/v1 429'), true);
});

test('a red whose parts all show a signature is a cause outside the tree', () => {
  const out = readTransient([red('Error: read ECONNRESET at TLSSocket')]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.signatures, ['ECONNRESET']);
  assert.deepEqual(out.files, ['tests/api.test.ts']);
  assert.deepEqual(out.layers[0].parts, ['api']);
  assert.deepEqual(out.layers[0].byPart, { api: ['tests/api.test.ts'] });
});

test('an assertion beside the signature takes triage, and says which rule refused', () => {
  const out = readTransient([red('ECONNRESET\nAssertionError: expected 4 to equal 5')]);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'code-signature');
  assert.match(out.detail, /acceptance\/api shows assertion/);
});

test('a compile error anywhere in the layer tail refuses the read', () => {
  const layer = red('ECONNRESET');
  layer.output = 'src/x.ts(3,1): error TS2304: Cannot find name foo';
  const out = readTransient([layer]);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'code-signature');
});

test('a red that named no failed file is a red the harness cannot narrow', () => {
  assert.equal(readTransient([red('ECONNRESET', { files: [] })]).reason, 'no-failed-files');
  assert.equal(
    readTransient([{ layer: 'unit', status: 'red', output: 'ECONNRESET' }]).reason,
    'no-failed-files',
  );
});

test('a red showing nothing from the set takes triage unchanged', () => {
  const out = readTransient([red('the suite exited 1')]);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-signature');
});

test('every red must qualify: one that does not sends the whole set to triage', () => {
  const out = readTransient([red('ECONNRESET'), red('nothing recognisable', { layer: 'lint' })]);
  assert.equal(out.ok, false);
});

test('a project adds its own wording, and it is counted under its own id', () => {
  const text = 'sandbox is warming up, please retry';
  assert.equal(readTransient([red(text)]).ok, false);
  const out = readTransient([red(text)], { patterns: ['sandbox is warming up'] });
  assert.equal(out.ok, true);
  assert.deepEqual(out.signatures, ['project:sandbox is warming up']);
  assert.equal(showsTransient(text, ['sandbox is warming up']), true);
  assert.equal(showsTransient(text), false);
  assert.equal(showsCode('AssertionError: nope'), true);
});

test('a signature host resolves to the credential whose host it ends with', () => {
  const credentials = [
    { name: 'sanity', hosts: ['api.sanity.io'] },
    { name: 'stripe', hosts: ['api.stripe.com', 'js.stripe.com'] },
  ];
  assert.equal(
    credentialHostIn('getaddrinfo EAI_AGAIN proj.api.sanity.io', credentials).credential.name,
    'sanity',
  );
  assert.equal(credentialHostIn('read ECONNRESET js.stripe.com', credentials).host, 'js.stripe.com');
  // A host nobody declared resolves to nothing, and a project that declares
  // none gets no external wait at all.
  assert.equal(credentialHostIn('ENOTFOUND api.example.com', credentials), null);
  assert.equal(credentialHostIn('ENOTFOUND api.sanity.io', []), null);
  // The suffix rule is on a label boundary: `notsanity.io` is not `sanity.io`.
  assert.equal(credentialHostIn('ENOTFOUND xapi.sanity.io.evil.test', credentials), null);
});

// -- the config keys ---------------------------------------------------------

function config(overrides = {}) {
  return {
    version: 1,
    repo: { defaultBranch: 'main', testPaths: ['tests'] },
    commands: { unit: ['node', '--test'], probe: ['node', '-e', 'x'] },
    gates: { tier1: [{ name: 'unit', command: 'unit' }] },
    lanes: { story: { suiteCommand: 'unit' } },
    ...overrides,
  };
}

/** The validator's own findings, as `path: message` lines. */
function errorsOf(overrides) {
  return validateProjectConfig(config(overrides)).map((e) => `${e.path}: ${e.message}`);
}

test('a credential host list is hostnames, and a URL is refused', () => {
  assert.deepEqual(
    errorsOf({
      credentials: [{ name: 'sanity', env: 'SANITY_TOKEN', probe: 'probe', hosts: ['api.sanity.io'] }],
    }).filter((line) => line.includes('hosts')),
    [],
  );
  const bad = errorsOf({
    credentials: [
      { name: 'sanity', env: 'SANITY_TOKEN', probe: 'probe', hosts: ['https://api.sanity.io/v1'] },
    ],
  });
  assert.ok(bad.some((line) => /credentials\[0\]\.hosts\[0\]/.test(line)));
  const empty = errorsOf({
    credentials: [{ name: 'sanity', env: 'SANITY_TOKEN', probe: 'probe', hosts: [] }],
  });
  assert.ok(empty.some((line) => /non-empty array of hostnames/.test(line)));
});

test('a transient pattern that will not compile is refused at the door', () => {
  assert.deepEqual(errorsOf({ gates: { ...config().gates, transientPatterns: ['sandbox \\d+'] } }), []);
  const bad = errorsOf({ gates: { ...config().gates, transientPatterns: ['('] } });
  assert.ok(bad.some((line) => /transientPatterns\[0\]/.test(line)));
});

test('the proof-debt flag is a boolean, and absent is off', () => {
  assert.deepEqual(errorsOf({ gates: { ...config().gates, proofDebt: true } }), []);
  const bad = errorsOf({ gates: { ...config().gates, proofDebt: 'yes' } });
  assert.ok(bad.some((line) => /gates\.proofDebt/.test(line)));
});

// -- the debt the settle run pays back ---------------------------------------

test('a deferred proof asks for its own parts and their own files', () => {
  const env = narrowEnv(
    { layer: 'acceptance', parts: ['api', 'web'], byPart: { api: ['tests/a.ts'], web: [] } },
    { partsEnv: PARTS_ENV, filesEnv: FAILED_FILES_ENV },
  );
  assert.equal(env[PARTS_ENV], 'api,web');
  // A part that named no file runs whole, so it names none here either.
  assert.equal(env[FAILED_FILES_ENV], 'api=tests/a.ts');
  assert.deepEqual(narrowEnv({ parts: [] }, { partsEnv: PARTS_ENV, filesEnv: FAILED_FILES_ENV }), {});
});

test('an open debt is a deferred proof with no settlement behind it', async (t) => {
  const { scaffoldHome, runLedgerPath } = await import('../src/daemon/home.mjs');
  const { openRunStore, openInstanceStore } = await import('../src/telemetry/stores.mjs');
  const { tempDir, removeDir } = await import('./helpers.mjs');
  const home = tempDir();
  const paths = scaffoldHome(home);
  const instance = openInstanceStore(paths);
  const run = openRunStore(paths, 'r1');
  t.after(() => {
    run.close();
    instance.close();
    removeDir(home);
  });
  run.append('run-launched', { actor: 'daemon', project: 'proj', lane: 'story' });
  const deferred = run.append('proof-deferred', {
    actor: 'operator',
    cycle: 1,
    credential: 'sanity',
    parts: [{ layer: 'acceptance', parts: ['api'], files: ['tests/a.ts'] }],
  });
  run.append('merged', { actor: 'daemon', pr: 12, sha: 'abc' });
  const open = openProofDebts(paths);
  assert.equal(open.length, 1);
  assert.equal(open[0].credential, 'sanity');
  assert.equal(open[0].pr, 12);
  assert.equal(open[0].runId, 'r1');
  instance.append('proof-settled', {
    actor: 'proof-debt',
    project: 'proj',
    runId: 'r1',
    deferredSeq: deferred.seq,
    credential: 'sanity',
    ok: true,
  });
  assert.deepEqual(openProofDebts(paths), []);
  assert.ok(runLedgerPath(paths, 'r1'));
});
