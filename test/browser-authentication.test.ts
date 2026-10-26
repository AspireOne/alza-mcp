import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'patchright';
import { configFromEnv } from '../src/infra/config.js';
import { StateStore } from '../src/infra/state.js';
import { AccessCoordinator } from '../src/infra/access.js';
import { Research } from '../src/domain/research.js';
import { browserCatalog } from '../src/domain/browser-catalog.js';
import { Cursors } from '../src/infra/cursor.js';
import { Operation } from '../src/infra/operation.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function setup(authMode = 'required') {
  const dir = await mkdtemp(join(tmpdir(), 'alza-authentication-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config = configFromEnv({ ALZA_DATA_DIR: dir, ALZA_AUTH_MODE: authMode });
  const store = new StateStore(dir);
  await store.open();
  store.account = { version: 1, expectedUserId: '123', generation: 'bea37cbe-e239-4ee4-a357-05ee7e626a33', importedAt: new Date().toISOString() };
  const state = { loggedIn: true, userId: '123', challenge: false };
  const navigations: string[] = [], closed: string[] = [];
  let jsonReads = 0;
  // TODO: Mock Chromium transport; the real coordinator, account verification, research and cache collaborate below.
  vi.spyOn(chromium, 'launchPersistentContext').mockImplementation(async profile => {
    const anonymous = String(profile).endsWith('/anonymous');
    return {
      newPage: async () => {
        let url = 'about:blank';
        return {
          goto: async (target: string) => { url = target; navigations.push(target); return { status: () => 200, allHeaders: async () => ({}) }; },
          url: () => url,
          content: async () => state.challenge ? '<title>Just a moment...</title><form id="challenge-form"></form>' : `<script>var _pageData=${JSON.stringify({ isUserLogged: !anonymous && state.loggedIn, userId: anonymous ? null : state.userId, categoryId: 42, data: {} })};</script><h1>Category</h1><a data-sort="0"></a>`,
          evaluate: async () => { jsonReads++; return { status: 200, headers: {}, text: '{"answer":42}', url: 'https://webapi.alza.cz/api/catalog/example' }; },
          close: async () => { closed.push(url); },
        };
      }, on: () => {}, close: async () => {},
    } as unknown as BrowserContext;
  });
  const access = new AccessCoordinator(config, store);
  cleanup.push(() => access.close());
  const research = new Research(config, access, browserCatalog, new Cursors(store.key));
  return { access, research, state, navigations, closed, jsonReads: () => jsonReads };
}

it('verifies a fresh target document without a homepage preflight', async () => {
  const h = await setup();
  expect(await h.research.call('get_category', { category_id: 42 })).toMatchObject({ status: 'ok', meta: { auth: { state: 'signed_in' } } });
  expect(h.navigations).toEqual(['https://www.alza.cz/42.htm']);
  expect(h.closed).toEqual(h.navigations);
});

it.each([
  { issue: 'expired', change: { loggedIn: false }, code: 'AUTH_REQUIRED' },
  { issue: 'wrong account', change: { userId: '456' }, code: 'AUTH_ACCOUNT_MISMATCH' },
  { issue: 'unverifiable', change: { userId: 'invalid' }, code: 'AUTH_UNVERIFIED' },
])('rejects a cached result after the session becomes $issue', async ({ change, code }) => {
  const h = await setup();
  expect(await h.research.call('get_category', { category_id: 42 })).toMatchObject({ status: 'ok' });
  Object.assign(h.state, change);
  expect(await h.research.call('get_category', { category_id: 42 })).toMatchObject({ status: 'error', error: { code } });
  expect(h.navigations).toEqual(['https://www.alza.cz/42.htm', 'https://www.alza.cz']);
});

it('checks fresh identity before returning cached data and does not navigate the target again', async () => {
  const h = await setup();
  await h.research.call('get_category', { category_id: 42 });
  expect(await h.research.call('get_category', { category_id: 42 })).toMatchObject({ status: 'ok', meta: { cache: { hit: true }, auth: { state: 'signed_in' } } });
  expect(h.navigations).toEqual(['https://www.alza.cz/42.htm', 'https://www.alza.cz']);
});

it('verifies once before JSON-first reads and does not send them for an expired account', async () => {
  const h = await setup();
  const op = new Operation('required', 10_000);
  try {
    await h.access.run(op, async reader => {
      expect(await reader.json('https://webapi.alza.cz/api/catalog/example')).toEqual({ answer: 42 });
      expect(await reader.json('https://webapi.alza.cz/api/catalog/example')).toEqual({ answer: 42 });
    });
    expect(h.navigations).toEqual(['https://www.alza.cz']);
    expect(h.jsonReads()).toBe(2);
    h.state.loggedIn = false;
    const next = new Operation('required', 10_000);
    try { await expect(h.access.run(next, reader => reader.json('https://webapi.alza.cz/api/catalog/example'))).rejects.toMatchObject({ failure: { code: 'AUTH_REQUIRED' } }); }
    finally { next.dispose(); }
    expect(h.jsonReads()).toBe(2);
  } finally { op.dispose(); }
});

it('retains preferred-auth fallback when lazy target verification discovers an expired account', async () => {
  const h = await setup('preferred');
  h.state.loggedIn = false;
  expect(await h.research.call('get_category', { category_id: 42 })).toMatchObject({ status: 'ok', meta: { auth: { state: 'anonymous', session_issue: { code: 'AUTH_REQUIRED' } }, warnings: [{ code: 'AUTH_REQUIRED' }] } });
  expect(h.navigations).toEqual(['https://www.alza.cz/42.htm', 'https://www.alza.cz/42.htm']);
  expect(h.closed).toHaveLength(2);
});

it('refuses anonymous continuation when lazy verification finds an expired preferred account', async () => {
  const h = await setup('preferred');
  h.state.loggedIn = false;
  const op = new Operation('preferred', 10_000);
  try {
    await expect(h.access.run(op, reader => reader.page('https://www.alza.cz/42.htm'), `account:${h.access.store.account!.generation}`))
      .rejects.toMatchObject({ failure: { code: 'CONTEXT_CHANGED' } });
    expect(h.navigations).toEqual(['https://www.alza.cz/42.htm']);
    expect(h.closed).toHaveLength(1);
  } finally { op.dispose(); }
});
