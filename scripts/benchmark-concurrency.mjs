#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual, parseArgs, parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const TIMEOUT_MS = 130_000;
const WINDOW = 5;
const ALL_SECTIONS = ['description', 'specifications', 'variants', 'media', 'documents', 'offers', 'attributes', 'ratings', 'reliability'];
const OMIT_HASH_KEYS = new Set(['meta', 'next_cursor', 'cursor', 'author', 'userId', 'user_id', 'accountId', 'account_id', 'fetched_at']);

export function semanticValue(value) {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !OMIT_HASH_KEYS.has(key)).map(key => [key, semanticValue(value[key])]));
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return value; }
  }
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(semanticValue(value))).digest('hex');

export function schedule({ categoryId = 18845887, productIds = [12611062, 12662568], query = 'disk' } = {}) {
  const auth = 'required';
  const filters = { max_price: 4000 };
  const shopping = [
    { label: 'category_search', name: 'search_products', arguments: { category_id: categoryId, filters, sort: 'price_asc', auth } },
    { label: 'text_search', name: 'search_products', arguments: { query, filters, sort: 'price_asc', auth } },
    ...productIds.map(id => ({ label: `product_${id}`, name: 'get_product', arguments: { product_id: id, auth } })),
    { label: 'category_facets', name: 'get_category', arguments: { category_id: categoryId, auth } },
  ];
  return [
    { label: 'cold_shopping', calls: shopping },
    { label: 'warm_shopping', calls: structuredClone(shopping) },
    { label: 'reviews', calls: productIds.map(id => ({ label: `reviews_${id}`, name: 'get_product_reviews', arguments: { product_id: id, limit: 10, auth } })) },
  ];
}

export function validateResult(call, result, wire) {
  const issues = [];
  const check = (condition, code) => { if (!condition) issues.push(code); };
  check(result?.status === 'ok', 'RESULT_NOT_OK');
  check(wire.isError !== true, 'WIRE_ERROR');
  try { check(isDeepStrictEqual(JSON.parse(wire.content.find(content => content.type === 'text').text), result), 'WIRE_CONTENT_MISMATCH'); }
  catch { check(false, 'WIRE_CONTENT_INVALID'); }
  check(result?.meta?.auth?.state === 'signed_in', 'AUTH_NOT_SIGNED_IN');
  if (result?.status !== 'ok') return issues;
  const data = result.data;
  if (call.name === 'get_product') {
    check(data?.id === call.arguments.product_id, 'PRODUCT_ID');
    for (const section of call.arguments.sections ?? ALL_SECTIONS) check(['available', 'not_provided'].includes(data?.sections?.[section]?.state), `SECTION_${section.toUpperCase()}`);
    check(data?.sections?.offers?.state === 'available' && Array.isArray(data.sections.offers.data) && data.sections.offers.data.length > 0, 'OFFERS_MISSING');
  } else if (call.name === 'search_products') {
    const products = data?.products;
    check(Array.isArray(products) && products.length > 0, 'SEARCH_EMPTY');
    if (Array.isArray(products)) {
      check(products.every(p => Number.isSafeInteger(p.id) && p.id > 0 && p.name && p.url), 'SEARCH_IDENTITIES');
      check(new Set(products.map(p => p.id)).size === products.length, 'SEARCH_DUPLICATES');
      check(data.returned_count === products.length, 'SEARCH_RETURNED_COUNT');
    }
    check(data?.page === 1, 'SEARCH_PAGE');
    check(data?.query?.sort === call.arguments.sort && data?.query?.filters?.max_price === call.arguments.filters.max_price, 'SEARCH_FILTERS');
    check(call.arguments.category_id ? data?.query?.category_id === call.arguments.category_id : data?.query?.query === call.arguments.query, 'SEARCH_QUERY');
  } else if (call.name === 'get_category') {
    check(data?.id === call.arguments.category_id, 'CATEGORY_ID');
    check(Array.isArray(data?.facets) && data.facets.length > 0, 'CATEGORY_FACETS');
  } else if (call.name === 'get_product_reviews') {
    check(data?.product_id === call.arguments.product_id, 'REVIEWS_PRODUCT_ID');
    check(data?.statistics?.state === 'available', 'REVIEW_STATISTICS');
    check(Array.isArray(data?.reviews) && data.reviews.length > 0 && data.reviews.length <= call.arguments.limit, 'REVIEWS_PAGE');
    if (Array.isArray(data?.reviews)) {
      const ids = data.reviews.map(review => review.id).filter(Boolean);
      check(new Set(ids).size === ids.length, 'REVIEW_DUPLICATES');
      check(data.returned_count === data.reviews.length, 'REVIEWS_RETURNED_COUNT');
    }
  }
  return issues;
}

export async function run() {
  const { values } = parseArgs({ options: { url: { type: 'string' }, label: { type: 'string', default: 'local' }, output: { type: 'string' }, 'env-file': { type: 'string' }, 'dry-run': { type: 'boolean' }, concurrency: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log('Usage: node scripts/benchmark-concurrency.mjs --url http://127.0.0.1:3002/mcp --label concurrency-1 --output .artifacts/benchmark-1.json [--env-file FILE] [--concurrency 1|2] [--dry-run]\n12 calls: cold five, identical warm five, two review pages; client window five; required auth.\nToken: ALZA_MCP_TOKEN or private .artifacts/local-stack/.env. Optional ALZA_BENCH_CATEGORY, ALZA_BENCH_PRODUCTS (two comma-separated IDs), ALZA_BENCH_QUERY.');
    return;
  }
  const categoryId = Number(process.env.ALZA_BENCH_CATEGORY ?? 18845887);
  const productIds = (process.env.ALZA_BENCH_PRODUCTS ?? '12611062,12662568').split(',').map(Number);
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0 || productIds.length !== 2 || new Set(productIds).size !== 2 || productIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid benchmark category/products.');
  const expectedConcurrency = values.concurrency ? Number(values.concurrency) : undefined;
  if (expectedConcurrency !== undefined && ![1, 2].includes(expectedConcurrency)) throw new Error('Expected concurrency must be 1 or 2.');
  const phases = schedule({ categoryId, productIds, query: process.env.ALZA_BENCH_QUERY ?? 'disk' });
  const endpoint = new URL(values.url ?? process.env.ALZA_MCP_URL ?? 'http://127.0.0.1:3002/mcp');
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Use an HTTP endpoint without credentials, query or fragment.');
  const publicSchedule = { label: values.label, endpoint: `${endpoint.origin}${endpoint.pathname}`, window: WINDOW, expectedConcurrency, timeoutMs: TIMEOUT_MS, phases, scheduleHash: hash(phases) };
  if (values['dry-run']) { console.log(JSON.stringify(publicSchedule, null, 2)); return; }
  let token = process.env.ALZA_MCP_TOKEN;
  if (!token) token = parseEnv(await readFile(values['env-file'] ?? '.artifacts/local-stack/.env', 'utf8')).ALZA_MCP_TOKEN;
  if (!token) throw new Error('Missing local MCP bearer token.');
  const output = resolve(values.output ?? `.artifacts/concurrency-${values.label}.json`);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const file = await open(output, 'wx', 0o600);
  await chmod(output, 0o600);
  await file.close();
  const saveReport = report => writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  const client = new Client({ name: 'alza-concurrency-benchmark', version: '0.2.0' });
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const report = { ...publicSchedule, startedAt: new Date().toISOString(), phases: [], limitations: ['One local sample; upstream responses and persistent browser HTTP caches can vary between arms.', 'Attempt duration includes server execution; client total minus attempt duration is NOT an exact queue measurement.', 'Use server request_id correlation for authoritative queue timing.'] };
  let failed = false;
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    async function serverStatus() {
      const wire = await client.callTool({ name: 'get_session_status', arguments: {} }, { timeout: TIMEOUT_MS, signal: stopped.signal });
      const result = wire.structuredContent;
      if (result?.status !== 'ok' || wire.isError) throw new Error('Session status unavailable.');
      const data = result.data;
      const status = { browserConcurrency: data.browser_concurrency, queueSize: data.queue_size, accountConfigured: data.account_configured, browser: { running: typeof data.browser?.running === 'boolean' ? data.browser.running : undefined, profiles: data.browser?.profiles } };
      if (expectedConcurrency !== undefined && status.browserConcurrency !== expectedConcurrency) throw new Error('Server concurrency does not match the requested arm.');
      return status;
    }
    report.serverBefore = await serverStatus();
    for (const phase of phases) {
      if (stopped.signal.aborted) break;
      const phaseStart = performance.now();
      const calls = [];
      // The fixed shopping phases each have five calls; never dispatch above the window.
      for (let offset = 0; offset < phase.calls.length; offset += WINDOW) {
        const completed = await Promise.all(phase.calls.slice(offset, offset + WINDOW).map(async call => {
          const start = performance.now();
          let result;
          try {
            const wire = await client.callTool({ name: call.name, arguments: call.arguments }, { timeout: TIMEOUT_MS, signal: stopped.signal });
            result = wire.structuredContent;
            const issues = validateResult(call, result, wire);
            const attempts = result?.meta?.attempts?.map(attempt => ({ provider: attempt.provider, outcome: attempt.outcome, code: attempt.code, durationMs: attempt.duration_ms })) ?? [];
            const durationMs = Math.round(performance.now() - start);
            return { label: call.label, tool: call.name, arguments: call.arguments, offsetMs: Math.round(start - phaseStart), durationMs, ok: issues.length === 0, issues, requestId: result?.meta?.request_id, status: result?.status, errorCodes: result?.status === 'error' ? [result.error.code] : result?.errors?.map(error => error.code) ?? [], authState: result?.meta?.auth?.state, cache: result?.meta?.cache, challenge: result?.meta?.challenge?.status, attempts, outsideAttemptsMsApprox: Math.max(0, durationMs - attempts.reduce((total, attempt) => total + attempt.durationMs, 0)), semanticHash: hash(result?.data ?? null), sectionStates: result?.data?.sections ? Object.fromEntries(Object.entries(result.data.sections).map(([key, section]) => [key, section.state])) : undefined, returnedCount: result?.data?.returned_count };
          } catch (error) {
            return { label: call.label, tool: call.name, arguments: call.arguments, offsetMs: Math.round(start - phaseStart), durationMs: Math.round(performance.now() - start), ok: false, issues: ['TRANSPORT_OR_RESULT_FAILURE'], errorName: error instanceof Error ? error.name : 'UnknownError' };
          }
        }));
        calls.push(...completed);
      }
      const entry = { label: phase.label, durationMs: Math.round(performance.now() - phaseStart), ok: calls.every(call => call.ok), calls };
      report.phases.push(entry);
      failed ||= !entry.ok;
      await saveReport(report);
      console.log(JSON.stringify({ label: values.label, phase: phase.label, durationMs: entry.durationMs, ok: entry.ok, calls: calls.map(call => ({ label: call.label, durationMs: call.durationMs, ok: call.ok, issues: call.issues, cacheHit: call.cache?.hit })) }));
      if (!entry.ok) break;
    }
    report.serverAfter = await serverStatus();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    report.completedAt = new Date().toISOString(); report.ok = !failed && !stopped.signal.aborted && report.phases.length === phases.length;
    await saveReport(report);
    await client.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch(() => { console.error('Benchmark failed; inspect the private report and server logs.'); process.exitCode = 1; });
}
