import { chromium, type BrowserContext, type Page } from "patchright";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { accountFromHtml, classifyResponse, decodeJson } from "../adapters/html.js";
import type { Config } from "./config.js";
import { fail, FailureError } from "./failure.js";
import type { Operation } from "./operation.js";
import type { Document, Reader } from "./reader.js";
import { StateStore, type Storage } from "./state.js";
import { alzaUrl, BASE_URL, FILTER_PATH } from "./urls.js";
import { log } from "./logger.js";

export class SessionBrowser {
  private context?: BrowserContext;
  private kind?: "anonymous" | "account";
  constructor(private readonly config: Config, readonly store: StateStore) {}
  async start(kind: "anonymous" | "account"): Promise<BrowserContext> {
    if (this.context && this.kind === kind) return this.context;
    await this.close();
    log.info("browser.start", { profile: kind });
    try {
      this.context = await chromium.launchPersistentContext(this.store.profile(kind), {
        headless: this.config.headless, executablePath: this.config.executablePath, viewport: null,
        locale: "cs-CZ", timezoneId: "Europe/Prague", timeout: 15_000,
      });
      this.kind = kind;
      this.context.on("close", () => { this.context = undefined; this.kind = undefined; });
      return this.context;
    } catch (error) {
      throw new FailureError({ code: "BROWSER_UNAVAILABLE", message: "Chromium could not start. Check browser installation, display, profile ownership, and server resources.", retryable: true }, { cause: error });
    }
  }
  async reader(op: Operation, kind: "anonymous" | "account", deadline: number): Promise<{ reader: Reader; dispose: () => Promise<void> }> {
    const context = await this.start(kind);
    op.check();
    const page = await context.newPage();
    const close = () => { void page.close().catch(() => {}); };
    const timer = setTimeout(close, Math.max(1, deadline - Date.now()));
    op.signal.addEventListener("abort", close, { once: true });
    const remaining = () => {
      op.check();
      if (Date.now() >= deadline) fail("TIMEOUT", "Primary browser access exceeded its budget.", { retryable: true });
      return Math.min(deadline - Date.now(), op.remaining());
    };
    const expected = kind === "account" ? this.store.account : undefined;
    const verify = (html: string) => {
      const account = accountFromHtml(html);
      if (expected && !account.loggedIn) fail("AUTH_REQUIRED", "The configured Alza session has expired. Import a valid session.");
      if (expected && account.userId !== expected.expectedUserId) fail("AUTH_ACCOUNT_MISMATCH", "The browser is signed into a different Alza account.");
      if (!expected && account.loggedIn) fail("AUTH_ACCOUNT_MISMATCH", "The anonymous profile unexpectedly contains an authenticated session.");
      op.meta.auth.state = expected ? "signed_in" : "anonymous";
    };
    const reader: Reader = {
      provider: "browser", canPost: true, context: expected ? `account:${expected.generation}` : "anonymous",
      page: async (url, options) => {
        alzaUrl(url);
        let response;
        try { response = await page.goto(url, { waitUntil: "load", timeout: remaining() }); }
        catch (error) { op.check(); remaining(); throw new FailureError({ code: "NETWORK_ERROR", message: "The browser could not load Alza.", retryable: true }, { cause: error }); }
        const headers = response ? await response.allHeaders() : {};
        let html = await page.content();
        classifyResponse(response?.status() ?? null, headers, html);
        alzaUrl(page.url());
        verify(html);
        if (options?.detail) await hydrateDetail(page, remaining);
        html = await page.content();
        verify(html);
        const document: Document = { url: alzaUrl(page.url()), html, status: response?.status() ?? null, headers };
        op.meta.sources.push(document.url);
        return document;
      },
      json: async (url, body) => {
        const target = alzaUrl(url);
        if (body !== undefined && new URL(target).pathname !== FILTER_PATH) fail("INVALID_INPUT", "Only the read-only catalog filter POST is supported.");
        const timeout = remaining();
        const result = await page.evaluate(async ({ target, body, timeout }) => {
          const response = await fetch(target, {
            method: body === undefined ? "GET" : "POST", credentials: "include",
            headers: body === undefined ? undefined : { "content-type": "application/json; charset=utf-8" },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
          });
          return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text(), url: response.url };
        }, { target, body, timeout }).catch(error => { op.check(); remaining(); throw new FailureError({ code: "NETWORK_ERROR", message: "An Alza data request failed.", retryable: true }, { cause: error }); });
        alzaUrl(result.url);
        classifyResponse(result.status, result.headers, result.text);
        op.meta.sources.push(target);
        return decodeJson(result.text);
      },
    };
    try {
      // A fresh first-party page verifies authentication even for cached/public API results.
      await reader.page(BASE_URL);
    } catch (error) { clearTimeout(timer); op.signal.removeEventListener("abort", close); await page.close().catch(() => {}); throw error; }
    return { reader, dispose: async () => { clearTimeout(timer); op.signal.removeEventListener("abort", close); await page.close().catch(() => {}); } };
  }
  status(): unknown { return { running: !!this.context, profile: this.kind ?? null }; }
  async close(): Promise<void> { const context = this.context; this.context = undefined; this.kind = undefined; await context?.close(); }
}

async function hydrateDetail(page: Page, remaining: () => number): Promise<void> {
  // Tabs trigger the same read-only requests used by the storefront. Preserve both loaded sections.
  for (const selector of ["#hlTabParameters", 'a[href="#description"]']) {
    const link = page.locator(selector).first();
    if (!await link.count()) continue;
    await link.click({ timeout: Math.min(remaining(), 3000) }).catch(() => {});
  }
  const description = page.locator("#descAnnotation");
  if (await description.count()) await description.scrollIntoViewIfNeeded({ timeout: Math.min(remaining(), 3000) }).catch(() => {});
  await page.waitForFunction(() => {
    const params = document.querySelector("#parameters");
    const description = document.querySelector("#descAnnotation");
    return (!params || !!params.querySelector(".param, table, [class*=parameter]")) && (!description || !!description.textContent?.trim());
  }, undefined, { timeout: Math.min(remaining(), 5000) }).catch(() => {});
  // Missing sections are reported by the parser; a slow optional section is not a fake empty result.
}

export async function applyStorage(context: BrowserContext, storage: Storage): Promise<void> {
  await context.addCookies(storage.cookies);
  for (const origin of storage.origins) {
    const page = await context.newPage();
    try {
      await page.goto(alzaUrl(origin.origin), { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.evaluate(values => { for (const { name, value } of values) localStorage.setItem(name, value); }, origin.localStorage);
    } finally { await page.close(); }
  }
}
