import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  seatSpawnOptions,
  terminateTree,
  sweepPathHolders,
  pathHolders,
} from '../src/engine/processes.mjs';
import { resolveArgv } from '../src/engine/executable.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

const ON_WINDOWS = process.platform === 'win32';
const WINDOWS_ONLY = ON_WINDOWS ? false : 'runs on Windows only';
// Everything the harness ships and runs. A spawn anywhere under these is a
// spawn on the operator's machine.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHIPPED = ['src', 'bin'];

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

/** Every `.mjs` file the harness ships, named from the repository root. */
function shippedFiles(dir = null) {
  const files = [];
  for (const entry of readdirSync(join(ROOT, dir ?? ''), { withFileTypes: true })) {
    const path = dir === null ? entry.name : `${dir}/${entry.name}`;
    if (dir === null && !SHIPPED.includes(entry.name)) continue;
    if (entry.isDirectory()) files.push(...shippedFiles(path));
    else if (entry.name.endsWith('.mjs')) files.push(path);
  }
  return files.sort();
}

/**
 * Every call in a module that starts a child process, with the source text of
 * its argument list. The names are the module's own `node:child_process`
 * import, plus `spawnImpl`, the one seam a caller may pass a spawn through.
 */
function childStartSites(text) {
  const imported = /import\s*\{([^}]*)\}\s*from\s*'node:child_process'/.exec(text);
  const names = new Set(
    imported ? imported[1].split(',').map((name) => name.trim().split(/\s+as\s+/).pop()) : [],
  );
  if (/\bspawnImpl\b/.test(text)) names.add('spawnImpl');
  const sites = [];
  for (const name of names) {
    if (name.length === 0) continue;
    const call = new RegExp(`\\b${name}\\s*\\(`, 'g');
    for (let match = call.exec(text); match; match = call.exec(text)) {
      const args = argumentText(text, match.index + match[0].length - 1);
      if (args !== null) sites.push({ name, args });
    }
  }
  return sites;
}

// The text between a call's parentheses. Strings and comments are stepped over
// whole, so an apostrophe or a bracket inside one cannot end the argument list.
function argumentText(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i) + 1;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      i = endOfString(text, i);
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (--depth === 0) return text.slice(open + 1, i);
    }
    if (i <= 0) return null;
  }
  return null;
}

function endOfString(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === text[start]) return i;
  }
  return -1;
}

// -- the spawn branch ---------------------------------------------------------

test('off Windows a seat spawns with exactly the options it had before', () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    assert.deepEqual(seatSpawnOptions({ platform }), {});
  }
});

test('on Windows a seat spawns onto a console with no window', () => {
  // CREATE_NO_WINDOW. One shape for every seat: the shim under `cmd.exe` and
  // the directly spawned tool are given the same console treatment.
  assert.deepEqual(seatSpawnOptions({ platform: 'win32' }), { windowsHide: true });
});

test('no seat is ever detached from a console', () => {
  // DETACHED_PROCESS leaves the seat with no console, and each console
  // descendant of a console-less process opens a visible one of its own.
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.equal('detached' in seatSpawnOptions({ platform }), false);
  }
});

// -- every place the harness starts a process ---------------------------------

test('nothing the harness starts can put a window on screen', () => {
  const offenders = [];
  for (const file of shippedFiles()) {
    for (const site of childStartSites(readFileSync(join(ROOT, file), 'utf8'))) {
      const where = `${file}: ${site.name}`;
      // Either the site states it, or it takes the seat shape that does.
      const hidden =
        /windowsHide:\s*true/.test(site.args) || /\.\.\.seatSpawnOptions\(/.test(site.args);
      if (!hidden) offenders.push(`${where} does not hide its window`);
      if (/\bdetached\b/.test(site.args)) offenders.push(`${where} detaches from its console`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the audit reads the sites it claims to read', () => {
  // A scan that matched nothing would pass the check above in silence.
  const found = [];
  for (const file of shippedFiles()) {
    for (const site of childStartSites(readFileSync(join(ROOT, file), 'utf8'))) {
      found.push(`${file}: ${site.name}`);
    }
  }
  assert.deepEqual(found.sort(), [
    'src/daemon/notifier.mjs: spawnImpl',
    'src/engine/processes.mjs: execFile',
    'src/engine/supervise.mjs: spawn',
    'src/isolation/git.mjs: execFile',
    'src/isolation/stacks.mjs: execFile',
    'src/lanes/exec.mjs: spawn',
  ]);
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
      // The working-directory reader goes the same way, for the same reason:
      // nothing this module composes is ever read as script.
      assert.match(opts.env.OLYMPUS_SWEEP_CWD_SOURCE, /NtQueryInformationProcess/);
      assert.ok(!args.join(' ').includes(opts.env.OLYMPUS_SWEEP_CWD_SOURCE));
      // The script must carry no trace of the path it is asked about.
      assert.ok(!args.join(' ').includes(root));
      return {
        code: 0,
        stdout: '111|cmdline|node.exe\r\n222|image|esbuild.exe\r\n111|cwd|node.exe\r\n',
        stderr: '',
      };
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

// -- the holders behind a leftover record ------------------------------------
// The record of a workspace nothing would delete is written from this, and an
// errno on its own leaves the operator with no next move.

test('the holder query names pids and image names, and ends nothing', async () => {
  const run = recorder((file) =>
    /powershell/i.test(file)
      ? { code: 0, stdout: '111|cwd|node.exe\r\n222|cmdline,image|esbuild.exe\r\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  );
  const result = await pathHolders('C:\\home\\worktrees\\run-1', { platform: 'win32', run });
  // What matched comes with the holder. A process matched on its working
  // directory is standing in the tree and nothing the OS reports about it says
  // so, which is the difference between an operator with a next move and one
  // reading an errno.
  assert.deepEqual(result, {
    holders: [
      { pid: 111, via: ['cwd'], name: 'node.exe' },
      { pid: 222, via: ['cmdline', 'image'], name: 'esbuild.exe' },
    ],
  });
  // A read, not a sweep: the release already killed what it could, and this
  // one says who survived it.
  assert.deepEqual(run.calls.filter((c) => /taskkill/i.test(c.file)), []);
});

test('a line the query did not write is not a holder', async () => {
  // Whatever else reaches the pipe — a warning, a progress record, a line a
  // profile printed — names no pid to kill.
  const run = recorder((file) =>
    /powershell/i.test(file)
      ? {
          code: 0,
          stdout: [
            'WARNING: something',
            '333',
            '444|node.exe',
            '|cwd|node.exe',
            '555|cwd|My Program.exe',
          ].join('\r\n'),
          stderr: '',
        }
      : { code: 0, stdout: '', stderr: '' },
  );
  const { holders } = await pathHolders('C:\\home\\worktrees\\run-1', { platform: 'win32', run });
  // The one well-formed line, image name and its space intact.
  assert.deepEqual(holders, [{ pid: 555, via: ['cwd'], name: 'My Program.exe' }]);
});

test('the holder query answers, never throws, and refuses an unsafe root', async () => {
  const failing = recorder((file) =>
    /powershell/i.test(file)
      ? { code: 1, stdout: '', stderr: 'CIM is unavailable' }
      : { code: 0, stdout: '', stderr: '' },
  );
  const unreadable = await pathHolders('C:\\home\\worktrees\\run-1', { platform: 'win32', run: failing });
  assert.deepEqual(unreadable.holders, []);
  assert.match(unreadable.error, /CIM is unavailable/);

  const run = recorder();
  const refused = await pathHolders('C:\\', { platform: 'win32', run });
  assert.deepEqual(refused.holders, []);
  assert.match(refused.error, /unsafe root/);
  // Off Windows there is nothing to read and nothing is spawned to find out.
  assert.deepEqual(await pathHolders('/home/home/worktrees/run-1', { platform: 'linux', run }), {
    holders: [],
  });
  assert.deepEqual(run.calls, []);
});

test('a record names a handful of holders, not every one of a hundred', async () => {
  const many = Array.from({ length: 25 }, (_, i) => `${100 + i}|cwd|node.exe`).join('\r\n');
  const run = recorder((file) =>
    /powershell/i.test(file) ? { code: 0, stdout: many, stderr: '' } : { code: 0, stdout: '', stderr: '' },
  );
  const { holders } = await pathHolders('C:\\home\\worktrees\\run-1', { platform: 'win32', run });
  assert.equal(holders.length, 10);
  // The sweep is not a record and takes them all.
  const swept = await sweepPathHolders('C:\\home\\worktrees\\run-1', { platform: 'win32', run });
  assert.equal(swept.count, 25);
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
      ...seatSpawnOptions(),
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
  'no descendant of a seat gets a window, and the shim still reaches the pipe',
  { skip: WINDOWS_ONLY },
  async (t) => {
    const dir = tempDir();
    t.after(() => removeDir(dir));
    // The probe answers for the console the calling process actually holds.
    // A handle of zero is a console with no window; a handle whose window is
    // not visible is one nobody sees. Anything else is a window on screen.
    const probe = join(dir, 'probe.ps1');
    writeFileSync(
      probe,
      [
        "Add-Type -Namespace P -Name C -MemberDefinition '" +
          '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();' +
          '[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);' +
          "'",
        '$h = [P.C]::GetConsoleWindow()',
        "if ($h -eq [System.IntPtr]::Zero) { 'nowindow' } else { 'visible=' + [P.C]::IsWindowVisible($h) }",
      ].join('\r\n'),
    );
    // A seat runs tools that are console programs of their own: git, a shell,
    // a build. This is one of them, reporting the console it was given.
    const report = join(dir, 'console.txt');
    writeFileSync(
      join(dir, 'tool.mjs'),
      `import { execFileSync } from 'node:child_process';
       import { appendFileSync } from 'node:fs';
       const answer = execFileSync('powershell.exe',
         ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ${JSON.stringify(probe)}],
         { encoding: 'utf8' });
       appendFileSync(${JSON.stringify(report)}, process.argv[2] + ' ' + answer.trim() + '\\n');`,
    );
    writeFileSync(join(dir, 'tool.cmd'), `@echo off\r\nnode "%~dp0tool.mjs" %*\r\necho shim-reached\r\n`);
    const run = async (label, spec) => {
      let out = '';
      const child = spawn(spec.file, spec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(spec.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
        ...seatSpawnOptions(),
      });
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      const code = await new Promise((resolve) => child.on('close', resolve));
      assert.equal(code, 0, `${label} exited ${code}: ${out}`);
      return out;
    };
    // Both seat shapes: a tool that spawns directly, and one the resolver has
    // to reach through a `cmd.exe` shim.
    await run('direct', { file: process.execPath, args: [join(dir, 'tool.mjs'), 'direct'] });
    const shimOut = await run('shim', resolveArgv(['tool', 'shim'], { env: { PATH: dir } }));
    // The shim's own output still arrives, which is where a seat's cost, its
    // session and its refusal to do the work are read from.
    assert.match(shimOut, /shim-reached/);
    const answers = readFileSync(report, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .sort();
    // Both shapes reported, so the shim's argument survived the escaping too.
    assert.equal(answers.length, 2, JSON.stringify(answers));
    assert.match(answers[0], /^direct /);
    assert.match(answers[1], /^shim /);
    for (const answer of answers) {
      assert.match(answer, /(nowindow|visible=False)$/, `a seat descendant got a window: ${answer}`);
    }
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

test(
  'a process standing in a workspace is found when nothing about it names one',
  { skip: WINDOWS_ONLY },
  async (t) => {
    const dir = tempDir();
    const workspace = join(dir, 'worktrees', 'run-1');
    mkdirSync(workspace, { recursive: true });
    // The holder the ledger showed and the query did not: a dev server or a
    // build worker started with a relative argument out of the app directory.
    // Its image is the shared node, its command line names no path at all, and
    // its working directory is the one thing keeping the tree undeletable.
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
      cwd: workspace,
      windowsHide: true,
    });
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
      cwd: dir,
      windowsHide: true,
    });
    t.after(async () => {
      for (const child of [holder, bystander]) await terminateTree(child);
      await waitFor(() => !alive(bystander.pid), { label: 'the bystander to go' });
      removeDir(dir);
    });
    await waitFor(() => alive(holder.pid) && alive(bystander.pid), { label: 'both to be running' });

    const { holders, error } = await pathHolders(workspace, { limit: Infinity });
    assert.equal(error, undefined);
    const found = holders.find((h) => h.pid === holder.pid);
    assert.ok(found, `the holder was not named: ${JSON.stringify(holders)}`);
    // On its working directory and on nothing else — the command line and the
    // image path are both outside the workspace.
    assert.deepEqual(found.via, ['cwd']);
    assert.equal(found.name, 'node.exe');
    assert.equal(holders.some((h) => h.pid === bystander.pid), false);

    // And the sweep ends it, because a process standing in a tree the harness
    // is deleting is the whole reason the delete was failing.
    const swept = await sweepPathHolders(workspace);
    assert.equal(swept.error, undefined);
    await waitFor(() => !alive(holder.pid), { label: 'the holder to be swept' });
    assert.equal(alive(bystander.pid), true, 'a process outside the workspace must survive');
  },
);
