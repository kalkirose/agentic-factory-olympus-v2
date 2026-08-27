// The gate-layer attempt invariant: every `layer-started` pairs with exactly
// one terminal stamp. The structural tests hold the rule that makes it a
// property of the runner — one writer of a `layer-` stamp, called from the
// `finally` every ending leaves through. The scenarios walk each way an attempt
// can end: the re-run that replaces a red, a command that cannot spawn, a child
// a signal takes, a throw in the runner, a path that decides nothing, a stage
// re-entry, and a daemon that died holding the layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { recoverOpenAttempts, unpairedAttempts } from '../src/ledger/attempts.mjs';
import { LAYER_ABANDON_REASONS } from '../src/ledger/registry.mjs';
import { runSpectrum } from '../src/lanes/spectrum.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

const GREEN = ['node', '-e', 'process.exit(0)'];
const RED = ['node', '-e', 'console.log("boom"); process.exit(1)'];

function fixture(t) {
  const root = tempDir();
  const paths = scaffoldHome(join(root, 'home'));
  mkdirSync(join(paths.runs, 'r1'), { recursive: true });
  const store = openRunStore(paths, 'r1');
  t.after(() => {
    store.close();
    removeDir(root);
  });
  return { root, paths, ctx: { store, paths, runId: 'r1' } };
}

function events(ctx) {
  return readEvents(runLedgerPath(ctx.paths, ctx.runId));
}

/** The invariant itself, asserted over whatever a scenario produced. */
function assertPaired(ctx) {
  const open = unpairedAttempts(events(ctx));
  assert.deepEqual(
    open.map((e) => [e.seq, e.layer, e.attempt]),
    [],
    'a layer-started was left without a terminal stamp',
  );
}

/** A command seam that answers whatever the scenario needs it to. */
function seam(answer) {
  return async () => answer();
}

const ONE_LAYER = {
  layers: [{ name: 'acceptance', command: 'suite' }],
  cwd: process.cwd(),
  cycle: 1,
  sha: 'sha1',
};

// -- the structural rule ------------------------------------------------------

test('the runner writes a layer stamp in one place, from the settle point alone', () => {
  const source = readFileSync(new URL('../src/lanes/spectrum.mjs', import.meta.url), 'utf8');
  const appends = source.match(/\.append\(\s*'layer-/g) ?? [];
  assert.equal(appends.length, 1, 'a layer stamp is written outside the one writer');
  const settles = source.match(/(?<!function )(?<![\w])settle\(/g) ?? [];
  assert.equal(settles.length, 1, 'the settle point is called from more than one path');
  assert.match(
    source,
    /finally \{[\s\S]{0,400}?settle\(/,
    'the settle point is not on the path every ending takes',
  );
});

test('every abandonment the runner can stamp is in the closed reason vocabulary', () => {
  const source = readFileSync(new URL('../src/lanes/spectrum.mjs', import.meta.url), 'utf8');
  const reasons = [...source.matchAll(/reason: '([\w-]+)'/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 4, 'the runner names no abandonment reasons');
  for (const reason of reasons) assert.ok(LAYER_ABANDON_REASONS.has(reason), reason);
});

// -- an attempt that judged the tree ------------------------------------------

test('a green attempt stamps the layer result under its own attempt number', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, { ...ONE_LAYER, commands: { suite: GREEN } });
  assert.equal(results[0].status, 'green');
  const result = events(ctx).find((e) => e.event === 'layer-result');
  assert.equal(result.attempt, 1);
  assert.ok(!events(ctx).some((e) => e.event === 'layer-abandoned'));
  assertPaired(ctx);
});

// -- respawn: the re-run the flake filter owes a red --------------------------

test('a red attempt the re-run replaces is stamped with what it printed', async (t) => {
  const { ctx } = fixture(t);
  let call = 0;
  await runSpectrum(ctx, {
    ...ONE_LAYER,
    commands: { suite: RED },
    exec: seam(() => {
      call++;
      return call === 1
        ? { code: 1, output: 'first attempt output', truncated: false, parts: [] }
        : { code: 0, output: '', truncated: false, parts: [] };
    }),
  });
  const abandoned = events(ctx).filter((e) => e.event === 'layer-abandoned');
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].reason, 'superseded-by-rerun');
  assert.equal(abandoned[0].attempt, 1);
  assert.equal(abandoned[0].detail, 'exit 1');
  assert.equal(abandoned[0].partialOutput, 'first attempt output');
  // The stamp names the start it closes, so the 38 minutes read as one span.
  const starts = events(ctx).filter((e) => e.event === 'layer-started');
  assert.equal(abandoned[0].startedSeq, starts[0].seq);
  // Retry provenance: the second attempt names the first and what spawned it.
  assert.equal(starts[1].retryOf, starts[0].seq);
  assert.equal(starts[1].trigger, 'flake-filter');
  assert.ok(starts[0].retryOf === undefined, 'a first attempt claimed a retry');
  // The green re-run still stamps the flake, and the result is attempt 2's.
  assert.ok(events(ctx).some((e) => e.event === 'flake'));
  const result = events(ctx).find((e) => e.event === 'layer-result');
  assert.equal(result.attempt, 2);
  assert.equal(result.status, 'green');
  assertPaired(ctx);
});

test('a red that survives its re-run stamps one abandonment and one red result', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, { ...ONE_LAYER, commands: { suite: RED } });
  assert.equal(results[0].status, 'red');
  const stamped = events(ctx).filter((e) => e.event.startsWith('layer-'));
  assert.deepEqual(
    stamped.map((e) => [e.event, e.attempt]),
    [
      ['layer-started', 1],
      ['layer-abandoned', 1],
      ['layer-started', 2],
      ['layer-result', 2],
    ],
  );
  assert.match(stamped[1].partialOutput, /boom/);
  assert.ok(!events(ctx).some((e) => e.event === 'flake'));
  assertPaired(ctx);
});

// -- a command that never became a verdict ------------------------------------

test('a command that cannot spawn stamps command-error and reports an error', async (t) => {
  const { ctx } = fixture(t);
  const answer = await runSpectrum(ctx, {
    ...ONE_LAYER,
    commands: { suite: ['definitely-not-a-tool-on-this-host'] },
  });
  assert.ok(answer.error, 'a spawn failure reported a verdict');
  assert.ok(!answer.results);
  const abandoned = events(ctx).filter((e) => e.event === 'layer-abandoned');
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].reason, 'command-error');
  assert.ok(abandoned[0].detail.length > 0);
  assert.ok(!events(ctx).some((e) => e.event === 'layer-result'));
  assertPaired(ctx);
});

// -- kill: a signal ended the child, so the exit is not an answer -------------

test('a child a signal took is abandoned as terminated, never read as a red', async (t) => {
  const { ctx } = fixture(t);
  const answer = await runSpectrum(ctx, {
    ...ONE_LAYER,
    commands: { suite: GREEN },
    exec: seam(() => ({
      code: null,
      signal: 'SIGTERM',
      output: 'ran for a while',
      truncated: false,
      parts: [],
    })),
  });
  assert.match(answer.error, /SIGTERM/);
  const [abandoned] = events(ctx).filter((e) => e.event === 'layer-abandoned');
  assert.equal(abandoned.reason, 'terminated');
  assert.equal(abandoned.signal, 'SIGTERM');
  assert.equal(abandoned.partialOutput, 'ran for a while');
  // One attempt only: a terminated child buys no flake-filter re-run.
  assert.equal(events(ctx).filter((e) => e.event === 'layer-started').length, 1);
  assertPaired(ctx);
});

// -- a swallowed error in the runner ------------------------------------------

test('a throw in the runner stamps the attempt before it leaves', async (t) => {
  const { ctx } = fixture(t);
  await assert.rejects(
    runSpectrum(ctx, {
      ...ONE_LAYER,
      commands: { suite: GREEN },
      exec: seam(() => {
        throw new Error('the runner fell over');
      }),
    }),
    /the runner fell over/,
  );
  const [abandoned] = events(ctx).filter((e) => e.event === 'layer-abandoned');
  assert.equal(abandoned.reason, 'runner-error');
  assert.equal(abandoned.detail, 'the runner fell over');
  assertPaired(ctx);
});

test('a path that ends an attempt without deciding anything is stamped as the defect it is', async (t) => {
  const { ctx } = fixture(t);
  const answer = await runSpectrum(ctx, {
    ...ONE_LAYER,
    commands: { suite: GREEN },
    exec: seam(() => undefined),
  });
  assert.ok(answer.error);
  const [abandoned] = events(ctx).filter((e) => e.event === 'layer-abandoned');
  assert.equal(abandoned.reason, 'unstamped-exit');
  assertPaired(ctx);
});

// -- stage re-entry ------------------------------------------------------------

test('a re-entered stage closes the attempt it interrupted before it starts another', async (t) => {
  const { ctx } = fixture(t);
  // What a daemon that died mid-layer leaves behind.
  ctx.store.append('layer-started', {
    actor: 'daemon',
    cycle: 1,
    layer: 'acceptance',
    attempt: 1,
    sha: 'sha1',
  });
  const recovered = recoverOpenAttempts(ctx.store, { trigger: 'daemon-start' });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].reason, 'unclosed-at-recovery');
  assert.equal(recovered[0].trigger, 'daemon-start');
  // The stage re-enters and runs the layer again, from attempt 1.
  await runSpectrum(ctx, { ...ONE_LAYER, commands: { suite: GREEN } });
  const starts = events(ctx).filter((e) => e.event === 'layer-started');
  assert.equal(starts.length, 2);
  assert.deepEqual(starts.map((e) => e.attempt), [1, 1]);
  assertPaired(ctx);
});

test('a recovery pass over a settled ledger stamps nothing', async (t) => {
  const { ctx } = fixture(t);
  await runSpectrum(ctx, { ...ONE_LAYER, commands: { suite: RED } });
  const before = events(ctx).length;
  assert.deepEqual(recoverOpenAttempts(ctx.store, { trigger: 'daemon-start' }), []);
  assert.equal(events(ctx).length, before);
});

test('a result from before the invariant closes every attempt of its layer', () => {
  // The older shape: one `layer-result` per layer per cycle, with no attempt on
  // it. A recovery guard that read it strictly would invent an abandonment for
  // every layer the harness ever ran.
  const older = [
    { seq: 1, event: 'layer-started', cycle: 3, layer: 'acceptance', attempt: 1 },
    { seq: 2, event: 'layer-started', cycle: 3, layer: 'acceptance', attempt: 2 },
    { seq: 3, event: 'layer-result', cycle: 3, layer: 'acceptance', status: 'red' },
  ];
  assert.deepEqual(unpairedAttempts(older), []);
  assert.deepEqual(unpairedAttempts(older.slice(0, 2)).map((e) => e.attempt), [1, 2]);
});

// -- the daemon's own recovery ------------------------------------------------

const RESUMABLE = [
  { event: 'run-launched', actor: 'daemon', project: 'proj', lane: 'story', payload: {} },
  { event: 'stage-entered', actor: 'daemon', stage: 'verdict' },
  { event: 'layer-started', actor: 'daemon', cycle: 2, layer: 'acceptance', attempt: 1, sha: 'ab' },
];

function writeLedger(paths, runId, lines) {
  mkdirSync(join(paths.runs, runId), { recursive: true });
  const text = lines
    .map((line, i) => JSON.stringify({ seq: i + 1, ts: new Date().toISOString(), ...line }) + '\n')
    .join('');
  writeFileSync(runLedgerPath(paths, runId), text);
}

test('a daemon start closes the attempt the dead instance was holding', async (t) => {
  const home = tempDir();
  const paths = scaffoldHome(home);
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { proj: { repoUrl: 'file:///fixture' } } }, null, 2),
  );
  t.after(() => removeDir(home));
  writeLedger(paths, 'r1', RESUMABLE);
  const lanes = {
    story: { stages: ['verdict'], handlers: { verdict: () => new Promise(() => {}) } },
  };
  const daemon = new Daemon(home, { lanes });
  const { runsResumed } = await daemon.start();
  assert.deepEqual(runsResumed, ['r1']);
  await waitFor(
    () => readEvents(runLedgerPath(paths, 'r1')).some((e) => e.event === 'layer-abandoned'),
    { label: 'the unclosed attempt is stamped' },
  );
  const ledger = readEvents(runLedgerPath(paths, 'r1'));
  const abandoned = ledger.find((e) => e.event === 'layer-abandoned');
  assert.equal(abandoned.reason, 'unclosed-at-recovery');
  assert.equal(abandoned.trigger, 'daemon-start');
  assert.equal(abandoned.layer, 'acceptance');
  assert.equal(abandoned.attempt, 1);
  assert.equal(abandoned.sha, 'ab');
  assert.equal(abandoned.startedSeq, 3);
  // And it lands before the resumed stage does anything of its own.
  assert.ok(abandoned.seq < ledger.find((e) => e.event === 'stage-entered' && e.resumed).seq);
  assert.deepEqual(unpairedAttempts(ledger), []);
  await daemon.stop();
});

test('the orphan sweep closes an attempt in a ledger the engine does not hold', async (t) => {
  const home = tempDir();
  const paths = scaffoldHome(home);
  writeFileSync(paths.instanceConfig, JSON.stringify({ version: 1, projects: {} }, null, 2));
  t.after(() => removeDir(home));
  const daemon = new Daemon(home, { lanes: {} });
  await daemon.start();
  writeLedger(paths, 'orphan', RESUMABLE);
  daemon.recoverAttemptsOf('orphan');
  const ledger = readEvents(runLedgerPath(paths, 'orphan'));
  assert.equal(ledger.at(-1).event, 'layer-abandoned');
  assert.equal(ledger.at(-1).trigger, 'orphan-sweep');
  // A closed run has said its last word; nothing is written behind it.
  writeLedger(paths, 'closed', [
    ...RESUMABLE,
    { event: 'run-closed', actor: 'daemon', state: 'killed' },
  ]);
  daemon.recoverAttemptsOf('closed');
  assert.equal(readEvents(runLedgerPath(paths, 'closed')).length, RESUMABLE.length + 1);
  await daemon.stop();
});
