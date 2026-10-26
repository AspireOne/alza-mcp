import { chromium, type BrowserContext, type Page } from "patchright";
import { readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { classifyResponse, decodeJson, htmlDocument, object, pageData, type HtmlSource } from "../adapters/html.js";
import type { Config } from "./config.js";
import { fail, FailureError } from "./failure.js";
import { OperationQueue, type Operation } from "./operation.js";
import type { DetailSection, Document, Reader } from "./reader.js";
import { StateStore, type Storage } from "./state.js";
import { alzaUrl, BASE_URL, FILTER_PATH } from "./urls.js";
import { log, withLogContext } from "./logger.js";
import { verifyIdentity } from "./identity.js";

type ProfileKind = "anonymous" | "account";
interface BrowserSlot { context?: BrowserContext; starting?: Promise<BrowserContext> }

export class SessionBrowser {
  private readonly slots = new Map<ProfileKind, BrowserSlot>();
  private activeReaders = 0;
  private readonly interactions = new OperationQueue();
  private readonly idle = new Set<() => void>();
  private closing?: Promise<void>;
  constructor(private readonly config: Config, readonly store: StateStore) {}
  async start(kind: ProfileKind, timeout = 15_000): Promise<BrowserContext> {
    while (this.closing) await this.closing;
    let slot = this.slots.get(kind);
    if (!slot) { slot = {}; this.slots.set(kind, slot); }
    if (slot.context) return slot.context;
    if (slot.starting) return slot.starting;
    const starting = this.launch(kind, timeout, slot);
    slot.starting = starting;
    try { return await starting; }
    finally { if (slot.starting === starting) slot.starting = undefined; }
  }
  private async launch(kind: ProfileKind, timeout: number, slot: BrowserSlot): Promise<BrowserContext> {
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
      const context = await chromium.launchPersistentContext(this.store.profile(kind), {
        headless: this.config.headless, executablePath: this.config.executablePath, viewport: null,
        // The application must finish request draining, log flushing and lease release before exiting.
        handleSIGINT: false,
        locale: "cs-CZ", timezoneId: "Europe/Prague", timeout,
      });
      slot.context = context;
      context.on("close", () => { if (slot.context === context) slot.context = undefined; });
      return context;
    } catch (error) {
      if (error instanceof FailureError) throw error;
      throw new FailureError({ code: "BROWSER_UNAVAILABLE", message: "Chromium could not start. Check browser installation, display, profile ownership, and server resources.", retryable: true }, { cause: error });
    }
  }
  async reader(op: Operation, kind: ProfileKind, deadline: number): Promise<{ reader: Reader; dispose: () => Promise<void> }> {
    while (this.closing) {
      const closing = this.closing;
      await op.step("browser.wait_close", { provider: "browser" }, () => op.waitFor(closing, deadline));
    }
    op.check();
    this.activeReaders++;
    try {
      const resource = await this.createReader(op, kind, deadline);
      let disposed = false;
      return { reader: resource.reader, dispose: async () => {
        if (disposed) return;
        disposed = true;
        try { await resource.dispose(); }
        finally { this.releaseReader(); }
      } };
    } catch (error) { this.releaseReader(); throw error; }
  }
  private releaseReader(): void {
    this.activeReaders--;
    if (!this.activeReaders) { for (const resolve of this.idle) resolve(); this.idle.clear(); }
  }
  private async createReader(op: Operation, kind: ProfileKind, deadline: number): Promise<{ reader: Reader; dispose: () => Promise<void> }> {
    op.check();
    if (Date.now() >= deadline) fail("TIMEOUT", "Primary browser budget was exhausted before startup.", { retryable: true });
    // A short-lived caller must not shorten a shared launch needed by another reader.
    const context = await op.step("browser.start", { provider: "browser", profile: kind, reused: !!this.slots.get(kind)?.context },
      () => op.waitFor(this.start(kind), Math.min(deadline, Date.now() + 15_000)));
    op.check();
    const page = await withLogContext({ queue: "interaction" }, () => this.interactions.run(op,
      () => op.step("browser.new_page", { provider: "browser" }, () => context.newPage()), deadline));
    try {
      op.check();
      if (Date.now() >= deadline) fail("TIMEOUT", "Primary browser budget was exhausted while opening a page.", { retryable: true });
    } catch (error) { await page.close().catch(() => {}); throw error; }
    const close = () => { void page.close().catch(() => {}); };
    const timer = setTimeout(close, Math.max(1, deadline - Date.now()));
    op.signal.addEventListener("abort", close, { once: true });
    const remaining = () => {
      op.check();
      if (Date.now() >= deadline) fail("TIMEOUT", "Primary browser access exceeded its budget.", { retryable: true });
      return Math.min(deadline - Date.now(), op.remaining());
    };
    const network = async <T>(work: () => Promise<T>): Promise<T> => {
      try { return await op.step("browser.network", { provider: "browser", attempt: 1 }, work); }
      catch (error) {
        op.check(); remaining();
        if (error instanceof FailureError) throw error;
        op.meta.warnings.push({ code: "NETWORK_RETRY", message: "Retrying one transient browser request within the existing deadline." });
        log.warn("browser.retry", { request_id: op.id, provider: "browser", attempt: 2 });
        try { return await op.step("browser.network", { provider: "browser", attempt: 2 }, work); }
        catch (cause) { op.check(); remaining(); throw new FailureError({ code: "NETWORK_ERROR", message: "An Alza browser request failed twice.", retryable: true }, { cause }); }
      }
    };
    const expected = kind === "account" ? this.store.account : undefined;
    let verified = false;
    const verify = (html: HtmlSource) => { op.meta.auth.state = verifyIdentity(html, expected); verified = true; };
    const reader: Reader = {
      provider: "browser", canPost: true, context: expected ? `account:${expected.generation}` : "anonymous",
      verify: async () => { if (!verified) await reader.page(BASE_URL); },
      page: async (url, options) => op.step("browser.page", { provider: "browser", path: new URL(url).pathname }, async () => {
        try {
          alzaUrl(url);
          const response = await network(() => page.goto(url, { waitUntil: "load", timeout: remaining() }));
          log.info("upstream.response", { request_id: op.id, provider: "browser", status: response?.status() ?? null });
          const headers = response ? await response.allHeaders() : {};
          let html = await page.content();
          const initial = htmlDocument(html);
          classifyResponse(response?.status() ?? null, headers, initial);
          alzaUrl(page.url());
          verify(initial);
          const detail = options?.detail;
          if (detail?.length) await withLogContext({ queue: "interaction" }, () => this.interactions.run(op,
            () => op.step("browser.hydrate_detail", { provider: "browser" }, async () => {
              await page.bringToFront();
              await hydrateDetail(page, remaining, op, detail);
            }), deadline));
          if (options?.stock && typeof object(pageData(initial).data).categoryTypeId === "number") {
            await op.step("browser.wait_stock", { provider: "browser" }, () => page.locator("label").filter({ hasText: "Skladem kdekoliv" }).locator('input[type="radio"]').first()
              .waitFor({ timeout: Math.min(remaining(), 5000) })).catch(() => {});
          }
          if (options?.category && initial('[data-testid="component-catalogLocalTitlePage"][data-api-url]').length) {
            try {
              await op.step("browser.wait_category", { provider: "browser" }, () => page.waitForFunction(() =>
                [...window.document.querySelectorAll('[data-testid="component-catalogLocalTitlePage"][data-api-url]')].every(component =>
                  !!component.querySelector('[data-testid="category-tile"] a[href]')), undefined, { timeout: Math.min(remaining(), 5000) }));
            } catch { remaining(); fail("SECTION_INCOMPLETE", "Category navigation did not finish loading.", { retryable: true }); }
          }
          html = await page.content();
          verify(html);
          const document: Document = { url: alzaUrl(page.url()), html, status: response?.status() ?? null, headers };
          op.meta.sources.push(document.url);
          remaining();
          return document;
        } catch (error) { remaining(); throw error; }
      }),
      json: async (url, body) => op.step("browser.json", { provider: "browser", path: new URL(url).pathname, method: body === undefined ? "GET" : "POST" }, async () => {
        const target = alzaUrl(url);
        if (body !== undefined && new URL(target).pathname !== FILTER_PATH) fail("INVALID_INPUT", "Only the read-only catalog filter POST is supported.");
        await reader.verify!();
        const timeout = remaining();
        const result = await network(() => page.evaluate(async ({ target, body, timeout }) => {
          const response = await fetch(target, {
            method: body === undefined ? "GET" : "POST", credentials: "include", redirect: "error",
            headers: body === undefined ? undefined : { "content-type": "application/json; charset=utf-8" },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
          });
          return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text(), url: response.url };
        }, { target, body, timeout: Math.min(timeout, remaining()) }));
        log.info("upstream.response", { request_id: op.id, provider: "browser", status: result.status });
        alzaUrl(result.url);
        classifyResponse(result.status, result.headers, result.text);
        op.meta.sources.push(target);
        return decodeJson(result.text);
      }),
    };
    return { reader, dispose: async () => { clearTimeout(timer); op.signal.removeEventListener("abort", close); await page.close().catch(() => {}); } };
  }
  status(): unknown {
    const profiles = [...this.slots].filter(([, slot]) => slot.context).map(([kind]) => kind);
    return { running: profiles.length > 0, profile: profiles.length === 1 ? profiles[0] : null, profiles, active_readers: this.activeReaders };
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    // A solver must not close tabs owned by another request. New readers wait behind this release.
    const closing = (async () => {
      if (this.activeReaders) await new Promise<void>(resolve => this.idle.add(resolve));
      const closed = await Promise.allSettled([...this.slots.values()].map(async slot => {
        const context = slot.context ?? await slot.starting?.catch(() => undefined);
        await context?.close();
        if (slot.context === context) slot.context = undefined;
      }));
      const failure = closed.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    this.closing = closing;
    try { await closing; }
    finally { if (this.closing === closing) this.closing = undefined; }
  }
}

async function hydrateDetail(page: Page, remaining: () => number, op: Operation, sections: readonly DetailSection[]): Promise<void> {
  const parametersNeeded = sections.includes("specifications");
  const descriptionNeeded = sections.includes("description");
  const variantsNeeded = sections.includes("variants");
  // Tabs trigger the same read-only requests used by the storefront. Preserve both loaded sections.
  const tabs = [...(parametersNeeded ? ["#hlTabParameters"] : []), ...(descriptionNeeded ? ['a[href="#description"]'] : [])];
  for (const selector of tabs) {
    const link = page.locator(selector).first();
    if (!await link.count()) continue;
    await op.step("browser.detail_tab", { selector }, () => link.click({ timeout: Math.min(remaining(), 3000) })).catch(() => {});
  }
  const description = descriptionNeeded ? page.locator("#descAnnotation") : undefined;
  if (description && await description.count()) await op.step("browser.detail_scroll", {}, () => description.scrollIntoViewIfNeeded({ timeout: Math.min(remaining(), 3000) })).catch(() => {});
  if (parametersNeeded || descriptionNeeded) await op.step("browser.detail_sections", {}, () => page.waitForFunction(({ parametersNeeded, descriptionNeeded }) => {
    const params = document.querySelector("#parameters");
    const description = document.querySelector("#descAnnotation");
    return (!parametersNeeded || !params || !!params.querySelector(".param, table, [class*=parameter]")) && (!descriptionNeeded || !description || !!description.textContent?.trim());
  }, { parametersNeeded, descriptionNeeded }, { timeout: Math.min(remaining(), 5000) })).catch(() => {});
  if (!variantsNeeded) return;
  const selectors = page.locator('[data-testid="detailVariantSelectComponentOpenOptionsButton"]');
  const readLabels = () => op.step("browser.variant_controls", {}, () => selectors.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).innerText)));
  let labels = await readLabels();
  const groups: { label: string; options: { label: string | undefined; selected: boolean }[] }[] = [];
  for (let i = 0; i < labels.length; i++) {
    const selector = selectors.nth(i);
    try {
      await op.step("browser.detail_variant", { index: i }, async () => {
        const label = labels[i]!;
        await op.step("browser.variant_open", { index: i }, () => selector.click({ timeout: Math.min(remaining(), 2000) }));
        await op.step("browser.variant_options", { index: i }, () => page.locator('[role="listbox"] [role="option"]').first().waitFor({ timeout: Math.min(remaining(), 2000) }));
        const options = await page.locator('[role="listbox"] [role="option"]').evaluateAll(nodes => nodes.map(n => ({ label: n.textContent?.trim(), selected: n.getAttribute('aria-selected') === 'true' })));
        groups.push({ label, options });
        await page.keyboard.press('Escape');
      });
      // Recheck after the batch: lazy controls can appear or change during interaction.
      // Query through Patchright so closed shadow roots retain the same semantics.
      if (i === labels.length - 1) labels = await readLabels();
    } catch { return; }
  }
  if (groups.length && groups.length === labels.length && groups.every((group, i) => group.label === labels[i])) await page.evaluate(groups => {
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
