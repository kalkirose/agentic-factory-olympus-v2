import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeDir, tempDir, writeTree } from './helpers.mjs';
import {
  NEIGHBOUR_CAP,
  activeRecords,
  birthNeighbours,
  citingRecords,
  isActiveRecord,
  matchUnits,
  recordFiles,
  recordId,
  recordNeighbours,
  recordRefs,
  recordUnits,
  statusOf,
  supersedesOf,
} from '../src/lanes/units.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(ROOT, 'test/fixtures/records');

/** One live record, copied from the ceq tree at the plan's pin. */
function fixture(name) {
  return readFileSync(join(FIXTURES, `${name}.md`), 'utf8');
}

/** One harness record, read from the tree it describes. */
function harness(name) {
  return readFileSync(join(ROOT, 'docs/adr', `${name}.md`), 'utf8');
}

function units(text) {
  const list = recordUnits(text);
  return { list, at: (line) => list.find((u) => u.line === line), byId: (id) => list.find((u) => u.id === id) };
}

// -- the enumeration (plan 35, point 1) ---------------------------------------

// The precedence rule, on the four live records the plan names. A list item is
// one unit whatever it contains: the fenced block and the indented paragraph
// inside it are that item's, and the next unit is the next item.
test('a list item is one unit, and a fenced block inside it is part of the item', () => {
  const manifest = units(fixture('adr-042-asset-completeness-validator'));
  // Item 1 runs from line 31 over a fenced block (33-35) and an indented
  // paragraph (37). The next unit is item 2, at line 39.
  assert.equal(manifest.at(31).id, 'U17');
  assert.equal(manifest.at(39).id, 'U18');
  for (let line = 32; line < 39; line++) assert.equal(manifest.at(line), undefined, String(line));
  // The same shape again at item 5 (45), whose block ends at 51.
  assert.equal(manifest.at(45).id, 'U21');
  assert.equal(manifest.at(53).id, 'U22');
  // A fenced block at the top level is one unit, and it stands for its first
  // line of content rather than for its fence.
  assert.equal(manifest.at(87).head, '// Layer key: deterministic semantic tuple, serialized canonically.');
  assert.equal(manifest.at(88), undefined);

  // A comment and a fenced block inside a numbered item (adr-038:77-90).
  const scaling = units(fixture('adr-038-scaling-posture'));
  assert.equal(scaling.at(77).id, 'U41');
  assert.equal(scaling.at(91).id, 'U42');
  for (let line = 78; line < 91; line++) assert.equal(scaling.at(line), undefined, String(line));
  // A nested list item is a unit of its own, at any depth (adr-038:74).
  assert.ok(scaling.at(74).head.startsWith('**Storefront `$state` discipline**'));

  // A bullet whose block is a waiver template (adr-048:76-83).
  const suites = units(fixture('adr-048-behavior-driven-test-strategy'));
  assert.equal(suites.at(76).id, 'U26');
  assert.equal(suites.at(85).id, 'U27');
  for (let line = 77; line < 85; line++) assert.equal(suites.at(line), undefined, String(line));

  // A bullet whose block is a shell fence (adr-004:83-87).
  const auth = units(fixture('adr-004-admin-auth'));
  assert.equal(auth.at(83).id, 'U33');
  assert.equal(auth.at(88).id, 'U34');
  for (let line = 84; line < 88; line++) assert.equal(auth.at(line), undefined, String(line));
});

// A table row is a unit; the header row and the rule line are structure
// (adr-004:69-76).
test('each table row is a unit and the header and the rule line are not', () => {
  const auth = units(fixture('adr-004-admin-auth'));
  assert.equal(auth.at(69), undefined);
  assert.equal(auth.at(70), undefined);
  assert.deepEqual(
    [71, 72, 73, 74, 75, 76].map((line) => auth.at(line).id),
    ['U24', 'U25', 'U26', 'U27', 'U28', 'U29'],
  );
  assert.ok(auth.at(71).head.startsWith('| Application |'));
});

// The head block is one unit per line, not one paragraph: the status line and
// the related line are each answered on their own (adr-020:3-7).
test('the title is U0 and each head-block line is one unit', () => {
  const sanity = units(fixture('adr-020-sanity-cms-pattern'));
  assert.deepEqual(sanity.byId('U0'), {
    id: 'U0',
    line: 1,
    head: '# ADR-020: Sanity CMS pattern + Cloudflare cache-purge',
    kind: 'title',
  });
  assert.deepEqual(
    sanity.list.slice(1, 6).map((u) => [u.id, u.line, u.kind]),
    [
      ['U1', 3, 'status'],
      ['U2', 4, undefined],
      ['U3', 5, undefined],
      ['U4', 6, undefined],
      ['U5', 7, undefined],
    ],
  );
  assert.equal(sanity.byId('U1').head, '**Status:** Accepted');
  assert.equal(sanity.byId('U5').head.startsWith('**Related:**'), true);
  // The first body unit follows the first heading.
  assert.equal(sanity.byId('U6').line, 11);

  // A title that holds a colon and a semicolon is still one unit, and the head
  // is its first eight words (adr-058:1).
  const gate = units(fixture('adr-058-launch-gate-go-live'));
  assert.equal(gate.byId('U0').kind, 'title');
  assert.equal(gate.byId('U0').head, '# ADR-058: Launch gate: env-armed coming-soon takeover; go-live');
  assert.equal(gate.byId('U0').head.split(/\s+/).length, 8);
});

// The two harness records the enumeration is read against in the tree it
// describes. The assertions are structural, because the record text is the
// harness's own and it moves with the harness.
test('a harness record enumerates title first, status second, and no unit inside a fence', () => {
  for (const name of ['0010-tripwire-watcher', '0026-reconciliation-intake']) {
    const text = harness(name);
    const list = recordUnits(text);
    const lines = text.split('\n');
    assert.equal(list[0].id, 'U0', name);
    assert.equal(list[0].kind, 'title', name);
    assert.equal(list[1].kind, 'status', name);
    assert.equal(list[1].line, statusOf(text).line, name);
    // Ids run in document order, one per line at most, and never onto a
    // heading, a blank line or a fence.
    let previous = 0;
    for (const unit of list) {
      assert.ok(unit.line > previous, `${name} ${unit.id}`);
      previous = unit.line;
      const line = lines[unit.line - 1];
      assert.ok(line.trim().length > 0, `${name} ${unit.id}`);
      if (unit.id !== 'U0') assert.ok(!/^ {0,3}#{1,6}\s/.test(line), `${name} ${unit.id}`);
    }
    assert.deepEqual(
      list.map((u) => u.id),
      ['U0', ...list.slice(1).map((_, i) => `U${i + 1}`)],
      name,
    );
  }
  // The nested bullets of ADR-0010 are units of their own.
  const nested = recordUnits(harness('0010-tripwire-watcher'));
  const lines = harness('0010-tripwire-watcher').split('\n');
  const indented = lines.map((line, i) => [line, i + 1]).filter(([line]) => /^ {2}[-*] /.test(line));
  assert.ok(indented.length > 0);
  for (const [, line] of indented) {
    assert.ok(
      nested.some((u) => u.line === line),
      `nested item at line ${line}`,
    );
  }
});

// The synthetic record holds every structure at once: a comment before the
// title, a comment between units, a top-level fence, a table, and two levels of
// list with a fence inside the nested item.
const SYNTHETIC = `<!-- the template's own note, stripped before the commit -->
# ADR-0900: A synthetic record

Status: accepted (2026-09-07)

## Decision

<!--
a comment over two lines
-->
The harness enumerates this record.

- the first item
  - the nested item
    \`\`\`js
    const inside = true;
    \`\`\`
  - the second nested item
- the second item

| Layer | Reads |
|---|---|
| lint | src |
| test | src, test |

\`\`\`sh
node bin/olympus-units.mjs docs/adr/adr-900.md
\`\`\`

The last paragraph, wrapped
over two lines.
`;

test('a comment is never a unit, and every other structure is one', () => {
  const list = recordUnits(SYNTHETIC);
  assert.deepEqual(
    list.map((u) => [u.id, u.line, u.kind ?? null, u.head]),
    [
      ['U0', 2, 'title', '# ADR-0900: A synthetic record'],
      ['U1', 4, 'status', 'Status: accepted (2026-09-07)'],
      ['U2', 11, null, 'The harness enumerates this record.'],
      ['U3', 13, null, 'the first item'],
      ['U4', 14, null, 'the nested item'],
      ['U5', 18, null, 'the second nested item'],
      ['U6', 19, null, 'the second item'],
      ['U7', 23, null, '| lint | src |'],
      ['U8', 24, null, '| test | src, test |'],
      ['U9', 26, null, 'node bin/olympus-units.mjs docs/adr/adr-900.md'],
      ['U10', 30, null, 'The last paragraph, wrapped'],
    ],
  );
});

// The bin and the module read one enumeration. A seat runs the bin, the check
// runs the module, and a difference between them would refuse an honest report.
test('olympus-units prints the enumeration the harness counts', () => {
  const path = join(FIXTURES, 'adr-042-asset-completeness-validator.md');
  const out = execFileSync(process.execPath, [join(ROOT, 'bin/olympus-units.mjs'), path], {
    encoding: 'utf8',
  });
  const lines = out.trim().split('\n');
  const list = recordUnits(readFileSync(path, 'utf8'));
  assert.equal(lines.length, list.length + 1);
  assert.equal(lines[0], `U0\t1\ttitle\t${list[0].head}`);
  assert.equal(lines[lines.length - 1], `${list.length} units in ${path}`);
  const json = execFileSync(
    process.execPath,
    [join(ROOT, 'bin/olympus-units.mjs'), path, '--json'],
    { encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(json), list);
});

// -- identity across a write (point 1) ----------------------------------------

test('units match by head first and by line second, and a changed head is moved', () => {
  const before = '# ADR-0900: A record\n\nStatus: accepted (2026-09-07)\n\n## Decision\n\nThe first claim.\n\nThe second claim.\n';
  const after =
    '# ADR-0900: A record\n\nStatus: accepted (2026-09-07)\n\n## Decision\n\nAn inserted paragraph.\n\nThe first claim.\n\nThe second claim, rewritten.\n';
  const { moved, map } = matchUnits(before, after);
  // The title, the status and the first claim keep their identity, whatever
  // their numbers did.
  assert.equal(map.get('U0'), 'U0');
  assert.equal(map.get('U1'), 'U1');
  assert.equal(map.get('U2'), 'U3');
  // The rewritten unit moved past the line another unit now holds, so no line
  // answers for it either. Both the inserted unit and the rewritten one are
  // moved: a head that changed is a unit the seat answers again.
  assert.equal(map.get('U3'), undefined);
  assert.deepEqual(moved, ['U2', 'U4']);

  // A unit rewritten in place is matched by its line, so a finding raised
  // against it still lands on it, and it is moved as well.
  const restated = before.replace('The first claim.', 'The first claim, restated.');
  const second = matchUnits(before, restated);
  assert.equal(second.map.get('U2'), 'U2');
  assert.equal(second.map.get('U3'), 'U3');
  assert.deepEqual(second.moved, ['U2']);

  // A write that changes nothing moves nothing.
  assert.deepEqual(matchUnits(before, before).moved, []);
});

// -- the status line (point 6) ------------------------------------------------

// Every form the two record trees write today, and the one decoy. The status is
// the first line whose text, emphasis stripped and case folded, opens with
// `status:`; the rest of the line is the status text.
test('the status regex reads every live form and never reads the decoy', () => {
  const cases = [
    ['**Status:** Accepted', 'accepted', 'Accepted'],
    ['**Status:** Accepted (2026-06-07)', 'accepted', 'Accepted (2026-06-07)'],
    ['**Status**: Accepted', 'accepted', 'Accepted'],
    [
      '**Status:** Superseded by ADR-052 (2026-07-18)',
      'superseded',
      'Superseded by ADR-052 (2026-07-18)',
    ],
    [
      '**Status:** Retired (2026-08-11) - not superseded. The gate it named is gone.',
      'retired',
      'Retired (2026-08-11) - not superseded. The gate it named is gone.',
    ],
    // adr-060: unbolded, lowercase, dated.
    ['Status: accepted (2026-08-15)', 'accepted', 'accepted (2026-08-15)'],
    // The harness form, whose parenthesis wraps onto the next line.
    [
      'Status: accepted (2026-08-10, the approach finding and the repair heading',
      'accepted',
      'accepted (2026-08-10, the approach finding and the repair heading',
    ],
    // A status nobody wrote to the standard reads active, and the review names
    // the malformed line under `whole`.
    ['**Status:** Draft', null, 'Draft'],
  ];
  for (const [line, word, text] of cases) {
    const record = `# ADR-0900: A record\n\n${line}\n\n## Decision\n\nOne sentence.\n`;
    assert.deepEqual(statusOf(record), { word, text, line: 3 }, line);
    assert.equal(isActiveRecord(record), word !== 'superseded' && word !== 'retired', line);
    assert.equal(recordUnits(record).find((u) => u.line === 3).kind, 'status', line);
  }
  // adr-033's decoy is a paragraph heading in the body and never a status.
  const decoy = '# ADR-033: Uptime\n\n**Status:** Accepted\n\n## Decision\n\n**Status page:**\n\n1. Create the status page.\n';
  assert.deepEqual(statusOf(decoy), { word: 'accepted', text: 'Accepted', line: 3 });
  const bare = '# ADR-0900: A record\n\n## Decision\n\n**Status page:** the page is not a status.\n';
  assert.deepEqual(statusOf(bare), { word: null, text: null, line: null });
  // A file with no status line at all is active: a record nobody marked
  // superseded is still judged.
  assert.equal(isActiveRecord('# ADR-0900\n\n## Decision\n\nOne sentence.\n'), true);
});

test('the supersedes line is read directly under the status line', () => {
  const record = '# ADR-0900\n\n**Status:** Accepted\n**Supersedes:** ADR-042 and ADR-043\n\n## Decision\n';
  assert.equal(supersedesOf(record), 'ADR-042 and ADR-043');
  assert.equal(supersedesOf('# ADR-0900\n\n**Status:** Accepted\n\n## Decision\n'), null);
});

// -- the neighbourhood (point 7) ----------------------------------------------

/** A record file with a status, a body and whatever references it carries. */
function record(id, { status = 'Accepted', body = '' } = {}) {
  return `# ADR-${id}: A record\n\n**Status:** ${status}\n\n## Decision\n\n${body}\n`;
}

function tree(t, files) {
  const dir = tempDir('olympus-records-');
  t.after(() => removeDir(dir));
  writeTree(dir, files);
  return dir;
}

test('the neighbourhood is both directions, by id, with the self and the dead out', (t) => {
  const dir = tree(t, {
    // ADR-001 cites 002 and 003, and names itself on its own first line.
    'docs/adr/adr-001-first.md': record('001', {
      body: 'This record relies on ADR-002 and on ADR-003.',
    }),
    'docs/adr/adr-002-second.md': record('002', { body: 'It cites nothing.' }),
    // Superseded: out of every list, in both directions.
    'docs/adr/adr-003-third.md': record('003', {
      status: 'Superseded by ADR-005 (2026-09-07)',
      body: 'It cites ADR-001.',
    }),
    // A citation inside a fenced block is not a citation.
    'docs/adr/adr-004-fourth.md': record('004', {
      body: 'The gate prints:\n\n```\nsee ADR-001\n```\n',
    }),
    'docs/adr/adr-005-fifth.md': record('005', { body: 'It follows ADR-001.' }),
  });
  const paths = ['docs/adr'];
  assert.deepEqual(activeRecords(dir, paths), [
    'docs/adr/adr-001-first.md',
    'docs/adr/adr-002-second.md',
    'docs/adr/adr-004-fourth.md',
    'docs/adr/adr-005-fifth.md',
  ]);
  // Cited by this one first, then the active records that cite it. ADR-003 is
  // superseded and ADR-004's only reference sits in a fence.
  assert.deepEqual(recordNeighbours(dir, 'docs/adr/adr-001-first.md', paths), {
    neighbours: ['docs/adr/adr-002-second.md', 'docs/adr/adr-005-fifth.md'],
    dropped: 0,
  });
  assert.deepEqual(recordNeighbours(dir, 'docs/adr/adr-005-fifth.md', paths), {
    neighbours: ['docs/adr/adr-001-first.md'],
    dropped: 0,
  });
  assert.deepEqual(recordNeighbours(dir, 'docs/adr/adr-004-fourth.md', paths), {
    neighbours: [],
    dropped: 0,
  });
  // Both id spellings resolve to the same number.
  assert.equal(recordId('docs/adr/adr-020-sanity.md'), 20);
  assert.equal(recordId('docs/adr/0026-reconciliation-intake.md'), 26);
  assert.deepEqual([...recordRefs('ADR-0026 and ADR-026 and adr-26')], [26]);
});

test('the neighbourhood is capped at twelve by rank and reports what it dropped', (t) => {
  const files = {};
  const cited = [];
  for (let i = 1; i <= 14; i++) {
    const id = String(i).padStart(3, '0');
    files[`docs/adr/adr-${id}-neighbour.md`] = record(id, { body: 'It cites nothing.' });
    cited.push(`ADR-${id}`);
  }
  files['docs/adr/adr-100-wide.md'] = record('100', { body: `It relies on ${cited.join(', ')}.` });
  const dir = tree(t, files);
  const { neighbours, dropped } = recordNeighbours(dir, 'docs/adr/adr-100-wide.md', ['docs/adr']);
  assert.equal(NEIGHBOUR_CAP, 12);
  assert.equal(neighbours.length, 12);
  assert.equal(dropped, 2);
  assert.equal(neighbours[0], 'docs/adr/adr-001-neighbour.md');
  assert.equal(neighbours[11], 'docs/adr/adr-012-neighbour.md');
});

test('a birth neighbourhood comes from the touched paths, then from what they name', (t) => {
  const dir = tree(t, {
    'docs/adr/adr-001-first.md': record('001', {
      body: 'The helper lives at `src/feature.mjs` and ADR-002 states its budget.',
    }),
    'docs/adr/adr-002-second.md': record('002', { body: 'The budget is stated here.' }),
    'docs/adr/adr-003-third.md': record('003', { body: 'It names src/other.mjs.' }),
  });
  assert.deepEqual(birthNeighbours(dir, ['src/feature.mjs'], ['docs/adr']), {
    neighbours: ['docs/adr/adr-001-first.md', 'docs/adr/adr-002-second.md'],
    dropped: 0,
  });
  assert.deepEqual(birthNeighbours(dir, ['src/nothing.mjs'], ['docs/adr']), {
    neighbours: [],
    dropped: 0,
  });
});

test('the siblings of a superseded record leave out the run own scope', (t) => {
  const dir = tree(t, {
    'docs/adr/adr-001-first.md': record('001', { body: 'The decision stands here.' }),
    'docs/adr/adr-002-second.md': record('002', { body: 'It follows ADR-001.' }),
    'docs/adr/adr-003-third.md': record('003', { body: 'It follows ADR-001 as well.' }),
    'docs/adr/adr-004-fourth.md': record('004', {
      status: 'Retired (2026-09-07): the gate it named is gone.',
      body: 'It followed ADR-001.',
    }),
  });
  const paths = ['docs/adr'];
  assert.deepEqual(citingRecords(dir, 'docs/adr/adr-001-first.md', paths), [
    'docs/adr/adr-002-second.md',
    'docs/adr/adr-003-third.md',
  ]);
  // A record this run already writes is answered as itself, so it is not a
  // sibling as well.
  assert.deepEqual(
    citingRecords(dir, 'docs/adr/adr-001-first.md', paths, {
      scope: ['docs/adr/adr-003-third.md'],
    }),
    ['docs/adr/adr-002-second.md'],
  );
});

// -- the record path list -----------------------------------------------------

test('an exclusion entry takes a file out of the record tree', (t) => {
  const dir = tree(t, {
    'docs/adr/adr-001-first.md': record('001'),
    'docs/adr/TEMPLATE.md': '# ADR-<id>: <title>\n\n**Status:** Accepted\n',
    'docs/other/note.md': '# not a record\n',
  });
  assert.deepEqual(recordFiles(dir, ['docs/adr']), [
    'docs/adr/TEMPLATE.md',
    'docs/adr/adr-001-first.md',
  ]);
  assert.deepEqual(recordFiles(dir, ['docs/adr', '!docs/adr/TEMPLATE.md']), [
    'docs/adr/adr-001-first.md',
  ]);
  assert.deepEqual(activeRecords(dir, ['docs/adr', '!docs/adr/TEMPLATE.md']), [
    'docs/adr/adr-001-first.md',
  ]);
});
