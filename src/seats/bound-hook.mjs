#!/usr/bin/env node
// The seat's bound, enforced at the tool call. One stage judges a tree, and it
// is the verdict; an implementation seat proves its own work and nothing
// wider. What its own work reaches is the footprint of its diff, so the bound
// is the layers that footprint selects and the seat is refused every other
// layer. The CLI runs this script before each command tool, hands it the call
// on stdin, and reads exit 2 as a refusal the seat receives as the tool's own
// error.
//
// The bound is computed here on every call rather than once at the spawn,
// because the seat's diff grows while it works and a bound fixed at the spawn
// would refuse the layer the seat's newest file needs. The file the runner
// writes carries only what cannot change inside one spawn: the worktree, the
// base commit, every layer with its command argv, its ground, its needs and
// whether it is setup, the frozen suite's name, and the per-layer durations of
// the certified base.
//
// Three readings pass whatever the diff says. A setup layer is what makes a
// worktree runnable at all, so it is in the bound by declaration and its own
// ground decides nothing. The frozen suite is the seat's own question and is
// never outside the seat's work. A layer with no duration reading has no cap
// to fail, because a cap is a claim about time and needs a measurement behind
// it.
//
// A refusal is appended beside the bound file as one JSON line. The run ledger
// has a single in-process writer holding the sequence in memory, so a second
// writer here would corrupt it and bypass every reader that listens on the
// append. The runner reads this file when the seat ends and stamps what it
// finds, which is the same fact with one writer.
//
// Doubt refuses. An unreadable bound file and a failed git command both exit 2
// naming the cause, because a hook that passes on its own failure leaves the
// seat unbounded and says nothing about it.
//
// Exit 0 writes one marker line carrying the bound file's digest. A settings
// file that fails validation is ignored in print mode, and the host's own
// hooks answer the same event, so the marker is what identifies this hook's
// answer in the stream and proves the bound loaded.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { underEntry } from '../config/project.mjs';
import { withDependents } from '../lanes/spectrum.mjs';
import { git } from '../isolation/git.mjs';

/** The cap a bound file that states none is read with. */
const DEFAULT_CAP_MS = 300000;

/** The first word of the stdout line, which is how the runner finds the hook. */
const MARKER = 'olympus-bound';

const boundPath = process.argv[2];
let digest = null;

const refusal = await decide();
if (refusal === null) {
  process.stdout.write(`${MARKER} ${digest}\n`);
} else {
  record(refusal);
  process.stderr.write(`${refusal.message}\n`);
  // No `process.exit`: stdout and stderr are pipes here, and a call that exits
  // before they drain hands the CLI a refusal with no text in it.
  process.exitCode = 2;
}

/**
 * The one decision this process makes: null to let the call through, or the
 * refusal to write. Every failure inside is a refusal, so nothing throws past
 * here and no path leaves the seat unbounded.
 * @returns {Promise<{layer: string|null, command: string, reason: string,
 *   message: string, seat?: string}|null>}
 */
async function decide() {
  let command = '';
  let bound = null;
  try {
    command = commandOf(JSON.parse(await readStdin()));
    if (boundPath === undefined) throw new Error('the hook was given no bound file path');
    const raw = readFileSync(boundPath);
    digest = createHash('sha256').update(raw).digest('hex');
    bound = JSON.parse(raw.toString('utf8'));
    const matched = matchedLayers(bound.layers ?? [], command);
    if (matched.length === 0) return null;
    const inBound = await boundLayers(bound);
    for (const layer of matched) {
      const reason = refusalReason(layer, bound, inBound);
      if (reason !== null) {
        return {
          ...seatOf(bound),
          layer: layer.name,
          command,
          reason,
          message: `${layer.name} is outside your bound: ${reason}. The verdict runs it.`,
        };
      }
    }
    return null;
  } catch (error) {
    const reason = String(error?.message ?? error);
    return {
      ...seatOf(bound),
      layer: null,
      command,
      reason,
      message: `the seat bound cannot be computed: ${reason}`,
    };
  }
}

/**
 * The seat's own command, as the CLI states it. A tool input that carries no
 * command string names no layer and is judged as such: this hook reads the
 * command and judges nothing else about a call.
 */
function commandOf(call) {
  const command = call?.tool_input?.command;
  return typeof command === 'string' ? command : '';
}

/**
 * Every layer the command runs. A layer is named by its command argv joined by
 * spaces and found anywhere in the command, because a seat runs a layer inside
 * a shell line that may hold a directory change, a redirection or a second
 * command. Whitespace is collapsed on both sides, so a line broken over
 * several spaces still names what it runs.
 */
function matchedLayers(layers, command) {
  const text = collapse(command);
  if (text.length === 0) return [];
  return layers.filter((layer) => {
    const argv = collapse((layer.argv ?? []).join(' '));
    return argv.length > 0 && text.includes(argv);
  });
}

/**
 * The layers the seat may run: the layers whose ground its diff touches, closed
 * over `needs` because a layer downstream of a changed one is judged against a
 * prerequisite that moved, plus the setup layers and the frozen suite, which
 * are in the bound by declaration.
 */
async function boundLayers(bound) {
  const layers = bound.layers ?? [];
  const changed = await changedFiles(bound.worktree, bound.baseSha);
  const touched = new Set();
  for (const layer of layers) {
    const ground = layer.ground ?? [];
    if (changed.some((file) => ground.some((entry) => underEntry(file, entry)))) {
      touched.add(layer.name);
    }
  }
  const inBound = withDependents(layers, touched);
  for (const layer of layers) if (layer.setup === true) inBound.add(layer.name);
  if (typeof bound.suite === 'string' && bound.suite.length > 0) inBound.add(bound.suite);
  return inBound;
}

/**
 * Why the seat may not run this layer, or null when it may.
 *
 * The cap reads the certified base's duration for the layer rather than a
 * budget in the config, because a budget with no measurement behind it refuses
 * on a guess. Absent the measurement the layer passes.
 */
function refusalReason(layer, bound, inBound) {
  if (!inBound.has(layer.name)) return 'the diff does not touch its ground';
  if (layer.setup === true) return null;
  if (layer.name === bound.suite) return null;
  const reading = bound.elapsedMs?.[layer.name];
  if (typeof reading !== 'number') return null;
  const cap = typeof bound.capMs === 'number' ? bound.capMs : DEFAULT_CAP_MS;
  if (reading < cap) return null;
  return `it took ${reading} ms on the certified base, at or over the ${cap} ms cap`;
}

/**
 * Every file the worktree holds differently from the base commit. The diff
 * answers for the tracked tree and `git status` for what is not committed yet,
 * and a seat is bounded by work it has not staged as much as by work it has.
 *
 * Both reads are NUL-separated so a path holding a space or a quote arrives
 * whole, and the status read names every untracked file rather than the
 * directory above it, which no ground entry would match.
 */
async function changedFiles(worktree, baseSha) {
  const diff = await git(['diff', '--name-only', '-z', baseSha], { cwd: worktree });
  const status = await git(['status', '--porcelain', '-z', '-uall'], { cwd: worktree });
  const files = new Set();
  for (const path of diff.split('\0')) if (path.length > 0) files.add(repoRelative(path));
  for (const path of statusPaths(status)) files.add(repoRelative(path));
  return [...files];
}

/**
 * The paths of a NUL-separated status read. An entry is its two status letters,
 * a space and the path; a rename or a copy adds a second field for the path it
 * came from, and both ends are the seat's work.
 */
function statusPaths(text) {
  const fields = text.split('\0');
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) {
      i++;
      if (fields[i]?.length > 0) paths.push(fields[i]);
    }
  }
  return paths;
}

/** The seat name, when the bound file carries one for the runner's stamp. */
function seatOf(bound) {
  return typeof bound?.seat === 'string' ? { seat: bound.seat } : {};
}

/**
 * Appends the refusal beside the bound file. A failure here is swallowed: the
 * refusal is already on stderr and reaches the seat, and losing the runner's
 * copy of it is no reason to let the command run.
 */
function record({ message, ...line }) {
  if (boundPath === undefined) return;
  const entry = JSON.stringify({ ...line, at: new Date().toISOString() });
  try {
    appendFileSync(`${boundPath}.refusals.jsonl`, `${entry}\n`);
  } catch {
    // The seat has the refusal on stderr; the runner's copy is what is lost.
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function collapse(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function repoRelative(path) {
  return path.replaceAll('\\', '/');
}
