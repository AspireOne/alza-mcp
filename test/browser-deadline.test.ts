import { expect, it, vi } from 'vitest';
import { chromium, type BrowserContext } from 'patchright';
import { SessionBrowser } from '../src/infra/session-browser.js';
import { configFromEnv } from '../src/infra/config.js';
import { Operation } from '../src/infra/operation.js';
import { StateStore } from '../src/infra/state.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('reports a deadline closing the page during HTML capture as a retryable timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alza-browser-deadline-'));
  vi.useFakeTimers();
  let capture: Promise<string> | undefined;
  let rejectCapture: ((error: Error) => void) | undefined;
  const page = {
    goto: async () => ({ allHeaders: async () => ({}), status: () => 200 }),
    content: async () => capture ?? '<script>var _pageData={"isUserLogged":false};</script>',
    url: () => 'https://www.alza.cz/',
    close: async () => { rejectCapture?.(new Error('Target page has been closed')); },
  };
  vi.spyOn(chromium, 'launchPersistentContext').mockResolvedValue({
    newPage: async () => page, on: () => {}, close: async () => {},
  } as unknown as BrowserContext);
  const browser = new SessionBrowser(configFromEnv({ ALZA_DATA_DIR: dir }), new StateStore(dir));
  const op = new Operation('anonymous', 10_000);
  let dispose: (() => Promise<void>) | undefined;
  try {
    const resource = await browser.reader(op, 'anonymous', Date.now() + 1000);
    dispose = resource.dispose;
    capture = new Promise((_, reject) => { rejectCapture = reject; });
    const result = resource.reader.page('https://www.alza.cz/');
    const assertion = expect(result).rejects.toMatchObject({ failure: { code: 'TIMEOUT', retryable: true } });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  } finally {
    await dispose?.(); await browser.close(); op.dispose();
    vi.restoreAllMocks(); vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  }
});
