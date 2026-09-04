// The story-lane pre-freeze chain end to end on fixture repos: a story
// reaches a valid freeze record with kill count and dispositions; every
// escalation case parks correctly; deterministic defects take the one-
// corrective contract route; a tampered wave suite is restored before
// evaluation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { COMMAND_LOG_ROOT } from '../src/lanes/exec.mjs';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, archivedRunLedgerPath, runLedgerPath } from '../src/daemon/home.mjs';
import { storyLane } from '../src/lanes/story.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { fingerprint } from '../src/daemon/credentials.mjs';
import { openWorkspaceLeftovers } from '../src/telemetry/readers.mjs';
import { OWNER_PIN_MARKER } from '../src/lanes/supersede.mjs';
import { FORESEEN_HEADING, FORESEEN_MARKER } from '../src/lanes/card.mjs';
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

/** Every file under a directory whose text holds a word. Empty when there is
 * no directory at all: a store nothing wrote is a store that leaked nothing. */
function filesHolding(dir, word) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...filesHolding(path, word));
    else if (readFileSync(path, 'utf8').includes(word)) found.push(path);
  }
  return found;
}

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
// The value an owner places on the host after a rotation. The probe refuses it,
// and no ledger and no park text may hold it.
const ROTATED = 'sk_fixture_rotated_never_record_me';
const PROBE_SCRIPT =
  `console.log('probe sent ${PROBE_LEAK}');` +
  `process.exit(process.env.${PROBE_VAR} === 'live' ? 0 : 1);`;

// A probe that answers no when the service has revoked a key the host still
// holds. The stored value is untouched; only the service's answer changes.
const BREAK_VAR = 'OLYMPUS_FIXTURE_SERVICE_REVOKED';
const REVOKING_PROBE_SCRIPT =
  `console.log('probe sent ${PROBE_LEAK}');` +
  `process.exit(process.env.${PROBE_VAR} === 'live' && !process.env.${BREAK_VAR} ? 0 : 1);`;

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

/**
 * The machine's own store of the fixture credential, and the way to replace the
 * value in it while the daemon runs. It is the file kind, which is the kind CI
 * and every non-Windows host uses; the registry kind is read in
 * `credentials.test.mjs` against a real `reg.exe`.
 */
function storedCredential(t, value) {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const path = join(dir, 'creds.env');
  const set = (next) => writeFileSync(path, next === undefined ? '' : `${PROBE_VAR}="${next}"\n`);
  set(value);
  return { instance: { credentialStore: { kind: 'env-file', path } }, set };
}

/** Sets a plain host variable for one test and restores it afterwards. */
function heldVariable(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

// -- fixture machinery -------------------------------------------------------

function specPathFrom(prompt) {
  return /absolute path: (.+)$/m.exec(prompt)[1].trim();
}

/** The fixture spec with its AC-1 section rewritten — one amendment's work. */
function amendedSpec(n, base = FIXTURE_SPEC) {
  return base.replace(
    'The suite asserts it on one number.',
    `The suite asserts it on one number. Amendment ${n} grounds it in src/base.mjs.`,
  );
}

/**
 * A spec-birth behavior that writes the spec at birth and rewrites the AC-1
 * section on every amendment, so the gate's computed scope is never empty.
 */
function amendingBirth(spec = FIXTURE_SPEC) {
  let amendments = 0;
  return ({ prompt }) =>
    prompt.includes('Amend the born spec')
      ? {
          files: { [specPathFrom(prompt)]: amendedSpec(++amendments, spec) },
          report: { amendedSections: ['AC-1'], summary: 'amended' },
        }
      : {
          files: { [specPathFrom(prompt)]: spec },
          report: { outcome: 'spec-born', summary: 'born' },
        };
}

/**
 * The seats a gate that passes needs after it: a suite that kills, and one
 * adversary the frozen suite kills. Every scenario about a converging gate
 * runs the whole chain, because a gate with no cap ends at the freeze.
 */
function shippingSeats(gate) {
  return {
    'spec-birth': amendingBirth(),
    'spec-gate': gate,
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

/**
 * A gate behavior whose rounds report the defects they are given, one blocking
 * finding each. A gate finding is identified by its section and the defect it
 * states, so two rounds that name different defects report different findings
 * however many each of them holds.
 */
function gateDefects(rounds) {
  return ({ label }) => {
    const defects = rounds[Number(/-(\d+)$/.exec(label)[1]) - 1] ?? [];
    return {
      report: {
        findings: defects.map((defect) => ({
          section: 'AC-1',
          finding: defect,
          evidence: 'src/base.mjs',
        })),
        summary: `${defects.length} blocking`,
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

// `waves` raises the adversary wave count for the scenarios whose subject is
// the multi-wave machinery. Omitted, the fixture takes the harness default,
// which is the one wave a round runs today.
function storyFixture(
  t,
  {
    seats,
    card = DEFAULT_CARD,
    config,
    composeRunner,
    files = {},
    waves,
    ciSecrets = null,
    // Machine-scoped keys this fixture's home declares, over the defaults. The
    // credential store is one: it says where this host keeps the values the
    // project declares (ADR-0064).
    instance = {},
  },
) {
  const root = tempDir();
  // `config` may be a function of the fixture root, for absolute probe paths.
  const overrides = typeof config === 'function' ? config(root) : (config ?? {});
  const base = {
    repo: { testPaths: ['tests'] },
    commands: { suite: ['node', '--test', 'tests/*.test.mjs'] },
    lanes: { story: { suiteCommand: 'suite', ...(waves ? { adversaryWaves: waves } : {}) } },
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
    JSON.stringify({
      version: 1,
      projects: { proj: { repoUrl: origin, slotCap: 2 } },
      ...instance,
    }) + '\n',
  );
  // A forge that answers one question: which secrets CI holds. `null` stands
  // for a forge that would not answer at all. Both the launch door and the
  // lane's own gate ask it, so both get the same one (ADR-0068).
  // A list, or a function of the read: a scenario about a surface the world
  // retired mid-run answers one thing at the door and another inside the run.
  const forgeFor =
    ciSecrets === null
      ? null
      : () => ({
          ciSecrets: async () => (typeof ciSecrets === 'function' ? ciSecrets() : ciSecrets),
        });
  const lanes = {
    story: storyLane({
      afterFreeze: {
        stages: ['done'],
        handlers: { done: async () => ({ close: { state: 'shipped' } }) },
      },
      forgeFor,
    }),
  };
  const daemon = new Daemon(join(root, 'home'), {
    lanes,
    composeRunner,
    forgeFor: forgeFor ?? (() => null),
  });
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
    /** A launch the door is expected to refuse: the daemon, started, and the throw. */
    async refusedLaunch(payload = {}) {
      if (!daemon.running) await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: fixture.commandFor });
      return daemon
        .launchRun({ project: 'proj', lane: 'story', card: 'stories/alpha.md', ...payload })
        .then(
          (ok) => {
            throw new Error(`the door admitted the launch: ${JSON.stringify(ok)}`);
          },
          (error) => error,
        );
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
  const fx = storyFixture(t, { seats, waves: 3, files: { '.olympus/constitution.md': policy } });
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
  // The security dimensions ride every wave: the verdict panel holds no seat
  // of its own for them, and a wave is where a missing assertion is cheapest
  // to find.
  for (const dimension of [
    'authorization on every entry point',
    'input trust',
    'secrets',
    'trust boundaries',
  ]) {
    assert.ok(
      adversaryCalls.every((c) => c.prompt.includes(`- ${dimension}`)),
      dimension,
    );
  }
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
  // A project that names no declared-ground command runs no such step and
  // stamps nothing, which is what every project had before the step existed
  // (ADR-0060).
  assert.ok(!events.some((e) => e.event === 'ground-check'));
  assert.ok(fx.calls.every((c) => !c.prompt.includes('checks the declared ground')));
});

test('the adversary runs one wave a round, and a survivor still hardens the suite', async (t) => {
  const seats = {
    'spec-birth': ({ prompt }) => ({
      files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
      report: { outcome: 'spec-born', summary: 'born' },
    }),
    'spec-gate': () => ({ report: { findings: [], summary: 'clean' } }),
    suite: ({ prompt }) =>
      prompt.includes('scored zero kills')
        ? {
            files: { 'tests/feature-kill.test.mjs': STRONG_TEST },
            report: {
              suiteFiles: ['tests/feature.test.mjs', 'tests/feature-kill.test.mjs'],
              reds: [
                { test: 'feature exists', class: 'feature-absence' },
                { test: 'f doubles', class: 'feature-absence' },
              ],
              summary: 'strengthened',
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
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'park'));
  // One wave a round, and the survivor of round 1 bought a strengthening round
  // instead of a freeze: the reduction holds only while the suite kills.
  const waves = events.filter((e) => e.event === 'adversary-wave');
  assert.deepEqual(
    waves.map((e) => [e.round, e.wave, e.phase, e.result]),
    [
      [1, 1, 'initial', 'survived'],
      [2, 1, 'initial', 'killed'],
    ],
  );
  assert.deepEqual(
    events.filter((e) => e.event === 'suite-committed').map((e) => e.phase),
    ['author', 'strengthening'],
  );
  const freeze = events.find((e) => e.event === 'freeze');
  assert.equal(freeze.killCount, 1);
});

test('open decisions park readiness; the spec gate stalls when a round closes nothing', async (t) => {
  const card = `---
key: alpha-1
title: Alpha
---

## Open decisions

- Pick the rounding mode
${FIXTURE_ACCEPTANCE}`;
  // The same two findings both rounds, by identity: round 2 closed nothing.
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([2, 2]) };
  const fx = storyFixture(t, { seats, card });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'open-decisions');
  assert.ok(park.question.includes('Pick the rounding mode'));
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'round half up' });
  // The stall parks for the owner; abandoning there closes the run.
  const exhausted = await waitParked(fx.paths, runId, 'spec-gate-stalled');
  assert.ok(exhausted.question.includes('2 blocking findings against 2 in round 1'));
  // The park counts the two channels apart: only the blocking count held it.
  assert.ok(exhausted.question.includes('notes: 1'));
  assert.deepEqual(exhausted.answers.options, ['round', 'abandon']);
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const events = await waitClosed(fx.paths, runId);
  const closed = events.find((e) => e.event === 'run-closed');
  assert.equal(closed.state, 'failed');
  assert.equal(closed.reason, 'spec-gate-stalled');
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

test('a stale credential is refused at the door, and no workspace exists after it', async (t) => {
  const setCredential = heldCredential(t, 'stale');
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 3]) };
  const fx = storyFixture(t, {
    seats,
    config: {
      commands: { probe: [process.execPath, '-e', PROBE_SCRIPT] },
      credentials: [{ name: 'payments', env: PROBE_VAR, probe: 'probe' }],
    },
  });
  const refused = await fx.refusedLaunch();
  assert.match(refused.message, /payments credential probe answered no at the launch door/);
  assert.ok(refused.message.includes(PROBE_VAR));
  assert.equal(refused.detail.credential, 'payments');
  assert.equal(refused.detail.fingerprint, fingerprint('stale'));
  // Nothing was spent: no seat, no run, no workspace (ADR-0068).
  assert.equal(fx.calls.length, 0);
  assert.deepEqual(readdirSync(fx.paths.runs), []);
  assert.equal(openWorkspaceLeftovers(fx.paths).size, 0);
  const failed = readEvents(fx.paths.instanceLedger).find((e) => e.event === 'credential-probe');
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'refused');
  assert.equal(failed.phase, 'launch');
  assert.equal(failed.credential, 'payments');
  assert.equal(failed.variable, PROBE_VAR);
  assert.equal(failed.validUntil, undefined);
  // The probe's own output reaches neither the ledger nor the human.
  assert.ok(!readFileSync(fx.paths.instanceLedger, 'utf8').includes(PROBE_LEAK));
  assert.ok(!refused.message.includes(PROBE_LEAK));
  // Nor any file. Every other command in the harness streams its output to
  // one (ADR-0043); this is the one that writes none, because nothing reads
  // its output and everything it prints can carry the credential (ADR-0027).
  assert.deepEqual(filesHolding(fx.paths.runs, PROBE_LEAK), []);
  assert.deepEqual(filesHolding(COMMAND_LOG_ROOT, PROBE_LEAK), []);

  // The owner replaces the value and launches again. The door probes the new
  // value, admits the launch, and the pass carries the window it stands for.
  setCredential('live');
  const { runId } = await fx.daemon.launchRun({
    project: 'proj',
    lane: 'story',
    card: 'stories/alpha.md',
  });
  const stalled = await waitParked(fx.paths, runId, 'spec-gate-stalled');
  assert.ok(stalled.question.includes('not converging'));
  const passed = readEvents(fx.paths.instanceLedger).find(
    (e) => e.event === 'credential-probe' && e.ok === true,
  );
  assert.equal(passed.fingerprint, fingerprint('live'));
  assert.match(passed.validUntil, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(passed.cached, undefined);
  // The run's own gate asked the service for itself: it is the guard for a
  // value that moves mid-run, and it reads no cache (ADR-0068).
  const inRun = readEvents(runLedgerPath(fx.paths, runId)).find(
    (e) => e.event === 'credential-probe',
  );
  assert.equal(inRun.ok, true);
  assert.equal(inRun.cached, undefined);
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  await waitClosed(fx.paths, runId);
  assert.ok(fx.calls.some((c) => c.seat === 'spec-birth'));
});

test('a second launch inside the cache window asks the service nothing', async (t) => {
  heldCredential(t, 'live');
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 3]) };
  const fx = storyFixture(t, {
    seats,
    config: {
      commands: { probe: [process.execPath, '-e', PROBE_SCRIPT] },
      credentials: [{ name: 'payments', env: PROBE_VAR, probe: 'probe' }],
    },
  });
  const first = await fx.launch();
  await waitParked(fx.paths, first, 'spec-gate-stalled');
  const { runId } = await fx.daemon.launchRun({
    project: 'proj',
    lane: 'story',
    card: 'stories/alpha.md',
  });
  await waitParked(fx.paths, runId, 'spec-gate-stalled');
  // One live probe on this instance, and every later read of the same value
  // stands on it and says so (ADR-0068).
  const doors = readEvents(fx.paths.instanceLedger).filter(
    (e) => e.event === 'credential-probe',
  );
  assert.equal(doors.length, 2);
  assert.deepEqual(
    doors.map((e) => [e.ok, e.cached === undefined]),
    [
      [true, true],
      [true, false],
    ],
  );
  assert.equal(doors[1].cached, doors[0].seq);
  assert.equal(doors[1].validUntil, doors[0].validUntil);
  for (const id of [first, runId]) {
    fx.daemon.engine.answer({ runId: id, actor: 'operator', option: 'abandon' });
    await waitClosed(fx.paths, id);
  }
});

test('an absent credential variable is refused at the door without running the probe', async (t) => {
  const setCredential = heldCredential(t, undefined);
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 3]) };
  const fx = storyFixture(t, {
    seats,
    config: {
      commands: { probe: [process.execPath, '-e', PROBE_SCRIPT] },
      credentials: [{ name: 'payments', env: PROBE_VAR, probe: 'probe' }],
    },
  });
  const refused = await fx.refusedLaunch();
  assert.match(refused.message, /is not on this host/);
  const stamped = readEvents(fx.paths.instanceLedger).find(
    (e) => e.event === 'credential-surface',
  );
  assert.equal(stamped.ok, false);
  assert.deepEqual(stamped.missing, [{ surface: 'host', name: PROBE_VAR }]);
  assert.equal(fx.calls.length, 0);
  assert.deepEqual(readdirSync(fx.paths.runs), []);
  setCredential('live');
  const { runId } = await fx.daemon.launchRun({
    project: 'proj',
    lane: 'story',
    card: 'stories/alpha.md',
  });
  await waitParked(fx.paths, runId, 'spec-gate-stalled');
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  await waitClosed(fx.paths, runId);
});

// -- the machine's store, not the window's copy -------------------------------

test('the gate asks the value the machine stores, not the copy the daemon inherited', async (t) => {
  // The window that started this daemon holds a value that no longer works.
  heldCredential(t, 'stale');
  const store = storedCredential(t, 'live');
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 3]) };
  const fx = storyFixture(t, {
    seats,
    instance: store.instance,
    config: {
      commands: { probe: [process.execPath, '-e', PROBE_SCRIPT] },
      credentials: [{ name: 'payments', env: PROBE_VAR, probe: 'probe' }],
    },
  });
  const runId = await fx.launch();
  // No provisioning park at all: the probe read the store and got a yes.
  const stalled = await waitParked(fx.paths, runId, 'spec-gate-stalled');
  assert.ok(stalled.question.includes('not converging'));
  const events = readEvents(runLedgerPath(fx.paths, runId));
  const probe = events.find((e) => e.event === 'credential-probe');
  assert.equal(probe.ok, true);
  assert.equal(probe.fingerprint, fingerprint('live'));
  assert.ok(!events.some((e) => e.event === 'park' && e.type === 'provisioning-gate'));
  // The read is recorded, and the daemon's own copy is left where it was.
  const read = readEvents(fx.paths.instanceLedger).find(
    (e) => e.event === 'credential-fingerprints',
  );
  assert.deepEqual(read.variables, [
    { name: PROBE_VAR, source: 'store', fingerprint: fingerprint('live') },
  ]);
  assert.equal(process.env[PROBE_VAR], 'stale');
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  await waitClosed(fx.paths, runId);
});

test('a value replaced in the store is read at the door and named as a rotation', async (t) => {
  heldCredential(t, 'stale');
  const store = storedCredential(t, 'live');
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 3]) };
  const fx = storyFixture(t, {
    seats,
    instance: store.instance,
    config: {
      commands: { probe: [process.execPath, '-e', PROBE_SCRIPT] },
      credentials: [{ name: 'payments', env: PROBE_VAR, probe: 'probe' }],
    },
  });
  const first = await fx.launch();
  await waitParked(fx.paths, first, 'spec-gate-stalled');
  // The owner places a new value on this host. Nothing is restarted.
  store.set(ROTATED);
  const refused = await fx.refusedLaunch();
  // The refusal says which of the two failures this is: the value moved.
  assert.match(
    refused.message,
    /The stored value changed since it last passed on \d{4}-\d{2}-\d{2}/,
  );
  assert.match(refused.message, /check the value placed on this host/);
  const instance = readEvents(fx.paths.instanceLedger);
  const rotated = instance.find((e) => e.event === 'credential-rotated');
  assert.equal(rotated.name, PROBE_VAR);
  assert.equal(rotated.from, fingerprint('live'));
  assert.equal(rotated.to, fingerprint(ROTATED));
  assert.equal(rotated.source, 'store');
  // A value that moved misses the cache by construction: the pass on the
  // record was recorded under the fingerprint of the value that passed, and
  // this is a different value (ADR-0068).
  const refusedProbe = instance.filter((e) => e.event === 'credential-probe').at(-1);
  assert.equal(refusedProbe.ok, false);
  assert.equal(refusedProbe.fingerprint, fingerprint(ROTATED));
  assert.equal(refusedProbe.cached, undefined);
  // Fingerprints, never values: neither the ledger nor the refusal holds one.
  assert.ok(!readFileSync(fx.paths.instanceLedger, 'utf8').includes(ROTATED));
  assert.ok(!refused.message.includes(ROTATED));
  fx.daemon.engine.answer({ runId: first, actor: 'operator', option: 'abandon' });
  await waitClosed(fx.paths, first);
});

test('a value the service revokes inside the cache window is caught by the run gate', async (t) => {
  // What the cache costs, and what pays for it. The value on this host is the
  // one that passed an hour ago, so the door stands on that pass and admits
  // the launch. The gate inside the run reads no cache and asks the service,
  // which is the whole reason it stays (ADR-0068).
  heldCredential(t, 'stale');
  const store = storedCredential(t, 'live');
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 3]) };
  const fx = storyFixture(t, {
    seats,
    instance: store.instance,
    config: {
      commands: { probe: [process.execPath, '-e', REVOKING_PROBE_SCRIPT] },
      credentials: [{ name: 'payments', env: PROBE_VAR, probe: 'probe' }],
    },
  });
  const first = await fx.launch();
  await waitParked(fx.paths, first, 'spec-gate-stalled');
  // The service revokes the key. The value on this host never moved.
  heldVariable(t, BREAK_VAR, '1');
  const { runId } = await fx.daemon.launchRun({
    project: 'proj',
    lane: 'story',
    card: 'stories/alpha.md',
  });
  const doors = readEvents(fx.paths.instanceLedger).filter(
    (e) => e.event === 'credential-probe',
  );
  assert.equal(doors.at(-1).cached, doors[0].seq, 'the door asked the service again');
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  assert.match(
    park.question,
    /The stored value is unchanged since it last passed on \d{4}-\d{2}-\d{2}/,
  );
  assert.match(park.question, /the credential itself needs replacing/);
  assert.match(park.question, /The launch door proved every declared credential/);
  // A value that did not move is no rotation.
  assert.ok(!readEvents(fx.paths.instanceLedger).some((e) => e.event === 'credential-rotated'));
  for (const id of [first, runId]) {
    fx.daemon.engine.answer({ runId: id, actor: 'operator', option: 'abandon' });
    await waitClosed(fx.paths, id);
  }
});

// -- credential parity across surfaces ---------------------------------------

const CI_SECRET = 'PAY_CI_KEY';
const WORKFLOW = '.github/workflows/ci.yml';
const WIRED_WORKFLOW = `name: ci
on: [pull_request]
jobs:
  suite:
    runs-on: ubuntu-latest
    steps:
      - run: node --test
        env:
          PAY_CI_KEY: \${{ secrets.${CI_SECRET} }}
`;
const UNWIRED_WORKFLOW = `name: ci
on: [pull_request]
jobs:
  suite:
    runs-on: ubuntu-latest
    steps:
      - run: node --test
`;

function parityConfig() {
  return {
    commands: { probe: [process.execPath, '-e', PROBE_SCRIPT] },
    credentials: [
      {
        name: 'payments',
        env: PROBE_VAR,
        probe: 'probe',
        ci: { secret: CI_SECRET, workflows: [WORKFLOW] },
      },
    ],
  };
}

test('the door refuses a missing CI surface and names every one at once', async (t) => {
  // The key is on this host and works. CI holds no secret of that name, and
  // the workflow that will need it reads nothing — the two gaps that used to
  // surface only after a request was open and a round had been paid for.
  heldCredential(t, 'live');
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 3]) };
  const fx = storyFixture(t, {
    seats,
    config: parityConfig(),
    files: { [WORKFLOW]: UNWIRED_WORKFLOW },
    ciSecrets: [],
  });
  const refused = await fx.refusedLaunch();
  assert.match(refused.message, /these credential surfaces are not wired/);
  assert.ok(refused.message.includes(`the repository holds no secret named ${CI_SECRET}`));
  assert.ok(refused.message.includes(`${WORKFLOW} does not reference secrets.${CI_SECRET}`));
  // Nothing was provisioned, and nothing was spent.
  assert.equal(fx.calls.length, 0);
  assert.deepEqual(readdirSync(fx.paths.runs), []);
  const stamped = readEvents(fx.paths.instanceLedger).find(
    (e) => e.event === 'credential-surface',
  );
  assert.equal(stamped.ok, false);
  assert.equal(stamped.phase, 'launch');
  // The declaration this read judged is the default branch's own (ADR-0068).
  assert.equal(stamped.source, 'default-branch');
  assert.deepEqual(stamped.missing, [
    { surface: 'ci-secret', name: CI_SECRET },
    { surface: 'workflow', name: WORKFLOW, secret: CI_SECRET },
  ]);
  // The probe never ran: an unwired surface is answered before the round trip.
  assert.ok(
    !readEvents(fx.paths.instanceLedger).some((e) => e.event === 'credential-probe'),
  );
});

test('every declared surface wired lets readiness through to the first seat', async (t) => {
  heldCredential(t, 'live');
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 3]) };
  const fx = storyFixture(t, {
    seats,
    config: parityConfig(),
    files: { [WORKFLOW]: WIRED_WORKFLOW },
    ciSecrets: [CI_SECRET, 'UNRELATED_KEY'],
  });
  const runId = await fx.launch();
  const stalled = await waitParked(fx.paths, runId, 'spec-gate-stalled');
  assert.ok(stalled.question.includes('not converging'));
  const live = readEvents(runLedgerPath(fx.paths, runId));
  const stamped = live.find((e) => e.event === 'credential-surface');
  assert.equal(stamped.ok, true);
  assert.equal(stamped.missing, undefined);
  // The surfaces pass first, and the value's own probe still answers after.
  assert.equal(live.find((e) => e.event === 'credential-probe').ok, true);
  assert.ok(fx.calls.some((c) => c.seat === 'spec-birth'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  await waitClosed(fx.paths, runId);
});

test('a gate that closes one finding a round runs to its pass with no park', async (t) => {
  // 4 → 3 → 2 → 1 → 0. Every round closes one of the findings the round before
  // it raised, and the count falls across every two rounds, so neither
  // convergence rule fires and no cap stops it (ADR-0020). The ledger's own
  // gates passed at rounds three to five exactly like this, after an owner
  // bought the rounds a cap had taken away.
  const fx = storyFixture(t, { seats: shippingSeats(gateFindings([4, 3, 2, 1])) });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(
    events.filter((e) => e.event === 'spec-gate-round').map((e) => [e.round, e.verdict, e.findings]),
    [
      [1, 'findings', 4],
      [2, 'findings', 3],
      [3, 'findings', 2],
      [4, 'findings', 1],
      [5, 'pass', 0],
    ],
  );
  assert.deepEqual(events.filter((e) => e.event === 'park'), []);
  // Every round is an amendment plus a re-check, and nobody was asked for one.
  assert.ok(fx.calls.some((c) => c.label === 'spec-gate-5'));
  assert.ok(fx.calls.some((c) => c.label === 'spec-birth-5'));
});

test('a shrinking blocking set runs to zero and passes the gate', async (t) => {
  // 3 → 1 → 0. Nothing stalls and nothing parks on the way.
  const fx = storyFixture(t, { seats: shippingSeats(gateFindings([3, 1, 0])) });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(
    events.filter((e) => e.event === 'spec-gate-round').map((e) => [e.round, e.verdict, e.findings]),
    [
      [1, 'findings', 3],
      [2, 'findings', 1],
      [3, 'pass', 0],
    ],
  );
  assert.ok(!events.some((e) => e.event === 'park' && e.type === 'spec-gate-stalled'));
});

test('a blocking count that holds while the identities move is converging', async (t) => {
  // 3 → 3, and two of the three are different defects: the amendment closed
  // two findings and the re-check found two more. A count cannot tell that from
  // a round that reported the same three, and the count rule parked two runs
  // that were converging (2026-08-21). The identity rule reads the round as
  // progress, and the round after it passes.
  const fx = storyFixture(t, {
    seats: shippingSeats(
      gateDefects([
        ['ungrounded claim 1', 'ungrounded claim 2', 'ungrounded claim 3'],
        ['ungrounded claim 1', 'unassertable threshold', 'scope beyond the card'],
        [],
      ]),
    ),
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'park' && e.type === 'spec-gate-stalled'));
  const rounds = events.filter((e) => e.event === 'spec-gate-round');
  assert.deepEqual(
    rounds.map((e) => e.findings),
    [3, 3, 0],
  );
  // Equal counts, moved identities: one finding survived the amendment.
  assert.equal(rounds[0].blocking.filter((id) => rounds[1].blocking.includes(id)).length, 1);
});

test('a count that does not fall across two rounds parks stalled', async (t) => {
  // Three rounds, three defects each, two of them new every time. No round
  // closes nothing, so the identity rule never fires; the count is what says
  // the trade of one finding for another is not progress (ADR-0020).
  const seats = {
    'spec-birth': amendingBirth(),
    'spec-gate': gateDefects([
      ['ungrounded claim 1', 'ungrounded claim 2', 'ungrounded claim 3'],
      ['ungrounded claim 1', 'unassertable threshold', 'scope beyond the card'],
      ['ungrounded claim 1', 'unnamed constant', 'untestable clause'],
    ]),
  };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const stalled = await waitParked(fx.paths, runId, 'spec-gate-stalled');
  assert.ok(stalled.question.includes('3 blocking findings against 3 in round 1'));
  assert.ok(stalled.question.includes('two rounds back'));
  assert.ok(stalled.question.includes('has not fallen across two'));
  assert.deepEqual(stalled.answers.options, ['round', 'abandon']);
  // Three rounds ran: the identity rule passed each of them.
  assert.equal(
    readEvents(runLedgerPath(fx.paths, runId)).filter((e) => e.event === 'spec-gate-round').length,
    3,
  );
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').reason, 'spec-gate-stalled');
});

test('a growing blocking set parks at once, and one bought round runs', async (t) => {
  // 2 → 4 → 4: growth closes nothing, the bought round runs, and the round it
  // buys closes nothing either, so the gate parks a second time on the same
  // condition.
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([2, 4, 4]) };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const first = await waitParked(fx.paths, runId, 'spec-gate-stalled');
  assert.ok(first.question.includes('4 blocking findings against 2 in round 1'));
  assert.ok(first.question.includes('rather than spend another round'));
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
    adversary: () => ({
      files: { 'src/feature.mjs': 'export const f = () => 0;\n' },
      report: { approach: 'stub', wrongness: 'f returns 0' },
    }),
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
  assert.equal(freeze.killCount, 1);
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
    adversary: () => ({
      files: { 'src/feature.mjs': 'export const f = () => 0;\n' },
      report: { approach: 'stub', wrongness: 'f returns 0' },
    }),
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
  // A strong suite kills the wave; freeze needs no amendment.
  const freeze = events.find((e) => e.event === 'freeze');
  assert.equal(freeze.killCount, 1);
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
  assert.deepEqual(crashed.answers.options, ['retry', 'abandon']);
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
  const fx = storyFixture(t, { seats, waves: 3 });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'unkilled-gap-survivor');
  assert.deepEqual(park.answers.options, ['accept-spec-indifferent', 'abandon']);
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
  const fx = storyFixture(t, { seats, waves: 3 });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'second-zero-kill');
  assert.deepEqual(park.answers.options, ['strengthen-again', 'abandon']);
  assert.ok(park.question.includes('0/3'));
  assert.ok(park.question.includes('f returns 0'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
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
  const fx = storyFixture(t, { seats, waves: 3 });
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
  assert.deepEqual(park.answers.options, ['retry', 'abandon']);
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
    'tests/feature.test.mjs (new) — suite',
    'tests/feature.test.mjs (new) — suite\ntests/support/harness.mjs (new) — dev',
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
  assert.equal(adversaries.length, 1);
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

// -- the card authorizes a supersede at the gate (ADR-0044) -------------------

// A card whose scope boundary already sanctions the extension the story needs.
// The gate meets the collision before the suite is frozen, against the pin an
// earlier story left in the repository.
const SUPERSEDE_CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Provide f(x) that doubles x in src/feature.mjs.

## Scope boundary

This story adds a second published export to the feature module; the export
set an earlier story closed is extended here, not replaced.
${FIXTURE_ACCEPTANCE}`;

const SILENT_CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Provide f(x) that doubles x in src/feature.mjs.

## Scope boundary

Registration is another story's work. Nothing here reaches the export set.
${FIXTURE_ACCEPTANCE}`;

const GATE_COVERING_LINE =
  'This story adds a second published export to the feature module; the export ' +
  'set an earlier story closed is extended here, not replaced.';

const REPO_PIN = `import test from 'node:test';
import assert from 'node:assert/strict';
test('the export set is closed', async () => {
  const mod = await import('../src/feature.mjs');
  assert.deepEqual(Object.keys(mod).sort(), ['f']);
});
`;

const GATE_CLAIM = {
  supersedes: 'tests/pinned.test.mjs',
  supersedeAssertion: 'the published export set is exactly ["f"]',
  supersedeQuote: GATE_COVERING_LINE,
  supersedeClause: 'scope-boundary',
};

/** The gate seats of the collision scenario: round 1 collides, round 2 is clean. */
function collidingGate(claim) {
  return ({ label }) =>
    label === 'spec-gate-1'
      ? {
          report: {
            findings: [],
            summary: 'collision',
            intentConflict: {
              conflict: true,
              detail: 'The frozen pin closes the export set AC-1 extends.',
              ...claim,
            },
          },
        }
      : {
          report: {
            findings: [],
            summary: 'clean',
            intentConflict: { conflict: false, detail: 'None on intent.' },
          },
        };
}

// The repository pin on src/feature.mjs is a pin the spec has to declare
// (ADR-0067): the born spec lists it, and the gate then judges the collision.
const PINNED_SPEC = FIXTURE_SPEC.replace(
  'tests/feature.test.mjs (new) — suite',
  'tests/feature.test.mjs (new) — suite\ntests/pinned.test.mjs — suite',
);

function collisionSeats(gate) {
  return {
    'spec-birth': amendingBirth(PINNED_SPEC),
    'spec-gate': gate,
    suite: () => ({
      files: { 'tests/feature.test.mjs': STRONG_TEST },
      report: {
        suiteFiles: ['tests/feature.test.mjs'],
        reds: [{ test: 'f doubles', class: 'feature-absence' }],
        summary: 'authored',
      },
    }),
    adversary: () => ({ report: { approach: 'absent', wrongness: 'no implementation' } }),
  };
}

test('the gate supersedes a collision the card covers, and never asks', async (t) => {
  const fx = storyFixture(t, {
    card: SUPERSEDE_CARD,
    seats: collisionSeats(collidingGate(GATE_CLAIM)),
    files: { 'tests/pinned.test.mjs': REPO_PIN },
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.deepEqual(
    events.filter((e) => e.event === 'park').map((e) => e.type),
    [],
  );
  const stamp = events.find((e) => e.event === 'supersede-authorized');
  assert.equal(stamp.site, 'spec-gate');
  assert.equal(stamp.test, 'tests/pinned.test.mjs');
  assert.equal(stamp.clause, 'scope-boundary');
  assert.equal(stamp.cardQuote, GATE_COVERING_LINE);
  assert.equal(stamp.card, 'stories/alpha.md');
  // The amendment ran on the card's own words, and burned no counted round.
  const amend = fx.calls.find((c) => c.label === 'spec-birth-2');
  assert.ok(amend.prompt.includes('the intent card authorizes the supersede'));
  assert.ok(amend.prompt.includes(GATE_COVERING_LINE));
  assert.ok(amend.prompt.includes('tests/pinned.test.mjs'));
  const rounds = events.filter((e) => e.event === 'spec-gate-round');
  assert.deepEqual(
    rounds.map((e) => [e.round, e.verdict]),
    [[1, 'pass']],
  );
  // The gate seat was told to classify before it reported, on the necessity
  // test rather than on whether the card names the surface (ADR-0053).
  assert.ok(
    fx.calls[1].prompt.includes(
      'does the card mandate a behavior whose implementation necessarily changes what the ' +
        'pinned clause asserts',
    ),
  );
});

test('the gate parks a collision the card is silent on, and refuses a fabricated quote', async (t) => {
  const fx = storyFixture(t, {
    card: SILENT_CARD,
    // The card carries no such line; the seat quotes it anyway.
    seats: collisionSeats(collidingGate(GATE_CLAIM)),
    files: { 'tests/pinned.test.mjs': REPO_PIN },
  });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'intent-conflict');
  assert.ok(park.question.includes('The card did not settle it'));
  assert.ok(park.question.includes('not in the card section the claim names'));
  assert.equal(
    readEvents(runLedgerPath(fx.paths, runId)).filter((e) => e.event === 'supersede-authorized')
      .length,
    0,
  );
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'Keep the closed set.' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.filter((e) => e.event === 'supersede-authorized').length, 0);
});

test('an owner-pinned test in the repository parks the gate, covering card or not', async (t) => {
  const fx = storyFixture(t, {
    card: SUPERSEDE_CARD,
    seats: collisionSeats(collidingGate(GATE_CLAIM)),
    files: {
      'tests/pinned.test.mjs': `// ${OWNER_PIN_MARKER}: the closed set is the owner's call.\n${REPO_PIN}`,
    },
  });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'intent-conflict');
  assert.ok(park.question.includes('carries the owner pin'));
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'Granted; extend the set.' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.equal(events.filter((e) => e.event === 'supersede-authorized').length, 0);
});

test('the freeze records which frozen tests are pinned to the owner', async (t) => {
  const seats = {
    'spec-birth': ({ prompt }) => ({
      files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
      report: { outcome: 'spec-born', summary: 'born' },
    }),
    'spec-gate': () => ({ report: { findings: [], summary: 'clean' } }),
    suite: () => ({
      files: {
        'tests/feature.test.mjs': STRONG_TEST,
        'tests/pinned.test.mjs': `// ${OWNER_PIN_MARKER}\n${REPO_PIN}`,
      },
      report: {
        suiteFiles: ['tests/feature.test.mjs', 'tests/pinned.test.mjs'],
        reds: [{ test: 'f doubles', class: 'feature-absence' }],
        summary: 'authored',
      },
    }),
    adversary: () => ({ report: { approach: 'absent', wrongness: 'no implementation' } }),
  };
  const fx = storyFixture(t, { seats });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  const freeze = events.find((e) => e.event === 'freeze');
  assert.equal(freeze.pins, 1);
  const record = JSON.parse(
    readFileSync(join(fx.paths.archivedRuns, runId, 'freeze.json'), 'utf8'),
  );
  assert.deepEqual(record.ownerPinned, ['tests/pinned.test.mjs']);
});

// -- foreseen amendments at the launch gate (ADR-0052) -----------------------

/** The shortest clean pre-freeze chain: born, gated, one suite, one wave. */
const CLEAN_SEATS = {
  'spec-birth': ({ prompt }) => ({
    files: { [specPathFrom(prompt)]: FIXTURE_SPEC },
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

const LAUNCH_NOTE =
  `${FORESEEN_MARKER} tests/feature.test.mjs pins the published export set; AC-1 mandates the ` +
  'second export.';

test('a foreseen amendment on the card never parks the launch', async (t) => {
  // The note states a consequence the card's own criteria mandate, so nothing
  // here waits on a human. The card carries it under its own heading and, as a
  // writer once put it, in the decisions section too: neither parks.
  const card = `---
key: alpha-1
title: Alpha
---

## Open decisions

- ${LAUNCH_NOTE}

## ${FORESEEN_HEADING}

- ${LAUNCH_NOTE}
${FIXTURE_ACCEPTANCE}`;
  const fx = storyFixture(t, { seats: CLEAN_SEATS, card });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  assert.ok(!events.some((e) => e.event === 'park'));
});

test('a question the card leaves open parks the launch, and the note beside it does not', async (t) => {
  const card = `---
key: alpha-1
title: Alpha
---

## Open decisions

- ${LAUNCH_NOTE}
- Pick the rounding mode
${FIXTURE_ACCEPTANCE}`;
  const fx = storyFixture(t, { seats: CLEAN_SEATS, card });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'open-decisions');
  assert.ok(park.question.includes('Pick the rounding mode'));
  assert.ok(!park.question.includes(FORESEEN_MARKER));
  fx.daemon.engine.answer({ runId, actor: 'operator', answer: 'round half up' });
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
});

// -- the declared-ground check before the freeze (ADR-0060) -------------------

// A project's own declared-ground check, in the smallest honest form: every
// suite file must name the family whose ground covers it. The check names the
// files that do not, exactly as a real one names the file and the family.
const GROUND_SCRIPT =
  "const fs=require('fs');" +
  "const files=fs.existsSync('tests')?fs.readdirSync('tests'):[];" +
  "const bad=files.filter((f)=>!fs.readFileSync('tests/'+f,'utf8').includes('olympus:family'));" +
  "if(bad.length){console.log('no family: '+bad.join(', '));process.exit(1);}" +
  "console.log('every suite file has a family');";

const GROUNDED_TEST = `// olympus:family unit\n${STRONG_TEST}`;

function groundConfig(command) {
  return {
    commands: { ground: command },
    lanes: { story: { suiteCommand: 'suite', groundCommand: 'ground' } },
  };
}

test('a red declared-ground check re-briefs the suite seat, and nothing is committed behind it', async (t) => {
  const seats = {
    ...CLEAN_SEATS,
    // The first suite file names no family; the corrective round adds it.
    suite: ({ label }) => ({
      files: { 'tests/feature.test.mjs': label === 'suite-1' ? STRONG_TEST : GROUNDED_TEST },
      report: {
        suiteFiles: ['tests/feature.test.mjs'],
        reds: [{ test: 'f doubles', class: 'feature-absence' }],
        summary: 'authored',
      },
    }),
  };
  const fx = storyFixture(t, {
    seats,
    config: groundConfig([process.execPath, '-e', GROUND_SCRIPT]),
  });
  const runId = await fx.launch();
  const events = await waitClosed(fx.paths, runId);
  assert.equal(events.find((e) => e.event === 'run-closed').state, 'shipped');
  // The check ran on the authoring round, went red, and went green on the
  // round that answered it.
  const checks = events.filter((e) => e.event === 'ground-check');
  assert.deepEqual(
    checks.map((e) => [e.phase, e.result]),
    [
      ['author', 'red'],
      ['author', 'green'],
    ],
  );
  // Nothing was committed behind the red: the commit follows the green.
  const committed = events.find((e) => e.event === 'suite-committed');
  assert.ok(committed.seq > checks[1].seq);
  // The seat that wrote the file was still live, and it was told which file.
  const attempts = fx.calls.filter((c) => c.seat === 'suite');
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1].prompt.includes('no family: feature.test.mjs'));
  assert.ok(attempts[1].prompt.includes('declared-ground check of this project is red'));
  // And every suite seat is told the rule before it can break it.
  assert.ok(attempts.every((c) => c.prompt.includes('checks the declared ground of its suite with')));
  // The run never reached the seat-failure park: one brief closed it.
  assert.ok(!events.some((e) => e.event === 'park'));
});

test('a declared-ground check that cannot run parks the environment, not the seat', async (t) => {
  const fx = storyFixture(t, {
    seats: CLEAN_SEATS,
    config: groundConfig(['olympus-no-such-ground-command']),
  });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'command-error');
  assert.equal(park.reason, 'ground-command-error');
  assert.match(park.question, /could not run, so nothing read the suite/);
  const live = readEvents(runLedgerPath(fx.paths, runId));
  const check = live.find((e) => e.event === 'ground-check');
  assert.equal(check.result, 'unrun');
  assert.equal(check.phase, 'author');
  assert.ok(check.cause.length > 0);
  // A host defect is not a defect of the suite: the seat is neither re-briefed
  // nor blamed, and one invocation is all it cost.
  assert.ok(!live.some((e) => e.event === 'seat-failure'));
  assert.equal(fx.calls.filter((c) => c.seat === 'suite').length, 1);
  assert.ok(!live.some((e) => e.event === 'suite-committed'));
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  await waitClosed(fx.paths, runId);
});

test('the check runs again on the round that hardens the suite', async (t) => {
  // The authoring round is not the only writer of a suite file. A strengthening
  // round writes one too, and a check that ran at the authoring round alone
  // would let that file reach the freeze undeclared.
  const seats = {
    ...CLEAN_SEATS,
    suite: ({ prompt }) =>
      prompt.includes('scored zero kills')
        ? {
            files: { 'tests/feature-kill.test.mjs': GROUNDED_TEST },
            report: {
              suiteFiles: ['tests/feature.test.mjs', 'tests/feature-kill.test.mjs'],
              reds: [{ test: 'f doubles', class: 'feature-absence' }],
              summary: 'strengthened',
            },
          }
        : {
            files: { 'tests/feature.test.mjs': GROUNDED_TEST },
            report: {
              suiteFiles: ['tests/feature.test.mjs'],
              reds: [{ test: 'f doubles', class: 'feature-absence' }],
              summary: 'authored',
            },
          },
    // A wave the suite cannot kill: the round scores zero and the lane
    // strengthens once.
    adversary: () => ({
      files: { 'src/feature.mjs': 'export const f = (x) => 2 * x;\n' },
      report: { approach: 'correct', wrongness: 'none the suite can see' },
    }),
  };
  const fx = storyFixture(t, {
    seats,
    config: groundConfig([process.execPath, '-e', GROUND_SCRIPT]),
  });
  const runId = await fx.launch();
  await waitParked(fx.paths, runId, 'second-zero-kill');
  const checks = readEvents(runLedgerPath(fx.paths, runId)).filter(
    (e) => e.event === 'ground-check',
  );
  assert.deepEqual(
    checks.map((e) => [e.phase, e.result]),
    [
      ['author', 'green'],
      ['strengthening', 'green'],
    ],
  );
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  await waitClosed(fx.paths, runId);
});

// -- acknowledging a gate that judges the world (ADR-0062) -------------------

test('an ack with a reason takes the run past a credential surface gate', async (t) => {
  // The key works on this host and every surface is wired when the door reads
  // them. The repository's secret is retired while the run is in flight, which
  // is exactly the shape that goes stale: the gap reads as a gap for the life
  // of the run, and no retry can move it.
  heldCredential(t, 'live');
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 3]) };
  let reads = 0;
  const fx = storyFixture(t, {
    seats,
    config: parityConfig(),
    files: { [WORKFLOW]: WIRED_WORKFLOW },
    ciSecrets: () => (reads++ === 0 ? [CI_SECRET] : []),
  });
  const runId = await fx.launch();
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  assert.deepEqual(park.answers.options, ['retry', 'ack', 'abandon']);
  assert.deepEqual(park.answers.reasoned, ['ack']);
  assert.equal(park.gate, 'credential-surface');
  assert.match(park.question, /Answer "ack" with --text/);
  // The reason is not optional, and the refusal names the forms.
  assert.throws(
    () => fx.daemon.engine.answer({ runId, actor: 'operator', option: 'ack' }),
    /--option ack takes the reason for it/,
  );

  fx.daemon.engine.answer({
    runId,
    actor: 'console:test',
    option: 'ack',
    answer: 'the payments workflow was retired on 2026-08-31',
  });
  // The run goes past the gate to the first seat, and the ledger says why.
  const stalled = await waitParked(fx.paths, runId, 'spec-gate-stalled');
  assert.ok(stalled.seq > park.seq);
  const live = readEvents(runLedgerPath(fx.paths, runId));
  const ack = live.find((e) => e.event === 'gate-acknowledged');
  assert.equal(ack.gate, 'credential-surface');
  assert.equal(ack.actor, 'console:test');
  assert.equal(ack.parkSeq, park.seq);
  assert.equal(ack.stage, 'readiness');
  assert.match(ack.reason, /retired on 2026-08-31/);
  // The ack answered that gate and no other: the probe behind it still ran,
  // and it still had to say yes before the first seat spawned.
  assert.equal(live.find((e) => e.event === 'credential-probe').ok, true);
  // The sweep ran again and found the same gap. It recorded it, named the ack
  // that let the run past, and stopped nothing.
  const surfaces = live.filter((e) => e.event === 'credential-surface');
  assert.equal(surfaces.length, 2);
  assert.equal(surfaces[0].ok, false);
  assert.equal(surfaces[0].acknowledged, undefined);
  assert.equal(surfaces[1].ok, false);
  assert.equal(surfaces[1].acknowledged, ack.seq);
  // One gate, one park: the acknowledgment stands for the run, so the second
  // read of the same gate never asked again.
  assert.equal(live.filter((e) => e.event === 'park' && e.type === 'provisioning-gate').length, 1);
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  await waitClosed(fx.paths, runId);
});

test('the credential probe gate names the credential it is about', async (t) => {
  // A probe verdict is the project's own command speaking, so the gate can be
  // as wrong as the command is. The key carries the credential, so an ack of
  // one probe is not an ack of another's. The gate is reached the way it is
  // reached in life: the value passed at the door, the service refused it
  // afterwards, and the run's own gate is what asks (ADR-0068).
  heldCredential(t, 'live');
  const seats = { 'spec-birth': amendingBirth(), 'spec-gate': gateFindings([3, 3]) };
  const fx = storyFixture(t, {
    seats,
    config: {
      commands: { probe: [process.execPath, '-e', REVOKING_PROBE_SCRIPT] },
      credentials: [{ name: 'payments', env: PROBE_VAR, probe: 'probe' }],
    },
  });
  const first = await fx.launch();
  await waitParked(fx.paths, first, 'spec-gate-stalled');
  heldVariable(t, BREAK_VAR, '1');
  const { runId } = await fx.daemon.launchRun({
    project: 'proj',
    lane: 'story',
    card: 'stories/alpha.md',
  });
  const park = await waitParked(fx.paths, runId, 'provisioning-gate');
  assert.equal(park.gate, 'credential-probe:payments');
  assert.deepEqual(park.answers.options, ['retry', 'ack', 'abandon']);
  fx.daemon.engine.answer({
    runId,
    actor: 'console:test',
    option: 'ack',
    answer: 'the probe command reads a retired endpoint',
  });
  await waitParked(fx.paths, runId, 'spec-gate-stalled');
  const live = readEvents(runLedgerPath(fx.paths, runId));
  assert.equal(live.find((e) => e.event === 'gate-acknowledged').gate, 'credential-probe:payments');
  const probes = live.filter((e) => e.event === 'credential-probe');
  assert.equal(probes.at(-1).ok, false);
  assert.ok(probes.at(-1).acknowledged > 0);
  fx.daemon.engine.answer({ runId, actor: 'operator', option: 'abandon' });
  await waitClosed(fx.paths, runId);
});
