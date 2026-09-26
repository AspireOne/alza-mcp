import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountFromHtml, classifyResponse, decodeJson, assignment } from "../src/adapters/html.js";
import { StateStore, scopedStorage } from "../src/infra/state.js";
import { Operation, OperationQueue } from "../src/infra/operation.js";

describe("upstream classification", () => {
  it("rejects challenges even when the upstream or solver claims HTTP 200", () => {
    expect(() => classifyResponse(200, {}, '<title>Just a moment...</title><div id="challenge-form"></div>')).toThrow("verification");
    expect(() => classifyResponse(200, { "cf-mitigated": "challenge" }, "{}")).toThrow("verification");
    expect(() => classifyResponse(200, {}, '<title>Alza</title><script src="/cdn-cgi/challenge-platform/js"></script><div class="browsingitem">captcha game</div>')).not.toThrow();
  });
  it("keeps rate limits and access denial distinct from challenges", () => {
    try { classifyResponse(429, { "retry-after": "30" }, "{}"); } catch (e) { expect(e).toMatchObject({ failure: { code: "RATE_LIMITED", retry_after_ms: 30000 } }); }
    try { classifyResponse(403, {}, "{}"); } catch (e) { expect(e).toMatchObject({ failure: { code: "UPSTREAM_ACCESS_DENIED" } }); }
  });
  it("decodes solver JSON wrappers and fails loudly on malformed JSON", () => {
    expect(decodeJson('<html><body><pre>{"value":"A &amp; B"}</pre></body></html>')).toEqual({ value: "A & B" });
    expect(() => decodeJson('<html>no product</html>')).toThrow("invalid JSON");
  });
  it("parses account bootstrap JSON without executing website code", () => {
    const html = '<script>var _pageData = {"isUserLogged":true,"userId":"123","data":{"text":"brace } and \\"quote"}};throw new Error("never execute")</script>';
    expect(accountFromHtml(html)).toEqual({ loggedIn: true, userId: "123" });
    expect(() => accountFromHtml('<script>var _pageData = {"isUserLogged":true}</script>')).toThrow("identity");
    expect(() => accountFromHtml('<h1>Shop</h1>')).toThrow("not recognized");
    expect(assignment('<script>var _pageData = {"isUserLogged":false,"userId":""};</script>', '_pageData')).toMatchObject({ isUserLogged: false });
  });
});

describe("profile ownership", () => {
  it("rejects concurrent owners and persists cursor identity across restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alza-state-test-"));
    const a = new StateStore(dir), b = new StateStore(dir);
    try {
      await a.open();
      await expect(b.open()).rejects.toThrow("Another process");
      const key = a.key;
      await a.close();
      const restarted = new StateStore(dir);
      try { await restarted.open(); expect(restarted.key).toBe(key); } finally { await restarted.close(); }
    } finally { await a.close(); await b.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it("imports only Alza cookies and excludes cross-browser clearance", () => {
    const cookie = { name: 'login', value: 'secret', domain: '.alza.cz', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' };
    const scoped = scopedStorage({ cookies: [cookie, { ...cookie, name: 'cf_clearance' }, { ...cookie, domain: '.other.test' }], origins: [] });
    expect(scoped.cookies.map(c => c.name)).toEqual(['login']);
  });
});

describe("bounded operation scheduling", () => {
  it("serializes jobs and rejects a queued call after five seconds", async () => {
    vi.useFakeTimers();
    const queue = new OperationQueue();
    const a = new Operation('anonymous', 90000), b = new Operation('anonymous', 90000);
    let release!: () => void;
    const first = queue.run(a, () => new Promise<void>(resolve => { release = resolve; }));
    const second = queue.run(b, async () => 'should not run');
    const rejected = expect(second).rejects.toMatchObject({ failure: { code: 'BUSY' } });
    try { await vi.advanceTimersByTimeAsync(5000); await rejected; release(); await first; expect(queue.size).toBe(0); }
    finally { a.dispose(); b.dispose(); vi.useRealTimers(); }
  });
});

it('verifies the expected account and rejects signed-in data in anonymous mode', async () => {
  const { verifyIdentity } = await import('../src/infra/identity.js');
  const account = { version: 1 as const, expectedUserId: '123', generation: 'example', importedAt: '2026-09-26' };
  const page = (logged: boolean, userId: string) => `<script>var _pageData=${JSON.stringify({ isUserLogged: logged, userId })};</script>`;
  expect(verifyIdentity(page(true, '123'), account)).toBe('signed_in');
  expect(() => verifyIdentity(page(true, '456'), account)).toThrow(/different Alza account/);
  expect(() => verifyIdentity(page(false, ''), account)).toThrow(/expired/);
  expect(() => verifyIdentity(page(true, '123'))).toThrow(/anonymous/);
});

it('keeps the previous account when an atomic import cannot replace its manifest', async () => {
  const { mkdir, readFile, readdir } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'alza-import-'));
  const store = new StateStore(dir);
  try {
    await store.open();
    const first = join(dir, 'first'); await mkdir(first);
    await store.commitImport({ cookies: [], origins: [] }, '123', first);
    const before = await readFile(join(dir, 'account.json'), 'utf8');
    // A directory at the temporary manifest path simulates a filesystem failure.
    await mkdir(join(dir, 'account.json.tmp'));
    const second = join(dir, 'second'); await mkdir(second);
    await expect(store.commitImport({ cookies: [], origins: [] }, '456', second)).rejects.toThrow();
    expect(await readFile(join(dir, 'account.json'), 'utf8')).toBe(before);
    expect(store.account?.expectedUserId).toBe('123');
    expect((await readdir(dir)).filter(name => name.startsWith('account-'))).toHaveLength(1);
    expect((await readdir(dir)).filter(name => name.startsWith('session-'))).toHaveLength(1);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
