#!/usr/bin/env node
// olympus-center — the command center's read-only server over a daemon home.
// Standalone: start it with the home path; the daemon does not know it runs.
//
//   olympus-center --home <dir> [--port <n>] [--host <addr>]
//
// --home falls back to OLYMPUSD_HOME. Defaults: port 4680, host 127.0.0.1.
import { createCenterServer } from '../src/center/server.mjs';

const opts = { home: process.env.OLYMPUSD_HOME ?? null, port: 4680, host: '127.0.0.1' };
const flags = new Map([
  ['--home', 'home'],
  ['--port', 'port'],
  ['--host', 'host'],
]);
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const key = flags.get(args[i]);
  if (!key) {
    console.error(`olympus-center: unknown option: ${args[i]}`);
    process.exit(2);
  }
  opts[key] = args[++i];
}
if (!opts.home) {
  console.error('olympus-center: --home (or OLYMPUSD_HOME) is required');
  process.exit(2);
}
const port = Number(opts.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`olympus-center: invalid port: ${opts.port}`);
  process.exit(2);
}

const server = createCenterServer(opts.home);
server.listen(port, opts.host, () => {
  const address = server.address();
  console.log(`command center: http://${opts.host}:${address.port}/`);
  console.log(`daemon home:    ${opts.home}`);
  console.log('read-only — GET only; commands go through olympusctl');
});
