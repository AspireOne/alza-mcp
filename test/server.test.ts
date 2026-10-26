import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/server.js';
import { httpServer } from '../src/http.js';
import { Research } from '../src/domain/research.js';
import { Cursors } from '../src/infra/cursor.js';
import { configFromEnv } from '../src/infra/config.js';
import { fail } from '../src/infra/failure.js';
const research = () => new Research(configFromEnv({}), { run: async () => fail('CHALLENGE_UNRESOLVED', 'Challenge recovery exhausted.', { retryable: true }), status: () => ({ account_configured: false }), close: async () => {} }, new Cursors('x'.repeat(64)));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('MCP wire contracts', () => {
  it('advertises only read tools and sends the complete error in text and structured content', async () => {
    const server = createServer(research()), client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b); cleanups.push(() => server.close(), () => client.close());
    const tools = await client.listTools(); expect(tools.tools.map(t => t.name)).toEqual(['search_products', 'get_product', 'get_product_reviews', 'list_categories', 'get_category', 'get_session_status']); expect(tools.tools.every(t => t.annotations?.readOnlyHint)).toBe(true);
    expect(client.getInstructions()).toContain('auth="preferred"');
    expect(client.getInstructions()).toContain('0.02 = 2%');
    expect(client.getInstructions()).toContain('do not apply a universal 2% threshold');
    for (const tool of tools.tools.filter(t => t.name !== 'get_session_status')) {
      expect(tool.description).toContain('auth="preferred"');
      expect((tool.inputSchema.properties?.auth as { description?: string }).description).toContain('auth="preferred"');
    }
    for (const tool of tools.tools.filter(t => t.name === 'search_products' || t.name === 'get_product')) {
      expect(tool.description).toContain('actual purchase price');
      expect(tool.description).toContain('company benefits can stack');
      expect(tool.description).toContain('not the checkout price');
    }
    const result = await client.callTool({ name: 'search_products', arguments: { query: 'disk' } });
    expect(result.isError).toBe(true); expect(result.structuredContent).toMatchObject({ status: 'error', error: { code: 'CHALLENGE_UNRESOLVED' } });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual(result.structuredContent);
    expect(await client.callTool({ name: 'get_product', arguments: {} })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    const cursor = tools.tools.find(tool => tool.name === 'get_product_reviews')!.inputSchema.properties?.cursor as { description: string };
    expect(cursor.description).toContain('Supply alone, without product_id or limit');
    expect(await client.callTool({ name: 'get_product_reviews', arguments: { cursor: 'opaque', limit: 5 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT', message: expect.stringContaining('cursor alone') } } });
    expect(await client.callTool({ name: 'search_products', arguments: { query: 'disk', filters: { manufacturers: Array(101).fill(null) } } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
  });
  it('supports real stateless HTTP clients and rejects token, host, origin and body errors', async () => {
    vi.stubEnv('ALZA_LOG_LEVEL', 'info'); vi.stubEnv('ALZA_DEBUG', 'false');
    const records: Array<Record<string, any>> = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { records.push(JSON.parse(String(chunk))); return true; });
    const http = httpServer(research(), { auth: { mode: 'token', token: 't'.repeat(40) }, port: 3000 });
    await new Promise<void>(resolve => http.server.listen(0, '127.0.0.1', resolve)); cleanups.push(http.close);
    const address = http.server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}/mcp`;
    const headers = { host: 'localhost:3000', authorization: `Bearer ${'t'.repeat(40)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect(await new Promise<number | undefined>(resolve => { const req = request(url, { method: 'POST', headers: { ...headers, host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.end('{}'); })).toBe(421);
    expect((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(1_048_577) })).status).toBe(413);
    const client = new Client({ name: 'http-test', version: '1' }); cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    expect((await client.callTool({ name: 'get_session_status' })).structuredContent).toMatchObject({ status: 'ok', data: { account_configured: false } });
    expect((await client.callTool({ name: 'get_product', arguments: { product_id: 42 } })).isError).toBe(true);
    const completed = records.filter(r => r.msg === 'http.request_completed');
    expect(completed).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 401, outcome: 'error', duration_ms: expect.any(Number) }),
      expect.objectContaining({ status: 403, outcome: 'error' }),
      expect.objectContaining({ status: 421, outcome: 'error' }),
      expect.objectContaining({ status: 413, outcome: 'error' }),
    ]));
    for (const tool of records.filter(r => r.msg === 'request.completed')) {
      expect(tool.http_request_id).toEqual(expect.any(String));
      expect(completed.filter(r => r.http_request_id === tool.http_request_id)).toMatchObject([{ status: 200, outcome: 'success' }]);
    }
    expect(records.filter(r => r.msg === 'request.completed').map(r => r.outcome)).toEqual(['ok', 'error']);
    expect(JSON.stringify(records)).not.toContain('t'.repeat(40));
  });
  it('aborts the underlying operation when the client cancels a tool call', async () => {
    let started!: () => void, aborted!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const cancelled = new Promise<void>(resolve => { aborted = resolve; });
    const service = new Research(configFromEnv({}), {
      status: () => ({}), close: async () => {},
      run: async op => {
        const signal = op.signal;
        await new Promise<void>(resolve => {
          signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true });
          started();
        });
        op.check();
        fail('CHALLENGE_UNRESOLVED', 'Cancelled operation must not complete.');
      },
    }, new Cursors('x'.repeat(64)));
    const server = createServer(service), client = new Client({ name: 'cancellation-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    cleanups.push(() => server.close(), () => client.close());
    const controller = new AbortController();
    const pending = client.callTool({ name: 'search_products', arguments: { query: 'disk' } }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('Cancelled by client');
    await running;
    controller.abort(new Error('Cancelled by client'));
    await rejected;
    await cancelled;
  });
});

it('accepts concurrent stateless calls with the same JSON-RPC ID without cross-cancellation', async () => {
  let started!: () => void, release!: () => void;
  const waiting = new Promise<void>(r => { started = r; });
  const gate = new Promise<void>(r => { release = r; });
  let active = 0;
  const config = configFromEnv({});
  const service = new Research(config, { status: () => ({}), close: async () => {}, run: async op => {
    if (++active === 2) started();
    await gate; op.check(); fail('CHALLENGE_UNRESOLVED', 'Controlled test failure.');
  } }, new Cursors('x'.repeat(64)));
  const http = httpServer(service, { auth: { mode: 'token', token: 't'.repeat(40) } }); await new Promise<void>(r => http.server.listen(0, '127.0.0.1', r)); cleanups.push(http.close);
  const url = `http://127.0.0.1:${(http.server.address() as { port: number }).port}/mcp`;
  const headers = { authorization: `Bearer ${'t'.repeat(40)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const call = (query: string) => fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'search_products', arguments: { query } } }) });
  const first = call('disk'), second = call('usb');
  await waiting;
  expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } }) })).status).toBe(202);
  release();
  for (const response of await Promise.all([first, second])) {
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 42, result: { isError: true, structuredContent: { status: 'error', error: { code: 'CHALLENGE_UNRESOLVED' } } } });
  }
});

it('accepts only a signed Cloudflare Access assertion for the configured account and app', async () => {
  const issuer = 'https://test.cloudflareaccess.com', audience = 'app-audience';
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const http = httpServer(research(), { auth: { mode: 'cloudflare-access', teamDomain: 'test.cloudflareaccess.com', audience, email: 'matejpesl1@gmail.com', jwks }, publicUrl: 'https://alza.example.com' });
  await new Promise<void>(resolve => http.server.listen(0, '127.0.0.1', resolve)); cleanups.push(http.close);
  const url = `http://127.0.0.1:${(http.server.address() as { port: number }).port}/mcp`;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const sign = (claims: Record<string, unknown>, tokenAudience = audience, expiration = Math.floor(Date.now() / 1000) + 60) => new SignJWT({ type: 'app', email: 'matejpesl1@gmail.com', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer).setAudience(tokenAudience).setIssuedAt().setExpirationTime(expiration).sign(privateKey);
  const post = (assertion?: string, authorization?: string) => fetch(url, { method: 'POST', headers: { ...headers, ...(assertion ? { 'cf-access-jwt-assertion': assertion } : {}), ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  expect((await post()).status).toBe(401);
  expect((await post(undefined, `Bearer ${'t'.repeat(40)}`)).status).toBe(401);
  expect((await post(await sign({ email: 'someone@example.com' }))).status).toBe(401);
  expect((await post(await sign({}, 'wrong-audience'))).status).toBe(401);
  expect((await post(await sign({}, audience, Math.floor(Date.now() / 1000) - 1))).status).toBe(401);
  const valid = await post(await sign({}));
  expect(valid.status).toBe(200);
  expect((await valid.json()).result.tools.map((tool: { name: string }) => tool.name)).toContain('search_products');
  expect((await fetch(url.replace('/mcp', '/healthz'))).status).toBe(200);
});
