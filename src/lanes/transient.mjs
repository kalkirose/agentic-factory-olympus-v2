// The closed signature set: what a red printed when its cause was outside the
// tree, and what it printed when the tree is the cause.
//
// A dropped connection, a rate limit, a name lookup that stalled, a sandbox
// down for a day: every one of those reddens a Tier-1 layer, and every one of
// them was read as a defect of the code once the flake filter's single re-run
// had gone red too. A repair seat then rewrote working code, or a fresh pass
// discarded a sound implementation. No repair fixes a cause outside the tree.
//
// So a red is read before a seat is spawned. The read is deterministic and it
// is deliberately narrow: a red qualifies only when the layer named the files
// that failed, every one of those parts shows a signature from the set below,
// and nothing in the layer's output shows an assertion failure or a compile
// error. Everything else — a layer that named no failed file, a red that mixes
// an assertion with a dropped connection — takes triage exactly as it did
// before, because the safe direction is the seat.
//
// The set is closed and it grows by decision, never from a call site. A
// project may add to it in its own config (`gates.transientPatterns`), because
// a runner's wording for a host that refused is the project's fact and not the
// harness's; it may not take anything out of it.

/**
 * One signature: an id a ledger can count, and the test it stands for.
 * @typedef {{id: string, test: (text: string) => boolean}} Signature
 */

/** A plain pattern over the whole text, case-insensitive. */
function pattern(id, source) {
  const re = new RegExp(source, 'i');
  return { id, test: (text) => re.test(text) };
}

/**
 * A pattern that has to sit on one line beside a host OUTSIDE this tree: an
 * HTTP status is only evidence about the world when the line says which world
 * it came from, and the run's own stack is not the world. A status printed on
 * its own is a number in somebody's output; a 500 from `localhost:3000` is the
 * tree failing on the run's own machine, and a wait would answer neither.
 */
function beside(id, statusSource) {
  const status = new RegExp(statusSource, 'i');
  return {
    id,
    test: (text) => text.split('\n').some((line) => status.test(line) && outsideHost(line)),
  };
}

// The addresses of the machine the run is on. A service answering here is the
// run's own stack, whatever it answered.
const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[?::1\]?)$/i;

const URL_IN_LINE = /https?:\/\/[^\s'"<>]+/gi;
const NAME_IN_LINE = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+\b/gi;

/**
 * Whether one line names a host that is not this machine: a dotted name, and
 * not a loopback address. A dotless name (`localhost`, a container alias, a
 * compose service) is refused for the same reason the loopback addresses are —
 * nothing outside the tree answers on one.
 */
export function outsideHost(line) {
  const named = [
    ...(line.match(URL_IN_LINE) ?? []).map((url) =>
      url.replace(/^https?:\/\//i, '').split(/[/:?#]/)[0],
    ),
    ...(line.match(NAME_IN_LINE) ?? []),
  ];
  return named.some((host) => host.includes('.') && !LOOPBACK.test(host));
}

/**
 * The closed set. Each entry is one condition outside the tree, and the id is
 * the word the ledger carries — `layer-transient` names them, a triage brief
 * lists them, and a check refuses a code-class finding whose only evidence is
 * one of them.
 */
export const TRANSIENT_SIGNATURES = Object.freeze([
  // The four errno values a dropped, refused, or timed-out connection reaches
  // a runner as, and the two a name lookup fails with.
  pattern('ECONNRESET', '\\bECONNRESET\\b'),
  pattern('ECONNREFUSED', '\\bECONNREFUSED\\b'),
  pattern('ETIMEDOUT', '\\bETIMEDOUT\\b'),
  pattern('ENOTFOUND', '\\bENOTFOUND\\b'),
  pattern('EAI_AGAIN', '\\bEAI_AGAIN\\b'),
  // A service that answered, said so, and named itself.
  beside('http-429', '(^|[^\\d])429([^\\d]|$)'),
  beside('http-5xx', '(^|[^\\d])5(0[0-9]|1[0-9])([^\\d]|$)'),
  // The words a host uses when it is refusing work rather than failing it.
  pattern('rate-limit', 'rate[ _-]?limit(ed|ing)?\\b|too many requests|quota exceeded'),
  // A container image the host could not fetch: the run's own substrate never
  // came up, so nothing about the tree was tested.
  pattern(
    'image-pull',
    'failed to pull|pull access denied|manifest unknown|error pulling image|' +
      'toomanyrequests|no such host.*registry|image pull (back-?off|failure)',
  ),
  // The two stores a run stack brings up, refusing connections while they
  // start. A suite that meets one of these met a stack, not a defect.
  pattern(
    'db-startup',
    'could not connect to server|the database system is (starting up|not yet accepting)|' +
      'connection to server at .* failed|redis connection to .* failed|' +
      'connect ECONNREFUSED .*:(5432|6379)\\b|SequelizeConnectionRefusedError',
  ),
  // The runner CLI's own retry, spent. It says the provider refused every
  // attempt the tool made before it gave up.
  pattern('api-retry', 'api_retry|api error.*(retry|retries) exhausted|max retries exceeded'),
]);

/**
 * The signatures of a cause inside the tree. One of these anywhere in a red's
 * evidence ends the read: an assertion that failed and a file that would not
 * compile are the tree's own answer, and a wait cannot change either.
 */
export const CODE_SIGNATURES = Object.freeze([
  pattern(
    'assertion',
    'AssertionError|assertion failed|\\bexpect\\(|expected .* (to|but) |' +
      '\\btoBe(Truthy|Falsy|Defined|Null|Close)?\\(|\\btoEqual\\(|\\btoMatch\\(|' +
      '\\bassert\\.[a-z]',
  ),
  pattern(
    'compile',
    'SyntaxError|\\berror TS\\d+|\\bTS\\d{4}:|Type error:|type-?check failed|' +
      'Parse error|ReferenceError|Cannot find name |Unexpected token',
  ),
]);

/**
 * The project's own additions, compiled. Each entry is a regular expression
 * source and its id is the source itself, so a ledger says which project line
 * matched rather than an index nobody can look up.
 *
 * A pattern that will not compile is dropped rather than thrown on: this runs
 * inside a verdict cycle, the config validator refuses a bad pattern at the
 * launch door, and a read that could not compile one still has the closed set
 * to work from.
 */
export function projectSignatures(patterns = []) {
  const out = [];
  for (const source of patterns) {
    if (typeof source !== 'string' || source.length === 0) continue;
    try {
      out.push(pattern(`project:${source}`, source));
    } catch {
      // Refused at the door; ignored here.
    }
  }
  return out;
}

/** Every signature id one text shows, in set order. */
function matched(signatures, text) {
  return signatures.filter((signature) => signature.test(text)).map((signature) => signature.id);
}

/**
 * Whether one text shows a cause outside the tree. The triage check reads a
 * seat's own sentences with it: a finding whose evidence is a dropped
 * connection and nothing else is a finding about the world.
 */
export function showsTransient(text, patterns = []) {
  return matched([...TRANSIENT_SIGNATURES, ...projectSignatures(patterns)], text ?? '').length > 0;
}

/** Whether one text shows a cause inside the tree: an assertion, a compile. */
export function showsCode(text) {
  return matched(CODE_SIGNATURES, text ?? '').length > 0;
}

/**
 * Reads a set of persistent reds as a condition outside the tree, or refuses
 * to.
 *
 * The refusal is the ordinary answer and it names its reason, because the
 * reason is what a reader needs when a red they believe is transient went to a
 * seat anyway. Four of them:
 *
 * - `no-red` — nothing to read.
 * - `no-failed-files` — a red layer named no part, or a red part named no
 *   file. The protocol the read stands on was not honoured, and a red the
 *   harness cannot narrow is a red it does not understand.
 * - `code-signature` — an assertion failure or a compile error sits beside the
 *   signatures. A mix is a tree that failed, whatever else also failed.
 * - `no-signature` — a red part shows nothing from the set. The set is closed,
 *   so this is the answer for everything nobody has named yet.
 *
 * @param {Array<{layer: string, status: string, output?: string,
 *   parts?: Array<{name: string, status: string, output?: string,
 *     failedFiles?: string[]}>}>} reds the persistent reds of one cycle
 * @param {{patterns?: string[]}} [opts] the project's own additions
 * @returns {{ok: boolean, reason?: string, detail?: string,
 *   layers?: Array<{layer: string, parts: string[], files: string[],
 *     signatures: string[]}>, files?: string[], signatures?: string[]}}
 */
export function readTransient(reds, { patterns = [] } = {}) {
  if (!Array.isArray(reds) || reds.length === 0) return { ok: false, reason: 'no-red' };
  const transient = [...TRANSIENT_SIGNATURES, ...projectSignatures(patterns)];
  const layers = [];
  const allFiles = new Set();
  const allSignatures = new Set();
  for (const red of reds) {
    const parts = (red.parts ?? []).filter((part) => part.status === 'red');
    if (parts.length === 0) {
      return {
        ok: false,
        reason: 'no-failed-files',
        detail: `layer ${red.layer} named no failed part`,
      };
    }
    // The layer's own tail is read for the tree's signatures and never for the
    // world's: a part is what says which files failed, and the tail is what
    // catches an assertion printed outside any part.
    const treeInTail = matched(CODE_SIGNATURES, red.output ?? '');
    if (treeInTail.length > 0) {
      return {
        ok: false,
        reason: 'code-signature',
        detail: `layer ${red.layer} shows ${treeInTail.join(', ')}`,
      };
    }
    const names = [];
    const files = [];
    for (const part of parts) {
      const named = (part.failedFiles ?? []).filter((file) => typeof file === 'string');
      if (named.length === 0) {
        return {
          ok: false,
          reason: 'no-failed-files',
          detail: `${red.layer}/${part.name} named no failed file`,
        };
      }
      const text = part.output ?? '';
      const tree = matched(CODE_SIGNATURES, text);
      if (tree.length > 0) {
        return {
          ok: false,
          reason: 'code-signature',
          detail: `${red.layer}/${part.name} shows ${tree.join(', ')}`,
        };
      }
      const hits = matched(transient, text);
      if (hits.length === 0) {
        return {
          ok: false,
          reason: 'no-signature',
          detail: `${red.layer}/${part.name} shows no signature of a cause outside the tree`,
        };
      }
      names.push(part.name);
      for (const file of named) files.push(file);
      for (const hit of hits) allSignatures.add(hit);
    }
    for (const file of files) allFiles.add(file);
    layers.push({
      layer: red.layer,
      parts: names,
      files: [...new Set(files)].sort(),
      // The files each part named, kept beside the union. The union is what a
      // reader wants; the mapping is what a re-run of these files somewhere
      // else has to have, because a path filter belongs to the part that named
      // it (ADR-0065).
      byPart: Object.fromEntries(
        parts.map((part) => [part.name, [...new Set(part.failedFiles ?? [])].sort()]),
      ),
      signatures: [...new Set(parts.flatMap((part) => matched(transient, part.output ?? '')))].sort(),
    });
  }
  return {
    ok: true,
    layers,
    files: [...allFiles].sort(),
    signatures: [...allSignatures].sort(),
  };
}

/**
 * The hosts a set of signature texts names, matched against the credentials
 * the project declares. A signature host resolves to the credential whose
 * declared host it equals or ends with, so `<project>.api.sanity.io` resolves
 * to `api.sanity.io` and nothing resolves to a suffix nobody declared.
 *
 * @param {string} text the evidence to read hosts out of
 * @param {Array<{name: string, hosts?: string[], probe?: string}>} credentials
 * @returns {{credential: object, host: string, named: string}|null} the first
 *   declared host the text names, with the credential that owns it
 */
export function credentialHostIn(text, credentials = []) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const found = text.toLowerCase().match(HOSTNAME) ?? [];
  for (const named of found) {
    for (const credential of credentials) {
      for (const host of credential.hosts ?? []) {
        const declared = String(host).toLowerCase();
        if (named === declared || named.endsWith(`.${declared}`)) {
          return { credential, host: declared, named };
        }
      }
    }
  }
  return null;
}

// A hostname as it appears in a runner's output: two or more labels, a letter
// somewhere in the last one. It over-matches a package name or a filename by
// design — the match only counts when a project declared the host it resolves
// to.
const HOSTNAME = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+\b/g;
