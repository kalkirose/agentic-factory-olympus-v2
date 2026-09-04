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
import { TRIPWIRE_METRICS } from '../tripwires/registry.mjs';
import {
  allowlistFindingsReading,
  gateRoundsReading,
  parksReading,
  projectRuns,
  waitsReading,
} from '../tripwires/metrics.mjs';

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

/**
 * The credential store this instance reads, and what the running instance found
 * in it: per project, how many declared variables came from the store, how many
 * fell back to the copy the daemon inherited, and how many nothing holds.
 *
 * A count above zero under `inherited` is the condition the store exists to
 * end: the daemon is working from a copy the machine can no longer confirm, and
 * it is readable here before any story tries the door (ADR-0064). Null for a
 * home that declares no store, which prints the status page it always printed.
 */
export function credentialStoreState(paths) {
  const store = readInstanceConfig(paths)?.credentialStore;
  if (!store) return null;
  const events = readEvents(paths.instanceLedger);
  let start = -1;
  events.forEach((e, i) => {
    if (e.event === 'daemon-started') start = i;
  });
  // This instance's reads alone. A count behind an older start describes a host
  // that no longer runs the probes.
  const held = new Map();
  for (const e of start === -1 ? [] : events.slice(start)) {
    if (e.event !== 'credential-fingerprints') continue;
    const counts = held.get(e.project) ?? { project: e.project, store: 0, inherited: 0, absent: 0 };
    for (const variable of e.variables ?? []) {
      if (counts[variable.source] !== undefined) counts[variable.source]++;
    }
    held.set(e.project, counts);
  }
  return { kind: store.kind, projects: [...held.values()] };
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
  const waiting = runs.filter((r) => r.waiting).length;
  const active = runs.filter((r) => !r.parked && !r.held && !r.violated && !r.waiting).length;
  const parked = runs.filter((r) => r.parked).length;
  // Held runs are counted apart from active ones because they are the two
  // different answers to "is the factory working": a held run holds its slot
  // and does nothing, and an operator reading a busy-looking header while a
  // hold stands is reading the wrong number (ADR-0040).
  const held = runs.filter((r) => r.held).length;
  const lines = [];
  // Waiting runs are counted apart from active ones for the reason held runs
  // are: a run sitting out a provider outage is not the factory working, and a
  // header that read it as active would report a busy factory that is idle
  // (ADR-0069).
  lines.push(
    `daemon ${running ? `running (pid ${lock.pid})` : 'stopped'}` +
      ` · runs ${active} active / ${parked} parked / ${held} held / ${waiting} waiting` +
      ` · loud ${loud.length} · queue ${queue.length}`,
  );
  const credentials = credentialStoreState(paths);
  if (credentials) {
    const read = credentials.projects.map(
      (p) => `${p.project} ${p.store} stored / ${p.inherited} inherited / ${p.absent} absent`,
    );
    lines.push(
      `credential store ${credentials.kind} · ` +
        (read.length > 0 ? read.join(' · ') : 'no project read at this start'),
    );
  }
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
    // What the run is waiting for and until when, on its own line under the
    // run. It is the whole of what an operator can do about a wait — read it,
    // and decide whether to let it run out or kill the run (ADR-0069).
    if (run.waiting) {
      lines.push(
        `    waiting: ${run.waiting.kind} ${run.waiting.reason} until ${run.waiting.until}` +
          `${run.waiting.attempt ? ` (attempt ${run.waiting.attempt})` : ''}`,
      );
    }
  }
  if (runs.length === 0) lines.push('  none');
  const config = readInstanceConfig(paths);
  const instanceEvents = readEvents(paths.instanceLedger);
  if (config) {
    const armed = armingState(paths);
    // A hold with no run under it yet is still the reason the next boundary
    // will not be crossed, so the project line carries it whether or not any
    // run is standing on one.
    const holds = holdState(instanceEvents);
    lines.push('');
    lines.push('PROJECTS');
    for (const [name, project] of Object.entries(config.projects)) {
      lines.push(
        `  ${name}: ${armed.get(name) === true ? 'armed' : 'paused'}` +
          `${projectHeld(holds, name) ? ', held' : ''}, slot cap ${project.slotCap}`,
      );
      // The four readings of what still stops a run and of what the harness
      // now answers for itself. They are on the status page rather than only
      // behind a breach, because a band is set from readings that were
      // watched first, and a reading nobody can see is a reading nobody sets a
      // band from (ADR-0010).
      const stops = stopReadings(paths, name, {
        instanceEvents,
        windows: armedWindows(instanceEvents, name),
      });
      if (stops) lines.push(`    ${stops}`);
    }
  }
  // Every harness defect the factory is currently allowed to walk past. It
  // belongs on the status page and not only in a park that has been answered:
  // an ack outlives the run that recorded it and every restart after, and the
  // only thing that ends one is an operator reading this line (ADR-0032).
  const acks = standingAckList(instanceEvents);
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
  // The launches the daemon refused, newest first. A refusal writes a reason
  // file that reaches only the console that asked, and a run that never
  // started is in no run ledger; this is where every other reader learns that
  // a slot was asked for and not given, and why (ADR-0067).
  const rejected = rejectedLaunches(paths);
  if (rejected.length > 0) {
    lines.push('');
    lines.push(`REJECTED (last ${rejected.length})`);
    for (const r of rejected) {
      const what = r.card ?? r.ticket;
      lines.push(
        `  #${r.seq} ${r.ts} ${r.project} ${r.lane}${what ? ` ${what}` : ''} ` +
          `(${r.requestedBy ?? 'unknown'}) — ${r.reason}`,
      );
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

/**
 * One project's four stop readings as a line, or null when the project has no
 * run to read yet.
 *
 * Every window is the project's own, read off the newest `tripwires-armed`
 * record, so the line and the band that judges it are measured over the same
 * stretch; a metric the project arms no entry for falls back to the registry
 * default. An ineligible reading prints an em-dash rather than a zero: the
 * difference between "no run parked" and "no run" is the whole of what a cold
 * window means.
 *
 * The run ledgers are walked once for all four. Each reading would otherwise
 * open every live and archived ledger of the project on its own, and a status
 * page is something a person waits for.
 */
function stopReadings(paths, project, { instanceEvents, windows }) {
  const runs = projectRuns(paths, project);
  const at = (metric) => windows.get(metric) ?? TRIPWIRE_METRICS[metric].defaultWindow;
  const parks = parksReading(paths, project, {
    window: at('parks-window'),
    runs,
    instanceEvents,
  });
  const rounds = gateRoundsReading(paths, project, { window: at('gate-rounds-window'), runs });
  const waits = waitsReading(paths, project, { window: at('waits-window'), runs });
  const allowlist = allowlistFindingsReading(paths, project, {
    window: at('allowlist-findings-window'),
    runs,
  });
  if (![parks, rounds, waits, allowlist].some((r) => r.eligible)) return null;
  const green =
    waits.eligible && waits.detail.greenShare !== undefined
      ? ` (${Math.round(waits.detail.greenShare * 100)}% green)`
      : '';
  return (
    `parks ${shown(parks)}/run · gate rounds ${shown(rounds)} · ` +
    `waits ${shown(waits)}/run${green} · allowlist findings ${shown(allowlist)}`
  );
}

/**
 * The window each metric is armed with on one project, from the newest
 * `tripwires-armed` record. An empty map is a project the daemon has not read
 * a registry for yet, and every reading then falls back to its default.
 */
function armedWindows(events, project) {
  let newest = null;
  for (const e of events) {
    if (e.event === 'tripwires-armed' && e.project === project) newest = e;
  }
  const windows = new Map();
  for (const entry of newest?.entries ?? []) {
    if (typeof entry.window === 'number') windows.set(entry.metric, entry.window);
  }
  return windows;
}

function shown(reading) {
  return reading.eligible ? reading.value : '—';
}

/** How many refused launches the status page carries. */
export const REJECTED_LAUNCHES_SHOWN = 5;

/**
 * The most recent refused launches on the instance ledger, newest first, at
 * most `REJECTED_LAUNCHES_SHOWN` of them. Read whole: a refusal can be far
 * behind a busy ledger's tail and is still the newest one there is.
 */
export function rejectedLaunches(paths) {
  return readEvents(paths.instanceLedger)
    .filter((e) => e.event === 'launch-rejected')
    .slice(-REJECTED_LAUNCHES_SHOWN)
    .reverse();
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
