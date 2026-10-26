import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type BrowserContext } from 'patchright';
import { SessionBrowser } from '../src/infra/session-browser.js';
import { StateStore } from '../src/infra/state.js';
import { configFromEnv } from '../src/infra/config.js';
import { Operation } from '../src/infra/operation.js';

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
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'alza-shared-launch-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const started = gate(), ready = gate();
  let url = 'about:blank';
  // TODO: Mock only Chromium startup to control independent caller deadlines.
  const context = {
    on: () => {}, close: vi.fn(async () => {}),
    newPage: vi.fn(async () => ({
      goto: async (target: string) => { url = target; return { status: () => 200, allHeaders: async () => ({}) }; },
      url: () => url, content: async () => '<script>var _pageData={"isUserLogged":false};</script>', close: async () => {},
    })),
  };
  vi.spyOn(chromium, 'launchPersistentContext').mockImplementation((_, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Launch timeout')), options?.timeout ?? 30_000);
    started.release();
    ready.promise.then(() => { clearTimeout(timer); resolve(context as unknown as BrowserContext); });
  }));
  const browser = new SessionBrowser(configFromEnv({ ALZA_DATA_DIR: directory }), new StateStore(directory));
  cleanup.push(() => browser.close());
  cleanup.push(async () => { ready.release(); });
  return { browser, started, ready, context };
}

it('expires a short-budget launch leader without failing a healthy follower', async () => {
  const h = await setup();
  vi.useFakeTimers();
  const first = new Operation('anonymous', 10_000), second = new Operation('anonymous', 10_000);
  let resource: Awaited<ReturnType<SessionBrowser['reader']>> | undefined;
  try {
    const leader = h.browser.reader(first, 'anonymous', Date.now() + 50);
    const rejected = expect(leader).rejects.toMatchObject({ failure: { code: 'TIMEOUT' } });
    await h.started.promise;
    const follower = h.browser.reader(second, 'anonymous', Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    h.ready.release();
    resource = await follower;
    await resource.reader.page('https://www.alza.cz');
    expect(second.meta.auth.state).toBe('anonymous');
    expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(h.browser.status()).toMatchObject({ active_readers: 1 });
  } finally { h.ready.release(); await resource?.dispose(); first.dispose(); second.dispose(); }
});

it('waits for and closes a shared launch after its only caller cancels', async () => {
  const h = await setup(), parent = new AbortController(), op = new Operation('anonymous', 10_000, parent.signal);
  try {
    const pending = h.browser.reader(op, 'anonymous', Date.now() + 10_000);
    const rejected = expect(pending).rejects.toMatchObject({ failure: { code: 'CANCELLED' } });
    await h.started.promise;
    parent.abort(); await rejected;
    expect(h.browser.status()).toMatchObject({ active_readers: 0 });
    const closing = h.browser.close();
    expect(h.context.close).not.toHaveBeenCalled();
    h.ready.release(); await closing;
    expect(h.context.close).toHaveBeenCalledTimes(1);
    expect(h.context.newPage).not.toHaveBeenCalled();
    expect(h.browser.status()).toMatchObject({ running: false });
  } finally { h.ready.release(); op.dispose(); }
});
