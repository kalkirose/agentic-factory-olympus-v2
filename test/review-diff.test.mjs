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
    runSeat: async ({ seat, roleBlock, reportPath }) => {
      briefs.push({ seat, roleBlock });
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
