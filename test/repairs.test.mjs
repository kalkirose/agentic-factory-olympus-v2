// The frontier's repair pass: the owed set derived from the escapes ledger
// and the repair runs' own launch stamps, the launch order against the story
// frontier, the slot-blocked retry, the paused project's loud stamp, and the
// restart that owes nothing twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, repairTicketPath } from '../src/daemon/home.mjs';
import { openEscapesStore } from '../src/telemetry/stores.mjs';
import { recordEscape, ticketEscape, fixEscape } from '../src/telemetry/escapes.mjs';
import { owedRepairs } from '../src/frontier/repairs.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { readStreamIndex } from '../src/telemetry/streams.mjs';
import {
  tempDir,
  removeDir,
  waitFor,
  initOriginRepo,
  projectConfigJson,
  fakeComposeRunner,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';
const WAIT = { attempts: 300, intervalMs: 100 };

function cardFile(key) {
  return ['---', `key: ${key}`, `title: Story ${key}`, '---', '', `Intent for ${key}.`, ''].join('\n');
}

/** A gate a stub run holds its slot on until the test opens it. */
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A one-stage lane that records what it was launched for, then ships. */
function stubLane(label, launched, held = null) {
  return {
    stages: ['work'],
    handlers: {
      work: async (ctx) => {
        launched.push(`${label}:${ctx.payload.escapeSeq ?? ctx.payload.storyKey}`);
        if (held) await held.promise;
        return { close: { state: 'shipped' } };
      },
    },
  };
}

/** Records one ticketed escape the way a red-merge breach leaves it. */
function seedEscape(paths, { project = 'alpha', defectLine = 'f(3) returns 5' } = {}) {
  const store = openEscapesStore(paths);
  const recorded = recordEscape(store, {
    actor: 'daemon',
    category: 'product-escape',
    defectLine,
    detectionSource: 'harness-self',
    attribution: 'alpha-1',
    refs: { project, runId: 'shipping-run', pr: 7 },
  });
  const ticket = repairTicketPath(paths, recorded.seq);
  writeFileSync(ticket, `# Repair ticket: escape ${recorded.seq}\n\n${defectLine}\n`);
  ticketEscape(store, { actor: 'daemon', escape: recorded.seq, ticket });
  store.close();
  return recorded.seq;
}

function fixture(t, { cards = ['s1'], slotCap = 1, storyHeld = null } = {}) {
  const root = tempDir();
  const launched = [];
  const files = { 'compose.harness.yml': 'services: {}\n' };
  for (const key of cards) files[`stories/${key}.md`] = cardFile(key);
  files[CONFIG_PATH] = projectConfigJson({ graph: { cardsDir: 'stories' } });
  const origin = initOriginRepo(join(root, 'origin'), files);
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { alpha: { repoUrl: origin, slotCap } } }) + '\n',
  );
  const lanes = {
    story: stubLane('story', launched, storyHeld),
    repair: stubLane('repair', launched),
  };
  const daemon = new Daemon(join(root, 'home'), { lanes, composeRunner: fakeComposeRunner() });
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  return { root, paths, daemon, launched, lanes };
}

function owedStamps(paths) {
  const events = readEvents(paths.instanceLedger);
  const resolved = new Set(events.filter((e) => e.event === 'resolved').map((e) => e.resolves));
  const all = events.filter((e) => e.event === 'repairs-owed');
  return { all, open: all.filter((e) => !resolved.has(e.seq)) };
}

test('the owed set is ticketed, unfixed, unlaunched, and of this project', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const paths = scaffoldHome(dir);
  const first = seedEscape(paths, { defectLine: 'the older defect' });
  const second = seedEscape(paths, { defectLine: 'the newer defect' });
  seedEscape(paths, { project: 'beta' });
  const store = openEscapesStore(paths);
  // An escape with no ticket is not repairable and never owed.
  recordEscape(store, {
    actor: 'daemon',
    category: 'chore',
    defectLine: 'a stale link',
    detectionSource: 'human-report',
    refs: { project: 'alpha' },
  });
  assert.deepEqual(
    owedRepairs(paths, 'alpha').map((e) => e.seq),
    [first, second],
  );
  fixEscape(store, {
    actor: 'daemon',
    fixes: first,
    category: 'product-escape',
    attribution: 'alpha-1',
    refs: { runId: 'r9', pr: 9 },
  });
  store.close();
  assert.deepEqual(
    owedRepairs(paths, 'alpha').map((e) => e.seq),
    [second],
  );
  assert.equal(owedRepairs(paths, 'beta').length, 1);
});

test('the sweep launches owed repairs before the story frontier, oldest first', async (t) => {
  const fx = fixture(t, { cards: ['s1'], slotCap: 1 });
  await fx.daemon.start();
  const first = seedEscape(fx.paths, { defectLine: 'the older defect' });
  const second = seedEscape(fx.paths, { defectLine: 'the newer defect' });
  fx.daemon.frontier.setArmed('alpha', true, 'human');
  await waitFor(() => fx.launched.length === 3, { ...WAIT, label: 'two repairs and one story' });
  assert.deepEqual(fx.launched, [`repair:${first}`, `repair:${second}`, 'story:s1']);
  // Each repair carried its ticket as the lane's spec.
  const launches = readEvents(fx.paths.instanceLedger).filter(
    (e) => e.event === 'launch' && e.lane === 'repair',
  );
  assert.equal(launches.length, 2);
  assert.deepEqual(owedRepairs(fx.paths, 'alpha'), []);
});

test('a slot-blocked repair stays owed and launches at the next sweep', async (t) => {
  const held = gate();
  const fx = fixture(t, { cards: ['s1'], slotCap: 1, storyHeld: held });
  await fx.daemon.start();
  fx.daemon.frontier.setArmed('alpha', true, 'human');
  await waitFor(() => fx.launched.length === 1, { ...WAIT, label: 's1 holds the slot' });
  const seq = seedEscape(fx.paths);
  // The only slot is taken: the sweep launches nothing and retries nothing.
  await fx.daemon.frontier.queueSweep('alpha');
  assert.deepEqual(fx.launched, ['story:s1']);
  assert.deepEqual(
    owedRepairs(fx.paths, 'alpha').map((e) => e.seq),
    [seq],
  );
  // The story closes; the close queues the sweep that launches the repair.
  held.open();
  await waitFor(() => fx.launched.includes(`repair:${seq}`), { ...WAIT, label: 'repair launched' });
  assert.deepEqual(owedRepairs(fx.paths, 'alpha'), []);
});

test('a paused project stamps its owed repairs loud once and resolves at launch', async (t) => {
  const fx = fixture(t, { cards: ['s1'], slotCap: 2 });
  await fx.daemon.start();
  const first = seedEscape(fx.paths, { defectLine: 'the older defect' });
  const second = seedEscape(fx.paths, { defectLine: 'the newer defect' });
  // Paused: the sweep never overrides the owner's pause, it says what the
  // pause costs.
  await fx.daemon.frontier.queueSweep('alpha');
  const stamped = owedStamps(fx.paths);
  assert.equal(stamped.all.length, 1);
  assert.deepEqual(stamped.all[0].escapes, [first, second]);
  assert.equal(stamped.all[0].project, 'alpha');
  assert.ok(readStreamIndex(fx.paths.loudStream).some((e) => e.event === 'repairs-owed'));
  assert.deepEqual(fx.launched, []);
  // The same owed set never stamps twice.
  await fx.daemon.frontier.queueSweep('alpha');
  assert.equal(owedStamps(fx.paths).all.length, 1);
  // Arming launches both, and the stamp resolves with them.
  fx.daemon.frontier.setArmed('alpha', true, 'human');
  await waitFor(() => owedStamps(fx.paths).open.length === 0, { ...WAIT, label: 'owed resolved' });
  assert.equal(owedStamps(fx.paths).all.length, 1);
  assert.ok(fx.launched.includes(`repair:${first}`));
  assert.ok(fx.launched.includes(`repair:${second}`));
});

test('a restarted daemon owes nothing the first one already launched', async (t) => {
  const fx = fixture(t, { cards: ['s1'], slotCap: 2 });
  await fx.daemon.start();
  const seq = seedEscape(fx.paths);
  fx.daemon.frontier.setArmed('alpha', true, 'human');
  await waitFor(() => fx.launched.includes(`repair:${seq}`), { ...WAIT, label: 'repair launched' });
  await waitFor(() => owedRepairs(fx.paths, 'alpha').length === 0, { ...WAIT, label: 'owed cleared' });
  await fx.daemon.stop();
  const launched = [];
  const second = new Daemon(join(fx.root, 'home'), {
    lanes: { story: stubLane('story', launched), repair: stubLane('repair', launched) },
    composeRunner: fakeComposeRunner(),
  });
  t.after(() => second.stop());
  await second.start();
  await second.frontier.queueSweep('alpha');
  await second.stop();
  // The escape is answered by a repair run that exists; the replay adds none.
  const repairs = readEvents(fx.paths.instanceLedger).filter(
    (e) => e.event === 'launch' && e.lane === 'repair',
  );
  assert.equal(repairs.length, 1);
  assert.ok(!launched.some((entry) => entry.startsWith('repair:')));
});
