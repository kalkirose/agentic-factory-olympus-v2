// Scenario 5: the door. Every input a run is judged on is read where it
// arrives, and a launch the daemon refuses leaves nothing behind — no slot, no
// clone worktree, no stack, no run ledger, no leftover to sweep (ADR-0068).
//
// Four refusals through the assembled binaries: a launch that names no card, a
// card the default branch does not hold, a card the parser cannot read, and a
// credential whose probe answers no. Nothing here waits on a run, because the
// point is that no run is ever created.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homePaths } from '../src/daemon/home.mjs';
import { openWorkspaceLeftovers } from '../src/telemetry/readers.mjs';
import {
  CARD_PATH,
  PROJECT,
  PROJECT_CONFIG,
  SECRET_NAME,
  buildFixture,
  cleanup,
  ctl,
  diagnostics,
  instanceEvents,
  pollFor,
  startDaemon,
  stopDaemon,
} from './fixture.mjs';

const MISSING_CARD = '.olympus/cards/nowhere-1.md';
const BROKEN_CARD = '.olympus/cards/broken-1.md';

// A card with no frontmatter block and no key: two errors the parser reports
// by name, and the refusal quotes them.
const BROKEN = `# A card somebody started and never finished

## Goal

Something about a helper.
`;

// The project as this scenario declares it: one credential whose value is on
// the host and whose probe refuses it. The surface half passes, so the refusal
// is the probe's own and the launch never reaches a slot.
const REFUSING_PROBE = ['node', '-e', 'process.exit(1)'];

function doorConfig() {
  return {
    ...PROJECT_CONFIG,
    commands: { ...PROJECT_CONFIG.commands, credprobe: REFUSING_PROBE },
    credentials: [{ name: 'fixture', env: SECRET_NAME, probe: 'credprobe' }],
  };
}

/** The refusals stamped so far, newest last. */
function refusals(fx) {
  return instanceEvents(fx).filter((e) => e.event === 'launch-rejected');
}

async function refuse(fx, args, nth) {
  ctl(fx, ['launch', '--project', PROJECT, ...args]);
  return pollFor(`refusal ${nth}`, () => refusals(fx)[nth - 1], {
    diagnose: () => diagnostics(fx),
  });
}

test('the door refuses every input it can read, and leaves nothing behind', async (t) => {
  const fx = buildFixture({
    prefix: 'olympus-e2e-door-',
    scenario: {},
    tree: {
      [BROKEN_CARD]: BROKEN,
      '.olympus/project.json': JSON.stringify(doorConfig(), null, 2) + '\n',
    },
  });
  t.after(() => cleanup(fx));
  await startDaemon(fx);

  // 1. A story launch is a card and everything derived from it.
  const noCard = await refuse(fx, [], 1);
  assert.equal(noCard.lane, 'story');
  assert.match(noCard.requestedBy, /^console:/);
  assert.match(noCard.reason, /names no intent card/);

  // 2. A path the default branch does not hold.
  const missing = await refuse(fx, ['--card', MISSING_CARD], 2);
  assert.equal(missing.card, MISSING_CARD);
  assert.match(missing.reason, new RegExp(`the intent card ${MISSING_CARD} is not on main`));

  // 3. A card the parser refuses: the path, and the errors by name.
  const broken = await refuse(fx, ['--card', BROKEN_CARD], 3);
  assert.equal(broken.card, BROKEN_CARD);
  assert.match(broken.reason, /does not parse/);
  assert.match(broken.reason, /card has no frontmatter block/);
  assert.deepEqual(broken.detail.errors, ['card has no frontmatter block']);

  // 4. A credential the project declares and the service will not take. The
  // card is the good one, so this refusal is the probe's alone.
  const probed = await refuse(fx, ['--card', CARD_PATH], 4);
  assert.equal(probed.card, CARD_PATH);
  assert.match(probed.reason, /fixture credential probe answered no at the launch door/);
  assert.equal(probed.detail.credential, 'fixture');
  assert.equal(probed.detail.variable, SECRET_NAME);
  assert.match(probed.detail.fingerprint, /^[0-9a-f]{12}$/);
  // The value is named and never revealed.
  assert.ok(!probed.reason.includes('fixture-credential'));

  // The probe answered on the record, and it answered once per launch that
  // reached it — the three card refusals never got that far.
  const probes = instanceEvents(fx).filter((e) => e.event === 'credential-probe');
  assert.deepEqual(
    probes.map((e) => [e.phase, e.ok, e.credential]),
    [['launch', false, 'fixture']],
  );

  // Nothing was provisioned by any of the four: no run, no workspace, no
  // leftover for a sweep to find.
  const paths = homePaths(fx.home);
  assert.deepEqual(instanceEvents(fx).filter((e) => e.event === 'launch'), []);
  assert.deepEqual(existsSync(paths.runs) ? readdirSync(paths.runs) : [], []);
  assert.deepEqual(
    existsSync(paths.worktrees) ? readdirSync(paths.worktrees) : [],
    [],
    'the door left a worktree behind',
  );
  assert.equal(openWorkspaceLeftovers(paths).size, 0);
  // The console reads the same four in the status render.
  const status = ctl(fx, ['status']);
  assert.match(status, /REJECTED/);
  assert.ok(status.includes(BROKEN_CARD), `status does not name the refused card:\n${status}`);

  await stopDaemon(fx);
  assert.equal(fx.daemon.exitCode, 0, 'the daemon did not exit cleanly');
  // No leftover control file was refused by the intake itself: every one of
  // these was a well-formed command the door judged.
  assert.deepEqual(readdirSync(join(fx.home, 'control', 'rejected')).filter((n) => !n.endsWith('.reason.txt')), []);
});
