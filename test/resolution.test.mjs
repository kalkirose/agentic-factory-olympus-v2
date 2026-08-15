// Loud-item lifecycle: the ownership table, the resolutions a ledger's own
// events owe, and the engine sweep that pairs them the moment the owning
// event lands. The close-out sweep stays the backstop under all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunEngine } from '../src/engine/engine.mjs';
import { scaffoldHome, runLedgerPath, archivedRunLedgerPath } from '../src/daemon/home.mjs';
import { readEvents } from '../src/ledger/ledger.mjs';
import { LOUD_EVENTS, RUN_EVENTS, INSTANCE_EVENTS } from '../src/ledger/registry.mjs';
import {
  LOUD_OWNERSHIP,
  OWNER_EVENTS,
  ownedResolutions,
} from '../src/ledger/resolution.mjs';
import { openLoud } from '../src/telemetry/readers.mjs';
import { tempDir, removeDir, waitFor } from './helpers.mjs';

let seq = 0;
const line = (event, fields = {}) => ({ seq: ++seq, ts: '2026-08-15T00:00:00.000Z', event, ...fields });

// -- the table ----------------------------------------------------------------

test('every loud event names who owns it', () => {
  for (const event of LOUD_EVENTS) {
    const rules = LOUD_OWNERSHIP[event];
    assert.ok(Array.isArray(rules) && rules.length > 0, `no ownership entry for ${event}`);
    for (const rule of rules) {
      assert.ok(typeof rule.name === 'string' && rule.name.length > 0);
      // Either a ledger event owns the record, or the entry says in prose who
      // else settles it. A class that says neither is a record nobody clears.
      assert.ok(rule.owner || rule.by, `${event}/${rule.name} names no owner`);
    }
  }
});

test('an owning event is an event some ledger can actually stamp', () => {
  for (const owner of OWNER_EVENTS) {
    assert.ok(RUN_EVENTS.has(owner) || INSTANCE_EVENTS.has(owner), `unknown owner: ${owner}`);
  }
  assert.deepEqual(
    [...OWNER_EVENTS].sort(),
    ['implementation-committed', 'merged', 're-freeze', 'run-archived', 'verdict-rendered'],
  );
});

test('the table covers no event that is not loud', () => {
  for (const event of Object.keys(LOUD_OWNERSHIP)) assert.ok(LOUD_EVENTS.has(event));
});

// -- what a ledger's own events owe -------------------------------------------

test('a re-freeze owns the take-back it re-takes', () => {
  const takeBack = line('diff-policy-violation', { violations: [], dropped: ['tests/a.test.mjs'] });
  const events = [takeBack, line('re-freeze', { sha: 'abc' })];
  assert.deepEqual(ownedResolutions(events), [
    { resolves: takeBack.seq, owner: 're-freeze' },
  ]);
});

test('a take-back with no re-freeze behind it owes nothing yet', () => {
  const events = [
    line('diff-policy-violation', { violations: [], dropped: ['tests/a.test.mjs'] }),
    line('implementation-committed', { sha: 'abc' }),
    line('verdict-rendered', { verdict: 'green', open: [] }),
  ];
  // The commit and the verdict answer other classes; neither speaks to a
  // write the freeze took back. That one waits for the re-freeze, or the close.
  assert.deepEqual(ownedResolutions(events), []);
});

test('the capture that got through owns the refusal that blocked one', () => {
  const refusal = line('diff-policy-violation', {
    violations: [{ path: '.npmrc', rule: 'denied' }],
    dropped: [],
  });
  const events = [refusal, line('implementation-committed', { sha: 'abc' })];
  assert.deepEqual(ownedResolutions(events), [
    { resolves: refusal.seq, owner: 'implementation-committed' },
  ]);
});

test('an owner has to land behind the record, not in front of it', () => {
  const events = [
    line('implementation-committed', { sha: 'old' }),
    line('diff-policy-violation', { violations: [{ path: '.npmrc' }], dropped: [] }),
  ];
  assert.deepEqual(ownedResolutions(events), []);
});

test('the merge owns the alert that said it would not fire', () => {
  const alert = line('gate-integrity', { kind: 'auto-merge', pr: 7, sha: 'abc' });
  const events = [alert, line('merged', { pr: 7, sha: 'abc' })];
  assert.deepEqual(ownedResolutions(events), [{ resolves: alert.seq, owner: 'merged' }]);
});

test('a harness finding is owned by the first verdict that drops it', () => {
  const alert = line('gate-integrity', { findingId: 'F1' });
  const events = [
    alert,
    line('verdict-rendered', { cycle: 1, verdict: 'red', open: ['F1'] }),
    line('verdict-rendered', { cycle: 2, verdict: 'green', open: [] }),
  ];
  assert.deepEqual(ownedResolutions(events), [
    { resolves: alert.seq, owner: 'verdict-rendered', findingId: 'F1' },
  ]);
  // Still open while the finding is still open.
  assert.deepEqual(ownedResolutions(events.slice(0, 2)), []);
});

test('a record that is already resolved is not resolved twice', () => {
  const takeBack = line('diff-policy-violation', { violations: [], dropped: ['tests/a.test.mjs'] });
  const events = [
    takeBack,
    line('re-freeze', { sha: 'abc' }),
    line('resolved', { resolves: takeBack.seq, resolvedEvent: 'diff-policy-violation' }),
  ];
  assert.deepEqual(ownedResolutions(events), []);
});

test('a breach the run cannot answer is owed to nobody in its own ledger', () => {
  const events = [
    line('budget-breach', { threshold: 100, cost: 120 }),
    line('liveness-violation', { stage: 'verdict' }),
    line('implementation-committed', { sha: 'abc' }),
    line('re-freeze', { sha: 'def' }),
    line('verdict-rendered', { verdict: 'green', open: [] }),
    line('merged', { pr: 7 }),
  ];
  assert.deepEqual(ownedResolutions(events), []);
});

// -- the engine sweep ---------------------------------------------------------

function setup(t) {
  const dir = tempDir();
  const paths = scaffoldHome(dir);
  const engine = new RunEngine(paths, { getSlotCap: () => 3 });
  t.after(async () => {
    await engine.stop();
    removeDir(dir);
  });
  return { paths, engine };
}

/** A lane whose one stage stamps a script of events, then closes. */
function scriptedLane(engine, script) {
  engine.registerLane('story', {
    stages: ['work'],
    handlers: {
      work: (ctx) => {
        for (const [event, fields] of script) ctx.store.append(event, { actor: 'daemon', ...fields });
        return { close: { state: 'shipped' } };
      },
    },
  });
}

async function runScript(t, script) {
  const { paths, engine } = setup(t);
  scriptedLane(engine, script);
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(
    () => readEvents(archivedRunLedgerPath(paths, 'r1')).some((e) => e.event === 'run-closed'),
    { label: 'run closed' },
  );
  return { paths, events: readEvents(archivedRunLedgerPath(paths, 'r1')) };
}

const TAKE_BACK = [
  'diff-policy-violation',
  { violations: [], dropped: ['tests/a.test.mjs'], gist: 'a take-back' },
];

test('the sweep pairs the resolution while the run is still open', async (t) => {
  const { paths, engine } = setup(t);
  const closing = { open: null };
  const held = new Promise((resolve) => {
    closing.open = resolve;
  });
  engine.registerLane('story', {
    stages: ['work'],
    handlers: {
      work: async (ctx) => {
        ctx.store.append('diff-policy-violation', { actor: 'daemon', ...TAKE_BACK[1] });
        ctx.store.append('re-freeze', { actor: 'daemon', sha: 'abc', files: [], findings: [] });
        await held;
        return { close: { state: 'shipped' } };
      },
    },
  });
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(
    () => readEvents(runLedgerPath(paths, 'r1')).some((e) => e.event === 'resolved'),
    { label: 'resolved' },
  );
  const events = readEvents(runLedgerPath(paths, 'r1'));
  const stamp = events.find((e) => e.event === 'diff-policy-violation');
  const resolution = events.find((e) => e.event === 'resolved');
  assert.equal(resolution.resolves, stamp.seq);
  assert.equal(resolution.resolvedEvent, 'diff-policy-violation');
  assert.equal(resolution.owner, 're-freeze');
  // The whole point: the strip is clear before the run is over.
  assert.ok(!events.some((e) => e.event === 'run-closed'));
  assert.equal(openLoud(paths).length, 0);
  closing.open();
  await waitFor(
    () => readEvents(archivedRunLedgerPath(paths, 'r1')).some((e) => e.event === 'run-closed'),
    { label: 'run closed' },
  );
  // The close-out sweep finds nothing left to pair; no second resolution.
  const closed = readEvents(archivedRunLedgerPath(paths, 'r1'));
  assert.equal(closed.filter((e) => e.event === 'resolved').length, 1);
});

test('the close-out sweep is still the backstop when no owner lands', async (t) => {
  const { paths, events } = await runScript(t, [TAKE_BACK]);
  const stamp = events.find((e) => e.event === 'diff-policy-violation');
  const resolution = events.find((e) => e.event === 'resolved');
  assert.equal(resolution.resolves, stamp.seq);
  assert.equal(resolution.note, 'run closed shipped');
  assert.equal(resolution.owner, undefined);
  assert.ok(events.indexOf(resolution) < events.findIndex((e) => e.event === 'run-closed'));
  assert.equal(openLoud(paths).length, 0);
});

test('a refusal and a take-back in one run resolve at their own owners', async (t) => {
  const { paths, events } = await runScript(t, [
    ['diff-policy-violation', { violations: [{ path: '.npmrc' }], dropped: [], gist: 'refused' }],
    TAKE_BACK,
    ['implementation-committed', { pass: 1, phase: 'initial', sha: 'abc' }],
    ['re-freeze', { sha: 'def', files: [], findings: [] }],
  ]);
  const [refusal, takeBack] = events.filter((e) => e.event === 'diff-policy-violation');
  const resolutions = events.filter((e) => e.event === 'resolved');
  assert.equal(resolutions.length, 2);
  assert.deepEqual(
    resolutions.map((e) => [e.resolves, e.owner]),
    [
      [refusal.seq, 'implementation-committed'],
      [takeBack.seq, 're-freeze'],
    ],
  );
  assert.equal(openLoud(paths).length, 0);
});

test('a liveness violation is nobody else\'s to clear', async (t) => {
  const { paths, engine } = setup(t);
  engine.registerLane('story', {
    stages: ['work'],
    handlers: {
      work: (ctx) => {
        ctx.store.append('liveness-violation', { actor: 'daemon', stage: 'work', gist: 'stalled' });
        ctx.store.append('re-freeze', { actor: 'daemon', sha: 'abc', files: [], findings: [] });
        ctx.store.append('merged', { actor: 'daemon', pr: 7, sha: 'abc', red: false });
        return { close: { state: 'shipped' } };
      },
    },
  });
  engine.launch({ runId: 'r1', project: 'proj', lane: 'story' });
  await waitFor(
    () => readEvents(archivedRunLedgerPath(paths, 'r1')).some((e) => e.event === 'run-closed'),
    { label: 'run closed' },
  );
  const events = readEvents(archivedRunLedgerPath(paths, 'r1'));
  assert.equal(events.filter((e) => e.event === 'resolved').length, 0);
  assert.equal(openLoud(paths).length, 1);
  assert.equal(openLoud(paths)[0].event, 'liveness-violation');
});
