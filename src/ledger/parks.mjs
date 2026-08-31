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
 *
 * `reasoned` names the options that take the text as well as the option word.
 * An option is in it when answering with it costs the run a check it did not
 * pass, so the record it leaves has to say why (ADR-0062).
 * @param {{options?: string[], text?: string, reasoned?: string[]}} declared
 */
export function runParkForms({ options, text, reasoned } = {}) {
  return forms({ options: [...(options ?? []), ABANDON], text, reasoned });
}

/**
 * The declaration an instance park writes. It carries no `abandon`: the park
 * belongs to a card rather than to a run, and there is no run to close.
 * @param {{options?: string[], text?: string, reasoned?: string[]}} declared
 */
export function instanceParkForms({ options, text, reasoned } = {}) {
  return forms({ options, text, reasoned });
}

function forms({ options, text, reasoned }) {
  const offered = [...new Set(options ?? [])];
  // A reasoned option the park does not offer would be a rule about an answer
  // nobody can give, so the list is narrowed to what is on the record.
  const requires = [...new Set(reasoned ?? [])].filter((option) => offered.includes(option));
  return {
    ...(offered.length > 0 && { options: offered }),
    ...(typeof text === 'string' && text.length > 0 && { text }),
    ...(requires.length > 0 && { reasoned: requires }),
  };
}

// A park recorded before the declaration existed. It accepted its options and,
// from the engine, free text at any park; it owed an abandon it never offered.
// The derivation gives that record all three, so a run parked across the
// upgrade is answerable from what its own record says.
const UNDECLARED_TEXT = 'your answer';

/**
 * What a park record accepts, whether it declared it or predates the
 * declaration. A record written before `reasoned` existed requires the text
 * for no option, which is what those parks took.
 * @param {object} record a `park` ledger line
 * @returns {{options: string[], text: string|null, reasoned: string[]}}
 */
export function acceptedForms(record) {
  const declared = record?.answers;
  if (declared) {
    return {
      options: declared.options ?? [],
      text: declared.text ?? null,
      reasoned: declared.reasoned ?? [],
    };
  }
  return {
    options: [...new Set([...(record?.options ?? []), ABANDON])],
    text: UNDECLARED_TEXT,
    reasoned: [],
  };
}

/** The one line a park says about what it will take. */
export function formsLine(record) {
  const { options, text, reasoned } = acceptedForms(record);
  const ways = [];
  if (options.length > 0) ways.push(`--option ${options.join('|')}`);
  if (text) ways.push(`--text "<${text}>"`);
  const line = ways.length > 0 ? ways.join(' or ') : 'no answer';
  if (reasoned.length === 0) return line;
  return `${line}; --option ${reasoned.join('|')} takes --text as well`;
}

/**
 * Validates a human answer against the record's declaration. Every refusal
 * names the forms the park does accept, so a rejected answer is one read from
 * a good one.
 * @param {object} record a `park` ledger line
 * @param {{option?: string, answer?: string}} given
 */
export function checkAnswer(record, { option, answer }) {
  const { options, text, reasoned } = acceptedForms(record);
  if (option !== undefined) {
    if (!options.includes(option)) {
      throw new Error(
        `option not offered by the escalation record: ${option} — this park accepts ${formsLine(record)}`,
      );
    }
    // The reason a reasoned option owes. It is refused here rather than
    // recorded empty, because the whole worth of that answer to a later reader
    // is the sentence beside it (ADR-0062).
    if (reasoned.includes(option) && !(typeof answer === 'string' && answer.trim().length > 0)) {
      throw new Error(
        `--option ${option} takes the reason for it — this park accepts ${formsLine(record)}`,
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
