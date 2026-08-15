# ADR-0028: Push notifier

Status: accepted (2026-08-15)

## Decision

The daemon pushes three events to one target the instance config names. Every
other notification surface stays pull.

- **One optional target, machine-scoped.** `notifier` in `instance.json`:
  `{"url": "https://…"}` for a webhook, or `{"command": ["…", "…"]}` for an
  argv, with an optional `timeoutMs` (default 5000). Exactly one of the two;
  a config that names both, or neither, is refused with the rest of the
  config's errors and the old config stays live. Absent, the daemon pushes
  nothing and behaves as it did before the field existed.
- **Three events.** `park`, `budget-breach`, `run-closed`. A park is the
  factory asking for a decision and holding a slot until it gets one; a breach
  is money crossing a line the owner drew; a close is the answer to the only
  question an absent owner has. Nothing else is pushed.
- **A fixed projection, never the ledger line.** The payload carries the
  envelope (`event`, `ts`, `seq`, `ledger`, `runId`, `project`) plus a short
  allowlist per event: `type` and `gist` for a park, `threshold`, `cost`,
  `stage` and `gist` for a breach, `state` for a close. A field a later stamp
  site adds does not travel until the allowlist names it.
- **The webhook is a POST of that JSON**; the command reads the same JSON on
  stdin, one line. A non-2xx status, a non-zero exit, a spawn error and a
  timeout are all failures.
- **Fire and forget.** Delivery is never awaited by an append, a stage, or a
  handler. The daemon's stop drains what is in flight, so a late failure stamp
  lands before the instance ledger closes.
- **A failure stamps `notify-failed`** on the instance ledger: the event it
  was about, its seq and ledger, the run and project, whether the target was a
  webhook or a command, and a reason. Quiet, not loud. The stamp never carries
  the URL or the argv, and the reason has the URL redacted out of it.
- **Nothing about a notifier reaches a lane.** The transport runs behind the
  store hook the tripwire watcher already uses. A target that hangs, refuses,
  or does not exist changes no run's behaviour and fails no daemon.

## Why push at all, when every surface is pull

The console renders the loud strip and the queue on demand. That is the right
default for a working session and useless for the hours around one. A park
frees its slot and waits; if nobody runs status, it waits until somebody does.
A factory built to run at any hour was, in practice, idle from the moment its
owner stopped looking, and the gap was bridged by an external watcher polling
the ledger from outside the harness — which is the harness admitting the
notification is owed and declining to send it.

So the daemon sends it. Push does not replace the pull surfaces and is not
allowed to become authoritative: the ledger is the record, the strip and the
queue are the reader, and a notification is a nudge to go look. That is why a
failed push is a quiet stamp and not a loud item. A loud record about a broken
push could only be delivered by the surfaces the push exists to cover, and
would be read hours later by the same absent owner, next to the park it failed
to announce.

## Why one target and not a fan-out

Two targets are two failure modes, two retry policies, and a question about
partial delivery that has no good answer. One target composes: a webhook is
already a fan-out point, and a command argv is a script the operator owns and
can make do whatever the machine can do. The harness stays out of that
business entirely.

The command form exists because a webhook is not always the shape a host has.
A local desktop notification, a phone push through a vendor CLI, a line
appended to a file a phone syncs — all of those are argv and none of them are
HTTP. The payload goes on stdin rather than in the argv so an operator writing
a command never has to think about quoting a JSON document through a shell.

## Why a projection instead of the event

A ledger line is the harness's own record and carries whatever its stamp site
put in it: a park's `detail`, a `refs` block of absolute paths, an answer's
free text. A webhook is somebody else's machine, reached over somebody else's
network, and a command argv is a script that may log its stdin. Spreading the
line would make every future stamp field a silent disclosure decision taken by
whoever wrote the stamp.

An allowlist inverts that: adding a field to a payload is a deliberate edit to
this module, reviewable on its own. The cost is that a notification says less
than the ledger does, which is the correct relationship — it says enough to
decide whether to go and read.

## Fallback path

If one target proves too narrow, the field takes an array of targets and the
notifier delivers to each independently, stamping per target. Trigger: an
operator wiring a second script only to fan out to a third. Reversal cost:
low — the config validator loops, and the delivery already returns a per-call
failure reason.

If the three events prove too few or too many, the notified set changes by an
edit to `NOTIFIED_EVENTS` and its allowlist entry. Trigger: an owner who
answers a park from a notification but still has to run status to know what
happened afterwards, or one who mutes the target. Reversal cost: low — one set
and one table.

If fire-and-forget proves too weak for a transport that drops under load, the
notifier gains a bounded retry with a recorded attempt count on the failure
stamp. Trigger: `notify-failed` stamps whose reason is transient and whose
event mattered. Reversal cost: low — the retry sits inside `deliver`, behind
the same interface, and nothing upstream awaits it either way.

If a push target ever needs a credential, it does not go in `instance.json`
next to the URL: the command form runs a script that reads the host's own
secret store, and the webhook form stays for targets whose URL is the secret.
Trigger: a target that requires a header. Reversal cost: none yet — this is a
boundary the module holds rather than a design it can lose.
