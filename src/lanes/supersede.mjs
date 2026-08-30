// The card authorizes a supersede (ADR-0044).
//
// A story that extends a surface an earlier story pinned collides with the
// frozen suite by construction. Until now every one of those collisions was an
// intent question: the run parked, a human ruled, and because an answer binds
// one run, a killed run dropped the ruling and the next launch asked again.
// Most of those collisions were never questions. The card already answered
// them — a card whose scope covers the extension has sanctioned the amendment,
// and the arithmetic between the card and the suite is not the owner's job.
//
// So the default inverts. A collision the card covers is an authorized
// supersede: no park, an amendment through the re-freeze route the ruling
// already had, and a record of what was superseded and on whose words. A
// collision the card is silent about is a genuine intent gap and parks exactly
// as it always did. Authorization derives from the card, so it is re-derivable
// in every run: nothing survives a dead run because nothing needs to.
//
// Covered is a test of necessity, not of naming (ADR-0053). The card mandates a
// behavior whose implementation necessarily changes what the pinned clause
// asserts, and the amendment restates the guarantee that clause protected in its
// new form. Asking instead whether the card NAMES the colliding surface reads a
// card that mandates the change as silent, because a card states what the story
// must do and never which test files the answer disturbs.
//
// Nothing here judges scope. A reasoning seat reads the card and makes the
// claim; this module is the mechanical half of the bargain and it is the only
// site the `supersede-authorized` event is appended from:
//
//   - the quote must be in the card section the claim names, verbatim;
//   - the test must be one the run actually froze;
//   - a test the owner pinned parks whatever the card says.
//
// Every refusal is a park with its reason named, and the safe direction is
// always the park: a claim this module cannot check is a claim it does not
// take.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORESEEN_HEADING, FORESEEN_SECTION, cardSections } from './card.mjs';
import { underAny } from './shared.mjs';

/**
 * The marker a test carries to pin itself to the owner. One string, placed by
 * hand in the test file — a legal gate, a money path, anything whose change is
 * the owner's call and no seat's. A pinned collision parks with the card in
 * front of it, which is what makes the pin the exception and the card the
 * default.
 */
export const OWNER_PIN_MARKER = 'olympus:owner-pinned';

/**
 * The shortest quote that can carry an authorization. A three-word fragment
 * appears in every card ever written, so a quote below this length authorizes
 * nothing: the check would pass and say nothing about scope.
 */
export const MIN_QUOTE_CHARS = 24;

/**
 * The card sections a supersede authorization may rest on.
 *
 * A mandate is what covers a collision, and a card states its mandates in its
 * acceptance criteria, so that section carries authority beside the two that
 * bound scope. `foreseen` is the fourth: a close-out sweep that already found
 * the collision wrote the mandating line onto the card, and a note the machine
 * wrote out of the card is quotable evidence of the same mandate.
 */
export const SUPERSEDE_CLAUSES = Object.freeze([
  'acceptance',
  'scope-boundary',
  'decisions',
  'foreseen',
]);

// The headings each clause reads. `decisions` takes every section whose heading
// carries the word, so a card that writes "Open decisions" and a card that
// writes "Decisions" are read the same way.
const CLAUSE_HEADINGS = Object.freeze({
  acceptance: /acceptance/i,
  'scope-boundary': /scope boundary/i,
  decisions: /decisions/i,
  foreseen: FORESEEN_SECTION,
});

/**
 * The four fields a seat states a claim in, for the report schemas that carry
 * one. They are flat strings rather than an object because a claim rides
 * inside a nested report field at both sites, and the report contract nests
 * objects one level only.
 *
 * There is no `covered` boolean beside them, and that is deliberate. The
 * dangerous direction here is the one that skips the park, so the claim is the
 * four facts or it is nothing: a report that names no test, no assertion, no
 * quote and no clause has said the card is silent, and silence parks. A
 * boolean would be a fifth thing that can disagree with the other four.
 */
export const SUPERSEDE_CLAIM_PROPERTIES = Object.freeze({
  supersedes: { type: 'string' },
  supersedeAssertion: { type: 'string' },
  supersedeQuote: { type: 'string' },
  supersedeClause: { type: 'string', enum: [...SUPERSEDE_CLAUSES] },
});

/**
 * The lines that put the classification duty on a seat that can make a claim.
 *
 * The test is necessity, not naming. Asking whether the card NAMES the colliding
 * surface answers the wrong question: a card writes what the story must do, not
 * which test files the answer disturbs, so a card that mandates a second email
 * and never mentions the test counting emails reads as silent and buys an owner
 * a question its own criteria already settled. Asking whether an implementation
 * of the mandated behavior can leave the pinned assertion true is the question
 * the two documents can actually answer.
 */
export const SUPERSEDE_BRIEF_LINES = Object.freeze([
  'A frozen test that collides with this story\'s own scope is not automatically an owner question.',
  'Read the whole card. Its acceptance criteria, its Scope boundary, its Decisions and any ' +
    `"${FORESEEN_HEADING}" notes all carry authority. Answer one question: does the card mandate ` +
    'a behavior whose implementation necessarily changes what the pinned clause asserts? A yes ' +
    'is covered.',
  'The test is necessity, not naming. A card that never names the test file still covers the ' +
    'collision when no implementation of the mandated behavior can leave the pinned assertion ' +
    'true. A card that does name the surface covers nothing when the mandated behavior can be ' +
    'built with that assertion intact.',
  `A "${FORESEEN_HEADING}" note is evidence you may use: a close-out sweep already read this card ` +
    'as mandating this collision and wrote down the pinned clause, the file it lives in, and the ' +
    'card line that mandates the change. It answers the necessity test; it does not excuse it.',
  'When the card covers it, state the supersede: "supersedes" (the frozen test file), ' +
    '"supersedeAssertion" (the guarantee the pin protects and the form it now takes), ' +
    '"supersedeQuote" (the card line the mandate rests on, copied word for word out of the card), ' +
    'and "supersedeClause" ("acceptance", "scope-boundary", "decisions" or "foreseen").',
  'The amendment restates the pin\'s protected guarantee in its new form; it never deletes it. A ' +
    'pin that asserted a closed set of two becomes a pin that asserts the closed set of three the ' +
    'card mandates. An amendment that drops the guarantee is a defect, not a supersede.',
  'The quote is checked against the card mechanically. A quote that is not in the named section ' +
    'word for word is refused and the run parks, so copy the line and never paraphrase it.',
  'When the card mandates no such behavior, state no supersede. Silence is the owner\'s question, ' +
    'and stretching a card line to reach a collision it does not reach is a reviewable defect.',
]);

/**
 * Why a claim was not taken. Every entry is a park, and the sentence is what
 * the park question carries: an owner reading the escalation is told which
 * check refused and can go and look at the same two documents.
 */
export const SUPERSEDE_REFUSALS = Object.freeze({
  disabled:
    'the project turned card-authorized supersedes off, so every frozen-surface collision parks.',
  silent:
    'the seat claimed no card authority for this collision: the card mandates no behavior whose ' +
    'implementation necessarily changes what the pinned clause asserts, so the decision is the ' +
    'owner\'s.',
  'owner-pinned':
    `the frozen test carries the owner pin (${OWNER_PIN_MARKER}). A pinned collision parks whatever ` +
    'the card says.',
  'already-authorized':
    'this run already superseded that test on the card\'s authority, and the collision came back. ' +
    'One amendment per test is what the card can buy; a second is a question.',
  'test-not-frozen':
    'the claim names a test that is not in the frozen suite of this run.',
  'quote-too-short':
    `the quoted card line is shorter than ${MIN_QUOTE_CHARS} characters; a fragment that short ` +
    'authorizes nothing.',
  'quote-not-in-card':
    'the quoted line is not in the card section the claim names, word for word.',
  unrecorded:
    'the run ledger closed before the authorization could be written. An authorization nothing ' +
    'recorded is not one.',
});

/**
 * The claim a seat report carries, or null when it makes none. A partial claim
 * is no claim: the four fields are one statement, and three of them state
 * nothing a check can stand on.
 * @param {object|null|undefined} source the report field the claim rides in
 */
export function supersedeClaim(source) {
  if (!source || typeof source !== 'object') return null;
  const test = text(source.supersedes);
  const assertion = text(source.supersedeAssertion);
  const quote = text(source.supersedeQuote);
  const clause = text(source.supersedeClause);
  if (!test || !assertion || !quote || !SUPERSEDE_CLAUSES.includes(clause)) return null;
  return { test: test.replaceAll('\\', '/'), assertion, quote, clause };
}

/**
 * The one site `supersede-authorized` is appended from. Every check runs here,
 * so no call site can stamp an authorization it did not earn: the answer is
 * either the stamped event or the reason the run parks instead.
 *
 * @param {import('../telemetry/stores.mjs').TelemetryStore} store
 * @param {object} opts
 * @param {string} opts.actor
 * @param {'spec-gate'|'verdict'} opts.site where the collision was found
 * @param {object|null} opts.claim from `supersedeClaim`
 * @param {string} opts.cardText the card, as the run holds it
 * @param {string} [opts.cardPath]
 * @param {string} [opts.findingId] the verdict finding the collision came from
 * @param {string} opts.worktree
 * @param {string[]} [opts.testPaths]
 * @param {string[]} [opts.frozen] the frozen suite by name, where the run has one
 * @param {string[]} [opts.pins] owner-pinned files the freeze recorded
 * @param {boolean} [opts.enabled]
 * @returns {{event: object|null, refused: string|null, claim: object|null}}
 */
export function authorizeSupersede(store, opts) {
  const { actor, site, claim, cardPath, findingId } = opts;
  const refused = supersedeRefusal(opts);
  if (refused) return { event: null, refused, claim: claim ?? null };
  const event = store.append('supersede-authorized', {
    actor,
    site,
    ...(findingId && { finding: findingId }),
    test: claim.test,
    assertion: claim.assertion,
    cardQuote: claim.quote,
    clause: claim.clause,
    ...(cardPath && { card: cardPath }),
  });
  // A closed ledger drops the append and answers null. The record is the whole
  // of what an authorization is, so no record means no authorization.
  if (!event) return { event: null, refused: 'unrecorded', claim };
  return { event, refused: null, claim };
}

/**
 * The check, on its own, for a caller that needs the answer before it has a
 * ledger to write to. Returns the refusal key, or null when the claim stands.
 */
export function supersedeRefusal({
  claim,
  cardText,
  worktree,
  testPaths,
  frozen,
  pins,
  authorized,
  enabled = true,
}) {
  // In order: is this a claim at all, is the test one this run froze, is it the
  // owner's, has the card already bought its one amendment for it, and do the
  // words hold. Each answer is more specific than the one before it, so the
  // reason on the park is the most specific true thing about the claim.
  if (enabled === false) return 'disabled';
  if (!claim) return 'silent';
  if (!frozenTest(claim.test, { worktree, testPaths, frozen })) return 'test-not-frozen';
  if (ownerPinned(worktree, claim.test, pins)) return 'owner-pinned';
  // The spec gate passes the tests it already superseded. Nothing else there
  // bounds the route — a conflict spends no counted round — so one amendment
  // per frozen test is what stops a seat and a gate re-reporting each other
  // for ever. The verdict site passes none: the re-freeze it routes into is
  // spent once per ruling and stalls on its own if the amendment misses.
  if ((authorized ?? []).includes(claim.test)) return 'already-authorized';
  const quote = normalize(claim.quote);
  if (quote.length < MIN_QUOTE_CHARS) return 'quote-too-short';
  const authority = cardSections(cardText ?? '', CLAUSE_HEADINGS[claim.clause])
    .map(normalize)
    .join(' ');
  if (!authority.includes(quote)) return 'quote-not-in-card';
  return null;
}

/** The refusal as the sentence a park question carries. */
export function refusalLine(refused, claim) {
  const reason = SUPERSEDE_REFUSALS[refused] ?? refused;
  return claim ? `${reason} The claim named ${claim.test}.` : reason;
}

/**
 * Whether a test is pinned to the owner: the freeze recorded it, or the file
 * carries the marker now. A file this cannot read counts as pinned — the pin
 * exists to stop a machine deciding, and a check that cannot see the file has
 * not seen that it may decide.
 */
export function ownerPinned(worktree, file, pins = []) {
  if ((pins ?? []).some((p) => p.replaceAll('\\', '/') === file)) return true;
  try {
    return readFileSync(join(worktree, file), 'utf8').includes(OWNER_PIN_MARKER);
  } catch {
    return true;
  }
}

/** The files of a set that carry the owner pin. The freeze records the answer. */
export function ownerPinnedFiles(worktree, files) {
  return (files ?? []).filter((file) => {
    try {
      return readFileSync(join(worktree, file), 'utf8').includes(OWNER_PIN_MARKER);
    } catch {
      return false;
    }
  });
}

/** Every supersede this run authorized, in ledger order, after an optional seq. */
export function authorizedSupersedes(events, { after = -1 } = {}) {
  return (events ?? []).filter((e) => e.event === 'supersede-authorized' && e.seq > after);
}

/**
 * The ruling a set of authorized supersedes makes, in the shape a park answer
 * has. The re-freeze route was built to carry one ruling into the frozen suite,
 * and it reads that ruling off an event seq, an actor and a sentence naming the
 * files. A card citation is a second source of exactly that, so it travels the
 * same route rather than a parallel one: the `re-freeze` stamp spends it the
 * same way, and `source` on the stamp is what tells the two apart.
 * @returns {object|null}
 */
export function supersedeRuling(supersedes) {
  if (!supersedes || supersedes.length === 0) return null;
  const last = supersedes[supersedes.length - 1];
  return {
    seq: last.seq,
    parkSeq: null,
    source: 'card',
    actor: 'card',
    answer: [
      'The intent card authorizes these supersedes; amend each frozen test named here, ' +
        'exactly as far as the quoted card line reaches and no further. Restate what each pin ' +
        'protected in the form the card mandates; a pin is amended, never deleted:',
      ...supersedes.map(
        (s) =>
          `- ${s.test}: the assertion "${s.assertion}" is superseded. The card's ${s.clause} ` +
          `section says: "${s.cardQuote}"`,
      ),
    ].join('\n'),
  };
}

/** The executed supersedes as the lines a later reader is briefed with. */
export function supersedeLines(supersedes) {
  return (supersedes ?? []).map(
    (s) => `- ${s.test} — ${s.assertion} — ${s.clause}: "${s.cardQuote}"`,
  );
}

function frozenTest(test, { worktree, testPaths, frozen }) {
  if (Array.isArray(frozen) && frozen.length > 0) {
    return frozen.some((file) => file.replaceAll('\\', '/') === test);
  }
  const paths = Array.isArray(testPaths) ? testPaths : [];
  if (paths.length === 0) return false;
  return underAny(test, paths) && existsSync(join(worktree, test));
}

/**
 * Whitespace, and nothing else. A card wraps its prose across lines and a seat
 * copies the sentence, so a run of whitespace matches a run of whitespace;
 * every other character has to be the character the card carries.
 */
function normalize(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
