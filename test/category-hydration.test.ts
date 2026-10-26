import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionBrowser } from '../src/infra/session-browser.js';
import { StateStore } from '../src/infra/state.js';
import { configFromEnv } from '../src/infra/config.js';
import { Research } from '../src/domain/research.js';
import { Cursors } from '../src/infra/cursor.js';
import type { Access } from '../src/infra/reader.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
};

it('waits for asynchronous navigation tiles before returning a landing category', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alza-category-hydration-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = configFromEnv({ ALZA_DATA_DIR: directory, ALZA_HEADLESS: 'true' });
  const browser = new SessionBrowser(config, new StateStore(directory));
  cleanup.push(() => browser.close());
  const context = await browser.start('anonymous');
  const children = gate(), waiting = gate();
  cleanup.push(async () => { children.resolve(); });
  // TODO: Mock only storefront transport; real Chromium executes the delayed component render.
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).pathname === '/children') {
      await children.promise;
      await route.fulfill({ contentType: 'text/html', body: '<div data-testid="category-tiles"><div data-testid="category-tile"><a href="/18850975.htm">Vysavače</a></div></div>' });
    } else await route.fulfill({ contentType: 'text/html', body: '<script>var _pageData={"isUserLogged":false,"categoryId":1,"data":null};</script><h1>Spotřebiče</h1><div id="tiles" data-testid="component-catalogLocalTitlePage" data-api-url="https://www.alza.cz/api/catalog/v2/homePage/categories/18901355/categories"></div><script>fetch("/children").then(r=>r.text()).then(html=>document.querySelector("#tiles").innerHTML=html)</script>' });
  });
  vi.stubEnv('ALZA_LOG_LEVEL', 'info');
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    const event = JSON.parse(String(chunk));
    if (event.msg === 'step.started' && event.step === 'browser.wait_category') waiting.resolve();
    return true;
  });
  const access: Access = { run: async (op, work) => {
    const resource = await browser.reader(op, 'anonymous', Date.now() + 20_000);
    try { return await work(resource.reader); } finally { await resource.dispose(); }
  }, status: () => ({}), close: () => browser.close() };
  const research = new Research(config, access, new Cursors('x'.repeat(64)));
  let settled = false;
  const result = research.call('get_category', { category_id: 18901355 }).then(value => { settled = true; return value; });
  await waiting.promise;
  expect(settled).toBe(false);
  children.resolve();
  expect(await result).toMatchObject({ status: 'ok', data: { id: 18901355, listing_supported: false, children: [{ id: 18850975, name: 'Vysavače' }] } });
}, 30_000);
