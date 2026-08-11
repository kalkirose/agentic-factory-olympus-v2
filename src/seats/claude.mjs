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
 * @param {{claudeCommand?: string[], prompt: string, model: string,
 *   effort: string, def: {web: boolean, explore: number}, resume?: string,
 *   denyTools?: string[]}} opts
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

function gist(text) {
  return text.length > GIST_MAX ? text.slice(0, GIST_MAX - 1) + '…' : text;
}
