// Global per-model concurrency semaphores across all runs. A seat waits on
// the semaphore; it never fails on it. Stamps go to the acquiring seat's own
// store: `semaphore-wait` when the seat must wait, `semaphore-granted` at
// every grant under a cap. A model without a configured limit has no
// semaphore — no wait, no stamps.
const ACTOR = 'daemon';

export class ModelSemaphores {
  /** @param {Record<string, number>} limits model id → max concurrent seats */
  constructor(limits = {}) {
    this.limits = { ...limits };
    this.held = new Map();
    this.queues = new Map();
  }

  /**
   * Live-edit pickup: replaces the limits and grants waiters a raised or
   * removed cap now allows. A cap added by a live edit applies to grants
   * after the edit; seats granted while the model was uncapped are not
   * counted against the new cap.
   */
  setLimits(limits) {
    this.limits = { ...limits };
    for (const model of [...this.queues.keys()]) this.drain(model);
  }

  /**
   * Acquires one slot for `model`. Resolves to a release function; release
   * is idempotent. Waiters are granted first come, first served.
   * @param {string} model
   * @param {{store: import('../telemetry/stores.mjs').TelemetryStore, seat: string}} opts
   * @returns {Promise<() => void>}
   */
  async acquire(model, { store, seat }) {
    const limit = this.limits[model];
    if (limit === undefined) return () => {};
    const queue = this.queues.get(model);
    if ((this.held.get(model) ?? 0) < limit && (queue?.length ?? 0) === 0) {
      this.held.set(model, (this.held.get(model) ?? 0) + 1);
      store.append('semaphore-granted', { actor: ACTOR, seat, model, waited: false });
      return this.releaser(model);
    }
    const line = store.append('semaphore-wait', {
      actor: ACTOR,
      seat,
      model,
      holders: this.held.get(model) ?? 0,
      queued: queue?.length ?? 0,
    });
    return new Promise((resolve) => {
      const waiters = this.queues.get(model) ?? [];
      waiters.push(() => {
        store.append('semaphore-granted', {
          actor: ACTOR,
          seat,
          model,
          waited: true,
          waitSeq: line.seq,
        });
        resolve(this.releaser(model));
      });
      this.queues.set(model, waiters);
    });
  }

  releaser(model) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held.set(model, (this.held.get(model) ?? 1) - 1);
      this.drain(model);
    };
  }

  drain(model) {
    const waiters = this.queues.get(model);
    if (!waiters) return;
    while (waiters.length > 0) {
      const limit = this.limits[model];
      if (limit !== undefined && (this.held.get(model) ?? 0) >= limit) break;
      this.held.set(model, (this.held.get(model) ?? 0) + 1);
      waiters.shift()();
    }
    if (waiters.length === 0) this.queues.delete(model);
  }
}
