import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { Cursors } from "../src/infra/cursor.js";
import { fail, failureOf } from "../src/infra/failure.js";
import { alzaUrl, productId } from "../src/infra/urls.js";

describe("continuation integrity", () => {
  const cursors = new Cursors("a".repeat(32));
  const schema = z.object({ page: z.number().int().positive() });
  it("binds continuation to its operation and authenticated context", () => {
    const token = cursors.encode("search", "account-generation-1", { page: 2 });
    expect(cursors.decode(token, "search", schema)).toEqual({ context: "account-generation-1", data: { page: 2 } });
    expect(() => cursors.decode(token, "reviews", schema)).toThrow("different operation");
    const parts = token.split(".");
    parts[0] = Buffer.from(JSON.stringify({ page: 900 })).toString("base64url");
    expect(() => cursors.decode(parts.join("."), "search", schema)).toThrow("signature");
  });
  it("expires at the deadline without silently restarting pagination", () => {
    vi.useFakeTimers();
    try {
      const token = cursors.encode("search", "anonymous", { page: 2 });
      vi.advanceTimersByTime(3_600_000);
      expect(() => cursors.decode(token, "search", schema)).toThrow("expired");
    } finally { vi.useRealTimers(); }
  });
});

describe("failures and navigation boundaries", () => {
  it("preserves actionable upstream errors without exposing unexpected exception contents", () => {
    try { fail("RATE_LIMITED", "Alza rate limited this operation.", { retry_after_ms: 3000, upstream_status: 429, retryable: true }); }
    catch (error) { expect(failureOf(error)).toMatchObject({ code: "RATE_LIMITED", retry_after_ms: 3000, upstream_status: 429 }); }
    expect(JSON.stringify(failureOf(new Error("secret-cookie=private")))).not.toContain("private");
  });
  it("rejects arbitrary hosts, credentials and nonstandard ports", () => {
    for (const url of ["http://www.alza.cz/x", "https://alza.cz.evil.test/x", "https://user:pass@www.alza.cz/x", "https://www.alza.cz:8443/x", "https://127.0.0.1/"]) {
      expect(() => alzaUrl(url)).toThrow();
    }
    expect(productId("https://www.alza.cz/a-d123.htm")).toBe(123);
    expect(productId("https://www.alza.cz/a?dq=456")).toBe(456);
  });
});
