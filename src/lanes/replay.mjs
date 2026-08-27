// What the project's `credentials[].layers` declaration is worth at run time,
// in the two places it is read.
//
// **Mechanical attribution.** A Tier-1 layer the project declares a credential
// for cannot judge the tree when that variable is absent from the host. Its red
// says so on the layer result itself — the variable by name — before a seat
// reasons about it. A green layer is never annotated: the absence did not
// matter, whatever the declaration says.
//
// **The replay probe.** A judgment seat is spawned with the machine's
// credentials stripped (ADR-0023), so it cannot re-run the layer whose red it
// is classifying, and a credential-dependent red used to be a red no seat could
// reproduce. The probe closes that without moving one secret into a seat: the
// seat names a Tier-1 layer of its own run, the daemon runs that layer's
// command in the run's stack with the full environment, and the seat is briefed
// again with the output. The seat asks for a layer, never for a command line
// and never for a value; the request form carries no environment field at all.
//
// The rules the probe refuses on are closed, and each of them is a rule about
// what the seat may reach rather than about what it may say:
//
// - a name that is not a Tier-1 layer of this project's own gate table;
// - a layer that needs a credential this host does not declare probe-eligible;
// - a request past the round budget of the seat session.
//
// A seat outside the judgment set never reaches the probe at all: the set is
// closed here and a call for any other seat throws, because that is a defect in
// the caller and not a state of a run.
//
// Every request is stamped, the refused ones included. The stamp carries the
// exit code and never the output: the output is minutes of a build, so it goes
// to a file beside the run's reports, past a redaction of every value this host
// declares a secret. A command that prints a key therefore hands the seat a
// redaction token and not the key.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { probeOutputPath } from '../daemon/home.mjs';
import { matchesSecret } from '../engine/supervise.mjs';
import { assertProbeRefusal } from '../ledger/registry.mjs';
import { runCommand } from './exec.mjs';
import { ACTOR, runEvents } from './shared.mjs';

/**
 * The seats the probe is open to: the two that judge a red they did not
 * produce and cannot otherwise reproduce. Closed like the seat map itself — a
 * seat enters by a decision recorded in an ADR, never from a call site.
 */
export const PROBE_SEATS = new Set(['verdict-triage', 'fury-verifier']);

/**
 * Replay rounds one seat session may spend. Each round costs a whole Tier-1
 * layer run and a fresh seat session on top of it, so the budget is small and
 * stated to the seat: a seat that knows it has two asks spends them on the
 * question it cannot settle any other way.
 */
export const PROBE_ROUNDS = 2;

// What the seat is handed of a replay's output. Larger than a layer result's
// ledger tail, because reproducing the red is the whole purpose, and bounded,
// because it lands in a prompt.
const PROBE_OUTPUT = 12000;

// The shortest value the redaction will replace. A three-character credential
// would match half the words in a build log and redact the evidence the probe
// was run to produce; a value below this floor is not a secret worth a
// substitution that damages the output.
const REDACT_FLOOR = 8;

/**
 * The probe request a judgment seat's report may carry, as a report-schema
 * property. One layer and the reason for it: no command line, no arguments, no
 * environment. A seat that wants nothing omits the field.
 */
export const PROBE_REQUEST_PROPERTY = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    layer: { type: 'string', description: 'the Tier-1 layer to re-run' },
    reason: { type: 'string', description: 'what the re-run would settle' },
  },
  required: ['layer', 'reason'],
});

/**
 * Whether a report is a request rather than a verdict. A report that asks for
 * a probe it can still have is superseded by the report of the round its
 * answer opens, so the caller's own work-product checks do not judge it: they
 * would spend the corrective invocation on findings the seat has not written
 * yet, and then fail the seat for not writing them.
 *
 * The request itself answers to no check here. Its shape is the schema's, and
 * every rule about what it may name is the daemon's, enforced where the probe
 * runs and stamped where it is refused — a name the rules turn down costs the
 * same round a correction would have cost, and unlike a correction it leaves a
 * record.
 */
export function asksForProbe(report, budget) {
  return budget > 0 && Boolean(report?.probe);
}

/**
 * The environment variables a Tier-1 layer declares and this host does not
 * hold. An empty value counts as absent, because a variable set to nothing
 * fails every command that reads it and reads as wired to everything that only
 * asks whether the name exists.
 * @param {Array<object>} credentials the project config's `credentials`
 * @param {string} layerName
 * @param {object} [env] the run's stack env, over the daemon's own
 * @returns {string[]} the missing variable names, in declaration order
 */
export function absentCredentials(credentials, layerName, env) {
  const held = { ...process.env, ...env };
  return declaredFor(credentials, layerName)
    .filter((entry) => {
      const value = held[entry.env];
      return typeof value !== 'string' || value.trim().length === 0;
    })
    .map((entry) => entry.env);
}

/** The credential entries a Tier-1 layer declares. */
function declaredFor(credentials, layerName) {
  return (credentials ?? []).filter(
    (entry) => Array.isArray(entry?.layers) && entry.layers.includes(layerName),
  );
}

/**
 * One seat session, with the replay rounds it may spend woven through it.
 *
 * `invoke({label, replays, budget})` runs the seat once and answers
 * `{report}` or `{fail}` — it is the caller's own seat machinery, because the
 * two judgment seats reach their reports by different routes and neither of
 * them is this module's business. A report that asks for a probe is not a
 * final report: the probe runs, and the same caller is asked again under the
 * next round's label with the answer in `replays`.
 *
 * Every round re-derives itself from the ledger and the files it names, so a
 * daemon that died between two rounds resumes into the round it was in rather
 * than starting the seat again.
 *
 * @param {object} ctx the stage context
 * @param {{seat: string, cycle: number, label: string,
 *   base: {config: object, worktree: string, env?: object}, cap?: number}} spec
 * @param {(round: {label: string, replays: object[], budget: number}) =>
 *   Promise<{report?: object, fail?: object}>} invoke
 */
export async function withReplayRounds(ctx, spec, invoke) {
  if (!PROBE_SEATS.has(spec.seat)) {
    throw new Error(`the replay probe is closed to the ${spec.seat} seat`);
  }
  const cap = spec.cap ?? PROBE_ROUNDS;
  for (;;) {
    const replays = priorReplays(ctx, spec);
    const budget = Math.max(0, cap - replays.length);
    const outcome = await invoke({ label: roundLabel(spec.label, replays.length), replays, budget });
    const request = outcome?.report?.probe;
    if (!request) return outcome;
    if (budget === 0) {
      // The round budget is spent and the seat asked anyway. The refusal is
      // stamped like every other request and takes no round, so the report the
      // seat wrote with it stands and the loop ends here. The stamp is read
      // from the ledger and not from `replays`, which holds the rounds and
      // leaves this refusal out by definition: a guard that read the rounds
      // would find nothing and write the same stamp at every stage re-entry.
      if (!askedPastBudget(ctx, spec)) {
        stampProbe(ctx, spec, {
          layer: request.layer,
          round: replays.length,
          refused: 'no-rounds-left',
        });
      }
      return outcome;
    }
    await runReplay(ctx, spec, request, replays.length + 1);
  }
}

/**
 * The report label of one round. Round zero keeps the label the seat has always
 * written under, so a run that asks for no probe writes exactly the files it
 * wrote before this existed.
 */
export function roundLabel(label, round) {
  return round === 0 ? label : `${label}-p${round}`;
}

/**
 * The label the final report of a seat session is under, read from the ledger.
 * A caller that rebuilds a finished step from its report needs the round the
 * step ended on, not the round it started at.
 */
export function finalReplayLabel(ctx, { seat, cycle, label }) {
  return roundLabel(label, priorReplays(ctx, { seat, cycle }).length);
}

/**
 * What this seat session has already asked for, in order: a replay that ran,
 * with its exit code and the output the seat was given, or one the rules
 * refused, with the reason. A request past the round budget is not a round and
 * is not here.
 */
function priorReplays(ctx, { seat, cycle }) {
  return probeStamps(ctx, { seat, cycle })
    .filter((e) => e.refused !== 'no-rounds-left')
    .map((e) =>
      e.refused
        ? { layer: e.layer, refused: e.refused, ...(e.detail && { detail: e.detail }) }
        : { layer: e.layer, exit: e.exit ?? null, output: readOutput(e.record) },
    );
}

/** Every probe stamp of one seat session, refusals included. */
function probeStamps(ctx, { seat, cycle }) {
  return runEvents(ctx).filter(
    (e) => e.event === 'probe-run' && e.requestedBy === seat && e.cycle === cycle,
  );
}

/** Whether this seat session already asked once past its round budget. */
function askedPastBudget(ctx, spec) {
  return probeStamps(ctx, spec).some((e) => e.refused === 'no-rounds-left');
}

function readOutput(path) {
  if (typeof path !== 'string') return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // The file went with an archive, or never landed. The exit code the stamp
    // carries is still the answer; the seat is told the output is gone.
    return '(the probe output is no longer on disk)';
  }
}

/**
 * One replay: admit it, run it, write what the seat may read, stamp it. Every
 * path through here stamps exactly once, so a round is never spent in silence.
 */
async function runReplay(ctx, spec, request, round) {
  const { config, worktree, env } = spec.base;
  const layers = config.gates?.tier1 ?? [];
  const layer = layers.find((entry) => entry.name === request.layer);
  if (!layer) {
    stampProbe(ctx, spec, {
      layer: request.layer,
      round,
      refused: 'not-a-tier1-layer',
      detail: `the gate table names: ${layers.map((entry) => entry.name).join(', ') || '(none)'}`,
    });
    return;
  }
  const eligible = new Set(ctx.probeCredentials ?? []);
  const barred = declaredFor(config.credentials, layer.name)
    .map((entry) => entry.env)
    .filter((name) => !eligible.has(name));
  if (barred.length > 0) {
    stampProbe(ctx, spec, {
      layer: layer.name,
      round,
      refused: 'credential-not-eligible',
      credentials: barred,
      detail: `this host declares no replay for: ${barred.join(', ')}`,
    });
    return;
  }
  // The same spawn the spectrum makes of this layer: the run's own tree, the
  // run's stack env, and the host environment whole underneath it. The seat's
  // environment is untouched by any of it.
  const run = await runCommand(config.commands[layer.command], {
    cwd: worktree,
    env,
    outputLimit: PROBE_OUTPUT,
  });
  const path = probeOutputPath(ctx.paths, ctx.runId, `${spec.seat}-c${spec.cycle}-p${round}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, redactSecrets(run.output ?? '', secretValues(ctx, spec)), 'utf8');
  stampProbe(ctx, spec, {
    layer: layer.name,
    command: layer.command,
    round,
    exit: run.code,
    record: path,
    ...(run.error && { error: run.error }),
  });
}

function stampProbe(ctx, spec, { refused, ...fields }) {
  return ctx.store.append('probe-run', {
    actor: ACTOR,
    cycle: spec.cycle,
    requestedBy: spec.seat,
    ...fields,
    ...(refused && { refused: assertProbeRefusal(refused) }),
  });
}

/**
 * The name and value of every variable the probe's own environment holds that
 * this host calls a secret: the names it declares probe-eligible, the patterns
 * it strips from seats (ADR-0023), and the variables the project declares
 * credentials for. Longest value first, so a value that contains another is
 * replaced before the shorter one can cut it in half.
 */
function secretValues(ctx, spec) {
  const held = { ...process.env, ...spec.base.env };
  const eligible = new Set(ctx.probeCredentials ?? []);
  const declared = new Set((spec.base.config.credentials ?? []).map((entry) => entry.env));
  const patterns = ctx.secretEnv ?? [];
  const pairs = [];
  for (const [name, value] of Object.entries(held)) {
    if (typeof value !== 'string' || value.length < REDACT_FLOOR) continue;
    if (eligible.has(name) || declared.has(name) || matchesSecret(name, patterns)) {
      pairs.push([name, value]);
    }
  }
  return pairs.sort((a, b) => b[1].length - a[1].length);
}

/** Replaces every secret value in the text with the name it came from. */
export function redactSecrets(text, pairs) {
  let out = text;
  for (const [name, value] of pairs) out = out.split(value).join(`[redacted:${name}]`);
  return out;
}

/**
 * What a seat is told about the probe before it writes its report: what it may
 * ask for, how to ask, what it costs, and what it will never get.
 */
export function probeOfferLines({ replays, budget, layers }) {
  const lines = [];
  if (replays.length > 0) {
    lines.push('Replay probes you asked for, and what they answered:');
    for (const replay of replays) {
      if (replay.refused) {
        lines.push(
          `- ${replay.layer}: refused (${replay.refused})` +
            (replay.detail ? ` — ${replay.detail}` : ''),
        );
        continue;
      }
      lines.push(
        `- ${replay.layer}: exit ` +
          (replay.exit === null ? '(the command could not run)' : String(replay.exit)),
        replay.output || '(no output)',
      );
    }
  }
  if (budget <= 0) {
    lines.push('No replay probe is left in this session. Judge on the evidence you hold.');
    return lines;
  }
  lines.push(
    'You may ask for one Tier-1 layer of this run to be run again, and read its output.',
    'To ask, put "probe": {"layer": "<name>", "reason": "<what it settles>"} in your report and ' +
      'stop there. The daemon runs the layer and asks you again with the output.',
    `Layers you may name: ${layers.join(', ')}.`,
    `Probes left in this session: ${budget}.`,
    'The layer runs with this host\'s credentials. You get the output only: no environment ' +
      'value ever reaches you, and every value this host calls a secret is replaced in the ' +
      'output by the name it came from.',
    'Ask only where the evidence you hold cannot settle the question. Each probe costs the ' +
      'whole run of that layer.',
  );
  return lines;
}
