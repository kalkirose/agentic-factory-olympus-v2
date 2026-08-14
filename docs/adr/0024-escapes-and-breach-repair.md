# ADR-0024: The escapes ledger and breach repair

Status: accepted (2026-08-14)

## Decision

A red-merge breach ends with a repair the factory owes itself, and the owed
work is derived from ledgers rather than held by whoever noticed it.

- **The escapes ledger exists by construction.** `scaffoldHome` creates
  `escapes.ledger.jsonl` at every daemon start, beside the instance ledger,
  and creates `tickets/` with it. The append never truncates, so a home with
  history keeps it. An empty ledger is a measured zero; a missing file is an
  unmeasurable hole, and the escapes-per-story metric reads the two the same
  way — healthy — while one of them is measuring nothing.
- **The escape lifecycle takes a third event.** `escape-ticketed` joins
  `escape-recorded` and `escape-fixed` in `ESCAPES_EVENTS`, linked by the
  recorded seq. It carries the absolute path of the repair ticket the harness
  wrote for that escape. The ticket path cannot ride the record: the ticket
  names the escape's seq, and the seq exists only once the record is
  appended.
- **The breach order is ticket, stamp, enqueue.** Per converted escape,
  close-out writes the repair ticket into the daemon home
  (`tickets/escape-<seq>.md`), then stamps `escape-ticketed` against it, then
  hands the breach to the frontier. The ticket file is written before the
  stamp that names it, so a ticketed escape always has a ticket to repair
  from; the stamp is the last step that must succeed for the record to stay
  actionable, and everything after it may fail without losing the repair. The
  `red-merge-breach` stamp (loud) carries the escape seqs and the ticketed
  subset.
- **The ticket is self-contained.** The repair seat reads it from a fresh
  worktree of the default branch and can see nothing of the run that shipped
  the defect — not its ledger, not its spec, not its tree. So the ticket
  carries the defect line, the escape seq, the category and attribution, the
  merged PR with its url, the branch, the head sha at the merge, the merge
  commit, and every red check with the tail of its output.
- **The breach enqueues; it never launches.** `shipStep({enqueueRepair})`
  replaces `shipStep({spawnRepair})`. At slot cap 1 the breaching run still
  holds its slot through its own close-out, so an inline launch fails exactly
  when it matters, and a spawn failure used to leave the escape as its own
  tracking record and nothing else. The hand-off asks the frontier to sweep;
  the owed work is durable without it, so a hand-off that never lands costs
  one sweep and no repair. `lanes/assemble.mjs` takes the hand-off and the
  daemon binary passes its frontier sweep. Nothing in the lane graph launches
  a run.
- **The sweep owns the repairs.** A sweep has two passes: owed repairs, then
  the story frontier. The owed set is derived at every sweep from the two
  ledgers — an escape that carries a ticket, has no fix, and is named by no
  repair run's launch stamp (`escapeSeq`, which the launch payload carries
  and close-out's fix-back already reads). Owed repairs launch oldest first
  while slots allow. A repair still waiting on a slot stands the story pass
  down for that sweep: the slot that frees while a sweep reads the graph
  belongs to the repair, and the close that frees it queues the sweep that
  takes it. A launch that fails outright ends the pass and leaves the story
  frontier moving — a repair that cannot launch at all must not stop
  everything else.
- **One sweep, one arming.** The arming state is read once per sweep and
  decides both passes; every launch still re-reads the live state before it
  spends. A sweep that judged its repairs against a paused project must not
  then fill slots with stories because the owner armed in between, and that
  transition queues its own sweep. Sweeps are queued for every project now,
  armed or not: a paused project launches nothing and still owes the
  owed-repairs judgment.
- **A pause is never bypassed.** A breach repair is a defect on shipped code,
  but a pause is a deliberate act of the owner. A sweep that finds owed
  repairs on a project that is paused (or was never armed) stamps
  `repairs-owed` (new, loud, instance-scoped) naming the owed escape seqs,
  and launches nothing. Dedupe is by escape seq: a seq an open stamp already
  names never stamps again, so a breach during the pause stamps for its own
  seqs alone. The sweep appends the paired `resolved` once none of the seqs a
  stamp names is owed any longer — the repairs launched, or the escapes were
  fixed by hand.
- **A launched repair is answered, whatever it does next.** The owed set
  keys on the launch stamp, not on the outcome. A repair run that failed or
  was killed is not owed again, for the same reason a spent card never
  auto-relaunches (ADR-0009): relaunching a failure burns compute in a loop
  no park covers. The console relaunches it with one command.

## Why the owed set is derived and never stored

The breach and the launch are separated by a slot, and often by a daemon
restart. A queue file between them would be a third authority that has to be
written, replayed, and pruned correctly, and every crash window in that
sequence is a lost or duplicated repair. Both facts already exist in
append-only ledgers that the harness maintains for other reasons: the escapes
ledger says what was ticketed, and a repair run's own launch stamp says what
has been answered. Subtracting one from the other at every sweep gives
restart idempotency for nothing, and no duplicate launch for one escape seq
is a property of the derivation rather than of the bookkeeping.

## Why `escape-ticketed` is a third event and not a payload field

The ticket names the escape's ledger seq, and the seq exists only after the
record is appended, so a ticket path in the `escape-recorded` payload would
have to name a file whose content could not yet be written. The alternatives
were a ticket path derived from the run id and an index — which would let a
record point at a file that a crash prevented from ever existing — or a
second write into the ticket after the record, which leaves the file's own
content finalized after the record that vouches for it. A separate stamp
follows the file it names, and the closed registry (ADR-0002) is where a
lifecycle state belongs.

## Why the repair pass runs before the story pass

Both passes spend the same slots. A breach repair is a defect on code that is
already on the default branch, and it exists because the harness merged red;
a story is work that has not started. Putting repairs first is the same rule
the response ladder applies inside a run: close what is broken before opening
what is new.

## Fallback paths

If the story frontier starves behind a repair that keeps failing to launch,
the pass already lets stories through on a launch failure; if it starves
behind repairs that launch and fail their runs, the owed set is unaffected —
a launched repair is answered. Trigger: repeated `launch-rejected` stamps on
the repair lane for one project. Fix: cap the repair pass at one launch per
sweep; reversal cost low, one counter.

If tickets accumulate in the home beyond usefulness, they are plain files
named by escape seq and the escapes ledger says which are answered; a pruner
is a read of that set. Nothing derives a ticket path a second way.

If `repairs-owed` proves noisy on a project that is paused for long stretches
by design, the stamp is one call site in the repair pass and its dedupe is by
escape seq; making it a queued item instead of a loud one is a one-line
change to the registry's stream classing. Trigger: the owner resolving the
same stamp repeatedly without acting on it.
