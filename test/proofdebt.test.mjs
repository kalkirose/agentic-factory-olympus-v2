// The settle run (ADR-0069): the proof a ship went out without, paid back.
// The watcher asks the service, runs exactly the deferred parts against the
// default branch, and records what came of it — a `proof-settled` either way,
// and a `deferred-proof` escape against the ship when the proof does not hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { openInstanceStore, openRunStore } from '../src/telemetry/stores.mjs';
import { readEscapeSet } from '../src/telemetry/escapes.mjs';
import { ProofDebtWatcher, openProofDebts } from '../src/lanes/proofdebt.mjs';
import {
  tempDir,
  removeDir,
  initOriginRepo,
  projectConfigJson,
  NO_WAIT,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';

/** A home with one run that shipped a deferred proof. */
function debtHome(t, { parts = [{ layer: 'ext', parts: ['api'], files: ['tests/a.test.mjs'] }] } = {}) {
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
    credential: 'svc',
    host: 'api.example.test',
    parts,
    files: ['tests/a.test.mjs'],
  });
  run.append('merged', { actor: 'daemon', pr: 7, sha: 'headsha', mergeSha: 'mergesha' });
  return { home, paths, instance, run, deferred };
}

test('a debt names the merge that carried it, not the request head', (t) => {
  const { paths } = debtHome(t);
  const [debt] = openProofDebts(paths);
  assert.equal(debt.pr, 7);
  assert.equal(debt.mergeSha, 'mergesha');
});

test('a service still down leaves the debt open and stamps nothing', async (t) => {
  const { paths, instance } = debtHome(t);
  const asked = [];
  const watcher = new ProofDebtWatcher({
    ledger: instance,
    paths,
    probe: async (debt) => {
      asked.push(debt.credential);
      return false;
    },
    settle: async () => assert.fail('a settle ran while the service was down'),
    declared: () => true,
  });
  await watcher.poll();
  assert.deepEqual(asked, ['svc']);
  assert.equal(openProofDebts(paths).length, 1);
  assert.ok(!readEvents(paths.instanceLedger).some((e) => e.event === 'proof-settled'));
});

test('a proof that holds settles the debt and records no escape', async (t) => {
  const { paths, instance, deferred } = debtHome(t);
  const watcher = new ProofDebtWatcher({
    ledger: instance,
    paths,
    probe: async () => true,
    settle: async () => ({ ok: true }),
    declared: () => true,
  });
  await watcher.poll();
  const settled = readEvents(paths.instanceLedger).find((e) => e.event === 'proof-settled');
  assert.equal(settled.ok, true);
  assert.equal(settled.runId, 'r1');
  assert.equal(settled.deferredSeq, deferred.seq);
  assert.equal(settled.credential, 'svc');
  assert.deepEqual(readEscapeSet(paths.escapesLedger), []);
  // The debt is closed: a second poll asks nobody about it again.
  assert.deepEqual(openProofDebts(paths), []);
});

test('a proof that fails is an escape against the ship that carried it', async (t) => {
  const { paths, instance } = debtHome(t);
  const watcher = new ProofDebtWatcher({
    ledger: instance,
    paths,
    probe: async () => true,
    settle: async () => ({ ok: false, detail: 'ext exited 1' }),
    declared: () => true,
  });
  await watcher.poll();
  const settled = readEvents(paths.instanceLedger).find((e) => e.event === 'proof-settled');
  assert.equal(settled.ok, false);
  assert.match(settled.detail, /ext exited 1/);
  const [escape] = readEscapeSet(paths.escapesLedger);
  assert.equal(escape.kind, 'deferred-proof');
  assert.equal(escape.category, 'product-escape');
  assert.equal(escape.refs.runId, 'r1');
  assert.equal(escape.refs.pr, 7);
  assert.equal(escape.refs.mergeSha, 'mergesha');
  assert.equal(settled.escape, escape.seq);
  assert.deepEqual(openProofDebts(paths), []);
});

test('a settle that throws closes the debt with the reason on the record', async (t) => {
  const { paths, instance } = debtHome(t);
  const watcher = new ProofDebtWatcher({
    ledger: instance,
    paths,
    probe: async () => true,
    settle: async () => {
      throw new Error('the workspace would not provision');
    },
    declared: () => true,
  });
  await watcher.poll();
  const settled = readEvents(paths.instanceLedger).find((e) => e.event === 'proof-settled');
  assert.equal(settled.ok, false);
  assert.match(settled.detail, /would not provision/);
});

test('an instance nobody armed the trade on reads no ledger after its first poll', async (t) => {
  const { paths, instance } = debtHome(t);
  let asked = 0;
  const watcher = new ProofDebtWatcher({
    ledger: instance,
    paths,
    probe: async () => {
      asked += 1;
      return false;
    },
    settle: async () => ({ ok: true }),
    // No project this instance launched arms it.
    declared: () => false,
  });
  // The first poll scans anyway, because a debt recorded before a restart is
  // one this instance owes. It finds one, so it keeps looking.
  await watcher.poll();
  assert.equal(asked, 1);
  await watcher.poll();
  assert.equal(asked, 2, 'an open debt keeps the scan armed');
  // Settled, and with nothing declared the scan stops.
  instance.append('proof-settled', {
    actor: 'proof-debt',
    project: 'proj',
    runId: 'r1',
    deferredSeq: openProofDebts(paths)[0].seq,
    credential: 'svc',
    ok: true,
  });
  await watcher.poll();
  await watcher.poll();
  assert.equal(asked, 2, 'nothing open and nothing declared reads nothing');
});

// -- the daemon's two routes --------------------------------------------------

const PROBE_GREEN = ['node', '-e', 'process.exit(0)'];

/** A project whose default branch holds one gate layer and one probe. */
function project(t, { probe }) {
  const root = tempDir();
  t.after(() => removeDir(root));
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson({
      repo: { testPaths: ['tests'] },
      commands: {
        ext: ['node', '-e', "process.exit(require('fs').existsSync('src/broken') ? 1 : 0)"],
        svcprobe: probe,
      },
      gates: { tier1: [{ name: 'ext', command: 'ext' }] },
      lanes: { story: { suiteCommand: 'ext' } },
      credentials: [{ name: 'svc', env: 'SVC_KEY', probe: 'svcprobe', hosts: ['api.example.test'] }],
      stack: null,
    }),
    'src/base.mjs': 'export const base = 1;\n',
  });
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { proj: { repoUrl: origin, slotCap: 1 } } }) + '\n',
  );
  const daemon = new Daemon(join(root, 'home'), { lanes: {}, waitSleep: NO_WAIT });
  t.after(async () => {
    await daemon.stop();
  });
  return { root, origin, paths, daemon };
}

test('a debt a resumed run opens arms the watcher, with no launch behind it', async (t) => {
  const { paths, daemon } = project(t, { probe: PROBE_GREEN });
  await daemon.start();
  // Nothing has launched, so nothing has read a config that arms the trade.
  assert.equal(daemon.proofDebts.declared(), false);
  // A run this instance resumed answers `defer-proof`: the append travels the
  // event key every in-daemon observer reads, and the hint is set there
  // (ADR-0069).
  daemon.engine.onEvent('proj', { event: 'proof-deferred', credential: 'svc' }, paths.instanceLedger);
  assert.equal(daemon.proofDebts.declared(), true);
  // The watcher had already scanned and found nothing at the start; with the
  // hint set it looks again, and the debt the resumed run opened is settled.
  const run = openRunStore(paths, 'r9');
  t.after(() => run.close());
  run.append('run-launched', { actor: 'daemon', project: 'proj', lane: 'story' });
  run.append('proof-deferred', {
    actor: 'operator',
    cycle: 1,
    credential: 'svc',
    parts: [{ layer: 'ext', parts: ['api'], files: [], byPart: {} }],
  });
  daemon.proofDebts.settle = async () => ({ ok: true });
  await daemon.proofDebts.poll();
  const settled = readEvents(paths.instanceLedger).find((e) => e.event === 'proof-settled');
  assert.equal(settled.runId, 'r9');
  assert.equal(settled.ok, true);
});

test('an armed instance keeps looking even after it settles everything', async (t) => {
  const { paths, instance } = debtHome(t);
  let asked = 0;
  const watcher = new ProofDebtWatcher({
    ledger: instance,
    paths,
    probe: async () => {
      asked += 1;
      return true;
    },
    settle: async () => ({ ok: true }),
    declared: () => true,
  });
  await watcher.poll();
  assert.equal(asked, 1);
  assert.deepEqual(openProofDebts(paths), []);
  // Nothing is owed now, but the flag is armed, so the next debt is found.
  await watcher.poll();
  assert.equal(asked, 1, 'no debt, nothing to ask about');
  const run = openRunStore(paths, 'r2');
  t.after(() => run.close());
  run.append('run-launched', { actor: 'daemon', project: 'proj', lane: 'story' });
  run.append('proof-deferred', { actor: 'operator', cycle: 1, credential: 'svc', parts: [] });
  await watcher.poll();
  assert.equal(asked, 2, 'an armed instance reads the ledger again');
});

const DEBT = {
  project: 'proj',
  runId: 'r1',
  seq: 4,
  credential: 'svc',
  host: 'api.example.test',
  parts: [{ layer: 'ext', parts: ['api'], files: ['tests/a.test.mjs'], byPart: { api: ['tests/a.test.mjs'] } }],
  pr: 7,
  mergeSha: 'mergesha',
};

test('the daemon asks the credential its own probe, in the bare clone', async (t) => {
  const { daemon } = project(t, { probe: PROBE_GREEN });
  await daemon.start();
  assert.equal(await daemon.probeDeferred(DEBT), true);
  assert.equal(await daemon.probeDeferred({ ...DEBT, credential: 'nobody' }), false);
});

test('a refused probe answers no rather than throwing', async (t) => {
  const { daemon } = project(t, { probe: ['node', '-e', 'process.exit(1)'] });
  await daemon.start();
  assert.equal(await daemon.probeDeferred(DEBT), false);
});

test('the settle run judges the default branch in a workspace of its own', async (t) => {
  const { daemon, paths } = project(t, { probe: PROBE_GREEN });
  await daemon.start();
  const green = await daemon.settleProofDebt(DEBT);
  assert.deepEqual(green, { ok: true });
  // Nothing is left behind: the workspace is released like a run's.
  assert.equal(readEvents(paths.instanceLedger).some((e) => e.event === 'workspace-leftover'), false);
});

test('a layer the default branch no longer runs closes the debt with the reason', async (t) => {
  const { daemon } = project(t, { probe: PROBE_GREEN });
  await daemon.start();
  const out = await daemon.settleProofDebt({
    ...DEBT,
    parts: [{ layer: 'gone', parts: ['api'], files: [] }],
  });
  assert.equal(out.ok, false);
  assert.match(out.detail, /runs no layer gone/);
});

test('a deferred part that still fails on the default branch is a red settle', async (t) => {
  const { daemon, origin } = project(t, { probe: PROBE_GREEN });
  // The defect the ship carried, on the branch the settle judges.
  writeFileSync(join(origin, 'src', 'broken'), 'x');
  const { gitSync } = await import('./helpers.mjs');
  gitSync(['add', '-A'], origin);
  gitSync(['commit', '-m', 'the defect the deferred proof would have caught'], origin);
  await daemon.start();
  const out = await daemon.settleProofDebt(DEBT);
  assert.equal(out.ok, false);
  assert.match(out.detail, /^ext exited 1/);
  assert.ok(readFileSync(join(origin, 'src', 'broken'), 'utf8'));
});
