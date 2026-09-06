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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { changedInRange, reviewDiff } from '../src/isolation/tree.mjs';
import { gitCapped } from '../src/isolation/git.mjs';
import { DEFAULT_EXCERPT_CHARS } from '../src/config/project.mjs';
import { furyRound, generalistReview } from '../src/lanes/review.mjs';
import {
  LENS_CRITERIA,
  RECORD_CRITERIA,
  RECORD_CRITERION_KEYS,
  RECORD_RULE,
} from '../src/lanes/lenses.mjs';
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
 * needs the two seats to answer differently.
 */
function seatsFixture(t, reportFor) {
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
      return { ok: true, report };
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

// -- a finding on a decision record is never advisory -------------------------
//
// A decision record says how the product works. A sentence of it that the tree
// contradicts is a defect, not a remark, so the severity ladder does not apply
// to it: every grade goes to the verifier, a confirmed one blocks, and a
// refuted one carries the verifier's evidence instead of the advisory word
// (ADR-0007). The tests below hold the split, both sides of it, and the three
// rules that decide which findings are record findings (ADR-0026).

const RECORD_BASE = { ...BASE, worktree: process.cwd(), recordPaths: ['docs/adr'] };
const RECORD_FILE = 'docs/adr/0001-doubling.md';

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

test('a MED finding on a record file is verified and blocks; a MED on code is advisory', async (t) => {
  const review = {
    findings: [
      {
        lens: 'record',
        severity: 'MED',
        finding: 'the record claims a transform the helper does not apply',
        evidence: 'src/image.mjs:12',
        file: RECORD_FILE,
        criterion: 'truth',
      },
      {
        lens: 'operational',
        severity: 'MED',
        finding: 'no retry handling',
        evidence: 'src/pay.mjs:41',
        file: 'src/pay.mjs',
      },
    ],
    summary: 'one of each',
  };
  const fx = seatsFixture(t, ({ seat, roleBlock }) =>
    seat === 'fury-verifier' ? verdicts({ 'new-1': 'confirmed' })({ roleBlock }) : review,
  );

  const outcome = await generalistReview(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    priorConfirmed: [],
    diffFiles: [RECORD_FILE, 'src/pay.mjs'],
  });

  // One item reached the verifier, and it is the MED on the record.
  const verifier = fx.ctx.briefs.filter((b) => b.seat === 'fury-verifier');
  assert.equal(verifier.length, 1);
  assert.equal((verifier[0].roleBlock.match(/^- \[new-\d+\]/gm) ?? []).length, 1);
  assert.ok(verifier[0].roleBlock.includes('[criterion: truth]'), verifier[0].roleBlock);

  // The confirmed record finding is open, and it carries the two new words.
  assert.equal(outcome.confirmed.length, 1);
  assert.equal(outcome.confirmed[0].record, true);
  assert.equal(outcome.confirmed[0].criterion, 'truth');
  const events = findingEvents(fx.paths);
  assert.equal(events.length, 2);
  const [record, code] = events;
  assert.equal(record.record, true);
  assert.equal(record.criterion, 'truth');
  assert.equal(record.confirmed, true);
  assert.equal(record.advisory, undefined);
  assert.equal(record.file, RECORD_FILE);
  // The severity ladder is intact everywhere else: the MED on code is advisory,
  // it was never verified, and it blocks nothing.
  assert.equal(code.severity, 'MED');
  assert.equal(code.advisory, true);
  assert.equal(code.record, undefined);
  assert.equal(code.confirmed, undefined);
});

test('a refuted record finding keeps its verdict and takes no advisory word', async (t) => {
  const review = {
    findings: [
      {
        lens: 'record',
        severity: 'LOW',
        finding: 'the budget line is wrong for the spendOnSuccess rows',
        evidence: 'the record, line 118',
        file: RECORD_FILE,
        criterion: 'truth',
      },
    ],
    summary: 'one',
  };
  const fx = seatsFixture(t, ({ seat, roleBlock }) =>
    seat === 'fury-verifier' ? verdicts({})({ roleBlock }) : review,
  );

  const outcome = await generalistReview(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    priorConfirmed: [],
    diffFiles: [RECORD_FILE],
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

test('a record-only diff carries the record lens, the six criteria and no code criterion', async (t) => {
  const review = { findings: [], summary: 'the records stand' };
  const fx = seatsFixture(t, () => review);

  await generalistReview(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    priorConfirmed: [],
    diffFiles: [RECORD_FILE, 'docs/adr/0002-other.md'],
  });

  const seat = fx.ctx.briefs.find((b) => b.seat === 'generalist-review');
  for (const key of RECORD_CRITERION_KEYS) {
    assert.ok(seat.roleBlock.includes(`- ${RECORD_CRITERIA[key]}`), key);
  }
  // Nothing from the code lenses reaches a seat reading markdown.
  for (const lens of ['spec', 'security']) {
    assert.ok(!seat.roleBlock.includes(`- ${LENS_CRITERIA[lens]}`), lens);
  }
  // And the schema is the record shape: one lens, and both fields required.
  const item = seat.schema.properties.findings.items;
  assert.deepEqual(item.properties.lens.enum, ['record']);
  assert.deepEqual(item.properties.criterion.enum, [...RECORD_CRITERION_KEYS]);
  assert.deepEqual(item.required, ['lens', 'severity', 'file', 'finding', 'evidence', 'criterion']);
});

test('a mixed diff carries the panel plus the record lens, and names the record files', async (t) => {
  const fx = seatsFixture(t, () => ({ findings: [], summary: 'clean' }));

  await generalistReview(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    priorConfirmed: [],
    diffFiles: [RECORD_FILE, 'src/pay.mjs'],
  });

  const seat = fx.ctx.briefs.find((b) => b.seat === 'generalist-review');
  for (const lens of RECORD_BASE.lenses) {
    assert.ok(seat.roleBlock.includes(`- ${LENS_CRITERIA[lens]}`), lens);
  }
  assert.ok(seat.roleBlock.includes('- record: the decision records this diff changes'));
  assert.ok(seat.roleBlock.includes(`- ${RECORD_FILE}`), seat.roleBlock);
  assert.ok(seat.roleBlock.includes('"criterion" it fails'), seat.roleBlock);
  const item = seat.schema.properties.findings.items;
  assert.deepEqual(item.properties.lens.enum, [...RECORD_BASE.lenses, 'record']);
  // Both fields stay optional here: the brief asks for them on a record file,
  // and a finding that leaves the path out is graded as it always was.
  assert.deepEqual(item.required, ['lens', 'severity', 'finding', 'evidence']);
});

test('a reconciliation review raises record findings with no path and the wrong record tree', async (t) => {
  const review = {
    findings: [
      {
        lens: 'record',
        severity: 'LOW',
        finding: 'a divergence the rewrite absorbed',
        evidence: 'the record says webp; the helper applies no transform',
        criterion: 'divergence',
      },
    ],
    summary: 'one, with no file on it',
  };
  const fx = seatsFixture(t, ({ seat, roleBlock }) =>
    seat === 'fury-verifier' ? verdicts({ 'new-1': 'confirmed' })({ roleBlock }) : review,
  );

  // The project's record paths name a tree nothing in this diff sits under, and
  // the seat named no file. The cycle judges a record commit, so both are
  // irrelevant: the write seat's own check refused any other file.
  const outcome = await generalistReview(
    fx.ctx,
    { ...RECORD_BASE, recordPaths: ['somewhere/else'] },
    { cycle: 1, diff: excerpted(), priorConfirmed: [], diffFiles: null, reconcile: true },
  );

  assert.equal(outcome.confirmed.length, 1);
  const [finding] = findingEvents(fx.paths);
  assert.equal(finding.record, true);
  assert.equal(finding.criterion, 'divergence');
  assert.equal(finding.file, undefined);
  assert.equal(finding.advisory, undefined);
});

test('the verifier is told the criterion a record finding cites and the list it comes from', async (t) => {
  const review = {
    findings: [
      {
        lens: 'record',
        severity: 'HIGH',
        finding: 'the record names urlFor(), which the tree does not export',
        evidence: 'src/image.mjs',
        file: RECORD_FILE,
        criterion: 'reference',
      },
    ],
    summary: 'one',
  };
  const fx = seatsFixture(t, ({ seat, roleBlock }) =>
    seat === 'fury-verifier' ? verdicts({ 'new-1': 'confirmed' })({ roleBlock }) : review,
  );

  await generalistReview(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    priorConfirmed: [],
    diffFiles: [RECORD_FILE],
  });

  const brief = fx.ctx.briefs.find((b) => b.seat === 'fury-verifier').roleBlock;
  assert.ok(brief.includes('[criterion: reference]'), brief);
  for (const key of RECORD_CRITERION_KEYS) {
    assert.ok(brief.includes(`- ${RECORD_CRITERIA[key]}`), key);
  }
  assert.ok(brief.includes('refuted for want of evidence'), brief);
  assert.ok(brief.includes('Taste is not a criterion.'), brief);
});

// -- a record review reads the whole record -----------------------------------
//
// A record is a set of claims about the code, and it is judged as a document.
// A seat handed the changed hunks alone reads the hunks and never sees a stale
// claim three paragraphs above them. One live reconciliation spent four review
// cycles that way: every cycle raised four or five confirmed findings on the
// layer the round before it had just moved, every round closed everything it
// was given, and what ended the pass was the round cap. So the brief names each
// record, says to read it whole from the working tree, and says the diff is
// context and not the boundary (ADR-0026).

const OTHER_RECORD = 'docs/adr/0002-other.md';
const READ_WHOLE = 'Read every one of those files whole, from the working tree, before you write a finding.';
const JUDGE_EVERY = 'Judge every claim in each record, changed in this diff or not.';
const DIFF_ONLY = 'Judge the diff only. Do not fix anything; do not widen into unchanged code.';

test('the record-only brief names each record, says to read it whole, and calls the diff context', async (t) => {
  const fx = seatsFixture(t, () => ({ findings: [], summary: 'the records stand' }));

  await generalistReview(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    priorConfirmed: [],
    diffFiles: [RECORD_FILE, OTHER_RECORD],
  });

  const brief = fx.ctx.briefs.find((b) => b.seat === 'generalist-review').roleBlock;
  assert.ok(brief.includes('The decision records this change moved:'), brief);
  assert.ok(brief.includes(`- ${RECORD_FILE}`), brief);
  assert.ok(brief.includes(`- ${OTHER_RECORD}`), brief);
  assert.ok(brief.includes(READ_WHOLE), brief);
  assert.ok(brief.includes(JUDGE_EVERY), brief);
  assert.ok(brief.includes('It is context, and it is not the boundary of the review'), brief);
  assert.ok(brief.includes('a finding may cite any'), brief);
  // The rule the six criteria serve opens the table.
  assert.ok(brief.includes(RECORD_RULE), brief);
  // And what the record rule already asked for stays asked for.
  assert.ok(brief.includes('Cite the sentence of the record your finding is about'), brief);
});

// The reconciliation cycle knows its records from its own diff. The write seat's
// containment check refused every other file, so a project whose record paths
// name another tree still gets its records named to the seat.
test('a reconciliation review names the records its own diff moved, whatever the path list says', async (t) => {
  const fx = seatsFixture(t, () => ({ findings: [], summary: 'clean' }));

  await generalistReview(
    fx.ctx,
    { ...RECORD_BASE, recordPaths: ['somewhere/else'] },
    {
      cycle: 1,
      diff: excerpted(),
      priorConfirmed: [],
      diffFiles: ['docs/records/0001-doubling.md'],
      reconcile: true,
    },
  );

  const brief = fx.ctx.briefs.find((b) => b.seat === 'generalist-review').roleBlock;
  assert.ok(brief.includes('- docs/records/0001-doubling.md'), brief);
  assert.ok(brief.includes(READ_WHOLE), brief);
});

// A cycle whose diff read failed knows no path. The duty is stated against the
// diff instead, because a brief that named no file and asked for none would
// leave the seat with the hunks again.
test('a record review that knows no path still asks for the whole record', async (t) => {
  const fx = seatsFixture(t, () => ({ findings: [], summary: 'clean' }));

  await generalistReview(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    priorConfirmed: [],
    diffFiles: null,
    reconcile: true,
  });

  const brief = fx.ctx.briefs.find((b) => b.seat === 'generalist-review').roleBlock;
  assert.ok(!brief.includes('The decision records this change moved:'), brief);
  assert.ok(
    brief.includes(
      'Read every decision record in the diff whole, from the working tree, before you write a finding.',
    ),
    brief,
  );
  assert.ok(brief.includes(JUDGE_EVERY), brief);
});

// The mixed diff. "Do not widen into unchanged code" is right for a code lens
// and wrong for a record, so the sentence stays and says which files it is
// about.
test('a mixed brief reads the records whole and keeps "judge the diff only" for the code', async (t) => {
  const fx = seatsFixture(t, () => ({ findings: [], summary: 'clean' }));

  await generalistReview(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    priorConfirmed: [],
    diffFiles: [RECORD_FILE, 'src/pay.mjs'],
  });

  const brief = fx.ctx.briefs.find((b) => b.seat === 'generalist-review').roleBlock;
  assert.ok(brief.includes(DIFF_ONLY), brief);
  assert.ok(
    brief.includes(
      `${DIFF_ONLY} That rule is about the code files: a decision record in this diff is read ` +
        'whole, from the working tree, and judged whole.',
    ),
    brief,
  );
  assert.ok(brief.includes(READ_WHOLE), brief);
  assert.ok(brief.includes(JUDGE_EVERY), brief);
  assert.ok(brief.includes(`- ${RECORD_FILE}`), brief);
});

// A diff with no record in it is judged exactly as it was: the qualification
// rides the record files and nothing else.
test('a code-only brief keeps the plain scope line and asks for no record', async (t) => {
  const fx = seatsFixture(t, () => ({ findings: [], summary: 'clean' }));

  await generalistReview(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    priorConfirmed: [],
    diffFiles: ['src/pay.mjs'],
  });

  const brief = fx.ctx.briefs.find((b) => b.seat === 'generalist-review').roleBlock;
  assert.ok(brief.includes(DIFF_ONLY), brief);
  assert.ok(!brief.includes('That rule is about the code files'), brief);
  assert.ok(!brief.includes(READ_WHOLE), brief);
});

// Every Fury seat of a mixed round carries the record lens, so every one of
// them takes the same qualification.
test('every Fury lens seat on a mixed diff is told to read the record whole', async (t) => {
  const fx = seatsFixture(t, () => ({ findings: [], summary: 'clean' }));

  await furyRound(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    diffFiles: [RECORD_FILE, 'src/pay.mjs'],
  });

  const lensSeats = fx.ctx.briefs.filter(
    (b) => b.seat.startsWith('fury-') && b.seat !== 'fury-verifier',
  );
  assert.ok(lensSeats.length > 0, 'the panel seated nobody');
  for (const { seat, roleBlock } of lensSeats) {
    assert.ok(roleBlock.includes('That rule is about the code files'), seat);
    assert.ok(roleBlock.includes(READ_WHOLE), seat);
    assert.ok(roleBlock.includes(`- ${RECORD_FILE}`), seat);
  }
});

// The verifier is given the scope the review had. A finding about a sentence
// the diff never moved is an ordinary finding, and a seat that refuted it for
// sitting outside the diff would refuse the work the review exists to do.
test('the verifier is given the record path and told to read the record whole', async (t) => {
  const review = {
    findings: [
      {
        lens: 'record',
        severity: 'LOW',
        finding: 'the record names a fallback path the tree removed',
        evidence: 'src/image.mjs',
        file: RECORD_FILE,
        criterion: 'truth',
      },
    ],
    summary: 'one, on a sentence this diff never touched',
  };
  const fx = seatsFixture(t, ({ seat, roleBlock }) =>
    seat === 'fury-verifier' ? verdicts({ 'new-1': 'confirmed' })({ roleBlock }) : review,
  );

  await generalistReview(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    priorConfirmed: [],
    diffFiles: [RECORD_FILE],
  });

  const brief = fx.ctx.briefs.find((b) => b.seat === 'fury-verifier').roleBlock;
  assert.ok(brief.includes('The records those items are about:'), brief);
  assert.ok(brief.includes(`- ${RECORD_FILE}`), brief);
  assert.ok(
    brief.includes(
      'Read each of those records whole, from the working tree, before you confirm or refute',
    ),
    brief,
  );
  assert.ok(brief.includes('is as confirmable as a finding about'), brief);
  // The item line carries the record beside the criterion it cites.
  assert.ok(brief.includes(`[record: ${RECORD_FILE}] [criterion: truth]`), brief);
});

// The Fury fan-out is the panel over code. A pass whose whole diff is records
// has no code to fan out over, and the record lens rides one seat.
test('a Fury round over a record-only diff is the one record seat', async (t) => {
  const fx = seatsFixture(t, () => ({ findings: [], summary: 'clean' }));

  await furyRound(fx.ctx, RECORD_BASE, {
    cycle: 1,
    diff: excerpted(),
    diffFiles: [RECORD_FILE],
  });

  assert.deepEqual(
    fx.ctx.briefs.map((b) => b.seat),
    ['generalist-review'],
  );
});
