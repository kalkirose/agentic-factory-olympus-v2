// Minimal async git runner. Every isolation module goes through this one
// call; an error carries the command and git's stderr.
import { execFile } from 'node:child_process';

/**
 * The output cap every full-text diff read carries.
 *
 * A patch grows with the work, not with the repository, and the runner's
 * default cap is one megabyte. Four packages installed into a project put a
 * lockfile change in the candidate diff and take it past that on their own,
 * and a read that hits the default cap throws inside the stage handler that
 * asked for it. The engine reads a handler throw as a liveness violation, so a
 * run whose whole spectrum came out green goes inert on the size of a file
 * nobody reviews. The cap is stated once, here, and every full-text diff read
 * in the harness carries this number.
 */
export const MAX_DIFF_BYTES = 256 * 1024 * 1024;

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
 * @param {{cwd?: string, maxBuffer?: number, timeout?: number}} [opts]
 *   `maxBuffer` raises the runner's own output cap for the few reads whose size
 *   follows the work rather than the repository. `timeout` bounds the call in
 *   milliseconds, for the callers that hold something another run is waiting
 *   for; the process is killed and the promise rejects. Both absent leave the
 *   runner's defaults, which is what every other caller has always had.
 * @returns {Promise<string>}
 */
export function git(args, { cwd, maxBuffer, timeout } = {}) {
  return run(gitArgv(args), args, { cwd, maxBuffer, timeout });
}

/**
 * Runs one git command with none of the harness's own settings in front of it,
 * in an environment the caller states. The answer is the host's, not this
 * process's — a command that carries `core.longPaths=true` answers the
 * question of whether the host holds that setting with a yes it supplied
 * itself (ADR-0030). `env` defaults to the daemon's own.
 * @param {string[]} args
 * @param {{cwd?: string, env?: object}} [opts]
 * @returns {Promise<string>}
 */
export function gitPlain(args, { cwd, env } = {}) {
  return run([...args], args, { cwd, env });
}

/**
 * Runs one git read whose output the caller would rather have short than not
 * at all, and answers with the bytes that fit.
 *
 * Node stops the stream at exactly `maxBuffer`, kills the child, and hands the
 * bytes it kept back beside the error. A caller that states a cap has already
 * decided what to do with a short answer, so this turns that one error into
 * the answer plus the word for it. Every other failure rejects exactly as
 * `git` does, so a read that could not run is still a throw.
 * @param {string[]} args
 * @param {{cwd?: string, maxBuffer?: number, timeout?: number}} [opts]
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
export function gitCapped(args, { cwd, maxBuffer = MAX_DIFF_BYTES, timeout } = {}) {
  return run(gitArgv(args), args, { cwd, maxBuffer, timeout, capped: true });
}

function run(argv, args, { cwd, env, maxBuffer, timeout, capped = false }) {
  return new Promise((resolve, reject) => {
    // The failure names the command the caller asked for, not the invocation
    // this module built around it.
    const options = {
      cwd,
      ...(env !== undefined && { env }),
      ...(maxBuffer !== undefined && { maxBuffer }),
      ...(timeout !== undefined && { timeout }),
    };
    // `windowsHide` stands at the call, where the process starts and where a
    // reader looks for it, and after the caller's options so none can drop it.
    execFile('git', argv, { ...options, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // The cap the caller stated, reached. The bytes up to it are in
        // `stdout`, so a capped read answers short rather than throwing.
        if (capped && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({ text: stdout, truncated: true });
          return;
        }
        // A killed call is the timeout, and it says so. git's own stderr is
        // empty for one, so without this the reader gets a signal name.
        const why = error.killed
          ? `timed out after ${timeout}ms`
          : String(stderr).trim() || error.message;
        reject(new Error(`git ${args.join(' ')} failed: ${why}`));
      } else {
        resolve(capped ? { text: stdout, truncated: false } : stdout);
      }
    });
  });
}
