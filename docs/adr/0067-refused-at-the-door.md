# ADR-0067: Bad input is refused at the door

Status: accepted (2026-09-03)

## Decision

Three inputs the harness used to pay for downstream are now checked where they
arrive, by code, before a seat, a gate round or a slot is spent on them.

### A triage report cannot carry a field its cycle forbids

`triageSchema(priorOpen)` in `src/lanes/verdict.mjs` builds the triage report
schema per cycle. A cycle with open prior findings takes the full shape:
`persisting` is required, and the brief lists the open ids verbatim under the
line `"persisting" takes only ids from this list`. A cycle with no prior
finding takes a shape with no `persisting` field at all, and the brief says so:
`This is a first cycle: no prior finding is open, so every red below is a new
finding.` The schema validator in `src/seats/runner.mjs` refuses an unknown key
with one in-session correction, so a seat that sends the field on a first
cycle is corrected before any check reads its report.

Every defect line `triageChecks` produces states the rule beside the entry.
`persisting id F9 is not an open prior finding; "persisting" takes only ids
from the open set, which is [F1, F2].` `the report carries a "persisting"
field, and this cycle has no prior findings; remove the field.` The layer and
depth rules read the same way. The ship stage's CI triage calls the same
`triageStep` and gets the same schema and brief.

### A crash retry and a corrective round are two budgets

`attemptLimit` in `src/lanes/shared.mjs` gives every lane contract loop two
attempts: one corrective round on a deterministic defect in the work product,
then the `seat-failure` park. A retry a human buys at that park is one
invocation when the corrective round already ran. It is two attempts when the
seat crashed instead of answering: a spawn error, a provider outage, a silence
kill, an invalid report past the runner's own correction. The ledger tells the
two apart by the stamp the contract loop leaves before its park, a
`seat-failure` line that carries the defect list. A crash leaves no such stamp.

`boughtRetry` names the other fact: the next invocation is the one a human
bought. Every bought invocation carries the failure evidence in its brief and
replays no stamped report, whatever failed. `seatWithChecks`, the verifier
loop in `src/lanes/review.mjs` and the triage resume in `src/lanes/verdict.mjs`
read both.

### A spec is checked against the tree before a seat judges it

Four rules join `lintSpec` in `src/lanes/speclint.mjs`. The lint already runs
as the spec-birth seat's own check and on every amendment, so a defect costs a
corrective birth round and never a gate round. Nothing here is a stage.

- **Every touched path is in the tree, or marked new.** Each entry of the
  `touched-paths` block resolves to a file or a directory at the spec's base
  sha, or carries the marker `(new)` between the path and the owner:
  `src/new-module.mjs (new) — dev`. A marker on a path the tree already holds
  is a defect too. `parseTouchedBlock` in `src/seats/diffpolicy.mjs` reads the
  marker into `isNew`; `path` never carries it, so the capture gate and the
  freeze see the path they always saw.
- **Every pin on a touched path is declared, or superseded.** For each touched
  path, the test files under `repo.testPaths` that hold the path as a literal
  string are its pins. A pin that the block does not list and no Supersedes
  clause names is a defect: `the spec touches X; the test file Y mentions that
  path, and the spec neither lists Y in the touched-paths block nor names it in
  a Supersedes clause. Declare the pin, or state the supersede.`
- **Every route id resolves under the routes root, or is marked new.** A token
  of the shape `/[param]/...` in the spec names a directory under
  `repo.routesRoot`. A route the work creates is written `` `/[lang=lang]/cart`
  (new)``. The rule runs only when the tree holds the routes root.
- **Every design-system component the spec names exists, or is marked new.**
  The template carries a `Components` section: one list item per component the
  story renders, written `` `Name` `` or `` `Name` (new)``, and `- None.` for a
  story that renders none. A name resolves under `repo.componentsRoot` as
  folder-per-component — a directory of that name holding a file of the same
  name — and a name the tree does not hold and the spec does not mark is a
  defect, as is a marker on a component the tree already holds. The rule reads
  that section and nothing else: a component name in prose is an English word,
  and no rule about the tree can say one true thing about a word.

`repo.routesRoot` and `repo.componentsRoot` are project config keys, validated
in `src/config/project.mjs` by one rule as a plain repo-relative path or
`null`. Their defaults are `apps/storefront/src/routes` and
`apps/storefront/src/lib/components`. A project whose tree has no such
directory gets no rule; a project that sets `null` turns it off by name.

The component file's extension is one of a closed set — `svelte`, `tsx`,
`jsx`, `vue` — so the rule belongs to the folder-per-component shape rather
than to one framework. The shape is what carries the claim: a directory named
for a component, holding the component's own file.

The lane reads the ground once per lint, in `specGround` in
`src/lanes/story.mjs`: every tracked path at the base sha (`treeFiles`), the
files under the test paths that mention each touched path (`filesMentioning`,
both in `src/isolation/tree.mjs`), the routes root, and the component names the
components root holds. The component listing is derived from the same
`treeFiles` answer, so the fourth rule costs no second look. A run with no base
sha reads the worktree's index. A tree git cannot read turns the four rules off
for that lint rather than parking the run on a check that could not look.

The birth template states the marker and the rules to the seat that writes the
block and the section. Two other seats read the section. The spec-gate seat is
told that the lint has already refused a component the tree does not hold, so
it reads the section as ground truth about the component set and judges what
the spec does with it rather than spending a finding on the set itself. Every
suite seat is told that the section names the components the story renders and
that its tests target those and no others, through the story's own test ids and
never through a page-wide locator by element type or role.

The `Components` section is a part of its own for `amendedSections`, beside the
touched-paths block and the environment section, so a re-check reads it when it
moves and skips it when it does not.

### A ticket that names forbidden ground is refused at launch

`launchRun` in `src/daemon/daemon.mjs` reads a repair ticket before it
provisions anything: an absolute path from the daemon home, a repo-relative
path from the default branch of the clone. It parses the ticket's
`touched-paths` block and judges every entry against the repair lane's
`deniedPaths` and `forbiddenPatterns` with the same `diffPolicyViolations` the
capture gate uses. The `declaredPaths` tier does not apply, because the block
is the declaration. One offending entry refuses the launch, and the reason
names every offending entry and its rule. A ticket with no block is accepted.
A ticket the clone cannot read is accepted too; the lane parks
`ticket-missing` with the path, and that park is where a wrong path is
answered.

The refusal is visible. `stampRejectedLaunch` carries the ticket path, and the
frontier stamps the same `launch-rejected` in each of its three catches (story,
repair, reconciliation) with `requestedBy: frontier`, so a refused
harness-authored launch reads the same as a refused console one.
`olympusctl status` prints a `REJECTED` section with the last five refusals,
newest first, each with its project, lane, card or ticket, requester and
reason.

## What this is for

Five defects on one day were answered with a retry, a hint or a note. Four
had a class: input the harness could have refused or corrected where it
arrived, paid for later.

A triage seat produced a report the checks refused three times. The schema
demanded a `persisting` list on every cycle, and the brief mentioned prior
findings only when some existed. On a first cycle the seat had a mandatory
field and nothing to put in it, so it invented entries, and the rejection named
the entry and not the rule. The schema now has no such field on a first cycle,
and every rule is stated where it is broken.

The same seat had crashed before it wrote anything. The retry the operator
bought then counted as its corrective round, so the first report defect after
the crash parked the run at once. A seat that never answered spent no
corrective round, and the budget now says so.

A spec spent four gate rounds on faults a script can see: a touched path the
tree did not hold, a pin that counted files the spec would move, a route id
that named no directory, a selector on an input the design system had no
component for. Each round cost a seat and found the next fault. The four rules
find all of them on the birth seat's own check, in one round.

A repair ticket named a path the lane forbids, and nobody said so until a
review seat read it two hours later. The daemon already had the ticket path;
it now reads the block.

## Why not the alternatives

A hint in the retry fixes one seat once and leaves the shape that produced the
mistake. A new pre-check stage before the spec gate would change every stage
reader, replay, resume, the hold boundaries and the e2e milestones; the
existing lint runs at the same moment for free. Reading the ticket only at the
repair stage spends a slot, a workspace and a seat on a launch the daemon could
refuse from the control file.

The pin rule reads literal mentions. A test that builds a path from parts is
invisible to it, and the gate still catches those. The route rule depends on a
route id shape; a project whose specs name no routes sets `repo.routesRoot` to
`null` and gets no rule. The `(new)` marker is one more thing a spec author
writes, and the lint says exactly when it is missing.

The component rule reads one section rather than the whole document, which is
the price of a name that is also an English word. A spec that names a component
in prose and leaves the section empty gets no rule, and that is the trade: a
rule that read prose would refuse a spec for using the word Button. The section
earns its place twice over anyway, because the suite seat reads it as the set
of surfaces the story owns.

## Fallback path

If the per-cycle triage schema proves wrong, `triageSchema` returns
`TRIAGE_SCHEMA` for every cycle and the first-cycle brief lines go. Trigger:
first-cycle reports that need to say a red persists from something. Reversal
cost: one function and two brief lines; the checks already tolerate an absent
field.

If the two-budget reading of a bought retry proves wrong, `attemptLimit`
returns 1 for every bought retry, as it did before. Trigger: crash retries that
loop through corrective rounds without converging. Reversal cost: one branch;
`boughtRetry` stays, because the brief and the replay guard read it.

If a lint rule refuses specs it should pass, the rule comes out of `lintSpec`
and the `ground` field that feeds it stops being read. Each rule stands on its
own part of the ground: `files` for the tree rule, `pins` for the pin rule,
`routesRoot` for the route rule, `components` and `componentsRoot` for the
component rule. A project can turn either of the last two off today with
`repo.routesRoot: null` or `repo.componentsRoot: null`. Trigger: a corrective
birth round spent on a true statement about the tree. Reversal cost: one rule
block per rule, no change to the template the seat is told.

If folder-per-component is the wrong shape for a project's design system, the
resolution in `componentIndex` changes and nothing else does: the section, the
template line, the config key and the two role texts are all about the name,
not about where the file sits. Trigger: a design system that holds a component
in one file beside its siblings rather than in a directory of its own.
Reversal cost: one regular expression, and the extension set beside it.

If the launch check refuses a ticket it should launch, `launchRun` skips
`refuseForbiddenTicket` and the ticket reaches the repair stage as before,
where the capture gate still judges the diff and the review seat still reads
the ticket. Trigger: a ticket block the lane may legitimately name, which
would mean the diff policy itself is wrong for that lane. Reversal cost: one
call; the `launch-rejected` stamp, its `ticket` field and the status section
stay, because refusals for every other reason still use them.
