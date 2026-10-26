import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Research } from '../src/domain/research.js';
import { browserCatalog } from '../src/domain/browser-catalog.js';
import { Cursors } from '../src/infra/cursor.js';
import { configFromEnv } from '../src/infra/config.js';
import type { Access, Reader, Document } from '../src/infra/reader.js';

const capture = JSON.parse(readFileSync(new URL('./fixtures/rating-scope.json', import.meta.url), 'utf8'));
function harness(stats = structuredClone(capture.stats), htmlAggregate: unknown = capture.html_aggregate) {
  const requests: URL[] = [];
  // TODO: Mock the storefront transport and review text; counts and aggregates come from a sanitized live capture.
  const reviews = Array.from({ length: 48 }, (_, i) => ({ rating: 5, description: `Review ${i + 1}`, positives: [], negatives: [], images: [], response: null, isTranslated: false,
    flagUrl: `https://cdn.alza.cz/images/flags/country/${i < 34 ? 'cz' : 'sk'}.svg`, templatedReviewAction: { href: `https://www.alza.cz/review/${i + 1}/detail` } }));
  const page: Document = { url: `https://www.alza.cz/product-d${capture.id}.htm`, status: 200, headers: {},
    html: `<script>var _pageData={"isUserLogged":false,"data":{"cid":${capture.id}}};</script><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: capture.name, aggregateRating: htmlAggregate })}</script><div data-api-url="https://webapi.alza.cz/api/catalog/v2/commodities/${capture.id}?ucik=test-user&amp;pgrik=test-page"></div>` };
  const reader: Reader = { provider: 'browser', context: 'anonymous', canPost: true, page: async () => page,
    json: async target => {
      const url = new URL(target); requests.push(url);
      if (url.pathname.endsWith('/reviewStats')) return stats;
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
      return { paging: { size: 48, limit, next: offset + limit < 48 ? { href: `https://webapi.alza.cz/api/catalog/v2/commodities/${capture.id}/reviews?offset=${offset + limit}&limit=${limit}` } : null }, value: reviews.slice(offset, offset + limit) };
    } };
  const access: Access = { run: async (op, work) => { op.meta.auth.state = 'anonymous'; return work(reader); }, status: () => ({ account_configured: false, active_requests: 0, last_failure: null }), close: async () => {} };
  return { research: new Research(configFromEnv({}), access, browserCatalog, new Cursors('x'.repeat(64))), requests };
}

it('shares API-backed rating counts without losing the smaller HTML observation or foreign reviews', async () => {
  const h = harness();
  const product = await h.research.call('get_product', { product_id: capture.id, sections: ['ratings', 'reliability'] });
  expect(product).toMatchObject({ status: 'ok', data: { sections: { ratings: { state: 'available', data: {
    source: 'review_stats', ratingAverage: 4.6, ratingCount: 176, reviewCount: 48,
    reviewCountTooltip: capture.stats.reviewCountTooltip, html_aggregate: capture.html_aggregate,
  } } } } });
  const first = await h.research.call('get_product_reviews', { product_id: capture.id, limit: 30 });
  expect(first).toMatchObject({ status: 'ok', data: { written_review_count: 48, returned_count: 30, exhausted: false, statistics: { state: 'available', data: { source: 'review_stats', ratingAverage: 4.6, ratingCount: 176, reviewCount: 48 } } } });
  if (first.status !== 'ok') throw new Error('Expected a review continuation');
  const second = await h.research.call('get_product_reviews', { cursor: (first.data as { next_cursor: string }).next_cursor });
  expect(second).toMatchObject({ status: 'ok', data: { written_review_count: 48, returned_count: 18, exhausted: true, next_cursor: null } });
  if (second.status !== 'ok') throw new Error('Expected the final review page');
  const remaining = (second.data as { reviews: { translated: boolean; country_flag_url: string | null }[] }).reviews;
  expect(remaining.filter(r => r.country_flag_url?.endsWith('/sk.svg'))).toHaveLength(14);
  expect(remaining.every(r => r.translated === false)).toBe(true);
  expect(h.requests.filter(url => url.pathname.endsWith('/reviewStats'))).toHaveLength(1);
});

it('preserves zero counts and an unknown average even when HTML has no aggregate', async () => {
  const h = harness({ ...capture.stats, ratingAverage: null, ratingCount: 0, reviewCount: 0, ratings: [] }, null);
  expect(await h.research.call('get_product', { product_id: capture.id, sections: ['ratings'] })).toMatchObject({ status: 'ok', data: { sections: { ratings: { state: 'available', data: { source: 'review_stats', ratingAverage: null, ratingCount: 0, reviewCount: 0, html_aggregate: null } } } } });
});

it.each([
  { name: 'unknown rating count', change: { ratingCount: null } },
  { name: 'negative review count', change: { reviewCount: -1 } },
  { name: 'missing average', change: { ratingAverage: undefined } },
])('fails the rating section for $name while preserving independent reliability', async ({ change }) => {
  const h = harness({ ...capture.stats, ...change });
  expect(await h.research.call('get_product', { product_id: capture.id, sections: ['ratings', 'reliability'] })).toMatchObject({ status: 'partial', data: { sections: { ratings: { state: 'failed', error: { code: 'SCHEMA_CHANGED', stage: 'ratings' } }, reliability: { state: 'available' } } }, errors: [{ stage: 'ratings' }] });
});

it('rejects statistics belonging to another product for both dependent sections', async () => {
  const h = harness({ ...capture.stats, self: { href: 'https://webapi.alza.cz/api/catalog/v2/commodities/42/reviewStats' } });
  expect(await h.research.call('get_product', { product_id: capture.id, sections: ['ratings', 'reliability'] })).toMatchObject({ status: 'partial', data: { sections: { ratings: { state: 'failed' }, reliability: { state: 'failed' } } }, errors: [{ stage: 'ratings' }, { stage: 'reliability' }] });
  expect(h.requests).toHaveLength(1);
});
