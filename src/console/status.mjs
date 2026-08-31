// Console renderers: plain-text views over the stores, loud first, then the
// queue. Pull-only — a console holds no daemon state and never blocks it.
// Every render answers from the files alone; olympusctl prints these.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readEvents, tailEvents } from '../ledger/ledger.mjs';
import { runCost } from '../ledger/cost.mjs';
import { deriveRunState } from '../engine/replay.mjs';
import { runLedgerPath } from '../daemon/home.mjs';
import { readLock, pidAlive } from '../daemon/lock.mjs';
import { withDefaults } from '../config/instance.mjs';
import { standingAckList } from '../ledger/acks.mjs';
import { holdState, projectHeld } from '../daemon/hold.mjs';
import { openLoud } from '../telemetry/readers.mjs';
import { escalationQueue } from '../telemetry/queue.mjs';

/**
 * Reads the instance config for display without scaffolding a missing file —
 * a console read never writes the daemon home.
 */
export function readInstanceConfig(paths) {
  if (!existsSync(paths.instanceConfig)) return null;
  try {
    return withDefaults(JSON.parse(readFileSync(paths.instanceConfig, 'utf8')));
  } catch {
    return null;
  }
}

/** Arming per project, replayed from the instance ledger. */
export function armingState(paths) {
  const armed = new Map();
  for (const e of readEvents(paths.instanceLedger)) {
    if (e.event === 'arming-changed') armed.set(e.project, e.armed === true);
  }
  return armed;
}

/**
 * What the running instance's start-time check found in the seat environment.
 * Only this instance's findings: a defect the operator fixed is gone from the
 * next start's, and the ones behind an older start describe a host that no
 * longer runs the seats (ADR-0030).
 */
export function seatEnvironment(paths) {
  const events = readEvents(paths.instanceLedger);
  let start = -1;
  events.forEach((e, i) => {
    if (e.event === 'daemon-started') start = i;
  });
  if (start === -1) return [];
  return events.slice(start).filter((e) => e.event === 'seat-environment');
}

/** Open runs with their replayed state, from the run ledgers alone. */
export function openRuns(paths) {
  const runs = [];
  let entries;
  try {
    entries = readdirSync(paths.runs, { withFileTypes: true });
  } catch {
    return runs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const events = readEvents(runLedgerPath(paths, entry.name));
    if (events.length === 0) continue;
    const state = deriveRunState(events);
    if (state.closed) continue;
    runs.push({
      runId: entry.name,
      ...state,
      cost: runCost(events),
      carryShare: lastCarryShare(events),
    });
  }
  return runs;
}

/**
 * The carried share of the run's last rendered verdict, or null before one.
 * It is what the cycles of this run are buying: a run whose share has fallen
 * to nothing is re-running every part of every layer, which costs hours and
 * turns nothing red (ADR-0058).
 */
function lastCarryShare(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'verdict-rendered' && typeof e.carryShare === 'number') return e.carryShare;
  }
  return null;
}

/** The status page: chips, loud strip, queue, runs, projects. */
export function renderStatus(paths) {
  const lock = readLock(paths.lock);
  const running = lock !== null && pidAlive(lock.pid);
  const loud = openLoud(paths);
  const queue = escalationQueue(paths);
  const runs = openRuns(paths);
  const active = runs.filter((r) => !r.parked && !r.held && !r.violated).length;
  const parked = runs.filter((r) => r.parked).length;
  // Held runs are counted apart from active ones because they are the two
  // different answers to "is the factory working": a held run holds its slot
  // and does nothing, and an operator reading a busy-looking header while a
  // hold stands is reading the wrong number (ADR-0040).
  const held = runs.filter((r) => r.held).length;
  const lines = [];
  lines.push(
    `daemon ${running ? `running (pid ${lock.pid})` : 'stopped'}` +
      ` · runs ${active} active / ${parked} parked / ${held} held` +
      ` · loud ${loud.length} · queue ${queue.length}`,
  );
  lines.push('');
  lines.push(`LOUD (${loud.length} open)`);
  for (const item of loud) {
    lines.push(`  ${item.ledger}#${item.seq} ${item.ts} ${item.event} — ${item.gist}`);
  }
  if (loud.length === 0) lines.push('  none');
  lines.push('');
  lines.push(`QUEUE (${queue.length} waiting)`);
  for (const item of queue) {
    lines.push(`  ${item.ledger}#${item.seq} ${item.ts} ${item.type ?? item.event} — ${item.gist}`);
  }
  if (queue.length === 0) lines.push('  empty');
  lines.push('');
  lines.push(`RUNS (${runs.length} open)`);
  for (const run of runs) {
    const flags = [
      ...(run.parked ? [`parked:${run.parkRecord?.type}`] : []),
      // The stage the run did not enter, because that is what a release will
      // start and what the operator is deciding about. A hold taken over this
      // run alone also names who took it and when, standing or still settling:
      // a per-run hold is the one an operator can forget, and a forgotten hold
      // has to be visible rather than silent (ADR-0057). A project hold reads
      // on the project line, so nothing repeats it here.
      ...(run.held ? [`held:${run.deferred}${heldBy(run)}`] : []),
      ...(!run.held && run.ownHold ? [`holding${heldBy(run)}`] : []),
      ...(run.violated ? ['violated'] : []),
    ];
    const budget = run.payload?.budget;
    const spend = `$${run.cost.toFixed(2)}${typeof budget === 'number' ? ` of $${budget.toFixed(2)}` : ''}`;
    // The carry, on the one stage that spends it. A run in verdict is a run
    // paying for gate layers by the hour, and this is the share of that work
    // its last cycle did not have to do (ADR-0058).
    const carry =
      run.stage === 'verdict' && typeof run.carryShare === 'number'
        ? ` · carry ${Math.round(run.carryShare * 100)}%`
        : '';
    lines.push(
      `  ${run.runId} ${run.lane} @ ${run.stage} · ${spend}${carry}` +
        `${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`,
    );
  }
  if (runs.length === 0) lines.push('  none');
  const config = readInstanceConfig(paths);
  if (config) {
    const armed = armingState(paths);
    // A hold with no run under it yet is still the reason the next boundary
    // will not be crossed, so the project line carries it whether or not any
    // run is standing on one.
    const holds = holdState(readEvents(paths.instanceLedger));
    lines.push('');
    lines.push('PROJECTS');
    for (const [name, project] of Object.entries(config.projects)) {
      lines.push(
        `  ${name}: ${armed.get(name) === true ? 'armed' : 'paused'}` +
          `${projectHeld(holds, name) ? ', held' : ''}, slot cap ${project.slotCap}`,
      );
    }
  }
  // Every harness defect the factory is currently allowed to walk past. It
  // belongs on the status page and not only in a park that has been answered:
  // an ack outlives the run that recorded it and every restart after, and the
  // only thing that ends one is an operator reading this line (ADR-0032).
  const acks = standingAckList(readEvents(paths.instanceLedger));
  if (acks.length > 0) {
    lines.push('');
    lines.push(`STANDING ACKS (${acks.length})`);
    for (const ack of acks) {
      lines.push(`  ${ack.project} ${ack.fingerprint} — ${ack.summary} (${ack.actor}, ${ack.ts})`);
    }
    lines.push('  revoke: olympusctl revoke --project <p> --fingerprint <f> --fix <ref>');
  }
  const environment = seatEnvironment(paths);
  if (environment.length > 0) {
    lines.push('');
    lines.push(`SEAT ENVIRONMENT (${environment.length} at this start)`);
    for (const finding of environment) {
      lines.push(`  ${finding.severity} · ${finding.check} — ${finding.gist}`);
    }
  }
  const changed = tailEvents(paths.instanceLedger, 200)
    .filter((e) => e.event === 'config-changed')
    .at(-1);
  if (changed) {
    lines.push('');
    lines.push(
      `last config edit: ${changed.accepted ? `accepted (${(changed.changedKeys ?? []).join(', ')})` : `rejected — ${changed.error}`}`,
    );
  }
  return lines.join('\n');
}

/** Who took this run's own hold and when, or nothing when no hold is its own. */
function heldBy(run) {
  return run.ownHold ? ` by ${run.ownHold.actor} at ${run.ownHold.ts}` : '';
}

/** The full queue, one answerable record per item. */
export function renderQueue(paths, { roadmap } = {}) {
  const queue = escalationQueue(paths, { roadmap });
  if (queue.length === 0) return 'queue empty';
  const lines = [];
  queue.forEach((item, i) => {
    if (i > 0) lines.push('');
    const target = item.runId ? `--run ${item.runId}` : `--seq ${item.seq}`;
    lines.push(`[${i + 1}] ${item.type ?? item.event} · ${item.ledger}#${item.seq} · ${item.ts}`);
    if (item.storyKey) lines.push(`    story: ${item.storyKey}`);
    if (item.card) lines.push(`    card: ${item.card}`);
    if (item.question) {
      for (const line of item.question.split('\n')) lines.push(`    ${line}`);
    } else {
      lines.push(`    ${item.gist}`);
    }
    if (item.refs) lines.push(`    refs: ${JSON.stringify(item.refs)}`);
    for (const ack of item.acks ?? []) {
      lines.push(`    ack ${ack.fingerprint} — ${ack.summary}`);
    }
    // The check an `ack` answer at this gate acknowledges, named before the
    // operator writes the reason it takes (ADR-0062).
    if (item.gate) lines.push(`    gate: ${item.gate}`);
    if (item.answers) {
      // Straight off the record: the forms the park declared are the forms the
      // engine will take, so the line an operator reads is the line that works.
      const ways = [];
      if (item.answers.options?.length > 0) {
        lines.push(`    options: ${item.answers.options.join(' | ')}`);
        ways.push('--option <option>');
      }
      if (item.answers.text) {
        lines.push(`    text: ${item.answers.text}`);
        ways.push('--text "<answer>"');
      }
      // An option the record says takes the text as well. Refused without it,
      // so the line an operator reads has to say so before they try.
      if (item.answers.reasoned?.length > 0) {
        lines.push(`    ${item.answers.reasoned.join(' | ')}: takes --option and --text together`);
      }
      lines.push(`    answer: olympusctl answer ${target} ${ways.join(' | ')}`);
    } else {
      lines.push(`    resolve: olympusctl resolve ${item.runId ? `${target} ` : ''}--seq ${item.seq}`);
    }
  });
  return lines.join('\n');
}

/** A computed frontier, one card per line in roadmap order. */
export function renderFrontier(project, frontier) {
  const lines = [`${project}: ${frontier.launchable.length} launchable, ${frontier.unfinished} unfinished`];
  for (const card of frontier.cards) {
    const blockers = card.blockedBy.length > 0 ? ` ← ${card.blockedBy.join(', ')}` : '';
    lines.push(`  ${card.state.padEnd(10)} ${card.key ?? card.path} (${card.phase ?? '?'})${blockers}`);
  }
  for (const defect of frontier.defects) {
    lines.push(`  defect: ${defect.key ?? defect.path} — ${defect.message}`);
  }
  return lines.join('\n');
}
