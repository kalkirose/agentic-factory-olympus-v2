// Control-channel writer, shared by every console entry point. Write-then-
// rename so the daemon never reads a half-written command; the daemon's
// feedback is the done/ and rejected/ directories, never a return channel.
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Queues one command file in the control inbox. Returns the file name the
 * daemon will claim — its trace in done/ or rejected/ carries the same name.
 * @param {ReturnType<import('./home.mjs').homePaths>} paths
 * @param {{command: string, actor: string, [k: string]: unknown}} command
 */
export function writeControlCommand(paths, command) {
  if (typeof command.command !== 'string' || typeof command.actor !== 'string') {
    throw new Error('a control command requires command and actor strings');
  }
  const name = `${command.command}-${randomUUID()}`;
  const tmp = join(paths.control, `${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(command) + '\n');
  renameSync(tmp, join(paths.control, `${name}.json`));
  return `${name}.json`;
}
