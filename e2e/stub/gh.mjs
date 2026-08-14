// The stub forge CLI. The instance config's `ghCommand` names it, so the real
// GitHub adapter builds the real argv and parses the real answers back; only
// the network is replaced. The answers are canned but the repository is not:
// the merge is a ref update in the fixture's own bare origin, so everything
// downstream of it (the fetch, the merge commit, the card sweep's reset) works
// on real git objects.
//
// The PR reaches its merge on the second state read, so the ship stage runs
// its check watcher once, stamps the transitions it observes, and then finds
// the merge. State lives in OLYMPUS_E2E_FORGE; every call is logged to
// OLYMPUS_E2E_FORGE_LOG.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const statePath = process.env.OLYMPUS_E2E_FORGE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));

const answer = handle();
log(answer.handled);
if (answer.out) process.stdout.write(answer.out.endsWith('\n') ? answer.out : answer.out + '\n');
save();
process.exit(answer.code ?? 0);

function handle() {
  const [command, sub] = argv;
  if (command === 'api') return api(argv[1]);
  if (command === 'pr' && sub === 'create') return prCreate();
  if (command === 'pr' && sub === 'view') return prView();
  if (command === 'pr' && sub === 'merge') return prMerge();
  if (command === 'run' && sub === 'list') return { handled: 'run-list', out: '[]' };
  if (command === 'run' && sub === 'rerun') return { handled: 'run-rerun', out: '' };
  if (command === 'run' && sub === 'view') return { handled: 'run-view', out: '(no failure log)' };
  return { handled: 'unknown', out: `stub gh: unhandled command ${argv.join(' ')}`, code: 1 };
}

function api(path) {
  if (/^repos\/[^/]+\/[^/]+$/.test(path) && flag('--jq') === '.allow_auto_merge') {
    return { handled: 'preflight-auto-merge', out: 'true' };
  }
  if (path.endsWith('/protection/required_status_checks')) {
    return {
      handled: 'preflight-protection',
      out: JSON.stringify({ strict: true, contexts: [state.check] }),
    };
  }
  const checks = /\/commits\/([^/]+)\/check-runs$/.exec(path);
  if (checks) return checkRuns(checks[1]);
  return { handled: 'unknown-api', out: `stub gh: unhandled api path ${path}`, code: 1 };
}

function prCreate() {
  state.head = flag('--head');
  state.base = flag('--base') ?? state.base;
  return { handled: 'pr-create', out: '' };
}

function prView() {
  const fields = flag('--json') ?? '';
  if (!fields.includes('headRefOid')) {
    return {
      handled: 'pr-view-open',
      out: JSON.stringify({
        number: 1,
        url: 'https://github.com/olympus-e2e/fixture/pull/1',
        state: 'OPEN',
      }),
    };
  }
  state.prStateCalls++;
  // The second read is where the forge merges. The ship stage has stamped one
  // round of check transitions by then, so both paths are exercised.
  if (state.prStateCalls >= 2 && !state.merged) {
    state.merged = true;
    state.mergeSha = merge();
  }
  return {
    handled: state.merged ? 'pr-state-merged' : 'pr-state-open',
    out: JSON.stringify({
      state: state.merged ? 'MERGED' : 'OPEN',
      headRefOid: sha1(`refs/heads/${state.head}`),
      mergeCommit: state.merged ? { oid: state.mergeSha } : null,
      mergeStateStatus: 'CLEAN',
      autoMergeRequest: state.armed ? { enabledAt: '2020-01-01T00:00:00Z' } : null,
    }),
  };
}

function prMerge() {
  state.armed = true;
  return { handled: 'pr-arm-auto-merge', out: '' };
}

function checkRuns() {
  state.checkCalls++;
  const done = state.checkCalls > 1;
  return {
    handled: done ? 'checks-green' : 'checks-pending',
    out: JSON.stringify({
      check_runs: [
        {
          name: state.check,
          status: done ? 'completed' : 'in_progress',
          conclusion: done ? 'success' : null,
          started_at: '2020-01-01T00:00:00Z',
          completed_at: done ? '2020-01-01T00:01:00Z' : null,
        },
      ],
    }),
  };
}

/**
 * Lands the head branch on the base branch of the fixture origin as a real
 * merge commit: two parents, the head's tree, its own sha. A fast-forward
 * would leave the merge sha equal to the head sha, and every reader after the
 * merge (the fetch, the close-out watcher, the card sweep's reset) would be
 * judged against a commit it already held.
 */
function merge() {
  const head = sha1(`refs/heads/${state.head}`);
  const base = sha1(`refs/heads/${state.base}`);
  const tree = sha1(`refs/heads/${state.head}^{tree}`);
  const sha = git([
    '-c',
    'user.name=Fixture Forge',
    '-c',
    'user.email=forge@olympus.invalid',
    'commit-tree',
    tree,
    '-p',
    base,
    '-p',
    head,
    '-m',
    `Merge pull request #1 from ${state.head}`,
  ]);
  git(['update-ref', `refs/heads/${state.base}`, sha]);
  return sha;
}

function flag(name) {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1];
}

function git(args) {
  return execFileSync('git', ['-C', state.origin, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function sha1(ref) {
  return git(['rev-parse', ref]);
}

function save() {
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

function log(handled) {
  if (!process.env.OLYMPUS_E2E_FORGE_LOG) return;
  appendFileSync(
    process.env.OLYMPUS_E2E_FORGE_LOG,
    JSON.stringify({ at: Date.now(), handled, argv }) + '\n',
  );
}
