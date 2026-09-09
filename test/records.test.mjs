import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { commitTree, gitSync, initOriginRepo, removeDir, tempDir, writeTree } from './helpers.mjs';
import { checkReportSchema, validateReport } from '../src/seats/contract.mjs';
import { RECORD_CRITERIA, RECORD_CRITERION_KEYS, RECORD_RULE } from '../src/lanes/lenses.mjs';
import { NEIGHBOUR_CAP, recordUnits } from '../src/lanes/units.mjs';
import {
  AUTHOR_SEAT,
  REVIEW_SEAT,
  UNITS_BIN,
  WRITE_SEAT,
  birthRole,
  correctiveRole,
  findingLine,
  kindTest,
  parseRecordList,
  reconcileWriteSchema,
  recordScope,
  remarkLine,
  runWindow,
  siblingChecks,
  supersedeChecks,
  unitChecks,
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
  writeTree(dir, { [RECORD]: RECORD_TEXT, 'src/feature.mjs': 'export const f = (x) => x * 2;\n', ...files });
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

/** The four entries a complete report carries for the fixture record. */
function completeUnits(over = {}) {
  return [
    { record: RECORD, id: 'U0', kind: 'title', verdict: 'holds', evidence: 'the title' },
    { record: RECORD, id: 'U1', kind: 'status', verdict: 'holds', evidence: 'the status line' },
    { record: RECORD, id: 'U2', kind: 'claim', verdict: 'holds', evidence: 'src/feature.mjs:1' },
    { record: RECORD, id: 'U3', kind: 'rationale', verdict: 'holds', evidence: 'the reason' },
  ].map((entry) => ({ ...entry, ...(over[entry.id] ?? {}) }));
}

function reportWith(units, over = {}) {
  return {
    rewritten: [RECORD],
    unchanged: [],
    units,
    divergences: [],
    summary: 'the record states what shipped',
    ...over,
  };
}

// -- the report shape (point 2) -----------------------------------------------

test('the write schema carries the units, the divergence evidence and the siblings', () => {
  const base = reconcileWriteSchema({ units: true });
  assert.deepEqual(checkReportSchema(base), []);
  assert.ok(base.required.includes('units'));
  assert.ok(!base.required.includes('answered'));
  assert.ok(!base.required.includes('siblings'));
  // The three fields are asked for by the dispatch. A dispatch that asks for
  // none takes the shape the write answered before this contract, and every
  // field is still in the shape, so a seat that answers more is never refused.
  const plain = reconcileWriteSchema();
  assert.deepEqual(checkReportSchema(plain), []);
  assert.ok(!plain.required.includes('units'));
  assert.ok(plain.properties.units !== undefined);
  assert.deepEqual(plain.properties.divergences.items.required, ['record', 'state', 'statement']);
  assert.deepEqual(base.properties.units.items.required, [
    'record',
    'id',
    'kind',
    'verdict',
    'evidence',
  ]);
  assert.deepEqual(base.properties.units.items.properties.kind.enum, [
    'title',
    'status',
    'claim',
    'open',
    'rationale',
    'reference',
  ]);
  assert.deepEqual(base.properties.units.items.properties.verdict.enum, [
    'holds',
    'fails',
    'not-built',
  ]);
  // A divergence carries the place in the tree that shows it, so an eval can
  // ask how many recorded shifts were wrong without re-reading the run.
  assert.deepEqual(base.properties.divergences.items.required, [
    'record',
    'state',
    'statement',
    'evidence',
  ]);
  // The sibling answers are in the shape whatever the dispatch asks for, so a
  // seat that answers a sibling nobody asked about is never refused for it. The
  // requirement is the dispatch's own (ADR-0079).
  assert.ok(plain.properties.siblings !== undefined);
  assert.deepEqual(validateReport(plain, reportWith(completeUnits(), { siblings: [] })), []);
  const both = reconcileWriteSchema({ answered: true, siblings: true });
  assert.deepEqual(checkReportSchema(both), []);
  assert.ok(both.required.includes('answered'));
  assert.ok(both.required.includes('siblings'));
  assert.deepEqual(both.properties.siblings.items.properties.state.enum, [
    'consistent',
    'superseded',
  ]);
  assert.deepEqual(both.properties.siblings.items.required, ['record', 'state', 'reason']);
  // The shape validates a report the seat could write.
  assert.deepEqual(
    validateReport(base, reportWith(completeUnits(), { divergences: [] })),
    [],
  );
});

test('the write shape is the function alone: no dispatch takes a pre-built one', () => {
  // Both dispatches build their own shape from what their brief asked for, so a
  // constant beside the function is a second shape nothing reads. A reader that
  // took it would send a seat a shape its brief never matched.
  const source = readFileSync(join(import.meta.dirname, '..', 'src/lanes/records.mjs'), 'utf8');
  assert.ok(!source.includes('RECONCILE_WRITE_SCHEMA'), 'records.mjs still holds the constant');
});

// -- the eight refusals (point 2) ---------------------------------------------

test('unit check 1 refuses a report that leaves a unit unanswered', (t) => {
  const dir = tree(t);
  const units = completeUnits().filter((entry) => entry.id !== 'U2');
  const defects = unitChecks({ worktree: dir }, [RECORD], reportWith(units));
  assert.equal(defects.length, 1);
  assert.match(defects[0], /^unit check 1: /);
  assert.match(defects[0], /U2 \(line 7, "The helper lives at `src\/feature\.mjs`\."\)/);
  // A report with no units at all is the same refusal.
  assert.match(
    unitChecks({ worktree: dir }, [RECORD], { rewritten: [], unchanged: [] })[0],
    /^unit check 1: your report carries no "units"/,
  );
});

test('unit check 2 refuses an entry naming a unit the file does not hold', (t) => {
  const dir = tree(t);
  const units = [...completeUnits(), { record: RECORD, id: 'U9', kind: 'claim', verdict: 'holds', evidence: 'src/feature.mjs' }];
  const defects = unitChecks({ worktree: dir }, [RECORD], reportWith(units));
  assert.equal(defects.length, 1);
  assert.match(defects[0], /^unit check 2: "units" names .*U9, which the file does not hold/);
  assert.ok(defects[0].includes(UNITS_BIN));
  // And an entry naming a record this dispatch does not hold.
  const other = [...completeUnits(), { record: 'docs/adr/adr-901-other.md', id: 'U0', kind: 'title', verdict: 'holds', evidence: 'the title' }];
  assert.match(
    unitChecks({ worktree: dir }, [RECORD], reportWith(other))[0],
    /^unit check 2: "units" names docs\/adr\/adr-901-other\.md, which is not a record of this dispatch/,
  );
});

test('unit check 3 refuses two entries for one unit', (t) => {
  const dir = tree(t);
  const units = completeUnits();
  const defects = unitChecks({ worktree: dir }, [RECORD], reportWith([...units, units[2]]));
  assert.equal(defects.length, 1);
  assert.match(defects[0], /^unit check 3: .*U2 has 2 entries in "units"/);
});

test('unit check 4 refuses a claim whose evidence names no path in the worktree', (t) => {
  const dir = tree(t);
  const missing = unitChecks(
    { worktree: dir },
    [RECORD],
    reportWith(completeUnits({ U2: { evidence: 'src/absent.mjs:12' } })),
  );
  assert.equal(missing.length, 1);
  assert.match(missing[0], /^unit check 4: .*U2 .*cites src\/absent\.mjs and the worktree holds no such path/);
  const vague = unitChecks(
    { worktree: dir },
    [RECORD],
    reportWith(completeUnits({ U2: { evidence: 'the code does it' } })),
  );
  assert.equal(vague.length, 1);
  assert.match(vague[0], /^unit check 4: .*evidence names no path/);
  // A path with a line, and a path without one, both answer.
  for (const evidence of ['src/feature.mjs:1', 'src/feature.mjs', '`src/feature.mjs`']) {
    assert.deepEqual(
      unitChecks({ worktree: dir }, [RECORD], reportWith(completeUnits({ U2: { evidence } }))),
      [],
      evidence,
    );
  }
});

test('unit check 5 refuses a claim filed as rationale', (t) => {
  const dir = tree(t);
  const defects = unitChecks(
    { worktree: dir },
    [RECORD],
    reportWith(completeUnits({ U2: { kind: 'rationale', evidence: 'the reason' } })),
  );
  assert.equal(defects.length, 1);
  assert.match(defects[0], /^unit check 5: .*U2 is filed as rationale and its text reads as a claim/);
});

// -- the reference kind and its check (plan 41, point 1) ----------------------

const CITING = 'docs/adr/adr-901-the-citing-record.md';
const CLOSED = 'docs/adr/adr-899-the-closed-record.md';

/** A record whose reference section names a record, a path and a link. */
function citingText(references) {
  return [
    '# ADR-901: The record that cites another',
    '',
    '**Status:** Accepted',
    '',
    '## Decision',
    '',
    'The helper lives at `src/feature.mjs`.',
    '',
    '## References',
    '',
    ...references,
    '',
  ].join('\n');
}

const CLOSED_TEXT = [
  '# ADR-899: The record this one replaces',
  '',
  '**Status:** Superseded by ADR-901 (2026-09-09)',
  '',
  '## Decision',
  '',
  'The helper doubled its input.',
  '',
].join('\n');

/** A tree that declares its record paths, so the reference check reads them. */
function citingTree(t, references, files = {}) {
  return tree(t, { [CITING]: citingText(references), ...files });
}

const CITING_BASE = (dir) => ({ worktree: dir, recordPaths: ['docs/adr'] });

/** One entry per unit of a record, the enumeration's own kinds kept. */
function unitsOf(dir, record, over = {}) {
  return recordUnits(readFileSync(join(dir, record), 'utf8')).map((unit) => {
    const read = unit.kind ?? (kindTest(unit.head) ? 'claim' : 'rationale');
    return {
      record,
      id: unit.id,
      kind: read,
      verdict: 'holds',
      evidence: read === 'claim' ? 'src/feature.mjs:1' : 'one short sentence',
      ...(over[unit.id] ?? {}),
    };
  });
}

function citingReport(dir, over = {}) {
  return {
    rewritten: [CITING],
    unchanged: [],
    units: unitsOf(dir, CITING, over),
    divergences: [],
    summary: 'the record states what shipped',
  };
}

test('unit check 9 refuses any kind but reference on a unit of the reference section', (t) => {
  const dir = citingTree(t, ['- ADR-900, the record this one narrows']);
  const base = CITING_BASE(dir);
  // The seat's guess, either way it guessed this run: a claim with the cited
  // record's path as evidence, or rationale.
  const claimed = unitChecks(base, [CITING], citingReport(dir, { U3: { kind: 'claim' } }));
  assert.equal(claimed.length, 1);
  assert.match(claimed[0], /^unit check 9: .*U3 .*stands under "## References" and you file it as "claim"/);
  const rationale = unitChecks(base, [CITING], citingReport(dir, { U3: { kind: 'rationale' } }));
  assert.equal(rationale.length, 1);
  assert.match(rationale[0], /^unit check 9: /);
  // The kind the enumeration named passes, and nothing else is asked of it.
  assert.deepEqual(unitChecks(base, [CITING], citingReport(dir)), []);
});

test('unit check 9 refuses the reference kind on a unit of the body', (t) => {
  const dir = citingTree(t, ['- ADR-900, the record this one narrows']);
  const defects = unitChecks(CITING_BASE(dir), [CITING], citingReport(dir, { U2: { kind: 'reference' } }));
  assert.equal(defects.length, 1);
  assert.match(defects[0], /^unit check 9: .*U2 .*is filed as "reference" and it stands under no/);
});

// The gloss the live tree writes on half its reference bullets holds a claim
// verb. Check 5 read it and refused the report; the kind is the harness's now,
// so nothing reads the verb.
test('unit check 5 never fires on a reference unit whose gloss reads as a claim', (t) => {
  const dir = citingTree(t, ['- ADR-900, the standard this record is written to']);
  const head = recordUnits(readFileSync(join(dir, CITING), 'utf8')).find((u) => u.id === 'U3').head;
  assert.equal(kindTest(head), 'claim');
  assert.deepEqual(unitChecks(CITING_BASE(dir), [CITING], citingReport(dir)), []);
});

test('unit check 9 refuses a reference to a record id the tree does not hold', (t) => {
  const dir = citingTree(t, ['- ADR-999, a record nobody wrote']);
  const defects = unitChecks(CITING_BASE(dir), [CITING], citingReport(dir));
  assert.equal(defects.length, 1);
  assert.match(defects[0], /^unit check 9: .*cites ADR-999 and the record tree holds no record of that id/);
});

test('unit check 9 refuses a reference to a path the worktree does not hold', (t) => {
  const dir = citingTree(t, ['- `scripts/nowhere.ts`, the checker']);
  const defects = unitChecks(CITING_BASE(dir), [CITING], citingReport(dir));
  assert.equal(defects.length, 1);
  assert.match(defects[0], /^unit check 9: .*cites scripts\/nowhere\.ts and the worktree holds no such path/);
  // The path the tree does hold passes, in every form a record writes it.
  for (const bullet of ['- `src/feature.mjs`', '- src/feature.mjs, the helper', '- docs/adr/adr-900-the-helper.md']) {
    const held = citingTree(t, [bullet]);
    assert.deepEqual(unitChecks(CITING_BASE(held), [CITING], citingReport(held)), [], bullet);
  }
});

// A record cites the record it supersedes, and that record is closed by the
// same diff. The check reads the whole record tree, at any status.
test('a reference to a superseded record passes', (t) => {
  const dir = citingTree(t, ['- ADR-899, the record this one replaces'], { [CLOSED]: CLOSED_TEXT });
  assert.deepEqual(unitChecks(CITING_BASE(dir), [CITING], citingReport(dir)), []);
});

// A link names a document outside the repository. The harness says nothing
// about one, and a reference that names nothing at all is the defect.
test('unit check 9 takes a link as a name and refuses a reference that names nothing', (t) => {
  const linked = citingTree(t, ['- [the upstream note](https://example.invalid/notes)']);
  assert.deepEqual(unitChecks(CITING_BASE(linked), [CITING], citingReport(linked)), []);
  const bare = citingTree(t, ['- PRD NFR24, the requirement behind this decision']);
  const defects = unitChecks(CITING_BASE(bare), [CITING], citingReport(bare));
  assert.equal(defects.length, 1);
  assert.match(defects[0], /^unit check 9: .*names no record, no path and no link/);
});

// The proof it can still fail: one record, two bad references, both named in
// the text the seat is given.
test('a record citing a missing id and a missing path is refused with both names', (t) => {
  const dir = citingTree(t, ['- ADR-999, a record nobody wrote', '- `scripts/nowhere.ts`, the checker']);
  const defects = unitChecks(CITING_BASE(dir), [CITING], citingReport(dir));
  assert.equal(defects.length, 2);
  assert.ok(defects.some((d) => d.includes('ADR-999')), defects.join('\n'));
  assert.ok(defects.some((d) => d.includes('scripts/nowhere.ts')), defects.join('\n'));
});

// The kind is not the seat's escape: a path, a symbol in backticks or one of
// the closed verbs makes a sentence a claim about the tree.
test('the kind test reads a path, a symbol and the closed verb list', () => {
  assert.equal(kindTest('The seat reads the record whole.'), 'claim');
  assert.equal(kindTest('The report is one file.'), 'claim');
  assert.equal(kindTest('Two shas are two facts.'), 'claim');
  assert.equal(kindTest('`recordScope` takes a range.'), 'claim');
  assert.equal(kindTest('The check lives in src/lanes/records.mjs today.'), 'claim');
  assert.equal(kindTest('The tree holds docs/style/anti-slop.md.'), 'claim');
  assert.equal(kindTest('Why: the alternative cost a second module.'), null);
  assert.equal(kindTest('Rejected: a per-combination enumeration, which blows up.'), null);
  assert.equal(kindTest('Reversal trigger: a second consumer of the same table.'), null);
  // A word with a slash is not a path.
  assert.equal(kindTest('The trade holds either way, and/or costs nothing.'), null);
});

test('unit check 6 refuses a writer report that leaves a unit failing', (t) => {
  const dir = tree(t);
  const defects = unitChecks(
    { worktree: dir },
    [RECORD],
    reportWith(completeUnits({ U2: { verdict: 'fails' } })),
    { seat: 'writer' },
  );
  assert.equal(defects.length, 1);
  assert.match(defects[0], /^unit check 6: .*U2 is reported "fails" and you wrote this record/);
  // A part the tree does not hold is not a failure: it is stated as not built.
  assert.deepEqual(
    unitChecks({ worktree: dir }, [RECORD], reportWith(completeUnits({ U2: { verdict: 'not-built' } })), {
      seat: 'writer',
    }),
    [],
  );
});

test('unit checks 7 and 8 hold the review report and its findings together', (t) => {
  const dir = tree(t);
  const finding = { id: 'F1', file: RECORD, unit: 'U2', criterion: 'truth' };
  // A unit that fails is a finding.
  const silent = unitChecks(
    { worktree: dir },
    [RECORD],
    reportWith(completeUnits({ U2: { verdict: 'fails' } })),
    { seat: 'review', findings: [] },
  );
  assert.equal(silent.length, 1);
  assert.match(silent[0], /^unit check 7: .*U2 is reported "fails" and no finding names it/);
  // And a finding is a unit that fails.
  const contradiction = unitChecks({ worktree: dir }, [RECORD], reportWith(completeUnits()), {
    seat: 'review',
    findings: [finding],
  });
  assert.equal(contradiction.length, 1);
  assert.match(contradiction[0], /^unit check 8: finding F1 names .*U2 and you reported that unit "holds"/);
  // The two together pass, and a review may report a failing unit.
  assert.deepEqual(
    unitChecks({ worktree: dir }, [RECORD], reportWith(completeUnits({ U2: { verdict: 'fails' } })), {
      seat: 'review',
      findings: [finding],
    }),
    [],
  );
  // Rule 6 binds the writer alone: a review may report a failure.
  assert.deepEqual(
    unitChecks({ worktree: dir }, [RECORD], reportWith(completeUnits({ U2: { verdict: 'fails' } })), {
      seat: 'review',
      findings: [finding],
    }),
    [],
  );
});

// Rules 1 to 5 bind every record seat. A review that answers half the record
// samples it exactly as a writer does.
test('rules 1 to 5 refuse a review report as they refuse a writer report', (t) => {
  const dir = tree(t);
  const opts = { seat: 'review', findings: [] };
  const short = unitChecks({ worktree: dir }, [RECORD], reportWith(completeUnits().slice(0, 3)), opts);
  assert.match(short[0], /^unit check 1: /);
  const invented = unitChecks(
    { worktree: dir },
    [RECORD],
    reportWith([...completeUnits(), { record: RECORD, id: 'U9', kind: 'open', verdict: 'holds', evidence: 'none' }]),
    opts,
  );
  assert.match(invented[0], /^unit check 2: /);
  const twice = completeUnits();
  const doubled = unitChecks({ worktree: dir }, [RECORD], reportWith([...twice, twice[0]]), opts);
  assert.match(doubled[0], /^unit check 3: /);
  const vague = unitChecks(
    { worktree: dir },
    [RECORD],
    reportWith(completeUnits({ U2: { evidence: 'the tree says so' } })),
    opts,
  );
  assert.match(vague[0], /^unit check 4: /);
  const filed = unitChecks(
    { worktree: dir },
    [RECORD],
    reportWith(completeUnits({ U2: { kind: 'rationale' } })),
    opts,
  );
  assert.match(filed[0], /^unit check 5: /);
});

test('a complete report passes every rule, for both seats', (t) => {
  const dir = tree(t);
  assert.deepEqual(
    unitChecks({ worktree: dir }, [RECORD], reportWith(completeUnits()), { seat: 'writer' }),
    [],
  );
  assert.deepEqual(
    unitChecks({ worktree: dir }, [RECORD], reportWith(completeUnits()), {
      seat: 'review',
      findings: [],
    }),
    [],
  );
});

// The checks are one function for every seat, and `writeChecks` is what the
// lanes call. A report that carries units is checked whether the caller named a
// seat or not.
test('writeChecks runs the unit checks over what the seat left', async (t) => {
  const dir = repo(t, { [RECORD]: RECORD_TEXT, 'src/feature.mjs': 'export const f = (x) => x * 2;\n' });
  const base = { worktree: dir, recordPaths: ['docs/adr'] };
  // The seat rewrote the record it was given, and answered every unit.
  writeFileSync(join(dir, RECORD), `${RECORD_TEXT}\nThe helper doubles.\n`);
  const clean = reportWith(completeUnits(), {
    units: [
      ...completeUnits(),
      { record: RECORD, id: 'U4', kind: 'claim', verdict: 'holds', evidence: 'src/feature.mjs:1' },
    ],
    divergences: [
      { record: RECORD, state: 'none', statement: 'the record and the tree agree', evidence: 'src/feature.mjs:1' },
    ],
  });
  assert.deepEqual(await writeChecks(base, [RECORD], clean, { seat: 'writer' }), []);
  // A unit the report leaves out is refused through the same call.
  const short = { ...clean, units: completeUnits() };
  const defects = await writeChecks(base, [RECORD], short, { seat: 'writer' });
  assert.equal(defects.length, 1);
  assert.match(defects[0], /^unit check 1: /);
  // The containment check still refuses a change outside the record tree.
  writeFileSync(join(dir, 'src/feature.mjs'), 'export const f = (x) => x * 3;\n');
  const outside = await writeChecks(base, [RECORD], clean, { seat: 'writer' });
  assert.equal(outside.length, 1);
  assert.match(outside[0], /^change outside the decision-record tree: src\/feature\.mjs/);
});

// -- the window (ADR-0079) ----------------------------------------------------

/** Four accepted records on the default branch, and a run branch over them. */
function windowRepo(t, extra = {}) {
  const records = {};
  for (const id of ['001', '002', '003', '004']) {
    records[`docs/adr/adr-${id}-a.md`] = `# ADR-${id}: A record\n\n**Status:** Accepted\n\n## Decision\n\nOne sentence.\n`;
  }
  const dir = repo(t, { 'src/feature.mjs': 'export const f = (x) => x;\n', ...records, ...extra });
  return { dir, records };
}

/** One commit on the default branch, and the run branch merges it back. */
function mainMoves(dir, files, message) {
  gitSync(['checkout', '-q', 'main'], dir);
  const sha = commitTree(dir, files, message);
  gitSync(['checkout', '-q', 'run'], dir);
  gitSync(['-c', 'commit.gpgsign=false', 'merge', '-m', 'merge main', sha], dir);
  return sha;
}

test('runWindow answers the merge base and the record files the run changed (W19)', async (t) => {
  const { dir, records } = windowRepo(t);
  const start = gitSync(['rev-parse', 'HEAD'], dir).trim();
  const touched = {};
  for (const path of Object.keys(records)) touched[path] = `${records[path]}\nThe run rewrote it.\n`;
  commitTree(dir, touched, 'records: the run rewrites four');
  const base = { worktree: dir, defaultBranch: 'main', recordPaths: ['docs/adr'] };
  const window = await runWindow(base);
  assert.equal(window.base, start);
  assert.equal(window.error, null);
  assert.deepEqual(window.files.slice().sort(), Object.keys(records).sort());
  // A record the default branch gained is never the run's, and the merge that
  // brings it in moves the base rather than the set.
  const moved = mainMoves(dir, { 'docs/adr/adr-006-a.md': ACCEPTED('006') }, 'records: main adds one');
  const after = await runWindow(base);
  assert.equal(after.base, moved);
  assert.ok(!after.files.includes('docs/adr/adr-006-a.md'), after.files.join(', '));
  assert.deepEqual(after.files.slice().sort(), Object.keys(records).sort());
  // The worktree half: a record this dispatch has not committed is in the
  // window as well.
  writeTree(dir, { 'docs/adr/adr-005-a.md': ACCEPTED('005') });
  assert.deepEqual(
    (await runWindow(base)).files.slice().sort(),
    [...Object.keys(records), 'docs/adr/adr-005-a.md'].sort(),
  );
});

test('a window read that fails answers the error and never an empty window', async (t) => {
  const { dir } = windowRepo(t);
  const window = await runWindow({
    worktree: dir,
    defaultBranch: 'no-such-branch',
    recordPaths: ['docs/adr'],
  });
  assert.equal(window.base, null);
  assert.deepEqual(window.files, []);
  assert.match(window.error, /^merge-base HEAD no-such-branch: /);
});

test('a run resumed on an inherited freeze holds the records it inherited', async (t) => {
  // A story launch may start on a prior run's frozen commit. That commit holds
  // the records the prior run was born with, and the branch carries them, so
  // the window this run reads holds them beside its own (ADR-0079). The window
  // is the run's branch against the default branch, and this is what that
  // means for a resumed run: it reviews what it inherited.
  const { dir } = windowRepo(t);
  const inherited = 'docs/adr/adr-010-inherited.md';
  const own = 'docs/adr/adr-011-own.md';
  commitTree(dir, { [inherited]: ACCEPTED('010') }, 'records: the run this one resumes wrote it');
  commitTree(dir, { [own]: ACCEPTED('011') }, 'records: this run writes it');
  const base = { worktree: dir, defaultBranch: 'main', recordPaths: ['docs/adr'] };
  const window = await runWindow(base);
  assert.deepEqual(window.files.slice().sort(), [inherited, own]);
  assert.deepEqual(
    (await recordScope(dir, ['docs/adr'], { defaultBranch: 'main' })).files.slice().sort(),
    [inherited, own],
  );
});

// -- the record set (point 5) -------------------------------------------------

test('recordScope reads the run window, and never a record main gained', async (t) => {
  const { dir, records } = windowRepo(t);
  const touched = {};
  for (const path of Object.keys(records)) touched[path] = `${records[path]}\nThe run rewrote it.\n`;
  commitTree(dir, touched, 'records: the run rewrites four');
  // The round touches one, and the window still holds all four.
  commitTree(
    dir,
    { 'docs/adr/adr-001-a.md': `${touched['docs/adr/adr-001-a.md']}\nThe round rewrote it.\n` },
    'records: the round rewrites one',
  );
  const paths = ['docs/adr'];
  const opts = { defaultBranch: 'main' };
  assert.deepEqual((await recordScope(dir, paths, opts)).files.slice().sort(), Object.keys(records));
  // `only` says whether the window holds anything but records.
  assert.equal((await recordScope(dir, paths, opts)).only, true);
  commitTree(dir, { 'src/feature.mjs': 'export const f = (x) => x + 1;\n' }, 'code');
  assert.equal((await recordScope(dir, paths, opts)).only, false);
  assert.deepEqual((await recordScope(dir, paths, opts)).files.slice().sort(), Object.keys(records));
  // Under the supersede lifecycle a closed record is out of every seat's scope.
  commitTree(
    dir,
    {
      'docs/adr/adr-002-a.md': `# ADR-002: A record\n\n**Status:** Superseded by ADR-004 (2026-09-07)\n\n## Decision\n\nOne sentence.\n`,
    },
    'records: adr-002 is superseded',
  );
  assert.deepEqual(
    (await recordScope(dir, paths, { ...opts, lifecycle: 'supersede' })).files.slice().sort(),
    ['docs/adr/adr-001-a.md', 'docs/adr/adr-003-a.md', 'docs/adr/adr-004-a.md'],
  );
  assert.equal((await recordScope(dir, paths, opts)).files.length, 4);
  // The template is not a record.
  assert.deepEqual(
    (await recordScope(dir, ['docs/adr', '!docs/adr/adr-001-a.md'], opts)).files.slice().sort(),
    ['docs/adr/adr-002-a.md', 'docs/adr/adr-003-a.md', 'docs/adr/adr-004-a.md'],
  );
  // After a merge of a moved default branch the scope holds the run's records
  // alone, and the base it answers is the merge base.
  const moved = mainMoves(dir, { 'docs/adr/adr-007-a.md': ACCEPTED('007') }, 'records: main adds one');
  const scope = await recordScope(dir, paths, opts);
  assert.equal(scope.base, moved);
  assert.deepEqual(scope.files.slice().sort(), Object.keys(records));
});

// -- the supersede lifecycle (point 6) ----------------------------------------

const ACCEPTED = (id, body = 'The decision stands.') =>
  `# ADR-${id}: A record\n\n**Status:** Accepted\n\n## Decision\n\n${body}\n`;

const SUPERSEDER = (id, parents, body = 'The decision stands now.') =>
  `# ADR-${id}: A record\n\n**Status:** Accepted\n**Supersedes:** ${parents}\n\n## Decision\n\n${body}\n`;

function superseded(id, list, body = 'The decision stands.') {
  return ACCEPTED(id, body).replace('**Status:** Accepted', `**Status:** Superseded by ${list} (2026-09-07)`);
}

function lifecycleBase(dir) {
  return {
    worktree: dir,
    defaultBranch: 'main',
    recordLifecycle: 'supersede',
    recordPaths: ['docs/adr', '!docs/adr/TEMPLATE.md'],
  };
}

function acceptedTree(t) {
  return repo(t, {
    'docs/adr/adr-001-first.md': ACCEPTED('001'),
    'docs/adr/adr-002-second.md': ACCEPTED('002', 'The second decision stands.'),
    'docs/adr/TEMPLATE.md': '# ADR-<id>: <title>\n\n**Status:** Accepted\n',
    'src/feature.mjs': 'export const f = (x) => x;\n',
  });
}

const REPORT = { rewritten: [], unchanged: [], units: [], divergences: [], summary: 'done' };

test('an accepted record takes no edit but its status line', async (t) => {
  const dir = acceptedTree(t);
  writeTree(dir, { 'docs/adr/adr-001-first.md': ACCEPTED('001', 'The decision changed.') });
  const defects = await supersedeChecks(lifecycleBase(dir), [], REPORT);
  assert.equal(defects.length, 1);
  assert.match(defects[0], /is an accepted record and this diff changes more than its status line/);
  // The body is kept verbatim, so a supersession that empties it is refused.
  writeTree(dir, {
    'docs/adr/adr-001-first.md': '# ADR-001: A record\n\n**Status:** Superseded by ADR-003 (2026-09-07)\n',
    'docs/adr/adr-003-third.md': SUPERSEDER('003', 'ADR-001'),
  });
  const emptied = await supersedeChecks(lifecycleBase(dir), [], REPORT);
  assert.equal(emptied.length, 1);
  assert.match(emptied[0], /changes more than its status line/);
  // And a deletion is refused by name.
  gitSync(['checkout', '-q', '--', '.'], dir);
  gitSync(['clean', '-qfd'], dir);
  rmSync(join(dir, 'docs/adr/adr-001-first.md'));
  const deleted = await supersedeChecks(lifecycleBase(dir), [], REPORT);
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /this diff deletes it/);
});

test('a supersession is written in both directions, one to one, split and merged', async (t) => {
  const dir = acceptedTree(t);
  // One to one.
  writeTree(dir, {
    'docs/adr/adr-001-first.md': superseded('001', 'ADR-003'),
    'docs/adr/adr-003-third.md': SUPERSEDER('003', 'ADR-001'),
  });
  assert.deepEqual(await supersedeChecks(lifecycleBase(dir), [], REPORT), []);
  // A split into three.
  gitSync(['checkout', '--', '.'], dir);
  rmSync(join(dir, 'docs/adr/adr-003-third.md'));
  writeTree(dir, {
    'docs/adr/adr-001-first.md': superseded('001', 'ADR-003, ADR-004 and ADR-005'),
    'docs/adr/adr-003-third.md': SUPERSEDER('003', 'ADR-001'),
    'docs/adr/adr-004-fourth.md': SUPERSEDER('004', 'ADR-001'),
    'docs/adr/adr-005-fifth.md': SUPERSEDER('005', 'ADR-001'),
  });
  assert.deepEqual(await supersedeChecks(lifecycleBase(dir), [], REPORT), []);
  // A merge of two.
  gitSync(['checkout', '--', '.'], dir);
  gitSync(['clean', '-qfd'], dir);
  writeTree(dir, {
    'docs/adr/adr-001-first.md': superseded('001', 'ADR-003'),
    'docs/adr/adr-002-second.md': superseded('002', 'ADR-003', 'The second decision stands.'),
    'docs/adr/adr-003-third.md': SUPERSEDER('003', 'ADR-001 and ADR-002'),
  });
  assert.deepEqual(await supersedeChecks(lifecycleBase(dir), [], REPORT), []);
  // A retirement names no successor and needs none.
  gitSync(['checkout', '--', '.'], dir);
  gitSync(['clean', '-qfd'], dir);
  writeTree(dir, {
    'docs/adr/adr-001-first.md': ACCEPTED('001').replace(
      '**Status:** Accepted',
      '**Status:** Retired (2026-09-07): the gate this record named is gone.',
    ),
  });
  assert.deepEqual(await supersedeChecks(lifecycleBase(dir), [], REPORT), []);
});

test('a supersession whose two directions disagree is refused', async (t) => {
  const dir = acceptedTree(t);
  // A list naming a record that is not in the diff.
  writeTree(dir, { 'docs/adr/adr-001-first.md': superseded('001', 'ADR-003') });
  const absent = await supersedeChecks(lifecycleBase(dir), [], REPORT);
  assert.equal(absent.length, 1);
  assert.match(absent[0], /superseded by ADR-3 and no such record is added in this diff/);
  // A new record with no Supersedes line.
  writeTree(dir, { 'docs/adr/adr-003-third.md': ACCEPTED('003', 'The decision stands now.') });
  const silent = await supersedeChecks(lifecycleBase(dir), [], REPORT);
  assert.equal(silent.length, 1);
  assert.match(silent[0], /carries no "Supersedes: <list>" line/);
  // A new record that names a parent whose status line is untouched.
  gitSync(['checkout', '--', '.'], dir);
  gitSync(['clean', '-qfd'], dir);
  writeTree(dir, { 'docs/adr/adr-003-third.md': SUPERSEDER('003', 'ADR-002') });
  const oneWay = await supersedeChecks(lifecycleBase(dir), [], REPORT);
  assert.equal(oneWay.length, 1);
  assert.match(oneWay[0], /leaves that record's status line unchanged/);
  // A list in another form is refused, so a reader and a writer never disagree
  // about where one id ends.
  gitSync(['clean', '-qfd'], dir);
  writeTree(dir, {
    'docs/adr/adr-001-first.md': superseded('001', 'ADR-003, ADR-004'),
    'docs/adr/adr-003-third.md': SUPERSEDER('003', 'ADR-001'),
    'docs/adr/adr-004-fourth.md': SUPERSEDER('004', 'ADR-001'),
  });
  const form = await supersedeChecks(lifecycleBase(dir), [], REPORT);
  assert.equal(form.length, 3);
  assert.match(form[0], /names its successors as "ADR-003, ADR-004"/);
  // The two new records read the same malformed list from the other side.
  assert.ok(form.slice(1).every((defect) => /status line does not name it/.test(defect)), form[1]);
  assert.deepEqual(parseRecordList('ADR-003, ADR-004 and ADR-005'), [3, 4, 5]);
  assert.deepEqual(parseRecordList('ADR-003 and ADR-004'), [3, 4]);
  assert.deepEqual(parseRecordList('ADR-0026'), [26]);
  assert.equal(parseRecordList('ADR-003, ADR-004'), null);
  assert.equal(parseRecordList('ADR-003 & ADR-004'), null);
  assert.equal(parseRecordList('the first record'), null);
});

test('a record this run added is not accepted, and the template is not a record', async (t) => {
  const dir = acceptedTree(t);
  // The birth stage commits a record on the run branch. It is not on the
  // default branch at the merge base, so a corrective round edits it in place.
  commitTree(dir, { 'docs/adr/adr-006-born.md': ACCEPTED('006', 'The born decision stands.') }, 'records: born');
  writeTree(dir, { 'docs/adr/adr-006-born.md': ACCEPTED('006', 'The born decision is corrected.') });
  assert.deepEqual(await supersedeChecks(lifecycleBase(dir), [], REPORT), []);
  // A record the default branch gained during the run is accepted, whatever the
  // freeze sha holds: the merge base moves with the branch.
  gitSync(['checkout', '-q', '--', '.'], dir);
  gitSync(['checkout', '-q', 'main'], dir);
  commitTree(dir, { 'docs/adr/adr-007-late.md': ACCEPTED('007', 'The late decision stands.') }, 'records: late');
  gitSync(['checkout', '-q', 'run'], dir);
  gitSync(['merge', '-q', '--no-edit', 'main'], dir);
  writeTree(dir, { 'docs/adr/adr-007-late.md': ACCEPTED('007', 'The late decision is edited.') });
  const defects = await supersedeChecks(lifecycleBase(dir), [], REPORT);
  assert.equal(defects.length, 1);
  assert.match(defects[0], /adr-007-late\.md is an accepted record/);
  // The excluded template is not a record, so nothing here reads it.
  gitSync(['checkout', '-q', '--', '.'], dir);
  writeTree(dir, { 'docs/adr/TEMPLATE.md': '# ADR-<id>: <title>\n\n**Status:** Accepted\n\n## Decision\n' });
  assert.deepEqual(await supersedeChecks(lifecycleBase(dir), [], REPORT), []);
});

// -- the siblings (point 7) ---------------------------------------------------

test('every sibling of a supersession is answered, and a superseded one is replaced', async (t) => {
  const dir = acceptedTree(t);
  writeTree(dir, { 'docs/adr/adr-003-third.md': SUPERSEDER('003', 'ADR-001') });
  const base = lifecycleBase(dir);
  const siblings = ['docs/adr/adr-004-cites.md', 'docs/adr/adr-005-cites.md'];
  const answered = {
    siblings: [
      { record: siblings[0], state: 'consistent', reason: 'it cites the id and not the decision' },
      {
        record: siblings[1],
        state: 'superseded',
        reason: 'it decided the same unbuilt part the older way',
        replacement: 'docs/adr/adr-003-third.md',
      },
    ],
  };
  assert.deepEqual(await siblingChecks(base, siblings, answered), []);
  // A sibling nobody answered is a record left citing a decision that no longer
  // stands.
  const short = { siblings: answered.siblings.slice(0, 1) };
  const missing = await siblingChecks(base, siblings, short);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /adr-005-cites\.md cites a record this write supersedes and "siblings" accounts for it nowhere/);
  // The defect names the whole computed list, so a seat that answered part of
  // it reads what the harness counted rather than one record of it (ADR-0079).
  assert.ok(missing[0].includes(`The records that cite what this write closed: ${siblings.join(', ')}.`), missing[0]);
  // A `superseded` answer with no record in the diff is refused.
  const empty = {
    siblings: [
      answered.siblings[0],
      { ...answered.siblings[1], replacement: 'docs/adr/adr-009-absent.md' },
    ],
  };
  const unwritten = await siblingChecks(base, siblings, empty);
  assert.equal(unwritten.length, 1);
  assert.match(unwritten[0], /no record that replaces it is in this round/);
  // An entry for a record that is not a sibling is refused: a record in the
  // run's own scope is answered as itself.
  const extra = {
    siblings: [
      ...answered.siblings,
      { record: 'docs/adr/adr-002-second.md', state: 'consistent', reason: 'this run writes it' },
    ],
  };
  const wrong = await siblingChecks(base, siblings, extra);
  assert.equal(wrong.length, 1);
  assert.match(wrong[0], /which is not a sibling of this write/);
  // Two entries for one sibling is the same refusal shape as a divergence.
  const twice = { siblings: [answered.siblings[0], answered.siblings[0], answered.siblings[1]] };
  const doubled = await siblingChecks(base, siblings, twice);
  assert.equal(doubled.length, 1);
  assert.match(doubled[0], /has 2 entries in "siblings"/);
});

// -- the three briefs (point 3) -----------------------------------------------

const JUDGED = {
  records: ['docs/adr/adr-001-first.md'],
  reason: 'the diff implements it',
  neighbours: { neighbours: ['docs/adr/adr-002-second.md'], dropped: 3 },
};

const FINDING = {
  id: 'F1',
  criterion: 'truth',
  file: 'docs/adr/adr-001-first.md',
  unit: 'U7',
  head: 'The public surface is exactly two routes',
  summary: 'the record states a surface the tree does not hold',
  evidence: 'src/routes.mjs:1',
};

function briefs(base) {
  return {
    birth: birthRole(base, { key: 'alpha-1', path: 'specs/alpha-1.md', touchedPaths: ['src/feature.mjs'] }, JUDGED.neighbours, null),
    write: writeRole(base, JUDGED, null),
    corrective: correctiveRole(base, JUDGED, { findings: [FINDING], divergences: [], brief: null }),
  };
}

test('all three briefs carry the criteria, the unit duty, the neighbourhood and the constitution', () => {
  const base = { worktree: '/tmp/run', defaultBranch: 'main' };
  for (const [name, brief] of Object.entries(briefs(base))) {
    assert.ok(brief.includes(RECORD_RULE), name);
    for (const key of RECORD_CRITERION_KEYS) {
      assert.ok(brief.includes(`- ${RECORD_CRITERIA[key]}`), `${name} ${key}`);
    }
    assert.ok(brief.includes('Edit only the decision-record tree.'), name);
    // The unit duty: the same enumeration the check counts, by absolute path.
    assert.ok(brief.includes(`node ${UNITS_BIN} <record>`), name);
    assert.ok(brief.includes('Every unit of every record you leave is yours.'), name);
    assert.ok(brief.includes('A unit you report as "fails" is a unit you have not finished.'), name);
    // The neighbourhood by path, with the count above the cap.
    assert.ok(brief.includes('- docs/adr/adr-002-second.md'), name);
    assert.ok(brief.includes(`capped at ${NEIGHBOUR_CAP} by rank`), name);
    assert.ok(brief.includes('3 more active records'), name);
    // The constitution.
    assert.ok(brief.includes('binds every sentence you write into a record'), name);
    // No lifecycle rule under `rewrite`.
    assert.ok(!brief.includes('It never edits an accepted one.'), name);
  }
  // The corrective brief names the unit each finding is about.
  const { corrective } = briefs(base);
  assert.ok(corrective.includes('U7 "The public surface is exactly two routes"'), corrective);
  assert.ok(corrective.includes('Every other unit of the record is yours as well.'));
  assert.equal(
    findingLine(FINDING),
    '[F1] [truth] (docs/adr/adr-001-first.md) U7 "The public surface is exactly two routes" ' +
      'the record states a surface the tree does not hold (evidence: src/routes.mjs:1)',
  );
  // The birth brief names the work and its touched paths, and asks for no
  // divergence entry.
  const { birth } = briefs(base);
  assert.ok(birth.includes('Work: alpha-1'));
  assert.ok(birth.includes('Specification: specs/alpha-1.md'));
  assert.ok(birth.includes('- src/feature.mjs'));
  assert.ok(birth.includes('"divergences" takes no entry'));
  // The two reconciliation briefs carry the divergence duty and the diff.
  for (const brief of [briefs(base).write, corrective]) {
    assert.ok(brief.includes('git diff main...HEAD'));
    assert.ok(brief.includes('"divergences" takes exactly one entry per judged record (1)'));
    assert.ok(brief.includes('"evidence": the repo-relative path'));
  }
});

// The remarks ride the brief of the round a HIGH opened on their record, under
// one line that says what they are worth (plan 41, point 2).
test('the corrective brief states the remarks and what answering one means', () => {
  const base = { worktree: '/tmp/run', defaultBranch: 'main' };
  const remark = {
    id: 'F4',
    severity: 'MED',
    criterion: 'reference',
    file: 'docs/adr/adr-001-first.md',
    unit: 'U9',
    head: 'The helper is named twice',
    summary: 'the record spells the helper two ways',
    evidence: 'src/routes.mjs:12',
  };
  const brief = correctiveRole(base, JUDGED, {
    findings: [FINDING],
    divergences: [],
    advisory: [remark],
    brief: null,
  });
  assert.ok(brief.includes('These remarks hold no render red.'), brief);
  assert.ok(
    brief.includes('Answer each one in this write, or state under\n"answered" why the record is right:'),
    brief,
  );
  assert.ok(brief.includes(`- ${remarkLine(remark)}`), brief);
  // The grade rides the remark's line and never a confirmed finding's: every
  // confirmed finding blocks, and the grade would say nothing there.
  assert.ok(brief.includes('- [MED] [F4] [reference]'), brief);
  assert.ok(brief.includes(`- ${findingLine(FINDING)}`), brief);
  // A round with no remark says nothing about them.
  assert.ok(
    !correctiveRole(base, JUDGED, { findings: [FINDING], divergences: [], brief: null }).includes(
      'These remarks',
    ),
  );
});

test('a computed sibling list of none takes no entry, and says so (W13)', () => {
  const base = { worktree: '/tmp/run', defaultBranch: 'main', recordLifecycle: 'supersede' };
  const sentence = 'No active record cites a record this write supersedes, so "siblings" takes no entry.';
  // The empty list and the absent one are two different facts. A dispatch that
  // computed a list of none says so; a lane with no sibling contract at all
  // states nothing.
  const empty = writeRole(base, { ...JUDGED, siblings: [] }, null);
  assert.ok(empty.includes(sentence), empty);
  assert.ok(!writeRole(base, JUDGED, null).includes(sentence));
  assert.ok(!writeRole(base, JUDGED, null).includes('These active records cite a record'));
  // A computed list is stated, and the bullet points the seat at it.
  const listed = writeRole(base, { ...JUDGED, siblings: ['docs/adr/adr-004-cites.md'] }, null);
  assert.ok(listed.includes('- docs/adr/adr-004-cites.md'), listed);
  assert.ok(!listed.includes(sentence), listed);
  for (const brief of [empty, listed]) {
    assert.ok(
      brief.includes(
        'The records that cite a record you supersede arrive in "siblings", listed in this brief.',
      ),
      brief,
    );
    assert.ok(brief.includes('A brief that lists none takes no "siblings" entry.'), brief);
  }
});

test('a consistent finding names the second record on the records line as well', () => {
  const consistent = {
    id: 'F2',
    criterion: 'consistent',
    file: 'docs/adr/adr-001-first.md',
    unit: 'U7',
    head: 'The public surface is exactly two routes',
    file2: 'docs/adr/adr-002-second.md',
    unit2: 'U3',
    head2: 'The public surface is one route',
    summary: 'the two records decide the surface two ways',
    evidence: 'src/routes.mjs:1',
  };
  const against = '[against: docs/adr/adr-002-second.md U3 "The public surface is one route"]';
  assert.equal(
    findingLine(consistent),
    '[F2] [consistent] (docs/adr/adr-001-first.md) U7 "The public surface is exactly two routes" ' +
      `${against} the two records decide the surface two ways (evidence: src/routes.mjs:1)`,
  );
  // One clause, three briefs: the code seat's line says the same about the
  // second place as the record writer's does.
  assert.ok(
    codeFindingLine({ ...consistent, source: 'review', lens: 'record', severity: 'HIGH' })
      .includes(against),
  );
  // The corrective brief carries the line the writer answers from.
  const corrective = correctiveRole({ worktree: '/tmp/run', defaultBranch: 'main' }, JUDGED, {
    findings: [consistent],
    divergences: [],
    brief: null,
  });
  assert.ok(corrective.includes(against), corrective);
  // A finding about one record names one place.
  assert.ok(!findingLine(FINDING).includes('[against:'));
});

test('the supersede rule stands in every brief the lifecycle binds', () => {
  const base = { worktree: '/tmp/run', defaultBranch: 'main', recordLifecycle: 'supersede' };
  // The siblings the harness computed ride the brief by path, so the seat reads
  // each one before it answers it.
  const withSiblings = writeRole(
    base,
    { ...JUDGED, siblings: ['docs/adr/adr-004-cites.md'] },
    null,
  );
  assert.ok(withSiblings.includes('These active records cite a record you supersede.'));
  assert.ok(withSiblings.includes('- docs/adr/adr-004-cites.md'));
  assert.ok(!writeRole(base, JUDGED, null).includes('These active records cite'));
  for (const [name, brief] of Object.entries(briefs(base))) {
    assert.ok(brief.includes('Lifecycle: this project supersedes its records.'), name);
    assert.ok(brief.includes('An accepted record is one that stands on main'), name);
    assert.ok(brief.includes('"Supersedes: <list>" line'), name);
    assert.ok(brief.includes('keeps its body, verbatim'), name);
    assert.ok(brief.includes('"Superseded by <list> (YYYY-MM-DD)"'), name);
    assert.ok(brief.includes('"Retired (YYYY-MM-DD): <one sentence>"'), name);
    assert.ok(brief.includes('A record this run added is not accepted yet'), name);
    assert.ok(brief.includes('resolve by recency'), name);
  }
});

// The one corrective attempt is spent on the same miss when the seat has to
// enumerate again. The retry brief carries the harness's own list.
test('a retry brief carries the defects and the unit list beside them', (t) => {
  const dir = tree(t);
  const base = { worktree: dir, defaultBranch: 'main' };
  const judged = { records: [RECORD], reason: 'the diff implements it' };
  const defects = ['unit check 1: docs/adr/adr-900-the-helper.md U2 has no entry in "units".'];
  const first = writeRole(base, judged, null);
  assert.ok(!first.includes('as the harness counts them'));
  const retry = writeRole(base, judged, defects);
  assert.ok(retry.includes('Correction brief — fix these defects:'));
  assert.ok(retry.includes(defects[0]));
  assert.ok(retry.includes(`The units of ${RECORD}, as the harness counts them:`), retry);
  assert.ok(retry.includes('- U0 (line 1, title): # ADR-900: The helper doubles its input'));
  assert.ok(retry.includes('- U2 (line 7): The helper lives at `src/feature.mjs`.'));
  // The corrective and birth briefs carry it on the same rule.
  const corrective = correctiveRole(base, judged, { findings: [FINDING], divergences: [], brief: defects });
  assert.ok(corrective.includes('as the harness counts them'));
  const birth = birthRole(base, { key: 'alpha-1', records: [RECORD] }, [], defects);
  assert.ok(birth.includes('as the harness counts them'));
});

test('the three seat names are the three keys of the budget and the cost series', () => {
  assert.equal(WRITE_SEAT, 'reconcile-write');
  assert.equal(AUTHOR_SEAT, 'record-author');
  assert.equal(REVIEW_SEAT, 'record-review');
});

// -- the closed record (ADR-0078) ---------------------------------------------

/** One old record of the sweep shape: a title, a status line and one claim. */
function oldRecord(id) {
  return `# ADR-${id}: An old decision\n\n**Status:** Accepted\n\n## Decision\n\nThe module src/base.mjs holds the base value.\n`;
}

/** The same record, closed by the write that replaces it. */
function closedBy(id, heir) {
  return oldRecord(id).replace(
    '**Status:** Accepted',
    `**Status:** Superseded by ADR-${heir} (2026-09-08)`,
  );
}

/** One record a birth wrote, with or without a parent it replaces. */
function newRecord(id, parent = null) {
  const supersedes = parent === null ? '' : `**Supersedes:** ADR-${parent}\n`;
  return `# ADR-${id}: A new decision\n\n**Status:** Accepted\n${supersedes}\n## Decision\n\nThe module src/base.mjs holds the base value.\n`;
}

/** Every unit of one record, answered as the harness counts them. */
function answersFor(dir, record) {
  const text = readFileSync(join(dir, record), 'utf8');
  return recordUnits(text).map((unit) => ({
    record,
    id: unit.id,
    kind: unit.kind ?? kindTest(unit.head) ?? 'rationale',
    verdict: 'holds',
    evidence: unit.kind ? 'structure' : kindTest(unit.head) ? 'src/base.mjs' : 'the reason',
  }));
}

/** The same answers, every one of them filed as rationale. */
function asRationale(dir, records) {
  return records.flatMap((record) =>
    recordUnits(readFileSync(join(dir, record), 'utf8')).map((unit) => ({
      record,
      id: unit.id,
      kind: unit.kind ?? 'rationale',
      verdict: 'holds',
      evidence: 'the reason',
    })),
  );
}

/**
 * The sweep batch that found this defect: sixteen records born, six of them
 * replacing an accepted record whose status line the same write closed.
 */
function sweepTree(t) {
  const olds = [];
  const news = [];
  const before = {};
  for (let i = 1; i <= 6; i++) {
    const path = `docs/adr/adr-10${i}-old.md`;
    olds.push(path);
    before[path] = oldRecord(`10${i}`);
  }
  const dir = repo(t, { ...before, 'src/base.mjs': 'export const base = 1;\n' });
  const after = {};
  for (let i = 1; i <= 16; i++) {
    const id = 200 + i;
    const path = `docs/adr/adr-${id}-new.md`;
    news.push(path);
    after[path] = newRecord(id, i <= 6 ? `10${i}` : null);
  }
  for (let i = 1; i <= 6; i++) after[olds[i - 1]] = closedBy(`10${i}`, 200 + i);
  writeTree(dir, after);
  return { dir, olds, news };
}

function sweepBase(dir) {
  return {
    worktree: dir,
    defaultBranch: 'main',
    recordLifecycle: 'supersede',
    recordPaths: ['docs/adr'],
  };
}

// The refusal this plan removes. The seat listed each old record in `rewritten`
// because it changed the file, and the unit check then enumerated the whole old
// body. No answer to a July claim passes both the writer's rule and the kind
// test (ADR-0078).
test('a birth that closes six records and writes sixteen is not refused', async (t) => {
  const { dir, olds, news } = sweepTree(t);
  const base = sweepBase(dir);
  const units = news.flatMap((record) => answersFor(dir, record));
  const report = {
    rewritten: [...news, ...olds],
    unchanged: [],
    units,
    divergences: [],
    summary: 'sixteen records, six of them replacing an old one',
  };
  assert.deepEqual(await writeChecks(base, [], report, { seat: 'writer' }), []);
  // The seat that answers the old records as well is not refused for it: the
  // entries are dropped, and the report stands.
  const answered = { ...report, units: [...units, ...asRationale(dir, olds)] };
  assert.deepEqual(await writeChecks(base, [], answered, { seat: 'writer' }), []);
  // The two refusals still stand over a new record.
  const short = { ...report, units: units.filter((u) => u.id !== 'U2' || u.record !== news[7]) };
  const missing = await writeChecks(base, [], short, { seat: 'writer' });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /^unit check 1: /);
  const invented = {
    ...report,
    units: [
      ...units,
      {
        record: 'docs/adr/adr-900-absent.md',
        id: 'U0',
        kind: 'title',
        verdict: 'holds',
        evidence: 'the title',
      },
    ],
  };
  const stranger = await writeChecks(base, [], invented, { seat: 'writer' });
  assert.equal(stranger.length, 1);
  assert.match(stranger[0], /^unit check 2: "units" names docs\/adr\/adr-900-absent\.md/);
});

// The proof it can still fail. With the closed records left in the set, the
// same report is the two refusals the live run took: every unit of every old
// record unanswered, and every one of them a claim if the seat files it as
// rationale.
test('the same birth is refused when the closed records stay in the set', async (t) => {
  const { dir, olds, news } = sweepTree(t);
  const base = sweepBase(dir);
  const units = news.flatMap((record) => answersFor(dir, record));
  const unfiltered = [...news, ...olds];
  const report = { rewritten: unfiltered, unchanged: [], units, divergences: [] };
  const missing = unitChecks(base, unfiltered, report, { seat: 'writer' });
  // Three units per old record, six old records. The live batch was twenty-two
  // records wide and took 438 of this defect; the shape is the same one.
  assert.ok(
    missing.length >= 18,
    `${missing.length} defects over ${olds.length} closed records of three units each`,
  );
  assert.ok(
    missing.every((defect) => /^unit check 1: /.test(defect)),
    missing[0],
  );
  const rationale = { ...report, units: [...units, ...asRationale(dir, olds)] };
  const filed = unitChecks(base, unfiltered, rationale, { seat: 'writer' });
  assert.equal(filed.length, 6);
  assert.ok(
    filed.every((defect) => /^unit check 5: /.test(defect)),
    filed[0],
  );
});

test('a judged supersession answers its replacements and none of the record it closed', async (t) => {
  const dir = acceptedTree(t);
  const base = lifecycleBase(dir);
  const record = 'docs/adr/adr-001-first.md';
  writeTree(dir, {
    [record]: superseded('001', 'ADR-003 and ADR-004'),
    'docs/adr/adr-003-third.md': SUPERSEDER('003', 'ADR-001'),
    'docs/adr/adr-004-fourth.md': SUPERSEDER('004', 'ADR-001'),
  });
  const heirs = ['docs/adr/adr-003-third.md', 'docs/adr/adr-004-fourth.md'];
  const units = heirs.flatMap((heir) => answersFor(dir, heir));
  // The divergence duty reads the same set the unit check counts: one entry per
  // record this write added, and the record it closed is read rather than
  // refused.
  const report = {
    rewritten: heirs,
    unchanged: [],
    units,
    divergences: [
      ...heirs.map((heir) => ({
        record: heir,
        state: 'none',
        statement: 'the record states the tree as it stands',
        evidence: 'src/feature.mjs:1',
      })),
      {
        record,
        state: 'none',
        statement: 'the tree and the record say one thing',
        evidence: 'src/feature.mjs:1',
      },
    ],
    summary: 'one record becomes two',
  };
  assert.deepEqual(await writeChecks(base, [record], report, { seat: 'writer' }), []);
  // The entry about the closed record is tolerated and never owed.
  const silent = { ...report, divergences: report.divergences.slice(0, 2) };
  assert.deepEqual(await writeChecks(base, [record], silent, { seat: 'writer' }), []);
  // A replacement with no entry of its own is refused, and so is a second entry
  // for one of them.
  const short = { ...report, divergences: report.divergences.slice(1) };
  const owed = await writeChecks(base, [record], short, { seat: 'writer' });
  assert.equal(owed.length, 1);
  assert.match(owed[0], /adr-003-third\.md was judged owed and "divergences" accounts for it nowhere/);
  const twice = { ...report, divergences: [...report.divergences, report.divergences[0]] };
  const doubled = await writeChecks(base, [record], twice, { seat: 'writer' });
  assert.equal(doubled.length, 1);
  assert.match(doubled[0], /has 2 entries in "divergences"/);
  // Every unit of a replacement is the writer's, so a missing one is refused.
  const thin = { ...report, units: units.filter((u) => !(u.record === heirs[1] && u.id === 'U0')) };
  const defects = await writeChecks(base, [record], thin, { seat: 'writer' });
  assert.equal(defects.length, 1);
  assert.match(defects[0], /^unit check 1: docs\/adr\/adr-004-fourth\.md U0/);
  // And an answer about the closed record is dropped rather than refused.
  const extra = {
    ...report,
    units: [...units, { record, id: 'U0', kind: 'title', verdict: 'holds', evidence: 'the title' }],
  };
  assert.deepEqual(await writeChecks(base, [record], extra, { seat: 'writer' }), []);
});

test('a bare closure is refused, and a replacement or a reason accounts for it', async (t) => {
  const dir = acceptedTree(t);
  const base = lifecycleBase(dir);
  const record = 'docs/adr/adr-001-first.md';
  const retired = ACCEPTED('001').replace(
    '**Status:** Accepted',
    '**Status:** Retired (2026-09-08): the gate this record named is gone.',
  );
  const divergences = [
    {
      record,
      state: 'none',
      statement: 'the tree and the record say one thing',
      evidence: 'src/feature.mjs:1',
    },
  ];
  writeTree(dir, { [record]: retired });
  const silent = { rewritten: [], unchanged: [], units: [], divergences, summary: 'closed' };
  const defects = await writeChecks(base, [record], silent, { seat: 'writer' });
  assert.equal(defects.length, 1);
  assert.match(defects[0], /adr-001-first\.md is closed in this diff and nothing accounts for it/);
  assert.match(defects[0], /Write the record that replaces it/);
  assert.match(defects[0], /report it in "unchanged" with the reason you retired it/);
  // A retirement the report carries with its reason passes.
  const declared = {
    ...silent,
    unchanged: [{ record, reason: 'the gate this record named is gone' }],
  };
  assert.deepEqual(await writeChecks(base, [record], declared, { seat: 'writer' }), []);
  // Listing it in "rewritten" is not an account of it: a status-line change is
  // not a rewrite.
  const relisted = await writeChecks(base, [record], { ...silent, rewritten: [record] }, {
    seat: 'writer',
  });
  assert.equal(relisted.length, 1);
  assert.match(relisted[0], /nothing accounts for it/);
  // A project that rewrites its records has no supersession, so the defect
  // names the one route it has.
  const rewrite = { worktree: dir, defaultBranch: 'main', recordPaths: ['docs/adr'] };
  const under = await writeChecks(rewrite, [record], silent, { seat: 'writer' });
  assert.equal(under.length, 1);
  assert.match(under[0], /Report it in "unchanged" with the reason you retired it/);
  assert.ok(!under[0].includes('Supersedes'), under[0]);
});

test('a birth that closes a record with neither route is refused', async (t) => {
  const dir = acceptedTree(t);
  const base = lifecycleBase(dir);
  const record = 'docs/adr/adr-001-first.md';
  writeTree(dir, { [record]: superseded('001', 'ADR-003') });
  const report = {
    rewritten: [record],
    unchanged: [],
    units: [],
    divergences: [],
    summary: 'closed',
  };
  const defects = await writeChecks(base, [], report, { seat: 'writer' });
  // The closure is refused, and the supersede lifecycle still asks for the
  // record the status line names.
  assert.ok(
    defects.some((d) => /is closed in this diff and nothing accounts for it/.test(d)),
    defects.join('\n'),
  );
  assert.ok(
    defects.some((d) => /no such record is added in this diff/.test(d)),
    defects.join('\n'),
  );
  // The same birth under the lifecycle that rewrites its records. There is no
  // supersession there, so the defect names the one route that lifecycle holds.
  const rewrite = { worktree: dir, defaultBranch: 'main', recordPaths: ['docs/adr'] };
  const under = await writeChecks(rewrite, [], report, { seat: 'writer' });
  assert.equal(under.length, 1);
  assert.match(under[0], /adr-001-first\.md is closed in this diff and nothing accounts for it/);
  assert.match(under[0], /Report it in "unchanged" with the reason you retired it/);
  // And the reason accounts for it under either lifecycle.
  const declared = {
    ...report,
    rewritten: [],
    unchanged: [{ record, reason: 'the decision this record states is gone' }],
  };
  assert.deepEqual(await writeChecks(rewrite, [], declared, { seat: 'writer' }), []);
});

// Two seats of one round that merge two records into one. The second seat finds
// its judged record closed and committed by its peer, and its own diff holds
// nothing (ADR-0078).
test('a closure a peer seat of the round replaced is accounted for', async (t) => {
  const dir = acceptedTree(t);
  const record = 'docs/adr/adr-002-second.md';
  commitTree(
    dir,
    {
      'docs/adr/adr-001-first.md': superseded('001', 'ADR-003'),
      [record]: superseded('002', 'ADR-003', 'The second decision stands.'),
      'docs/adr/adr-003-third.md': SUPERSEDER('003', 'ADR-001 and ADR-002'),
    },
    'reconcile: the first seat merges two records into one',
  );
  const report = {
    rewritten: [],
    unchanged: [],
    units: [],
    divergences: [
      {
        record,
        state: 'none',
        statement: 'the merge states both decisions',
        evidence: 'src/feature.mjs:1',
      },
    ],
    summary: 'the peer of this round closed it',
  };
  const base = lifecycleBase(dir);
  assert.deepEqual(await writeChecks(base, [record], report, { seat: 'writer' }), []);
  // The negative control: with the window narrowed to this dispatch's own diff,
  // the same write reads as a bare closure. That narrow window is what the
  // round range answered, and it is what ADR-0079 replaced.
  const narrow = await writeChecks(base, [record], report, {
    seat: 'writer',
    window: { ...(await runWindow(base)), files: [] },
  });
  assert.equal(narrow.length, 1);
  assert.match(narrow[0], /is closed in this diff and nothing accounts for it/);
});

// -- the born supersession (ADR-0079) -----------------------------------------
//
// The corrective round over a batch the birth wrote. The parent of every
// replacement closed in the birth commit, one commit before the round opened,
// and the range a round reads excludes that commit (W11, W12).

/** A birth that closed two accepted records and added their replacements. */
function bornTree(t) {
  const dir = repo(t, {
    'docs/adr/adr-001-first.md': ACCEPTED('001'),
    'docs/adr/adr-002-second.md': ACCEPTED('002', 'The second decision stands.'),
    'docs/adr/adr-005-cites.md': ACCEPTED('005', 'This record relies on ADR-001.'),
    'docs/adr/TEMPLATE.md': '# ADR-<id>: <title>\n\n**Status:** Accepted\n',
    'src/feature.mjs': 'export const f = (x) => x;\n',
  });
  const birth = commitTree(
    dir,
    {
      'docs/adr/adr-001-first.md': superseded('001', 'ADR-003'),
      'docs/adr/adr-002-second.md': superseded('002', 'ADR-004', 'The second decision stands.'),
      'docs/adr/adr-003-third.md': SUPERSEDER('003', 'ADR-001'),
      'docs/adr/adr-004-fourth.md': SUPERSEDER('004', 'ADR-002'),
    },
    'records: the birth writes the batch',
  );
  return { dir, birth };
}

/**
 * The report one corrective seat leaves over one record it rewrote. Every claim
 * cites the file this fixture holds, because a claim's evidence has to resolve
 * in the worktree.
 */
function correctiveReport(dir, record, over = {}) {
  return {
    rewritten: [record],
    unchanged: [],
    units: answersFor(dir, record).map((unit) => ({
      ...unit,
      ...(unit.evidence === 'src/base.mjs' && { evidence: 'src/feature.mjs' }),
    })),
    divergences: [
      {
        record,
        state: 'none',
        statement: 'the record and the tree state one thing',
        evidence: 'src/feature.mjs:1',
      },
    ],
    summary: 'the record states what the tree holds',
    ...over,
  };
}

test('a corrective write of a born replacement passes the pairing (W11)', async (t) => {
  const { dir, birth } = bornTree(t);
  const record = 'docs/adr/adr-003-third.md';
  const base = lifecycleBase(dir);
  // The corrective seat rewrites the replacement its own run's birth added.
  writeTree(dir, {
    [record]: SUPERSEDER('003', 'ADR-001', 'The decision stands now, as src/feature.mjs holds it.'),
  });
  const report = correctiveReport(dir, record);
  assert.deepEqual(await supersedeChecks(base, [record], report), []);
  assert.deepEqual(await writeChecks(base, [record], report, { seat: 'writer' }), []);
  // The read the round used to make. The round opens at the birth commit, and
  // `git diff A..A` lists nothing, so the parent stood outside it and the same
  // seat was refused twice on a write that was right.
  assert.equal(gitSync(['diff', '--name-only', `${birth}..HEAD`], dir).trim(), '');
  const window = await runWindow(base);
  assert.equal(window.base, gitSync(['rev-parse', 'main'], dir).trim());
  assert.ok(window.files.includes('docs/adr/adr-001-first.md'), window.files.join(', '));
});

test('a replacement whose parent is active is refused with the same text (W11)', async (t) => {
  const dir = repo(t, {
    'docs/adr/adr-001-first.md': ACCEPTED('001'),
    'docs/adr/TEMPLATE.md': '# ADR-<id>: <title>\n\n**Status:** Accepted\n',
    'src/feature.mjs': 'export const f = (x) => x;\n',
  });
  const record = 'docs/adr/adr-003-third.md';
  commitTree(dir, { [record]: SUPERSEDER('003', 'ADR-001') }, 'records: a replacement, no closure');
  const defects = await supersedeChecks(lifecycleBase(dir), [record], REPORT);
  assert.equal(defects.length, 1, defects.join('\n'));
  assert.match(defects[0], /leaves that record's status line unchanged/);
});

test('a replacement of a record closed at the merge base is refused (W11)', async (t) => {
  const dir = repo(t, {
    'docs/adr/adr-001-first.md': superseded('001', 'ADR-002'),
    'docs/adr/adr-002-second.md': SUPERSEDER('002', 'ADR-001'),
    'docs/adr/TEMPLATE.md': '# ADR-<id>: <title>\n\n**Status:** Accepted\n',
    'src/feature.mjs': 'export const f = (x) => x;\n',
  });
  const record = 'docs/adr/adr-003-third.md';
  commitTree(dir, { [record]: SUPERSEDER('003', 'ADR-001') }, 'records: a second replacement');
  const defects = await supersedeChecks(lifecycleBase(dir), [record], REPORT);
  assert.equal(defects.length, 1, defects.join('\n'));
  assert.match(defects[0], /already closed at this run's merge base/);
});

test('an accepted record the window changed on its status line alone passes', async (t) => {
  const { dir } = bornTree(t);
  const base = lifecycleBase(dir);
  const record = 'docs/adr/adr-003-third.md';
  // The birth commit made the edit, and no dispatch of this round touched the
  // parent. The window reads it all the same.
  assert.deepEqual(await supersedeChecks(base, [record], REPORT), []);
  // The same record, changed anywhere but its status line, is refused whichever
  // dispatch made the edit.
  writeTree(dir, {
    'docs/adr/adr-001-first.md': superseded('001', 'ADR-003', 'The decision changed.'),
  });
  const defects = await supersedeChecks(base, [record], REPORT);
  assert.equal(defects.length, 1, defects.join('\n'));
  assert.match(defects[0], /changes more than its status line/);
});

test('a sibling the birth replaced is answered in a corrective round (W12)', async (t) => {
  const { dir, birth } = bornTree(t);
  const base = lifecycleBase(dir);
  const cites = 'docs/adr/adr-005-cites.md';
  const record = 'docs/adr/adr-004-fourth.md';
  const replacement = 'docs/adr/adr-003-third.md';
  // This dispatch rewrites one replacement, and answers the sibling of the
  // record another replacement of the same birth closed.
  writeTree(dir, {
    [record]: SUPERSEDER('004', 'ADR-002', 'The second decision stands now, in src/feature.mjs.'),
  });
  const report = correctiveReport(dir, record, {
    siblings: [
      {
        record: cites,
        state: 'superseded',
        reason: 'it relies on the decision the replacement now states',
        replacement,
      },
    ],
  });
  assert.deepEqual(
    await writeChecks(base, [record], report, { seat: 'writer', siblings: [cites] }),
    [],
  );
  // The negative control: the round's own range holds this dispatch's diff and
  // no birth commit, so the replacement is out of reach and the answer is
  // refused. That is the read the window replaced.
  const round = { ...(await runWindow(base)), files: [record] };
  const narrow = await writeChecks(base, [record], report, {
    seat: 'writer',
    siblings: [cites],
    window: round,
  });
  assert.ok(
    narrow.some((defect) => /no record that replaces it is in this round/.test(defect)),
    narrow.join('\n'),
  );
});

test('the brief says once that a status-line change is not a rewrite', () => {
  const bullet = 'A status-line change of an old record is not a rewrite.';
  // The filter and the closure check are not gated on the lifecycle, so the
  // rule reaches the seat under either one. A check the brief never states is a
  // rule the seat cannot meet.
  for (const lifecycle of ['supersede', 'rewrite']) {
    const base = { worktree: '/tmp/run', defaultBranch: 'main', recordLifecycle: lifecycle };
    for (const [name, brief] of Object.entries(briefs(base))) {
      const where = `${lifecycle} ${name}`;
      assert.ok(brief.includes(bullet), where);
      assert.ok(brief.includes('List that record in neither'), where);
      assert.ok(brief.includes('unless you retire it with a reason, and answer none of its'), where);
      assert.ok(brief.includes('The harness reads its status line from the tree.'), where);
      assert.ok(brief.includes('Every unit of a record you add is'), where);
      // Once, and in one place.
      assert.equal(brief.split(bullet).length - 1, 1, where);
      // The supersession rules stay the supersede lifecycle's own.
      assert.equal(brief.includes('It never edits an accepted one.'), lifecycle === 'supersede', where);
    }
  }
  // The two reconciliation briefs state what a supersession owes the
  // declaration, where the lifecycle holds one.
  const supersede = { worktree: '/tmp/run', defaultBranch: 'main', recordLifecycle: 'supersede' };
  const rewrite = { worktree: '/tmp/run', defaultBranch: 'main' };
  const clause = 'A record you add to replace one of these takes an entry of its own.';
  for (const name of ['write', 'corrective']) {
    assert.ok(briefs(supersede)[name].includes(clause), name);
    assert.ok(!briefs(rewrite)[name].includes(clause), name);
  }
});

test('a closed record the write never touched is refused in rewritten', async (t) => {
  const dir = acceptedTree(t);
  // A record an earlier round closed, which this write never opens.
  const closed = 'docs/adr/adr-002-second.md';
  commitTree(
    dir,
    { [closed]: superseded('002', 'ADR-003', 'The second decision stands.') },
    'records: an earlier round closed it',
  );
  const written = 'docs/adr/adr-004-fourth.md';
  writeTree(dir, { [written]: ACCEPTED('004') });
  const base = { worktree: dir, defaultBranch: 'main', recordPaths: ['docs/adr'] };
  const report = {
    rewritten: [written, closed],
    unchanged: [],
    units: answersFor(dir, written),
    divergences: [],
    summary: 'one record written, and one this write never opened',
  };
  const defects = await writeChecks(base, [], report, { seat: 'writer' });
  assert.equal(defects.length, 1, defects.join('\n'));
  assert.match(
    defects[0],
    /you report docs\/adr\/adr-002-second\.md as rewritten and the file is unchanged in the tree/,
  );
  // The same list without it stands: a closed record the write did change is
  // the one the closure rule accounts for.
  assert.deepEqual(
    await writeChecks(base, [], { ...report, rewritten: [written] }, { seat: 'writer' }),
    [],
  );
});

// The sibling side of the same range. A merge round closes two records with
// one, and the second seat answers a sibling of a record its own diff never
// touched: the record that replaces it is in the first seat's commit
// (ADR-0078).
test('a sibling the round replaced is answered from a peer seat commit', async (t) => {
  const dir = acceptedTree(t);
  const cites = 'docs/adr/adr-005-cites.md';
  commitTree(dir, { [cites]: ACCEPTED('005', 'This record relies on ADR-002.') }, 'records: a citing record');
  const record = 'docs/adr/adr-002-second.md';
  const merged = 'docs/adr/adr-003-third.md';
  commitTree(
    dir,
    {
      'docs/adr/adr-001-first.md': superseded('001', 'ADR-003'),
      [record]: superseded('002', 'ADR-003', 'The second decision stands.'),
      [merged]: SUPERSEDER('003', 'ADR-001 and ADR-002'),
    },
    'reconcile: the first seat merges two records into one',
  );
  const report = {
    rewritten: [],
    unchanged: [],
    units: [],
    divergences: [
      {
        record,
        state: 'none',
        statement: 'the merge states both decisions',
        evidence: 'src/feature.mjs:1',
      },
    ],
    siblings: [
      {
        record: cites,
        state: 'superseded',
        reason: 'it decides the part the merged record now decides',
        replacement: merged,
      },
    ],
    summary: 'the peer of this round closed it',
  };
  const base = lifecycleBase(dir);
  assert.deepEqual(
    await writeChecks(base, [record], report, { seat: 'writer', siblings: [cites] }),
    [],
  );
  // A replacement the window does not hold is still refused.
  const absent = {
    ...report,
    siblings: [{ ...report.siblings[0], replacement: 'docs/adr/adr-009-absent.md' }],
  };
  const defects = await writeChecks(base, [record], absent, { seat: 'writer', siblings: [cites] });
  assert.equal(defects.length, 1, defects.join('\n'));
  assert.match(defects[0], /no record that replaces it is in this round/);
  // The negative control: narrowed to this dispatch's own diff, the peer's
  // write is out of reach, which is the read the window widened.
  const narrow = await writeChecks(base, [record], report, {
    seat: 'writer',
    siblings: [cites],
    window: { ...(await runWindow(base)), files: [] },
  });
  assert.ok(
    narrow.some((defect) => /no record that replaces it is in this round/.test(defect)),
    narrow.join('\n'),
  );
});

test('a window read that fails is stated, and no closure is judged on it', async (t) => {
  const dir = acceptedTree(t);
  const record = 'docs/adr/adr-002-second.md';
  commitTree(
    dir,
    {
      'docs/adr/adr-001-first.md': superseded('001', 'ADR-003'),
      [record]: superseded('002', 'ADR-003', 'The second decision stands.'),
      'docs/adr/adr-003-third.md': SUPERSEDER('003', 'ADR-001 and ADR-002'),
    },
    'reconcile: the first seat merges two records into one',
  );
  const report = {
    rewritten: [],
    unchanged: [],
    units: [],
    divergences: [
      {
        record,
        state: 'none',
        statement: 'the merge states both decisions',
        evidence: 'src/feature.mjs:1',
      },
    ],
    summary: 'the peer of this round closed it',
  };
  assert.deepEqual(await writeChecks(lifecycleBase(dir), [record], report, { seat: 'writer' }), []);
  // A window git cannot read says nothing about the closure. The check states
  // the failed read and judges no closure on it, because an empty window would
  // read a legal supersession as a bare one.
  const broken = { ...lifecycleBase(dir), defaultBranch: 'no-such-branch' };
  const defects = await writeChecks(broken, [record], report, { seat: 'writer' });
  assert.equal(defects.length, 2, defects.join('\n'));
  assert.match(defects[0], /the record window of this run cannot be read \(merge-base HEAD no-such-branch: /);
  assert.ok(!defects[0].includes('nothing accounts for it'), defects[0]);
  // The supersede checks read the same window and state the same failure.
  assert.match(defects[1], /the accepted record set cannot be computed: merge-base HEAD no-such-branch: /);
});

test('the correction brief enumerates no unit of a closed record', (t) => {
  const dir = tree(t, {
    'docs/adr/adr-001-first.md':
      '# ADR-001: A record\n\n**Status:** Superseded by ADR-003 (2026-09-08)\n\n## Decision\n\nOne sentence.\n',
  });
  const base = { worktree: dir, defaultBranch: 'main' };
  const judged = { records: ['docs/adr/adr-001-first.md', RECORD], reason: 'the diff implements it' };
  const retry = writeRole(base, judged, ['unit check 1: a unit has no entry.']);
  assert.ok(retry.includes(`The units of ${RECORD}, as the harness counts them:`), retry);
  assert.ok(!retry.includes('The units of docs/adr/adr-001-first.md'), retry);
});
