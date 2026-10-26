import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Research, type ResearchService } from '../src/domain/research.js';
import { apiCatalog } from '../src/domain/api-catalog.js';
import { configFromEnv } from '../src/infra/config.js';
import { Cursors } from '../src/infra/cursor.js';
import { ApiAccess, classifyApiResponse } from '../src/infra/api-access.js';
import { ApiSession } from '../src/infra/api-session.js';
import type { RawResponse, RequestInit, Transport } from '../src/infra/api-transport.js';
import type { StateStore } from '../src/infra/state.js';
import { failureOf } from '../src/infra/failure.js';
import { categoryChildren, parse, variantsSchema, variantsSection } from '../src/adapters/app-api.js';

// Captured app payloads, trimmed to parsed fields; see test/fixtures/README.md.
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/app-api/${name}.json`, import.meta.url), 'utf8'));
const USER_ID = '1000';
const SWITCH = /ALZA_BACKEND=browser/;
const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const token = (expiresInS: number) => jwt({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) + expiresInS });

type Route = (url: URL, init: RequestInit) => Promise<unknown> | unknown;
class FakeTransport implements Transport {
  readonly requests: Array<{ url: URL; init: RequestInit }> = [];
  constructor(private readonly route: Route) {}
  async request(url: string, init: RequestInit): Promise<RawResponse> {
    const parsed = new URL(url); this.requests.push({ url: parsed, init });
    const answer = await this.route(parsed, init);
    const response = answer && typeof answer === 'object' && 'status' in answer ? answer as Omit<RawResponse, 'url' | 'headers'> & { headers?: Record<string, string> } : { status: 200, body: JSON.stringify(answer) };
    return { headers: {}, url, ...response };
  }
  async close() {}
}

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function sessionDir(accessToken = token(3600)) {
  const dir = await mkdtemp(join(tmpdir(), 'alza-api-')); directories.push(dir);
  await writeFile(join(dir, 'api-session.json'), JSON.stringify({ version: 1, generation: crypto.randomUUID(), expectedUserId: USER_ID, visitorId: crypto.randomUUID(), accessToken, refreshToken: 'refresh-1', signedInAt: new Date().toISOString() }));
  return dir;
}

/** Serves the captured fixtures by path; `override` replaces individual responses. */
async function backend(override: Route = () => undefined, signedIn = true) {
  const [product, v14, listing, category, facets] = await Promise.all(['product-13458454', 'product-v14-13458454', 'listing', 'category-18857353', 'facets-18857353'].map(fixture));
  const transport = new FakeTransport(async (url, init) => {
    const custom = await override(url, init);
    if (custom !== undefined) return custom;
    if (url.pathname === '/api/router/legacy/catalog/product/13458454') return product;
    if (url.pathname === '/api/legacy/catalog/v14/product/13458454') return v14;
    if (url.pathname === '/services/restservice.svc/v2/products') return listing;
    if (url.pathname === '/services/restservice.svc/v1/category/18857353') return category;
    if (url.pathname === '/services/restservice.svc/v3/params/18857353') return facets;
    return { status: 404, body: '' };
  });
  const session = signedIn ? await ApiSession.load(await sessionDir(), transport) : undefined;
  const store = { close: async () => {} } as unknown as StateStore;
  const research: ResearchService = new Research(configFromEnv({}), new ApiAccess(configFromEnv({}), store, transport, session), apiCatalog, new Cursors('x'.repeat(64)));
  return { research, transport };
}
const okData = (result: Awaited<ReturnType<ResearchService['call']>>): any => { expect(result).toMatchObject({ status: 'ok' }); return 'data' in result ? result.data : undefined; };

describe('app API response classification', () => {
  it('maps rejections that suggest an Alza-side change to switch-hinted failures', () => {
    const classify = (response: Partial<RawResponse>) => failureOf((() => { try { return classifyApiResponse({ status: 200, headers: {}, body: '', url: '', ...response }); } catch (error) { return error; } })());
    expect(classify({ status: 403 })).toMatchObject({ code: 'API_BLOCKED', message: expect.stringMatching(SWITCH) });
    expect(classify({ status: 400 })).toMatchObject({ code: 'API_REQUEST_REJECTED', message: expect.stringMatching(SWITCH) });
    expect(classify({ body: '<html>' })).toMatchObject({ code: 'SCHEMA_CHANGED', message: expect.stringMatching(SWITCH) });
    expect(classify({ status: 429, headers: { 'retry-after': '5' } })).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retry_after_ms: 5000 });
    expect(classifyApiResponse({ status: 200, headers: {}, body: '{"a":1}', url: '' })).toEqual({ a: 1 });
  });
});

describe('API backend research', () => {
  it('returns signed-in product offers exactly as the app reports them', async () => {
    const h = await backend();
    const data = okData(await h.research.call('get_product', { product_id: 13458454, sections: ['offers', 'attributes', 'variants'], auth: 'required' }));
    expect(data).toMatchObject({ id: 13458454, brand: 'SIEMENS', identifiers: { sku: 'SIEAK712', mpn: 'TP551E19' }, condition: null, availability: 'Skladem > 5 ks' });
    expect(data.sections.offers.data.map((o: any) => [o.kind, o.amount, o.vat, o.promotion?.code ?? o.promotion?.type ?? null])).toEqual([
      ['effective', '12763.75', 'included', null], ['effective', '10549.00', 'excluded', null],
      ['conditional', '10849.00', 'included', 'ALZADNY15'], ['conditional', '9849.00', 'included', 'cashback'], ['reference', '15990.00', 'included', null],
    ]);
    expect(data.sections.offers.data[0].conditions).toEqual(['Benefit Sleva -20 %']);
    expect(data.sections.variants).toEqual({ state: 'not_provided' });
    // The v14 detail must carry the router's account and price-group context.
    const detail = h.transport.requests.find(r => r.url.pathname.includes('/v14/'))!;
    expect(detail.url.searchParams.get('pgrik')).toBe('p_test');
    expect(detail.init.headers?.authorization).toMatch(/^Bearer /);
  });
  it('fails loudly with the backend switch hint when a payload changes shape', async () => {
    const h = await backend(async url => url.pathname.startsWith('/api/router/') ? { ...(await fixture('product-13458454')), data: { id: 13458454 } } : undefined);
    expect(await h.research.call('get_product', { product_id: 13458454, sections: ['offers'] })).toMatchObject({ status: 'error', error: { code: 'SCHEMA_CHANGED', message: expect.stringMatching(SWITCH) } });
  });
  it('rejects answers for another account', async () => {
    const h = await backend(async url => url.pathname.startsWith('/api/router/') ? { ...(await fixture('product-13458454')), user_id: 2000 } : undefined);
    expect(await h.research.call('get_product', { product_id: 13458454, sections: ['offers'] })).toMatchObject({ status: 'error', error: { code: 'AUTH_ACCOUNT_MISMATCH' } });
  });
  it('falls back to public prices only when the account is preferred', async () => {
    // Alza answers every router request as an anonymous visitor, as it does after a token is revoked.
    const h = await backend(async url => url.pathname.startsWith('/api/router/') ? { ...(await fixture('product-13458454')), user_id: -1 } : undefined);
    const preferred = await h.research.call('get_product', { product_id: 13458454, sections: ['offers'] });
    expect(preferred).toMatchObject({ status: 'ok', meta: { auth: { state: 'anonymous', session_issue: { code: 'AUTH_REQUIRED' } }, warnings: [{ code: 'AUTH_REQUIRED' }] } });
    expect(h.transport.requests.at(-1)!.init.headers?.authorization).toBeUndefined();
    expect(await h.research.call('get_product', { product_id: 13458454, sections: ['offers'], auth: 'required' })).toMatchObject({ status: 'error', error: { code: 'AUTH_REQUIRED' } });
    expect(await (await backend(undefined, false)).research.call('get_product', { product_id: 13458454, auth: 'required' })).toMatchObject({ status: 'error', error: { code: 'AUTH_NOT_CONFIGURED' } });
  });
  it('sends validated category filters in the app format and links the matching website listing', async () => {
    const h = await backend(), producer = (await fixture('facets-18857353')).producers[0].v;
    const data = okData(await h.research.call('search_products', {
      category_id: 18857353, sort: 'price_asc',
      filters: { in_stock: true, condition: ['used'], min_price: 5000, manufacturers: [producer], facets: [{ id: 17767, values: ['17767-239717689'] }, { id: 30598, from: 2 }] },
    }));
    const body = h.transport.requests.find(r => r.url.pathname.endsWith('/v2/products'))!.init.body!;
    expect(JSON.parse(body).filterParameters).toMatchObject({
      id: 18857353, type: 'CATEGORY', orderBy: 1, page: 1, availabilityType: 1, commodityWears: [1, 3], minPrice: 5000, maxPrice: null, producers: [producer],
      params: [{ tId: 17767, v: [239717689], vFrom: null, vTo: null }, { tId: 30598, v: [], vFrom: 2, vTo: 3 }],
    });
    expect(data.effective_url).toBe(`https://www.alza.cz/automaticke-kavovary/18857353.htm#f&limit=5000---1&availabilityFilterValue=1&cst=1,3&cud=0&pg=1&pn=1&prod=${producer}&par17767=17767-239717689&par30598=2--3`);
    expect(data.products[0]).toMatchObject({ id: 13348053, offers: [{ kind: 'effective', amount: '6999.00' }, { kind: 'conditional', amount: '5599.00', promotion: { type: 'coupon', code: 'ALZADNY20' } }] });
    expect(await h.research.call('search_products', { category_id: 18857353, filters: { facets: [{ id: 17767, values: ['17767-1'] }] } })).toMatchObject({ status: 'error', error: { code: 'UNSUPPORTED_FILTER' } });
  });
  it('reports hubs and category-scoped text search explicitly', async () => {
    const h = await backend(async url => url.pathname.endsWith('/v1/category/18857353') ? { ...(await fixture('category-18857353')), ltp: true } : undefined);
    expect(await h.research.call('search_products', { category_id: 18857353 })).toMatchObject({ status: 'error', error: { code: 'CATEGORY_NOT_LISTABLE', suggested_categories: expect.arrayContaining([expect.objectContaining({ id: expect.any(Number) })]) } });
    expect(await h.research.call('search_products', { query: 'kávovar', category_id: 18857353 })).toMatchObject({ status: 'error', error: { code: 'UNSUPPORTED_FILTER' } });
    expect(h.transport.requests.some(r => r.url.pathname.endsWith('/v2/products'))).toBe(false);
  });
});

describe('app API mappings', () => {
  it('links parameter, condition and product-line variants to their product IDs', async () => {
    const section = variantsSection(parse(variantsSchema, await fixture('variants'), 'variants')) as any;
    expect(section.data.groups.map((g: any) => [g.kind, g.label, g.options.map((o: any) => [o.product_id, o.selected])])).toEqual([
      ['parameter', 'Velikost', [[7191519, true], [12662568, false]]],
      ['condition', null, [[9682835, false], [12298425, false], [12381430, true]]],
      ['product_line', 'KRUPS Serenity', [[13348053, true], [13348054, false]]],
    ]);
  });
  it('takes category IDs from navigation URLs rather than alias node IDs', () => {
    expect(categoryChildren([
      { id: 18901308, name: 'Zrnková káva', cat_type: 'CATEGORY', url: 'https://www.alza.cz/zrnkova-kava/18862971.htm' },
      { id: 0, name: 'Alza dny', cat_type: 'BOOST', url: null },
      { id: 18872611, name: "De'Longhi", cat_type: 'PRODUCER', url: 'https://www.alza.cz/automaticke-kavovary/delonghi/18857353-v8445.htm' },
    ], ['CATEGORY'])).toEqual([{ id: 18862971, name: 'Zrnková káva', url: 'https://www.alza.cz/zrnkova-kava/18862971.htm' }]);
  });
});

describe('API session', () => {
  const tokenEndpoint = (respond: () => unknown) => new FakeTransport(async url => { expect(url.pathname).toBe('/connect/token'); return respond(); });
  it('refreshes once for concurrent callers and persists the rotated token before use', async () => {
    const dir = await sessionDir(token(-10)), next = token(3600);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const transport = tokenEndpoint(async () => { await gate; return { access_token: next, refresh_token: 'refresh-2' }; });
    const session = (await ApiSession.load(dir, transport))!;
    const pending = Promise.all([session.accessToken(), session.accessToken()]); release();
    expect(await pending).toEqual([next, next]);
    expect(transport.requests).toHaveLength(1);
    expect(new URLSearchParams(transport.requests[0]!.init.body).get('refresh_token')).toBe('refresh-1');
    expect(JSON.parse(await readFile(join(dir, 'api-session.json'), 'utf8'))).toMatchObject({ accessToken: next, refreshToken: 'refresh-2' });
  });
  it('separates an expired grant from a rejected app client', async () => {
    const refresh = async (body: unknown, status = 400) => failureOf(await (await ApiSession.load(await sessionDir(token(-10)), tokenEndpoint(() => ({ status, body: JSON.stringify(body) }))))!.accessToken().catch(error => error));
    expect(await refresh({ error: 'invalid_grant' })).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await refresh({ error: 'invalid_client' })).toMatchObject({ code: 'API_CLIENT_REJECTED', message: expect.stringMatching(SWITCH) });
    expect(await refresh({ access_token: jwt({ sub: '2000', exp: 9e9 }) }, 200)).toMatchObject({ code: 'AUTH_ACCOUNT_MISMATCH' });
  });
});
