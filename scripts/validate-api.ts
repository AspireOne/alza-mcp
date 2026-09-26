#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApplication, createServer } from '../src/server.js';
import type { Result, SearchPage, Product, ReviewsPage } from '../src/domain/contracts.js';

const soak = process.argv.includes('--soak');
const report = process.env.ALZA_VALIDATION_REPORT ?? '.artifacts/validation.jsonl';
const categoryId = Number(process.env.ALZA_TEST_CATEGORY ?? 18845887), productId = Number(process.env.ALZA_TEST_PRODUCT ?? 12611062);
const auth = process.env.ALZA_TEST_AUTH ?? 'anonymous';
const client = new Client({ name: 'alza-validation', version: '0.2.0' });
let close: () => Promise<void> = async () => {};
await mkdir(dirname(report), { recursive: true });
try {
  if (process.env.ALZA_MCP_URL) {
    await client.connect(new StreamableHTTPClientTransport(new URL(process.env.ALZA_MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${process.env.ALZA_MCP_TOKEN ?? ''}` } } }));
  } else {
    const app = await buildApplication(), server = createServer(app.research), [a, b] = InMemoryTransport.createLinkedPair();
    close = async () => { await server.close(); await app.close(); }; await server.connect(a); await client.connect(b);
  }
  async function call<T>(name: string, args: Record<string, unknown>, verify?: (data: T) => void): Promise<T> {
    const start = Date.now(); let result: Result<T> | undefined, ok = false;
    try {
      const wire = await client.callTool({ name, arguments: args }, undefined, { timeout: 100_000 });
      result = wire.structuredContent as unknown as Result<T>;
      assert(result && ['ok', 'partial', 'error'].includes(result.status), 'Missing structured result');
      assert.deepEqual(JSON.parse((wire.content as Array<{ text: string }>)[0]!.text), result, 'Text and structured content disagree');
      if (result.status !== 'ok') throw new Error(result.status === 'error' ? result.error.code : result.errors.map(e => e.code).join(','));
      assert.equal(wire.isError, false);
      if (auth === 'required' && name !== 'get_session_status') assert.equal(result.meta.auth.state, 'signed_in');
      verify?.(result.data); ok = true; return result.data;
    } finally {
      const entry = { at: new Date().toISOString(), tool: name, ok, duration_ms: Date.now() - start, status: result?.status ?? 'transport_error', code: result?.status === 'error' ? result.error.code : result?.status === 'partial' ? result.errors.map(e => e.code).join(',') : undefined, provider: result?.meta.provider, cache: result?.meta.cache, auth: result?.meta.auth, attempts: result?.meta.attempts };
      await appendFile(report, JSON.stringify(entry) + '\n', { mode: 0o600 }); console.log(JSON.stringify(entry));
    }
  }
  const searchArgs = { category_id: categoryId, filters: { max_price: 4000 }, sort: 'price_asc', auth };
  const checks = [
    async () => { await call<unknown[]>('list_categories', { auth }, data => { assert(data.length > 0); }); },
    async () => { await call<{ id: number; facets: unknown[] }>('get_category', { category_id: categoryId, auth }, data => { assert.equal(data.id, categoryId); assert(data.facets.length > 0); }); },
    async () => { await call<SearchPage>('search_products', searchArgs, data => { assert(data.products.length > 0); assert(data.products.every(p => p.id > 0 && p.name && p.url)); }); },
    async () => { await call<Product>('get_product', { product_id: productId, auth }, data => { assert.equal(data.id, productId); assert.equal(data.sections.description?.state, 'available'); assert.equal(data.sections.specifications?.state, 'available'); assert.equal(data.sections.offers?.state, 'available'); }); },
    async () => { await call<ReviewsPage>('get_product_reviews', { product_id: productId, limit: 50, auth }, data => { assert(data.reviews.length > 0); assert.equal(data.statistics.state, 'available'); }); },
  ];
  if (soak) {
    if (!process.env.ALZA_MCP_URL) throw new Error('The soak trial requires ALZA_MCP_URL pointing to the deployed server.');
    const interval = Number(process.env.ALZA_SOAK_INTERVAL_MS ?? 1_800_000), duration = Number(process.env.ALZA_SOAK_DURATION_MS ?? 604_800_000);
    if (!Number.isFinite(interval) || interval < 60_000 || !Number.isFinite(duration) || duration < interval) throw new Error('Invalid soak timing.');
    const start = Date.now(); let index = 0;
    while (Date.now() - start < duration) {
      try { await checks[index++ % checks.length]!(); } catch (error) { console.error(error instanceof Error ? error.message : 'Validation failed'); }
      await setTimeout(Math.min(interval, Math.max(1, duration - (Date.now() - start))));
    }
    const records = (await readFile(report, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(r => Date.parse(r.at) >= start);
    const successes = records.filter(r => r.ok).length, rate = successes / records.length;
    const accepted = Date.now() - start >= 604_800_000 && records.length >= 200 && rate >= 0.99;
    console.log(JSON.stringify({ calls: records.length, success_rate: rate, seven_day_acceptance: accepted }));
    if (!accepted) process.exitCode = 1;
  } else {
    await call('get_session_status', {});
    for (const check of checks) await check();
    let next: string | null = null; const ids = new Set<number>();
    do {
      const page: SearchPage = await call('search_products', next ? { cursor: next } : searchArgs);
      for (const item of page.products) { assert(!ids.has(item.id), 'Repeated product'); ids.add(item.id); }
      next = page.next_cursor; if (!next) { assert.equal(page.exhausted, true); if (page.total !== null) assert.equal(ids.size, page.total); }
    } while (next);
    const reviewIds = new Set<string>(); let written = 0;
    do {
      const page: ReviewsPage = await call('get_product_reviews', next ? { cursor: next } : { product_id: productId, limit: 50, auth });
      written += page.reviews.length;
      for (const review of page.reviews) if (review.id) { assert(!reviewIds.has(review.id), 'Repeated review'); reviewIds.add(review.id); }
      next = page.next_cursor; if (!next) { assert.equal(page.exhausted, true); assert.equal(written, page.written_review_count); }
    } while (next);
    console.log(`Validated all tools, ${ids.size} unique products and ${written} written reviews.`);
  }
} finally { await client.close(); await close(); }
