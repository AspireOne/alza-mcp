import { connect, constants, type ClientHttp2Session } from "node:http2";
import { fail, FailureError } from "./failure.js";

// Cloudflare rejects Node's HTTP/1.1 TLS fingerprint for app-identified
// requests but accepts its HTTP/2 client, so the API backend speaks HTTP/2 only.
const ALLOWED_HOSTS = new Set(["www.alza.cz", "webapi.alza.cz", "identity.alza.cz", "m.alza.cz"]);
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SESSION_IDLE_MS = 60_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface RawResponse { status: number; headers: Record<string, string>; body: string; url: string }
export interface RequestInit { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs: number }
export interface Transport {
  request(url: string, init: RequestInit): Promise<RawResponse>;
  close(): Promise<void>;
}

export function apiUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return fail("INVALID_INPUT", "Invalid Alza API URL."); }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || url.port || url.username || url.password) fail("SCHEMA_CHANGED", "Alza linked to an unsupported host.");
  return url;
}

export class Http2Transport implements Transport {
  private readonly sessions = new Map<string, ClientHttp2Session>();
  async request(url: string, init: RequestInit): Promise<RawResponse> {
    let target = apiUrl(url), method = init.method ?? "GET", body = init.body;
    for (let redirect = 0; ; redirect++) {
      const response = await this.once(target, { ...init, method, body });
      const location = response.headers.location;
      if (!REDIRECTS.has(response.status) || !location) return response;
      if (redirect === MAX_REDIRECTS) fail("UPSTREAM_ERROR", "Alza redirected too many times.");
      target = apiUrl(new URL(location, target).href);
      if (response.status === 303) { method = "GET"; body = undefined; }
    }
  }
  private session(origin: string): ClientHttp2Session {
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(origin);
    // Request streams report their own failures; a session error only ends reuse.
    session.on("error", () => {});
    session.on("close", () => { if (this.sessions.get(origin) === session) this.sessions.delete(origin); });
    session.setTimeout(SESSION_IDLE_MS, () => session.close());
    this.sessions.set(origin, session);
    return session;
  }
  private once(url: URL, init: RequestInit): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      if (init.signal?.aborted) return reject(init.signal.reason);
      const session = this.session(url.origin);
      const stream = session.request({ ":method": init.method ?? "GET", ":path": `${url.pathname}${url.search}`, ...init.headers }, { endStream: init.body === undefined });
      let status = 0, headers: Record<string, string> = {}, size = 0;
      const chunks: Buffer[] = [];
      const finish = (error?: unknown) => {
        clearTimeout(timer); init.signal?.removeEventListener("abort", abort);
        if (error) { stream.close(constants.NGHTTP2_CANCEL); reject(error); }
      };
      const abort = () => finish(init.signal!.reason);
      const timer = setTimeout(() => finish(new FailureError({ code: "TIMEOUT", message: "An Alza API request exceeded its time limit.", retryable: true })), init.timeoutMs);
      init.signal?.addEventListener("abort", abort, { once: true });
      stream.on("response", received => {
        status = Number(received[":status"]);
        headers = Object.fromEntries(Object.entries(received).filter(([name]) => !name.startsWith(":")).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : String(value)]));
      });
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) finish(new FailureError({ code: "UPSTREAM_ERROR", message: "An Alza API response exceeded the size limit.", retryable: false }));
        else chunks.push(chunk);
      });
      stream.on("end", () => { finish(); resolve({ status, headers, body: Buffer.concat(chunks).toString("utf8"), url: url.href }); });
      stream.on("error", error => finish(error));
      if (init.body !== undefined) stream.end(init.body);
    });
  }
  async close(): Promise<void> {
    // A session stays mapped until its close event, so that event always fires; close(callback) may not if closing already began.
    await Promise.all([...this.sessions.values()].map(session => new Promise<void>(resolve => { session.once("close", () => resolve()); session.close(); })));
    this.sessions.clear();
  }
}
