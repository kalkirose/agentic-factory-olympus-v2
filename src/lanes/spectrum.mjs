// The Tier-1 spectrum runner: every layer the cycle plan asks for runs to
// completion and the spectrum reports the union of reds. A layer whose
// prerequisite failed reports not-runnable, attributed to the root red —
// never a red of its own. The flake filter is process policy: each red layer
// re-runs once, red-only; a green re-run stamps a flake event, never a
// finding. Reds that survive the re-run are persistent reds — only these
// enter triage.
//
// The cycle plan decides which layers run (ADR-0022). The first cycle of an
// implementation pass has nothing proven, so it runs every layer. A later
// cycle judges a tree a repair round, a re-freeze, or an operational fix
// touched, so it runs the targeted set — every layer the pass has not proven
// green, plus every layer downstream of one of those through `needs` — and
// carries the remaining greens forward. A carried result is marked `carried`,
// so no result of an older sha reads as a fresh proof.
//
// Each execution stamps its start as well: a layer is one process that can
// hold a run for an hour, and before that stamp the ledger said nothing
// between the route that ordered the cycle and the first result, so a run
// inside a long layer read exactly like a run that had stopped. The stamp is a
// record and never state — the resume reads `layer-result` as it always did
// (ADR-0034).
//
// Layer results stamp per layer under the cycle number, so a daemon restart
// mid-spectrum skips the layers already judged and re-runs only the rest. A
// layer stamped under this cycle reports `run` whatever the plan says: the
// stamp is the fact. Deterministic re-runs are unlimited by doctrine; they
// judge nothing.
//
// A red the host explains gets that explanation on the result. A layer the
// project declares a credential for cannot judge the tree when the variable is
// absent, so its red carries the missing variable by name — before triage, and
// without a seat reasoning about it (ADR-0042).
//
// Every attempt also stamps its ending. An attempt that judged the tree stamps
// `layer-result`; every other ending stamps `layer-abandoned` with the reason
// and what the attempt had printed. The stamp is written at one settle point
// that every ending of an attempt leaves through, so a path cannot end an
// attempt without stamping — including a path written later (ADR-0034).
//
// Every attempt is also measured. What the layer's process tree peaked at
// rides its record, and an attempt that died of that peak is classed there and
// then: exit 134 and its kin are a mechanical fact, and a run that dies of
// memory used to reach a judgment seat as a generic red for the seat to
// attribute — twice, on two runs that were then abandoned (ADR-0045). The
// classification happens at the same one settle point the stamp does, so it
// covers every ending an attempt has rather than the endings somebody
// remembered.
import { commandLogPath } from '../daemon/home.mjs';
import { assertDefectKind, assertAbandonReason } from '../ledger/registry.mjs';
import { runCommand } from './exec.mjs';
import { exhaustionOf } from './resources.mjs';
import { absentCredentials } from './replay.mjs';
import { runEvents, ACTOR } from './shared.mjs';

const OUTPUT_TAIL = 1500;
// What a red layer that ran in parts records beyond that tail. A layer command
// is often a sequence — a suite runner with steps — and the tail of one long
// stream is whatever ran last, so a red in the middle of the sequence reaches
// triage as the green minutes that followed it. A command that says where its
// parts begin (`::olympus part`, see exec.mjs) gets the failing part recorded
// under its own name. The budget is the whole record's, shared between the
// parts kept, and never cut below the floor.
//
// A red whose stream outgrew the tail and named no part is the case the parts
// exist to answer: the record holds whatever ran last and the failure may not
// be in it. Every attempt now streams its whole output to a file in the run
// directory (ADR-0043), so what the record holds is the tail *and* the file,
// and that case is open only when the file is not there either — a caller with
// no file at all, or a stream that outgrew the file's own cap. That is when
// the record carries the closed word for the defect (`layer-log-truncated`),
// so the word keeps meaning what it always meant: output the harness cannot
// produce, counted where the harness observes it instead of waiting for a
// triage seat to write a sentence about it (ADR-0008).
const PART_TAIL = 6000;
const PART_FLOOR = 500;
// What a layer is allowed to attempt: the run, and the flake filter's one
// red-only re-run. The bound is process policy and lives here alone, because
// the attempt loop and the settle point both read it.
const ATTEMPTS = 2;

/**
 * Runs one verdict cycle's Tier-1 spectrum.
 * @param {object} ctx run-engine handler context
 * @param {{layers: Array<{name: string, command: string, needs?: string[]}>,
 *   commands: Record<string, string[]>, cwd: string, env?: object,
 *   cycle: number, sha: string, run?: Set<string>|null,
 *   prior?: Map<string, object>|null, confirmation?: boolean,
 *   credentials?: Array<object>, exec?: typeof runCommand}} opts
 *   `run` names the layers this cycle executes; every other layer carries its
 *   `prior` green forward. Both absent means the full spectrum.
 *   `credentials` is the project's credential declaration; a layer it names
 *   that this host cannot supply has its red attributed to the missing
 *   variable, on the result itself.
 *   `exec` is the command seam. A runner that throws, or one that answers
 *   nothing at all, is a real ending of an attempt that no portable test can
 *   stage with a child process, so the call the condition breaks is injectable.
 * @returns {Promise<{results?: Array<{layer: string, status: string,
 *   mode: string, attributedTo?: string, output?: string, log?: string,
 *   credentialAbsent?: string[], resources?: object, exhaustion?: object,
 *   parts?: Array<{name: string, output: string}>}>, error?: string}>}
 *   `log` is the file holding that layer's whole output, for the red that has
 *   one: the tail and the parts are the summary, the file is the text.
 *   `resources` is what the layer's process tree peaked at, and `exhaustion`
 *   is the harness's own attribution of a red that died of it — both facts
 *   about the attempt, decided before any seat reads the output (ADR-0045).
 *   `error` is set when a layer command could not run at all — an
 *   environment defect, never a verdict about the tree.
 */
export async function runSpectrum(
  ctx,
  {
    layers,
    commands,
    cwd,
    env,
    cycle,
    sha,
    run = null,
    prior = null,
    confirmation = false,
    credentials = [],
    exec = runCommand,
  },
) {
  const stamped = new Map(
    runEvents(ctx)
      .filter((e) => e.event === 'layer-result' && e.cycle === cycle)
      .map((e) => [e.layer, e]),
  );
  const mark = confirmation ? { confirmation: true } : {};
  const status = new Map();
  const results = [];
  for (const layer of layers) {
    let record = stamped.get(layer.name);
    let mode = 'run';
    if (!record) {
      const carried = carriedResult(layer, run, prior);
      if (carried) {
        record = carried;
        mode = 'carried';
      } else {
        const blocked = (layer.needs ?? []).find((need) => status.get(need)?.status !== 'green');
        if (blocked) {
          // A layer that never started owes no pairing: the stamp is the
          // layer's, not an attempt's, and it carries no attempt number.
          record = stampLayer(ctx, 'layer-result', {
            cycle,
            layer: layer.name,
            status: 'not-runnable',
            attributedTo: rootRed(status, blocked),
            sha,
            ...mark,
          });
        } else {
          const outcome = await runLayer(ctx, {
            layer,
            commands,
            cwd,
            env,
            cycle,
            sha,
            mark,
            exec,
            // Read before the layer runs, so the attribution is a fact about
            // the host this attempt started on rather than one about the host
            // at the moment somebody read the record.
            absent: absentCredentials(credentials, layer.name, env),
          });
          if (outcome.error) return { error: outcome.error };
          record = outcome.record;
        }
      }
    }
    status.set(layer.name, record);
    results.push({
      layer: layer.name,
      status: record.status,
      mode,
      ...(record.attributedTo && { attributedTo: record.attributedTo }),
      ...(record.credentialAbsent?.length > 0 && { credentialAbsent: record.credentialAbsent }),
      ...(record.resources && { resources: record.resources }),
      ...(record.exhaustion && { exhaustion: record.exhaustion }),
      ...(record.output && { output: record.output }),
      ...(record.log && { log: record.log }),
      ...(record.parts?.length > 0 && { parts: record.parts }),
    });
  }
  return { results };
}

/**
 * The result a cycle carries for a layer its plan left out, or null when the
 * layer must run. Only a proven green carries: a layer the cycles before left
 * red, not-runnable, or unjudged has no green to carry.
 */
function carriedResult(layer, run, prior) {
  if (!run || run.has(layer.name)) return null;
  const previous = prior?.get(layer.name);
  return previous?.status === 'green' ? previous : null;
}

/**
 * One layer, run until an attempt judges it or the attempts run out. The flake
 * filter is the loop: a first red is never the layer's answer, so it is
 * replaced by one red-only re-run and stamped as the replaced attempt it is.
 */
async function runLayer(ctx, { layer, commands, cwd, env, cycle, sha, mark, exec, absent }) {
  const argv = commands[layer.command];
  let previous = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const settled = await runAttempt(ctx, {
      argv,
      layer,
      cwd,
      env,
      cycle,
      sha,
      mark,
      exec,
      absent,
      attempt,
      // Retry provenance: an attempt above the first names the attempt it
      // replaced and what spawned it, so a replacement is never silent.
      ...(previous && { retryOf: previous.seq, trigger: 'flake-filter' }),
    });
    if (settled.disposition.event === 'layer-result') return { record: settled.record };
    if (settled.disposition.reason !== 'superseded-by-rerun') {
      return { error: settled.disposition.detail };
    }
    previous = settled.start;
  }
  // Unreachable: the last attempt never supersedes itself. A throw beats a
  // silent undefined if a later change to `ATTEMPTS` or the policy makes it so.
  throw new Error(`layer ${layer.name} ran out of attempts without a result`);
}

/**
 * One execution of one layer command: the start stamp, the run, and the
 * terminal stamp that closes it.
 *
 * STRUCTURAL RULE. The attempt body records what it learned and decides
 * nothing; `settle` below is the only writer of an attempt's terminal stamp,
 * and it is called from the `finally` every ending of this function leaves
 * through — an exit code, a throw, and a `return` a later change adds inside
 * the body. That is what makes "no attempt ends without a record" a property of
 * the runner rather than a rule each path has to remember (ADR-0034).
 */
async function runAttempt(ctx, spec) {
  const { argv, layer, cwd, env, cycle, sha, mark, exec, attempt, retryOf, trigger } = spec;
  const logFile = attemptLogFile(ctx, { cycle, layer: layer.name, attempt });
  const start = ctx.store.append('layer-started', {
    actor: ACTOR,
    cycle,
    layer: layer.name,
    attempt,
    sha,
    ...(retryOf !== undefined && { retryOf, trigger }),
    ...mark,
  });
  const made = { start };
  try {
    made.outcome = await exec(argv, {
      cwd,
      env,
      // One file per attempt, named by the attempt: the flake filter's first
      // red keeps its own evidence when the re-run replaces it.
      ...(logFile !== null && { log: logFile }),
      // Every layer attempt is measured. A gate layer is the one command in
      // this harness that runs long enough for its memory to be a fact worth
      // keeping, and the reading is what the forecast is built from (ADR-0045).
      resources: true,
    });
  } catch (error) {
    made.thrown = error;
    throw error;
  } finally {
    settle(ctx, spec, made);
  }
  return made;
}

/**
 * The file this attempt's whole output is streamed to, inside the run
 * directory. Null for a context with no run behind it — a caller that builds a
 * spectrum out of a bare store — and then the command primitive files it under
 * its own root instead (ADR-0043).
 */
function attemptLogFile(ctx, { cycle, layer, attempt }) {
  if (!ctx?.paths?.runs || !ctx.runId) return null;
  return commandLogPath(ctx.paths, ctx.runId, `c${cycle}-${layer}-a${attempt}`);
}

/**
 * The single settle point: what this attempt's ending means, and the one stamp
 * that says so. Writes `made.disposition` and `made.record`.
 *
 * A green re-run stamps the flake here too. The flake and the result are one
 * fact about one attempt, and a filter whose evidence is stamped somewhere else
 * is a filter that can lose it.
 */
function settle(ctx, spec, made) {
  const { layer, cycle, sha, mark, attempt, absent } = spec;
  const disposition = dispositionOf(made, attempt, layer.memoryCeilingMb ?? null);
  made.disposition = disposition;
  const identity = { cycle, layer: layer.name, attempt, sha };
  if (disposition.event === 'layer-result') {
    if (disposition.status === 'green' && attempt > 1) {
      ctx.store.append('flake', { actor: ACTOR, cycle, layer: layer.name, sha });
    }
    made.record = stampLayer(ctx, 'layer-result', {
      ...identity,
      status: disposition.status,
      // What the layer's process tree peaked at, on every result the harness
      // could measure. A green carries it too: a green at the ceiling is the
      // reading the forecast needs, and it is the one nobody would think to
      // keep (ADR-0045).
      ...(disposition.resources && { resources: disposition.resources }),
      ...(disposition.exhaustion && { exhaustion: disposition.exhaustion }),
      ...disposition.evidence,
      // The mechanical half of the attribution: this layer declared a
      // credential the host does not hold, and it went red. The variable is
      // named on the result, so the reason is on the record before a seat
      // reads a line of the output (ADR-0042). A green layer is never
      // annotated — the absence did not stop it, whatever the declaration
      // says.
      ...(disposition.status === 'red' && absent?.length > 0 && { credentialAbsent: absent }),
      ...mark,
    });
    if (disposition.exhaustion) stampExhaustion(ctx, spec, disposition.exhaustion);
    return;
  }
  made.record = stampLayer(ctx, 'layer-abandoned', {
    ...identity,
    reason: assertAbandonReason(disposition.reason),
    ...(made.start && { startedSeq: made.start.seq }),
    ...(disposition.detail !== undefined && { detail: disposition.detail }),
    ...(disposition.exitSignal && { signal: disposition.exitSignal }),
    ...(disposition.partialOutput && { partialOutput: disposition.partialOutput }),
    // The measurement rides an abandoned attempt too. The flake filter replaces
    // a first red rather than judging it, and the attempt it replaced is often
    // the first death of the pair — a history that skipped it would learn the
    // layer's memory from half its runs.
    ...(disposition.resources && { resources: disposition.resources }),
    ...(disposition.exhaustion && { exhaustion: disposition.exhaustion }),
    // The whole output of an attempt nobody judged: a file the run keeps and
    // archives, because a replaced red is the one record of minutes that were
    // spent (ADR-0043).
    ...(disposition.log && { log: disposition.log }),
    ...mark,
  });
  if (disposition.exhaustion) stampExhaustion(ctx, spec, disposition.exhaustion);
}

/**
 * The loud record a layer that died of memory earns, stamped at the settle
 * beside the layer's own. It names the layer, the peak the harness measured
 * and the ceiling the project declared, so the class is answered before triage
 * is dispatched rather than reasoned out by a seat after the fact (ADR-0045).
 *
 * One per layer while the record stands open. The flake filter gives an OOM
 * two deaths, the cycles give it more, and a strip that reports the same
 * ceiling six times reports it worse than once. The layer's own green answers
 * the record and re-arms this (`resolution.mjs`).
 */
function stampExhaustion(ctx, { layer, cycle, sha, mark }, exhaustion) {
  const events = ctx.store.events();
  const resolved = new Set(
    events.filter((e) => e.event === 'resolved').map((e) => e.resolves),
  );
  const standing = events.some(
    (e) =>
      e.event === 'gate-integrity' &&
      e.kind === 'resource-exhaustion' &&
      e.layer === layer.name &&
      !resolved.has(e.seq),
  );
  if (standing) return;
  const held =
    typeof exhaustion.peakRssMb === 'number' ? `${exhaustion.peakRssMb} MB` : 'an unmeasured peak';
  const against =
    typeof exhaustion.ceilingMb === 'number'
      ? ` against a declared ceiling of ${exhaustion.ceilingMb} MB`
      : '';
  ctx.store.append('gate-integrity', {
    actor: ACTOR,
    kind: assertDefectKind('resource-exhaustion'),
    layer: layer.name,
    cycle,
    sha,
    ...exhaustion,
    gist: `${layer.name} died of memory at ${held}${against}`,
    ...mark,
  });
}

/**
 * What an attempt's ending was, from what the attempt recorded. Pure: the
 * whole policy of the flake filter is here, and nothing here writes.
 *
 * `ceilingMb` is what the project declared this layer may hold. Optional, and
 * absent for every layer that declares nothing: the classification then rests
 * on the exit and the output alone, and the forecast reads the trend instead
 * of a fraction (ADR-0045).
 */
function dispositionOf({ outcome, thrown }, attempt, ceilingMb = null) {
  if (thrown) {
    return { event: 'layer-abandoned', reason: 'runner-error', detail: thrown.message };
  }
  if (!outcome) {
    // The backstop. A path left the attempt without running anything and
    // without deciding anything, which is a defect in this runner.
    return {
      event: 'layer-abandoned',
      reason: 'unstamped-exit',
      detail: 'the attempt ended without an outcome',
    };
  }
  const partialOutput = outcome.output ? outcome.output.slice(-OUTPUT_TAIL) : undefined;
  // The file the stream went to, when one survived this attempt. A green
  // deletes its own, so only a record that is about a failure ever names one.
  const log = outcome.log?.removed === true ? undefined : outcome.log?.path;
  // Whether that file is the whole stream. A file the cap cut is still the
  // best evidence there is and is still named; what it is not is complete,
  // and the record says which of the two it is holding.
  const whole = Boolean(log) && outcome.log.truncated !== true;
  // What this attempt cost the machine, and what the harness makes of an
  // ending that cost it everything. Both ride every disposition below: an
  // attempt is measured whichever way it ends, and the flake filter's replaced
  // red is as much a death of memory as the one that follows it (ADR-0045).
  const exhaustion = exhaustionOf(outcome, { ceilingMb });
  const cost = {
    ...(outcome.resources && {
      // The declaration rides the reading. A forecast that had to fetch the
      // ceiling from a config blob could only ever read today's number against
      // a history of peaks measured under yesterday's; carried here, every
      // reading says what it was measured against (ADR-0045).
      resources: {
        ...outcome.resources,
        ...(typeof ceilingMb === 'number' && { ceilingMb }),
      },
    }),
    ...(exhaustion && { exhaustion }),
  };
  if (outcome.code === null) {
    // A spawn that failed carries the reason; a child a signal took carries the
    // signal. Neither is the command's answer, and neither is read as one.
    return outcome.error
      ? {
          event: 'layer-abandoned',
          reason: 'command-error',
          detail: outcome.error,
          partialOutput,
          log,
          ...cost,
        }
      : {
          event: 'layer-abandoned',
          reason: 'terminated',
          detail: `the layer command was terminated by ${outcome.signal ?? 'a signal'}`,
          exitSignal: outcome.signal ?? null,
          partialOutput,
          log,
          ...cost,
        };
  }
  if (outcome.code === 0) {
    return { event: 'layer-result', status: 'green', evidence: {}, ...cost };
  }
  if (attempt < ATTEMPTS) {
    // The flake filter owes this red a re-run, so this attempt judges nothing.
    // Its output is kept anyway: it is what the attempt spent its minutes on,
    // and without it a replaced attempt leaves the ledger with nothing at all.
    return {
      event: 'layer-abandoned',
      reason: 'superseded-by-rerun',
      detail: `exit ${outcome.code}`,
      partialOutput,
      log,
      ...cost,
    };
  }
  const parts = recordedParts(outcome.parts);
  return {
    event: 'layer-result',
    status: 'red',
    ...cost,
    evidence: {
      output: partialOutput ?? '',
      ...(log && { log }),
      ...(parts.length > 0 && { parts }),
      // The defect is output the harness cannot produce. A file that holds the
      // whole stream is not that, whatever the tail lost; a stream that
      // outgrew the file's cap, or an attempt with no file at all, is.
      ...(parts.length === 0 &&
        !whole &&
        (outcome.truncated || (outcome.output?.length ?? 0) > OUTPUT_TAIL) && {
          kind: assertDefectKind('layer-log-truncated'),
        }),
    },
  };
}

/**
 * The parts of a red layer's run the record keeps, each with a bounded tail of
 * its own. A command that named the parts that failed gets those; a command
 * that only said where its parts begin gets all of them, because the red is in
 * one of them and the stream does not say which; a command that surfaced no
 * parts at all gets none, and the record keeps the tail alone as it always did.
 * @param {Array<{name: string, failed: boolean, output: string}>} [parts]
 */
function recordedParts(parts = []) {
  if (parts.length === 0) return [];
  const failed = parts.filter((p) => p.failed);
  let kept = failed.length > 0 ? failed : parts;
  const room = Math.floor(PART_TAIL / PART_FLOOR);
  if (kept.length > room) kept = kept.slice(-room);
  const each = Math.max(PART_FLOOR, Math.floor(PART_TAIL / kept.length));
  return kept.map((p) => ({ name: p.name, output: p.output.slice(-each) }));
}

/**
 * The one writer of a layer's own stamps. Every terminal record of an attempt
 * and every not-runnable stamp is written here and nowhere else, which is what
 * a structural test can hold: one append of a `layer-` event in this file, and
 * one call of `settle` behind it.
 */
function stampLayer(ctx, event, fields) {
  return ctx.store.append(event, { actor: ACTOR, ...fields });
}

/** Follows a not-runnable chain down to the red layer that caused it. */
function rootRed(status, name) {
  let current = name;
  for (;;) {
    const record = status.get(current);
    if (record?.status === 'not-runnable' && record.attributedTo) current = record.attributedTo;
    else return current;
  }
}

/** The red layers of a spectrum result set — the persistent reds. */
export function persistentReds(results) {
  return results.filter((r) => r.status === 'red');
}

/**
 * Every layer's standing result going into a cycle: the last stamp before it.
 * A green a later cycle carried keeps the stamp of the cycle that earned it,
 * so the standing status is that stamp, however many cycles ago it landed.
 */
export function priorStatus(events, cycle) {
  const status = new Map();
  for (const e of events) {
    if (e.event === 'layer-result' && e.cycle < cycle) status.set(e.layer, e);
  }
  return status;
}

/**
 * The targeted set: every layer the cycles before did not prove green, plus
 * every layer downstream of one of those through `needs`, transitively. A
 * downstream layer either reported not-runnable or was judged against a
 * prerequisite that has since changed, so neither has a green worth carrying.
 */
export function targetedLayers(layers, prior) {
  const dependents = new Map();
  for (const layer of layers) {
    for (const need of layer.needs ?? []) {
      if (!dependents.has(need)) dependents.set(need, []);
      dependents.get(need).push(layer.name);
    }
  }
  const target = new Set();
  const queue = [];
  for (const layer of layers) {
    if (prior.get(layer.name)?.status === 'green') continue;
    target.add(layer.name);
    queue.push(layer.name);
  }
  for (let i = 0; i < queue.length; i++) {
    for (const dependent of dependents.get(queue[i]) ?? []) {
      if (target.has(dependent)) continue;
      target.add(dependent);
      queue.push(dependent);
    }
  }
  return target;
}

/**
 * What one verdict cycle runs. The first cycle of an implementation pass has
 * nothing proven, so it runs the full spectrum; so does the first cycle after
 * a CI red, whose red checks name no Tier-1 layer of this tree. Every other
 * cycle judges a tree a repair round, a re-freeze, or an operational fix
 * touched, and runs the targeted set.
 *
 * The plan reads the ledger alone, and the stamps of the cycle being planned
 * never reach it, so a daemon restart mid-cycle derives the same set.
 */
export function cyclePlan(events, { cycle, pass, layers }) {
  const renders = events.filter((e) => e.event === 'verdict-rendered');
  const previous = renders[renders.length - 1];
  if (!previous || previous.pass !== pass || previous.source === 'ci') return { sweep: 'full' };
  const prior = priorStatus(events, cycle);
  return { sweep: 'targeted', run: targetedLayers(layers, prior), prior };
}
