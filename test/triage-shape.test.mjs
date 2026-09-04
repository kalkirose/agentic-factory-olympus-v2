// The triage report shape, per cycle (ADR-0067). A first cycle has no prior
// findings, so its report has no field for them; a later cycle lists the open
// ids and requires the field. Every defect the checks raise states the rule
// beside the entry, so the corrective brief says what to write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { validateReport } from '../src/seats/contract.mjs';
import { TRIAGE_SCHEMA, triageSchema, triageStep } from '../src/lanes/verdict.mjs';
import { tempDir, removeDir } from './helpers.mjs';

const GREEN = ['node', '-e', 'process.exit(0)'];
const RED = ['node', '-e', 'console.log("boom"); process.exit(1)'];
const REDS = [{ layer: 'acceptance', status: 'red', output: 'boom' }];
const PRIOR = [
  { id: 'F1', class: 'code-defect', layers: ['acceptance'], summary: 'broken acceptance', evidence: 'x' },
  { id: 'F2', class: 'code-defect', layers: ['lint'], summary: 'broken lint', evidence: 'y' },
];

function fixture(t) {
  const root = tempDir('olympus-triage-shape-');
  const paths = scaffoldHome(join(root, 'home'));
  mkdirSync(join(paths.runs, 'r1'), { recursive: true });
  const store = openRunStore(paths, 'r1');
  t.after(() => {
    store.close();
    removeDir(root);
  });
  return { paths, ctx: { store, paths, runId: 'r1', probeCredentials: [], secretEnv: [] } };
}

function base() {
  return {
    config: {
      version: 1,
      commands: { suite: RED, lint: GREEN },
      gates: { tier1: [{ name: 'acceptance', command: 'suite' }, { name: 'lint', command: 'lint' }] },
      credentials: [],
    },
    worktree: process.cwd(),
    constitution: null,
    specRef: 'spec.md',
  };
}

/**
 * A seat seam that answers with the next report in the queue, writes it where
 * the contract expects it, and stamps `seat-report`. It records every brief and
 * every schema it was handed, which is what these tests read.
 */
function seatQueue(ctx, reports) {
  let index = 0;
  const calls = [];
  const runSeat = async ({ seat, roleBlock, reportPath, schema }) => {
    const report = reports[Math.min(index, reports.length - 1)];
    index++;
    calls.push({ seat, roleBlock, reportPath, schema });
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report));
    ctx.store.append('seat-report', { actor: seat, seat, path: reportPath, attempt: 1 });
    return { ok: true, report };
  };
  runSeat.calls = calls;
  return runSeat;
}

const finding = (layer = 'acceptance') => ({
  class: 'code-defect',
  layers: [layer],
  summary: `broken ${layer}`,
  evidence: `red output of ${layer}`,
});

// -- the schema per cycle ----------------------------------------------------

test('a first cycle has no persisting field; a later cycle requires it', () => {
  const first = triageSchema([]);
  assert.ok(!('persisting' in first.properties));
  assert.deepEqual(first.required, ['findings', 'summary']);
  assert.equal(first.additionalProperties, false);
  // The validator refuses the field in session, before any check reads it.
  const errors = validateReport(first, { findings: [finding()], persisting: [], summary: 's' });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.deepEqual(errors[0], { path: '$.persisting', message: 'unknown field' });
  assert.deepEqual(validateReport(first, { findings: [finding()], summary: 's' }), []);
  // A cycle with prior findings takes the full shape, unchanged.
  assert.equal(triageSchema(PRIOR), TRIAGE_SCHEMA);
  assert.ok(TRIAGE_SCHEMA.required.includes('persisting'));
  assert.equal(
    validateReport(TRIAGE_SCHEMA, { findings: [], summary: 's' }).length,
    1,
    'a later cycle without the field validates',
  );
});

// -- the brief per cycle -----------------------------------------------------

test('the first-cycle brief says every red is new, and the later brief lists the open ids verbatim', async (t) => {
  const { ctx } = fixture(t);
  ctx.runSeat = seatQueue(ctx, [{ findings: [finding()], summary: 'one' }]);
  const first = await triageStep(ctx, base(), { cycle: 1, reds: REDS, priorOpen: [] });
  assert.equal(first.fail, undefined);
  const brief = ctx.runSeat.calls[0].roleBlock;
  assert.match(brief, /This is a first cycle: no prior finding is open, so every red below is a new finding\./);
  assert.match(brief, /The report takes no "persisting" field on this cycle/);
  assert.ok(!brief.includes('Prior open findings'));
  assert.ok(!('persisting' in ctx.runSeat.calls[0].schema.properties));

  const { ctx: later } = fixture(t);
  later.runSeat = seatQueue(later, [{ findings: [], persisting: ['F1'], summary: 'still' }]);
  const second = await triageStep(later, base(), { cycle: 2, reds: REDS, priorOpen: PRIOR });
  assert.equal(second.fail, undefined);
  assert.deepEqual(second.open.map((f) => f.id), ['F1']);
  const laterBrief = later.runSeat.calls[0].roleBlock;
  assert.match(laterBrief, /"persisting" takes only ids from this list, verbatim:/);
  assert.match(laterBrief, /- \[F1\] /);
  assert.match(laterBrief, /- \[F2\] /);
  assert.ok(!laterBrief.includes('This is a first cycle'));
  assert.equal(later.runSeat.calls[0].schema, TRIAGE_SCHEMA);
});

// -- the checks name the rule ------------------------------------------------

test('a first-cycle report that carries the field is told to remove it, and the corrected round stands', async (t) => {
  const { ctx } = fixture(t);
  // The schema validator would have refused this in session; the check is the
  // rule's second reader, and it says the same thing in words.
  ctx.runSeat = seatQueue(ctx, [
    { findings: [finding()], persisting: [], summary: 'one' },
    { findings: [finding()], summary: 'one' },
  ]);
  const outcome = await triageStep(ctx, base(), { cycle: 1, reds: REDS, priorOpen: [] });
  assert.equal(outcome.fail, undefined);
  assert.equal(ctx.runSeat.calls.length, 2, 'one corrective round');
  assert.match(
    ctx.runSeat.calls[1].roleBlock,
    /the report carries a "persisting" field, and this cycle has no prior findings; remove the field and report every red as a new finding\./,
  );
  assert.ok(!readEvents(runLedgerPath(ctx.paths, 'r1')).some((e) => e.event === 'seat-failure'));
});

test('a later-cycle report naming an unknown id gets the open ids in its defect line', async (t) => {
  const { ctx } = fixture(t);
  ctx.runSeat = seatQueue(ctx, [
    { findings: [], persisting: ['F9'], summary: 'guess' },
    { findings: [], persisting: ['F1'], summary: 'right' },
  ]);
  const outcome = await triageStep(ctx, base(), { cycle: 2, reds: REDS, priorOpen: PRIOR });
  assert.equal(outcome.fail, undefined);
  assert.equal(ctx.runSeat.calls.length, 2);
  const brief = ctx.runSeat.calls[1].roleBlock;
  assert.match(
    brief,
    /persisting id F9 is not an open prior finding; "persisting" takes only ids from the open set, which is \[F1, F2\]\./,
  );
  // The uncovered red is named with the rule that covers it.
  assert.match(
    brief,
    /persistent red layer acceptance is covered by no finding; every red layer below is named in the "layers" of a new finding or of a persisting prior finding\./,
  );
});

test('a code finding whose only evidence is a signature is refused with the rule', async (t) => {
  const { ctx } = fixture(t);
  // The harness already read this red as a cause outside the tree and spent a
  // ladder of re-runs against it (ADR-0069). A code-defect finding that cites
  // nothing but the signature sends a repair seat to rewrite working code.
  ctx.store.append('layer-transient', {
    actor: 'daemon',
    cycle: 1,
    layer: 'acceptance',
    parts: ['api'],
    files: ['tests/api.test.mjs'],
    signatures: ['ECONNRESET'],
  });
  ctx.runSeat = seatQueue(ctx, [
    {
      findings: [
        {
          class: 'code-defect',
          layers: ['acceptance'],
          summary: 'the client drops the connection',
          evidence: 'Error: read ECONNRESET',
        },
      ],
      summary: 'wrong',
    },
    {
      findings: [
        {
          class: 'env',
          layers: ['acceptance'],
          summary: 'the host drops the connection',
          evidence: 'Error: read ECONNRESET',
        },
      ],
      summary: 'right',
    },
  ]);
  const outcome = await triageStep(ctx, base(), { cycle: 1, reds: REDS, priorOpen: [] });
  assert.equal(outcome.fail, undefined);
  assert.equal(ctx.runSeat.calls.length, 2, 'one corrective round');
  assert.match(
    ctx.runSeat.calls[1].roleBlock,
    /cites only a signature of a cause outside the tree \(ECONNRESET\); the harness re-ran these files after 1, 5 and 15 minutes/,
  );
  // The brief said so before the seat wrote anything, too.
  assert.match(ctx.runSeat.calls[0].roleBlock, /acceptance: ECONNRESET in api/);
  assert.equal(outcome.open[0].class, 'env');
});

test('an assertion beside the signature leaves a code finding standing', async (t) => {
  const { ctx } = fixture(t);
  ctx.store.append('layer-transient', {
    actor: 'daemon',
    cycle: 1,
    layer: 'acceptance',
    parts: ['api'],
    files: ['tests/api.test.mjs'],
    signatures: ['ECONNRESET'],
  });
  ctx.runSeat = seatQueue(ctx, [
    {
      findings: [
        {
          class: 'code-defect',
          layers: ['acceptance'],
          summary: 'the client retries wrongly',
          evidence: 'ECONNRESET, and AssertionError: expected 2 to equal 4',
        },
      ],
      summary: 'one',
    },
  ]);
  const outcome = await triageStep(ctx, base(), { cycle: 1, reds: REDS, priorOpen: [] });
  assert.equal(outcome.fail, undefined);
  assert.equal(ctx.runSeat.calls.length, 1, 'no corrective round');
  assert.equal(outcome.open[0].class, 'code-defect');
});

test('a finding on a green layer and a suite-defect without depth are refused with their rules', async (t) => {
  const { ctx } = fixture(t);
  ctx.runSeat = seatQueue(ctx, [
    {
      findings: [
        finding('ghost'),
        { class: 'suite-defect', layers: ['acceptance'], summary: 'the pin', evidence: 'z' },
      ],
      summary: 'wrong',
    },
    { findings: [finding()], summary: 'right' },
  ]);
  const outcome = await triageStep(ctx, base(), { cycle: 1, reds: REDS, priorOpen: [] });
  assert.equal(outcome.fail, undefined);
  const brief = ctx.runSeat.calls[1].roleBlock;
  assert.match(
    brief,
    /the finding "broken ghost" names the layer ghost, which is not a persistent red; a finding names only red layers, which are \[acceptance\]\./,
  );
  assert.match(
    brief,
    /the suite-defect finding "the pin" carries no depth; a suite-defect finding takes "depth": "test", "spec" or "intent"\./,
  );
});
