#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { log } from './infra/logger.js';
import { buildApplication, createServer } from './server.js';
import { configFromEnv } from './infra/config.js';
import { httpServer } from './http.js';
import { importSession } from './session.js';
import { failureOf } from './infra/failure.js';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { http: { type: 'boolean' }, help: { type: 'boolean' }, storage: { type: 'string' }, profile: { type: 'string' }, 'expected-user-id': { type: 'string' } } });
  if (values.help) { process.stdout.write('alza-mcp [--http]\nalza-mcp session import (--storage FILE | --profile CLOSED_CHROMIUM_USER_DATA_DIR) --expected-user-id ID\nConfiguration: ALZA_DATA_DIR, ALZA_AUTH_MODE, ALZA_MCP_TOKEN, ALZA_PUBLIC_URL, ALZA_FLARESOLVERR_URL, ALZA_BYPARR_URL.\n'); return; }
  const config = configFromEnv();
  if (positionals.join(' ') === 'session import') {
    await importSession(config, { storage: values.storage, profile: values.profile, expectedUserId: values['expected-user-id'] ?? '' });
    process.stdout.write('Alza session imported and account identity verified.\n'); return;
  }
  if (positionals.length || values.storage || values.profile || values['expected-user-id']) throw new Error('Invalid arguments. Use --help.');
  const application = await buildApplication(config);
  let closeTransport: () => Promise<void>;
  try {
    if (values.http || process.env.ALZA_TRANSPORT === 'http') {
      const port = Number(process.env.PORT ?? '3000'); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
      const http = httpServer(application.research, { token: process.env.ALZA_MCP_TOKEN ?? '', publicUrl: process.env.ALZA_PUBLIC_URL, port });
      await new Promise<void>((resolve, reject) => { http.server.once('error', reject); http.server.listen(port, '0.0.0.0', resolve); });
      closeTransport = http.close; log.info('http.ready', { port });
    } else {
      const server = createServer(application.research); await server.connect(new StdioServerTransport());
      closeTransport = () => server.close(); log.info('stdio.ready');
      process.stdin.once('end', () => void shutdown());
    }
  } catch (error) { await application.close(); throw error; }
  let closing = false;
  async function shutdown(): Promise<void> {
    if (closing) return; closing = true; log.info('server.stopping');
    try { try { await closeTransport(); } finally { await application.close(); } } catch { process.exitCode = 1; }
  }
  process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
}
main().catch(error => { const failure = failureOf(error); log.error('fatal', { code: failure.code, message: failure.message }); process.exitCode = 1; });
