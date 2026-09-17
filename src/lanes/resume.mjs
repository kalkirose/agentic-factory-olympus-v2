// Resume from a prior run's freeze. A launch may inherit the whole pre-freeze
// derivation of a run that died after its freeze: the born spec, the freeze
// record, and the frozen suite at its sha. The prior run stays closed and
// archived; nothing here writes to it.
//
// Every validation lives here so the console command, the daemon handler, and
// the lane's admission gate refuse on the same facts. A refusal always names
// its reason: a freeze that silently applies to a different tree is worse than
// a re-derived one.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '../ledger/ledger.mjs';
import { LOUD_EVENTS } from '../ledger/registry.mjs';
import { runLedgerPath, archivedRunLedgerPath } from '../daemon/home.mjs';
import { runBranch } from '../isolation/worktrees.mjs';

/** A run's directory: the live one while it runs, the archive after it closes. */
export function priorRunDir(paths, runId) {
  return existsSync(runLedgerPath(paths, runId))
    ? join(paths.runs, runId)
    : join(paths.archivedRuns, runId);
}

/**
 * The suite files one run's own writes declared, as a union in ledger order.
 *
 * It is the run's statement about which test files it wrote, and it is much
 * narrower than the freeze record's `suiteFiles`, which is every file under the
 * test paths at the freeze sha. Two readers need the narrow list: the red-state
 * check, whose question is about the files the write changed, and the dev
 * brief, which tells the seat which files define its own story.
 *
 * A later write need not restate an earlier one, so the union is the only
 * complete reading. What it may hold that the tree does not is a file a later
 * write deleted, and every caller filters against the tree it is asking about.
 *
 * @param {Array<object>} events one run ledger, in order
 * @returns {string[]}
 */
export function suiteWriteFiles(events = []) {
  const files = [];
  const seen = new Set();
  for (const e of events) {
    if (e.event !== 'suite-committed') continue;
    for (const file of e.files ?? []) {
      if (typeof file !== 'string' || seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

/**
 * The same union, read out of another run's ledger — live directory or archive.
 *
 * A run that inherited a freeze wrote no suite of its own, so every reader of
 * "the files this run's suite writes named" has to reach the prior run for
 * them. It validates nothing: the inheritance was validated where it was taken,
 * and a reader that cannot open the ledger is told the run named no file, which
 * is the answer every caller here already handles.
 */
export function priorSuiteWrites(paths, runId) {
  if (typeof runId !== 'string' || runId.length === 0) return [];
  try {
    return suiteWriteFiles(readEvents(join(priorRunDir(paths, runId), 'ledger.jsonl')));
  } catch {
    return [];
  }
}

/**
 * The freeze anchor of a run: the freeze it earned, or the one it inherited.
 * Both name the sha the suite is restored from and the tree an implementation
 * starts on, so every reader after the freeze takes either.
 */
export function freezeAnchor(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'freeze' || e.event === 'freeze-inherited') return e;
  }
  return null;
}

/** The recorded close state of a run, live ledger or archive; null when open. */
export function closeState(paths, runId) {
  for (const path of [runLedgerPath(paths, runId), archivedRunLedgerPath(paths, runId)]) {
    const closed = readEvents(path).find((e) => e.event === 'run-closed');
    if (closed) return closed.state;
  }
  return null;
}

/**
 * Reads and validates the inheritance a resume would take from `runId`, and
 * throws on every condition under which the harness would have to guess.
 * Returns the facts a launch needs: the frozen sha, the artifacts to carry,
 * the card the prior run ran, and pointers to what stays behind.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {string} runId
 */
export function readInheritance(paths, runId) {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('a resume requires the id of the run it inherits from');
  }
  const dir = priorRunDir(paths, runId);
  const events = readEvents(join(dir, 'ledger.jsonl'));
  if (events.length === 0) throw new Error(`no ledger for run ${runId}`);
  const launch = events.find((e) => e.event === 'run-launched');
  if (!launch) throw new Error(`run ${runId} has no launch record`);
  if (launch.lane !== 'story') throw new Error(`run ${runId} is not a story-lane run`);
  const closed = events.find((e) => e.event === 'run-closed');
  // An open run owns its branch and writes to it; a shipped run's freeze
  // belongs to work that is already on the default branch.
  if (!closed) throw new Error(`run ${runId} is still open`);
  if (closed.state === 'shipped') {
    throw new Error(`run ${runId} shipped; its freeze belongs to merged work`);
  }
  const anchor = freezeAnchor(events);
  if (!anchor || typeof anchor.sha !== 'string') {
    throw new Error(`run ${runId} has no freeze record`);
  }
  const freezePath = join(dir, 'freeze.json');
  let record = null;
  try {
    record = JSON.parse(readFileSync(freezePath, 'utf8'));
  } catch {
    throw new Error(`run ${runId} has no readable freeze record at ${freezePath}`);
  }
  if (typeof record?.suiteSha !== 'string') {
    throw new Error(`the freeze record of run ${runId} names no suite sha`);
  }
  const specPath = join(dir, 'spec.md');
  if (!existsSync(specPath) || readFileSync(specPath, 'utf8').trim().length === 0) {
    throw new Error(`run ${runId} has no born spec at ${specPath}`);
  }
  if (typeof launch.card !== 'string' || launch.card.length === 0) {
    throw new Error(`run ${runId} launched without an intent card`);
  }
  // Without the base the freeze was derived against, no reader can tell
  // whether it still applies to the tree it would merge into.
  if (typeof launch.baseSha !== 'string') {
    throw new Error(`run ${runId} records no base sha for its freeze`);
  }
  return {
    runId,
    project: launch.project,
    card: launch.card,
    storyKey: typeof launch.storyKey === 'string' ? launch.storyKey : null,
    branch: typeof launch.branch === 'string' ? launch.branch : runBranch(runId),
    // The tree the freeze certified. Everything the prior run committed after
    // it — implementations, repairs, re-freezes — is left on that branch.
    frozenSha: anchor.sha,
    // The default-branch head the prior run launched on: the base the freeze
    // was derived against.
    baseSha: launch.baseSha,
    specPath,
    freezePath,
    record,
    // The decision records the inherited freeze carries. They were born before
    // the frozen sha, so the tree this run starts on holds them and this run
    // owes none of them; a resumed run that stamped nothing would count every
    // record it inherited as one the judge found late (ADR-0074).
    records: inheritedRecords(events),
    // The test files the prior run's own suite writes named. The resumed run
    // writes no suite, so this is the only statement of what its frozen suite
    // is FOR, as against every file the test paths happen to hold.
    suiteWrites: suiteWriteFiles(events),
    openFindings: openFindingIds(events),
    openLoud: openLoudSeqs(events),
  };
}

/**
 * The record commit of the prior run, as the paths and the decision behind it.
 * A prior run from before the records stage stamped nothing, and inherits an
 * empty set: the tree holds no born record and the count is right either way.
 */
function inheritedRecords(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== 'records-committed') continue;
    return { paths: e.paths ?? [], decided: e.decided === true };
  }
  return { paths: [], decided: false };
}

/** The finding ids the prior run's last verdict left open. */
function openFindingIds(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'verdict-rendered') return e.open ?? [];
  }
  return [];
}

/** Loud items in the prior run's ledger with no paired resolution. */
function openLoudSeqs(events) {
  const resolved = new Set(events.filter((e) => e.event === 'resolved').map((e) => e.resolves));
  return events
    .filter((e) => LOUD_EVENTS.has(e.event) && !resolved.has(e.seq))
    .map((e) => e.seq);
}
