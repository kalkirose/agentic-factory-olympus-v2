#!/usr/bin/env node
// olympusd — daemon entry point.
//   olympusd start  --home <dir>   run the daemon in the foreground
//   olympusd stop   --home <dir>   request a clean stop via the control inbox
//   olympusd status --home <dir>   report lock state and the ledger tail
// The OS service manager owns daemonization and restarts (see
// docs/service-wiring.md).
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Daemon } from '../src/daemon/daemon.mjs';
import { homePaths } from '../src/daemon/home.mjs';
import { readLock, pidAlive } from '../src/daemon/lock.mjs';
import { tailEvents } from '../src/ledger/ledger.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  let home = process.env.OLYMPUSD_HOME ?? null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--home') home = rest[++i];
  }
  return { command, home };
}

function usage() {
  console.error('usage: olympusd <start|stop|status> --home <dir>');
  process.exit(2);
}

const { command, home } = parseArgs(process.argv.slice(2));
if (!command || !home) usage();
const paths = homePaths(home);

if (command === 'start') {
  const daemon = new Daemon(home, { handleSignals: true });
  daemon.onStopped = () => process.exit(0);
  const { runsResumed } = await daemon.start();
  console.log(`olympusd: started (pid ${process.pid}, home ${home})`);
  if (runsResumed.length > 0) console.log(`olympusd: resumed runs: ${runsResumed.join(', ')}`);
  // The daemon lives on its watchers; keep the loop open explicitly.
  setInterval(() => {}, 1 << 30);
} else if (command === 'stop') {
  const lock = readLock(paths.lock);
  if (!lock || !pidAlive(lock.pid)) {
    console.log('olympusd: not running');
    process.exit(0);
  }
  // Write-then-rename so the daemon never reads a half-written command.
  const name = `stop-${randomUUID()}`;
  const tmp = join(paths.control, `${name}.tmp`);
  writeFileSync(tmp, JSON.stringify({ actor: 'cli', command: 'stop' }) + '\n');
  renameSync(tmp, join(paths.control, `${name}.json`));
  console.log('olympusd: stop requested via control inbox');
} else if (command === 'status') {
  const lock = readLock(paths.lock);
  const running = lock !== null && pidAlive(lock.pid);
  console.log(running ? `olympusd: running (pid ${lock.pid}, since ${lock.startedAt})` : 'olympusd: not running');
  for (const event of tailEvents(paths.instanceLedger, 5)) {
    console.log(`  ${event.seq} ${event.ts} ${event.event}`);
  }
} else {
  usage();
}
