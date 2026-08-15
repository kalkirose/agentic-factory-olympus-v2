# ADR-0029: Park answer forms

Status: accepted (2026-08-15)

A park is the harness asking the owner a question and waiting for the answer.
The question has always been on the record. What the park would accept back
was not. That lived in the source of the site that raised the park, and in the
engine's validator, and nowhere the operator could read.

## Decision

Every park record carries `answers`, the record's own statement of what it
takes back:

```json
"answers": { "options": ["retry", "abandon"], "text": "a note on what you repaired" }
```

- **The site declares, the engine writes.** A park directive names the options
  it offers, the free-text slot it wants, or both. `text` is the label of that
  slot and says what the text is for. The engine writes the declaration onto
  the record. A directive that declares neither an option nor a text slot is a
  defect: the stage asked a question it will not read the answer to, and the
  engine stamps a liveness violation instead of parking.
- **`abandon` is added by the engine.** Every park of a run offers it, because
  the engine puts it in every declaration rather than trusting each site to
  remember it. `abandon` takes the close-by-abandon route of ADR-0015.
- **The record validates the answer.** One function reads the declaration and
  judges an answer against it. The engine uses it for run parks and the daemon
  for instance parks, so both surfaces accept the same thing.
- **Every refusal quotes the declaration.** A rejected answer says what the
  park does accept, in the same line: `option not offered by the escalation
  record: proceed — this park accepts --option retry|abandon or --text "<a
  note on what you repaired>"`. A refusal is one read from a good answer.
- **The console renders from the declaration.** `olympusctl queue` prints the
  options, the text label and the command line that takes them, off the record.
  The line an operator reads is the line the engine will accept.
- **A provisioning gate takes both forms.** Every gate declares the option
  `retry` and a text slot. The gate re-reads the substrate on either answer, so
  the option carries the whole answer and the text carries a note beside it.
- **The instance park is the exception, and says so.** A `card-invalidated`
  park belongs to a card and not to a run, so it offers no `abandon`: there is
  no run to close. Its record declares a text slot alone, and a refusal names
  it.
- **An undeclared record derives its forms.** A park written before this
  contract existed accepted its options, and free text, and owed an `abandon`
  it never offered. The reader gives such a record all three, so a run parked
  across the upgrade stays answerable from its own record.

## Why the record has to state the forms

An operator met a provisioning gate in a live run and could not answer it.
The park carried a question and no options. `--option retry` came back as
"option not offered by the escalation record: retry", which says what failed
and nothing about what would work. Finding `--text` took a read of the engine's
validator and of the console's argument parser.

The habit was not the operator's mistake. Recovery parks take `--option
retry|abandon`, and they are the parks an operator meets most, so the option
form is the form the hand reaches for. Provisioning gates took free text only.
Nothing on the park said which kind it was, so the only way to tell two park
classes apart was to read the lane that raised them.

Then the rejected answer sat in the control queue and the run stayed parked.
The park offered no `abandon`, so the run could not be closed by the route
ADR-0015 built for exactly that. The one exit left was a kill, which is the
route for a run that stopped being a run, not for a decision the owner made.

Three defects, one cause: the park record did not carry its own contract. A
question is answerable only when the record says what an answer looks like.

## Why the engine adds the abandon

The alternative is a review rule: every new park site must remember to offer
`abandon`. Ten park types were authored under that rule and four of them
offered `fail` instead, one offered nothing, and the recovery types offered the
real thing. That spread is what a convention produces. Adding the option in the
one place that writes every park record makes the guarantee structural, and a
structural test can then walk the whole catalog and hold it.

## Why the option parks lost `fail`

`fail` and `abandon` were the same act under two names: a human decides the
run is not worth continuing, and the run closes `failed` on the condition its
park recorded. Four park types offered `fail` and each one carried its own
close directive with its own literal reason, which is four ways to reach one
state.

They are now one. Every park offers `abandon`, the abandon route closes on the
park's recorded reason, and a park that records none closes on the condition
its type names, so the ledger reads exactly as it did. The closed set of
terminal routes drops from seven entries to two, and the structural test that
holds that set got shorter rather than longer.

## Fallback paths

If one shared label per park class proves too coarse — an operator answers the
right form with the wrong content — the declaration gains a per-site example
beside the label. Trigger: two answers that parse but say nothing the stage can
use. Reversal cost: low. One more optional field, rendered under the text line.

If the `abandon` on every park proves too easy to reach, and a run is closed
that the owner meant to retry, the option gains a confirmation: the console
asks for the run id back before it queues the command. Trigger: one abandoned
run the owner did not intend. Reversal cost: low. The change is in the console,
and the engine keeps taking the answer it always took.

If a park class needs an answer shape that is neither an option nor a line of
text — a file, a structured record — the declaration gains a third form and the
validator a third branch. Trigger: a park whose answer an operator cannot type.
Reversal cost: medium. The forms line, the console render and the validator all
learn one more case.

If the derivation for undeclared records outlives its use, it goes. Every park
record written after this decision declares its forms, so the derivation is
only for ledgers that predate it. Trigger: no open run older than the change.
Reversal cost: none. One branch of one function.
