# ADR-0018: The constitution and the authority stack

Status: accepted (2026-08-14)

## Decision

A project may version a policy file in its own repository. The harness reads
it at seat-prompt assembly, injects it as its own block, and tells every
judging seat where it ranks against the other documents in the run.

- **One file, named in project config.** `constitutionPath` defaults to
  `.olympus/constitution.md` and validates as a repo-relative path, like
  `stack.composeFile` and `graph.cardsDir`. The file is read from the run's
  worktree, so a run is judged against the policy that shipped with the tree
  it holds.
- **An absent file means the feature is off.** A missing file, an unreadable
  file, and an empty file are the same answer: no block, and every seat
  prompt is byte for byte what it was before this decision.
- **A third prompt block.** The shared core comes first, the policy block
  second, the per-seat role block last. The policy block opens with one line
  that names it, then the file text whole between an opening and a closing
  marker. The two existing blocks are unchanged, and no role block was
  restructured to carry policy.
- **A closed seat set.** The set lives beside the seat map and changes only by
  decision: spec birth, the spec gate, the suite seat in every mode, the dev
  and fix seats, the repair-dev seat, every Fury lens, the generalist review,
  the Fury verifier, and verdict triage. The adversary is out, because its
  brief is to write a plausible wrong implementation and policy text only
  dilutes that brief. The card sweep is out, because it edits intent cards
  rather than the tree. The eval seat is instance-scoped and holds no worktree
  to read from.
- **The authority order, for judging seats only.** The nine judging seats
  carry one fixed paragraph after the policy text: the constitution outranks
  the intent card, the card outranks the run's spec, a spec clause that
  contradicts a higher authority has no force, that clause is never enforced
  against the tree, and the clause itself is a blocking finding against the
  spec. The Fury verifier carries two more sentences, because it decides which
  findings block: it confirms a finding only when the spec clause behind it is
  legitimate under this order, and it refutes a finding that enforces an
  illegitimate clause with that reason.
- **The Tier-1 gate commands are stated facts.** The dev seat used to be told
  to run "the gate commands from the project config" without being told what
  they are. The fix seat was told nothing. Both now receive each Tier-1
  layer's name and argv, read from the loaded project config. The vague
  self-check sentence is gone: a named command list is a tool, and a
  "check your work" sentence is the verification scaffolding the prompt module
  bans.

Nothing else changes. Lane control flow, the park machinery, the diff-policy
gate and the candidate capture are untouched.

## Why policy has to be an input, and not a memory

One run produced this decision, and every seat in it behaved reasonably.

The spec seat noticed that a set of platform-specific files was absent from
the repository. It inferred from that absence that the story owed those files,
and it wrote the obligation into the spec. The suite seat encoded the
obligation as tests. The review seats read the tree, found the files still
absent, and confirmed the absence as HIGH defects. The dev seat then created
the files, because the spec said so and every gate agreed.

The project had removed those files on purpose, and had written that decision
down in its own documents. No seat ever read them. Each seat did exactly what
its brief allowed, and the run spent a full cycle building something the
project had decided not to have.

The failure is not in any one seat's judgment. It is that a standing decision
existed in the project and had no path into a seat prompt. A rule nobody is
given is a rule nobody can apply, so the file is now an input, injected the
same way on every run, with no seat left to remember it.

## Why the order is stated and not left implied

Every seat in that run treated the spec as the top authority, and the spec was
the newest and least reviewed document in the run. It is born fresh at launch,
by one seat, in one pass. The intent card is older and has been read by a
human. The constitution is older still and describes the project rather than
one story.

Handing a seat two documents without a rank is handing it a choice, and a
fresh-context seat resolves that choice differently each time. Left implied,
the order also inverts under pressure: the spec is the document the seat was
told to enforce, so the spec wins, which is exactly backwards.

The paragraph also names the remedy, because a seat that finds a bad clause
needs somewhere to put it. Without that, a seat has two bad options: enforce a
clause it can see is wrong, or drop a finding it cannot justify. Routing the
clause back as a blocking finding against the spec makes the conflict visible
in the run, where a spec amendment can settle it.

The verifier gets the extra sentences because it is the last gate a finding
passes. Confirm-to-block means an unconfirmed finding never blocks, so the
verifier is the cheapest place to stop a finding that enforces an illegitimate
clause. Refuting it there costs one verdict, while confirming it costs a
repair round and a tree change.

## Why the gate commands became facts

The asymmetry was old and had no defence. The dev seat was told to run gate
commands it was never given, and the fix seat, judged by the identical gates,
was told nothing at all. A seat that has to guess the command either skips the
check or invents an argv, and both cost a cycle.

Naming the commands is a fact about the run, like the test paths and the spec
path the same block already carries. The header's ban on verification
scaffolding is about instructions to re-read, re-check and re-confirm, which
buy nothing and cost tokens in every seat. A list of runnable commands is not
that, and the sentence it replaces was the scaffolding of the pair.

## Fallback paths

If a constitution grows large enough that injecting it whole is a real cost
across a fan-out, the working seats fall back to the file path alone and only
the judging seats receive the text. Trigger: policy text past a few thousand
tokens, or a measured cost rise on the Fury round. Reversal cost: low, one
branch at the block builder.

If the authority paragraph produces findings against specs that were right,
the paragraph narrows to the constitution alone and drops the card from the
order. Trigger: two runs whose blocking spec findings the owner overturns.
Reversal cost: low, the paragraph is one constant.

If projects need policy that differs per seat, the file gains named sections
and the block builder selects the section for the seat. Trigger: a project
that keeps a constitution the dev seats must not read. Reversal cost: medium,
the file gains a format and the loader gains a parser.

If reading the file per stage proves to be the wrong grain, the text moves to
the launch payload and is fixed for the whole run. Trigger: a run whose policy
changed under it mid-flight and produced two different judgments. Reversal
cost: low, the read moves to launch and the bases carry the payload value.
