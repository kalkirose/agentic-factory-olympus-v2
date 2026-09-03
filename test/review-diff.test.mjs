// The diff a review seat is given, and the two ways it can be short.
//
// A candidate diff grows with the work. Four packages installed into a project
// put a lockfile change in it and take it past the runner's default output cap
// on their own, and the read that hit that cap threw inside the verdict stage
// handler. The engine reads a handler throw as a liveness violation, so a run
// whose whole spectrum had come out green went inert on the size of a file
// nobody reviews (ADR-0066). These tests hold the three rules that replaced it:
// the read is capped high enough that a lockfile cannot reach it, the lockfile
// is kept out of the patch and named beside it instead, and a diff that is
// short anyway says so rather than throwing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { changedInRange, reviewDiff } from '../src/isolation/tree.mjs';
import { gitCapped } from '../src/isolation/git.mjs';
import { generalistReview } from '../src/lanes/review.mjs';
import { scaffoldHome, runLedgerPath } from '../src/daemon/home.mjs';
import { openRunStore } from '../src/telemetry/stores.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { tempDir, removeDir, commitTree, gitSync, initOriginRepo } from './helpers.mjs';

/** Node's own default output cap, and so the size the old read died at. */
const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;

function repoFixture(t, files) {
  const root = tempDir('olympus-reviewdiff-');
  const repo = initOriginRepo(join(root, 'repo'), files);
  t.after(() => removeDir(root));
  return repo;
}

test('a candidate diff past node\'s default output cap is read whole', async (t) => {
  const repo = repoFixture(t, { 'src/a.mjs': 'base\n' });
  const before = gitSync(['rev-parse', 'HEAD'], repo).trim();
  // Three megabytes of distinct lines: distinct so git cannot collapse them,
  // and three because the cap that used to end this read was one.
  const bulk = Array.from({ length: 60_000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const after = commitTree(repo, { 'src/bulk.mjs': bulk + '\n' }, 'bulk');

  const diff = await reviewDiff(repo, before, after, { limit: 8 * 1024 * 1024 });

  assert.ok(
    diff.text.length > 3 * NODE_DEFAULT_MAX_BUFFER,
    `the read stopped early at ${diff.text.length} bytes`,
  );
  assert.equal(diff.truncated, false);
  assert.ok(diff.text.includes('line 59999'), 'the end of the patch is missing');
});

test('lockfiles and generated files are named to the seat, never pasted into it', async (t) => {
  const repo = repoFixture(t, {
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

  const diff = await reviewDiff(repo, before, after, { limit: 8 * 1024 * 1024 });

  // The work is there in full.
  assert.ok(diff.text.includes('+the change under judgment'));
  // The excluded content is not, at either depth, and neither is the generated
  // file's.
  assert.ok(!diff.text.includes('dep-399'), 'lockfile content reached the seat');
  assert.ok(!diff.text.includes('export const two'), 'generated content reached the seat');
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
  assert.equal(diff.truncated, false);
  // A name read answers about every path, exactly as it did before.
  assert.ok((await changedInRange(repo, before, after)).includes('pnpm-lock.yaml'));
});

test('a project states its own exclusions, and an empty list filters nothing', async (t) => {
  const repo = repoFixture(t, { 'src/a.mjs': 'base\n', 'schema.sql': 'select 1;\n' });
  const before = gitSync(['rev-parse', 'HEAD'], repo).trim();
  const after = commitTree(
    repo,
    { 'src/a.mjs': 'work\n', 'schema.sql': 'select 2;\n' },
    'work plus generated sql',
  );

  const stated = await reviewDiff(repo, before, after, { exclude: ['schema.sql'] });
  assert.deepEqual(stated.excluded, ['schema.sql']);
  assert.ok(!stated.text.includes('+select 2;'));

  const none = await reviewDiff(repo, before, after, { exclude: [] });
  assert.deepEqual(none.excluded, []);
  assert.ok(none.text.includes('+select 2;'));
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
  const repo = repoFixture(t, { 'src/a.mjs': 'base\n', ...before });
  const baseSha = gitSync(['rev-parse', 'HEAD'], repo).trim();
  const after = commitTree(
    repo,
    {
      'src/a.mjs': 'the change under judgment\n',
      ...Object.fromEntries(paths.map((p) => [p, 'export const one = 1;\nexport const two = 2;\n'])),
    },
    'a regeneration beside the work',
  );

  const diff = await reviewDiff(repo, baseSha, after, { limit: 8 * 1024 * 1024 });

  assert.equal(diff.excluded.length, 400);
  assert.ok(diff.text.includes('+the change under judgment'));
  assert.ok(!diff.text.includes('export const two'), 'generated content reached the seat');
  assert.ok(diff.text.includes(paths[0]), 'the first generated file is not named');
  assert.ok(diff.text.includes(paths.at(-1)), 'the last generated file is not named');
  assert.equal(diff.truncated, false);
});

test('a diff over the cap is cut, named, and never thrown', async (t) => {
  const repo = repoFixture(t, { 'src/a.mjs': 'base\n' });
  const before = gitSync(['rev-parse', 'HEAD'], repo).trim();
  const filler = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const after = commitTree(
    repo,
    { 'src/a.mjs': `${filler}\n`, 'src/b.mjs': `${filler}\n`, 'src/c.mjs': `${filler}\n` },
    'three files',
  );

  // The runner's cap, not the seat's window: this is the read that used to
  // throw, and the throw is what left the run inert.
  const capped = await reviewDiff(repo, before, after, { cap: 900, limit: 8 * 1024 * 1024 });
  assert.equal(capped.truncated, true);
  const marker = capped.text.split('\n').find((line) => line.startsWith('[diff truncated at '));
  assert.ok(marker, 'the cut patch carries no marker');
  assert.match(marker, /^\[diff truncated at \d+ bytes; \d+ files not shown: .+\]$/);
  assert.ok(marker.includes('src/c.mjs'), 'the marker does not name the file the seat never saw');

  // The seat's own window cuts the same way and says the same thing.
  const short = await reviewDiff(repo, before, after, { limit: 400 });
  assert.equal(short.truncated, true);
  assert.match(short.text, /\[diff truncated at 400 bytes; \d+ files not shown: /);

  // And a whole diff says nothing.
  const whole = await reviewDiff(repo, before, after, { limit: 8 * 1024 * 1024 });
  assert.equal(whole.truncated, false);
  assert.ok(!whole.text.includes('[diff truncated at'));
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

// -- the ledger side ---------------------------------------------------------

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
  const ctx = {
    store,
    paths,
    runId: 'r1',
    runSeat: async ({ seat, reportPath }) => {
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
  lenses: ['spec', 'security'],
};

test('a finding raised over a cut diff carries the word for it', async (t) => {
  const { ctx, paths } = runFixture(t, {
    findings: [
      {
        lens: 'security',
        severity: 'MEDIUM',
        finding: 'the token check reads a header it never validates',
        evidence: 'src/pay.mjs:41',
      },
    ],
    summary: 'one advisory',
  });

  const outcome = await generalistReview(ctx, BASE, {
    cycle: 1,
    diffText: 'diff',
    priorConfirmed: [],
    diffTruncated: true,
  });

  assert.equal(outcome.fail, undefined);
  const findings = readEvents(runLedgerPath(paths, 'r1')).filter((e) => e.event === 'finding');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].diffTruncated, true);
});

test('a finding raised over a whole diff carries nothing', async (t) => {
  const { ctx, paths } = runFixture(t, {
    findings: [
      {
        lens: 'security',
        severity: 'MEDIUM',
        finding: 'the token check reads a header it never validates',
        evidence: 'src/pay.mjs:41',
      },
    ],
    summary: 'one advisory',
  });

  await generalistReview(ctx, BASE, { cycle: 1, diffText: 'diff', priorConfirmed: [] });

  const findings = readEvents(runLedgerPath(paths, 'r1')).filter((e) => e.event === 'finding');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].diffTruncated, undefined);
});
