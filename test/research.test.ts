import { describe, expect, it } from 'vitest';
import { Research } from '../src/domain/research.js';
import { configFromEnv } from '../src/infra/config.js';
import { Cursors } from '../src/infra/cursor.js';
import type { Access, Reader } from '../src/infra/reader.js';
import type { Operation } from '../src/infra/operation.js';
import { fail } from '../src/infra/failure.js';
import { parseProduct } from '../src/adapters/product.js';
import { parseReviews } from '../src/adapters/reviews.js';
import { money } from '../src/adapters/listings.js';
import { filterRequest, categories, parseRenderedSearch } from '../src/adapters/catalog.js';

const bootstrap = '<script>var _pageData = {"isUserLogged":false,"categoryId":18845887,"configurationId":3,"data":{"categoryTypeId":1,"searchTerm":"disk"}};</script><a data-sort="0"></a><a data-sort="1"></a>';
const card = (id: number) => `<div class="browsingitem" data-id="${id}" data-code="shared"><a class="name" href="/disk-d${id}.htm">Disk ${id}</a><div class="price"><span class="js-price-box__primary-price__value">1 234,-</span></div></div>`;
function harness(pages: Array<{ ids: number[]; total: number; next: boolean }>, html = bootstrap) {
  let authenticated = true, checks = 0; const requests: unknown[] = [], pageOptions: Array<{ detail?: boolean; stock?: boolean } | undefined> = [];
  const reader: Reader = { provider: 'browser', canPost: true, context: 'account:example', page: async (url, options) => { pageOptions.push(options); return { url, html, status: 200, headers: {} }; }, json: async (_, body) => {
    requests.push(body); const i = (body as {page: number}).page - 1, p = pages[i]!;
    return { d: { Count: p.total, Page: i + 1, Boxes: p.ids.map(card).join(''), PagerBottom: p.next ? '<a class="next"></a>' : '' } };
  } };
  const access: Access = { run: async <T>(op: Operation, work: (r: Reader) => Promise<T>, context?: string) => { checks++; if (context && context !== reader.context) fail('CONTEXT_CHANGED', 'changed'); if (!authenticated) fail('AUTH_REQUIRED', 'expired'); op.meta.auth.state = 'signed_in'; return work(reader); }, status: () => ({}), close: async () => {} };
  return { research: new Research(configFromEnv({}), access, new Cursors('x'.repeat(64))), requests, pageOptions, expire: () => { authenticated = false; }, checks: () => checks };
}
const okData = (result: Awaited<ReturnType<Research['call']>>): any => { expect(result.status).not.toBe('error'); return 'data' in result ? result.data : undefined; };

describe('research traversal contracts', () => {
  it('accepts a confirmed empty search even when Alza omits sorting controls', async () => {
    const h = harness([], '<script>var _pageData={"isUserLogged":false,"categoryId":1,"data":{"isSearch":true,"isEmpty":true,"searchTerm":"unmatched"}};</script>');
    expect(await h.research.call('search_products', { query: 'unmatched' })).toMatchObject({ status: 'ok', data: { products: [], total: 0, sort_orders: [], exhausted: true, next_cursor: null } });
    expect(h.requests).toHaveLength(0);
  });
  it('retrieves every page, binds filters and auth, and proves exhaustion against total', async () => {
    const h = harness([{ ids: [1, 2], total: 3, next: true }, { ids: [3], total: 3, next: false }]);
    const first = await h.research.call('search_products', { category_id: 18845887, filters: { max_price: 4000 }, sort: 'price_asc', auth: 'required' });
    expect(first.status).toBe('ok'); const a = okData(first);
    expect(a.sort_orders).toEqual(['relevance', 'price_asc']);
    const second = await h.research.call('search_products', { cursor: a.next_cursor }); const b = okData(second);
    expect(b.products.map((p: any) => p.id)).toEqual([3]); expect(b.exhausted).toBe(true); expect(b.next_cursor).toBeNull();
    expect(h.requests).toMatchObject([{ page: 1, maxPrice: 4000, sort: 1 }, { page: 2, maxPrice: 4000, sort: 1 }]);
    expect(second.meta.auth.requested).toBe('required');
    expect(await h.research.call('search_products', { cursor: a.next_cursor, auth: 'anonymous' })).toMatchObject({ status: 'error', error: { code: 'CONTEXT_CHANGED' } });
  });
  it('returns useful partial data without claiming completion when counts change or pages repeat', async () => {
    const h = harness([{ ids: [1, 2], total: 4, next: true }, { ids: [2, 3], total: 3, next: false }]);
    const first = okData(await h.research.call('search_products', { query: 'disk' }));
    const result = await h.research.call('search_products', { cursor: first.next_cursor });
    expect(result).toMatchObject({ status: 'partial', data: { exhausted: false, next_cursor: null }, errors: [{ code: 'RESULT_SET_CHANGED' }, { code: 'RESULT_SET_CHANGED' }] });
    expect(okData(result).products).toHaveLength(2);
  });
  it('does not treat truncated pagination as an empty successful ending', async () => {
    const h = harness([{ ids: [1], total: 40, next: false }]);
    expect(await h.research.call('search_products', { query: 'disk' })).toMatchObject({ status: 'partial', errors: [{ code: 'INCOMPLETE_RESULTS' }] });
  });
  it('verifies required authentication before serving a cached result', async () => {
    const h = harness([{ ids: [1], total: 1, next: false }]); const args = { query: 'disk', auth: 'required' };
    await h.research.call('search_products', args);
    const cached = await h.research.call('search_products', args); expect(cached.meta.cache.hit).toBe(true); expect(h.requests).toHaveLength(1);
    h.expire(); expect(await h.research.call('search_products', args)).toMatchObject({ status: 'error', error: { code: 'AUTH_REQUIRED' } }); expect(h.checks()).toBe(3);
  });
  it('rejects ambiguous product codes and unknown filters explicitly', async () => {
    const h = harness([{ ids: [1, 2], total: 2, next: false }]);
    expect(await h.research.call('get_product', { code: 'shared' })).toMatchObject({ status: 'error', error: { code: 'AMBIGUOUS_PRODUCT' } });
    expect(await h.research.call('search_products', { query: 'disk', filters: { facets: [{ id: 999, values: ['missing'] }] } })).toMatchObject({ status: 'error', error: { code: 'UNSUPPORTED_FILTER' } });
  });
  it('reports the available sorts when Alza omits the requested ordering', async () => {
    const h = harness([]);
    expect(await h.research.call('search_products', { query: 'gadget', sort: 'bestselling' })).toMatchObject({ status: 'error', error: { code: 'UNSUPPORTED_FILTER', sort_orders: ['relevance', 'price_asc'] } });
    expect(h.requests).toHaveLength(0);
  });
  it('suggests child categories when Alza redirects a search to a category hub', async () => {
    const html = '<script>var _pageData={"isUserLogged":false,"categoryId":18855843,"data":{}};</script><div data-testid="category-tiles"><div data-testid="category-tile"><a href="/chytre-osvetleni/18913998.htm">Chytré osvětlení</a></div><div data-testid="category-tile"><a href="/18855843-e19.htm">Promotion</a></div></div>';
    const h = harness([], html), child = { id: 18913998, name: 'Chytré osvětlení', url: 'https://www.alza.cz/chytre-osvetleni/18913998.htm' };
    expect(await h.research.call('search_products', { query: 'chytrá domácnost' })).toMatchObject({ status: 'error', error: { code: 'CATEGORY_NOT_LISTABLE', category_id: 18855843, suggested_categories: [child] } });
    expect(await h.research.call('get_category', { category_id: 18855843 })).toMatchObject({ status: 'ok', data: { listing_supported: false, children: [child] } });
    expect(h.requests).toHaveLength(0);
  });
  it('requests a hydrated stock control and sends only Alza’s advertised value', async () => {
    const h = harness([{ ids: [1], total: 1, next: false }], `${bootstrap}<label>Skladem kdekoliv<input type="radio" value="1"></label>`);
    expect(await h.research.call('search_products', { query: 'chytrý lokátor', filters: { in_stock: true } })).toMatchObject({ status: 'ok' });
    expect(h.pageOptions).toContainEqual({ stock: true });
    expect(h.requests).toMatchObject([{ availabilityType: 1 }]);
  });
  it('rejects a valid signed cursor after a server restart', async () => {
    const h = harness([{ ids: [1], total: 2, next: true }]); const first = okData(await h.research.call('search_products', { query: 'disk' }));
    expect(await harness([]).research.call('search_products', { cursor: first.next_cursor })).toMatchObject({ status: 'error', error: { code: 'CURSOR_EXPIRED' } });
  });
});

describe('source fidelity', () => {
  it('accepts a single rendered page without a pager but never treats it as a later page', () => {
    const html = bootstrap + card(1) + '<span id="lblNumberItem">1</span>';
    expect(parseRenderedSearch(html, 1, { query: 'disk' })).toMatchObject({ total: 1, next: false });
    expect(() => parseRenderedSearch(html, 2, { query: 'disk' })).toThrow(/requested result page/);
  });
  it('discovers current category tiles without mixing in editorial or archive links', () => {
    expect(categories('<div class="category-tiles__categories"><a href="/m2/18854796.htm">M.2</a></div><a href="/unrelated/18812345.htm">Article link</a>', true)).toEqual([{ id: 18854796, name: 'M.2', url: 'https://www.alza.cz/m2/18854796.htm' }]);
  });
  it('keeps precision, displayed rounding, VAT and conditional offers separate', () => {
    const html = `<script>var _pageData={"isUserLogged":true,"data":{"cid":42,"commodityCode":"ABC"}};</script><script type="application/ld+json">{"@type":"Product","name":"Disk","offers":{"price":7199.1,"priceCurrency":"CZK"}}</script><div class="js-price-detail__main-price-box-wrapper"><span class="js-price-box__primary-price__value">7 199,-</span><span class="js-secondary-price">bez DPH 5 950,-</span></div><div class="js-price-detail__alternative-price-box-wrapper"><div data-slot="pb-title">S kódem SALE</div><span data-slot="pb-price">6 999,-</span></div><div id="descAnnotation"></div>`;
    const p = parseProduct(html, 'https://www.alza.cz/disk-d42.htm', 42, true, ['offers', 'description']);
    expect(p.sections.offers).toMatchObject({ state: 'available', data: [{ amount: '7199.10', display: '7 199,-', vat: 'unknown', kind: 'effective' }, { amount: '5950.00', vat: 'excluded' }, { amount: '6999.00', kind: 'conditional' }] });
    expect(p.sections.description).toMatchObject({ state: 'failed', error: { code: 'SECTION_INCOMPLETE' } });
    expect(money('Ušetříte 500,-')).toBeNull();
  });
  it('preserves complete review text and rejects a stalled continuation', () => {
    const body = 'Complete review. '.repeat(200);
    const raw = { paging: { size: 1, limit: 10, next: null }, value: [{ rating: 4, description: body, positives: ['one'], negatives: [], images: [], response: { text: 'Seller response' }, isTranslated: true, commodityName: 'Different variant', verifiedPurchaseTag: { label: 'Ověřený nákup' } }] };
    expect(parseReviews(raw, 42, 0).reviews[0]).toMatchObject({ body, translated: true, variant: 'Different variant', verified_purchase: 'Ověřený nákup', response: { text: 'Seller response' } });
    expect(() => parseReviews({ ...raw, paging: { ...raw.paging, next: { href: 'https://webapi.alza.cz/api/catalog/v2/commodities/42/reviews?offset=0' } } }, 42, 0)).toThrow(/continuation/);
    expect(() => parseReviews({ message: 'The Ucik field is required.' }, 42, 0)).toThrow(/schema/);
  });
  it('maps advertised enum IDs and numeric range units to the upstream contract', () => {
    const html = bootstrap + `<div class="parameter enum" data-parameterid="10"><span class="parameterName">Type</span><div class="parameterValue"><span class="name">SSD</span><input value="4" data-key="10-4"></div></div><div class="parameter slider" data-parameterid="20"><span class="parameterName">Size</span></div><script>_parameterTypes[20]={name:'Size',values:[{id:1,text:'1 GB',count:2,value:1000},{id:2,text:'2 GB',count:3,value:2000}]};</script>`;
    expect(filterRequest(html, { category_id: 18845887, filters: { facets: [{ id: 10, values: ['10-4'] }, { id: 20, from: 1000, to: 2000 }] } }, 1)).toMatchObject({ parameters: [{ typeId: 10, values: ['4'], valueIds: ['10-4'] }, { typeId: 20, valueFrom: 1000, valueTo: 2000 }], hash: '#f&cud=0&pg=1&prod=&par10=10-4&par20=1000--2000' });
  });
});

it('preserves financing terms without misreading interest or monthly installments as a purchase price', () => {
  const html = '<script>var _pageData={"isUserLogged":false,"data":{"cid":42,"hasVariants":false}};</script><script type="application/ld+json">{"@type":"Product","name":"Laptop","offers":{"price":20000,"priceSpecification":[{"price":20000,"valueAddedTaxIncluded":true},{"price":22000,"priceType":"https://schema.org/ListPrice","valueAddedTaxIncluded":true}]}}</script><div class="detailVariants"><div></div></div><div class="js-price-detail__alternative-price-box-wrapper"><span class="ads-pb--instalments-c"><span data-slot="pb-price">4,9% úrok</span><span>od 816,- měsíčně</span></span></div>';
  const p = parseProduct(html, 'https://www.alza.cz/laptop-d42.htm', 42, false, ['offers', 'attributes', 'variants']);
  expect(p.sections.offers).toMatchObject({ state: 'available', data: [{ amount: '20000.00', kind: 'public', vat: 'included' }, { amount: '22000.00', kind: 'reference' }] });
  expect(p.sections.attributes).toMatchObject({ state: 'available', data: { financing_displays: ['4,9% úrokod 816,- měsíčně'] } });
  expect(p.sections.variants).toEqual({ state: 'not_provided' });
});
