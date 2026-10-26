import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Research } from '../src/domain/research.js';
import { configFromEnv } from '../src/infra/config.js';
import { Cursors } from '../src/infra/cursor.js';
import { fail } from '../src/infra/failure.js';
import type { Access, Reader } from '../src/infra/reader.js';
import type { Complaint } from '../src/domain/contracts.js';

interface Capture { id: number; name: string; stats: Record<string, unknown> }
const captures: Capture[] = JSON.parse(readFileSync(new URL('./fixtures/review-statistics.json', import.meta.url), 'utf8'));
const capture = (id: number) => structuredClone(captures.find(sample => sample.id === id)!);

// TODO: Mock transport and page bootstrap; statistics payloads are sanitized live captures.
function harness(sample = capture(5879402), html?: string, upstreamError?: string) {
  const requests: URL[] = [];
  let sources: string[] = [];
  const context = `https://webapi.alza.cz/api/catalog/v2/commodities/${sample.id}?ucik=test-user&pgrik=test-page`;
  const pageHtml = html ?? `<script>var _pageData={"isUserLogged":false,"data":{"cid":${sample.id}}};</script><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: sample.name, aggregateRating: { ratingValue: 4.4, ratingCount: 205 } })}</script><div data-api-url="${context}"></div>`;
  const reader: Reader = {
    provider: 'browser', context: 'anonymous', canPost: true,
    page: async url => { sources.push(url); return { url, html: pageHtml, status: 200, headers: {} }; },
    json: async target => {
      const url = new URL(target); requests.push(url);
      if (url.pathname.endsWith('/reviewStats')) {
        if (upstreamError) fail(upstreamError, 'Controlled upstream failure.');
        sources.push(target);
        return sample.stats;
      }
      if (url.pathname.endsWith('/reviews')) return { paging: { size: 0, limit: 20, next: null }, value: [] };
      throw new Error('Unexpected request');
    },
  };
  const access: Access = { run: async (op, work) => { op.meta.auth.state = 'anonymous'; sources = op.meta.sources; return work(reader); }, status: () => ({}), close: async () => {} };
  return { research: new Research(configFromEnv({}), access, new Cursors('x'.repeat(64))), requests, id: sample.id };
}

describe('product reliability from captured Alza responses', () => {
  it.each([
    { id: 7400136, rate: 0, type: 1, description: 'nízká reklamovanost', count: '200+' },
    { id: 5879402, rate: 0.0565, type: 3, description: 'vysoká reklamovanost', count: '1 000+' },
    { id: 13188678, rate: 0.0114, type: 1, description: 'nízká reklamovanost', count: '1 000+' },
    { id: 10837262, rate: null, type: 0, description: 'neznámá reklamovanost', count: '10+' },
  ])('preserves the reported fraction and assessment for $id', async ({ id, rate, type, description, count }) => {
    const h = harness(capture(id));
    const result = await h.research.call('get_product', { product_id: id, sections: ['reliability'] });
    expect(result).toMatchObject({ status: 'ok', data: { sections: { reliability: { state: 'available', data: { complaint: { rate, type, description, tooltip: expect.any(String) }, purchaseCountFormatted: count, showPurchaseCount: true } } } } });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.pathname).toBe(`/api/catalog/v2/commodities/${id}/reviewStats`);
    expect(h.requests[0]?.searchParams.get('ucik')).toBe('test-user');
    expect(h.requests[0]?.searchParams.get('pgrik')).toBe('test-page');
    expect(h.requests[0]?.searchParams.get('country')).toBe('CZ');
    expect(result.meta.sources).toContain(h.requests[0]!.href);
  });

  it('reports an explicitly absent complaint object as not provided, even for a high-volume product', async () => {
    const h = harness(capture(12662568));
    expect(await h.research.call('get_product', { product_id: h.id, sections: ['reliability'] })).toMatchObject({ status: 'ok', data: { sections: { reliability: { state: 'not_provided' } } } });
  });

  it('includes reliability by default and shares the upstream statistics cache with reviews', async () => {
    const h = harness();
    const product = await h.research.call('get_product', { product_id: h.id });
    expect(product).toMatchObject({ status: 'ok', data: { sections: { reliability: { data: { complaint: { rate: 0.0565 } } } } } });
    const reviews = await h.research.call('get_product_reviews', { product_id: h.id });
    expect(reviews).toMatchObject({ status: 'ok', data: { statistics: { state: 'available', data: { complaint: { rate: 0.0565, description: 'vysoká reklamovanost' }, purchaseCountFormatted: '1 000+' } } }, meta: { cache: { hit: true } } });
    expect(h.requests.filter(url => url.pathname.endsWith('/reviewStats'))).toHaveLength(1);
    expect(reviews.meta.sources).toContain(h.requests[0]!.href);
  });

  it('does not fetch statistics when neither ratings nor reliability was requested', async () => {
    const h = harness();
    const result = await h.research.call('get_product', { product_id: h.id, sections: ['attributes'] });
    expect(result).toMatchObject({ status: 'ok', data: { sections: { attributes: { state: 'available' } } } });
    if (result.status !== 'error') expect((result.data as { sections: object }).sections).not.toHaveProperty('reliability');
    expect(h.requests).toHaveLength(0);
  });

  it('preserves upstream assessment codes and hidden sales context without inventing thresholds or counts', async () => {
    const sample = capture(5879402);
    sample.stats.complaint = { rate: 0.015, type: 99, description: 'Upstream assessment', tooltip: 'Category-specific explanation' };
    sample.stats.purchaseCountFormatted = null; sample.stats.showPurchaseCount = false;
    const h = harness(sample);
    expect(await h.research.call('get_product', { product_id: h.id, sections: ['reliability'] })).toMatchObject({ status: 'ok', data: { sections: { reliability: { data: { complaint: sample.stats.complaint, purchaseCountFormatted: null, showPurchaseCount: false } } } } });
  });

  it('preserves shared statistics across new and opened listings without merging their identities', async () => {
    for (const id of [7980597, 8598564]) {
      const h = harness(capture(id));
      expect(await h.research.call('get_product', { product_id: id, sections: ['reliability'] })).toMatchObject({ status: 'ok', data: { id, sections: { reliability: { data: { complaint: { rate: 0.0628 } } } } } });
    }
  });
});

describe('reliability failures', () => {
  it.each([
    { name: 'rate missing', mutate: (s: Capture) => { delete (s.stats.complaint as Partial<Complaint>).rate; } },
    { name: 'rate in percentage units', mutate: (s: Capture) => { (s.stats.complaint as Complaint).rate = 5.65; } },
    { name: 'rate as text', mutate: (s: Capture) => { s.stats.complaint = { ...(s.stats.complaint as Complaint), rate: '0.0565' }; } },
    { name: 'assessment missing', mutate: (s: Capture) => { delete s.stats.complaint; } },
    { name: 'tooltip missing', mutate: (s: Capture) => { delete (s.stats.complaint as Partial<Complaint>).tooltip; } },
    { name: 'sales count malformed', mutate: (s: Capture) => { s.stats.purchaseCountFormatted = 1000; } },
  ])('keeps ratings but explicitly fails reliability when $name', async ({ mutate }) => {
    const sample = capture(5879402); mutate(sample); const h = harness(sample);
    expect(await h.research.call('get_product', { product_id: h.id, sections: ['ratings', 'reliability'] })).toMatchObject({ status: 'partial', data: { sections: { ratings: { state: 'available' }, reliability: { state: 'failed', error: { code: 'SCHEMA_CHANGED', stage: 'reliability' } } } }, errors: [{ code: 'SCHEMA_CHANGED', stage: 'reliability' }] });
  });

  it('fails explicitly if the page has no review-statistics context', async () => {
    const h = harness(capture(5879402), '<script>var _pageData={"isUserLogged":false,"data":{"cid":5879402}};</script><script type="application/ld+json">{"@type":"Product","name":"Vacuum"}</script>');
    expect(await h.research.call('get_product', { product_id: h.id, sections: ['reliability'] })).toMatchObject({ status: 'partial', errors: [{ code: 'SCHEMA_CHANGED', stage: 'reliability' }] });
    expect(h.requests).toHaveLength(0);
  });

  it('preserves independent product data and fails both API-backed sections on an upstream statistics error', async () => {
    const h = harness(capture(5879402), undefined, 'UPSTREAM_ERROR');
    expect(await h.research.call('get_product', { product_id: h.id, sections: ['attributes', 'ratings', 'reliability'] })).toMatchObject({ status: 'partial', data: { sections: { attributes: { state: 'available' }, ratings: { state: 'failed' }, reliability: { state: 'failed' } } }, errors: [{ code: 'UPSTREAM_ERROR', stage: 'ratings' }, { code: 'UPSTREAM_ERROR', stage: 'reliability' }] });
    expect(h.requests).toHaveLength(1);
  });

  it('propagates authentication failures to the access coordinator', async () => {
    const h = harness(capture(5879402), undefined, 'AUTH_REQUIRED');
    expect(await h.research.call('get_product', { product_id: h.id, sections: ['reliability'] })).toMatchObject({ status: 'error', error: { code: 'AUTH_REQUIRED' } });
  });
});
