// The tree a retry runs against (ADR-0055). A `stage-blocked` park is the
// class of failure the run cannot repair itself: the repair lands on the
// default branch, where the operator can write. The run's tree is pinned at
// launch, so a retry answered on that park has to meet a tree that holds the
// repair, or the same park comes back for ever.
//
// The scenarios walk one repair through the whole route on a real repository:
// the park, the repair on the default branch, the answer, the refreshed tree,
// and the stage that then passes. The refusals ride beside them, because the
// refresh is bounded to a tree the run has written nothing to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { scaffoldHome, archivedRunLedgerPath, runLedgerPath } from '../src/daemon/home.mjs';
import { storyLane } from '../src/lanes/story.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import {
  tempDir,
  removeDir,
  waitFor,
  initOriginRepo,
  commitTree,
  projectConfigJson,
  FIXTURE_ACCEPTANCE,
} from './helpers.mjs';

const CONFIG_PATH = '.olympus/project.json';
const CARD_PATH = 'stories/alpha.md';
const SECOND_CARD = 'stories/beta.md';

const CARD = `---
key: alpha-1
title: Alpha feature
---

## Goal

Provide f(x) that doubles x in src/feature.mjs.
${FIXTURE_ACCEPTANCE}`;

const BETA_CARD = `---
key: beta-1
title: Beta feature
---

## Goal

Provide g(x) that halves x in src/feature.mjs.
${FIXTURE_ACCEPTANCE}`;

// The card the project's lint refuses, and the repair for it. The lint reads
// every card, so one bad card holds every launch behind it.
const BETA_BROKEN = 'Beta feature, with no frontmatter at all.\n';

// The lint a project puts in front of every writer of a card.
const CARD_LINT = `import { readdirSync, readFileSync } from 'node:fs';

for (const name of readdirSync('stories')) {
  if (!name.endsWith('.md')) continue;
  if (!readFileSync(\`stories/\${name}\`, 'utf8').startsWith('---')) {
    console.error(\`card lint: \${name} carries no frontmatter\`);
    process.exit(1);
  }
}
console.log('card lint: every card carries frontmatter');
`;

// -- fixture -----------------------------------------------------------------

function fixtureParse(line) {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    return { cost: parsed.cost, note: parsed.note, meta: parsed.meta };
  } catch {
    return null;
  }
}

function seatScript({ reportPath, model, report }) {
  const stmts = [
    "const fs = require('fs');",
    "const path = require('path');",
    `console.log(${JSON.stringify(JSON.stringify({ meta: { model } }))});`,
  ];
  if (report !== undefined) {
    stmts.push(
      `fs.mkdirSync(path.dirname(${JSON.stringify(reportPath)}), { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});`,
    );
  }
  stmts.push('process.exit(0);');
  return stmts.join('\n');
}

// One seat behavior: spec birth reports nothing usable, so the chain parks
// under `seat-failure` the moment readiness lets it through. What this suite
// reads is that readiness let it through at all.
function seatFixture() {
  const calls = [];
  let last = null;
  const commandFor = (opts) => {
    const header = /You are the (\S+) seat/.exec(opts.prompt);
    const lines = opts.prompt.split('\n');
    const contract = lines.findIndex((l) => l.includes('write your JSON report to this file'));
    const seat = header ? header[1] : last.seat;
    const reportPath = header ? lines[contract + 1] : last.reportPath;
    last = { seat, reportPath };
    calls.push({ seat, label: basename(reportPath, '.json'), attempt: opts.attempt });
    return {
      cmd: process.execPath,
      args: ['-e', seatScript({ reportPath, model: opts.model, report: {} })],
      parseLine: fixtureParse,
    };
  };
  return { commandFor, calls };
}

function fixture(t, { beta = BETA_BROKEN } = {}) {
  const root = tempDir();
  const origin = initOriginRepo(join(root, 'origin'), {
    [CONFIG_PATH]: projectConfigJson({
      repo: { testPaths: ['tests'] },
      commands: { suite: ['node', '--test', 'tests/*.test.mjs'], cardlint: ['node', 'scripts/cardlint.mjs'] },
      lanes: { story: { suiteCommand: 'suite', lintCommand: 'cardlint' } },
      stack: null,
    }),
    'scripts/cardlint.mjs': CARD_LINT,
    [CARD_PATH]: CARD,
    [SECOND_CARD]: beta,
    'src/base.mjs': 'export const base = 1;\n',
  });
  const home = join(root, 'home');
  const paths = scaffoldHome(home);
  writeFileSync(
    paths.instanceConfig,
    JSON.stringify({ version: 1, projects: { proj: { repoUrl: origin, slotCap: 2 } } }) + '\n',
  );
  const lanes = {
    story: storyLane({
      afterFreeze: {
        stages: ['done'],
        handlers: { done: async () => ({ close: { state: 'shipped' } }) },
      },
    }),
  };
  const seats = seatFixture();
  const daemon = new Daemon(home, { lanes });
  t.after(async () => {
    await daemon.stop();
    removeDir(root);
  });
  return {
    paths,
    origin,
    calls: seats.calls,
    async launch() {
      await daemon.start();
      daemon.engine.seatDefaults = () => ({ commandFor: seats.commandFor });
      return daemon.launchRun({ project: 'proj', lane: 'story', card: CARD_PATH });
    },
    /** The repair an operator makes where the run cannot: on the branch. */
    repair(files, message) {
      return commitTree(origin, files, message);
    },
    answer(runId, answer) {
      daemon.engine.answer({ runId, actor: 'operator', ...answer });
    },
  };
}

function events(paths, runId) {
  const live = runLedgerPath(paths, runId);
  return readEvents(existsSync(live) ? live : archivedRunLedgerPath(paths, runId));
}

/** One text, in one line ending, whatever the host checked out. */
function lines(text) {
  return text.replaceAll('\r\n', '\n');
}

function waitParked(paths, runId, nth = 1) {
  return waitFor(
    () => {
      const parks = events(paths, runId).filter(
        (e) => e.event === 'park' && e.type === 'stage-blocked',
      );
      return parks.length >= nth ? parks[nth - 1] : undefined;
    },
    { label: `stage-blocked park #${nth}`, attempts: 400, intervalMs: 100 },
  );
}

function waitSeatPark(paths, runId, nth) {
  return waitFor(
    () => {
      const parks = events(paths, runId).filter(
        (e) => e.event === 'park' && e.type === 'seat-failure',
      );
      return parks.length >= nth ? parks[nth - 1] : undefined;
    },
    { label: `seat-failure park #${nth}`, attempts: 400, intervalMs: 100 },
  );
}

function waitFound(paths, runId, match, label) {
  return waitFor(() => events(paths, runId).find(match), { label, attempts: 400, intervalMs: 100 });
}

// -- the route ---------------------------------------------------------------

test('a retry meets the repair the branch carries, and the tree says so', async (t) => {
  const fx = fixture(t);
  const { runId, worktree, baseSha } = await fx.launch();
  const park = await waitParked(fx.paths, runId);
  assert.equal(park.reason, 'readiness-lint');
  assert.ok(park.question.includes('carries no frontmatter'));

  // The operator repairs what the run cannot: the card lands on the branch.
  const repaired = fx.repair({ [SECOND_CARD]: BETA_CARD }, 'cards: repair the second card');
  assert.notEqual(repaired, baseSha);

  fx.answer(runId, { option: 'retry' });
  const refresh = await waitFound(
    fx.paths,
    runId,
    (e) => e.event === 'tree-refreshed',
    'the tree refresh',
  );
  assert.equal(refresh.park, park.seq);
  assert.equal(refresh.moved, true);
  assert.equal(refresh.branch, 'main');
  assert.equal(refresh.from, baseSha);
  assert.equal(refresh.to, repaired);
  assert.equal(refresh.cause, undefined);
  // The refreshed tree holds the repair, and the stage that asked for it
  // passed. The comparison is line-ending blind: a checkout on this host may
  // write the same card with the host's own endings.
  assert.equal(lines(readFileSync(join(worktree, SECOND_CARD), 'utf8')), lines(BETA_CARD));
  await waitFound(
    fx.paths,
    runId,
    (e) => e.event === 'stage-entered' && e.stage === 'spec-birth',
    'the stage after readiness',
  );
  // One park, one refresh: the stage did not come back, and the entries behind
  // it read the ledger and stopped.
  await waitFound(
    fx.paths,
    runId,
    (e) => e.event === 'park' && e.type === 'seat-failure',
    'the park the fixture seat earns',
  );
  const held = events(fx.paths, runId);
  assert.equal(held.filter((e) => e.event === 'park' && e.type === 'stage-blocked').length, 1);
  assert.equal(held.filter((e) => e.event === 'tree-refreshed').length, 1);
});

test('a repair that never landed leaves the park exactly where it was', async (t) => {
  const fx = fixture(t);
  const { runId, baseSha } = await fx.launch();
  const park = await waitParked(fx.paths, runId);
  // The answer arrives with nothing behind it: the branch never moved.
  fx.answer(runId, { option: 'retry' });
  const refresh = await waitFound(
    fx.paths,
    runId,
    (e) => e.event === 'tree-refreshed',
    'the tree refresh',
  );
  assert.equal(refresh.moved, false);
  assert.equal(refresh.from, baseSha);
  assert.equal(refresh.to, baseSha);
  const second = await waitParked(fx.paths, runId, 2);
  assert.equal(second.reason, 'readiness-lint');
  assert.ok(second.seq > park.seq);
});

test('a tree with work of its own keeps it, and the refusal is recorded', async (t) => {
  const fx = fixture(t);
  const { runId, worktree } = await fx.launch();
  const park = await waitParked(fx.paths, runId);
  // The operator repairs the tree by hand, the way an operator answers a
  // missing file today. The repair is uncommitted work, and it survives.
  writeFileSync(join(worktree, SECOND_CARD), BETA_CARD);
  writeFileSync(join(worktree, 'src/scratch.mjs'), 'export const scratch = 1;\n');
  fx.repair({ [SECOND_CARD]: BETA_CARD }, 'cards: repair the second card');
  fx.answer(runId, { option: 'retry' });
  const refresh = await waitFound(
    fx.paths,
    runId,
    (e) => e.event === 'tree-refreshed',
    'the tree refresh',
  );
  assert.equal(refresh.park, park.seq);
  assert.equal(refresh.moved, false);
  assert.match(refresh.cause, /uncommitted/);
  assert.ok(existsSync(join(worktree, 'src/scratch.mjs')));
  // The hand repair is what the retry then met, so the stage passed on it.
  await waitFound(
    fx.paths,
    runId,
    (e) => e.event === 'stage-entered' && e.stage === 'spec-birth',
    'the stage after readiness',
  );
});

test('an abandoned park refreshes nothing', async (t) => {
  const fx = fixture(t);
  const { runId } = await fx.launch();
  await waitParked(fx.paths, runId);
  fx.repair({ [SECOND_CARD]: BETA_CARD }, 'cards: repair the second card');
  fx.answer(runId, { option: 'abandon' });
  await waitFor(
    () => events(fx.paths, runId).find((e) => e.event === 'run-closed'),
    { label: 'the run to close', attempts: 400, intervalMs: 100 },
  );
  assert.ok(!events(fx.paths, runId).some((e) => e.event === 'tree-refreshed'));
});

test('a park of another class buys no refresh', async (t) => {
  // Nothing is wrong with the branch here: the lint is green from the start,
  // and the only park the run reaches is the one its own seat earns.
  const fx = fixture(t, { beta: BETA_CARD });
  const { runId } = await fx.launch();
  const first = await waitSeatPark(fx.paths, runId, 1);
  // The branch moves under the run, and the answer buys the invocation it
  // always bought: a seat is not a substrate, so its retry refreshes nothing.
  fx.repair({ 'src/base.mjs': 'export const base = 2;\n' }, 'src: a later commit');
  fx.answer(runId, { option: 'retry' });
  const second = await waitSeatPark(fx.paths, runId, 2);
  assert.ok(second.seq > first.seq);
  assert.ok(!events(fx.paths, runId).some((e) => e.event === 'tree-refreshed'));
});
