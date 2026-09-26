import { classifyResponse, decodeJson } from "../adapters/html.js";
import type { Account } from "./state.js";
import type { Reader } from "./reader.js";
import type { Operation } from "./operation.js";
import { fail, FailureError } from "./failure.js";
import { alzaUrl, BASE_URL } from "./urls.js";
import { verifyIdentity } from "./identity.js";

export async function solverReader(provider: "flaresolverr" | "byparr", endpoint: string, op: Operation, deadline: number, account?: Account, cookies?: Array<Record<string, unknown>>): Promise<{ reader: Reader; dispose: () => Promise<void> }> {
  const session = `alza-${op.id}`;
  const remaining = () => {
    op.check();
    if (Date.now() >= deadline) fail("TIMEOUT", `${provider} exceeded its recovery budget.`, { retryable: true });
    return Math.max(1, Math.min(deadline - Date.now(), op.remaining()));
  };
  async function command(body: Record<string, unknown>): Promise<Record<string, any>> {
    const timeout = remaining();
    try {
      const response = await fetch(`${endpoint}/v1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([op.signal, AbortSignal.timeout(timeout)]) });
      if (!response.ok) fail("RECOVERY_PROVIDER_UNAVAILABLE", `${provider} returned HTTP ${response.status}.`, { retryable: true, stage: provider });
      const data = await response.json() as Record<string, any>;
      if (data.status !== "ok") fail("CHALLENGE_UNRESOLVED", `${provider} did not return a successful recovery.`, { retryable: true, stage: provider });
      return data;
    } catch (error) {
      op.check();
      if (error instanceof FailureError) throw error;
      remaining();
      fail("RECOVERY_PROVIDER_UNAVAILABLE", `${provider} could not be reached or returned an invalid response.`, { retryable: true, stage: provider });
    }
  }
  const dispose = async () => {
    if (provider !== "flaresolverr") return;
    // Cleanup has its own short budget, including when the operation was cancelled.
    await fetch(`${endpoint}/v1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "sessions.destroy", session }), signal: AbortSignal.timeout(2000) }).catch(() => {});
  };
  let seeded = false;
  const read = async (url: string) => {
    const target = alzaUrl(url);
    const data = await command({ cmd: "request.get", url: target, maxTimeout: Math.max(1000, Math.floor(remaining())), ...(provider === "flaresolverr" ? { session, waitInSeconds: 1, ...(!seeded && cookies ? { cookies } : {}) } : { blockMedia: false }) });
    seeded = true;
    const solution = data.solution;
    if (!solution || typeof solution.response !== "string" || typeof solution.url !== "string") fail("PARSE_ERROR", `${provider} returned an incomplete result.`, { stage: provider });
    const finalUrl = alzaUrl(solution.url);
    // Both solvers can synthesize HTTP 200 and retain headers from an earlier response.
    classifyResponse(null, {}, solution.response);
    op.meta.sources.push(finalUrl);
    return { url: finalUrl, html: solution.response as string, status: null, headers: {} };
  };
  const reader: Reader = {
    provider, canPost: false, context: account ? `account:${account.generation}` : "anonymous",
    page: async url => {
      const doc = await read(url);
      op.meta.auth.state = verifyIdentity(doc.html, account);
      return doc;
    },
    json: async (url, body) => {
      if (body !== undefined) fail("RECOVERY_UNSUPPORTED", `${provider} does not support catalog JSON POST requests.`);
      return decodeJson((await read(url)).html);
    },
  };
  try {
    if (provider === "flaresolverr") await command({ cmd: "sessions.create", session });
    if (account) await reader.page(BASE_URL);
    else op.meta.auth.state = "anonymous";
    return { reader, dispose };
  } catch (error) { await dispose(); throw error; }
}
