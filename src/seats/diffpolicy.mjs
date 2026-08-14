// The diff-policy gate at candidate capture. Three tiers stand between what a
// dev seat left in the tree and the implementation commit: paths the lane may
// never ship, paths it may ship only when the run declared them, and path
// patterns no run ships at all. The tiers are project config, so a project
// that declares none keeps every changed file allowed.
//
// The gate reads the repo-relative path and nothing else. A file the policy
// names violates it whatever the change inside that file says — the point is
// that the seat under judgment cannot quietly move the ground it is judged
// on, and content review cannot settle that.
import { underEntry } from '../config/project.mjs';

// The declaration contract: a fenced block the spec author writes, one
// repo-relative path per line, each followed by the seat that owns the file.
// The gate reads the path; the owner tag is the spec lint's and the freeze's
// business, so the parse carries it rather than dropping it.
const FENCE_OPEN = /^```touched-paths\s*$/;
const FENCE_CLOSE = /^```/;
const OWNER_SUFFIX = /^(.*?)\s+[—–-]\s+(.*)$/;

const patternCache = new Map();

/**
 * The ```touched-paths block of a spec (or ticket), parsed whole. That block
 * is the only declaration the gate reads; a path named in prose elsewhere
 * declares nothing.
 *
 * A missing block and a block left unterminated both declare nothing. That is
 * the conservative reading in both directions: an undeclared match against
 * `declaredPaths` is a violation, so a malformed block blocks the capture
 * rather than waving it through. The block counts and the unterminated flag
 * ride along so a reader that judges the spec itself can say which of the two
 * it found.
 *
 * @param {string} text spec (or ticket) text
 * @returns {{entries: {path: string, raw: string, owner: string|null}[],
 *   blocks: number, unterminated: boolean}} entries in document order; `path`
 *   is slash-normalized, `raw` is the line as written
 */
export function parseTouchedBlock(text) {
  if (typeof text !== 'string') return { entries: [], blocks: 0, unterminated: false };
  const entries = [];
  let blocks = 0;
  let block = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (block === null) {
      if (FENCE_OPEN.test(trimmed)) block = [];
      continue;
    }
    if (FENCE_CLOSE.test(trimmed)) {
      // Only a closed block declares: the push happens at the closing fence.
      entries.push(...block);
      blocks++;
      block = null;
      continue;
    }
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const owned = OWNER_SUFFIX.exec(trimmed);
    const raw = (owned ? owned[1] : trimmed).trim();
    if (raw.length === 0) continue;
    block.push({ path: raw.replaceAll('\\', '/'), raw, owner: owned ? owned[2].trim() : null });
  }
  return { entries, blocks, unterminated: block !== null };
}

/**
 * The repo-relative paths a spec declares. The declaration semantics live in
 * `parseTouchedBlock`; this is the gate's view of them.
 * @param {string} text spec (or ticket) text
 * @returns {string[]} declared paths, slash-normalized, in document order
 */
export function parseTouchedPaths(text) {
  return parseTouchedBlock(text).entries.map((entry) => entry.path);
}

/** One lane's policy tiers, or null when the project declares none. */
export function laneDiffPolicy(config, lane) {
  return config?.diffPolicy?.[lane] ?? null;
}

/**
 * Judges changed paths against one lane's tiers. The first tier that matches
 * a path names the violation, so a path both forbidden and merely declarable
 * reports as forbidden.
 *
 * @param {string[]} changed repo-relative paths the capture holds
 * @param {object|null} tier the lane's policy tiers
 * @param {(path: string) => boolean} declares whether the run declared a path
 * @returns {{path: string, rule: string, pattern: string}[]} one entry per
 *   violating path, in the order the paths arrived
 */
export function diffPolicyViolations(changed, tier, declares = () => false) {
  if (!tier) return [];
  const violations = [];
  for (const raw of changed) {
    const path = raw.replaceAll('\\', '/');
    const denied = (tier.deniedPaths ?? []).find((entry) => underEntry(path, entry));
    if (denied) {
      violations.push({ path, rule: 'denied', pattern: denied });
      continue;
    }
    const forbidden = (tier.forbiddenPatterns ?? []).find((p) => compile(p).test(path));
    if (forbidden) {
      violations.push({ path, rule: 'forbidden', pattern: forbidden });
      continue;
    }
    const declarable = (tier.declaredPaths ?? []).find((entry) => underEntry(path, entry));
    if (declarable && !declares(path)) {
      violations.push({ path, rule: 'undeclared', pattern: declarable });
    }
  }
  return violations;
}

/** The corrective-brief line for one violation. */
export function violationLine(v) {
  if (v.rule === 'denied') {
    return `${v.path}: the diff policy denies this path to this lane (deniedPaths: ${v.pattern}). Restore it to its committed state.`;
  }
  if (v.rule === 'forbidden') {
    return `${v.path}: the diff policy forbids this path shape (forbiddenPatterns: ${v.pattern}). Restore it to its committed state.`;
  }
  return `${v.path}: the diff policy admits this path only when the spec declares it (declaredPaths: ${v.pattern}), and the spec does not. Restore it to its committed state.`;
}

/** The corrective-brief line for one path the capture took back. */
export function dropLine(path) {
  return `${path}: the capture took this change back and it did not reach the commit. Whatever it was meant to fix is still unfixed.`;
}

/** A one-line gist for the ledger stream index. */
export function captureGist({ violations, dropped }) {
  const parts = [];
  if (violations.length > 0) parts.push(`${violations.length} path(s) the diff policy blocks`);
  if (dropped.length > 0) parts.push(`${dropped.length} path(s) the capture took back`);
  const named = [...violations.map((v) => v.path), ...dropped].slice(0, 3).join(', ');
  return `${parts.join(' and ')}: ${named}`;
}

function compile(pattern) {
  const cached = patternCache.get(pattern);
  if (cached) return cached;
  const compiled = new RegExp(pattern);
  patternCache.set(pattern, compiled);
  return compiled;
}
