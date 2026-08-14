# ADR-0026: Decision-record reconciliation intake

Status: accepted (2026-08-15)

## Decision

Every shipped story run gets a fresh-context judgment on whether its diff
implements or contradicts any decision record, and an owed reconciliation
launches from the sweep without a human in the loop.

- **The judgment is a close-out seat.** After the card sweep, the story
  lane's close-out runs `reconcile-judge` (seat map: default model and
  effort; judges only, changes nothing) against the merge commit in the
  run's worktree. The seat locates the repository's decision-record tree
  itself (commonly `docs/adr/`); a repository without one is judged
  not-owed with that as the reason. Implementation counts even when the
  diff never touches the record files — that is the case a path filter can
  never see, and the reason this is a seat and not a glob.
- **Both verdicts stamp.** `reconciliation-judged` (run ledger) carries
  `owed`, the judged `records`, and the `reason`. A failed judgment stamps
  `ok: false` with the cause: an unjudged ship is a recorded miss, never a
  silent skip — the card-sweep failure semantics. No outcome blocks the
  close; the story shipped either way.
- **Owed writes the ticket first.** `tickets/reconcile-<runId>.md`, then
  the stamp — a stamped judgment always has a ticket to launch from
  (ADR-0024's ordering). The ticket carries the merge commit, the judged
  records, and the rewrite rules: implemented parts become standalone
  present-tense fact, rationale and fallbacks kept; unimplemented parts
  stay explicit open sections; a divergence between diff and decision is
  named verbatim, never absorbed; edits stay inside the record tree.
- **The sweep launches it.** The owed set derives at every sweep from the
  run ledgers alone: shipped story runs judged owed, minus the ships some
  reconciliation run's launch stamp (`reconcilesRunId`) already names —
  stored nowhere, restart-idempotent (the owed-repairs shape, ADR-0024).
  The pass runs after breach repairs and before the story frontier:
  defects on shipped code first, record hygiene second, new work third.
  A slot-blocked reconciliation stands the story pass down, stays owed,
  and the next sweep launches it.
- **The rewrite is a repair-lane run.** The ticket is the spec; the lane's
  gates and generalist review run in full and the rewrite ships through
  its own PR. The rewrite never rides the run that shipped the diff — the
  implementing context must not reconcile records against its own work.
- **A launched-and-failed reconciliation is not owed again.** Like a spent
  repair, it is a console decision.

## Why a seat and not automation on paths

The trigger condition — "the diff implements or contradicts a recorded
decision" — is semantic. The common case is a diff that implements a
decision without touching `docs/adr/` at all; a path filter reads that as
nothing happened. The first live cutover run shipped exactly that shape:
a payment story implementing several recorded decisions, records
untouched, and no mechanism anywhere that would ever have noticed. The
judgment costs one read-only seat per ship and buys the guarantee that
every ship is either reconciled or visibly owed.

## Why not-owed and failed are stamps, not silence

The prior state was manual intake, and its failure mode was not a wrong
judgment — it was no judgment, invisibly. Any mechanical filter that
silently skips rebuilds that failure mode inside the machine. Three
outcomes, all in the ledger: owed (with the ticket), not owed (with the
reason), unjudged (with the cause). The eval seat can count all three.

## Why reconciliations sit between repairs and stories in the sweep

A breach repair is a defect users can hit; it outranks everything. A
reconciliation is hygiene on shipped work, but letting new stories launch
ahead of it lets record drift compound under exactly the runs that read
those records for grounding. The frontier is only consulted after both
owed sets are empty or slot-blocked.

## Fallback paths

If the judgment seat proves noisy (owed on every ship, or never), pin its
verdict rate on the eval seat's ledger review and tighten the role block —
the seat's contract (report schema, stamp) does not change. Reversal cost:
prompt-only.

If a project's record tree needs an explicit location, add an optional
project-config field and pass it into the role block; discovery stays the
default. Trigger: a judged-not-owed ship whose repository holds records
somewhere unusual. Reversal cost: low — additive config.

If the repair lane proves wrong for docs-only rewrites (gate friction,
review mismatch), give reconciliation its own thin lane over the same ship
step. Trigger: two reconciliation runs parked on lane mechanics rather
than content. Reversal cost: medium — a lane assembly, no new machinery.
