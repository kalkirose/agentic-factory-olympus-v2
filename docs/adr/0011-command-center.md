# ADR-0011: Command center shapes

Status: accepted (2026-08-10)

## Decision

The command center is one HTML page plus one small read-only server under
`src/center/`, with the `olympus-center` bin as the entry point. Concrete
shapes:

- **Standalone by construction.** The server is started with the daemon-home
  path and nothing else. The daemon and the harness never reference the
  center; the store files on disk are the only interface. Stopping or
  breaking the center changes nothing about a run.
- **GET-only server, three routes.** `GET /` serves the page. `GET
  /snapshot.json` serves the derived view the page renders. `GET /state/...`
  serves the raw store files (a directory answers as a JSON listing), so the
  files stay inspectable without the page. Every other method answers 405;
  every other path answers 404. All responses carry `cache-control:
  no-store`.
- **Path guard.** A `/state` target resolves against the home root; a
  resolved path outside the root answers 403. The guard re-checks the real
  path, so a symlink inside the home cannot serve a file outside it.
- **The server derives, the page renders.** `buildSnapshot` assembles the
  full display state through the same pull-only readers the console uses —
  run replay, open-loud and queue joins, escapes window, yield and kill-rate
  collectors, frontier compute. The page holds no derivation beyond
  formatting, so display logic cannot drift from the tested reader code.
  Clone-backed sections (tripwire registry, frontier) read the bare clone
  without fetching and degrade to null while no clone exists.
- **Display cadence only.** The page fetches the snapshot on load, every
  60 s, and on the manual refresh control. The cadence styles a countdown
  chip and nothing else — detection stays with the event-keyed watchers, so
  the no-timeout-as-detection rule is untouched.
- **Content set, top to bottom, per the accepted layout:** status chips
  (source root, daemon liveness from the lock file, per-project arming,
  slots, per-model seats in flight), loud strip, run cards (stage pipeline
  from the lane's stage list, in-flight seats with model and effort, repair
  round, last event; parked runs dimmed with the freed slot named),
  escalations (loud first, then the queue in FIFO order with the roadmap
  tiebreak), build health (escapes rolling-10 meter against the registry
  ceiling, open escapes, open gate-integrity count, kill rate at the last
  freeze, per-lens yield over the baseline window, tripwire board), run-time
  statistics (median story wall-clock against the 4 h target, last-10 ships
  chart, green-ship p50, CI critical path p50, frontier width, stage
  medians), and the ledger tail (newest first across all stores).
- **Read-only by rule holds in the DOM too.** The page writes ledger text
  into the document only through `textContent` — a gist can never become
  markup. Numbers derived from `ts` values (elapsed, medians) are display
  data; an out-of-order pair reads as no duration, never as a negative one.

## Why the page renders a derived snapshot instead of the raw files

The accepted resolution names `GET /state/...` as the serving shape, and the
route exists. But the display needs joins the raw files only imply: open
loud items need `resolved` cross-references, run cards need replay, health
needs window math over ships and escapes, and the frontier needs a clone
read no browser can do. Re-implementing those joins in page JavaScript
would duplicate tested reader code in a second language and drift from it
silently. The snapshot endpoint is the same fetched-ledger data, joined
once, server-side, by the modules the console already trusts; the raw
`/state` route stays for inspection and tooling.

## Why the tripwire board tolerates an unread registry

The registry lives in project config on the project's default branch; the
center reads it from the bare clone without fetching. Before the first
launch there is no clone, and the center must not create one — provisioning
is the daemon's. The board therefore renders open breaches from the
instance ledger alone (they carry metric and condition in the stamp) and
marks the registry unread, instead of failing the panel or fetching.

## Fallback paths

If snapshot assembly grows slow on large homes, split the endpoint per
panel (`/snapshot/runs.json`, …) and fetch them independently; the page
already renders per section. Trigger: assembly duration noticeable at the
60 s cadence.

If the page needs to work with no server at all (a mailed snapshot), add a
generator that inlines one snapshot JSON into the page as a static
document. The page reads one object either way. Trigger: a real need to
share state outside the machine.
