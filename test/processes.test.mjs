import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seatSpawnOptions, terminateTree, sweepPathHolders } from '../src/engine/processes.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

const ON_WINDOWS = process.platform === 'win32';
const WINDOWS_ONLY = ON_WINDOWS ? false : 'runs on Windows only';

/** Records what would have been run, and answers with a fixed result. */
function recorder(result = { code: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const run = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return typeof result === 'function' ? result(file, args, opts) : result;
  };
  run.calls = calls;
  return run;
}

/** A child handle with the surface these functions touch. */
function fakeChild(pid = 4321) {
  return { pid, killed: 0, kill() { this.killed++; } };
}

function alive(pid) {
  return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(
    String(pid),
  );
}

// -- the spawn branch ---------------------------------------------------------

test('off Windows a seat spawns with exactly the options it had before', () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    assert.deepEqual(seatSpawnOptions({ platform }), {});
    assert.deepEqual(seatSpawnOptions({ platform, viaShim: true }), {});
  }
});

test('on Windows a seat spawns into a process group of its own', () => {
  // `detached` is DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP there, which is
  // what keeps a console event aimed at a seat away from the daemon.
  assert.deepEqual(seatSpawnOptions({ platform: 'win32' }), {
    detached: true,
    windowsHide: true,
  });
});

test('a seat that has to run under cmd keeps its output over its isolation', () => {
  // DETACHED_PROCESS leaves the interpreter without a console, and the tool it
  // starts then writes nowhere. Progress, cost and the model's refusal all
  // arrive on that stream, so the group is what gives way, not the stream.
  assert.deepEqual(seatSpawnOptions({ platform: 'win32', viaShim: true }), {
    windowsHide: true,
  });
});

// -- the deliberate kill ------------------------------------------------------

test('off Windows a deliberate kill is the same direct kill as before', async () => {
  const child = fakeChild();
  const run = recorder();
  await terminateTree(child, { platform: 'linux', run });
  assert.equal(child.killed, 1);
  assert.deepEqual(run.calls, []);
});

test('on Windows a deliberate kill takes the whole tree', async () => {
  const child = fakeChild(4321);
  const run = recorder();
  await terminateTree(child, { platform: 'win32', run });
  assert.equal(run.calls.length, 1);
  assert.match(run.calls[0].file, /taskkill/i);
  assert.deepEqual(run.calls[0].args, ['/PID', '4321', '/T', '/F']);
  // The tree kill answered; nothing else was needed.
  assert.equal(child.killed, 0);
});

test('a tree kill that cannot run still ends the child', async () => {
  for (const run of [
    recorder({ code: 128, stdout: '', stderr: 'not found' }),
    recorder(() => Promise.reject(new Error('taskkill is missing'))),
  ]) {
    const child = fakeChild();
    await terminateTree(child, { platform: 'win32', run });
    assert.equal(child.killed, 1);
  }
});

// -- the sweep ----------------------------------------------------------------

test('off Windows the release sweeps nothing and spawns nothing', async () => {
  const run = recorder();
  assert.deepEqual(await sweepPathHolders('/tmp/whatever', { platform: 'linux', run }), {
    count: 0,
    names: [],
  });
  assert.deepEqual(run.calls, []);
});

test('a root too broad to be one workspace is refused, not swept', async () => {
  const run = recorder();
  for (const root of ['', 'C:\\', 'worktrees\\r1', '.', undefined]) {
    const result = await sweepPathHolders(root, { platform: 'win32', run });
    assert.equal(result.count, 0);
    assert.match(result.error, /unsafe root/);
  }
  // Nothing was enumerated and, above all, nothing was killed.
  assert.deepEqual(run.calls, []);
});

test('the sweep hands the path over in the environment, never in the script', async () => {
  const root = 'C:\\home\\worktrees\\run-1';
  const run = recorder((file, args, opts) => {
    if (/powershell/i.test(file)) {
      assert.equal(opts.env.OLYMPUS_SWEEP_ROOT, root);
      // The script must carry no trace of the path it is asked about.
      assert.ok(!args.join(' ').includes(root));
      return { code: 0, stdout: '111 node.exe\r\n222 esbuild.exe\r\n111 node.exe\r\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  const result = await sweepPathHolders(root, { platform: 'win32', run });
  assert.deepEqual(result, { count: 3, names: ['esbuild.exe', 'node.exe'] });
  const killed = run.calls.filter((c) => /taskkill/i.test(c.file)).map((c) => c.args);
  assert.deepEqual(killed, [
    ['/PID', '111', '/T', '/F'],
    ['/PID', '222', '/T', '/F'],
    ['/PID', '111', '/T', '/F'],
  ]);
});

test('an enumeration that fails reports itself and kills nothing', async () => {
  const run = recorder((file) =>
    /powershell/i.test(file)
      ? { code: 1, stdout: '', stderr: 'CIM is unavailable' }
      : { code: 0, stdout: '', stderr: '' },
  );
  const result = await sweepPathHolders('C:\\home\\worktrees\\run-1', { platform: 'win32', run });
  assert.equal(result.count, 0);
  assert.match(result.error, /CIM is unavailable/);
  assert.equal(run.calls.filter((c) => /taskkill/i.test(c.file)).length, 0);
});

// -- the real host (Windows only) --------------------------------------------

test(
  'a deliberate kill reaches a seat descendant the handle does not name',
  { skip: WINDOWS_ONLY },
  async (t) => {
    const dir = tempDir();
    t.after(() => removeDir(dir));
    // The harness's real seat shape: a shim runs under cmd.exe, so the tool is
    // a grandchild of the process the handle names, and its own children are
    // further down again.
    const marker = join(dir, 'grandchild.pid');
    writeFileSync(
      join(dir, 'tool.mjs'),
      `import { spawn } from 'node:child_process';
       import { writeFileSync } from 'node:fs';
       const grand = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1<<30)']);
       writeFileSync(${JSON.stringify(marker)}, String(grand.pid));
       setInterval(() => {}, 1 << 30);`,
    );
    writeFileSync(join(dir, 'tool.cmd'), `@echo off\r\nnode "%~dp0tool.mjs" %*\r\n`);
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${join(dir, 'tool.cmd')}"`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: true,
      ...seatSpawnOptions({ viaShim: true }),
    });
    const grandPid = Number(
      await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8'), {
        label: 'the descendant to report its pid',
      }),
    );
    assert.ok(alive(grandPid), 'the descendant should be running before the kill');
    await terminateTree(child);
    await waitFor(() => !alive(grandPid), { label: 'the descendant to die with the seat' });
    assert.equal(alive(grandPid), false);
  },
);

test(
  'the sweep ends what is standing in a workspace and leaves the rest alone',
  { skip: WINDOWS_ONLY },
  async (t) => {
    const dir = tempDir();
    const workspace = join(dir, 'worktrees', 'run-1');
    mkdirSync(workspace, { recursive: true });
    const idle = 'setInterval(() => {}, 1 << 30);\n';
    writeFileSync(join(workspace, 'holder.mjs'), idle);
    writeFileSync(join(dir, 'bystander.mjs'), idle);
    // A tool run out of the workspace, and a bystander run beside it that must
    // survive: the sweep matches a workspace, not a process name.
    const holder = spawn(process.execPath, [join(workspace, 'holder.mjs')], { cwd: workspace });
    const bystander = spawn(process.execPath, [join(dir, 'bystander.mjs')], { cwd: dir });
    // The bystander sits in the directory on purpose, so it has to go before
    // the directory can: the removal it would otherwise block is the whole
    // failure this sweep exists to prevent.
    t.after(async () => {
      for (const child of [holder, bystander]) await terminateTree(child);
      await waitFor(() => !alive(bystander.pid), { label: 'the bystander to go' });
      removeDir(dir);
    });
    await waitFor(() => alive(holder.pid) && alive(bystander.pid), { label: 'both to be running' });
    const result = await sweepPathHolders(workspace);
    assert.equal(result.error, undefined);
    assert.ok(result.count >= 1, `expected the holder to be found, got ${JSON.stringify(result)}`);
    assert.ok(result.names.includes('node.exe'), JSON.stringify(result.names));
    await waitFor(() => !alive(holder.pid), { label: 'the holder to be swept' });
    assert.equal(alive(bystander.pid), true, 'a process outside the workspace must survive');
  },
);
