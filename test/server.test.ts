import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../src/server.js';
import { httpServer } from '../src/http.js';
import { Research } from '../src/domain/research.js';
import { Cursors } from '../src/infra/cursor.js';
import { configFromEnv } from '../src/infra/config.js';
import { fail } from '../src/infra/failure.js';
const research = () => new Research(configFromEnv({}), { run: async () => fail('CHALLENGE_UNRESOLVED', 'Challenge recovery exhausted.', { retryable: true }), status: () => ({ account_configured: false }), close: async () => {} }, new Cursors('x'.repeat(64)));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

describe('MCP wire contracts', () => {
  it('advertises only read tools and sends the complete error in text and structured content', async () => {
    const server = createServer(research()), client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b); cleanups.push(() => server.close(), () => client.close());
    const tools = await client.listTools(); expect(tools.tools.map(t => t.name)).toEqual(['search_products', 'get_product', 'get_product_reviews', 'list_categories', 'get_category', 'get_session_status']); expect(tools.tools.every(t => t.annotations?.readOnlyHint)).toBe(true);
    const result = await client.callTool({ name: 'search_products', arguments: { query: 'disk' } });
    expect(result.isError).toBe(true); expect(result.structuredContent).toMatchObject({ status: 'error', error: { code: 'CHALLENGE_UNRESOLVED' } });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual(result.structuredContent);
    expect(await client.callTool({ name: 'get_product', arguments: {} })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
  });
  it('supports real stateless HTTP clients and rejects token, host, origin and body errors', async () => {
    const http = httpServer(research(), { token: 't'.repeat(40), port: 3000 });
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
  });
});
