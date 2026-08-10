// Minimal async git runner. Every isolation module goes through this one
// call; an error carries the command and git's stderr.
import { execFile } from 'node:child_process';

/**
 * Runs one git command and resolves its raw stdout.
 * @param {string[]} args
 * @param {{cwd?: string}} [opts]
 * @returns {Promise<string>}
 */
export function git(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(' ')} failed: ${String(stderr).trim() || error.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}
