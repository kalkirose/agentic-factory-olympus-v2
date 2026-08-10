// Runner for project-config commands (suite runs, reference lint). The argv
// comes from the project config's `commands` table — the single home for
// every runnable command. The result carries the exit code and an output
// tail; the caller judges the code, this module never does.
import { spawn } from 'node:child_process';

/**
 * Runs one command to completion.
 * @param {string[]} argv
 * @param {{cwd?: string, env?: object, outputLimit?: number}} [opts]
 * @returns {Promise<{code: number|null, signal?: string|null, output: string, error?: string}>}
 *   `code` is null when the command could not run at all (spawn error) —
 *   an environment defect, never a verdict about the tree under test.
 */
export function runCommand(argv, { cwd, env, outputLimit = 4000 } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('runCommand requires a non-empty argv');
  }
  return new Promise((resolve) => {
    // The daemon's own node runtime context must not leak into the command:
    // under an inherited NODE_TEST_CONTEXT a child `node --test` reports
    // exit 0 for a red suite — a false green on the evaluation path.
    const base = { ...process.env, ...env };
    delete base.NODE_TEST_CONTEXT;
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: base,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk) => {
      output = (output + chunk).slice(-outputLimit);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let settled = false;
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ code: null, output, error: error.message });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, output });
    });
  });
}
