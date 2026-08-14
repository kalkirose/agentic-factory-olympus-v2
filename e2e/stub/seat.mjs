// The stub seat CLI. The instance config's `claudeCommand` names it, so the
// daemon assembles the real argv, spawns it through the real supervisor, and
// reads the real stream-json contract back. What the stub replaces is the
// model, and nothing else: it identifies its seat from the shared core block
// of the prompt it was handed, produces the artifacts that seat owes, writes
// its JSON report where the prompt says, and exits 0.
//
// The scenario file (OLYMPUS_E2E_SCENARIO) holds the artifact texts, so one
// stub drives every lane.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? '';
const model = valueOf('--model') ?? '(none)';
const scenario = JSON.parse(readFileSync(process.env.OLYMPUS_E2E_SCENARIO, 'utf8'));

const seat = match(/You are the (\S+) seat in an Olympus run/)?.[1] ?? null;
const reportPath = reportPathFrom(prompt);

record();

if (!seat || !reportPath) {
  console.error(`stub seat: no seat or no report path in the prompt (seat: ${seat})`);
  process.exit(3);
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
  if (name === 'spec-gate') {
    return {
      report: {
        findings: [],
        intentConflict: { conflict: false, detail: '' },
        summary: 'the spec is grounded, in scope and encodable',
      },
    };
  }
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
  if (name === 'reconcile-judge') {
    return { report: { owed: false, records: [], reason: 'no decision-record tree in this fixture' } };
  }
  throw new Error(`no fixture behaviour for the ${name} seat`);
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
  return {
    files: { [path]: scenario.spec },
    report: { outcome: 'spec-born', summary: 'the spec answers AC-1' },
  };
}

function suiteSeat() {
  const files = scenario.suiteFiles ?? {};
  const report = {
    suiteFiles: Object.keys(files),
    reds: scenario.suiteReds ?? [],
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
  if (layers.length === 0) return { report: { findings: [], persisting: [], summary: 'no red' } };
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
      persisting: [],
      summary: `${layers.length} red layer(s) classed`,
    },
  };
}

function verifier() {
  const items = [...prompt.matchAll(/^- \[([^\]]+)\] \((confirm|resolution-check)\)/gm)];
  return {
    report: {
      results: items.map(([, id, mode]) => ({
        id,
        verdict: mode === 'confirm' ? 'refuted' : 'resolved',
        evidence: 'the code does not show the finding',
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
      model,
      argv,
      prompt,
      reportPath,
      cwd: process.cwd(),
      // Whether the machine's credential reached this seat. The strip follows
      // suite execution, so the answer differs per seat by design.
      secret: process.env[scenario.secretName] !== undefined,
    }) + '\n',
  );
}
