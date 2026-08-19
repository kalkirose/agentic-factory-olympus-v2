// The watched-workflow observer: a red on a scheduled run nothing else reads
// becomes a loud item once, the ledger is the only state a restart reads it
// back from, a green closes the item with the evidence that answers it, and a
// list nobody could read is never a green.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scaffoldHome } from '../src/daemon/home.mjs';
import { openInstanceStore } from '../src/telemetry/stores.mjs';
import { openLoud } from '../src/telemetry/readers.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { validateProjectConfig, parseProjectConfig } from '../src/config/project.mjs';
import { gitHubForge } from '../src/ship/forge.mjs';
import { WorkflowWatcher } from '../src/ship/workflows.mjs';
import { tempDir, removeDir } from './helpers.mjs';

const WORKFLOW = 'nightly.yml';

function home(t) {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  return scaffoldHome(dir);
}

/**
 * A forge whose answer for the watched workflow is whatever `answers` holds
 * at poll time: a run object, null for a list nobody could read, or an Error
 * to throw.
 */
function fakeForge(answers) {
  const calls = [];
  return {
    calls,
    forge: {
      async latestCompletedRun(workflow, branch) {
        calls.push({ workflow, branch });
        const answer = answers.current;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

function run(id, conclusion) {
  return { id, conclusion, url: `https://forge/runs/${id}`, headSha: 'f'.repeat(40) };
}

/** A watcher over one project, with the poll timer never armed. */
function watcher(ledger, forge, { watched = [WORKFLOW] } = {}) {
  return new WorkflowWatcher({
    ledger,
    projects: () => [{ project: 'proj', defaultBranch: 'main' }],
    forgeFor: () => forge,
    readWatched: async () => watched,
  });
}

function eventsOf(paths, event) {
  return readEvents(paths.instanceLedger).filter((e) => e.event === event);
}

test('a red watched workflow opens one loud item, however often it is polled', async (t) => {
  const paths = home(t);
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const answers = { current: run('101', 'failure') };
  const { forge, calls } = fakeForge(answers);
  const w = watcher(ledger, forge);
  await w.poll();
  await w.poll();
  await w.poll();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { workflow: WORKFLOW, branch: 'main' });
  const reds = eventsOf(paths, 'workflow-red');
  assert.equal(reds.length, 1);
  assert.equal(reds[0].project, 'proj');
  assert.equal(reds[0].workflow, WORKFLOW);
  assert.equal(reds[0].run, '101');
  assert.equal(reds[0].conclusion, 'failure');
  assert.equal(reds[0].branch, 'main');
  assert.match(reds[0].gist, /nightly\.yml run 101 on main: failure/);
  // Loud: the record is the only thing between the red and nobody reading it.
  assert.deepEqual(
    openLoud(paths).map((e) => e.event),
    ['workflow-red'],
  );
  // A newer red run is a new piece of news, and the first one stays open.
  answers.current = run('102', 'timed_out');
  await w.poll();
  assert.deepEqual(
    eventsOf(paths, 'workflow-red').map((e) => [e.run, e.conclusion]),
    [
      ['101', 'failure'],
      ['102', 'timed_out'],
    ],
  );
});

test('the red a restart reads back is the red the ledger holds, and it stamps nothing', async (t) => {
  const paths = home(t);
  const answers = { current: run('101', 'failure') };
  const { forge } = fakeForge(answers);
  const first = openInstanceStore(paths);
  await watcher(first, forge).poll();
  first.close();
  assert.equal(eventsOf(paths, 'workflow-red').length, 1);
  // A second instance over the same home: no memory travelled, and the same
  // red is the same red.
  const second = openInstanceStore(paths);
  t.after(() => second.close());
  await watcher(second, forge).poll();
  await watcher(second, forge).poll();
  assert.equal(eventsOf(paths, 'workflow-red').length, 1);
  assert.equal(openLoud(paths).length, 1);
});

test('a green after a red records the recovery and closes the item with it', async (t) => {
  const paths = home(t);
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const answers = { current: run('101', 'failure') };
  const { forge } = fakeForge(answers);
  const w = watcher(ledger, forge);
  await w.poll();
  const red = eventsOf(paths, 'workflow-red')[0];
  answers.current = run('103', 'success');
  await w.poll();
  const recovered = eventsOf(paths, 'workflow-recovered');
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].run, '103');
  assert.equal(recovered[0].conclusion, 'success');
  assert.deepEqual(recovered[0].closes, [red.seq]);
  // The recovery owns the loud item, so the strip clears where the green
  // landed rather than where a human got round to it.
  const resolved = eventsOf(paths, 'resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].resolves, red.seq);
  assert.equal(resolved[0].resolvedEvent, 'workflow-red');
  assert.equal(resolved[0].workflow, WORKFLOW);
  assert.deepEqual(openLoud(paths), []);
  // Green with nothing open says nothing at all.
  answers.current = run('104', 'success');
  await w.poll();
  assert.equal(eventsOf(paths, 'workflow-recovered').length, 1);
});

test('a list nobody could read is never a green', async (t) => {
  const paths = home(t);
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const answers = { current: run('101', 'failure') };
  const { forge } = fakeForge(answers);
  const w = watcher(ledger, forge);
  await w.poll();
  const red = eventsOf(paths, 'workflow-red')[0];
  // The forge would not answer, and then it could not be reached at all.
  // Neither is a conclusion, so neither opens a record and neither closes one.
  answers.current = null;
  await w.poll();
  answers.current = new Error('gh could not run');
  await w.poll();
  assert.equal(eventsOf(paths, 'workflow-red').length, 1);
  assert.equal(eventsOf(paths, 'workflow-recovered').length, 0);
  assert.deepEqual(
    openLoud(paths).map((e) => e.seq),
    [red.seq],
  );
});

test('a project that watches nothing never reaches the forge', async (t) => {
  const paths = home(t);
  const ledger = openInstanceStore(paths);
  t.after(() => ledger.close());
  const { forge, calls } = fakeForge({ current: run('101', 'failure') });
  await watcher(ledger, forge, { watched: [] }).poll();
  assert.deepEqual(calls, []);
  assert.deepEqual(readEvents(paths.instanceLedger), []);
});

test('the watched-workflow list is workflow files, named once each', () => {
  const config = (workflows) => ({ version: 1, watchedWorkflows: workflows });
  const paths = (workflows) => validateProjectConfig(config(workflows)).map((e) => e.path);
  assert.deepEqual(validateProjectConfig(config([WORKFLOW, 'audit.yml'])), []);
  assert.deepEqual(paths('nightly.yml'), ['watchedWorkflows']);
  assert.deepEqual(paths([2]), ['watchedWorkflows']);
  assert.deepEqual(paths([WORKFLOW, WORKFLOW]), ['watchedWorkflows[1]']);
  // Absent, the default is the empty list: a project watches nothing until it
  // says which workflow it wants watched.
  assert.deepEqual(parseProjectConfig(JSON.stringify({ version: 1 }), 'fixture').watchedWorkflows, []);
});

test('the gh adapter asks for one completed run of one workflow on one branch', async () => {
  const calls = [];
  const runner = async (argv) => {
    calls.push(argv);
    return {
      code: 0,
      output: JSON.stringify({
        runs: [
          {
            id: 42,
            conclusion: 'failure',
            html_url: 'https://github.com/acme/widgets/actions/runs/42',
            head_sha: 'abc123',
            updated_at: '2026-08-19T03:00:00Z',
          },
        ],
      }),
    };
  };
  const forge = gitHubForge({ repo: 'acme/widgets', runner });
  const latest = await forge.latestCompletedRun(WORKFLOW, 'main');
  assert.deepEqual(latest, {
    id: '42',
    conclusion: 'failure',
    url: 'https://github.com/acme/widgets/actions/runs/42',
    headSha: 'abc123',
    completedAt: '2026-08-19T03:00:00Z',
  });
  assert.equal(
    calls[0][2],
    'repos/acme/widgets/actions/workflows/nightly.yml/runs?branch=main&status=completed&per_page=1',
  );
});

test('the gh adapter answers null for a list it could not read and a run with no conclusion', async () => {
  const refused = gitHubForge({
    repo: 'acme/widgets',
    runner: async () => ({ code: 1, output: 'Not Found' }),
  });
  assert.equal(await refused.latestCompletedRun(WORKFLOW, 'main'), null);
  const empty = gitHubForge({
    repo: 'acme/widgets',
    runner: async () => ({ code: 0, output: JSON.stringify({ runs: [] }) }),
  });
  assert.equal(await empty.latestCompletedRun(WORKFLOW, 'main'), null);
  const unfinished = gitHubForge({
    repo: 'acme/widgets',
    runner: async () => ({ code: 0, output: JSON.stringify({ runs: [{ id: 7, conclusion: null }] }) }),
  });
  assert.equal(await unfinished.latestCompletedRun(WORKFLOW, 'main'), null);
});
