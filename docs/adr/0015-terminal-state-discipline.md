# ADR-0015: Terminal-state discipline

Status: accepted (2026-08-13)

## Decision

A run reaches `run-closed` through three routes only:

1. the ship step's close-out, which closes `shipped`;
2. a human kill, which closes `killed`;
3. a human answering a park with its abandon option, which closes `failed`.

Every other condition that a lane meets on its own parks the run. A refusal
that happens before provisioning throws at the console or at the daemon
handler and opens no run at all, so it stamps nothing.

- **Three recovery park types** join the closed catalog: `seat-failure` (a
  seat work product past its corrective invocation), `stage-blocked` (a stage
  precondition the run cannot settle itself), and `command-error` (a
  configured command that could not run). Each one offers the same two
  options, `retry` and `abandon`. No new ledger event type: a recovery park
  is the same `park` event under a new type.
- **The park carries the close it replaced.** The park event holds `reason`
  and `detail`, which are the close directive the condition would have taken.
  `abandon` closes on that record, so the run fails on the original reason
  with its original fields, whatever the resumed stage meets afterwards.
- **The abandon guard runs at stage entry.** `withAbandonGuard` wraps every
  handler of every lane. An answered abandon closes the run before the stage
  spends anything else, so the answer never buys one more seat.
- **One answer buys one attempt.** A bought retry re-enters the stage once.
  The failure that follows it parks again, and the next answer is a fresh
  decision. Nothing loops on its own authority, and no arm counts elapsed
  time.
- **The retry carries the evidence.** In a lane contract loop the bought
  retry is one invocation with the recorded defect list in its brief, not a
  second corrective round. The corrective round already ran before the park.
  A resume-by-report shortcut is bypassed for that invocation: the stamped
  report is the one the checks refused, so replaying it buys nothing.
- **The ledger is the only state.** The retry budget, the abandon answer and
  the original reason all derive from the run ledger. A daemon restart
  replays to the same position, and a parked run waits on the human across
  the restart.
- **Judging seats are covered.** A triage or verifier seat that fails its own
  deterministic checks parks under `seat-failure`. A judge that cannot
  deliver a usable verdict is not the run failing.
- **A corrected intake ticket may ride the answer.** A `stage-blocked` answer
  whose text is an absolute path replaces the repair lane's ticket path. The
  verdict stage and the ship step both read it from the ledger.
- **A structural test holds the closed set.** It scans the source for every
  close directive, asserts the set of `state:reason` routes, and asserts that
  `run-closed` is stamped in the engine alone, from the directive route and
  the kill. A new close route fails CI until it is added deliberately.

Nothing else changes. The spec-gate exhaustion park keeps its own options
(`round` and `abandon`). The four option parks that already close on a human
answer keep their reasons (`spec-gate-exhausted`, `second-zero-kill`,
`unkilled-gap-survivor`, `second-stall`). The model-unavailable degradation,
the human kill path, the seat runner's single corrective re-prompt and the
park catalog's answer plumbing are untouched.

## Why a recoverable failure is a decision, not a defect

Three runs died to conditions that a human could have cleared in a minute.

A suite seat returned a report that did not validate twice, and the run
closed. That run held a frozen suite and a full verdict. A triage seat named
a persisting finding id that was not in the open prior set, which is a
bookkeeping mismatch in one field of one report, and the run closed after a
complete dev pass. The two closes discarded more than $150 of sound work.

None of the three conditions said anything about the story, the spec or the
tree. Each one said that a seat had a bad minute, or that an input was in the
wrong place. The harness answered a cheap defect with the most expensive
action it has: it threw away everything the run had earned, and the relaunch
paid for all of it again.

A close is cheap only while a run holds nothing. Before the first seat runs, a
close costs a provisioning cycle. After the freeze, a run holds a validated
spec, a suite proven red and killed against adversaries, one or more dev
passes and a rendered verdict. Re-deriving that set costs the whole run. The
machine cannot weigh that, because it knows neither what the artifacts are
worth nor what a relaunch would cost. The owner knows both.

So the failure stops the run and waits. The park frees the slot like every
other park, the evidence is already in the ledger, and the owner spends one
answer to buy a retry or to abandon the run on purpose.

## Why the spec-gate precedent generalizes

The spec gate reached this conclusion one milestone earlier, on the same kind
of evidence: a run closed on a list of known findings with about $21 of seat
work in it, and the fresh birth that replaced it re-derived every one of them.
The gate's answer was to park at the cap with `round` and `abandon` instead of
closing, and to count the granted rounds from the answered parks in the
ledger.

That answer never depended on anything specific to the spec gate. Its
premises are that the run holds work the condition does not invalidate, that
the machine cannot price the relaunch, and that an unbounded retry is unsafe.
All three hold for an invalid report, a work-product defect, a missing input
and a command that will not spawn. The shapes carry over one for one: the
options are two, the grant is exactly one attempt, the count comes from the
answered parks, and the ledger replays it.

The one shape that does not carry over is the round counter. The gate spends
rounds that can succeed, so a spent grant must not satisfy the next cap, and
the gate keys its park on the round. A recovery park needs no key: the failure
itself proves that the last retry was spent, and an abandoned park closes the
run at the next stage entry, so no stale answer can survive.

## Fallback paths

If a recovery type costs more human attention than it saves, that type
returns to a close. Trigger: three consecutive parks of one type answered
`abandon`. Reversal cost: low. The helper returns a close directive again and
the catalog entry can stay.

If one attempt per answer proves too coarse for a seat that fails in bursts,
the option set gains a counted grant like the spec gate's `round`, with the
same ledger-derived accounting. Trigger: two runs in which the owner answers
`retry` three or more times for one seat. Reversal cost: low. One counter and
one option string.

If three types prove too coarse for the console queue, `stage-blocked` splits
per stage so the queue line says what the answer must fix. Trigger: an
operator cannot tell from the queue what an answer costs. Reversal cost: low.
Catalog entries plus the call sites that name them.

If the park detail on the ledger grows past a readable line, the close keeps
the reason alone and the detail stays in the park record. Trigger: a park
event that no console can render. Reversal cost: low. One spread disappears
from the abandon route.
