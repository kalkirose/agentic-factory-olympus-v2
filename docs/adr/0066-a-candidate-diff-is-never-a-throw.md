# ADR-0066: A candidate diff is whole, bounded, filtered, and never a throw

Status: accepted (2026-09-03)

## Decision

The diff a judgment seat reads is produced by `reviewDiff()` in
`src/isolation/tree.mjs`. Five rules bound it.

- **The whole diff is a file, and the brief is the way in.** `reviewDiff()`
  writes the filtered patch to the path its caller names and returns an excerpt
  of it. The verdict stage names
  `<home>/runs/<runId>/reviews/diff-c<cycle>.patch`, from `reviewDiffPath()` in
  `src/daemon/home.mjs`. The write happens inside `reviewDiff()`, before the
  caller can spawn anything, so no seat is pointed at a file that does not
  exist. A call with no path is refused rather than served: an excerpt with
  nowhere behind it is the defect this rule closes.
- **The brief says what it is holding.** Above the excerpt the seat reads the
  size of the whole diff in bytes, the number of files in it, the path of the
  file, and one instruction: read the whole file before judging, and cite the
  file and hunk every finding comes from. Where the excerpt is the whole diff,
  one line says so and names the file anyway. `diffLines()` in
  `src/lanes/review.mjs` builds both forms, and every review brief carries it:
  every seat of the Fury panel, and the generalist seat.
- **The excerpt is a length in the project config.** `review.excerptChars`,
  default 12,000, validated in `src/config/project.mjs` as a positive integer.
  It sits beside `review.excludeFromDiff` and moves the same way. It bounds the
  brief and nothing else. The file holds the whole diff at any value.
- **Every full-text diff read carries an explicit output cap.** The cap is
  `MAX_DIFF_BYTES` in `src/isolation/git.mjs`, 256 MB, and it is the harness's
  only number for this. `reviewDiff()` carries it, `evidenceDiff()` carries it,
  and the fast-path ship's two patch reads carry it. The runner's default cap is
  one megabyte, which a lockfile clears on its own. A read past the cap answers
  short: `gitCapped()` is the seam, Node stops the stream at exactly the cap,
  kills the child, and hands back the bytes it kept, so the read resolves with
  `{text, truncated: true}` rather than rejecting. Every other git failure still
  rejects, so a read that could not run is still an error.
- **Lockfiles and generated files are named, not pasted.** The patch leaves out
  every path matching `review.excludeFromDiff` in the project config. The
  default is `**/pnpm-lock.yaml`, `**/package-lock.json`, `**/yarn.lock` and
  `**/*.generated.*`. The excluded paths are named to the seat instead, one
  `git diff --stat` line each, so the seat knows they changed and by how much.
  The file holds the filtered text, so the file and the excerpt are the same
  diff. Name reads are untouched: `--name-only` and `--name-status` answer about
  every path, the Fury interface seat is still seated by the whole changed-file
  set, and the diff policy still judges every path.

## What `diffTruncated` means

It means the read cap cut the diff. The end of the work is then in no file the
seat could open, so the finding rests on part of the work. The verdict stage
stamps `diffTruncated: true` on the cycle's `verdict-rendered` and on every
`finding` the round raised. Both fields are documented in
`src/ledger/registry.mjs`.

An excerpt shorter than the diff is not truncation. The rest of that diff is in
the file, the brief names the file, and the seat is told to read it.
`reviewDiff()` returns the two facts under two names: `truncated` for the cap,
`partial` for the excerpt. Nothing stamps `partial`, because a brief that
carried an excerpt is the ordinary case and every brief carries one.

## What this is for

A candidate diff grows with the work, not with the repository. Two failures
came out of that, and this decision holds both.

A run installed four packages. That put a lockfile change in the candidate
diff and took it past one megabyte on its own. All 29 of the run's gate layers
were green. The verdict stage then read the candidate diff, the read hit the
runner's default cap, and the handler threw with `stdout maxBuffer length
exceeded`. The engine reads a stage handler throw as a liveness violation
(`executeStage()` in `src/engine/engine.mjs`), so the run went inert with its
whole spectrum green and its work finished. The cost of a file nobody reviews
was the run.

The read that replaced it was cut to 12,000 characters before it reached the
seats. Every story diff longer than that was judged on its first few hundred
lines. The seats reported on what they were given and said nothing about the
rest, because nothing in the brief told them there was a rest. A gate that
reads a fraction of the work and answers about all of it is worse than a gate
that throws: the throw is visible.

## Why the seat is told the names

A file that changed and is not in the diff is a hole a reviewer cannot see. A
seat handed a filtered patch with no statement about the filtering would judge
a tree it believes it read whole.

So the exclusion is a substitution and not a deletion. The seat gets the path
and the line count of every file held back, which is what a reviewer does with
a lockfile anyway: check that it changed, check that the size is plausible, and
read the source instead.

## Why the excerpt stays

A seat that opens a file before it has read a word of the work spends its first
tool call deciding whether to bother. The excerpt puts the work in the brief:
the seat is already reading the diff when it learns how much more there is. It
also survives a seat that ignores instructions, which is worth something the
day a model regresses.

12,000 characters is the default because it is a few hundred lines of patch,
which orients a reader without pushing the lenses, the spec reference and the
supersede duties out of the brief.

## Why the file is evidence

The verdict record says what the seats decided. The patch file says what they
were deciding about. It sits in the run directory beside the record and the
seat reports, so it archives with the run at close-out and goes with the
directory when a crashed run is swept. Nothing deletes it, and no size rule
applies to it: run directories have one lifecycle, the run's own, and the only
per-run artifact with a rule of its own is the command log, which deletes on a
green because its content is a build's stdout. A patch is the object under
judgment, and the read cap is the only bound on it. One cycle writes one file,
so a run holds one per cycle.

The file holds patch text and nothing else. The notes about the excerpt and the
cap ride the brief, so `git apply` and an operator's editor both read the file
as what it is.

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

## Fallback path

If a project's seats spend too much of their window on the excerpt, it lowers
`review.excerptChars`. If they need more of the diff in front of them, it
raises it. Trigger: seats that run out of context, or seats whose findings
never cite anything past the excerpt. Reversal cost: one config field, no code.
The file is the whole diff at every value, so neither direction changes what a
seat can reach.

If a project needs its judgment seats to read a file the exclusions hold back,
it sets `review.excludeFromDiff` to its own list. An empty list filters
nothing. Trigger: a seat that cannot judge a change because the evidence is in
an excluded file. Reversal cost: one config field, no code. The same field and
the same empty list retire the whole exclusion mechanism if it proves wrong,
because a project's generated files carry review-worthy content no glob
separates from the rest. The named-and-counted block goes with it, and the seat
reads what it read before.

If the patch file proves wrong, because the seats will not open it or a host
cannot hold it, the retreat is a large `review.excerptChars` and the brief's
one-line form. The seat then reads the diff in the brief, as it did before this
decision, and the file stays on disk as evidence. Trigger: seats whose findings
show no sign of the file, or a run directory a host refuses. Reversal cost: one
config field for the behaviour; removing the file entirely is a change to
`reviewDiff()` and its caller.

If 256 MB proves too small on some repository, the number moves in one place
and every read moves with it. If it proves too large for a host, the same
constant comes down. Neither change touches a call site.
