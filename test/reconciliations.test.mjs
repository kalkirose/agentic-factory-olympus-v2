// The frontier's reconciliation pass: the owed set derived from the shipping
// runs' judgment stamps and the reconciliation runs' own launch stamps, and
// the sweep order — breach repairs, then reconciliations, then the story
// frontier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, repairTicketPath, reconcileTicketPath } from '../src/daemon/home.mjs';
import { openEscapesStore, openRunStore } from '../src/telemetry/stores.mjs';
import { recordEscape, ticketEscape } from '../src/telemetry/escapes.mjs';
import {
  owedReconciliations,
  reconciliationLaunch,
  launchedReconciliations,
} from '../src/frontier/reconciliations.mjs';
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

/** Seeds one story run's ledger the way a close-out leaves it. */
function seedStoryRun(paths, { runId, project = 'alpha', judged = null, state = 'shipped' }) {
  const store = openRunStore(paths, runId);
  store.append('run-launched', { actor: 'daemon', project, lane: 'story', storyKey: runId });
  if (judged) store.append('reconciliation-judged', { actor: 'daemon', ...judged });
  store.append('run-closed', { actor: 'daemon', state, pr: 7, mergeSha: 'abc' });
  store.close();
}

/** Seeds a reconciliation run's launch stamp the way the sweep leaves it. */
function seedReconciliationRun(paths, { runId, reconcilesRunId, project = 'alpha' }) {
  const store = openRunStore(paths, runId);
  store.append('run-launched', { actor: 'daemon', project, lane: 'repair', reconcilesRunId });
  store.close();
}

function owedJudgment(paths, runId, records = ['docs/adr/0001-x.md']) {
  const ticket = reconcileTicketPath(paths, runId);
  writeFileSync(ticket, `# Reconciliation ticket: run ${runId}\n`);
  return { ok: true, owed: true, records, reason: 'implements the decision', ticket };
}

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

test('the owed set is judged owed, shipped, unlaunched, and of this project', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const paths = scaffoldHome(dir);
  seedStoryRun(paths, { runId: 'r1', judged: owedJudgment(paths, 'r1') });
  // A ship judged not owed is never owed.
  seedStoryRun(paths, {
    runId: 'r2',
    judged: { ok: true, owed: false, reason: 'no decision-record tree' },
  });
  // A failed judgment is a recorded miss, not an owed reconciliation.
  seedStoryRun(paths, { runId: 'r3', judged: { ok: false, cause: 'seat-failure' } });
  // A run that did not ship owes nothing, whatever the judgment said.
  seedStoryRun(paths, { runId: 'r4', judged: owedJudgment(paths, 'r4'), state: 'failed' });
  // Another project's ship is not this project's owed set.
  seedStoryRun(paths, { runId: 'r5', project: 'beta', judged: owedJudgment(paths, 'r5') });
  // A reconciliation run that exists answers its ship, open or closed.
  seedStoryRun(paths, { runId: 'r6', judged: owedJudgment(paths, 'r6') });
  seedReconciliationRun(paths, { runId: 'rr6', reconcilesRunId: 'r6' });

  assert.deepEqual(launchedReconciliations(paths), new Set(['r6']));
  const owed = owedReconciliations(paths, 'alpha');
  assert.deepEqual(
    owed.map((o) => o.runId),
    ['r1'],
  );
  assert.deepEqual(reconciliationLaunch(owed[0]), {
    project: 'alpha',
    lane: 'repair',
    ticket: reconcileTicketPath(paths, 'r1'),
    reconcilesRunId: 'r1',
  });
  assert.deepEqual(
    owedReconciliations(paths, 'beta').map((o) => o.runId),
    ['r5'],
  );
});

test('the sweep launches repairs, then reconciliations, then the story frontier', async (t) => {
  const root = tempDir();
  const launched = [];
  const origin = initOriginRepo(join(root, 'origin'), {
    'compose.harness.yml': 'services: {}\n',
    'stories/s1.md': cardFile('s1'),
    [CONFIG_PATH]: projectConfigJson({ graph: { cardsDir: 'stories' } }),
  });
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { alpha: { repoUrl: origin, slotCap: 1 } } }) + '\n',
  );
  const stub = (label) => ({
    stages: ['work'],
    handlers: {
      work: async (ctx) => {
        launched.push(
          `${label}:${ctx.payload.reconcilesRunId ?? ctx.payload.escapeSeq ?? ctx.payload.storyKey}`,
        );
        return { close: { state: 'shipped' } };
      },
    },
  });
  const daemon = new Daemon(join(root, 'home'), {
    lanes: { story: stub('story'), repair: stub('repair') },
    composeRunner: fakeComposeRunner(),
  });
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  await daemon.start();
  const seq = seedEscape(paths);
  seedStoryRun(paths, { runId: 'shipped-1', judged: owedJudgment(paths, 'shipped-1') });
  daemon.frontier.setArmed('alpha', true, 'human');
  await waitFor(() => launched.length === 3, { ...WAIT, label: 'repair, reconciliation, story' });
  assert.deepEqual(launched, [`repair:${seq}`, 'repair:shipped-1', 'story:s1']);
  assert.deepEqual(owedReconciliations(paths, 'alpha'), []);
  // The launch stamp carries the ship it answers.
  assert.deepEqual(launchedReconciliations(paths), new Set(['shipped-1']));
});
