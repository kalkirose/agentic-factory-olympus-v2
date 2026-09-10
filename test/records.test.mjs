import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitTree, gitSync, initOriginRepo, removeDir, tempDir, writeTree } from './helpers.mjs';
import { checkReportSchema, validateReport } from '../src/seats/contract.mjs';
import { RECORD_CRITERIA, RECORD_CRITERION_KEYS, RECORD_RULE } from '../src/lanes/lenses.mjs';
import { NEIGHBOUR_CAP } from '../src/lanes/units.mjs';
import {
  AUTHOR_SEAT,
  REVIEW_SEAT,
  WRITE_SEAT,
  birthRole,
  correctiveRole,
  findingLine,
  parseRecordList,
  reconcileWriteSchema,
  recordScope,
  remarkLine,
  runWindow,
  writeChecks,
  writeRole,
} from '../src/lanes/records.mjs';
import { findingLine as codeFindingLine } from '../src/lanes/verdict.mjs';

const RECORD = 'docs/adr/adr-900-the-helper.md';
const RECORD_TEXT = `# ADR-900: The helper doubles its input

**Status:** Accepted

## Decision

The helper lives at \`src/feature.mjs\`.

Why: the alternative cost a second module.
`;

/** A worktree with one record and the file that record cites. */
function tree(t, files = {}) {
  const dir = tempDir('olympus-records-');
  t.after(() => removeDir(dir));
  writeTree(dir, {
    [RECORD]: RECORD_TEXT,
    'src/feature.mjs': 'export const f = (x) => x * 2;\n',
    ...files,
  });
  return dir;
}

/** A repository on a run branch, with the default branch behind it. */
function repo(t, files) {
  const dir = tempDir('olympus-records-git-');
  t.after(() => removeDir(dir));
  initOriginRepo(dir, files);
  gitSync(['checkout', '-q', '-b', 'run'], dir);
  return dir;
}

/** A context whose store keeps what the readings stamped. */
function stubCtx() {
  const events = [];
  return {
    events,
    store: {
      append(event, body) {
        events.push({ event, ...body });
        return { seq: events.length };
      },
    },
  };
}

function report(over = {}) {
  return {
    rewritten: [RECORD],
    unchanged: [],
    summary: 'the record states what shipped',
    ...over,
  };
}

const BASE = {
  recordPaths: ['docs/adr/'],
  recordLifecycle: 'supersede',
  defaultBranch: 'main',
  mode: 'records',
  recordLayers: ['adr-form'],
  layers: [{ name: 'adr-form', command: 'gateAdrForm' }],
  commands: { gateAdrForm: ['pnpm', 'gate:adr-form'] },
};

// -- the report shape ---------------------------------------------------------

test('the write shape asks for the record and the findings, and for no reading of the text', () => {
  const plain = reconcileWriteSchema();
  assert.deepEqual(checkReportSchema(plain), []);
  assert.deepEqual(plain.required, ['rewritten', 'unchanged', 'summary']);
  // The three tables are gone. A seat that filed a kind, a verdict and a path
  // for every sentence answered a reading the harness cannot check (ADR-0080).
  for (const field of ['units', 'divergences', 'siblings']) {
    assert.equal(plain.properties[field], undefined, `the shape still holds ${field}`);
  }
  assert.deepEqual(validateReport(plain, report()), []);
});

test('a corrective report lists the findings it answered, with the reason it disputes one', () => {
  const shape = reconcileWriteSchema({ answered: true });
  assert.deepEqual(checkReportSchema(shape), []);
  assert.ok(shape.required.includes('answered'));
  assert.deepEqual(shape.properties.answered.items.required, ['id']);
  assert.deepEqual(
    validateReport(
      shape,
      report({ answered: [{ id: 'F1' }, { id: 'F2', disputed: 'the tree reads as the record says' }] }),
    ),
    [],
  );
  // The id alone is the whole of an answer. A writer that agrees answers in the
  // record; a writer that does not says why, and the next fresh reviewer reads
  // the record again (ADR-0080).
  assert.deepEqual(
    validateReport(shape, report({ answered: [{ id: 'F1', kind: 'claim' }] })).length,
    1,
  );
});

test('the write shape is the function alone: no dispatch takes a pre-built one', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'src/lanes/records.mjs'), 'utf8');
  assert.ok(!source.includes('RECONCILE_WRITE_SCHEMA'), 'records.mjs still holds the constant');
});

// -- the harness reads no token of a record -----------------------------------

test('the harness holds no reader of a record token, verb or path', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'src/lanes/records.mjs'), 'utf8');
  for (const gone of [
    'kindTest',
    'CLAIM_VERBS',
    'pathTokens',
    'unitChecks',
    'siblingChecks',
    'supersedeChecks',
    'divergenceDefects',
    'evidencePath',
    'referenceDefects',
  ]) {
    assert.ok(!source.includes(gone), `records.mjs still holds ${gone}`);
  }
});

test('the record criteria are three, and the rule stands above them', () => {
  assert.deepEqual(RECORD_CRITERION_KEYS, ['truth', 'consistent', 'form']);
  assert.equal(Object.keys(RECORD_CRITERIA).length, 3);
  // `open`, `divergence` and `reference` are readings of the truth of a record,
  // and the truth criterion states all three (ADR-0080).
  assert.match(RECORD_CRITERIA.truth, /not built/);
  assert.match(RECORD_CRITERIA.truth, /divergence/);
  assert.match(RECORD_CRITERIA.truth, /means what the record says/);
  // `form` is what the project gate cannot read, by rule number.
  assert.match(RECORD_CRITERIA.form, /rule number/);
  assert.match(RECORD_RULE, /never conflicts with the code/);
});

// -- the two readings of what a seat left --------------------------------------

test('a change outside the record tree is reverted and recorded, and nothing is refused', async (t) => {
  const dir = repo(t, { [RECORD]: RECORD_TEXT, 'src/feature.mjs': 'export const f = 1;\n' });
  writeFileSync(join(dir, RECORD), `${RECORD_TEXT}\nOne more sentence.\n`);
  writeFileSync(join(dir, 'src/feature.mjs'), 'export const f = 2;\n');
  const ctx = stubCtx();
  const base = { ...BASE, worktree: dir, seat: `${WRITE_SEAT}:1` };
  const defects = await writeChecks(ctx, base, [], report());
  assert.deepEqual(defects, [], 'a record run must not be refused for a code write');
  // The file is back where the last commit left it, and the record stands.
  assert.equal(readFileSync(join(dir, 'src/feature.mjs'), 'utf8'), 'export const f = 1;\n');
  assert.match(readFileSync(join(dir, RECORD), 'utf8'), /One more sentence/);
  const stamp = ctx.events.find((e) => e.event === 'diff-policy-recapture');
  assert.ok(stamp, 'the revert left no record');
  assert.equal(stamp.class, 'record-seat');
  assert.deepEqual(stamp.recaptured, ['src/feature.mjs']);
  assert.equal(ctx.events.some((e) => e.event === 'seat-refused'), false);
});

test('a listed record the tree did not change is dropped from the entry with a note', async (t) => {
  const dir = repo(t, { [RECORD]: RECORD_TEXT });
  const other = 'docs/adr/adr-901-the-other.md';
  writeFileSync(join(dir, RECORD), `${RECORD_TEXT}\nOne more sentence.\n`);
  const ctx = stubCtx();
  const out = report({ rewritten: [RECORD, other] });
  const defects = await writeChecks(ctx, { ...BASE, worktree: dir }, [], out);
  assert.deepEqual(defects, []);
  assert.deepEqual(out.rewritten, [RECORD]);
  assert.deepEqual(out.dropped, [other]);
});

test('the record tree revert leaves the record tree alone', async (t) => {
  const dir = repo(t, { [RECORD]: RECORD_TEXT });
  const added = 'docs/adr/adr-902-new.md';
  writeFileSync(join(dir, added), '# ADR-902: A new decision\n\n**Status:** Accepted\n');
  const ctx = stubCtx();
  const out = report({ rewritten: [added] });
  assert.deepEqual(await writeChecks(ctx, { ...BASE, worktree: dir }, [], out), []);
  assert.equal(readFileSync(join(dir, added), 'utf8').length > 0, true);
  assert.deepEqual(out.rewritten, [added]);
  assert.equal(ctx.events.length, 0, 'nothing outside the tree, so nothing to record');
});

test('the judged records are the boundary where a dispatch names them', async (t) => {
  const dir = repo(t, { [RECORD]: RECORD_TEXT, 'other/notes.md': 'notes\n' });
  writeFileSync(join(dir, 'other/notes.md'), 'moved\n');
  const ctx = stubCtx();
  await writeChecks(ctx, { ...BASE, worktree: dir }, [RECORD], report());
  const stamp = ctx.events.find((e) => e.event === 'diff-policy-recapture');
  assert.deepEqual(stamp.recaptured, ['other/notes.md']);
  assert.match(stamp.recapturedLines[0], /docs\/adr/);
});

// -- the window ----------------------------------------------------------------

test('runWindow answers the merge base and the record files the run changed', async (t) => {
  const dir = repo(t, { [RECORD]: RECORD_TEXT });
  commitTree(dir, { 'docs/adr/adr-903-added.md': '# ADR-903\n' }, 'add a record');
  const window = await runWindow({ worktree: dir, defaultBranch: 'main', recordPaths: ['docs/adr/'] });
  assert.equal(window.error, null);
  assert.equal(typeof window.base, 'string');
  assert.deepEqual(window.files, ['docs/adr/adr-903-added.md']);
});

test('a window read that fails answers the error and never an empty window', async () => {
  const window = await runWindow({ worktree: tempDir('olympus-no-repo-'), defaultBranch: 'main' });
  assert.notEqual(window.error, null);
  assert.deepEqual(window.files, []);
});

test('recordScope reads the run window, and never a record main gained', async (t) => {
  const dir = repo(t, { [RECORD]: RECORD_TEXT });
  commitTree(dir, { 'docs/adr/adr-904-run.md': '# ADR-904\n\n**Status:** Accepted\n' }, 'run record');
  gitSync(['checkout', '-q', 'main'], dir);
  commitTree(dir, { 'docs/adr/adr-905-main.md': '# ADR-905\n\n**Status:** Accepted\n' }, 'main record');
  gitSync(['checkout', '-q', 'run'], dir);
  const scope = await recordScope(dir, ['docs/adr/'], {
    lifecycle: 'supersede',
    defaultBranch: 'main',
  });
  assert.deepEqual(scope.files, ['docs/adr/adr-904-run.md']);
  assert.equal(scope.only, true);
});

test('a closed record leaves the scope under the supersede lifecycle', async (t) => {
  const dir = repo(t, { [RECORD]: RECORD_TEXT });
  commitTree(
    dir,
    {
      'docs/adr/adr-906-closed.md': '# ADR-906\n\n**Status:** Superseded by ADR-907 (2026-01-01)\n',
      'docs/adr/adr-907-open.md': '# ADR-907\n\n**Status:** Accepted\nSupersedes: ADR-906\n',
    },
    'a supersession',
  );
  const scope = await recordScope(dir, ['docs/adr/'], {
    lifecycle: 'supersede',
    defaultBranch: 'main',
  });
  assert.deepEqual(scope.files, ['docs/adr/adr-907-open.md']);
});

// -- the briefs ----------------------------------------------------------------

const JUDGED = { records: [RECORD], reason: 'the diff moved past it', neighbours: [] };

test('all three briefs carry the criteria, the gate command and the constitution', () => {
  const base = { ...BASE, worktree: '/tmp/none' };
  const briefs = [
    birthRole(base, { key: 'a-1', path: 'ticket.md' }, [], null),
    writeRole(base, JUDGED, null),
    correctiveRole(base, JUDGED, { findings: [], advisory: [], brief: null }),
  ];
  for (const text of briefs) {
    assert.ok(text.includes(RECORD_RULE), 'a brief states the rule behind the criteria');
    for (const key of RECORD_CRITERION_KEYS) {
      assert.ok(text.includes(RECORD_CRITERIA[key]), `a brief drops the ${key} criterion`);
    }
    assert.match(text, /pnpm gate:adr-form/, 'a brief names no gate command');
    assert.match(text, /before you report/);
    assert.match(text, /constitution block/);
  }
});

test('every brief carries the writing directions as prose, and no report table', () => {
  const base = { ...BASE, worktree: '/tmp/none' };
  for (const text of [
    birthRole(base, { key: 'a-1' }, [], null),
    writeRole(base, JUDGED, null),
    correctiveRole(base, JUDGED, { findings: [], advisory: [], brief: null }),
  ]) {
    assert.match(text, /Check every present-tense sentence against the tree/);
    assert.match(text, /cite the path in the record/);
    assert.match(text, /Name every divergence/);
    assert.match(text, /Read every active record that cites the one you supersede/);
    assert.match(text, /A record does not cite the standard/);
    // The tables and the enumeration step leave with the checks (ADR-0080).
    assert.ok(!text.includes('"units"'), 'a brief still asks for a unit table');
    assert.ok(!text.includes('"siblings"'), 'a brief still asks for a sibling table');
    assert.ok(!text.includes('"divergences"'), 'a brief still asks for a divergence table');
    assert.ok(!text.includes('olympus-units.mjs'), 'a writer is still sent to enumerate');
  }
});

test('a records-lane write brief names the record and no git diff', () => {
  const text = writeRole({ ...BASE, worktree: '/tmp/none' }, JUDGED, null);
  assert.ok(!text.includes('git diff'), 'the records lane has no code diff to read');
  assert.match(text, /this branch's own work/);
});

test('a story-lane write brief keeps the diff it answers', () => {
  const text = writeRole({ ...BASE, mode: 'story', worktree: '/tmp/none' }, JUDGED, null);
  assert.match(text, /git diff main\.\.\.HEAD/);
});

test('the corrective brief states the findings, the remarks and the dispute route', () => {
  const finding = {
    id: 'F3',
    criterion: 'truth',
    file: RECORD,
    unit: 'U2',
    head: 'The helper lives at',
    summary: 'the helper moved',
    evidence: 'src/other.mjs:1',
  };
  const remark = { ...finding, id: 'F4', severity: 'MED' };
  const text = correctiveRole({ ...BASE, worktree: '/tmp/none' }, JUDGED, {
    findings: [finding],
    advisory: [remark],
    brief: null,
  });
  assert.ok(text.includes(findingLine(finding)));
  assert.ok(text.includes(remarkLine(remark)));
  assert.match(text, /List every finding id in "answered"/);
  assert.match(text, /"disputed"/);
  assert.match(text, /The next review reads that record fresh/);
});

test('a consistent finding names the second record on its line', () => {
  const line = findingLine({
    id: 'F5',
    criterion: 'consistent',
    file: RECORD,
    file2: 'docs/adr/adr-901-the-other.md',
    unit: 'U2',
    head: 'The helper lives at',
    unit2: 'U4',
    head2: 'The helper is one module',
    summary: 'the two decide one unbuilt part two ways',
    evidence: 'both records',
  });
  assert.match(line, /adr-901-the-other\.md/);
  assert.match(line, /U4/);
  // The record brief and the code brief write one clause for one thing.
  assert.equal(
    codeFindingLine({ id: 'F5', summary: 'x', evidence: 'y', file2: 'a.md', unit2: 'U4', head2: 'h' })
      .includes('a.md'),
    true,
  );
});

test('the supersede rule stands in every brief the lifecycle binds', () => {
  const base = { ...BASE, worktree: '/tmp/none' };
  for (const text of [
    birthRole(base, { key: 'a-1' }, [], null),
    writeRole(base, JUDGED, null),
    correctiveRole(base, JUDGED, { findings: [], advisory: [], brief: null }),
  ]) {
    assert.match(text, /never edits an accepted one/);
    assert.match(text, /Supersedes: <list>/);
    assert.match(text, /Superseded by <list>/);
    assert.match(text, /The project form gate reads that pairing/);
  }
  const rewrite = writeRole({ ...base, recordLifecycle: 'rewrite' }, JUDGED, null);
  assert.ok(!rewrite.includes('Supersedes: <list>'));
  assert.match(rewrite, /status-line change of an old record is not a rewrite/);
});

test('the brief says once that a status-line change is not a rewrite', () => {
  const text = writeRole({ ...BASE, worktree: '/tmp/none' }, JUDGED, null);
  const hits = text.split('status-line change of an old record is not a rewrite').length - 1;
  assert.equal(hits, 1);
});

test('the neighbourhood rides the brief, with the count the cap dropped', () => {
  const text = writeRole({ ...BASE, worktree: '/tmp/none' }, {
    ...JUDGED,
    neighbours: { neighbours: ['docs/adr/adr-901-the-other.md'], dropped: 4 },
  }, null);
  assert.match(text, /adr-901-the-other\.md/);
  assert.match(text, new RegExp(`capped at ${NEIGHBOUR_CAP}`));
  assert.match(text, /4 more active records/);
});

test('the three seat names are the three keys of the budget and the cost series', () => {
  assert.equal(AUTHOR_SEAT, 'record-author');
  assert.equal(WRITE_SEAT, 'reconcile-write');
  assert.equal(REVIEW_SEAT, 'record-review');
});

// -- the record list -----------------------------------------------------------

test('the record list has one form, and the tree shape reads it', () => {
  assert.deepEqual(parseRecordList('ADR-101'), [101]);
  assert.deepEqual(parseRecordList('ADR-101, ADR-102 and ADR-103'), [101, 102, 103]);
  assert.equal(parseRecordList('ADR-101 ADR-102'), null);
  assert.equal(parseRecordList('the first one'), null);
});
