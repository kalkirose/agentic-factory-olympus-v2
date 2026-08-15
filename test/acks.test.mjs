// Finding acknowledgments (ADR-0032): the fingerprint that gives a harness
// finding an identity past the run that raised it, the fold that derives the
// standing set from the instance ledger, and the control machinery that
// records and revokes one. The lane end of it — the gate that offers `ack` and
// the repeat that answers itself — is in the verdict suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Daemon } from '../src/daemon/daemon.mjs';
import { homePaths, scaffoldHome } from '../src/daemon/home.mjs';
import { writeControlCommand } from '../src/daemon/control.mjs';
import { readEvents, Ledger } from '../src/ledger/ledger.mjs';
import { INSTANCE_EVENTS } from '../src/ledger/registry.mjs';
import {
  coveringAck,
  findingFingerprint,
  isAckable,
  standingAckList,
  standingAcks,
  standingAcksFor,
} from '../src/ledger/acks.mjs';
import { renderStatus } from '../src/console/status.mjs';
import { tempDir, removeDir } from './helpers.mjs';

const DEFECT = {
  class: 'harness',
  summary: 'The triage seat captures none of the layer log',
  evidence: 'reports/verdict-triage-c2.json holds an empty output field',
};

function instanceEvents(paths) {
  return readEvents(paths.instanceLedger);
}

function appendInstance(paths, event, fields) {
  const ledger = new Ledger(paths.instanceLedger, { allowedEvents: INSTANCE_EVENTS });
  const line = ledger.append(event, fields);
  ledger.close();
  return line;
}

// -- the fingerprint ---------------------------------------------------------

test('the fingerprint is what the finding says, not the run that raised it', () => {
  const first = findingFingerprint({
    ...DEFECT,
    evidence: 'C:\\home\\runs\\r-1a2b\\reports\\verdict-triage-c2.json holds an empty output field',
  });
  const second = findingFingerprint({
    ...DEFECT,
    evidence: '/srv/olympus/runs/r-99zz/reports/verdict-triage-c7.json holds an empty output field',
  });
  // Another host, another run, another cycle, another path separator: the
  // defect is the same defect, and the operator answered for it already.
  assert.equal(first, second);
  assert.match(first, /^harness:[0-9a-f]{12}$/);
});

test('the class and the words are both part of the identity', () => {
  const harness = findingFingerprint(DEFECT);
  assert.notEqual(harness, findingFingerprint({ ...DEFECT, class: 'env' }));
  assert.notEqual(
    harness,
    findingFingerprint({ ...DEFECT, summary: 'The triage seat captures half the layer log' }),
  );
  assert.notEqual(
    harness,
    findingFingerprint({ ...DEFECT, evidence: 'the layer output reached the record whole' }),
  );
});

test('an ack covers a harness finding and nothing else', () => {
  assert.equal(isAckable(DEFECT), true);
  for (const cls of ['env', 'code-defect', 'suite-defect', undefined]) {
    const finding = { ...DEFECT, class: cls };
    assert.equal(isAckable(finding), false, `${cls} is not ackable`);
    // Even with an acknowledgment recorded at the finding's own fingerprint,
    // the class rule refuses the coverage: the substrate and the product are
    // never answered by a standing answer.
    const standing = new Map([[findingFingerprint(finding), { seq: 1, actor: 'operator' }]]);
    assert.equal(coveringAck(standing, finding), null);
  }
  const standing = new Map([[findingFingerprint(DEFECT), { seq: 1, actor: 'operator' }]]);
  assert.equal(coveringAck(standing, DEFECT).seq, 1);
});

// -- the standing set --------------------------------------------------------

test('the standing set is folded from ack and revoke pairs, project by project', () => {
  const events = [
    { event: 'finding-ack', seq: 1, project: 'alpha', fingerprint: 'harness:a' },
    { event: 'finding-ack', seq: 2, project: 'alpha', fingerprint: 'harness:b' },
    { event: 'finding-ack', seq: 3, project: 'beta', fingerprint: 'harness:a' },
    { event: 'finding-ack-revoked', seq: 4, project: 'alpha', fingerprint: 'harness:a' },
  ];
  // The revoke ends the one fingerprint it names, in the one project it names.
  assert.deepEqual([...standingAcks(events, 'alpha').keys()], ['harness:b']);
  assert.deepEqual([...standingAcks(events, 'beta').keys()], ['harness:a']);
  assert.deepEqual([...standingAcks(events, 'gamma').keys()], []);
  assert.equal(standingAckList(events).length, 2);
  // Re-recording an acknowledgment after its revoke stands again, and the
  // fold is the same however often it is read.
  const again = [...events, { event: 'finding-ack', seq: 5, project: 'alpha', fingerprint: 'harness:a' }];
  assert.deepEqual([...standingAcks(again, 'alpha').keys()].sort(), ['harness:a', 'harness:b']);
});

// -- the control machinery ---------------------------------------------------

async function daemonOn(t) {
  const home = tempDir();
  const paths = scaffoldHome(home);
  const daemon = new Daemon(home);
  t.after(async () => {
    await daemon.stop();
    removeDir(home);
  });
  await daemon.start();
  return { home, paths, daemon };
}

/** The reason files the daemon left for refused commands. */
function rejections(paths) {
  return readdirSync(paths.controlRejected)
    .filter((f) => f.endsWith('.reason.txt'))
    .map((f) => readFileSync(join(paths.controlRejected, f), 'utf8').trim());
}

/** A parked run as the engine holds one, without a lane behind it. */
function parkedRun(parkRecord) {
  return { project: 'proj', parked: true, parkRecord, seats: new Set(), store: { close() {} } };
}

test('an ack answer records what the park record names, and nothing it does not', async (t) => {
  const { paths, daemon } = await daemonOn(t);
  const acks = [{ fingerprint: 'harness:abc123abc123', class: 'harness', summary: 'a known defect' }];
  // A park that never offered the option records nothing: the engine refuses
  // the answer, and no acknowledgment is written on the way to that refusal.
  daemon.engine.runs.set(
    'r-quiet',
    parkedRun({ seq: 4, answers: { options: ['retry', 'abandon'] }, acks }),
  );
  daemon.recordAcks({ runId: 'r-quiet', actor: 'operator', option: 'ack' });
  assert.equal(instanceEvents(paths).filter((e) => e.event === 'finding-ack').length, 0);

  daemon.engine.runs.set(
    'r-gate',
    parkedRun({ seq: 9, answers: { options: ['retry', 'ack', 'abandon'] }, acks }),
  );
  // A retry at the same park is still a retry.
  daemon.recordAcks({ runId: 'r-gate', actor: 'operator', option: 'retry' });
  assert.equal(instanceEvents(paths).filter((e) => e.event === 'finding-ack').length, 0);
  daemon.recordAcks({ runId: 'r-gate', actor: 'operator', option: 'ack' });
  const ack = instanceEvents(paths).find((e) => e.event === 'finding-ack');
  assert.equal(ack.project, 'proj');
  assert.equal(ack.fingerprint, 'harness:abc123abc123');
  assert.equal(ack.class, 'harness');
  assert.equal(ack.runId, 'r-gate');
  assert.equal(ack.parkSeq, 9);
});

test('a revoke names one fingerprint, carries its fix, and refuses the rest', async (t) => {
  const { paths, daemon } = await daemonOn(t);
  appendInstance(paths, 'finding-ack', {
    actor: 'operator',
    project: 'proj',
    fingerprint: 'harness:aaa',
    class: 'harness',
    summary: 'the triage capture',
  });
  const base = { actor: 'operator', project: 'proj', fingerprint: 'harness:aaa', fix: 'harness abc1234' };
  assert.throws(() => daemon.revokeAck({ ...base, actor: '' }), /requires an actor/);
  assert.throws(() => daemon.revokeAck({ ...base, project: undefined }), /requires the project/);
  assert.throws(() => daemon.revokeAck({ ...base, fingerprint: undefined }), /names the one fingerprint/);
  assert.throws(() => daemon.revokeAck({ ...base, fix: undefined }), /carries the fix it stands on/);
  // A fingerprint nobody acknowledged is a typo, and the refusal says what
  // does stand so the next attempt is one read away.
  assert.throws(
    () => daemon.revokeAck({ ...base, fingerprint: 'harness:zzz' }),
    /no acknowledgment stands for harness:zzz in proj — standing: harness:aaa/,
  );
  assert.equal(instanceEvents(paths).some((e) => e.event === 'finding-ack-revoked'), false);
});

test('a revoke through the control inbox stamps the instance ledger', async (t) => {
  const { paths, daemon } = await daemonOn(t);
  const recorded = appendInstance(paths, 'finding-ack', {
    actor: 'operator',
    project: 'proj',
    fingerprint: 'harness:aaa',
    class: 'harness',
    summary: 'the triage capture',
  });
  writeControlCommand(paths, {
    command: 'revoke',
    actor: 'console:test',
    project: 'proj',
    fingerprint: 'harness:aaa',
    fix: 'harness abc1234: the capture armed',
  });
  await daemon.drainControlInbox();
  const revoked = instanceEvents(paths).find((e) => e.event === 'finding-ack-revoked');
  assert.equal(revoked.actor, 'console:test');
  assert.equal(revoked.fingerprint, 'harness:aaa');
  assert.equal(revoked.fix, 'harness abc1234: the capture armed');
  assert.equal(revoked.ackSeq, recorded.seq);
  assert.equal(standingAcksFor(paths, 'proj').size, 0);

  writeControlCommand(paths, {
    command: 'revoke',
    actor: 'console:test',
    project: 'proj',
    fingerprint: 'harness:aaa',
    fix: 'the same fix again',
  });
  await daemon.drainControlInbox();
  assert.ok(rejections(paths).some((r) => /no acknowledgment stands for harness:aaa/.test(r)));
});

test('an acknowledgment survives a restart: nothing about a defect changed', async (t) => {
  const home = tempDir();
  const paths = scaffoldHome(home);
  t.after(() => removeDir(home));
  const first = new Daemon(home);
  await first.start();
  first.ledger.append('finding-ack', {
    actor: 'operator',
    project: 'proj',
    fingerprint: 'harness:aaa',
    class: 'harness',
    summary: 'the triage capture',
  });
  first.ledger.append('finding-ack', {
    actor: 'operator',
    project: 'proj',
    fingerprint: 'harness:bbb',
    class: 'harness',
    summary: 'the other one',
  });
  first.revokeAck({
    actor: 'operator',
    project: 'proj',
    fingerprint: 'harness:bbb',
    fix: 'harness abc1234',
  });
  await first.stop();

  const second = new Daemon(home);
  t.after(async () => second.stop());
  await second.start();
  // A restart proves nothing about an unsolved harness defect, so it clears
  // nothing — and it revives nothing a revoke ended either.
  assert.deepEqual([...standingAcksFor(homePaths(home), 'proj').keys()], ['harness:aaa']);
  assert.equal(
    instanceEvents(paths).filter((e) => e.event === 'finding-ack-revoked').length,
    1,
  );
});

// -- the console read --------------------------------------------------------

test('status lists every standing acknowledgment and the way to end one', async (t) => {
  const home = tempDir();
  const paths = scaffoldHome(home);
  t.after(() => removeDir(home));
  writeFileSync(paths.instanceConfig, JSON.stringify({ version: 1, projects: {} }) + '\n');
  appendInstance(paths, 'finding-ack', {
    actor: 'operator',
    project: 'proj',
    fingerprint: 'harness:aaa',
    class: 'harness',
    summary: 'the triage seat captures none of the layer log',
  });
  appendInstance(paths, 'finding-ack', {
    actor: 'operator',
    project: 'proj',
    fingerprint: 'harness:bbb',
    class: 'harness',
    summary: 'the other one',
  });
  appendInstance(paths, 'finding-ack-revoked', {
    actor: 'operator',
    project: 'proj',
    fingerprint: 'harness:bbb',
    fix: 'harness abc1234',
  });
  const status = renderStatus(paths);
  assert.match(status, /STANDING ACKS \(1\)/);
  assert.match(status, /proj harness:aaa — the triage seat captures none of the layer log \(operator/);
  assert.ok(!status.includes('harness:bbb'));
  assert.match(status, /olympusctl revoke --project <p> --fingerprint <f> --fix <ref>/);
});
