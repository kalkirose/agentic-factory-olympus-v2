// Minimal async git runner. Every isolation module goes through this one
// call; an error carries the command and git's stderr.
import { execFile } from 'node:child_process';

/**
 * The argv git is actually invoked with. On Windows every invocation carries
 * long-path support of its own: a run worktree nests a run id under the daemon
 * home and a workspace path under that, which clears 260 characters on an
 * ordinary tree, and git without `core.longPaths` fails those checkouts and
 * removals with "Filename too long". The setting is not taken from the user's
 * global config — the daemon's git runs under whatever account the service
 * manager gives it, which is not reliably the account that config belongs to.
 * @param {string[]} args
 * @param {string} [platform]
 * @returns {string[]}
 */
export function gitArgv(args, platform = process.platform) {
  return platform === 'win32' ? ['-c', 'core.longPaths=true', ...args] : [...args];
}

/**
 * Runs one git command and resolves its raw stdout.
 * @param {string[]} args
 * @param {{cwd?: string}} [opts]
 * @returns {Promise<string>}
 */
export function git(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    // The failure names the command the caller asked for, not the invocation
    // this module built around it.
    execFile('git', gitArgv(args), { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(' ')} failed: ${String(stderr).trim() || error.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}
