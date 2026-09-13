// The bound an implementation seat runs inside, as a set of layer names. One
// stage judges a tree and it is the verdict; a seat proves its own work and
// nothing wider, so the bound is what the work reaches and the seat is refused
// every other layer.
//
// Three places ask this question: the brief that names the bound at the spawn,
// the stamp that records what the seat was allowed to run, and the hook that
// refuses a command at the tool call. The only difference between them is the
// file list — the paths the spec or the ticket declared, or the seat's live
// diff — so the rule lives here and the caller brings the files. Two
// definitions of one bound would let the brief promise a layer the hook
// refuses.
import { underEntry } from '../config/project.mjs';
import { withDependents } from '../lanes/spectrum.mjs';

/**
 * The layers a seat may run, given the files its work reaches.
 *
 * Four readings put a layer in the bound:
 *
 *  - its ground holds one of the files;
 *  - it is downstream of such a layer, because a layer judged against a
 *    prerequisite that moved is judged against a tree it no longer describes;
 *  - it declares `setup`, or it is the frozen suite. A setup layer is what
 *    makes a worktree runnable at all and its own ground decides nothing; the
 *    suite is the seat's own question and is never outside the seat's work;
 *  - something already in the bound needs it, transitively. A layer whose
 *    prerequisite is refused cannot run at all, so a bound that holds a suite
 *    and refuses the install under it is a bound no seat can meet. It reports
 *    its own work red and is refused for saying so.
 *
 * The prerequisite closure runs last, over everything the other three
 * readings admitted. It walks `needs` upward only: pulling the dependents of a
 * prerequisite back in would hand a one-file diff the whole spectrum, which is
 * the thing the bound exists to prevent.
 *
 * A prerequisite in the bound is a bound layer like any other, and the seat's
 * time cap judges it the same, unless it declares `setup`.
 *
 * @param {{layers?: Array<{name: string, ground?: string[], needs?: string[],
 *   setup?: boolean}>, declared?: string[], suite?: string|null}} bound
 * @param {string[]} [files] the files the work reaches. The declared paths by
 *   default, which is the bound at the spawn.
 * @returns {Set<string>}
 */
export function boundLayerNames(bound, files = bound.declared ?? []) {
  const layers = bound.layers ?? [];
  const touched = new Set();
  for (const layer of layers) {
    const ground = layer.ground ?? [];
    if (files.some((file) => ground.some((entry) => underEntry(file, entry)))) {
      touched.add(layer.name);
    }
  }
  const names = withDependents(layers, touched);
  for (const layer of layers) if (layer.setup === true) names.add(layer.name);
  if (typeof bound.suite === 'string' && bound.suite.length > 0) names.add(bound.suite);
  return withPrerequisites(layers, names);
}

/**
 * One set of layers, closed over `needs` upward and transitively. A `needs`
 * entry no layer of the spectrum declares is skipped: it names nothing this
 * bound could hold, and nothing the hook could match a command against.
 */
function withPrerequisites(layers, target) {
  const by = new Map(layers.map((layer) => [layer.name, layer]));
  const queue = [...target];
  for (let i = 0; i < queue.length; i++) {
    for (const need of by.get(queue[i])?.needs ?? []) {
      if (target.has(need) || !by.has(need)) continue;
      target.add(need);
      queue.push(need);
    }
  }
  return target;
}
