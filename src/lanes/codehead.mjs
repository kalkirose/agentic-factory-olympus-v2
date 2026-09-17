// The tree the run holds, defined once (ADR-0093).
//
// Four readers ask one question: has the tree the run holds been judged? The
// admission gate asks it before it opens a request, the verdict stage asks it
// to decide whether a cycle is owed, the suite restore asks it to know which
// tree its frozen paths belong to, and the update stage asks it under the ship
// token. Each of them can answer from a set of stamps of its own. Two readers
// that disagree are not one wrong answer in one place: they are a run that
// enters two stages in turn, each passing it on because the other has it, with
// nothing stamped between and nobody but a person to stop it.
//
// So the code head is one list here, and every reader takes it from this
// module. A stamp on the list declares two things about itself: whether it put
// a different tree under the run, which is what buys a verdict cycle, and
// which sha the tree stands at after it.
//
// The record commits are deliberately outside the list. The reconcile stage
// commits its records after the verdict's final green, so a head that followed
// them would stand at a sha no green render names and every ship would buy a
// verdict cycle over a tree the code never changed (ADR-0075). They are named
// heads all the same, which is a different question and the second one this
// module answers.

/** The word a re-freeze written inside a merge round carries. */
export const MERGE_ROUND = 'merge-round';

/** One sha, or null for anything that is not one. */
function shaOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Whether one `pre-verdict-update` stamp put a different tree under the run.
 *
 * Two forms say so. `ran: true` is the merge the stage made and recorded. An
 * unnamed head is a tree the stage found under itself that no stamp of the
 * ledger names: the merge that built it was made and never recorded, so the
 * stamp that says so is the first record of that tree and it moves the head to
 * it.
 */
function updateMoved(e) {
  return e.ran === true || e.unnamedHead === true;
}

/**
 * The stamps that move the code head, each with the two readings a stage takes
 * of one: `moved(e)`, whether the tree under the run changed, and `sha(e)`,
 * the head it stands at afterwards or null.
 *
 * Three stamps, and the reason there is no fourth is the route. The verdict
 * renders at the worktree head. Every route back to the verdict from the ship
 * path carries a red render or a new implementation commit. A `fresh-pass`
 * reset and a `freeze` are each followed by an `implementation-committed`
 * before any stage decides anything. `operational-fix` commits nothing: it
 * moves the verdict's reading and names no sha, which is why the verdict keeps
 * it beside this list rather than in it.
 *
 * `branch-update` is not on the list, in either of its two writers. The
 * pre-freeze one is always followed by an implementation commit. The ship-stage
 * one lands under an open request, where the forge's checks certify the tree
 * (ADR-0033), and the verdict does not read that stamp as moved: reading its
 * sha as the head would send such a run through a full local cycle the forge
 * already ran. A merge round's re-freeze inside the ship stage is the same tree
 * under the same request and is excluded for the same reason.
 */
export const CODE_HEAD_STAMPS = new Map([
  [
    'implementation-committed',
    {
      moved: () => true,
      sha: (e) => shaOf(e.sha),
    },
  ],
  [
    're-freeze',
    {
      moved: () => true,
      // A merge round's re-freeze commits the merged suite in the middle of a
      // merge the stage has not finished recording. The stamp that says who
      // holds that tree comes after it: the update stage's own
      // `pre-verdict-update` with the same sha, or the `branch-update` under an
      // open request. Reading the re-freeze as the head would name the tree
      // before the record of what stands behind it.
      sha: (e) => (e.source === MERGE_ROUND ? null : shaOf(e.sha)),
    },
  ],
  [
    'pre-verdict-update',
    {
      moved: updateMoved,
      sha: (e) => (updateMoved(e) ? shaOf(e.toSha) : null),
    },
  ],
]);

/**
 * The sha of the tree the run holds, read from its ledger, or null where the
 * run has committed nothing yet.
 * @param {object[]} events the run's ledger, in order
 */
export function codeHead(events) {
  let head = null;
  for (const e of events) {
    const stamp = CODE_HEAD_STAMPS.get(e.event);
    if (stamp === undefined) continue;
    const sha = stamp.sha(e);
    if (sha !== null) head = sha;
  }
  return head;
}

/**
 * Whether one `fast-path-ship` stamp carried the code certification onto the
 * tree its merge built.
 *
 * The check answers the code question and the record question apart, so a
 * stamp refused for a record reason can still hold a code answer of `kept`,
 * and that answer is the check's own certification of the merged tree: it was
 * reached by the ground comparison and by nothing weaker (ADR-0056). A taken
 * stamp is the same carry with both answers standing.
 *
 * Every reader of a carried ship takes this predicate. A carry the close mark,
 * the escape attribution and the trade counter could not see would be a ship
 * that skipped a certifying pass and said so nowhere.
 */
export function carriedFastPath(e) {
  if (e?.event !== 'fast-path-ship') return false;
  return e.taken === true || e.code?.answer === 'kept';
}

/**
 * Every sha this run's ledger names as a tree some judgment, some carry or some
 * record commit stands behind.
 *
 * The update stage asks one question of it: is the worktree head under me a
 * tree this ledger can name? A head in this set is a tree the run recorded
 * holding. A head outside it is a tree a merge built and a crash left before
 * the stamp that would have recorded it, and that is exactly the tree that must
 * not reach a request on an older green.
 *
 * What qualifies is narrow on purpose. The code head, because a judgment stands
 * at it. A `branch-update`, because the forge certifies the tree under an open
 * request. A carried `fast-path-ship`, because the check itself certified the
 * merged tree. Every record commit, because the reconcile stage moves the
 * worktree after the final green and each of its writes says which sha it left:
 * the cycle's own starting head on `reconcile-rendered`, the round's commit on
 * `record-written`, the write's commit on `reconciliation-written`, and the
 * birth's commit on `records-committed`. And a `tree-refreshed` that moved,
 * because the run was put back on a branch head by hand; one that moved nothing
 * names a sha the tree never took.
 *
 * Five stamps carry a sha and are refused by name, each for one reason: each
 * names a tree the run holds that nothing has yet judged. `merge-round.sha` and
 * a merge-round `re-freeze.sha` are written inside the merge, before the stamp
 * that records it. `suite-committed.sha` is the same commit under its other
 * name. A `fast-path-ship` that carried nothing refused the tree it names.
 * `fresh-pass.sha` is a tree reset and not yet implemented. A head named by one
 * of those alone is the tree a crash left unjudged.
 * @param {object[]} events the run's ledger, in order
 * @returns {Set<string>}
 */
export function namedHeads(events) {
  const named = new Set();
  const add = (value) => {
    const sha = shaOf(value);
    if (sha !== null) named.add(sha);
  };
  add(codeHead(events));
  for (const e of events) {
    switch (e.event) {
      case 'branch-update':
        add(e.toSha);
        break;
      case 'fast-path-ship':
        if (carriedFastPath(e)) add(e.toSha);
        break;
      case 'reconcile-rendered':
      case 'record-written':
      case 'reconciliation-written':
      case 'records-committed':
        add(e.sha);
        break;
      case 'tree-refreshed':
        // The stamp carries the branch head it read whether or not it moved the
        // tree there, and a refresh that stood down left the tree where it was.
        if (e.moved === true) add(e.to);
        break;
      default:
        break;
    }
  }
  return named;
}
