# ADR-0076: Read the bytes CI reads

Status: accepted (2026-09-07)

## Context

The harness writes LF line endings alone. It is tested in Linux CI and deployed
to a Linux host. Nothing in it considered the development machine's settings,
and the rule held by luck rather than by rule.

Three facts made that luck. No git call the harness made named a line-ending
setting; `gitArgv` added `core.longPaths` and nothing else. The daemon's project
clones inherited `core.autocrlf=true` from the machine's global git config. A
seat's own git and every gate command a project runs read that clone config. A
seat wrote files into the run worktree with whatever bytes its tools produced.
`commitAll` left the working tree alone after the commit.

The gates of a verdict read the working tree; CI reads the commit. A file a seat
wrote with carriage returns was judged with carriage returns in the run. CI
judged the same file with LF. The project's `.gitattributes` was the one thing that kept the
committed bytes LF. Nothing checked that a project had such a rule.

## Decision

The harness reads the bytes CI reads. Four seams carry the rule, because four
readers exist.

**Every harness git call carries the settings.** `gitArgv` in
`src/isolation/git.mjs` adds `-c core.autocrlf=false -c core.eol=lf` on every
platform, before the win32 `core.longPaths` entry. `gitPlain` keeps its bypass.
It answers with the host's own settings, which is what a check of the host is
for (ADR-0030). It writes no tree of its own.

**Every clone carries the settings.** `ensureBareClone` in
`src/isolation/clones.mjs` writes `core.autocrlf=false` and `core.eol=lf` into
the clone on every call, beside the `remote.origin.fetch` re-pin. A clone made
before this record heals at its next launch. This binds the seat's own git and
every gate command the project runs: both read the clone config, and neither
takes a harness argument. `src/daemon/environment.mjs` states the same class for
`core.longPaths`.

**After a commit, the tree holds the committed bytes.** `commitAll` and
`concludeMerge` in `src/isolation/tree.mjs` read `git ls-files --eol` over the
paths they committed. The read gives the index bytes and the working-tree bytes
of each path. A path where the two differ is replaced with the index bytes, and
a second read is the proof. A `w/crlf` answer after that is a harness fault with
the path named, never a silent pass.

The replacement deletes the file and checks it out. Git will not overwrite a
file its own stat cache calls current. After `git add` that cache holds the
seat's file, so a plain checkout of the path returns and writes nothing. Every
pathspec is literal, because a repository path may hold `[` and `]` and a bare
pathspec is wildmatched. The paths ride in batches, because a Windows command
line has a ceiling and a commit does not. This covers every seat that commits:
dev, repair, record, reconcile-write, suite, and the cards sweep.

A rewrite that moves the bytes and nothing else stages nothing. `status` lists
the path, because the bytes moved. `add` normalises them back to the blob the
index already holds, and `commit` on an empty index exits non-zero. The commit
is therefore asked for only when the index has something in it. The tree is put
right either way.

**A project with no LF rule does not launch.** `refuseUnnormalisedRepo` in
`src/daemon/daemon.mjs` reads `.gitattributes` from the default branch. It
refuses when no line gives the pattern `*` the attribute `eol=lf`. An
unreadable file is a refusal too.

The rule is read the way git reads it. Git applies the last `eol` a path
matches. A file that says `* eol=lf` and then `* eol=crlf` declares CRLF, and
the door refuses it. The pattern must be `*`: a narrower one leaves the rest of the tree
unruled, and the door fails closed on that.

`readBranchFiles` in `src/isolation/clones.mjs` reads the config and the
attributes in one clone pass: one lock, one fetch, two blobs. The credential
gate beside this one reads the same answer, so the refusal costs no fetch of its
own. The refusal is a plain `Error`
with the sentence and `.detail`, as the four door refusals beside it are.
`stampRejectedLaunch` stamps `launch-rejected` with no change. No slot, no
workspace, no ledger (ADR-0067, ADR-0068).

The door refusal is what makes this a rule and not a default. A project without
an LF attribute still commits carriage returns, and no seam below the attribute
can undo that.

## Consequences

A project with no `.gitattributes` LF rule cannot launch until it adds one.
Today that is no project: ceq has the rule. Every fixture repository the suites
build carries it too, in `initOriginRepo` (`test/helpers.mjs`), `fixtureTree`
(`e2e/fixture.mjs`) and `projectTree` (`e2e/cards.e2e.mjs`).

Every commit costs one `ls-files` read over the changed paths. Milliseconds. A
commit whose paths all agree costs nothing more. Only a path that disagrees is
deleted and checked out. A build cache therefore keeps every file the commit
agreed with.

A seat that deliberately writes a binary file with CR bytes is unaffected: the
`-text` and `binary` attributes exempt it, as ceq's own fixtures already do.

The `w/crlf` fault fires on a path whose attributes exempt it from LF while the
harness still expects LF. A project that wants CRLF on a path declares it, and
the fault says so with the path named.

## Rejected options

- An environment variable for the seat processes: the e2e fixture already holds
  `GIT_CONFIG_COUNT` for its URL rewrite, and an environment travels only where
  the harness spawns. The clone config travels with the clone.
- The clone config alone: the harness's own git reads a clone config only inside
  a clone or a worktree of one. A check of the host runs in neither.
- The tree repair alone: a project with no LF attribute commits CRLF blobs, so
  the tree and CI agree on the wrong bytes.
- A warning rather than a door refusal: the owner asked for the loud answer.

## Fallback path

The alternative is the three seams without the door refusal: `launchRun` skips
`refuseUnnormalisedRepo` and a project with no attribute launches with LF
settings alone. The switch trigger is a project the harness must run that cannot
carry an LF attribute. The reversal cost is one call; the `launch-rejected`
stamp and its detail stay, because every other refusal uses them.

If the `w/crlf` fault refuses a commit it should take, `takeIndexBytes` keeps
the repair and drops the second read. The trigger is a project whose attributes
exempt a path from LF on purpose. The reversal cost is one block.

## References

- ADR-0016, ADR-0030, ADR-0067, ADR-0068
- `src/isolation/git.mjs`
- `src/isolation/clones.mjs`
- `src/isolation/tree.mjs`
- `src/daemon/daemon.mjs`
