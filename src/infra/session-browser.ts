import { chromium, type BrowserContext, type Page } from "patchright";
import { readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { classifyResponse, decodeJson } from "../adapters/html.js";
import type { Config } from "./config.js";
import { fail, FailureError } from "./failure.js";
import type { Operation } from "./operation.js";
import type { Document, Reader } from "./reader.js";
import { StateStore, type Storage } from "./state.js";
import { alzaUrl, BASE_URL, FILTER_PATH } from "./urls.js";
import { log } from "./logger.js";
import { verifyIdentity } from "./identity.js";

export class SessionBrowser {
  private context?: BrowserContext;
  private kind?: "anonymous" | "account";
  constructor(private readonly config: Config, readonly store: StateStore) {}
  async start(kind: "anonymous" | "account", timeout = 15_000): Promise<BrowserContext> {
    if (this.context && this.kind === kind) return this.context;
    await this.close();
    log.info("browser.start", { profile: kind });
    try {
      const profile = this.store.profile(kind);
      // The caller owns the data-directory lease. Chromium's old hostname/PID
      // lock otherwise prevents recovery after replacing a crashed container.
      try {
        const lock = await readlink(join(profile, 'SingletonLock'));
        const match = lock.match(/^(.*)-(\d+)$/);
        if (match?.[1] === hostname()) {
          let alive = false;
          try { process.kill(Number(match[2]), 0); alive = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') alive = true; }
          if (alive) fail('PROFILE_IN_USE', 'A browser process still owns the managed profile.');
        }
        await Promise.all(['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map(file => rm(join(profile, file), { force: true })));
        log.info('browser.stale_lock_removed', { profile: kind });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.context = await chromium.launchPersistentContext(this.store.profile(kind), {
        headless: this.config.headless, executablePath: this.config.executablePath, viewport: null,
        locale: "cs-CZ", timezoneId: "Europe/Prague", timeout,
      });
      this.kind = kind;
      this.context.on("close", () => { this.context = undefined; this.kind = undefined; });
      return this.context;
    } catch (error) {
      if (error instanceof FailureError) throw error;
      throw new FailureError({ code: "BROWSER_UNAVAILABLE", message: "Chromium could not start. Check browser installation, display, profile ownership, and server resources.", retryable: true }, { cause: error });
    }
  }
  async reader(op: Operation, kind: "anonymous" | "account", deadline: number): Promise<{ reader: Reader; dispose: () => Promise<void> }> {
    op.check();
    if (Date.now() >= deadline) fail("TIMEOUT", "Primary browser budget was exhausted before startup.", { retryable: true });
    const context = await this.start(kind, Math.min(15_000, deadline - Date.now(), op.remaining()));
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
    const network = async <T>(work: () => Promise<T>): Promise<T> => {
      try { return await work(); }
      catch (error) {
        op.check(); remaining();
        if (error instanceof FailureError) throw error;
        op.meta.warnings.push({ code: "NETWORK_RETRY", message: "Retrying one transient browser request within the existing deadline." });
        try { return await work(); }
        catch (cause) { op.check(); remaining(); throw new FailureError({ code: "NETWORK_ERROR", message: "An Alza browser request failed twice.", retryable: true }, { cause }); }
      }
    };
    const expected = kind === "account" ? this.store.account : undefined;
    const verify = (html: string) => { op.meta.auth.state = verifyIdentity(html, expected); };
    const reader: Reader = {
      provider: "browser", canPost: true, context: expected ? `account:${expected.generation}` : "anonymous",
      page: async (url, options) => {
        alzaUrl(url);
        const response = await network(() => page.goto(url, { waitUntil: "load", timeout: remaining() }));
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
        const result = await network(() => page.evaluate(async ({ target, body, timeout }) => {
          const response = await fetch(target, {
            method: body === undefined ? "GET" : "POST", credentials: "include", redirect: "error",
            headers: body === undefined ? undefined : { "content-type": "application/json; charset=utf-8" },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
          });
          return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text(), url: response.url };
        }, { target, body, timeout: Math.min(timeout, remaining()) }));
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
  const selectors = page.locator('[data-testid="detailVariantSelectComponentOpenOptionsButton"]');
  const groups: unknown[] = [];
  for (let i = 0; i < await selectors.count(); i++) {
    const selector = selectors.nth(i);
    try {
      const label = await selector.innerText();
      await selector.click({ timeout: Math.min(remaining(), 2000) });
      await page.locator('[role="listbox"] [role="option"]').first().waitFor({ timeout: Math.min(remaining(), 2000) });
      const options = await page.locator('[role="listbox"] [role="option"]').evaluateAll(nodes => nodes.map(n => ({ label: n.textContent?.trim(), selected: n.getAttribute('aria-selected') === 'true' })));
      groups.push({ label, options });
      await page.keyboard.press('Escape');
    } catch { break; }
  }
  if (groups.length && groups.length === await selectors.count()) await page.evaluate(groups => {
    const node = document.createElement('script'); node.type = 'application/json'; node.id = 'alza-mcp-variant-options'; node.textContent = JSON.stringify(groups); document.body.append(node);
  }, groups);
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
