// The measurement, and the reading of an ending (ADR-0045). The first half is
// proved against a real spawned tree on the hosts that can be measured, because
// a peak nobody has read off a live process is a number in a comment. The
// second half is the classification, which decides — mechanically, with no seat
// in the loop — whether what killed a command was memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  startPeakSampler,
  exhaustionOf,
  parseProcStat,
  parseProcPeak,
  SAMPLE_INTERVAL_MS,
} from '../src/lanes/resources.mjs';
import { runCommand } from '../src/lanes/exec.mjs';

// The hosts this measures. Elsewhere it answers nothing, which is a stated
// answer and not a silent zero.
const MEASURED = process.platform === 'win32' || process.platform === 'linux';

// What the fixture command holds, and the floor the assertion uses. The gap
// between them is room for a runtime that reports its own overhead differently
// on two operating systems; it is not room for a reading that missed the
// allocation, which would come back near zero.
const HELD_MB = 300;
const FLOOR_MB = 220;

/**
 * A command that holds `HELD_MB` for long enough to be sampled, under a shell
 * so the thing being measured is a tree and not one process. The allocation is
 * touched (`Buffer.alloc` fills), because an untouched reservation is not a
 * working set on either platform.
 */
function holdsMemory() {
  const body =
    `const a=[];for(let i=0;i<${HELD_MB};i++)a.push(Buffer.alloc(1024*1024,1));` +
    "setTimeout(function(){console.log('held ' + a.length)},2200);";
  // The body holds quotes of its own, so the shell is handed it as an argument
  // rather than as text inside the script it runs.
  return process.platform === 'win32'
    ? ['cmd.exe', '/c', process.execPath, '-e', body]
    : ['sh', '-c', 'exec "$0" -e "$1"', process.execPath, body];
}

test('the peak of a real spawned tree is read, on the hosts that can be read', async (t) => {
  if (!MEASURED) {
    t.skip(`no peak-memory source on ${process.platform}`);
    return;
  }
  const run = await runCommand(holdsMemory(), { resources: true, sampleIntervalMs: 200 });
  t.after(() => run.log?.path && rmSync(run.log.path, { force: true }));

  assert.equal(run.code, 0, run.output);
  assert.ok(run.resources, 'a measurable host measured nothing');
  assert.ok(
    run.resources.peakRssMb >= FLOOR_MB,
    `read ${run.resources.peakRssMb} MB for a tree holding ${HELD_MB} MB`,
  );
  assert.ok(run.resources.samples > 0);
  // The floor of what the reading could have seen is on the reading itself, so
  // nobody has to assume it.
  assert.equal(run.resources.intervalMs, 200);
  assert.equal(
    run.resources.source,
    process.platform === 'win32' ? 'win32-cim' : 'linux-proc',
  );
  // The tree, not the process the harness spawned: the shell holds nothing and
  // the runtime under it holds all of it.
  assert.match(run.resources.peakProcess.name, /node/i);
  assert.ok(run.resources.peakProcess.rssMb >= FLOOR_MB);
});

test('a command that was not asked to be measured carries no reading at all', async (t) => {
  const run = await runCommand([process.execPath, '-e', 'console.log(1)']);
  t.after(() => run.log?.path && rmSync(run.log.path, { force: true }));
  assert.equal(run.resources, null);
});

test('a host with no source for the reading answers nothing, and says so by absence', async () => {
  const sampler = startPeakSampler(process.pid, { platform: 'sunos' });
  assert.equal(await sampler.stop(), null);
  // A spawn that never happened has no tree to measure.
  assert.equal(await startPeakSampler(undefined, { platform: 'linux' }).stop(), null);
  assert.equal(await startPeakSampler(-1, { platform: 'linux' }).stop(), null);
});

test('the sampling floor is stated once per platform, and it is on the record', async () => {
  // Two floors, because the two reads cost different things: a process-table
  // query is 75 ms of a core and a `/proc` walk is a few milliseconds. Neither
  // number is guessed at by a reader — whichever applied rides the reading.
  assert.equal(SAMPLE_INTERVAL_MS.win32, 2000);
  assert.equal(SAMPLE_INTERVAL_MS.linux, 250);
  const sampler = startPeakSampler(10, {
    platform: 'linux',
    readTree: () => [proc(10, 1, 30)],
  });
  assert.equal((await sampler.stop()).intervalMs, SAMPLE_INTERVAL_MS.linux);
});

// -- the tree walk ------------------------------------------------------------
//
// Stated tables rather than a live host: the three ways a walk can be wrong are
// a stranger counted in, a recycled process id grafted on, and a parent cycle
// that never returns. None of them can be staged on a real machine to order.

function proc(pid, ppid, peakMb, { name = `p${pid}`, startedAt = 100 } = {}) {
  return { pid, ppid, name, startedAt, peakBytes: peakMb * 1024 * 1024 };
}

async function walk(table, pid = 10) {
  const sampler = startPeakSampler(pid, { readTree: () => table, intervalMs: 60000 });
  return sampler.stop();
}

test('the reading is the whole tree under the command, and nothing beside it', async () => {
  const reading = await walk([
    proc(10, 1, 20, { name: 'sh' }),
    proc(11, 10, 400, { name: 'node' }),
    proc(12, 11, 30, { name: 'worker' }),
    // Another run's process, on the same host, at the same moment.
    proc(99, 1, 4000, { name: 'stranger' }),
  ]);
  assert.equal(reading.peakRssMb, 450);
  assert.deepEqual(reading.peakProcess, { name: 'node', rssMb: 400 });
});

test('a process older than the command is not in the command tree, whatever its parent id says', async () => {
  // Process ids are reused, and quickly. Without the age guard a recycled id
  // whose parent chain now points at the root grafts a stranger's memory on.
  const reading = await walk([
    proc(10, 1, 20, { startedAt: 500 }),
    proc(11, 10, 40, { startedAt: 600 }),
    proc(12, 10, 9000, { name: 'recycled', startedAt: 12 }),
  ]);
  assert.equal(reading.peakRssMb, 60);
});

test('a cycle in the parent map ends the walk instead of running it forever', async () => {
  const reading = await walk([proc(10, 11, 10), proc(11, 10, 10)]);
  assert.equal(reading.peakRssMb, 20);
});

test('a table that does not hold the command answers nothing', async () => {
  assert.equal(await walk([proc(77, 1, 10)]), null);
});

test('a process table that cannot be read costs the command nothing', async () => {
  const sampler = startPeakSampler(10, {
    readTree: () => {
      throw new Error('/proc is not readable here');
    },
  });
  assert.equal(await sampler.stop(), null);
});

// -- the Linux source ---------------------------------------------------------
//
// The fields are counted, and a command name that holds a space or a
// parenthesis is what moves the count. Asserted on stated lines because the
// process this suite runs in cannot be given an awkward name to order.

test('the parent and the start time survive a command name that holds anything', () => {
  const plain =
    '4242 (node) S 4200 4242 4200 0 -1 4194304 9001 0 0 0 41 7 0 0 20 0 11 0 987654 ' +
    '1122334455 6789 18446744073709551615';
  assert.deepEqual(parseProcStat(plain), { ppid: 4200, name: 'node', startedAt: 987654 });
  // A name with a space and a closing parenthesis inside it. Splitting the line
  // on spaces reads the parent id off the wrong field for this one.
  const awkward = plain.replace('(node)', '(a name (with) spaces)');
  assert.deepEqual(parseProcStat(awkward), {
    ppid: 4200,
    name: 'a name (with) spaces',
    startedAt: 987654,
  });
  assert.equal(parseProcStat('nothing that looks like a stat line'), null);
});

test('the peak read from a status file is the kernel high-water mark, in bytes', () => {
  const status = 'Name:\tnode\nState:\tS (sleeping)\nVmPeak:\t 9000000 kB\nVmHWM:\t  650000 kB\nVmRSS:\t   64000 kB\n';
  assert.equal(parseProcPeak(status), 650000 * 1024);
  // VmRSS is what the process holds now; VmHWM is what it held at its worst,
  // and the difference between the two is the whole reason the peak is read.
  assert.ok(parseProcPeak(status) > 64000 * 1024);
  assert.equal(parseProcPeak(null), 0);
  assert.equal(parseProcPeak('Name:\tkthreadd\n'), 0);
});

// -- what an ending means -----------------------------------------------------

const RED = { code: 1, output: '' };

test('a command that answered the question is never classed as a death', () => {
  assert.equal(exhaustionOf({ code: 0, output: 'JavaScript heap out of memory' }), null);
  // Nor is a green that ran right up against its ceiling: that is a forecast's
  // business, and this is the reading of a death.
  assert.equal(
    exhaustionOf({ code: 0, resources: { peakRssMb: 4096 } }, { ceilingMb: 4096 }),
    null,
  );
});

test('the abort a heap ceiling ends a process with is classed from the exit alone', () => {
  assert.equal(exhaustionOf({ code: 134, output: '' }).evidence, 'abort-exit');
  // Windows STATUS_NO_MEMORY.
  assert.equal(exhaustionOf({ code: 3221225495, output: '' }).evidence, 'abort-exit');
  assert.equal(exhaustionOf({ code: null, signal: 'SIGABRT', output: '' }).evidence, 'abort-signal');
});

test('the death the harness actually met is classed: a wrapper exit, with 134 in the text', () => {
  // The shape of both runs that found this class. The harness saw exit 1 — the
  // workspace tool's own code — and the abort was only ever in the output.
  const outcome = {
    code: 1,
    output:
      ' ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  app test:acceptance: `jest --runInBand`\n' +
      'Exit status 134\n ELIFECYCLE  Command failed with exit code 1.\n',
    resources: { peakRssMb: 3850 },
  };
  const found = exhaustionOf(outcome, { ceilingMb: 4096 });
  assert.equal(found.evidence, 'abort-reported');
  // The record names what it held and what it was allowed to hold: that pair
  // is the whole finding, and no seat has to reconstruct it.
  assert.equal(found.peakRssMb, 3850);
  assert.equal(found.ceilingMb, 4096);
});

test('the words a runtime prints about memory are classed, and only those words', () => {
  const say = (text) => exhaustionOf({ code: 1, output: text })?.evidence ?? null;
  assert.equal(say('FATAL ERROR: Reached heap limit Allocation failed'), 'heap-abort');
  assert.equal(say('<--- Last few GCs --->\nJavaScript heap out of memory'), 'heap-abort');
  assert.equal(say('spawn ENOMEM'), 'os-refusal');
  assert.equal(say('fork: Cannot allocate memory'), 'os-refusal');
  assert.equal(say('Killed: process ran out of memory'), 'os-refusal');
  // An ordinary red is an ordinary red.
  assert.equal(say('1 failing\n  expected 2 to equal 3'), null);
  assert.equal(say(''), null);
});

test('a sequence that died in the middle is read in the part that died', () => {
  // A layer command is often a sequence, each part keeps a tail of its own, and
  // the tail of the whole stream is whatever ran last. The death is in the part
  // (ADR-0043), so the parts are read too.
  const found = exhaustionOf({
    code: 1,
    output: '\n 4 passed (1.4m)\n ELIFECYCLE  Command failed with exit code 1.\n',
    parts: [
      { name: 'unit', output: 'all green' },
      { name: 'acceptance', output: 'FATAL ERROR: Reached heap limit Allocation failed' },
    ],
  });
  assert.equal(found.evidence, 'heap-abort');
});

test('a signal the daemon sent is not a memory death', () => {
  // The daemon kills a run's tree when it stops, and every one of those endings
  // would carry the word if a signal alone were evidence.
  assert.equal(exhaustionOf({ code: null, signal: 'SIGKILL', output: 'ran for a while' }), null);
  assert.equal(exhaustionOf({ code: null, signal: 'SIGTERM', output: '' }), null);
  assert.equal(exhaustionOf({ code: 137, output: '' }), null);
});

test('a red that reached the ceiling is classed on the measurement, with nothing else to go on', () => {
  const found = exhaustionOf({ ...RED, resources: { peakRssMb: 4100 } }, { ceilingMb: 4096 });
  assert.equal(found.evidence, 'ceiling-crossed');
  assert.equal(found.peakRssMb, 4100);
  // Under the ceiling, a red with nothing to say about memory says nothing.
  assert.equal(exhaustionOf({ ...RED, resources: { peakRssMb: 900 } }, { ceilingMb: 4096 }), null);
  // And a project that declared no ceiling never crosses one.
  assert.equal(exhaustionOf({ ...RED, resources: { peakRssMb: 99999 } }), null);
});
