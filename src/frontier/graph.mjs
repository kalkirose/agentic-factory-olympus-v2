// The story-graph frontier, computed from plain inputs: parsed intent cards,
// the phase list, and ledger-derived run history. Roadmap order is derived,
// never stored — a topological order with an unlock-count tiebreak, so hubs
// land early. The phase gate bounds the launchable set; it is an auto-launch
// rule, never an edge.

/**
 * Card states, mutually exclusive, checked in this order:
 *   defect     — the card cannot enter the graph (parse error, missing or
 *                duplicate key, unknown phase, unknown blocker, cycle)
 *   shipped    — a story-lane run for the card closed `shipped`
 *   open       — an open run exists (parked runs included)
 *   spent      — a run closed `failed` or `killed`; auto-launch never
 *                retries a failure — relaunch is a console decision
 *   parked     — an unanswered card-invalidated park blocks the card
 *   blocked    — a blocker is not shipped
 *   gated      — the card's phase is not open yet
 *   launchable — none of the above
 */

/**
 * @param {{
 *   cards: Array<{key: string|null, path: string, phase: string|null,
 *     blockedBy: string[], errors?: string[]}>,
 *   phases?: Array<{name: string, after?: string}>,
 *   runs?: Map<string, {open: number, shipped: number, spent: number}>,
 *   parkedCards?: Set<string>,
 * }} input `runs` from storyRunsByKey; `parkedCards` holds card keys or
 *   paths as the sweep seat reported them.
 */
export function computeFrontier({ cards, phases, runs, parkedCards }) {
  phases = phases && phases.length > 0 ? phases : [{ name: 'launch' }];
  runs = runs ?? new Map();
  parkedCards = parkedCards ?? new Set();
  const phaseIndex = new Map(phases.map((p, i) => [p.name, i]));
  const defects = [];
  const defective = new Set();
  const defect = (card, message) => {
    defects.push({ ...(card.key && { key: card.key }), path: card.path, message });
    defective.add(card);
  };

  // -- admission: a card enters the graph only with a clean identity --------
  const byKey = new Map();
  for (const card of cards) {
    if (Array.isArray(card.errors) && card.errors.length > 0) {
      defect(card, `card invalid: ${card.errors.join('; ')}`);
    } else if (!card.key) {
      defect(card, 'card names no key');
    } else if (byKey.has(card.key)) {
      defect(card, `duplicate key: ${card.key}`);
    } else if (card.phase !== null && !phaseIndex.has(card.phase)) {
      defect(card, `unknown phase: ${card.phase}`);
    } else {
      byKey.set(card.key, card);
    }
  }
  for (const card of byKey.values()) {
    for (const blocker of card.blockedBy) {
      const shipped = runs.get(blocker)?.shipped > 0;
      if (!byKey.has(blocker) && !shipped) {
        defect(card, `unknown blocker: ${blocker}`);
        byKey.delete(card.key);
        break;
      }
    }
  }

  // -- roadmap order: Kahn, ready set picked by phase, unlock count, key ----
  const dependents = new Map([...byKey.keys()].map((key) => [key, []]));
  const pending = new Map();
  for (const card of byKey.values()) {
    const inGraph = card.blockedBy.filter((b) => byKey.has(b));
    pending.set(card.key, inGraph.length);
    for (const blocker of inGraph) dependents.get(blocker).push(card.key);
  }
  const phaseOf = (card) => phaseIndex.get(card.phase ?? phases[0].name);
  const ready = [...byKey.values()].filter((c) => pending.get(c.key) === 0);
  const order = [];
  while (ready.length > 0) {
    ready.sort(
      (a, b) =>
        phaseOf(a) - phaseOf(b) ||
        dependents.get(b.key).length - dependents.get(a.key).length ||
        (a.key < b.key ? -1 : 1),
    );
    const card = ready.shift();
    order.push(card.key);
    for (const next of dependents.get(card.key)) {
      pending.set(next, pending.get(next) - 1);
      if (pending.get(next) === 0) ready.push(byKey.get(next));
    }
  }
  for (const card of byKey.values()) {
    if (!order.includes(card.key)) {
      defect(card, 'cycle: the card never becomes ready');
      byKey.delete(card.key);
    }
  }

  // -- phase gates ----------------------------------------------------------
  const phaseOpen = phases.map(
    (phase, i) => i === 0 || runs.get(phase.after)?.shipped > 0,
  );

  // -- width: possible-not-forced parallelism -------------------------------
  // Unshipped cards whose blockers all shipped and whose phase is open,
  // regardless of run history or parks — the graph's own measure, for the
  // width tripwire. An open or spent card still counts: the edges permit
  // work there.
  const width = [...byKey.values()].filter(
    (card) =>
      !(runs.get(card.key)?.shipped > 0) &&
      card.blockedBy.every((b) => runs.get(b)?.shipped > 0) &&
      phaseOpen[phaseOf(card)],
  ).length;

  // -- state per card, in roadmap order; defects trail ----------------------
  const classify = (card) => {
    const history = runs.get(card.key);
    if (history?.shipped > 0) return 'shipped';
    if (history?.open > 0) return 'open';
    if (history?.spent > 0) return 'spent';
    if (parkedCards.has(card.key) || parkedCards.has(card.path)) return 'parked';
    if (!card.blockedBy.every((b) => runs.get(b)?.shipped > 0)) return 'blocked';
    if (!phaseOpen[phaseOf(card)]) return 'gated';
    return 'launchable';
  };
  const entries = [
    ...order.map((key) => {
      const card = byKey.get(key);
      return {
        key,
        path: card.path,
        phase: card.phase ?? phases[0].name,
        blockedBy: card.blockedBy,
        state: classify(card),
      };
    }),
    ...[...defective].map((card) => ({
      key: card.key ?? null,
      path: card.path,
      phase: card.phase ?? null,
      blockedBy: card.blockedBy ?? [],
      state: 'defect',
    })),
  ];
  return {
    order,
    cards: entries,
    launchable: entries.filter((e) => e.state === 'launchable'),
    unfinished: entries.filter((e) => e.state !== 'shipped').length,
    width,
    defects,
  };
}

/** Roadmap position per key and per path, for the queue tiebreak. */
export function roadmapPositions(frontier) {
  const positions = new Map();
  frontier.cards.forEach((card, i) => {
    if (card.key !== null && !positions.has(card.key)) positions.set(card.key, i);
    positions.set(card.path, i);
  });
  return positions;
}
