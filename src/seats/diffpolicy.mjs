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
//
// The same block carries one class that blocks nothing: `recapturablePaths`
// names the frozen artifacts a re-freeze re-takes, and a write the capture
// takes back from one of them is recorded quietly instead of loudly. The
// classification is made once, here, at the moment of the revert; every later
// step that meets those paths reads it off the record rather than judging the
// same paths again and reaching a louder answer.
import { underEntry } from '../config/project.mjs';

// The declaration contract: a fenced block the spec author writes, one
// repo-relative path per line, each followed by the seat that owns the file.
// The gate reads the path; the owner tag is the spec lint's and the freeze's
// business, so the parse carries it rather than dropping it.
//
// A declared entry is a literal path, never a pattern. The tiers below are
// project config and are matched as globs; an entry out of a spec is compared
// to a changed file character for character, so a file inside a directory
// named `[param]` or `(group)` answers its own entry and nothing else.
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
 * @param {(path: string) => boolean} declares whether the run declared a path;
 *   the caller answers it by literal comparison against what the spec wrote
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

/**
 * The line that states one take-back, wherever a take-back is stated: the
 * capture record, a later seat's brief, the corrective brief of a capture that
 * a violation blocked anyway.
 *
 * It is not a defect line. A take-back names a path the lane froze, and no
 * seat under that freeze can make the write legal by trying again. The line
 * therefore says three things and asks for nothing: the path is frozen, the
 * write is reverted and ships from no implementation seat, and the route for
 * a change the surface genuinely needs runs through the verdict.
 */
export function dropLine(path) {
  return (
    `${path}: this path is frozen for this lane. The capture reverted the write, ` +
    'and it ships from no implementation seat. If this surface must change, the ' +
    'verdict routes that change through a re-freeze; do not write the file again.'
  );
}

/**
 * Splits the paths one capture took back into the two classes the record
 * treats differently.
 *
 * A take-back is a write to a path the lane froze, and the revert is the same
 * for every one of them. What differs is who the record is for. A frozen test
 * is authored work, and a write to it is worth the owner's attention. A frozen
 * artifact a machine re-takes — a visual baseline, a recorded fixture — is not:
 * the verdict's re-freeze route already re-takes it, so an alert on every
 * take-back reports a handled case as an open item.
 *
 * `recapturablePaths` names that second class, per lane, in project config. A
 * path in it is still reverted, still recorded, and still stated to every
 * later seat; only the loudness changes.
 *
 * The class never reaches a path the hard tiers hold. A take-back that the
 * lane's `deniedPaths` or `forbiddenPatterns` also match stays in the loud
 * class whatever `recapturablePaths` says, so no project quiets its own
 * tamper protection by widening a glob.
 *
 * @param {string[]} dropped repo-relative paths the capture reverted
 * @param {object|null} tier the lane's policy tiers
 * @returns {{recaptured: {path: string, pattern: string}[], held: string[]}}
 *   `recaptured` is the quiet class with the entry that classed each path;
 *   `held` is everything else, in the order the paths arrived
 */
export function classifyTakeBacks(dropped, tier) {
  const recaptured = [];
  const held = [];
  for (const raw of dropped) {
    const path = raw.replaceAll('\\', '/');
    const guarded =
      (tier?.deniedPaths ?? []).some((entry) => underEntry(path, entry)) ||
      (tier?.forbiddenPatterns ?? []).some((pattern) => compile(pattern).test(path));
    const entry = guarded
      ? undefined
      : (tier?.recapturablePaths ?? []).find((e) => underEntry(path, e));
    if (entry) recaptured.push({ path, pattern: entry });
    else held.push(raw);
  }
  return { recaptured, held };
}

// A path as a reader writes one: it has a separator in it, and it stops at
// whitespace or at the punctuation a sentence wraps it in.
const PATH_TOKEN = /[^\s"'`()[\]<>{},;]*\/[^\s"'`()[\]<>{},;]*/g;
const TRAILING = /[.,;:!?]+$/;
const LEADING = /^[./]+/;

/**
 * The repo-relative-looking paths a piece of prose names. A sentence about a
 * defect names the files it is about, and this is the only handle a reader
 * outside the capture has on which files those are.
 * @param {string} text
 * @returns {string[]} slash-normalized, in the order they were written
 */
export function pathTokens(text) {
  if (typeof text !== 'string') return [];
  const tokens = [];
  for (const raw of text.replaceAll('\\', '/').match(PATH_TOKEN) ?? []) {
    const token = raw.replace(TRAILING, '').replace(LEADING, '');
    if (token.includes('/')) tokens.push(token);
  }
  return tokens;
}

/**
 * Whether a piece of prose is about take-backs the capture classed
 * re-capturable, and about no take-back it held.
 *
 * The capture already made this judgment, path by path, at the moment it
 * reverted the writes. A later reader that meets the same paths in a sentence
 * has no standing to make it a second time and reach a different answer: an
 * artifact the lane declared re-capturable is a record and not an open item,
 * whichever step is looking at it.
 *
 * A sentence names the directory the fifteen files sit in more often than it
 * names the fifteen files, so a token and a path answer to each other when
 * either contains the other on a segment boundary. A held take-back named
 * anywhere in the prose settles it the other way: the loud class outranks the
 * quiet one, exactly as the hard tiers outrank it at the capture.
 *
 * @param {string} text the prose to read
 * @param {{recaptured?: {path: string}[], held?: string[]}} takeBacks what this
 *   run's captures reverted, in the shape `classifyTakeBacks` returns and the
 *   ledger records
 */
export function namesOnlyRecapturable(text, { recaptured = [], held = [] } = {}) {
  if (recaptured.length === 0) return false;
  const tokens = pathTokens(text);
  if (tokens.length === 0) return false;
  let named = false;
  for (const token of tokens) {
    if (held.some((path) => sameSurface(token, path))) return false;
    if (recaptured.some((r) => sameSurface(token, r.path))) named = true;
  }
  return named;
}

/** Whether two written paths name one surface: equal, or one inside the other. */
function sameSurface(a, b) {
  const one = `/${a.replaceAll('\\', '/')}/`;
  const other = `/${b.replaceAll('\\', '/')}/`;
  return one.includes(other) || other.includes(one);
}

/** The record's line for one re-capturable take-back. */
export function recaptureLine(r) {
  return (
    `${r.path}: a re-capturable frozen path (recapturablePaths: ${r.pattern}). The capture ` +
    "reverted the write, and the verdict's re-freeze re-takes this artifact; it ships from " +
    'no implementation seat.'
  );
}

/** The record's one-sentence statement of what a re-capturable take-back is. */
export const RECAPTURE_NOTE =
  'Re-capturable frozen paths reverted at capture. The lane declares this class in project ' +
  'config for artifacts a re-freeze re-takes, so the take-back is a record and not an open ' +
  'item; the allowed set is committed either way.';

/** A one-line gist for the ledger stream index. */
export function recaptureGist(recaptured) {
  const named = recaptured.map((r) => r.path).slice(0, 3).join(', ');
  return `${recaptured.length} re-capturable frozen path(s) the capture reverted: ${named}`;
}

/** The record's one-sentence statement of what a take-back is. */
export const DROP_NOTE =
  'Frozen paths reverted at capture. The commit holds the allowed set; a change ' +
  'a frozen surface needs reaches it through the verdict re-freeze route, never ' +
  'through an implementation seat.';

/** A one-line gist for the ledger stream index. */
export function captureGist({ violations, dropped }) {
  const parts = [];
  if (violations.length > 0) parts.push(`${violations.length} path(s) the diff policy blocks`);
  if (dropped.length > 0) parts.push(`${dropped.length} frozen path(s) the capture reverted`);
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
