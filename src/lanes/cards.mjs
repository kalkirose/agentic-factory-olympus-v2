// The card writer: every write the harness lands on the intent cards of a
// project, and the one route by which it pushes text to the default branch
// outside a pull request.
//
// A caller names the paths it wrote, and `pushCardPaths` stages those and
// nothing else: a run's worktree holds whatever its seats left in it, and a
// commit of the whole tree carries those files to a branch no gate reads. The
// close-out sweep is one such caller, and it lives here beside the writer
// because the cards are the whole of its subject (ADR-0044).
//
// The push is worth exactly one retry and no more. A rejection here is almost
// always the default branch moving under it, and the replay proves the
// replayed result all over again before the second push (ADR-0063).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commandLogPath, runReportPath } from '../daemon/home.mjs';
import { readEvents } from '../ledger/ledger.mjs';
import { instanceParkForms } from '../ledger/parks.mjs';
import { branchSha, cloneDir, fetchClone } from '../isolation/clones.mjs';
import {
  changedFiles,
  changedInRange,
  cherryPick,
  commitPaths,
  push,
  resetHard,
} from '../isolation/tree.mjs';
import {
  FORESEEN_HEADING,
  FORESEEN_MARKER,
  isForeseenNote,
  parseIntentCard,
} from './card.mjs';
import { authorizedSupersedes, supersedeLines } from './supersede.mjs';
import { runCommand } from './exec.mjs';
import {
  ACTOR,
  briefLines,
  gist,
  invocationCount,
  loadProjectConfig,
  runEnv,
  runEvents,
  underAny,
} from './shared.mjs';

export const CARD_SWEEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    updatedCards: { type: 'array', items: { type: 'string' } },
    invalidated: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          card: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['card', 'reason'],
      },
    },
    // The two routes a downstream collision takes (ADR-0052). A consequence the
    // target card already mandates is a note the sweep writes onto that card; a
    // choice the card leaves open is a question for the owner. Both are
    // optional: a sweep that reports neither has found neither, and the
    // build-time classifier still reads the card for itself.
    foreseen: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          card: { type: 'string' },
          clause: { type: 'string' },
          file: { type: 'string' },
          mandate: { type: 'string' },
        },
        required: ['card', 'clause', 'file', 'mandate'],
      },
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          card: { type: 'string' },
          question: { type: 'string' },
        },
        required: ['card', 'question'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['updatedCards', 'invalidated', 'summary'],
};

/**
 * What the card lint may say before the harness stops listening. A refusal is
 * read whole into the correction brief, and the default 4000-character tail
 * would cut the front off a report that names several cards. The log of a
 * green is kept beside it, because a clean run still reports what it found on
 * the cards it was not asked about.
 */
const LINT_OUTPUT_LIMIT = 65536;

/**
 * Commits the named paths and pushes them to the default branch.
 *
 * The paths are the whole of the commit. The caller names what it wrote, and
 * a file it did not name stays in the working tree: a run's worktree is not a
 * clean room, and the default branch is the one place the harness writes
 * without a request and a gate in front of it.
 *
 * Confinement is the card directory of the launched card. A path outside it is
 * refused and nothing is pushed, because a writer allowed to reach past the
 * cards is a writer that lands unjudged code on the default branch.
 *
 * `lintCards` names the cards the project's own lint is asked about. The lint
 * runs over the replayed result before the second push, as it ran before the
 * first: a branch that moved is a tree nothing has read yet.
 *
 * @param {{ctx: object, paths: string[], message: string, lintCards?: string[]}} opts
 * @returns {Promise<{ok: boolean, pushed: boolean, attempts: number, sha?: string,
 *   reason?: string, error?: string, replay?: object}>}
 *   `reason` on a refusal: `outside-cards` for a path past the card directory,
 *   `lint-red` for a replayed result the project's lint refuses, `push-lost`
 *   for a push that lost twice and for the git error that ended it.
 */
export async function pushCardPaths({ ctx, paths, message, lintCards = [] }) {
  const worktree = ctx.payload.worktree;
  const defaultBranch = ctx.payload.defaultBranch ?? 'main';
  const cardPath = typeof ctx.payload.card === 'string' ? ctx.payload.card : null;
  if (!cardPath) {
    return {
      ok: false,
      pushed: false,
      attempts: 0,
      reason: 'outside-cards',
      error: 'the run names no card, so there is no card directory to confine the push to',
    };
  }
  const cardDir = dirname(cardPath);
  const outside = paths.filter((file) => !underAny(file, [cardDir]));
  if (outside.length > 0) {
    return {
      ok: false,
      pushed: false,
      attempts: 0,
      reason: 'outside-cards',
      error: `the push reaches outside ${cardDir}: ${outside.join(', ')}`,
    };
  }
  const sha = await commitPaths(worktree, paths, message);
  try {
    // Cards are planning artifacts; they land directly on the default branch.
    await push(worktree, 'origin', `HEAD:${defaultBranch}`);
    return { ok: true, pushed: true, attempts: 1, sha };
  } catch (error) {
    const again = await replayCards({ ctx, worktree, defaultBranch, cardDir, sha, lintCards });
    if (again.ok) return { ok: true, pushed: true, attempts: 2, sha: again.sha, replay: again.replay };
    return {
      ok: false,
      pushed: false,
      attempts: 2,
      sha,
      reason: again.reason,
      replay: again.replay,
      error: again.replay.cause
        ? `${error.message}; the replay onto ${again.replay.onto} did not land: ${again.replay.cause}`
        : error.message,
    };
  }
}

/**
 * The one retry a rejected card push is worth: refetch, replay the commit onto
 * the head that beat it, prove the replayed result, push again.
 *
 * The replay is a three-way pick rather than a checkout of the writer's file
 * versions, so a human edit to the same card conflicts instead of being taken
 * back in silence. Every check the first push stood behind runs again on the
 * result: the containment to the card directory, and the project's own card
 * lint. Neither is assumed to hold because it held before the branch moved.
 *
 * A second rejection records the miss exactly as the first one did. There is no
 * third attempt: a push that loses twice is a contended directory rather than a
 * race, and a loop against it would run for as long as somebody keeps writing.
 * @returns {Promise<{ok: boolean, sha?: string, reason?: string, replay: object}>}
 */
async function replayCards({ ctx, worktree, defaultBranch, cardDir, sha, lintCards }) {
  const replay = { onto: null };
  try {
    const config = await loadProjectConfig(ctx);
    const clone = cloneDir(ctx.paths, ctx.project);
    await fetchClone(clone);
    const head = await branchSha(clone, defaultBranch);
    replay.onto = head;
    await resetHard(worktree, head);
    const picked = await cherryPick(worktree, sha);
    if (!picked.ok) {
      return { ok: false, reason: 'push-lost', replay: { ...replay, ok: false, cause: picked.cause } };
    }
    const changed = await changedInRange(worktree, head, picked.sha);
    const outside = changed.filter((file) => !underAny(file, [cardDir]));
    if (outside.length > 0) {
      return {
        ok: false,
        reason: 'outside-cards',
        replay: {
          ...replay,
          ok: false,
          cause: `the replayed result reaches outside ${cardDir}: ${outside.join(', ')}`,
        },
      };
    }
    const defects = [];
    const lint = await cardLint({
      ctx,
      config,
      env: runEnv(ctx, config),
      worktree,
      changed,
      cards: lintCards,
      defects,
      // The replay's own lint file sits beside the first one rather than on
      // top of it: two reads of two trees are two records (ADR-0043).
      logName: `card-push-lint-${sha.slice(0, 8)}`,
    });
    if (defects.length > 0) {
      return {
        ok: false,
        reason: lint === 'red' ? 'lint-red' : 'push-lost',
        replay: { ...replay, ok: false, lint, cause: defects[0] },
      };
    }
    await push(worktree, 'origin', `HEAD:${defaultBranch}`);
    return { ok: true, sha: picked.sha, replay: { ...replay, ok: true, lint, files: changed.length } };
  } catch (error) {
    return { ok: false, reason: 'push-lost', replay: { ...replay, ok: false, cause: error.message } };
  }
}

// -- the close-out card sweep ------------------------------------------------

/**
 * One seat brings the cards in line with the repository as shipped, and what
 * it wrote is pushed by path.
 *
 * Nothing here fails the run. The story shipped before this ran, so a seat
 * that fails, a work product the checks refuse and a push that loses twice are
 * all recorded on the ledger and raise nothing.
 */
export async function cardSweep(ctx, base, merged) {
  const clone = cloneDir(ctx.paths, ctx.project);
  await fetchClone(clone);
  await resetHard(base.worktree, merged.mergeSha);
  const cardDir = dirname(base.cardPath);
  // The supersedes this run executed on the card's authority. The card is their
  // durable home — a run ledger archives with its run, and the next story reads
  // the card — and this sweep is the one mechanism already allowed to write a
  // card on the default branch (ADR-0044).
  const supersedes = authorizedSupersedes(runEvents(ctx));
  let brief = null;
  let report = null;
  let lint = null;
  for (let attempt = 1; ; attempt++) {
    const n = invocationCount(runEvents(ctx), 'card-sweep') + 1;
    const result = await ctx.runSeat({
      seat: 'card-sweep',
      roleBlock: sweepRole(base, cardDir, brief, supersedes),
      reportPath: runReportPath(ctx.paths, ctx.runId, `card-sweep-${n}`),
      schema: CARD_SWEEP_SCHEMA,
      cwd: base.worktree,
      env: base.env,
    });
    if (!result.ok) {
      // The story shipped; a sweep failure never un-ships it. Loud enough
      // through the seat-failure stamp; the sweep records the miss.
      ctx.store.append('card-sweep', { actor: ACTOR, ok: false, cause: 'seat-failure' });
      return;
    }
    const checked = await sweepChecks(ctx, base, cardDir, result.report);
    const defects = checked.defects;
    lint = checked.lint;
    if (defects.length === 0) {
      report = result.report;
      break;
    }
    if (attempt === 2) {
      ctx.store.append('seat-failure', {
        actor: ACTOR,
        seat: 'card-sweep',
        reason: 'work-product-defect',
        defects,
      });
      ctx.store.append('card-sweep', {
        actor: ACTOR,
        ok: false,
        cause: 'work-product-defect',
        ...(lint && { lint }),
      });
      return;
    }
    brief = defects;
  }
  let pushed = false;
  let sha = null;
  let pushError = null;
  let replay = null;
  let attempts = 0;
  const written = await changedFiles(base.worktree);
  if (written.length > 0) {
    const landed = await pushCardPaths({
      ctx,
      paths: written,
      message: `cards: sweep ${base.storyKey ?? ctx.runId}`,
      lintCards: written,
    });
    pushed = landed.pushed;
    sha = landed.sha ?? null;
    attempts = landed.attempts;
    replay = landed.replay ?? null;
    pushError = landed.error ?? null;
  }
  // An invalidated card parks the card, never the run that shipped: the park
  // lands in the instance ledger and blocks that card's launch, not this
  // close.
  const instanceParks = readEvents(ctx.paths.instanceLedger).filter(
    (e) => e.event === 'park' && e.runId === ctx.runId,
  );
  const parked = new Set(
    instanceParks.filter((e) => e.type === 'card-invalidated').map((e) => e.card),
  );
  for (const inv of report.invalidated) {
    if (parked.has(inv.card)) continue;
    ctx.instanceStore?.append('park', {
      actor: ACTOR,
      type: 'card-invalidated',
      card: inv.card,
      runId: ctx.runId,
      // The repository the card belongs to. A card path is a project's own
      // word, and the frontier that blocks on this park judges one project's
      // cards (ADR-0008).
      project: ctx.project,
      question: `The ship of ${base.storyKey ?? ctx.runId} invalidated ${inv.card}: ${inv.reason}`,
      // The one park with no run behind it, so the one park that offers no
      // abandon: the answer unblocks the card, and there is nothing to close
      // (ADR-0029).
      answers: instanceParkForms({ text: 'what you did about the card' }),
      gist: gist(`card-invalidated: ${inv.card} — ${inv.reason}`),
    });
  }
  // A choice the card genuinely leaves open takes the same route, one park per
  // question. It is asked here rather than planted on the card, because a
  // question written into a card parks the next launch of that card before the
  // machinery that settles collisions from card authority ever runs, and the
  // owner is then asked once per ship for ever (ADR-0052). The park holds the
  // card it names and never this close: the story shipped.
  const asked = new Set(
    instanceParks
      .filter((e) => e.type === 'card-decision')
      .map((e) => `${e.card}\n${e.decision}`),
  );
  for (const open of report.decisions ?? []) {
    const key = `${open.card}\n${open.question}`;
    if (asked.has(key)) continue;
    asked.add(key);
    ctx.instanceStore?.append('park', {
      actor: ACTOR,
      type: 'card-decision',
      card: open.card,
      decision: open.question,
      runId: ctx.runId,
      project: ctx.project,
      question:
        `The ship of ${base.storyKey ?? ctx.runId} left a decision open on ${open.card}: ` +
        open.question,
      answers: instanceParkForms({ text: 'the decision, resolved' }),
      gist: gist(`card-decision on ${open.card}: ${open.question}`),
    });
  }
  ctx.store.append('card-sweep', {
    actor: ACTOR,
    ok: true,
    updated: report.updatedCards.length,
    invalidated: report.invalidated.length,
    // What the sweep classified: the notes it wrote onto cards, and the
    // questions it put to the owner. Both counts record that the
    // classification duty ran at all.
    foreseen: (report.foreseen ?? []).length,
    decisions: (report.decisions ?? []).length,
    // What the project's own card lint said about the writes this sweep is
    // pushing: green, or the reason there is no green to report (ADR-0054).
    ...(lint && { lint }),
    pushed,
    ...(sha && { sha }),
    // How many pushes the cards took. Two is the race absorbed, and the count
    // is what says how contended the card directory is (ADR-0063).
    ...(attempts > 0 && { pushAttempts: attempts }),
    ...(replay && { replay }),
    ...(pushError && { error: pushError }),
  });
}

/**
 * The sweep's self-check on its own work product: what the seat wrote, and
 * where. It returns the defects that re-brief the attempt, and what the
 * project's card lint said (ADR-0054).
 */
async function sweepChecks(ctx, base, cardDir, report) {
  const defects = [];
  const changed = await changedFiles(base.worktree);
  for (const file of changed) {
    if (!underAny(file, [cardDir])) defects.push(`change outside the card directory: ${file}`);
  }
  for (const card of report.updatedCards) {
    if (!underAny(card, [cardDir])) defects.push(`updated card outside the card directory: ${card}`);
  }
  for (const inv of report.invalidated) {
    if (!underAny(inv.card, [cardDir])) {
      defects.push(`invalidated card outside the card directory: ${inv.card}`);
    }
  }
  // A foreseen amendment is a note ON a card, so the note has to be there. The
  // report is the sweep's claim and the card is the durable record: the next
  // launch reads the card to see there is nothing to ask, and the build-time
  // classifier reads it as evidence. A claim with no note on the card is a
  // work-product defect, and the attempt is re-briefed (ADR-0052).
  for (const note of report.foreseen ?? []) {
    if (!underAny(note.card, [cardDir])) {
      defects.push(`foreseen amendment on a card outside the card directory: ${note.card}`);
    } else if (!noteWritten(base.worktree, note)) {
      defects.push(
        `the foreseen amendment for ${note.file} is not on ${note.card}: write it there under a ` +
          `"${FORESEEN_HEADING}" heading, as one line that opens with "${FORESEEN_MARKER}" and ` +
          'names the file.',
      );
    }
  }
  for (const open of report.decisions ?? []) {
    if (!underAny(open.card, [cardDir])) {
      defects.push(`open decision on a card outside the card directory: ${open.card}`);
    }
  }
  const n = invocationCount(runEvents(ctx), 'card-sweep');
  return {
    defects,
    lint: await cardLint({
      ctx,
      config: base.config,
      env: base.env,
      worktree: base.worktree,
      changed,
      cards: changed,
      defects,
      logName: `card-sweep-lint-${n}`,
    }),
  };
}

/**
 * The project's own card lint, run over the cards a writer wrote, before any of
 * them is pushed.
 *
 * This is the one writer in the harness that lands text on the default branch
 * without a request behind it, so it is the one writer whose output no gate
 * reads. The command is the project's, named in its own config, and it is the
 * same command the launch gate runs over the same files: an automated writer
 * passes every mechanical check that binds the equivalent human path, because
 * a card the project's check refuses parks every launch behind it (ADR-0054).
 *
 * The question put to the lint is about the cards named and no others. A card
 * somebody else left red is not this writer's to repair, and a whole-directory
 * answer would hold the notes of a shipped run out of the default branch for
 * as long as that other card stayed broken. The project's own cards check is
 * what holds the directory clean.
 *
 * A red is a work-product defect. It fails this attempt and re-briefs the seat
 * on the two-attempt loop the sweep already has, so nothing red is pushed. A
 * command that could not run at all fails the attempt the same way: it is not
 * a red, but it is not a green either, and a push behind it is a push of cards
 * no check read. The stamp keeps the two apart, so a reader can tell a refused
 * card from a host that could not answer. A writer that wrote nothing is not a
 * writer, and the lint of the tree as it stood is not its answer to give.
 */
async function cardLint({ ctx, config, env, worktree, changed, cards, defects, logName }) {
  const name = config.lanes?.story?.lintCommand;
  if (!name) return 'undeclared';
  if (changed.length === 0) return 'unwritten';
  // Plain argv, so the flag the harness asks about is the harness's to append.
  // A script that does not know the flag ignores it and reads the whole
  // directory, which is a wider answer and never a wrong one. A card the
  // sweep deleted is a changed path with no file behind it; the lint refuses
  // a name it cannot open, and what a deletion breaks shows on the cards that
  // still name it, which the whole-corpus parse reads either way.
  const present = cards.filter((card) => existsSync(join(worktree, card)));
  const argv = [...config.commands[name], ...present.flatMap((card) => ['--card', card])];
  const run = await runCommand(argv, {
    cwd: worktree,
    env,
    outputLimit: LINT_OUTPUT_LIMIT,
    keep: 'always',
    log: commandLogPath(ctx.paths, ctx.runId, logName),
  });
  if (run.code === null) {
    defects.push(
      'the card lint of this project could not run, so nothing read the cards you wrote; ' +
        `no card the lint did not pass is pushed:\n${run.error ?? run.output}`,
    );
    return 'unrun';
  }
  if (run.code === 0) return 'green';
  defects.push(
    'the card lint of this project is red on what you wrote; repair the cards you edited ' +
      `until it passes:\n${run.output}`,
  );
  return 'red';
}

/**
 * Whether the card really carries the note the report claims for it: a line
 * under the foreseen heading, opening with the marker, naming the file whose
 * clause the amendment is foreseen for.
 */
function noteWritten(worktree, note) {
  let text;
  try {
    text = readFileSync(join(worktree, note.card), 'utf8');
  } catch {
    return false;
  }
  return parseIntentCard(text).card.foreseenAmendments.some(
    (item) => isForeseenNote(item) && item.includes(note.file),
  );
}

function sweepRole(base, cardDir, brief, supersedes = []) {
  return [
    `The story ${base.storyKey ?? ''} shipped; sweep the intent cards.`,
    `The shipped spec: ${base.specRef}`,
    `The cards live under: ${cardDir}. Edit card files in place; touch nothing outside that directory.`,
    'Update Blocked-by edges, sources, and open decisions so every card matches the repository as shipped.',
    "When the shipped work invalidates a card's goal or scope boundary, do not rewrite the card: list it under invalidated with the reason.",
    'List every card you edited under updatedCards.',
    ...(base.config.lanes?.story?.lintCommand
      ? [
          "The project's own card lint runs over everything you write, before any of it is " +
            'pushed. A card it refuses fails this attempt, so keep every card you edit inside ' +
            'the conventions the lint enforces.',
        ]
      : []),
    ...foreseenLines(cardDir),
    ...(supersedes.length > 0
      ? [
          'This run amended frozen tests on this card\'s own authority. Record each one on this ' +
            `story's card (${base.cardPath}) under a "## Supersedes" heading, creating the heading ` +
            'when the card has none. One line each: the test file, the assertion that changed, and ' +
            'the card line the authorization rested on. Record them; do not re-judge them.',
          ...supersedeLines(supersedes),
        ]
      : []),
    ...briefLines(brief),
  ].join('\n');
}

/**
 * The classification duty (ADR-0052). This ship froze tests, and a later card's
 * work can collide with them. Every such collision is one of two things, and
 * they take different routes.
 *
 * A consequence the target card's own acceptance criteria already mandate is
 * not a question. It becomes a note on that card: the next launch reads it and
 * proceeds, and the machinery that settles collisions from card authority
 * consumes it as evidence at build time. Writing it as an open decision instead
 * parks that launch before the machinery ever runs, and asks the owner, once
 * per ship, what the card already answered.
 *
 * A choice the card genuinely leaves open is a question, and it is put to the
 * owner here, at close-out, while the context is fresh. It holds the card it
 * names and no run.
 */
function foreseenLines(cardDir) {
  return [
    `This ship froze tests. Where the work of a later card under ${cardDir} would collide with ` +
      'them, classify the collision before you write anything, and take the route the class asks for.',
    `Mandated by the target card: the card's own acceptance criteria mandate a behavior whose ` +
      `implementation necessarily changes what the frozen clause asserts. Write a note on that ` +
      `card under a "## ${FORESEEN_HEADING}" heading, creating the heading when the card has ` +
      `none. One line, opening with "${FORESEEN_MARKER}", naming the clause the tests pin, the ` +
      `file it lives in, and the card line that mandates the change. Report it under foreseen ` +
      `with the card, the clause, the file and the mandate. It is a note, not a question: never ` +
      `write it as an open decision, and never rewrite the frozen tests here.`,
    'Left open by the target card: the card states no such mandate and a human has to choose. ' +
      'Report it under decisions with the card and the question. The owner is asked at this ' +
      'close-out and the question holds that card alone. Do not write it onto the card.',
    'Report foreseen and decisions on every sweep, empty when you found neither.',
  ];
}
