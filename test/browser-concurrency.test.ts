import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'patchright';
import { configFromEnv } from '../src/infra/config.js';
import { StateStore } from '../src/infra/state.js';
import { AccessCoordinator } from '../src/infra/access.js';
import { Research } from '../src/domain/research.js';
import { Cursors } from '../src/infra/cursor.js';
import { Operation } from '../src/infra/operation.js';
import { parseProduct } from '../src/adapters/product.js';

type Kind = 'account' | 'anonymous';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'alza-concurrent-browser-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = configFromEnv({ ALZA_DATA_DIR: directory, ALZA_AUTH_MODE: 'required', ALZA_HEADLESS: 'true' });
  const store = new StateStore(directory);
  await store.open();
  store.account = { version: 1, expectedUserId: '123', generation: 'bea37cbe-e239-4ee4-a357-05ee7e626a33', importedAt: '2026-10-26T00:00:00Z' };
  const contexts: Array<{ kind: Kind; context: BrowserContext }> = [];
  const holds = new Map<string, { arrived: ReturnType<typeof gate>; finish: ReturnType<typeof gate> }>();
  const launch = chromium.launchPersistentContext.bind(chromium);
  // TODO: Mock only storefront transport; Chromium, leases, identity, coordinator and parsers remain real.
  vi.spyOn(chromium, 'launchPersistentContext').mockImplementation(async (profile, options) => {
    const kind: Kind = String(profile).endsWith('/anonymous') ? 'anonymous' : 'account';
    const context = await launch(profile, options);
    contexts.push({ kind, context });
    await context.route('**/*', async route => {
      const id = Number(new URL(route.request().url()).pathname.match(/-d(\d+)\.htm/)?.[1] ?? 0);
      const hold = holds.get(`${kind}:${id}`);
      if (hold) { hold.arrived.release(); await hold.finish.promise; }
      const amount = (kind === 'account' ? 100 : 200) + id;
      await route.fulfill({ contentType: 'text/html', body: `<script>var _pageData=${JSON.stringify({ isUserLogged: kind === 'account', userId: kind === 'account' ? '123' : null, data: { cid: id } })};</script><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: `Product ${id}`, offers: { price: amount, priceCurrency: 'CZK' } })}</script>` }).catch(() => {});
    });
    return context;
  });
  const access = new AccessCoordinator(config, store);
  cleanup.push(() => access.close());
  const resources: Array<{ dispose: () => Promise<void> }> = [];
  const operations: Operation[] = [];
  cleanup.push(async () => {
    holds.forEach(hold => hold.finish.release());
    await Promise.all(resources.map(resource => resource.dispose()));
    operations.forEach(op => op.dispose());
  });
  const research = new Research(config, access, new Cursors(store.key));
  const hold = (kind: Kind, id: number) => {
    const held = { arrived: gate(), finish: gate() };
    holds.set(`${kind}:${id}`, held);
    return held;
  };
  const open = async (kind: Kind = 'account', parent?: AbortSignal, deadline = Date.now() + 20_000) => {
    const op = new Operation(kind === 'account' ? 'required' : 'anonymous', 30_000, parent);
    operations.push(op);
    const resource = await access.browser.reader(op, kind, deadline);
    resources.push(resource);
    return { ...resource, op };
  };
  return { access, research, contexts, hold, open };
}

it('launches one cold account browser for overlapping requests and keeps product offers isolated', async () => {
  const h = await setup(), first = h.hold('account', 41), second = h.hold('account', 42);
  const a = h.research.call('get_product', { product_id: 41, sections: ['offers'] });
  const b = h.research.call('get_product', { product_id: 42, sections: ['offers'] });
  await Promise.all([first.arrived.promise, second.arrived.promise]);
  expect(h.contexts).toHaveLength(1);
  expect(h.access.browser.status()).toMatchObject({ active_readers: 2 });
  second.finish.release();
  expect(await b).toMatchObject({ status: 'ok', meta: { auth: { state: 'signed_in' } }, data: { id: 42, sections: { offers: { data: [{ amount: '142.00', kind: 'effective' }] } } } });
  first.finish.release();
  expect(await a).toMatchObject({ status: 'ok', meta: { auth: { state: 'signed_in' } }, data: { id: 41, sections: { offers: { data: [{ amount: '141.00', kind: 'effective' }] } } } });
  expect(h.access.browser.status()).toMatchObject({ active_readers: 0 });
}, 30_000);

it('releases both leases after a shared startup failure and can start again', async () => {
  const h = await setup();
  vi.mocked(chromium.launchPersistentContext).mockRejectedValueOnce(new Error('Chromium startup failed'));
  const results = await Promise.all([
    h.research.call('get_product', { product_id: 41, sections: ['offers'] }),
    h.research.call('get_product', { product_id: 42, sections: ['offers'] }),
  ]);
  expect(results).toMatchObject([
    { status: 'error', error: { code: 'BROWSER_UNAVAILABLE' } },
    { status: 'error', error: { code: 'BROWSER_UNAVAILABLE' } },
  ]);
  expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(1);
  expect(h.access.browser.status()).toMatchObject({ active_readers: 0 });
  expect(await h.research.call('get_product', { product_id: 42, sections: ['offers'] })).toMatchObject({ status: 'ok', meta: { auth: { state: 'signed_in' } } });
}, 30_000);

it('keeps anonymous and signed-in requests in separate persistent contexts without closing a peer', async () => {
  const h = await setup(), account = h.hold('account', 42), anonymous = h.hold('anonymous', 42);
  const signed = h.research.call('get_product', { product_id: 42, sections: ['offers'], auth: 'required' });
  const publicPrice = h.research.call('get_product', { product_id: 42, sections: ['offers'], auth: 'anonymous' });
  await Promise.all([account.arrived.promise, anonymous.arrived.promise]);
  expect(h.contexts.map(entry => entry.kind).sort()).toEqual(['account', 'anonymous']);
  anonymous.finish.release();
  expect(await publicPrice).toMatchObject({ status: 'ok', meta: { auth: { state: 'anonymous' } }, data: { sections: { offers: { data: [{ amount: '242.00', kind: 'public' }] } } } });
  account.finish.release();
  expect(await signed).toMatchObject({ status: 'ok', meta: { auth: { state: 'signed_in' } }, data: { sections: { offers: { data: [{ amount: '142.00', kind: 'effective' }] } } } });
  expect(h.access.browser.status()).toMatchObject({ running: true, active_readers: 0, profiles: expect.arrayContaining(['account', 'anonymous']) });
}, 30_000);

it('cancels only the owning page while a peer navigation completes with verified account pricing', async () => {
  const h = await setup(), parent = new AbortController();
  const a = await h.open('account', parent.signal), b = await h.open();
  const first = h.hold('account', 41), second = h.hold('account', 42);
  const cancelled = a.reader.page('https://www.alza.cz/product-d41.htm');
  const rejected = expect(cancelled).rejects.toMatchObject({ failure: { code: 'CANCELLED' } });
  const successful = b.reader.page('https://www.alza.cz/product-d42.htm');
  await Promise.all([first.arrived.promise, second.arrived.promise]);
  parent.abort(); await rejected; await a.dispose(); await a.dispose();
  expect(h.access.browser.status()).toMatchObject({ active_readers: 1 });
  second.finish.release();
  const doc = await successful;
  expect(parseProduct(doc.html, doc.url, 42, b.op.meta.auth.state === 'signed_in', ['offers'])).toMatchObject({ id: 42, sections: { offers: { data: [{ amount: '142.00', kind: 'effective' }] } } });
  expect(b.op.meta.auth.state).toBe('signed_in');
  expect(h.contexts).toHaveLength(1);
}, 30_000);

it('drains existing leases, bounds waiting admission and reopens a verified account context after close', async () => {
  const h = await setup(), a = await h.open(), b = await h.open();
  await a.reader.page('https://www.alza.cz/product-d41.htm');
  await a.dispose(); await a.dispose();
  let closed = false;
  const closing = h.access.browser.close().then(() => { closed = true; });
  const parent = new AbortController();
  const rejected = expect(h.open('account', parent.signal)).rejects.toMatchObject({ failure: { code: 'CANCELLED' } });
  parent.abort(); await rejected;
  await expect(h.open('account', undefined, Date.now() - 1)).rejects.toMatchObject({ failure: { code: 'TIMEOUT' } });
  expect(h.contexts).toHaveLength(1);
  expect(closed).toBe(false);
  expect(h.access.browser.status()).toMatchObject({ active_readers: 1 });
  await b.reader.page('https://www.alza.cz/product-d42.htm');
  expect(b.op.meta.auth.state).toBe('signed_in');
  await b.dispose(); await closing;
  expect(h.access.browser.status()).toMatchObject({ running: false, active_readers: 0 });
  const reopened = await h.open();
  await reopened.reader.page('https://www.alza.cz/product-d43.htm');
  expect(reopened.op.meta.auth.state).toBe('signed_in');
  expect(h.contexts).toHaveLength(2);
}, 30_000);

it('serializes variant interaction and page creation while allowing a peer navigation to overlap', async () => {
  const h = await setup(), a = await h.open(), b = await h.open();
  const context = h.contexts[0]!.context;
  const firstOptions = gate(), finishOptions = gate(), peerNavigated = gate(), bothQueued = gate();
  cleanup.push(async () => { finishOptions.release(); });
  const menus: number[] = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/options') {
      const id = Number(url.searchParams.get('id'));
      menus.push(id);
      if (id === 41) { firstOptions.release(); await finishOptions.promise; }
      await route.fulfill({ contentType: 'text/html', body: '<div role="listbox"><div role="option" aria-selected="true">Black</div></div>' }).catch(() => {});
      return;
    }
    const id = Number(url.pathname.match(/-d(\d+)\.htm/)?.[1]);
    if (id === 42) peerNavigated.release();
    await route.fulfill({ contentType: 'text/html', body: `<script>var _pageData={"isUserLogged":true,"userId":"123","data":{"cid":${id}}};</script><script type="application/ld+json">{"@type":"Product","name":"Product ${id}"}</script><button data-testid="detailVariantSelectComponentOpenOptionsButton" onclick="fetch('/options?id=${id}').then(response=>response.text()).then(html=>document.querySelector('#options').innerHTML=html)">Colour</button><div id="options"></div>` });
  });
  vi.stubEnv('ALZA_LOG_LEVEL', 'info');
  let queued = 0;
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    const event = JSON.parse(String(chunk));
    if (event.msg === 'step.started' && event.step === 'queue.wait' && event.queue === 'interaction') {
      queued++;
      if (queued === 2) bothQueued.release();
    }
    return true;
  });

  const first = a.reader.page('https://www.alza.cz/product-d41.htm', { detail: ['variants'] });
  await firstOptions.promise;
  const second = b.reader.page('https://www.alza.cz/product-d42.htm', { detail: ['variants'] });
  await peerNavigated.promise;
  const pageCount = context.pages().length;
  const third = h.open();
  await bothQueued.promise;
  expect(menus).toEqual([41]);
  expect(context.pages()).toHaveLength(pageCount);
  finishOptions.release();
  const [firstDoc, secondDoc] = await Promise.all([first, second]);
  await third;
  for (const [doc, id] of [[firstDoc, 41], [secondDoc, 42]] as const) {
    expect(parseProduct(doc.html, doc.url, id, true, ['variants'])).toMatchObject({ sections: { variants: { state: 'available', data: { groups: [{ label: 'Colour', options: [{ label: 'Black', selected: true }] }] } } } });
  }
  expect(menus).toEqual([41, 42]);
  expect(context.pages()).toHaveLength(pageCount + 1);
}, 30_000);
