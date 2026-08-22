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
import { standingTripwires, withTripwireDefaults } from '../src/tripwires/registry.mjs';
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
    }),
    ...[2, 3, 4, 5, 6, 7].map((seq) =>
      line(seq, `2026-08-03T0${seq}:00:00Z`, 'escape-recorded', {
        category: seq === 7 ? 'chore' : 'product-escape',
        defectLine: `escape ${seq}`,
        detectionSource: 'human-report',
        attribution: 'unattributed',
      }),
    ),
  ]);
  const result = await evaluateMetric('escapes-window', { paths, project: 'p', window: 10 });
  // five counted (the chore and the pre-ship record stay out) over window 10
  assert.equal(result.value, 0.5);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.detail, { ships: 1, counted: 5 });
  const empty = await evaluateMetric('escapes-window', { paths, project: 'r', window: 10 });
  assert.equal(empty.eligible, false);
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
