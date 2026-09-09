// The stub seat CLI. The instance config's `claudeCommand` names it, so the
// daemon assembles the real argv, spawns it through the real supervisor, and
// reads the real stream-json contract back. What the stub replaces is the
// model, and nothing else: it identifies its seat from the shared core block
// of the prompt it was handed, produces the artifacts that seat owes, writes
// its JSON report where the prompt says, and exits 0.
//
// The scenario file (OLYMPUS_E2E_SCENARIO) holds the artifact texts, so one
// stub drives every lane.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? '';
const model = valueOf('--model') ?? '(none)';
const scenario = JSON.parse(readFileSync(process.env.OLYMPUS_E2E_SCENARIO, 'utf8'));

/** The sentence a corrective dispatch writes into the record it answers. */
const ANSWERED = 'The corrective round answered the finding.';

// A seat name may carry a slot suffix (`reconcile-write:2`). The suffix is the
// dispatch's identity and not a seat, so the behaviour table reads the base.
const named = match(/You are the (\S+) seat in an Olympus run/)?.[1] ?? null;
const seat = named === null ? null : named.split(':')[0];
const slot = named === null ? null : (named.split(':')[1] ?? null);
const reportPath = reportPathFrom(prompt);

record();

if (!seat || !reportPath) {
  console.error(`stub seat: no seat or no report path in the prompt (seat: ${seat})`);
  process.exit(3);
}

// A seat that holds where it is. The scenario names one when it has to stop a
// run at an exact point: the moment after the stage created its worktree and
// before anything read it. The pid goes to the marker file first, so the
// scenario can end this process when it has what it waited for.
//
// The hold lifts where the scenario stops naming this seat. A scenario that
// needs the world to move under a running run holds a seat at the boundary,
// moves it, and lets the seat answer; a scenario about a crash ends the
// process instead, and this loop never sees the change.
if (scenario.stallSeat === seat) {
  writeFileSync(scenario.stallMarker, String(process.pid));
  // The timer holds the loop open. Without it the runtime finds nothing left
  // to do, ends the process on the pending await, and the hold becomes a seat
  // that exited rather than a seat that never answered.
  const beat = setInterval(() => {}, 1 << 30);
  while (stallNamed()) await new Promise((resolve) => setTimeout(resolve, 50));
  clearInterval(beat);
}

/** Whether the scenario, as it stands on disk now, still holds this seat. */
function stallNamed() {
  try {
    return JSON.parse(readFileSync(process.env.OLYMPUS_E2E_SCENARIO, 'utf8')).stallSeat === seat;
  } catch {
    return true;
  }
}

let work;
try {
  work = behaviour(seat);
} catch (error) {
  console.error(`stub seat: ${error.message}`);
  process.exit(4);
}

// The stream the supervisor parses: the init event carries the model it must
// see back, the assistant line becomes a progress note, the result line
// carries the cost.
emit({ type: 'system', subtype: 'init', model, session_id: `e2e-${seat}-${process.pid}` });
emit({
  type: 'assistant',
  message: { content: [{ type: 'text', text: `${seat}: fixture work product` }] },
});
for (const [path, content] of Object.entries(work.files ?? {})) {
  const full = isAbsolute(path) ? path : join(process.cwd(), path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(work.report, null, 2) + '\n');
emit({ type: 'result', subtype: 'success', total_cost_usd: 0.01 });
process.exit(0);

// -- the seat table ----------------------------------------------------------

function behaviour(name) {
  if (name === 'spec-birth') return specBirth();
  if (name === 'spec-gate') return specGate();
  if (name === 'suite') return suiteSeat();
  if (name === 'adversary') {
    return {
      files: scenario.adversaryFiles,
      report: {
        approach: 'an implementation that answers the shape and not the value',
        wrongness: 'the returned number is off by one',
      },
    };
  }
  if (name === 'dev') return devSeat();
  if (name === 'repair-dev') {
    return { files: scenario.repairFiles, report: { summary: 'the open finding is repaired' } };
  }
  if (name === 'verdict-triage') return triage();
  if (name === 'fury-verifier') return verifier();
  if (name.startsWith('fury-') || name === 'generalist-review') {
    return { report: { findings: [], summary: 'the diff answers the spec' } };
  }
  if (name === 'card-sweep') {
    return { report: { updatedCards: [], invalidated: [], summary: 'every card still stands' } };
  }
  if (name === 'reconcile-judge') return reconcileJudge();
  if (name === 'record-author') return recordAuthor();
  if (name === 'reconcile-write') return recordWrite();
  if (name === 'record-review') return recordReview();
  throw new Error(`no fixture behaviour for the ${name} seat`);
}

// -- the record seats (ADR-0073, ADR-0074, ADR-0075) --------------------------
//
// Every one of them answers the harness's own enumeration rather than a list of
// its own: the unit check counts the file, and a stub that guessed would prove
// nothing about the check. The brief names the enumerator by absolute path, so
// the stub runs the same command a real seat is told to run.

/** The units of one record, as `olympus-units` counts them. */
function unitsOf(record) {
  const bin = match(/node (\S*olympus-units\.mjs)/)?.[1];
  if (!bin) throw new Error('the brief names no unit enumerator');
  const out = execFileSync(process.execPath, [bin, record, '--json'], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** One answer per unit: the kind the enumerator gave it, and a path for a claim. */
function unitAnswers(record, evidence) {
  return unitsOf(record).map((unit) => ({
    record,
    id: unit.id,
    kind: unit.kind ?? (claimLike(unit.head) ? 'claim' : 'rationale'),
    verdict: 'holds',
    evidence: claimLike(unit.head) ? evidence : 'structure',
  }));
}

/**
 * Whether a unit head reads as a claim about the tree. The stub mirrors the
 * harness's own kind test rather than importing it: a claim filed as rationale
 * is one of the refusals this fixture must be able to meet.
 */
function claimLike(head) {
  return /[\w-]+\/[\w./-]+|`[^`]+`|\b(is|are|reads|returns|runs|writes|serves|exposes)\b/.test(head);
}

/** The judgment the scenario states, or a fixture with no record tree at all. */
function reconcileJudge() {
  const judged = scenario.reconcileJudge;
  if (!judged) {
    return {
      report: { owed: false, records: [], reason: 'no decision-record tree in this fixture' },
    };
  }
  // The recheck asks about the delta alone, and this fixture's repairs never
  // implicate a further record.
  if (prompt.includes('A repair round changed this run')) {
    return { report: { owed: false, records: [], reason: 'the delta implicates no record' } };
  }
  return { report: judged };
}

/** The birth: the records the scenario decides, or a work that decides none. */
function recordAuthor() {
  const records = scenario.bornRecords ?? {};
  const paths = Object.keys(records);
  for (const [path, content] of Object.entries(records)) {
    const full = join(process.cwd(), path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return {
    report: {
      rewritten: paths,
      unchanged: [],
      units: paths.flatMap((path) => unitAnswers(path, path)),
      divergences: [],
      ...(scenario.recordSiblings && { siblings: [] }),
      summary: paths.length > 0 ? 'the records this work decides' : 'the work decides no record',
    },
  };
}

/**
 * The calls this run has already recorded, this one included. The stub runs one
 * process per dispatch, so a scenario that counts dispatches counts them here.
 */
function priorCalls(match) {
  const out = [];
  for (const name of readdirSync(scenario.callDir)) {
    if (!name.endsWith('.json')) continue;
    let call;
    try {
      call = JSON.parse(readFileSync(join(scenario.callDir, name), 'utf8'));
    } catch {
      continue;
    }
    if (match(call)) out.push(call);
  }
  return out;
}

/** How many corrective dispatches this run has made over one record, this one included. */
function correctiveCalls(record) {
  return priorCalls(
    (call) =>
      call.seat === 'reconcile-write' &&
      call.prompt.includes('Confirmed findings:') &&
      call.prompt.includes(`- ${record}`),
  ).length;
}

/** How many times this run has reviewed one record, this read included. */
function reviewCalls(record) {
  return priorCalls(
    (call) =>
      call.seat === 'record-review' &&
      call.prompt.includes(`Review one decision record: ${record}`),
  ).length;
}

/**
 * One record, rewritten to state the tree. The brief names the one record.
 *
 * A scenario that names a supersession takes the other route: the old record
 * keeps its body and takes its status line, the record that replaces it is
 * added, and the report answers every unit of the replacement. It answers the
 * closed record's units as well, which the harness drops without a defect
 * (ADR-0078).
 */
function recordWrite() {
  const record = match(/^- (\S+\.md)$/m)?.[1];
  if (!record) throw new Error('the write brief names no record');
  const corrective = prompt.includes('Confirmed findings:');
  // A scenario about a refused dispatch: the report accounts for the judged
  // record nowhere, which is the check every write is refused on.
  const refusals = (scenario.recordRefusals ?? {})[record] ?? 0;
  if (corrective && correctiveCalls(record) <= refusals) {
    return {
      report: {
        rewritten: [],
        unchanged: [],
        units: [],
        divergences: [],
        answered: [...prompt.matchAll(/^- \[(F\d+)\]/gm)].map((m) => m[1]),
        ...(scenario.recordSiblings && { siblings: [] }),
        summary: 'the report accounts for the record nowhere',
      },
    };
  }
  const supersede = (scenario.reconcileSupersedes ?? {})[record];
  if (supersede) return supersedeWrite(record, supersede);
  // A corrective dispatch answers the finding in the record, which is what
  // moves the text the next cycle reads.
  const text = corrective
    ? `${readFileSync(join(process.cwd(), record), 'utf8')}\n${ANSWERED}\n`
    : (scenario.reconcileWrites ?? {})[record];
  if (text) {
    const full = join(process.cwd(), record);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return {
    report: {
      rewritten: text ? [record] : [],
      unchanged: text ? [] : [{ record, reason: 'the record already states the tree' }],
      units: unitAnswers(record, record),
      divergences: [
        {
          record,
          state: 'none',
          statement: 'the record and the tree state one thing',
          evidence: record,
        },
      ],
      ...(corrective && {
        answered: [...prompt.matchAll(/^- \[(F\d+)\]/gm)].map((m) => m[1]),
      }),
      ...(scenario.recordSiblings && { siblings: [] }),
      summary: `${record}, as the tree stands`,
    },
  };
}

/** The supersession one write makes: the old record closed, the new one added. */
function supersedeWrite(record, { closed, added, text }) {
  for (const [path, content] of [
    [record, closed],
    [added, text],
  ]) {
    const full = join(process.cwd(), path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return {
    report: {
      rewritten: [added],
      unchanged: [],
      units: [...unitAnswers(added, added), ...unitAnswers(record, record)],
      // One entry per record the check counts, and one about the record this
      // write closed, which the harness reads and never refuses.
      divergences: [added, record].map((path) => ({
        record: path,
        state: 'none',
        statement: 'the record that replaces this one states the tree',
        evidence: added,
      })),
      ...(prompt.includes('Confirmed findings:') && {
        answered: [...prompt.matchAll(/^- \[(F\d+)\]/gm)].map((m) => m[1]),
      }),
      ...(scenario.recordSiblings && { siblings: [] }),
      summary: `${record} is superseded by ${added}`,
    },
  };
}

/**
 * One record, reviewed whole. The brief carries the enumeration it answers.
 *
 * A scenario that names a finding for this record raises it on the first reads
 * of that record and on no later one, so a corrective round can close it. The
 * finding names a unit the same report answers `fails`, which is the rule every
 * record review report is refused on (ADR-0073).
 */
function recordReview() {
  const record = match(/^Review one decision record: (.+)$/m)?.[1]?.trim();
  if (!record) throw new Error('the review brief names no record');
  const units = [...prompt.matchAll(/^- (U\d+) \(line \d+(?:, (\w+))?\): (.+)$/gm)].map(
    ([, id, kind, head]) => ({
      record,
      id,
      kind: kind ?? (claimLike(head) ? 'claim' : 'rationale'),
      verdict: 'holds',
      evidence: claimLike(head) ? record : 'structure',
      head,
    }),
  );
  const raised = (scenario.recordFindings ?? {})[record];
  const target =
    raised && reviewCalls(record) <= (raised.reads ?? 1)
      ? (units.find((u) => u.kind === 'claim') ?? units[units.length - 1])
      : null;
  if (target) target.verdict = 'fails';
  return {
    report: {
      findings: target
        ? [
            {
              id: 'r1',
              criterion: 'truth',
              severity: 'HIGH',
              file: record,
              unit: target.id,
              head: target.head,
              line: 1,
              summary: raised.summary,
              evidence: record,
            },
          ]
        : [],
      units: units.map(({ head: _head, ...rest }) => rest),
      summary: 'every unit of the record stands',
    },
  };
}

/**
 * The gate round. A scenario that says nothing about the gate gets a clean
 * first round, as every scenario but the gate ones does. A scenario that
 * names `gateRounds` gets one entry per round: the blocking defects that
 * round reports, by the words that are their identity (ADR-0020). The round
 * is the invocation, and the report path carries it.
 */
function specGate() {
  const round = Number(/spec-gate-(\d+)\.json$/.exec(reportPath)?.[1] ?? 1);
  const defects = scenario.gateRounds ? (scenario.gateRounds[round - 1] ?? []) : [];
  return {
    report: {
      findings: defects.map((finding) => ({
        section: 'AC-1',
        finding,
        evidence: 'src/base.mjs',
      })),
      intentConflict: { conflict: false, detail: '' },
      summary:
        defects.length === 0
          ? 'the spec is grounded, in scope and encodable'
          : `${defects.length} blocking finding(s)`,
    },
  };
}

function specBirth() {
  const amending = prompt.includes('Amend the born spec');
  const path = match(
    amending
      ? /Amend the born spec at this absolute path: (.+)/
      : /Write the spec as markdown to this absolute path: (.+)/,
  )?.[1]?.trim();
  if (!path) throw new Error('the spec-birth prompt names no spec path');
  if (amending) {
    return {
      files: { [path]: scenario.specAmendment ?? scenario.spec },
      report: { amendedSections: ['AC-1'], summary: 'amended' },
    };
  }
  // A scenario may name a first draft the lint refuses; the corrective round
  // carries the lint's defects in its brief, and the stub then writes the spec.
  const draft = scenario.specFirstDraft && !prompt.includes('Correction brief');
  return {
    files: { [path]: draft ? scenario.specFirstDraft : scenario.spec },
    report: { outcome: 'spec-born', summary: 'the spec answers AC-1' },
  };
}

/**
 * The dimensions the surface-map brief names. The stub reads them off its own
 * prompt, so the fixture never restates the harness's list.
 */
function dimensions() {
  const block = /the dimensions the adversary weighs\.\n([\s\S]*?)\nFor each dimension,/.exec(prompt);
  if (!block) return [];
  return block[1]
    .split('\n')
    .map((line) => line.replace(/^- /, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * The surface map of one suite write: one enumerated item, closed by a test the
 * declared suite files hold, and every other dimension declared out of scope.
 * The item is the same at every write, so the map never shrinks, and every
 * survivor wave of this write sits on it.
 */
function surfaceMap(reds) {
  const dims = dimensions();
  if (dims.length === 0) return {};
  const out = (list) =>
    list.map((dimension) => ({
      dimension,
      reason: 'the fixture story renders no surface on this dimension',
    }));
  // A scenario that declares no red names no test, so it enumerates nothing.
  const named = reds[0]?.test;
  if (!named) return { surfaceMap: [], dimensionsOutOfScope: out(dims) };
  const [first, ...rest] = dims;
  const survivors = waves();
  return {
    surfaceMap: [
      {
        dimension: first,
        kind: 'route',
        item: 'the module entry point',
        where: 'src/feature.mjs',
        test: named,
        ...(survivors.length > 0 && { survivors }),
      },
    ],
    dimensionsOutOfScope: out(rest),
  };
}

function suiteSeat() {
  const files = scenario.suiteFiles ?? {};
  const reds = scenario.suiteReds ?? [];
  const report = {
    suiteFiles: Object.keys(files),
    reds,
    ...surfaceMap(reds),
    summary: 'the suite asserts the criterion',
  };
  // The amendment round takes a wider report than the author round.
  if (prompt.includes('list it under killingTests')) {
    report.killingTests = [];
    report.dispositions = waves().map((wave) => ({
      wave,
      disposition: 'unkilled-gap',
      reason: 'the fixture suite encodes no killing test',
    }));
  }
  return { files, report };
}

function devSeat() {
  const repair = prompt.includes('Fix the defect described by the intake ticket');
  return {
    files: repair ? scenario.fixFiles : scenario.devFiles,
    report: { summary: repair ? 'the ticketed defect is fixed' : 'the spec is implemented' },
  };
}

function triage() {
  const layers = [...prompt.matchAll(/^- layer (.+):$/gm)].map((m) => m[1].trim());
  // A first cycle has no prior findings and takes no field for them; a later
  // cycle lists the open ids and requires the field.
  const persisting = prompt.includes('Prior open findings') ? { persisting: [] } : {};
  if (layers.length === 0) return { report: { findings: [], ...persisting, summary: 'no red' } };
  return {
    report: {
      findings: [
        {
          class: 'code-defect',
          layers,
          summary: 'the implementation does not satisfy the frozen suite',
          evidence: `red layers: ${layers.join(', ')}`,
        },
      ],
      ...persisting,
      summary: `${layers.length} red layer(s) classed`,
    },
  };
}

function verifier() {
  const items = [...prompt.matchAll(/^- \[([^\]]+)\] \((confirm|resolution-check)\)/gm)];
  // A scenario about a red render needs its findings confirmed; every other
  // scenario reads a tree that holds what its records state.
  const confirm = scenario.confirmFindings === true ? 'confirmed' : 'refuted';
  return {
    report: {
      results: items.map(([, id, mode]) => ({
        id,
        verdict: mode === 'confirm' ? confirm : 'resolved',
        evidence: 'the record states what the tree does not hold',
      })),
      summary: `${items.length} item(s) verified`,
    },
  };
}

function waves() {
  return [...prompt.matchAll(/^Survivor wave (\d+):$/gm)].map((m) => Number(m[1]));
}

// -- plumbing ----------------------------------------------------------------

function valueOf(flag) {
  const at = argv.indexOf(flag);
  return at === -1 ? null : argv[at + 1];
}

function match(pattern) {
  return pattern.exec(prompt);
}

function reportPathFrom(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((line) =>
    line.includes('write your JSON report to this file, then stop:'),
  );
  if (at !== -1 && lines[at + 1]) return lines[at + 1].trim();
  return (
    /report to the same file, then stop: (.+)/.exec(text)?.[1]?.trim() ??
    /write your JSON report to this file before you stop: (.+)/.exec(text)?.[1]?.trim() ??
    null
  );
}

function emit(line) {
  process.stdout.write(JSON.stringify(line) + '\n');
}

/**
 * One record per invocation, in its own file: the Fury seats run in parallel,
 * and separate files need no append discipline between processes.
 */
function record() {
  const name = `${String(Date.now()).padStart(14, '0')}-${process.pid}-${seat ?? 'unknown'}.json`;
  writeFileSync(
    join(scenario.callDir, name),
    JSON.stringify({
      at: Date.now(),
      seat,
      // The whole identity, slot and all: N writers in one run are N dispatches
      // and a scenario counts them apart (ADR-0075).
      named,
      slot,
      model,
      argv,
      prompt,
      reportPath,
      cwd: process.cwd(),
      // The range the harness gave this seat. A gate command reads it, and a
      // scenario about the base the in-run gate judges reads it here.
      baseSha: process.env.OLYMPUS_BASE_SHA ?? null,
      // Whether the machine's credential reached this seat. The strip follows
      // suite execution, so the answer differs per seat by design.
      secret: process.env[scenario.secretName] !== undefined,
    }) + '\n',
  );
}
