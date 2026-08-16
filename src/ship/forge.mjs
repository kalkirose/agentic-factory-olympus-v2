// GitHub forge adapter over the `gh` CLI. The ship step talks to the forge
// through this interface only; tests substitute a fake with the same shape.
// Argv builders are exported for unit tests. Every call goes through an
// injectable runner, so nothing here spawns in a test.
//
// Interface contract (any forge implementation):
//   preflight(base)      → {autoMergeAllowed, strict, requiredChecks}
//   openPr(opts)         → {number, url}; idempotent per head branch — an
//                          open PR for the branch is returned, never doubled
//   armAutoMerge(number) → {armed, reason?}; never throws on refusal
//   prState(number)      → {state: 'open'|'merged'|'closed', headSha,
//                          mergeSha?, behindBase, conflicting, autoMergeArmed}
//   checkRuns(sha)       → [{name, status, conclusion?, startedAt?, completedAt?,
//                          run?}]; `run` is the id of the workflow run the
//                          check is a job of, or null for a check no workflow
//                          produced
//   workflowRun(id)      → {id, status, conclusion} for one workflow run, or
//                          null when the forge would not answer
//   rerunFailed(sha)     → re-runs the failed jobs of the sha's runs
//   checkOutput(sha, name) → failure-log tail for one check, or a parenthetical
//                          saying why no log is retrievable. It answers every
//                          forge condition with a reason and throws on none of
//                          them; the one thing it refuses is a log asked for
//                          before its workflow run finished, which is a defect
//                          of the caller and throws `PartialLogRefusal`
import { runCommand } from '../lanes/exec.mjs';

const OUTPUT_LIMIT = 400000;
const LOG_TAIL = 3000;

/** The check-run link of a workflow job: the run id, then the job id. */
const JOB_LINK = /\/actions\/runs\/(\d+)\/job\/(\d+)/;

/**
 * The refusal of a log fetch that arrived before its workflow run was over.
 * The forge serves the log of a run from one archive, so a run still executing
 * hands back the steps it has finished so far and nothing about the rest. That
 * text reads exactly like a whole log, and a gate judged on it is judged on
 * half the evidence — so the fetch refuses instead of answering, and the
 * refusal is an exception rather than a reason string: every other absence
 * here is the forge's business, and this one is the harness's own.
 */
export class PartialLogRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'PartialLogRefusal';
  }
}

/** Extracts `owner/name` from the common GitHub remote URL shapes. */
export function parseGitHubRepo(repoUrl) {
  const match =
    /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repoUrl) ??
    /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(repoUrl) ??
    /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(repoUrl);
  return match ? match[1] : null;
}

/**
 * Builds the GitHub forge.
 * @param {{repo: string, ghCommand?: string[], runner?: typeof runCommand}} opts
 *   `repo` is `owner/name`; `ghCommand` is the machine's gh argv.
 */
export function gitHubForge({ repo, ghCommand = ['gh'], runner = runCommand }) {
  if (typeof repo !== 'string' || !repo.includes('/')) {
    throw new Error(`gitHubForge requires an owner/name repo, got: ${repo}`);
  }

  async function gh(args, { allowFail = false } = {}) {
    const result = await runner([...ghCommand, ...args], { outputLimit: OUTPUT_LIMIT });
    if (result.code === null) throw new Error(`gh could not run: ${result.error}`);
    if (result.code !== 0 && !allowFail) {
      throw new Error(`gh ${args[0]} failed (${result.code}): ${result.output.slice(-500)}`);
    }
    return result;
  }

  async function ghJson(args, opts) {
    const result = await gh(args, opts);
    if (result.code !== 0) return null;
    return JSON.parse(result.output);
  }

  /**
   * The check runs of one commit, raw. This is the only name authority on the
   * ship path: a check is named after the job that produced it, and the
   * watcher stamps that name. A workflow run carries the name of the
   * workflow, so a check cannot be found among workflow runs by name.
   */
  async function commitCheckRuns(sha, opts) {
    const data = await ghJson(
      [
        'api', `repos/${repo}/commits/${sha}/check-runs`, '--paginate',
        '-q', '{check_runs: [.check_runs[]]}',
      ],
      opts,
    );
    return data?.check_runs ?? [];
  }

  /**
   * The state of one workflow run. `status` is the forge's own word — queued,
   * in_progress, completed — and only the last of them means the run is over.
   * A run the forge would not answer for reads as null: a state nobody could
   * read is not a statement that the run is still going.
   */
  async function runState(id) {
    const result = await gh(
      ['api', `repos/${repo}/actions/runs/${id}`, '--jq', '{status: .status, conclusion: .conclusion}'],
      { allowFail: true },
    );
    if (result.code !== 0) return null;
    let data = null;
    try {
      data = JSON.parse(result.output);
    } catch {
      return null;
    }
    if (!data?.status) return null;
    return { id: String(id), status: data.status, conclusion: data.conclusion ?? null };
  }

  return {
    async preflight(base) {
      // The auto-merge capability is a REST repository field: `gh repo view
      // --json` has no autoMergeAllowed field, and a call that names one
      // fails the stage. The read takes the api route of the protection
      // call below.
      const allowAutoMerge = await ghJson(['api', `repos/${repo}`, '--jq', '.allow_auto_merge'], {
        allowFail: true, // unreadable reads as off; the ship step parks on it
      });
      const protection = await ghJson(
        ['api', `repos/${repo}/branches/${base}/protection/required_status_checks`],
        { allowFail: true }, // 404 = no protection; the ship step parks on it
      );
      return {
        autoMergeAllowed: allowAutoMerge === true,
        strict: protection?.strict === true,
        requiredChecks: protection?.contexts ?? [],
      };
    },

    async openPr({ head, base, title, body }) {
      await gh(
        ['pr', 'create', '-R', repo, '--head', head, '--base', base, '--title', title, '--body', body],
        { allowFail: true }, // an existing open PR for the branch is not an error
      );
      const view = await ghJson(['pr', 'view', head, '-R', repo, '--json', 'number,url,state']);
      if (!view || view.state === 'CLOSED') {
        throw new Error(`no open PR for branch ${head} after create`);
      }
      return { number: view.number, url: view.url };
    },

    async armAutoMerge(number) {
      const result = await gh(['pr', 'merge', String(number), '-R', repo, '--squash', '--auto'], {
        allowFail: true,
      });
      if (result.code !== 0) return { armed: false, reason: result.output.slice(-300) };
      return { armed: true };
    },

    async prState(number) {
      const view = await ghJson([
        'pr', 'view', String(number), '-R', repo,
        '--json', 'state,headRefOid,mergeCommit,mergeable,mergeStateStatus,autoMergeRequest',
      ]);
      return {
        state: view.state.toLowerCase(), // open | merged | closed
        headSha: view.headRefOid,
        mergeSha: view.mergeCommit?.oid ?? null,
        behindBase: view.mergeStateStatus === 'BEHIND',
        // A pull request in textual conflict with its base, named by both of
        // the forge's answers about it: `mergeable` is CONFLICTING and the
        // merge state is DIRTY. The forge builds no merge ref for such a
        // request, so it starts no pull-request workflow and the head sha can
        // never carry a check. The ship step routes the state; it is not a
        // check that has yet to arrive.
        conflicting: view.mergeable === 'CONFLICTING' || view.mergeStateStatus === 'DIRTY',
        autoMergeArmed: view.autoMergeRequest != null,
      };
    },

    async checkRuns(sha) {
      return (await commitCheckRuns(sha)).map((run) => ({
        name: run.name,
        status: run.status, // queued | in_progress | completed
        conclusion: run.conclusion ?? null,
        startedAt: run.started_at ?? null,
        completedAt: run.completed_at ?? null,
        // The workflow run this check is a job of, taken off the check's own
        // link. A check is terminal when its job is; the run it belongs to can
        // still be executing, and the watcher reads both.
        run: JOB_LINK.exec(run.details_url ?? '')?.[1] ?? null,
      }));
    },

    workflowRun(id) {
      return runState(id);
    },

    async rerunFailed(sha) {
      const runs = await ghJson([
        'run', 'list', '-R', repo, '--commit', sha, '--json', 'databaseId,conclusion',
      ]);
      for (const run of runs ?? []) {
        if (run.conclusion && run.conclusion !== 'success') {
          await gh(['run', 'rerun', String(run.databaseId), '-R', repo, '--failed'], {
            allowFail: true, // a run without failed jobs refuses; others still re-run
          });
        }
      }
    },

    // The triage input is only as good as this string, so every path out of
    // here says what it is: the log tail, or the reason there is none.
    async checkOutput(sha, name) {
      try {
        const named = (await commitCheckRuns(sha, { allowFail: true })).filter(
          (run) => run.name === name,
        );
        const match = named.find((run) => run.conclusion && run.conclusion !== 'success');
        if (!match) {
          const state = named[0]
            ? `it is ${named[0].status}${named[0].conclusion ? `/${named[0].conclusion}` : ''}`
            : 'the commit carries no check of that name';
          return `(no failure log for ${name}: ${state})`;
        }
        // The check run of a workflow job links to the job it reports on;
        // that link carries the run id and the job id the log calls answer to.
        // A check from any other app has no job and no log to read.
        const link = JOB_LINK.exec(match.details_url ?? '');
        if (!link) {
          return `(no failure log for ${name}: no workflow job behind the check, at ${match.details_url || 'no url'})`;
        }
        const [, runId, jobId] = link;
        // The completion assert, before a single byte of log is asked for. The
        // caller decides when a red check is ready to be read; this says what
        // it costs to be wrong about it.
        const state = await runState(runId);
        if (state && state.status !== 'completed') {
          throw new PartialLogRefusal(
            `refusing the log of ${name}: its workflow run ${runId} is ${state.status}. ` +
              'A log read out of a run still executing is a partial log, and it reads ' +
              'exactly like a whole one.',
          );
        }
        const failed = await logOfJob(jobId, '--log-failed');
        if (failed.code === 0 && failed.output.trim()) return failed.output.slice(-LOG_TAIL);
        // A job killed before a step failed (cancelled, timed out, lost its
        // runner) reports no failed step at all; its whole log is then the
        // only account of what happened.
        const whole = await logOfJob(jobId, '--log');
        if (whole.code === 0 && whole.output.trim()) return whole.output.slice(-LOG_TAIL);
        const why = (whole.output || failed.output).trim().slice(-500) || 'it answered with nothing';
        return `(no failure log for ${name}: the forge would not read job ${jobId}: ${why})`;
      } catch (error) {
        if (error instanceof PartialLogRefusal) throw error;
        return `(no failure log for ${name}: ${error.message})`;
      }
    },
  };

  function logOfJob(jobId, mode) {
    return gh(['run', 'view', '--job', jobId, '-R', repo, mode], { allowFail: true });
  }
}
