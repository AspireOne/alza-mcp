import { expect, it } from 'vitest';
import { Research } from '../src/domain/research.js';
import { configFromEnv } from '../src/infra/config.js';
import { Cursors } from '../src/infra/cursor.js';
import type { Access, Reader } from '../src/infra/reader.js';

const hubs = [
  { id: 18901355, name: 'Domácí a osobní spotřebiče', url: 'https://www.alza.cz/domaci-a-osobni-spotrebice', child: { id: 18850975, name: 'Vysavače', url: 'https://www.alza.cz/vysavace/18850975.htm' } },
  { id: 18855850, name: 'Dům, dílna a zahrada', url: 'https://www.alza.cz/hobby', child: { id: 18858962, name: 'Nářadí', url: 'https://www.alza.cz/hobby/naradi/18858962.htm' } },
];
const component = (id: number, origin = 'https://www.alza.cz') => `<div data-testid="component-catalogLocalTitlePage" data-api-url="${origin}/api/catalog/v2/homePage/categories/${id}/categories?ucik=test-user&amp;pgrik=test-page"></div>`;
const landing = (hub = hubs[0]!, bootstrap = 1) => `<script>var _pageData={"isUserLogged":false,"categoryId":${bootstrap},"data":null};</script><h1>${hub.name}</h1>${component(hub.id)}<div data-testid="category-tiles"><div data-testid="category-tile"><a href="${hub.child.url}">${hub.child.name}</a></div></div>`;

function harness(override?: string) {
  // TODO: Mock upstream transport with the minimal observed landing-page contract.
  const reader: Reader = { context: 'anonymous', provider: 'browser', canPost: true,
    page: async url => {
      const hub = hubs.find(h => url.endsWith(`/${h.id}.htm`)) ?? hubs[0]!;
      const html = new URL(url).pathname === '/' ? `<div class="category-tree">${hubs.map(h => `<a href="/${h.id}.htm">${h.name}</a>`).join('')}</div>` : override ?? landing(hub);
      return { url: new URL(url).pathname === '/' ? url : hub.url, html, headers: {}, status: 200 };
    }, json: async () => { throw new Error('Navigation hubs must not issue filter requests'); },
  };
  const access: Access = { run: async (op, work) => { op.meta.auth.state = 'anonymous'; return work(reader); }, status: () => ({}), close: async () => {} };
  return new Research(configFromEnv({}), access, new Cursors('x'.repeat(64)));
}

it('resolves advertised navigation IDs through their landing-page components and retains child categories', async () => {
  const research = harness();
  const listed = await research.call('list_categories', {});
  expect(listed).toMatchObject({ status: 'ok', data: hubs.map(h => ({ id: h.id, name: h.name })) });
  for (const hub of hubs) {
    expect(await research.call('get_category', { category_id: hub.id })).toMatchObject({ status: 'ok', data: { id: hub.id, name: hub.name, url: hub.url, children: [hub.child], facets: [], manufacturers: [], sort_orders: [], listing_supported: false } });
  }
});

it('identifies a searched landing hub with its real navigation ID and useful child suggestions', async () => {
  expect(await harness().call('search_products', { category_id: hubs[0]!.id })).toMatchObject({ status: 'error', error: { code: 'CATEGORY_NOT_LISTABLE', category_id: hubs[0]!.id, suggested_categories: [hubs[0]!.child] } });
});

it.each(['get_category', 'search_products'] as const)('rejects a different landing identity in %s', async tool => {
  expect(await harness(landing(hubs[0])).call(tool, { category_id: hubs[1]!.id })).toMatchObject({ status: 'error', error: { code: 'CATEGORY_ID_MISMATCH' } });
});

it.each([
  { name: 'unrelated redirect without component identity', html: landing().replace(component(hubs[0]!.id), ''), code: 'CATEGORY_ID_MISMATCH' },
  { name: 'conflicting component identities', html: landing() + component(hubs[1]!.id), code: 'CATEGORY_ID_MISMATCH' },
  { name: 'conflicting non-placeholder bootstrap', html: landing(hubs[0], hubs[1]!.id), code: 'CATEGORY_ID_MISMATCH' },
  { name: 'untrusted component origin', html: landing().replace(component(hubs[0]!.id), component(hubs[0]!.id, 'https://example.com')), code: 'SCHEMA_CHANGED' },
])('rejects $name', async ({ html, code }) => {
  expect(await harness(html).call('get_category', { category_id: hubs[0]!.id })).toMatchObject({ status: 'error', error: { code } });
});
