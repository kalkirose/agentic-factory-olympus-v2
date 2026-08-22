import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveArgv,
  findExecutable,
  batchCommandLine,
  commandLineLength,
  COMMAND_LINE_MAX,
} from '../src/engine/executable.mjs';
import { runCommand } from '../src/lanes/exec.mjs';
import { tempDir, removeDir } from './helpers.mjs';

const ON_WINDOWS = process.platform === 'win32';
const WINDOWS_ONLY = ON_WINDOWS ? false : 'runs on Windows only';

/** A file set as a lookup predicate — the search rule without a filesystem. */
function fileSet(...paths) {
  const set = new Set(paths);
  return (path) => set.has(path);
}

// -- the search rule (any platform) ------------------------------------------

test('a real executable outranks a shim, wherever on PATH it sits', () => {
  const found = findExecutable('tool', {
    pathValue: 'C:\\first;C:\\second',
    isFile: fileSet(join('C:\\first', 'tool.cmd'), join('C:\\second', 'tool.exe')),
  });
  assert.equal(found, join('C:\\second', 'tool.exe'));
});

test('a shim resolves when no real executable exists', () => {
  const found = findExecutable('tool', {
    pathValue: 'C:\\first;C:\\second',
    isFile: fileSet(join('C:\\second', 'tool.cmd')),
  });
  assert.equal(found, join('C:\\second', 'tool.cmd'));
});

test('an extensionless file is never taken for an executable', () => {
  // The npm-style install layout: a shell script under the bare name, next to
  // the shims. Windows cannot run the bare file.
  const found = findExecutable('tool', {
    pathValue: 'C:\\bin',
    isFile: fileSet(join('C:\\bin', 'tool')),
  });
  assert.equal(found, null);
});

test('an explicit known extension names the file itself', () => {
  const found = findExecutable('tool.cmd', {
    pathValue: 'C:\\bin',
    isFile: fileSet(join('C:\\bin', 'tool.cmd'), join('C:\\bin', 'tool.exe')),
  });
  assert.equal(found, join('C:\\bin', 'tool.cmd'));
});

test('an extension that needs an interpreter resolves to nothing', () => {
  const found = findExecutable('tool.ps1', {
    pathValue: 'C:\\bin',
    isFile: fileSet(join('C:\\bin', 'tool.ps1')),
  });
  assert.equal(found, null);
});

test('a command that carries a path is not searched on PATH', () => {
  const isFile = fileSet('C:\\elsewhere\\tool.exe', 'C:\\bin\\sub\\tool.exe');
  const opts = { pathValue: 'C:\\bin', isFile };
  assert.equal(findExecutable('C:\\elsewhere\\tool', opts), 'C:\\elsewhere\\tool.exe');
  assert.equal(findExecutable('sub\\tool', opts), null);
});

test('PATH entries that are quoted or empty do not break the search', () => {
  const found = findExecutable('tool', {
    pathValue: ';"C:\\quoted" ;;C:\\bin',
    isFile: fileSet(join('C:\\quoted', 'tool.exe')),
  });
  assert.equal(found, join('C:\\quoted', 'tool.exe'));
});

// -- non-Windows stays untouched ---------------------------------------------

test('off Windows the argv is passed through exactly as configured', () => {
  for (const argv of [['pnpm', 'test'], ['gh'], ['./x.sh', 'a b', 'c&d']]) {
    const spec = resolveArgv(argv, { platform: 'linux', env: { PATH: '/usr/bin' } });
    assert.deepEqual(spec, { file: argv[0], args: argv.slice(1) });
    assert.equal(spec.windowsVerbatimArguments, undefined);
  }
});

test('an empty argv is refused', () => {
  assert.throws(() => resolveArgv([]), /non-empty argv/);
});

// -- the Windows decision (asserted on any platform, real files) --------------

test('on Windows a real executable is spawned directly, no interpreter', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'tool.exe'), '');
    const spec = resolveArgv(['tool', 'a b'], {
      platform: 'win32',
      env: { PATH: dir, ComSpec: 'cmd.exe' },
    });
    assert.deepEqual(spec, { file: join(dir, 'tool.exe'), args: ['a b'] });
  } finally {
    removeDir(dir);
  }
});

test('on Windows a shim is run through cmd with a hand-built command line', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'tool.cmd'), '');
    const spec = resolveArgv(['tool', '--version'], {
      platform: 'win32',
      env: { PATH: dir, ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    });
    assert.equal(spec.file, 'C:\\Windows\\system32\\cmd.exe');
    assert.deepEqual(spec.args, [
      '/d',
      '/s',
      '/c',
      `"${join(dir, 'tool.cmd')} ^^^"--version^^^""`,
    ]);
    // Verbatim: no layer below may re-quote what the escaping settled.
    assert.equal(spec.windowsVerbatimArguments, true);
  } finally {
    removeDir(dir);
  }
});

test('an unresolvable command keeps its configured name for the spawn error', () => {
  const dir = tempDir();
  try {
    const spec = resolveArgv(['nosuchtool', 'x'], {
      platform: 'win32',
      env: { PATH: dir, ComSpec: 'cmd.exe' },
    });
    assert.deepEqual(spec, { file: 'nosuchtool', args: ['x'] });
  } finally {
    removeDir(dir);
  }
});

// -- the escaping (any platform) ---------------------------------------------

test('every argument reaches cmd as literal text', () => {
  assert.equal(batchCommandLine('C:\\bin\\tool.cmd', ['a b']), 'C:\\bin\\tool.cmd ^^^"a^^^ b^^^"');
  // The injection shape from CVE-2024-27980: the separator must not survive
  // as syntax. Both carets and the quoting neutralise it.
  assert.equal(
    batchCommandLine('C:\\bin\\tool.cmd', ['x & echo P']),
    'C:\\bin\\tool.cmd ^^^"x^^^ ^^^&^^^ echo^^^ P^^^"',
  );
  // A quote inside an argument must not close the quoting and open a command.
  assert.equal(
    batchCommandLine('C:\\bin\\tool.cmd', ['a"b']),
    'C:\\bin\\tool.cmd ^^^"a\\^^^"b^^^"',
  );
});

test('a space in the shim path is escaped, not quoted', () => {
  assert.equal(batchCommandLine('C:\\Program Files\\tool.cmd', []), 'C:\\Program^ Files\\tool.cmd');
});

test('an argument cmd cannot carry is refused by name', () => {
  for (const bad of ['line\nbreak', 'carriage\rreturn', 'nul\0byte']) {
    assert.throws(() => batchCommandLine('C:\\bin\\tool.cmd', [bad]), /newline or NUL/);
  }
});

// -- the real host (Windows only) --------------------------------------------

const SHIM_ARGS = [
  '--version',
  'a b',
  '&calc.exe',
  'x & echo INJECTED',
  'a" & echo INJECTED & "b',
  '%PATH%',
  '!DELAYED!',
  'a|b',
  'c>d',
  'back\\slash',
  'trail\\',
  '(paren)',
  '^caret^',
  '',
];

/** Installs a shim that reports the argv it received, plus its own directory. */
function installShim(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.mjs`),
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
  );
  writeFileSync(
    join(dir, `${name}.cmd`),
    `@echo off\r\nnode "%~dp0${name}.mjs" %*\r\n`,
  );
}

test(
  'runCommand executes a shim that has no real executable beside it',
  { skip: WINDOWS_ONLY },
  async () => {
    const dir = tempDir();
    try {
      installShim(dir, 'shimtool');
      const env = { PATH: `${dir};${process.env.PATH}` };
      const result = await runCommand(['shimtool'], { env });
      assert.equal(result.error, undefined);
      assert.equal(result.code, 0, result.output);
      assert.deepEqual(JSON.parse(result.output), []);
    } finally {
      removeDir(dir);
    }
  },
);

test(
  'a shim receives every argument verbatim and runs nothing else',
  { skip: WINDOWS_ONLY },
  async () => {
    const dir = tempDir();
    try {
      installShim(dir, 'shimtool');
      const result = await runCommand(['shimtool', ...SHIM_ARGS], {
        env: { PATH: `${dir};${process.env.PATH}` },
      });
      assert.equal(result.code, 0, result.output);
      // The shim prints its argv as JSON and nothing else. A parse over the
      // whole output therefore fails if a second command ran, and the
      // comparison fails if any argument was split, merged or rewritten.
      assert.deepEqual(JSON.parse(result.output), SHIM_ARGS);
    } finally {
      removeDir(dir);
    }
  },
);

test(
  'runCommand reports an argument cmd cannot carry as a run failure',
  { skip: WINDOWS_ONLY },
  async () => {
    const dir = tempDir();
    try {
      installShim(dir, 'shimtool');
      const result = await runCommand(['shimtool', 'two\nlines'], {
        env: { PATH: `${dir};${process.env.PATH}` },
      });
      assert.equal(result.code, null);
      assert.match(result.error, /newline or NUL/);
    } finally {
      removeDir(dir);
    }
  },
);

// Project-config commands are the verdict's own instrument: the Tier-1
// spectrum, the suite, the lint gate. A payment test that cannot read the
// machine's test-mode credentials is a red the tree did not earn, so nothing
// on this path narrows the environment.
test('runCommand hands the machine environment to a command whole', async () => {
  const result = await runCommand(
    [process.execPath, '-e', 'console.log(process.env.PAY_SECRET_KEY ?? "absent")'],
    { env: { PAY_SECRET_KEY: 'sk-test-1' } },
  );
  assert.equal(result.code, 0);
  assert.match(result.output, /sk-test-1/);
});

// -- the command-line ceiling (any platform) ---------------------------------

test('the command-line bound is counted high, never low', () => {
  // A separator and a pair of quotes per argument, plus one escape for every
  // character the quoter has to double.
  assert.equal(commandLineLength(['ab']), 5);
  assert.equal(commandLineLength(['ab', 'cd']), 10);
  assert.equal(commandLineLength(['a"b']), 7);
  assert.equal(commandLineLength(['a\\b']), 7);
  assert.equal(commandLineLength([]), 0);
  assert.equal(commandLineLength(), 0);
});

test('the bound is never under what Windows will be handed', () => {
  const args = ['C:\\bin\\claude.exe', '--model', 'm', 'a prompt "with" quotes\nand a line'];
  // Node quotes and escapes each argument; the bound charges at least that.
  const quoted = args.map((arg) => `"${arg.replace(/(\\*)"/g, '$1$1\\"')}"`).join(' ');
  assert.ok(commandLineLength(args) >= quoted.length);
});

test('the ceiling is the Windows one, on every platform', () => {
  assert.equal(COMMAND_LINE_MAX, 32767);
});
