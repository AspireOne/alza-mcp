import type { Provider } from "../domain/contracts.js";
import { fail, failureOf, FailureError } from "./failure.js";
import type { Config } from "./config.js";
import type { Access, Reader } from "./reader.js";
import { Operation, OperationQueue } from "./operation.js";
import { SessionBrowser } from "./session-browser.js";
import { solverReader } from "./solver.js";
import { StateStore } from "./state.js";
import { log } from "./logger.js";

const RECOVERABLE = new Set(["CHALLENGE_UNRESOLVED", "NETWORK_ERROR", "TIMEOUT", "BROWSER_UNAVAILABLE", "RECOVERY_PROVIDER_UNAVAILABLE", "RECOVERY_UNSUPPORTED"]);
export class AccessCoordinator implements Access {
  readonly browser: SessionBrowser;
  private readonly queue = new OperationQueue();
  private readonly cooldowns = new Map<string, number>();
  private lastFailure: ReturnType<typeof failureOf> | null = null;
  private closed = false;
  private readonly active = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  constructor(readonly config: Config, readonly store: StateStore) { this.browser = new SessionBrowser(config, store); }
  run<T>(op: Operation, work: (reader: Reader) => Promise<T>, expectedContext?: string): Promise<T> {
    const pending = this.execute(op, work, expectedContext);
    this.active.add(pending);
    void pending.finally(() => this.active.delete(pending)).catch(() => {});
    return pending;
  }
  private async execute<T>(op: Operation, work: (reader: Reader) => Promise<T>, expectedContext?: string): Promise<T> {
    if (this.closed) fail("BROWSER_UNAVAILABLE", "The server is shutting down.");
    await this.store.open();
    if (op.auth === "required" && !this.store.account) fail("AUTH_NOT_CONFIGURED", "Import an Alza account session before using auth=required.");
    const initial = op.auth !== "anonymous" && this.store.account ? "account" : "anonymous";
    return this.queue.run(op, async () => {
      let kind: "account" | "anonymous" = initial;
      const initialContext = kind === "account" ? `account:${this.store.account!.generation}` : "anonymous";
      if (expectedContext && initialContext !== expectedContext) fail("CONTEXT_CHANGED", "The account context changed. Start a new traversal.");
      const cooldown = this.cooldowns.get(initialContext) ?? 0;
      if (cooldown > Date.now()) fail("CHALLENGE_UNRESOLVED", "Automatic recovery is cooling down after an unsuccessful attempt.", { retryable: true, retry_after_ms: cooldown - Date.now() });
      let last: unknown;
      const providers: Provider[] = ["browser", "flaresolverr", "byparr"];
      for (const provider of providers) {
        op.check();
        if (provider === "byparr" && kind === "account") {
          if (op.auth === "required") { op.meta.attempts.push({ provider, outcome: "skipped", code: "RECOVERY_UNSUPPORTED", duration_ms: 0 }); continue; }
          if (expectedContext) fail("CONTEXT_CHANGED", "Recovery would change account pricing. Start a new traversal.");
          kind = "anonymous";
          op.meta.warnings.push({ code: "ANONYMOUS_FALLBACK", message: "The account browser failed; recovery is using public prices." });
        }
        const endpoint = provider === "flaresolverr" ? this.config.flareUrl : this.config.byparrUrl;
        if (provider !== "browser" && !endpoint) { op.meta.attempts.push({ provider, outcome: "skipped", code: "RECOVERY_PROVIDER_UNAVAILABLE", duration_ms: 0 }); continue; }
        const budget = provider === "browser" ? this.config.primaryMs : provider === "flaresolverr" ? this.config.flareMs : this.config.byparrMs;
        const started = Date.now(), deadline = Math.min(op.deadline - 2000, started + budget);
        let resource: { reader: Reader; dispose: () => Promise<void> } | undefined;
        try {
          if (provider === "browser") {
            try { resource = await this.browser.reader(op, kind, deadline); }
            catch (error) {
              if (failureOf(error).code !== "AUTH_REQUIRED" || op.auth !== "preferred") throw error;
              op.meta.attempts.push({ provider, outcome: "failed", code: "AUTH_REQUIRED", duration_ms: Date.now() - started });
              if (expectedContext) fail("CONTEXT_CHANGED", "The account session expired. Start a new traversal.");
              kind = "anonymous";
              op.meta.warnings.push({ code: "AUTH_REQUIRED", message: "The configured account session expired. Public prices are being used." });
              resource = await this.browser.reader(op, kind, deadline);
            }
          } else {
            const account = kind === "account" ? this.store.account : undefined;
            const storage = account ? await this.store.importedStorage() : undefined;
            const cookies = storage?.cookies.map(({ expires, ...cookie }) => ({ ...cookie, ...(expires > 0 ? { expiry: Math.floor(expires) } : {}) }));
            resource = await solverReader(provider, endpoint!, op, deadline, account, cookies);
          }
          if (expectedContext && resource.reader.context !== expectedContext) fail("CONTEXT_CHANGED", "Recovery changed the traversal context.");
          op.meta.provider = provider;
          const result = await work(resource.reader);
          op.check();
          op.meta.attempts.push({ provider, outcome: "success", duration_ms: Date.now() - started });
          op.meta.sources = [...new Set(op.meta.sources)];
          this.lastFailure = null;
          log.info("access.success", { request_id: op.id, provider, duration_ms: Date.now() - started });
          return result;
        } catch (error) {
          last = error;
          const failure = failureOf(error, provider);
          this.lastFailure = failure;
          op.meta.attempts.push({ provider, outcome: "failed", code: failure.code, duration_ms: Date.now() - started });
          log.warn("access.failed", { request_id: op.id, provider, code: failure.code });
          if (!RECOVERABLE.has(failure.code)) throw error;
        } finally { await resource?.dispose(); }
      }
      const failure = failureOf(last);
      if (op.meta.attempts.some(a => a.code === "CHALLENGE_UNRESOLVED")) {
        this.cooldowns.set(initialContext, Date.now() + this.config.cooldownMs);
        fail("CHALLENGE_UNRESOLVED", "All eligible automatic recovery options failed.", { retryable: true, retry_after_ms: this.config.cooldownMs });
      }
      throw new FailureError(failure);
    });
  }
  status(): unknown { return { browser: this.browser.status(), queue_size: this.queue.size, account_configured: !!this.store.account, last_failure: this.lastFailure, cooldown_until: Math.max(0, ...this.cooldowns.values()), recovery: { flaresolverr: this.config.flareUrl ? "configured" : "disabled", byparr: this.config.byparrUrl ? "configured" : "disabled" } }; }
  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => { await Promise.allSettled([...this.active]); await this.browser.close(); await this.store.close(); })();
    return this.closing;
  }
}
