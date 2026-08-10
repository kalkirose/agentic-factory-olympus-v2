// Frontier auto-launch: the daemon fills free slots from the launchable
// frontier in roadmap order, at any hour. The launcher is event-keyed —
// a sweep runs on daemon start, arming, run close, run park, an answer, a
// config change, and console commands; never on a timer. Sweeps serialize
// per project through a promise chain, so two triggers never race a launch.
//
// Arming is a per-project state machine: disarmed at birth, toggled by the
// `arm` and `pause` commands, every transition stamped `arming-changed`,
// replayed from the instance ledger at daemon start.
//
// Factory starvation — zero active runs while unfinished work exists and
// nothing is launchable — stamps loud, once per episode. The daemon resolves
// the stamp itself when activity returns (or on pause: a paused factory is
// idle by decision, not starved).
import { readEvents } from '../ledger/ledger.mjs';
import { storyRunsByKey } from '../telemetry/readers.mjs';
import { openCardParks } from '../telemetry/queue.mjs';
import { readGraphSource } from './source.mjs';
import { computeFrontier } from './graph.mjs';

const ACTOR = 'daemon';
const GIST_MAX = 120;

export class FrontierLauncher {
  /** @param {import('../daemon/daemon.mjs').Daemon} daemon */
  constructor(daemon) {
    this.daemon = daemon;
    this.armed = new Map();
    this.chains = new Map();
    this.pending = new Map();
  }

  /** Rebuilds the arming state from the instance ledger. Runs at start. */
  replayArming() {
    for (const e of readEvents(this.daemon.paths.instanceLedger)) {
      if (e.event === 'arming-changed') this.armed.set(e.project, e.armed === true);
    }
  }

  isArmed(project) {
    return this.armed.get(project) === true;
  }

  /** Applies an arm/pause command. Idempotent: only a transition stamps. */
  setArmed(project, armed, actor) {
    if (!this.daemon.config.projects[project]) throw new Error(`unknown project: ${project}`);
    if (typeof actor !== 'string' || actor.length === 0) {
      throw new Error('arming requires an actor');
    }
    if (this.isArmed(project) === armed) return;
    this.armed.set(project, armed);
    this.daemon.ledger.append('arming-changed', { actor, project, armed });
    if (armed) this.queueSweep(project);
    else this.clearStarvation(project);
  }

  /** Chains one sweep for the project; concurrent triggers coalesce in order. */
  queueSweep(project) {
    this.pending.set(project, (this.pending.get(project) ?? 0) + 1);
    const prev = this.chains.get(project) ?? Promise.resolve();
    const next = prev.then(() => this.sweep(project)).catch(() => {});
    this.chains.set(project, next);
    return next;
  }

  queueSweepAll() {
    for (const project of Object.keys(this.daemon.config.projects)) {
      if (this.isArmed(project)) this.queueSweep(project);
    }
  }

  /** Awaited by daemon stop so late stamps land before the ledger closes. */
  async drain() {
    await Promise.allSettled([...this.chains.values()]);
  }

  async sweep(project) {
    this.pending.set(project, this.pending.get(project) - 1);
    const d = this.daemon;
    if (!d.running || !this.isArmed(project)) return;
    const entry = d.config.projects[project];
    if (!entry || !d.engine.lanes.has('story')) return;
    let source;
    try {
      source = await d.isolation.withClone(project, () =>
        readGraphSource(d.paths, project, entry),
      );
    } catch (error) {
      this.settle(project, null, `the story graph is unreadable: ${error.message}`);
      return;
    }
    if (!source) return; // no graph section: manual launches only
    const frontier = computeFrontier({
      cards: source.cards,
      phases: source.config.graph.phases,
      runs: storyRunsByKey(d.paths),
      parkedCards: new Set(openCardParks(d.paths).map((p) => p.card).filter(Boolean)),
    });
    for (const card of frontier.launchable) {
      if (!d.running || !this.isArmed(project) || !d.engine.hasFreeSlot(project)) break;
      try {
        await d.launchRun({ project, lane: 'story', card: card.path, storyKey: card.key });
      } catch (error) {
        // One failed launch ends the sweep — the next trigger retries; a
        // tight retry loop would hammer a broken remote.
        this.settle(project, source, `launch of ${card.key} failed: ${error.message}`);
        return;
      }
    }
    this.settle(project, source);
  }

  /**
   * The post-sweep starvation check. Run history is re-read here — a card
   * that launched and closed during this very sweep counts as its ledger
   * says, not as the pre-sweep frontier snapshot said.
   */
  settle(project, source, failure = null) {
    const d = this.daemon;
    if (!d.running) return;
    // A queued successor sweep judges instead: an event that arrived during
    // this sweep (a run close, an answer) may launch the next card — a
    // starvation stamped now would be a false episode.
    if ((this.pending.get(project) ?? 0) > 0) return;
    if (d.engine.activeCount(project) > 0) {
      this.clearStarvation(project);
      return;
    }
    if (failure) {
      this.noteStarvation(project, failure);
      return;
    }
    const runs = storyRunsByKey(d.paths);
    const unfinished = source.cards.filter(
      (card) => !card.key || !(runs.get(card.key)?.shipped > 0),
    ).length;
    const parkedRuns = [...d.engine.runs.values()].some(
      (r) => r.project === project && !r.closed && r.parked,
    );
    if (unfinished > 0 || parkedRuns) {
      this.noteStarvation(
        project,
        `zero active runs; ${unfinished} unfinished cards, nothing launchable`,
      );
    } else {
      this.clearStarvation(project);
    }
  }

  // -- starvation: open once, resolved by the daemon on activity ------------

  openStarvation(project) {
    const events = readEvents(this.daemon.paths.instanceLedger);
    const resolved = new Set(
      events.filter((e) => e.event === 'resolved').map((e) => e.resolves),
    );
    return events.filter(
      (e) => e.event === 'factory-starvation' && e.project === project && !resolved.has(e.seq),
    );
  }

  noteStarvation(project, reason) {
    if (this.openStarvation(project).length > 0) return;
    this.daemon.ledger.append('factory-starvation', {
      actor: ACTOR,
      project,
      reason,
      gist: gist(`factory-starvation: ${project} — ${reason}`),
    });
  }

  clearStarvation(project) {
    for (const e of this.openStarvation(project)) {
      this.daemon.ledger.resolve({ actor: ACTOR, resolves: e.seq, project });
    }
  }
}

function gist(text) {
  return text.length > GIST_MAX ? text.slice(0, GIST_MAX - 1) + '…' : text;
}
