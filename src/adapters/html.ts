import { load } from "cheerio";
import { fail } from "../infra/failure.js";

export function text(value: string): string { return value.replace(/\s+/g, " ").trim(); }
export function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
export function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }

/** Extract JSON assignments without evaluating any script supplied by the shop. */
export function assignment(html: string, name: string): Record<string, unknown> | null {
  const $ = load(html);
  for (const el of $("script").toArray()) {
    const source = $(el).text();
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?:^|[\\s;])(?:var\\s+)?${escaped}\\s*=\\s*(\\{)`).exec(source);
    if (!match) continue;
    const start = match.index + match[0].lastIndexOf("{");
    let depth = 0, quoted = false, escapedChar = false;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (escapedChar) escapedChar = false;
        else if (char === "\\") escapedChar = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try { return object(JSON.parse(source.slice(start, i + 1))); }
        catch { fail("SCHEMA_CHANGED", `Alza's ${name} data is no longer valid JSON.`); }
      }
    }
    fail("PARSE_ERROR", `Alza's ${name} data is incomplete.`);
  }
  return null;
}
export function pageData(html: string): Record<string, unknown> {
  const data = assignment(html, "_pageData");
  if (!data || typeof data.isUserLogged !== "boolean") fail("SCHEMA_CHANGED", "Alza account/page bootstrap data was not recognized.");
  return data;
}
export function accountFromHtml(html: string): { loggedIn: boolean; userId: string | null } {
  const data = pageData(html);
  const id = string(data.userId);
  if (data.isUserLogged === true && (!id || !/^\d+$/.test(id))) fail("AUTH_UNVERIFIED", "Alza reports a signed-in session without a recognized account identity.");
  return { loggedIn: data.isUserLogged === true, userId: id || null };
}
export function jsonLd(html: string, type: string): Record<string, unknown> | null {
  const $ = load(html);
  function find(value: unknown): Record<string, unknown> | null {
    if (Array.isArray(value)) { for (const item of value) { const match = find(item); if (match) return match; } return null; }
    const obj = object(value), types = obj["@type"];
    if (types === type || Array.isArray(types) && types.includes(type)) return obj;
    return obj["@graph"] ? find(obj["@graph"]) : null;
  }
  let malformed = false;
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let parsed: unknown;
    try { parsed = JSON.parse($(el).text()); } catch { malformed = true; continue; }
    const match = find(parsed); if (match) return match;
  }
  if (malformed) fail("PARSE_ERROR", `Alza supplied malformed structured data for ${type}.`);
  return null;
}
export function classifyResponse(status: number | null, headers: Record<string, string>, html: string): void {
  const $ = load(html);
  const title = $("title").text().trim();
  const challenge = headers["cf-mitigated"] === "challenge" || /^(?:Just a moment|Attention Required)/i.test(title) ||
    (!!$("#challenge-running, #cf-challenge-running, #challenge-form, #cf-chl-widget").length && !$(".browsingitem, #detailItem").length) ||
    /Prosím, potvrďte, že jste z masa a kostí/i.test($("body").text());
  if (challenge) fail("CHALLENGE_UNRESOLVED", "Alza returned a human-verification challenge.", { retryable: true, upstream_status: status ?? undefined });
  if (status === 429) {
    const retry = headers["retry-after"];
    const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Math.max(0, Date.parse(retry) - Date.now()) : 60_000;
    fail("RATE_LIMITED", "Alza rate limited the request.", { retryable: true, retry_after_ms: Number.isFinite(delay) ? delay : 60_000, upstream_status: status });
  }
  if (status === 401) fail("AUTH_REQUIRED", "Alza requires a valid account session.", { upstream_status: status });
  if (status === 403) fail("UPSTREAM_ACCESS_DENIED", "Alza denied access without a recognized challenge.", { upstream_status: status });
  if (status && status >= 400) fail("UPSTREAM_ERROR", `Alza returned HTTP ${status}.`, { upstream_status: status, retryable: status >= 500 });
  if (/^(?:Access denied|Service unavailable|Internal Server Error)/i.test(title)) fail("UPSTREAM_ERROR", "Alza returned an error page.", { retryable: true });
}
export function decodeJson(body: string): unknown {
  const raw = /^\s*</.test(body) ? load(body)("pre").text() : body;
  try { return JSON.parse(raw); } catch { fail("PARSE_ERROR", "Alza returned invalid JSON."); }
}
