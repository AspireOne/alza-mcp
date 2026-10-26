import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'patchright';
import { AccessCoordinator } from '../src/infra/access.js';
import { configFromEnv } from '../src/infra/config.js';
import { StateStore } from '../src/infra/state.js';
import { Operation } from '../src/infra/operation.js';
import { Research } from '../src/domain/research.js';
import { Cursors } from '../src/infra/cursor.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.useRealTimers(); }
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function setup(timeout = '100', concurrency = '2') {
  const directory = await mkdtemp(join(tmpdir(), 'alza-idle-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = configFromEnv({ ALZA_DATA_DIR: directory, ALZA_BROWSER_IDLE_TIMEOUT_MS: timeout, ALZA_BROWSER_CONCURRENCY: concurrency });
  const store = new StateStore(directory);
  await store.open();
  const closed = vi.fn(async () => {});
  // TODO: Mock Chromium's boundary to gate launch/close independently of request activity.
  const launch = vi.spyOn(chromium, 'launchPersistentContext').mockImplementation(async () => {
    let onClose = () => {};
    return {
      on: (_event: string, listener: () => void) => { onClose = listener; },
      close: async () => { await closed(); onClose(); },
      newPage: async () => ({ close: async () => {} }),
    } as unknown as BrowserContext;
  });
  const access = new AccessCoordinator(config, store);
  cleanup.push(() => access.close());
  const run = <T>(work: () => Promise<T> = async () => 42 as T, signal?: AbortSignal) => {
    const op = new Operation('anonymous', 120_000, signal);
    return access.run(op, work).finally(() => op.dispose());
  };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  return { access, config, store, run, closed, launch };
}

it('validates the idle timeout and defaults to one hour', () => {
  expect(configFromEnv({}).browserIdleTimeoutMs).toBe(3_600_000);
  expect(configFromEnv({ ALZA_BROWSER_IDLE_TIMEOUT_MS: '0' }).browserIdleTimeoutMs).toBe(0);
  expect(configFromEnv({ ALZA_BROWSER_IDLE_TIMEOUT_MS: '2147483647' }).browserIdleTimeoutMs).toBe(2_147_483_647);
  for (const value of ['', '-1', '1.5', 'NaN', 'Infinity', '1e3', ' 100', '2147483648']) {
    expect(() => configFromEnv({ ALZA_BROWSER_IDLE_TIMEOUT_MS: value })).toThrow('ALZA_BROWSER_IDLE_TIMEOUT_MS');
  }
});

it('resets inactivity on research, ignores status polling, and reopens after eviction', async () => {
  const h = await setup();
  await h.run();
  await vi.advanceTimersByTimeAsync(99);
  expect(h.closed).not.toHaveBeenCalled();
  await h.run();
  await vi.advanceTimersByTimeAsync(99);
  const research = new Research(h.config, h.access, new Cursors(h.store.key));
  expect(await research.call('get_session_status', {})).toMatchObject({ status: 'ok', data: { browser: { running: true } } });
  expect(h.closed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.closed).toHaveBeenCalledTimes(1);
  expect(h.access.status()).toMatchObject({ browser: { running: false } });
  await Promise.all([h.run(), h.run()]);
  expect(h.launch).toHaveBeenCalledTimes(2);
  expect(h.access.status()).toMatchObject({ browser: { running: true } });
});

it('keeps the browser while active and queued requests span the timeout', async () => {
  const h = await setup('100', '1'), firstEntered = gate(), firstFinish = gate(), secondEntered = gate(), secondFinish = gate();
  cleanup.push(async () => { firstFinish.release(); secondFinish.release(); });
  const first = h.run(async () => { firstEntered.release(); await firstFinish.promise; });
  await firstEntered.promise;
  const second = h.run(async () => { secondEntered.release(); await secondFinish.promise; });
  await vi.advanceTimersByTimeAsync(200);
  expect(h.closed).not.toHaveBeenCalled();
  firstFinish.release(); await first; await secondEntered.promise;
  await vi.advanceTimersByTimeAsync(200);
  expect(h.closed).not.toHaveBeenCalled();
  secondFinish.release(); await second;
  await vi.advanceTimersByTimeAsync(100);
  expect(h.closed).toHaveBeenCalledTimes(1);
});

it('waits for an idle close before admitting returning readers and shares their launch', async () => {
  const h = await setup(), closing = gate(), finish = gate(), entered = gate();
  cleanup.push(async () => { finish.release(); });
  await h.run();
  h.closed.mockImplementationOnce(async () => { closing.release(); await finish.promise; });
  await vi.advanceTimersByTimeAsync(100); await closing.promise;
  const a = h.run(async () => { entered.release(); return 1; }), b = h.run(async () => 2);
  await vi.advanceTimersByTimeAsync(200);
  expect(h.launch).toHaveBeenCalledTimes(1);
  finish.release();
  expect(await Promise.all([a, b])).toEqual([1, 2]);
  await entered.promise;
  expect(h.launch).toHaveBeenCalledTimes(2);
});

it('does not create an idle timer when disabled or after application shutdown', async () => {
  const disabled = await setup('0');
  await disabled.run(); await vi.advanceTimersByTimeAsync(10_000);
  expect(disabled.closed).not.toHaveBeenCalled();
  const enabled = await setup();
  await enabled.run(); await enabled.access.close();
  await vi.advanceTimersByTimeAsync(200);
  expect(enabled.closed).toHaveBeenCalledTimes(1);
});

it('logs a failed idle close and retains the context for a later clean shutdown', async () => {
  const h = await setup();
  const records: Array<Record<string, unknown>> = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { records.push(JSON.parse(String(chunk))); return true; });
  await h.run();
  h.closed.mockRejectedValueOnce(new Error('close failed'));
  await vi.advanceTimersByTimeAsync(100);
  expect(records.some(r => r.msg === 'browser.idle_close.failed')).toBe(true);
  expect(records.some(r => r.msg === 'browser.idle_close.completed')).toBe(false);
  expect(h.access.status()).toMatchObject({ browser: { running: true } });
  await h.access.close();
  expect(h.closed).toHaveBeenCalledTimes(2);
  expect(h.access.status()).toMatchObject({ browser: { running: false } });
});

it('evicts a late shared launch after its only request cancels', async () => {
  const h = await setup(), launched = gate(), finish = gate(), parent = new AbortController();
  cleanup.push(async () => { finish.release(); });
  const original = h.launch.getMockImplementation()!;
  h.launch.mockImplementationOnce(async (...args) => { launched.release(); await finish.promise; return original(...args); });
  const pending = h.run(undefined, parent.signal);
  const rejected = expect(pending).rejects.toMatchObject({ failure: { code: 'CANCELLED' } });
  await launched.promise; parent.abort(); await rejected;
  await vi.advanceTimersByTimeAsync(100);
  expect(h.closed).not.toHaveBeenCalled();
  finish.release();
  await h.access.browser.close();
  expect(h.closed).toHaveBeenCalledTimes(1);
  expect(h.access.status()).toMatchObject({ browser: { running: false } });
});

it('evicts both managed profiles together', async () => {
  const h = await setup();
  await h.run();
  await h.access.browser.start('account');
  expect(h.access.status()).toMatchObject({ browser: { profiles: ['anonymous', 'account'] } });
  await vi.advanceTimersByTimeAsync(100);
  expect(h.closed).toHaveBeenCalledTimes(2);
  expect(h.access.status()).toMatchObject({ browser: { running: false, profiles: [] } });
});

it('preserves real Chromium cookies and local storage across idle eviction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alza-idle-persistence-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = configFromEnv({ ALZA_DATA_DIR: directory, ALZA_HEADLESS: 'true', ALZA_BROWSER_IDLE_TIMEOUT_MS: '250' });
  const store = new StateStore(directory);
  await store.open();
  const access = new AccessCoordinator(config, store);
  cleanup.push(() => access.close());
  const evicted = gate();
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    if (JSON.parse(String(chunk)).msg === 'browser.idle_close.completed') evicted.release();
    return true;
  });
  const contexts: BrowserContext[] = [];
  const launch = chromium.launchPersistentContext.bind(chromium);
  // TODO: Mock storefront transport only; profile persistence and browser lifecycle remain real.
  vi.spyOn(chromium, 'launchPersistentContext').mockImplementation(async (...args) => {
    const context = await launch(...args);
    contexts.push(context);
    await context.route('https://www.alza.cz/**', route => route.fulfill({ contentType: 'text/html', body: '<script>var _pageData={"isUserLogged":false};</script>' }));
    return context;
  });
  const key = store.key;
  const visit = async (seed: boolean) => {
    const op = new Operation('anonymous', 15_000);
    try {
      return await access.run(op, async reader => {
        await reader.page('https://www.alza.cz/');
        const context = contexts.at(-1)!;
        const page = context.pages().find(page => page.url() === 'https://www.alza.cz/')!;
        if (seed) {
          await context.addCookies([{ name: 'idle-test', value: 'persisted', domain: 'www.alza.cz', path: '/', secure: true, expires: Math.floor(Date.now() / 1000) + 3600 }]);
          await page.evaluate(() => localStorage.setItem('idle-test', 'persisted'));
        }
        return { cookie: (await context.cookies()).find(cookie => cookie.name === 'idle-test')?.value, storage: await page.evaluate(() => localStorage.getItem('idle-test')) };
      });
    } finally { op.dispose(); }
  };
  expect(await visit(true)).toEqual({ cookie: 'persisted', storage: 'persisted' });
  await evicted.promise;
  expect(access.status()).toMatchObject({ browser: { running: false } });
  expect(await visit(false)).toEqual({ cookie: 'persisted', storage: 'persisted' });
  expect(contexts).toHaveLength(2);
  expect(store.key).toBe(key);
}, 20_000);

it('joins an idle close already in progress during application shutdown', async () => {
  const h = await setup(), closing = gate(), finish = gate();
  cleanup.push(async () => { finish.release(); });
  await h.run();
  h.closed.mockImplementationOnce(async () => { closing.release(); await finish.promise; });
  await vi.advanceTimersByTimeAsync(100); await closing.promise;
  let stopped = false;
  const shutdown = h.access.close().then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(100);
  expect(stopped).toBe(false);
  expect(h.closed).toHaveBeenCalledTimes(1);
  finish.release(); await shutdown;
  expect(stopped).toBe(true);
  expect(h.closed).toHaveBeenCalledTimes(1);
});
