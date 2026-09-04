// The watched-workflow observer: an in-daemon poll of the workflow runs no
// request path covers. A job that leaves the request path — moved to a
// schedule on the default branch — stops being read by anything: no run waits
// on it, no check watcher sees it, and its red sits on the forge until a human
// opens the actions tab. This reads it instead, and says so where the operator
// already looks (ADR-0035).
//
// The condition is the forge's own terminal word on the run: a completed run
// and the conclusion it carries. No span of wall-clock time appears in it. A
// list the forge would not answer, and a workflow with no completed run yet,
// both read as nothing anybody has judged — never as a green.
//
// The ledger is the only state. Which reds are already recorded, and which of
// them are still open, are both derived from the instance ledger on every
// poll, so a restart re-derives the same set and stamps nothing twice.
import { settleOwnedLoud } from '../ledger/resolution.mjs';
import { PollWatcher } from '../daemon/watch.mjs';

const ACTOR = 'workflow-watcher';
const GIST_MAX = 120;

// The poll period. Modest by design: a watched workflow runs on a schedule of
// its own, and nothing in the harness waits on this. Every tick that finds a
// state the ledger already holds writes nothing.
export const WATCH_MS = 15 * 60 * 1000;

// The conclusions that are not a defect. `neutral` and `skipped` are the
// forge's ways of saying a run made no claim, and the ship path already reads
// them beside `success` for exactly that reason.
const GREEN = new Set(['success', 'neutral', 'skipped']);

export class WorkflowWatcher extends PollWatcher {
  /**
   * @param {{ledger: import('../telemetry/stores.mjs').TelemetryStore,
   *   projects: () => {project: string, defaultBranch: string}[],
   *   forgeFor: (project: string) => object,
   *   readWatched: (project: string) => Promise<string[]>,
   *   intervalMs?: number}} opts
   *   ledger: the instance store the records land in — the watcher holds no
   *   run and opens no run store.
   *   projects: the live instance-config entries, read fresh per poll.
   *   readWatched: the project's `watchedWorkflows`, read from its clone.
   */
  constructor({ ledger, projects, forgeFor, readWatched, intervalMs = WATCH_MS }) {
    super({ intervalMs });
    this.ledger = ledger;
    this.projects = projects ?? (() => []);
    this.forgeFor = forgeFor ?? (() => null);
    this.readWatched = readWatched ?? (async () => []);
  }

  async poll() {
    for (const { project, defaultBranch } of this.projects()) {
      let watched;
      try {
        watched = await this.readWatched(project);
      } catch {
        continue; // no clone yet, or a config this poll could not read
      }
      if (!Array.isArray(watched) || watched.length === 0) continue;
      let forge;
      try {
        forge = this.forgeFor(project);
      } catch {
        continue; // a project this host holds no forge for
      }
      if (!forge) continue;
      for (const workflow of watched) {
        if (this.stopped) return;
        await this.judge({ project, workflow, forge, branch: defaultBranch });
      }
    }
  }

  /**
   * One workflow, one verdict. A red opens a loud record once per red run,
   * naming the jobs that were not green; a green closes whatever this
   * workflow has open, through the recovery record that owns it.
   */
  async judge({ project, workflow, forge, branch }) {
    let run = null;
    try {
      run = await forge.latestCompletedRun(workflow, branch);
    } catch {
      run = null;
    }
    // Nobody read a conclusion. That is not a green: it opens nothing and,
    // more importantly, it closes nothing that is already open.
    if (run === null) return;
    const events = this.ledger.events();
    const mine = events.filter((e) => e.project === project && e.workflow === workflow);
    if (!GREEN.has(run.conclusion)) {
      // The same red run, poll after poll, is one piece of news. The last
      // stamp is what says so, and it is read from the ledger, so a restart
      // reads the same answer.
      const last = mine.at(-1);
      if (last?.event === 'workflow-red' && last.run === run.id) return;
      const jobs = await redJobs(forge, run.id);
      const named = jobs.map((j) => j.name).join(', ');
      this.ledger.append('workflow-red', {
        actor: ACTOR,
        project,
        workflow,
        run: run.id,
        conclusion: run.conclusion,
        branch,
        jobs,
        ...(run.url && { url: run.url }),
        ...(run.headSha && { headSha: run.headSha }),
        gist: gist(
          `${workflow} run ${run.id} on ${branch}: ${run.conclusion}` +
            (named ? ` (${named})` : ''),
        ),
      });
      return;
    }
    const resolved = new Set(events.filter((e) => e.event === 'resolved').map((e) => e.resolves));
    const open = mine.filter((e) => e.event === 'workflow-red' && !resolved.has(e.seq));
    if (open.length === 0) return;
    this.ledger.append('workflow-recovered', {
      actor: ACTOR,
      project,
      workflow,
      run: run.id,
      conclusion: run.conclusion,
      branch,
      ...(run.url && { url: run.url }),
      closes: open.map((e) => e.seq),
    });
    // The instance ledger has no per-append sweep of its own, so the pairing
    // happens where the stamp lands.
    settleOwnedLoud(this.ledger, { actor: ACTOR });
  }
}

/**
 * The jobs of one run that were not green, as `{name, conclusion}`. The forge
 * is asked once, through the same client the run came from. A list the forge
 * would not answer reads as no job named: the red stands on the run's own
 * conclusion, and a job list is what tells the reader which slice to open.
 */
async function redJobs(forge, runId) {
  let jobs = null;
  try {
    jobs = await forge.runJobs(runId);
  } catch {
    jobs = null;
  }
  if (!Array.isArray(jobs)) return [];
  return jobs
    .filter((j) => typeof j?.name === 'string' && !GREEN.has(j.conclusion))
    .map((j) => ({ name: j.name, conclusion: j.conclusion ?? null }));
}

function gist(text) {
  return text.length > GIST_MAX ? text.slice(0, GIST_MAX - 1) + '…' : text;
}
