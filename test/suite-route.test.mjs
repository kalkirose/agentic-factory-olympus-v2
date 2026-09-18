// The route a finding about a frozen pin takes (ADR-0094).
//
// A review seat that says the fix belongs in a frozen test used to have no way
// of saying so. The finding was confirmed, the confirmation made it a code
// finding, and a code finding goes to a seat that may not edit a test file.
// That seat reported the collision and the harness read none of it; the empty
// commit read as a moved tree and bought a review cycle over an identical diff;
// the same finding twice read as no progress and spent the run's one fresh
// pass.
//
// These tests pin the four joints of the route that replaced it: the field a
// review finding states its fix in and the shapes the round refuses, the claim
// run the harness makes before the verifier judges a claim, the stamps that say
// a repair round moved nothing, and the readings that keep such a round out of
// the progress rule and out of a cycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scaffoldHome } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { checkReportSchema } from '../src/seats/contract.mjs';
import { generalistReview, reviewSchema, suiteSets } from '../src/lanes/review.mjs';
import { runClaims, unprovenClaims } from '../src/lanes/claims.mjs';
import {
  CONFLICT_TRIAGE_SCHEMA,
  findingLine,
  interruptedStep,
  repairStalled,
} from '../src/lanes/verdict.mjs';
import { supersedeRuling } from '../src/lanes/supersede.mjs';
import { commitChanged } from '../src/isolation/tree.mjs';
import { ownedResolutions } from '../src/ledger/resolution.mjs';
import { tempDir, removeDir, initOriginRepo, commitTree, gitSync } from './helpers.mjs';

const OWN_TEST = 'tests/own.spec.ts';
const PINNED_TEST = 'tests/pinned.spec.ts';
const SECOND_PIN = 'tests/second.spec.ts';
const CODE_FILE = 'src/feature.mjs';

const CARD_QUOTE = 'The order confirmation sends a second email to the warehouse.';

/**
 * A repository whose tree holds one pin from an earlier story and one test this
 * run wrote. The base sha is the commit before the run's own write, which is
 * what tells the two apart.
 */
function repoFixture(t) {
  const root = tempDir('olympus-suiteroute-');
  const worktree = join(root, 'repo');
  initOriginRepo(worktree, {
    [PINNED_TEST]: 'test("pins one email", () => {});\n',
    [SECOND_PIN]: 'test("pins the receipt", () => {});\n',
    [CODE_FILE]: 'export const feature = 1;\n',
  });
  const baseSha = gitSync(['rev-parse', 'HEAD'], worktree).trim();
  commitTree(worktree, { [OWN_TEST]: 'test("this story", () => {});\n' }, 'suite');
  t.after(() => removeDir(root));
  return { root, worktree, baseSha };
}

/** A home with one open run, and a seat runner the test drives. */
function runFixture(t, reportFor) {
  const root = tempDir('olympus-suiteroutehome-');
  const paths = scaffoldHome(join(root, 'home'));
  mkdirSync(join(paths.runs, 'r1'), { recursive: true });
  const store = openRunStore(paths, 'r1');
  t.after(() => {
    store.close();
    removeDir(root);
  });
  const briefs = [];
  const ctx = {
    store,
    paths,
    runId: 'r1',
    briefs,
    runSeat: async ({ seat, roleBlock, reportPath, schema }) => {
      briefs.push({ seat, roleBlock, schema });
      const report = reportFor({ seat, roleBlock });
      if (report?.fail) {
        store.append('seat-failure', { actor: 'daemon', seat, reason: report.fail });
        return { ok: false, failed: true, reason: report.fail };
      }
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, JSON.stringify(report));
      store.append('seat-report', { actor: seat, seat, path: reportPath, attempt: 1 });
      return { ok: true, report };
    },
  };
  return { ctx, paths, store, briefs };
}

/** The lane base of a story-lane review round over the fixture repository. */
function storyBase(repo, overrides = {}) {
  return {
    config: {
      version: 1,
      commands: {},
      gates: { tier1: [] },
      lanes: { story: { suiteCommand: 'acceptance' } },
    },
    commands: {},
    layers: [],
    worktree: repo.worktree,
    env: undefined,
    constitution: null,
    specRef: 'spec.md',
    cardPath: 'card.md',
    uiPaths: [],
    lenses: ['spec', 'security'],
    testPaths: ['tests'],
    baseSha: repo.baseSha,
    frozenSuiteFiles: [PINNED_TEST, SECOND_PIN, OWN_TEST],
    frozenExclusions: [],
    ...overrides,
  };
}

/** One review finding, in the shape a code lens writes. */
function finding(overrides = {}) {
  return {
    lens: 'spec',
    severity: 'HIGH',
    ground: [CODE_FILE],
    finding: 'the guard is missing',
    evidence: `${CODE_FILE}:1`,
    fix: 'code',
    ...overrides,
  };
}

/** The claim four fields, as a seat states one. */
function claim(test = PINNED_TEST) {
  return {
    supersedes: test,
    supersedeAssertion: 'exactly one email is sent',
    supersedeQuote: CARD_QUOTE,
    supersedeClause: 'acceptance',
  };
}

const EMPTY_DIFF = { text: '', bytes: 0, files: 0, path: '/tmp/diff', partial: false };

/** The defect lines one refused round handed back to its seat. */
function refusals(store) {
  return store
    .events()
    .filter((e) => e.event === 'seat-refused')
    .flatMap((e) => e.defects ?? []);
}

// -- the field, and the shapes the round refuses -----------------------------

test('every review finding states where its fix lives, and the claim may ride it', () => {
  const schema = reviewSchema(['spec']);
  const item = schema.properties.findings.items;
  assert.deepEqual(item.required, ['lens', 'severity', 'ground', 'finding', 'evidence', 'fix']);
  assert.deepEqual(item.properties.fix.enum, ['code', 'suite']);
  // The claim rides in the same four fields every other site states one in.
  for (const key of ['supersedes', 'supersedeAssertion', 'supersedeQuote', 'supersedeClause']) {
    assert.ok(key in item.properties, key);
  }
  assert.deepEqual(checkReportSchema(schema), []);
});

test('the run tells its own frozen tests from an earlier story\'s pins', async (t) => {
  const repo = repoFixture(t);
  const sets = await suiteSets(storyBase(repo), 'story');
  assert.deepEqual([...sets.own], [OWN_TEST]);
  assert.ok(sets.frozen.has(PINNED_TEST));
  // A run with no base sha owns nothing, so every suite finding in it needs a
  // claim. That is the safe direction, and it is the one this answers.
  const blind = await suiteSets(storyBase(repo, { baseSha: null }), 'story');
  assert.equal(blind.own.size, 0);
  // The repair lane freezes no suite at all.
  assert.equal(await suiteSets(storyBase(repo), 'repair'), null);
});

test('a suite fix names one frozen test, and a claim names the same one', async (t) => {
  const repo = repoFixture(t);
  const cases = [
    {
      why: 'two frozen tests',
      finding: finding({ fix: 'suite', ground: [PINNED_TEST, SECOND_PIN], ...claim() }),
      match: /names 2 frozen tests/,
    },
    {
      why: 'no frozen test',
      finding: finding({ fix: 'suite', ground: [CODE_FILE] }),
      match: /names no frozen test of this run/,
    },
    {
      why: "an earlier story's pin with no claim",
      finding: finding({ fix: 'suite', ground: [PINNED_TEST] }),
      match: /an earlier story pinned and this run did not write/,
    },
    {
      why: 'a claim about another file',
      finding: finding({ fix: 'suite', ground: [PINNED_TEST], ...claim(SECOND_PIN) }),
      match: /the evidence would be about another/,
    },
    {
      why: 'a code fix grounded on frozen tests alone',
      finding: finding({ fix: 'code', ground: [PINNED_TEST] }),
      match: /its ground is frozen tests and nothing else/,
    },
  ];
  for (const one of cases) {
    const fx = runFixture(t, () => ({ findings: [one.finding], summary: 'x' }));
    const outcome = await generalistReview(fx.ctx, storyBase(repo), {
      cycle: 1,
      diff: EMPTY_DIFF,
      diffFiles: [],
      priorConfirmed: [],
      mode: 'story',
    });
    assert.ok(outcome.fail, one.why);
    assert.match(refusals(fx.store).join('\n'), one.match, one.why);
  }
});

test('a suite fix on the run\'s own test needs no claim, and the repair lane refuses none', async (t) => {
  const repo = repoFixture(t);
  const own = runFixture(t, ({ seat }) =>
    seat === 'fury-verifier'
      ? { results: [{ id: 'new-1', verdict: 'refuted', evidence: 'read' }], summary: 'x' }
      : { findings: [finding({ fix: 'suite', ground: [OWN_TEST] })], summary: 'x' },
  );
  const settled = await generalistReview(own.ctx, storyBase(repo), {
    cycle: 1,
    diff: EMPTY_DIFF,
    diffFiles: [],
    priorConfirmed: [],
    mode: 'story',
  });
  assert.ok(!settled.fail);
  assert.deepEqual(refusals(own.store), []);
  // The repair lane holds no frozen suite, so none of the rules fire and a
  // suite fix there is an ordinary edit.
  const repair = runFixture(t, ({ seat }) =>
    seat === 'fury-verifier'
      ? { results: [{ id: 'new-1', verdict: 'refuted', evidence: 'read' }], summary: 'x' }
      : { findings: [finding({ fix: 'suite', ground: [PINNED_TEST] })], summary: 'x' },
  );
  const lane = await generalistReview(repair.ctx, storyBase(repo), {
    cycle: 1,
    diff: EMPTY_DIFF,
    diffFiles: [],
    priorConfirmed: [],
    mode: 'repair',
  });
  assert.ok(!lane.fail);
  assert.deepEqual(refusals(repair.store), []);
  assert.equal(repair.store.events().some((e) => e.event === 'claim-run'), false);
});

// -- the stamp the route reads -----------------------------------------------

test('a confirmed suite fix is stamped as a suite defect with a derived depth', async (t) => {
  const repo = repoFixture(t);
  const fx = runFixture(t, ({ seat }) =>
    seat === 'fury-verifier'
      ? {
          results: [
            { id: 'new-1', verdict: 'confirmed', evidence: 'read' },
            { id: 'new-2', verdict: 'confirmed', evidence: 'read' },
          ],
          summary: 'x',
        }
      : {
          findings: [
            finding({ fix: 'suite', ground: [OWN_TEST] }),
            finding({ fix: 'suite', ground: [PINNED_TEST], ...claim() }),
          ],
          summary: 'x',
        },
  );
  const outcome = await generalistReview(fx.ctx, storyBase(repo), {
    cycle: 1,
    diff: EMPTY_DIFF,
    diffFiles: [],
    priorConfirmed: [],
    mode: 'story',
  });
  assert.ok(!outcome.fail);
  const stamped = fx.store.events().filter((e) => e.event === 'finding');
  assert.equal(stamped.length, 2);
  for (const e of stamped) assert.equal(e.class, 'suite-defect');
  // The run's own test mis-encodes the run's own spec: the suite seat amends it
  // and no card line is owed. An earlier story's pin is the card's to authorize.
  assert.equal(stamped[0].depth, 'test');
  assert.equal(stamped[0].supersede, undefined);
  assert.equal(stamped[1].depth, 'intent');
  assert.equal(stamped[1].supersede.test, PINNED_TEST);
  assert.equal(stamped[1].fix, 'suite');
});

test('the brief names the run\'s own frozen tests and the claim form', async (t) => {
  const repo = repoFixture(t);
  const fx = runFixture(t, () => ({ findings: [], summary: 'clean' }));
  await generalistReview(fx.ctx, storyBase(repo), {
    cycle: 1,
    diff: EMPTY_DIFF,
    diffFiles: [],
    priorConfirmed: [],
    mode: 'story',
  });
  const brief = fx.briefs[0].roleBlock;
  assert.match(brief, /Every finding states "fix"/);
  assert.ok(brief.includes(OWN_TEST), brief);
  assert.match(brief, /amended on the intent card's authority or not at all/);
});

// -- the claim run -----------------------------------------------------------

/** A suite command that prints the marker lines a narrowed runner prints. */
function markerCommand(lines) {
  return ['node', '-e', lines.map((l) => `console.log(${JSON.stringify(l)});`).join('')];
}

function claimBase(repo, lines) {
  return storyBase(repo, {
    commands: { acceptance: markerCommand(lines) },
    layers: [{ name: 'acceptance', command: 'acceptance' }],
  });
}

test('a claim run reads per file: red, green, and unselected', async (t) => {
  const repo = repoFixture(t);
  const fx = runFixture(t, () => ({ findings: [], summary: 'x' }));
  const base = claimBase(repo, [
    '::olympus part api',
    `::olympus files-selected api ${PINNED_TEST}`,
    '::olympus files-unselected api',
    `::olympus part-failed-files api ${PINNED_TEST}`,
    '::olympus part-failed api',
    '::olympus part browser',
    `::olympus files-selected browser ${OWN_TEST}`,
    `::olympus files-unselected browser ${SECOND_PIN}`,
    '::olympus part-ok browser',
  ]);
  const answers = await runClaims(fx.ctx, base, {
    cycle: 2,
    claims: [
      { item: 'new-1', file: PINNED_TEST },
      { item: 'new-2', file: OWN_TEST },
      { item: 'new-3', file: SECOND_PIN },
    ],
  });
  assert.equal(answers.get('new-1').result, 'red');
  // A claimed file whose own part passed and said it selected the file. One red
  // part never turns another part's files unselected: the reading is each
  // part's own word and never the run's exit code.
  assert.equal(answers.get('new-2').result, 'green');
  assert.equal(answers.get('new-2').part, 'browser');
  // A file the framework selected nothing for: the verifier's reading stands.
  assert.equal(answers.get('new-3').result, 'unselected');
  const events = fx.store.events();
  const started = events.find((e) => e.event === 'claim-started');
  assert.deepEqual(started.files, [PINNED_TEST, OWN_TEST, SECOND_PIN]);
  assert.deepEqual(started.items, ['new-1', 'new-2', 'new-3']);
  assert.equal(events.filter((e) => e.event === 'claim-run').length, 3);
  // The green one is the claim the run refuted, and the stamp carries it to a
  // later triage.
  assert.deepEqual(unprovenClaims(events).map((c) => c.file), [OWN_TEST]);
  // The log survives a green exit, because its selection line is the evidence.
  assert.match(readFileSync(started.log, 'utf8'), /files-selected/);
});

test('a round whose claims already ran reads the ledger and runs nothing', async (t) => {
  const repo = repoFixture(t);
  const fx = runFixture(t, () => ({ findings: [], summary: 'x' }));
  const base = claimBase(repo, ['::olympus part acceptance', '::olympus part-ok acceptance']);
  const claims = [{ item: 'new-1', file: PINNED_TEST }];
  await runClaims(fx.ctx, base, { cycle: 1, claims });
  const first = fx.store.events().filter((e) => e.event === 'claim-started').length;
  const again = await runClaims(fx.ctx, base, { cycle: 1, claims });
  assert.equal(fx.store.events().filter((e) => e.event === 'claim-started').length, first);
  assert.equal(again.get('new-1').result, 'unselected');
});

test('a claim the run turned green makes its finding advisory whatever the verifier says', async (t) => {
  const repo = repoFixture(t);
  const fx = runFixture(t, ({ seat }) =>
    seat === 'fury-verifier'
      ? { results: [{ id: 'new-1', verdict: 'confirmed', evidence: 'read' }], summary: 'x' }
      : { findings: [finding({ fix: 'suite', ground: [OWN_TEST] })], summary: 'x' },
  );
  const base = claimBase(repo, [
    '::olympus part acceptance',
    `::olympus files-selected acceptance ${OWN_TEST}`,
    '::olympus part-ok acceptance',
  ]);
  const outcome = await generalistReview(fx.ctx, base, {
    cycle: 1,
    diff: EMPTY_DIFF,
    diffFiles: [],
    priorConfirmed: [],
    mode: 'story',
  });
  assert.deepEqual(outcome.confirmed, []);
  const stamped = fx.store.events().find((e) => e.event === 'finding');
  assert.equal(stamped.advisory, true);
  assert.equal(stamped.confirmed, false);
  assert.equal(stamped.class, undefined);
  // The verifier judged the claim with the run in front of it.
  const verifier = fx.briefs.find((b) => b.seat === 'fury-verifier');
  assert.match(verifier.roleBlock, /ran GREEN/);
});

// -- a repair round that moved nothing ---------------------------------------

/** A ledger builder: appends in seq order, exactly as the store does. */
function ledger() {
  const events = [];
  let seq = 0;
  return {
    events,
    append(event, fields = {}) {
      const line = { seq: ++seq, event, ...fields };
      events.push(line);
      return line;
    },
  };
}

function render(log, { open = [], pass = 1, cycle = 1 } = {}) {
  return log.append('verdict-rendered', {
    cycle,
    pass,
    sha: 'sha-1',
    verdict: 'red',
    open,
    record: `verdict-${cycle}.json`,
  });
}

test('a repair round that moved nothing is a finished round for the resume', () => {
  const log = ledger();
  render(log);
  log.append('seat-spawned', { seat: 'repair-dev' });
  // Before the round reports, the stop left the step owed.
  assert.deepEqual(interruptedStep(log.events), { kind: 'repair-round' });
  log.append('repair-no-change', { pass: 1, sha: 'sha-1', conflicts: 1 });
  // After it, the round is over: a resume dispatches nothing. Without this the
  // seat would be paid again for the report it already wrote.
  assert.equal(interruptedStep(log.events), null);
  log.append('repair-round', { pass: 1, round: 1, changed: false, sha: 'sha-1' });
  assert.equal(interruptedStep(log.events), null);
});

test('the progress rule drops a no-change round a re-freeze answered', () => {
  const answered = ledger();
  answered.append('finding', { id: 'F1', source: 'triage', class: 'code-defect', summary: 'a', evidence: 'b' });
  render(answered, { open: ['F1'] });
  answered.append('repair-round', { pass: 1, round: 1, changed: false, sha: 'sha-1' });
  answered.append('re-freeze', { baseSha: 'sha-1', sha: 'sha-2', findings: ['F1'] });
  render(answered, { open: ['F1'], cycle: 2 });
  const renders = answered.events.filter((e) => e.event === 'verdict-rendered');
  // The round was never the thing that had to move the findings: the amendment
  // was, and it landed. Counting it spends the run's one fresh pass.
  assert.equal(repairStalled(answered.events, renders, renders[renders.length - 1]), false);

  const unanswered = ledger();
  unanswered.append('finding', { id: 'F1', source: 'triage', class: 'code-defect', summary: 'a', evidence: 'b' });
  render(unanswered, { open: ['F1'] });
  unanswered.append('repair-round', { pass: 1, round: 1, changed: false, sha: 'sha-1' });
  render(unanswered, { open: ['F1'], cycle: 2 });
  const second = unanswered.events.filter((e) => e.event === 'verdict-rendered');
  // A round that moved nothing and that nothing answered still counts: the seat
  // had its chance and took it.
  assert.equal(repairStalled(unanswered.events, second, second[second.length - 1]), true);
});

// -- the seat that judges a reported collision -------------------------------

test('the conflict-triage report shape is the triage shape without the spectrum fields', () => {
  assert.deepEqual(checkReportSchema(CONFLICT_TRIAGE_SCHEMA), []);
  const item = CONFLICT_TRIAGE_SCHEMA.properties.findings.items;
  assert.deepEqual(item.required, ['entry', 'class', 'summary', 'evidence']);
  assert.deepEqual(item.properties.class.enum, ['suite-defect', 'code-defect']);
  // No gate layer ran, so there is no layer to name and no probe to ask for.
  for (const key of ['layers', 'probe']) assert.ok(!(key in item.properties), key);
  assert.ok(!('persisting' in CONFLICT_TRIAGE_SCHEMA.properties));
});

test('a classed finding prints its class and depth, and a lens finding is unchanged', () => {
  assert.equal(
    findingLine({
      source: 'conflict-triage',
      class: 'suite-defect',
      depth: 'intent',
      summary: 'the pin asserts one email',
      evidence: `${PINNED_TEST}:4`,
    }),
    `[suite-defect intent] the pin asserts one email (evidence: ${PINNED_TEST}:4)`,
  );
  assert.equal(
    findingLine({
      source: 'review',
      lens: 'correctness',
      severity: 'HIGH',
      summary: 'the guard is missing',
      evidence: 'src/feature.mjs:12',
    }),
    '[correctness HIGH] the guard is missing (evidence: src/feature.mjs:12)',
  );
});

// -- the records the route leaves --------------------------------------------

test('the three routing alarms are answered by the run close and by no render', () => {
  const log = ledger();
  for (const kind of ['fresh-pass-suite-route', 'report-unconsumed', 'claim-unrun']) {
    log.append('gate-integrity', { kind, findings: ['F1'], gist: kind });
  }
  // A render that drops the finding must not close them: the render is the
  // moment each alarm is about.
  log.append('verdict-rendered', { cycle: 1, open: [], verdict: 'green' });
  assert.deepEqual(ownedResolutions(log.events), []);
  log.append('run-closed', { state: 'killed' });
  assert.deepEqual(
    ownedResolutions(log.events).map((o) => o.owner),
    ['run-closed', 'run-closed', 'run-closed'],
  );
});

test('a card ruling names the tests it is about', () => {
  const ruling = supersedeRuling([
    { seq: 9, test: PINNED_TEST, assertion: 'one email', cardQuote: CARD_QUOTE, clause: 'acceptance' },
    { seq: 10, test: SECOND_PIN, assertion: 'one receipt', cardQuote: CARD_QUOTE, clause: 'acceptance' },
  ]);
  assert.deepEqual(ruling.tests, [PINNED_TEST, SECOND_PIN]);
  assert.equal(ruling.source, 'card');
});

test('a suite write records what its own commit moved', async (t) => {
  const repo = repoFixture(t);
  const before = gitSync(['rev-parse', 'HEAD'], repo.worktree).trim();
  const after = commitTree(repo.worktree, { [PINNED_TEST]: 'test("pins two", () => {});\n' }, 'amend');
  assert.deepEqual(await commitChanged(repo.worktree, before, after), [PINNED_TEST]);
  // A write that committed nothing moved nothing, and says so without asking
  // git a question whose answer would be the empty range.
  assert.deepEqual(await commitChanged(repo.worktree, after, after), []);
});
