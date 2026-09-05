// The stub seat CLI for the card-classification scenario. It stands in for the
// model and nothing else: the daemon assembles the real argv, spawns it through
// the real supervisor, and reads the real stream-json contract back.
//
// This scenario runs two stories through one home, so every behavior is keyed
// on the story a run belongs to. The run is the id in the report path the
// prompt names. The story is learned once, from the card path in the first role
// block that carries one, and written down beside the call records: the seats
// after that one are handed the spec and the diff, never the card.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? '';
const model = valueOf('--model') ?? '(none)';
const scenario = JSON.parse(readFileSync(process.env.OLYMPUS_E2E_SCENARIO, 'utf8'));

const seat = match(/You are the (\S+) seat in an Olympus run/)?.[1] ?? null;
const reportPath = reportPathFrom(prompt);
const runId = /[\\/]runs[\\/]([^\\/]+)[\\/]/.exec(reportPath ?? '')?.[1] ?? 'unknown';
const story = rememberStory();

record();

if (!seat || !reportPath) {
  console.error(`stub seat: no seat or no report path in the prompt (seat: ${seat})`);
  process.exit(3);
}

let work;
try {
  work = behavior(seat);
} catch (error) {
  console.error(`stub seat: ${error.message}`);
  process.exit(4);
}

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

function behavior(name) {
  if (name === 'spec-birth') return specBirth();
  if (name === 'spec-gate') return specGate();
  if (name === 'suite') return suiteSeat();
  if (name === 'adversary') {
    return {
      files: plan().adversaryFiles,
      report: {
        approach: 'an implementation that answers the shape and not the value',
        wrongness: 'the module answers the wrong number',
      },
    };
  }
  if (name === 'dev' || name === 'repair-dev') {
    return { files: plan().devFiles, report: { summary: 'the spec is implemented' } };
  }
  if (name === 'verdict-triage') return triage();
  if (name === 'fury-verifier') return verifier();
  if (name.startsWith('fury-') || name === 'generalist-review') {
    return { report: { findings: [], summary: 'the diff answers the spec' } };
  }
  if (name === 'card-sweep') {
    return plan().sweep ?? { report: emptySweep() };
  }
  if (name === 'reconcile-judge') {
    return { report: { owed: false, records: [], reason: 'no decision-record tree in this fixture' } };
  }
  throw new Error(`no fixture behavior for the ${name} seat`);
}

function emptySweep() {
  return {
    updatedCards: [],
    invalidated: [],
    foreseen: [],
    decisions: [],
    summary: 'every card still stands',
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
      files: { [path]: plan().specAmendment ?? plan().spec },
      report: { amendedSections: ['AC-1'], summary: 'amended' },
    };
  }
  const draft = plan().specFirstDraft && !prompt.includes('Correction brief');
  return {
    files: { [path]: draft ? plan().specFirstDraft : plan().spec },
    report: { outcome: 'spec-born', summary: 'the spec answers AC-1' },
  };
}

/**
 * The gate reports the collision this story's card was written to settle, once.
 * The round after the amendment reads the amended spec and agrees with it, so
 * the gate converges exactly as it does behind a human ruling.
 */
function specGate() {
  const conflict = plan().gateConflict;
  const round = Number(/spec-gate-(\d+)/.exec(basename(reportPath))?.[1] ?? '1');
  if (conflict && round === 1) {
    return {
      report: {
        findings: [],
        intentConflict: { conflict: true, ...conflict },
        summary: 'a frozen-surface collision the card settles',
      },
    };
  }
  return {
    report: {
      findings: [],
      intentConflict: { conflict: false, detail: '' },
      summary: 'the spec is grounded, in scope and encodable',
    },
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
  const files = plan().suiteFiles ?? {};
  const reds = plan().suiteReds ?? [];
  const report = {
    suiteFiles: Object.keys(files),
    reds,
    ...surfaceMap(reds),
    summary: 'the suite asserts the criterion',
  };
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

/** The scenario block of the story this run belongs to. */
function plan() {
  const found = scenario.stories?.[story];
  if (!found) throw new Error(`no scenario block for the story of run ${runId} (${story})`);
  return found;
}

/**
 * The story key of this run. A role block that names the card teaches it and
 * writes it down; every later seat of the same run reads what was written.
 */
function rememberStory() {
  // Its own directory: the call directory holds one JSON record per invocation
  // and a reader of it parses every file there.
  const memo = join(scenario.memoDir, `story-${runId}.txt`);
  const named = /cards\/([a-z0-9-]+)\.md/.exec(prompt)?.[1] ?? null;
  if (named) {
    writeFileSync(memo, named);
    return named;
  }
  return existsSync(memo) ? readFileSync(memo, 'utf8').trim() : null;
}

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

/** One record per invocation, in its own file: the Fury seats run in parallel. */
function record() {
  const name = `${String(Date.now()).padStart(14, '0')}-${process.pid}-${seat ?? 'unknown'}.json`;
  writeFileSync(
    join(scenario.callDir, name),
    JSON.stringify({
      at: Date.now(),
      seat,
      story,
      runId,
      model,
      argv,
      prompt,
      reportPath,
      cwd: process.cwd(),
    }) + '\n',
  );
}
