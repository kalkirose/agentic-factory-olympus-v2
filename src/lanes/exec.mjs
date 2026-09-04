// Runner for project-config commands (suite runs, reference lint). The argv
// comes from the project config's `commands` table — the single home for
// every runnable command. The result carries the exit code, an output tail,
// and the file the whole stream went to; the caller judges the code, this
// module never does.
//
// THE FILE IS THE RECORD (ADR-0043). Every command run here streams its whole
// output to a file, and the in-memory tail is the cheap summary beside it. The
// tail alone lost the failure three times — a red in the middle of a long
// sequence, minutes of green after it, and a record that held the green. A
// consumer cannot reintroduce that by forgetting to ask for the file: the file
// is written whether it is asked for or not, and what a consumer chooses is
// only where it lands.
//
// What survives is what is worth keeping. A command that exited 0 has its file
// deleted the moment it settles — the tail says all a green needs to say — and
// a command that failed, was terminated, or could not run keeps its file, which
// then archives with the run that ran it (`keep: 'always'` keeps a green's file
// too, for the caller whose whole purpose is reading it). A per-file cap guards
// a runaway command; the file says so on its last line and the result carries
// `log.truncated`, so a bound that cut the evidence is never silent.
//
// A layer command is often a sequence of its own — a suite runner with steps,
// a script that shells out several times — and it reports one exit code for
// all of it. The tail of such a stream is whatever ran last, which on a red in
// the middle is the detail of the parts that passed. So a command may say
// where its parts begin, and then each part keeps a bounded tail of its own
// and the caller records the failing part under its name instead of the
// minutes of green that followed it.
//
// The protocol is five lines a command may print, on their own:
//
//   ::olympus part <name>          what follows belongs to <name>
//   ::olympus part-failed <name>   <name> failed; its own output is evidence
//   ::olympus part-ok <name>       <name> finished and passed
//   ::olympus part-inputs <e> …    the current part's input set: repo-relative
//                                  path entries, whitespace-separated
//   ::olympus part-failed-files <name> <path>[,<path>…]
//                                  the files of <name> that failed, comma-
//                                  separated and named by the framework's own
//                                  summary rather than guessed at
//
// Nothing changes for a command that prints none of them: the parts are empty
// and the tail is the tail it always was. Marker lines are consumed, never
// kept — the file holds them, because the file is the stream as the command
// printed it.
//
// `part-failed-files` is the line a re-run is narrowed by. The name is read to
// the LAST whitespace on the line and the path list is the token after it, so a
// part whose name holds a space keeps working and a path may hold none — which
// is what `part-inputs` already asks of a path.
//
// `part-ok` and `part-inputs` are what make a part carryable between cycles
// (ADR-0046). A part the caller may skip next cycle has to say two things
// this stream did not say before: that it passed on its own, rather than
// being covered by an exit code that spoke for the whole sequence, and which
// files could change its answer. `part-inputs` binds to the part the last
// `part` line opened, so a part declares its own input set as it runs, and a
// part that did not run declares nothing. Opening a part twice is opening the
// same part.
//
// The caller's half of the protocol is two environment variables (see
// parts.mjs): `OLYMPUS_PARTS`, the parts it asks for by name, and
// `OLYMPUS_FAILED_FILES`, the files it asks for inside a part
// (`<part>=<path>,<path>;<part>=…`). A command that ignores either runs
// everything, which costs time and never correctness — what the record holds
// is what the stream said ran.
//
// A caller may also ask what the command cost the machine. The measurement is
// the same additive shape the file is: an option to ask for it, a field on the
// result, and nothing at all for the caller that does not (ADR-0045). It reads
// the process tree from outside — the command's own spawn is untouched — so
// what asking for it changes about the command is nothing.
import { spawn } from 'node:child_process';
import { terminateTree } from '../engine/processes.mjs';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveArgv } from '../engine/executable.mjs';
import { startPeakSampler } from './resources.mjs';

const PART_PREFIX = '::olympus ';
const PART_MARKER =
  /^::olympus (part|part-failed-files|part-failed|part-ok|part-inputs)[ \t]+(.+?)[ \t]*$/;
// The name of a `part-failed-files` line and the path list after it: the name
// runs to the last whitespace, the list is the token that follows.
const FAILED_FILES_LINE = /^(.*?)[ \t]+([^ \t]+)$/;
// Per part, and how many parts a run holds: a bound the longest sequence a
// project runs stays under, and small enough that a command with no markers
// costs nothing and one with thousands cannot grow the daemon. The count is
// generous because the table is now read as well as displayed: a part is
// carryable only while the record still holds it (ADR-0046), and an evicted
// part is a part that re-runs.
const PART_OUTPUT = 4000;
const PART_LIMIT = 64;
// The input entries one part may declare, and how long an entry may be. A
// path set is a statement about a repository, so both bounds are far above any
// honest one and exist for the command that has lost its mind.
const PART_INPUTS = 64;
const PART_INPUT_LENGTH = 200;
// The failed files one part may name. The same bound and the same reason: a
// part that names more files than this is a part whose whole re-run is the
// cheaper answer anyway.
const PART_FAILED_FILES = 64;
// A marker is one line. Text this long with no newline in it is not a marker,
// and holding it back to look for one would only grow a buffer.
const LINE_LIMIT = 65536;

/**
 * What one command's file may hold. Generous: the longest gate command this
 * harness has measured printed a few megabytes, and the cap is here for the
 * command that has lost its mind, not for the one that talks a lot. A file
 * that reaches it says so on its own last line, and the result says so in
 * `log.truncated` — a cap that cut the evidence is recorded, never silent.
 */
export const LOG_CAP = 10 * 1024 * 1024;

/**
 * Where a command's file goes when the caller names no path.
 *
 * Every call site that has a run behind it hands over a path inside that run's
 * directory, so the file inherits the run's lifecycle — archived at close-out,
 * swept with the run directory after a crash — and no store of its own is
 * added. The rest are the calls with no run to belong to: the forge's `gh`
 * reads, and this harness's own tests. Their files land in the host's
 * temporary directory, which the host itself reclaims, and a green deletes its
 * own the moment it settles, so what can accumulate there is a failed `gh`
 * call — bytes, in the one directory on the machine that is already somebody
 * else's job to empty. That is the whole reason it is not on the daemon home:
 * a store on the home would need a sweep of its own, and no defect here is
 * worth new garbage collection (ADR-0043).
 */
export const COMMAND_LOG_ROOT = join(tmpdir(), 'olympus-commands');

// Distinct within a process and readable to a person: the tool, when the run
// that follows it needs finding, and a sequence that cannot collide inside one
// millisecond.
let logSequence = 0;
function ambientLogFile(argv) {
  logSequence += 1;
  const tool =
    String(argv[0])
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(-24) || 'command';
  const stamp = `${Date.now().toString(36)}-${process.pid}-${logSequence}`;
  return join(COMMAND_LOG_ROOT, `${stamp}-${tool}.log`);
}

/**
 * The file one command's output is streamed to, and the record of what
 * happened to it. Never throws: a machine that cannot open the file still has
 * to run the command, and the caller learns what it lost from `log.error`
 * rather than from a failed command it would read as a verdict about the tree.
 */
function openCommandLog(path, cap) {
  const record = { path, bytes: 0, truncated: false };
  let stream = null;
  let closed = Promise.resolve();
  try {
    mkdirSync(dirname(path), { recursive: true });
    stream = createWriteStream(path);
    closed = new Promise((resolve) => stream.once('close', resolve));
    stream.on('error', (error) => {
      record.error = error.message;
      stream = null;
    });
  } catch (error) {
    record.error = error.message;
  }
  return {
    record,
    write(text) {
      if (!stream || record.truncated || text === '') return;
      const room = cap - record.bytes;
      const size = Buffer.byteLength(text);
      if (size <= room) {
        stream.write(text);
        record.bytes += size;
        return;
      }
      // The head is what a reader needs — a sequence fails forward, and the
      // end of the stream is still in the tail the result carries.
      const kept = Buffer.from(text, 'utf8').subarray(0, Math.max(0, room)).toString('utf8');
      if (kept !== '') {
        stream.write(kept);
        record.bytes += Buffer.byteLength(kept);
      }
      record.truncated = true;
      stream.write(
        `\n[olympus] this log stopped at the ${cap}-byte cap; the rest of the command's ` +
          'output was not written\n',
      );
    },
    /**
     * Closes the file and decides whether it survives. The handle is released
     * before this resolves: a run directory with an open handle inside it is a
     * directory Windows refuses to archive.
     */
    async settle(keep) {
      if (stream) {
        const ending = stream;
        stream = null;
        ending.end();
        await closed;
      }
      if (keep) return;
      try {
        rmSync(path, { force: true });
        record.removed = true;
      } catch (error) {
        record.error = record.error ?? error.message;
      }
    },
  };
}

/**
 * Runs one command to completion.
 * @param {string[]} argv
 * @param {{cwd?: string, env?: object, outputLimit?: number,
 *   log?: string|false, logCap?: number, keep?: 'evidence'|'always',
 *   redact?: (text: string) => string, resources?: boolean,
 *   sampleIntervalMs?: number}} [opts]
 *   `log` is the file the whole stream is written to: a path the caller names
 *   — normally inside its own run directory — or nothing, for a file under
 *   `COMMAND_LOG_ROOT`. `false` writes no file at all, which is for the one
 *   caller whose command's output must never be held anywhere (ADR-0027).
 *   `keep` decides what survives the settle: `evidence` (the default) keeps
 *   the file of a command that did not exit 0 and printed something, `always`
 *   keeps it whatever happened.
 *   `redact` rewrites the stream before anything holds it — the file, the
 *   tail, and the parts alike. It is applied to whole lines.
 *   `resources` measures the peak memory of the tree the command spawns. Off
 *   by default: it is worth a sampler for a layer that runs for an hour and
 *   worth nothing for a forge read that runs for a second (ADR-0045).
 * @returns {Promise<{code: number|null, signal?: string|null, output: string,
 *   truncated: boolean,
 *   parts: Array<{name: string, failed: boolean, ok: boolean, output: string,
 *     inputs: string[], failedFiles: string[]}>,
 *   log: {path: string, bytes: number, truncated: boolean, removed?: boolean,
 *     error?: string}|null,
 *   resources: {peakRssMb: number, peakProcess?: {name: string, rssMb: number},
 *     samples: number, intervalMs: number, source: string}|null,
 *   error?: string}>}
 *   `code` is null when the command could not run at all (spawn error) —
 *   an environment defect, never a verdict about the tree under test.
 *   `parts` is what the command said about its own parts, in the order it
 *   opened them; empty for a command that said nothing. `failed` and `ok` are
 *   what it said about each one; a part with neither said nothing about
 *   itself, and the caller decides what the exit code makes of that.
 *   `inputs` is the part's declared input set, empty for a part that declared
 *   none. `failedFiles` is what the part said failed inside it, empty for a
 *   part that named nothing — and then the part re-runs whole.
 *   `truncated` says the stream outgrew the in-memory bound, so `output` is a
 *   tail. It is not a statement that anything was lost: `log` says what the
 *   harness still holds. `log.truncated` is the loss — the file hit its cap —
 *   and `log.removed` says the file was a green's and is gone.
 *   `resources` is null for the caller that did not ask and for the host that
 *   cannot answer. `intervalMs` on it is the floor of what it could see.
 */
export function runCommand(
  argv,
  {
    cwd,
    env,
    outputLimit = 4000,
    log: logFile,
    logCap = LOG_CAP,
    keep = 'evidence',
    redact,
    resources = false,
    sampleIntervalMs,
    timeoutMs = null,
  } = {},
) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('runCommand requires a non-empty argv');
  }
  return new Promise((resolve) => {
    // The daemon's own node runtime context must not leak into the command:
    // under an inherited NODE_TEST_CONTEXT a child `node --test` reports
    // exit 0 for a red suite — a false green on the evaluation path.
    const base = { ...process.env, ...env };
    delete base.NODE_TEST_CONTEXT;
    // The command table names the tool, the host decides which file that is.
    let spec;
    try {
      spec = resolveArgv(argv, { env: base });
    } catch (error) {
      // Nothing ran, so there is no stream and no file to open: an argv this
      // host cannot carry is a defect of the call, not output of a command.
      resolve({
        code: null,
        output: '',
        truncated: false,
        parts: [],
        log: null,
        resources: null,
        error: error.message,
      });
      return;
    }
    const log = logFile === false ? null : openCommandLog(logFile ?? ambientLogFile(argv), logCap);
    const child = spawn(spec.file, spec.args, {
      cwd,
      env: base,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(spec.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
    });
    // The measurement starts once there is a tree to measure and never before:
    // it reads the child from outside, so it needs the pid the spawn returned
    // and nothing else of the command (ADR-0045).
    const sampler =
      resources && child.pid
        ? startPeakSampler(child.pid, {
            ...(sampleIntervalMs !== undefined && { intervalMs: sampleIntervalMs }),
          })
        : null;
    let output = '';
    let pending = '';
    let truncated = false;
    const parts = [];
    let current = null;

    const openPart = (name) => {
      const known = parts.find((p) => p.name === name);
      if (known) return known;
      if (parts.length >= PART_LIMIT) {
        // A part that said how it ended outlives one that did not, and a
        // failure outlives a pass: the record is evidence first, and a pass
        // is worth keeping only because a later cycle may carry it.
        const silent = parts.findIndex((p) => !p.failed && !p.ok);
        const spare = silent === -1 ? parts.findIndex((p) => !p.failed) : silent;
        parts.splice(spare === -1 ? 0 : spare, 1);
      }
      const part = { name, failed: false, ok: false, output: '', inputs: [], failedFiles: [] };
      parts.push(part);
      return part;
    };

    // The files one part reported red, from the part's own `part-failed-files`
    // line. It names its part, so it binds to that part wherever it is printed
    // and never to whatever part happens to be open. A line with no path list
    // states nothing and is dropped: an empty narrowing is a whole re-run, and
    // that is the direction a broken parse has to fall in.
    const declareFailedFiles = (text) => {
      const line = FAILED_FILES_LINE.exec(text);
      if (!line) return;
      const paths = line[2]
        .split(',')
        .filter((path) => path !== '' && path.length <= PART_INPUT_LENGTH);
      if (paths.length === 0) return;
      const part = openPart(line[1]);
      for (const path of paths) {
        if (part.failedFiles.length >= PART_FAILED_FILES) return;
        if (!part.failedFiles.includes(path)) part.failedFiles.push(path);
      }
    };

    // The current part's declared input set, grown by every `part-inputs`
    // line it prints. Bounded, deduplicated, and dropped entirely for a
    // command with no part open: an entry with no part to belong to is a
    // statement about nothing.
    const declareInputs = (part, text) => {
      if (!part) return;
      for (const entry of text.split(/[ \t]+/)) {
        if (entry === '' || entry.length > PART_INPUT_LENGTH) continue;
        if (part.inputs.length >= PART_INPUTS) return;
        if (!part.inputs.includes(entry)) part.inputs.push(entry);
      }
    };

    const hold = (text) => {
      const grown = output + text;
      if (grown.length > outputLimit) truncated = true;
      output = grown.slice(-outputLimit);
      if (current) current.output = (current.output + text).slice(-PART_OUTPUT);
    };

    const absorb = (text) => {
      if (text === '') return;
      if (!text.includes(PART_PREFIX)) {
        hold(text);
        return;
      }
      for (const line of text.split(/(?<=\n)/)) {
        const marker = PART_MARKER.exec(line.trimEnd());
        if (!marker) {
          hold(line);
          continue;
        }
        if (marker[1] === 'part-inputs') {
          declareInputs(current, marker[2]);
          continue;
        }
        if (marker[1] === 'part-failed-files') {
          declareFailedFiles(marker[2]);
          continue;
        }
        const part = openPart(marker[2]);
        if (marker[1] === 'part-failed') part.failed = true;
        else if (marker[1] === 'part-ok') part.ok = true;
        else current = part;
      }
    };

    // The one gate every byte passes: redacted once, then written to the file
    // and read for markers. Whole lines, so a value cannot be halved by a
    // chunk boundary, and the file gets the text the caller would have seen.
    const take = (raw) => {
      if (raw === '') return;
      const text = redact ? redact(raw) : raw;
      if (log) log.write(text);
      absorb(text);
    };

    const collect = (chunk) => {
      pending += chunk;
      const end = pending.lastIndexOf('\n');
      if (end === -1) {
        if (pending.length > LINE_LIMIT) {
          take(pending);
          pending = '';
        }
        return;
      }
      take(pending.slice(0, end + 1));
      pending = pending.slice(end + 1);
    };

    const flush = () => {
      take(pending);
      pending = '';
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let settled = false;
    // The file settles with the command: a green's is deleted, a red's is
    // kept, and the handle is released either way before the caller is
    // answered. Nothing later has to remember to do it.
    // What the child's ending adds is the argument; everything the stream
    // produced is read here, after the flush, so a last line with no newline
    // on it is in the answer and in the file.
    const done = async (ending) => {
      flush();
      // The measurement ends with the command, before the answer: the sampler
      // is a process of its own on Windows, and one still running when the run
      // directory is archived is a handle inside it.
      const measured = sampler ? await sampler.stop().catch(() => null) : null;
      if (log) {
        // Evidence is a failure with something to show for it. A green says
        // all it has to say in the tail, and a failure that printed nothing
        // leaves no empty file behind to be read as evidence of anything.
        const evidence = ending.code !== 0 && log.record.bytes > 0;
        await log.settle(keep === 'always' || evidence);
      }
      resolve({
        ...ending,
        output,
        truncated,
        parts,
        log: log ? { ...log.record } : null,
        resources: measured,
      });
    };
    // A command that never ends. Every caller of this function awaits it, and
    // one of them awaits it inside the daemon's control drain, so a child that
    // hangs holds a queue nobody can see waiting. The kill is the answer the
    // caller gets: no exit code, and a reason that says what happened, which
    // is the same shape a command that could not spawn produces (ADR-0068).
    const deadline =
      typeof timeoutMs === 'number' && timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            // The tree, not the child: a probe that wraps a script leaves the
            // work in a grandchild, and killing the wrapper alone would answer
            // the caller while the thing that hung carried on.
            void terminateTree(child);
            void done({ code: null, timedOut: true, error: `timed out after ${timeoutMs} ms` });
          }, timeoutMs)
        : null;
    if (deadline?.unref) deadline.unref();
    const end = (ending) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      void done(ending);
    };
    child.on('error', (error) => end({ code: null, error: error.message }));
    child.on('close', (code, signal) => end({ code, signal }));
  });
}
