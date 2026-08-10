---
name: olympus-console
description: Console over a running Olympus daemon — render status (loud first, then queue), answer escalations in batch, arm/pause auto-launch, launch or kill runs, resolve loud items, edit instance config live. Use when the user asks for factory status, wants to answer parked questions, or wants to steer runs.
---

# Olympus console

A console session owns no run. The daemon owns every run; this session reads
the ledgers and writes control commands the daemon obeys. Steering happens at
seams — there is no mid-seat interjection.

## Find the daemon home

Use `$OLYMPUSD_HOME` if set; otherwise ask the user once. Every command below
takes `--home <dir>`. The CLI is `node bin/olympusctl.mjs` from the harness
repo (or `olympusctl` if linked).

## Read state

- `olympusctl status --home <dir>` — chips, loud strip, queue, open runs,
  project arming. Always render loud items first, then the queue.
- `olympusctl queue --home <dir>` — every open escalation as a full record:
  question, context refs, options, and the exact answer command.
- `olympusctl frontier --home <dir> --project <name>` — roadmap order and
  card states (launchable, blocked, gated, parked, spent, defect).

Report to the user extremely concisely: loud items first, then queue depth,
then active runs. Sacrifice grammar for concision.

## Answer escalations

Each record is answerable from itself. Answers are independent state changes;
batch by issuing several answer commands in one turn, in any order.

- Run park with options: `olympusctl answer --run <id> --option <option>`
- Run park, free text: `olympusctl answer --run <id> --text "<answer>"`
- Instance park (invalidated card): `olympusctl answer --seq <n> --text "<answer>"`

Never pick an option the human did not give you. No default answers exist:
when the user has not decided, the park stays open — that is the designed
state, not a problem to fix.

## Steer the factory

- `olympusctl arm --home <dir> --project <name>` — auto-launch fills free
  slots from the frontier in roadmap order.
- `olympusctl pause --home <dir> --project <name>` — no new auto-launches;
  open runs continue.
- `olympusctl launch --home <dir> --project <name> --card <path>` — manual
  launch, also for cards auto-launch skips (a `spent` card after a failed
  run relaunches only this way).
- `olympusctl kill --home <dir> --run <id>` — terminate a run. Destructive;
  only on explicit user instruction.
- `olympusctl resolve --home <dir> [--run <id>] --seq <n>` — pair a
  `resolved` stamp to a loud item (liveness violation, gate-integrity,
  red-merge breach, starvation) after the cause is repaired. Resolving the
  last open violation of a live run re-enters its recorded stage.
- Reorder: roadmap order derives from the card graph. To reorder, edit card
  edges in the project repo, not the harness.

## Command feedback

The control channel is async and returns nothing. After a command, confirm
the effect in `status`, or check `<home>/control/rejected/` for a
`<file>.reason.txt` — that text is the daemon's refusal. `<home>/control/done/`
holds claimed commands.

## Edit instance config live

Edit `<home>/instance.json` directly (slot caps, semaphores, projects). The
daemon validates every edit: `status` shows `last config edit: accepted` with
the changed keys, or `rejected` with the error — a rejected edit keeps the
old config live. Do not restart the daemon for config changes.

## Stop / start the daemon

`node bin/olympusd.mjs stop --home <dir>` requests a clean stop;
`... start --home <dir>` runs it in the foreground (the OS service manager
normally owns this). A restart resumes every open run from its ledger.
