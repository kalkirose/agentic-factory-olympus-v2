// What a command cost the machine, and what it means when a command dies of it.
//
// The harness had no concept of resource exhaustion. A gate command's memory
// could grow for weeks; nothing measured it, nothing warned, and the eventual
// death arrived as a generic red that expensive judgment seats then puzzled
// over. Two runs proved the class by dying at a fixed heap ceiling the suite
// had outgrown, and in both the attribution was reasoned out by a triage seat
// after the fact (ADR-0045).
//
// Two things live here. The first is the measurement: the peak memory of the
// process tree one command spawned, read while the command runs, because after
// it exits the operating system holds nothing about it. The second is the
// reading of an ending: whether what killed a command was memory. Both are
// pure of the ledger — the caller decides what to record.
//
// MECHANISM. Neither platform is asked for a number it does not keep. Windows
// maintains `PeakWorkingSetSize` per process and Linux maintains `VmHWM`, and
// both are high-water marks the kernel raises and never lowers while the
// process lives. So a sample is not a hope of catching the spike: a spike
// between two samples is still in the reading, as long as the process that
// took it is observed once afterwards. Measured on Windows against a real
// tree: 600 MB allocated and then freed leaves a 62 MB working set and a
// 648 MB peak, and the peak is what this reports.
//
// THE FLOOR. What sampling can still miss is a whole process — one that is
// born and dies between two samples takes its peak with it. The interval is
// therefore stated on every record rather than assumed by its reader, and the
// tree total is a sum of high-water marks, which is an upper bound on the
// simultaneous footprint rather than an estimate of it. Both directions of
// that error are the safe one for a forecast whose job is to warn early.
//
// COST. On Windows the sampler is one process of its own beside the command,
// so the command itself is not touched: no injected library, no changed
// argv, no environment it can read. It costs one process-table query per
// interval (measured: 75 ms of one core per query on a 342-process host). On
// Linux nothing is spawned at all — the reading is `/proc`, in this process.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * How often the tree is read, and therefore the floor of what the reading can
 * see: a process whose whole life falls inside one interval is invisible to
 * it. The floor differs by platform because the read does, and whichever one
 * applied is carried on every record — no reader has to assume a number.
 */
export const SAMPLE_INTERVAL_MS = {
  // One process-table query costs 75 ms of a core here (measured on a
  // 342-process host), so the interval is set against the thing being
  // measured: a gate command runs for minutes to an hour, and its heap grows
  // over that whole time.
  win32: 2000,
  // A `/proc` walk costs a few milliseconds and spawns nothing, so the floor
  // is an eighth of the Windows one for the same fraction of a core. It has to
  // be: the first sample of a command is taken before the command has done
  // anything, and on Linux there is no sampler start-up delay to hide that.
  linux: 250,
};

const MIB = 1024 * 1024;

/** The Windows sampler, as one PowerShell program. Explained in `winSampler`. */
const WIN_SAMPLER = [
  '$root = [int]$env:OLYMPUS_PEAK_PID',
  '$interval = [int]$env:OLYMPUS_PEAK_INTERVAL',
  '$born = $null',
  'while ($true) {',
  '$all = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,' +
    'Name,PeakWorkingSetSize,CreationDate',
  '$byId = @{}; $kids = @{}',
  'foreach ($p in $all) { $id = [int]$p.ProcessId; $byId[$id] = $p; $pp = [int]$p.ParentProcessId;',
  'if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.ArrayList }',
  '[void]$kids[$pp].Add($id) }',
  'if (-not $byId.ContainsKey($root)) { break }',
  'if ($null -eq $born) { $born = $byId[$root].CreationDate }',
  '$q = New-Object System.Collections.Queue; $q.Enqueue($root); $seen = @{}',
  '$sumPeak = [int64]0; $maxPeak = [int64]0; $maxName = ""; $n = 0',
  'while ($q.Count -gt 0) { $id = $q.Dequeue(); if ($seen.ContainsKey($id)) { continue }',
  '$seen[$id] = $true; $p = $byId[$id]; if ($null -eq $p) { continue }',
  'if ($id -ne $root -and $p.CreationDate -lt $born) { continue }',
  '$n++; $peak = [int64]$p.PeakWorkingSetSize * 1024; $sumPeak += $peak',
  'if ($peak -gt $maxPeak) { $maxPeak = $peak; $maxName = $p.Name }',
  'if ($kids.ContainsKey($id)) { foreach ($c in $kids[$id]) { $q.Enqueue($c) } } }',
  'Write-Output "$sumPeak $maxPeak $n $maxName"',
  'Start-Sleep -Milliseconds $interval }',
].join('\n');

// One sample, as the Windows sampler prints it: the tree's summed peak, the
// largest single peak in it, how many processes were counted, and the image
// name behind that largest peak. Bytes, and a name that may hold a space.
const WIN_SAMPLE = /^(\d+) (\d+) (\d+) (.*)$/;

/**
 * Starts measuring the peak memory of the tree under `pid`. Never throws and
 * never rejects: a host that cannot be read answers `null`, and the command
 * being measured runs exactly as it would have.
 * @param {number} pid the process the command was spawned as
 * @param {{platform?: string, intervalMs?: number, spawnFn?: typeof spawn,
 *   readTree?: () => Array<{pid: number, ppid: number, name: string,
 *     peakBytes: number, startedAt: number}>}} [opts]
 *   `readTree` is the POSIX seam: the whole process table, as this host
 *   reports it. Injected so a test can state a table instead of owning one.
 * @returns {{stop: () => Promise<object|null>}} `stop` ends the measurement
 *   and answers the record, or `null` where nothing could be measured.
 */
export function startPeakSampler(pid, opts = {}) {
  const { platform = process.platform } = opts;
  const intervalMs = opts.intervalMs ?? SAMPLE_INTERVAL_MS[platform] ?? SAMPLE_INTERVAL_MS.win32;
  if (!Number.isInteger(pid) || pid <= 0) return idleSampler();
  try {
    // A stated table is the seam, and it decides before the platform does: a
    // test that states a process table is testing the walk, wherever it runs.
    if (opts.readTree) return posixSampler(pid, { intervalMs, readTree: opts.readTree });
    if (platform === 'win32') return winSampler(pid, { intervalMs, spawnFn: opts.spawnFn ?? spawn });
    if (platform === 'linux') return posixSampler(pid, { intervalMs, readTree: readProcTree });
  } catch {
    // A sampler that cannot start measures nothing. It never costs the caller
    // the command it was about to run.
  }
  return idleSampler();
}

/** The answer of a host this cannot measure: nothing, said once. */
function idleSampler() {
  return { stop: async () => null };
}

/**
 * The reading, folded from the samples one platform produced. `peakRssMb` is
 * the largest tree total any sample saw, in mebibytes; `peakProcess` is the
 * single process behind the largest of those, which is what names a culprit
 * where a tree holds one runaway and a dozen small helpers.
 */
function fold({ source, intervalMs }) {
  const state = { peakBytes: 0, samples: 0, name: null, nameBytes: 0 };
  return {
    take({ sumBytes, maxBytes, name }) {
      state.samples += 1;
      if (sumBytes > state.peakBytes) state.peakBytes = sumBytes;
      if (maxBytes > state.nameBytes) {
        state.nameBytes = maxBytes;
        state.name = name || null;
      }
    },
    record() {
      if (state.samples === 0) return null;
      return {
        peakRssMb: mib(state.peakBytes),
        ...(state.name && { peakProcess: { name: state.name, rssMb: mib(state.nameBytes) } }),
        samples: state.samples,
        // The floor, on the record. A reader who wants to know what this could
        // not have seen reads it here instead of assuming a number.
        intervalMs,
        source,
      };
    },
  };
}

function mib(bytes) {
  return Math.round((bytes / MIB) * 10) / 10;
}

// -- Windows -----------------------------------------------------------------

/**
 * One PowerShell beside the command, walking the tree from `pid` on its own
 * clock and printing one line per sample. The child is what keeps the cost off
 * the command: nothing about the command's own spawn changes.
 *
 * Two guards are worth naming. The walk stops when the root is gone, so the
 * sampler ends itself even if nobody kills it. And a process is only in the
 * tree if it was created no earlier than the root was — Windows reuses process
 * ids quickly, and without that the parent chain of a recycled id can graft a
 * stranger's memory onto the reading.
 */
function winSampler(pid, { intervalMs, spawnFn }) {
  const child = spawnFn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WIN_SAMPLER],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OLYMPUS_PEAK_PID: String(pid),
        OLYMPUS_PEAK_INTERVAL: String(intervalMs),
      },
    },
  );
  const folder = fold({ source: 'win32-cim', intervalMs });
  let pending = '';
  let failed = false;
  const absorb = (chunk) => {
    pending += chunk;
    const end = pending.lastIndexOf('\n');
    if (end === -1) return;
    for (const line of pending.slice(0, end).split('\n')) {
      const match = WIN_SAMPLE.exec(line.trim());
      if (!match) continue;
      folder.take({
        sumBytes: Number(match[1]),
        maxBytes: Number(match[2]),
        name: match[4].trim(),
      });
    }
    pending = pending.slice(end + 1);
  };
  child.stdout?.on('data', absorb);
  // The sampler's own complaints are not the command's output and are never
  // carried into one. A sampler that fails answers nothing at all.
  child.stderr?.on('data', () => {});
  // Either ending ends the wait. A spawn that failed is an ending too, and a
  // stop that waited only for `close` would hang the command's own settle on a
  // host with no PowerShell on it.
  const ended = new Promise((resolve) => {
    child.once('close', resolve);
    child.once('error', () => {
      failed = true;
      resolve();
    });
  });
  return {
    async stop() {
      try {
        child.kill();
      } catch {
        // Already gone: the walk ended when the root did.
      }
      await ended;
      absorb('\n');
      return failed ? null : folder.record();
    },
  };
}

// -- POSIX -------------------------------------------------------------------

/**
 * The `/proc` reading, in this process. No child is spawned, so there is no
 * second process to pay for and nothing to kill: the interval is a timer, and
 * the peak each process reports (`VmHWM`) is the same kind of high-water mark
 * Windows keeps.
 */
function posixSampler(pid, { intervalMs, readTree }) {
  const folder = fold({ source: 'linux-proc', intervalMs });
  let root = null;
  const sample = () => {
    let table;
    try {
      table = readTree();
    } catch {
      return;
    }
    const self = table.find((p) => p.pid === pid);
    if (!self) return;
    if (root === null) root = self.startedAt;
    const summed = treeTotal(table, pid, root);
    if (summed.count > 0) folder.take(summed);
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  // The daemon's own exit is never held open by a measurement.
  timer.unref?.();
  return {
    async stop() {
      sample();
      clearInterval(timer);
      return folder.record();
    },
  };
}

/**
 * The tree under `pid`, summed. The same two guards the Windows walk carries:
 * a cycle in the parent map cannot loop the walk, and a process that started
 * before the root is not in the root's tree whatever its parent id says.
 */
function treeTotal(table, pid, rootStartedAt) {
  const byParent = new Map();
  const byId = new Map();
  for (const proc of table) {
    byId.set(proc.pid, proc);
    if (!byParent.has(proc.ppid)) byParent.set(proc.ppid, []);
    byParent.get(proc.ppid).push(proc.pid);
  }
  const seen = new Set();
  const queue = [pid];
  let sumBytes = 0;
  let maxBytes = 0;
  let name = null;
  let count = 0;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (seen.has(id)) continue;
    seen.add(id);
    const proc = byId.get(id);
    if (!proc) continue;
    if (id !== pid && proc.startedAt < rootStartedAt) continue;
    count += 1;
    // Read once: on the `/proc` reader this access is the file read.
    const peakBytes = proc.peakBytes;
    sumBytes += peakBytes;
    if (peakBytes > maxBytes) {
      maxBytes = peakBytes;
      name = proc.name;
    }
    queue.push(...(byParent.get(id) ?? []));
  }
  return { sumBytes, maxBytes, name, count };
}

/**
 * The host's process table, from `/proc`. `stat` is read for every process,
 * because the parent ids in it are what the tree is built from; `status` — the
 * file that holds the peak — is read only for what the tree turned out to
 * hold. A process that exits mid-walk is skipped, not reported: it is exactly
 * the process the walk before this one saw.
 */
function readProcTree() {
  const table = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readText(`/proc/${entry}/stat`);
    if (stat === null) continue;
    const parsed = parseProcStat(stat);
    if (parsed === null) continue;
    const proc = { pid: Number(entry), ...parsed };
    // The peak is read on access, so it is read for the handful of processes
    // the walk keeps rather than for every process on the host. A busy machine
    // holds three hundred of them and the walk holds three.
    Object.defineProperty(proc, 'peakBytes', {
      enumerable: true,
      get: () => parseProcPeak(readText(`/proc/${entry}/status`)),
    });
    table.push(proc);
  }
  return table;
}

/**
 * The parent and the start time out of one `/proc/<pid>/stat` line.
 *
 * The command name is the second field, it is in parentheses, and it may hold
 * anything at all — spaces, digits, parentheses of its own. So the fields after
 * it are counted from the last closing parenthesis and never by splitting the
 * line. After that slice, index 0 is the state (field 3 of proc(5)), index 1 is
 * the parent id (field 4), and index 19 is the start time (field 22).
 * @returns {{ppid: number, name: string, startedAt: number}|null}
 */
export function parseProcStat(stat) {
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const fields = stat.slice(close + 2).split(' ');
  const ppid = Number(fields[1]);
  const startedAt = Number(fields[19]);
  if (!Number.isFinite(ppid) || !Number.isFinite(startedAt)) return null;
  return { ppid, name: stat.slice(stat.indexOf('(') + 1, close), startedAt };
}

/**
 * The peak resident size out of one `/proc/<pid>/status`, in bytes. `VmHWM` is
 * the kernel's own high-water mark: a spike this reads after the memory is
 * given back is still the spike. Zero for what cannot be read.
 */
export function parseProcPeak(status) {
  if (status === null) return 0;
  const match = /^VmHWM:\s+(\d+) kB$/m.exec(status);
  return match ? Number(match[1]) * 1024 : 0;
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // Gone between the listing and the read, or a process this user may not
    // look at. Either way it is not part of an answer.
    return null;
  }
}

// -- what an ending means ----------------------------------------------------

// The abort a V8 heap ceiling ends a process with, as a shell reports it
// (128 + SIGABRT), and the Windows status for an allocation the system
// refused. Both are the death itself rather than a description of one.
const ABORT_CODE = 134;
const WIN_NO_MEMORY = 3221225495; // 0xC0000017 STATUS_NO_MEMORY

// What the death looks like when the harness did not watch it happen. A gate
// command is usually a runner of runners — a workspace tool calling a test
// runner calling a process — and the exit code the harness sees is the
// wrapper's own. In the run this class was found in, the harness saw exit 1
// and the words "Exit status 134" in the output: the abort was real, and only
// the text carried it. So the text is read, and it is read for the signatures
// a memory death actually prints rather than for the word "memory".
const SIGNATURES = [
  { evidence: 'heap-abort', pattern: /JavaScript heap out of memory/i },
  { evidence: 'heap-abort', pattern: /FATAL ERROR:[^\n]*(Reached heap limit|Allocation failed)/i },
  { evidence: 'abort-reported', pattern: /\b(?:Exit status|exited with code|exit code) 134\b/i },
  { evidence: 'os-refusal', pattern: /\bENOMEM\b/ },
  { evidence: 'os-refusal', pattern: /Cannot allocate memory/i },
  { evidence: 'os-refusal', pattern: /\bout of memory\b/i },
  { evidence: 'os-refusal', pattern: /0xC0000017/i },
];

/**
 * Whether a command's ending was resource exhaustion, and what says so.
 *
 * Mechanical, and deliberately so: this is the whole attribution, and no seat
 * is asked to reason about it (ADR-0045). Only a failure is ever classed — a
 * command that exited 0 spent whatever it spent and answered the question it
 * was asked, and a run that peaked against its ceiling and still passed is a
 * forecast's business rather than a death.
 *
 * A signal is not evidence on its own. `SIGKILL` is what the daemon sends a
 * run it is ending, and reading a deliberate kill as a memory death would put
 * the word on every stopped run.
 * @param {{code: number|null, signal?: string|null, output?: string,
 *   parts?: Array<{output: string}>,
 *   resources?: {peakRssMb: number}|null}} outcome as `runCommand` answers it
 * @param {{ceilingMb?: number|null}} [declared] the layer's own ceiling
 * @returns {{evidence: string, peakRssMb?: number, ceilingMb?: number}|null}
 */
export function exhaustionOf(outcome, { ceilingMb = null } = {}) {
  if (!outcome || outcome.code === 0) return null;
  const peakRssMb = outcome.resources?.peakRssMb;
  const found = evidenceOf(outcome, { ceilingMb, peakRssMb });
  if (!found) return null;
  return {
    evidence: found,
    ...(typeof peakRssMb === 'number' && { peakRssMb }),
    ...(typeof ceilingMb === 'number' && { ceilingMb }),
  };
}

function evidenceOf({ code, signal, output, parts }, { ceilingMb, peakRssMb }) {
  if (code === ABORT_CODE || code === WIN_NO_MEMORY) return 'abort-exit';
  if (signal === 'SIGABRT') return 'abort-signal';
  // Every bounded piece of the stream the harness still holds, not the tail
  // alone: a layer that runs in parts keeps a tail per part, and a sequence
  // that died in the middle has the death in one of those rather than at the
  // end (ADR-0043). The whole stream is on disk and is not read here — this
  // runs at a settle point, and a settle point does not open files.
  const text = [output, ...(parts ?? []).map((p) => p.output)]
    .filter((piece) => typeof piece === 'string')
    .join('\n');
  for (const { evidence, pattern } of SIGNATURES) {
    if (pattern.test(text)) return evidence;
  }
  // The measurement's own answer, for the death that printed nothing this
  // recognizes: the command failed, and it failed holding everything the
  // project said the layer may hold.
  if (typeof ceilingMb === 'number' && typeof peakRssMb === 'number' && peakRssMb >= ceilingMb) {
    return 'ceiling-crossed';
  }
  return null;
}
