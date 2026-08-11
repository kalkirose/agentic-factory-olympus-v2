// Per-run compose stacks. Each run gets its own compose project, named from
// the run id, built from the compose template versioned in the project repo
// (read from the run worktree, so the template rides the same sha as the
// code). The template derives every name and connection string from the env
// this module passes — no fixed host ports, nothing shared between runs.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { resolveArgv } from '../engine/executable.mjs';

const NAME_PREFIX = 'oly-';

/** Derives the compose project name from a run id. Deterministic. */
export function stackName(runId) {
  const safe = runId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+/, '');
  return NAME_PREFIX + safe;
}

/** The env a stack derives itself from. Static template env rides along. */
export function stackEnv({ runId, worktree, extra }) {
  return {
    COMPOSE_PROJECT_NAME: stackName(runId),
    OLYMPUS_RUN_ID: runId,
    OLYMPUS_WORKTREE: worktree,
    ...extra,
  };
}

/**
 * Brings the run's stack up. Returns the compose project name.
 * @param {{runId: string, worktree: string, composeFile: string,
 *   extraEnv?: object, composeCommand: string[], runner?: Function}} opts
 */
export async function stackUp({ runId, worktree, composeFile, extraEnv, composeCommand, runner }) {
  const name = stackName(runId);
  const env = stackEnv({ runId, worktree, extra: extraEnv });
  await runCompose(runner, composeCommand, ['-p', name, '-f', join(worktree, composeFile), 'up', '-d'], env);
  return name;
}

/**
 * Tears the run's stack down, volumes included. Works from the project name
 * alone — compose finds the containers by label, so teardown needs no file
 * and survives worktree removal.
 */
export async function stackDown({ runId, composeCommand, runner }) {
  const name = stackName(runId);
  await runCompose(runner, composeCommand, ['-p', name, 'down', '--volumes', '--remove-orphans'], {
    COMPOSE_PROJECT_NAME: name,
    OLYMPUS_RUN_ID: runId,
  });
}

function runCompose(runner, composeCommand, args, env) {
  if (!Array.isArray(composeCommand) || composeCommand.length === 0) {
    throw new Error('stack requires a composeCommand argv');
  }
  const [cmd, ...prefix] = composeCommand;
  if (runner) return runner(cmd, [...prefix, ...args], env);
  const childEnv = { ...process.env, ...env };
  // The compose command names a tool; the host decides which file that is.
  const spec = resolveArgv([cmd, ...prefix, ...args], { env: childEnv });
  return new Promise((resolve, reject) => {
    execFile(
      spec.file,
      spec.args,
      {
        env: childEnv,
        windowsHide: true,
        ...(spec.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${cmd} ${args.join(' ')} failed: ${String(stderr).trim() || error.message}`));
        } else {
          resolve();
        }
      },
    );
  });
}
