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
//                          mergeSha?, behindBase, autoMergeArmed}
//   checkRuns(sha)       → [{name, status, conclusion?, startedAt?, completedAt?}]
//   rerunFailed(sha)     → re-runs the failed jobs of the sha's runs
//   checkOutput(sha, name) → failure-log tail for one check
import { runCommand } from '../lanes/exec.mjs';

const OUTPUT_LIMIT = 400000;
const LOG_TAIL = 3000;

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

  return {
    async preflight(base) {
      const repoView = await ghJson(['repo', 'view', repo, '--json', 'autoMergeAllowed']);
      const protection = await ghJson(
        ['api', `repos/${repo}/branches/${base}/protection/required_status_checks`],
        { allowFail: true }, // 404 = no protection; the ship step parks on it
      );
      return {
        autoMergeAllowed: repoView?.autoMergeAllowed === true,
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
        '--json', 'state,headRefOid,mergeCommit,mergeStateStatus,autoMergeRequest',
      ]);
      return {
        state: view.state.toLowerCase(), // open | merged | closed
        headSha: view.headRefOid,
        mergeSha: view.mergeCommit?.oid ?? null,
        behindBase: view.mergeStateStatus === 'BEHIND',
        autoMergeArmed: view.autoMergeRequest != null,
      };
    },

    async checkRuns(sha) {
      const data = await ghJson([
        'api', `repos/${repo}/commits/${sha}/check-runs`, '--paginate',
        '-q', '{check_runs: [.check_runs[]]}',
      ]);
      return (data?.check_runs ?? []).map((run) => ({
        name: run.name,
        status: run.status, // queued | in_progress | completed
        conclusion: run.conclusion ?? null,
        startedAt: run.started_at ?? null,
        completedAt: run.completed_at ?? null,
      }));
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

    async checkOutput(sha, name) {
      const runs = await ghJson([
        'run', 'list', '-R', repo, '--commit', sha, '--json', 'databaseId,name,conclusion',
      ]);
      const match = (runs ?? []).find((run) => run.name === name && run.conclusion !== 'success');
      if (!match) return '(no failure log found)';
      const log = await gh(['run', 'view', String(match.databaseId), '-R', repo, '--log-failed'], {
        allowFail: true,
      });
      return log.output.slice(-LOG_TAIL);
    },
  };
}
