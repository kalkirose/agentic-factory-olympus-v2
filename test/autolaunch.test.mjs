// Frontier auto-launch through the daemon: a multi-card fixture launches in
// roadmap order under the slot cap, a park frees its slot, an answer resumes
// the run, starvation lands loud once and resolves on activity, arming
// survives a restart, and a spent card never auto-relaunches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { writeControlCommand } from '../src/daemon/control.mjs';
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

function cardFile(key, { blockedBy, phase } = {}) {
  const lines = ['---', `key: ${key}`, `title: Story ${key}`];
  if (blockedBy) lines.push(`blocked-by: ${JSON.stringify(blockedBy)}`);
  if (phase) lines.push(`phase: ${phase}`);
  lines.push('---', '', `Intent for ${key}.`, '');
  return lines.join('\n');
}

/**
 * A story-lane stub driven by per-key behavior: 'ship' (default), 'park'
 * (parks once, ships after the answer), or 'fail'.
 */
function stubStoryLane(behavior, launched) {
  return {
    stages: ['work'],
    handlers: {
      work: async (ctx) => {
        const key = ctx.payload.storyKey;
        if (!ctx.lastAnswer) launched.push(key);
        const mode = behavior[key] ?? 'ship';
        if (mode === 'park' && !ctx.lastAnswer) {
          return {
            park: {
              type: 'open-decisions',
              question: `Decide the scope of ${key}.`,
              text: 'the scope',
            },
          };
        }
        if (mode === 'fail') return { close: { state: 'failed', reason: 'fixture' } };
        return { close: { state: 'shipped' } };
      },
    },
  };
}

function fixture(t, { cards, phases, slotCap = 1, behavior = {}, lanes } = {}) {
  const root = tempDir();
  const launched = [];
  const files = { 'compose.harness.yml': 'services: {}\n' };
  for (const [key, spec] of Object.entries(cards)) {
    files[`stories/${key}.md`] = cardFile(key, spec);
  }
  files[CONFIG_PATH] = projectConfigJson({
    graph: { cardsDir: 'stories', ...(phases && { phases }) },
  });
  const origin = initOriginRepo(join(root, 'origin'), files);
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { alpha: { repoUrl: origin, slotCap } } }) + '\n',
  );
  const daemon = new Daemon(join(root, 'home'), {
    waitSleep: NO_WAIT,
    lanes: lanes ?? { story: stubStoryLane(behavior, launched) },
    composeRunner: fakeComposeRunner(),
  });
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  return { root, origin, paths, daemon, launched };
}

function starvations(paths) {
  return readEvents(paths.instanceLedger).filter((e) => e.event === 'factory-starvation');
}

test('a multi-card fixture launches in roadmap order under the slot cap', async (t) => {
  const { paths, daemon, launched } = fixture(t, {
    cards: {
      s1: {},
      s2: { blockedBy: ['s1'] },
      s3: { blockedBy: ['s1'] },
      w1: { phase: 'post-launch' },
    },
    phases: [{ name: 'launch' }, { name: 'post-launch', after: 's2' }],
    slotCap: 1,
  });
  await daemon.start();
  // Arm through the control inbox — the console path.
  writeControlCommand(paths, { command: 'arm', actor: 'human', project: 'alpha' });
  await waitFor(() => launched.length === 4, { attempts: 300, label: 'four cards launched' });
  assert.deepEqual(launched, ['s1', 's2', 's3', 'w1']);
  await waitFor(
    () =>
      readEvents(paths.instanceLedger).filter(
        (e) => e.event === 'workspace-released' && e.ok,
      ).length === 4,
    { attempts: 300, label: 'all workspaces released' },
  );
  const arming = readEvents(paths.instanceLedger).filter((e) => e.event === 'arming-changed');
  assert.equal(arming.length, 1);
  assert.equal(arming[0].armed, true);
  assert.equal(arming[0].actor, 'human');
  // Every card shipped: the factory ran dry quietly, no starvation.
  assert.equal(starvations(paths).length, 0);
});

test('another project\'s shipped story key never takes a card off this frontier', async (t) => {
  // A story key is a project's own word. `beta` shipped its own `s1`; alpha's
  // `s1` is untouched and has to launch. A run history read across projects
  // would mark alpha's card shipped and launch nothing for it, ever.
  const { paths, daemon, launched } = fixture(t, {
    cards: { s1: {}, s2: { blockedBy: ['s1'] } },
    slotCap: 1,
  });
  const line = (seq, ts, event, extra = {}) => ({ seq, ts, event, actor: 'daemon', ...extra });
  const foreign = runLedgerPath(paths, 'beta-1');
  mkdirSync(dirname(foreign), { recursive: true });
  writeFileSync(
    foreign,
    [
      line(1, '2026-08-01T00:00:00Z', 'run-launched', {
        project: 'beta',
        lane: 'story',
        storyKey: 's1',
      }),
      line(2, '2026-08-02T00:00:00Z', 'run-closed', { state: 'shipped' }),
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
  await daemon.start();
  writeControlCommand(paths, { command: 'arm', actor: 'human', project: 'alpha' });
  await waitFor(() => launched.length === 2, { attempts: 300, label: 'both cards launched' });
  assert.deepEqual(launched, ['s1', 's2']);
});

test('a park frees its slot, starvation lands loud once, an answer resumes', async (t) => {
  const { paths, daemon, launched } = fixture(t, {
    cards: { s1: {}, s2: { blockedBy: ['s1'] } },
    slotCap: 1,
    behavior: { s1: 'park' },
  });
  await daemon.start();
  daemon.frontier.setArmed('alpha', true, 'human');
  // s1 parks; nothing else is launchable; zero active runs = starvation, loud.
  await waitFor(() => starvations(paths).length === 1, { attempts: 300, label: 'starvation' });
  const runId = readEvents(paths.instanceLedger).find((e) => e.event === 'launch').runId;
  const parkedRun = daemon.engine.runs.get(runId);
  assert.equal(parkedRun.parked, true);
  assert.equal(daemon.engine.activeCount('alpha'), 0);
  // Open once: another sweep does not stamp a second episode.
  await daemon.frontier.queueSweep('alpha');
  assert.equal(starvations(paths).length, 1);
  assert.ok(readStreamIndex(paths.loudStream).some((e) => e.event === 'factory-starvation'));
  // The answer resumes the run at its parked stage; the ship unblocks s2.
  writeControlCommand(paths, {
    command: 'answer',
    actor: 'human',
    runId,
    answer: 'keep the scope as carded',
  });
  await waitFor(() => launched.includes('s2'), { attempts: 300, label: 's2 launched' });
  await waitFor(
    () => {
      const events = readEvents(paths.instanceLedger);
      const open = starvations(paths).filter(
        (s) => !events.some((e) => e.event === 'resolved' && e.resolves === s.seq),
      );
      return open.length === 0;
    },
    { attempts: 300, label: 'starvation resolved' },
  );
  const answer = readEvents(join(paths.runs, runId, 'ledger.jsonl'));
  assert.ok(
    answer.some((e) => e.event === 'answer' && e.actor === 'human') ||
      readEvents(join(paths.archivedRuns, runId, 'ledger.jsonl')).some(
        (e) => e.event === 'answer' && e.actor === 'human',
      ),
  );
});

test('a spent card never auto-relaunches; pause clears the starvation', async (t) => {
  const { paths, daemon, launched } = fixture(t, {
    cards: { s1: {}, s2: { blockedBy: ['s1'] } },
    slotCap: 2,
    behavior: { s1: 'fail' },
  });
  await daemon.start();
  daemon.frontier.setArmed('alpha', true, 'human');
  await waitFor(() => starvations(paths).length === 1, { attempts: 300, label: 'starvation' });
  assert.deepEqual(launched, ['s1']);
  // Extra sweeps retry nothing: the failure needs a console decision.
  await daemon.frontier.queueSweep('alpha');
  assert.deepEqual(launched, ['s1']);
  daemon.frontier.setArmed('alpha', false, 'human');
  const events = readEvents(paths.instanceLedger);
  const open = starvations(paths).filter(
    (s) => !events.some((e) => e.event === 'resolved' && e.resolves === s.seq),
  );
  assert.equal(open.length, 0);
});

test('arming survives a daemon restart', async (t) => {
  const { root, paths, daemon } = fixture(t, {
    cards: { s1: {} },
    lanes: {}, // no story lane yet: arming precedes the workload
  });
  await daemon.start();
  daemon.frontier.setArmed('alpha', true, 'human');
  await daemon.stop();
  const launched = [];
  const daemon2 = new Daemon(join(root, 'home'), {
    waitSleep: NO_WAIT,
    lanes: { story: stubStoryLane({}, launched) },
    composeRunner: fakeComposeRunner(),
  });
  t.after(() => daemon2.stop());
  await daemon2.start();
  assert.equal(daemon2.frontier.isArmed('alpha'), true);
  await waitFor(() => launched.includes('s1'), { attempts: 300, label: 's1 launched after restart' });
  // Stop in the body: the fixture's removeDir hook runs first (hooks are
  // FIFO) and needs the home released.
  await daemon2.stop();
});

test('a manual launch command reads the story key from the clone', async (t) => {
  const { paths, daemon, launched } = fixture(t, {
    cards: { s1: {} },
    slotCap: 1,
  });
  await daemon.start();
  // Paused: nothing auto-launches; the console launches one card by hand.
  writeControlCommand(paths, {
    command: 'launch',
    actor: 'human',
    project: 'alpha',
    card: 'stories/s1.md',
  });
  await waitFor(() => launched.includes('s1'), { attempts: 300, label: 'manual launch' });
  const run = readEvents(paths.instanceLedger).find((e) => e.event === 'launch');
  await waitFor(
    () =>
      readEvents(join(paths.archivedRuns, run.runId, 'ledger.jsonl')).some(
        (e) => e.event === 'run-launched' && e.storyKey === 's1',
      ),
    { attempts: 300, label: 'storyKey recorded' },
  );
});
