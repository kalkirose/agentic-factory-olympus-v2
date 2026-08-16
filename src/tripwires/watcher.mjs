// The tripwire watcher: an in-daemon process that reads ledgers and writes
// breaches; it classifies and executes nothing. Event-keyed only — an append
// that matches a tripwire's trigger events re-evaluates it; wall-clock never
// triggers. A breach opens once, stays open until its paired `resolved`
// (restore executed, or a recorded human exception), and re-arms at
// resolution: the next matching append evaluates fresh.
//
// The registry is each project's `tripwires` section. The launch path hands
// the watcher the freshly read config; between launches (and after a daemon
// restart) the watcher reads the registry from the project's bare clone,
// without fetching — the observer never advances the clone.
//
// One tripwire stands outside the registry, because it watches the harness
// rather than a project's quality: stage duration against the duration
// history, keyed on the heartbeat a polling stage stamps. It opens a queued
// record and touches nothing (ADR-0034).
import { readEvents } from '../ledger/ledger.mjs';
import { listRunEvents } from '../telemetry/readers.mjs';
import { withTripwireDefaults } from './registry.mjs';
import { durationBand, stageDurations } from './duration.mjs';
import {
  evaluateMetric,
  countFreezes,
  countVerdicts,
  killRateBaseline,
  furyYieldBaseline,
  BASELINE_WINDOW,
} from './metrics.mjs';

const ACTOR = 'tripwire-watcher';
const GIST_MAX = 120;

// The stage-duration key. A heartbeat is the only stamp a polling stage makes
// while it waits, so it is where the duration is read; the two lifecycle
// stamps are where an open record stops being a request.
const HEARTBEAT = 'stage-heartbeat';
const STAGE_EVENTS = new Set([HEARTBEAT, 'stage-entered', 'run-closed']);

// The self-baseline points: the 5th freeze proposes the kill-rate band, the
// 5th verdict the per-lens yield bands. Stamped once per project and metric.
const BASELINE_METRICS = new Map([
  ['freeze', 'kill-rate'],
  ['verdict-rendered', 'fury-lens-yield'],
]);

const COMPARATORS = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
};

export class TripwireWatcher {
  /**
   * @param {{paths: object, ledger: import('../telemetry/stores.mjs').TelemetryStore,
   *   readRegistry?: (project: string) => Promise<object[]>,
   *   readSource?: (project: string) => Promise<object|null>}} opts
   *   ledger: the instance store breaches and proposals stamp to.
   *   readRegistry: reads the project's tripwire section (clone, no fetch).
   *   readSource: reads the story-graph source for the width metric.
   */
  constructor({ paths, ledger, readRegistry, readSource }) {
    this.paths = paths;
    this.ledger = ledger;
    this.readRegistry = readRegistry ?? (async () => []);
    this.readSource = readSource ?? (async () => null);
    this.registries = new Map();
    this.chains = new Map();
    this.stopped = false;
  }

  /** The launch path hands over the freshly read registry. */
  setRegistry(project, tripwires) {
    this.registries.set(project, (tripwires ?? []).map(withTripwireDefaults));
  }

  /**
   * The event key: every store append lands here (via the store hooks). An
   * event that matches no tripwire trigger, no baseline point and no stage
   * key returns without queueing. Work chains per project, so two appends
   * never race an evaluation against the open-breach check.
   * @param {string} project
   * @param {object} line the appended event
   * @param {string} [ledger] the source-ledger id the store appended to; a run
   *   ledger is `run:<runId>`, and the stage key reads it for the run.
   */
  notify(project, line, ledger) {
    if (this.stopped || typeof project !== 'string' || project.length === 0) return;
    const registry = this.registries.get(project);
    const matches =
      registry === undefined || registry.some((t) => t.triggerEvents.includes(line.event));
    const staged = runIdOf(ledger) !== null && STAGE_EVENTS.has(line.event);
    if (!matches && !BASELINE_METRICS.has(line.event) && !staged) return;
    const prev = this.chains.get(project) ?? Promise.resolve();
    const next = prev.then(() => this.handle(project, line, ledger)).catch(() => {});
    this.chains.set(project, next);
    return next;
  }

  /** Awaited by daemon stop so late stamps land before the ledger closes. */
  async stop() {
    this.stopped = true;
    await Promise.allSettled([...this.chains.values()]);
  }

  async handle(project, line, ledger) {
    if (this.stopped) return;
    const event = line.event;
    const runId = runIdOf(ledger);
    if (runId !== null && STAGE_EVENTS.has(event)) {
      try {
        this.checkStageDuration(project, runId, line);
      } catch {
        // An unreadable ledger skips; the next heartbeat reads again.
      }
    }
    if (BASELINE_METRICS.has(event)) {
      await this.checkBaseline(project, BASELINE_METRICS.get(event)).catch(() => {});
    }
    const registry = await this.registryFor(project);
    for (const entry of registry) {
      if (!entry.triggerEvents.includes(event)) continue;
      // An unreadable metric skips; the next matching append re-evaluates.
      await this.evaluate(project, entry).catch(() => {});
    }
  }

  /**
   * The cached registry, lazily read from the clone when no launch has
   * handed one over yet (first traffic after a daemon restart). A failed
   * read stays uncached and retries on the next matching append.
   */
  async registryFor(project) {
    const cached = this.registries.get(project);
    if (cached !== undefined) return cached;
    let tripwires;
    try {
      tripwires = await this.readRegistry(project);
    } catch {
      return [];
    }
    this.setRegistry(project, tripwires);
    return this.registries.get(project);
  }

  async evaluate(project, entry) {
    if (this.openBreachSeqs(project, entry.id).length > 0) return; // open once
    const { value, eligible, detail } = await evaluateMetric(entry.metric, {
      paths: this.paths,
      project,
      window: entry.window,
      params: entry.params,
      readSource: this.readSource,
    });
    if (!eligible) return;
    if (!COMPARATORS[entry.breach.op](value, entry.breach.value)) return;
    this.ledger.append('tripwire-breach', {
      actor: ACTOR,
      project,
      tripwire: entry.id,
      metric: entry.metric,
      value,
      breach: entry.breach,
      ...(entry.window !== undefined && { window: entry.window }),
      ...(detail && Object.keys(detail).length > 0 && { detail }),
      answer: entry.answer,
      gist: gist(
        `tripwire ${entry.id}: ${entry.metric} ${round(value)} ${entry.breach.op} ${entry.breach.value} (${project})`,
      ),
    });
  }

  openBreachSeqs(project, tripwireId) {
    const events = readEvents(this.paths.instanceLedger);
    const resolved = new Set(
      events.filter((e) => e.event === 'resolved').map((e) => e.resolves),
    );
    return events
      .filter(
        (e) =>
          e.event === 'tripwire-breach' &&
          e.project === project &&
          e.tripwire === tripwireId &&
          !resolved.has(e.seq),
      )
      .map((e) => e.seq);
  }

  // -- stage duration --------------------------------------------------------

  /**
   * The stage-duration tripwire, keyed on the heartbeat a polling stage
   * stamps. The elapsed the stamp carries is measured against the band the
   * same stage of the same lane built in the other runs of the project, and a
   * stage past the band opens one queued record for the operator.
   *
   * It detects and it does nothing else. The watcher holds no run, opens no
   * run store and returns no directive, so nothing here can kill a run, move
   * it, or change what it waits for. No span of wall-clock time appears in the
   * condition either: the band is the history, and the heartbeat is the state
   * change that triggers the reading (ADR-0034).
   *
   * A lifecycle stamp takes the other route: the record asked the operator to
   * look at a stage, and the stage has ended.
   */
  checkStageDuration(project, runId, line) {
    if (line.event !== HEARTBEAT) {
      this.settleStageOverrun(runId, line);
      return;
    }
    if (typeof line.stage !== 'string' || typeof line.elapsed !== 'number') return;
    // Open once per stage, not once per heartbeat: the condition holds for as
    // long as the stage does, and the operator asked to be told, not counted at.
    if (this.openOverruns(runId).some((e) => e.stage === line.stage)) return;
    const runs = listRunEvents(this.paths, { project });
    const self = runs.find((r) => r.runId === runId);
    if (!self) return;
    // A run never sets the band it is judged against, and a lane never judges
    // another lane's stage of the same name.
    const samples = [];
    for (const run of runs) {
      if (run.runId === runId || run.lane !== self.lane) continue;
      samples.push(...stageDurations(run.events, line.stage));
    }
    const band = durationBand(samples);
    // Cold start: the history is too thin to hold a band, so there is nothing
    // to be outside of. Quiet, because a guess the operator learns to ignore
    // is worse than no record at all.
    if (band === null || line.elapsed <= band.upper) return;
    this.ledger.append('stage-overrun', {
      actor: ACTOR,
      project,
      runId,
      lane: self.lane,
      stage: line.stage,
      elapsed: line.elapsed,
      ...(line.waitingOn !== undefined && { waitingOn: line.waitingOn }),
      ...(line.polls !== undefined && { polls: line.polls }),
      band,
      gist: gist(
        `${runId} has been in ${line.stage} for ${minutes(line.elapsed)} min; ` +
          `the last ${samples.length} visits stayed under ${minutes(band.upper)} min`,
      ),
    });
  }

  /**
   * The record stops being a request the moment the stage it named ends, so a
   * stage transition and a run close both answer it. A resumed entry answers
   * nothing: the daemon restarted, and the stage the record named is the stage
   * the run is still in.
   */
  settleStageOverrun(runId, line) {
    if (line.event === 'stage-entered' && line.resumed) return;
    for (const open of this.openOverruns(runId)) {
      this.ledger.resolve({
        actor: ACTOR,
        resolves: open.seq,
        note: line.event === 'run-closed' ? 'the run closed' : `the run entered ${line.stage}`,
      });
    }
  }

  openOverruns(runId) {
    const events = readEvents(this.paths.instanceLedger);
    const resolved = new Set(
      events.filter((e) => e.event === 'resolved').map((e) => e.resolves),
    );
    return events.filter(
      (e) => e.event === 'stage-overrun' && e.runId === runId && !resolved.has(e.seq),
    );
  }

  // -- baseline proposals ----------------------------------------------------

  async checkBaseline(project, metric) {
    const events = readEvents(this.paths.instanceLedger);
    if (
      events.some(
        (e) => e.event === 'baseline-proposal' && e.project === project && e.metric === metric,
      )
    ) {
      return;
    }
    const count =
      metric === 'kill-rate' ? countFreezes(this.paths, project) : countVerdicts(this.paths, project);
    if (count < BASELINE_WINDOW) return;
    const observed =
      metric === 'kill-rate'
        ? killRateBaseline(this.paths, project)
        : furyYieldBaseline(this.paths, project);
    this.ledger.append('baseline-proposal', {
      actor: ACTOR,
      project,
      metric,
      window: BASELINE_WINDOW,
      observed,
      // The kill-rate band is a floor; the observed minimum is the honest
      // opening bid. Lens-yield bands read from the per-lens counts.
      ...(metric === 'kill-rate' && {
        suggested: { op: '<', value: round(Math.min(...observed.perFreeze)) },
      }),
      gist: gist(
        metric === 'kill-rate'
          ? `baseline proposal: kill-rate ${round(observed.rate)} over ${observed.freezes} freezes (${project})`
          : `baseline proposal: lens yield over ${observed.verdicts} verdicts (${project})`,
      ),
    });
  }
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

/** The run behind a source-ledger id, or null for a ledger that holds no run. */
function runIdOf(ledger) {
  return typeof ledger === 'string' && ledger.startsWith('run:')
    ? ledger.slice('run:'.length)
    : null;
}

function minutes(ms) {
  return Math.round(ms / 60000);
}

function gist(text) {
  return text.length > GIST_MAX ? text.slice(0, GIST_MAX - 1) + '…' : text;
}
