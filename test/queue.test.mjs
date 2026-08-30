// The escalation queue: openness by paired answer/resolved, answerable-from-
// record joins, FIFO with the roadmap tiebreak, the instance answer path,
// and the console resolve routes (open run, closed run, instance).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldHome } from '../src/daemon/home.mjs';
import { Daemon } from '../src/daemon/daemon.mjs';
import { writeControlCommand } from '../src/daemon/control.mjs';
import { openRunStore, openInstanceStore, resolveClosedRun, archiveRun } from '../src/telemetry/stores.mjs';
import { escalationQueue, openCardParks, sortQueue } from '../src/telemetry/queue.mjs';
import { appendStreamEntry } from '../src/telemetry/streams.mjs';
import { openLoud } from '../src/telemetry/readers.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { tempDir, removeDir, waitFor, initOriginRepo, projectConfigJson, fakeComposeRunner } from './helpers.mjs';

const CONFIG = '.olympus/project.json';

function home(t) {
  const root = tempDir();
  t.after(() => removeDir(root));
  return scaffoldHome(join(root, 'home'));
}

test('parks and breaches join the queue and leave on answer / resolve', (t) => {
  const paths = home(t);
  const run = openRunStore(paths, 'r1');
  run.append('run-launched', { actor: 'daemon', project: 'p', lane: 'story', storyKey: 's1' });
  const park = run.append('park', {
    actor: 'daemon',
    type: 'open-decisions',
    question: 'Decide the scope of s1.',
    answers: { options: ['narrow', 'wide', 'abandon'] },
    gist: 'open-decisions: s1',
  });
  const instance = openInstanceStore(paths);
  const cardPark = instance.append('park', {
    actor: 'daemon',
    type: 'card-invalidated',
    card: 'stories/s2.md',
    runId: 'r0',
    question: 'The ship of s1 invalidated stories/s2.md.',
    gist: 'card-invalidated: stories/s2.md',
  });
  const breach = instance.append('tripwire-breach', {
    actor: 'daemon',
    tripwire: 'kill-rate',
    gist: 'tripwire-breach: kill-rate',
  });

  let queue = escalationQueue(paths);
  assert.equal(queue.length, 3);
  const runEntry = queue.find((e) => e.runId === 'r1');
  assert.equal(runEntry.type, 'open-decisions');
  assert.equal(runEntry.storyKey, 's1');
  assert.equal(runEntry.question, 'Decide the scope of s1.');
  // Every queue item carries the record's own answer forms (ADR-0029); a park
  // written before the declaration existed derives them.
  assert.deepEqual(runEntry.answers, { options: ['narrow', 'wide', 'abandon'], text: null });
  assert.deepEqual(queue.find((e) => e.card === 'stories/s2.md').answers, {
    options: ['abandon'],
    text: 'your answer',
  });
  assert.equal(openCardParks(paths).length, 1);

  // Paired closes: an answer for each park, a resolution for the breach.
  run.append('answer', { actor: 'human', parkSeq: park.seq, option: 'narrow' });
  instance.append('answer', { actor: 'human', parkSeq: cardPark.seq, answer: 'card repaired' });
  instance.resolve({ actor: 'human', resolves: breach.seq });
  queue = escalationQueue(paths);
  assert.equal(queue.length, 0);
  assert.equal(openCardParks(paths).length, 0);

  // A park in a closed run is moot without an answer.
  const killed = openRunStore(paths, 'r2');
  killed.append('run-launched', { actor: 'daemon', project: 'p', lane: 'story' });
  killed.append('park', { actor: 'daemon', type: 'second-stall', question: 'q', gist: 'g' });
  killed.append('run-closed', { actor: 'human', state: 'killed' });
  assert.equal(escalationQueue(paths).length, 0);
  run.close();
  killed.close();
  instance.close();
});

test('the frontier reads one project\'s card parks, the queue reads them all', (t) => {
  // A card path is a project's own word. Two projects can hold the same one,
  // and an open decision in `q` may not block the card of that name in `p`:
  // that card would be unlaunchable, and no answer inside `p` could clear it.
  const paths = home(t);
  const instance = openInstanceStore(paths);
  instance.append('park', {
    actor: 'daemon',
    type: 'card-decision',
    card: '.olympus/cards/alpha-1.md',
    runId: 'q1',
    project: 'q',
    question: 'The ship of q left a decision open.',
    gist: 'card-decision in q',
  });
  instance.append('park', {
    actor: 'daemon',
    type: 'card-invalidated',
    card: '.olympus/cards/beta-2.md',
    runId: 'p1',
    project: 'p',
    question: 'The ship of p invalidated beta-2.',
    gist: 'card-invalidated in p',
  });
  assert.deepEqual(
    openCardParks(paths, { project: 'p' }).map((e) => e.card),
    ['.olympus/cards/beta-2.md'],
  );
  assert.deepEqual(
    openCardParks(paths, { project: 'q' }).map((e) => e.card),
    ['.olympus/cards/alpha-1.md'],
  );
  // Unscoped is the queue's own reading, and it stays instance-wide: an
  // operator answers both from one list.
  assert.equal(openCardParks(paths).length, 2);
  // A park older than the project ref names no project, so it blocks no
  // project's frontier while the queue still presents it.
  instance.append('park', {
    actor: 'daemon',
    type: 'card-decision',
    card: '.olympus/cards/gamma-3.md',
    runId: 'r1',
    question: 'An older park.',
    gist: 'card-decision, no project',
  });
  assert.equal(openCardParks(paths, { project: 'p' }).length, 1);
  assert.equal(openCardParks(paths).length, 3);
  instance.close();
});

test('a pointer ahead of its record is nothing, and the queue answers the rest', (t) => {
  const paths = home(t);
  const run = openRunStore(paths, 'r1');
  run.append('run-launched', { actor: 'daemon', project: 'p', lane: 'story', storyKey: 's1' });
  run.append('park', {
    actor: 'daemon',
    type: 'open-decisions',
    question: 'Decide the scope of s1.',
    gist: 'open-decisions: s1',
  });
  // The index leads the ledger, so a reader can catch a pointer whose record
  // is not written yet. It names nothing until the record lands, and the queue
  // it sits in the middle of still answers.
  appendStreamEntry(paths, 'queued', {
    ledger: 'run:r1',
    seq: 99,
    ts: '2026-08-23T00:00:00.000Z',
    event: 'park',
    gist: 'open-decisions: not yet',
  });
  assert.deepEqual(
    escalationQueue(paths).map((e) => e.gist),
    ['open-decisions: s1'],
  );
  run.close();
});

test('presentation is FIFO with a roadmap-order tiebreak', () => {
  const entries = [
    { ts: '2026-08-10T10:00:00Z', seq: 9, storyKey: 'late' },
    { ts: '2026-08-10T09:00:00Z', seq: 5, storyKey: 'tail' },
    { ts: '2026-08-10T09:00:00Z', seq: 4, card: 'stories/head.md' },
    { ts: '2026-08-10T09:00:00Z', seq: 3, storyKey: 'unknown' },
  ];
  const roadmap = new Map([
    ['stories/head.md', 0],
    ['tail', 7],
  ]);
  const sorted = sortQueue(entries, roadmap);
  // Arrival first; equal arrivals by roadmap position; unknowns last by seq.
  assert.deepEqual(
    sorted.map((e) => e.seq),
    [4, 5, 3, 9],
  );
});

test('the daemon answers an instance park and rejects a bad one', async (t) => {
  const root = tempDir();
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG]: projectConfigJson(),
    'compose.harness.yml': 'services: {}\n',
  });
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { p: { repoUrl: origin } } }) + '\n',
  );
  const seeded = openInstanceStore(paths);
  const park = seeded.append('park', {
    actor: 'daemon',
    type: 'card-invalidated',
    card: 'stories/s2.md',
    question: 'invalidated',
    gist: 'card-invalidated: stories/s2.md',
  });
  seeded.close();
  const daemon = new Daemon(join(root, 'home'), { lanes: {}, composeRunner: fakeComposeRunner() });
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  await daemon.start();
  writeControlCommand(paths, { command: 'answer', actor: 'human', seq: park.seq, answer: 'fixed' });
  const answer = await waitFor(
    () => readEvents(paths.instanceLedger).find((e) => e.event === 'answer'),
    { label: 'instance answer stamped' },
  );
  assert.equal(answer.parkSeq, park.seq);
  assert.equal(answer.card, 'stories/s2.md');
  assert.equal(answer.actor, 'human');
  // A second answer to the same park is refused with a reason file.
  writeControlCommand(paths, { command: 'answer', actor: 'human', seq: park.seq, answer: 'again' });
  await waitFor(
    () => readdirSync(paths.controlRejected).some((f) => f.endsWith('.reason.txt')),
    { label: 'rejection reason file' },
  );
});

test('resolve routes: open-run liveness recovery, closed run, instance', async (t) => {
  const root = tempDir();
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG]: projectConfigJson(),
    'compose.harness.yml': 'services: {}\n',
  });
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { p: { repoUrl: origin, slotCap: 2 } } }) + '\n',
  );
  let calls = 0;
  const lanes = {
    wobbly: {
      stages: ['work'],
      handlers: {
        // First entry returns no directive — a liveness violation; the
        // console resolve re-enters the stage and the run ships.
        work: async () => (++calls === 1 ? null : { close: { state: 'shipped' } }),
      },
    },
  };
  const daemon = new Daemon(join(root, 'home'), { lanes, composeRunner: fakeComposeRunner() });
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  await daemon.start();
  const { runId } = await daemon.launchRun({ project: 'p', lane: 'wobbly' });
  const violation = await waitFor(
    () =>
      readEvents(join(paths.runs, runId, 'ledger.jsonl')).find(
        (e) => e.event === 'liveness-violation',
      ),
    { label: 'violation stamped' },
  );
  assert.equal(daemon.engine.runs.get(runId).violated, true);
  writeControlCommand(paths, { command: 'resolve', actor: 'human', runId, seq: violation.seq });
  await waitFor(
    () => readEvents(join(paths.archivedRuns, runId, 'ledger.jsonl')).some(
      (e) => e.event === 'run-closed' && e.state === 'shipped',
    ),
    { attempts: 150, label: 'run recovered and shipped' },
  );
  assert.equal(openLoud(paths).length, 0);

  // A loud item in an archived run resolves through the same command.
  const events = readEvents(join(paths.archivedRuns, runId, 'ledger.jsonl'));
  assert.ok(events.some((e) => e.event === 'resolved' && e.resolves === violation.seq));
  const closedRun = openRunStore(paths, 'r-closed');
  closedRun.append('run-launched', { actor: 'daemon', project: 'p', lane: 'story' });
  const gate = closedRun.append('gate-integrity', {
    actor: 'daemon',
    detail: 'seeded',
    gist: 'gate-integrity: seeded',
  });
  closedRun.append('run-closed', { actor: 'daemon', state: 'failed' });
  closedRun.close();
  archiveRun(paths, 'r-closed');
  assert.equal(openLoud(paths).length, 1);
  resolveClosedRun(paths, 'r-closed', { actor: 'human', resolves: gate.seq });
  assert.equal(openLoud(paths).length, 0);

  // An instance loud item resolves through the daemon's own ledger.
  daemon.ledger.append('factory-starvation', {
    actor: 'daemon',
    project: 'p',
    reason: 'seeded',
    gist: 'factory-starvation: p',
  });
  const starve = readEvents(paths.instanceLedger).find((e) => e.event === 'factory-starvation');
  writeControlCommand(paths, { command: 'resolve', actor: 'human', seq: starve.seq });
  await waitFor(() => openLoud(paths).length === 0, { label: 'instance loud resolved' });
});
