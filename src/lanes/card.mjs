// Intent-card parsing. A card is the roadmap artifact for one story: YAML
// frontmatter (key, title, blocked-by, phase) plus markdown sections. The
// harness reads only what readiness and the frontier need — the key, the
// edges, the phase, and the open decisions. Everything else is seat-facing
// prose.

/**
 * Parses an intent card. Returns `{card, errors}`; a non-empty errors list
 * means the card fails readiness.
 * @param {string} text
 */
export function parseIntentCard(text) {
  const errors = [];
  const { fields, body, found } = splitFrontmatter(text);
  if (!found) errors.push('card has no frontmatter block');
  const key = fields.key ?? null;
  if (found && !key) errors.push('frontmatter names no key');
  const card = {
    key,
    title: fields.title ?? null,
    blockedBy: parseList(fields['blocked-by']),
    // Phase membership for the launch gate; absent = the first phase.
    phase: fields.phase ?? null,
    openDecisions: sectionItems(body, /open decisions/i),
  };
  return { card, errors };
}

function splitFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { fields: {}, body: text, found: false };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) return { fields: {}, body: text, found: false };
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = stripQuotes(match[2].trim());
  }
  return { fields, body: lines.slice(end + 1).join('\n'), found: true };
}

function parseList(value) {
  if (!value) return [];
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      // fall through to the comma split
    }
  }
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((v) => stripQuotes(v.trim()))
    .filter((v) => v.length > 0);
}

/** List items under the first heading that matches `pattern`, until the next heading. */
function sectionItems(body, pattern) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    return match && pattern.test(match[1]);
  });
  if (start === -1) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!item) continue;
    const value = item[1].trim();
    if (value.length > 0 && !/^none\.?$/i.test(value)) items.push(value);
  }
  return items;
}

function stripQuotes(value) {
  const match = /^(['"])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}
