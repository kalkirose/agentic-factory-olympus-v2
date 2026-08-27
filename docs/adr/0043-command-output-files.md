# ADR-0043: A command's output is a file, and the tail is the summary

Status: accepted (2026-08-28)

## The condition

Every command this harness runs — a gate layer, the suite, the card lint, a
replay probe, a `gh` call — runs through one primitive, `runCommand`. Until now
that primitive held its child's output in memory, bounded, and answered with the
last few thousand characters of it. Every consumer inherited the bound, and
every consumer inherited what the bound does to a long stream: the end of a run
is the part that survives, and the failure of a sequence is in the middle.

The class has now been paid for three times.

1. A gate layer command is a sequence — a suite runner with steps — that reports
   one exit code. A red in step four reached triage as the green minutes of
   steps five and six. Answered consumer-side in the part-marker protocol
   (ADR-0008): a command may say where its parts begin, and the record keeps a
   bounded tail *per part*.
2. The same bound, in the record, was then honest enough to name itself:
   `layer-log-truncated` counts the reds whose evidence is a tail with no part
   under it.
3. The replay probe (ADR-0042) shipped with a 12,000-character bound of its own
   and met the class again on its first live use. Measured on this instance: a
   triage seat replayed a 38-minute gate layer of six steps; the fourth step
   failed 36 minutes in; the fifth and sixth ran green for two more minutes; and
   the record the seat read held the green of the last step plus one summary
   line saying which step had failed. The seat could not name a single failing
   test of the suite it was spawned to reproduce.

Three fixes at three consumers, for one defect at one primitive. The fourth
consumer would have paid for it again.

## Decision

**The primitive writes the whole stream to a file. Always, for every caller.**
The in-memory tail stays exactly as it was — it is the cheap summary a ledger
line quotes and a park text carries — and the file is the text under it. A
consumer cannot reintroduce the class by forgetting to ask for a file: it is
written whether it is asked for or not. What a caller chooses is only where it
lands, and whether it survives.

### Where it lands

A caller with a run behind it names a path inside that run's directory:
`runs/<id>/commands/<name>.log`, one per layer attempt, per lint, per red-state
check, and — for the replay probe — the `runs/<id>/probes/<name>.txt` file its
record already pointed at. That placement is the whole lifecycle: the run
directory archives at close-out, the orphan sweep takes a crashed run's
directory with it, and no store, no sweep, and no garbage collection is added by
this decision.

A caller with no run behind it — the forge's `gh` reads, the harness's own tests
— gets a file under `COMMAND_LOG_ROOT`, which is `<tmpdir>/olympus-commands`. It
is on the host's temporary directory deliberately: the host already empties that
directory, a green deletes its own file the moment it settles, and what can
accumulate there is a failed `gh` call measured in kilobytes. A store on the
daemon home would need a sweep of its own, and no defect here is worth new
garbage collection.

### What survives

At the settle of every command:

- **A green's file is deleted.** The exit code is the answer, the tail is the
  colour, and a green nobody will read is a green nobody has to store.
- **A red's file is kept** — a nonzero exit, a signal, a spawn error — and
  archives with the run.
- **A failure that printed nothing keeps no file.** An empty file is not
  evidence and reads like a lost one.
- **`keep: 'always'` keeps a green's file too.** One caller uses it: the replay
  probe, whose whole purpose is a seat reading the output, green or red.

The deletion is the primitive's, at the same point the result is resolved. A
consumer cannot forget to clean up, and no path can leave a file behind that no
record names.

### The cap, and the honesty of `layer-log-truncated`

A file stops at 10 MB. The file says so on its own last line, and the result
carries `log.truncated`. Nothing about a cut is silent.

`layer-log-truncated` keeps meaning what it always meant: **output the harness
cannot produce.** With a file under every record, that is no longer true of a
long stream — it is true only of a stream that outgrew the file's cap, or of an
attempt with no file at all. So the stamp condition narrows to exactly that, and
the record still names the capped file beside the defect, because 10 MB of
evidence is better than none. This is the narrowing ADR-0008 wrote down as this
kind's fallback path, taken for the reason it named: the tail was not what was
missing.

### Secrets

`redact` is a hook on the primitive, applied to whole lines before anything
holds them — the file, the tail, and the parts alike.

- **The replay probe redacts at write.** The probe process holds this host's
  credentials and the file is written for a seat that holds none, so no
  unredacted copy of a probe's output exists on this disk at any moment. This
  is at least as redacted as the probe was before: the redaction used to run
  over the answer, on the way to the file.
- **Gate output is stamped unredacted, as it was before this decision.** A
  layer's output was never redacted, and this decision does not quietly change
  that posture. It is a real gap — a suite that prints a key writes it to the
  run directory — and it is one to answer on its own evidence, not as a side
  effect of a truncation fix.
- **The credential probe (ADR-0027) writes no file at all**, `log: false`. It is
  the one exception to "always", and it is the one command whose output nothing
  reads: a yes/no question whose exit code is the whole answer, whose output can
  carry the credential it just asked about. A file there would make nothing
  readable and would leave a key lying about. The exception cannot reintroduce
  the truncation class, because there is no consumer of that output to truncate.

### What the consumers do with it

- **A red `layer-result` names its file** (`log`), and so does a
  `layer-abandoned` — including the first red the flake filter replaced, which
  is otherwise the one record of minutes that were spent.
- **The triage brief names it** under the red's evidence: the tail and the parts
  are the summary, the file is the text, and the seat is told to open it when
  the summary does not name the failure.
- **The probe brief carries the end of the output and the path of the whole.** A
  brief is a prompt and stays bounded; a seat that needs what ran before the end
  reads the file. The probe stamp carries the byte count, and `capped: true`
  when the cap cut it.

## Why not the alternatives

**Raise the bound.** The bound was raised for the probe — 4,000 to 12,000 — and
the class met it on its first live run. A number large enough for a 38-minute
suite is a number that does not belong in memory or in a prompt.

**Keep a head as well as a tail.** It would have missed this failure too: the
step that failed ran 36 minutes into a 38-minute layer, which is neither end.

**Rely on the part markers.** They work, and they stay: they attribute output to
the part that produced it, which no file does. But they are an opt-in that a
project's command has to print, they bound each part in turn, and the two
consumers that met the class most recently — the probe and the triage read —
never looked at parts at all.

**Stream to the ledger.** The ledger is a line-oriented record a person reads
and quotes. Minutes of a build is not that, and ADR-0042 already settled it.

## Fallback paths

**The file, per caller.** Every call site names its own path, so one caller
returns to the old behaviour by passing `log: false` — no file, the tail, and
the record it always wrote. Trigger: a call site whose output must not be held
at all, the way the credential probe's must not. Reversal cost: one option at
one call site.

**The file, everywhere.** The default path is one expression in `runCommand`.
The primitive reverts to memory-only by making the file opt-in instead of
opt-out, and every record that names a file falls back to the tail it still
carries. Trigger: a host where the writes cost more than the evidence is worth —
a disk that cannot take a run's worth of layer output. Reversal cost: one
default and this ADR; no record shape changes, because the field is additive and
every reader of it treats absence as "nothing known".

**Retention.** `keep: 'evidence'` is the default and `keep: 'always'` is one
word at a call site. If a red's file proves to be worth less than the space it
takes — an archive growing past what the host can hold — the retention narrows
to the layer attempts alone and the rest settle green-or-red the same way.
Trigger: an archive whose size is a problem before its contents are. Reversal
cost: one predicate in the primitive.

**The cap.** `LOG_CAP` is one constant. It moves in either direction without a
consumer change: the file says what it stopped at, and the result carries
`log.truncated` whatever the number is. Trigger: a real command that outgrows
10 MB honestly, or a host that cannot spare it. Reversal cost: one constant.

**The home for runless commands.** `COMMAND_LOG_ROOT` is one constant. If the
host's temporary directory proves to be the wrong home — a machine that never
empties it, or one that empties it while a command is running — it moves to a
directory the daemon owns, and that directory then needs the sweep this decision
avoided. Trigger: files under it that outlive the sessions that wrote them.
Reversal cost: one constant, plus a sweep at daemon start.
