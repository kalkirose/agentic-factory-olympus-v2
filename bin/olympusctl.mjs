#!/usr/bin/env node
// olympusctl — the console over a daemon home. Reads render from the ledgers
// and stream indexes; commands go through the control inbox. The daemon's
// feedback for a command is the control done/ and rejected/ directories.
//
//   olympusctl status   --home <dir>
//   olympusctl queue    --home <dir>
//   olympusctl frontier --home <dir> --project <name>
//   olympusctl answer   --home <dir> (--run <id> | --seq <n>) (--option <o> | --text <t>)
//   olympusctl arm      --home <dir> --project <name>
//   olympusctl pause    --home <dir> --project <name>
//   olympusctl launch   --home <dir> --project <name> [--card <path>] [--lane <name>]
//   olympusctl kill     --home <dir> --run <id>
//   olympusctl resolve  --home <dir> [--run <id>] --seq <n> [--note <text>]
// --home falls back to OLYMPUSD_HOME; --actor defaults to console:<os user>.
import { userInfo } from 'node:os';
import { homePaths } from '../src/daemon/home.mjs';
import { writeControlCommand } from '../src/daemon/control.mjs';
import {
  renderStatus,
  renderQueue,
  renderFrontier,
  readInstanceConfig,
} from '../src/console/status.mjs';
import { readGraphSource } from '../src/frontier/source.mjs';
import { computeFrontier } from '../src/frontier/graph.mjs';
import { storyRunsByKey } from '../src/telemetry/readers.mjs';
import { openCardParks } from '../src/telemetry/queue.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { home: process.env.OLYMPUSD_HOME ?? null, actor: null };
  const flags = new Map([
    ['--home', 'home'],
    ['--actor', 'actor'],
    ['--project', 'project'],
    ['--run', 'run'],
    ['--seq', 'seq'],
    ['--option', 'option'],
    ['--text', 'text'],
    ['--card', 'card'],
    ['--lane', 'lane'],
    ['--note', 'note'],
  ]);
  for (let i = 0; i < rest.length; i++) {
    const key = flags.get(rest[i]);
    if (!key) fail(`unknown option: ${rest[i]}`);
    opts[key] = rest[++i];
  }
  return { command, opts };
}

function fail(message) {
  console.error(`olympusctl: ${message}`);
  process.exit(2);
}

function need(opts, name) {
  if (opts[name] === undefined || opts[name] === null) fail(`--${name} is required`);
  return opts[name];
}

function queueCommand(paths, command) {
  const file = writeControlCommand(paths, command);
  console.log(`queued: ${file}`);
  console.log(`the daemon claims it into control/done or control/rejected (reason file)`);
}

const { command, opts } = parseArgs(process.argv.slice(2));
if (!command) fail('usage: olympusctl <status|queue|frontier|answer|arm|pause|launch|kill|resolve> --home <dir>');
if (!opts.home) fail('--home (or OLYMPUSD_HOME) is required');
const paths = homePaths(opts.home);
const actor = opts.actor ?? `console:${userInfo().username}`;

if (command === 'status') {
  console.log(renderStatus(paths));
} else if (command === 'queue') {
  console.log(renderQueue(paths));
} else if (command === 'frontier') {
  const project = need(opts, 'project');
  const config = readInstanceConfig(paths);
  const entry = config?.projects[project];
  if (!entry) fail(`unknown project: ${project}`);
  // No fetch: a console reads the clone as it stands; only the daemon moves refs.
  const source = await readGraphSource(paths, project, entry, { fetch: false });
  if (!source) {
    console.log(`${project}: project config has no graph section`);
  } else {
    const frontier = computeFrontier({
      cards: source.cards,
      phases: source.config.graph.phases,
      runs: storyRunsByKey(paths),
      parkedCards: new Set(openCardParks(paths).map((p) => p.card).filter(Boolean)),
    });
    console.log(renderFrontier(project, frontier));
  }
} else if (command === 'answer') {
  const target =
    opts.run !== undefined
      ? { runId: opts.run }
      : { seq: Number(need(opts, 'seq')) };
  if (opts.option === undefined && opts.text === undefined) {
    fail('--option or --text is required');
  }
  queueCommand(paths, {
    command: 'answer',
    actor,
    ...target,
    ...(opts.option !== undefined && { option: opts.option }),
    ...(opts.text !== undefined && { answer: opts.text }),
  });
} else if (command === 'arm' || command === 'pause') {
  queueCommand(paths, { command, actor, project: need(opts, 'project') });
} else if (command === 'launch') {
  queueCommand(paths, {
    command: 'launch',
    actor,
    project: need(opts, 'project'),
    ...(opts.lane !== undefined && { lane: opts.lane }),
    ...(opts.card !== undefined && { card: opts.card }),
  });
} else if (command === 'kill') {
  queueCommand(paths, { command: 'kill', actor, runId: need(opts, 'run') });
} else if (command === 'resolve') {
  queueCommand(paths, {
    command: 'resolve',
    actor,
    seq: Number(need(opts, 'seq')),
    ...(opts.run !== undefined && { runId: opts.run }),
    ...(opts.note !== undefined && { note: opts.note }),
  });
} else {
  fail(`unknown command: ${command}`);
}
