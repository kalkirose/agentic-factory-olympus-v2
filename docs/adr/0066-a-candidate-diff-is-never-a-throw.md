# ADR-0066: A candidate diff is bounded, filtered, and never a throw

Status: accepted (2026-09-03)

## Decision

The diff a judgment seat reads is produced by `reviewDiff()` in
`src/isolation/tree.mjs`. Three rules bound it.

- **Every full-text diff read carries an explicit output cap.** The cap is
  `MAX_DIFF_BYTES` in `src/isolation/git.mjs`, 256 MB, and it is the harness's
  only number for this. `reviewDiff()` carries it, `evidenceDiff()` carries it,
  and the fast-path ship's two patch reads carry it. The runner's default cap
  is one megabyte, which a lockfile clears on its own.
- **A read past the cap answers short.** `gitCapped()` in
  `src/isolation/git.mjs` is the seam. Node stops the stream at exactly the
  cap, kills the child, and hands back the bytes it kept, so the read resolves
  with `{text, truncated: true}` rather than rejecting. Every other git failure
  still rejects, so a read that could not run is still an error.
- **Lockfiles and generated files are named, not pasted.** The patch leaves out
  every path matching `review.excludeFromDiff` in the project config. The
  default is `**/pnpm-lock.yaml`, `**/package-lock.json`, `**/yarn.lock` and
  `**/*.generated.*`. The excluded paths are still named to the seat, one
  `git diff --stat` line each, so the seat knows they changed and by how much.
  The key is validated in `src/config/project.mjs` and a value that is not a
  list of path entries fails the config.
- **A cut patch says so, to the seat and to the ledger.** The text ends on one
  line, `[diff truncated at <n> bytes; <m> files not shown: …]`, naming the
  files whose patch the seat never saw. The verdict stage stamps
  `diffTruncated: true` on the cycle's `verdict-rendered` and on every
  `finding` the round raised.
- **Name reads are untouched.** `--name-only` and `--name-status` answer about
  every path, lockfiles included. What a seat is shown and what a file set is
  derived from are different questions. The Fury interface seat is still seated
  by the whole changed-file set, and the diff policy still judges every path.

## What this is for

A candidate diff grows with the work, not with the repository. Installing four
packages into a project puts a lockfile change in that diff and takes it past
one megabyte on its own.

One live run did exactly that. All 29 of its gate layers were green. The
verdict stage then read the candidate diff, the read hit the runner's default
cap, and the handler threw with `stdout maxBuffer length exceeded`. The engine
reads a stage handler throw as a liveness violation (`executeStage()` in
`src/engine/engine.mjs`), so the run went inert with its whole spectrum green
and its work finished. The cost of a file nobody reviews was the run.

## Why the seat is told the names

A file that changed and is not in the diff is a hole a reviewer cannot see. A
seat handed a filtered patch with no statement about the filtering would judge
a tree it believes it read whole.

So the exclusion is a substitution and not a deletion. The seat gets the path
and the line count of every file held back, which is what a reviewer does with
a lockfile anyway: check that it changed, check that the size is plausible, and
read the source instead.

## Why the truncation is stamped on the cycle and not only on the findings

A review round that raises nothing raises nothing to carry the word. A clean
verdict over a partial diff is the case a reader most needs to be able to see,
and it is the case a per-finding field cannot record. So the cycle boundary
carries it too. Both fields are documented in `src/ledger/registry.mjs`.

## Why the cap is a quarter of a gigabyte

The cap exists to bound memory, not to bound diffs. Any number a real diff can
reach puts the harness back where it started, deciding what to do with half an
answer. 256 MB is past every diff a story produces and far below what a node
process can hold, so the truncation path is real, tested, and never taken by
ordinary work.

The cap is a ceiling and not an allocation. A one-kilobyte diff costs a
kilobyte.

## Resuming an inert run

A run left inert by a stage handler failure is resumed by the operator, with
the seq of the `liveness-violation` line in the run ledger:

```
olympusctl resolve --home <home> --run <runId> --seq <n>
```

`bin/olympusctl.mjs` queues the command. `src/daemon/daemon.mjs` dispatches it
to `Engine.resolve()`. That method clears the violation, finds no other open
one, and calls `executeStage(run)` on a run that is not parked, not held, holds
no seat, and never left its stage. The verdict handler re-derives its position
from the run ledger and the git state at every entry, so the re-entry is the
same recovery a daemon restart performs. `test/queue.test.mjs` walks the whole
path: a stage that violates, a `resolve` command, and a run that re-enters and
ships.

## Fallback paths

If a project needs its judgment seats to read a file this decision holds back,
it sets `review.excludeFromDiff` to its own list. An empty list filters
nothing, which is the behaviour of the harness before this decision. Trigger: a
seat that cannot judge a change because the evidence is in an excluded file.
Reversal cost: one config field, no code.

If the exclusion mechanism itself proves wrong, because a project's generated
files carry review-worthy content that no glob separates from the rest, the
retreat is the same field and the same empty list. The named-and-counted block
goes with it, and the seat reads what it read before.

If 256 MB proves too small on some repository, the number moves in one place
and every read moves with it. If it proves too large for a host, the same
constant comes down. Neither change touches a call site.
