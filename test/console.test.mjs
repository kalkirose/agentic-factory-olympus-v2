// Console surface: the status render (loud first, then queue), the full
// queue render, and the olympusctl command path into the control inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldHome } from '../src/daemon/home.mjs';
import { openRunStore, openInstanceStore } from '../src/telemetry/stores.mjs';
import { renderStatus, renderQueue } from '../src/console/status.mjs';
import { tempDir, removeDir } from './helpers.mjs';

function seededHome(t) {
  const root = tempDir();
  t.after(() => removeDir(root));
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { alpha: { repoUrl: 'unused', slotCap: 3 } } }) + '\n',
  );
  const instance = openInstanceStore(paths);
  instance.append('arming-changed', { actor: 'human', project: 'alpha', armed: true });
  instance.append('factory-starvation', {
    actor: 'daemon',
    project: 'alpha',
    reason: 'seeded',
    gist: 'factory-starvation: alpha — seeded',
  });
  instance.close();
  const run = openRunStore(paths, 'r1');
  run.append('run-launched', { actor: 'daemon', project: 'alpha', lane: 'story', storyKey: 's1' });
  run.append('stage-entered', { actor: 'daemon', stage: 'work' });
  run.append('park', {
    actor: 'daemon',
    type: 'open-decisions',
    question: 'Decide the scope of s1.',
    answers: { options: ['narrow', 'wide', 'abandon'], text: 'the scope, in words' },
    gist: 'open-decisions: s1',
  });
  run.close();
  return { root, paths };
}

test('status renders chips, loud before queue, runs, and arming', (t) => {
  const { paths } = seededHome(t);
  const status = renderStatus(paths);
  assert.match(status, /daemon stopped/);
  assert.match(status, /runs 0 active \/ 1 parked/);
  assert.match(status, /loud 1 · queue 1/);
  assert.ok(status.indexOf('LOUD') < status.indexOf('QUEUE'));
  assert.ok(status.indexOf('QUEUE') < status.indexOf('RUNS'));
  assert.match(status, /factory-starvation: alpha/);
  assert.match(status, /open-decisions: s1/);
  assert.match(status, /r1 story @ work · \$0\.00 \[parked:open-decisions\]/);
  assert.match(status, /alpha: armed, slot cap 3/);
});

test('the queue render is answerable from the record alone', (t) => {
  const { paths } = seededHome(t);
  const rendered = renderQueue(paths);
  assert.match(rendered, /open-decisions · run:r1#3/);
  assert.match(rendered, /story: s1/);
  assert.match(rendered, /Decide the scope of s1\./);
  // The forms come off the record, so the line an operator reads is the line
  // the engine takes (ADR-0029).
  assert.match(rendered, /options: narrow \| wide \| abandon/);
  assert.match(rendered, /text: the scope, in words/);
  assert.match(rendered, /olympusctl answer --run r1 --option <option> \| --text "<answer>"/);
});

test('olympusctl writes control commands and renders status', (t) => {
  const { root, paths } = seededHome(t);
  const bin = join(import.meta.dirname, '..', 'bin', 'olympusctl.mjs');
  const home = join(root, 'home');
  const out = execFileSync(process.execPath, [bin, 'status', '--home', home], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.match(out, /daemon stopped/);
  execFileSync(
    process.execPath,
    [bin, 'answer', '--home', home, '--run', 'r1', '--option', 'narrow', '--actor', 'human'],
    { encoding: 'utf8', windowsHide: true },
  );
  execFileSync(process.execPath, [bin, 'pause', '--home', home, '--project', 'alpha'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const files = readdirSync(paths.control).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 2);
  const answer = JSON.parse(
    readFileSync(join(paths.control, files.find((f) => f.startsWith('answer'))), 'utf8'),
  );
  assert.deepEqual(answer, { command: 'answer', actor: 'human', runId: 'r1', option: 'narrow' });
  const pause = JSON.parse(
    readFileSync(join(paths.control, files.find((f) => f.startsWith('pause'))), 'utf8'),
  );
  assert.equal(pause.command, 'pause');
  assert.equal(pause.project, 'alpha');
  assert.match(pause.actor, /^console:/);
});

test('a repair launch carries its ticket; lane and ticket must agree', (t) => {
  const { root, paths } = seededHome(t);
  const bin = join(import.meta.dirname, '..', 'bin', 'olympusctl.mjs');
  const home = join(root, 'home');
  const ctl = (args) =>
    execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', windowsHide: true });
  const refused = (args) => {
    try {
      ctl(args);
    } catch (error) {
      return { status: error.status, stderr: error.stderr };
    }
    throw new Error(`expected olympusctl to refuse: ${args.join(' ')}`);
  };

  const args = ['--project', 'alpha', '--lane', 'repair', '--ticket', 'tickets/t1.md'];
  ctl(['launch', '--home', home, ...args]);
  const file = readdirSync(paths.control).find((f) => f.startsWith('launch'));
  const launch = JSON.parse(readFileSync(join(paths.control, file), 'utf8'));
  assert.equal(launch.lane, 'repair');
  assert.equal(launch.ticket, 'tickets/t1.md');

  // A repair run without its ticket has no spec, and a ticket the lane drops
  // is a silent surprise: both are refused before the inbox, exit code 2.
  const noTicket = refused(['launch', '--home', home, '--project', 'alpha', '--lane', 'repair']);
  assert.equal(noTicket.status, 2);
  assert.match(noTicket.stderr, /--lane repair requires --ticket/);
  const wrongLane = refused([
    'launch',
    '--home',
    home,
    '--project',
    'alpha',
    '--ticket',
    'tickets/t1.md',
  ]);
  assert.equal(wrongLane.status, 2);
  assert.match(wrongLane.stderr, /--ticket applies to --lane repair only \(lane: story\)/);
  assert.equal(readdirSync(paths.control).filter((f) => f.endsWith('.json')).length, 1);
});
