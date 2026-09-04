# ADR-0068: The door refuses what it can read, and a harness defect is one decision

Status: accepted (2026-09-04)

## Decision

Two inputs a run is judged on are read at the launch door, before a slot, a
workspace or a stack exists; and the one gate whose question no answer could
repair stops offering the answer that cannot repair it.

### A story launch without a readable card is refused at the door

`launchRun` in `src/daemon/daemon.mjs` reads the story's intent card the way it
already reads a repair ticket (ADR-0067): from the default branch of the
project's bare clone, after a fetch, because the card sweep pushes to that
branch and a card written minutes ago is only there afterwards. It parses the
text with `parseIntentCard` and refuses the launch on three conditions: the
payload names no card, the branch holds no file at that path, or the parser
reports errors. The refusal names the path and the first three errors, stamps
`launch-rejected` with the path and the whole error list in `detail`, and shows
in the `REJECTED` section of `olympusctl status`.

A resume takes its card from the prior run's own record before the check runs
(`resolveResume`), so an inherited freeze is judged on the card it was born for
and never on whatever the payload named.

The story lane's own card checks stay where they are. They read the worktree,
which is a different question: a card that moves between the door's read and
readiness is the one thing the door cannot see, and the lane still parks
`stage-blocked` on it.

### Every declared credential is proven at the door, and the ship gate reads the world

`launchRun` runs the whole credential gate — the surface parity sweep and the
live probe of every declared value — before it provisions anything. A surface
that is not wired or a probe that answers no refuses the launch; the refusal
carries the gate's own evidence and the fingerprint of the value a service
would not take (ADR-0064), and nothing is left on disk.

Three facts make that affordable on every launch.

- **The declaration is read from the default branch.** `readLaunchConfig` reads
  the project config as the world holds it, so a surface the world retired
  since some earlier launch is not a gap and one the world added since is.
- **A green probe is cached for a day, keyed on the value.** `credential-probe`
  gains `validUntil`, and a pass is stamped on the instance ledger with the
  project, the variable and the value's fingerprint. A gate that finds a live
  pass for the same value asks the service nothing and stamps
  `cached: <seq>` instead. A value that moved has a different fingerprint and
  misses the cache by construction, which is the whole rule: a credential is
  re-probed when it changes or when its answer ages out.
- **The probe runs in the bare clone.** There is no worktree at the door. A
  probe is a read-only question to a service; a project whose probe command
  needs a working tree names an absolute one.

The ship stage's parity half reads `credentials[]` from the default branch too,
through the same reader. The question it asks is about the CI that will run the
request, and that CI reads the default branch: a surface the world retired
since the launch pinned its blob is not a gap. The probe half stays on the
pinned config, because a probe names a command in it. A branch nothing could
read falls back to the pinned set, which is where the gate stood before.

The gates inside a run stay, and their text says what they are for: the door
proved every declared credential before the run existed, so what a live gate
can still catch is a value that moved while the run was in flight.

### A harness-class finding is one decision per defect, with no retry

The provisioning gate in `src/lanes/verdict.mjs` splits on the class of the
findings it holds. `gateFor` routes a set with any env-class finding to the
substrate gate, which is the gate as it was: `retry`, the ack where a finding
may carry one (ADR-0032), and a line naming the harness findings the same
render holds and saying the next gate asks about them. A set of harness
findings alone routes to the harness gate, which offers no `retry` at all.
`HARNESS_GATE_FORMS` in `src/lanes/shared.mjs` carries the order: `ack` first,
with each finding's fingerprint beside it in the question, and the `abandon`
every park owes.

Before it parks, the harness gate records one escape per fingerprint on the
escapes ledger: category `harness`, kind `harness`, `refs.fingerprint` the ack
identity, no ticket. No repair sweep launches against a ticketless escape, and
the quality-bar window counts categories rather than kinds, so a harness defect
never moves the escape rate. What it does is count: `kindEscapesWindow` in
`src/telemetry/escapes.mjs` reads escapes of one kind over a window of ships,
and this is the number that says what the harness is costing the runs it
judges.

The escape stays open while the acknowledgment stands. `ESCAPE_KIND_OWNERSHIP`
in `src/ledger/resolution.mjs` names the act that closes it: `olympusctl
revoke`, which already names the fingerprint and the fix behind it, so
`revokeAck` stamps `escape-marked-fixed` on every open escape of that project
and fingerprint with the fix as its evidence.

### Both parks that ask for a ruling list the whole render

The `intent-conflict` park at the spec gate and at the verdict lists every
finding open at the round or the render it was raised from, each with its id,
its class, its severity and one line; the intent findings come first, then the
card's refusals. The text slot says the answer may address any finding by id,
and the amendment brief that carries the ruling says the same.

## What this is for

Ninety-four parks across sixty-nine runs. Six were the owner's to answer. The
rest asked for an answer the harness held, a clock it could read, or an input
it could have refused where it arrived.

Five of them were launches with no card. Each took a slot, a clone, a worktree
and a stack, walked to readiness, and parked `stage-blocked` on an input no
answer at that park could supply; every one was abandoned. The daemon had the
card path in the control file the whole time.

Seven were credential checks. The probe was made a stage because eleven probes
on every launch was the cost nobody wanted to pay; the result was that every
refusal cost a workspace instead. The fingerprint cache is what makes the
cheap place affordable: a burst of launches asks each service once a day, and
the launch that would have parked never starts. One of those seven was worse
than a cost — a ship gate refused a surface the owner had deliberately retired,
because the run was reading a declaration it had pinned at launch and asking a
question about main.

Ten were harness defects, four distinct ones, one of them reported three times
inside a single run. The gate offered `retry` first, and a retry re-runs the
same harness against the same tree: it cannot answer differently. What the
operator could actually say was "known, go on", and the ledger shows three
standing acknowledgments that say exactly that. Recording the defect where a
count can find it is what turns the third report of one defect into a number
rather than a third question.

Three of the ten intent-conflict parks were answered "no conflict exists". A
ruling is given against the state of the document or the tree the round found,
and a park that quoted the conflict alone asked for a ruling on half of it.

## Why not the alternatives

**Probe every credential on every launch, with no cache.** That is the cost
that made the probe a stage in the first place. The fingerprint is the right
key because it is the thing the question is about: a value that has not moved
and passed an hour ago will pass again, and a value that moved is a different
value.

**Keep the credential gate at readiness and refuse only the card at the door.**
Then a refused credential still costs a clone, a worktree and a stack, and the
run sits parked holding a slot on a question about the world outside it.

**Let the door offer the acknowledgment the readiness gate offered.** An
acknowledgment at a world gate stands for one run (ADR-0062), and there is no
run at the door to stand for. The answer at the door is to fix the world and
launch again, which costs nothing: no slot, no workspace, no stack. A run
already in flight still meets the live gates, and those still take the ack.

**Let a harness finding pass with no human at all.** A harness defect that
broke the tree cannot ship past a green verdict it does not have, and the run
holding it may be worth abandoning. One decision per defect is the floor; what
goes is the option that could never have been the answer.

**Record the harness defect as a ticketed escape so a repair run fixes it.**
The repair lane repairs the project the run was judged in, and a harness defect
is not in that repository. A ticketless escape is a count and nothing else,
which is what this record is for.

## Fallback path

If the card check refuses launches it should admit — a project whose cards are
generated after the launch, or a parser stricter than the lane needs —
`launchRun` skips `refuseUnreadableCard` and the card reaches readiness as
before, where `card-missing` and `card-invalid` still park. Trigger: one
refusal a human answers by launching the same card unchanged. Reversal cost:
one call; the `launch-rejected` stamp and its `card` field stay, because
refusals for every other reason still use them.

If the door's credential gate proves too slow or too eager, `launchRun` skips
`refuseUnprovenCredentials` and the story lane's own probe stage is the gate
again. Trigger: launches measurably delayed by probe round trips that the cache
does not absorb, or a refusal at the door that the readiness gate would have
let past on an acknowledgment. Reversal cost: one call. The cache is
independent of it: `validUntil` and the instance-ledger stamps stay, and the
in-run gate keeps reading them, so removing the door leaves the probes cheaper
than they were.

If the cache window proves wrong, `PROBE_CACHE_MS` in `src/lanes/probes.mjs`
moves. A shorter window costs round trips; a longer one carries a credential a
service revoked for longer, and the run's own gate is what catches that.
Trigger: a credential revoked inside the window that reached a ship. Reversal
cost: one constant.

If reading the ship's surface list from the default branch proves wrong — a
project whose CI runs the request's own workflow files rather than main's —
`openPr` passes no `surfaceCredentials` and the parity half reads the pinned
blob again, where `run-reconfigured` (ADR-0061) is the way past a stale
declaration. Trigger: a surface gap the pinned blob names and main does not,
where CI really needed the pinned one. Reversal cost: one argument.

If the harness gate's missing `retry` proves too strict — a defect a restart
really does clear — the gate offers `retry` again beside the ack, and the
escape is recorded either way. Trigger: two harness gates whose defect was gone
on the next run with no fix behind it. Reversal cost: one form object; the
escape, the fingerprint and the revoke ownership are untouched by it.

If the whole-render finding list makes the ruling parks unreadable, the
question truncates to the intent findings and the ids of the rest. Trigger: a
park question a console cannot render. Reversal cost: one renderer; the ids are
already on every line.
