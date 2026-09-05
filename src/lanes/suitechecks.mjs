// The project's own checks over a suite write, run before anything is
// committed and before the freeze.
//
// A suite file is judged twice by the same project. Once here, while the seat
// that wrote it is still live, and once at the verdict, as a Tier-1 layer over
// the implemented tree. The second reading is the expensive one: the file is
// frozen by then, so the correction is not an edit. It is a triage seat, a
// repair round against a frozen surface, a re-freeze and a second verdict
// cycle, and the reds that buy all of that are attributed to a pass that never
// wrote the file (ADR-0071).
//
// So a project names the checks it wants over its own suite writes, in order,
// as `lanes.story.suiteChecks`. Every suite write of the story lane runs them:
// the authoring round, an adversary amendment, a strengthening round, the
// red-state fix, and the re-freeze amendment after the freeze. Each of those
// five writes a suite file, and a check that ran at one of them would let the
// other four past.
//
// THE ORDER IS THE PROJECT'S. A type check needs its generated packages built;
// a lint needs its dependencies installed. The list carries that, so this
// module needs no dependency graph: it runs the names in the order the project
// wrote them.
//
// EVERY CHECK RUNS, EVEN AFTER A RED. The lane gives a seat one corrective
// invocation and then parks (ADR-0015). A list that stopped at the first red
// would hand the seat one fault, take its round, and park on the second fault
// the next check would have named. One brief carries every red.
//
// A COMMAND THAT COULD NOT RUN ENDS THE LIST. It says nothing about the suite,
// and every command after it runs on the same broken host. It is stamped
// `unrun` and the lane parks it under `command-error`, where every unrunnable
// command goes; the seat is never asked to repair a host (ADR-0060).
import { commandLogPath } from '../daemon/home.mjs';
import { runCommand } from './exec.mjs';
import { ACTOR, runEvents } from './shared.mjs';

/**
 * The checks a project runs over its own suite writes, in order.
 *
 * `lanes.story.suiteChecks` is the field. `lanes.story.groundCommand` is the
 * one-entry form it replaced, and it is still read where no list is present, so
 * a project whose config still names the old field keeps its check for one
 * release. Where both are present the list wins, and the validator holds the
 * two to the same set, so no pin runs a check another pin does not.
 *
 * @param {object} config the project config
 * @returns {string[]} command names, in the order they run
 */
export function storySuiteChecks(config) {
  const story = config?.lanes?.story;
  if (!story) return [];
  if (Array.isArray(story.suiteChecks)) return story.suiteChecks.filter((n) => typeof n === 'string');
  return typeof story.groundCommand === 'string' ? [story.groundCommand] : [];
}

/**
 * Runs the project's suite checks over the tree as the seat left it, stamps one
 * `suite-check` per check, and pushes a defect line for every red.
 *
 * The defect lines are what re-brief the seat: each one names the command and
 * carries that command's own output, which names the file and the fault. A
 * project that names no checks runs nothing and stamps nothing.
 *
 * @param {object} ctx the lane context
 * @param {{names: string[], commands: object, cwd: string, env: object}} at
 * @param {string} phase the suite write this ran over
 * @param {string[]} defects the defect list of the calling check
 */
export async function runSuiteChecks(ctx, at, phase, defects) {
  const { names = [], commands, cwd, env } = at ?? {};
  for (const name of names) {
    const argv = commands?.[name];
    // A name the command table does not hold is refused by the config
    // validator at the launch, so this can only be a config the door never
    // read. It is a host fact and not a suite fact, and it takes the route
    // every unrunnable command takes.
    if (!Array.isArray(argv) || argv.length === 0) {
      stamp(ctx, phase, name, 'unrun', 0, { cause: `the project config names no command "${name}"` });
      return;
    }
    const n = runEvents(ctx).filter((e) => e.event === 'suite-check').length + 1;
    const startedAt = Date.now();
    const run = await runCommand(argv, {
      cwd,
      env,
      log: commandLogPath(ctx.paths, ctx.runId, `suite-check-${n}-${name}`),
    });
    const ms = Date.now() - startedAt;
    if (run.code === null) {
      stamp(ctx, phase, name, 'unrun', ms, { cause: run.error ?? 'the command did not start' });
      return;
    }
    if (run.code === 0) {
      stamp(ctx, phase, name, 'green', ms);
      continue;
    }
    stamp(ctx, phase, name, 'red', ms, { code: run.code });
    defects.push(
      `the project's suite check "${name}" (${argv.join(' ')}) is red on the tree you left. ` +
        'It runs again on what you hand back, and a red is a defect of your work product:\n' +
        run.output,
    );
  }
}

function stamp(ctx, phase, command, result, ms, fields = {}) {
  ctx.store.append('suite-check', { actor: ACTOR, phase, command, result, ms, ...fields });
}

/**
 * The suite check of this write that could not run, or null.
 *
 * The list stops at the first one, so there is at most one per write, and the
 * lane reads it after the seat's contract loop has ended: a host defect is not
 * a defect of the suite, and it parks rather than spending a corrective round
 * on a brief no seat can answer.
 *
 * The scan is bounded by the last suite seat this run spawned, because the
 * checks of one invocation run after its own spawn. Without that bound, a seat
 * that died before its checks ever ran would be reported as the host defect an
 * earlier invocation left on the ledger, and the park would name a cause that
 * is not what just happened.
 *
 * @param {object[]} events the run ledger
 * @param {string} phase the suite write to read
 */
export function unrunSuiteCheck(events, phase) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'seat-spawned' && e.seat === 'suite') return null;
    if (e.event !== 'suite-check' || e.phase !== phase) continue;
    return e.result === 'unrun' ? e : null;
  }
  return null;
}

/**
 * The park a suite check that could not run raises. One question for every
 * suite write, because the answer is the same at each of them: repair the host
 * and retry, or close the run.
 *
 * @param {object} unrun the `suite-check` stamp with result `unrun`
 */
export function unrunQuestion(unrun) {
  return (
    `The project's suite check "${unrun.command}" could not run, so nothing read the suite ` +
    `this run wrote: ${unrun.cause}\n` +
    'Repair the environment, then answer "retry" for one more attempt, or ' +
    '"abandon" to close the run.'
  );
}

/**
 * The suite-check rule, stated to every seat that writes a suite file. The
 * checks run on what comes back either way; saying it first is what lets a seat
 * meet them without spending a corrective round on them.
 *
 * @param {{names: string[], commands: object}} at
 */
export function suiteCheckLines(at) {
  const { names = [], commands } = at ?? {};
  if (names.length === 0) return [];
  return [
    'This project runs its own checks over every suite you write, in this order: ' +
      names.map((name) => `${name} (${(commands?.[name] ?? []).join(' ')})`).join(', '),
    'Run them yourself before you report, and repair whatever they name. They run again on ' +
      'what you hand back, and a red is a defect of your work product.',
  ];
}
