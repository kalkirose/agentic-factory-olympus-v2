import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, runLedgerPath, archivedRunLedgerPath } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { tempDir, removeDir, waitFor, NO_WAIT } from './helpers.mjs';

function setupHome(t) {
  const home = tempDir();
  const paths = scaffoldHome(home);
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { proj: { repoUrl: 'file:///fixture' } } }, null, 2),
  );
  t.after(() => removeDir(home));
  return { home, paths };
}

function writeControl(paths, name, command) {
  const tmp = join(paths.control, `${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(command) + '\n');
  renameSync(tmp, join(paths.control, `${name}.json`));
}

test('a daemon restart resumes an open run at its recorded stage', async (t) => {
  const { home, paths } = setupHome(t);
  // First daemon: the build stage holds an in-flight seat when the stop lands.
  const lanesFirst = {
    story: {
      stages: ['prep', 'build'],
      handlers: {
        prep: () => ({ next: 'build' }),
        build: async (ctx) => {
          await ctx.supervise({
            seat: 'dev',
            cmd: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
          });
          return new Promise(() => {}); // terminated by the stop; never settles
        },
      },
    },
  };
  const d1 = new Daemon(home, { waitSleep: NO_WAIT, lanes: lanesFirst });
  await d1.start();
  d1.engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => readEvents(runLedgerPath(paths, 'r1')).some((e) => e.event === 'seat-spawned'), {
    label: 'seat in flight',
  });
  await d1.stop();
  const afterStop = readEvents(runLedgerPath(paths, 'r1'));
  const terminated = afterStop.find((e) => e.event === 'seat-terminated');
  assert.equal(terminated.reason, 'daemon-stopped');
  assert.ok(!afterStop.some((e) => e.event === 'seat-failure'));

  // Second daemon: same lane shape, build now completes.
  const lanesSecond = {
    story: {
      stages: ['prep', 'build'],
      handlers: {
        prep: () => ({ next: 'build' }),
        build: () => ({ close: { state: 'shipped' } }),
      },
    },
  };
  const d2 = new Daemon(home, { waitSleep: NO_WAIT, lanes: lanesSecond });
  const { runsResumed } = await d2.start();
  assert.deepEqual(runsResumed, ['r1']);
  await waitFor(() => readEvents(archivedRunLedgerPath(paths, 'r1')).some((e) => e.event === 'run-closed'), {
    label: 'resumed run closed',
  });
  await d2.stop();
  const events = readEvents(archivedRunLedgerPath(paths, 'r1'));
  const entered = events.filter((e) => e.event === 'stage-entered');
  assert.equal(entered.at(-1).stage, 'build');
  assert.equal(entered.at(-1).resumed, true);
  assert.equal(events.at(-1).state, 'shipped');
});

test('a parked run stays parked across restart and resumes on a control-inbox answer', async (t) => {
  const { home, paths } = setupHome(t);
  const lanes = {
    story: {
      stages: ['decide', 'finish'],
      handlers: {
        decide: (ctx) =>
          ctx.lastAnswer
            ? { next: 'finish' }
            : {
                park: {
                  type: 'open-decisions',
                  question: 'Pick the auth scheme.',
                  options: ['jwt', 'session'],
                },
              },
        finish: () => ({ close: { state: 'shipped' } }),
      },
    },
  };
  const d1 = new Daemon(home, { waitSleep: NO_WAIT, lanes });
  await d1.start();
  d1.engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(() => readEvents(runLedgerPath(paths, 'r1')).some((e) => e.event === 'park'), {
    label: 'run parked',
  });
  await d1.stop();

  const d2 = new Daemon(home, { waitSleep: NO_WAIT, lanes });
  const { runsResumed } = await d2.start();
  t.after(async () => {
    await d2.stop();
  });
  assert.deepEqual(runsResumed, ['r1']);
  // Parked runs wait on the human: no re-entry, the slot stays free.
  assert.equal(d2.engine.activeCount('proj'), 0);
  assert.equal(
    readEvents(runLedgerPath(paths, 'r1')).filter((e) => e.event === 'stage-entered').length,
    1,
  );

  // An invalid answer is claimed and recorded with a reason; the run stays parked.
  writeControl(paths, 'bad-answer', {
    command: 'answer',
    actor: 'operator',
    runId: 'r1',
    option: 'oauth',
  });
  await waitFor(
    () => readdirSync(paths.controlRejected).some((f) => f.startsWith('bad-answer') && f.endsWith('.reason.txt')),
    { label: 'invalid answer reason recorded' },
  );
  assert.equal(d2.engine.activeCount('proj'), 0);

  // The valid answer resumes the run at the parked stage; who/when stamped.
  writeControl(paths, 'good-answer', {
    command: 'answer',
    actor: 'operator',
    runId: 'r1',
    option: 'jwt',
  });
  await waitFor(() => readEvents(archivedRunLedgerPath(paths, 'r1')).some((e) => e.event === 'run-closed'), {
    label: 'answered run closed',
  });
  const events = readEvents(archivedRunLedgerPath(paths, 'r1'));
  const answer = events.find((e) => e.event === 'answer');
  assert.equal(answer.actor, 'operator');
  assert.equal(answer.option, 'jwt');
  assert.ok(answer.ts);
  assert.equal(events.find((e) => e.event === 'resume').stage, 'decide');
  assert.equal(events.at(-1).state, 'shipped');
});

test('a run the engine cannot resume violates loud instead of vanishing', async (t) => {
  const { home, paths } = setupHome(t);
  const lanes = {
    story: {
      stages: ['hold'],
      handlers: { hold: () => new Promise(() => {}) },
    },
  };
  const d1 = new Daemon(home, { waitSleep: NO_WAIT, lanes });
  await d1.start();
  d1.engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await d1.stop();

  const d2 = new Daemon(home, { waitSleep: NO_WAIT, lanes: {} }); // lane no longer registered
  const { runsResumed } = await d2.start();
  t.after(async () => {
    await d2.stop();
  });
  assert.deepEqual(runsResumed, ['r1']);
  const violation = readEvents(runLedgerPath(paths, 'r1')).find(
    (e) => e.event === 'liveness-violation',
  );
  assert.equal(violation.stream, 'loud');
  assert.match(violation.detail, /cannot resume/);
});
