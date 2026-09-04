// The settle run: the proof a ship went out without, paid back.
//
// A service that stays down past the external wait raises a gate, and a
// project whose owner turned `gates.proofDebt` on may answer it `defer-proof`:
// the red parts ride the verdict as deferred, the ship goes on, and the
// harness owes a proof (ADR-0069). This is where the debt is settled. The
// daemon keeps asking the credential's own probe; when it passes, it runs
// exactly the deferred parts against the default branch in a workspace of its
// own, and stamps what came of it.
//
// Nothing here holds a run. The run that made the trade closed hours or days
// before, so the records land on the instance ledger and, on a red, on the
// escapes ledger against the ship that carried the debt. That escape is the
// whole measurement of the trade: a `deferred-proof` escape is what the
// owner's speed-over-residual-safety flag actually cost.
//
// The ledger is the only state. Which debts are open is derived from the run
// ledgers and the instance ledger at every poll, so a restart re-derives the
// same set and settles nothing twice.
import { listRunEvents } from '../telemetry/readers.mjs';
import { readEvents } from '../ledger/ledger.mjs';
import { openEscapesStore } from '../telemetry/stores.mjs';
import { recordEscape } from '../telemetry/escapes.mjs';
import { assertDefectKind } from '../ledger/registry.mjs';
import { PollWatcher } from '../daemon/watch.mjs';

const ACTOR = 'proof-debt';
const GIST_MAX = 120;

/** How often a debt asks the service whether it can be settled: ten minutes. */
export const SETTLE_POLL_MS = 10 * 60 * 1000;

/**
 * Every proof this instance owes: a `proof-deferred` in a run ledger with no
 * `proof-settled` for it on the instance ledger.
 *
 * The pair is keyed on the run and the stamp's own seq, so two debts of one
 * run are two debts and a settled one never comes back.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @returns {Array<{project: string, runId: string, seq: number,
 *   credential: string, host: string|null, parts: Array<object>,
 *   pr: number|null, mergeSha: string|null}>}
 */
export function openProofDebts(paths) {
  const settled = new Set();
  for (const e of readEvents(paths.instanceLedger)) {
    if (e.event === 'proof-settled') settled.add(`${e.runId}:${e.deferredSeq}`);
  }
  const debts = [];
  for (const run of listRunEvents(paths)) {
    for (const e of run.events) {
      if (e.event !== 'proof-deferred') continue;
      if (settled.has(`${run.runId}:${e.seq}`)) continue;
      const merged = run.events.filter((line) => line.event === 'merged').at(-1);
      debts.push({
        project: run.project,
        runId: run.runId,
        seq: e.seq,
        credential: e.credential,
        host: e.host ?? null,
        parts: e.parts ?? [],
        pr: merged?.pr ?? null,
        // The merge commit, and the request head only where no merge named
        // one: the ship stamps both, and the commit that carried the defect
        // into the product is the merge.
        mergeSha: merged?.mergeSha ?? merged?.sha ?? null,
      });
    }
  }
  return debts;
}

/**
 * The environment one deferred layer's command is asked with: the parts that
 * were never proven, and the files each of them named. The same protocol a
 * narrowed re-run uses, so the command narrows exactly as it would inside a
 * run (ADR-0065). A part that named no file runs whole.
 * @param {{parts: string[], byPart?: Record<string, string[]>}} entry
 * @param {{partsEnv: string, filesEnv: string}} names the protocol's variables
 */
export function narrowEnv(entry, { partsEnv, filesEnv }) {
  const parts = entry.parts ?? [];
  if (parts.length === 0) return {};
  const files = Object.entries(entry.byPart ?? {})
    .filter(([part, list]) => parts.includes(part) && (list ?? []).length > 0)
    .map(([part, list]) => `${part}=${list.join(',')}`)
    .join(';');
  return { [partsEnv]: parts.join(','), ...(files.length > 0 && { [filesEnv]: files }) };
}

/**
 * The in-daemon poll behind every open debt. It holds no run, classifies
 * nothing and decides nothing beyond the exit code of the command the project
 * itself wrote.
 */
export class ProofDebtWatcher extends PollWatcher {
  /**
   * @param {{ledger: object, paths: object,
   *   probe: (debt: object) => Promise<boolean>,
   *   settle: (debt: object) => Promise<{ok: boolean, detail?: string}>,
   *   declared?: () => boolean, intervalMs?: number}} opts
   *   probe answers whether the service is back; settle runs the deferred
   *   parts against the default branch. Both are the daemon's, because both
   *   need the project's config and a workspace. `declared` says whether any
   *   project this instance has launched arms the trade at all.
   */
  constructor({ ledger, paths, probe, settle, declared, intervalMs = SETTLE_POLL_MS }) {
    super({ intervalMs });
    this.ledger = ledger;
    this.paths = paths;
    this.probe = probe ?? (async () => false);
    this.settle = settle ?? (async () => ({ ok: false, detail: 'no settle route' }));
    this.declared = declared ?? (() => false);
    // One scan at the start, because a debt recorded before a restart is a
    // debt this instance owes. After that the scan is bought by evidence.
    this.scanned = false;
    this.owed = false;
  }

  async poll() {
    // A debt exists only where an owner armed the trade, and most instances
    // never do. The scan reads every run ledger this home holds, live and
    // archived, so it runs at the start and then only while something says a
    // debt could be there: one is open, or a project has launched under the
    // flag (ADR-0069).
    if (this.scanned && !this.owed && !this.declared()) return;
    this.scanned = true;
    const debts = openProofDebts(this.paths);
    this.owed = debts.length > 0;
    for (const debt of debts) {
      if (this.stopped) return;
      let back = false;
      try {
        back = await this.probe(debt);
      } catch {
        back = false;
      }
      // A service still down says nothing. The debt stays open, and the next
      // poll asks again: there is no deadline on a proof nobody can run.
      if (!back) continue;
      let result;
      try {
        result = await this.settle(debt);
      } catch (error) {
        result = { ok: false, detail: error?.message ?? String(error) };
      }
      this.record(debt, result);
      this.owed = openProofDebts(this.paths).length > 0;
    }
  }

  /**
   * What came of one settle run. A green closes the debt and says so. A red
   * closes it too — the proof was run, and it failed — and records the escape
   * against the ship that carried the debt, because that merge is what put the
   * defect in the product.
   */
  record(debt, result) {
    let escape = null;
    if (!result.ok) {
      const store = openEscapesStore(this.paths);
      try {
        escape = recordEscape(store, {
          actor: ACTOR,
          // A defect that reached the default branch, counted like every other
          // one: the trade the flag bought was speed against residual safety,
          // and this is the residual arriving. The `kind` is what separates it
          // from the escapes nobody chose (ADR-0069).
          category: 'product-escape',
          defectLine:
            `a proof deferred at the ${debt.credential} gate failed against the default ` +
            `branch: ${result.detail ?? 'red'}`,
          detectionSource: 'harness-self',
          attribution: 'harness',
          kind: assertDefectKind('deferred-proof'),
          refs: {
            project: debt.project,
            runId: debt.runId,
            credential: debt.credential,
            ...(debt.pr !== null && { pr: debt.pr }),
            ...(debt.mergeSha !== null && { mergeSha: debt.mergeSha }),
          },
        }).seq;
      } finally {
        store.close();
      }
    }
    this.ledger.append('proof-settled', {
      actor: ACTOR,
      project: debt.project,
      runId: debt.runId,
      deferredSeq: debt.seq,
      credential: debt.credential,
      ok: result.ok === true,
      ...(result.detail && { detail: gist(result.detail) }),
      ...(escape !== null && { escape }),
    });
  }
}

function gist(text) {
  return text.length > GIST_MAX ? text.slice(0, GIST_MAX - 1) + '…' : text;
}
