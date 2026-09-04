// The answer-forms contract (ADR-0029): every park states what it will take
// back, in its own record and in every refusal, and every park of a run takes
// `abandon`. The structural tests hold the declaration at the park sites; the
// engine tests walk every type in the catalog through park, refusal, and the
// abandon route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { RunEngine } from '../src/engine/engine.mjs';
import { Daemon } from '../src/daemon/daemon.mjs';
import {
  homePaths,
  scaffoldHome,
  runLedgerPath,
  archivedRunLedgerPath,
} from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { PARK_TYPES } from '../src/ledger/registry.mjs';
import {
  acceptedForms,
  checkAnswer,
  formsLine,
  instanceParkForms,
  runParkForms,
} from '../src/ledger/parks.mjs';
import {
  GATE_FORMS,
  HARNESS_GATE_FORMS,
  WORLD_GATES,
  parkDirective,
  withAbandonGuard,
  worldGate,
} from '../src/lanes/shared.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

// -- the descriptor ----------------------------------------------------------

test('a run park declares its own options plus the abandon it always owes', () => {
  assert.deepEqual(runParkForms({ options: ['retry'] }), { options: ['retry', 'abandon'] });
  assert.deepEqual(runParkForms({ options: ['round'], text: 'a note' }), {
    options: ['round', 'abandon'],
    text: 'a note',
  });
  // A site that names abandon itself gets it once.
  assert.deepEqual(runParkForms({ options: ['retry', 'abandon'] }), {
    options: ['retry', 'abandon'],
  });
  // A text-only park still takes the abandon.
  assert.deepEqual(runParkForms({ text: 'the decisions' }), {
    options: ['abandon'],
    text: 'the decisions',
  });
});

test('an instance park declares no abandon: it has no run to close', () => {
  assert.deepEqual(instanceParkForms({ text: 'what you did about the card' }), {
    text: 'what you did about the card',
  });
});

test('a park recorded before the declaration derives its forms', () => {
  // And it requires the text for no option, which is what those parks took.
  assert.deepEqual(acceptedForms({ event: 'park', options: ['round'] }), {
    options: ['round', 'abandon'],
    text: 'your answer',
    reasoned: [],
  });
  assert.deepEqual(acceptedForms({ event: 'park' }), {
    options: ['abandon'],
    text: 'your answer',
    reasoned: [],
  });
});

test('the forms line names every way in, and a refusal quotes it', () => {
  const record = { answers: runParkForms({ options: ['retry'], text: 'a note on the repair' }) };
  assert.equal(formsLine(record), '--option retry|abandon or --text "<a note on the repair>"');
  assert.throws(
    () => checkAnswer(record, { option: 'proceed' }),
    /option not offered by the escalation record: proceed — this park accepts --option retry\|abandon or --text "<a note on the repair>"/,
  );
  assert.throws(() => checkAnswer(record, {}), /an answer is required — this park accepts --option/);
  checkAnswer(record, { option: 'abandon' });
  checkAnswer(record, { answer: 'restarted the runner' });

  const optionsOnly = { answers: runParkForms({ options: ['round'] }) };
  assert.throws(
    () => checkAnswer(optionsOnly, { answer: 'go on' }),
    /this park takes no answer text — it accepts --option round\|abandon/,
  );

  const textOnly = { answers: runParkForms({ text: 'the decisions' }) };
  checkAnswer(textOnly, { answer: 'ship both' });
  assert.throws(() => checkAnswer(textOnly, { option: 'retry' }), /not offered/);
});

// -- the park sites ----------------------------------------------------------

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith('.mjs')) files.push(full);
  }
  return files;
}

/** Every `parkDirective` call of one source file, as type → declaration text. */
function parkSites(source) {
  const found = [];
  const opener = /parkDirective\(\s*'([\w-]+)'\s*,\s*\{/g;
  let match;
  while ((match = opener.exec(source))) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    found.push({ type: match[1], body: source.slice(match.index + match[0].length, i - 1) });
  }
  return found;
}

test('every park site declares the forms it accepts', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const declared = new Set();
  for (const file of sourceFiles(src)) {
    for (const site of parkSites(readFileSync(file, 'utf8'))) {
      assert.ok(
        /(^|[\s{,])(options|text):/.test(site.body) ||
          /\.\.\.\w*GATE_FORMS/.test(site.body) ||
          /\.\.\.worldGate\(/.test(site.body),
        `the ${site.type} park in ${file} declares neither an option nor a text slot`,
      );
      declared.add(site.type);
    }
  }
  // The recovery types come from the `recover` helper, which declares for all
  // three of them; every other type in the catalog is declared at its site.
  const fromRecover = new Set(['seat-failure', 'stage-blocked', 'command-error']);
  // The two card parks are appended to the instance ledger rather than routed
  // through a directive, and both declare their forms at their own site.
  const fromSweep = new Set(['card-invalidated', 'card-decision']);
  assert.deepEqual(
    [...PARK_TYPES].filter((type) => !declared.has(type) && !fromRecover.has(type) && !fromSweep.has(type)),
    [],
  );
});

test('a provisioning gate over a harness defect offers the ack and no retry', () => {
  // A retry re-runs the same harness on the same tree, so the gate that names
  // a harness defect does not offer one: the ack leads, and the abandon every
  // park owes closes (ADR-0068). The substrate gate keeps its retry, because
  // there the answer is a repair somebody can actually make.
  assert.deepEqual(runParkForms(HARNESS_GATE_FORMS), {
    options: ['ack', 'abandon'],
    text: 'a note on the defect and what is being done about it',
  });
  assert.deepEqual(runParkForms(GATE_FORMS), {
    options: ['retry', 'abandon'],
    text: 'a note on what you repaired',
  });
  // Neither form is a world gate: an ack here records a standing finding
  // acknowledgment, which is a different instrument (ADR-0032, ADR-0062).
  assert.equal(HARNESS_GATE_FORMS.gate, undefined);
  assert.equal(HARNESS_GATE_FORMS.reasoned, undefined);
});

// -- the world-gate scope (ADR-0062) -----------------------------------------

test('the ack is offered by three gates, and the set says which', () => {
  // The scope rule, held where it can be broken: a gate gains the ack by
  // being added to WORLD_GATES and by spreading worldGate at its own park, and
  // this fails on either half alone. A fourth world gate is a decision about
  // who may walk past what, and it is taken here or it is not taken.
  assert.deepEqual([...WORLD_GATES].sort(), [
    'credential-probe',
    'credential-surface',
    'substrate-probe',
  ]);
  const src = join(import.meta.dirname, '..', 'src');
  const byFile = {};
  for (const file of sourceFiles(src)) {
    const sites = parkSites(readFileSync(file, 'utf8')).filter((site) =>
      /\.\.\.worldGate\(/.test(site.body),
    );
    if (sites.length > 0) byFile[basename(file)] = sites.length;
  }
  assert.deepEqual(byFile, { 'probes.mjs': 2, 'substrate.mjs': 1 });
  // Every one of those sites is a provisioning gate; nothing else takes an ack.
  for (const file of sourceFiles(src)) {
    for (const site of parkSites(readFileSync(file, 'utf8'))) {
      if (/\.\.\.worldGate\(/.test(site.body)) assert.equal(site.type, 'provisioning-gate');
    }
  }
});

test('a world gate declares the ack, the reason it owes, and the check it names', () => {
  const forms = worldGate('credential-surface');
  assert.deepEqual(forms.options, ['retry', 'ack']);
  assert.deepEqual(forms.reasoned, ['ack']);
  assert.equal(forms.gate, 'credential-surface');
  // A subject rides the key, so one credential's probe is not another's.
  assert.equal(worldGate('credential-probe:payments').gate, 'credential-probe:payments');
  // A gate outside the set cannot reach the option from a call site.
  assert.throws(() => worldGate('ship-preflight'), /unknown world gate: ship-preflight/);
});

test('a reasoned option is refused without its reason, and the refusal says so', () => {
  const record = { answers: runParkForms(worldGate('substrate-probe')) };
  assert.deepEqual(record.answers.options, ['retry', 'ack', 'abandon']);
  assert.deepEqual(record.answers.reasoned, ['ack']);
  assert.match(formsLine(record), /--option ack takes --text as well$/);
  assert.throws(
    () => checkAnswer(record, { option: 'ack' }),
    /--option ack takes the reason for it/,
  );
  assert.throws(() => checkAnswer(record, { option: 'ack', answer: '  ' }), /takes the reason/);
  checkAnswer(record, { option: 'ack', answer: 'the stack publishes on one family' });
  // Every other answer the gate takes is unchanged by the requirement.
  checkAnswer(record, { option: 'retry' });
  checkAnswer(record, { option: 'abandon' });
  checkAnswer(record, { answer: 'restarted the engine' });
});

test('a park declaring a reasoned option it does not offer declares nothing', () => {
  // A rule about an answer nobody can give would refuse an answer for a reason
  // no reader could find on the record.
  assert.deepEqual(runParkForms({ options: ['retry'], text: 'a note', reasoned: ['ack'] }), {
    options: ['retry', 'abandon'],
    text: 'a note',
  });
});

// -- the engine --------------------------------------------------------------

function setup(t) {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const engine = new RunEngine(paths, { getSlotCap: () => 3 });
  t.after(async () => {
    await engine.stop();
    removeDir(home);
  });
  return { paths, engine };
}

// One stage that parks on entry, guarded exactly as every assembled lane is.
function parkingLane(directive) {
  return {
    stages: ['only'],
    handlers: withAbandonGuard({ only: () => directive }),
  };
}

async function parkAnd(t, { paths, engine }, runId, directive, answer) {
  engine.registerLane(runId, parkingLane(directive));
  engine.launch({ runId, project: 'proj', lane: runId });
  const park = await waitFor(
    () => readEvents(runLedgerPath(paths, runId)).find((e) => e.event === 'park'),
    { label: `park in ${runId}` },
  );
  engine.answer({ runId, actor: 'operator', ...answer });
  const events = await waitFor(
    () => {
      const lines = readEvents(archivedRunLedgerPath(paths, runId));
      return lines.some((e) => e.event === 'run-closed') ? lines : null;
    },
    { label: `close of ${runId}` },
  );
  return { park, closed: events.find((e) => e.event === 'run-closed') };
}

test('every park type in the catalog offers abandon, and abandon closes the run', async (t) => {
  const engine = setup(t);
  let n = 0;
  for (const type of PARK_TYPES) {
    const runId = `r${++n}`;
    const { park, closed } = await parkAnd(
      t,
      engine,
      runId,
      parkDirective(type, { question: `A ${type} question.`, text: 'what you decided' }),
      { option: 'abandon' },
    );
    assert.ok(park.answers.options.includes('abandon'), `${type} offers no abandon`);
    assert.equal(park.answers.text, 'what you decided');
    // The abandon route, on the condition the park recorded: a park that
    // carries no reason of its own closes on the type that named it.
    assert.equal(closed.state, 'failed', type);
    assert.equal(closed.reason, type);
    assert.equal(closed.abandoned, park.seq);
  }
});

test('a park that declares an option keeps taking it, and its detail rides the abandon', async (t) => {
  const engine = setup(t);
  const { park, closed } = await parkAnd(
    t,
    engine,
    'r-detail',
    {
      park: {
        type: 'seat-failure',
        question: 'The suite seat failed.',
        options: ['retry'],
        reason: 'seat-failure',
        detail: { seat: 'suite', cause: 'report-invalid' },
      },
    },
    { option: 'abandon' },
  );
  assert.deepEqual(park.answers, { options: ['retry', 'abandon'] });
  assert.equal(closed.reason, 'seat-failure');
  assert.equal(closed.seat, 'suite');
  assert.equal(closed.cause, 'report-invalid');
});

test('a park that declares no answer form at all is a defect, not an escalation', async (t) => {
  const { paths, engine } = setup(t);
  engine.registerLane('mute', {
    stages: ['only'],
    handlers: { only: () => ({ park: { type: 'open-decisions', question: 'Well?' } }) },
  });
  engine.launch({ runId: 'r-mute', project: 'proj', lane: 'mute' });
  const violation = await waitFor(
    () => readEvents(runLedgerPath(paths, 'r-mute')).find((e) => e.event === 'liveness-violation'),
    { label: 'violation' },
  );
  assert.match(violation.detail, /declares no answer form/);
});

// -- the instance park -------------------------------------------------------

test('an instance park validates against its record and names its own forms', async (t) => {
  const home = tempDir();
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  const park = daemon.ledger.append('park', {
    actor: 'daemon',
    type: 'card-invalidated',
    card: 'stories/beta.md',
    runId: 'r0',
    question: 'The ship of alpha-1 invalidated stories/beta.md.',
    answers: instanceParkForms({ text: 'what you did about the card' }),
    gist: 'card-invalidated: stories/beta.md',
  });
  // No run stands behind it, so it offers no abandon — and it says so.
  assert.throws(
    () => daemon.answerInstancePark({ actor: 'operator', seq: park.seq, option: 'abandon' }),
    /not offered by the escalation record: abandon — this park accepts --text "<what you did about the card>"/,
  );
  daemon.answerInstancePark({ actor: 'operator', seq: park.seq, answer: 'card rewritten' });
  const answer = readEvents(homePaths(home).instanceLedger).find((e) => e.event === 'answer');
  assert.equal(answer.parkSeq, park.seq);
  assert.equal(answer.card, 'stories/beta.md');
});
