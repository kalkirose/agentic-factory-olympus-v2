// Console surface: the status render (loud first, then queue), the full
// queue render, the session identity every command stamps, and the olympusctl
// command path into the control inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldHome } from '../src/daemon/home.mjs';
import { openRunStore, openInstanceStore } from '../src/telemetry/stores.mjs';
import { renderStatus, renderQueue } from '../src/console/status.mjs';
import { consoleActor } from '../src/console/identity.mjs';
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

test('status carries what this start found in the seat environment', (t) => {
  const { paths } = seededHome(t);
  const instance = openInstanceStore(paths);
  instance.append('daemon-started', { actor: 'daemon', pid: 1, runsResumed: [] });
  instance.append('seat-environment', {
    actor: 'daemon',
    check: 'runner-trust',
    severity: 'degraded',
    reason: 'untrusted',
    path: 'C:/home/worktrees',
    gist: 'the runner holds no trust record covering C:/home/worktrees',
  });
  // The start after a defect was fixed is the whole record: a finding behind
  // an older start describes a host that no longer runs the seats.
  instance.append('daemon-stopped', { actor: 'daemon', trigger: 'api' });
  instance.append('daemon-started', { actor: 'daemon', pid: 2, runsResumed: [] });
  instance.close();
  const status = renderStatus(paths);
  assert.ok(!status.includes('SEAT ENVIRONMENT'));

  const next = openInstanceStore(paths);
  next.append('seat-environment', {
    actor: 'daemon',
    check: 'runner-command',
    severity: 'blocking',
    reason: 'unresolvable',
    path: 'runner',
    gist: 'the seat runner runner resolves to no executable file on this host',
  });
  next.close();
  const after = renderStatus(paths);
  assert.match(after, /SEAT ENVIRONMENT \(1 at this start\)/);
  assert.match(after, /blocking · runner-command — the seat runner runner resolves/);
  assert.ok(!after.includes('runner-trust'));
});

test('a run in verdict carries the share of its part work it did not do', (t) => {
  // ADR-0058. The stage that spends gate-command hours is the one stage where
  // the carry is worth a place on the status page.
  const { paths } = seededHome(t);
  const run = openRunStore(paths, 'r2');
  run.append('run-launched', { actor: 'daemon', project: 'alpha', lane: 'story', storyKey: 's2' });
  run.append('stage-entered', { actor: 'daemon', stage: 'verdict' });
  run.append('verdict-rendered', {
    actor: 'daemon',
    cycle: 1,
    sweep: 'targeted',
    partsRun: 3,
    partsCarried: 17,
    carryShare: 0.85,
    verdict: 'red',
    open: [],
  });
  run.close();
  assert.match(renderStatus(paths), /r2 story @ verdict · \$0\.00 · carry 85%/);

  // A run in any other stage says nothing about it, and a run that has
  // rendered no verdict has nothing to say.
  const moved = openRunStore(paths, 'r2');
  moved.append('stage-entered', { actor: 'daemon', stage: 'ship' });
  moved.close();
  const after = renderStatus(paths);
  assert.match(after, /r2 story @ ship · \$0\.00$/m);
  assert.match(after, /r1 story @ work · \$0\.00 \[parked:open-decisions\]/);
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

// -- the session behind a command --------------------------------------------
//
// Two operator sessions under one login used to stamp one name, and a ledger
// that gives both the same name cannot say which of them answered a park.

test('two sessions on one login stamp two names, and one session stamps one', () => {
  const session = { username: 'op', env: {}, ppid: 4100 };
  // Same shell, second command: the same stamp, so a reader can follow one
  // session through the ledger.
  assert.equal(consoleActor(session), consoleActor(session));
  assert.notEqual(consoleActor(session), consoleActor({ ...session, ppid: 4200 }));
  assert.match(consoleActor(session), /^console:op:[0-9a-f]{8}$/);

  // The terminal's own session variable outranks the parent, because every
  // child of that window inherits it: a wrapper process between the shell and
  // the console changes the parent and not the session.
  const window = { username: 'op', env: { WT_SESSION: 'ac3f-1' }, ppid: 4100 };
  assert.equal(consoleActor(window), consoleActor({ ...window, ppid: 9999 }));
  assert.notEqual(consoleActor(window), consoleActor({ ...window, env: { WT_SESSION: 'ac3f-2' } }));
  assert.notEqual(
    consoleActor(window),
    consoleActor({ ...window, env: { TERM_SESSION_ID: 'ac3f-1' } }),
  );
});

test('an operator names a session, and an unnameable one keeps the old stamp', () => {
  const base = { username: 'op', env: { WT_SESSION: 'ac3f-1' }, ppid: 4100 };
  // The override outranks every derivation and reads as written: a stamp an
  // operator chose is a stamp an operator can recognise.
  assert.equal(consoleActor({ ...base, env: { ...base.env, OLYMPUS_CONSOLE_ID: 'lane-a' } }),
    'console:op:lane-a');
  // A stamp is read by eye and matched by machine, so a label carries a short
  // word and nothing else; a label with nothing left of it counts as unset.
  assert.equal(
    consoleActor({ ...base, env: { ...base.env, OLYMPUS_CONSOLE_ID: 'lane a:2' } }),
    'console:op:lanea2',
  );
  assert.equal(
    consoleActor({ ...base, env: { ...base.env, OLYMPUS_CONSOLE_ID: '   ' } }),
    consoleActor(base),
  );

  // No session variable and no parent to name: the old stamp, never a refusal
  // and never an invented identity.
  assert.equal(consoleActor({ username: 'op', env: {}, ppid: 0 }), 'console:op');
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
  // No --actor: the console derives the session and stamps it whole.
  assert.match(pause.actor, /^console:.+:.+$/);
});

test('the console stamps its session, and says which one it stamped', (t) => {
  const { root, paths } = seededHome(t);
  const bin = join(import.meta.dirname, '..', 'bin', 'olympusctl.mjs');
  const home = join(root, 'home');
  const arm = (env) =>
    execFileSync(process.execPath, [bin, 'arm', '--home', home, '--project', 'alpha'], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...env },
    });

  // One session, two commands, one stamp — with zero setup on the way in.
  const first = arm({});
  const second = arm({});
  const stamps = () =>
    readdirSync(paths.control)
      .filter((f) => f.startsWith('arm'))
      .map((f) => JSON.parse(readFileSync(join(paths.control, f), 'utf8')).actor);
  const [a, b] = stamps();
  assert.equal(a, b);
  assert.match(a, /^console:.+:.+$/);
  // The stamp is derived, so the console prints the one it wrote: this line is
  // where an operator reads the id the ledger will carry.
  assert.ok(first.includes(`as ${a}`), first);
  assert.ok(second.includes(`as ${a}`), second);

  // A second session on the same login is a different stamp.
  arm({ OLYMPUS_CONSOLE_ID: 'lane-b' });
  const all = new Set(stamps());
  assert.equal(all.size, 2);
  assert.ok(all.has('console:' + a.split(':')[1] + ':lane-b'));
});

// The name the daemon claims is created by the rename and never by a write,
// so a reader of the inbox sees a whole command or no file at all. A console
// runs in its own process, and the daemon's intake reads on a directory
// watch: any write straight to the claimed name puts a partial file in front
// of it — first the empty file the create leaves, then the blocks as they
// land.
test('a queued command appears under its claimed name whole or not at all', async (t) => {
  const { root, paths } = seededHome(t);
  const bin = join(import.meta.dirname, '..', 'bin', 'olympusctl.mjs');
  const home = join(root, 'home');
  const answer = 'x'.repeat(20000);
  const ctl = spawn(
    process.execPath,
    [bin, 'answer', '--home', home, '--run', 'r1', '--text', answer, '--actor', 'tester'],
    { windowsHide: true, stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => ctl.on('exit', resolve));
  let running = true;
  exited.then(() => {
    running = false;
  });
  // The first sighting is the one that matters: under a rename it is already
  // the whole command, and under a plain write it is whatever had landed.
  let sighting = null;
  while (sighting === null) {
    const name = readdirSync(paths.control).find((f) => f.endsWith('.json'));
    if (name) sighting = readFileSync(join(paths.control, name), 'utf8');
    else if (!running) break;
    else await new Promise((resolve) => setImmediate(resolve));
  }
  await exited;
  assert.equal(ctl.exitCode, 0);
  assert.notEqual(sighting, null);
  assert.equal(JSON.parse(sighting).answer, answer);
  // Nothing of the temporary name survives the publish.
  assert.deepEqual(readdirSync(paths.control).filter((f) => f.endsWith('.tmp')), []);
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

test('a repair launch carries the escape it repairs; the daemon reads the rest', (t) => {
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

  const repair = ['--project', 'alpha', '--lane', 'repair', '--ticket', 'tickets/t1.md'];
  ctl(['launch', '--home', home, ...repair, '--escape', '4']);
  const file = readdirSync(paths.control).find((f) => f.startsWith('launch'));
  const launch = JSON.parse(readFileSync(join(paths.control, file), 'utf8'));
  // A number, not the string an argv gives: the daemon takes an integer seq.
  assert.equal(launch.escape, 4);

  // An escape rides the run payload for the close-out fix-back to read back;
  // on any other lane nothing would ever read it.
  const wrongLane = refused([
    'launch',
    '--home',
    home,
    '--project',
    'alpha',
    '--escape',
    '4',
  ]);
  assert.equal(wrongLane.status, 2);
  assert.match(wrongLane.stderr, /--escape applies to --lane repair only \(lane: story\)/);
  const notASeq = refused(['launch', '--home', home, ...repair, '--escape', 'the first one']);
  assert.equal(notASeq.status, 2);
  assert.match(notASeq.stderr, /--escape takes the escape's seq in the escapes ledger/);
  assert.equal(readdirSync(paths.control).filter((f) => f.endsWith('.json')).length, 1);
});

test('a fixed-mark queues with its evidence and is refused without it', (t) => {
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

  ctl([
    'fixed',
    '--home',
    home,
    '--escape',
    '2',
    '--evidence',
    'fixed by hand on the default branch',
    '--actor',
    'human',
  ]);
  const file = readdirSync(paths.control).find((f) => f.startsWith('fixed'));
  assert.deepEqual(JSON.parse(readFileSync(join(paths.control, file), 'utf8')), {
    command: 'fixed',
    actor: 'human',
    escape: 2,
    evidence: 'fixed by hand on the default branch',
  });

  // A mark with nothing behind it retires a defect on somebody's memory, so
  // the evidence is not optional and blank is not evidence.
  const noEvidence = refused(['fixed', '--home', home, '--escape', '2']);
  assert.equal(noEvidence.status, 2);
  assert.match(noEvidence.stderr, /--evidence is required/);
  const blank = refused(['fixed', '--home', home, '--escape', '2', '--evidence', '   ']);
  assert.equal(blank.status, 2);
  assert.match(blank.stderr, /--evidence cannot be empty/);
  const noEscape = refused(['fixed', '--home', home, '--evidence', 'fixed by hand']);
  assert.equal(noEscape.status, 2);
  assert.match(noEscape.stderr, /--escape is required/);
  assert.equal(readdirSync(paths.control).filter((f) => f.endsWith('.json')).length, 1);
});
