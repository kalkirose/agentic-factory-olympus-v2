// The story-lane pre-freeze chain end to end on fixture repos: a story
// reaches a valid freeze record with kill count and dispositions; every
// escalation case parks correctly; deterministic defects take the one-
// corrective contract route; a tampered wave suite is restored before
// evaluation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, archivedRunLedgerPath, runLedgerPath } from '../src/daemon/home.mjs';
import { storyLane } from '../src/lanes/story.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import {
  tempDir,
  removeDir,
  waitFor,
  initOriginRepo,
  projectConfigJson,
  fakeComposeRunner,
  FIXTURE_ACCEPTANCE,
  FIXTURE_SPEC,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';

const DEFAULT_CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Provide f(x) that doubles x in src/feature.mjs.
${FIXTURE_ACCEPTANCE}`;

const WEAK_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('feature exists', async () => {
  const mod = await import('../src/feature.mjs');
  assert.equal(typeof mod.f, 'function');
});
`;

const STRONG_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('f doubles', async () => {
  const { f } = await import('../src/feature.mjs');
  assert.equal(f(2), 4);
});
`;

const BOGUS_KILL_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('bogus kill', async () => {
  const mod = await import('../src/feature.mjs');
  assert.equal(typeof mod.f, 'function');
});
`;

const TAUTOLOGY_TEST = `import test from 'node:test';
test('always green', () => {});
`;

const CONDITIONAL_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('f doubles when present', async () => {
  let mod;
  try { mod = await import('../src/feature.mjs'); } catch { return; }
  assert.equal(mod.f(2), 4);
});
`;

// A credential probe the fixture controls through one variable. It prints a
// value that must never be recorded anywhere, so the ledger and the park text
// can be searched for it.
const PROBE_VAR = 'OLYMPUS_FIXTURE_CREDENTIAL';
const PROBE_LEAK = 'sk_fixture_never_record_me';
const PROBE_SCRIPT =
  `console.log('probe sent ${PROBE_LEAK}');` +
  `process.exit(process.env.${PROBE_VAR} === 'live' ? 0 : 1);`;

/** Sets the fixture credential for one test and restores it afterwards. */
function heldCredential(t, value) {
  const previous = process.env[PROBE_VAR];
  const set = (next) => {
    if (next === undefined) delete process.env[PROBE_VAR];
    else process.env[PROBE_VAR] = next;
  };
  set(value);
  t.after(() => set(previous));
  return set;
}

// -- fixture machinery -------------------------------------------------------

function specPathFrom(prompt) {
  return /absolute path: (.+)$/m.exec(prompt)[1].trim();
}

/** The fixture spec with its AC-1 section rewritten — one amendment's work. */
function amendedSpec(n) {
  return FIXTURE_SPEC.replace(
    'The suite asserts it on one number.',
    `The suite asserts it on one number. Amendment ${n} grounds it in src/base.mjs.`,
  );
}

/**
 * A spec-birth behavior that writes the spec at birth and rewrites the AC-1
 * section on every amendment, so the gate's computed scope is never empty.
 */
function amendingBirth() {
  let amendments = 0;
  return ({ prompt }) =>
    prompt.includes('Amend the born spec')
      ? {
          files: { [specPathFrom(prompt)]: amendedSpec(++amendments) },
          report: { amendedSections: ['AC-1'], summary: 'amended' },
        }
      : {
          files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
          report: { outcome: 'spec-born', summary: 'born' },
        };
}

/** A gate behavior that reports a blocking count per round, plus one note. */
function gateFindings(counts) {
  return ({ label }) => {
    const round = Number(/-(\d+)$/.exec(label)[1]);
    const blocking = counts[round - 1] ?? 0;
    return {
      report: {
        findings: [
          ...Array.from({ length: blocking }, (_, i) => ({
            section: 'AC-1',
            finding: `ungrounded claim ${i + 1}`,
            evidence: 'src/base.mjs',
          })),
          {
            section: 'AC-1',
            finding: 'two helpers, not three',
            evidence: 'src/base.mjs',
            severity: 'note',
          },
        ],
        summary: `${blocking} blocking`,
      },
    };
  };
}

function fixtureParse(line) {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    return { cost: parsed.cost, note: parsed.note, meta: parsed.meta };
  } catch {
    return null;
  }
}

// A fixture seat child: writes files (relative paths land in the seat's cwd),
// writes the report, exits. Behaviors dispatch per seat on label and prompt.
// envCapture writes the named env vars to a file — the seat-env probe.
function seatScript({ reportPath, model, report, files = {}, exitCode = 0, envCapture }) {
  const stmts = [
    "const fs = require('fs');",
    "const path = require('path');",
    `console.log(${JSON.stringify(JSON.stringify({ meta: { model } }))});`,
  ];
  for (const [file, content] of Object.entries(files)) {
    stmts.push(
      `fs.mkdirSync(path.dirname(${JSON.stringify(file)}), { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)});`,
    );
  }
  if (envCapture) {
    stmts.push(
      `fs.writeFileSync(${JSON.stringify(envCapture.path)}, JSON.stringify(` +
        `Object.fromEntries(${JSON.stringify(envCapture.keys)}.map((k) => [k, process.env[k]]))));`,
    );
  }
  if (report !== undefined) {
    stmts.push(
      `fs.mkdirSync(path.dirname(${JSON.stringify(reportPath)}), { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});`,
    );
  }
  stmts.push(`process.exit(${exitCode});`);
  return stmts.join('\n');
}

function seatFixture(seats) {
  const calls = [];
  const commandFor = (opts) => {
    const seat = /You are the (\S+) seat/.exec(opts.prompt)[1];
    const lines = opts.prompt.split('\n');
    const contract = lines.findIndex((l) => l.includes('write your JSON report to this file'));
    const reportPath = lines[contract + 1];
    const label = basename(reportPath, '.json');
    calls.push({ seat, label, attempt: opts.attempt, prompt: opts.prompt, denyTools: opts.denyTools });
    const behavior = seats[seat];
    if (!behavior) throw new Error(`no fixture behavior for seat ${seat}`);
    const out = behavior({ seat, label, prompt: opts.prompt, attempt: opts.attempt }) ?? {};
    return {
      cmd: process.execPath,
      args: ['-e', seatScript({ reportPath, model: opts.model, ...out })],
      parseLine: fixtureParse,
    };
  };
  return { commandFor, calls };
}

function storyFixture(t, { seats, card = DEFAULT_CARD, config, composeRunner, files = {} }) {
  const root = tempDir();
  // `config` may be a function of the fixture root, for absolute probe paths.
  const overrides = typeof config === 'function' ? config(root) : (config ?? {});
  const base = {
    repo: { testPaths: ['tests'] },
    commands: { suite: ['node', '--test', 'tests/*.test.mjs'] },
    lanes: { story: { suiteCommand: 'suite' } },
    stack: null,
  };
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson({
      ...base,
      ...overrides,
      commands: { ...base.commands, ...(overrides.commands ?? {}) },
      lanes: { ...base.lanes, ...(overrides.lanes ?? {}) },
    }),
    'stories/alpha.md': card,
    'src/base.mjs': 'export const base = 1;\n',
    ...files,
  });
  const paths = scaffoldHome(join(root, 'home'));
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { proj: { repoUrl: origin, slotCap: 2 } } }) + '\n',
  );
  const lanes = {
    story: storyLane({
      afterFreeze: {
        stages: ['done'],
        handlers: { done: async () => ({ close: { state: 'shipped' } }) },
      },
    }),
  };
  const daemon = new Daemon(join(root, 'home'), { lanes, composeRunner });
  const fixture = seatFixture(seats);
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  return {
    paths,
    daemon,
    calls: fixture.calls,
    async launch() {
      await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: fixture.commandFor });
      const { runId } = await daemon.launchRun({ project: 'proj', lane: 'story', card: 'stories/alpha.md' });
      return runId;
    },
  };
}

async function waitClosed(paths, runId) {
  try {
    await waitFor(() => existsSync(archivedRunLedgerPath(paths, runId)), {
      label: 'run archived',
      attempts: 400,
      intervalMs: 100,
    });
  } catch (error) {
    const live = runLedgerPath(paths, runId);
    const tail = existsSync(live)
      ? readEvents(live)
          .slice(-10)
          .map((e) => `${e.seq} ${e.event} ${e.stage ?? e.phase ?? ''} ${e.result ?? e.reason ?? ''}`)
      : ['no live ledger'];
    error.message += `\nledger tail:\n${tail.join('\n')}`;
    throw error;
  }
  return readEvents(archivedRunLedgerPath(paths, runId));
}

function waitParked(paths, runId, type, nth = 1) {
  return waitFor(
    () => {
      const parks = readEvents(runLedgerPath(paths, runId)).filter(
        (e) => e.event === 'park' && e.type === type,
      );
      return parks.length >= nth ? parks[nth - 1] : undefined;
    },
    { label: `park ${type} #${nth}`, attempts: 400, intervalMs: 100 },
  );
}

// -- scenarios ---------------------------------------------------------------

test('a fixture story reaches a valid freeze record with kills and dispositions', async (t) => {
  const seats = {
    'spec-birth': ({ prompt }) => ({
      files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
      report: { outcome: 'spec-born', summary: 'born' },
    }),
    'spec-gate': () => ({ report: { findings: [], summary: 'clean' } }),
    suite: ({ prompt }) => {
      if (prompt.includes('left survivors')) {
        return {
          files: { 'tests/feature-kill.test.mjs': STRONG_TEST },
          report: {
            suiteFiles: ['tests/feature.test.mjs', 'tests/feature-kill.test.mjs'],
            reds: [
              { test: 'feature exists', class: 'feature-absence' },
              { test: 'f doubles', class: 'feature-absence' },
            ],
            summary: 'amended',
            killingTests: [{ wave: 1, test: 'f doubles' }],
            dispositions: [{ wave: 3, disposition: 'spec-indifferent', reason: 'slope unconstrained' }],
          },
        };
      }
      return {
        files: { 'tests/feature.test.mjs': WEAK_TEST },
        report: {
          suiteFiles: ['tests/feature.test.mjs'],
          reds: [{ test: 'feature exists', class: 'feature-absence' }],
          summary: 'authored',
        },
      };
    },
    adversary: ({ label }) => {
      const wave = Number(/-w(\d+)$/.exec(label)[1]);
      if (wave === 1) {
        return {
          files: { 'src/feature.mjs': 'export const f = () => 0;\n' },
          report: { approach: 'stub', wrongness: 'f returns 0' },
        };
      }
      if (wave === 2) {
        // Tamper attempt: replace the suite with a tautology. The restore
        // before evaluation voids it and the absent feature kills the wave.
        return {
          files: { 'tests/feature.test.mjs': TAUTOLOGY_TEST },
          report: { approach: 'tamper', wrongness: 'suite replaced, no implementation' },
        };
      }
      return {
        files: { 'src/feature.mjs': 'export const f = (x) => x;\n' },
        report: { approach: 'identity', wrongness: 'f returns x' },
      };
    },
  };
  const policy = '# Constitution\n\nA deliverable exists only where the card names it.\n';
  const fx = storyFixture(t, { seats, files: { '.olympus/constitution.md': policy } });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'park'));
  // Wave verdicts: the tampered wave dies on the restored suite.
  const initial = events.filter((e) => e.event === 'adversary-wave' && e.phase === 'initial');
  assert.deepEqual(
    initial.map((e) => [e.wave, e.result]),
    [
      [1, 'survived'],
      [2, 'killed'],
      [3, 'survived'],
    ],
  );
  const rerun = events.find((e) => e.event === 'adversary-wave' && e.phase === 're-run');
  assert.equal(rerun.wave, 1);
  assert.equal(rerun.result, 'killed');
  const disposition = events.find((e) => e.event === 'survivor-disposition');
  assert.equal(disposition.wave, 3);
  assert.equal(disposition.disposition, 'spec-indifferent');
  // Red state and freeze.
  assert.equal(events.find((e) => e.event === 'red-state-check').result, 'red');
  const freeze = events.find((e) => e.event === 'freeze');
  assert.equal(freeze.killCount, 1);
  assert.equal(freeze.amendmentKills, 1);
  assert.equal(freeze.dispositions, 1);
  // The freeze record and the born spec archive with the run.
  const record = JSON.parse(readFileSync(join(fx.paths.archivedRuns, runId, 'freeze.json'), 'utf8'));
  assert.equal(record.storyKey, 'alpha-1');
  assert.equal(record.killCount, 1);
  assert.equal(record.amendmentKills, 1);
  assert.deepEqual(record.dispositions, [
    { round: 1, wave: 3, disposition: 'spec-indifferent', reason: 'slope unconstrained' },
  ]);
  assert.deepEqual(record.suiteFiles.sort(), ['tests/feature-kill.test.mjs', 'tests/feature.test.mjs']);
  assert.equal(record.waves.length, 3);
  assert.equal(record.redState.result, 'red');
  assert.ok(record.redState.reds.every((r) => r.class === 'feature-absence'));
  assert.ok(existsSync(join(fx.paths.archivedRuns, runId, 'spec.md')));
  // The adversary seats carried the test-edit deny rules.
  const adversaryCalls = fx.calls.filter((c) => c.seat === 'adversary');
  assert.equal(adversaryCalls.length, 3);
  assert.ok(adversaryCalls.every((c) => c.denyTools.includes('Edit(tests/**)')));
  // The constitution reached the pre-freeze seats; the spec gate judges, so
  // it also carries the authority order. The adversary carries neither: its
  // brief is to write a wrong implementation on purpose.
  const line = 'A deliverable exists only where the card names it.';
  for (const seat of ['spec-birth', 'spec-gate', 'suite']) {
    assert.ok(
      fx.calls.filter((c) => c.seat === seat).every((c) => c.prompt.includes(line)),
      seat,
    );
  }
  assert.match(fx.calls.find((c) => c.seat === 'spec-gate').prompt, /Authority order, highest first/);
  assert.ok(!fx.calls.find((c) => c.seat === 'spec-birth').prompt.includes('Authority order'));
  assert.ok(adversaryCalls.every((c) => !c.prompt.includes(line)));
  assert.ok(adversaryCalls.every((c) => !c.prompt.includes('constitution')));
  // The touched-paths template names the one entry class a spec author reads
  // past: the visual baselines a rendered surface re-renders. Undeclared, they
  // are frozen, and the story pays a verdict round-trip to change them.
  const birthPrompt = fx.calls.find((c) => c.seat === 'spec-birth').prompt;
  assert.match(birthPrompt, /re-renders that surface's existing visual baseline files/);
  assert.match(birthPrompt, /name each of those files in the block as a dev-owned entry/);
  assert.match(birthPrompt, /A baseline the block does not name is frozen/);
  assert.match(birthPrompt, /costs a verdict round-trip/);
});

test('open decisions park readiness; the spec gate caps at two rounds', async (t) => {
  const card = `---
key: alpha-1
title: Alpha
---

## Open decisions

- Pick the rounding mode
${FIXTURE_ACCEPTANCE}`;
  // The blocking set shrinks 2 → 1, so the gate converges and spends its cap.
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([2, 1]) };
  const fx = storyFixture(t, { seats, card });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'open-decisions');
  assert.ok(park.question.includes('Pick the rounding mode'));
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'round half up' });
  // The cap parks for the owner; abandoning there closes the run.
  const exhausted = await waitParked(fx.paths, runId, 'spec-gate-exhausted');
  assert.ok(exhausted.question.includes('spent 2 rounds'));
  // The park counts the two channels apart: only the blocking count held it.
  assert.ok(exhausted.question.includes('blocking findings: 1; notes: 1'));
  assert.deepEqual(exhausted.options, ['round', 'abandon']);
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const events = await waitClosed(fx.paths, runId);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'spec-gate-exhausted');
  // The birth seat received the resolved decision.
  const birth = fx.calls.find((c) => c.label === 'spec-birth-1');
  assert.ok(birth.prompt.includes('Decisions already made'));
  assert.ok(birth.prompt.includes('round half up'));
  // The spec seat writes the test plan, so it is told what runs the suite and
  // where a test file may live.
  assert.ok(birth.prompt.includes('The acceptance suite runs with: node --test tests/*.test.mjs'));
  assert.ok(birth.prompt.includes('Suite files live only under: tests'));
  // Two counted rounds, the second scoped to the amended sections.
  const rounds = events.filter((e) => e.event === 'spec-gate-round');
  assert.deepEqual(
    rounds.map((e) => [e.round, e.verdict]),
    [
      [1, 'findings'],
      [2, 'findings'],
    ],
  );
  const amend = fx.calls.find((c) => c.label === 'spec-birth-2');
  assert.ok(amend.prompt.includes('ungrounded claim'));
  // The re-check is scoped by the diff of the two spec versions, not by the
  // amendment's own account of it, and it carries the previous round's
  // findings verbatim so each one is answered closed or still open.
  const recheck = fx.calls.find((c) => c.label === 'spec-gate-2');
  assert.ok(recheck.prompt.includes('Sections amended since the previous round: AC-1'));
  assert.ok(recheck.prompt.includes('This is a re-check, not a fresh review'));
  assert.ok(recheck.prompt.includes('closed or still open'));
  assert.ok(recheck.prompt.includes('The findings of the previous round, verbatim:'));
  assert.ok(recheck.prompt.includes('- [AC-1] (blocking) ungrounded claim 1'));
  assert.ok(recheck.prompt.includes('- [AC-1] (note) two helpers, not three'));
  // A new defect outside the amended sections is a note; an authority
  // contradiction blocks wherever it is found.
  assert.ok(
    recheck.prompt.includes(
      'A new defect in a section that was NOT amended is reported with severity "note", never "blocking"',
    ),
  );
  assert.ok(recheck.prompt.includes('blocking wherever you find it, amended or not'));
  assert.ok(!recheck.prompt.includes('Review the whole spec'));
  // The spec each round judged is kept beside the run's spec, so the scope is
  // recomputed after a restart rather than remembered.
  assert.ok(existsSync(join(fx.paths.archivedRuns, runId, 'spec-round-1.md')));
  assert.ok(existsSync(join(fx.paths.archivedRuns, runId, 'spec-round-2.md')));
});

test('a stale credential parks readiness before the first seat spawns', async (t) => {
  const setCredential = heldCredential(t, 'stale');
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 3]) };
  const fx = storyFixture(t, {
    seats,
    config: {
      commands: { probe: [process.execPath, '-e', PROBE_SCRIPT] },
      credentials: [{ name: 'payments', env: PROBE_VAR, probe: 'probe' }],
    },
  });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  assert.match(park.question, /payments credential probe answered no at the launch gate/);
  assert.ok(park.question.includes(PROBE_VAR));
  // Nothing was spent past the gate.
  assert.equal(fx.calls.length, 0);
  const live = runLedgerPath(fx.paths, runId);
  const failed = readEvents(live).find((e) => e.event === 'credential-probe');
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'refused');
  assert.equal(failed.phase, 'launch');
  assert.equal(failed.credential, 'payments');
  assert.equal(failed.variable, PROBE_VAR);
  // The probe's own output reaches neither the ledger nor the human.
  assert.ok(!readFileSync(live, 'utf8').includes(PROBE_LEAK));
  assert.ok(!park.question.includes(PROBE_LEAK));

  setCredential('live');
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'key rotated' });
  // The answer re-probes rather than trusting it: the pass is stamped too.
  const stalled = await waitParked(fx.paths, runId, 'spec-gate-stalled');
  assert.ok(stalled.question.includes('not converging'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const events = await waitClosed(fx.paths, runId);
  assert.deepEqual(
    events.filter((e) => e.event === 'credential-probe').map((e) => [e.phase, e.ok]),
    [
      ['launch', false],
      ['launch', true],
    ],
  );
  assert.ok(fx.calls.some((c) => c.seat === 'spec-birth'));
});

test('an absent credential variable parks without running the probe', async (t) => {
  const setCredential = heldCredential(t, undefined);
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 3]) };
  const fx = storyFixture(t, {
    seats,
    config: {
      commands: { probe: [process.execPath, '-e', PROBE_SCRIPT] },
      credentials: [{ name: 'payments', env: PROBE_VAR, probe: 'probe' }],
    },
  });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  assert.match(park.question, /is not on this host/);
  const stamped = readEvents(runLedgerPath(fx.paths, runId)).find(
    (e) => e.event === 'credential-probe',
  );
  assert.equal(stamped.reason, 'absent');
  assert.equal(fx.calls.length, 0);
  setCredential('live');
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'variable set' });
  await waitParked(fx.paths, runId, 'spec-gate-stalled');
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  await waitClosed(fx.paths, runId);
});

test('the owner buys one more spec-gate round, and the next cap parks again', async (t) => {
  // 3 → 2 → 1: every round shrinks, so only the cap ever parks the run.
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 2, 1]) };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const first = await waitParked(fx.paths, runId, 'spec-gate-exhausted');
  assert.ok(first.question.includes('spent 2 rounds'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'round' });
  // The bought round runs, and the cap moves by exactly one.
  const second = await waitParked(fx.paths, runId, 'spec-gate-exhausted', 2);
  assert.ok(second.question.includes('spent 3 rounds'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').reason, 'spec-gate-exhausted');
  const rounds = events.filter((e) => e.event === 'spec-gate-round');
  assert.deepEqual(
    rounds.map((e) => [e.round, e.verdict]),
    [
      [1, 'findings'],
      [2, 'findings'],
      [3, 'findings'],
    ],
  );
  // The bought round is an amendment plus a re-check, like any other round.
  assert.ok(fx.calls.some((c) => c.label === 'spec-birth-3'));
  assert.ok(fx.calls.some((c) => c.label === 'spec-gate-3'));
  // A shrinking gate never meets the convergence park.
  assert.ok(!events.some((e) => e.event === 'park' && e.type === 'spec-gate-stalled'));
});

test('a shrinking blocking set runs to zero and passes the gate', async (t) => {
  // 3 → 1 → 0. The cap parks between rounds 2 and 3, the owner buys the round,
  // and the round it buys passes. Nothing stalls on the way.
  const seats = {
    'spec-birth': amendingBirth(),
    'spec-gate': gateFindings([3, 1, 0]),
    suite: () => ({
      files: { 'tests/feature.test.mjs': STRONG_TEST },
      report: {
        suiteFiles: ['tests/feature.test.mjs'],
        reds: [{ test: 'f doubles', class: 'feature-absence' }],
        summary: 'authored',
      },
    }),
    adversary: () => ({
      files: { 'src/feature.mjs': 'export const f = () => 0;\n' },
      report: { approach: 'stub', wrongness: 'f returns 0' },
    }),
  };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const capped = await waitParked(fx.paths, runId, 'spec-gate-exhausted');
  assert.ok(capped.question.includes('blocking findings: 1'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'round' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const rounds = events.filter((e) => e.event === 'spec-gate-round');
  assert.deepEqual(
    rounds.map((e) => [e.round, e.verdict, e.findings]),
    [
      [1, 'findings', 3],
      [2, 'findings', 1],
      [3, 'pass', 0],
    ],
  );
  assert.ok(!events.some((e) => e.event === 'park' && e.type === 'spec-gate-stalled'));
});

test('a blocking set that does not shrink parks at once, cap unspent', async (t) => {
  // 3 → 3. The cap allows two counted rounds and both ran, but the park that
  // stops the gate is the convergence one: the set never shrank.
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 3]) };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const stalled = await waitParked(fx.paths, runId, 'spec-gate-stalled');
  assert.ok(stalled.question.includes('not converging'));
  assert.ok(stalled.question.includes('3 blocking findings against 3 in round 1'));
  assert.deepEqual(stalled.options, ['round', 'abandon']);
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const events = await waitClosed(fx.paths, runId);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'spec-gate-stalled');
  // The convergence park is the only one raised: the cap was never reached.
  assert.deepEqual(
    events.filter((e) => e.event === 'park').map((e) => e.type),
    ['spec-gate-stalled'],
  );
  assert.equal(events.filter((e) => e.event === 'spec-gate-round').length, 2);
});

test('a growing blocking set parks before the cap, and one bought round runs', async (t) => {
  // 2 → 4 → 4: growth parks, the bought round runs, and the round it buys
  // grows again, so the gate parks a second time on the same condition.
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([2, 4, 4]) };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const first = await waitParked(fx.paths, runId, 'spec-gate-stalled');
  assert.ok(first.question.includes('4 blocking findings against 2 in round 1'));
  assert.ok(first.question.includes('rather than spend a counted round'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'round' });
  const second = await waitParked(fx.paths, runId, 'spec-gate-stalled', 2);
  assert.ok(second.question.includes('4 blocking findings against 4 in round 2'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').reason, 'spec-gate-stalled');
  // One answer bought exactly one amendment and one re-check.
  const rounds = events.filter((e) => e.event === 'spec-gate-round');
  assert.deepEqual(
    rounds.map((e) => e.round),
    [1, 2, 3],
  );
  assert.ok(fx.calls.some((c) => c.label === 'spec-gate-3'));
  assert.ok(!fx.calls.some((c) => c.label === 'spec-gate-4'));
});

test('blocking findings hold the spec; notes pass it and reach the suite seat', async (t) => {
  const seats = {
    'spec-birth': ({ prompt }) =>
      prompt.includes('Amend the born spec')
        ? { report: { amendedSections: ['Goal'], summary: 'amended' } }
        : {
            files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
            report: { outcome: 'spec-born', summary: 'born' },
          },
    'spec-gate': ({ label }) =>
      label === 'spec-gate-1'
        ? {
            report: {
              findings: [
                // No severity at all: a seat that never learned the field
                // cannot weaken the gate, so this one blocks.
                { section: 'Goal', finding: 'ungrounded claim', evidence: 'src/base.mjs' },
                {
                  section: 'Acceptance',
                  finding: 'criterion 3 is not assertable',
                  evidence: 'spec section 3',
                  severity: 'blocking',
                },
                {
                  section: 'Scope',
                  finding: 'the spec says three helpers; the tree carries two',
                  evidence: 'src/base.mjs',
                  severity: 'note',
                },
              ],
              summary: 'two defects and one count',
            },
          }
        : {
            report: {
              findings: [
                {
                  section: 'Scope',
                  finding: 'the pattern set has four members',
                  evidence: 'src/base.mjs',
                  severity: 'note',
                },
              ],
              summary: 'none blocking',
            },
          },
    suite: () => ({
      files: { 'tests/feature.test.mjs': STRONG_TEST },
      report: {
        suiteFiles: ['tests/feature.test.mjs'],
        reds: [{ test: 'f doubles', class: 'feature-absence' }],
        summary: 'authored; both counts asserted',
      },
    }),
    adversary: ({ label }) => {
      const wave = Number(/-w(\d+)$/.exec(label)[1]);
      if (wave === 1) {
        return {
          files: { 'src/feature.mjs': 'export const f = () => 0;\n' },
          report: { approach: 'stub', wrongness: 'f returns 0' },
        };
      }
      if (wave === 2) return { report: { approach: 'absent', wrongness: 'no implementation' } };
      return {
        files: { 'src/feature.mjs': 'export const f = (x) => x;\n' },
        report: { approach: 'identity', wrongness: 'f returns x' },
      };
    },
  };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'park'));
  // Round 1 blocks on two findings and counts the note apart; round 2 carries
  // a note only, so the gate passes the spec instead of spending the cap.
  const rounds = events.filter((e) => e.event === 'spec-gate-round');
  assert.deepEqual(
    rounds.map((e) => [e.round, e.verdict, e.findings, e.notes]),
    [
      [1, 'findings', 2, 1],
      [2, 'pass', 0, 1],
    ],
  );
  // The amendment brief carries the blocking findings and nothing else: a
  // note is never settled by editing the document.
  const amend = fx.calls.find((c) => c.label === 'spec-birth-2');
  assert.ok(amend.prompt.includes('ungrounded claim'));
  assert.ok(amend.prompt.includes('criterion 3 is not assertable'));
  assert.ok(!amend.prompt.includes('three helpers'));
  // Every note from every round reaches the suite seat, in order, as an
  // obligation to prove against running code.
  const suite = fx.calls.find((c) => c.label === 'suite-1');
  assert.ok(suite.prompt.includes('A note is not a waiver'));
  assert.ok(suite.prompt.includes('the spec says three helpers; the tree carries two'));
  assert.ok(suite.prompt.includes('the pattern set has four members'));
  assert.ok(
    suite.prompt.indexOf('three helpers') < suite.prompt.indexOf('four members'),
    'notes reached the suite seat out of order',
  );
  // The suite never sees a blocking finding: that one was fixed in the spec.
  assert.ok(!suite.prompt.includes('criterion 3 is not assertable'));
  const freeze = events.find((e) => e.event === 'freeze');
  assert.equal(freeze.killCount, 3);
});

test('a grounding conflict parks spec birth; a bad red class takes one corrective round', async (t) => {
  const seats = {
    'spec-birth': ({ label, prompt }) =>
      label === 'spec-birth-1'
        ? {
            report: {
              outcome: 'grounding-conflict',
              summary: 'conflict',
              conflict: 'The card assumes a module that does not exist.',
            },
          }
        : {
            files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
            report: { outcome: 'spec-born', summary: 'born' },
          },
    'spec-gate': () => ({ report: { findings: [], summary: 'clean' } }),
    suite: ({ label }) =>
      label === 'suite-1'
        ? {
            files: { 'tests/feature.test.mjs': STRONG_TEST },
            report: {
              suiteFiles: ['tests/feature.test.mjs'],
              reds: [{ test: 'f doubles', class: 'fixture-defect' }],
              summary: 'authored',
            },
          }
        : {
            report: {
              suiteFiles: ['tests/feature.test.mjs'],
              reds: [{ test: 'f doubles', class: 'feature-absence' }],
              summary: 'corrected',
            },
          },
    adversary: ({ label }) => {
      const wave = Number(/-w(\d+)$/.exec(label)[1]);
      if (wave === 1) {
        return {
          files: { 'src/feature.mjs': 'export const f = () => 0;\n' },
          report: { approach: 'stub', wrongness: 'f returns 0' },
        };
      }
      if (wave === 2) return { report: { approach: 'absent', wrongness: 'no implementation' } };
      return {
        files: { 'src/feature.mjs': 'export const f = (x) => x;\n' },
        report: { approach: 'identity', wrongness: 'f returns x' },
      };
    },
  };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'grounding-conflict');
  assert.ok(park.question.includes('does not exist'));
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'The module lands with this story; spec it.' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The re-birth carried the answered escalation.
  const rebirth = fx.calls.find((c) => c.label === 'spec-birth-2');
  assert.ok(rebirth.prompt.includes('lands with this story'));
  // One corrective suite round on the wrong red class.
  const corrective = fx.calls.find((c) => c.label === 'suite-2');
  assert.ok(corrective.prompt.includes('Correction brief'));
  assert.ok(corrective.prompt.includes('fixture-defect'));
  // A strong suite kills all three waves; freeze needs no amendment.
  const freeze = events.find((e) => e.event === 'freeze');
  assert.equal(freeze.killCount, 3);
  assert.equal(freeze.amendmentKills, 0);
  assert.equal(freeze.dispositions, 0);
});

test('an intent conflict never burns a round; a seat crash parks, and abandon closes', async (t) => {
  const seats = {
    'spec-birth': ({ label, prompt }) =>
      prompt.includes('Amend the born spec')
        ? { report: { amendedSections: ['Scope'], summary: 'aligned' } }
        : {
            files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
            report: { outcome: 'spec-born', summary: 'born' },
          },
    'spec-gate': ({ label }) =>
      label === 'spec-gate-1'
        ? {
            report: {
              findings: [
                { section: 'Goal', finding: 'ungrounded claim', evidence: 'src/base.mjs' },
              ],
              summary: 'conflict',
              intentConflict: { conflict: true, detail: 'The spec drops the card constraint.' },
            },
          }
        : {
            report: {
              findings: [],
              summary: 'clean',
              // Prose that means "no conflict" must not park the run.
              intentConflict: { conflict: false, detail: 'None on intent; the card is honored.' },
            },
          },
    suite: () => ({ exitCode: 3 }),
  };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'intent-conflict');
  assert.ok(park.question.includes('drops the card constraint'));
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'Keep the card constraint.' });
  // The crashed seat parks with the recoverable options; only the answer closes.
  const crashed = await waitParked(fx.paths, runId, 'seat-failure');
  assert.deepEqual(crashed.options, ['retry', 'abandon']);
  assert.equal(crashed.detail.seat, 'suite');
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const events = await waitClosed(fx.paths, runId);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'seat-failure');
  assert.equal(closed.seat, 'suite');
  assert.equal(closed.cause, 'exit');
  // The conflict amendment ran, then a full counted round passed — the
  // conflict burned no round from the cap of two.
  const amend = fx.calls.find((c) => c.label === 'spec-birth-2');
  assert.ok(amend.prompt.includes('Keep the card constraint'));
  // The parking round stamps nothing, so its findings ride the conflict brief.
  assert.ok(amend.prompt.includes('ungrounded claim'));
  const rounds = events.filter((e) => e.event === 'spec-gate-round');
  assert.deepEqual(
    rounds.map((e) => [e.round, e.verdict]),
    [[1, 'pass']],
  );
  const recheck = fx.calls.find((c) => c.label === 'spec-gate-2');
  assert.ok(recheck.prompt.includes('Review the whole spec'));
});

test('an unkilled gap blocks the freeze until the human accepts it', async (t) => {
  const seats = {
    'spec-birth': ({ prompt }) => ({
      files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
      report: { outcome: 'spec-born', summary: 'born' },
    }),
    'spec-gate': () => ({ report: { findings: [], summary: 'clean' } }),
    suite: ({ prompt }) => {
      if (prompt.includes('left survivors')) {
        return {
          files: { 'tests/bogus.test.mjs': BOGUS_KILL_TEST },
          report: {
            suiteFiles: ['tests/feature.test.mjs', 'tests/bogus.test.mjs'],
            reds: [
              { test: 'feature exists', class: 'feature-absence' },
              { test: 'bogus kill', class: 'feature-absence' },
            ],
            summary: 'amended',
            killingTests: [{ wave: 1, test: 'bogus kill' }],
            dispositions: [],
          },
        };
      }
      return {
        files: { 'tests/feature.test.mjs': WEAK_TEST },
        report: {
          suiteFiles: ['tests/feature.test.mjs'],
          reds: [{ test: 'feature exists', class: 'feature-absence' }],
          summary: 'authored',
        },
      };
    },
    adversary: ({ label }) => {
      const wave = Number(/-w(\d+)$/.exec(label)[1]);
      if (wave === 1) {
        return {
          files: { 'src/feature.mjs': 'export const f = () => 0;\n' },
          report: { approach: 'stub', wrongness: 'f returns 0' },
        };
      }
      return { report: { approach: 'absent', wrongness: 'no implementation' } };
    },
  };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'unkilled-gap-survivor');
  assert.deepEqual(park.options, ['accept-spec-indifferent', 'fail']);
  assert.ok(park.question.includes('wave 1'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'accept-spec-indifferent' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The bogus killing test did not kill; the gap escalated, then the human
  // acceptance recorded it as spec-indifferent.
  const dispositions = events.filter((e) => e.event === 'survivor-disposition');
  assert.deepEqual(
    dispositions.map((e) => [e.wave, e.disposition, e.actor]),
    [
      [1, 'unkilled-gap', 'daemon'],
      [1, 'spec-indifferent', 'operator'],
    ],
  );
  const record = JSON.parse(readFileSync(join(fx.paths.archivedRuns, runId, 'freeze.json'), 'utf8'));
  assert.equal(record.killCount, 2);
  assert.equal(record.amendmentKills, 0);
  assert.deepEqual(record.dispositions.map((d) => [d.wave, d.disposition]), [[1, 'spec-indifferent']]);
});

test('a second zero-kill round escalates with the survivor set', async (t) => {
  const seats = {
    'spec-birth': ({ prompt }) => ({
      files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
      report: { outcome: 'spec-born', summary: 'born' },
    }),
    'spec-gate': () => ({ report: { findings: [], summary: 'clean' } }),
    suite: ({ prompt }) =>
      prompt.includes('scored zero kills')
        ? {
            report: {
              suiteFiles: ['tests/feature.test.mjs'],
              reds: [{ test: 'feature exists', class: 'feature-absence' }],
              summary: 'no stronger suite found',
            },
          }
        : {
            files: { 'tests/feature.test.mjs': WEAK_TEST },
            report: {
              suiteFiles: ['tests/feature.test.mjs'],
              reds: [{ test: 'feature exists', class: 'feature-absence' }],
              summary: 'authored',
            },
          },
    adversary: () => ({
      files: { 'src/feature.mjs': 'export const f = () => 0;\n' },
      report: { approach: 'stub', wrongness: 'f returns 0' },
    }),
  };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'second-zero-kill');
  assert.deepEqual(park.options, ['strengthen-again', 'fail']);
  assert.ok(park.question.includes('0/3'));
  assert.ok(park.question.includes('f returns 0'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'fail' });
  const events = await waitClosed(fx.paths, runId);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'second-zero-kill');
  // Two full rounds ran to verdict around one strengthening commit.
  const initial = events.filter((e) => e.event === 'adversary-wave' && e.phase === 'initial');
  assert.equal(initial.filter((e) => e.round === 1).length, 3);
  assert.equal(initial.filter((e) => e.round === 2).length, 3);
  assert.ok(initial.every((e) => e.result === 'survived'));
  assert.equal(
    events.filter((e) => e.event === 'suite-committed' && e.phase === 'strengthening').length,
    1,
  );
});

test('a green red-state check routes one suite fix round before the freeze', async (t) => {
  const seats = {
    'spec-birth': ({ prompt }) => ({
      files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
      report: { outcome: 'spec-born', summary: 'born' },
    }),
    'spec-gate': () => ({ report: { findings: [], summary: 'clean' } }),
    suite: ({ prompt }) => {
      if (prompt.includes('red-state check failed')) {
        return {
          files: { 'tests/feature.test.mjs': STRONG_TEST },
          report: {
            suiteFiles: ['tests/feature.test.mjs'],
            reds: [{ test: 'f doubles', class: 'feature-absence' }],
            summary: 'fixed',
          },
        };
      }
      if (prompt.includes('left survivors')) {
        return {
          report: {
            suiteFiles: ['tests/feature.test.mjs'],
            reds: [{ test: 'f doubles when present', class: 'feature-absence' }],
            summary: 'disposed',
            killingTests: [],
            dispositions: [
              { wave: 2, disposition: 'spec-indifferent', reason: 'absence is out of scope' },
            ],
          },
        };
      }
      return {
        files: { 'tests/feature.test.mjs': CONDITIONAL_TEST },
        report: {
          suiteFiles: ['tests/feature.test.mjs'],
          reds: [{ test: 'f doubles when present', class: 'feature-absence' }],
          summary: 'authored',
        },
      };
    },
    adversary: ({ label }) => {
      const wave = Number(/-w(\d+)$/.exec(label)[1]);
      if (wave === 1) {
        return {
          files: { 'src/feature.mjs': 'export const f = () => 0;\n' },
          report: { approach: 'stub', wrongness: 'f returns 0' },
        };
      }
      if (wave === 2) return { report: { approach: 'absent', wrongness: 'no implementation' } };
      return {
        files: { 'src/feature.mjs': 'export const f = (x) => x;\n' },
        report: { approach: 'identity', wrongness: 'f returns x' },
      };
    },
  };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The conditional suite was green pre-implementation: green, fix, red.
  const redStates = events.filter((e) => e.event === 'red-state-check');
  assert.deepEqual(
    redStates.map((e) => e.result),
    ['green', 'red'],
  );
  const phases = events.filter((e) => e.event === 'suite-committed').map((e) => e.phase);
  assert.deepEqual(phases, ['author', 'amendment', 'fix']);
  const freeze = events.find((e) => e.event === 'freeze');
  assert.equal(freeze.killCount, 2);
  const record = JSON.parse(readFileSync(join(fx.paths.archivedRuns, runId, 'freeze.json'), 'utf8'));
  assert.equal(record.redState.result, 'red');
  assert.deepEqual(record.dispositions.map((d) => [d.wave, d.disposition]), [[2, 'spec-indifferent']]);
});

test('a spec that breaks the template takes one corrective round, then parks', async (t) => {
  const seats = {
    'spec-birth': ({ prompt }) => ({
      files: { [specPathFrom(prompt)]: '# alpha-1 spec\n\nf(x) returns twice its input.\n' },
      report: { outcome: 'spec-born', summary: 'born' },
    }),
  };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'seat-failure');
  assert.equal(park.detail.seat, 'spec-birth');
  assert.equal(park.detail.cause, 'spec-defect');
  // One corrective invocation, carrying the exact failures by name.
  const calls = fx.calls.filter((c) => c.seat === 'spec-birth');
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /Correction brief/);
  assert.match(calls[1].prompt, /no section for acceptance criterion AC-1/);
  assert.match(calls[1].prompt, /declares no ```touched-paths block/);
  // The template is stated where the spec is written, so the two never drift.
  assert.match(calls[0].prompt, /The spec has a fixed template/);
  assert.match(calls[0].prompt, /Test mapping:/);
  assert.match(calls[0].prompt, /The card defines WHAT ships/);
  // The lint is a bookend, not a judgment round: no gate seat, no gate round,
  // and no spec was ever born.
  const live = readEvents(runLedgerPath(fx.paths, runId));
  assert.ok(!fx.calls.some((c) => c.seat === 'spec-gate'));
  assert.ok(!live.some((e) => e.event === 'spec-gate-round'));
  assert.ok(!live.some((e) => e.event === 'spec-born'));
  const failure = live.find((e) => e.event === 'seat-failure');
  assert.ok(failure.defects.some((d) => /touched-paths/.test(d)));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const closed = (await waitClosed(fx.paths, runId)).find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.seat, 'spec-birth');
});

test('a card that yields no criterion parks stage-blocked, before any seat', async (t) => {
  const card = `---
key: alpha-1
title: Alpha
---

## Acceptance criteria

The goal above states them.
`;
  const seats = { 'spec-birth': amendingBirth() };
  const fx = storyFixture(t, { seats, card });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'stage-blocked');
  assert.equal(park.reason, 'card-no-criteria');
  assert.deepEqual(park.options, ['retry', 'abandon']);
  // The message names the card and the heading the parse read.
  assert.ok(park.question.includes('stories/alpha.md'), park.question);
  assert.ok(park.question.includes('acceptance heading'), park.question);
  // A seat cannot fix a parse, so no seat was ever asked to: the birth seat is
  // never invoked, and no spec-defect failure was recorded against it.
  const live = readEvents(runLedgerPath(fx.paths, runId));
  assert.deepEqual(fx.calls, []);
  assert.ok(!live.some((e) => e.event === 'seat-spawned'));
  assert.ok(!live.some((e) => e.event === 'seat-failure'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const closed = (await waitClosed(fx.paths, runId)).find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'card-no-criteria');
});

test('the freeze records the test-path files the spec gave the dev pass', async (t) => {
  const spec = FIXTURE_SPEC.replace(
    'tests/feature.test.mjs — suite',
    'tests/feature.test.mjs — suite\ntests/support/harness.mjs — dev',
  );
  const seats = {
    'spec-birth': ({ prompt }) => ({
      files: { [specPathFrom(prompt)]: spec },
      report: { outcome: 'spec-born', summary: 'born' },
    }),
    'spec-gate': () => ({ report: { findings: [], summary: 'clean' } }),
    suite: () => ({
      files: { 'tests/feature.test.mjs': STRONG_TEST },
      report: {
        suiteFiles: ['tests/feature.test.mjs'],
        reds: [{ test: 'f doubles', class: 'feature-absence' }],
        summary: 'authored',
      },
    }),
    adversary: () => ({
      files: { 'src/feature.mjs': 'export const f = () => 0;\n' },
      report: { approach: 'stub', wrongness: 'f returns 0' },
    }),
  };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const freeze = events.find((e) => e.event === 'freeze');
  assert.equal(freeze.exclusions, 1);
  const record = JSON.parse(readFileSync(join(fx.paths.archivedRuns, runId, 'freeze.json'), 'utf8'));
  assert.deepEqual(record.frozenExclusions, ['tests/support/harness.mjs']);
  // The adversary's boundary is unchanged: an exclusion belongs to the dev
  // pass, and an adversary that edits a test file is still tampering.
  const adversaries = fx.calls.filter((c) => c.seat === 'adversary');
  assert.equal(adversaries.length, 3);
  assert.ok(adversaries.every((c) => c.denyTools.includes('Edit(tests/**)')));
});

test('the stack env reaches the compose up, the lint command, and the seats', async (t) => {
  const ENV_KEYS = ['COMPOSE_PROJECT_NAME', 'OLYMPUS_RUN_ID', 'OLYMPUS_WORKTREE', 'OLY_STATIC'];
  let lintCapture;
  let seatCapture;
  const compose = fakeComposeRunner();
  const seats = {
    'spec-birth': () => ({
      report: { outcome: 'grounding-conflict', summary: 'conflict', conflict: 'which way?' },
      envCapture: { path: seatCapture, keys: ENV_KEYS },
    }),
  };
  const fx = storyFixture(t, {
    seats,
    composeRunner: compose,
    config: (root) => {
      lintCapture = join(root, 'lint-env.json');
      seatCapture = join(root, 'seat-env.json');
      return {
        stack: { composeFile: 'compose.harness.yml', env: { OLY_STATIC: 'static-1' } },
        commands: {
          lint: [
            'node',
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(lintCapture)},JSON.stringify(` +
              `Object.fromEntries(${JSON.stringify(ENV_KEYS)}.map((k) => [k, process.env[k]]))))`,
          ],
        },
        lanes: { story: { suiteCommand: 'suite', lintCommand: 'lint' } },
      };
    },
  });
  const runId = await fx.launch();
  await waitParked(fx.paths, runId, 'grounding-conflict');
  // One derivation everywhere: the env compose brought the stack up with is
  // the env the lint command and the seat ran with.
  const up = compose.calls.find((c) => c.args.includes('up'));
  assert.ok(up, 'no compose up call');
  const expected = {
    COMPOSE_PROJECT_NAME: `oly-${runId}`,
    OLYMPUS_RUN_ID: runId,
    OLYMPUS_WORKTREE: up.env.OLYMPUS_WORKTREE,
    OLY_STATIC: 'static-1',
  };
  assert.equal(up.env.COMPOSE_PROJECT_NAME, expected.COMPOSE_PROJECT_NAME);
  assert.ok(up.env.OLYMPUS_WORKTREE.length > 0, 'compose up got no worktree');
  assert.deepEqual(JSON.parse(readFileSync(lintCapture, 'utf8')), expected);
  assert.deepEqual(JSON.parse(readFileSync(seatCapture, 'utf8')), expected);
});
