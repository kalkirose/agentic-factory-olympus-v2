# ADR-0059: Ground a project states no suite reads

Status: accepted (2026-08-31)

## Decision

A project may declare, in `gates.groundlessPaths`, the repo-relative path
entries that no test suite of it reads. A verdict cycle drops those paths out
of its diff before it attributes anything, so a change confined to them neither
blinds the cycle nor reaches a part.

- **It is a positive claim, made by the project, in the project's config.** The
  entries are plain prefixes or globs, the same path vocabulary every other
  entry in the config uses. Absent means the empty list, which is exactly the
  behaviour every project had before the field existed.
- **It is read at one moment by one module.** `src/lanes/parts.mjs` filters the
  changed-path list through it, before the blind test and before any part is
  matched. Nothing else reads it.
- **It is not `gates.inertGround`.** That list answers a different question at a
  different moment: may the default branch move this file while a certified
  ship keeps its certification (ADR-0056)? It is read at ship time and only by
  `src/lanes/fastpath.mjs`. Neither list is derived from the other, neither
  reader consults the other's list, and a project earns each entry of each by
  its own proof.
- **Every entry is proven, never asserted.** The project's own declared-ground
  check sweeps its test trees for run-time reads and fails on any
  `groundlessPaths` entry a suite opens. The list is short by policy, and the
  sweep runs again whenever it changes.

## What this is for

A changed path under no part's declared ground makes every part of every layer
run. That rule is right and it stays (ADR-0046): a path the mapping cannot
speak about could reach anything, and doubt re-runs.

The rule is right about paths that could reach a suite. It is also applied to
paths that provably cannot. A decision record, a readme, an architecture
document and a planning card are all files a repository changes often and no
test opens. Under the rule alone, each of them costs a full re-run of every
part of every layer of the cycle that follows it, and the harness has no way to
be told otherwise.

The alternative on the table was to let the mapping guess what an unattributed
path affects. That was rejected. A wrong guess skips a suite that should have
run, which is the one direction this mechanism must never fail in. A declared
list fails in the same direction, so the difference is not the risk but who
carries it: a guess is the harness being wrong about a project it cannot see,
and a list is the project being wrong about itself, in writing, in a file that
reviews like code.

## Why it is a separate list from `inertGround`

The two questions look alike and are not.

`inertGround` asks whether a certified ship may ignore a file the default
branch moved. `groundlessPaths` asks whether a change to a file can affect a
test suite. A file may be safe for one and not the other. A generated client
that no suite opens is groundless, and a ship that carried its certification
over a change to it may still be wrong, because the built artifact ships. A
CODEOWNERS file the ship path may ignore over a merge is not automatically a
file no suite opens, because a suite may lint it.

Deriving one from the other would make every future entry of either a claim
about both, and the reviewer of the entry would only have thought about one.
Two lists cost two proofs and two reviews, which is the price of the two
questions being different.

## Why the entries are swept and not trusted

A wrong entry means a change to that path skips suites it should have run, and
the defect ships. That is the failure this whole family of decisions is written
against, so the entry is not allowed to be an opinion.

The sweep is static. It reads the test trees for what they open and refuses an
entry any suite touches. That is what removed a readme and a config file from a
project's inert list once the sweep was pointed at it, and it applies here
unchanged.

Static is not complete. A path built at run time, from a variable, is a read
the sweep cannot see. So every entry is a deliberate risk that the sweep
narrows and does not eliminate, the list is kept short on purpose, and the
sweep runs again whenever the list changes.

## Replay

The list is read off the project config the run pinned at launch, like every
other gate field, so a cycle judges against the list that stood when the run
began and a daemon that comes back derives the same plan. Nothing is stored,
and the filter is pure.

## Fallback paths

If an entry proves wrong, the project deletes the line. The next cycle
attributes that path again, the cycle goes blind on it as it did before, and
every part runs. Trigger: one defect that reached the default branch through a
suite the entry let a cycle skip. Reversal cost: none, one config line.

If the field proves unhelpful for a project altogether, the project leaves it
absent and every path is attributed exactly as it was before this decision. The
code stays and goes inert on the empty list.

If a project needs the wider retreat, `gates.partTargeting: false` still returns
every layer to a whole re-run per cycle, and this filter then decides nothing at
all.
