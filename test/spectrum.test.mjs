// The Tier-1 spectrum runner: not-runnable attribution follows the needs
// chain to the root red; the flake filter re-runs red layers once and stamps
// flakes instead of findings; stamped layers are never re-run. A red layer
// that ran in parts records the failing part under its name. The cycle plan
// decides what a cycle runs and what it carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import {
  runSpectrum,
  persistentReds,
  cyclePlan,
  groundedLayers,
  priorStatus,
  targetedLayers,
  SWEEP_REASONS,
  assertSweepReason,
} from '../src/lanes/spectrum.mjs';
// The four conditions that arm the footprint are read off a project config and
// the instance ledger, and they decide which plan this module returns, so they
// are asserted beside it.
import { certifiedFootprint } from '../src/lanes/verdict.mjs';
import { confirmationTally } from '../src/lanes/parts.mjs';
import { openInstanceStore } from '../src/telemetry/stores.mjs';
import { tempDir, removeDir, initOriginRepo, commitTree, gitSync } from './helpers.mjs';

/** One base certification of the test project, holding every layer green. */
function certifyBase(paths, sha) {
  const store = openInstanceStore(paths);
  const line = store.append('base-certified', {
    actor: 'daemon',
    project: 'p',
    runId: 'r0',
    sha,
    layers: FOOTPRINT.map((layer) => ({
      name: layer.name,
      status: 'green',
      elapsedMs: 1000,
      mode: 'run',
      verdict: 'verdict-1.json',
    })),
  });
  store.close();
  return line;
}

const GREEN = ['node', '-e', 'process.exit(0)'];
const RED = ['node', '-e', 'process.exit(1)'];

function fixture(t) {
  const root = tempDir();
  const paths = scaffoldHome(join(root, 'home'));
  mkdirSync(join(paths.runs, 'r1'), { recursive: true });
  const store = openRunStore(paths, 'r1');
  t.after(() => {
    store.close();
    removeDir(root);
  });
  return { root, ctx: { store, paths, runId: 'r1' } };
}

function events(ctx) {
  return readEvents(runLedgerPath(ctx.paths, ctx.runId));
}

/**
 * What the spectrum decided about each layer, with what the layer cost the
 * machine taken off. The peak of a process tree is an additive fact about the
 * host and it is asserted where it belongs (ADR-0045); these tests are about
 * the decisions, and a reading that varies by machine is not one.
 */
function decided(results) {
  return results.map(({ resources, exhaustion, ...decision }) => decision);
}

test('a not-runnable layer attributes to the root red through the needs chain', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, {
    layers: [
      { name: 'a', command: 'red' },
      { name: 'b', command: 'green', needs: ['a'] },
      { name: 'c', command: 'green', needs: ['b'] },
      { name: 'd', command: 'green' },
    ],
    commands: { red: RED, green: GREEN },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  });
  assert.deepEqual(
    results.map((r) => [r.layer, r.status, r.mode, r.attributedTo]),
    [
      ['a', 'red', 'run', undefined],
      ['b', 'not-runnable', 'run', 'a'],
      ['c', 'not-runnable', 'run', 'a'],
      ['d', 'green', 'run', undefined],
    ],
  );
  assert.deepEqual(persistentReds(results).map((r) => r.layer), ['a']);
  // The red layer carries its output tail; the re-run confirmed the red.
  const stamped = events(ctx).filter((e) => e.event === 'layer-result');
  assert.equal(stamped.length, 4);
  assert.ok(!events(ctx).some((e) => e.event === 'flake'));
});

// -- a layer that runs in parts ----------------------------------------------

/** A command that says where its parts begin, in the protocol exec.mjs reads. */
function partsCmd(lines) {
  return ['node', '-e', lines.map((line) => `console.log(${JSON.stringify(line)});`).join('') + 'process.exit(1);'];
}

// The middle part fails, and the part after it prints more than the tail holds.
const SEQUENCE = [
  '::olympus part preflight',
  'preflight clean',
  '::olympus part unit suite',
  'AssertionError: expected 4 to equal 5',
  '::olympus part-failed unit suite',
  '::olympus part e2e suite',
  'e2e green'.padEnd(4000, '.'),
];

test('a red layer that ran in parts records the failing part with its own output', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'sequence' }],
    commands: { sequence: partsCmd(SEQUENCE) },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  });
  const [red] = results;
  assert.equal(red.status, 'red');
  // The whole part table is recorded; the output rides the failing part alone.
  assert.deepEqual(
    red.parts.map((p) => [p.name, p.status, p.output !== undefined]),
    [
      ['preflight', 'unknown', false],
      ['unit suite', 'red', true],
      ['e2e suite', 'unknown', false],
    ],
  );
  assert.match(red.parts[1].output, /expected 4 to equal 5/);
  // The failing part is in the middle, so the tail alone is the part after it.
  assert.ok(!red.output.includes('expected 4 to equal 5'), 'the tail held the failure after all');
  assert.match(red.output, /\.\.\./);
  // The record carries what the results carry, and no marker line survives it.
  const stamped = events(ctx).find((e) => e.event === 'layer-result');
  assert.deepEqual(stamped.parts, red.parts);
  assert.ok(!stamped.parts[1].output.includes('::olympus'));
  assert.ok(!stamped.output.includes('::olympus'));
});

test('a command that opens parts but names no failure records every part', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'sequence' }],
    commands: { sequence: partsCmd(SEQUENCE.filter((line) => !line.startsWith('::olympus part-failed'))) },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  });
  assert.deepEqual(
    results[0].parts.map((p) => p.name),
    ['preflight', 'unit suite', 'e2e suite'],
  );
  assert.match(results[0].parts[1].output, /expected 4 to equal 5/);
});

test('a red layer whose command surfaces no parts records the tail alone', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'silent' }],
    commands: { silent: ['node', '-e', "console.log('boom');process.exit(1);"] },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  });
  assert.equal(results[0].parts, undefined);
  const stamped = events(ctx).find((e) => e.event === 'layer-result');
  assert.equal(stamped.parts, undefined);
  assert.match(stamped.output, /boom/);
  // The whole stream is in the record, so nothing is missing and the record
  // names no defect.
  assert.equal(stamped.kind, undefined);
});

test('a red whose stream outgrew the tail names the file that holds all of it', async (t) => {
  // The class the per-part protocol was written for, closed at the primitive:
  // a long stream with no part markers still leaves the record holding a tail,
  // and the whole of it is in the file the record names. Nothing is missing,
  // so nothing is a defect.
  const { ctx } = fixture(t);
  // The exit is `process.exitCode`: a child that calls `process.exit` loses
  // whatever the pipe has not taken yet, and this one is asserted whole.
  const long = [
    'node',
    '-e',
    `console.log('x'.repeat(9000));console.log('THE FAILURE');process.exitCode=1;`,
  ];
  await runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'long' }],
    commands: { long },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  });
  const stamped = events(ctx).find((e) => e.event === 'layer-result');
  assert.equal(stamped.status, 'red');
  assert.equal(stamped.parts, undefined);
  assert.equal(stamped.kind, undefined);
  assert.ok(existsSync(stamped.log), 'the red left no file to read');
  const held = readFileSync(stamped.log, 'utf8');
  assert.ok(held.length > 9000, 'the file holds no more than the tail did');
  assert.match(held, /THE FAILURE/);
});

test('a red whose file the cap cut names the file and the defect both', async (t) => {
  // The one reading of `layer-log-truncated` left: the harness cannot produce
  // the output, because the command outgrew the file's own cap. A cap is not
  // reachable through the spectrum's own options, so the outcome is staged at
  // the command seam.
  const { ctx } = fixture(t);
  const capped = async () => ({
    code: 1,
    output: 'x'.repeat(9000),
    truncated: true,
    parts: [],
    log: { path: join(ctx.paths.runs, 'r1', 'commands', 'capped.log'), bytes: 10, truncated: true },
  });
  await runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'long' }],
    commands: { long: RED },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
    exec: capped,
  });
  const stamped = events(ctx).find((e) => e.event === 'layer-result');
  assert.equal(stamped.kind, 'layer-log-truncated');
  assert.match(stamped.log, /capped\.log$/, 'the record dropped the evidence it does hold');
});

test('a green layer leaves no file behind, and its record names none', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'talks' }],
    commands: { talks: ['node', '-e', `console.log('y'.repeat(9000));process.exit(0);`] },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  });
  assert.equal(results[0].status, 'green');
  const stamped = events(ctx).find((e) => e.event === 'layer-result');
  assert.equal(stamped.log, undefined);
  assert.deepEqual(readdirSync(join(ctx.paths.runs, 'r1', 'commands')), []);
});

test('the red the flake filter replaced keeps its own file, under its own attempt', async (t) => {
  const { root, ctx } = fixture(t);
  const marker = join(root, 'flake-marker-log');
  const flaky = [
    'node',
    '-e',
    `const fs=require('fs');const p=${JSON.stringify(marker)};` +
      `if(fs.existsSync(p)){console.log('the green re-run');process.exit(0);}` +
      `fs.writeFileSync(p,'x');console.log('THE FIRST RED');process.exit(1);`,
  ];
  await runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'flaky' }],
    commands: { flaky },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  });
  const abandoned = events(ctx).find((e) => e.event === 'layer-abandoned');
  assert.equal(abandoned.reason, 'superseded-by-rerun');
  assert.match(readFileSync(abandoned.log, 'utf8'), /THE FIRST RED/);
  // The green that replaced it took its own file with it.
  assert.deepEqual(readdirSync(join(ctx.paths.runs, 'r1', 'commands')), [
    'c1-acceptance-a1.log',
  ]);
});

test('a red that named its failing part carries the evidence, and no defect', async (t) => {
  // The same long stream, with the parts protocol in it. The failing part is
  // recorded under its own name, so the record holds the failure and there is
  // no defect to name.
  const { ctx } = fixture(t);
  await runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'sequence' }],
    commands: { sequence: partsCmd(SEQUENCE) },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  });
  const stamped = events(ctx).find((e) => e.event === 'layer-result');
  assert.deepEqual(
    stamped.parts.filter((p) => p.output !== undefined).map((p) => p.name),
    ['unit suite'],
  );
  assert.equal(stamped.kind, undefined);
});

test('a red that turns green on the re-run stamps a flake, never a finding', async (t) => {
  const { root, ctx } = fixture(t);
  const marker = join(root, 'flake-marker');
  const flaky = [
    'node',
    '-e',
    `const fs=require('fs');const p=${JSON.stringify(marker)};` +
      `if(fs.existsSync(p))process.exit(0);fs.writeFileSync(p,'x');process.exit(1);`,
  ];
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'flaky', command: 'flaky' }],
    commands: { flaky },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  });
  assert.deepEqual(decided(results), [{ layer: 'flaky', status: 'green', mode: 'run' }]);
  const flakes = events(ctx).filter((e) => e.event === 'flake');
  assert.equal(flakes.length, 1);
  assert.equal(flakes[0].layer, 'flaky');
  assert.equal(flakes[0].cycle, 1);
});

test('every layer execution says when it started, the flake re-run included', async (t) => {
  const { root, ctx } = fixture(t);
  const marker = join(root, 'started-marker');
  const flaky = [
    'node',
    '-e',
    `const fs=require('fs');const p=${JSON.stringify(marker)};` +
      `if(fs.existsSync(p))process.exit(0);fs.writeFileSync(p,'x');process.exit(1);`,
  ];
  await runSpectrum(ctx, {
    layers: [
      { name: 'flaky', command: 'flaky' },
      { name: 'green', command: 'green' },
      { name: 'blocked', command: 'green', needs: ['flaky'] },
    ],
    commands: { flaky, green: GREEN },
    cwd: process.cwd(),
    cycle: 3,
    sha: 'sha3',
  });
  const started = events(ctx).filter((e) => e.event === 'layer-started');
  assert.deepEqual(
    started.map((e) => [e.layer, e.attempt, e.cycle, e.sha]),
    [
      ['flaky', 1, 3, 'sha3'],
      ['flaky', 2, 3, 'sha3'],
      ['green', 1, 3, 'sha3'],
      ['blocked', 1, 3, 'sha3'],
    ],
  );
  // The stamp says when, and it lands before the result it belongs to.
  assert.ok(started.every((e) => typeof e.ts === 'string' && e.ts.endsWith('Z')));
  const flakyResult = events(ctx).find((e) => e.event === 'layer-result' && e.layer === 'flaky');
  assert.ok(started[1].seq < flakyResult.seq);
});

test('a layer nothing executes stamps no start: carried greens and stamped layers', async (t) => {
  const { ctx } = fixture(t);
  ctx.store.append('layer-result', { actor: 'daemon', cycle: 1, layer: 'a', status: 'green', sha: 's' });
  const prior = new Map([['b', { layer: 'b', status: 'green', cycle: 1, sha: 's' }]]);
  await runSpectrum(ctx, {
    layers: [
      { name: 'a', command: 'green' },
      { name: 'b', command: 'green' },
      { name: 'c', command: 'green' },
    ],
    commands: { green: GREEN },
    cwd: process.cwd(),
    cycle: 1,
    sha: 's',
    run: new Set(['c']),
    prior,
  });
  assert.deepEqual(
    events(ctx)
      .filter((e) => e.event === 'layer-started')
      .map((e) => e.layer),
    ['c'],
  );
});

test('a stamped layer is never re-run in the same cycle', async (t) => {
  const { root, ctx } = fixture(t);
  ctx.store.append('layer-result', { actor: 'daemon', cycle: 1, layer: 'a', status: 'green', sha: 's' });
  const boom = join(root, 'boom-marker');
  const tattling = [
    'node',
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(boom)},'x');process.exit(1);`,
  ];
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'a', command: 'tattling' }],
    commands: { tattling },
    cwd: process.cwd(),
    cycle: 1,
    sha: 's',
  });
  assert.deepEqual(decided(results), [{ layer: 'a', status: 'green', mode: 'run' }]);
  assert.ok(!existsSync(boom), 'the stamped layer ran again');
});

test('the run env reaches every layer command', async (t) => {
  const { root, ctx } = fixture(t);
  const capture = join(root, 'layer-env.json');
  const probe = [
    'node',
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(capture)},` +
      `JSON.stringify({p:process.env.COMPOSE_PROJECT_NAME,s:process.env.OLY_STATIC}));process.exit(0)`,
  ];
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'a', command: 'probe' }],
    commands: { probe },
    cwd: process.cwd(),
    env: { COMPOSE_PROJECT_NAME: 'oly-r1', OLY_STATIC: 'static-1' },
    cycle: 1,
    sha: 's',
  });
  assert.deepEqual(decided(results), [{ layer: 'a', status: 'green', mode: 'run' }]);
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), { p: 'oly-r1', s: 'static-1' });
});

// -- what the flake filter's re-run asks for ---------------------------------
//
// The re-run buys the failure and nothing else: the parts the replaced attempt
// did not pass, and the files those parts named. The parts it passed ride the
// second attempt's record, so the merged table is one complete answer at one
// sha with the attempt behind every line of it.

/**
 * A command that runs its parts in the marker protocol, honours both
 * narrowings, and writes down what each invocation really ran — part by part
 * and file by file. Its first invocation fails the files it is told to fail
 * and every later one passes, which is a flake exactly.
 *
 * `nameFiles: false` fails without saying which files did, which is the runner
 * that has not adopted the line, or one whose framework changed its summary.
 */
function narrowingCmd(logFile, table, { nameFiles = true, alwaysRed = false } = {}) {
  const body = [
    "const fs = require('fs');",
    `const table = ${JSON.stringify(table)};`,
    `const log = ${JSON.stringify(logFile)};`,
    'const first = !fs.existsSync(log);',
    "const only = (process.env.OLYMPUS_PARTS || '').split(',').filter(Boolean);",
    'const narrow = new Map();',
    "for (const entry of (process.env.OLYMPUS_FAILED_FILES || '').split(';')) {",
    "  const at = entry.indexOf('=');",
    '  if (at <= 0) continue;',
    "  const paths = entry.slice(at + 1).split(',').filter(Boolean);",
    '  if (paths.length > 0) narrow.set(entry.slice(0, at), paths);',
    '}',
    'const ran = [];',
    'let bad = 0;',
    'for (const part of table) {',
    '  if (only.length > 0 && !only.includes(part.name)) continue;',
    '  const asked = narrow.get(part.name);',
    '  const files = asked ? part.files.filter((f) => asked.includes(f)) : part.files;',
    "  ran.push(part.name + ':' + files.join('+'));",
    "  console.log('::olympus part ' + part.name);",
    "  console.log('::olympus part-inputs ' + part.inputs.join(' '));",
    "  console.log(part.name + ' ran ' + files.join('+'));",
    `  const red = (first || ${alwaysRed}) ? files.filter((f) => part.red.includes(f)) : [];`,
    '  if (red.length > 0) {',
    ...(nameFiles
      ? ["    console.log('::olympus part-failed-files ' + part.name + ' ' + red.join(','));"]
      : []),
    "    console.log('::olympus part-failed ' + part.name);",
    '    bad = 1;',
    '  } else {',
    "    console.log('::olympus part-ok ' + part.name);",
    '  }',
    '}',
    "fs.appendFileSync(log, JSON.stringify(ran) + '\\n');",
    'process.exitCode = bad;',
  ].join('\n');
  return ['node', '-e', body];
}

const NARROW_TABLE = [
  { name: 'alpha', inputs: ['apps/alpha'], files: ['a1', 'a2'], red: ['a1'] },
  { name: 'beta', inputs: ['apps/beta'], files: ['b1'], red: [] },
];

function ranOf(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function narrowed(t, table, opts = {}) {
  const { root, ctx } = fixture(t);
  const log = join(root, 'ran.log');
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'parts' }],
    commands: { parts: narrowingCmd(log, table, opts) },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
    ...(opts.flakeRerun && { flakeRerun: opts.flakeRerun }),
  });
  return { ctx, results, ran: ranOf(log) };
}

test('the re-run asks for the parts that failed and for the files they named', async (t) => {
  const { ctx, results, ran } = await narrowed(t, NARROW_TABLE);
  // The first attempt ran everything; the re-run bought one file of one part.
  assert.deepEqual(ran, [['alpha:a1+a2', 'beta:b1'], ['alpha:a1']]);
  assert.equal(results[0].status, 'green');
  assert.deepEqual(results[0].narrowedTo, { parts: ['alpha'], files: 1 });
  // One complete part table at this sha, and every part names the attempt
  // that earned it. Nothing in it is carried: both greens are of this sha.
  assert.deepEqual(
    results[0].parts.map((p) => [p.name, p.status, p.attempt, p.carriedFrom]),
    [
      ['alpha', 'green', 2, undefined],
      ['beta', 'green', 1, undefined],
    ],
  );
  const stamped = events(ctx).filter((e) => e.event === 'layer-result');
  assert.deepEqual(stamped[0].parts, results[0].parts);
  assert.equal(stamped[0].narrowedTo.files, 1);
  // A green re-run is still a flake, and the replaced attempt still says so.
  assert.equal(events(ctx).filter((e) => e.event === 'flake').length, 1);
  assert.equal(
    events(ctx).find((e) => e.event === 'layer-abandoned').reason,
    'superseded-by-rerun',
  );
});

test('a part that named no failing file re-runs whole', async (t) => {
  const { results, ran } = await narrowed(t, NARROW_TABLE, { nameFiles: false });
  // The part still narrows to itself — the green beside it is proven — but it
  // buys every file of itself, because nothing said which one failed.
  assert.deepEqual(ran, [['alpha:a1+a2', 'beta:b1'], ['alpha:a1+a2']]);
  assert.deepEqual(results[0].narrowedTo, { parts: ['alpha'], files: 0 });
});

test('a layer whose parts all failed re-runs whole, and says it narrowed nothing', async (t) => {
  const table = [
    { name: 'alpha', inputs: ['apps/alpha'], files: ['a1'], red: ['a1'] },
    { name: 'beta', inputs: ['apps/beta'], files: ['b1'], red: ['b1'] },
  ];
  const { results, ran } = await narrowed(t, table, { nameFiles: false });
  assert.deepEqual(ran, [['alpha:a1', 'beta:b1'], ['alpha:a1', 'beta:b1']]);
  assert.equal(results[0].narrowedTo, undefined);
  assert.deepEqual(results[0].parts.map((p) => p.attempt), [undefined, undefined]);
});

test('a layer that named no part at all is left exactly as it was', async (t) => {
  const { root, ctx } = fixture(t);
  const log = join(root, 'env.log');
  const silent = [
    'node',
    '-e',
    `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify([` +
      "process.env.OLYMPUS_PARTS || '', process.env.OLYMPUS_FAILED_FILES || '']) + '\\n');" +
      "console.log('boom');process.exit(1);",
  ];
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'silent' }],
    commands: { silent },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  });
  // Two attempts, and neither was narrowed by anything.
  assert.deepEqual(ranOf(log), [['', ''], ['', '']]);
  assert.equal(results[0].narrowedTo, undefined);
  assert.equal(results[0].parts, undefined);
});

test('gates.flakeRerun "whole" runs the layer again, exactly as it did before', async (t) => {
  const { results, ran } = await narrowed(t, NARROW_TABLE, { flakeRerun: 'whole' });
  assert.deepEqual(ran, [
    ['alpha:a1+a2', 'beta:b1'],
    ['alpha:a1+a2', 'beta:b1'],
  ]);
  assert.equal(results[0].narrowedTo, undefined);
  assert.deepEqual(
    results[0].parts.map((p) => [p.name, p.status, p.attempt]),
    [
      ['alpha', 'green', undefined],
      ['beta', 'green', undefined],
    ],
  );
});

test('a narrowed re-run that stays red is the layer answer, with the failure on it', async (t) => {
  const { results, ran } = await narrowed(t, NARROW_TABLE, { alwaysRed: true });
  assert.deepEqual(ran, [['alpha:a1+a2', 'beta:b1'], ['alpha:a1']]);
  assert.equal(results[0].status, 'red');
  assert.deepEqual(
    results[0].parts.map((p) => [p.name, p.status, p.attempt]),
    [
      ['alpha', 'red', 2],
      ['beta', 'green', 1],
    ],
  );
  // The red part is the evidence of the red layer; the kept green prints
  // nothing, because it printed nothing in this attempt.
  assert.match(results[0].parts[0].output, /alpha ran a1/);
  assert.equal(results[0].parts[1].output, undefined);
});

test('a confirmation whose own re-run narrows keeps the word that says who ran what', async (t) => {
  const { root, ctx } = fixture(t);
  const log = join(root, 'ran.log');
  // A result of this cycle that ran one part and carried two. The sweep buys
  // the two, its first attempt fails one of them, and its re-run buys that one.
  ctx.store.append('layer-result', {
    actor: 'daemon',
    cycle: 1,
    layer: 'acceptance',
    status: 'green',
    sha: 'sha1',
    attempt: 1,
    parts: [
      { name: 'alpha', status: 'green', reason: 'touched' },
      { name: 'beta', status: 'green', carriedFrom: 1 },
      { name: 'gamma', status: 'green', carriedFrom: 1 },
    ],
  });
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'acceptance', command: 'parts' }],
    commands: {
      parts: narrowingCmd(log, [
        { name: 'alpha', inputs: ['apps/alpha'], files: ['a1'], red: [] },
        { name: 'beta', inputs: ['apps/beta'], files: ['b1'], red: [] },
        { name: 'gamma', inputs: ['apps/gamma'], files: ['g1'], red: ['g1'] },
      ]),
    },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
    confirmation: true,
  });
  assert.deepEqual(ranOf(log), [['beta:b1', 'gamma:g1'], ['gamma:g1']]);
  assert.deepEqual(results[0].narrowedTo, { parts: ['gamma'], files: 1 });
  // Both parts the sweep bought say so, whichever of its attempts bought them,
  // and the part it kept from the pass before it says which pass that was.
  assert.deepEqual(
    results[0].parts.map((p) => [p.name, p.confirmation === true, p.attempt, p.carriedFrom]),
    [
      ['gamma', true, 2, undefined],
      ['alpha', false, 1, undefined],
      ['beta', true, 1, undefined],
    ],
  );
  assert.deepEqual(confirmationTally(results), { ran: 2, kept: 1 });
});

// -- the cycle plan ----------------------------------------------------------

const CHAIN = [
  { name: 'a', command: 'green' },
  { name: 'b', command: 'green', needs: ['a'] },
  { name: 'c', command: 'green', needs: ['b'] },
  { name: 'd', command: 'green' },
];

function priorOf(entries) {
  return new Map(Object.entries(entries).map(([layer, status]) => [layer, { layer, status }]));
}

test('the targeted set takes a red and everything downstream of it, transitively', () => {
  const target = targetedLayers(
    CHAIN,
    priorOf({ a: 'red', b: 'not-runnable', c: 'not-runnable', d: 'green' }),
  );
  assert.deepEqual([...target].sort(), ['a', 'b', 'c']);
});

test('a red reaches its transitive dependents even where they were judged green', () => {
  // b and c ran green against the a of an earlier cycle. That a has changed,
  // so their greens judge a tree that no longer exists.
  const target = targetedLayers(CHAIN, priorOf({ a: 'red', b: 'green', c: 'green', d: 'green' }));
  assert.deepEqual([...target].sort(), ['a', 'b', 'c']);
});

test('a green with no red upstream stays out of the targeted set; an unjudged layer never does', () => {
  assert.deepEqual([...targetedLayers(CHAIN, priorOf({ a: 'green', b: 'green', c: 'green', d: 'red' }))], ['d']);
  // A layer the ledger has never judged has no green to carry.
  assert.deepEqual(
    [...targetedLayers(CHAIN, priorOf({ a: 'green', b: 'green', c: 'green' }))].sort(),
    ['d'],
  );
});

test('the standing status of a layer is its last stamp, however many cycles ago', () => {
  const events = [
    { event: 'layer-result', cycle: 1, layer: 'a', status: 'green' },
    { event: 'layer-result', cycle: 1, layer: 'b', status: 'red' },
    { event: 'layer-result', cycle: 2, layer: 'b', status: 'green' },
    { event: 'layer-result', cycle: 3, layer: 'b', status: 'red' },
  ];
  const prior = priorStatus(events, 3);
  assert.equal(prior.get('a').status, 'green');
  assert.equal(prior.get('b').status, 'green');
  // The stamps of the cycle being planned never reach the plan.
  assert.equal(priorStatus(events, 4).get('b').status, 'red');
});

test('a pass runs its first cycle full and its later cycles targeted', () => {
  const events = [
    { event: 'implementation-committed', pass: 1 },
    { event: 'layer-result', cycle: 1, layer: 'a', status: 'red' },
    { event: 'layer-result', cycle: 1, layer: 'b', status: 'not-runnable' },
    { event: 'layer-result', cycle: 1, layer: 'c', status: 'not-runnable' },
    { event: 'layer-result', cycle: 1, layer: 'd', status: 'green' },
  ];
  // Cycle 1: no render behind it, so nothing is proven.
  assert.deepEqual(cyclePlan(events, { cycle: 1, pass: 1, layers: CHAIN }), { sweep: 'full' });
  const rendered = [...events, { event: 'verdict-rendered', cycle: 1, pass: 1, verdict: 'red' }];
  const plan = cyclePlan(rendered, { cycle: 2, pass: 1, layers: CHAIN });
  assert.equal(plan.sweep, 'targeted');
  assert.deepEqual([...plan.run].sort(), ['a', 'b', 'c']);
  // A fresh pass judges a tree the run has never seen.
  assert.deepEqual(cyclePlan(rendered, { cycle: 2, pass: 2, layers: CHAIN }), { sweep: 'full' });
  // A CI red names no Tier-1 layer of this tree, so it targets nothing.
  const ci = [...rendered, { event: 'verdict-rendered', cycle: 2, pass: 1, source: 'ci', verdict: 'red' }];
  assert.deepEqual(cyclePlan(ci, { cycle: 3, pass: 1, layers: CHAIN }), {
    sweep: 'full',
    reason: 'ci-red',
  });
});

test('a restart mid-cycle derives the same targeted set', () => {
  const events = [
    { event: 'implementation-committed', pass: 1 },
    { event: 'layer-result', cycle: 1, layer: 'a', status: 'red' },
    { event: 'layer-result', cycle: 1, layer: 'b', status: 'not-runnable' },
    { event: 'layer-result', cycle: 1, layer: 'c', status: 'not-runnable' },
    { event: 'layer-result', cycle: 1, layer: 'd', status: 'green' },
    { event: 'verdict-rendered', cycle: 1, pass: 1, verdict: 'red' },
  ];
  const before = cyclePlan(events, { cycle: 2, pass: 1, layers: CHAIN });
  // The daemon died after cycle 2 judged a green and a red of its own.
  const midCycle = [
    ...events,
    { event: 'layer-result', cycle: 2, layer: 'a', status: 'green' },
    { event: 'layer-result', cycle: 2, layer: 'b', status: 'red' },
  ];
  const after = cyclePlan(midCycle, { cycle: 2, pass: 1, layers: CHAIN });
  assert.equal(after.sweep, before.sweep);
  assert.deepEqual([...after.run].sort(), [...before.run].sort());
});

test('a layer outside the run set carries its green forward without running', async (t) => {
  const { root, ctx } = fixture(t);
  const boom = join(root, 'carried-marker');
  const tattling = [
    'node',
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(boom)},'x');process.exit(1);`,
  ];
  const { results } = await runSpectrum(ctx, {
    layers: [
      { name: 'a', command: 'green' },
      { name: 'carried', command: 'tattling' },
      { name: 'unjudged', command: 'green' },
    ],
    commands: { green: GREEN, tattling },
    cwd: process.cwd(),
    cycle: 2,
    sha: 'sha2',
    run: new Set(['a']),
    prior: priorOf({ a: 'red', carried: 'green' }),
  });
  assert.deepEqual(
    results.map((r) => [r.layer, r.status, r.mode]),
    [
      ['a', 'green', 'run'],
      ['carried', 'green', 'carried'],
      // Outside the run set, but with no proven green to carry: it runs.
      ['unjudged', 'green', 'run'],
    ],
  );
  assert.ok(!existsSync(boom), 'the carried layer ran');
  // A carried result stamps nothing: the cycle that earned the green owns it.
  assert.deepEqual(
    events(ctx)
      .filter((e) => e.event === 'layer-result')
      .map((e) => e.layer),
    ['a', 'unjudged'],
  );
});

test('a layer stamped in this cycle reports run whatever the plan left out', async (t) => {
  const { ctx } = fixture(t);
  ctx.store.append('layer-result', {
    actor: 'daemon',
    cycle: 2,
    layer: 'confirmed',
    status: 'red',
    sha: 's',
    confirmation: true,
  });
  const { results } = await runSpectrum(ctx, {
    layers: [{ name: 'confirmed', command: 'green' }],
    commands: { green: GREEN },
    cwd: process.cwd(),
    cycle: 2,
    sha: 's',
    run: new Set(),
    prior: priorOf({ confirmed: 'green' }),
  });
  assert.deepEqual(decided(results), [{ layer: 'confirmed', status: 'red', mode: 'run' }]);
});

test('the confirmation sweep runs what the cycle carried and marks its stamps', async (t) => {
  const { ctx } = fixture(t);
  const layers = [
    { name: 'a', command: 'green' },
    { name: 'b', command: 'green' },
  ];
  const gates = { layers, commands: { green: GREEN }, cwd: process.cwd(), cycle: 2, sha: 'sha2' };
  await runSpectrum(ctx, { ...gates, run: new Set(['a']), prior: priorOf({ a: 'red', b: 'green' }) });
  const { results } = await runSpectrum(ctx, { ...gates, confirmation: true });
  assert.deepEqual(
    results.map((r) => [r.layer, r.status, r.mode]),
    [
      ['a', 'green', 'run'],
      ['b', 'green', 'run'],
    ],
  );
  assert.deepEqual(
    events(ctx)
      .filter((e) => e.event === 'layer-result')
      .map((e) => [e.layer, e.confirmation]),
    [
      ['a', undefined],
      ['b', true],
    ],
  );
});

test('a layer command that cannot run at all reports an error, not a verdict', async (t) => {
  const { ctx } = fixture(t);
  const outcome = await runSpectrum(ctx, {
    layers: [{ name: 'a', command: 'missing' }],
    commands: { missing: ['definitely-not-a-real-binary-xyz'] },
    cwd: process.cwd(),
    cycle: 1,
    sha: 's',
  });
  assert.ok(outcome.error);
  assert.equal(outcome.results, undefined);
  assert.ok(!events(ctx).some((e) => e.event === 'layer-result'));
});

// -- concurrency groups (ADR-0047) -------------------------------------------

/**
 * A layer command that holds the machine for a while and writes down when it
 * started and when it stopped. The two spans are what "ran together" and "ran
 * one after the other" are read from, so the proof is a fact the commands
 * recorded and never a stopwatch on the test.
 */
function spanCmd(file, ms = 300) {
  return [
    'node',
    '-e',
    `const {writeFileSync}=require('fs');const s=Date.now();` +
      `setTimeout(()=>{writeFileSync(${JSON.stringify(file)},` +
      `JSON.stringify({s,e:Date.now()}));process.exit(0);},${ms});`,
  ];
}

function spanOf(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const overlaps = (x, y) => x.s < y.e && y.s < x.e;

/**
 * `ms` is how long each command holds. A test that proves layers did NOT
 * overlap needs no particular figure: the runner awaits them in turn and the
 * spans cannot meet whatever they hold for. A test that proves they DID
 * overlap needs a hold longer than the machine's own spawn latency, so those
 * tests ask for a generous one.
 */
function spanFixture(t, ms = 300) {
  const { root, ctx } = fixture(t);
  const files = { a: join(root, 'a.json'), b: join(root, 'b.json'), c: join(root, 'c.json') };
  const gates = {
    layers: [
      { name: 'a', command: 'a' },
      { name: 'b', command: 'b' },
      { name: 'c', command: 'c' },
    ],
    commands: { a: spanCmd(files.a, ms), b: spanCmd(files.b, ms), c: spanCmd(files.c, ms) },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
  };
  return { ctx, files, gates };
}

test('with no concurrency group declared, no two layers ever overlap', async (t) => {
  const { ctx, files, gates } = spanFixture(t);
  const { results } = await runSpectrum(ctx, gates);
  assert.deepEqual(
    results.map((r) => [r.layer, r.status, r.concurrentWith]),
    [
      ['a', 'green', undefined],
      ['b', 'green', undefined],
      ['c', 'green', undefined],
    ],
  );
  const spans = [spanOf(files.a), spanOf(files.b), spanOf(files.c)];
  assert.ok(!overlaps(spans[0], spans[1]), 'a and b overlapped without a group');
  assert.ok(!overlaps(spans[1], spans[2]), 'b and c overlapped without a group');
  // Nothing on the ledger claims a concurrency that did not happen.
  assert.ok(!events(ctx).some((e) => e.concurrentWith !== undefined));
});

test('a declared group runs together, and every layer of it keeps its own record', async (t) => {
  const { ctx, files, gates } = spanFixture(t, 1500);
  const { results } = await runSpectrum(ctx, { ...gates, groups: [['a', 'b']] });
  assert.deepEqual(
    results.map((r) => [r.layer, r.status, r.mode, r.concurrentWith]),
    [
      ['a', 'green', 'run', ['b']],
      ['b', 'green', 'run', ['a']],
      ['c', 'green', 'run', undefined],
    ],
  );
  const spans = { a: spanOf(files.a), b: spanOf(files.b), c: spanOf(files.c) };
  assert.ok(overlaps(spans.a, spans.b), 'the grouped layers did not run together');
  // The groups themselves stay in order: the layer after the group starts
  // after every layer of the group has finished.
  assert.ok(spans.c.s >= spans.a.e && spans.c.s >= spans.b.e, 'a later batch started early');
  // Each layer answers for itself: its own start stamp, its own result, its
  // own attempt, and its own name on both.
  const stamps = events(ctx).filter(
    (e) => e.event === 'layer-started' || e.event === 'layer-result',
  );
  for (const layer of ['a', 'b']) {
    const peer = layer === 'a' ? 'b' : 'a';
    assert.deepEqual(
      stamps.filter((e) => e.layer === layer).map((e) => [e.event, e.attempt, e.concurrentWith]),
      [
        ['layer-started', 1, [peer]],
        ['layer-result', 1, [peer]],
      ],
    );
  }
  assert.ok(stamps.filter((e) => e.layer === 'c').every((e) => e.concurrentWith === undefined));
});

test('the revert is the field: removing it returns the strict sequence', async (t) => {
  const { ctx, files, gates } = spanFixture(t, 1500);
  const together = await runSpectrum(ctx, { ...gates, groups: [['a', 'b']] });
  assert.ok(overlaps(spanOf(files.a), spanOf(files.b)));
  // The same layers, the same commands, the same cycle inputs, with the field
  // gone: the engine keeps the capability and does nothing with it.
  const second = spanFixture(t);
  const apart = await runSpectrum(second.ctx, second.gates);
  assert.ok(!overlaps(spanOf(second.files.a), spanOf(second.files.b)));
  // And the decision the cycle reports is the same one either way.
  assert.deepEqual(
    apart.results.map((r) => [r.layer, r.status, r.mode]),
    together.results.map((r) => [r.layer, r.status, r.mode]),
  );
});

test('a concurrent layer keeps its own parts, its own log and its own resources', async (t) => {
  const { ctx } = fixture(t);
  // The measurement seam: two layers whose readings differ, so a result that
  // took the other layer's reading would be visible.
  const measured = {
    a: { peakRssMb: 111, samples: 4, intervalMs: 250, source: 'test' },
    b: { peakRssMb: 222, samples: 4, intervalMs: 250, source: 'test' },
  };
  const exec = async (argv) => ({
    code: 0,
    output: '',
    truncated: false,
    parts: [
      { name: `${argv[0]}-part`, failed: false, ok: true, output: '', inputs: [`src/${argv[0]}`] },
    ],
    log: { path: `${argv[0]}.log`, bytes: 1, truncated: false },
    resources: measured[argv[0]],
  });
  const { results } = await runSpectrum(ctx, {
    layers: [
      { name: 'a', command: 'a', memoryCeilingMb: 500 },
      { name: 'b', command: 'b', memoryCeilingMb: 900 },
    ],
    commands: { a: ['a'], b: ['b'] },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
    groups: [['a', 'b']],
    exec,
  });
  assert.deepEqual(
    results.map((r) => [r.layer, r.resources.peakRssMb, r.resources.ceilingMb]),
    [
      ['a', 111, 500],
      ['b', 222, 900],
    ],
  );
  assert.deepEqual(
    results.map((r) => r.parts.map((p) => [p.name, p.status, p.inputs])),
    [[['a-part', 'green', ['src/a']]], [['b-part', 'green', ['src/b']]]],
  );
});

test('a concurrent batch reports a command error in declared order', async (t) => {
  const { ctx } = fixture(t);
  const { results, error } = await runSpectrum(ctx, {
    layers: [
      { name: 'a', command: 'missing' },
      { name: 'b', command: 'missing' },
    ],
    commands: { missing: ['definitely-not-a-real-binary-xyz'] },
    cwd: process.cwd(),
    cycle: 1,
    sha: 's',
    groups: [['a', 'b']],
  });
  assert.ok(error);
  assert.equal(results, undefined);
  assert.ok(!events(ctx).some((e) => e.event === 'layer-result'));
});

test('a group whose member is not runnable still runs the rest of the group', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, {
    layers: [
      { name: 'root', command: 'red' },
      { name: 'a', command: 'green', needs: ['root'] },
      { name: 'b', command: 'green' },
    ],
    commands: { green: GREEN, red: RED },
    cwd: process.cwd(),
    cycle: 1,
    sha: 's',
    groups: [['a', 'b']],
  });
  assert.deepEqual(
    results.map((r) => [r.layer, r.status, r.attributedTo, r.concurrentWith]),
    [
      ['root', 'red', undefined, undefined],
      // A layer that never started spent no wall beside anything, and it held
      // the machine for none of what its batch-mate spent, so neither of them
      // claims the other.
      ['a', 'not-runnable', 'root', undefined],
      ['b', 'green', undefined, undefined],
    ],
  );
});

test('a batch-mate that carries held the machine for none of it, and is not named', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, {
    layers: [
      { name: 'a', command: 'green' },
      { name: 'b', command: 'green' },
    ],
    commands: { green: GREEN },
    cwd: process.cwd(),
    cycle: 2,
    sha: 'sha2',
    groups: [['a', 'b']],
    run: new Set(['a']),
    prior: priorOf({ a: 'red', b: 'green' }),
  });
  assert.deepEqual(
    results.map((r) => [r.layer, r.mode, r.concurrentWith]),
    [
      ['a', 'run', undefined],
      ['b', 'carried', undefined],
    ],
  );
  assert.ok(!events(ctx).some((e) => e.concurrentWith !== undefined));
});

test('a batch that throws waits for its siblings and throws in declared order', async (t) => {
  const { ctx } = fixture(t);
  let finished = false;
  const exec = async (argv) => {
    if (argv[0] === 'a') throw new Error('a threw');
    await new Promise((resolve) => setTimeout(resolve, 120));
    finished = true;
    if (argv[0] === 'b') throw new Error('b threw');
    return { code: 0, output: '', truncated: false, parts: [], log: null, resources: null };
  };
  await assert.rejects(
    () =>
      runSpectrum(ctx, {
        layers: [
          { name: 'a', command: 'a' },
          { name: 'b', command: 'b' },
        ],
        commands: { a: ['a'], b: ['b'] },
        cwd: process.cwd(),
        cycle: 1,
        sha: 's',
        groups: [['a', 'b']],
        exec,
      }),
    // The first layer in declared order, never the first one in time.
    /a threw/,
  );
  assert.ok(finished, 'the runner left a sibling still running');
  // Both attempts stamped their own ending before anything left the runner.
  assert.deepEqual(
    events(ctx)
      .filter((e) => e.event === 'layer-abandoned')
      .map((e) => [e.layer, e.reason]),
    [
      ['a', 'runner-error'],
      ['b', 'runner-error'],
    ],
  );
});

// -- the reconciliation set (ADR-0026) ---------------------------------------

const GROUNDED = [
  { name: 'lint', command: 'green', ground: ['src', 'docs'] },
  { name: 'unit', command: 'green', ground: ['src'], needs: ['lint'] },
  { name: 'docs', command: 'green', ground: ['docs/**'] },
  { name: 'bare', command: 'green' },
];

/** Every layer green, with the part table each one declared, if any. */
function groundPrior(parts = {}) {
  return new Map(
    GROUNDED.map((l) => [l.name, { layer: l.name, status: 'green', ...(parts[l.name] ?? {}) }]),
  );
}

test('the reconciliation set runs the layers the record diff reaches, and the ones that claim nothing', () => {
  const target = groundedLayers(GROUNDED, groundPrior(), {
    changed: ['docs/adr/0001-x.md'],
  });
  // lint and docs claim the record tree; unit claims src alone and carries;
  // bare declares nothing at all, so it has no claim to carry on.
  assert.deepEqual([...target].sort(), ['bare', 'docs', 'lint', 'unit']);
  // unit is in the set because it needs lint, not because of its own ground.
  const noChain = GROUNDED.map(({ needs, ...l }) => l);
  assert.deepEqual(
    [...groundedLayers(noChain, groundPrior(), { changed: ['docs/adr/0001-x.md'] })].sort(),
    ['bare', 'docs', 'lint'],
  );
});

test('a layer whose ground the record diff misses carries', () => {
  const noChain = GROUNDED.map(({ needs, ...l }) => l);
  const target = groundedLayers(noChain, groundPrior(), { changed: ['notes/0001-x.md'] });
  assert.deepEqual([...target].sort(), ['bare']);
});

test('a part declaration is ground too, and the breadth list joins every layer', () => {
  const noChain = GROUNDED.map(({ needs, ...l }) => l);
  // The bare layer's command declared its inputs, so it has a claim to carry.
  const prior = groundPrior({ bare: { parts: [{ name: 'all', inputs: ['tools'] }] } });
  assert.deepEqual([...groundedLayers(noChain, prior, { changed: ['notes/x.md'] })], []);
  assert.deepEqual([...groundedLayers(noChain, prior, { changed: ['tools/x.mjs'] })], ['bare']);
  // The breadth list belongs to every layer whatever it declared.
  assert.deepEqual(
    [...groundedLayers(noChain, prior, { changed: ['pnpm-lock.yaml'], breadth: ['pnpm-lock.yaml'] })].sort(),
    ['bare', 'docs', 'lint', 'unit'],
  );
});

test('a layer with no standing green runs whatever its ground says', () => {
  const noChain = GROUNDED.map(({ needs, ...l }) => l);
  const prior = groundPrior();
  prior.set('unit', { layer: 'unit', status: 'red' });
  prior.delete('docs');
  assert.deepEqual([...groundedLayers(noChain, prior, { changed: ['notes/x.md'] })].sort(), [
    'bare',
    'docs',
    'unit',
  ]);
});

// The reconciliation sweep is gone with the round that named it. A record diff
// takes the record plan, whatever cycle it arrives on, and this module no longer
// holds a set the ship stage hands it (ADR-0075).
test('there is no reconciliation sweep, and a record diff plans on its own', () => {
  const events = [
    { event: 'implementation-committed', pass: 1 },
    ...GROUNDED.map((l) => ({ event: 'layer-result', cycle: 1, layer: l.name, status: 'green' })),
    { event: 'verdict-rendered', cycle: 1, pass: 1, verdict: 'green' },
  ];
  const plan = cyclePlan(events, {
    cycle: 2,
    pass: 1,
    layers: GROUNDED,
    changed: ['docs/adr/0001-x.md'],
    recordPaths: ['docs/adr'],
    recordLayers: ['docs'],
  });
  assert.equal(plan.sweep, 'records');
  assert.deepEqual([...plan.run], ['docs']);
  // A project that names no record layers plans the targeted set, which is
  // empty because every layer is green.
  assert.equal(cyclePlan(events, { cycle: 2, pass: 1, layers: GROUNDED }).sweep, 'targeted');
  assert.equal(
    cyclePlan(events, { cycle: 2, pass: 1, layers: GROUNDED, changed: ['docs/adr/0001-x.md'] })
      .sweep,
    'targeted',
  );
});

// -- the record attribution --------------------------------------------------
//
// The project names the layers a record path is read by. Such a path selects
// those layers and no other, whatever any ground declares, and a cycle whose
// whole diff is records runs them alone.

const RECORDS = { recordPaths: ['docs/adr', '!docs/adr/TEMPLATE.md'], recordLayers: ['form'] };

/** A spectrum with a record layer that needs a prerequisite, as ceq has. */
const RECORD_LAYERS = [
  { name: 'lockfile', command: 'green', ground: ['pnpm-lock.yaml'] },
  { name: 'form', command: 'green', ground: ['docs/adr/**', 'scripts/form.ts'], needs: ['lockfile'] },
  { name: 'lint', command: 'green', ground: ['src', 'docs'] },
  { name: 'unit', command: 'green', ground: ['src'] },
];

const allGreen = (layers = RECORD_LAYERS) =>
  new Map(layers.map((l) => [l.name, { layer: l.name, status: 'green' }]));

test('a changed record path selects the record layers and no other', () => {
  // lint claims `docs` and would take the record diff on its ground alone.
  // The project has said which layers read a record, so it does not.
  const target = groundedLayers(RECORD_LAYERS, allGreen(), {
    changed: ['docs/adr/adr-020-x.md'],
    ...RECORDS,
  });
  assert.deepEqual([...target].sort(), ['form']);
});

test('a project that names no record layer keeps the selection it had', () => {
  const target = groundedLayers(RECORD_LAYERS, allGreen(), {
    changed: ['docs/adr/adr-020-x.md'],
    recordPaths: RECORDS.recordPaths,
  });
  assert.deepEqual([...target].sort(), ['form', 'lint']);
});

test('a record path the exclusion names is ground like any other', () => {
  const target = groundedLayers(RECORD_LAYERS, allGreen(), {
    changed: ['docs/adr/TEMPLATE.md'],
    ...RECORDS,
  });
  assert.deepEqual([...target].sort(), ['form', 'lint']);
});

test('a code path of a record layer selects it by its own ground', () => {
  const target = groundedLayers(RECORD_LAYERS, allGreen(), {
    changed: ['scripts/form.ts'],
    ...RECORDS,
  });
  assert.deepEqual([...target].sort(), ['form']);
});

test('the needs closure runs over the selected set as it always did', () => {
  const chained = [...RECORD_LAYERS, { name: 'after', command: 'green', needs: ['form'] }];
  const target = groundedLayers(chained, allGreen(chained), {
    changed: ['docs/adr/adr-020-x.md'],
    ...RECORDS,
  });
  assert.deepEqual([...target].sort(), ['after', 'form']);
});

test('the breadth list never carries a record to a layer', () => {
  // A breadth entry under the record paths would give every suite ground over
  // the record tree and undo the attribution in one line of config.
  const target = groundedLayers(RECORD_LAYERS, allGreen(), {
    changed: ['docs/adr/adr-020-x.md'],
    breadth: ['docs/adr/**'],
    ...RECORDS,
  });
  assert.deepEqual([...target].sort(), ['form']);
});

test('a record-only diff runs the record layers and their needs, on the first cycle too', () => {
  // Nothing is proven and no render stands, so today's plan is the full
  // spectrum. The diff is a change the project states no code layer reads.
  const plan = cyclePlan([], {
    cycle: 1,
    pass: 1,
    layers: RECORD_LAYERS,
    changed: ['docs/adr/adr-020-x.md', 'docs/adr/adr-021-y.md'],
    ...RECORDS,
  });
  assert.equal(plan.sweep, 'records');
  // The prerequisite runs because it holds no green: a record layer whose
  // prerequisite nothing ran reports not-runnable instead of judging.
  assert.deepEqual([...plan.run].sort(), ['form', 'lockfile']);
  // The rest are skipped and not carried. This cycle earns them no green and
  // claims none for them.
  assert.deepEqual([...plan.skip].sort(), ['lint', 'unit']);
});

test('a prerequisite with a green to carry is not run again', () => {
  const plan = cyclePlan([], {
    cycle: 2,
    pass: 1,
    layers: RECORD_LAYERS,
    changed: ['docs/adr/adr-020-x.md'],
    ...RECORDS,
  });
  assert.deepEqual([...plan.run].sort(), ['form', 'lockfile']);
  const green = [
    { event: 'implementation-committed', pass: 1 },
    ...RECORD_LAYERS.map((l) => ({
      event: 'layer-result',
      cycle: 1,
      layer: l.name,
      status: 'green',
    })),
    { event: 'verdict-rendered', cycle: 1, pass: 1, verdict: 'green' },
  ];
  const carried = cyclePlan(green, {
    cycle: 2,
    pass: 1,
    layers: RECORD_LAYERS,
    changed: ['docs/adr/adr-020-x.md'],
    ...RECORDS,
  });
  assert.deepEqual([...carried.run], ['form']);
  assert.deepEqual([...carried.skip], []);
});

test('a diff that is not records alone takes the plan it always took', () => {
  const mixed = cyclePlan([], {
    cycle: 1,
    pass: 1,
    layers: RECORD_LAYERS,
    changed: ['docs/adr/adr-020-x.md', 'src/api/f.mjs'],
    ...RECORDS,
  });
  assert.deepEqual(mixed, { sweep: 'full' });
  // And so does a project that states no record attribution at all.
  const undeclared = cyclePlan([], {
    cycle: 1,
    pass: 1,
    layers: RECORD_LAYERS,
    changed: ['docs/adr/adr-020-x.md'],
  });
  assert.deepEqual(undeclared, { sweep: 'full' });
  // An empty diff decides nothing: every path of nothing is a record, and the
  // cycle that judged no change would skip the spectrum on a vacuous reading.
  assert.deepEqual(
    cyclePlan([], { cycle: 1, pass: 1, layers: RECORD_LAYERS, changed: [], ...RECORDS }),
    { sweep: 'full' },
  );
});

test('a skipped layer neither runs nor carries, and the ledger says nothing of it', async (t) => {
  const { root, ctx } = fixture(t);
  const marker = join(root, 'skipped-marker');
  const tattling = [
    'node',
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)},'x');process.exit(0);`,
  ];
  const { results } = await runSpectrum(ctx, {
    layers: [
      { name: 'form', command: 'green' },
      { name: 'unit', command: 'tattling' },
    ],
    commands: { green: GREEN, tattling },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'sha1',
    run: new Set(['form']),
    skip: new Set(['unit']),
  });
  assert.deepEqual(
    results.map((r) => [r.layer, r.status, r.mode]),
    [['form', 'green', 'run']],
  );
  assert.equal(existsSync(marker), false, 'a skipped layer ran');
  assert.deepEqual(
    events(ctx)
      .filter((e) => e.event === 'layer-result')
      .map((e) => e.layer),
    ['form'],
  );
});

// -- the footprint of the run's own diff (the first cycle) --------------------
//
// The first cycle of a pass proved nothing of its own, so it asks what the
// default branch already proved. Four conditions arm that question, and each one
// that fails buys the whole spectrum under its own word.

const FOOTPRINT = [
  { name: 'install', command: 'green', ground: ['manifest.json'], setup: true },
  { name: 'lint', command: 'green', ground: ['src'] },
  { name: 'unit', command: 'green', ground: ['src', 'tests'], needs: ['lint'] },
  { name: 'docs', command: 'green', ground: ['notes'] },
];

/** Every named layer certified green at one base, as the readers answer. */
function certifiedAll(names = FOOTPRINT.map((l) => l.name)) {
  return new Map(
    names.map((name) => [name, { baseSha: 'base1', certifiedSeq: 7, status: 'green' }]),
  );
}

function footprintPlan(changed, certified = certifiedAll(), layers = FOOTPRINT) {
  return cyclePlan([], { cycle: 1, pass: 1, layers, footprint: { changed, certified } });
}

test('the first cycle runs the layers the diff reaches, their dependents and every setup layer', () => {
  const plan = footprintPlan(['src/api/f.mjs']);
  assert.equal(plan.sweep, 'footprint');
  // lint reads src; unit needs lint; install runs by declaration; docs reads
  // notes, which the diff never touched, so its certification answers.
  assert.deepEqual([...plan.run].sort(), ['install', 'lint', 'unit']);
});

test('a setup layer runs on the footprint cycle and pulls no dependent in with it', () => {
  // Nothing of this diff is any layer's ground but the setup layer's own, so the
  // setup layer is the only thing that runs. A closure over `needs` here would
  // buy the whole spectrum back on every cycle.
  assert.deepEqual([...footprintPlan(['manifest.json']).run], ['install']);
});

test('a layer no certification answers for runs, and a layer above it still carries', () => {
  const plan = footprintPlan(['notes/x.md'], certifiedAll(['install', 'lint', 'docs']));
  // unit holds no certification, so it runs. lint holds one and the diff leaves
  // its ground alone, so it carries under a layer that runs.
  assert.deepEqual([...plan.run].sort(), ['docs', 'install', 'unit']);
});

test('the breadth ground belongs to every layer, so a shared input runs the spectrum', () => {
  const plan = cyclePlan([], {
    cycle: 1,
    pass: 1,
    layers: FOOTPRINT,
    breadth: ['shared.lock'],
    footprint: { changed: ['shared.lock'], certified: certifiedAll() },
  });
  assert.deepEqual([...plan.run].sort(), ['docs', 'install', 'lint', 'unit']);
});

test('a record path selects the record layers and no other on the footprint cycle', () => {
  const plan = cyclePlan([], {
    cycle: 1,
    pass: 1,
    layers: FOOTPRINT,
    recordPaths: ['notes'],
    recordLayers: ['docs'],
    footprint: { changed: ['notes/0001-x.md'], certified: certifiedAll() },
  });
  // docs is the layer the project attributes its records to, and it is the only
  // layer a record path reaches whatever any ground declares.
  assert.deepEqual([...plan.run].sort(), ['docs', 'install']);
});

test('a change no layer claims buys the whole spectrum', () => {
  // The project has not said which layer reads it, so no carry over it rests on
  // anything. The ground the project states no suite reads is the exception: it
  // leaves the diff before the attribution, because that list is the project
  // saying these files reach no layer.
  const plan = footprintPlan(['tools/release.mjs']);
  assert.deepEqual(plan, { sweep: 'full', reason: 'unclaimed-ground' });
  const stated = cyclePlan([], {
    cycle: 1,
    pass: 1,
    layers: FOOTPRINT,
    groundless: ['tools'],
    footprint: { changed: ['tools/release.mjs'], certified: certifiedAll() },
  });
  assert.equal(stated.sweep, 'footprint');
  assert.deepEqual([...stated.run], ['install']);
});

test('the frozen suite runs on the footprint cycle and pulls no dependent in with it', () => {
  // The suite asserts the story, the run wrote it inside this pass, and the
  // certification of the default branch was earned before it existed. A carry of
  // it would be a carry of the one layer that answers the spec.
  const plan = cyclePlan([], {
    cycle: 1,
    pass: 1,
    layers: FOOTPRINT,
    suite: 'docs',
    footprint: { changed: ['manifest.json'], certified: certifiedAll() },
  });
  assert.equal(plan.sweep, 'footprint');
  assert.deepEqual([...plan.run].sort(), ['docs', 'install']);
});

test('a CI red keeps the whole spectrum, whatever footprint the caller offers', () => {
  // The red is stamped against the check's own name and maps to no Tier-1 layer,
  // so no standing green is the one it contradicts and no footprint can be drawn
  // around it.
  const events = [
    { event: 'verdict-rendered', cycle: 1, pass: 1, verdict: 'green' },
    { event: 'verdict-rendered', cycle: 2, pass: 1, source: 'ci', verdict: 'red' },
  ];
  assert.deepEqual(
    cyclePlan(events, {
      cycle: 3,
      pass: 1,
      layers: FOOTPRINT,
      footprint: { changed: ['src/api/f.mjs'], certified: certifiedAll() },
    }),
    { sweep: 'full', reason: 'ci-red' },
  );
});

test('a refused footprint is the full sweep, and the sweep names the condition', () => {
  for (const reason of [
    'no-setup-layer',
    'groundless-layer',
    'no-base-certification',
    'unreadable-diff',
  ]) {
    assert.deepEqual(cyclePlan([], { cycle: 1, pass: 1, layers: FOOTPRINT, footprint: { reason } }), {
      sweep: 'full',
      reason,
    });
  }
  // A caller that offers nothing takes the sweep it always took, unnamed.
  assert.deepEqual(cyclePlan([], { cycle: 1, pass: 1, layers: FOOTPRINT }), { sweep: 'full' });
});

test('a carried certification stamps a result that names the tree it was earned at', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, {
    layers: FOOTPRINT,
    commands: { green: GREEN },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'candidate',
    run: new Set(['install', 'lint', 'unit']),
    certified: certifiedAll(),
  });
  assert.deepEqual(
    results.map((r) => [r.layer, r.status, r.mode]),
    [
      ['install', 'green', 'run'],
      ['lint', 'green', 'run'],
      ['unit', 'green', 'run'],
      ['docs', 'green', 'carried'],
    ],
  );
  const docs = results.find((r) => r.layer === 'docs');
  assert.deepEqual([docs.carriedFrom, docs.baseSha, docs.certifiedSeq], ['base', 'base1', 7]);
  const stamp = events(ctx).find((e) => e.event === 'layer-result' && e.layer === 'docs');
  // The tree this cycle judged and the tree the green was earned at, apart.
  assert.equal(stamp.sha, 'candidate');
  assert.equal(stamp.baseSha, 'base1');
  assert.equal(stamp.mode, 'carried');
  // A carry spent no wall clock and held no machine, so it measures neither.
  assert.equal(stamp.elapsedMs, undefined);
  assert.equal(stamp.resources, undefined);
  // And it ran nothing: the layer's own command never started.
  assert.ok(!events(ctx).some((e) => e.event === 'layer-started' && e.layer === 'docs'));
});

test('a carried result stays carried when the daemon comes back inside the cycle', async (t) => {
  const { ctx } = fixture(t);
  const plan = {
    layers: FOOTPRINT,
    commands: { green: GREEN },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'candidate',
    run: new Set(['install', 'lint', 'unit']),
    certified: certifiedAll(),
  };
  const first = await runSpectrum(ctx, plan);
  assert.equal(first.results.find((r) => r.layer === 'docs').mode, 'carried');
  // The same cycle again, as a resume re-enters it. The stamp is the fact, and a
  // carry re-read as a run would report a proof of this tree.
  const again = await runSpectrum(ctx, plan);
  const docs = again.results.find((r) => r.layer === 'docs');
  assert.equal(docs.mode, 'carried');
  assert.equal(docs.baseSha, 'base1');
  assert.equal(
    events(ctx).filter((e) => e.event === 'layer-result' && e.layer === 'docs').length,
    1,
    'the resume stamped the carry a second time',
  );
});

test('a dependent of a red setup layer is not-runnable and carries no certification', async (t) => {
  const { ctx } = fixture(t);
  const { results } = await runSpectrum(ctx, {
    layers: [
      { name: 'install', command: 'red', ground: ['manifest.json'], setup: true },
      { name: 'unit', command: 'green', ground: ['tests'], needs: ['install'] },
    ],
    commands: { green: GREEN, red: RED },
    cwd: process.cwd(),
    cycle: 1,
    sha: 'candidate',
    run: new Set(['install']),
    certified: certifiedAll(['install', 'unit']),
  });
  // The certification says unit was green at the base. The setup layer this
  // cycle ran says the tree under it is broken here, and a carried green would
  // report a proof nobody holds and answer an open exhaustion record with it.
  assert.deepEqual(
    results.map((r) => [r.layer, r.status, r.mode, r.attributedTo]),
    [
      ['install', 'red', 'run', undefined],
      ['unit', 'not-runnable', 'run', 'install'],
    ],
  );
  const unit = events(ctx).find((e) => e.event === 'layer-result' && e.layer === 'unit');
  assert.equal(unit.carriedFrom, undefined);
});

test('a later cycle takes the targeted set, and no base certification reaches it', () => {
  const ledger = [
    { event: 'implementation-committed', pass: 1 },
    ...FOOTPRINT.map((l) => ({
      event: 'layer-result',
      cycle: 1,
      layer: l.name,
      status: l.name === 'unit' ? 'red' : 'green',
    })),
    { event: 'verdict-rendered', cycle: 1, pass: 1, verdict: 'red' },
  ];
  const plan = cyclePlan(ledger, {
    cycle: 2,
    pass: 1,
    layers: FOOTPRINT,
    footprint: { changed: [], certified: certifiedAll() },
  });
  assert.equal(plan.sweep, 'targeted');
  assert.deepEqual([...plan.run], ['unit']);
  assert.equal(plan.certified, undefined);
});

test('a layer the first cycle carried reads as green to the cycle behind it', () => {
  const ledger = [
    { event: 'implementation-committed', pass: 1 },
    {
      event: 'layer-result',
      cycle: 1,
      layer: 'docs',
      status: 'green',
      mode: 'carried',
      carriedFrom: 'base',
      baseSha: 'base1',
    },
    ...FOOTPRINT.filter((l) => l.name !== 'docs').map((l) => ({
      event: 'layer-result',
      cycle: 1,
      layer: l.name,
      status: 'green',
    })),
    { event: 'verdict-rendered', cycle: 1, pass: 1, verdict: 'green' },
  ];
  const prior = priorStatus(ledger, 2);
  assert.equal(prior.get('docs').mode, 'carried');
  // So the set behind it asks for nothing, the carried layer included.
  assert.deepEqual([...targetedLayers(FOOTPRINT, prior)], []);
});

// -- the four conditions, over a project config ------------------------------
//
// The conditions are read off the config and the instance ledger, so they are
// asserted here beside the plan they decide.

function footprintBase(layers, { recordPaths = [] } = {}) {
  return {
    layers,
    config: { gates: { tier1: layers } },
    recordPaths,
    worktree: process.cwd(),
  };
}

test('a project that declares no setup layer takes the full sweep', async (t) => {
  const { ctx } = fixture(t);
  // Every layer states its ground and none is a setup layer, which is what a
  // project config states before it opts into the footprint.
  const layers = FOOTPRINT.map(({ setup, ...layer }) => layer);
  assert.deepEqual(
    await certifiedFootprint({ ...ctx, project: 'p', payload: { baseSha: 'base1' } },
      footprintBase(layers), 'candidate'),
    { reason: 'no-setup-layer' },
  );
});

test('one Tier-1 layer with no ground takes the full sweep for the whole spectrum', async (t) => {
  const { ctx } = fixture(t);
  const layers = FOOTPRINT.map(({ ground, ...layer }) =>
    layer.name === 'docs' ? layer : { ...layer, ground },
  );
  assert.deepEqual(
    await certifiedFootprint({ ...ctx, project: 'p', payload: { baseSha: 'base1' } },
      footprintBase(layers), 'candidate'),
    { reason: 'groundless-layer' },
  );
});

test('a project with a setup layer and no certification at all takes the full sweep', async (t) => {
  const { ctx } = fixture(t);
  // The config the first run after this ships reads: a setup layer declared,
  // every layer grounded, and an instance ledger that holds no certification.
  assert.deepEqual(
    await certifiedFootprint({ ...ctx, project: 'p', payload: { baseSha: 'base1' } },
      footprintBase(FOOTPRINT), 'candidate'),
    { reason: 'no-base-certification' },
  );
});

test('a diff the run cannot read takes the full sweep', async (t) => {
  const { ctx } = fixture(t);
  certifyBase(ctx.paths, 'base1');
  // A tree that is no repository answers nothing about what the run changed.
  const base = { ...footprintBase(FOOTPRINT), worktree: tempDir() };
  t.after(() => removeDir(base.worktree));
  assert.deepEqual(
    await certifiedFootprint(
      { ...ctx, project: 'p', payload: { baseSha: 'base1' } },
      base,
      'candidate',
    ),
    { reason: 'unreadable-diff' },
  );
});

test('a certification of the base answers per layer, and the diff decides the rest', async (t) => {
  const { ctx } = fixture(t);
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const tree = join(dir, 'work');
  initOriginRepo(tree, { 'src/f.mjs': 'first\n', 'notes/n.md': 'first\n' });
  const baseSha = gitSync(['rev-parse', 'HEAD'], tree).trim();
  const candidate = commitTree(tree, { 'src/f.mjs': 'second\n' }, 'the work');
  certifyBase(ctx.paths, baseSha);
  const offer = await certifiedFootprint(
    { ...ctx, project: 'p', payload: { baseSha } },
    { ...footprintBase(FOOTPRINT), worktree: tree },
    candidate,
  );
  assert.deepEqual(offer.changed, ['src/f.mjs']);
  assert.deepEqual([...offer.certified.keys()].sort(), ['docs', 'install', 'lint', 'unit']);
  assert.equal(offer.certified.get('docs').baseSha, baseSha);
  // And the plan off that offer runs the diff's own layers and carries the rest.
  const plan = cyclePlan([], {
    cycle: 1,
    pass: 1,
    layers: FOOTPRINT,
    footprint: offer,
  });
  assert.equal(plan.sweep, 'footprint');
  assert.deepEqual([...plan.run].sort(), ['install', 'lint', 'unit']);
});

test('the sweep reasons are a closed vocabulary', () => {
  // The reading that says whether the footprint is ever taken on a project is a
  // count of these words, and a word nobody registered cannot be counted.
  assert.equal(SWEEP_REASONS.size, 6);
  for (const reason of SWEEP_REASONS) assert.equal(assertSweepReason(reason), reason);
  assert.throws(() => assertSweepReason('no-footprint'), /unknown sweep reason/);
  assert.throws(
    () => cyclePlan([], { cycle: 1, pass: 1, layers: FOOTPRINT, footprint: { reason: 'because' } }),
    /unknown sweep reason/,
  );
});
