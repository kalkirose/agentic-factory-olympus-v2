# ADR-0002: Telemetry store shapes

Status: accepted (2026-08-10)

## Decision

The three stores and two indexes from the locked design get these concrete
shapes:

- **Ledger ids.** Stream indexes point at a source ledger by id: `instance`,
  `escapes`, or `run:<runId>`. Readers resolve a run id to the live location
  first, then the archive.
- **Stream index entry.** One JSON line: `ledger`, `seq`, `ts`, `event`,
  `gist`. The store appends the entry in the same call that appends the
  source event, so indexing holds by construction. A stream-classed append
  must carry a one-line `gist`; the append is refused before the ledger
  write when it does not.
- **Index first, ledger second.** Within that call the index entry is
  written and synced before the source line is. A reader outside the daemon
  reads the two files at two moments, so one of the two orders is a lie it
  can catch: a park readable in a run ledger while the queue that indexes it
  still answers empty. The other order tells no lie — a pointer whose record
  is not written yet names nothing, and every index reader joins to the
  source record and skips a pointer that finds none. A stream-classed line
  is therefore never readable before it is findable.
- **Resolution pairing.** A `resolved` event in the source ledger carries
  `resolves` (the target seq). Loud events take a resolution, as do the quiet
  records that name a job the harness owes itself; the store refuses unknown
  targets and double resolution. The open set = index entries without a
  linked resolution, and for a record that carries no index entry, a read of
  its own ledger.
- **Escapes linkage.** `escape-fixed` and `escape-marked-fixed` carry `fixes`
  (the seq of their `escape-recorded`): the first is a repair run's close-out,
  the second an operator's out-of-band mark with the evidence it stands on. A
  repair fix's category and attribution are the final values; the recorded
  ones stay a routing hint, and a mark reclassifies nothing. One fix per
  record, by either event.
- **Archive layout.** `archive/runs/<runId>` under the daemon home. The
  whole run directory moves after `run-closed`; an open run does not
  archive. Readers fall back to the archive, so open loud items outlive
  their run. What the move does when a held file handle blocks it is
  ADR-0015.
- **Window math.** The escapes window divides by the window size (10), not
  by the ship count, so the ceiling stays conservative before ten ships.

## Why indexes as derived data

The full event lives only in its source ledger. An index entry is a pointer
plus a gist — enough for a console to render without a second read. A lost
or torn index line loses no truth: the indexes are rebuildable by one scan
over the ledgers.

## Why writer-side pairing checks

The reader could tolerate dangling resolutions, but a refused bad write is
cheaper than a query that must defend against one. The store validates
resolution targets and escape links at append time by one read of its own
file; ledgers are small and the writes are rare.

## Fallback path

If per-append file reads become a cost (very long instance ledgers), move
the pairing state into memory held by the daemon, rebuilt at start from one
scan. Trigger: measurable append latency in the daemon's own telemetry.
Reversal cost: low — the checks sit behind the store methods.

If the archive move proves wrong for retention (run directories grow large),
switch to archiving the ledger file alone and deleting artifacts by policy,
by a new ADR. Reversal cost: low — readers already resolve through
`ledgerPathFor`.
