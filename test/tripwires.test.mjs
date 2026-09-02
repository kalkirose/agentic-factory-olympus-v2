import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { scaffoldHome, runLedgerPath, archivedRunLedgerPath } from '../src/daemon/home.mjs';
import { openInstanceStore, openEscapesStore } from '../src/telemetry/stores.mjs';
import { openBreaches, openStreamItems } from '../src/telemetry/readers.mjs';
import { recordEscape } from '../src/telemetry/escapes.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { validateProjectConfig } from '../src/config/project.mjs';
import {
  armedTripwires,
  standingTripwires,
  withTripwireDefaults,
} from '../src/tripwires/registry.mjs';
import { evaluateMetric } from '../src/tripwires/metrics.mjs';
import { TripwireWatcher } from '../src/tripwires/watcher.mjs';
import { computeFrontier } from '../src/frontier/graph.mjs';
import { RunEngine } from '../src/engine/engine.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

function home(t) {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  return scaffoldHome(dir);
}

function writeLedger(path, lines) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function line(seq, ts, event, extra = {}) {
  return { seq, ts, event, actor: 'daemon', ...extra };
}

// A story-lane run ledger with a freeze after `waves` initial waves.
function freezeRun(paths, runId, project, ts, { kills, waves = 3 }) {
  const lines = [line(1, ts, 'run-launched', { project, lane: 'story' })];
  for (let w = 1; w <= waves; w++) {
    lines.push(line(1 + w, ts, 'adversary-wave', { round: 1, wave: w, phase: 'initial' }));
  }
  lines.push(line(2 + waves, ts, 'freeze', { killCount: kills, sha: 'f'.repeat(7) }));
  writeLedger(runLedgerPath(paths, runId), lines);
}

// -- registry validation ------------------------------------------------------

test('the standing tripwires validate clean', () => {
  const errors = validateProjectConfig({ version: 1, tripwires: standingTripwires() });
  assert.deepEqual(errors, []);
});

test('tripwire validation refuses what the daemon cannot evaluate', () => {
  const entry = (over) => ({
    id: 'x',
    metric: 'escapes-window',
    breach: { op: '>', value: 0.5 },
    answer: 'restore',
    ...over,
  });
  const paths = (tripwire) =>
    validateProjectConfig({ version: 1, tripwires: [tripwire] }).map((e) => e.path);
  assert.deepEqual(paths(entry({ metric: 'made-up' })), ['tripwires[0].metric']);
  assert.deepEqual(paths(entry({ breach: { op: '!=', value: 1 } })), ['tripwires[0].breach']);
  assert.deepEqual(paths(entry({ breach: undefined })), ['tripwires[0].breach']);
  assert.deepEqual(paths(entry({ window: 0 })), ['tripwires[0].window']);
  assert.deepEqual(paths(entry({ triggerEvents: ['merge'] })), ['tripwires[0].triggerEvents']);
  assert.deepEqual(paths(entry({ answer: undefined })), ['tripwires[0].answer']);
  // a metric over current state takes no window
  assert.deepEqual(
    paths({
      id: 'w',
      metric: 'frontier-width',
      window: 5,
      breach: { op: '<', value: 2 },
      answer: 'card-edge review',
    }),
    ['tripwires[0].window'],
  );
  // fury-lens-yield names its lens
  assert.deepEqual(
    paths({ id: 'y', metric: 'fury-lens-yield', breach: { op: '<', value: 1 }, answer: 'review' }),
    ['tripwires[0].params.lens'],
  );
});

test('defaults fill the window and the trigger events', () => {
  const filled = withTripwireDefaults({
    id: 'esc',
    metric: 'escapes-window',
    breach: { op: '>', value: 0.5 },
    answer: 'restore',
  });
  assert.equal(filled.window, 10);
  assert.deepEqual(filled.triggerEvents, ['escape-recorded', 'escape-fixed', 'merged']);
  const width = withTripwireDefaults({
    id: 'w',
    metric: 'frontier-width',
    breach: { op: '<', value: 2 },
    answer: 'card-edge review',
  });
  assert.equal(width.window, undefined);
  assert.deepEqual(width.triggerEvents, ['merged', 'card-sweep']);
});

test('the fast path cannot be turned on without the counter that measures it', () => {
  // The doctrine rule for a gate cut: the cut, its metric, its window and its
  // breach condition land together. `gates.fastPathShip` is a cut, and a
  // project that turns it on and names no counter has traded a guarantee with
  // nothing measuring the cost and nothing able to propose the revert.
  // The two operator levers are armed on every project, because they are on
  // every project: any world gate can be acknowledged and any run can be
  // repinned, whatever the config says (ADR-0061, ADR-0062).
  const off = { gates: { tier1: [] }, tripwires: [] };
  assert.deepEqual(
    armedTripwires(off).map((e) => e.metric),
    ['gate-acks-window', 'run-reconfigures-window'],
  );
  const on = { gates: { tier1: [], fastPathShip: true }, tripwires: [] };
  const armed = armedTripwires(on);
  assert.deepEqual(
    armed.map((e) => e.metric),
    ['fast-path-escapes', 'gate-acks-window', 'run-reconfigures-window'],
  );
  assert.match(armed[0].answer, /gates\.fastPathShip to false/);
  // A project that wrote its own band keeps it: the arming fills a gap, it
  // never overrides a decision somebody made.
  const own = {
    gates: { tier1: [], fastPathShip: true },
    tripwires: [
      { id: 'mine', metric: 'fast-path-escapes', window: 20, breach: { op: '>', value: 4 }, answer: 'x' },
      { id: 'acks', metric: 'gate-acks-window', window: 5, breach: { op: '>', value: 0 }, answer: 'y' },
      { id: 'pins', metric: 'run-reconfigures-window', window: 5, breach: { op: '>', value: 0 }, answer: 'z' },
    ],
  };
  assert.deepEqual(armedTripwires(own), own.tripwires);
  // Every other entry the project wrote rides through untouched.
  const mixed = {
    gates: { tier1: [], fastPathShip: true },
    tripwires: [{ id: 'k', metric: 'kill-rate', breach: { op: '<', value: 1 }, answer: 'y' }],
  };
  assert.deepEqual(
    armedTripwires(mixed).map((e) => e.id),
    ['k', 'fast-path-escapes', 'gate-acks', 'run-reconfigures'],
  );
});

// -- metrics ------------------------------------------------------------------

test('escapes-window counts escapes after the oldest ship of the project', async (t) => {
  const paths = home(t);
  writeLedger(runLedgerPath(paths, 's1'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-02T00:00:00Z', 'merged', { sha: 'aaa' }),
  ]);
  // another project's ship is older; it must not widen p's window
  writeLedger(runLedgerPath(paths, 'q1'), [
    line(1, '2026-07-01T00:00:00Z', 'run-launched', { project: 'q', lane: 'story' }),
    line(2, '2026-07-02T00:00:00Z', 'merged', { sha: 'bbb' }),
  ]);
  writeLedger(paths.escapesLedger, [
    line(1, '2026-08-01T00:00:00Z', 'escape-recorded', {
      category: 'product-escape',
      defectLine: 'before the ship',
      detectionSource: 'human-report',
      attribution: 'unattributed',
      refs: { project: 'p' },
    }),
    ...[2, 3, 4, 5, 6, 7].map((seq) =>
      line(seq, `2026-08-03T0${seq}:00:00Z`, 'escape-recorded', {
        category: seq === 7 ? 'chore' : 'product-escape',
        defectLine: `escape ${seq}`,
        detectionSource: 'human-report',
        attribution: 'unattributed',
        refs: { project: 'p' },
      }),
    ),
    // Another project's defect, inside p's window. The quality bar is a
    // reading about one repository, and a breach here would name p's ceiling
    // for work that is not in p.
    line(8, '2026-08-04T00:00:00Z', 'escape-recorded', {
      category: 'product-escape',
      defectLine: 'a defect in q',
      detectionSource: 'human-report',
      attribution: 'unattributed',
      refs: { project: 'q' },
    }),
  ]);
  const result = await evaluateMetric('escapes-window', { paths, project: 'p', window: 10 });
  // five counted (the chore, the pre-ship record and q's defect stay out)
  assert.equal(result.value, 0.5);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.detail, { ships: 1, counted: 5 });
  const empty = await evaluateMetric('escapes-window', { paths, project: 'r', window: 10 });
  assert.equal(empty.eligible, false);
});

test('a shipped repair stands in the escape windows like a story', async (t) => {
  const paths = home(t);
  // One repair ship, then one story ship. The repair is the oldest ship of the
  // window, so an escape recorded between the two is inside it.
  writeLedger(runLedgerPath(paths, 'r1'), [
    line(1, '2026-07-19T00:00:00Z', 'run-launched', {
      project: 'p',
      lane: 'repair',
      ticket: '/home/tickets/escape-1.md',
      escapeSeq: 1,
    }),
    line(2, '2026-07-20T00:00:00Z', 'merged', { sha: 'rrr' }),
  ]);
  writeLedger(runLedgerPath(paths, 's1'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-02T00:00:00Z', 'merged', { sha: 'aaa' }),
  ]);
  const escape = (seq, ts, extra) =>
    line(seq, ts, 'escape-recorded', {
      category: 'product-escape',
      defectLine: `escape ${seq}`,
      detectionSource: 'human-report',
      attribution: 'unattributed',
      refs: { project: 'p' },
      ...extra,
    });
  writeLedger(paths.escapesLedger, [
    escape(1, '2026-07-01T00:00:00Z', {}), // before every ship
    escape(2, '2026-07-25T00:00:00Z', {}), // after the repair shipped
    escape(3, '2026-07-26T00:00:00Z', { kind: 'fast-path-escape' }),
  ]);
  const rate = await evaluateMetric('escapes-window', { paths, project: 'p', window: 10 });
  assert.deepEqual(rate.detail, { ships: 2, counted: 2 });
  assert.equal(rate.value, 0.2);
  const fast = await evaluateMetric('fast-path-escapes', { paths, project: 'p', window: 10 });
  assert.deepEqual(fast.detail, { ships: 2, counted: 1, escapes: [3] });
  // A project whose only ship is a repair has a window, so it has a reading.
  writeLedger(runLedgerPath(paths, 'q1'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'q', lane: 'repair' }),
    line(2, '2026-08-02T00:00:00Z', 'merged', { sha: 'qqq' }),
  ]);
  const onlyRepair = await evaluateMetric('escapes-window', { paths, project: 'q', window: 10 });
  assert.equal(onlyRepair.eligible, true);
  assert.deepEqual(onlyRepair.detail, { ships: 1, counted: 0 });
});

test('fast-path-escapes counts only the kind, only inside the window', async (t) => {
  const paths = home(t);
  writeLedger(runLedgerPath(paths, 'f1'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-02T00:00:00Z', 'fast-path-ship', { taken: true, commits: ['abc'] }),
    line(3, '2026-08-02T01:00:00Z', 'merged', { pr: 7, sha: 'aaa', mergeSha: 'mmm' }),
  ]);
  const escape = (seq, ts, extra) =>
    line(seq, ts, 'escape-recorded', {
      category: 'product-escape',
      defectLine: `escape ${seq}`,
      detectionSource: 'human-report',
      attribution: 'unattributed',
      ...extra,
    });
  writeLedger(paths.escapesLedger, [
    // Before the window's oldest ship: outside the reading, like every other
    // recency-based window here.
    escape(1, '2026-07-01T00:00:00Z', { kind: 'fast-path-escape', refs: { project: 'p' } }),
    // An ordinary escape of the same window. It is a defect and it is not this
    // metric's defect: the flag is not what let it through.
    escape(2, '2026-08-03T00:00:00Z', { refs: { project: 'p' } }),
    escape(3, '2026-08-03T01:00:00Z', { kind: 'fast-path-escape', refs: { project: 'p' } }),
    escape(4, '2026-08-03T02:00:00Z', { kind: 'fast-path-escape', refs: { project: 'p' } }),
    // Another project's defect, on another project's trade. The escapes ledger
    // is instance-scoped and this reading is about one project's flag.
    escape(5, '2026-08-03T03:00:00Z', { kind: 'fast-path-escape', refs: { project: 'q' } }),
  ]);
  const result = await evaluateMetric('fast-path-escapes', { paths, project: 'p', window: 10 });
  assert.equal(result.value, 2);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.detail, { ships: 1, counted: 2, escapes: [3, 4] });
  // A project that never shipped has no window, so it has no reading.
  const quiet = await evaluateMetric('fast-path-escapes', { paths, project: 'r', window: 10 });
  assert.equal(quiet.eligible, false);
});

test('kill-rate sums kills over waves across the freeze window', async (t) => {
  const paths = home(t);
  freezeRun(paths, 'k1', 'p', '2026-08-01T00:00:00Z', { kills: 2 });
  freezeRun(paths, 'k2', 'p', '2026-08-02T00:00:00Z', { kills: 3 });
  const both = await evaluateMetric('kill-rate', { paths, project: 'p', window: 5 });
  assert.equal(both.value, 5 / 6);
  assert.deepEqual(both.detail, { freezes: 2, kills: 5, waves: 6 });
  const last = await evaluateMetric('kill-rate', { paths, project: 'p', window: 1 });
  assert.equal(last.value, 1);
  const none = await evaluateMetric('kill-rate', { paths, project: 'empty', window: 5 });
  assert.equal(none.eligible, false);
});

test('fury-lens-yield counts confirmed findings for one lens over the verdict window', async (t) => {
  const paths = home(t);
  writeLedger(runLedgerPath(paths, 'v1'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-01T01:00:00Z', 'finding', {
      cycle: 1,
      id: 'F1',
      lens: 'security',
      severity: 'HIGH',
      confirmed: true,
    }),
    line(3, '2026-08-01T01:00:00Z', 'finding', {
      cycle: 1,
      id: 'F2',
      lens: 'security',
      severity: 'MEDIUM',
      advisory: true,
    }),
    line(4, '2026-08-01T02:00:00Z', 'verdict-rendered', { cycle: 1, pass: 1, verdict: 'red' }),
  ]);
  writeLedger(archivedRunLedgerPath(paths, 'v2'), [
    line(1, '2026-08-02T00:00:00Z', 'run-launched', { project: 'p', lane: 'repair' }),
    line(2, '2026-08-02T01:00:00Z', 'finding', {
      cycle: 1,
      id: 'F1',
      lens: 'security',
      severity: 'HIGH',
      confirmed: true,
    }),
    line(3, '2026-08-02T01:00:00Z', 'finding', {
      cycle: 1,
      id: 'F2',
      lens: 'operational',
      severity: 'HIGH',
      confirmed: true,
    }),
    line(4, '2026-08-02T02:00:00Z', 'verdict-rendered', { cycle: 1, pass: 1, verdict: 'green' }),
  ]);
  const security = await evaluateMetric('fury-lens-yield', {
    paths,
    project: 'p',
    window: 5,
    params: { lens: 'security' },
  });
  assert.equal(security.value, 2);
  const quiet = await evaluateMetric('fury-lens-yield', {
    paths,
    project: 'p',
    window: 5,
    params: { lens: 'interface' },
  });
  assert.equal(quiet.value, 0);
  assert.equal(quiet.eligible, true);
});

// -- the memory forecast (ADR-0045) -------------------------------------------
//
// One run's peaks per layer, written the way the spectrum writes them. `peaks`
// maps a layer to what its process tree reached, in mebibytes; a layer with a
// declared ceiling carries it on the same reading, so the forecast never has to
// read today's config against yesterday's measurements.

function peakRun(paths, runId, project, ts, peaks, { ceilings = {}, archived = false } = {}) {
  const entries = Object.entries(peaks);
  writeLedger(archived ? archivedRunLedgerPath(paths, runId) : runLedgerPath(paths, runId), [
    line(1, ts, 'run-launched', { project, lane: 'story' }),
    ...entries.map(([layer, peakRssMb], i) =>
      line(2 + i, ts, 'layer-result', {
        cycle: 1,
        layer,
        attempt: 1,
        status: 'green',
        resources: {
          peakRssMb,
          samples: 12,
          intervalMs: 2000,
          source: 'linux-proc',
          ...(ceilings[layer] && { ceilingMb: ceilings[layer] }),
        },
      }),
    ),
    line(2 + entries.length, ts, 'verdict-rendered', { cycle: 1, pass: 1, verdict: 'green' }),
  ]);
}

test('a layer whose peak climbs every run trips the forecast, and a flat one stays quiet', async (t) => {
  const paths = home(t);
  // Four runs of one layer, each holding more than the run before it, and a
  // second layer beside it that never moves. Nothing has died yet: that is the
  // whole point of the reading.
  const climb = [900, 1400, 2000, 2700];
  climb.forEach((peakRssMb, i) =>
    peakRun(paths, `g${i}`, 'p', `2026-08-0${i + 1}T00:00:00Z`, {
      acceptance: peakRssMb,
      lint: 300,
    }),
  );
  const result = await evaluateMetric('layer-peak-trend', { paths, project: 'p', window: 5 });
  assert.equal(result.eligible, true);
  assert.equal(result.value, 4);
  assert.equal(result.detail.layer, 'acceptance');
  assert.deepEqual(result.detail.peaks, climb);
  assert.equal(result.detail.runs, 4);

  // The flat layer alone reads as what it is: one reading, going nowhere.
  const flat = home(t);
  [1, 2, 3, 4].forEach((day) =>
    peakRun(flat, `f${day}`, 'p', `2026-08-0${day}T00:00:00Z`, { lint: 300 }),
  );
  const quiet = await evaluateMetric('layer-peak-trend', { paths: flat, project: 'p', window: 5 });
  assert.equal(quiet.eligible, true);
  assert.equal(quiet.value, 1);
});

test('a climb that stopped is history, and noise between runs is not a climb', async (t) => {
  const paths = home(t);
  // It climbed for three runs and then settled. A forecast reads the tail.
  [900, 1400, 2000, 2010, 2015].forEach((peakRssMb, i) =>
    peakRun(paths, `s${i}`, 'p', `2026-08-0${i + 1}T00:00:00Z`, { acceptance: peakRssMb }),
  );
  const settled = await evaluateMetric('layer-peak-trend', { paths, project: 'p', window: 5 });
  assert.equal(settled.value, 1, 'a climb that ended two runs ago still reads as a climb');

  // A layer that wanders by a few megabytes between identical runs is a layer
  // doing nothing. Without a noise floor this is a breach every window.
  const noisy = home(t);
  [1000, 1004, 1009, 1013, 1018].forEach((peakRssMb, i) =>
    peakRun(noisy, `n${i}`, 'p', `2026-08-0${i + 1}T00:00:00Z`, { acceptance: peakRssMb }),
  );
  const wander = await evaluateMetric('layer-peak-trend', { paths: noisy, project: 'p', window: 5 });
  assert.equal(wander.value, 1);
});

test('a declared ceiling is read as the fraction of it the layer holds', async (t) => {
  const paths = home(t);
  peakRun(paths, 'h1', 'p', '2026-08-01T00:00:00Z', { acceptance: 2000, lint: 400 }, {
    ceilings: { acceptance: 4096 },
  });
  peakRun(paths, 'h2', 'p', '2026-08-02T00:00:00Z', { acceptance: 3600, lint: 400 }, {
    ceilings: { acceptance: 4096 },
  });
  const result = await evaluateMetric('layer-peak-headroom', { paths, project: 'p', window: 5 });
  assert.equal(result.eligible, true);
  // The worst reading in the window, not the last: a layer that touched its
  // ceiling once has a ceiling problem.
  assert.equal(result.value, round(3600 / 4096));
  assert.equal(result.detail.layer, 'acceptance');
  assert.equal(result.detail.peakRssMb, 3600);
  assert.equal(result.detail.ceilingMb, 4096);
  assert.equal(result.detail.run, 'h2');
  // The standing band is four fifths, and this reading is past it.
  const band = standingTripwires().find((e) => e.id === 'layer-peak-headroom');
  assert.equal(band.breach.value, 0.8);
  assert.ok(result.value > band.breach.value);

  // A project that declares no ceiling anywhere is watched by the trend alone.
  const undeclared = home(t);
  peakRun(undeclared, 'u1', 'p', '2026-08-01T00:00:00Z', { acceptance: 9000 });
  const none = await evaluateMetric('layer-peak-headroom', {
    paths: undeclared,
    project: 'p',
    window: 5,
  });
  assert.equal(none.eligible, false);
  assert.equal(none.value, null);
});

test('a ledger written before the measurement existed reads clean, and measures nothing', async (t) => {
  const paths = home(t);
  // Exactly what the running daemon is writing right now: layer results with no
  // reading on them at all. The additive field is absent, not zero, and neither
  // metric may invent a number for it.
  writeLedger(runLedgerPath(paths, 'old'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-01T01:00:00Z', 'layer-result', {
      cycle: 1,
      layer: 'acceptance',
      attempt: 1,
      status: 'red',
      output: 'one test failed',
    }),
    line(3, '2026-08-01T02:00:00Z', 'verdict-rendered', { cycle: 1, pass: 1, verdict: 'red' }),
  ]);
  for (const metric of ['layer-peak-headroom', 'layer-peak-trend']) {
    const result = await evaluateMetric(metric, { paths, project: 'p', window: 5 });
    assert.equal(result.eligible, false, metric);
    assert.equal(result.value, null, metric);
  }

  // And a run measured beside it is read on its own, with no zero carried in
  // from the ledgers that predate the field.
  peakRun(paths, 'new', 'p', '2026-08-03T00:00:00Z', { acceptance: 2000 }, {
    ceilings: { acceptance: 2048 },
  });
  const headroom = await evaluateMetric('layer-peak-headroom', { paths, project: 'p', window: 5 });
  assert.equal(headroom.detail.runs, 1);
  assert.ok(headroom.value > 0.9);
});

test('a replaced attempt counts, and several attempts in one run count once', async (t) => {
  const paths = home(t);
  // The flake filter abandons the first red and re-runs it, so half a layer's
  // deaths are `layer-abandoned`. A history that read results alone would learn
  // this layer's memory from the quieter half of its runs.
  writeLedger(runLedgerPath(paths, 'a1'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-01T01:00:00Z', 'layer-abandoned', {
      cycle: 1,
      layer: 'acceptance',
      attempt: 1,
      reason: 'superseded-by-rerun',
      resources: { peakRssMb: 3900, samples: 9, intervalMs: 2000, source: 'linux-proc', ceilingMb: 4096 },
    }),
    line(3, '2026-08-01T02:00:00Z', 'layer-result', {
      cycle: 1,
      layer: 'acceptance',
      attempt: 2,
      status: 'green',
      resources: { peakRssMb: 1200, samples: 9, intervalMs: 2000, source: 'linux-proc', ceilingMb: 4096 },
    }),
  ]);
  const result = await evaluateMetric('layer-peak-headroom', { paths, project: 'p', window: 5 });
  assert.equal(result.detail.peakRssMb, 3900, 'the replaced attempt was not read');
  assert.equal(result.detail.runs, 1, 'one run counted as two');
});

function round(value) {
  return Math.round(value * 1000) / 1000;
}

test('ci-critical-path takes the median of the longest green check, in minutes', async (t) => {
  const paths = home(t);
  const ship = (runId, ts, sha, checks) =>
    writeLedger(runLedgerPath(paths, runId), [
      line(1, ts, 'run-launched', { project: 'p', lane: 'story' }),
      ...checks.map((c, i) =>
        line(2 + i, ts, 'check-transition', { sha, check: c.name, status: c.status, duration: c.minutes * 60000 }),
      ),
      line(2 + checks.length, ts, 'merged', { sha }),
    ]);
  ship('c1', '2026-08-01T00:00:00Z', 's1', [
    { name: 'unit', status: 'success', minutes: 4 },
    { name: 'docker-build', status: 'success', minutes: 10 },
    // a red duration never measures the green path
    { name: 'flaky', status: 'failure', minutes: 99 },
  ]);
  ship('c2', '2026-08-02T00:00:00Z', 's2', [{ name: 'docker-build', status: 'success', minutes: 20 }]);
  const result = await evaluateMetric('ci-critical-path', { paths, project: 'p', window: 5 });
  assert.equal(result.value, 15);
  assert.deepEqual(result.detail, { merges: 2 });
});

test('verdict-cycles reads the worst run of the window, not its average', async (t) => {
  const paths = home(t);
  const judged = (runId, day, cycles) =>
    writeLedger(runLedgerPath(paths, runId), [
      line(1, `2026-08-0${day}T00:00:00Z`, 'run-launched', { project: 'p', lane: 'story' }),
      ...Array.from({ length: cycles }, (_, i) =>
        line(2 + i, `2026-08-0${day}T0${i}:00:00Z`, 'verdict-rendered', {
          cycle: i + 1,
          verdict: i + 1 === cycles ? 'green' : 'red',
        }),
      ),
    ]);
  judged('r1', 1, 2);
  judged('r2', 2, 3);
  const quiet = await evaluateMetric('verdict-cycles', { paths, project: 'p', window: 5 });
  assert.equal(quiet.value, 3);
  assert.deepEqual(quiet.detail, { runs: 2, run: 'r2' });
  // The sixth cycle of one run is the reading, whatever the others did.
  judged('r3', 3, 6);
  const loud = await evaluateMetric('verdict-cycles', { paths, project: 'p', window: 5 });
  assert.equal(loud.value, 6);
  assert.equal(loud.detail.run, 'r3');
  // A window that reaches back past a run drops it, and the reading falls.
  const narrow = await evaluateMetric('verdict-cycles', { paths, project: 'p', window: 1 });
  assert.equal(narrow.value, 6);
  const empty = await evaluateMetric('verdict-cycles', { paths, project: 'q', window: 5 });
  assert.equal(empty.eligible, false);
  assert.equal(empty.value, null);
});

// -- the carry share ---------------------------------------------------------
//
// ADR-0058. The one band in the registry that watches a number for falling: a
// part-level carry that quietly stops happening costs the hours it was built
// to remove and reddens nothing.

/**
 * A judged run whose cycles each recorded a share. `shares` is one entry per
 * cycle; a number is a targeted cycle, and a `{share, sweep, confirmation}`
 * object states a cycle that ran whole.
 */
function sharedRun(paths, runId, day, shares) {
  writeLedger(runLedgerPath(paths, runId), [
    line(1, `2026-08-0${day}T00:00:00Z`, 'run-launched', { project: 'p', lane: 'story' }),
    ...shares.map((entry, i) => {
      const cycle = typeof entry === 'number' ? { share: entry } : entry;
      return line(2 + i, `2026-08-0${day}T0${i}:00:00Z`, 'verdict-rendered', {
        cycle: i + 1,
        verdict: 'red',
        sweep: cycle.sweep ?? 'targeted',
        ...(cycle.confirmation && { confirmation: true }),
        ...(cycle.share !== undefined && {
          partsRun: 1,
          partsCarried: 1,
          carryShare: cycle.share,
        }),
      });
    }),
  ]);
}

test('carry-share-window means the shares of the cycles that narrowed', async (t) => {
  const paths = home(t);
  sharedRun(paths, 'r1', 1, [0.8, 0.6]);
  const healthy = await evaluateMetric('carry-share-window', { paths, project: 'p', window: 10 });
  assert.equal(healthy.value, 0.7);
  assert.deepEqual(healthy.detail, { cycles: 2, run: 'r1' });
  // A project with no reading at all is ineligible and never breaches: nought
  // measured is not a share of nought.
  const cold = await evaluateMetric('carry-share-window', { paths, project: 'q', window: 10 });
  assert.equal(cold.eligible, false);
  assert.equal(cold.value, null);
});

test('the cycles that run whole on purpose are no reading about the narrowing', async (t) => {
  const paths = home(t);
  // A first cycle has nothing to carry from and a confirming cycle runs every
  // layer at its own sha (ADR-0046). Both record a share of nought, and both
  // would read the design as a decay.
  sharedRun(paths, 'r1', 1, [
    { share: 0, sweep: 'full' },
    0.8,
    { share: 0, confirmation: true },
  ]);
  const reading = await evaluateMetric('carry-share-window', { paths, project: 'p', window: 10 });
  assert.equal(reading.value, 0.8);
  assert.equal(reading.detail.cycles, 1);
  // A render written before the share existed carries no number, so it is no
  // reading either, and an old ledger keeps the band quiet.
  sharedRun(paths, 'r2', 2, [{ share: undefined }]);
  const old = await evaluateMetric('carry-share-window', { paths, project: 'p', window: 10 });
  assert.equal(old.value, 0.8);
  assert.equal(old.detail.cycles, 1);
});

test('a carry that decays breaches the floor, and ten healthy cycles do not', async (t) => {
  const paths = home(t);
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const watcher = new TripwireWatcher({ paths, ledger });
  // A floor a project sets after measuring itself. The standing entry ships at
  // nought and cannot fire; this is the shape it takes once the ten cycles
  // named in ADR-0058 stand on the ledger.
  const armed = withTripwireDefaults({
    ...standingTripwires().find((e) => e.id === 'carry-share-floor'),
    breach: { op: '<', value: 0.4 },
  });
  watcher.setRegistry('p', [armed]);
  const breaches = () =>
    readEvents(paths.instanceLedger).filter((e) => e.event === 'tripwire-breach');

  // Ten cycles of a project whose declarations hold.
  sharedRun(paths, 'r1', 1, [0.7, 0.6, 0.8, 0.7, 0.6, 0.7, 0.8, 0.6, 0.7, 0.7]);
  await watcher.notify('p', { event: 'verdict-rendered' });
  assert.deepEqual(breaches(), []);

  // One family loses its input declaration. Every part runs every cycle, the
  // share falls to nothing, and no layer goes red about it.
  sharedRun(paths, 'r2', 2, [0.1, 0, 0, 0, 0, 0]);
  await watcher.notify('p', { event: 'verdict-rendered' });
  assert.equal(breaches().length, 1);
  const breach = breaches()[0];
  assert.equal(breach.tripwire, 'carry-share-floor');
  assert.equal(breach.metric, 'carry-share-window');
  assert.ok(breach.value < 0.4, `mean ${breach.value} did not fall under the floor`);
  assert.equal(breach.window, 10);
  assert.match(breach.answer, /input declaration/);
  assert.equal(openBreaches(paths).length, 1);
});

test('the standing carry-share entry cannot fire on any share', async (t) => {
  const paths = home(t);
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const watcher = new TripwireWatcher({ paths, ledger });
  const standing = standingTripwires().find((e) => e.id === 'carry-share-floor');
  assert.deepEqual(standing.breach, { op: '<', value: 0 });
  watcher.setRegistry('p', [withTripwireDefaults(standing)]);
  // Every part of every cycle re-running is the worst reading there is, and
  // the placeholder floor still says nothing. That is deliberate: the honest
  // floor is measured, and a band nobody measured is a band an operator
  // learns to ignore.
  sharedRun(paths, 'r1', 1, [0, 0, 0, 0, 0]);
  await watcher.notify('p', { event: 'verdict-rendered' });
  const breaches = readEvents(paths.instanceLedger).filter((e) => e.event === 'tripwire-breach');
  assert.deepEqual(breaches, []);
});

test('ship-token-wait reads the longest queue wait, open ones included', async (t) => {
  const paths = home(t);
  const queued = (runId, day, { waited, closed }) =>
    writeLedger(runLedgerPath(paths, runId), [
      line(1, `2026-08-0${day}T00:00:00Z`, 'run-launched', { project: 'p', lane: 'story' }),
      line(2, `2026-08-0${day}T00:00:00Z`, 'ship-token', { state: 'waiting', holder: 'other' }),
      ...(waited === null
        ? []
        : [line(3, `2026-08-0${day}T00:${String(waited).padStart(2, '0')}:00Z`, 'ship-token', { state: 'acquired' })]),
      ...(closed ? [line(4, `2026-08-0${day}T02:00:00Z`, 'run-closed', { state: 'shipped' })] : []),
    ]);
  queued('t1', 1, { waited: 5, closed: true });
  queued('t2', 2, { waited: 40, closed: true });
  const closedOnly = await evaluateMetric('ship-token-wait', { paths, project: 'p', window: 5 });
  assert.equal(closedOnly.value, 40);
  assert.deepEqual(closedOnly.detail, { waits: 2, run: 't2' });
  // A run still in the queue is measured up to now: the wait nobody has ended
  // is the one the metric exists for.
  queued('t3', 3, { waited: null, closed: false });
  const open = await evaluateMetric('ship-token-wait', {
    paths,
    project: 'p',
    window: 5,
    now: Date.parse('2026-08-03T02:00:00Z'),
  });
  assert.equal(open.value, 120);
  assert.equal(open.detail.run, 't3');
  // A run that never queued says nothing at all.
  writeLedger(runLedgerPath(paths, 't4'), [
    line(1, '2026-08-04T00:00:00Z', 'run-launched', { project: 'q', lane: 'story' }),
  ]);
  const none = await evaluateMetric('ship-token-wait', { paths, project: 'q', window: 5 });
  assert.equal(none.eligible, false);
});

test('the frontier width is possible parallelism, not the launchable set', () => {
  const card = (key, blockedBy = [], phase = null) => ({ key, path: `${key}.md`, phase, blockedBy });
  const runs = new Map([
    ['a', { open: 0, shipped: 1, spent: 0 }],
    ['c', { open: 0, shipped: 0, spent: 1 }],
  ]);
  const frontier = computeFrontier({
    cards: [card('a'), card('b', ['a']), card('c', ['a']), card('d', ['b']), card('e', [], 'post')],
    phases: [{ name: 'launch' }, { name: 'post', after: 'a-key-that-never-shipped' }],
    runs,
  });
  // b and the spent c count: their edges permit work; d waits on b, e is gated
  assert.equal(frontier.width, 2);
});

test('frontier-width breaches only while enough stories remain', async (t) => {
  const paths = home(t);
  const cards = (n, chain) =>
    Array.from({ length: n }, (_, i) => ({
      key: `s${i + 1}`,
      path: `s${i + 1}.md`,
      phase: null,
      blockedBy: chain && i > 0 ? [`s${i}`] : [],
    }));
  const source = (n) => ({ config: { graph: { phases: [{ name: 'launch' }] } }, cards: cards(n, true) });
  const pinched = await evaluateMetric('frontier-width', {
    paths,
    project: 'p',
    readSource: async () => source(7),
  });
  assert.equal(pinched.value, 1);
  assert.equal(pinched.eligible, true);
  const tail = await evaluateMetric('frontier-width', {
    paths,
    project: 'p',
    readSource: async () => source(3),
  });
  assert.equal(tail.eligible, false);
  const graphless = await evaluateMetric('frontier-width', {
    paths,
    project: 'p',
    readSource: async () => null,
  });
  assert.equal(graphless.eligible, false);
});

test('the frontier width reads one project\'s run history', async (t) => {
  // A story key is a project's own word. `q` shipped its own `s1`; `p` has
  // shipped nothing, so every card of `p` is still unfinished and its first
  // card is still the only launchable one. A history read across projects
  // would take `s1` off p's frontier and widen the reading to the two cards
  // behind it.
  const paths = home(t);
  writeLedger(runLedgerPath(paths, 'q1'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', {
      project: 'q',
      lane: 'story',
      storyKey: 's1',
    }),
    line(2, '2026-08-02T00:00:00Z', 'run-closed', { state: 'shipped' }),
  ]);
  const cards = Array.from({ length: 7 }, (_, i) => ({
    key: `s${i + 1}`,
    path: `s${i + 1}.md`,
    phase: null,
    blockedBy: i > 0 ? ['s1'] : [],
  }));
  const width = await evaluateMetric('frontier-width', {
    paths,
    project: 'p',
    readSource: async () => ({ config: { graph: { phases: [{ name: 'launch' }] } }, cards }),
  });
  assert.equal(width.value, 1);
  assert.equal(width.detail.unfinished, 7);
});

// -- the watcher --------------------------------------------------------------

function escapesFixture(paths, { counted }) {
  writeLedger(runLedgerPath(paths, 's1'), [
    line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
    line(2, '2026-08-02T00:00:00Z', 'merged', { sha: 'aaa' }),
  ]);
  writeLedger(
    paths.escapesLedger,
    Array.from({ length: counted }, (_, i) =>
      line(i + 1, `2026-08-03T00:0${i}:00Z`, 'escape-recorded', {
        category: 'product-escape',
        defectLine: `escape ${i + 1}`,
        detectionSource: 'human-report',
        attribution: 'unattributed',
        refs: { project: 'p' },
      }),
    ),
  );
}

const ESCAPES_TRIPWIRE = {
  id: 'escapes-ceiling',
  metric: 'escapes-window',
  window: 10,
  breach: { op: '>', value: 0.5 },
  answer: 'restore the cut',
};

// -- the workspace metrics ----------------------------------------------------
// Measured over five ships: 16 releases that did not clear their workspace,
// three of five ships blocked on their first release, and one directory that
// took six attempts across some twenty hours.

/** An instance ledger of releases: `false` for one that left its workspace. */
function releasesFixture(paths, outcomes, { project = 'p', extra = [] } = {}) {
  writeLedger(paths.instanceLedger, [
    ...outcomes.map((ok, i) =>
      line(i + 1, `2026-08-1${i}T00:00:00Z`, 'workspace-released', {
        project,
        runId: `r${i + 1}`,
        ok,
        ...(ok ? {} : { holders: [{ pid: 100 + i, name: 'node.exe' }] }),
      }),
    ),
    ...extra.map((e, i) => ({ ...e, seq: outcomes.length + i + 1 })),
  ]);
}

test('workspace-release-failures counts the failures in the release window', async (t) => {
  const paths = home(t);
  releasesFixture(paths, [false, true, false, false, true, false], {
    // Another project's failed releases never enter this one's window.
    extra: [
      line(0, '2026-08-20T00:00:00Z', 'workspace-released', {
        project: 'q',
        runId: 'x',
        ok: false,
      }),
    ],
  });
  const all = await evaluateMetric('workspace-release-failures', {
    paths,
    project: 'p',
    window: 10,
  });
  assert.equal(all.value, 4);
  assert.equal(all.eligible, true);
  assert.deepEqual(all.detail.runs, ['r1', 'r3', 'r4', 'r6']);
  // The image name on every failure is what the answer is read from.
  assert.deepEqual(all.detail.holders, ['node.exe']);
  // The window is the last N releases, not the last N of anything else.
  const recent = await evaluateMetric('workspace-release-failures', {
    paths,
    project: 'p',
    window: 2,
  });
  assert.equal(recent.value, 1);
  assert.equal(recent.detail.releases, 2);
  // A home that has released nothing for this project has nothing to say.
  const quiet = await evaluateMetric('workspace-release-failures', {
    paths,
    project: 'never',
    window: 10,
  });
  assert.equal(quiet.eligible, false);
});

test('workspace-leftover-age reads the oldest directory no release has cleared', async (t) => {
  const paths = home(t);
  const now = Date.parse('2026-08-20T12:00:00Z');
  writeLedger(paths.instanceLedger, [
    line(1, '2026-08-20T02:00:00Z', 'workspace-leftover', {
      project: 'p',
      runId: 'old',
      path: 'C:\\home\\worktrees\\old',
      reason: 'EBUSY',
    }),
    line(2, '2026-08-20T11:00:00Z', 'workspace-leftover', {
      project: 'p',
      runId: 'young',
      path: 'C:\\home\\worktrees\\young',
      reason: 'EBUSY',
    }),
    line(3, '2026-08-20T03:00:00Z', 'workspace-leftover', {
      project: 'q',
      runId: 'other',
      path: 'C:\\home\\worktrees\\other',
      reason: 'EBUSY',
    }),
  ]);
  const open = await evaluateMetric('workspace-leftover-age', { paths, project: 'p', now });
  // Ten hours: the oldest, because one directory nothing will ever release is
  // the condition and a second does not make it worse.
  assert.equal(open.value, 10);
  assert.equal(open.eligible, true);
  assert.deepEqual(open.detail, { open: 2, oldest: 'old' });

  // A record a sweep answered is not an open leftover any more.
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  ledger.resolve({ actor: 'daemon', resolves: 1, runId: 'old' });
  const after = await evaluateMetric('workspace-leftover-age', { paths, project: 'p', now });
  assert.equal(after.value, 1);
  assert.deepEqual(after.detail, { open: 1, oldest: 'young' });
});

test('a home with every workspace released says nothing about leftover age', async (t) => {
  const paths = home(t);
  releasesFixture(paths, [true, true]);
  const result = await evaluateMetric('workspace-leftover-age', { paths, project: 'p' });
  assert.equal(result.eligible, false);
  assert.equal(result.value, null);
});

test('the standing workspace tripwires fire on the evidence that set them', async (t) => {
  const paths = home(t);
  // Four failed releases in ten: the shape of the window that ran three of
  // five ships into a blocked first release.
  releasesFixture(paths, [false, true, false, false, true, false, true, true, true, true]);
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const watcher = new TripwireWatcher({ paths, ledger });
  const standing = standingTripwires()
    .filter((entry) => entry.metric.startsWith('workspace-'))
    .map(withTripwireDefaults);
  assert.equal(standing.length, 2);
  watcher.setRegistry('p', standing);

  await watcher.notify('p', { event: 'workspace-released' });
  const breaches = readEvents(paths.instanceLedger).filter((e) => e.event === 'tripwire-breach');
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].tripwire, 'workspace-release-failures');
  assert.equal(breaches[0].value, 4);
  assert.equal(breaches[0].window, 10);
  assert.match(breaches[0].answer, /holders/);
  assert.equal(openBreaches(paths).length, 1);
  // A release event of a project the watcher cannot key is counted by nobody.
  await watcher.notify(undefined, { event: 'workspace-released' });
  assert.equal(openBreaches(paths).length, 1);
});

test('a leftover the sweeps never clear breaches on its age', async (t) => {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const entry = withTripwireDefaults(
    standingTripwires().find((e) => e.metric === 'workspace-leftover-age'),
  );
  // One home per age, because the age of a record is the record's own ts and
  // nothing later rewrites it.
  const armed = (hours) => {
    const paths = home(t);
    writeLedger(paths.instanceLedger, [
      line(1, hoursAgo(hours), 'workspace-leftover', {
        project: 'p',
        runId: 'r1',
        path: 'C:\\home\\worktrees\\r1',
        reason: 'EBUSY',
        holders: [{ pid: 4242, name: 'node.exe' }],
      }),
    ]);
    const ledger = openInstanceStore(paths);
    t.after(() => ledger.close());
    const watcher = new TripwireWatcher({ paths, ledger });
    watcher.setRegistry('p', [entry]);
    return { paths, watcher };
  };

  // Under the band: a hold that passes clears in a sweep or two, and most do.
  const passing = armed(1);
  await passing.watcher.notify('p', { event: 'workspace-released' });
  assert.equal(openBreaches(passing.paths).length, 0);

  // Past it: a directory that outlived most of a day of sweeps is a hold no
  // sweep will ever reach, and the answer is a person.
  const stuck = armed(20);
  await stuck.watcher.notify('p', { event: 'workspace-released' });
  const breaches = readEvents(stuck.paths.instanceLedger).filter(
    (e) => e.event === 'tripwire-breach',
  );
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].tripwire, 'workspace-leftover-age');
  assert.ok(breaches[0].value > 4);
  assert.deepEqual(breaches[0].detail, { open: 1, oldest: 'r1' });
});

test('a breach opens once, stays open, and re-arms at resolution', async (t) => {
  const paths = home(t);
  escapesFixture(paths, { counted: 6 });
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const watcher = new TripwireWatcher({ paths, ledger });
  watcher.setRegistry('p', [ESCAPES_TRIPWIRE]);
  await watcher.notify('p', { event: 'escape-recorded' });
  let breaches = readEvents(paths.instanceLedger).filter((e) => e.event === 'tripwire-breach');
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].tripwire, 'escapes-ceiling');
  assert.equal(breaches[0].value, 0.6);
  assert.equal(breaches[0].answer, 'restore the cut');
  assert.equal(openBreaches(paths).length, 1);
  // open once: the same condition never stamps a second open breach
  await watcher.notify('p', { event: 'merged' });
  breaches = readEvents(paths.instanceLedger).filter((e) => e.event === 'tripwire-breach');
  assert.equal(breaches.length, 1);
  // re-arm at resolution: the next matching append evaluates fresh
  ledger.resolve({ actor: 'human', resolves: breaches[0].seq, note: 'restore executed' });
  assert.equal(openBreaches(paths).length, 0);
  await watcher.notify('p', { event: 'escape-recorded' });
  breaches = readEvents(paths.instanceLedger).filter((e) => e.event === 'tripwire-breach');
  assert.equal(breaches.length, 2);
});

test('the sixth verdict cycle of a run stamps, and the fifth does not', async (t) => {
  const paths = home(t);
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const watcher = new TripwireWatcher({ paths, ledger });
  watcher.setRegistry('p', [standingTripwires().find((e) => e.id === 'verdict-cycles')]);
  const judged = (cycles) =>
    writeLedger(runLedgerPath(paths, 'r1'), [
      line(1, '2026-08-01T00:00:00Z', 'run-launched', { project: 'p', lane: 'story' }),
      ...Array.from({ length: cycles }, (_, i) =>
        line(2 + i, `2026-08-01T0${i}:00:00Z`, 'verdict-rendered', { cycle: i + 1, verdict: 'red' }),
      ),
    ]);
  const breaches = () => readEvents(paths.instanceLedger).filter((e) => e.event === 'tripwire-breach');
  judged(5);
  await watcher.notify('p', { event: 'verdict-rendered' });
  assert.deepEqual(breaches(), []);
  judged(6);
  await watcher.notify('p', { event: 'verdict-rendered' });
  assert.equal(breaches().length, 1);
  assert.equal(breaches()[0].metric, 'verdict-cycles');
  assert.equal(breaches()[0].value, 6);
  assert.deepEqual(breaches()[0].detail, { runs: 1, run: 'r1' });
  assert.equal(openBreaches(paths).length, 1);
});

test('a non-matching event queues no evaluation; ineligible metrics never breach', async (t) => {
  const paths = home(t);
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const watcher = new TripwireWatcher({ paths, ledger });
  watcher.setRegistry('p', [ESCAPES_TRIPWIRE]);
  assert.equal(watcher.notify('p', { event: 'seat-progress' }), undefined);
  // zero ships: the window is empty, the metric is ineligible, no breach —
  // even under a comparator the empty rate would satisfy
  watcher.setRegistry('p', [{ ...ESCAPES_TRIPWIRE, breach: { op: '<', value: 1 } }]);
  await watcher.notify('p', { event: 'merged' });
  assert.equal(readEvents(paths.instanceLedger).filter((e) => e.event === 'tripwire-breach').length, 0);
});

test('the registry loads lazily from the reader and a failed read retries', async (t) => {
  const paths = home(t);
  escapesFixture(paths, { counted: 6 });
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  let calls = 0;
  const watcher = new TripwireWatcher({
    paths,
    ledger,
    readRegistry: async () => {
      calls++;
      if (calls === 1) throw new Error('no clone yet');
      return [ESCAPES_TRIPWIRE];
    },
  });
  await watcher.notify('p', { event: 'merged' });
  assert.equal(readEvents(paths.instanceLedger).filter((e) => e.event === 'tripwire-breach').length, 0);
  await watcher.notify('p', { event: 'merged' });
  assert.equal(readEvents(paths.instanceLedger).filter((e) => e.event === 'tripwire-breach').length, 1);
  // cached now: no further reads
  await watcher.notify('p', { event: 'merged' });
  assert.equal(calls, 2);
});

// -- baseline proposals -------------------------------------------------------

test('the 5th freeze stamps one kill-rate baseline proposal, queued', async (t) => {
  const paths = home(t);
  const kills = [3, 2, 3, 1, 2];
  kills.forEach((k, i) =>
    freezeRun(paths, `f${i + 1}`, 'p', `2026-08-0${i + 1}T00:00:00Z`, { kills: k }),
  );
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const watcher = new TripwireWatcher({ paths, ledger });
  await watcher.notify('p', { event: 'freeze' });
  const proposals = readEvents(paths.instanceLedger).filter((e) => e.event === 'baseline-proposal');
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].metric, 'kill-rate');
  assert.equal(proposals[0].observed.kills, 11);
  assert.equal(proposals[0].observed.waves, 15);
  // the band is a floor; the observed minimum opens the bid
  assert.deepEqual(proposals[0].suggested, { op: '<', value: Math.round((1 / 3) * 1000) / 1000 });
  assert.ok(openStreamItems(paths, 'queued').some((e) => e.event === 'baseline-proposal'));
  // stamped once per project and metric
  await watcher.notify('p', { event: 'freeze' });
  assert.equal(
    readEvents(paths.instanceLedger).filter((e) => e.event === 'baseline-proposal').length,
    1,
  );
});

test('before the 5th freeze no baseline proposal stamps', async (t) => {
  const paths = home(t);
  freezeRun(paths, 'f1', 'p', '2026-08-01T00:00:00Z', { kills: 2 });
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const watcher = new TripwireWatcher({ paths, ledger });
  await watcher.notify('p', { event: 'freeze' });
  assert.equal(
    readEvents(paths.instanceLedger).filter((e) => e.event === 'baseline-proposal').length,
    0,
  );
});

test('the 5th verdict stamps the per-lens yield baseline, zero-filled', async (t) => {
  const paths = home(t);
  for (let i = 1; i <= 5; i++) {
    writeLedger(runLedgerPath(paths, `v${i}`), [
      line(1, `2026-08-0${i}T00:00:00Z`, 'run-launched', { project: 'p', lane: 'story' }),
      line(2, `2026-08-0${i}T01:00:00Z`, 'finding', {
        cycle: 1,
        id: 'F1',
        lens: 'operational',
        severity: 'HIGH',
        confirmed: true,
      }),
      line(3, `2026-08-0${i}T02:00:00Z`, 'verdict-rendered', { cycle: 1, pass: 1, verdict: 'red' }),
    ]);
  }
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const watcher = new TripwireWatcher({ paths, ledger });
  await watcher.notify('p', { event: 'verdict-rendered' });
  const proposals = readEvents(paths.instanceLedger).filter((e) => e.event === 'baseline-proposal');
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].metric, 'fury-lens-yield');
  assert.equal(proposals[0].observed.verdicts, 5);
  assert.equal(proposals[0].observed.byLens.operational, 5);
  // a zero-yield lens shows as zero — that lens is the cut candidate
  assert.equal(proposals[0].observed.byLens.interface, 0);
});

// -- wiring -------------------------------------------------------------------

test('every run-store append reaches the event hook, project-attributed', async (t) => {
  const paths = home(t);
  const seen = [];
  const engine = new RunEngine(paths, {
    getSlotCap: () => 2,
    onEvent: (project, l) => seen.push({ project, event: l.event }),
  });
  t.after(() => engine.stop());
  engine.registerLane('t', {
    stages: ['s'],
    handlers: { s: async () => ({ close: { state: 'failed' } }) },
  });
  engine.launch({ runId: 'w1', project: 'p', lane: 't' });
  await waitFor(() => seen.some((e) => e.event === 'run-closed'), { label: 'run close hook' });
  assert.ok(seen.every((e) => e.project === 'p'));
  assert.deepEqual(
    seen.map((e) => e.event),
    ['run-launched', 'stage-entered', 'run-closed'],
  );
});

test('an escapes store opened with the hook feeds the same key', (t) => {
  const paths = home(t);
  const seen = [];
  const store = openEscapesStore(paths, { onAppend: (l) => seen.push(l.event) });
  t.after(() => store.close());
  recordEscape(store, {
    actor: 'daemon',
    category: 'product-escape',
    defectLine: 'x',
    detectionSource: 'human-report',
  });
  assert.deepEqual(seen, ['escape-recorded']);
});

test('a failing hook never fails the append', (t) => {
  const paths = home(t);
  const store = openInstanceStore(paths, {
    onAppend: () => {
      throw new Error('hook exploded');
    },
  });
  t.after(() => store.close());
  const l = store.append('launch', { actor: 'daemon', runId: 'r1', project: 'p', lane: 'story' });
  assert.equal(l.seq, 1);
});

// -- the two operator levers (ADR-0061, ADR-0062) ----------------------------

/** A run ledger of one project holding whatever events a test needs after it. */
function runWith(paths, runId, project, ts, events = []) {
  writeLedger(runLedgerPath(paths, runId), [
    line(1, ts, 'run-launched', { project, lane: 'story' }),
    ...events.map((e, i) => line(2 + i, ts, e.event, e)),
  ]);
}

test('gate-acks-window counts the gates walked past, and names them', async (t) => {
  const paths = home(t);
  runWith(paths, 'r1', 'p', '2026-08-01T00:00:00Z', [
    { event: 'gate-acknowledged', gate: 'credential-surface', reason: 'retired surface' },
  ]);
  runWith(paths, 'r2', 'p', '2026-08-02T00:00:00Z');
  runWith(paths, 'r3', 'p', '2026-08-03T00:00:00Z', [
    { event: 'gate-acknowledged', gate: 'credential-probe:payments', reason: 'stale probe' },
    { event: 'gate-acknowledged', gate: 'substrate-probe', reason: 'one family by design' },
  ]);
  // Another project's acks are not this project's.
  runWith(paths, 'o1', 'other', '2026-08-04T00:00:00Z', [
    { event: 'gate-acknowledged', gate: 'substrate-probe', reason: 'theirs' },
  ]);
  const all = await evaluateMetric('gate-acks-window', { paths, project: 'p', window: 10 });
  assert.equal(all.value, 3);
  assert.equal(all.eligible, true);
  assert.equal(all.detail.runs, 3);
  assert.deepEqual(all.detail.gates, [
    'credential-probe:payments',
    'credential-surface',
    'substrate-probe',
  ]);
  assert.deepEqual(all.detail.acked.sort(), ['r1', 'r3']);
  // The window is the last N runs in launch order: the oldest ack leaves it.
  const narrow = await evaluateMetric('gate-acks-window', { paths, project: 'p', window: 2 });
  assert.equal(narrow.value, 2);
  assert.deepEqual(narrow.detail.acked, ['r3']);
  // A project with no run at all is no reading.
  const cold = await evaluateMetric('gate-acks-window', { paths, project: 'none', window: 10 });
  assert.equal(cold.eligible, false);
});

test('the standing ack band holds one in ten runs and breaches on the second', async (t) => {
  const paths = home(t);
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const watcher = new TripwireWatcher({ paths, ledger });
  watcher.setRegistry('p', [
    withTripwireDefaults(standingTripwires().find((e) => e.id === 'gate-acks')),
  ]);
  const breaches = () =>
    readEvents(paths.instanceLedger).filter((e) => e.event === 'tripwire-breach');

  // Nine ordinary runs and one gate somebody was wrong about.
  for (let i = 1; i <= 9; i++) runWith(paths, `q${i}`, 'p', `2026-08-0${i}T00:00:00Z`);
  runWith(paths, 'q10', 'p', '2026-08-10T00:00:00Z', [
    { event: 'gate-acknowledged', gate: 'substrate-probe', reason: 'one family by design' },
  ]);
  await watcher.notify('p', { event: 'gate-acknowledged' });
  assert.deepEqual(breaches(), [], 'one gate in ten runs is an exception');

  // A second one inside the same window is a habit, and the band says so.
  runWith(paths, 'q11', 'p', '2026-08-11T00:00:00Z', [
    { event: 'gate-acknowledged', gate: 'substrate-probe', reason: 'again' },
  ]);
  await watcher.notify('p', { event: 'gate-acknowledged' });
  assert.equal(breaches().length, 1);
  const breach = breaches()[0];
  assert.equal(breach.tripwire, 'gate-acks');
  assert.equal(breach.value, 2);
  assert.match(breach.answer, /a gate to repair/);
  assert.deepEqual(breach.detail.gates, ['substrate-probe']);
});

test('run-reconfigures-window counts the runs repinned, never the repins', async (t) => {
  const paths = home(t);
  runWith(paths, 'r1', 'p', '2026-08-01T00:00:00Z', [
    { event: 'run-reconfigured', configBlob: 'aaa', reason: 'first' },
    { event: 'run-reconfigured', configBlob: 'bbb', reason: 'a correction of the first' },
  ]);
  runWith(paths, 'r2', 'p', '2026-08-02T00:00:00Z');
  const one = await evaluateMetric('run-reconfigures-window', { paths, project: 'p', window: 10 });
  // One run whose launch pin was wrong, not two faults.
  assert.equal(one.value, 1);
  assert.deepEqual(one.detail.repinned, ['r1']);
  assert.equal(one.detail.runs, 2);
  const cold = await evaluateMetric('run-reconfigures-window', {
    paths,
    project: 'none',
    window: 10,
  });
  assert.equal(cold.eligible, false);
});

test('the standing repin band breaches on the second run in the window', async (t) => {
  const paths = home(t);
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const watcher = new TripwireWatcher({ paths, ledger });
  watcher.setRegistry('p', [
    withTripwireDefaults(standingTripwires().find((e) => e.id === 'run-reconfigures')),
  ]);
  const breaches = () =>
    readEvents(paths.instanceLedger).filter((e) => e.event === 'tripwire-breach');
  runWith(paths, 'r1', 'p', '2026-08-01T00:00:00Z', [
    { event: 'run-reconfigured', configBlob: 'aaa', reason: 'the config moved under a long run' },
  ]);
  await watcher.notify('p', { event: 'run-reconfigured' });
  assert.deepEqual(breaches(), []);
  runWith(paths, 'r2', 'p', '2026-08-02T00:00:00Z', [
    { event: 'run-reconfigured', configBlob: 'bbb', reason: 'and again' },
  ]);
  await watcher.notify('p', { event: 'run-reconfigured' });
  assert.equal(breaches().length, 1);
  assert.equal(breaches()[0].tripwire, 'run-reconfigures');
  assert.match(breaches()[0].answer, /pinning a config its own runs cannot use/);
  assert.deepEqual(breaches()[0].detail.repinned, ['r1', 'r2']);
});
