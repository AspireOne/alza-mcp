import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import type { Research } from "./domain/research.js";
import { log } from "./infra/logger.js";

const MAX_BODY = 1_048_576;
export interface HttpOptions { token: string; publicUrl?: string; port?: number; host?: string }
export function httpServer(research: Research, options: HttpOptions) {
  if (options.token.length < 32) throw new Error("ALZA_MCP_TOKEN must contain at least 32 characters.");
  const expected = createHash('sha256').update(`Bearer ${options.token}`).digest();
  const origins = new Set([`http://localhost:${options.port ?? 3000}`, `http://127.0.0.1:${options.port ?? 3000}`]);
  if (options.publicUrl) { const u = new URL(options.publicUrl); if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('ALZA_PUBLIC_URL must be an HTTPS origin.'); origins.add(u.origin); }
  const hosts = new Set([...origins].map(o => new URL(o).host));
  const active = new Set<Promise<void>>();
  const cancellations = new Map<string | number, AbortController>();
  const server = createHttpServer((req, res) => {
    const work = handle(req, res).catch(error => { log.error('http.request_failed', { name: error instanceof Error ? error.name : 'unknown' }); if (!res.headersSent) reply(res, 500, 'Internal server error'); else res.end(); }).finally(() => active.delete(work));
    active.add(work);
  });
  server.on('listening', () => {
    const address = server.address();
    if (address && typeof address === 'object') for (const host of ['localhost', '127.0.0.1']) {
      hosts.add(`${host}:${address.port}`); origins.add(`http://${host}:${address.port}`);
    }
  });
  server.requestTimeout = 95_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.headers.host || !hosts.has(req.headers.host)) { reply(res, 421, 'Host not allowed'); return; }
    if (req.headers.origin && !origins.has(req.headers.origin)) { reply(res, 403, 'Origin not allowed'); return; }
    // Health is intentionally local and does not navigate the browser or expose account state.
    if (req.url === '/healthz' && req.method === 'GET') { reply(res, 200, 'ok'); return; }
    const actual = createHash('sha256').update(req.headers.authorization ?? '').digest();
    if (!timingSafeEqual(actual, expected)) { res.setHeader('WWW-Authenticate', 'Bearer'); reply(res, 401, 'Unauthorized'); return; }
    if (req.url !== '/mcp') { reply(res, 404, 'Not found'); return; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reply(res, 405, 'Stateless MCP accepts POST only'); return; }
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) { reply(res, 415, 'Expected application/json'); return; }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { reply(res, 413, 'Request body too large'); return; }
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { reply(res, 413, 'Request body too large'); return; } chunks.push(chunk); }
    let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(res, 400, 'Invalid JSON'); return; }
    if (Array.isArray(body)) { reply(res, 400, 'JSON-RPC batches are not supported'); return; }
    const message = body as { id?: string | number; method?: string; params?: { requestId?: string | number } } | null;
    if (message?.method === 'notifications/cancelled') {
      const id = message.params?.requestId;
      if (id !== undefined) cancellations.get(id)?.abort();
      reply(res, 202, 'Accepted'); return;
    }
    const id = message?.id, controller = new AbortController();
    if (id !== undefined) {
      if (cancellations.has(id)) { reply(res, 409, 'Request ID is already active'); return; }
      cancellations.set(id, controller);
    }
    const mcp = createServer(research, controller.signal), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try { await mcp.connect(transport); await transport.handleRequest(req, res, body); }
    finally { if (id !== undefined) cancellations.delete(id); await mcp.close(); }
  }
  return { server, close: async () => { const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await Promise.allSettled([...active]); await closed; } };
}
function reply(res: ServerResponse, status: number, message: string): void { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(message); }
