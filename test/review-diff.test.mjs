// The diff a review seat is given: the file that holds all of it, the excerpt
// that opens the brief, and the two ways either can be short.
//
// A candidate diff grows with the work. Four packages installed into a project
// put a lockfile change in it and take it past the runner's default output cap
// on their own, and the read that hit that cap threw inside the verdict stage
// handler. The engine reads a handler throw as a liveness violation, so a run
// whose whole spectrum had come out green went inert on the size of a file
// nobody reviews. The bound that replaced the throw then cut the patch to
// 12,000 characters before it reached the seats, and every longer story was
// judged on its opening (ADR-0066). These tests hold the rules that close both:
// the whole diff is written to the run's own directory and named in the brief,
// the excerpt is a configured length and not a cut, the lockfile is kept out of
// the patch and named beside it instead, and the read cap is the only thing
// that can leave work nowhere.
//
// Beside them sits the round that takes no diff at all: the record review, one
// seat per record, and the code lenses that hold no record any more
// (ADR-0073).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { changedInRange, reviewDiff } from '../src/isolation/tree.mjs';
import { gitCapped } from '../src/isolation/git.mjs';
import { DEFAULT_EXCERPT_CHARS } from '../src/config/project.mjs';
import {
  VERIFIER_SEATS,
  furyRound,
  generalistReview,
  recordReviewRound,
  recordReviewSchema,
  verifierFor,
} from '../src/lanes/review.mjs';
import {
  LENS_CRITERIA,
  RECORD_CRITERIA,
  RECORD_CRITERION_KEYS,
  RECORD_RULE,
} from '../src/lanes/lenses.mjs';
import { UNITS_BIN, kindTest } from '../src/lanes/records.mjs';
import {
  NEIGHBOUR_CAP,
  UNIT_KINDS,
  UNIT_VERDICTS,
  recordUnits,
} from '../src/lanes/units.mjs';
import { scaffoldHome, reviewDiffPath, runLedgerPath } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { tempDir, removeDir, commitTree, gitSync, initOriginRepo } from './helpers.mjs';

/** Node's own default output cap, and so the size the old read died at. */
const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;

function repoFixture(t, files) {
  const root = tempDir('olympus-reviewdiff-');
  const repo = initOriginRepo(join(root, 'repo'), files);
  t.after(() => removeDir(root));
  return { repo, patch: join(root, 'runs', 'r1', 'reviews', 'diff-c1.patch') };
}

// The defect this test holds: a seat that was handed the first 12,000
// characters of a three-megabyte diff and judged the story on them. The whole
// diff is on disk, the excerpt is the configured length, and the two facts
// have separate names.
test('the whole diff is written to the run while the brief keeps its excerpt', async (t) => {
  const { repo, patch } = repoFixture(t, { 'src/a.mjs': 'base\n' });
  const before = gitSync(['rev-parse', 'HEAD'], repo).trim();
  // Three megabytes of distinct lines: distinct so git cannot collapse them,
  // and three because the cap that used to end this read was one.
  const bulk = Array.from({ length: 60_000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const after = commitTree(repo, { 'src/bulk.mjs': bulk + '\n' }, 'bulk');

  const diff = await reviewDiff(repo, before, after, { path: patch });

  const written = readFileSync(patch, 'utf8');
  assert.ok(
    written.length > 3 * NODE_DEFAULT_MAX_BUFFER,
    `the file holds only ${written.length} bytes`,
  );
  assert.ok(written.includes('line 59999'), 'the end of the patch never reached the file');
  assert.equal(diff.path, patch);
  assert.equal(diff.bytes, statSync(patch).size);
  assert.equal(diff.files, 1);
  assert.equal(diff.truncated, false);

  // The excerpt is the configured length, and it is an excerpt: the end of the
  // work is in the file and nowhere in the brief.
  assert.equal(diff.chars, DEFAULT_EXCERPT_CHARS);
  assert.equal(diff.partial, true);
  assert.ok(!diff.text.includes('line 59999'), 'the excerpt is not bounded');
  assert.ok(diff.text.includes(`the whole diff is at ${patch}`), 'the excerpt ends on no pointer');

  // The length is the project's to state, and the file does not move with it.
  const wider = await reviewDiff(repo, before, after, { path: patch, excerptChars: 40_000 });
  assert.equal(wider.chars, 40_000);
  assert.equal(wider.partial, true);
  assert.equal(wider.bytes, diff.bytes);
});

// A diff no longer than the excerpt is the whole diff twice: in the brief and
// in the file. Nothing about it is partial.
test('a diff that fits the excerpt is not partial, and is written anyway', async (t) => {
  const { repo, patch } = repoFixture(t, { 'src/a.mjs': 'base\n' });
  const before = gitSync(['rev-parse', 'HEAD'], repo).trim();
  const after = commitTree(repo, { 'src/a.mjs': 'the change under judgment\n' }, 'small');

  const diff = await reviewDiff(repo, before, after, { path: patch });

  assert.equal(diff.partial, false);
  assert.equal(diff.truncated, false);
  assert.equal(diff.files, 1);
  assert.equal(diff.text, readFileSync(patch, 'utf8'));
  assert.equal(diff.chars, diff.text.length);
  assert.ok(!diff.text.includes('[excerpt ends at'), 'a whole diff carries a cut marker');
});

// The file is the diff, so a call with nowhere to put it is refused. An
// excerpt whose brief can only point at itself is the defect, not a fallback.
test('a review diff with no file to write is refused', async (t) => {
  const { repo } = repoFixture(t, { 'src/a.mjs': 'base\n' });
  const before = gitSync(['rev-parse', 'HEAD'], repo).trim();
  const after = commitTree(repo, { 'src/a.mjs': 'work\n' }, 'work');

  await assert.rejects(() => reviewDiff(repo, before, after), /needs a path/);
});

test('lockfiles and generated files are named to the seat, never pasted into it', async (t) => {
  const { repo, patch } = repoFixture(t, {
    'src/a.mjs': 'base\n',
    'pnpm-lock.yaml': 'lockfile: 1\n',
    'packages/web/pnpm-lock.yaml': 'lockfile: 1\n',
    'src/api.generated.ts': 'export const one = 1;\n',
  });
  const before = gitSync(['rev-parse', 'HEAD'], repo).trim();
  const lock = Array.from({ length: 400 }, (_, i) => `  dep-${i}: 1.0.0`).join('\n');
  const after = commitTree(
    repo,
    {
      'src/a.mjs': 'the change under judgment\n',
      'pnpm-lock.yaml': `lockfile: 1\n${lock}\n`,
      'packages/web/pnpm-lock.yaml': `lockfile: 1\n${lock}\n`,
      'src/api.generated.ts': 'export const one = 1;\nexport const two = 2;\n',
    },
    'work plus a lockfile',
  );

  const diff = await reviewDiff(repo, before, after, { path: patch });

  // The work is there in full.
  assert.ok(diff.text.includes('+the change under judgment'));
  // The excluded content is not, at either depth, and neither is the generated
  // file's. The file the seat opens holds the same filtered text.
  const written = readFileSync(patch, 'utf8');
  assert.ok(!diff.text.includes('dep-399'), 'lockfile content reached the seat');
  assert.ok(!written.includes('dep-399'), 'lockfile content reached the file');
  assert.ok(!diff.text.includes('export const two'), 'generated content reached the seat');
  assert.ok(!written.includes('export const two'), 'generated content reached the file');
  // The seat is still told they changed, with a line count each.
  assert.deepEqual(diff.excluded.sort(), [
    'packages/web/pnpm-lock.yaml',
    'pnpm-lock.yaml',
    'src/api.generated.ts',
  ]);
  for (const path of diff.excluded) {
    const line = diff.text.split('\n').find((l) => l.includes(path) && l.includes('|'));
    assert.ok(line, `${path} is not named to the seat`);
    assert.match(line, /\|\s+\d+/, `${path} is named without a line count`);
  }
  // The file count is the files the seat can find in the file, so the paths
  // named under their own heading are not in it.
  assert.equal(diff.files, 1);
  assert.equal(diff.truncated, false);
  // A name read answers about every path, exactly as it did before.
  assert.ok((await changedInRange(repo, before, after)).includes('pnpm-lock.yaml'));
});

test('a project states its own exclusions, and an empty list filters nothing', async (t) => {
  const { repo, patch } = repoFixture(t, { 'src/a.mjs': 'base\n', 'schema.sql': 'select 1;\n' });
  const before = gitSync(['rev-parse', 'HEAD'], repo).trim();
  const after = commitTree(
    repo,
    { 'src/a.mjs': 'work\n', 'schema.sql': 'select 2;\n' },
    'work plus generated sql',
  );

  const stated = await reviewDiff(repo, before, after, { path: patch, exclude: ['schema.sql'] });
  assert.deepEqual(stated.excluded, ['schema.sql']);
  assert.ok(!stated.text.includes('+select 2;'));
  assert.equal(stated.files, 1);

  const none = await reviewDiff(repo, before, after, { path: patch, exclude: [] });
  assert.deepEqual(none.excluded, []);
  assert.ok(none.text.includes('+select 2;'));
  assert.equal(none.files, 2);
});

// Past the command-line budget the exclusions go to git as the project's own
// patterns. An argv long enough to overrun the shell would throw, and a throw
// in the verdict stage handler is the whole defect.
test('a generated file set too wide for one command line is still held back', async (t) => {
  const paths = Array.from(
    { length: 400 },
    (_, i) => `packages/generated/mod-${String(i).padStart(3, '0')}/client.generated.ts`,
  );
  const before = Object.fromEntries(paths.map((p) => [p, 'export const one = 1;\n']));
  const { repo, patch } = repoFixture(t, { 'src/a.mjs': 'base\n', ...before });
  const baseSha = gitSync(['rev-parse', 'HEAD'], repo).trim();
  const after = commitTree(
    repo,
    {
      'src/a.mjs': 'the change under judgment\n',
      ...Object.fromEntries(paths.map((p) => [p, 'export const one = 1;\nexport const two = 2;\n'])),
    },
    'a regeneration beside the work',
  );

  const diff = await reviewDiff(repo, baseSha, after, { path: patch });

  assert.equal(diff.excluded.length, 400);
  assert.equal(diff.files, 1);
  assert.ok(diff.text.includes('+the change under judgment'));
  assert.ok(!diff.text.includes('export const two'), 'generated content reached the seat');
  assert.ok(diff.text.includes(paths[0]), 'the first generated file is not named');
  assert.ok(diff.text.includes(paths.at(-1)), 'the last generated file is not named');
  assert.equal(diff.truncated, false);
});

// The read cap is the one bound that can leave work nowhere, and it is the
// only one `truncated` reports. An excerpt is not a cut: the rest is in the
// file the brief names.
test('a diff over the read cap is cut, named, and never thrown', async (t) => {
  const { repo, patch } = repoFixture(t, { 'src/a.mjs': 'base\n' });
  const before = gitSync(['rev-parse', 'HEAD'], repo).trim();
  const filler = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const after = commitTree(
    repo,
    { 'src/a.mjs': `${filler}\n`, 'src/b.mjs': `${filler}\n`, 'src/c.mjs': `${filler}\n` },
    'three files',
  );

  // The runner's cap, not the seat's window: this is the read that used to
  // throw, and the throw is what left the run inert.
  const capped = await reviewDiff(repo, before, after, { path: patch, cap: 900 });
  assert.equal(capped.truncated, true);
  assert.ok(capped.bytes <= 900, `the file holds ${capped.bytes} bytes past a 900-byte cap`);
  assert.equal(capped.bytes, statSync(patch).size);
  const marker = capped.text.split('\n').find((line) => line.startsWith('[the diff file stopped'));
  assert.ok(marker, 'the cut file carries no marker');
  assert.match(
    marker,
    /^\[the diff file stopped at the 900-byte read cap, \d+ bytes in; \d+ files are in neither it nor this excerpt: .+\]$/,
  );
  assert.ok(marker.includes('src/c.mjs'), 'the marker does not name the file nobody can read');

  // A diff the excerpt bounds is not truncated: every byte of it is in the
  // file, and this is the reading the ledger stamps.
  const short = await reviewDiff(repo, before, after, { path: patch, excerptChars: 400 });
  assert.equal(short.truncated, false);
  assert.equal(short.partial, true);
  assert.ok(!short.text.includes('[the diff file stopped'));
  assert.ok(short.text.includes('[excerpt ends at 400 characters;'));

  // And a whole diff says nothing at all.
  const whole = await reviewDiff(repo, before, after, { path: patch, excerptChars: 8 * 1024 * 1024 });
  assert.equal(whole.truncated, false);
  assert.equal(whole.partial, false);
  assert.ok(!whole.text.includes('[the diff file stopped'));
  assert.ok(!whole.text.includes('[excerpt ends at'));
});

test('a capped git read answers with what fit instead of throwing', async () => {
  const read = await gitCapped(['log', '--format=%H%n%s'], { cwd: process.cwd(), maxBuffer: 64 });
  assert.equal(read.truncated, true);
  assert.equal(read.text.length, 64);
  // A read that could not run at all is still a throw: the cap is the only
  // failure this seam converts into an answer.
  await assert.rejects(
    () => gitCapped(['rev-parse', 'refs/heads/no-such-branch-here'], { cwd: process.cwd() }),
    /git rev-parse/,
  );
});

// -- the brief and the ledger ------------------------------------------------

/** A run store and the seat seam the review lane spawns through. */
function runFixture(t, report) {
  return seatsFixture(t, () => report);
}

/**
 * The same seam, with the report chosen per seat. The record rule puts a
 * verifier behind a review that raised no HIGH at all, so a scenario about it
 * needs the two seats to answer differently. `cost` is what the seam reports a
 * dispatch spent, which the per-record stamp carries.
 */
function seatsFixture(t, reportFor, { cost } = {}) {
  const root = tempDir('olympus-reviewstamp-');
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
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, JSON.stringify(report));
      store.append('seat-report', { actor: seat, seat, path: reportPath, attempt: 1 });
      return { ok: true, report, ...(cost !== undefined && { cost }) };
    },
  };
  return { ctx, paths };
}

const BASE = {
  config: { version: 1, commands: {}, gates: { tier1: [] } },
  worktree: process.cwd(),
  env: undefined,
  constitution: null,
  specRef: 'spec.md',
  uiPaths: [],
  lenses: ['spec', 'security'],
};

const REPORT = {
  findings: [
    {
      lens: 'security',
      severity: 'MEDIUM',
      finding: 'the token check reads a header it never validates',
      evidence: 'src/pay.mjs:41',
    },
  ],
  summary: 'one advisory',
};

/** An excerpted diff as the verdict stage hands one over. */
function excerpted(overrides = {}) {
  return {
    text: 'diff --git a/src/pay.mjs b/src/pay.mjs',
    path: 'C:\\olympusd-home\\runs\\r1\\reviews\\diff-c1.patch',
    bytes: 3_145_728,
    files: 7,
    chars: 12_000,
    partial: true,
    truncated: false,
    ...overrides,
  };
}

// The whole defect, at the brief: a seat given part of a diff has to be told
// it is part, where the rest is, and that reading it is its job.
test('an excerpted brief names the file, the size and the count, and says to read it all', async (t) => {
  const { ctx } = runFixture(t, REPORT);
  const diff = excerpted();

  await generalistReview(ctx, BASE, { cycle: 1, diff, priorConfirmed: [] });

  const brief = ctx.briefs.find((b) => b.seat === 'generalist-review').roleBlock;
  assert.ok(
    brief.includes('The excerpt below is the first 12000 characters of a 3145728-byte diff across 7 files.'),
    brief,
  );
  assert.ok(brief.includes(`The whole diff is at ${diff.path}.`), brief);
  assert.ok(
    brief.includes(
      'Read the whole file before you judge; a finding must cite the file and hunk it comes from.',
    ),
    brief,
  );
  // The excerpt is still in the brief, under a heading that says what it is.
  assert.ok(brief.includes(`Excerpt:\n${diff.text}`), brief);
});

// Every judgment seat, not the generalist alone: the Fury panel fans out and
// each of its lens seats reads the same statement about what it is holding.
test('every Fury lens seat is given the same statement about the diff', async (t) => {
  const { ctx } = runFixture(t, REPORT);
  const diff = excerpted();

  await furyRound(ctx, BASE, { cycle: 1, diff, diffFiles: ['src/pay.mjs'] });

  const lensSeats = ctx.briefs.filter((b) => b.seat.startsWith('fury-') && b.seat !== 'fury-verifier');
  assert.ok(lensSeats.length > 0, 'the panel seated nobody');
  for (const { seat, roleBlock } of lensSeats) {
    assert.ok(roleBlock.includes(`The whole diff is at ${diff.path}.`), seat);
    assert.ok(
      roleBlock.includes(
        'Read the whole file before you judge; a finding must cite the file and hunk it comes from.',
      ),
      seat,
    );
  }
});

// The other form: the excerpt IS the diff. One line says so, and it names the
// file anyway, so the absence of a path never means anything.
test('a brief whose excerpt is the whole diff says so and names the same file', async (t) => {
  const { ctx } = runFixture(t, REPORT);
  const diff = excerpted({ bytes: 420, files: 1, chars: 420, partial: false });

  await generalistReview(ctx, BASE, { cycle: 1, diff, priorConfirmed: [] });

  const brief = ctx.briefs.find((b) => b.seat === 'generalist-review').roleBlock;
  assert.ok(
    brief.includes(`The whole diff is below: 420 bytes across 1 file. The same text is on disk at ${diff.path}.`),
    brief,
  );
  assert.ok(!brief.includes('Read the whole file before you judge'), brief);
  assert.ok(brief.includes(`Diff:\n${diff.text}`), brief);
});

test('a finding raised over a cut diff carries the word for it', async (t) => {
  const { ctx, paths } = runFixture(t, REPORT);

  const outcome = await generalistReview(ctx, BASE, {
    cycle: 1,
    diff: excerpted({ truncated: true }),
    priorConfirmed: [],
  });

  assert.equal(outcome.fail, undefined);
  const findings = readEvents(runLedgerPath(paths, 'r1')).filter((e) => e.event === 'finding');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].diffTruncated, true);
});

// The correction the excerpt earns: a seat that read an excerpt read the whole
// work, because the file behind it holds all of it. Only the read cap makes a
// finding partial, and this diff cleared it.
test('a finding raised over an excerpt of a whole diff carries nothing', async (t) => {
  const { ctx, paths } = runFixture(t, REPORT);

  await generalistReview(ctx, BASE, { cycle: 1, diff: excerpted(), priorConfirmed: [] });

  const findings = readEvents(runLedgerPath(paths, 'r1')).filter((e) => e.event === 'finding');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].diffTruncated, undefined);
});

// The path the verdict stage names is inside the run's own directory, so the
// patch archives with the run exactly as the verdict record does.
test("a cycle's diff file sits in the run directory, beside the record", () => {
  const paths = { runs: join('C:', 'olympusd-home', 'runs') };
  assert.equal(
    reviewDiffPath(paths, 'r1', 'diff-c2'),
    join('C:', 'olympusd-home', 'runs', 'r1', 'reviews', 'diff-c2.patch'),
  );
});

// The allowlist word is assigned at the stamp, and the path it is assigned
// against is prose: a seat writes the path it was reading, and what it was
// reading is the run worktree. A match against any other form answers no
// silently, which is the one thing the field exists to stop (ADR-0010).
test('a finding carries the file the lens named, in the form a path entry is written', async (t) => {
  const worktree = process.cwd();
  const report = {
    findings: [
      { lens: 'spec', severity: 'MED', finding: 'a', evidence: 'e', file: './allowlists/price.json' },
      {
        lens: 'spec',
        severity: 'MED',
        finding: 'b',
        evidence: 'e',
        file: join(worktree, 'allowlists', 'price.json'),
      },
      { lens: 'spec', severity: 'MED', finding: 'c', evidence: 'e', file: 'allowlists\\price.json' },
      { lens: 'spec', severity: 'MED', finding: 'd', evidence: 'e', file: 'src/pay.mjs' },
      { lens: 'spec', severity: 'MED', finding: 'e', evidence: 'e' },
    ],
    summary: 'five',
  };
  const { ctx, paths } = runFixture(t, report);

  await generalistReview(
    ctx,
    { ...BASE, worktree, allowlistPaths: ['allowlists/**'] },
    { cycle: 1, diff: excerpted(), priorConfirmed: [] },
  );

  const findings = readEvents(runLedgerPath(paths, 'r1')).filter((e) => e.event === 'finding');
  assert.deepEqual(
    findings.map((f) => f.file),
    [
      'allowlists/price.json',
      'allowlists/price.json',
      'allowlists/price.json',
      'src/pay.mjs',
      undefined,
    ],
  );
  assert.deepEqual(
    findings.map((f) => f.allowlist),
    [true, true, true, undefined, undefined],
  );
  // Every review seat is asked for the field, so the ledger can hold it.
  const brief = ctx.briefs.find((b) => b.seat === 'generalist-review').roleBlock;
  assert.ok(brief.includes('Put the repo-relative path of the one file a finding is about'), brief);
});

// -- the record review: one seat per record, and no diff ----------------------
//
// A decision record says how the product works. A sentence of it that the tree
// contradicts is a defect, not a remark, so the severity ladder does not apply
// to it: every grade goes to the verifier, a confirmed one blocks, and a
// refuted one carries the verifier's evidence instead of the advisory word
// (ADR-0007).
//
// Which sentences were read is the question this round answers. One seat holds
// one record, the units the harness counted in it, the neighbourhood and no
// diff, and it answers every unit by id. A live reconciliation spent three
// cycles at about ten dollars each on seats that started at the diff and
// sampled the rest of the document, and ended on the round cap rather than on a
// clean record (ADR-0073).

const RECORD_FILE = 'docs/adr/0001-doubling.md';
const OTHER_RECORD = 'docs/adr/0002-surface.md';

/** A lane base whose project declares a record tree. */
const RECORD_BASE = { ...BASE, worktree: process.cwd(), recordPaths: ['docs/adr'] };

/** A verifier report answering each item with the verdict the map names. */
function verdicts(map) {
  return ({ roleBlock }) => ({
    results: [...roleBlock.matchAll(/^- \[([^\]]+)\] \(([a-z-]+)\)/gm)].map((m) => ({
      id: m[1],
      verdict: map[m[1]] ?? 'refuted',
      evidence: 'read the tree',
    })),
    summary: 'verified',
  });
}

function findingEvents(paths) {
  return readEvents(runLedgerPath(paths, 'r1')).filter((e) => e.event === 'finding');
}

const RECORD_TEXT = [
  '# ADR-0001: Double the price',
  '',
  'Status: Accepted',
  'Date: 2026-09-01',
  '',
  '## Decision',
  '',
  'The helper doubles the price in src/pay.mjs.',
  '',
  '## Consequences',
  '',
  'The second route is not yet built.',
  '',
].join('\n');

const OTHER_TEXT = [
  '# ADR-0002: Serve one route',
  '',
  'Status: Accepted',
  '',
  '## Decision',
  '',
  'The public surface is one route, in src/pay.mjs.',
  '',
  '## Context',
  '',
  'It narrows what ADR-0001 decided.',
  '',
].join('\n');

const SUPERSEDED_TEXT = [
  '# ADR-0003: Cache the price',
  '',
  'Status: Superseded by ADR-0002 (2026-09-02)',
  '',
  '## Decision',
  '',
  'The price is cached in src/pay.mjs.',
  '',
].join('\n');

/** A worktree holding the records under judgment and the code they cite. */
function recordTree(t, files = {}) {
  const root = tempDir('olympus-recordreview-');
  const worktree = join(root, 'tree');
  const tree = {
    [RECORD_FILE]: RECORD_TEXT,
    [OTHER_RECORD]: OTHER_TEXT,
    'src/pay.mjs': 'export const pay = 1;\n',
    ...files,
  };
  for (const [path, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), text);
  }
  t.after(() => removeDir(root));
  return worktree;
}

function recordBase(worktree, overrides = {}) {
  return { ...BASE, worktree, recordPaths: ['docs/adr'], ...overrides };
}

/**
 * A complete unit answer for one record: the harness's own enumeration, with a
 * kind the kind test accepts and evidence the worktree holds. A test that wants
 * one unit answered differently names it.
 */
function unitAnswers(worktree, record, overrides = {}) {
  return recordUnits(readFileSync(join(worktree, record), 'utf8')).map((unit) => {
    const read = kindTest(unit.head) ? 'claim' : 'rationale';
    const kind = overrides[unit.id]?.kind ?? unit.kind ?? read;
    return {
      record,
      id: unit.id,
      kind,
      verdict: overrides[unit.id]?.verdict ?? (kind === 'open' ? 'not-built' : 'holds'),
      evidence: kind === 'claim' ? 'src/pay.mjs:1' : 'the sentence claims nothing',
    };
  });
}

function recordReport(worktree, record, { findings = [], units = {} } = {}) {
  return {
    findings,
    units: unitAnswers(worktree, record, units),
    summary: 'the record, read whole',
  };
}

/** One finding on the first claim unit of the doubling record. */
function claimFinding(overrides = {}) {
  return {
    id: 'r1',
    criterion: 'truth',
    severity: 'HIGH',
    file: RECORD_FILE,
    unit: 'U3',
    head: 'The helper doubles the price in src/pay.mjs.',
    line: 8,
    summary: 'the record claims a doubling the helper does not apply',
    evidence: 'src/pay.mjs:1',
    ...overrides,
  };
}

test('a record review is one seat per record, and each seat holds one record', async (t) => {
  const more = {
    'docs/adr/0004-cache.md': RECORD_TEXT.replace('ADR-0001', 'ADR-0004'),
    'docs/adr/0005-retry.md': RECORD_TEXT.replace('ADR-0001', 'ADR-0005'),
  };
  const worktree = recordTree(t, more);
  const records = [RECORD_FILE, OTHER_RECORD, ...Object.keys(more)];
  const fx = seatsFixture(t, ({ seat }) =>
    recordReport(worktree, records[Number(seat.split(':')[1]) - 1]),
  );

  const outcome = await recordReviewRound(fx.ctx, recordBase(worktree), { records, cycle: 1 });

  assert.equal(outcome.fail, undefined);
  // Four records is four seats, each with its own slot, so each holds its own
  // attempt budget, its own cost line and its own failure record.
  assert.deepEqual(
    fx.ctx.briefs.map((b) => b.seat).sort(),
    ['record-review:1', 'record-review:2', 'record-review:3', 'record-review:4'],
  );
  const first = fx.ctx.briefs.find((b) => b.seat === 'record-review:1').roleBlock;
  const second = fx.ctx.briefs.find((b) => b.seat === 'record-review:2').roleBlock;
  assert.ok(first.includes(`Review one decision record: ${RECORD_FILE}`), first);
  assert.ok(second.includes(`Review one decision record: ${OTHER_RECORD}`), second);
  // One record per seat: another record reaches a seat as a neighbour to read
  // against, and never as a record to judge.
  for (const { roleBlock } of fx.ctx.briefs) {
    assert.equal((roleBlock.match(/^Review one decision record:/gm) ?? []).length, 1, roleBlock);
    assert.equal((roleBlock.match(/^The units of /gm) ?? []).length, 1, roleBlock);
  }
  assert.ok(first.includes(`The units of ${RECORD_FILE},`), first);
  assert.ok(second.includes(`The units of ${OTHER_RECORD},`), second);
});

// The defect this test holds: the diff anchored the review. The record seat is
// given the document, the harness's count of it, and nothing of the diff.
test('a record review brief carries the units and no diff', async (t) => {
  const worktree = recordTree(t);
  const fx = seatsFixture(t, () => recordReport(worktree, RECORD_FILE));

  await recordReviewRound(fx.ctx, recordBase(worktree), {
    records: [RECORD_FILE],
    neighbours: { [RECORD_FILE]: { neighbours: [OTHER_RECORD], dropped: 8 } },
    moved: { [RECORD_FILE]: ['U3'] },
    spec: { key: 's-1', path: 'specs/s-1.md', text: 'The price doubles.' },
    cycle: 2,
  });

  const brief = fx.ctx.briefs[0].roleBlock;
  // The record, whole, and the harness's own enumeration of it.
  assert.ok(brief.includes('Read it whole, from the working tree.'), brief);
  assert.ok(brief.includes(`The units of ${RECORD_FILE}, as the harness counts them:`), brief);
  assert.ok(brief.includes('- U0 (line 1, title): # ADR-0001: Double the price'), brief);
  assert.ok(brief.includes('- U3 (line 8): The helper doubles the price in src/pay.mjs.'), brief);
  assert.ok(brief.includes(`node ${UNITS_BIN} ${RECORD_FILE}`), brief);
  // The criteria and the rule they serve.
  assert.ok(brief.includes(RECORD_RULE), brief);
  for (const key of RECORD_CRITERION_KEYS) {
    assert.ok(brief.includes(`- ${RECORD_CRITERIA[key]}`), key);
  }
  // The work, the neighbourhood with the count above the cap, and the units
  // this round moved, by head.
  assert.ok(brief.includes('Work: s-1'), brief);
  assert.ok(brief.includes('The specification: specs/s-1.md'), brief);
  assert.ok(brief.includes('The price doubles.'), brief);
  assert.ok(brief.includes(`- ${OTHER_RECORD}`), brief);
  assert.ok(brief.includes('8 more active records cite this one'), brief);
  assert.ok(brief.includes(`capped at ${NEIGHBOUR_CAP} by rank`), brief);
  assert.ok(
    brief.includes(
      'The units this round moved: "The helper doubles the price in src/pay.mjs.".',
    ),
    brief,
  );
  // The constitution and the style files bind the sentences of a record.
  assert.ok(brief.includes('A constitution block above this brief'), brief);
  assert.ok(brief.includes('a style block names the rule files'), brief);
  // And no diff, in any of its forms.
  for (const word of ['Diff:', 'Excerpt:', 'diff --git', 'git diff', '.patch', 'the whole diff']) {
    assert.ok(!brief.includes(word), `${word} reached a record seat: ${brief}`);
  }
});

test('a record seat with no neighbour, and one whose neighbourhood the tree gives', async (t) => {
  const worktree = recordTree(t);
  const fx = seatsFixture(t, () => recordReport(worktree, RECORD_FILE));

  await recordReviewRound(fx.ctx, recordBase(worktree), { records: [RECORD_FILE], cycle: 1 });
  // Nobody passed a neighbourhood, so the harness read the tree: ADR-0002 cites
  // ADR-0001, which is what makes it a neighbour.
  const read = fx.ctx.briefs[0].roleBlock;
  assert.ok(read.includes(`- ${OTHER_RECORD}`), read);
  assert.ok(!read.includes('more active records cite this one'), read);

  const empty = seatsFixture(t, () => recordReport(worktree, RECORD_FILE));
  await recordReviewRound(empty.ctx, recordBase(worktree), {
    records: [RECORD_FILE],
    neighbours: { [RECORD_FILE]: { neighbours: [], dropped: 0 } },
    cycle: 1,
  });
  const none = empty.ctx.briefs[0].roleBlock;
  assert.ok(none.includes('Neighbourhood: no active record cites this record'), none);
  assert.ok(none.includes('No unit of this record moved in this round.'), none);
});

test('the record schema requires the unit a finding names, and the units it read', () => {
  const schema = recordReviewSchema();
  const item = schema.properties.findings.items;
  assert.deepEqual(item.required, [
    'id',
    'criterion',
    'severity',
    'file',
    'unit',
    'head',
    'line',
    'summary',
    'evidence',
  ]);
  assert.deepEqual(item.properties.criterion.enum, [...RECORD_CRITERION_KEYS]);
  // The second place is in the shape and owed on one criterion, which no flat
  // schema can say: the check says it instead.
  for (const key of ['file2', 'unit2', 'head2']) {
    assert.ok(key in item.properties, key);
    assert.ok(!item.required.includes(key), key);
  }
  const unit = schema.properties.units.items;
  assert.deepEqual(unit.required, ['record', 'id', 'kind', 'verdict', 'evidence']);
  assert.deepEqual(unit.properties.kind.enum, [...UNIT_KINDS]);
  assert.deepEqual(unit.properties.verdict.enum, [...UNIT_VERDICTS]);
  assert.deepEqual(schema.required, ['findings', 'units', 'summary']);
  // No code lens reaches this seat.
  assert.ok(!('lens' in item.properties));
});

// The unit check is the whole mechanism: a report that answers less than every
// unit is refused, and the second attempt is briefed with what it missed.
test('a record report that leaves a unit unanswered buys one corrective attempt', async (t) => {
  const worktree = recordTree(t);
  const fx = seatsFixture(t, ({ roleBlock }) => {
    const report = recordReport(worktree, RECORD_FILE);
    if (roleBlock.includes('Correction brief')) return report;
    return { ...report, units: report.units.slice(0, -1) };
  });

  const outcome = await recordReviewRound(fx.ctx, recordBase(worktree), {
    records: [RECORD_FILE],
    cycle: 1,
  });

  assert.equal(outcome.fail, undefined);
  assert.equal(fx.ctx.briefs.length, 2);
  const retry = fx.ctx.briefs[1].roleBlock;
  assert.ok(retry.includes('Correction brief'), retry);
  assert.ok(retry.includes('unit check 1'), retry);
  assert.ok(retry.includes('U4'), retry);
});

// The two refusals of point 4, both before the verifier: the seat gets them
// back as work-product defects and the run pays no verifier seat for them.
test('a consistent finding that names one record is returned to the seat', async (t) => {
  const worktree = recordTree(t);
  const fx = seatsFixture(t, ({ roleBlock }) => {
    if (roleBlock.includes('Correction brief')) return recordReport(worktree, RECORD_FILE);
    return recordReport(worktree, RECORD_FILE, {
      findings: [claimFinding({ criterion: 'consistent' })],
      units: { U3: { verdict: 'fails' } },
    });
  });

  const outcome = await recordReviewRound(fx.ctx, recordBase(worktree), {
    records: [RECORD_FILE],
    cycle: 1,
  });

  assert.deepEqual(outcome.confirmed, []);
  const retry = fx.ctx.briefs[1].roleBlock;
  assert.ok(retry.includes('cites "consistent" and names one record'), retry);
  // The verifier never saw it, and no finding was stamped.
  assert.ok(!fx.ctx.briefs.some((b) => b.seat === 'fury-verifier'));
  assert.deepEqual(findingEvents(fx.paths), []);
});

test('a finding on a superseded record is returned to the seat', async (t) => {
  const worktree = recordTree(t, { 'docs/adr/0003-cache.md': SUPERSEDED_TEXT });
  const fx = seatsFixture(t, ({ roleBlock }) => {
    if (roleBlock.includes('Correction brief')) return recordReport(worktree, RECORD_FILE);
    return recordReport(worktree, RECORD_FILE, {
      findings: [claimFinding({ file: 'docs/adr/0003-cache.md' })],
    });
  });

  const outcome = await recordReviewRound(
    fx.ctx,
    recordBase(worktree, { recordLifecycle: 'supersede' }),
    { records: [RECORD_FILE], cycle: 1 },
  );

  assert.deepEqual(outcome.confirmed, []);
  const retry = fx.ctx.briefs[1].roleBlock;
  assert.ok(retry.includes('whose status line reads superseded or retired'), retry);
  assert.ok(!fx.ctx.briefs.some((b) => b.seat === 'fury-verifier'));
});

test('each record seat stamps what it answered, unit by unit, with its cost', async (t) => {
  const worktree = recordTree(t);
  const fx = seatsFixture(
    t,
    ({ seat }) =>
      recordReport(worktree, seat === 'record-review:1' ? RECORD_FILE : OTHER_RECORD, {
        units: { U4: { kind: 'open' } },
      }),
    { cost: 1.25 },
  );

  await recordReviewRound(fx.ctx, recordBase(worktree), {
    records: [RECORD_FILE, OTHER_RECORD],
    neighbours: {
      [RECORD_FILE]: { neighbours: [OTHER_RECORD], dropped: 3 },
      [OTHER_RECORD]: { neighbours: [], dropped: 0 },
    },
    cycle: 4,
  });

  const stamps = readEvents(runLedgerPath(fx.paths, 'r1')).filter((e) => e.event === 'record-units');
  assert.equal(stamps.length, 2);
  const [first] = stamps;
  assert.equal(first.seat, 'record-review:1');
  assert.equal(first.cycle, 4);
  assert.equal(first.record, RECORD_FILE);
  assert.equal(first.cost, 1.25);
  assert.equal(first.neighbours, 1);
  assert.equal(first.neighboursDropped, 3);
  assert.deepEqual(
    first.units.map((u) => u.id),
    ['U0', 'U1', 'U2', 'U3', 'U4'],
  );
  // The per-unit list is the fact the writer's miss rate joins on, so the entry
  // carries the verdict and the kind and not a count alone.
  assert.deepEqual(first.counts, { claims: 1, holds: 4, fails: 0, notBuilt: 1 });
  assert.equal(stamps[1].neighbours, 0);
});

test('a record finding is stamped with its unit, and a consistent one with the second place', async (t) => {
  const worktree = recordTree(t);
  const consistent = claimFinding({
    id: 'r2',
    criterion: 'consistent',
    unit: 'U4',
    head: 'The second route is not yet built.',
    line: 12,
    summary: 'ADR-0002 decides the same unbuilt surface the other way',
    file2: OTHER_RECORD,
    unit2: 'U3',
    head2: 'The public surface is one route, in src/pay.mjs.',
  });
  const fx = seatsFixture(t, ({ seat, roleBlock }) =>
    seat.endsWith('-verifier')
      ? verdicts({ 'new-1': 'confirmed', 'new-2': 'confirmed' })({ roleBlock })
      : recordReport(worktree, RECORD_FILE, {
          findings: [claimFinding(), consistent],
          units: { U3: { verdict: 'fails' }, U4: { kind: 'open', verdict: 'fails' } },
        }),
  );

  const outcome = await recordReviewRound(fx.ctx, recordBase(worktree), {
    records: [RECORD_FILE],
    cycle: 3,
  });

  assert.equal(outcome.confirmed.length, 2);
  const events = findingEvents(fx.paths);
  assert.equal(events.length, 2);
  const [truth, second] = events;
  assert.equal(truth.record, true);
  assert.equal(truth.cycle, 3);
  assert.equal(truth.lens, 'record');
  assert.equal(truth.source, 'record-review:1');
  assert.equal(truth.file, RECORD_FILE);
  assert.equal(truth.unit, 'U3');
  assert.equal(truth.head, 'The helper doubles the price in src/pay.mjs.');
  assert.equal(truth.line, 8);
  assert.equal(truth.advisory, undefined);
  // The seat's sentence reaches the ledger, because the corrective brief and
  // the ticket both quote it.
  assert.equal(truth.summary, 'the record claims a doubling the helper does not apply');
  assert.equal(second.criterion, 'consistent');
  assert.equal(second.file2, OTHER_RECORD);
  assert.equal(second.unit2, 'U3');
  assert.equal(second.head2, 'The public surface is one route, in src/pay.mjs.');
});

// One split for every lane: a HIGH is verified, and a confirmed one blocks.
test('a HIGH finding on a record is verified and blocks', async (t) => {
  const worktree = recordTree(t);
  const fx = seatsFixture(t, ({ seat, roleBlock }) =>
    seat.endsWith('-verifier')
      ? verdicts({ 'new-1': 'confirmed' })({ roleBlock })
      : recordReport(worktree, RECORD_FILE, {
          findings: [claimFinding()],
          units: { U3: { verdict: 'fails' } },
        }),
  );

  const outcome = await recordReviewRound(fx.ctx, recordBase(worktree), {
    records: [RECORD_FILE],
    cycle: 1,
  });

  const verifier = fx.ctx.briefs.filter((b) => b.seat === 'record-verifier');
  assert.equal(verifier.length, 1);
  assert.equal((verifier[0].roleBlock.match(/^- \[new-\d+\]/gm) ?? []).length, 1);
  assert.equal(outcome.confirmed.length, 1);
  assert.equal(outcome.confirmed[0].record, true);
  assert.equal(outcome.confirmed[0].criterion, 'truth');
  assert.equal(outcome.confirmed[0].unit, 'U3');
  const [finding] = findingEvents(fx.paths);
  assert.equal(finding.confirmed, true);
  assert.equal(finding.advisory, undefined);
});

// The remarks. A MED and a LOW on a record are stamped with everything a
// corrective brief needs to quote them, and nothing else happens to them: no
// verifier reads them, and no render turns red on them (plan 41, point 2).
test('a MED and a LOW record finding are remarks, stamped with their record place', async (t) => {
  const worktree = recordTree(t);
  const low = claimFinding({
    id: 'r2',
    severity: 'LOW',
    criterion: 'reference',
    unit: 'U4',
    head: 'The second route is not yet built.',
    line: 12,
    summary: 'the record cites a route the tree does not name',
  });
  const fx = seatsFixture(t, () =>
    recordReport(worktree, RECORD_FILE, {
      findings: [claimFinding({ severity: 'MED' }), low],
      units: { U3: { verdict: 'fails' }, U4: { kind: 'open', verdict: 'fails' } },
    }),
  );

  const outcome = await recordReviewRound(fx.ctx, recordBase(worktree), {
    records: [RECORD_FILE],
    cycle: 1,
  });

  // No verifier at all: the round holds nothing for it.
  assert.ok(!fx.ctx.briefs.some((b) => b.seat.endsWith('-verifier')), 'a remark bought a verifier');
  assert.deepEqual(outcome.confirmed, []);
  const events = findingEvents(fx.paths);
  assert.equal(events.length, 2);
  for (const finding of events) {
    assert.equal(finding.advisory, true);
    assert.equal(finding.record, true);
    assert.equal(finding.confirmed, undefined);
    assert.equal(finding.file, RECORD_FILE);
  }
  const [med, remark] = events;
  assert.equal(med.severity, 'MED');
  assert.equal(med.criterion, 'truth');
  assert.equal(med.unit, 'U3');
  assert.equal(med.head, 'The helper doubles the price in src/pay.mjs.');
  assert.equal(med.line, 8);
  assert.equal(med.summary, 'the record claims a doubling the helper does not apply');
  assert.equal(remark.severity, 'LOW');
  assert.equal(remark.unit, 'U4');
  assert.equal(remark.criterion, 'reference');
});

// The brief states what the grade means, so the grade is a definition and not
// a feeling.
test('the record review brief states what HIGH means and what a remark is', async (t) => {
  const worktree = recordTree(t);
  const fx = seatsFixture(t, () => recordReport(worktree, RECORD_FILE));

  await recordReviewRound(fx.ctx, recordBase(worktree), { records: [RECORD_FILE], cycle: 1 });

  const brief = fx.ctx.briefs[0].roleBlock;
  assert.ok(
    brief.includes(
      'HIGH means the record and the tree disagree on what the\n  product does, and a confirmed HIGH blocks.',
    ),
    brief,
  );
  assert.ok(brief.includes('MED and LOW are remarks'), brief);
  assert.ok(brief.includes('never a round on their own'), brief);
});

test('a MED finding on code is advisory, and reaches no verifier', async (t) => {
  const fx = seatsFixture(t, () => ({
    findings: [
      {
        lens: 'operational',
        severity: 'MED',
        finding: 'no retry handling',
        evidence: 'src/pay.mjs:41',
        file: 'src/pay.mjs',
      },
    ],
    summary: 'one on code',
  }));

  const outcome = await generalistReview(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    priorConfirmed: [],
  });

  assert.deepEqual(outcome.confirmed, []);
  assert.ok(!fx.ctx.briefs.some((b) => b.seat === 'fury-verifier'));
  const [finding] = findingEvents(fx.paths);
  assert.equal(finding.severity, 'MED');
  assert.equal(finding.advisory, true);
  assert.equal(finding.record, undefined);
  assert.equal(finding.confirmed, undefined);
});

test('a refuted record finding keeps its verdict and takes no advisory word', async (t) => {
  const worktree = recordTree(t);
  const fx = seatsFixture(t, ({ seat, roleBlock }) =>
    seat.endsWith('-verifier')
      ? verdicts({})({ roleBlock })
      : recordReport(worktree, RECORD_FILE, {
          findings: [claimFinding()],
          units: { U3: { verdict: 'fails' } },
        }),
  );

  const outcome = await recordReviewRound(fx.ctx, recordBase(worktree), {
    records: [RECORD_FILE],
    cycle: 1,
  });

  assert.deepEqual(outcome.confirmed, []);
  const [finding] = findingEvents(fx.paths);
  assert.equal(finding.record, true);
  assert.equal(finding.confirmed, false);
  assert.equal(finding.criterion, 'truth');
  // The one word this rule removes. A second seat read the tree and wrote down
  // why the record is right; that is a verdict, not advice.
  assert.equal(finding.advisory, undefined);
});

// The item list picks the verifier: a round of record items alone takes the
// seat that runs the records lane's own model, and anything else takes the
// certification seat (plan 41, point 3).
test('a settle over record items alone spawns the record verifier', async (t) => {
  const worktree = recordTree(t);
  const fx = seatsFixture(t, ({ seat, roleBlock }) =>
    seat.endsWith('-verifier')
      ? verdicts({ 'new-1': 'confirmed' })({ roleBlock })
      : recordReport(worktree, RECORD_FILE, {
          findings: [claimFinding()],
          units: { U3: { verdict: 'fails' } },
        }),
  );

  await recordReviewRound(fx.ctx, recordBase(worktree), { records: [RECORD_FILE], cycle: 4 });

  const verifiers = fx.ctx.briefs.filter((b) => b.seat.endsWith('-verifier'));
  assert.equal(verifiers.length, 1);
  assert.equal(verifiers[0].seat, 'record-verifier');
  assert.ok(!fx.ctx.briefs.some((b) => b.seat === 'fury-verifier'));
  // One function behind both names: the brief is the verifier's own.
  assert.ok(verifiers[0].roleBlock.includes('Verify each review finding below'), verifiers[0].roleBlock);
  assert.ok(verifiers[0].roleBlock.includes(`[record: ${RECORD_FILE}]`), verifiers[0].roleBlock);
});

test('a settle holding one code item spawns the code verifier', async (t) => {
  const fx = seatsFixture(t, ({ seat, roleBlock }) =>
    seat.endsWith('-verifier')
      ? verdicts({ 'new-1': 'confirmed' })({ roleBlock })
      : {
          findings: [
            {
              lens: 'security',
              severity: 'HIGH',
              finding: 'the token check reads a header it never validates',
              evidence: 'src/pay.mjs:41',
              file: 'src/pay.mjs',
            },
          ],
          summary: 'one on code',
        },
  );

  await generalistReview(fx.ctx, RECORD_BASE, { cycle: 1, diff: excerpted(), priorConfirmed: [] });

  const verifiers = fx.ctx.briefs.filter((b) => b.seat.endsWith('-verifier'));
  assert.equal(verifiers.length, 1);
  assert.equal(verifiers[0].seat, 'fury-verifier');
});

// The seat name is the argument, so the choice is a function a reader can ask
// without running a round.
test('the item list picks the verifier seat', () => {
  const record = { finding: { record: true } };
  const code = { finding: { severity: 'HIGH' } };
  assert.equal(verifierFor([record, record]), 'record-verifier');
  assert.equal(verifierFor([record, code]), 'fury-verifier');
  assert.equal(verifierFor([code]), 'fury-verifier');
  // An empty round spawns nobody, and the name it would take is the code seat's.
  assert.equal(verifierFor([]), 'fury-verifier');
  assert.deepEqual([...VERIFIER_SEATS], ['fury-verifier', 'record-verifier']);
});

// A record seat's findings are record findings because a record seat raised
// them. The project's path list decides nothing here: the stage handed the seat
// one record and the seat read that record.
test('a record seat raises record findings whatever the project paths say', async (t) => {
  const worktree = recordTree(t);
  const fx = seatsFixture(t, ({ seat, roleBlock }) =>
    seat.endsWith('-verifier')
      ? verdicts({ 'new-1': 'confirmed' })({ roleBlock })
      : recordReport(worktree, RECORD_FILE, {
          findings: [claimFinding({ criterion: 'divergence' })],
          units: { U3: { verdict: 'fails' } },
        }),
  );

  const outcome = await recordReviewRound(
    fx.ctx,
    recordBase(worktree, { recordPaths: ['somewhere/else'] }),
    { records: [RECORD_FILE], cycle: 1 },
  );

  assert.equal(outcome.confirmed.length, 1);
  const [finding] = findingEvents(fx.paths);
  assert.equal(finding.record, true);
  assert.equal(finding.criterion, 'divergence');
});

// The verifier is given the scope the review had: the record whole, the
// criterion, and the unit the finding is about. A verifier handed the file
// alone reads it for a sentence that matches the claim.
test('the verifier is told the record, the unit head and the criterion', async (t) => {
  const worktree = recordTree(t);
  const fx = seatsFixture(t, ({ seat, roleBlock }) =>
    seat.endsWith('-verifier')
      ? verdicts({ 'new-1': 'confirmed' })({ roleBlock })
      : recordReport(worktree, RECORD_FILE, {
          findings: [claimFinding({ criterion: 'reference' })],
          units: { U3: { verdict: 'fails' } },
        }),
  );

  await recordReviewRound(fx.ctx, recordBase(worktree), { records: [RECORD_FILE], cycle: 1 });

  const brief = fx.ctx.briefs.find((b) => b.seat === 'record-verifier').roleBlock;
  assert.ok(
    brief.includes(
      `[record: ${RECORD_FILE}] [unit: U3 "The helper doubles the price in src/pay.mjs."] ` +
        '[criterion: reference]',
    ),
    brief,
  );
  assert.ok(brief.includes('The records those items are about:'), brief);
  assert.ok(brief.includes(`- ${RECORD_FILE}`), brief);
  assert.ok(
    brief.includes(
      'Read each of those records whole, from the working tree, before you confirm or refute',
    ),
    brief,
  );
  assert.ok(brief.includes('is as confirmable as a finding about'), brief);
  for (const key of RECORD_CRITERION_KEYS) {
    assert.ok(brief.includes(`- ${RECORD_CRITERIA[key]}`), key);
  }
  assert.ok(brief.includes('refuted for want of evidence'), brief);
  assert.ok(brief.includes('Taste is not a criterion.'), brief);
});

// -- the code lenses hold no record -------------------------------------------
//
// The four sites that put a record into a code lens are gone. A code lens keeps
// the diff and "judge the diff only"; the records leave its file list and its
// brief, and they are judged by their own seats (ADR-0073).

const DIFF_ONLY = 'Judge the diff only. Do not fix anything; do not widen into unchanged code.';

test('a code lens brief on a mixed diff holds no record', async (t) => {
  const fx = seatsFixture(t, () => ({ findings: [], summary: 'clean' }));

  await generalistReview(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    priorConfirmed: [],
  });

  const seat = fx.ctx.briefs.find((b) => b.seat === 'generalist-review');
  for (const lens of RECORD_BASE.lenses) {
    assert.ok(seat.roleBlock.includes(`- ${LENS_CRITERIA[lens]}`), lens);
  }
  assert.ok(seat.roleBlock.includes(DIFF_ONLY), seat.roleBlock);
  // No record lens, no record path, no whole-record duty, and no qualification
  // on the scope line.
  assert.ok(!seat.roleBlock.includes('That rule is about the code files'), seat.roleBlock);
  assert.ok(!seat.roleBlock.includes(RECORD_FILE), seat.roleBlock);
  assert.ok(!seat.roleBlock.includes('decision record'), seat.roleBlock);
  assert.ok(!seat.roleBlock.includes(RECORD_RULE), seat.roleBlock);
  const item = seat.schema.properties.findings.items;
  assert.deepEqual(item.properties.lens.enum, [...RECORD_BASE.lenses]);
  assert.ok(!('criterion' in item.properties));
  assert.deepEqual(item.required, ['lens', 'severity', 'finding', 'evidence']);
});

test('a mixed diff is the code panel plus one record seat per record', async (t) => {
  const worktree = recordTree(t);
  const base = recordBase(worktree, { lenses: ['spec', 'security'], uiPaths: [] });
  const fx = seatsFixture(t, ({ seat }) =>
    seat.startsWith('record-review')
      ? recordReport(worktree, seat === 'record-review:1' ? RECORD_FILE : OTHER_RECORD)
      : { findings: [], summary: 'clean' },
  );

  await furyRound(fx.ctx, base, {
    cycle: 1,
    diff: excerpted(),
    diffFiles: [RECORD_FILE, OTHER_RECORD, 'src/pay.mjs'],
  });
  await recordReviewRound(fx.ctx, base, {
    records: [RECORD_FILE, OTHER_RECORD],
    cycle: 2,
  });

  const seats = fx.ctx.briefs.map((b) => b.seat);
  assert.ok(seats.includes('fury-spec'), seats.join(','));
  assert.ok(seats.includes('fury-operational'), seats.join(','));
  assert.deepEqual(
    seats.filter((s) => s.startsWith('record-review')).sort(),
    ['record-review:1', 'record-review:2'],
  );
  // Every lens seat of the panel keeps the diff and holds no record.
  for (const { seat, roleBlock } of fx.ctx.briefs.filter((b) => b.seat.startsWith('fury-'))) {
    assert.ok(roleBlock.includes(DIFF_ONLY), seat);
    assert.ok(!roleBlock.includes(RECORD_FILE), seat);
    assert.ok(!roleBlock.includes('read whole'), seat);
  }
});

// The record paths leave the file list the panel fans out over, so a record
// never decides which code seat runs.
test('a record path is not in the file list the Fury round reads', async (t) => {
  const base = { ...RECORD_BASE, uiPaths: ['src/ui'], lenses: ['spec', 'interface'] };
  const withUi = seatsFixture(t, () => ({ findings: [], summary: 'clean' }));
  await furyRound(withUi.ctx, base, {
    cycle: 1,
    diff: excerpted(),
    diffFiles: [RECORD_FILE, 'src/ui/pay.svelte'],
  });
  assert.ok(withUi.ctx.briefs.some((b) => b.seat === 'fury-interface'));

  const recordsOnly = seatsFixture(t, () => ({ findings: [], summary: 'clean' }));
  await furyRound(recordsOnly.ctx, base, {
    cycle: 1,
    diff: excerpted(),
    diffFiles: [RECORD_FILE],
  });
  const seats = recordsOnly.ctx.briefs.map((b) => b.seat);
  assert.ok(!seats.includes('fury-interface'), seats.join(','));
  // And no route to the generalist seat: the record lens left the panel.
  assert.ok(!seats.includes('generalist-review'), seats.join(','));
});

