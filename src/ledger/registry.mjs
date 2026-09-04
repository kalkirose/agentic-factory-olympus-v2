// Closed event registries. A new event type enters only by a design-level
// decision recorded in an ADR — never ad hoc from a call site.

// Seat events appear in run ledgers and, for instance-scoped jobs, in the
// instance ledger.
const SEAT_EVENTS = [
  'seat-spawned',
  'seat-progress',
  'seat-report',
  'seat-failure',
  'seat-terminated',
  'model-substituted',
  'model-degraded',
  // A prompt too long for a command line, written to a file the spawn points
  // at instead. Quiet — the seat runs exactly as it would have — but never
  // silent: the stamp names the file and its size, so a reader can see what
  // the seat was actually given (ADR-0005).
  'prompt-spilled',
  'semaphore-wait',
  'semaphore-granted',
];

// The events that end a seat invocation. Everything a seat spent before one
// of these is a snapshot; the terminal stamp is the invocation's final word.
export const SEAT_TERMINAL_EVENTS = new Set([
  'seat-report',
  'seat-failure',
  'seat-terminated',
]);

// The events that end one gate-layer attempt. Every `layer-started` pairs with
// exactly one of these, and the pairing is the invariant `attempts.mjs` reads
// (ADR-0034).
export const LAYER_TERMINAL_EVENTS = new Set(['layer-result', 'layer-abandoned']);

// Closed vocabulary for why an attempt was abandoned. Closed for the reason
// every registry here is: a reason written as prose at a call site counts as
// nothing, and the reader of two ledgers has to decide whether two sentences
// mean the same thing.
export const LAYER_ABANDON_REASONS = new Set([
  // The flake filter owes every red one red-only re-run, so a first red is
  // replaced rather than judged. The record is what the replaced attempt did.
  'superseded-by-rerun',
  // The command could not run at all — an environment defect, never a verdict
  // about the tree. The route parks the run under `command-error`.
  'command-error',
  // A signal ended the child: the daemon stopping, or an operator killing the
  // run. The exit is not the command's answer and is never read as one.
  'terminated',
  // The runner itself threw while the attempt was in flight. The throw carries
  // on to the engine; the stamp is what says the attempt is over.
  'runner-error',
  // The backstop: a path left the attempt without deciding anything. It is a
  // defect in the runner rather than a state of the tree, and it exists so that
  // a path written later cannot end an attempt in silence.
  'unstamped-exit',
  // A start a dead instance left open, closed by the recovery guard at the next
  // daemon start or by the orphan sweep.
  'unclosed-at-recovery',
]);

/** The reason, or a throw naming it. The only way a reason reaches a stamp. */
export function assertAbandonReason(reason) {
  if (!LAYER_ABANDON_REASONS.has(reason)) {
    throw new Error(`unknown layer-abandoned reason: ${reason}`);
  }
  return reason;
}

// Closed vocabulary for why a replay probe was refused. Closed for the reason
// the others are, and for one more: these are the rules that bound what a
// judgment seat can reach, so the set of them is the whole statement of the
// bound and reads in one place (ADR-0042).
export const PROBE_REFUSALS = new Set([
  // The seat named something that is not a Tier-1 layer of this project's own
  // gate table. The table is the whole of what the probe may run.
  'not-a-tier1-layer',
  // The layer needs a credential this host does not declare probe-eligible.
  // Eligibility is the host's statement about the values it holds, so a
  // project cannot widen it and a run cannot earn it.
  'credential-not-eligible',
  // The request came after the seat session spent its round budget. It takes
  // no round of its own; the report the seat wrote with it stands.
  'no-rounds-left',
]);

/** The refusal, or a throw naming it. The only way one reaches a stamp. */
export function assertProbeRefusal(refusal) {
  if (!PROBE_REFUSALS.has(refusal)) throw new Error(`unknown probe refusal: ${refusal}`);
  return refusal;
}

export const RUN_EVENTS = new Set([
  // run lifecycle
  'run-launched',
  // The project config this run judges against, replaced while the run is
  // open: the blob it now reads, the blob it read before, the operator and the
  // reason they gave. A launch pins the config on `run-launched` and every
  // stage reads that pin, so a run whose pin predates a deliberate change
  // judges the world against a config nobody holds any more and no answer at
  // any gate can move it. Replay applies the newest of these over the launch
  // value, so the launch record stays true, the current pin is derivable from
  // the ledger alone, and nobody has to edit `run-launched` to clear a run —
  // which is the operation this event replaces, and which falsified three
  // ledgers before it existed (ADR-0061).
  'run-reconfigured',
  'stage-entered',
  // The stage that settled while an operator hold stood, and the stage the run
  // did not enter behind it. A hold interrupts nothing: the running stage keeps
  // its seats and finishes, and the chain stops at the boundary. Quiet — the
  // quiet is the point — but never silent, because a run idling at a stage it
  // completed reads exactly like a run that died there (ADR-0040).
  'stage-held',
  // The deferred stage, entered. It is the close of the wait `stage-held`
  // opened, so the two bound a span every duration reading takes out of the
  // run's work (ADR-0040).
  'stage-released',
  // One operator hold taken over this run alone, or lifted from it. The whole
  // store of a per-run hold: it is folded at every daemon start, so the hold
  // outlives the instance that took it exactly as a project hold does, and it
  // carries the actor and the instant a reader needs to see who stopped this
  // run and when. A ledger written before this event existed folds to no
  // per-run hold, which is what those runs had (ADR-0057).
  'run-hold-changed',
  // The run waiting on something that is not a person: a provider that killed
  // a seat, a layer whose red came from outside the tree, a host that has not
  // repaired itself yet, a declared service that is down. It carries the
  // `kind` (seat, layer, substrate, external), the `reason` it waits for, the
  // `until` the span runs to, and the `attempt` on the ladder. Every reader of
  // a run works off this pair and its close: the liveness rule reads a waiting
  // run as alive, the duration split takes the span out of `activeMs`, the
  // heartbeat says what is being waited on, the cycle fingerprint counts the
  // waits, and `olympusctl status` prints it. Quiet — waiting is the answer,
  // not a fault — but never silent, because a run that stopped for twenty
  // minutes with no stamp reads exactly like a run that died.
  'waiting',
  // The close of that span: the kind again, and the `outcome` — `elapsed` for
  // a ladder step that ran out, `probe-green` for a service that came back,
  // `spent` for a poll that never got its answer, `killed` or `daemon-stopped`
  // for a wait the machine ended. Every `waiting` pairs with exactly one of
  // these, and a span a dead instance left open is closed by the next start.
  'waiting-ended',
  // What a stage that runs no seat says while it polls: what it waits on, the
  // poll outcomes behind the stamp, and its time in the stage. One stamp per
  // batch of poll outcomes, so a stage that settles quickly stamps none and a
  // stage that waits for hours stamps a handful. Quiet — waiting is not a
  // fault — but never silent, because a stage nothing stamps for reads the
  // same at one minute as at three hours (ADR-0034).
  'stage-heartbeat',
  // The close-out record: the terminal state, whatever the closing stage put
  // beside it, and the run's two durations — `wallMs` from the launch stamp,
  // and `activeMs` with the parked and inert spans taken out. Two, because a
  // run that waited nine hours on a human did not take nine hours of harness
  // (ADR-0036).
  'run-closed',
  ...SEAT_EVENTS,
  // One read-only probe of one external credential, at the launch gate or at
  // the ship gate: `ok` carries the answer, and both answers are stamped, so
  // a run always says which credentials it proved and when. The probe's own
  // output is never carried — it can hold the credential (ADR-0027).
  // `fingerprint` names the value the probe carried, so a refusal is tied to
  // the exact value the service refused and a later reader can tell a dead
  // credential from a stale copy of a live one (ADR-0064). It is twelve hex
  // characters of a hash: it identifies a value, it never reveals one, and it
  // is absent for a probe that held no value at all. `validUntil` rides a
  // pass and says how long that answer stands for the value it names: the
  // launch door caches a green probe per fingerprint, so a second launch
  // inside the window asks the service nothing and a value that moved misses
  // the cache by construction. `cached` names the earlier pass a gate stood
  // on instead of spawning the probe again.
  'credential-probe',
  // The parity read of one credential at one gate: every surface the project
  // declared for it, answered together. `ok` carries the verdict and `missing`
  // names each surface that is not wired, so the owner wires them in one pass
  // rather than one gate round per surface. Names only — the secret's value
  // is never read, on this host or on any other surface (ADR-0027).
  'credential-surface',
  // One replay probe: a judgment seat asked the daemon to re-run a named
  // Tier-1 layer of this run, and the daemon answered. It names the layer, the
  // seat that asked, the round, the exit code, and the file the seat's copy of
  // the output was written to; a request the rules refuse carries `refused`
  // and no exit. The seat's own environment stays stripped, so this stamp is
  // the whole record of a judgment seat reaching a command that holds the
  // machine's credentials — and it is written for the refusals too, because a
  // request that was turned down is as much a record as one that ran
  // (ADR-0042). The output is never a field here: it goes to the file, past a
  // redaction of every value the host declares a secret.
  'probe-run',
  // The read-only substrate probe the operational-fix route runs before it
  // spends a layer re-run on this host: every port the run's stack publishes,
  // asked on both loopback families, with the answer of each attempt. `state`
  // is clean, failed, or unread — a probe that could not read the stack judges
  // nothing and stops nothing, and the route carries on as it did before the
  // probe existed (ADR-0022).
  'substrate-probe',
  // spec + suite
  'spec-born',
  'spec-gate-round',
  'suite-committed',
  'adversary-wave',
  'survivor-disposition',
  'red-state-check',
  // The project's own declared-ground check, run over the suite as a seat left
  // it and before anything is committed or frozen: green, red, or unrun. A
  // suite file that declares no ground is a lost skip and nothing more, but the
  // check that finds it runs after the freeze today, where the file is frozen
  // and the repair costs a re-freeze and a second verdict. This is the same
  // check at the moment the seat that wrote the file is still live. A project
  // that names no ground command stamps nothing, exactly as before (ADR-0060).
  'ground-check',
  'freeze',
  // A launch that inherited a prior run's freeze instead of deriving one.
  // A resumed run never stamps `freeze`: it did not earn one.
  'freeze-inherited',
  // verdict
  'implementation-committed',
  // One gate layer, at the moment its process starts: the cycle, the layer,
  // the sha, and the attempt (the flake filter's re-run is the second). A
  // layer can hold a run for an hour, and without this the ledger ran silent
  // from the route that ordered the cycle to the first result — an hour that
  // read like a stopped run and was provable alive only by hand. A record,
  // never state: the spectrum resumes off `layer-result` alone, so a restart
  // mid-layer stamps a fresh start for the execution it begins (ADR-0034).
  'layer-started',
  // What one gate layer decided, and the whole part table behind it. A part
  // carries `carriedFrom` where an older cycle earned its green (ADR-0046),
  // `attempt` and `seq` where an earlier execution of THIS cycle earned it —
  // the attempt the flake filter replaced, or the pass a confirmation sweep is
  // confirming — and `confirmation` where the sweep itself ran it. A table
  // holding either of the last two holds no `carriedFrom`: every part of it
  // ran at this sha. `narrowedTo` (parts, files) rides the flake filter's
  // re-run alone and says what that attempt was asked for, so a re-run that
  // answered a failure never reads as a re-run of the layer.
  'layer-result',
  // The attempt that ended without a verdict about the tree: the red the flake
  // filter's re-run replaced, a command that could not run, a child a signal
  // took, a throw in the runner, and the start a dead instance left open. It
  // carries the reason, what the attempt had printed by then, and the seq of
  // the start it closes. A 38-minute acceptance attempt once vanished with no
  // record of any kind and its re-run replaced it in silence; nothing in the
  // ledger said either had happened (ADR-0034).
  'layer-abandoned',
  'flake',
  // A red the harness read as a condition outside the tree, before any seat
  // was spawned: the layer, the parts that failed, the files they named, and
  // the signatures every one of those parts showed. It is what the layer
  // ladder is climbing for, and it is the evidence a triage brief carries when
  // the ladder is spent — a check refuses a code-class finding whose only
  // evidence is one of these signatures. Quiet: nothing is wrong yet, and the
  // re-runs behind it are the test of the reading.
  'layer-transient',
  // A ship that went out with one proof missing: the credential whose service
  // was down past the wait, and the files nobody could run against it. It is
  // stamped only where the project turned `gates.proofDebt` on, which is the
  // owner's speed-over-residual-safety trade, and the settle run behind it is
  // what pays the debt back or records that it could not.
  'proof-deferred',
  // One judgment, and what the seat that made it was reading.
  // `diffTruncated: true` says the read cap cut the candidate diff itself, so
  // the end of the work is in no file the seat could open and the finding
  // rests on part of it. Absent means the whole diff was there to read: the
  // brief carries an excerpt of it either way, and an excerpt is not a cut.
  // A reader weighs a finding by its evidence, and the completeness of that
  // evidence is not derivable from the finding itself (ADR-0066).
  //
  // `file` is the one file a review finding is about, where the lens named
  // one, and `allowlist: true` says that file is one of the project's
  // cross-cutting gate allowlists. The word is assigned at the stamp, against
  // `gates.allowlistPaths`, and never read back out of the seat's sentence:
  // an allowlist addition is judged by the spec lens alone, and a reading of
  // whether anybody is judging them has to be countable (ADR-0010).
  'finding',
  // The cycle boundary, and what the cycle did not have to buy. `partsRun`,
  // `partsCarried` and `carryShare` are the cycle's carry (ADR-0058);
  // `confirmationParts` (ran, kept) is the confirmation sweep's, over the
  // layers it narrowed — what it executed, and what an earlier pass of the same
  // cycle had already proven at this sha (ADR-0046). `diffTruncated: true` says
  // the read cap cut this cycle's candidate diff, so its judgment seats could
  // not reach the end of the work anywhere; it is stamped here as well as on
  // the findings, because a round that raised nothing raises nothing to carry
  // the word, and a clean verdict over a cut diff is the one a reader most
  // needs to be able to see (ADR-0066).
  'verdict-rendered',
  // The one retry a repeated cycle fingerprint is worth, spent. The stamp
  // names the fingerprint, the render it was granted for and the cycles that
  // share it, so the park behind a second repeat reads off the ledger rather
  // than off a count nobody kept. Quiet — a repeat may be a flake, and one
  // more cycle is the cheapest way to find out — but never silent, because a
  // cycle the harness granted itself is a cycle somebody paid for (ADR-0022).
  'cycle-retry',
  'repair-round',
  // The run stopped moving on its own findings, and the reason says how: a
  // repair round that closed none of them (`no-progress`), a suite defect that
  // survived its re-freeze (`re-freeze-no-progress`), the round cap with its
  // granted rounds spent (`cap-exhausted`), or, in the ship lane, a merge round
  // that failed (`merge-conflict`). It is the whole vocabulary, and what is not
  // in it is as much of the record: a finding about the shape of the
  // implementation is not a stall, it is a repair round with a heading
  // (ADR-0007).
  'stall',
  'fresh-pass',
  // A frozen-surface collision the story's own card sanctioned: the test, the
  // assertion that changes, the card line the authorization rests on, and the
  // section it came from. Quiet, because the card answered the question before
  // the run asked it — but never silent, because the run amended a frozen test
  // on a document's authority and nobody was asked. It is the record a reviewer
  // checks the card against, and the count of them is what an outlier window is
  // read from (ADR-0044).
  'supersede-authorized',
  're-freeze',
  'operational-fix',
  // The gate answered itself on a standing acknowledgment: every finding it
  // would have asked about is a harness defect an operator already recorded as
  // known. Quiet, because the gate is answered and the run proceeds as it does
  // on any answer — but never silent, because the run took a human's authority
  // without asking the human. It names the findings, the fingerprints, the ack
  // events and who recorded them, and the `operational-fix` beside it carries
  // `source: 'ack'` (ADR-0032).
  'finding-ack-used',
  // gate integrity (loud)
  'gate-integrity',
  // The run passed the budget its lane was given. Loud, because the owner is
  // watching money leave and nothing else in the run will say so — and
  // informational, because a threshold never parks, blocks, or closes
  // anything (ADR-0021). The run pairs its own `resolved` at close.
  'budget-breach',
  // A candidate capture the diff policy refused, or one that took a frozen
  // write back. Loud, because both mean the tree the run judges is not the
  // tree the seat believed it left behind (ADR-0017). A refusal is owned by
  // the capture that got through; a take-back by the re-freeze that re-takes
  // the frozen surface (ADR-0015).
  'diff-policy-violation',
  // A capture that took a write back from a path the lane declared
  // re-capturable. Quiet: the revert, the record and the downstream statement
  // are the same as any take-back, but the verdict's re-freeze already owns
  // the artifact, so an alert would report a handled case (ADR-0017).
  'diff-policy-recapture',
  // The generated artifacts a capture cleared from frozen paths before it read
  // what the tree changed: files the freeze does not hold, under a glob the
  // lane declares swept. Quiet, and not a take-back — nothing authored was
  // taken back, so no later step is told to reason about them. The record
  // exists because the capture removed files from a tree under judgment, and
  // nothing leaves a capture in silence (ADR-0017).
  'capture-swept',
  // ship
  // The per-project ship token, at the two moments a run's own ledger is what
  // says where the token went: the wait, and the acquire. The token itself is
  // derived from these stamps and from `pr-opened`/`merged` across the open
  // runs of a project, never from a file — so a restart re-derives the holder
  // it had, and a stamp records a move rather than storing a right (ADR-0033).
  'ship-token',
  // The branch update the run takes under the token, just before its final
  // verdict: the tree the verdict certifies is then the tree that lands.
  // Stamped whether it ran or found the base where the run left it — a run
  // that merges the default branch into its own tree on its own authority
  // says so either way — and `capped` is the pass that stopped chasing a
  // moving base and left the update to the ship stage (ADR-0033).
  'pre-verdict-update',
  // The clean-rebase fast path's answer about one moved base: whether the
  // certification the run already earned stands over the tree the update
  // built, and why (ADR-0056). A taken record carries the default-branch
  // commits examined, the declaration version they were checked against, and
  // the certification it reuses; a refusal carries the closed reason. Quiet:
  // a refusal costs the run the re-verdict it would have taken anyway, and a
  // ship is what the record follows either way. Never silent, because a ship
  // that skipped a certifying pass has to say so, and because a flag that
  // fires for nothing has to be readable as one. Stamped only where the flag
  // is on: a project without it stamps nothing, as it always did.
  'fast-path-ship',
  'pr-opened',
  // The labels the request carries, derived from its own diff by the project's
  // label rules and applied before auto-merge arms. Stamped at every open, the
  // empty set included: a request whose diff asked for no label and one whose
  // derivation never ran read the same otherwise (ADR-0008).
  'pr-labeled',
  'check-transition',
  // One CI check attempt's evidence, captured when the attempt was observed
  // rather than when a reader needed it. It names the check run, the attempt,
  // the directory the metadata and the log were written to, and whether the
  // log is on disk, still owed, or refused with a reason. An external
  // cancel-and-rerun once destroyed the failing attempts of a ship, and the
  // triage that followed cited the cancellations because they were all the
  // forge still held (ADR-0041).
  'ci-evidence',
  'ci-flake',
  'branch-update',
  // One state of the forge that is not a state of a check: a pull request in
  // conflict with its base, for which the forge builds no merge ref and runs
  // no workflow, or a head sha it carries no check run of any name for. The
  // watcher would read either as a check that has yet to arrive, so each is
  // named here and routed (ADR-0008). Quiet — every kind has a route, and the
  // route stamps what it did — but never silent, because a run that waits on
  // the forge must say what it waits on.
  'forge-anomaly',
  // The watcher held a red check back from triage because the workflow run it
  // is a job of was still executing, so its log was still being written. One
  // stamp per wait — the head sha and the run it waited on — never one per
  // poll. Quiet: waiting is what the watcher does with every state that is not
  // yet a verdict, and the CI verdict that follows carries how long the wait
  // ran. Never silent, because a dispatch that did not happen when the ledger
  // says a check went red is otherwise a gap nobody can read (ADR-0008).
  'triage-wait',
  'merge-round',
  'merged',
  'merge-commit-check',
  'red-merge-breach',
  'card-sweep',
  // The close-out judgment on decision-record reconciliation: owed or not,
  // with the records named and the ticket written when owed (ADR-0026). A
  // failed judgment stamps ok:false — an unjudged ship is visible, never a
  // silent skip.
  'reconciliation-judged',
  // The close-out learning artifact a project asks for in its config: `ok`
  // with the artifact paths the seat reported, or ok:false with the reason
  // (ADR-0031). Quiet either way — the story shipped, and nothing here can
  // stop or slow the close — but never silent, because a feature that fails
  // without a record is a feature nobody can tell is broken.
  'learning-lesson',
  // escalation
  'park',
  'answer',
  // One gate answered `ack`: the operator's written statement that the gate is
  // wrong about the world, and the run's authority to go past it. It names the
  // gate, the park it answers, the stage the run stood in, and the reason,
  // which is required. Quiet, because a person decided and the run does what
  // they said — but never silent, because a check the run did not satisfy let
  // it through, and the count of these is what says whether a gate is being
  // repaired or merely acknowledged. Only a gate that states a JUDGMENT the
  // harness formed about the world offers it (ADR-0062).
  'gate-acknowledged',
  'resume',
  // The run's tree, brought to the default branch head for one answered
  // `stage-blocked` park: the park it belongs to, the branch, the sha the tree
  // stood at and the sha it now stands at. A retry on that park asks the
  // operator for a repair the run cannot make, and the repair lands on the
  // default branch, so the retry has to meet a tree that holds it. Quiet,
  // because the stage runs as it always did, but never silent, because the
  // inputs of a run moved between two attempts, and provenance is what says by
  // how much.
  // Stamped for the refusals too: a tree with the run's own work in it keeps
  // it, and the stamp carries the cause (ADR-0055).
  'tree-refreshed',
  // liveness (loud)
  'liveness-violation',
  // paired resolution append for loud items and breaches
  'resolved',
]);

export const INSTANCE_EVENTS = new Set([
  'daemon-started',
  'daemon-stopped',
  // A start that found no clean stop behind it: the previous instance died
  // where the ledger goes silent, and the seq it carries is that point
  // (ADR-0016). Every ordinary exit path stamps `daemon-stopped`, so this
  // event means a death no exit path saw.
  'daemon-crash-detected',
  // What this instance holds for one project's declared credentials, stamped
  // at the start and again the first time a gate reads a name no record covers.
  // `variables` names each declared variable with where its value came from —
  // the machine's store, the copy the daemon inherited from the window that
  // started it, or nowhere — and the fingerprint of the value. A count of
  // `inherited` above zero is a daemon running on a copy that the machine can
  // no longer confirm (ADR-0064). Absent on a home that declares no store.
  'credential-fingerprints',
  // A declared credential whose stored value moved: the fingerprint the
  // machine now holds differs from the one this instance last recorded.
  // Quiet and informational. It says a password changed and when the harness
  // first read the new one, which is what separates "the value on this host is
  // wrong" from "the service refused a value that never changed" (ADR-0064).
  'credential-rotated',
  // One defect in the environment this instance's seats will run in, found by
  // the start-time check and stamped once: a runner the host cannot execute, a
  // path its CLI will not trust, a clone whose git cannot hold the harness's
  // own path lengths. Informational — the daemon starts on every one of them,
  // and a clean host stamps none (ADR-0030).
  'seat-environment',
  // The credential gate at the launch door, stamped here because it runs
  // before a run exists: the parity read of every declared surface, and the
  // live probe of every declared value (ADR-0068). The run-scoped stamps of
  // the same names are the mid-run guards, and they carry the same fields.
  // The instance copy is also the probe cache: a pass carries `validUntil`,
  // and a gate reads the newest pass of a variable and its fingerprint here.
  'credential-surface',
  'credential-probe',
  'launch',
  // A launch the daemon refused. The console's reason file says why to
  // whoever asked; this says it to everyone reading the instance ledger, and
  // `olympusctl status` renders the last few. It carries `requestedBy` (the
  // console actor, or `frontier` for a launch the sweep asked for), `project`,
  // `lane`, the `card` or `ticket` named, the `runId` that would have existed
  // where the refusal came after the name was taken, and the `reason`
  // (ADR-0067).
  'launch-rejected',
  // A closed run reached the archive: at its close, or at the start that
  // swept it up afterwards. It carries how the directory travelled (`rename`
  // or `copy`) and the live directory a copy could not delete, and it is the
  // event that answers an `archive-failed` record for the same run.
  'run-archived',
  // One stamp that arrived for a run whose ledger had already closed: the
  // terminated child that exited after the kill, or any other run-scoped
  // append the close outran. It names the run, the event that did not land
  // and the seat behind it. Quiet: the run is over in the state it recorded,
  // and a stamp behind that close changes nothing anyone reads. Never silent,
  // because a machine that drops a write says where it went (ADR-0015).
  'late-append',
  // A closed run that did not reach the archive. Loud, because the run is
  // over and the move is the one part of a close that a process outside the
  // harness can block: the daemon carries on, and the record is what says a
  // run directory is sitting where no run lives (ADR-0015).
  'archive-failed',
  // A push notification that did not get through: the transport failed, the
  // target answered with an error, or it ran past its timeout. The event a
  // reader can no longer trust the push for is named, so the pull surfaces
  // stay the authority they always were (ADR-0028).
  'notify-failed',
  // One operator statement that a harness defect is known and deferred, and
  // the revoke that ends it. Together they are the whole store of standing
  // acknowledgments: the set is folded from this pair, so it survives every
  // restart and changes only when somebody says so (ADR-0032). The revoke
  // names one fingerprint and carries the fix it stands on.
  'finding-ack',
  'finding-ack-revoked',
  'workspace-released',
  // A run workspace the release could not delete, naming the directory that
  // stayed behind. Quiet: the run is over, every reader already looks past
  // the workspace root, and the answer is a retry the harness owes itself
  // rather than a decision for the owner. It stays open until a sweep deletes
  // what it names, and the `resolved` beside it is that sweep (ADR-0004).
  'workspace-leftover',
  'arming-changed',
  // One operator hold set or lifted, over one project or over the instance.
  // The whole store of the hold, folded at every daemon start the way arming
  // is: a hold outlives the instance that took it, which is what the restart
  // recipe stands on (ADR-0040).
  'hold-changed',
  'config-changed',
  'factory-starvation',
  // Ticketed breach escapes the sweep may not launch, because the project is
  // paused or was never armed. Loud, because the pause is the owner's and the
  // daemon never bypasses it; the sweep appends the paired `resolved` when
  // the repairs launch (ADR-0024).
  'repairs-owed',
  'tripwire-breach',
  // A stage of one run past the duration band the same stage of the same lane
  // built in the ledgers. It sits in the instance ledger because the watcher
  // wrote it, and the watcher holds no run: detection that cannot reach into a
  // run cannot change one (ADR-0034).
  'stage-overrun',
  'baseline-proposal',
  // One eval review over a window of ships. `ships` names the run ids the
  // window held, and the next window starts after the newest of them;
  // `lanes` counts them per lane, so a window that held no repair while
  // repairs shipped reads as the filter it is. `shipCount` is the total at
  // dispatch, information only (ADR-0012).
  'eval-review',
  // A watched workflow's most recent completed run on the default branch came
  // back red. Loud, because the run is off every request path — no run waits
  // on it and no check watcher reads it — so this record is the only thing
  // between that red and nobody noticing. One per red run: the same run,
  // polled again, is the same piece of news. `jobs` names the jobs of that
  // run that were not green, each with its conclusion, so the record says
  // which slice went red and not only that the night did (ADR-0035).
  'workflow-red',
  // A watched workflow completed green while a red of the same workflow was
  // still open. Quiet: the record is the evidence the loud item is answered
  // with, and it owns that item, so the strip clears where the green landed
  // rather than where a human got round to it (ADR-0035).
  'workflow-recovered',
  // A declared service that has refused its own probe for an hour while a run
  // waited on it. Loud, because nobody is being asked anything: the run waits
  // on its own and the operator is being told, once, that a service the
  // factory depends on is down. It names the project, the credential and the
  // run that is waiting, and it is answered by the probe that comes back green
  // (`resolution.mjs`).
  'external-outage',
  // The deferred proof, settled: the daemon ran the files a ship went out
  // without against the default branch once the service came back. `ok` says
  // which way it went, and a red is also an escape of kind `deferred-proof`
  // against the ship that carried it. Stamped here and not in the run,
  // because the run that made the trade closed hours or days before.
  'proof-settled',
  // Instance-scoped escalations: a park that waits on the human but belongs
  // to no open run (card-invalidated from the ship-time sweep). The paired
  // `answer` clears the park and unblocks the card; runs park and answer
  // through the engine.
  'park',
  'answer',
  ...SEAT_EVENTS,
  'resolved',
]);

// The escape lifecycle: recorded → ticketed (the repair ticket the harness
// wrote for it, absolute path) → fixed. The ticket stamp follows the file it
// names, so a ticketed escape always has a ticket to repair from (ADR-0024).
// An escape ends one of two ways and the ledger says which: `escape-fixed` is
// a repair run's close-out, `escape-marked-fixed` is an operator's statement
// that the defect is out of the product, with the evidence it stands on.
export const ESCAPES_EVENTS = new Set([
  'escape-recorded',
  'escape-ticketed',
  'escape-fixed',
  'escape-marked-fixed',
]);

// Stream classing. Every stream-classed append also lands as a pointer in
// the matching stream index. The full event lives only in its source ledger.
export const QUEUED_EVENTS = new Set([
  'park',
  'tripwire-breach',
  // One stage of one run past the duration band of that stage, read from the
  // heartbeat the stage stamped. Queued, because it asks the operator to look
  // and asks the run for nothing: the record names the stage, the elapsed and
  // the band it left, and the run carries on untouched. It opens once per
  // stage and closes when the stage moves on (ADR-0034).
  'stage-overrun',
  'baseline-proposal',
  'eval-review',
]);
export const LOUD_EVENTS = new Set([
  'liveness-violation',
  'gate-integrity',
  'diff-policy-violation',
  'red-merge-breach',
  'factory-starvation',
  'repairs-owed',
  'budget-breach',
  'archive-failed',
  'workflow-red',
  'external-outage',
]);

// The close-out backstop. A loud record resolves at the event that owns it
// (`resolution.mjs`); these two are the classes a run may also close on its
// own when no owner ever landed. They ask the owner for no decision — the run
// they reported on is over — so leaving them open would build the owner an
// alert strip of finished runs (ADR-0021).
export const CLOSE_RESOLVED_EVENTS = new Set(['budget-breach', 'diff-policy-violation']);

export function streamOf(event) {
  if (QUEUED_EVENTS.has(event)) return 'queued';
  if (LOUD_EVENTS.has(event)) return 'loud';
  return null;
}

// Closed park catalog — the only states that wait on the human. A new park
// type enters only by a design-level decision, never ad hoc from a seat.
export const PARK_TYPES = new Set([
  'open-decisions', // open decisions at build start
  'grounding-conflict', // spec birth
  'intent-conflict', // spec gate
  // The one gate park. The gate runs as many rounds as it converges for and
  // parks only when it stops closing findings: a round that closed none of
  // the previous round's blocking set, or a round whose blocking count is not
  // below the count two rounds back. A decision park names its condition in
  // the type, because `reason` on a park already carries the close an
  // answered recovery park takes (ADR-0020).
  'spec-gate-stalled',
  'unkilled-gap-survivor', // adversary survivor without a killing test
  'second-zero-kill', // second 0/N adversary round
  'second-stall', // response ladder
  // A verdict cycle that judged what an earlier cycle of the same run already
  // judged — same candidate sha, same suite, same open findings by identity,
  // same check state — after the one retry the repetition was worth. A
  // decision park: it names its condition in the type, and the run holds
  // every result it earned while it waits (ADR-0022).
  'cycle-repeat',
  'card-invalidated', // ship-time card sweep
  // A choice a shipped story left open on a later card, asked at close-out
  // while the context is fresh. Like `card-invalidated` it belongs to the card
  // and not to a run: it holds that card's next launch and closes nothing
  // (ADR-0052).
  'card-decision',
  'provisioning-gate',
  // Terminal-state discipline (ADR-0015): a recoverable failure parks with
  // `retry` / `abandon` instead of closing the run.
  'seat-failure', // a seat work product past its machine retry allowance
  'stage-blocked', // a stage precondition the run cannot settle itself
  'command-error', // a configured command could not run at all
]);

// Terminal run states. Every one of them stamps `run-closed`. A run reaches
// one of them through the ship path, a human kill, or a human answering a
// park with its abandon option — never through a condition the run met on
// its own (ADR-0015).
export const CLOSE_STATES = new Set(['shipped', 'failed', 'killed']);

// Closed defect kinds. A defect the harness recognizes in itself used to be
// carried as prose wherever it was recorded: one defect described in two
// sentences across two runs counts as nothing, and the reader of those ledgers
// has to decide the sentences mean the same thing. A kind is what makes a
// recurrence a number. The word is assigned where the harness observes the
// defect, never read back out of a seat's sentence about it. The set is closed
// and grows the way every registry above does — by a decision recorded in an
// ADR, never ad hoc from a call site (ADR-0008, ADR-0024).
//
// The kinds a `gate-integrity` record classifies. The record is loud and its
// kind decides who answers it, so every one of these owns a rule in
// `resolution.mjs` — a loud record nobody owns is one the sweep walks past for
// ever.
export const GATE_INTEGRITY_KINDS = new Set([
  // The required checks are green and auto-merge did not fire.
  'auto-merge',
  // A request that existed without the labels its own diff asks for. The
  // forge starts a request's checks at creation, so a label that lands after
  // that is a label the check reading the request may never see.
  'pr-label-missing',
  // A CI failure log the forge would not hand over to the triage that needed
  // it. The triage still runs — a red check is a red check — but it judges the
  // red on the reason the log is absent rather than on the log.
  'triage-log-missing',
  // A required check that answered both ways on one head sha often enough that
  // its greens report nothing about the tree. The harness re-ran it on the
  // strength of those greens, so the record is where the re-runs stop.
  'deterministic-red',
  // A gate layer that died of memory rather than of the tree: the abort a heap
  // ceiling ends a process with, the words a runner prints about one, or a peak
  // that reached the ceiling the project declared for the layer. It is stamped
  // where the attempt settles, from the exit and the measured peak alone, so
  // the attribution costs no judgment seat a cycle — it was reasoned out by one
  // twice, after two runs had already died of it (ADR-0045).
  'resource-exhaustion',
]);

// The kinds a step stamps on the record of the defect it just met. These
// classify a record that already exists and already has whatever loudness it
// is owed, so they add no alert and owe no ownership rule: the word is there to
// be counted, not to be answered.
export const OBSERVED_DEFECT_KINDS = new Set([
  // A red layer whose output the harness cannot produce: a bounded tail of one
  // long stream, no named part carrying the failure, and no whole stream on
  // disk either — the file outgrew its own cap, or the attempt had no file
  // (ADR-0043). Triage then judges the red on whatever ran last rather than on
  // what failed. Stamped on `layer-result`.
  'layer-log-truncated',
  // A candidate capture that reverted a write to a path the lane froze. The
  // revert is the design (ADR-0017); the kind is what makes a surface that
  // keeps producing them countable. Stamped on both take-back records.
  'capture-takeback',
  // A defect that reached the default branch through a ship that carried its
  // certification over a moved base instead of earning it again (ADR-0056).
  // The word is what makes the owner's speed-over-residual-safety trade a
  // number rather than an anecdote: the kind is assigned where the escape is
  // recorded, from the ship record alone, and the standing tripwire over a
  // rolling window of it is what proposes switching the flag back off.
  'fast-path-escape',
  // A defect of the machinery that judges, met at a provisioning gate and
  // acknowledged there. The gate offers no retry — a retry re-runs the same
  // harness — so the run goes on under a standing acknowledgment and the
  // defect is counted here until `olympusctl revoke` names the fix behind it
  // (ADR-0032, ADR-0068). The escape carries the ack fingerprint, so one
  // defect reported in two sentences across two runs is one count.
  'harness',
  // A proof a ship went out without, that did not hold when it was finally
  // run. The trade is the owner's (`gates.proofDebt`), the settle run is what
  // tests it, and this word is what makes the cost of the trade a number
  // rather than an anecdote. It is recorded against the ship that carried the
  // debt, whose merge is what put the defect in the product.
  'deferred-proof',
]);

// The whole vocabulary. `escape-recorded` takes any of it: a defect the harness
// named before a merge is recorded under that name when the merge carries it
// into the product (ADR-0024).
export const DEFECT_KINDS = new Set([...GATE_INTEGRITY_KINDS, ...OBSERVED_DEFECT_KINDS]);

/** The kind, or a throw naming it. The only way a kind reaches a stamp. */
export function assertDefectKind(kind) {
  if (!DEFECT_KINDS.has(kind)) throw new Error(`unknown defect kind: ${kind}`);
  return kind;
}
