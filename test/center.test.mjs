// Command center: the derived snapshot and the read-only GET server. The
// fixture home seeds every section — runs (live, parked, shipped), loud
// items, the queue, escapes, a breach, and a graph-backed project clone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import {
  openRunStore,
  openInstanceStore,
  openEscapesStore,
  archiveRun,
} from '../src/telemetry/stores.mjs';
import { recordEscape, fixEscape } from '../src/telemetry/escapes.mjs';
import { ensureBareClone } from '../src/isolation/clones.mjs';
import { buildSnapshot, LANE_STAGES } from '../src/center/snapshot.mjs';
import { CRASH_RETRIES } from '../src/seats/runner.mjs';
import { createCenterServer } from '../src/center/server.mjs';
import { tempDir, removeDir, initOriginRepo, projectConfigJson } from './helpers.mjs';

const ACTOR = 'test';
const T = (minutes) => new Date(Date.parse('2026-01-01T00:00:00Z') + minutes * 60_000);
const NOW = T(24 * 60);

function card(key, blockedBy = []) {
  return `---\nkey: ${key}\nphase: launch\nblocked-by: [${blockedBy.join(', ')}]\n---\n\n# ${key}\n`;
}

/** One shipped story run with freeze, checks, and merge, `runId` archived. */
function seedShippedRun(paths, runId, storyKey, { start, hours, archived = false }) {
  const store = openRunStore(paths, runId);
  const at = (m) => T(start + m).toISOString();
  const stamp = (event, minutes, fields = {}) => {
    const line = store.append(event, { actor: ACTOR, ...fields });
    patchTs(paths, runId, line.seq, at(minutes));
  };
  stamp('run-launched', 0, { project: 'alpha', lane: 'story', storyKey });
  const stages = LANE_STAGES.story;
  stages.forEach((stage, i) => stamp('stage-entered', i * 10, { stage }));
  stamp('adversary-wave', 41, { round: 1, wave: 1, phase: 'initial', result: 'killed', sha: 'a' });
  stamp('adversary-wave', 42, { round: 1, wave: 2, phase: 'initial', result: 'killed', sha: 'b' });
  stamp('freeze', 50, { sha: 'f'.repeat(40), killCount: 2, amendmentKills: 0, dispositions: 0, files: 3 });
  stamp('pr-opened', hours * 60 - 38, { pr: 7, url: 'x', branch: `run/${runId}`, base: 'main', sha: 'c1', required: ['ci'], autoMerge: 'squash' });
  stamp('check-transition', hours * 60 - 10, { name: 'ci', sha: 'c1', status: 'success', duration: 22 * 60_000 });
  stamp('merged', hours * 60, { pr: 7, sha: 'c1', mergeSha: 'm1', red: false });
  stamp('run-closed', hours * 60 + 1, { state: 'shipped' });
  store.close();
  if (archived) archiveRun(paths, runId);
}

// The ledger stamps wall-clock ts at append; the fixture rewrites ts lines
// to place events in a known history. Seq and order stay untouched.
function patchTs(paths, runId, seq, ts) {
  const path = runLedgerPath(paths, runId);
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    const parsed = JSON.parse(line);
    if (parsed.seq === seq) parsed.ts = ts;
    return JSON.stringify(parsed);
  });
  writeFileSync(path, lines.join('\n') + '\n');
}

function seededHome(t, { withClone = false } = {}) {
  const root = tempDir();
  t.after(() => removeDir(root));
  const paths = scaffoldHome(join(root, 'home'));
  const origin = join(root, 'origin');
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({
      version: 1,
      semaphores: { 'model-a': 4 },
      projects: { alpha: { repoUrl: origin, slotCap: 3 } },
    }) + '\n',
  );

  const instance = openInstanceStore(paths);
  instance.append('arming-changed', { actor: 'human', project: 'alpha', armed: true });
  instance.append('tripwire-breach', {
    actor: 'tripwire-watcher',
    project: 'alpha',
    tripwire: 'ci-critical-path-p50',
    metric: 'ci-critical-path',
    value: 26.4,
    breach: { op: '>', value: 25 },
    answer: 'review the check set',
    gist: 'tripwire ci-critical-path-p50: 26.4 > 25 (alpha)',
  });
  instance.close();

  // Two shipped runs (one archived), one live run mid-verdict, one parked.
  seedShippedRun(paths, 'r-ship-1', 's-1', { start: 0, hours: 3.4, archived: true });
  seedShippedRun(paths, 'r-ship-2', 's-2', { start: 300, hours: 2.8 });

  const live = openRunStore(paths, 'r-live');
  live.append('run-launched', { actor: ACTOR, project: 'alpha', lane: 'story', storyKey: 's-3' });
  live.append('stage-entered', { actor: ACTOR, stage: 'verdict' });
  live.append('seat-spawned', { actor: 'daemon', seat: 'dev-1', model: 'model-a', effort: 'high' });
  live.append('repair-round', { actor: ACTOR, pass: 1, round: 1, sha: 'd1', openBefore: ['F1'] });
  live.append('gate-integrity', {
    actor: ACTOR,
    findingId: 'F9',
    detail: 'dev seat wrote a frozen suite path',
    gist: 'gate-integrity: frozen suite path written by a dev seat',
  });
  live.close();

  const parked = openRunStore(paths, 'r-parked');
  parked.append('run-launched', { actor: ACTOR, project: 'alpha', lane: 'story', storyKey: 's-4' });
  parked.append('stage-entered', { actor: ACTOR, stage: 'spec-gate' });
  parked.append('park', {
    actor: ACTOR,
    type: 'intent-conflict',
    question: 'Which intent stands?',
    answers: { options: ['card', 'shipped-spec', 'abandon'] },
    gist: 'intent-conflict: s-4',
  });
  parked.close();

  const escapes = openEscapesStore(paths);
  recordEscape(escapes, {
    actor: ACTOR,
    category: 'product-escape',
    defectLine: 'checkout drops the coupon',
    detectionSource: 'human-report',
    refs: { project: 'alpha' },
  });
  recordEscape(escapes, {
    actor: ACTOR,
    category: 'chore',
    defectLine: 'flaky harness fixture',
    detectionSource: 'harness-self',
    refs: { project: 'alpha' },
  });
  // A second project's defect. The instance tile counts it; alpha's quality
  // bar may not, because a breach there names alpha's ceiling for work that is
  // in another repository.
  recordEscape(escapes, {
    actor: ACTOR,
    category: 'product-escape',
    defectLine: 'the other project loses a row',
    detectionSource: 'human-report',
    refs: { project: 'beta' },
  });
  fixEscape(escapes, {
    actor: ACTOR,
    fixes: 2,
    category: 'chore',
    attribution: 'harness',
    refs: { pr: 9, runId: 'r-fix' },
  });
  escapes.close();

  if (withClone) {
    initOriginRepo(origin, {
      '.olympus/project.json': projectConfigJson({
        graph: { cardsDir: 'cards', phases: [{ name: 'launch' }] },
        tripwires: [
          { id: 'escapes-ceiling', metric: 'escapes-window', breach: { op: '>', value: 0.5 }, answer: 'restore the cut gate' },
          { id: 'ci-critical-path-p50', metric: 'ci-critical-path', breach: { op: '>', value: 25 }, answer: 'review the check set' },
        ],
      }),
      'cards/s-3.md': card('s-3'),
      'cards/s-4.md': card('s-4'),
      'cards/s-5.md': card('s-5', ['s-3']),
    });
  }
  return { root, paths, origin };
}

test('snapshot derives every section from the files alone', async (t) => {
  const { paths } = seededHome(t);
  const s = await buildSnapshot(paths, { now: NOW });

  assert.equal(s.daemon.running, false);
  assert.ok(s.instanceSeq >= 2);

  // chips
  assert.deepEqual(s.projects.map((p) => p.name), ['alpha']);
  assert.equal(s.projects[0].armed, true);
  assert.equal(s.projects[0].slotCap, 3);
  assert.equal(s.projects[0].slotsBusy, 1); // r-live; r-parked freed its slot
  assert.deepEqual(s.semaphores, [{ model: 'model-a', max: 4, inFlight: 1 }]);

  // loud + queue
  assert.equal(s.loud.length, 1);
  assert.equal(s.loud[0].event, 'gate-integrity');
  const queueEvents = s.queue.map((q) => q.event).sort();
  assert.deepEqual(queueEvents, ['park', 'tripwire-breach']);
  const park = s.queue.find((q) => q.event === 'park');
  assert.equal(park.type, 'intent-conflict');
  assert.equal(park.question, 'Which intent stands?');
  assert.equal(park.storyKey, 's-4');

  // runs
  assert.equal(s.runs.length, 2);
  const liveRun = s.runs.find((r) => r.runId === 'r-live');
  assert.equal(liveRun.stage, 'verdict');
  assert.deepEqual(liveRun.stages, LANE_STAGES.story);
  assert.deepEqual(liveRun.seats, [{ seat: 'dev-1', model: 'model-a', effort: 'high' }]);
  assert.deepEqual(liveRun.repair, { pass: 1, round: 1 });
  assert.equal(liveRun.lastEvent.event, 'gate-integrity');
  const parkedRun = s.runs.find((r) => r.runId === 'r-parked');
  assert.equal(parkedRun.parked, true);
  assert.equal(parkedRun.parkType, 'intent-conflict');

  // health
  // The instance tile counts every open escape of the home, both projects.
  assert.equal(s.health.openEscapes, 2);
  assert.equal(s.health.gateIntegrityOpen, 1);
  const health = s.health.byProject[0];
  assert.equal(health.project, 'alpha');
  // All three escapes fall inside the 2-ship window. Only alpha's
  // product-escape counts: the chore is not a counted category, and the third
  // is another project's defect.
  assert.equal(health.escapes.counted, 1);
  assert.equal(health.escapes.rate, 0.1);
  assert.deepEqual(
    { kills: health.killRate.kills, waves: health.killRate.waves },
    { kills: 2, waves: 2 },
  );
  assert.equal(health.tripwires.registryRead, false);
  // The open breach shows even while the registry is unread.
  assert.deepEqual(health.tripwires.wires.map((w) => [w.id, w.state]), [
    ['ci-critical-path-p50', 'breach'],
  ]);
  assert.equal(health.frontier, null);

  // stats
  assert.equal(s.stats.ships.length, 2);
  assert.deepEqual(s.stats.ships.map((x) => x.storyKey), ['s-1', 's-2']);
  assert.equal(s.stats.medianHours, 3.1);
  assert.equal(s.stats.greenShipP50Minutes, 38);
  assert.equal(s.stats.ciCriticalPathP50Minutes, 22);
  const stageNames = s.stats.stageMedians.map((m) => m.stage);
  assert.ok(stageNames.includes('adversary'));
  assert.ok(stageNames.indexOf('readiness') < stageNames.indexOf('verdict'));

  // tail: newest first, loud flagged
  assert.ok(s.tail.length > 5);
  assert.ok(s.tail[0].ts >= s.tail.at(-1).ts);
  const loudLine = s.tail.find((l) => l.event === 'gate-integrity');
  assert.equal(loudLine.loud, true);
  assert.match(loudLine.detail, /frozen suite path/);
});

test('snapshot reads registry and frontier from the clone, no fetch', async (t) => {
  const { paths, origin } = seededHome(t, { withClone: true });
  await ensureBareClone(paths, 'alpha', origin, 'main');
  const s = await buildSnapshot(paths, { now: NOW });
  const health = s.health.byProject[0];
  assert.equal(health.tripwires.registryRead, true);
  // The two the project wrote, plus the six counters the harness arms on every
  // project: the levers an operator can pull on any run (ADR-0061, ADR-0062),
  // and the four readings of the record rule (ADR-0007, ADR-0026, ADR-0075).
  assert.deepEqual(
    health.tripwires.wires.map((w) => [w.id, w.state]),
    [
      ['escapes-ceiling', 'armed'],
      ['ci-critical-path-p50', 'breach'],
      ['gate-acks', 'armed'],
      ['run-reconfigures', 'armed'],
      ['record-refuted-share', 'armed'],
      ['reconcile-fallbacks', 'armed'],
      ['record-cycles', 'armed'],
      ['record-write-time', 'armed'],
    ],
  );
  // s-3 open, s-4 open, s-5 blocked by unshipped s-3 → width counts
  // blocker-free unshipped cards: s-3 and s-4.
  assert.deepEqual(health.frontier, { width: 2, unfinished: 3, launchable: 0 });
});

// -- the record tree ----------------------------------------------------------

const REC = (minutes) =>
  new Date(Date.parse('2026-02-01T00:00:00Z') + minutes * 60_000).toISOString();

/** One run ledger, written whole, so a fixture can state its own history. */
function writeRunLedger(paths, runId, lines) {
  const path = runLedgerPath(paths, runId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

/**
 * A run that went through the record stage twice: two cycles to green, a
 * re-run over a moved base, one recheck, and one write that missed a unit.
 * Every number the section reports is stated here.
 */
function seedRecordRun(paths) {
  let seq = 0;
  const line = (minutes, event, fields = {}) => ({
    seq: ++seq,
    ts: REC(minutes),
    event,
    actor: ACTOR,
    ...fields,
  });
  writeRunLedger(paths, 'r-rec', [
    line(0, 'run-launched', { project: 'alpha', lane: 'story', storyKey: 's-rec' }),
    line(5, 'reconciliation-judged', {
      ok: true,
      owed: true,
      records: ['docs/adr/a.md', 'docs/adr/b.md'],
      born: ['docs/adr/a.md'],
      late: ['docs/adr/b.md'],
    }),
    line(60, 'stage-entered', { stage: 'reconcile' }),
    line(65, 'seat-spawned', { seat: 'reconcile-write:1', model: 'model-a' }),
    line(75, 'reconciliation-written', {
      ok: true,
      records: [{ record: 'docs/adr/a.md', seat: 'reconcile-write:1', cost: 1, attempts: 1 }],
      active: 12,
      supersededCount: 1,
      split: 2,
      merged: 0,
    }),
    line(76, 'record-units', {
      seat: 'reconcile-write:1',
      cycle: 4,
      record: 'docs/adr/a.md',
      units: [
        { id: 'U1', kind: 'claim', verdict: 'holds', evidence: 'src/a.mjs' },
        { id: 'U2', kind: 'claim', verdict: 'holds', evidence: 'src/b.mjs' },
        { id: 'U3', kind: 'open', verdict: 'not-built' },
      ],
      counts: { claims: 2, holds: 2, fails: 0, notBuilt: 1 },
      neighbours: 3,
      neighboursDropped: 0,
      cost: 1.2,
    }),
    line(80, 'layer-result', { cycle: 4, layer: 'adr-form', status: 'green', elapsedMs: 120_000 }),
    line(85, 'finding', {
      cycle: 4,
      id: 'F1',
      lens: 'record',
      record: true,
      file: 'docs/adr/a.md',
      unit: 'U1',
      head: 'the public surface is exactly two',
      confirmed: true,
    }),
    line(86, 'finding', {
      cycle: 4,
      id: 'F2',
      lens: 'record',
      record: true,
      file: 'docs/adr/a.md',
      unit: 'U3',
      head: 'the second route is not yet built',
      confirmed: true,
    }),
    line(90, 'reconcile-rendered', {
      cycle: 4,
      sha: 'r1',
      verdict: 'red',
      open: ['F1', 'F2'],
      records: ['docs/adr/a.md'],
      layers: ['adr-form'],
    }),
    line(95, 'reconcile-round', { round: 1, records: ['docs/adr/a.md'], findings: ['F1', 'F2'] }),
    line(100, 'seat-spawned', { seat: 'reconcile-write:1', model: 'model-a' }),
    line(110, 'reconciliation-written', {
      ok: true,
      records: [{ record: 'docs/adr/a.md', seat: 'reconcile-write:1', cost: 1, attempts: 1 }],
      active: 13,
      supersededCount: 0,
      split: 0,
      merged: 0,
    }),
    line(115, 'layer-result', { cycle: 5, layer: 'adr-form', status: 'green', elapsedMs: 60_000 }),
    line(120, 'reconcile-rendered', {
      cycle: 5,
      sha: 'r2',
      verdict: 'green',
      open: [],
      records: ['docs/adr/a.md'],
      layers: ['adr-form'],
    }),
    line(125, 'stage-entered', { stage: 'update' }),
    line(130, 'pre-verdict-update', {
      pass: 1,
      ran: true,
      code: { answer: 'kept', files: [] },
      records: { answer: 'rerun', files: ['docs/adr/x.md'] },
    }),
    line(135, 'stage-entered', { stage: 'reconcile' }),
    line(140, 'reconcile-rendered', {
      cycle: 6,
      sha: 'r3',
      verdict: 'green',
      open: [],
      records: ['docs/adr/a.md'],
      layers: [],
    }),
    line(150, 'reconcile-recheck', { delta: 'aaa..bbb', units: [], judge: 'none', result: 'kept' }),
  ]);
}

test('the records section derives its eight measures from the ledger', async (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const paths = scaffoldHome(join(root, 'home'));
  // The harness pin, stamped before the run. Every render after it is read in
  // the new shape.
  writeFileSync(
    paths.instanceLedger,
    JSON.stringify({
      seq: 1,
      ts: REC(-60),
      event: 'daemon-started',
      actor: 'daemon',
      pid: 1,
      runsResumed: 0,
      harnessSha: 'abc',
    }) + '\n',
  );
  seedRecordRun(paths);

  const s = await buildSnapshot(paths, { now: NOW });
  const r = s.stats.records;
  assert.equal(r.runs, 1);
  // Two stage runs: two cycles to green, then one for the re-run.
  assert.deepEqual(r.cycles, { mean: 1.5, reconciliations: 2, worst: 2 });
  // Two units the writer said hold; the review found one of them false.
  assert.deepEqual(r.writerMiss, {
    holds: 2,
    missed: 1,
    rate: 0.5,
    records: ['docs/adr/a.md'],
  });
  assert.deepEqual(r.late, { born: 1, late: 1, share: 0.5 });
  assert.deepEqual(r.movedTree, { updates: 1, rejudged: 0, rerun: 1, both: 0, neither: 0 });
  assert.deepEqual(r.recheck, { rechecks: 1, answered: 0, yield: 0 });
  // Two minutes of layers on the first render, one on the second; the third
  // ran no layer and is no reading.
  assert.deepEqual(r.gateMinutes, { renders: 2, mean: 1.5 });
  // The first write seat to the last write stamp of that stage run.
  assert.deepEqual(r.writeMinutes, { mean: 45, writes: 1, longest: 45 });
  assert.deepEqual(
    r.tree.map((e) => [e.active, e.superseded, e.split, e.merged]),
    [
      [12, 1, 2, 0],
      [13, 0, 0, 0],
    ],
  );
});

test('a home with no record stamp reports the section empty, never zero', async (t) => {
  const { paths } = seededHome(t);
  const r = (await buildSnapshot(paths, { now: NOW })).stats.records;
  assert.equal(r.runs, 0);
  assert.equal(r.cycles.mean, null);
  assert.equal(r.writerMiss.rate, null);
  assert.equal(r.late.share, null);
  assert.equal(r.recheck.yield, null);
  assert.equal(r.gateMinutes.mean, null);
  assert.equal(r.writeMinutes.mean, null);
  assert.deepEqual(r.tree, []);
});

test('a seat chip carries the retry ordinal, a first spawn carries none', async (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const paths = scaffoldHome(join(root, 'home'));
  const store = openRunStore(paths, 'r-retry');
  const spawn = (seat, fields = {}) =>
    store.append('seat-spawned', {
      actor: 'daemon',
      seat,
      model: 'model-a',
      effort: 'high',
      attempt: 1,
      ...fields,
    });
  store.append('run-launched', { actor: ACTOR, project: 'alpha', lane: 'story', storyKey: 's-9' });
  store.append('stage-entered', { actor: ACTOR, stage: 'implementation' });
  spawn('dev-1');
  spawn('fury-1');
  // The crash-retry cycle: the dying child stamps its evidence, then the
  // retry spawns into the session it named.
  store.append('seat-failure', { actor: 'daemon', seat: 'dev-1', reason: 'exit', code: 1 });
  spawn('dev-1', { retry: 2, resumed: true, session: 'sess-1' });
  store.close();

  const s = await buildSnapshot(paths, { now: NOW });
  const { seats } = s.runs.find((r) => r.runId === 'r-retry');
  assert.deepEqual(seats.find((x) => x.seat === 'dev-1'), {
    seat: 'dev-1',
    model: 'model-a',
    effort: 'high',
    retry: 2,
    retryMax: CRASH_RETRIES,
    resumed: true,
  });
  assert.deepEqual(seats.find((x) => x.seat === 'fury-1'), {
    seat: 'fury-1',
    model: 'model-a',
    effort: 'high',
  });
  // Both seats hold a slot on the model: the retry replaced the drop.
  assert.deepEqual(s.semaphores, [{ model: 'model-a', max: null, inFlight: 2 }]);
});

test('a held run reads as held, and it keeps the slot it holds', async (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { alpha: { repoUrl: 'unused', slotCap: 3 } } }) + '\n',
  );
  const instance = openInstanceStore(paths);
  instance.append('hold-changed', { actor: 'human', project: 'alpha', held: true });
  instance.close();
  const store = openRunStore(paths, 'r-held');
  store.append('run-launched', { actor: ACTOR, project: 'alpha', lane: 'story', storyKey: 's-8' });
  store.append('stage-entered', { actor: ACTOR, stage: 'verdict' });
  store.append('stage-held', { actor: ACTOR, stage: 'verdict', next: 'update' });
  store.close();

  const s = await buildSnapshot(paths, { now: NOW });
  const run = s.runs.find((r) => r.runId === 'r-held');
  assert.equal(run.held, true);
  assert.equal(run.heldNext, 'update');
  assert.equal(run.parked, false);
  const project = s.projects.find((p) => p.name === 'alpha');
  assert.equal(project.held, true);
  assert.equal(project.slotsBusy, 1);
});

// -- server -------------------------------------------------------------------

async function startServer(t, home) {
  const server = createCenterServer(home);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('server serves the page, the snapshot, and raw state files', async (t) => {
  const { root, paths } = seededHome(t);
  const base = await startServer(t, join(root, 'home'));

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /Command Center/);
  assert.match(html, /snapshot\.json/);
  // The seat chip renders the retry ordinal the snapshot carries.
  assert.match(html, /" · retry " \+ seat\.retry \+ "\/" \+ seat\.retryMax/);

  const snapshot = await (await fetch(`${base}/snapshot.json`)).json();
  assert.equal(snapshot.home, paths.home);
  assert.equal(snapshot.runs.length, 2);

  const ledger = await fetch(`${base}/state/instance.ledger.jsonl`);
  assert.equal(ledger.status, 200);
  assert.match(await ledger.text(), /arming-changed/);

  const listing = await (await fetch(`${base}/state/runs`)).json();
  assert.deepEqual(
    listing.filter((e) => e.type === 'dir').map((e) => e.name).sort(),
    ['r-live', 'r-parked', 'r-ship-2'],
  );
});

test('server is GET-only and path-guarded', async (t) => {
  const { root } = seededHome(t);
  writeFileSync(join(root, 'outside.txt'), 'secret');
  const base = await startServer(t, join(root, 'home'));

  assert.equal((await fetch(`${base}/snapshot.json`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/state/instance.ledger.jsonl`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/state/missing.jsonl`)).status, 404);

  for (const escape of [
    '/state/../outside.txt',
    '/state/%2e%2e/outside.txt',
    '/state/..%2foutside.txt',
    '/state/..%5coutside.txt',
  ]) {
    const res = await fetch(`${base}${escape}`);
    assert.notEqual(res.status, 200, `escaped the home root: ${escape}`);
    if (res.status === 403) continue;
    // Some URL forms normalize before they reach the server; those must 404
    // inside the root, never serve the outside file.
    assert.notEqual(await res.text(), 'secret');
  }
});
