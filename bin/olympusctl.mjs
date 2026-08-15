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
//   olympusctl launch   --home <dir> --project <name> [--lane <name>]
//                       [--card <path>] [--ticket <path>]
//                       [--resume-from <runId>]
//   olympusctl kill     --home <dir> --run <id>
//   olympusctl resolve  --home <dir> [--run <id>] --seq <n> [--note <text>]
//   olympusctl revoke   --home <dir> --project <name> --fingerprint <f>
//                       --fix <ref> [--note <text>]
// --home falls back to OLYMPUSD_HOME; --actor defaults to console:<os user>.
// Every park states the answer forms it takes, and `queue` prints them per
// item: the options it offers, the free-text slot it wants, or both. Every
// park of a run also takes --option abandon, which closes the run on the
// condition the park recorded.
// A provisioning gate that names a harness finding also takes --option ack: it
// answers the gate and records that finding as known and deferred, by the
// fingerprint `queue` prints beside it. A later gate whose findings are all
// acknowledged answers itself on the record. `status` lists every standing
// acknowledgment; `revoke` ends the one its fingerprint names, and carries the
// fix it stands on. Nothing else ends one — a restart least of all.
// The intake ticket is the repair lane's spec: --lane repair requires
// --ticket, and no other lane accepts one. A repo-relative ticket path names
// a ticket committed in the run worktree; an absolute path names a ticket in
// the daemon home.
// --resume-from names a prior story run whose freeze the new run inherits:
// story lane only, and the prior run supplies the card, so --card is refused
// beside it.
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
    ['--ticket', 'ticket'],
    ['--resume-from', 'resumeFrom'],
    ['--note', 'note'],
    ['--fingerprint', 'fingerprint'],
    ['--fix', 'fix'],
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
if (!command) {
  fail(
    'usage: olympusctl <status|queue|frontier|answer|arm|pause|launch|kill|resolve|revoke> --home <dir>\n' +
      '       answer: (--run <id> | --seq <n>) (--option <o> | --text <t>)\n' +
      '               queue prints the forms each park accepts; every run park\n' +
      '               takes --option abandon, which closes the run\n' +
      '       launch: --project <name> [--lane <name>] [--card <path>] [--ticket <path>]\n' +
      '               [--resume-from <runId>]\n' +
      '       --lane repair requires --ticket; no other lane accepts one\n' +
      '       --resume-from is story-lane only and takes no --card\n' +
      '       revoke: --project <name> --fingerprint <f> --fix <ref> [--note <text>]\n' +
      '               ends the one acknowledgment its fingerprint names; status lists them',
  );
}
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
    fail(
      '--option or --text is required; `olympusctl queue` prints the forms this park ' +
        'accepts, and every run park takes --option abandon',
    );
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
  const project = need(opts, 'project');
  const lane = opts.lane ?? 'story';
  // Every combination is settled here, before the command reaches the inbox.
  // A resume inherits one run's freeze, so it belongs to the story lane and
  // takes that run's card; naming another card would apply a spec to a story
  // it was not born for.
  if (opts.resumeFrom !== undefined) {
    if (lane !== 'story') fail(`--resume-from applies to --lane story only (lane: ${lane})`);
    if (opts.card !== undefined) fail('--resume-from takes its card from the prior run; drop --card');
  }
  // A repair run without its ticket has no spec, and a ticket on any other
  // lane is a typed intent the run would drop in silence.
  if (lane === 'repair' && opts.ticket === undefined) {
    fail('--lane repair requires --ticket <path>');
  }
  if (lane !== 'repair' && opts.ticket !== undefined) {
    fail(`--ticket applies to --lane repair only (lane: ${lane})`);
  }
  queueCommand(paths, {
    command: 'launch',
    actor,
    project,
    ...(opts.lane !== undefined && { lane: opts.lane }),
    ...(opts.card !== undefined && { card: opts.card }),
    ...(opts.ticket !== undefined && { ticket: opts.ticket }),
    ...(opts.resumeFrom !== undefined && { resumeFrom: opts.resumeFrom }),
  });
} else if (command === 'kill') {
  queueCommand(paths, { command: 'kill', actor, runId: need(opts, 'run') });
} else if (command === 'revoke') {
  // One fingerprint, one fix. There is no form that ends every acknowledgment
  // at once: a harness defect nobody fixed is still there after the one beside
  // it was fixed (ADR-0032).
  queueCommand(paths, {
    command: 'revoke',
    actor,
    project: need(opts, 'project'),
    fingerprint: need(opts, 'fingerprint'),
    fix: need(opts, 'fix'),
    ...(opts.note !== undefined && { note: opts.note }),
  });
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
