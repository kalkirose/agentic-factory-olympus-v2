// Runner for project-config commands (suite runs, reference lint). The argv
// comes from the project config's `commands` table — the single home for
// every runnable command. The result carries the exit code and an output
// tail; the caller judges the code, this module never does.
//
// A layer command is often a sequence of its own — a suite runner with steps,
// a script that shells out several times — and it reports one exit code for
// all of it. The tail of such a stream is whatever ran last, which on a red in
// the middle is the detail of the parts that passed. So a command may say
// where its parts begin, and then each part keeps a bounded tail of its own
// and the caller records the failing part under its name instead of the
// minutes of green that followed it.
//
// The protocol is two lines a command may print, on their own:
//
//   ::olympus part <name>          what follows belongs to <name>
//   ::olympus part-failed <name>   <name> failed; its own output is evidence
//
// Nothing changes for a command that prints neither: the parts are empty and
// the tail is the tail it always was. Marker lines are consumed, never kept.
import { spawn } from 'node:child_process';
import { resolveArgv } from '../engine/executable.mjs';

const PART_PREFIX = '::olympus ';
const PART_MARKER = /^::olympus (part|part-failed)[ \t]+(.+?)[ \t]*$/;
// Per part, and how many parts a run holds: a bound the longest sequence a
// project runs stays under, and small enough that a command with no markers
// costs nothing and one with thousands cannot grow the daemon.
const PART_OUTPUT = 4000;
const PART_LIMIT = 24;
// A marker is one line. Text this long with no newline in it is not a marker,
// and holding it back to look for one would only grow a buffer.
const LINE_LIMIT = 65536;

/**
 * Runs one command to completion.
 * @param {string[]} argv
 * @param {{cwd?: string, env?: object, outputLimit?: number}} [opts]
 * @returns {Promise<{code: number|null, signal?: string|null, output: string,
 *   truncated: boolean,
 *   parts: Array<{name: string, failed: boolean, output: string}>,
 *   error?: string}>}
 *   `code` is null when the command could not run at all (spawn error) —
 *   an environment defect, never a verdict about the tree under test.
 *   `parts` is what the command said about its own parts, in the order it
 *   opened them; empty for a command that said nothing.
 *   `truncated` says the stream outgrew the bound, so `output` is a tail and
 *   what the caller holds is not what the command printed. The caller decides
 *   what that costs; this module never does.
 */
export function runCommand(argv, { cwd, env, outputLimit = 4000 } = {}) {
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
      resolve({ code: null, output: '', truncated: false, parts: [], error: error.message });
      return;
    }
    const child = spawn(spec.file, spec.args, {
      cwd,
      env: base,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(spec.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
    });
    let output = '';
    let pending = '';
    let truncated = false;
    const parts = [];
    let current = null;

    const openPart = (name) => {
      const known = parts.find((p) => p.name === name);
      if (known) return known;
      if (parts.length >= PART_LIMIT) {
        // A part that reported a failure outlives one that did not.
        const spare = parts.findIndex((p) => !p.failed);
        parts.splice(spare === -1 ? 0 : spare, 1);
      }
      const part = { name, failed: false, output: '' };
      parts.push(part);
      return part;
    };

    const keep = (text) => {
      const grown = output + text;
      if (grown.length > outputLimit) truncated = true;
      output = grown.slice(-outputLimit);
      if (current) current.output = (current.output + text).slice(-PART_OUTPUT);
    };

    const absorb = (text) => {
      if (text === '') return;
      if (!text.includes(PART_PREFIX)) {
        keep(text);
        return;
      }
      for (const line of text.split(/(?<=\n)/)) {
        const marker = PART_MARKER.exec(line.trimEnd());
        if (!marker) {
          keep(line);
          continue;
        }
        const part = openPart(marker[2]);
        if (marker[1] === 'part-failed') part.failed = true;
        else current = part;
      }
    };

    const collect = (chunk) => {
      pending += chunk;
      const end = pending.lastIndexOf('\n');
      if (end === -1) {
        if (pending.length > LINE_LIMIT) {
          absorb(pending);
          pending = '';
        }
        return;
      }
      absorb(pending.slice(0, end + 1));
      pending = pending.slice(end + 1);
    };

    const flush = () => {
      absorb(pending);
      pending = '';
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let settled = false;
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      flush();
      resolve({ code: null, output, truncated, parts, error: error.message });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      flush();
      resolve({ code, signal, output, truncated, parts });
    });
  });
}
