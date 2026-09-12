# ADR-0089: A brief names the active records, and no seat lists the record tree

Status: accepted (2026-09-12)

## Context

A decision record's status is a line inside the file. It is not in the file's
name, and it is not in the directory listing. A record that has been replaced or
retired reads, from the outside, exactly like a record that governs the code
being written.

Every seat that writes or judges code was handed the record directory and told to
find what governs its area. So each one listed the directory, opened records by
their titles, read a closed one, followed its replacement line to the record that
replaced it, and read that too. The cost is paid per seat and per spawn, it is
invisible in the ledger, and it is worst on exactly the projects whose record tree
is worth reading: the longer a project keeps records, the larger the share of them
that is closed.

The harness already knew the answer. It computes an active-only neighbourhood for
the seats that write records, from the same tree, and it gave that answer to
nobody else.

## Decision

**A seat's brief names the active records, and no brief names the record tree as a
directory to list.**

- **One function builds the block.** `governingRecordLines(worktree, paths,
  recordPaths, {exclude})` in `src/lanes/units.mjs` stands on the neighbourhood
  and active-record readers that already exist. No second reader of a record
  enters the harness.
- **Two blocks and one sentence.** First, the active records that govern the paths
  this seat works on, one path per line; where the neighbourhood cap dropped any,
  one line states how many more there are and under which directory. Then every
  other active record, one path per line, with the line that says to open one only
  where the work reaches its area. Then the rule: a record in that directory named
  in neither list is closed, its status line says so, and it is out of the seat's
  scope; a record is written by a record seat, and the reconciliation stage owns
  every change to one.
- **The paths are the seat's own work.** The dev, fix and suite seats take the
  spec's `touched-paths`; the repair seat takes the ticket's; a spec birth takes
  the card, so its first block is empty and the active list is the whole brief; a
  review seat takes the files of the diff it judges.
- **A seat that already carries a neighbourhood passes it as an exclusion.** The
  record birth, the record review and the reconcile judge keep the list they
  carry as the first block and gain the second, with no path named twice. Without
  those three the rule would be false for them: the sentence would tell a seat
  that a record it was not given is closed, and the reconcile judge would be told
  to open nothing at all. The judge's instruction to locate the record tree goes,
  because there is nothing left for it to locate.
- **A project with no record tree sees no block**, exactly as before.
- **The policy text says the same thing.** The constitution's own record rule
  stops telling a seat to list the directory and starts telling it to read the
  first list before it touches the area, and to leave a record named in neither
  list alone. A seat learns policy from that text, so a brief that names the
  records while the policy says to list the tree teaches two rules.
- **The write flow is untouched.** A seat that supersedes a record reads it while
  its status is still accepted, and after the write it is closed and no later
  brief names it. A record born before the freeze is accepted in the worktree and
  is named at the implementation spawn. The lifecycle rule and the supersession
  line are the project's, and neither moves.
- **Nothing is stamped.** A brief is built at the spawn. There is no new event, no
  schema field, no rebuild and no reader outside the brief.

## Consequences

Every brief build reads each record file once. The record birth already paid that
read, and a seat spawn pays it too. The paths inline are of the order of a few
thousand tokens beside a brief that already carries the project's whole
constitution, and they replace an unbounded number of file reads the seat was
making inside its own session.

A closed record is named in no brief, so a seat that wants the history of a
decision has to be told to look for it. That is the right default: the history of
a decision is the reconciliation stage's subject, not the implementation's.

The cap on the governing list still drops paths on a wide spec. The count is
stated, so a seat knows the list is not the whole set, and the second block names
every other active record anyway.

## Rejected options

- **Tell the seat to read the status line before it reads the record.** That is
  the instruction that was already there in effect, and it costs the open of every
  record to answer. The harness can answer it once for every seat.
- **Put the status in the file name.** Then a supersession renames a file, every
  reference to it by path breaks, and the git history of a record splits at the
  rename.
- **Give the seats the neighbourhood alone, with no second block.** A seat whose
  work reaches an area the neighbourhood did not compute would then have no way to
  find the record that governs it, and the sentence about a closed record would be
  false for every record the cap dropped.
- **Compute the list in the constitution's own words and leave the brief as it
  was.** A policy file cannot name the records that govern one seat's paths: it
  does not know them.

## Fallback path

The alternative is the directory name again: the brief names the record tree, and
the seat lists it and reads what it finds. The switch trigger is a brief whose
record block grows past what a seat reads reliably, measured as a fall in what the
seats do with the records they are given. The reversal cost is one call per brief,
and the readers behind it stay for the record seats that already use them.

## References

- ADR-0018, ADR-0026, ADR-0074, ADR-0075, ADR-0080
- `src/lanes/units.mjs`
- `src/lanes/verdict.mjs`
- `src/lanes/story.mjs`
- `src/lanes/review.mjs`
- `src/lanes/records.mjs`
- `src/lanes/reconcile.mjs`
