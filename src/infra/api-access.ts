import { randomUUID } from "node:crypto";
import type { Failure } from "../domain/contracts.js";
import type { Config } from "./config.js";
import { fail, failureOf, FailureError, retryAfterMs, SWITCH_HINT } from "./failure.js";
import { log } from "./logger.js";
import type { Operation } from "./operation.js";
import type { Access, Source } from "./reader.js";
import type { StateStore } from "./state.js";
import { APP_USER_AGENT, ApiSession } from "./api-session.js";
import type { RawResponse, Transport } from "./api-transport.js";

const REQUEST_TIMEOUT_MS = 30_000;
const ANONYMOUS_USER_ID = -1;
// Failures that point at an Alza-side change rather than a transient condition.
const BACKEND_CHANGE_CODES = new Set(["API_BLOCKED", "API_CLIENT_REJECTED", "API_REQUEST_REJECTED", "SCHEMA_CHANGED"]);
export interface ApiSource extends Source {
  readonly provider: "api";
  /** Fetches an app-linked HTML document, such as a product's description page. */
  text(url: string): Promise<string>;
}

/** Maps an app-API response to the shared failure contract. Rejections that suggest an Alza-side change carry the backend switch hint. */
export function classifyApiResponse(response: RawResponse, format: "json" | "text" = "json"): unknown {
  const { status, headers, body } = response;
  if (status === 403) fail("API_BLOCKED", `Alza's bot protection rejected the API backend${headers["cf-mitigated"] === "challenge" || body.includes("var getData") ? " with a challenge" : ""}. ${SWITCH_HINT}`, { upstream_status: 403 });
  if (status === 429) {
    fail("RATE_LIMITED", "Alza rate limited the request.", { retryable: true, retry_after_ms: retryAfterMs(headers["retry-after"]), upstream_status: 429 });
  }
  if (status === 401) fail("AUTH_REQUIRED", "Alza rejected the API session.", { upstream_status: 401 });
  if (status === 400) fail("API_REQUEST_REJECTED", `Alza rejected the API backend's request as invalid. ${SWITCH_HINT}`, { upstream_status: 400 });
  if (status < 200 || status >= 300) fail("UPSTREAM_ERROR", `Alza returned HTTP ${status}.`, { upstream_status: status, retryable: status >= 500 });
  if (format === "text") return body;
  try { return JSON.parse(body); }
  catch { return fail("SCHEMA_CHANGED", `Alza's app API returned a non-JSON response. ${SWITCH_HINT}`); }
}

/** Serves operations from Alza's app API with the stored app session; never falls back to a browser. */
export class ApiAccess implements Access<ApiSource> {
  private readonly active = new Set<Promise<unknown>>();
  private readonly anonymousVisitor = randomUUID();
  private lastFailure: Failure | null = null;
  private closing?: Promise<void>;
  constructor(readonly config: Config, readonly store: StateStore, private readonly transport: Transport, private readonly session: ApiSession | undefined) {}
  run<T>(op: Operation, work: (source: ApiSource) => Promise<T>, expectedContext?: string): Promise<T> {
    if (this.closing) fail("BACKEND_UNAVAILABLE", "The server is shutting down.");
    const pending = this.execute(op, work, expectedContext);
    this.active.add(pending);
    void pending.finally(() => this.active.delete(pending)).catch(() => {});
    return pending;
  }
  private async execute<T>(op: Operation, work: (source: ApiSource) => Promise<T>, expectedContext?: string): Promise<T> {
    if (op.auth === "required" && !this.session) fail("AUTH_NOT_CONFIGURED", "Run `alza-mcp api-session login` before using auth=required.");
    op.meta.provider = "api";
    let account = op.auth !== "anonymous" && !!this.session;
    const started = Date.now();
    try {
      try { return await this.attempt(op, work, account, expectedContext); }
      catch (error) {
        const failure = failureOf(error);
        if (account && (failure.code === "AUTH_REQUIRED" || failure.code === "AUTH_ACCOUNT_MISMATCH")) op.meta.auth.session_issue = { code: failure.code, message: failure.message };
        if (!account || op.auth !== "preferred" || failure.code !== "AUTH_REQUIRED") throw error;
        op.meta.attempts.push({ provider: "api", outcome: "failed", code: failure.code, duration_ms: Date.now() - started });
        log.warn("access.auth_fallback", { request_id: op.id, provider: "api", code: failure.code, profile: "anonymous" });
        if (expectedContext) fail("CONTEXT_CHANGED", "The account session expired. Start a new traversal.");
        op.meta.warnings.push({ code: "AUTH_REQUIRED", message: "The configured API session expired. Public prices are being used." });
        account = false;
        return await this.attempt(op, work, account, expectedContext);
      }
    } catch (error) {
      const failure = failureOf(error, "api");
      this.lastFailure = failure;
      op.meta.attempts.push({ provider: "api", outcome: "failed", code: failure.code, duration_ms: Date.now() - started });
      (BACKEND_CHANGE_CODES.has(failure.code) ? log.error : log.warn)("access.failed", { request_id: op.id, provider: "api", code: failure.code, duration_ms: Date.now() - started });
      throw error;
    }
  }
  private async attempt<T>(op: Operation, work: (source: ApiSource) => Promise<T>, account: boolean, expectedContext?: string): Promise<T> {
    const session = account ? this.session! : undefined;
    const context = session ? `account:${session.generation}` : "anonymous";
    if (expectedContext && context !== expectedContext) fail("CONTEXT_CHANGED", "The account context changed. Start a new traversal.");
    const started = Date.now();
    op.meta.cache = { hit: false, age_ms: 0 };
    op.meta.fetched_at = new Date().toISOString();
    op.meta.auth.state = "unverified";
    let token = session ? await op.step("api.session_token", {}, () => op.waitFor(session.accessToken())) : undefined;
    // Alza can revoke an access token before its expiry; one refresh per operation tells that from an expired grant.
    let renewed = false;
    // An app token is a stateless credential: its own claims establish the account
    // until an envelope proves otherwise, so cache hits need no extra request.
    const verify = async () => { if (op.meta.auth.state === "unverified") op.meta.auth.state = session ? "signed_in" : "anonymous"; };
    const request = (url: string, body: unknown, format: "json" | "text") => op.step("api.request", { provider: "api", path: new URL(url).pathname, method: body === undefined ? "GET" : "POST" }, async () => {
      const send = () => this.transport.request(url, {
        method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), signal: op.signal, timeoutMs: op.remaining(REQUEST_TIMEOUT_MS),
        headers: {
          "user-agent": APP_USER_AGENT, accept: format === "json" ? "application/json" : "text/html", "accept-language": "cs-CZ,cs;q=0.9",
          "balancer-guid": session?.visitorId ?? this.anonymousVisitor, "x-correlation-id": randomUUID(),
          ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      });
      const exchange = async () => {
        let response: RawResponse;
        try { response = await send(); }
        catch (error) {
          op.check();
          if (error instanceof FailureError) throw error;
          op.meta.warnings.push({ code: "NETWORK_RETRY", message: "Retrying one transient API request within the existing deadline." });
          log.warn("api.retry", { request_id: op.id, provider: "api", attempt: 2 });
          try { response = await send(); }
          catch (cause) { op.check(); if (cause instanceof FailureError) throw cause; throw new FailureError({ code: "NETWORK_ERROR", message: "An Alza API request failed twice.", retryable: true }, { cause }); }
        }
        log.info("upstream.response", { request_id: op.id, provider: "api", status: response.status });
        const data = classifyApiResponse(response, format);
        const userId = (data as { user_id?: unknown } | null)?.user_id;
        if (typeof userId === "number") {
          if (session && userId === ANONYMOUS_USER_ID) fail("AUTH_REQUIRED", "Alza answered the API session as an anonymous visitor.");
          if (session ? String(userId) !== session.expectedUserId : userId !== ANONYMOUS_USER_ID) fail("AUTH_ACCOUNT_MISMATCH", "Alza answered for a different account than configured.");
        }
        return data;
      };
      let data: unknown;
      try { data = await exchange(); }
      catch (error) {
        if (!session || renewed || failureOf(error).code !== "AUTH_REQUIRED") throw error;
        renewed = true;
        log.warn("api_session.token_rejected", { request_id: op.id });
        token = await op.waitFor(session.accessToken(token));
        data = await exchange();
      }
      await verify();
      op.meta.sources.push(url);
      return data;
    });
    const source: ApiSource = { provider: "api", context, verify, json: (url, body) => request(url, body, "json"), text: async url => request(url, undefined, "text") as Promise<string> };
    const result = await work(source);
    op.meta.sources = [...new Set(op.meta.sources)];
    op.meta.attempts.push({ provider: "api", outcome: "success", duration_ms: Date.now() - started });
    this.lastFailure = null;
    return result;
  }
  status(): unknown {
    return { backend: "api", account_configured: !!this.session, access_token_expires_at: this.session?.expiresAt ?? null, active_requests: this.active.size, last_failure: this.lastFailure };
  }
  close(beforeRelease?: () => Promise<void>): Promise<void> {
    this.closing ??= (async () => {
      await Promise.allSettled([...this.active]);
      // An abandoned refresh may still persist a rotated token; it must land before the lease is released.
      await this.session?.settled();
      try { await this.transport.close(); } finally { try { await beforeRelease?.(); } finally { await this.store.close(); } }
    })();
    return this.closing;
  }
}
