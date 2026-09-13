// Claude CLI adapter: argv assembly for one headless seat invocation and the
// stream-json line parser. Model integrity by construction: the builder
// names the model explicitly and never emits a fallback-model or
// model-switch flag, so an availability fallback cannot happen silently.
// The harness owns availability fallback itself, from the stream evidence,
// and stamps it (`model-degraded`).
//
// Named verification item for the first live shakedown (ADR-0005): whether
// WebFetch runs client-side.
const GIST_MAX = 120;

/**
 * The command tools the bound hook answers for. Each is a tool of its own on
 * the CLI, and a matcher that named one of them would leave the other two as
 * an open door onto every layer.
 */
export const COMMAND_TOOLS = ['Bash', 'PowerShell', 'REPL'];

/** The first word of the line the bound hook prints when it lets a call pass. */
export const BOUND_MARKER = 'olympus-bound';

// The reason string a rejected model carries into the runner's degrade
// decision. One value today; a named reason keeps a second cause (a future
// outage signal) from having to overload a boolean.
const RATE_LIMITED = 'rate-limit';
// The CLI's own value in the `error` field of a synthetic rejection message.
const CLI_RATE_LIMIT_ERROR = 'rate_limit';

/**
 * Builds the child-process spec for one seat invocation. `denyTools` adds
 * caller rules to the disallowed set — the test-edit boundary rides here.
 * `cmd` stays the name the config declares; the supervisor resolves it
 * against the host at spawn time.
 * `settingsPath` names the CLI settings file that carries this dispatch's
 * bound hook. It comes with `--include-hook-events`, because a settings file
 * that fails validation is ignored without a word in print mode: the load is
 * proven from the hook's own line in the stream, and the events have to be in
 * the stream for that.
 * @param {{claudeCommand?: string[], prompt: string, model: string,
 *   effort: string, def: {web: boolean, explore: number}, resume?: string,
 *   denyTools?: string[], settingsPath?: string}} opts
 * @returns {{cmd: string, args: string[], parseLine: typeof parseClaudeLine}}
 */
export function claudeSeatCommand({
  claudeCommand = ['claude'],
  prompt,
  model,
  effort,
  def,
  resume,
  denyTools = [],
  settingsPath,
}) {
  const disallowed = [...denyTools];
  if (!def.web) disallowed.push('WebSearch', 'WebFetch');
  if (!(def.explore > 0)) disallowed.push('Task');
  const args = [
    ...claudeCommand.slice(1),
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--model',
    model,
    '--effort',
    effort,
    ...(disallowed.length > 0 ? ['--disallowedTools', ...disallowed] : []),
    ...(resume ? ['--resume', resume] : []),
    ...(settingsPath ? ['--include-hook-events', '--settings', settingsPath] : []),
    // Last flag before the prompt, and it must stay last. `--disallowedTools`
    // takes a variadic value list, which swallows every following argument up
    // to the next flag — the prompt included. A seat whose prompt was eaten
    // dies at argument parsing with no transcript at all. A boolean flag
    // between the list and the prompt closes the list. The invariant is
    // asserted in the seat-map test, not left to argv order by luck.
    '--dangerously-skip-permissions',
    prompt,
  ];
  return { cmd: claudeCommand[0], args, parseLine: parseClaudeLine };
}

/**
 * Maps one stream-json line to supervision progress. The init event carries
 * the actual model and the session id (meta); assistant text becomes a note
 * gist; the result event carries the cumulative cost.
 *
 * Two lines also mark the requested model as unavailable (`meta.unavailable`,
 * which the runner reads as its degrade signal):
 *
 *  - a `rate_limit_event` whose `rate_limit_info.status` is `rejected`, which
 *    also carries `resetsAt`;
 *  - the synthetic assistant message the CLI substitutes for the answer,
 *    identified by `error: "rate_limit"` with `is_api_error_message: true`.
 *
 * Both are structured fields. The exit code is not consulted: the same
 * rejection was measured exiting 0 from a terminal and 1 from the harness's
 * piped spawn. Neither is the English message text, which is user-facing copy.
 */
export function parseClaudeLine(line) {
  if (!line.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (parsed.type === 'system' && parsed.subtype === 'init') {
    return { meta: { model: parsed.model, sessionId: parsed.session_id } };
  }
  if (parsed.type === 'rate_limit_event') {
    // A healthy stream carries this event too, at status `allowed`. Only an
    // outright rejection means the model refused the work.
    if (parsed.rate_limit_info?.status !== 'rejected') return null;
    const resetsAt = parsed.rate_limit_info.resetsAt;
    return {
      meta: {
        unavailable: RATE_LIMITED,
        ...(typeof resetsAt === 'number' && { resetsAt }),
      },
    };
  }
  if (parsed.type === 'assistant') {
    const text = (parsed.message?.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim();
    // The rejection copy is worth keeping as a note — it is what the seat
    // emitted — but the decision rides the two structured fields beside it.
    const rejected =
      parsed.error === CLI_RATE_LIMIT_ERROR && parsed.is_api_error_message === true;
    if (!text && !rejected) return null;
    return {
      ...(text && { note: gist(text) }),
      ...(rejected && { meta: { unavailable: RATE_LIMITED } }),
    };
  }
  if (parsed.type === 'result') {
    return { cost: parsed.total_cost_usd, meta: { outcome: parsed.subtype } };
  }
  return null;
}

/**
 * Whether this seat's bound hook actually loaded, read from the stream.
 *
 * A settings file the CLI refuses is ignored in print mode with nothing said
 * about it, so writing the file proves nothing. What proves it is the hook's
 * own answer beside a command tool call: `hook_response` carries the hook's
 * stdout, and the bound hook prints one marker line there when it lets a call
 * pass. A `hook_started` line is not evidence — the host's own settings raise
 * one for the same event.
 *
 * A command that ran settles it. The proof is the marker beside that command;
 * no marker beside a command that ran is the miss, because a loaded hook
 * answers every command tool call.
 *
 * A command a hook denied settles nothing, and the next one is read instead. A
 * hook refusing is how the bound works, and a refusal carries the reason on
 * stderr rather than the marker on stdout; a call some other hook of the host
 * denied never reached this one. Either way nothing unbounded ran, which is the
 * whole of what this answers. A denial is read from the hook's own outcome and
 * its exit code, so no reading here rests on a message anybody writes.
 *
 * A field the line does not carry says nothing, and a reading that took an
 * absent code for a denial would disarm this proof on every stream: the miss it
 * exists to catch is a command that ran with no marker beside it, and a denial
 * is exactly what excuses one.
 *
 * @returns {(line: string) => boolean} true on the one line that proves the miss
 */
export function boundLoadProof() {
  let awaiting = null;
  let marked = false;
  let denied = false;
  let settled = false;
  return function read(line) {
    if (settled || !line.trim()) return false;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;
    const blocks = parsed.message?.content ?? [];
    if (parsed.type === 'assistant') {
      if (awaiting !== null) return false;
      const use = blocks.find((b) => b?.type === 'tool_use' && COMMAND_TOOLS.includes(b.name));
      if (use) awaiting = typeof use.id === 'string' ? use.id : '';
      return false;
    }
    if (awaiting === null) return false;
    if (parsed.type === 'system' && parsed.subtype === 'hook_response') {
      if (firstWord(parsed.stdout) === BOUND_MARKER) marked = true;
      if (parsed.outcome === 'error' || exitCode(parsed) !== 0) denied = true;
      return false;
    }
    if (parsed.type === 'user') {
      const closes = blocks.some(
        (b) => b?.type === 'tool_result' && (awaiting === '' || b.tool_use_id === awaiting),
      );
      if (!closes) return false;
      if (denied) {
        awaiting = null;
        marked = false;
        denied = false;
        return false;
      }
      settled = true;
      return !marked;
    }
    return false;
  };
}

/** A hook's exit code, or 0 where the line states none: absence is no denial. */
function exitCode(line) {
  return typeof line.exit_code === 'number' ? line.exit_code : 0;
}

function firstWord(text) {
  return typeof text === 'string' ? text.trim().split(/\s+/)[0] : '';
}

function gist(text) {
  return text.length > GIST_MAX ? text.slice(0, GIST_MAX - 1) + '…' : text;
}
