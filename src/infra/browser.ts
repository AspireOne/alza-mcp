import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { resolveLocale, type Locale } from "./locale.js";
import { log } from "./logger.js";
import { redactSensitiveText, redactUrl, sensitiveUrlParts } from "./redaction.js";

const require = createRequire(import.meta.url);

const PAGE_TIMEOUT_MS = 30_000;
const HEADER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const DEFAULT_IDLE_BROWSER_TTL_MS = 3 * 60 * 1000;

export interface BrowserOptions {
  baseUrl?: string;
  /** Connect to an existing Chrome via CDP instead of launching Chromium. */
  cdpUrl?: string;
  /** Set false to run a visible window (debugging only). Default true. */
  headless?: boolean;
  /** Close the browser entirely after this many ms of inactivity. Default 3 min. */
  idleTtlMs?: number;
  /** Playwright seam for deterministic browser lifecycle tests. */
  driver?: BrowserDriver;
  /** Browser installer seam for deterministic browser lifecycle tests. */
  installer?: BrowserInstaller;
}

export interface BrowserDriver {
  launch: typeof chromium.launch;
  connectOverCDP: typeof chromium.connectOverCDP;
}

export type BrowserInstaller = () => Promise<void>;

/**
 * Lazy, idle-shutdown browser facade.
 *
 * Design notes:
 *  - The browser is launched on first use, NOT eagerly.
 *  - Pages are NOT pooled. Each `withPage` call opens a fresh page and
 *    closes it in a finally — pages accumulate DOM/JS heap across
 *    navigations and pooling them caused 1.9 GB renderer leaks.
 *  - When no calls have been made for `idleTtlMs`, the entire browser
 *    process tree is shut down. Next call relaunches.
 *  - Image/font/media/analytics traffic is blocked at the route level so
 *    every page load is just HTML + JSON-LD.
 */
export class AlzaBrowser {
  readonly locale: Locale;
  private readonly cdpUrl?: string;
  private readonly headless: boolean;
  private readonly idleTtlMs: number;
  private readonly driver: BrowserDriver;
  private readonly installer: BrowserInstaller;

  private launching?: Promise<Browser>;
  private contextInitializing?: Promise<BrowserContext>;
  private shutdownPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private browser?: Browser;
  private context?: BrowserContext;
  private idleTimer?: NodeJS.Timeout;
  private readonly idleWaiters = new Set<() => void>();
  private inFlight = 0;
  private closed = false;

  constructor(opts: BrowserOptions = {}) {
    this.locale = resolveLocale(opts.baseUrl);
    this.cdpUrl = opts.cdpUrl ?? process.env.ALZA_CDP_URL;
    this.headless = opts.headless ?? process.env.ALZA_HEADLESS !== "false";
    this.driver = opts.driver ?? chromium;
    this.installer = opts.installer ?? installChromium;
    const envTtl = Number(process.env.ALZA_IDLE_TTL_MS);
    this.idleTtlMs =
      opts.idleTtlMs ?? (Number.isFinite(envTtl) && envTtl > 0 ? envTtl : DEFAULT_IDLE_BROWSER_TTL_MS);
  }

  /**
   * Run an async function with a fresh page. The page is opened just
   * before the callback and closed unconditionally afterward.
   */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("browser closed");

    this.cancelIdleTimer();
    this.inFlight++;
    let page: Page | undefined;
    try {
      const ctx = await this.ensureContext();
      page = await ctx.newPage();
      page.setDefaultTimeout(PAGE_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
      return await fn(page);
    } finally {
      if (page) await page.close().catch(() => {});
      this.inFlight--;
      if (this.inFlight === 0) {
        this.resolveIdleWaiters();
        this.scheduleIdleShutdown();
      }
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.cancelIdleTimer();
    this.closePromise = (async () => {
      await this.waitUntilIdle();
      await this.shutdownBrowser();
    })();
    return this.closePromise;
  }

  private async shutdownBrowser(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    const ctx = this.context;
    const browser = this.browser;
    this.context = undefined;
    this.browser = undefined;

    const shutdown = (async () => {
      if (this.cdpUrl) return;
      await ctx?.close().catch(() => {});
      await browser?.close().catch(() => {});
    })();
    this.shutdownPromise = shutdown;
    try {
      await shutdown;
    } finally {
      if (this.shutdownPromise === shutdown) this.shutdownPromise = undefined;
    }
  }

  private scheduleIdleShutdown(): void {
    if (this.closed || this.cdpUrl) return;
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.inFlight !== 0 || this.closed) return;
      log.info("alza-browser: closing idle browser", { idleMs: this.idleTtlMs });
      void this.shutdownBrowser();
    }, this.idleTtlMs);
    // Don't keep the process alive solely for this timer (matters for stdio).
    this.idleTimer.unref?.();
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.shutdownPromise) await this.shutdownPromise;
    if (this.closed) throw new Error("browser closed");
    if (this.context) return this.context;
    if (this.contextInitializing) return this.contextInitializing;

    const initializing = this.createContext();
    this.contextInitializing = initializing;
    try {
      const context = await initializing;
      this.context = context;
      return context;
    } finally {
      if (this.contextInitializing === initializing) this.contextInitializing = undefined;
    }
  }

  private async createContext(): Promise<BrowserContext> {
    const browser = await this.ensureBrowser();
    if (this.cdpUrl) {
      const context = browser.contexts()[0];
      if (!context) throw new Error("CDP browser has no existing browser context");
      return context;
    }

    const context = await browser.newContext({
      locale: this.locale.acceptLanguage.split(",")[0] ?? "cs-CZ",
      userAgent: HEADER_USER_AGENT,
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { "accept-language": this.locale.acceptLanguage },
    });

    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      const url = route.request().url();
      if (
        url.includes("googletagmanager.com") ||
        url.includes("google-analytics.com") ||
        url.includes("doubleclick.net") ||
        url.includes("/api/log/")
      ) {
        return route.abort();
      }
      return route.continue();
    });

    return context;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      if (this.cdpUrl) {
        log.info("alza-browser: connecting via CDP", { cdpUrl: redactUrl(this.cdpUrl) });
        let browser: Browser;
        try {
          browser = await this.driver.connectOverCDP(this.cdpUrl);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `CDP browser connection failed: ${redactSensitiveText(
              message,
              sensitiveUrlParts(this.cdpUrl)
            )}`,
            { cause: error }
          );
        }
        this.browser = browser;
        this.watchBrowser(browser);
        return browser;
      }
      log.info("alza-browser: launching managed Chromium", { headless: this.headless });
      const browser = await this.launchChromiumWithFallback();
      this.browser = browser;
      this.watchBrowser(browser);
      return browser;
    })().finally(() => {
      this.launching = undefined;
    });

    return this.launching;
  }

  private async launchChromiumWithFallback(): Promise<Browser> {
    const launchArgs = {
      headless: this.headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        // Trim memory / process count.
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--no-default-browser-check",
        "--no-first-run",
      ],
    };
    try {
      return await this.driver.launch(launchArgs);
    } catch (err) {
      const message = (err as Error)?.message ?? "";
      const isMissingBinary =
        message.includes("Executable doesn't exist") ||
        message.includes("Looks like Playwright Test or Playwright was just installed");
      if (!isMissingBinary) throw err;

      log.info(
        "alza-browser: chromium not found — downloading headless-shell now (~92 MB, one-time). " +
          "Set ALZA_CDP_URL to skip the download and use your own Chrome."
      );
      await this.installer();
      return this.driver.launch(launchArgs);
    }
  }

  private watchBrowser(browser: Browser): void {
    browser.on("disconnected", () => {
      if (this.browser !== browser) return;
      log.info("alza-browser: chromium disconnected");
      this.browser = undefined;
      this.context = undefined;
    });
  }

  private waitUntilIdle(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

export async function installChromium(spawnProcess: typeof spawn = spawn): Promise<void> {
  let cliPath: string;
  try {
    const pkgJsonPath = require.resolve("playwright/package.json");
    cliPath = join(dirname(pkgJsonPath), "cli.js");
  } catch (err) {
    throw new Error(
      "Cannot find Playwright CLI. Run `npm install playwright` and retry.",
      { cause: err as Error }
    );
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(process.execPath, [cliPath, "install", "chromium", "--only-shell"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => process.stderr.write(chunk));
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Failed to install Chromium (exit ${code}). Try \`npx playwright install chromium --only-shell\` manually.`
          )
        );
    });
  });
}
