// Frontier auto-launch: the daemon fills free slots from the launchable
// frontier in roadmap order, at any hour. The launcher is event-keyed —
// a sweep runs on daemon start, arming, run close, run park, an answer, a
// config change, and console commands; never on a timer. Sweeps serialize
// per project through a promise chain, so two triggers never race a launch.
//
// A sweep has three passes: owed breach repairs, then owed decision-record
// reconciliations, then the story frontier. Repairs come first because they
// are defects on code that already shipped; reconciliations outrank new
// stories because record hygiene on shipped work is owed before more work
// ships on top of it. All three passes spend the same slots.
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
import { owedRepairs, repairLaunch } from './repairs.mjs';
import { owedReconciliations, reconciliationLaunch } from './reconciliations.mjs';

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
    if (!armed) this.clearStarvation(project);
    // Both directions sweep. Arming launches what is owed and launchable;
    // pausing is the moment owed repairs become starved, and the sweep is
    // where that is said out loud.
    this.queueSweep(project);
  }

  /** Chains one sweep for the project; concurrent triggers coalesce in order. */
  queueSweep(project) {
    this.pending.set(project, (this.pending.get(project) ?? 0) + 1);
    const prev = this.chains.get(project) ?? Promise.resolve();
    const next = prev.then(() => this.sweep(project)).catch(() => {});
    this.chains.set(project, next);
    return next;
  }

  /**
   * Every project, armed or not: a paused project launches nothing, and the
   * sweep still owes it the owed-repairs judgment.
   */
  queueSweepAll() {
    for (const project of Object.keys(this.daemon.config.projects)) {
      this.queueSweep(project);
    }
  }

  /** Awaited by daemon stop so late stamps land before the ledger closes. */
  async drain() {
    await Promise.allSettled([...this.chains.values()]);
  }

  async sweep(project) {
    this.pending.set(project, this.pending.get(project) - 1);
    const d = this.daemon;
    if (!d.running) return;
    const entry = d.config.projects[project];
    if (!entry) return;
    // One sweep, one arming: the passes are separated by launches, and a
    // sweep that judged its repairs paused must not fill slots with stories
    // because the owner armed in between. That transition queues its own
    // sweep. Each launch still re-reads the live state before it spends.
    const armed = this.isArmed(project);
    const waiting = await this.repairPass(project, armed);
    if (!armed || !d.running || !d.engine.lanes.has('story')) return;
    if (waiting > 0) {
      // Repairs are owed and every slot is taken. The story frontier waits:
      // a slot that frees while this sweep reads the graph belongs to the
      // repair, and the close that frees it queues the sweep that takes it.
      // The factory is provably busy, so nothing here is starvation.
      this.clearStarvation(project);
      return;
    }
    if ((await this.reconciliationPass(project)) > 0) {
      // Same stand-down as the repair pass: an owed reconciliation waits on
      // a slot, so the story frontier does not take it first.
      this.clearStarvation(project);
      return;
    }
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
      runs: storyRunsByKey(d.paths, { project }),
      parkedCards: new Set(
        openCardParks(d.paths, { project }).map((p) => p.card).filter(Boolean),
      ),
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
   * The repair pass: the owed breach repairs of one project, oldest escape
   * first, while slots allow. Returns how many are still waiting on a slot —
   * the story pass stands down for those. Nothing is retried here: a repair
   * that found no slot stays owed and the next sweep launches it, which is
   * also how a daemon that restarted mid-breach catches up.
   *
   * A paused project launches nothing. A breach repair is a defect on shipped
   * code, but a pause is a deliberate act of the owner, and the daemon never
   * overrides one; the owed set goes loud instead.
   */
  async repairPass(project, armed) {
    const d = this.daemon;
    if (!d.engine.lanes.has('repair')) return 0;
    const owed = owedRepairs(d.paths, project);
    let waiting = 0;
    if (!armed) {
      if (owed.length > 0) this.noteOwedRepairs(project, owed);
    } else {
      for (let i = 0; i < owed.length; i++) {
        if (!d.running || !this.isArmed(project)) break;
        if (!d.engine.hasFreeSlot(project)) {
          waiting = owed.length - i;
          break;
        }
        try {
          await d.launchRun(repairLaunch(owed[i]));
        } catch {
          // One failed launch ends the pass; the escape stays owed and the
          // next trigger retries it. The refusal stamps itself, and the story
          // frontier keeps moving — a repair that cannot launch at all must
          // not stop everything else.
          break;
        }
      }
    }
    // Every pass, and not only a pass that launched: an owed set empties
    // without a launch whenever somebody fixes an escape out of band, and an
    // item nothing retires is a loud strip that stays lit over work that is
    // done.
    this.clearOwedRepairs(project);
    return waiting;
  }

  /**
   * The reconciliation pass: the owed decision-record reconciliations of one
   * project, oldest ship first, while slots allow. Returns how many still
   * wait on a slot — the story pass stands down for those. Nothing is
   * retried here: an owed reconciliation the sweep could not launch stays
   * derived and the next sweep launches it, which is also how a daemon that
   * restarted between the judgment and the launch catches up. A paused
   * project launches nothing and nothing goes loud: the owed set persists in
   * the run ledgers, and the record tree's own hygiene gate bounds the gap.
   */
  async reconciliationPass(project) {
    const d = this.daemon;
    if (!d.engine.lanes.has('repair') || !this.isArmed(project)) return 0;
    const owed = owedReconciliations(d.paths, project);
    let waiting = 0;
    for (let i = 0; i < owed.length; i++) {
      if (!d.running || !this.isArmed(project)) break;
      if (!d.engine.hasFreeSlot(project)) {
        waiting = owed.length - i;
        break;
      }
      try {
        await d.launchRun(reconciliationLaunch(owed[i]));
      } catch {
        // One failed launch ends the pass; the reconciliation stays owed and
        // the next trigger retries it. The story frontier keeps moving.
        break;
      }
    }
    return waiting;
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
    const runs = storyRunsByKey(d.paths, { project });
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

  // -- owed repairs a paused project cannot launch --------------------------

  openOwedRepairs(project) {
    const events = readEvents(this.daemon.paths.instanceLedger);
    const resolved = new Set(events.filter((e) => e.event === 'resolved').map((e) => e.resolves));
    return events.filter(
      (e) => e.event === 'repairs-owed' && e.project === project && !resolved.has(e.seq),
    );
  }

  /**
   * Stamps the owed escapes a paused project starves. Dedupe is by escape
   * seq: a seq an open item already names never stamps twice, and a breach
   * that lands during the pause stamps for its own seqs alone.
   */
  noteOwedRepairs(project, owed) {
    const named = new Set(this.openOwedRepairs(project).flatMap((e) => e.escapes));
    const escapes = owed.map((e) => e.seq).filter((seq) => !named.has(seq));
    if (escapes.length === 0) return;
    this.daemon.ledger.append('repairs-owed', {
      actor: ACTOR,
      project,
      escapes,
      reason: `${project} is not armed; ${escapes.length} ticketed escape(s) await a repair run`,
      gist: gist(`repairs-owed: ${project} — escape ${escapes.join(', ')} ticketed, not launched`),
    });
  }

  /** Resolves an open item once none of the escapes it names is still owed. */
  clearOwedRepairs(project) {
    const open = this.openOwedRepairs(project);
    if (open.length === 0) return;
    const still = new Set(owedRepairs(this.daemon.paths, project).map((e) => e.seq));
    for (const item of open) {
      if (item.escapes.some((seq) => still.has(seq))) continue;
      this.daemon.ledger.resolve({ actor: ACTOR, resolves: item.seq, project });
    }
  }
}

function gist(text) {
  return text.length > GIST_MAX ? text.slice(0, GIST_MAX - 1) + '…' : text;
}
