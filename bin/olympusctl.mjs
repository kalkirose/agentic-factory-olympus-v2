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
//   olympusctl hold     --home <dir> (--run <id> | --project <name> | --all)
//   olympusctl release  --home <dir> (--run <id> | --project <name> | --all)
//   olympusctl launch   --home <dir> --project <name> [--lane <name>]
//                       [--card <path>] [--ticket <path>] [--escape <n>]
//                       [--resume-from <runId>]
//   olympusctl kill     --home <dir> --run <id>
//   olympusctl resolve  --home <dir> [--run <id>] --seq <n> [--note <text>]
//   olympusctl revoke   --home <dir> --project <name> --fingerprint <f>
//                       --fix <ref> [--note <text>]
//   olympusctl fixed    --home <dir> --escape <n> --evidence <text>
//                       [--note <text>]
//   olympusctl escape   --home <dir> --project <name> --defect <text>
//                       [--category <c>] [--source <s>] [--pr <n>]
//                       [--merge <sha>] [--note <text>]
// --home falls back to OLYMPUSD_HOME; --actor defaults to
// console:<os user>:<session>, where the session half separates two operator
// sessions on one login (src/console/identity.mjs; OLYMPUS_CONSOLE_ID names
// one). Every queued command prints the stamp it wrote.
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
// `hold` stops the stage chain and interrupts nothing: every run finishes the
// stage it is in and stops at the boundary, so the factory drains itself to a
// moment with no live seat. `release` enters the deferred stage of every run
// the release frees. A hold survives a restart, which is what makes it the
// restart recipe: hold, wait for the runs to reach a boundary or a park, stop,
// start, release. --all holds the instance, --project one project and --run one
// run; the three are separate statements, the widest one standing governs, and
// a release ends the one it names. So a project release leaves a run somebody
// held by hand held, and a per-run release under a project hold is refused with
// the hold that is actually stopping the run. `status` marks a held run with
// the stage it did not enter, and names who held it and when when the hold is
// the run's own.
// The intake ticket is the repair lane's spec: --lane repair requires
// --ticket, and no other lane accepts one. A repo-relative ticket path names
// a ticket committed in the run worktree; an absolute path names a ticket in
// the daemon home.
// A repair launch carries the escape it repairs, and the close-out stamps that
// escape fixed when the repair merges. --escape names it; without the option
// the daemon reads it off the ticket path when an open escape already names
// that file. `fixed` is the other route: it marks an escape fixed out of band,
// takes the evidence it stands on, and stamps an event of its own — an
// operator's statement is never filed as a repair run's fix-back.
// `escape` is the intake at the other end: one defect somebody found in the
// product after it shipped. The record carries the project it is in and a
// repair ticket of its own, so the next sweep owes the repair, exactly as it
// does for a defect the harness found itself. --pr or --merge names the merge
// it came in on; when that merge was a ship which carried its certification
// over a moved base, the record is filed under the closed fast-path kind and
// attributed to that run, which is what the standing fast-path tripwire counts.
// --resume-from names a prior story run whose freeze the new run inherits:
// story lane only, and the prior run supplies the card, so --card is refused
// beside it.
import { homePaths } from '../src/daemon/home.mjs';
import { writeControlCommand } from '../src/daemon/control.mjs';
import { consoleActor } from '../src/console/identity.mjs';
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
    ['--escape', 'escape'],
    ['--evidence', 'evidence'],
    ['--resume-from', 'resumeFrom'],
    ['--note', 'note'],
    ['--fingerprint', 'fingerprint'],
    ['--fix', 'fix'],
    ['--defect', 'defect'],
    ['--category', 'category'],
    ['--source', 'source'],
    ['--pr', 'pr'],
    ['--merge', 'merge'],
  ]);
  // The one option that carries no value: a scope is the instance or it is not.
  const switches = new Map([['--all', 'all']]);
  for (let i = 0; i < rest.length; i++) {
    const flag = switches.get(rest[i]);
    if (flag) {
      opts[flag] = true;
      continue;
    }
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

/** An escape is named by the seq of its record in the escapes ledger. */
function escapeSeq(value) {
  const seq = Number(value);
  if (!Number.isInteger(seq) || seq < 1) {
    fail(`--escape takes the escape's seq in the escapes ledger (got: ${value})`);
  }
  return seq;
}

/** A request is named by the number the forge gave it. */
function prNumber(value) {
  const pr = Number(value);
  if (!Number.isInteger(pr) || pr < 1) {
    fail(`--pr takes the request number the forge gave it (got: ${value})`);
  }
  return pr;
}

function queueCommand(paths, command) {
  const file = writeControlCommand(paths, command);
  // The stamp is printed because it is derived: this is where an operator
  // reads which session the ledger will name, and it is the id to quote when
  // two sessions have to be told apart afterwards.
  console.log(`queued: ${file} as ${command.actor}`);
  console.log(`the daemon claims it into control/done or control/rejected (reason file)`);
}

const { command, opts } = parseArgs(process.argv.slice(2));
if (!command) {
  fail(
    'usage: olympusctl <status|queue|frontier|answer|arm|pause|hold|release|launch|kill|resolve|revoke|fixed|escape> --home <dir>\n' +
      '       answer: (--run <id> | --seq <n>) (--option <o> | --text <t>)\n' +
      '               queue prints the forms each park accepts; every run park\n' +
      '               takes --option abandon, which closes the run\n' +
      '       hold:   (--run <id> | --project <name> | --all)\n' +
      '               every run finishes its current stage and stops there;\n' +
      '               release enters the stage each held run did not enter\n' +
      '               a project release leaves a run held with --run held\n' +
      '       launch: --project <name> [--lane <name>] [--card <path>] [--ticket <path>]\n' +
      '               [--escape <n>] [--resume-from <runId>]\n' +
      '       --lane repair requires --ticket; no other lane accepts one\n' +
      '       --escape is repair-lane only; without it the ticket path names\n' +
      '               the escape when an open escape record already names it\n' +
      '       --resume-from is story-lane only and takes no --card\n' +
      '       revoke: --project <name> --fingerprint <f> --fix <ref> [--note <text>]\n' +
      '               ends the one acknowledgment its fingerprint names; status lists them\n' +
      '       fixed:  --escape <n> --evidence <text> [--note <text>]\n' +
      '               marks an escape fixed out of band; the evidence is required\n' +
      '       escape: --project <name> --defect <text> [--category <c>] [--source <s>]\n' +
      '               [--pr <n>] [--merge <sha>] [--note <text>]\n' +
      '               records one post-merge defect; --pr or --merge names the\n' +
      '               merge it came in on, and a fast-path ship is attributed',
  );
}
if (!opts.home) fail('--home (or OLYMPUSD_HOME) is required');
const paths = homePaths(opts.home);
const actor = opts.actor ?? consoleActor();

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
} else if (command === 'hold' || command === 'release') {
  // One scope per command. `--all` is the instance, `--project` is one project
  // and `--run` is one run; naming two would leave the operator guessing which
  // of them the daemon acted on, and no two of them are the same statement.
  if (opts.all === true && opts.project !== undefined) {
    fail('--all holds the instance; drop --project');
  }
  if (opts.run !== undefined && (opts.project !== undefined || opts.all === true)) {
    fail('--run holds one run; drop --project and --all');
  }
  if (opts.all !== true && opts.project === undefined && opts.run === undefined) {
    fail(`${command} takes --run <id>, --project <name> or --all`);
  }
  queueCommand(paths, {
    command,
    actor,
    ...(opts.run !== undefined
      ? { runId: opts.run }
      : opts.all === true
        ? { all: true }
        : { project: opts.project }),
  });
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
  // The escape rides the run payload, and the close-out stamps that escape
  // fixed when the repair merges. On any other lane nothing would read it.
  if (lane !== 'repair' && opts.escape !== undefined) {
    fail(`--escape applies to --lane repair only (lane: ${lane})`);
  }
  queueCommand(paths, {
    command: 'launch',
    actor,
    project,
    ...(opts.lane !== undefined && { lane: opts.lane }),
    ...(opts.card !== undefined && { card: opts.card }),
    ...(opts.ticket !== undefined && { ticket: opts.ticket }),
    ...(opts.escape !== undefined && { escape: escapeSeq(opts.escape) }),
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
} else if (command === 'fixed') {
  // The honest route for a defect somebody took out of the product without
  // the factory: it ends the escape, and it says so in an event of its own,
  // with the evidence a later reader stands on. Nothing derives that evidence
  // — a mark with nothing behind it retires a defect on somebody's memory.
  const evidence = need(opts, 'evidence');
  if (evidence.trim().length === 0) fail('--evidence cannot be empty');
  queueCommand(paths, {
    command: 'fixed',
    actor,
    escape: escapeSeq(need(opts, 'escape')),
    evidence,
    ...(opts.note !== undefined && { note: opts.note }),
  });
} else if (command === 'escape') {
  // The intake for a defect the factory did not catch. The category and the
  // detection source have the defaults a human report almost always wants, and
  // both stay statable: an escape a nightly run found is not a human report,
  // and the ledger has to be able to say so.
  const defect = need(opts, 'defect');
  if (defect.trim().length === 0) fail('--defect cannot be empty');
  queueCommand(paths, {
    command: 'escape',
    actor,
    project: need(opts, 'project'),
    defectLine: defect,
    ...(opts.category !== undefined && { category: opts.category }),
    ...(opts.source !== undefined && { detectionSource: opts.source }),
    ...(opts.pr !== undefined && { pr: prNumber(opts.pr) }),
    ...(opts.merge !== undefined && { mergeSha: opts.merge }),
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
