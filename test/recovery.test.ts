import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessCoordinator } from '../src/infra/access.js';
import { StateStore } from '../src/infra/state.js';
import { configFromEnv } from '../src/infra/config.js';
import { Operation } from '../src/infra/operation.js';
import { FailureError } from '../src/infra/failure.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function setup(challenge = false, onCommand: () => void = () => {}) {
  const commands: Array<Record<string, any>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); commands.push(body);
    onCommand();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body.cmd === 'request.get' ? { status: 'ok', solution: { status: 200, url: body.url, response: challenge ? '<title>Just a moment...</title><form id="challenge-form"></form>' : '<html><pre>{&quot;answer&quot;:42}</pre></html>' } } : { status: 'ok' }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); cleanup.push(() => new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())));
  const dir = await mkdtemp(join(tmpdir(), 'alza-recovery-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config = configFromEnv({ ALZA_DATA_DIR: dir, ALZA_FLARESOLVERR_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, ALZA_BYPARR_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  const access = new AccessCoordinator(config, new StateStore(dir)); cleanup.push(() => access.close());
  vi.spyOn(access.browser, 'reader').mockRejectedValue(new FailureError({ code: 'CHALLENGE_UNRESOLVED', message: 'challenge', retryable: true }));
  return { access, commands };
}
describe('automatic recovery', () => {
  it('releases the primary browser before contacting an external solver', async () => {
    let primaryRunning = true;
    const observed: boolean[] = [];
    const { access } = await setup(false, () => observed.push(primaryRunning));
    vi.spyOn(access.browser, 'close').mockImplementation(async () => { primaryRunning = false; });
    const op = new Operation('anonymous', 10_000);
    try { expect(await access.run(op, r => r.json('https://webapi.alza.cz/api/catalog/example'))).toEqual({ answer: 42 }); }
    finally { op.dispose(); }
    expect(observed).toEqual([false, false, false]);
  });
  it('reads a JSON solver wrapper and destroys the temporary session after success', async () => {
    const { access, commands } = await setup(); const op = new Operation('anonymous', 10_000);
    try { expect(await access.run(op, r => r.json('https://webapi.alza.cz/api/catalog/example'))).toEqual({ answer: 42 }); }
    finally { op.dispose(); }
    expect(commands.map(c => c.cmd)).toEqual(['sessions.create', 'request.get', 'sessions.destroy']);
    expect(op.meta.attempts).toMatchObject([{ provider: 'browser', outcome: 'failed' }, { provider: 'flaresolverr', outcome: 'success' }]);
  });
  it('detects synthetic-200 challenges, tries both solvers, then applies cooldown', async () => {
    const { access, commands } = await setup(true); const op = new Operation('anonymous', 10_000);
    try { await expect(access.run(op, r => r.page('https://www.alza.cz'))).rejects.toMatchObject({ failure: { code: 'CHALLENGE_UNRESOLVED', retry_after_ms: 300_000 } }); } finally { op.dispose(); }
    expect(commands.map(c => c.cmd)).toEqual(['sessions.create', 'request.get', 'sessions.destroy', 'request.get']);
    const count = commands.length, next = new Operation('anonymous', 10_000);
    try { await expect(access.run(next, r => r.page('https://www.alza.cz'))).rejects.toMatchObject({ failure: { code: 'CHALLENGE_UNRESOLVED' } }); } finally { next.dispose(); }
    expect(commands).toHaveLength(count);
  });
  it('fails required auth before any solver can silently return public prices', async () => {
    const { access, commands } = await setup(); const op = new Operation('required', 10_000);
    try { await expect(access.run(op, r => r.page('https://www.alza.cz'))).rejects.toMatchObject({ failure: { code: 'AUTH_NOT_CONFIGURED' } }); } finally { op.dispose(); }
    expect(commands).toHaveLength(0);
  });
});
