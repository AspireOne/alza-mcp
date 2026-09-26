import { randomUUID } from "node:crypto";
import type { AuthMode, Metadata } from "../domain/contracts.js";
import { fail, FailureError } from "./failure.js";

export class Operation {
  readonly id = randomUUID();
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly meta: Metadata;
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  constructor(readonly auth: AuthMode, timeoutMs: number, parent?: AbortSignal) {
    this.deadline = Date.now() + timeoutMs;
    this.signal = parent ? AbortSignal.any([parent, this.controller.signal]) : this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(new FailureError({ code: "TIMEOUT", message: "The operation deadline was reached.", retryable: true })), timeoutMs);
    this.timer.unref();
    this.meta = { request_id: this.id, fetched_at: new Date().toISOString(), sources: [], provider: "browser", auth: { requested: auth, state: "unverified" }, cache: { hit: false, age_ms: 0 }, warnings: [], attempts: [] };
  }
  remaining(max = Infinity): number { this.check(); return Math.max(1, Math.min(max, this.deadline - Date.now())); }
  check(): void {
    if (this.signal.aborted) {
      if (this.signal.reason instanceof FailureError) throw this.signal.reason;
      fail("CANCELLED", "The client cancelled this operation.");
    }
    if (Date.now() >= this.deadline) fail("TIMEOUT", "The operation deadline was reached.", { retryable: true });
  }
  dispose(): void { clearTimeout(this.timer); }
}

/** A single owner prevents browser navigation and account contexts from interleaving. */
export class OperationQueue {
  private running = false;
  private readonly waiting: Array<() => void> = [];
  async run<T>(op: Operation, work: () => Promise<T>): Promise<T> {
    op.check();
    if (this.running) {
      if (this.waiting.length >= 8) fail("BUSY", "The browser queue is full.", { retryable: true, retry_after_ms: 5000 });
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout;
        const cleanup = () => { clearTimeout(timer); op.signal.removeEventListener("abort", abort); };
        const remove = () => { const i = this.waiting.indexOf(ready); if (i >= 0) this.waiting.splice(i, 1); cleanup(); };
        const abort = () => { remove(); try { op.check(); } catch (error) { reject(error); } };
        const ready = () => { cleanup(); resolve(); };
        timer = setTimeout(() => { remove(); reject(new FailureError({ code: "BUSY", message: "The browser is busy. Retry this operation.", retryable: true, retry_after_ms: 5000 })); }, Math.min(5000, op.remaining()));
        op.signal.addEventListener("abort", abort, { once: true });
        this.waiting.push(ready);
      });
    } else this.running = true;
    try { op.check(); return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.running = false;
    }
  }
  get size(): number { return this.waiting.length + Number(this.running); }
}
