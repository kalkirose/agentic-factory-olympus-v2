// Command center: the derived snapshot and the read-only GET server. The
// fixture home seeds every section — runs (live, parked, shipped), loud
// items, the queue, escapes, a breach, and a graph-backed project clone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  live.append('seat-spawned', { actor: 'daemon', seat: 'dev-1', model: 'model-a', effort: 'xhigh' });
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
    options: ['card', 'shipped-spec'],
    gist: 'intent-conflict: s-4',
  });
  parked.close();

  const escapes = openEscapesStore(paths);
  recordEscape(escapes, {
    actor: ACTOR,
    category: 'product-escape',
    defectLine: 'checkout drops the coupon',
    detectionSource: 'human-report',
  });
  recordEscape(escapes, {
    actor: ACTOR,
    category: 'chore',
    defectLine: 'flaky harness fixture',
    detectionSource: 'harness-self',
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
  assert.deepEqual(liveRun.seats, [{ seat: 'dev-1', model: 'model-a', effort: 'xhigh' }]);
  assert.deepEqual(liveRun.repair, { pass: 1, round: 1 });
  assert.equal(liveRun.lastEvent.event, 'gate-integrity');
  const parkedRun = s.runs.find((r) => r.runId === 'r-parked');
  assert.equal(parkedRun.parked, true);
  assert.equal(parkedRun.parkType, 'intent-conflict');

  // health
  assert.equal(s.health.openEscapes, 1);
  assert.equal(s.health.gateIntegrityOpen, 1);
  const health = s.health.byProject[0];
  assert.equal(health.project, 'alpha');
  // Both escapes fall inside the 2-ship window; only product-escape counts.
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
  assert.deepEqual(
    health.tripwires.wires.map((w) => [w.id, w.state]),
    [
      ['escapes-ceiling', 'armed'],
      ['ci-critical-path-p50', 'breach'],
    ],
  );
  // s-3 open, s-4 open, s-5 blocked by unshipped s-3 → width counts
  // blocker-free unshipped cards: s-3 and s-4.
  assert.deepEqual(health.frontier, { width: 2, unfinished: 3, launchable: 0 });
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
