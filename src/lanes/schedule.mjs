// How a cycle's gate layers are ordered into batches (ADR-0047).
//
// The spectrum ran one layer at a time, in the order the project declared
// them. That is still what happens, and it is what happens when a project
// says nothing: this module answers a batch of one per layer, in declared
// order, and the runner behind it does exactly what it did before.
//
// A project that names concurrency groups is saying that the layers inside
// one group may hold the machine at the same time. The saying is all it is:
// the harness holds no opinion about which layers those are, it measures
// nothing to decide, and it never groups two layers a project did not name
// together.
//
// The batching is a merge of NEIGHBOURS and never a reorder. A layer joins
// the batch in flight only when it follows one of its own group immediately
// in the declared order, so every layer stays where the project put it and
// every `needs` still points at a layer that already settled. A group whose
// members the declared order separates buys nothing for the separated member,
// which is the sequence it would have had anyway: the degradation is always
// toward the behaviour of an absent field.
//
// Two guards live here rather than in the config check alone, because this
// module answers a caller that may not have read a config at all: a layer
// never shares a batch with a layer it `needs`, and a layer belongs to the
// first group that names it.

/**
 * The layers of one cycle, in the order they run, batched by what may run
 * together.
 *
 * @param {Array<{name: string, needs?: string[]}>} layers the declared layers,
 *   in declared order
 * @param {Array<string[]>|null} [groups] the project's concurrency groups
 * @returns {Array<Array<object>>} one batch per step of the sequence, in
 *   declared order, each batch in declared order. Every batch holds one layer
 *   when `groups` is absent or empty.
 */
export function layerBatches(layers, groups = null) {
  const index = groupIndex(groups);
  const batches = [];
  let batch = null;
  let group = null;
  for (const layer of layers) {
    const mine = index.get(layer.name) ?? null;
    const joins =
      batch !== null &&
      mine !== null &&
      mine === group &&
      !(layer.needs ?? []).some((need) => batch.some((held) => held.name === need));
    if (joins) {
      batch.push(layer);
      continue;
    }
    if (batch !== null) batches.push(batch);
    batch = [layer];
    group = mine;
  }
  if (batch !== null) batches.push(batch);
  return batches;
}

/**
 * Layer name to the index of the group that holds it. The first group wins a
 * name two of them claim; the config check refuses that config, and this is
 * what the runner does with one that reached it anyway.
 */
function groupIndex(groups) {
  const index = new Map();
  if (!Array.isArray(groups)) return index;
  groups.forEach((group, i) => {
    if (!Array.isArray(group)) return;
    for (const name of group) {
      if (typeof name === 'string' && !index.has(name)) index.set(name, i);
    }
  });
  return index;
}

/**
 * The concurrency groups a project config declares, or null. Reads the same
 * shape the validator admits and tolerates anything else by answering null,
 * which is the strict sequence.
 */
export function configuredGroups(config) {
  const groups = config?.gates?.concurrencyGroups;
  return Array.isArray(groups) && groups.length > 0 ? groups : null;
}
