// The command primitive's output file (ADR-0043). The in-memory tail is a
// summary and always was; what these hold is the record under it — that every
// command writes one, that a green's is gone the moment it settles, that a
// failure's survives with the whole stream in it, that a cap is stamped rather
// than silent, and that no file this writes keeps a handle open past the call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_LOG_ROOT, LOG_CAP, runCommand } from '../src/lanes/exec.mjs';
import { tempDir, removeDir } from './helpers.mjs';

// The bound the record kept before there was a file, and the bound the replay
// probe hands a seat. A test that proves the file outgrew both proves the
// class the file was written for is closed.
const OLD_TAIL = 4000;
const PROBE_TAIL = 12000;

function fixture(t) {
  const root = tempDir('olympus-command-log-');
  t.after(() => removeDir(root));
  return { root, file: (name) => join(root, 'commands', `${name}.log`) };
}

/** A command that prints `size` characters, then one named line, then exits. */
function talks(size, last, code) {
  return [
    process.execPath,
    '-e',
    `console.log('x'.repeat(${size}));console.log(${JSON.stringify(last)});process.exit(${code});`,
  ];
}

test('a green command leaves no file behind when it settles', async (t) => {
  const { file } = fixture(t);
  const path = file('green');
  const run = await runCommand(talks(9000, 'all of it passed', 0), { log: path });

  assert.equal(run.code, 0);
  assert.equal(run.log.path, path);
  assert.equal(run.log.removed, true);
  assert.equal(existsSync(path), false, 'a green kept its file');
  // The tail is what a green is worth, and it is still there.
  assert.match(run.output, /all of it passed/);
});

test("a red command's file survives, and holds what the tail could not", async (t) => {
  const { file } = fixture(t);
  const path = file('red');
  // The failure is printed first and the noise after it, which is the shape
  // that beat the tail three times: a red in the middle of a long sequence.
  const argv = [
    process.execPath,
    '-e',
    "console.log('THE STEP THAT FAILED');console.log('y'.repeat(30000));process.exit(1);",
  ];
  const run = await runCommand(argv, { log: path });

  assert.equal(run.code, 1);
  assert.equal(run.log.removed, undefined);
  assert.ok(run.truncated, 'the tail did not outgrow its bound');
  assert.ok(!run.output.includes('THE STEP THAT FAILED'), 'the tail held the failure anyway');

  const held = readFileSync(path, 'utf8');
  assert.match(held, /THE STEP THAT FAILED/);
  assert.ok(held.length > PROBE_TAIL, `the file holds ${held.length}, no more than a tail`);
  assert.ok(held.length > OLD_TAIL);
  assert.equal(run.log.truncated, false);
  assert.equal(run.log.bytes, statSync(path).size);
});

test('a command that could not run at all writes no file and says so', async (t) => {
  const { file } = fixture(t);
  const path = file('unrunnable');
  const run = await runCommand([join(process.cwd(), 'no-such-tool-anywhere')], { log: path });
  assert.equal(run.code, null);
  assert.ok(run.error);
  assert.equal(existsSync(path), false);
});

test('a failure that printed nothing leaves no empty file to be read as evidence', async (t) => {
  const { root, file } = fixture(t);
  const run = await runCommand([process.execPath, '-e', 'process.exit(2)'], { log: file('quiet') });
  assert.equal(run.code, 2);
  assert.equal(run.log.removed, true);
  assert.deepEqual(readdirSync(join(root, 'commands')), []);
});

test('a caller whose whole purpose is the output keeps the file of a green too', async (t) => {
  const { file } = fixture(t);
  const path = file('kept');
  const run = await runCommand(talks(20, 'the replay passed this time', 0), {
    log: path,
    keep: 'always',
  });
  assert.equal(run.code, 0);
  assert.equal(run.log.removed, undefined);
  assert.match(readFileSync(path, 'utf8'), /the replay passed this time/);
});

test('the cap stops the file, stamps it truncated, and says so in the file', async (t) => {
  const { file } = fixture(t);
  const path = file('capped');
  const run = await runCommand(talks(5000, 'never written', 1), { log: path, logCap: 500 });

  assert.equal(run.log.truncated, true);
  assert.equal(run.log.bytes, 500);
  const held = readFileSync(path, 'utf8');
  assert.match(held, /this log stopped at the 500-byte cap/);
  assert.ok(!held.includes('never written'), 'the cap did not stop the writing');
});

test('the cap a command meets by default is ten megabytes, and it is not silent', async () => {
  assert.equal(LOG_CAP, 10 * 1024 * 1024);
  // The real cap, met by a real command: a runaway printing more than the file
  // may hold. It costs a few seconds, and it is the only proof that the number
  // in the constant is the number the writer enforces.
  const argv = [
    process.execPath,
    '-e',
    "const line='x'.repeat(1024*1024);for(let i=0;i<11;i++)console.log(line);process.exit(1);",
  ];
  const run = await runCommand(argv);
  try {
    assert.equal(run.log.truncated, true);
    assert.equal(run.log.bytes, LOG_CAP);
    assert.ok(statSync(run.log.path).size > LOG_CAP, 'the notice went missing');
    assert.match(readFileSync(run.log.path, 'utf8').slice(-200), /stopped at the 10485760-byte cap/);
  } finally {
    rmSync(run.log.path, { force: true });
  }
});

test('a caller that names no file still gets one, under the root for the runless', async (t) => {
  const run = await runCommand(talks(20, 'a failure with no run behind it', 1));
  t.after(() => rmSync(run.log.path, { force: true }));
  assert.equal(run.log.path.startsWith(COMMAND_LOG_ROOT), true, run.log.path);
  assert.match(readFileSync(run.log.path, 'utf8'), /a failure with no run behind it/);
});

test('the one caller that may hold nothing writes nothing, anywhere', async (t) => {
  const { root, file } = fixture(t);
  // A word only this command prints, so the search below answers about this
  // command and not about whatever else the suite is running beside it.
  const secret = 'a-credential-probe-said-no-42';
  const run = await runCommand(talks(20, secret, 1), { log: false });
  assert.equal(run.code, 1);
  assert.equal(run.log, null);
  assert.match(run.output, new RegExp(secret), 'the caller was answered nothing at all');
  assert.equal(existsSync(file('anything')), false);
  assert.deepEqual(holding(root, secret), []);
  assert.deepEqual(holding(COMMAND_LOG_ROOT, secret), []);
});

/**
 * Every file under a directory that holds a word. Tolerant of a file that
 * vanishes mid-walk: the root for runless commands is shared with whatever
 * else this suite is running, and a green deletes its own file there.
 */
function holding(dir, word) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) found.push(...holding(path, word));
      else if (readFileSync(path, 'utf8').includes(word)) found.push(path);
    } catch {
      continue;
    }
  }
  return found;
}

test('the redaction runs before the file, so no unredacted copy is ever on disk', async (t) => {
  const { file } = fixture(t);
  const path = file('redacted');
  const value = 'the-value-no-file-may-carry';
  const argv = [
    process.execPath,
    '-e',
    `console.log('key was ' + process.env.PROBE_VALUE);process.exit(1);`,
  ];
  const run = await runCommand(argv, {
    log: path,
    env: { PROBE_VALUE: value },
    redact: (text) => text.split(value).join('[redacted:PROBE_VALUE]'),
  });
  assert.ok(!readFileSync(path, 'utf8').includes(value), 'the value reached the disk');
  assert.match(readFileSync(path, 'utf8'), /key was \[redacted:PROBE_VALUE\]/);
  assert.ok(!run.output.includes(value), 'the value reached the tail');
});

test('the file holds the stream the command printed, part markers and all', async (t) => {
  const { file } = fixture(t);
  const path = file('parts');
  const argv = [
    process.execPath,
    '-e',
    "console.log('::olympus part unit suite');console.log('the unit suite failed');" +
      "console.log('::olympus part-failed unit suite');console.log('::olympus part e2e suite');" +
      "console.log('z'.repeat(9000));process.exit(1);",
  ];
  const run = await runCommand(argv, { log: path });

  // The parts read exactly as they always did: the markers are consumed there.
  assert.deepEqual(run.parts.map((p) => p.name), ['unit suite', 'e2e suite']);
  assert.match(run.parts[0].output, /the unit suite failed/);
  assert.ok(!run.output.includes('::olympus'), 'a marker reached the tail');
  // The file is the stream, which is what a person opening it expects to read.
  const held = readFileSync(path, 'utf8');
  assert.match(held, /::olympus part-failed unit suite/);
  assert.match(held, /the unit suite failed/);
});

test('the file is closed before the caller is answered, so the run can be archived', async (t) => {
  // A handle inside a run directory is a directory Windows will not rename,
  // and the archive at close-out is a rename. The property is the release, so
  // it is asserted by doing what the archive does, immediately.
  const root = tempDir('olympus-command-log-handle-');
  t.after(() => removeDir(root));
  const live = join(root, 'runs', 'r1');
  mkdirSync(live, { recursive: true });
  const run = await runCommand(talks(2000, 'a red worth archiving', 1), {
    log: join(live, 'commands', 'layer.log'),
  });
  assert.ok(existsSync(run.log.path));
  renameSync(live, join(root, 'archive-r1'));
  assert.match(
    readFileSync(join(root, 'archive-r1', 'commands', 'layer.log'), 'utf8'),
    /a red worth archiving/,
  );
});
