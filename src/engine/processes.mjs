// Process lifecycle across platforms. Windows has no process groups a signal
// can address and no parent-child kill semantics, so three POSIX assumptions
// the harness would otherwise make are wrong there. All three corrections live
// here, behind one platform branch, the way `resolveArgv` owns the executable
// branch: off Windows every function below is the behaviour that shipped
// before it existed.
//
// 1. A spawned child joins its parent's console and its parent's console
//    process group. A console control event addressed to the child is
//    delivered to the whole group, the daemon included, and a daemon with no
//    handler for it dies on the spot (measured: exit 0xC000013A,
//    STATUS_CONTROL_C_EXIT). So a seat is given a console of its own that has
//    no window. `windowsHide` is CREATE_NO_WINDOW, the seat's whole descendant
//    tree inherits that console, and neither a window nor a console event can
//    leave it. `detached` is not taken: it is DETACHED_PROCESS, which leaves
//    the seat with no console at all, and every console descendant of a
//    console-less process opens a visible one of its own (ADR-0016).
// 2. `child.kill()` is TerminateProcess on the one process the handle names.
//    A seat is usually `cmd.exe` running a shim (ADR-0013), so the tool itself
//    is a grandchild and survives the kill along with everything it spawned.
//    A deliberate termination therefore kills the tree, not the handle.
//    Off Windows the same hole is there for the same reason — a signal to one
//    pid reaches one process — and the answer POSIX already has is the process
//    group: a child spawned `detached` leads a group of its own, and a signal
//    to the negative pid reaches every descendant in it. So the harness spawns
//    its children into groups off Windows and ends the group, and `detached`
//    there is a process group and not the console-less shape Windows means by
//    the same word.
// 3. A seat that exits on its own leaves no signal behind for its own
//    descendants. Survivors keep a handle or a working directory inside the
//    run worktree, and Windows refuses to delete a directory anything is
//    sitting in — the `git worktree remove` that follows fails EBUSY. So the
//    workspace release enumerates what is still standing in the workspace and
//    ends it first. The same enumeration, without the kill, is what names the
//    holder in the record of a workspace that survived the release anyway.
//    Standing in a workspace is three separate things — a command line that
//    names it, an image loaded out of it, and a working directory inside it —
//    and the third is the one that actually blocks an `rmdir` (ADR-0016).
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { resolveArgv } from './executable.mjs';

// A sweep root names one run's workspace. Anything shorter or relative would
// match paths outside it, and the sweep kills what it matches — so a root that
// broad is refused rather than run.
const MIN_ROOT_LENGTH = 4;

// How many holders a record names. A leftover with more than a handful of
// processes in it is one story, not ten, and the record is read by a human.
const HOLDER_LIMIT = 10;

// Reads another process's current directory. Windows reports a process's
// command line and its image path and nothing else, and a working directory is
// only in the process's own memory: the PEB holds the parameter block, and the
// block holds the directory as a counted UTF-16 string. Handed to PowerShell in
// the environment, like the root, so no value this module composes is ever read
// as script.
//
// Everything it can be refused by, it answers `null` for — a process of another
// user, a protected process, a process that exited between the listing and the
// read. A holder this cannot see is exactly the holder the query had before it.
const CWD_READER_SOURCE = [
  'using System;using System.Runtime.InteropServices;',
  'public static class OlympusCwd {',
  '[DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int c,ref PBI i,int len,IntPtr r);',
  '[DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a,bool inh,int pid);',
  '[DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h,IntPtr addr,byte[] buf,IntPtr size,out IntPtr read);',
  '[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);',
  '[StructLayout(LayoutKind.Sequential)] struct PBI{public IntPtr R1;public IntPtr Peb;public IntPtr R2a;public IntPtr R2b;public IntPtr Id;public IntPtr R3;}',
  'static IntPtr Ptr(IntPtr h,IntPtr addr){byte[] b=new byte[IntPtr.Size];IntPtr n;if(!ReadProcessMemory(h,addr,b,(IntPtr)b.Length,out n))return IntPtr.Zero;return IntPtr.Size==8?(IntPtr)BitConverter.ToInt64(b,0):(IntPtr)BitConverter.ToInt32(b,0);}',
  'public static string Of(int pid){',
  'IntPtr h=OpenProcess(0x0400|0x0010,false,pid); if(h==IntPtr.Zero) return null;',
  'try{ PBI pbi=new PBI(); if(NtQueryInformationProcess(h,0,ref pbi,Marshal.SizeOf(pbi),IntPtr.Zero)!=0) return null;',
  'IntPtr p=Ptr(h,(IntPtr)(pbi.Peb.ToInt64()+(IntPtr.Size==8?0x20:0x10))); if(p==IntPtr.Zero) return null;',
  'byte[] u=new byte[IntPtr.Size==8?16:8]; IntPtr n;',
  'if(!ReadProcessMemory(h,(IntPtr)(p.ToInt64()+(IntPtr.Size==8?0x38:0x24)),u,(IntPtr)u.Length,out n)) return null;',
  'ushort len=BitConverter.ToUInt16(u,0); IntPtr buf=IntPtr.Size==8?(IntPtr)BitConverter.ToInt64(u,8):(IntPtr)BitConverter.ToInt32(u,4);',
  'if(len==0||buf==IntPtr.Zero) return null; byte[] s=new byte[len];',
  'if(!ReadProcessMemory(h,buf,s,(IntPtr)len,out n)) return null;',
  'return System.Text.Encoding.Unicode.GetString(s); } finally { CloseHandle(h); } } }',
].join('');

// One holder per line: the pid, why it matched, and the image name. A pipe,
// because an image name may carry a space and neither of the first two fields
// can carry a pipe.
const HOLDER_LINE = /^(\d+)\|([a-z,]+)\|(.+)$/;

/**
 * Spawn options for a child the harness ends as a tree: a seat, and every
 * command a gate layer or a probe runs. One shape for all of them, because
 * every one of them can leave descendants behind and the harness ends them the
 * same way.
 * @param {{platform?: string}} [opts]
 * @returns {object}
 */
export function treeSpawnOptions({ platform = process.platform } = {}) {
  if (platform !== 'win32') {
    // A process group of its own, so `terminateTree` can address the whole
    // tree with one signal. It is not unref'd, so the daemon still waits on
    // the child exactly as before, and nothing about the console changes:
    // POSIX `detached` is `setsid`, which is a session and a group, and the
    // visible-console failure the Windows branch avoids is a Windows fact.
    return { detached: true };
  }
  // CREATE_NO_WINDOW. The seat gets a console of its own with no window on it,
  // the descendants inherit that console instead of opening a visible one, and
  // a console control event stays inside it. The child is not detached and not
  // unref'd: the daemon still waits on it exactly as before. DETACHED_PROCESS
  // is what `detached` means here, and it is the one thing this branch exists
  // to avoid.
  return { windowsHide: true };
}

/**
 * Ends a child the daemon decided to end, and everything it spawned.
 * @param {import('node:child_process').ChildProcess} child
 * @param {{platform?: string, run?: Function, kill?: Function}} [opts]
 *   injection points for tests
 * @returns {Promise<void>}
 */
export async function terminateTree(
  child,
  {
    platform = process.platform,
    run = execAsync,
    kill = (pid, signal) => process.kill(pid, signal),
  } = {},
) {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (platform !== 'win32') {
    // The child leads a process group of its own (`treeSpawnOptions`), so its
    // pid is the group id and the negative pid addresses every descendant. A
    // group that has already gone, or a child somebody spawned without the
    // group, throws — and the direct kill is what that child was owed anyway.
    try {
      kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill();
    }
    return;
  }
  // /T takes the descendants with it; /F is required because a console
  // process with no message pump refuses the graceful stop.
  let code = null;
  try {
    ({ code } = await run(...spawnSpec(['taskkill', '/PID', String(child.pid), '/T', '/F'])));
  } catch {
    // taskkill itself could not run; the direct kill still has to happen.
  }
  // taskkill exits nonzero when the pid is already gone, which the direct
  // kill then finds too. Either way the child does not outlive this call.
  if (code !== 0) child.kill();
}

/**
 * Ends every process standing inside a workspace, so the directory can be
 * removed. Best effort by design: what it cannot enumerate or cannot kill
 * surfaces as a failed removal, which the caller already reports.
 *
 * Everything the query matches is ended, including a process matched only by
 * its working directory. A process whose working directory is inside a run
 * workspace is inside a tree the harness is deleting; there is no reading of
 * that under which it should survive the delete.
 * @param {string} root the workspace directory, absolute
 * @param {{platform?: string, run?: Function, self?: number}} [opts]
 * @returns {Promise<{count: number, names: string[], error?: string}>}
 */
export async function sweepPathHolders(
  root,
  { platform = process.platform, run = execAsync, self = process.pid } = {},
) {
  const empty = { count: 0, names: [] };
  const { holders, error } = await pathHolders(root, {
    platform,
    run,
    self,
    limit: Infinity,
    refusal: 'refusing to sweep on an unsafe root',
  });
  if (error) return { ...empty, error };
  if (holders.length === 0) return empty;
  for (const holder of holders) {
    // A tree kill of one holder often takes the next one with it; taskkill
    // then reports a pid it cannot find, which is the intended outcome.
    await run(...spawnSpec(['taskkill', '/PID', String(holder.pid), '/T', '/F'])).catch(() => {});
  }
  return { count: holders.length, names: [...new Set(holders.map((h) => h.name))].sort() };
}

/**
 * The processes standing inside a path, named rather than ended. Same
 * enumeration the sweep runs on, and it kills nothing: this is what a record
 * about a directory nothing would delete is written from.
 *
 * A leftover workspace is the sweep's own failure, so a bare errno on it says
 * only that the condition the sweep exists for is still true. What the
 * operator does next is decided by which process is sitting in the tree — a
 * seat's surviving child, an editor, a scanner — and that is a pid, an image
 * name, and what put it in the tree (ADR-0016). Never throws: a record about a
 * directory is not worth a second failure.
 * @param {string} root the directory, absolute
 * @param {{platform?: string, run?: Function, self?: number, limit?: number,
 *   refusal?: string}} [opts]
 * @returns {Promise<{holders: Array<{pid: number, via: string[], name: string}>,
 *   error?: string}>} `via` names the signals that matched: `cmdline`, `image`,
 *   `cwd`. A holder matched on `cwd` alone is standing in the directory and
 *   nothing about it names the directory anywhere the OS reports.
 */
export async function pathHolders(
  root,
  {
    platform = process.platform,
    run = execAsync,
    self = process.pid,
    limit = HOLDER_LIMIT,
    refusal = 'refusing to read the holders of an unsafe root',
  } = {},
) {
  if (platform !== 'win32') return { holders: [] };
  // The Windows rule, whatever host is asking: the branch is what decides,
  // never the platform the check happens to run on.
  if (typeof root !== 'string' || root.length < MIN_ROOT_LENGTH || !win32.isAbsolute(root)) {
    return { holders: [], error: `${refusal}: ${JSON.stringify(root)}` };
  }
  try {
    return { holders: (await listPathHolders(root, { run, self })).slice(0, limit) };
  } catch (error) {
    return { holders: [], error: `could not enumerate: ${error.message}` };
  }
}

/**
 * Processes standing inside `root`: by command line, by image path, or by
 * working directory. Both values the script reads — the root and the reader's
 * own source — are handed over in the environment, never interpolated into the
 * script, so nothing this module composes can be read as script.
 *
 * The working-directory read is the one that costs something, so it is the one
 * that may fail: a PowerShell that cannot compile the reader keeps the other
 * two signals and reports the holders it can still see. A narrower answer is
 * the answer this query gave before the reader existed, and it is never an
 * error — the release it belongs to has to run either way.
 */
async function listPathHolders(root, { run, self }) {
  const script = [
    '$root = $env:OLYMPUS_SWEEP_ROOT.ToLowerInvariant()',
    '$self = [int]$env:OLYMPUS_SWEEP_SELF',
    '$cwd = $false',
    'try { Add-Type -TypeDefinition $env:OLYMPUS_SWEEP_CWD_SOURCE -Language CSharp -ErrorAction Stop;' +
      ' $cwd = $true } catch { }',
    'Get-CimInstance Win32_Process | ForEach-Object {',
    'if ($_.ProcessId -eq $PID -or $_.ProcessId -eq $self) { return }',
    '$via = @()',
    "if ($_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($root)) { $via += 'cmdline' }",
    "if ($_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().Contains($root)) { $via += 'image' }",
    'if ($cwd) { $d = $null; try { $d = [OlympusCwd]::Of([int]$_.ProcessId) } catch { }',
    "if ($d -and $d.ToLowerInvariant().Contains($root)) { $via += 'cwd' } }",
    "if ($via.Count -gt 0) { \"$($_.ProcessId)|$($via -join ',')|$($_.Name)\" } }",
  ].join('\n');
  const spec = spawnSpec(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]);
  const { code, stdout, stderr } = await run(spec[0], spec[1], {
    env: {
      ...process.env,
      OLYMPUS_SWEEP_ROOT: root,
      OLYMPUS_SWEEP_SELF: String(self),
      OLYMPUS_SWEEP_CWD_SOURCE: CWD_READER_SOURCE,
    },
  });
  if (code !== 0) throw new Error(String(stderr).trim() || `exit ${code}`);
  const holders = [];
  for (const line of String(stdout).split('\n')) {
    const match = HOLDER_LINE.exec(line.trim());
    if (match) {
      holders.push({ pid: Number(match[1]), via: match[2].split(','), name: match[3].trim() });
    }
  }
  return holders;
}

// The host decides which file a tool name stands for here as everywhere else.
function spawnSpec([command, ...args]) {
  const spec = resolveArgv([command, ...args]);
  return [spec.file, spec.args];
}

// Resolves on the exit code rather than rejecting on it: a nonzero taskkill is
// an answer ("no such pid"), not a fault.
function execAsync(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // `windowsHide` is last: no caller can drop it and put a window on screen.
    execFile(file, args, { ...opts, windowsHide: true }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}
