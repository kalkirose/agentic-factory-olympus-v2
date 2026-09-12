# ADR-0088: The first verdict cycle is the footprint of the change, and the certified base carries the rest

Status: accepted (2026-09-12)

## Context

The first cycle of an implementation pass ran every Tier-1 layer of the project.
The reasoning was sound as far as it went: a first cycle has proven nothing of its
own, and a green it did not earn is not a green.

It went one step short. The tree a run starts from is the tree the last ship
merged, and that ship's own verdict ran every layer green at that sha. The
default branch is therefore a standing answer for everything except what this run
changed, and what this run changed is knowable: it is the diff from the base to
the candidate, read against the ground each layer declares. The full sweep was
scoping its work by the container, a first cycle, instead of by what the change
touches.

Nothing recorded the standing answer. A verdict record lives in a run directory
and archives with the run, and no reader asked which layers stood green at the sha
the default branch became.

## Decision

**Every ship states what it certified, and the first cycle of a pass runs the
footprint of the run's own diff over that certification.**

- **`base-certified` is stamped on the instance ledger at every ship close-out.**
  It carries the project, the run, the merge sha, and per layer the name, the
  status, the elapsed time, whether the layer ran or carried, and the name of the
  verdict record it came from. A reader resolves that record through the home's own
  archive layout and never through a stored path, because the run directory moves
  when the run closes.
- **A layer is certified at a sha two ways.** The newest certification at that
  sha holds it green, which involves no ground claim at all because the layer
  ran against that tree. Or the newest green certification at an ancestor holds
  it, and the diff between the two shas touches none of the layer's ground: the
  layer's answer follows its ground, and a diff that touched none of it cannot
  have changed the answer. The ancestor question is asked because the default
  branch moves past a merge commit for ordinary reasons such as a card sweep or
  a config change, so a base that is not itself a merge sha is the common case
  rather than the exception. The branch is linear, so the ancestry is one diff.
- **Doubt runs the layer, three ways.** A certification at the sha that holds the
  layer red outranks any claim about an older tree. A layer with no declared ground
  has claimed nothing, so only a certification at the sha itself answers for it.
  Only the newest green certification is tried, because walking every certification
  a project ever stamped costs one diff each and a refusal costs one layer run the
  cycle was going to spend anyway.
- **Four conditions gate the narrowed sweep, and each failure buys the whole
  spectrum with a word.** A project that declares no setup layer has not said which
  layers produce the tree the others read, and carrying under that silence leaves a
  run with no installed modules and a green it did not earn. A Tier-1 layer with no
  ground in config has claimed nothing, and one such layer refuses for the whole
  cycle because a sweep is one decision about one cycle. A project with no
  certification at all is the ordinary state of one that has never shipped under
  this. A diff git cannot read says nothing about what the run changed.
- **The footprint is three clauses, each failing towards running.** A layer whose
  ground the diff touches runs, and its dependents run with it, because a layer
  judged against a prerequisite the run changed was judged against something else.
  A layer no certification answers for runs. A setup layer runs whatever the diff
  and the certification say, and its dependents are not pulled in with it: a setup
  layer produces a tree that is not in the repository, so no certification earned
  on another host stands in for it, and that is a statement about this host rather
  than about the diff.
- **A changed file no layer's ground claims buys the whole spectrum.** The project
  has not said which layer reads it, so no carry over it rests on anything. The
  ground a project states no suite reads leaves the diff before any of this, because
  that list is the project saying those files reach no layer on purpose.
- **The diff is read from the certified base**, not from the commit the pass
  started on. The suite commit and the records the run wrote before the freeze are
  the run's own work, and a footprint that excluded them would carry a layer over a
  file this run wrote.
- **A carried layer stamps a result of its own.** It states that it carried, which
  base sha and which certification it came from, and the status it copied. It
  carries no duration and no resource reading, because it ran nothing. A resume
  reads the mode and keeps a carried result carried. The standing-green reader
  treats it as green at its own base, so the next cycle targets nothing carried and
  the ship path does not read it as a layer with no green behind it. Nothing owns a
  resource-exhaustion record on a result that ran no process.
- **Blocked outranks carried.** A dependent of a red setup layer is not runnable
  and is never carried: the test for a failed prerequisite runs before the test for
  a standing certification.
- **The declaration at the next ship reads config ground for a carried layer.** A
  carried layer's part table belongs to another run and a part's declared inputs do
  not survive into a verdict record, so the config ground is the only claim the
  carry was ever taken on, and it is the claim the ship path asks about. Each
  carried green names the tree it was earned at.
- **The cycle says which sweep it took.** The rendered verdict carries the sweep,
  and a full sweep carries the reason it fell back, so a project that never
  narrows reads as a project with a missing declaration rather than as a quiet
  default.

## Consequences

Under this, a skip is a claim. Every carried layer rests on a ground declaration
somebody wrote, and a declaration that is wrong carries a layer over a change it
reads. The pull-request checks are the net in front of the merge, and a layer no
check in the forge runs has none. A red check beside a narrowed sweep is a
footprint that lied, and it is read by hand.

The saving is bounded by the project's own ground. A project whose heaviest suites
declare wide ground keeps running them on every cycle, and narrowing those
declarations is a decision for the project rather than for the harness.

The instance ledger gains one record per ship, and the per-layer durations in it
are the history a per-layer time bound would need. Nothing reads them that way
yet.

A run launched against a base the project has never certified takes the full sweep
and says so, which is also what every run of a project that has just adopted this
does.

## Rejected options

- **Read the standing answer from the ship's own fast-path records.** Those say a
  certification was carried over a moved base. The close-out stamp says which
  layers stood green at the sha the default branch actually became, which is the
  question a later run asks.
- **Carry a layer on the run's own earlier cycle.** That is the targeted sweep, and
  it already exists for cycles after the first. The gap was the first cycle, where
  the run has earned nothing and the branch has earned almost everything.
- **Take the narrowed sweep whenever the ground is declared, without a setup
  layer.** A tree with no installed modules passes nothing, and a green carried
  over that state is the worst kind: it names a layer that could not have run.
- **Pull a setup layer's dependents into the cycle with it.** A setup layer is in
  every footprint by declaration, so its dependents would be too, and the narrowed
  sweep would be the full one.
- **Skip a layer instead of stamping a carried result.** Then a resume, the next
  cycle and the ship path each have to infer what happened from an absence, and an
  absence reads the same as a layer nobody planned.

## Fallback path

The alternative is the full spectrum on every first cycle, with the certification
stamp kept for its durations. The switch trigger is a red check on a merge whose
first cycle narrowed, where the layer the check ran was carried. The reversal cost
is one branch in the cycle plan; the stamp, the reader and the carried mode stay,
and the targeted sweep keeps using them.

## References

- ADR-0022, ADR-0033, ADR-0045, ADR-0046, ADR-0056, ADR-0058, ADR-0059, ADR-0075
- `src/lanes/spectrum.mjs`
- `src/lanes/verdict.mjs`
- `src/lanes/ship.mjs`
- `src/ledger/readers.mjs`
- `src/ledger/registry.mjs`
