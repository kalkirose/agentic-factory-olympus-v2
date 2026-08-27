// GitHub forge adapter over the `gh` CLI. The ship step talks to the forge
// through this interface only; tests substitute a fake with the same shape.
// Argv builders are exported for unit tests. Every call goes through an
// injectable runner, so nothing here spawns in a test.
//
// Interface contract (any forge implementation):
//   preflight(base)      → {autoMergeAllowed, strict, requiredChecks}
//   openPr(opts)         → {number, url, labelled}; idempotent per head
//                          branch — an open PR for the branch is returned,
//                          never doubled. `opts.labels` ride the creation
//                          call on a forge that takes them, and `labelled`
//                          says whether the request that came back carries
//                          them already; a false answer sends the caller to
//                          `applyLabels`
//   applyLabels(n, list) → {applied, reason?}; additive, and never throws on
//                          a label the repository does not define. The
//                          fallback path for a forge whose create cannot
//                          carry labels, and for a request that already
//                          existed when the create ran
//   ciSecrets()          → the names of the repository's CI secrets, or null
//                          when the forge would not answer. Names only — the
//                          host serves no values and none are asked for
//   armAutoMerge(number) → {armed, reason?}; never throws on refusal
//   prState(number)      → {state: 'open'|'merged'|'closed', headSha,
//                          mergeSha?, behindBase, conflicting, autoMergeArmed}
//   checkRuns(sha)       → [{id, name, status, conclusion?, startedAt?,
//                          completedAt?, detailsUrl?, run?}]; `id` is the
//                          check run's own id, which is what identifies one
//                          attempt of a check — a name identifies the
//                          question, never the answer. `run` is the id of the
//                          workflow run the check is a job of, or null for a
//                          check no workflow produced
//   workflowRun(id)      → {id, status, conclusion} for one workflow run, or
//                          null when the forge would not answer
//   latestCompletedRun(workflow, branch)
//                        → {id, conclusion, url, headSha, completedAt} for the
//                          most recent completed run of one workflow file on
//                          one branch, or null when the forge would not answer
//                          and when no run of it has completed. A null is
//                          never a green: it says nobody read a conclusion
//   rerunFailed(sha)     → re-runs the failed jobs of the sha's runs
//   checkOutput(sha, name) → failure-log tail for one check, or a parenthetical
//                          saying why no log is retrievable — `noLogReason`
//                          tells the two apart. It answers every forge
//                          condition with a reason and throws on none of
//                          them; the one thing it refuses is a log asked for
//                          before its workflow run finished, which is a defect
//                          of the caller and throws `PartialLogRefusal`
//   checkLog(run)        → the same answer for a check run the caller already
//                          holds, addressed by its own job link rather than
//                          re-found by name. The name route has to choose
//                          among the attempts on that name; a caller that
//                          holds one attempt has already chosen (ADR-0041)
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

/**
 * The one shape of a no-log answer, and the one reader of it. `checkOutput`
 * hands its caller either a log or a sentence saying why there is none, and
 * the two are the same type — so a caller that wants to count the absences
 * would otherwise have to recognize prose it did not write. The builder and
 * the reader sit together here, where the sentence is authored, and nothing
 * outside this module knows what a no-log answer looks like.
 */
function noLog(name, reason) {
  return `(no failure log for ${name}: ${reason})`;
}

const NO_LOG = /^\(no failure log for .+?: ([\s\S]*)\)$/;

/** The reason a check output carries no log, or null when it is a log. */
export function noLogReason(output) {
  return typeof output === 'string' ? (NO_LOG.exec(output)?.[1] ?? null) : null;
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

  /** The open request of one head branch, or null when there is none. */
  async function openRequest(head) {
    const view = await ghJson(['pr', 'view', head, '-R', repo, '--json', 'number,url,state'], {
      allowFail: true, // no request for the branch is an answer, not a failure
    });
    return view && view.state !== 'CLOSED' ? view : null;
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

    /**
     * Opens the request with its labels on the create call itself. The host
     * triggers the checks of a request at creation, so a label applied after
     * the create is a label the check that reads it may never see; passing
     * them to `pr create` leaves no state between the two.
     *
     * Two things refuse this create. An open request for the branch already
     * exists — the idempotent case, which re-views and reports the labels
     * unapplied, because this call did not apply them. Or the repository does
     * not define a label, which opens nothing at all: that one is retried
     * bare, so the caller holds a request it can park on with the forge's own
     * reason instead of a run that failed with no request to name.
     */
    async openPr({ head, base, title, body, labels = [] }) {
      const argv = [
        'pr', 'create', '-R', repo, '--head', head, '--base', base, '--title', title, '--body', body,
      ];
      const created = await gh([...argv, ...labels.flatMap((label) => ['--label', label])], {
        allowFail: true, // an existing open PR for the branch is not an error
      });
      let view = await openRequest(head);
      if (!view && labels.length > 0) {
        await gh(argv, { allowFail: true });
        view = await openRequest(head);
      }
      if (!view) throw new Error(`no open PR for branch ${head} after create`);
      return {
        number: view.number,
        url: view.url,
        labelled: labels.length > 0 && created.code === 0,
      };
    },

    async ciSecrets() {
      // The Actions secrets endpoint lists names and never values; there is no
      // route through this API to a secret's content, which is what makes the
      // parity read safe to run at a gate.
      const data = await ghJson(
        ['api', `repos/${repo}/actions/secrets`, '--paginate', '-q', '{secrets: [.secrets[]]}'],
        { allowFail: true }, // an unreadable list is not an absent secret
      );
      const secrets = data?.secrets;
      return Array.isArray(secrets) ? secrets.map((secret) => secret.name) : null;
    },

    async applyLabels(number, labels) {
      if (labels.length === 0) return { applied: [] };
      const result = await gh(
        ['pr', 'edit', String(number), '-R', repo, ...labels.flatMap((l) => ['--add-label', l])],
        { allowFail: true }, // a label the repository does not define; the ship step parks on it
      );
      if (result.code !== 0) return { applied: [], reason: result.output.slice(-300) };
      return { applied: [...labels] };
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
      return (await commitCheckRuns(sha)).map(toCheckRun);
    },

    workflowRun(id) {
      return runState(id);
    },

    /**
     * The most recent completed run of one workflow file on one branch. The
     * workflow file is the id the forge lists runs under; a display name is
     * not addressable. `status=completed` is the forge's own filter, so the
     * answer carries a terminal conclusion or there is no answer — nothing
     * here reads a clock or an elapsed.
     */
    async latestCompletedRun(workflow, branch) {
      const query = `branch=${encodeURIComponent(branch)}&status=completed&per_page=1`;
      const data = await ghJson(
        [
          'api', `repos/${repo}/actions/workflows/${workflow}/runs?${query}`,
          '-q', '{runs: [.workflow_runs[]]}',
        ],
        { allowFail: true }, // an unreadable list is not a run that passed
      );
      const run = data?.runs?.[0];
      if (!run?.id || !run.conclusion) return null;
      return {
        id: String(run.id),
        conclusion: run.conclusion,
        url: run.html_url ?? null,
        headSha: run.head_sha ?? null,
        completedAt: run.updated_at ?? null,
      };
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
        const named = (await commitCheckRuns(sha, { allowFail: true }))
          .map(toCheckRun)
          .filter((run) => run.name === name)
          .sort(attemptOrder);
        // The last non-green attempt of that name, never the first the forge
        // listed: the list order is the forge's business, and a name with
        // three attempts on it would otherwise hand back a different log
        // depending on how the answer came back.
        const match = [...named].reverse().find((run) => run.conclusion && run.conclusion !== 'success');
        if (!match) {
          const latest = named.at(-1);
          const state = latest
            ? `it is ${latest.status}${latest.conclusion ? `/${latest.conclusion}` : ''}`
            : 'the commit carries no check of that name';
          return noLog(name, state);
        }
        return await jobLog(name, match.detailsUrl);
      } catch (error) {
        if (error instanceof PartialLogRefusal) throw error;
        return noLog(name, error.message);
      }
    },

    async checkLog(run) {
      try {
        return await jobLog(run.name, run.detailsUrl ?? null);
      } catch (error) {
        if (error instanceof PartialLogRefusal) throw error;
        return noLog(run.name, error.message);
      }
    },
  };

  /**
   * The log behind one check run, addressed by the check's own job link. The
   * link carries the run id and the job id the log calls answer to, so a
   * caller holding a check run reads that attempt and no other. A check from
   * any other app has no job and no log to read.
   */
  async function jobLog(name, detailsUrl) {
    const link = JOB_LINK.exec(detailsUrl ?? '');
    if (!link) {
      return noLog(name, `no workflow job behind the check, at ${detailsUrl || 'no url'}`);
    }
    const [, runId, jobId] = link;
    // The completion assert, before a single byte of log is asked for. The
    // caller decides when a red check is ready to be read; this says what it
    // costs to be wrong about it.
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
    // runner) reports no failed step at all; its whole log is then the only
    // account of what happened.
    const whole = await logOfJob(jobId, '--log');
    if (whole.code === 0 && whole.output.trim()) return whole.output.slice(-LOG_TAIL);
    const why = (whole.output || failed.output).trim().slice(-500) || 'it answered with nothing';
    return noLog(name, `the forge would not read job ${jobId}: ${why}`);
  }

  function logOfJob(jobId, mode) {
    return gh(['run', 'view', '--job', jobId, '-R', repo, mode], { allowFail: true });
  }
}

/** One check run of the host's, in the shape the interface documents. */
function toCheckRun(run) {
  return {
    // The check run's own id: the identity of one attempt at one check. The
    // forge lists every attempt it holds for a name, so a caller that keys on
    // the name alone reads whichever of them came back first.
    id: run.id == null ? null : String(run.id),
    name: run.name,
    status: run.status, // queued | in_progress | completed
    conclusion: run.conclusion ?? null,
    startedAt: run.started_at ?? null,
    completedAt: run.completed_at ?? null,
    // The link the log calls answer to, carried whole: the run id and the job
    // id are both in it, and a caller holding this check run needs no second
    // lookup by name to read its log.
    detailsUrl: run.details_url ?? null,
    // The workflow run this check is a job of, taken off the check's own link.
    // A check is terminal when its job is; the run it belongs to can still be
    // executing, and the watcher reads both.
    run: JOB_LINK.exec(run.details_url ?? '')?.[1] ?? null,
  };
}

/**
 * The order of two check runs of one name: the attempts, oldest first. Start
 * time decides it, and the check-run id breaks a tie — an id is minted when
 * the attempt is created, so the larger one is the later attempt. Neither
 * component is the list order the forge answered with, which is what made a
 * name with several attempts on it read differently from one call to the next
 * (ADR-0041). Exported because the watcher orders the same attempts, and one
 * rule read in two places is one rule.
 */
export function attemptOrder(a, b) {
  const at = Date.parse(a.startedAt ?? '') || 0;
  const bt = Date.parse(b.startedAt ?? '') || 0;
  if (at !== bt) return at < bt ? -1 : 1;
  const ai = Number(a.id);
  const bi = Number(b.id);
  if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai < bi ? -1 : 1;
  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
}
