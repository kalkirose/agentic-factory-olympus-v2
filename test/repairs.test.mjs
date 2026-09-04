// The frontier's repair pass: the owed set derived from the escapes ledger
// and the repair runs' own launch stamps, the launch order against the story
// frontier, the slot-blocked retry, the paused project's loud stamp, and the
// restart that owes nothing twice. With them, the two console routes that end
// an escape — a repair launch that carries it, and an operator's fixed-mark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, repairTicketPath } from '../src/daemon/home.mjs';
import { writeControlCommand } from '../src/daemon/control.mjs';
import { openEscapesStore } from '../src/telemetry/stores.mjs';
import {
  recordEscape,
  ticketEscape,
  fixEscape,
  readEscapeSet,
} from '../src/telemetry/escapes.mjs';
import { owedRepairs, launchEscape } from '../src/frontier/repairs.mjs';
import { listRunEvents } from '../src/telemetry/readers.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { readStreamIndex } from '../src/telemetry/streams.mjs';
import {
  tempDir,
  removeDir,
  waitFor,
  initOriginRepo,
  projectConfigJson,
  fakeComposeRunner,
  NO_WAIT,
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

function fixture(t, { cards = ['s1'], slotCap = 1, storyHeld = null, config = {}, tree = {} } = {}) {
  const root = tempDir();
  const launched = [];
  const files = { 'compose.harness.yml': 'services: {}\n', ...tree };
  for (const key of cards) files[`stories/${key}.md`] = cardFile(key);
  files[CONFIG_PATH] = projectConfigJson({ graph: { cardsDir: 'stories' }, ...config });
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
  const daemon = new Daemon(join(root, 'home'), { waitSleep: NO_WAIT, lanes, composeRunner: fakeComposeRunner() });
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

test('a repair launch carries the escape it was named, or the ticket names it', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const paths = scaffoldHome(dir);
  const seq = seedEscape(paths);
  const ticket = repairTicketPath(paths, seq);
  // Named outright, and derived from a ticket an escape record already names:
  // both routes reach the same linkage the sweep builds for itself.
  assert.deepEqual(launchEscape(paths, { ticket, escape: seq }), { seq, attribution: 'alpha-1' });
  assert.deepEqual(launchEscape(paths, { ticket }), { seq, attribution: 'alpha-1' });
  // A ticket the operator wrote by hand belongs to no escape, and a repair
  // against one is a legitimate run with nothing to stamp back.
  assert.equal(launchEscape(paths, { ticket: join(dir, 'tickets', 'by-hand.md') }), null);
  assert.equal(launchEscape(paths, { ticket: 'tickets/in-the-worktree.md' }), null);
  // A number that names no open escape is refused: silently dropping it loses
  // the fix-back, and stamping it fixes an escape nobody repaired.
  assert.throws(() => launchEscape(paths, { ticket, escape: 99 }), /no escape at seq 99/);
  assert.throws(() => launchEscape(paths, { ticket, escape: 99 }), /open escapes: 1/);
  assert.throws(() => launchEscape(paths, { ticket, escape: 'one' }), /integer seq/);
  const store = openEscapesStore(paths);
  fixEscape(store, {
    actor: 'daemon',
    fixes: seq,
    category: 'product-escape',
    attribution: 'alpha-1',
    refs: { runId: 'r9', pr: 9 },
  });
  store.close();
  assert.throws(() => launchEscape(paths, { ticket, escape: seq }), /already fixed \(repair\)/);
  // The ticket of a fixed escape names nothing: the escape it belonged to is
  // closed, and the run that repairs from it stamps nothing back.
  assert.equal(launchEscape(paths, { ticket }), null);
});

test('a console repair launch carries its escape into the run payload', async (t) => {
  const fx = fixture(t, { cards: ['s1'], slotCap: 2 });
  await fx.daemon.start();
  const derived = seedEscape(fx.paths, { defectLine: 'the derived defect' });
  const named = seedEscape(fx.paths, { defectLine: 'the named defect' });
  // The project stays paused: nothing here is the sweep's work.
  await fx.daemon.launchCommand({
    actor: 'console:operator',
    project: 'alpha',
    lane: 'repair',
    ticket: repairTicketPath(fx.paths, derived),
  });
  await fx.daemon.launchCommand({
    actor: 'console:operator',
    project: 'alpha',
    lane: 'repair',
    ticket: join(fx.paths.tickets, 'by-hand.md'),
    escape: named,
  });
  await waitFor(() => fx.launched.length === 2, { ...WAIT, label: 'two console repairs' });
  assert.deepEqual(fx.launched, [`repair:${derived}`, `repair:${named}`]);
  const launches = readEvents(fx.paths.instanceLedger).filter(
    (e) => e.event === 'launch' && e.lane === 'repair',
  );
  assert.equal(launches.length, 2);
  // The payload is where the close-out fix-back looks, and the attribution
  // rides with it so the fix carries the story the defect came from.
  const stamps = listRunEvents(fx.paths, { lane: 'repair' }).map(({ events }) =>
    events.find((line) => line.event === 'run-launched'),
  );
  assert.deepEqual(
    stamps.map((e) => e.escapeSeq).sort(),
    [derived, named].sort(),
  );
  assert.deepEqual(stamps.map((e) => e.attribution), ['alpha-1', 'alpha-1']);
  // Both escapes are answered by a repair run that exists.
  assert.deepEqual(owedRepairs(fx.paths, 'alpha'), []);
});

test('a console launch that names no open escape is refused, loud, before a slot', async (t) => {
  const fx = fixture(t, { cards: ['s1'], slotCap: 2 });
  await fx.daemon.start();
  const seq = seedEscape(fx.paths);
  writeControlCommand(fx.paths, {
    command: 'launch',
    actor: 'console:operator',
    project: 'alpha',
    lane: 'repair',
    ticket: repairTicketPath(fx.paths, seq),
    escape: 99,
  });
  const rejected = await waitFor(
    () => readEvents(fx.paths.instanceLedger).find((e) => e.event === 'launch-rejected'),
    { ...WAIT, label: 'the launch was refused' },
  );
  assert.match(rejected.reason, /no escape at seq 99/);
  assert.deepEqual(fx.launched, []);
  assert.deepEqual(
    owedRepairs(fx.paths, 'alpha').map((e) => e.seq),
    [seq],
  );
});

// -- the ticket check at the door (ADR-0067) ----------------------------------

const REPAIR_POLICY = {
  diffPolicy: {
    repair: { deniedPaths: ['.olympus/project.json', '.github'], forbiddenPatterns: ['\\.env$'] },
  },
};

function ticket(block) {
  return [
    '# Repair ticket: the greeting',
    '',
    '## The defect',
    '',
    'greet() answers "hi"; it must answer "hello".',
    '',
    ...(block ? ['```touched-paths', ...block, '```', ''] : []),
  ].join('\n');
}

test('a console ticket whose block names forbidden ground is refused before a slot, with the entry and the rule', async (t) => {
  const fx = fixture(t, {
    cards: ['s1'],
    slotCap: 2,
    config: REPAIR_POLICY,
    tree: {
      '.olympus/tickets/forbidden.md': ticket([
        'src/greeting.mjs',
        '.olympus/project.json — dev',
        'config/.env',
      ]),
      '.olympus/tickets/plain.md': ticket(null),
      '.olympus/tickets/allowed.md': ticket(['src/greeting.mjs — dev', 'tests/greeting.test.mjs']),
    },
  });
  await fx.daemon.start();
  writeControlCommand(fx.paths, {
    command: 'launch',
    actor: 'console:operator',
    project: 'alpha',
    lane: 'repair',
    ticket: '.olympus/tickets/forbidden.md',
  });
  const rejected = await waitFor(
    () => readEvents(fx.paths.instanceLedger).find((e) => e.event === 'launch-rejected'),
    { ...WAIT, label: 'the launch was refused' },
  );
  assert.equal(rejected.requestedBy, 'console:operator');
  assert.equal(rejected.lane, 'repair');
  assert.equal(rejected.ticket, '.olympus/tickets/forbidden.md');
  assert.match(
    rejected.reason,
    /the ticket \.olympus\/tickets\/forbidden\.md names ground the repair lane may not touch: \.olympus\/project\.json \(deniedPaths: \.olympus\/project\.json\); config\/\.env \(forbiddenPatterns: \\\.env\$\)\. Remove those entries/,
  );
  assert.ok(!rejected.reason.includes('src/greeting.mjs'), 'an ordinary entry is not named');
  // Nothing was provisioned for it: no launch, no run, no workspace.
  assert.deepEqual(fx.launched, []);
  assert.ok(!readEvents(fx.paths.instanceLedger).some((e) => e.event === 'launch'));
  assert.ok(!existsSync(join(fx.paths.worktrees, rejected.runId ?? 'none')));
  assert.ok(existsSync(fx.paths.controlRejected));

  // A ticket with no block launches, as it always did; so does a ticket whose
  // block names only ground the lane may touch.
  for (const path of ['.olympus/tickets/plain.md', '.olympus/tickets/allowed.md']) {
    await fx.daemon.launchCommand({
      actor: 'console:operator',
      project: 'alpha',
      lane: 'repair',
      ticket: path,
    });
  }
  await waitFor(() => fx.launched.length === 2, { ...WAIT, label: 'two repairs launched' });
  assert.equal(
    readEvents(fx.paths.instanceLedger).filter((e) => e.event === 'launch-rejected').length,
    1,
  );
});

test('an absolute ticket is read from the home, and the frontier stamps a refused repair launch', async (t) => {
  const fx = fixture(t, { cards: ['s1'], slotCap: 2, config: REPAIR_POLICY });
  await fx.daemon.start();
  const seq = seedEscape(fx.paths);
  // A harness-authored ticket carries no block; this one was edited by hand
  // to name the file the repair lane is denied.
  writeFileSync(repairTicketPath(fx.paths, seq), ticket(['.github/workflows/ci.yml — dev']));
  fx.daemon.frontier.setArmed('alpha', true, 'human');
  const rejected = await waitFor(
    () => readEvents(fx.paths.instanceLedger).find((e) => e.event === 'launch-rejected'),
    { ...WAIT, label: 'the sweep stamps the refusal' },
  );
  assert.equal(rejected.requestedBy, 'frontier');
  assert.equal(rejected.project, 'alpha');
  assert.equal(rejected.lane, 'repair');
  assert.equal(rejected.ticket, repairTicketPath(fx.paths, seq));
  assert.match(rejected.reason, /\.github\/workflows\/ci\.yml \(deniedPaths: \.github\)/);
  // The escape stays owed, and the story frontier kept moving.
  assert.deepEqual(
    owedRepairs(fx.paths, 'alpha').map((e) => e.seq),
    [seq],
  );
  await waitFor(() => fx.launched.includes('story:s1'), { ...WAIT, label: 'the story launched' });
  assert.ok(!fx.launched.some((l) => l.startsWith('repair:')));
});

test('a repair lane with no diff policy accepts every block, and an unreadable ticket is left to the lane', async (t) => {
  const fx = fixture(t, {
    cards: ['s1'],
    slotCap: 2,
    tree: { '.olympus/tickets/anything.md': ticket(['.olympus/project.json — dev']) },
  });
  await fx.daemon.start();
  await fx.daemon.launchCommand({
    actor: 'console:operator',
    project: 'alpha',
    lane: 'repair',
    ticket: '.olympus/tickets/anything.md',
  });
  await fx.daemon.launchCommand({
    actor: 'console:operator',
    project: 'alpha',
    lane: 'repair',
    ticket: '.olympus/tickets/no-such-ticket.md',
  });
  await waitFor(() => fx.launched.length === 2, { ...WAIT, label: 'both launched' });
  assert.ok(!readEvents(fx.paths.instanceLedger).some((e) => e.event === 'launch-rejected'));
});

test('an operator fixed-mark retires the owed repair and the loud item', async (t) => {
  const fx = fixture(t, { cards: ['s1'], slotCap: 2 });
  await fx.daemon.start();
  const seq = seedEscape(fx.paths);
  // Paused, so the owed repair goes loud instead of launching.
  await fx.daemon.frontier.queueSweep('alpha');
  assert.equal(owedStamps(fx.paths).open.length, 1);
  writeControlCommand(fx.paths, {
    command: 'fixed',
    actor: 'console:operator',
    escape: seq,
    evidence: 'fixed by hand on the default branch',
  });
  await waitFor(() => owedStamps(fx.paths).open.length === 0, { ...WAIT, label: 'owed resolved' });
  // Nothing ran: the defect left the product without the factory, and the
  // ledger says so under an event no repair run writes.
  assert.deepEqual(fx.launched, []);
  const marked = readEvents(fx.paths.escapesLedger).find((e) => e.event === 'escape-marked-fixed');
  assert.equal(marked.fixes, seq);
  assert.equal(marked.actor, 'console:operator');
  assert.equal(marked.evidence, 'fixed by hand on the default branch');
  assert.equal(readEscapeSet(fx.paths.escapesLedger)[0].fixedBy, 'operator');
  assert.deepEqual(owedRepairs(fx.paths, 'alpha'), []);
});

test('a fixed-mark without evidence is refused and the escape stays owed', async (t) => {
  const fx = fixture(t, { cards: ['s1'], slotCap: 2 });
  await fx.daemon.start();
  const seq = seedEscape(fx.paths);
  const file = writeControlCommand(fx.paths, {
    command: 'fixed',
    actor: 'console:operator',
    escape: seq,
  });
  const reason = join(fx.paths.controlRejected, `${file}.reason.txt`);
  await waitFor(() => existsSync(reason), { ...WAIT, label: 'the mark was refused' });
  assert.match(readFileSync(reason, 'utf8'), /carries the evidence it stands on/);
  assert.deepEqual(
    owedRepairs(fx.paths, 'alpha').map((e) => e.seq),
    [seq],
  );
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
    waitSleep: NO_WAIT,
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
