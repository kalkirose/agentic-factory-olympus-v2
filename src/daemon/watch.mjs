// The shape every in-daemon poll takes.
//
// Two observers run on a clock of their own: the watched-workflow reader
// (ADR-0035) and the deferred-proof settler (ADR-0069). Neither holds a run,
// neither classifies anything, and both need the same four properties — one
// poll at a time, a tick that arrives mid-poll dropped rather than queued, a
// first poll at the start because that is what covers a restart, and a stop
// that waits for the poll in flight. Written twice, those four drift; written
// here, a watcher states its own `poll` and nothing else.
export class PollWatcher {
  /** @param {{intervalMs: number}} opts */
  constructor({ intervalMs }) {
    this.intervalMs = intervalMs;
    this.timer = null;
    this.stopped = false;
    this.chain = Promise.resolve();
  }

  /**
   * Arms the poll and takes the first one now. The immediate poll is what
   * covers a restart: what landed while the daemon was down is read at the
   * start rather than one period later.
   */
  start() {
    this.queuePoll();
    this.timer = setInterval(() => this.queuePoll(), this.intervalMs);
    // An observer never holds the process open on its own.
    this.timer.unref?.();
  }

  /** One poll at a time; a tick that arrives mid-poll is dropped, not queued. */
  queuePoll() {
    if (this.stopped) return;
    const next = this.chain.then(() => (this.stopped ? undefined : this.poll())).catch(() => {});
    this.chain = next;
    return next;
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    await this.chain;
  }

  /** What this watcher reads. A watcher that states none is a defect. */
  async poll() {
    throw new Error(`${this.constructor.name} states no poll`);
  }
}
