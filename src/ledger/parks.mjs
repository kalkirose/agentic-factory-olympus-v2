// The answer-forms contract. Every park record says what the park will take
// back from the human: the options it offers, and whether it takes free text
// and what that text is for. The declaration is written once, at the park, and
// three readers use it — the engine and the daemon validate an answer against
// it and echo it whenever they refuse one, and the console renders the answer
// line from it. A park whose accepted forms live only in the source is a park
// the operator cannot answer without reading the source (ADR-0029).
//
// Every run park also offers `abandon`, added here rather than at the park
// sites, so no park can be authored without the human's way out of it
// (ADR-0015). An instance park has no run behind it and offers none.

/** The option that closes a run by the abandon route. */
export const ABANDON = 'abandon';

/**
 * The declaration a run park writes: the site's own options plus `abandon`,
 * and the free-text slot when the site wants one. `text` is the label the
 * console shows for that slot, so it states what the text is for.
 * @param {{options?: string[], text?: string}} declared
 */
export function runParkForms({ options, text } = {}) {
  return forms({ options: [...(options ?? []), ABANDON], text });
}

/**
 * The declaration an instance park writes. It carries no `abandon`: the park
 * belongs to a card rather than to a run, and there is no run to close.
 * @param {{options?: string[], text?: string}} declared
 */
export function instanceParkForms({ options, text } = {}) {
  return forms({ options, text });
}

function forms({ options, text }) {
  const offered = [...new Set(options ?? [])];
  return {
    ...(offered.length > 0 && { options: offered }),
    ...(typeof text === 'string' && text.length > 0 && { text }),
  };
}

// A park recorded before the declaration existed. It accepted its options and,
// from the engine, free text at any park; it owed an abandon it never offered.
// The derivation gives that record all three, so a run parked across the
// upgrade is answerable from what its own record says.
const UNDECLARED_TEXT = 'your answer';

/**
 * What a park record accepts, whether it declared it or predates the
 * declaration.
 * @param {object} record a `park` ledger line
 * @returns {{options: string[], text: string|null}}
 */
export function acceptedForms(record) {
  const declared = record?.answers;
  if (declared) {
    return { options: declared.options ?? [], text: declared.text ?? null };
  }
  return {
    options: [...new Set([...(record?.options ?? []), ABANDON])],
    text: UNDECLARED_TEXT,
  };
}

/** The one line a park says about what it will take. */
export function formsLine(record) {
  const { options, text } = acceptedForms(record);
  const ways = [];
  if (options.length > 0) ways.push(`--option ${options.join('|')}`);
  if (text) ways.push(`--text "<${text}>"`);
  return ways.length > 0 ? ways.join(' or ') : 'no answer';
}

/**
 * Validates a human answer against the record's declaration. Every refusal
 * names the forms the park does accept, so a rejected answer is one read from
 * a good one.
 * @param {object} record a `park` ledger line
 * @param {{option?: string, answer?: string}} given
 */
export function checkAnswer(record, { option, answer }) {
  const { options, text } = acceptedForms(record);
  if (option !== undefined) {
    if (!options.includes(option)) {
      throw new Error(
        `option not offered by the escalation record: ${option} — this park accepts ${formsLine(record)}`,
      );
    }
    return;
  }
  if (typeof answer === 'string' && answer.length > 0) {
    if (!text) {
      throw new Error(`this park takes no answer text — it accepts ${formsLine(record)}`);
    }
    return;
  }
  throw new Error(`an answer is required — this park accepts ${formsLine(record)}`);
}

/** True when an answer takes the abandon route. */
export function isAbandon(answer) {
  return answer?.option === ABANDON;
}
