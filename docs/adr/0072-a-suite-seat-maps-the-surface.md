# ADR-0072: A suite seat maps the surface it is asked to hold

Status: accepted (2026-09-05, the map as the only measure 2026-09-12)

## Decision

Every seat that writes a suite file receives the security dimensions and owes an
enumeration of the story's surface along each of them. The enumeration is a
structured field in the seat's report, and the daemon checks its shape and its
coverage.

- **One list of dimensions, five readers.** `SECURITY_DIMENSIONS` in
  `src/lanes/lenses.mjs` holds authorization on every entry point, input trust,
  secrets and trust boundaries. The lens criteria read it for the verdict panel.
  The suite brief and the re-freeze brief read it for the map, and the
  deterministic check in each of the two lanes reads it again. The four readers
  beside the panel reach it through `src/lanes/surfacemap.mjs`, one module both
  lanes import, so neither lane owns the rule.
- **The dimensions are not project config.** `review.lenses` selects the verdict
  panel alone. A project that drops the security lens still owes the map: the
  panel judges one candidate and the map is what the frozen suite is held to. A
  config key here would narrow the one enumeration nothing else in the run
  makes.
- **`surfaceMap` and `dimensionsOutOfScope` are required fields** on every suite
  report of the story lane: the author write, the red-state fix, and the
  re-freeze amendment after the freeze. Both are flat arrays of flat objects,
  because the report schema subset allows one level of nesting, so the dimension
  rides each row. A row carries the dimension, the kind, the item, where the
  item sits, and one of `test` or `outOfScope`. The seat that resolves conflict
  hunks in test files during a merge is not one of the three: it merges two
  versions of a frozen file, it answers no spec, and it is given no map brief.
- **`SURFACE_KINDS` is a closed vocabulary of eight.** `carrier` is what carries
  a credential or a grant into a request. `route` is where a request can arrive.
  `parameter` is what steers a destination, a query or a client. `override` is a
  value a caller can set that displaces a pinned configuration. `fallback` is a
  value the code uses when the configured one is absent. `log-site` is a call
  that writes a log line, a metric or an error payload. `store` is where a value
  comes to rest. `boundary` is where data crosses into the process from outside
  it. A kind enters, moves or leaves by a decision recorded here, never from a
  call site.
- **Nine deterministic checks, all about the document.** A dimension in neither
  field. A dimension in both. An out-of-scope dimension with no reason. A row
  with no item or no `where`. A row closed by both `test` and `outOfScope`, or
  by neither. A row whose `outOfScope` reason is empty. A `test` value no
  declared suite file holds, compared after whitespace runs collapse on both
  sides. An item the previous map held and this one drops. One item on two rows.
  A defect takes the route every suite-report defect takes: one corrective
  invocation with the defect list, then the seat-failure park.
- **The previous map is the last suite report before the last commit.** A
  corrective invocation inside the current write is never read as the write
  before it. The author write has no previous map and skips that check.
- **`surface-map` is a run event**, one stamp per suite write, carrying the
  write, the row count, how many rows a test closes, how many an excuse closes,
  the dimensions declared out of scope, and the count of distinct kinds. Counts
  only. The rows stay in the seat report on disk, and the freeze record carries
  the map of the last write beside the reds it already carries.

## Why a map and not a sample of holes

A suite seat that is shown defects writes a test for each one and stops. It
never asks the question the defect list is a sample of: what else on this
surface can carry the same fault.

The shape is the same every time it is read. A seat closes exactly the hole it
was handed, and it leaves the siblings of that hole open on the same file: a
test for one cookie name and none for the second cookie name beside it, a test
for one entry header and none for the second entry route, a test for one log
line and none for the line under it. The siblings are not new. They sat in the
tree before the story, and they carry what the story's own grant carries. A seat
asked to list every carrier of a secret finds them. A seat asked to close a hole
does not, and a second sample buys a second hole at the price of a second round.

So the ask is the enumeration, once, from the seat that is already reading the
surface to write the tests.

## Why the checks do not judge the enumeration

Nothing mechanical knows the surface. Every check listed above is about the
shape and the coverage of the document, and a seat that enumerates thinly and
honestly passes all nine.

What answers a thin map is not another check here. It is a defect that ships: a
CI red on the merge commit or a repair ticket against the shipped behavior, on
an item no row listed. That reads as a map that was not the surface. A defect on
an item a row did list reads as a test that does not hold. The two need
different repairs, and the record of the defect is what says which.

## Why every write carries the map, and why it never shrinks

Every suite seat runs in fresh context. Each one can delete the row the write
before it earned, exactly as each one can delete the test that discharges a gate
note. So the obligation rides all three briefs, and the check reads the previous
map at each of the two writes that have one.

The no-shrink rule makes the map cumulative inside a run. A row that a spec
amendment makes wrong stays, with an `outOfScope` reason. That is one line, and
it is the line that says the item was considered and released, rather than
forgotten.

## What this costs

Every suite report grows. A story with a wide surface writes twenty to forty
rows, three times over, and that is seat tokens and report size on every story.
A story with no security surface pays four `dimensionsOutOfScope` lines and
stops, which is why that field exists.

The check over a named test is load-bearing. A project whose test names are
assembled at runtime, from a template or a variable, fails it on an honest map,
and the corrective invocation can pass it only with a literal name. The defect
line names every file it searched.

A suite seat that cannot produce a valid map after one corrective invocation
parks the run. It is the same stop every other suite-report defect raises, and
the fields it is about are the seat's own.

## Fallback paths

If the map proves to be a document seats write without reading the tree, the
enumeration gains an evidence obligation: each row cites the line of the file it
read. The symptom is a map that passes all nine checks while defects keep
arriving on items no row listed. Trigger: a shipped defect, from a CI red or a
repair ticket, on a surface the map did not list. Reversal cost: one required
field and one check.

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
shipped defect ever named. Trigger: two seat-failure parks whose only defect is
a dropped row of a superseded criterion. Reversal cost: low, one filter in the
check.

## References

- ADR-0006, ADR-0019, ADR-0038, ADR-0060, ADR-0087
- `src/lanes/surfacemap.mjs`
- `src/lanes/lenses.mjs`
- `src/lanes/story.mjs`
- `src/lanes/verdict.mjs`
