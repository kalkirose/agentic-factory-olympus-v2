#!/usr/bin/env node
// olympusd — daemon entry point.
//   olympusd start  --home <dir>   start the daemon detached from this shell
//   olympusd run    --home <dir>   run the daemon in the foreground
//   olympusd stop   --home <dir>   request a clean stop via the control inbox
//   olympusd status --home <dir>   report lock state and the ledger tail
// `run` is the form a service manager wires, because a service manager wants
// the process it supervises in the foreground. `start` is the form a person
// types: it detaches the daemon from the console that gave the command, so
// closing that console cannot take the daemon down (ADR-0050, see
// docs/service-wiring.md).
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Daemon } from '../src/daemon/daemon.mjs';
import { assembleLanes } from '../src/lanes/assemble.mjs';
import { homePaths } from '../src/daemon/home.mjs';
import { writeControlCommand } from '../src/daemon/control.mjs';
import { readLock, pidAlive } from '../src/daemon/lock.mjs';
import { awaitDaemonStart, logTail, spawnDetachedDaemon } from '../src/daemon/launch.mjs';
import { tailEvents } from '../src/ledger/ledger.mjs';

const ENTRY = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  let home = process.env.OLYMPUSD_HOME ?? null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--home') home = rest[++i];
  }
  // Absolute from here on. The started daemon runs from the home rather than
  // from the caller's directory, so a relative home would name a different
  // place in the child than it did in the command.
  return { command, home: home === null ? null : resolve(home) };
}

function usage() {
  console.error('usage: olympusd <start|run|stop|status> --home <dir>');
  process.exit(2);
}

const { command, home } = parseArgs(process.argv.slice(2));
if (!command || !home) usage();
const paths = homePaths(home);

if (command === 'start') {
  const held = readLock(paths.lock);
  if (held && pidAlive(held.pid)) {
    console.error(`olympusd: already running (pid ${held.pid}, home ${home})`);
    process.exit(1);
  }
  const { pid, logs } = spawnDetachedDaemon(ENTRY, home, paths);
  const started = await awaitDaemonStart({ lockPath: paths.lock, pid });
  if (!started.ok) {
    console.error(`olympusd: the daemon did not start (${started.reason})`);
    const tail = logTail(logs.err);
    if (tail !== '') console.error(tail);
    process.exit(1);
  }
  console.log(`olympusd: started (pid ${pid}, home ${home})`);
  console.log(`olympusd: output goes to ${logs.out}`);
} else if (command === 'run') {
  // The reader closes over the daemon, whose config the start reads and every
  // live edit replaces; the lanes resolve each run's forge through it. A
  // breach hands its ticketed escapes to the frontier the same way: the sweep
  // launches the repair when a slot frees, never the breaching run itself.
  const lanes = assembleLanes({
    instanceConfig: () => daemon.config,
    enqueueRepair: ({ project }) => daemon.frontier.queueSweep(project),
  });
  const daemon = new Daemon(home, { handleSignals: true, lanes });
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
  writeControlCommand(paths, { actor: 'cli', command: 'stop' });
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
