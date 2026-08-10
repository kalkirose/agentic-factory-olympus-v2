// The Tier-1 full-spectrum runner: every runnable layer runs to completion
// and the spectrum reports the union of reds. A layer whose prerequisite
// failed reports not-runnable, attributed to the root red — never a red of
// its own. The flake filter is process policy: each red layer re-runs once,
// red-only; a green re-run stamps a flake event, never a finding. Reds that
// survive the re-run are persistent reds — only these enter triage.
//
// Layer results stamp per layer under the cycle number, so a daemon restart
// mid-spectrum skips the layers already judged and re-runs only the rest.
// Deterministic re-runs are unlimited by doctrine; they judge nothing.
import { runCommand } from './exec.mjs';
import { runEvents, ACTOR } from './shared.mjs';

const OUTPUT_TAIL = 1500;

/**
 * Runs the full Tier-1 spectrum for one verdict cycle.
 * @param {object} ctx run-engine handler context
 * @param {{layers: Array<{name: string, command: string, needs?: string[]}>,
 *   commands: Record<string, string[]>, cwd: string, cycle: number, sha: string}} opts
 * @returns {Promise<{results?: Array<{layer: string, status: string,
 *   attributedTo?: string, output?: string}>, error?: string}>}
 *   `error` is set when a layer command could not run at all — an
 *   environment defect, never a verdict about the tree.
 */
export async function runSpectrum(ctx, { layers, commands, cwd, cycle, sha }) {
  const stamped = new Map(
    runEvents(ctx)
      .filter((e) => e.event === 'layer-result' && e.cycle === cycle)
      .map((e) => [e.layer, e]),
  );
  const status = new Map();
  const results = [];
  for (const layer of layers) {
    let record = stamped.get(layer.name);
    if (!record) {
      const blocked = (layer.needs ?? []).find((need) => status.get(need)?.status !== 'green');
      if (blocked) {
        record = ctx.store.append('layer-result', {
          actor: ACTOR,
          cycle,
          layer: layer.name,
          status: 'not-runnable',
          attributedTo: rootRed(status, blocked),
          sha,
        });
      } else {
        const outcome = await runLayer(ctx, { layer, commands, cwd, cycle, sha });
        if (outcome.error) return { error: outcome.error };
        record = outcome.record;
      }
    }
    status.set(layer.name, record);
    results.push({
      layer: record.layer,
      status: record.status,
      ...(record.attributedTo && { attributedTo: record.attributedTo }),
      ...(record.output && { output: record.output }),
    });
  }
  return { results };
}

async function runLayer(ctx, { layer, commands, cwd, cycle, sha }) {
  const argv = commands[layer.command];
  const first = await runCommand(argv, { cwd });
  if (first.code === null) return { error: first.error };
  if (first.code === 0) {
    return { record: stampResult(ctx, { cycle, layer: layer.name, status: 'green', sha }) };
  }
  // Flake filter: one red-only re-run by process policy.
  const rerun = await runCommand(argv, { cwd });
  if (rerun.code === null) return { error: rerun.error };
  if (rerun.code === 0) {
    ctx.store.append('flake', { actor: ACTOR, cycle, layer: layer.name, sha });
    return { record: stampResult(ctx, { cycle, layer: layer.name, status: 'green', sha }) };
  }
  return {
    record: stampResult(ctx, {
      cycle,
      layer: layer.name,
      status: 'red',
      sha,
      output: rerun.output.slice(-OUTPUT_TAIL),
    }),
  };
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
