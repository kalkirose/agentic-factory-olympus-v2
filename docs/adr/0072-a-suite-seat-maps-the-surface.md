# ADR-0072: A suite seat maps the surface it is asked to hold

Status: accepted (2026-09-05)

## Decision

Every seat that writes a suite file receives the security dimensions the
adversary receives, and owes an enumeration of the story's surface along each
of them. The enumeration is a structured field in the seat's report, and the
daemon checks its shape and its coverage.

- **One list of dimensions, six readers.** `SECURITY_DIMENSIONS` in
  `src/lanes/lenses.mjs` holds authorization on every entry point, input trust,
  secrets and trust boundaries. The lens criteria read it for the verdict panel.
  The wave brief reads it for the adversary. The suite brief and the re-freeze
  brief read it for the map, and the deterministic check in each of the two
  lanes reads it again. The four new readers reach it through
  `src/lanes/surfacemap.mjs`, one module both lanes import, so neither lane owns
  the rule.
- **The dimensions are not project config.** `review.lenses` selects the verdict
  panel alone. A project that drops the security lens still gets the dimensions
  in its waves, and a suite must map what the adversary probes. A config key
  here would let a project narrow its map while its waves stayed wide.
- **`surfaceMap` and `dimensionsOutOfScope` are required fields** on every suite
  report of the story lane: the author write, the adversary amendment, the
  strengthening round, the red-state fix, and the re-freeze amendment after the
  freeze. Both are flat arrays of flat objects, because the report schema subset
  allows one level of nesting, so the dimension rides each row. A row carries
  the dimension, the kind, the item, where the item sits, and one of `test` or
  `outOfScope`. The seat that resolves conflict hunks in test files during a
  merge is not one of the five: it merges two versions of a frozen file, it
  answers no spec, and it is given no map brief.
- **`SURFACE_KINDS` is a closed vocabulary of eight.** `carrier` is what carries
  a credential or a grant into a request. `route` is where a request can arrive.
  `parameter` is what steers a destination, a query or a client. `override` is a
  value a caller can set that displaces a pinned configuration. `fallback` is a
  value the code uses when the configured one is absent. `log-site` is a call
  that writes a log line, a metric or an error payload. `store` is where a value
  comes to rest. `boundary` is where data crosses into the process from outside
  it. A kind enters, moves or leaves by a decision recorded here, never from a
  call site.
- **Eleven deterministic checks, all about the document.** A dimension in
  neither field. A dimension in both. An out-of-scope dimension with no reason.
  A row with no item or no `where`. A row closed by both `test` and
  `outOfScope`, or by neither. A row whose `outOfScope` reason is empty. A
  `test` value no declared suite file holds, compared after whitespace runs
  collapse on both sides. A survivor wave no row names. A row that names a
  survivor wave and carries `outOfScope`. An item of the previous map this map
  drops. One item on two rows. A defect takes the route every suite-report
  defect takes: one corrective invocation with the defect list, then the
  seat-failure park.
- **The previous map is the last suite report before the last commit.** A
  corrective invocation inside the current write is never read as the write
  before it. The author write has no previous map and skips that check.
- **The adversary is never shown the map.** The wave brief is unchanged.
- **`surface-map` is a run event**, one stamp per suite write, carrying the
  write, the row count, how many rows a test closes, how many an excuse closes,
  the dimensions declared out of scope, and the count of distinct kinds. Counts
  only. The rows stay in the seat report on disk, and the freeze record carries
  the map of the last write beside the reds it already carries.

## Why a map and not more waves

A suite seat that is shown defects writes a test for each one and stops. It
never asks the question the defect list is a sample of: what else on this
surface can carry the same fault.

One story froze after four adversary rounds. Three of the four rounds survived,
and between them the suite seat ran three times. Each time it closed exactly the
holes the last adversary named. Each time it left the siblings of those holes
open, on the same file. The suite gained a test for one cookie name and no test
for the second cookie name beside it. It gained a test for one entry header and
no test for the second entry route. It gained a test for one log line and no
test for the log line under it. The second cookie name was not new. It had sat
in the tree for months, and it carried the same secret the story's own grant
carried. A seat that had listed every carrier of that secret would have found it
before any adversary ran.

The three extra rounds cost three full seats, three full suite runs, two owner
questions, and about two hours of a run waiting for a person.

More waves per round do not repair that. Waves buy sample size for the kill
rate, and three waves against a round-one suite would have found three of the
holes at once instead of one, at three times the cost per round. The seat would
still have closed the three it was shown. The defect is the seat's method, and
the repair is to ask for the enumeration the method skips.

## Why the checks do not judge the enumeration

Nothing mechanical knows the surface. Every check listed above is about the
shape and the coverage of the document, and a seat that enumerates thinly and
honestly passes all eleven.

That is not a gap in the design. It is the reason the adversary stays blind.
The adversary writes a plausible wrong implementation against the spec, the
frozen suite kills it or does not, and a survivor is a demonstrated hole. That
answer is independent of the map, and the kill-rate band over it reads a real
measurement.

An adversary that read the map would be told where the seat already looked. Its
wrongness would drift to whatever the map omits, which sounds useful and is not:
a kill would then prove the suite covers what the map declared, and would prove
nothing about whether the map is the surface. The band over that number would be
a band over self-consistency, and it would read high for ever.

The cost of a blind adversary is that it will sometimes attack an axis the map
already lists, and the suite will sometimes fail to kill it. That case is worth
finding. It reads as a weak test, not as a missing row, and the two need
different repairs.

## Why every write carries the map, and why it never shrinks

Every suite seat runs in fresh context. Each one can delete the row the write
before it earned, exactly as each one can delete the test that discharges a gate
note. So the obligation rides all five briefs, and the check reads the previous
map at each of the four writes that have one.

The no-shrink rule makes the map cumulative inside a run. A row that a spec
amendment makes wrong stays, with an `outOfScope` reason. That is one line, and
it is the line that says the item was considered and released, rather than
forgotten.

## Why the strengthening brief carries every round

A seat cannot see a pattern across rounds that nobody puts in front of it. Three
rounds that named a cookie value, then a bare request header, then a second
cookie name are one instruction read together: enumerate the carriers. Read one
at a time they are three requests to add one test, and three suite reports show
a seat doing exactly that.

So the survivor evidence gained a second section: every earlier round of the
run, newest first, with its approach and its wrongness. No diff, because the
lane drops each survivor tree when it ends a round, and the report is what is
left. The added text stays small for the same reason.

## What this costs

Every suite report grows. A story with a wide surface writes twenty to forty
rows, five times over, and that is seat tokens and report size on every story.
A story with no security surface pays four `dimensionsOutOfScope` lines and
stops, which is why that field exists.

The check over a named test is newly load-bearing. A project whose test names
are assembled at runtime, from a template or a variable, fails it on an honest
map, and the corrective invocation can pass it only with a literal name. The
defect line names every file it searched.

A suite seat that cannot produce a valid map after one corrective invocation
parks the run. That is a stop that could not happen before. It is the same stop
every other suite-report defect already raises, and the fields it is about are
the seat's own.

## Fallback paths

If the map proves to be a document seats write without reading the tree, the
enumeration gains an evidence obligation: each row cites the line of the file it
read. The symptom is a map that passes all eleven checks while the adversary
keeps finding items no row listed. Trigger: two freezes whose surviving
wrongness sits on an item no map listed. Reversal cost: one required field and
one check.

If the kind vocabulary misses a class of carrier, the repair is in
`SURFACE_KINDS` and not in the mechanism: one entry here, one line in the brief.
Trigger: an eval review that cannot name a real surface item by any of the eight
kinds. Reversal cost: low.

If the brief grows past what a suite seat reads reliably, and the seat starts to
miss note obligations or component obligations, the map moves to a step of its
own. That step writes the map and is checked before the suite seat spawns, and
the suite brief then carries the finished map instead of the instruction to
write one. Trigger: a measured fall in note discharge or component targeting
after this brief lands. Reversal cost: moderate, one seat and one report
contract.

If the no-shrink rule costs more human attention than it saves, and parks arrive
where a seat cannot state why a stale row stays, the rule narrows to the rows a
survivor wave ever named. Trigger: two seat-failure parks whose only defect is a
dropped row of a superseded criterion. Reversal cost: low, one filter in the
check.
