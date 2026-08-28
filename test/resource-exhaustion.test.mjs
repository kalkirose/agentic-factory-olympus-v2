// Resource exhaustion as a class the harness recognizes in itself (ADR-0045):
// the layer's peak on every record, the closed kind on the death, and one loud
// record per layer that the layer's own green answers. The first test runs a
// real command that really dies of memory, because the whole point of the class
// is that the harness can name a death nobody watched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { settleOwnedLoud } from '../src/ledger/resolution.mjs';
import { runSpectrum } from '../src/lanes/spectrum.mjs';
import { tempDir, removeDir } from './helpers.mjs';

function fixture(t) {
  const root = tempDir('olympus-exhaustion-');
  const paths = scaffoldHome(join(root, 'home'));
  mkdirSync(join(paths.runs, 'r1'), { recursive: true });
  const store = openRunStore(paths, 'r1');
  t.after(() => {
    store.close();
    removeDir(root);
  });
  return { paths, ctx: { store, paths, runId: 'r1' } };
}

function events(ctx) {
  return readEvents(runLedgerPath(ctx.paths, ctx.runId));
}

function loudRecords(ctx) {
  return events(ctx).filter(
    (e) => e.event === 'gate-integrity' && e.kind === 'resource-exhaustion',
  );
}

// A command that holds a real allocation long enough to be measured and then
// runs past the heap ceiling it was given. Two seconds of standing memory is
// what makes it a fair fixture for a layer: a gate layer runs for minutes, and
// a death at 300 ms would prove the classification while proving nothing at all
// about the measurement beside it.
const RUNAWAY = [
  'node',
  '--max-old-space-size=320',
  '-e',
  'const a=[];for(let i=0;i<25;i++)a.push(new Array(1e6).fill(1));' +
    'setTimeout(function(){for(;;){a.push(new Array(1e6).fill(Math.random()))}},2000);',
];

const GREEN = ['node', '-e', 'process.exit(0)'];
const RED = ['node', '-e', 'console.log("one test failed"); process.exit(1)'];

/** One layer, with the ceiling the project declares for it. */
function oneLayer(memoryCeilingMb) {
  return {
    layers: [{ name: 'acceptance', command: 'suite', ...(memoryCeilingMb && { memoryCeilingMb }) }],
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  };
}

/** A command seam that answers a stated outcome, the same one every attempt. */
function seam(outcome) {
  return async () => ({ truncated: false, parts: [], log: null, ...outcome });
}

test('a command that outgrows a small ceiling records its peak, dies, and is named', async (t) => {
  const { ctx } = fixture(t);
  await runSpectrum(ctx, { ...oneLayer(150), commands: { suite: RUNAWAY }, exec: undefined });

  // A heap abort is one death and two endings, because the two platforms report
  // it differently: Windows hands the harness exit code 134, and POSIX hands it
  // `SIGABRT` with no code at all. The first is a red the spectrum judges, the
  // second is a child a signal took, which the spectrum has always abandoned
  // rather than read as a verdict (ADR-0034). What must not differ is the
  // attribution, and it does not.
  const terminal = events(ctx).find(
    (e) => e.event === 'layer-result' || e.event === 'layer-abandoned',
  );
  assert.ok(terminal.exhaustion, 'the death was recorded as a plain red');
  assert.ok(
    ['abort-exit', 'abort-signal'].includes(terminal.exhaustion.evidence),
    `a heap abort read as ${terminal.exhaustion.evidence}`,
  );
  assert.equal(terminal.exhaustion.ceilingMb, 150);

  // The peak the layer's own process tree reached, on the record that says it
  // died. Measured, on the hosts that can measure: elsewhere the class is still
  // named, from the exit alone.
  if (process.platform === 'win32' || process.platform === 'linux') {
    assert.ok(terminal.resources, 'a measurable host recorded no peak for the death');
    assert.ok(
      terminal.resources.peakRssMb > 150,
      `peak ${terminal.resources.peakRssMb} MB did not clear the 150 MB ceiling`,
    );
    assert.equal(terminal.resources.ceilingMb, 150);
    assert.equal(terminal.exhaustion.peakRssMb, terminal.resources.peakRssMb);
  }

  // One loud record, naming the layer and what it held — not one per attempt.
  // The flake filter gives a red a second death, and both are the same news.
  const loud = loudRecords(ctx);
  assert.equal(loud.length, 1, 'the same ceiling was reported twice');
  assert.equal(loud[0].layer, 'acceptance');
  assert.equal(loud[0].cycle, 1);
  assert.equal(loud[0].ceilingMb, 150);
  assert.match(loud[0].gist, /^acceptance died of memory at /);
});

test('a heap abort on either platform is the same class, whatever ends the attempt', async (t) => {
  // The two endings, both staged, so the platform this suite happens to run on
  // decides nothing. On Windows the flake filter also gives the red a second
  // death, and the second one adds no second record.
  for (const [name, outcome] of [
    ['exit code', { code: 134, output: '' }],
    ['signal', { code: null, signal: 'SIGABRT', output: '' }],
  ]) {
    const { ctx } = fixture(t);
    await runSpectrum(ctx, {
      ...oneLayer(150),
      commands: { suite: GREEN },
      exec: seam({ ...outcome, resources: { peakRssMb: 400, samples: 4, intervalMs: 250 } }),
    });
    const loud = loudRecords(ctx);
    assert.equal(loud.length, 1, `${name}: one death, ${loud.length} records`);
    assert.equal(loud[0].layer, 'acceptance');
    assert.equal(loud[0].peakRssMb, 400);
  }
});

test('the layer that dies of memory in a runner that survives it is still named', async (t) => {
  // The shape both real runs had: the layer command is a workspace tool running
  // a test runner, the tool exits 1 with its own code, and the abort is only in
  // the text. Read off the exit alone this is an ordinary red, and it reached a
  // judgment seat as one — twice.
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, {
    ...oneLayer(4096),
    commands: { suite: GREEN },
    exec: seam({
      code: 1,
      output: ' ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  app test:acceptance\nExit status 134\n',
      resources: { peakRssMb: 3850, samples: 60, intervalMs: 2000, source: 'win32-cim' },
    }),
  });
  assert.equal(results[0].status, 'red');
  assert.equal(results[0].exhaustion.evidence, 'abort-reported');
  assert.equal(results[0].exhaustion.peakRssMb, 3850);
  const [loud] = loudRecords(ctx);
  assert.equal(loud.layer, 'acceptance');
  assert.equal(loud.peakRssMb, 3850);
  assert.match(loud.gist, /3850 MB against a declared ceiling of 4096 MB/);
});

test("the layer's own green answers the record, and the strip clears where it lands", async (t) => {
  const { ctx } = fixture(t);
  let call = 0;
  await runSpectrum(ctx, {
    ...oneLayer(512),
    commands: { suite: GREEN },
    exec: async () => {
      call += 1;
      return {
        code: 134,
        output: '',
        truncated: false,
        parts: [],
        log: null,
        resources: { peakRssMb: 600, samples: 3, intervalMs: 2000, source: 'linux-proc' },
      };
    },
  });
  assert.equal(call, 2, 'the flake filter did not re-run the red');
  const [loud] = loudRecords(ctx);
  settleOwnedLoud(ctx.store, { actor: 'test' });
  assert.deepEqual(
    events(ctx).filter((e) => e.event === 'resolved'),
    [],
    'a record was answered by a run that never got the layer green',
  );

  // The bound raised, the runner fixed, the layer green: that is the evidence,
  // and it is the only thing in a ledger that could be.
  await runSpectrum(ctx, {
    ...oneLayer(512),
    cycle: 2,
    commands: { suite: GREEN },
  });
  settleOwnedLoud(ctx.store, { actor: 'test' });
  const resolved = events(ctx).filter((e) => e.event === 'resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].resolves, loud.seq);
  assert.equal(resolved[0].layer, 'acceptance');
});

test('a green layer records what it peaked at, because that is the reading nobody keeps', async (t) => {
  const { ctx } = fixture(t);
  await runSpectrum(ctx, {
    ...oneLayer(4096),
    commands: { suite: GREEN },
    exec: seam({
      code: 0,
      output: '',
      resources: { peakRssMb: 3600, samples: 40, intervalMs: 2000, source: 'linux-proc' },
    }),
  });
  const result = events(ctx).find((e) => e.event === 'layer-result');
  assert.equal(result.status, 'green');
  // A green at seven eighths of its ceiling is the whole forecast: it is the
  // last run before the death, and it is the one that says nothing is wrong.
  assert.equal(result.resources.peakRssMb, 3600);
  assert.equal(result.resources.ceilingMb, 4096);
  assert.equal(result.exhaustion, undefined);
  assert.deepEqual(loudRecords(ctx), []);
});

test('an ordinary red and a killed child are not deaths of memory', async (t) => {
  const { ctx } = fixture(t);
  await runSpectrum(ctx, { ...oneLayer(4096), commands: { suite: RED } });
  assert.deepEqual(loudRecords(ctx), []);
  const red = events(ctx).find((e) => e.event === 'layer-result');
  assert.equal(red.status, 'red');
  assert.equal(red.exhaustion, undefined);

  // The daemon kills a run's tree when it stops. Reading a signal as evidence
  // would put the word on every run an operator ever ended.
  await runSpectrum(ctx, {
    ...oneLayer(4096),
    cycle: 2,
    commands: { suite: GREEN },
    exec: seam({ code: null, signal: 'SIGKILL', output: 'it had been running for a while' }),
  });
  assert.deepEqual(loudRecords(ctx), []);
});

test('a layer that declares no ceiling is still named when it dies of memory', async (t) => {
  const { ctx } = fixture(t);
  await runSpectrum(ctx, {
    ...oneLayer(null),
    commands: { suite: GREEN },
    exec: seam({
      code: 1,
      output: 'FATAL ERROR: Reached heap limit Allocation failed',
      resources: { peakRssMb: 2048, samples: 9, intervalMs: 2000, source: 'linux-proc' },
    }),
  });
  const [loud] = loudRecords(ctx);
  assert.equal(loud.evidence, 'heap-abort');
  assert.equal(loud.peakRssMb, 2048);
  assert.equal(loud.ceilingMb, undefined);
  assert.match(loud.gist, /died of memory at 2048 MB$/);
});

test('a host that cannot measure still classes the death, and says nothing it did not read', async (t) => {
  const { ctx } = fixture(t);
  await runSpectrum(ctx, {
    ...oneLayer(null),
    commands: { suite: GREEN },
    exec: seam({ code: 134, output: '', resources: null }),
  });
  const [loud] = loudRecords(ctx);
  assert.equal(loud.evidence, 'abort-exit');
  assert.equal(loud.peakRssMb, undefined);
  assert.match(loud.gist, /died of memory at an unmeasured peak/);
  const result = events(ctx).find((e) => e.event === 'layer-result');
  assert.equal(result.resources, undefined);
});
