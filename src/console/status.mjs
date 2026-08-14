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
    runs.push({ runId: entry.name, ...state, cost: runCost(events) });
  }
  return runs;
}

/** The status page: chips, loud strip, queue, runs, projects. */
export function renderStatus(paths) {
  const lock = readLock(paths.lock);
  const running = lock !== null && pidAlive(lock.pid);
  const loud = openLoud(paths);
  const queue = escalationQueue(paths);
  const runs = openRuns(paths);
  const active = runs.filter((r) => !r.parked && !r.violated).length;
  const parked = runs.filter((r) => r.parked).length;
  const lines = [];
  lines.push(
    `daemon ${running ? `running (pid ${lock.pid})` : 'stopped'}` +
      ` · runs ${active} active / ${parked} parked` +
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
      ...(run.violated ? ['violated'] : []),
    ];
    const budget = run.payload?.budget;
    const spend = `$${run.cost.toFixed(2)}${typeof budget === 'number' ? ` of $${budget.toFixed(2)}` : ''}`;
    lines.push(
      `  ${run.runId} ${run.lane} @ ${run.stage} · ${spend}` +
        `${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`,
    );
  }
  if (runs.length === 0) lines.push('  none');
  const config = readInstanceConfig(paths);
  if (config) {
    const armed = armingState(paths);
    lines.push('');
    lines.push('PROJECTS');
    for (const [name, project] of Object.entries(config.projects)) {
      lines.push(
        `  ${name}: ${armed.get(name) === true ? 'armed' : 'paused'}, slot cap ${project.slotCap}`,
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
    if (item.options) {
      lines.push(`    options: ${item.options.join(' | ')}`);
      lines.push(`    answer: olympusctl answer ${target} --option <option>`);
    } else if (item.event === 'park') {
      lines.push(`    answer: olympusctl answer ${target} --text "<answer>"`);
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
