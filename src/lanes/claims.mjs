// The claim run: the harness runs a review seat's suite claims before the
// verifier judges them (ADR-0094).
//
// A review seat that says a frozen test must be amended is making a claim about
// what that test does at the judged sha. Reading is how a seat answers such a
// claim, and a reading that is wrong amends tests that did not need amending.
// The suite command is the one reader that cannot be wrong about it, and the
// harness can ask it: one run of the acceptance layer, narrowed to the claimed
// files, between the review seats' reports and the verifier's spawn. The
// verifier then judges with the run in hand.
//
// ONE RUN PER ROUND, NEVER ONE PER FINDING. A collision across five files is
// five findings, and five runs of one acceptance layer is hours before any seat
// spawns. The round's whole claimed set rides one command.
//
// IT NEVER GOES THROUGH THE SPECTRUM. A run through the spectrum stamps
// `layer-started` and `layer-result` and becomes the cycle's standing
// acceptance result, which is a green or a red the cycle did not judge. This
// runs the command directly, keeps its own log and stamps its own events.
//
// THE READING IS PER FILE AND IT IS NOT THE EXIT CODE. A narrowed run of a file
// the framework selects no test from exits 0 under a pass-with-no-tests flag, so
// a green exit says nothing about the file. Three answers:
//
//   red         the file is among the reds a part reported
//   green       the part that answered for it passed AND said it selected it
//   unselected  everything else
//
// `unselected` is the safe direction and it covers three real cases: a file no
// gate of the project runs, a command that reads no narrowing variable and
// prints no selection line, and a command that could not run at all. The
// verifier's own reading stands for each of them. A command that could not run
// is not a park here, unlike a gate layer: this run is evidence and never a
// verdict, so its absence leaves the round exactly where the round already was.
import { readFileSync } from 'node:fs';
import { commandLogPath } from '../daemon/home.mjs';
import { underEntry } from '../config/project.mjs';
import { runCommand } from './exec.mjs';
import { FILES_ENV, PARTS_ENV, fileNarrowing, layerGround, partGround } from './parts.mjs';
import { ACTOR, runEvents } from './shared.mjs';

// The selection lines a command prints to answer a file list: the part name
// runs to the last whitespace and the path list is the token after it, which is
// the shape `part-failed-files` already takes in `exec.mjs`. A line with no path
// list states an empty side of the partition, which is a part that selected
// nothing rather than a part that ran whole.
const SELECTED_LINE = /^::olympus files-selected[ \t]+(.*?)(?:[ \t]+([^ \t]+))?[ \t]*$/;

/**
 * The layer that runs the frozen suite, with the argv behind it, or null where
 * the lane names none. The claim is about a frozen test, so the suite command is
 * the only command that can answer it.
 */
function suiteCommand(base) {
  const command = base?.config?.lanes?.story?.suiteCommand;
  if (typeof command !== 'string' || command.length === 0) return null;
  const layer = (base.layers ?? []).find((entry) => entry.command === command);
  const argv = base.commands?.[command];
  if (!layer || !Array.isArray(argv) || argv.length === 0) return null;
  return { layer, argv };
}

/**
 * The parts of the suite layer whose recorded ground covers every claimed file,
 * or null when the run must go whole.
 *
 * Three cases drop the narrowing, and doubt runs whole here as it does
 * everywhere else: a claimed file no part's ground covers, a run with no
 * standing result for the layer, and a result the cycle carried, which holds no
 * part table at all and so can map nothing.
 */
function claimParts(base, events, layer, files) {
  const result = [...events]
    .reverse()
    .find((e) => e.event === 'layer-result' && e.layer === layer.name);
  const parts = result?.mode === 'carried' ? [] : (result?.parts ?? []);
  if (parts.length === 0) return null;
  const ground = layerGround(layer, result, base.config?.gates?.breadthGround ?? [], base.recordPaths ?? []);
  const named = new Set();
  for (const file of files) {
    const holders = parts.filter((part) =>
      partGround(part, ground).some((entry) => underEntry(file, entry)),
    );
    if (holders.length === 0) return null;
    for (const part of holders) named.add(part.name);
  }
  // A part that declares no input set of its own takes the layer's ground, so a
  // prerequisite step joins the list. That costs nothing: a command that runs
  // its prerequisites anyway runs them either way, and a list that left one out
  // would ask for a step whose inputs nothing built.
  for (const part of parts) {
    if (partGround(part, ground).length === 0) named.add(part.name);
  }
  return [...named];
}

/** Which parts said they selected which of the files they were handed. */
function selectedByPart(logPath) {
  const selected = new Map();
  if (typeof logPath !== 'string' || logPath.length === 0) return selected;
  let text;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return selected;
  }
  for (const raw of text.split('\n')) {
    const line = SELECTED_LINE.exec(raw.trimEnd());
    if (!line) continue;
    const files = (line[2] ?? '').split(',').filter((path) => path !== '');
    const held = selected.get(line[1]) ?? new Set();
    for (const path of files) held.add(path.replaceAll('\\', '/'));
    selected.set(line[1], held);
  }
  return selected;
}

/**
 * What one run said about one claimed file: the answer and the part that gave
 * it.
 *
 * A red is a red whichever part reported it. A green needs two statements from
 * one part: the part passed, and the part says its framework answered for this
 * file. Either one alone is a green nobody earned: a passing part says nothing
 * about a file it never selected, and a selection line on a red part says the
 * file ran inside a step that failed.
 */
function readClaim(file, parts, selected) {
  const path = file.replaceAll('\\', '/');
  const red = parts.find((part) =>
    (part.failedFiles ?? []).some((entry) => String(entry).replaceAll('\\', '/') === path),
  );
  if (red) return { result: 'red', part: red.name };
  const green = parts.find((part) => part.ok === true && selected.get(part.name)?.has(path));
  if (green) return { result: 'green', part: green.name };
  return { result: 'unselected', part: null };
}

/**
 * Runs one review round's suite claims and records what the run said about each
 * one.
 *
 * Idempotent by `{cycle, item}`: a round whose every claimed item already holds
 * a `claim-run` of this cycle reads the answers off the ledger and runs nothing.
 * A round that holds some of them runs again, which is the safe direction: a
 * partial run's log names fewer files than the round claims, and reading it
 * would turn an unfinished run into an `unselected` verdict on the rest.
 *
 * @param {object} ctx the stage context
 * @param {object} base the lane base
 * @param {{cycle: number, claims: Array<{item: string, file: string}>}} opts
 * @returns {Promise<Map<string, {file: string, result: string,
 *   part: string|null, log: string|null}>>} by verifier item id
 */
export async function runClaims(ctx, base, { cycle, claims }) {
  const answers = new Map();
  if (!Array.isArray(claims) || claims.length === 0) return answers;
  const events = runEvents(ctx);
  const stamped = new Map(
    events
      .filter((e) => e.event === 'claim-run' && e.cycle === cycle)
      .map((e) => [e.item, { file: e.file, result: e.result, part: e.part ?? null, log: e.log ?? null }]),
  );
  if (claims.every((claim) => stamped.has(claim.item))) {
    for (const claim of claims) answers.set(claim.item, stamped.get(claim.item));
    return answers;
  }
  const files = [...new Set(claims.map((claim) => claim.file.replaceAll('\\', '/')))];
  const suite = suiteCommand(base);
  // A lane with no suite command cannot ask the question, so every claim keeps
  // the verifier's own reading. The stamp is written all the same: a claim with
  // no record of its run is what the `claim-unrun` alarm is about, and this run
  // did answer, with the only answer there is.
  if (!suite) {
    for (const claim of claims) {
      answers.set(claim.item, stampClaim(ctx, cycle, claim, { result: 'unselected', part: null, log: null }));
    }
    return answers;
  }
  const parts = claimParts(base, events, suite.layer, files);
  const narrow = fileNarrowing(files);
  const log = commandLogPath(ctx.paths, ctx.runId, `claim-c${cycle}`);
  // The run says it started. It holds the run for as long as the suite layer
  // does, and a stage that stamps nothing for that long reads to a person
  // exactly like a stage that died.
  ctx.store.append('claim-started', {
    actor: ACTOR,
    cycle,
    items: claims.map((claim) => claim.item),
    files,
    ...(parts && { parts }),
    log,
  });
  const run = await runCommand(suite.argv, {
    cwd: base.worktree,
    env: {
      ...base.env,
      ...(parts && { [PARTS_ENV]: parts.join(',') }),
      ...(narrow.value !== '' && { [FILES_ENV]: narrow.value }),
    },
    log,
    // The selection line of a green run is the evidence, and the default
    // deletes the log of a command that exited 0.
    keep: 'always',
  });
  const selected = selectedByPart(log);
  for (const claim of claims) {
    const read = readClaim(claim.file, run.parts ?? [], selected);
    answers.set(claim.item, stampClaim(ctx, cycle, claim, { ...read, log }));
  }
  return answers;
}

/** One claimed file's answer, on the ledger, with the unproven mark beside it. */
function stampClaim(ctx, cycle, claim, { result, part, log }) {
  const file = claim.file.replaceAll('\\', '/');
  ctx.store.append('claim-run', {
    actor: ACTOR,
    cycle,
    item: claim.item,
    file,
    ...(part && { part }),
    result,
    ...(log && { log }),
  });
  if (result === 'green') {
    // The test the claim wants amended passes at the judged sha, so the premise
    // of the claim is not met and the finding is advisory whatever the verifier
    // says. The stamp is what carries the claim to a later red in that file.
    ctx.store.append('claim-unproven', {
      actor: ACTOR,
      cycle,
      item: claim.item,
      file,
      ...(log && { log }),
    });
  }
  return { file, result, part: part ?? null, log: log ?? null };
}

/**
 * The claims of this run that its own suite command turned green, newest last.
 * A later triage is briefed with them, so a red that finally appears in one of
 * those files arrives with the claim already written.
 * @param {object[]} events the run's ledger, in order
 */
export function unprovenClaims(events) {
  return (events ?? [])
    .filter((e) => e.event === 'claim-unproven')
    .map((e) => ({ cycle: e.cycle, file: e.file, log: e.log ?? null }));
}
