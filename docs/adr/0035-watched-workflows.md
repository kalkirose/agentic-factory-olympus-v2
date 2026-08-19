# ADR-0035: Watched workflows off the request path

Status: accepted (2026-08-19)

## The condition

Every check the harness reads is a check on a request. The ship step opens the
request, the watcher polls the checks of its head sha, and a red enters triage
with the run standing behind it. That is the whole of the harness's reading of
CI, and it is bounded by the request.

A job that leaves the request path leaves that reading with it. A long
acceptance suite moved to a schedule on the default branch still runs, still
fails, and is now read by nobody: no run waits on it, the check watcher never
sees its sha, and its red sits in the actions tab until a human opens the tab.
The move that buys back thirty minutes of every request round also buys a
detector that reports to no one.

The banned answer is a clock. "Alert if the nightly has not passed in 26 hours"
is a wall-clock trigger, and it fires on a schedule the project changed and on
a runner queue that ran long. The condition here is available without one: the
forge has a terminal word on every run it finished, and that word is a state
change the harness can key on.

## Decision

**A project names the workflows it wants watched.** `watchedWorkflows` in
project config is a list of workflow files — the id the forge lists a
workflow's runs under, because a display name is not addressable. The default
is the empty list, so a project watches nothing until it says otherwise, and
the list ships through the same PR path as the workflow it names.

**The daemon polls the most recent completed run on the default branch.** One
forge read per watched workflow: `latestCompletedRun(workflow, branch)`, which
asks the forge for completed runs only and takes the first. The verdict is the
`conclusion` that run carries. `success`, `neutral` and `skipped` are not
defects — the ship path already reads those three together — and every other
conclusion is. No elapsed, no age, no schedule appears in the condition.

**A red opens one loud record per red run.** `workflow-red` names the project,
the workflow, the run id, the conclusion, the branch and the run's url. Loud,
because this record is the only thing between the red and nobody noticing:
every other loud class competes with a run that is also saying something, and
this one has no run behind it at all. The same red run, polled again, is the
same piece of news and stamps nothing. A newer red run is news again, and the
older record stays open.

**A green closes it, through the record that carries the evidence.** A
completed green run while a red of that workflow is open stamps
`workflow-recovered` — quiet, naming the green run and the records it closes —
and that event owns the loud item in the ownership table (ADR-0015). One green
closes every open red of that workflow: the workflow is passing or it is not.
A green with nothing open stamps nothing, so a workflow that has never failed
leaves no trace at all.

**A conclusion nobody read is never a green.** A list the forge would not
answer, a `gh` that could not run, and a workflow with no completed run yet all
come back as the same null. A null opens no record, and — the half that
matters — closes none either. The next poll asks again.

**The ledger is the only state.** Which red is current and which records are
open are both derived from the instance ledger on every poll. Nothing is held
in the watcher, so a restart reads the same answer and stamps nothing twice,
and the poll at start is what covers a red that landed while the daemon was
down.

**Detection only.** The watcher holds no run, opens no run store and returns no
directive, exactly as the tripwire watcher does not (ADR-0034). The records
land in the instance ledger, which is where cross-run observations already
live.

The watcher lives in `src/ship/workflows.mjs`, beside the forge adapter it
reads through; the daemon constructs it at start and stops it with the rest of
the observers.

## Why a dedicated poll rather than an existing surface

Everything else in the daemon is event-keyed: an append fires the tripwire
watcher, a close fires the eval scheduler, a control file fires the drain. None
of those keys exist here, because the event is on somebody else's machine. The
only surface that already ticks is the orphan-workspace sweep, and its period
is documented as low precisely because nothing waits on it; hanging a forge
read on it would tie one concern's cadence to another's reasoning.

So the poll is its own, at the same modest period, unref'd like the sweep, and
one poll at a time. A tick that arrives while a poll is running is dropped
rather than queued: the next one is fifteen minutes away and the state it would
read is the state this one is reading. Polling is what a machine does when the
event is not its own to receive, and the doctrine's objection is to a clock in
the *condition*, not to a clock on the *reading*. Nothing here decides anything
from the passage of time.

## Why the red is loud and the recovery is quiet

A loud record is a request for the owner's eyes, and the test for one is
whether anything else would say the same thing. For every other CI red there is
a run: it parks, or it stamps a verdict, or it holds a request open. For this
red there is nothing — the whole point of moving the job off the request path
was that no run pays for it any more. Quiet would mean the record exists and
the strip does not show it, which is the state the change was meant to end.

The recovery is the opposite case. It answers a question the owner already has
open rather than raising a new one, and it carries the evidence — the green run
and its id — that makes the answer checkable. So it goes in the ledger, owns
the loud item, and the strip clears where the green landed rather than where a
human got round to reading it.

## Fallback paths

If a watched workflow is red for reasons the project has decided to live with,
the answer is to stop watching it: the entry leaves `watchedWorkflows` by PR,
and the open record is resolved from a console like any other loud item.
Trigger: a red the owner has ruled known and will not repair. Reversal cost:
none — one config line, and the watcher stops asking.

If one loud item per red run proves too noisy — a workflow that fails nightly
opens a record a night — the record becomes one per workflow, re-opened only
after a recovery. Trigger: two open records for one workflow that the owner
read as one condition. Reversal cost: low — the dedupe key moves from the run
id to the open record, in one condition in `judge()`.

If the poll period proves too slow for a workflow somebody waits on, the period
becomes a per-project field beside the list. Trigger: a red an operator found
by hand before the watcher stamped it. Reversal cost: low — one field, and one
argument at the construction site. Nothing in the condition changes, because
the condition never held a clock.
