// Claude CLI adapter: argv assembly for one headless seat invocation and the
// stream-json line parser. Model integrity by construction: the builder
// names the model explicitly and never emits a fallback-model or
// model-switch flag, so an availability fallback cannot happen silently.
//
// Named verification items for the first live shakedown (ADR-0005): the
// `--effort` flag, the `--disallowedTools` value syntax, and whether
// WebFetch runs client-side.
const GIST_MAX = 120;

/**
 * Builds the child-process spec for one seat invocation.
 * @param {{claudeCommand?: string[], prompt: string, model: string,
 *   effort: string, def: {web: boolean, explore: number}, resume?: string}} opts
 * @returns {{cmd: string, args: string[], parseLine: typeof parseClaudeLine}}
 */
export function claudeSeatCommand({ claudeCommand = ['claude'], prompt, model, effort, def, resume }) {
  const disallowed = [];
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
    '--dangerously-skip-permissions',
    ...(disallowed.length > 0 ? ['--disallowedTools', ...disallowed] : []),
    ...(resume ? ['--resume', resume] : []),
    prompt,
  ];
  return { cmd: claudeCommand[0], args, parseLine: parseClaudeLine };
}

/**
 * Maps one stream-json line to supervision progress. The init event carries
 * the actual model and the session id (meta); assistant text becomes a note
 * gist; the result event carries the cumulative cost.
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
  if (parsed.type === 'assistant') {
    const text = (parsed.message?.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim();
    return text ? { note: gist(text) } : null;
  }
  if (parsed.type === 'result') {
    return { cost: parsed.total_cost_usd, meta: { outcome: parsed.subtype } };
  }
  return null;
}

function gist(text) {
  return text.length > GIST_MAX ? text.slice(0, GIST_MAX - 1) + '…' : text;
}
