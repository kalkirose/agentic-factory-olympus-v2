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
import { runCommand } from './exec.mjs';
import { runEvents, ACTOR } from './shared.mjs';

const OUTPUT_TAIL = 1500;
// What a red layer that ran in parts records beyond that tail. A layer command
// is often a sequence — a suite runner with steps — and the tail of one long
// stream is whatever ran last, so a red in the middle of the sequence reaches
// triage as the green minutes that followed it. A command that says where its
// parts begin (`::olympus part`, see exec.mjs) gets the failing part recorded
// under its own name. The budget is the whole record's, shared between the
// parts kept, and never cut below the floor.
const PART_TAIL = 6000;
const PART_FLOOR = 500;

/**
 * Runs one verdict cycle's Tier-1 spectrum.
 * @param {object} ctx run-engine handler context
 * @param {{layers: Array<{name: string, command: string, needs?: string[]}>,
 *   commands: Record<string, string[]>, cwd: string, env?: object,
 *   cycle: number, sha: string, run?: Set<string>|null,
 *   prior?: Map<string, object>|null, confirmation?: boolean}} opts
 *   `run` names the layers this cycle executes; every other layer carries its
 *   `prior` green forward. Both absent means the full spectrum.
 * @returns {Promise<{results?: Array<{layer: string, status: string,
 *   mode: string, attributedTo?: string, output?: string,
 *   parts?: Array<{name: string, output: string}>}>, error?: string}>}
 *   `error` is set when a layer command could not run at all — an
 *   environment defect, never a verdict about the tree.
 */
export async function runSpectrum(
  ctx,
  { layers, commands, cwd, env, cycle, sha, run = null, prior = null, confirmation = false },
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
          record = ctx.store.append('layer-result', {
            actor: ACTOR,
            cycle,
            layer: layer.name,
            status: 'not-runnable',
            attributedTo: rootRed(status, blocked),
            sha,
            ...mark,
          });
        } else {
          const outcome = await runLayer(ctx, { layer, commands, cwd, env, cycle, sha, mark });
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
      ...(record.output && { output: record.output }),
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

async function runLayer(ctx, { layer, commands, cwd, env, cycle, sha, mark }) {
  const argv = commands[layer.command];
  const started = (attempt) =>
    ctx.store.append('layer-started', { actor: ACTOR, cycle, layer: layer.name, attempt, sha, ...mark });
  started(1);
  const first = await runCommand(argv, { cwd, env });
  if (first.code === null) return { error: first.error };
  if (first.code === 0) {
    return { record: stampResult(ctx, { cycle, layer: layer.name, status: 'green', sha, ...mark }) };
  }
  // Flake filter: one red-only re-run by process policy.
  started(2);
  const rerun = await runCommand(argv, { cwd, env });
  if (rerun.code === null) return { error: rerun.error };
  if (rerun.code === 0) {
    ctx.store.append('flake', { actor: ACTOR, cycle, layer: layer.name, sha });
    return { record: stampResult(ctx, { cycle, layer: layer.name, status: 'green', sha, ...mark }) };
  }
  const parts = recordedParts(rerun.parts);
  return {
    record: stampResult(ctx, {
      cycle,
      layer: layer.name,
      status: 'red',
      sha,
      output: rerun.output.slice(-OUTPUT_TAIL),
      ...(parts.length > 0 && { parts }),
      ...mark,
    }),
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

function stampResult(ctx, fields) {
  return ctx.store.append('layer-result', { actor: ACTOR, ...fields });
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
