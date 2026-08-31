# ADR-0063: The card sweep absorbs one race

Status: accepted (2026-08-31)

## Decision

When the close-out card sweep's push to the default branch is rejected, the
sweep retries once: it refetches, replays its own commit onto the head that beat
it, proves the replayed result again, and pushes. A second rejection records the
miss exactly as the first one did.

- **The replay is a three-way pick of the sweep's own commit**, so an edit
  somebody else made to the same card conflicts rather than being taken back in
  silence. A conflict ends the retry.
- **Every check the first push stood behind runs again**: the containment to the
  card directory, and the project's own card lint over the replayed result.
  Neither is assumed to hold because it held before the branch moved.
- **One retry, never a loop.** A push that loses twice is a contended directory
  rather than a race.
- **The record says what happened.** `card-sweep` carries `pushAttempts`, and a
  retry adds `replay` with the head it replayed onto, whether it landed, the
  lint's answer, and the cause when it did not.

## What this is for

The card sweep is the one writer in the harness that lands text on the default
branch with no request behind it. It runs at close-out, after the story merged,
and it updates the planning cards the ship invalidated or amended.

Its push is a plain push to a branch other people write to. A human landing a
card edit in the seconds the sweep takes moves the branch, git rejects the push,
and the sweep records the loss. Nothing retries it. The cards the sweep wrote —
the amendments the next story reads, the notes the build-time classifier reads
as evidence — are then in a commit on a branch that is about to be deleted.

The rejection is almost always the branch having moved. Replaying onto the head
that moved it is the whole of the fix.

## Why a three-way pick and not a checkout

The obvious replay is to take the sweep's version of each card file onto the new
head. It is also wrong. The new head is there because somebody wrote to one of
those files, and a checkout of the sweep's version overwrites their edit with a
file the sweep composed against a tree that did not have it. Nothing red, no
conflict, and their work gone.

A three-way pick answers honestly. Two edits to different cards compose. Two
edits to different parts of one card compose. Two edits to the same lines
conflict, and a conflict is the correct answer to a question the machine cannot
settle: the sweep backs out and records the miss, and a person reads both.

## Why the checks run again

The first push stood behind two proofs: the sweep wrote nothing outside the card
directory, and the project's own card lint was green on what it wrote. Both were
statements about a tree that no longer exists.

A replay onto a moved head builds a tree neither proof has seen. The containment
is cheap and it is the one guarantee that keeps this writer bounded to planning
text. The lint is the check that keeps unlinted text off the default branch, and
a card that lints green beside one version of its neighbours can lint red beside
another. Skipping either would make the retry a way of pushing text nothing
read.

## Why one retry and not a loop

A retry answers a race. A loop answers contention, and it answers it by running
for as long as somebody keeps writing — on the close-out path of a story that
has already shipped, holding a workspace open behind it.

Two attempts bound the work at one extra fetch, one pick and one lint. What a
second rejection means is not "try again"; it means the card directory has more
than one writer at that moment, and the answer to that is a person looking, not
a third push.

## What a reader can ask of this

`pushAttempts` on the `card-sweep` stamp is the count. A sweep that pushed on
the second attempt is a race absorbed — a card batch that used to be lost. A
sweep with `pushed: false` after two attempts is the miss, recorded as it always
was, with the replay's own cause beside it.

If the replay never fires over many ships, the race was not real and the retry
is dead weight worth removing. If second rejections recur, one retry is not
enough, and the answer is a queue over the card directory rather than a third
attempt.

## Fallback paths

If the replay composes badly in a way the lint does not catch, the retry is
removed and the sweep records the loss on the first rejection, exactly as it did
before. Trigger: one card that reached the default branch with a human edit
silently reverted. Reversal cost: one block of the sweep.

The rule that keeps this bounded is the containment: whatever the replay
produces, it reaches the card directory alone, and a replayed result that
reaches outside it is refused rather than pushed.
