# ADR-0075: Judge the records in a stage of their own

Status: accepted (2026-09-07)

## Context

The reconciliation used to hang on the verdict's repair ladder. A record commit
re-entered the verdict. A record round spent a repair cap. A red record layer
reset the tree. The cost was live. A repair round after a green reconciliation
shipped under a stale one, because the ship matched one green render against the
head sha.

## Decision

A stage of its own judges the records, and nothing in it changes a verdict.

`src/lanes/reconcile.mjs` holds the stage. Every lane graph names it between the
verdict and the update. The records lane names it after its records stage.
`reconcileStep` derives ten steps from the stage's own stamps since the last
`fresh-pass`: judge, write, spectrum, review, verify, render, correct, recheck,
stall, done. A restart at any boundary resumes that step. Each dispatch signs its
commit with the run, the seat and the round's position, so a restart repeats no
committed write.

**Two grounds, two shas.** `certifiedTrees` in `src/lanes/ship.mjs` returns two
trees with two greens: the code tree at the last code commit, the record tree at
the last record commit. The admission gate requires both. The verdict reads no
record stamp, so a corrective round buys no code cycle.

**Two questions at the merge.** `groundVerdict` in `src/lanes/fastpath.mjs` lists
the incoming files once. It answers each certification on its own ground. The
code ground is what the suites declare. The record ground is the run's own
records and their neighbourhood. `pre-verdict-update` stamps both answers after
the fast path decides. The update returns `{next: 'ship'}`, `{next: 'verdict'}`
or `{next: 'reconcile', rerun: true}`. A record re-run spends the update cap.

**The write.** One `reconcile-write:<n>` per record, in sequence, each with its
own reset, commit, checks and budget. `reconciliation-written` carries one entry
per record: the seat, the cost, the attempts, the units answered.

**The recheck.** Every `claim` unit carries the evidence path that answered it.
After a repair round past a green render, a fresh judge reads the delta alone.
The units whose evidence the delta touched are re-answered and reviewed. Every
other unit keeps its answer. `reconcile-recheck` stamps the delta, the units and
the result. An empty intersection stamps `kept`.

**The stall.** A red render buys a corrective round under
`gates.reconcileRounds`. At the cap the stage takes the fallback and asks nobody.
`reconcile-stall` is loud. The story and repair lanes ship the code and ticket
the records: `cause: 'record-cap'`, `partial: true`, `residual`. The records lane
closes with reason `reconcile-cap` and tickets from the run branch.

## Consequences

A record cycle costs one review seat per record and the verifier. The write is
sequential, and `record-write-time` says when that stops paying.
`reconcile-rendered.open` mixes finding ids and layer names, so a reader filters
by the finding index.

A record re-run gives the ship token back under its own reason.
`src/lanes/ship.mjs` calls `releaseShipToken(ctx, 're-reconcile')`, and
`SHIP_TOKEN_RELEASE_REASONS` in `src/ship/token.mjs` holds that reason beside
`re-verdict` and `park`. `releasedForVerdict` reads the reason back and sends a
restart in the crash window to the reconcile stage.

This record is superseded when `record-cycles` breaches over a window whose
briefs were already tightened once.

## Rejected options

- The reconciliation on the verdict's ladder: the stale ship above.
- One certification at the head sha: the record commit moves the head.
- A stamp between the certifications: a file intersection is checkable.
- A park at the cap: the owner refused it.
- Parallel writers in disposable worktrees: the owner refused them.

## Fallback path

The alternative is one corrective round: `gates.reconcileRounds` set to 1. The
switch trigger is a reconciliation that costs more than its story. The reversal
cost is one config value.

## References

- ADR-0007, ADR-0026, ADR-0033, ADR-0056, ADR-0073, ADR-0074
- `src/lanes/reconcile.mjs`
- `src/lanes/ship.mjs`
- `src/lanes/fastpath.mjs`
- `src/ship/token.mjs`
- `src/tripwires/registry.mjs`
