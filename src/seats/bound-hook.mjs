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
// The suite is refused on one other reading, and it is about the FORM of the
// command rather than the layer. The whole suite is the verdict's to run, so a
// bound that says so refuses the bare command and passes one that carries a
// narrowing in front of it on the same line (ADR-0092).
//
// A layer is matched by its config argv and by the project's own script names
// for the same run, which the bound file carries per layer. A match on the
// config spelling alone is a bound nobody meets: a seat reaches for the name
// the project's documentation uses.
//
// The bound itself is computed in `bound.mjs`, which the brief and the stamp
// read too. Beyond the layers the diff touches, that set holds every layer they
// need; a prerequisite admitted that way is judged by the cap here like any
// other bound layer, unless it declares `setup`.
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
import { boundLayerNames } from './bound.mjs';
import { git } from '../isolation/git.mjs';

/** The cap a bound file that states none is read with. */
const DEFAULT_CAP_MS = 300000;

// What may stand on either side of a whole command word. The empty string is
// the start and the end of the text, which both patterns accept.
const WORD_EDGE_BEFORE = /^$|^[\s;&|(]$/;
const WORD_EDGE_AFTER = /^$|^[\s;&|)>]$/;

/**
 * A narrowing variable assigned inline, in the text in front of the command.
 *
 * The assignment has to carry a value: an empty one narrows nothing, and a
 * mention of the name somewhere else in the line is not an assignment at all.
 * The hook reads one call at a time and never the shell's own state, so a seat
 * that exported the variable in an earlier call and then ran the bare command
 * is refused. That is the accepted cost of a bound enforced per call.
 */
const NARROWING_ASSIGNED = /(?:^|[\s;&|(])OLYMPUS_(?:FILES|PARTS)=[^\s;&|)]/;

// These three are declared above the decision below because this module runs
// its decision at the top level: a constant declared after that line is still
// in its dead zone when the decision reads it.

/** The first word of the stdout line, which is how the runner finds the hook. */
const MARKER = 'olympus-bound';

const boundPath = process.argv[2];

const { refusal, digest } = await decide();
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
 * The one decision this process makes: the refusal to write, or null to let the
 * call through with the bound file's digest. Every failure inside is a refusal,
 * so nothing throws past here and no path leaves the seat unbounded.
 * @returns {Promise<{refusal: {layer: string|null, command: string,
 *   reason: string, message: string, seat?: string}|null, digest: string|null}>}
 */
async function decide() {
  let command = '';
  let bound = null;
  let digest = null;
  try {
    command = commandOf(JSON.parse(await readStdin()));
    if (boundPath === undefined) throw new Error('the hook was given no bound file path');
    const raw = readFileSync(boundPath);
    digest = createHash('sha256').update(raw).digest('hex');
    bound = JSON.parse(raw.toString('utf8'));
    const matched = matchedLayers(bound.layers ?? [], command);
    if (matched.length === 0) return { refusal: null, digest };
    const inBound = await boundLayers(bound);
    for (const { layer, at } of matched) {
      const refused = refusalReason(layer, bound, inBound, spelling(command).slice(0, at));
      if (refused === null) continue;
      return {
        refusal: {
          ...seatOf(bound),
          layer: layer.name,
          command,
          reason: refused.reason,
          ...(refused.narrowed === true && { narrowed: true }),
          message:
            refused.message ??
            `${layer.name} is outside your bound: ${refused.reason}. The verdict runs it.`,
        },
        digest,
      };
    }
    return { refusal: null, digest };
  } catch (error) {
    const reason = String(error?.message ?? error);
    return {
      refusal: {
        ...seatOf(bound),
        layer: null,
        command,
        reason,
        message: `the seat bound cannot be computed: ${reason}`,
      },
      digest,
    };
  }
}

/**
 * The seat's own command, as the CLI states it. A command tool carries a shell
 * line in `command`; the REPL carries source in `code`, which runs a layer as
 * readily as a shell line does and is read the same way. A tool input that
 * carries neither names no layer: this hook reads what the call would run and
 * judges nothing else about it.
 */
function commandOf(call) {
  const input = call?.tool_input ?? {};
  for (const field of ['command', 'code']) {
    if (typeof input[field] === 'string') return input[field];
  }
  return '';
}

/**
 * Every layer the command runs, each with where in the command it was found.
 *
 * A layer is named by its command argv joined by spaces, found anywhere in the
 * command, because a seat runs a layer inside a shell line that may hold a
 * directory change, a redirection or a second command.
 *
 * It is ALSO named by any alias the bound file carries: the project's own
 * script names for the same run. Without them the match never fires on the way
 * a seat actually runs a layer, because a seat reaches for the name the
 * project's own documentation uses and not for the config's argv.
 *
 * An alias matches only as a whole command word. A word-character boundary
 * would not do it: a script name may hold a colon, which is a non-word
 * character, so a short name would match inside a longer one and refuse a layer
 * that was never run. So an alias has to be preceded by the start of the text,
 * whitespace or a shell separator, and followed by the end of the text,
 * whitespace or a shell separator.
 *
 * The position is returned because one reading depends on what stands BEFORE
 * the command: a narrowing variable assigned inline.
 */
function matchedLayers(layers, command) {
  const text = spelling(command);
  if (text.length === 0) return [];
  const matched = [];
  for (const layer of layers) {
    const argv = spelling((layer.argv ?? []).join(' '));
    let at = argv.length > 0 ? text.indexOf(argv) : -1;
    for (const alias of layer.aliases ?? []) {
      if (at !== -1) break;
      at = wordIndex(text, spelling(alias));
    }
    if (at !== -1) matched.push({ layer, at });
  }
  return matched;
}

/** Where one whole command word stands in the text, or -1. */
function wordIndex(text, word) {
  if (word.length === 0) return -1;
  for (let from = 0; from <= text.length - word.length; ) {
    const at = text.indexOf(word, from);
    if (at === -1) return -1;
    const before = at === 0 ? '' : text[at - 1];
    const after = at + word.length >= text.length ? '' : text[at + word.length];
    if (WORD_EDGE_BEFORE.test(before) && WORD_EDGE_AFTER.test(after)) return at;
    from = at + 1;
  }
  return -1;
}



/**
 * One command line as the match reads it. The same invocation has several
 * ordinary spellings, and a match on the literal argv would let every one of
 * them but the config's own walk past the bound: a line broken over several
 * spaces, a Windows path separator, a quoted script path. Whitespace is
 * collapsed, a backslash reads as a forward slash, and a quote is dropped.
 *
 * Both sides are read through this, so the layer's own argv is normalised the
 * same way and a config that quotes a path still matches.
 */
function spelling(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replaceAll('\\', '/')
    .replaceAll('"', '')
    .replaceAll("'", '')
    .trim();
}

/**
 * The layers the seat may run, against the diff it holds now. The rule is the
 * one the brief named at the spawn; only the file list differs, and here it is
 * the live diff rather than the declared paths.
 */
async function boundLayers(bound) {
  return boundLayerNames(bound, await changedFiles(bound.worktree, bound.baseSha));
}

/**
 * Why the seat may not run this layer, or null when it may.
 *
 * The cap reads the certified base's duration for the layer rather than a
 * budget in the config, because a budget with no measurement behind it refuses
 * on a guess. Absent the measurement the layer passes.
 *
 * The suite is the one layer refused on its FORM rather than on its time. It is
 * the seat's own question, so it is always in the bound, and it is the heaviest
 * layer of most projects: a seat that runs the whole of it spends the run ten
 * minutes and more on files its own diff cannot reach, and the verdict runs
 * every one of them again at the sha it ships. So a bound that says the suite
 * is narrowed refuses the bare command and passes a narrowed one. The rule
 * reads no duration at all, deliberately: the certified reading for a suite
 * layer is usually a narrowed re-run's, which is far under any cap, so a
 * duration rule would pass the whole suite on the day it shipped (ADR-0092).
 *
 * `before` is the command text that stands in front of the match, which is
 * where an inline assignment has to be for the shell to apply it to this
 * command.
 *
 * @returns {{reason: string, message?: string, narrowed?: boolean}|null}
 */
function refusalReason(layer, bound, inBound, before) {
  if (!inBound.has(layer.name)) return { reason: 'the diff does not touch its ground' };
  if (layer.setup === true) return null;
  if (layer.name === bound.suite) {
    if (bound.suiteNarrowed !== true) return null;
    if (NARROWING_ASSIGNED.test(before)) return null;
    return {
      reason: 'the whole suite belongs to the verdict stage',
      narrowed: true,
      message:
        `${layer.name} runs whole in the verdict stage alone. Put OLYMPUS_FILES=` +
        '<comma-separated repo-relative test paths> or OLYMPUS_PARTS=<comma-separated part ' +
        'names> in front of the command, on the same line, and it runs.',
    };
  }
  const reading = bound.elapsedMs?.[layer.name];
  if (typeof reading !== 'number') return null;
  const cap = typeof bound.capMs === 'number' ? bound.capMs : DEFAULT_CAP_MS;
  if (reading < cap) return null;
  return {
    reason: `it took ${reading} ms on the certified base, at or over the ${cap} ms cap`,
  };
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
  // Without these two the diff would answer for whatever tree this process
  // stands in, which is a bound the seat never had. Doubt refuses instead.
  for (const [field, value] of [
    ['worktree', worktree],
    ['baseSha', baseSha],
  ]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`the bound file states no ${field}`);
    }
  }
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

function repoRelative(path) {
  return path.replaceAll('\\', '/');
}
