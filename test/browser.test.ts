import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlzaBrowser,
  installChromium,
  type BrowserDriver,
} from "../src/infra/browser.js";

interface FakePage extends EventEmitter {
  close: ReturnType<typeof vi.fn>;
  setDefaultTimeout: ReturnType<typeof vi.fn>;
  setDefaultNavigationTimeout: ReturnType<typeof vi.fn>;
}

interface FakeContext extends EventEmitter {
  route: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  newPage: ReturnType<typeof vi.fn>;
}

interface FakeBrowser extends EventEmitter {
  contexts: ReturnType<typeof vi.fn>;
  newContext: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makePage(): FakePage {
  const page = new EventEmitter() as FakePage;
  page.close = vi.fn(async () => {});
  page.setDefaultTimeout = vi.fn();
  page.setDefaultNavigationTimeout = vi.fn();
  return page;
}

function makeContext(pages: FakePage[] = [makePage()]): FakeContext {
  const context = new EventEmitter() as FakeContext;
  context.route = vi.fn(async () => {});
  context.newPage = vi.fn(async () => pages.shift() ?? makePage());
  context.close = vi.fn(async () => context.emit("close"));
  return context;
}

function makeBrowser(contexts: FakeContext[] = []): FakeBrowser {
  const browser = new EventEmitter() as FakeBrowser;
  browser.contexts = vi.fn(() => contexts as unknown as BrowserContext[]);
  browser.newContext = vi.fn(async () => contexts[0] ?? makeContext());
  browser.close = vi.fn(async () => browser.emit("disconnected"));
  return browser;
}

function makeDriver(overrides: Partial<BrowserDriver> = {}): BrowserDriver {
  return {
    launch: vi.fn(async () => makeBrowser() as unknown as Browser),
    connectOverCDP: vi.fn(async () => makeBrowser() as unknown as Browser),
    ...overrides,
  } as BrowserDriver;
}

beforeEach(() => {
  vi.stubEnv("ALZA_CDP_URL", "");
  vi.stubEnv("ALZA_HEADLESS", "true");
  vi.stubEnv("ALZA_IDLE_TTL_MS", "60000");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("AlzaBrowser lifecycle", () => {
  it("coalesces concurrent context initialization", async () => {
    const context = makeContext([makePage(), makePage()]);
    const browser = makeBrowser();
    let resolveContext!: (value: BrowserContext) => void;
    browser.newContext.mockImplementation(
      () => new Promise<BrowserContext>((resolve) => (resolveContext = resolve))
    );
    const launch = vi.fn(async () => browser as unknown as Browser);
    const alza = new AlzaBrowser({ driver: makeDriver({ launch }) });

    const first = alza.withPage(async () => "first");
    const second = alza.withPage(async () => "second");
    await vi.waitFor(() => expect(browser.newContext).toHaveBeenCalledOnce());
    resolveContext(context as unknown as BrowserContext);

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(launch).toHaveBeenCalledOnce();
    expect(browser.newContext).toHaveBeenCalledOnce();
    expect(context.route).toHaveBeenCalledOnce();
    expect(context.newPage).toHaveBeenCalledTimes(2);
    await alza.close();
  });

  it("borrows the existing CDP context without closing the user's browser", async () => {
    const page = makePage();
    const context = makeContext([page]);
    const browser = makeBrowser([context]);
    const connectOverCDP = vi.fn(
      async () => browser as unknown as Browser
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const alza = new AlzaBrowser({
      cdpUrl: "http://user:secret@localhost:9222/session/token",
      driver: makeDriver({ connectOverCDP }),
    });

    await alza.withPage(async () => {});
    await alza.close();

    expect(connectOverCDP).toHaveBeenCalledOnce();
    expect(browser.contexts).toHaveBeenCalled();
    expect(browser.newContext).not.toHaveBeenCalled();
    expect(context.route).not.toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledOnce();
    expect(context.close).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    const logs = stderr.mock.calls.flat().join("");
    expect(logs).toContain("http://localhost:9222");
    expect(logs).not.toMatch(/user|secret|session|token/);
  });

  it("waits for an active operation before closing owned resources", async () => {
    const page = makePage();
    const context = makeContext([page]);
    const browser = makeBrowser([context]);
    const alza = new AlzaBrowser({
      driver: makeDriver({
        launch: vi.fn(async () => browser as unknown as Browser),
      }),
    });
    let finish!: () => void;
    const operation = alza.withPage(
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    await vi.waitFor(() => expect(context.newPage).toHaveBeenCalledOnce());

    const closing = alza.close();
    expect(alza.close()).toBe(closing);
    expect(context.close).not.toHaveBeenCalled();
    finish();
    await Promise.all([operation, closing]);

    expect(page.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("redacts CDP connection details from errors", async () => {
    const connectOverCDP = vi.fn(async () => {
      throw new Error(
        "failed http://user:secret@localhost:9222/session/token?key=abc"
      );
    });
    const alza = new AlzaBrowser({
      cdpUrl: "http://user:secret@localhost:9222/session/token?key=abc",
      driver: makeDriver({ connectOverCDP }),
    });

    const error = await alza.withPage(async () => {}).catch((caught) => caught as Error);

    expect(error.message).not.toMatch(/user|secret|session|token|abc/);
    expect(error.message).toContain("[redacted]");
    await alza.close();
  });
});

describe("Chromium installation", () => {
  it("pipes installer output to stderr instead of MCP stdout", async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const spawnProcess = vi.fn(() => child);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const installing = installChromium(
      spawnProcess as unknown as typeof import("node:child_process").spawn
    );
    child.stdout.emit("data", "download progress");
    child.stderr.emit("data", "installer warning");
    child.emit("exit", 0);
    await installing;

    const [, args, options] = spawnProcess.mock.calls[0]!;
    expect(args).toContain("chromium");
    expect(options).toEqual({ stdio: ["ignore", "pipe", "pipe"] });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join("")).toContain("download progress");
    expect(stderr.mock.calls.flat().join("")).toContain("installer warning");
  });
});
