import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discordPayload, finishTrial, readChecks, SEVEN_DAYS_MS, sendDiscord, summarize } from '../scripts/validation-report.js';

const start = Date.parse('2026-09-26T16:09:44Z');
const webhook = 'https://discord.com/api/webhooks/123/secret-token';
const checks = (count: number, failures = 0) => Array.from({ length: count }, (_, index) => ({ at: new Date(start + index * 1000).toISOString(), ok: index >= failures, ...(index < failures ? { code: 'CHALLENGE_UNRESOLVED' } : {}) }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('requires the full duration, sample size and success rate, including retained failures', () => {
  expect(summarize(checks(200, 2), start, start + SEVEN_DAYS_MS)).toMatchObject({ status: 'passed', failures: 2, success_rate: 0.99, errors: { CHALLENGE_UNRESOLVED: 2 } });
  expect(summarize(checks(200, 3), start, start + SEVEN_DAYS_MS).status).toBe('failed');
  expect(summarize(checks(199), start, start + SEVEN_DAYS_MS).status).toBe('failed');
  expect(summarize(checks(200), start, start + SEVEN_DAYS_MS - 1).status).toBe('failed');
  expect(summarize(checks(200), start, start + SEVEN_DAYS_MS, true).status).toBe('aborted');
  expect(summarize([], start, start + SEVEN_DAYS_MS).status).toBe('failed');
});

it('retains current-run records when resuming and excludes an older trial', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alza-validation-'));
  try {
    const report = join(dir, 'soak.jsonl');
    await writeFile(report, [{ at: new Date(start - 1).toISOString(), ok: true }, ...checks(3, 1)].map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(await readChecks(report, start)).toEqual(checks(3, 1));
    await writeFile(report, '{truncated\n', { flag: 'a' });
    await expect(readChecks(report, start)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('waits for a Discord message receipt and disables mentions', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: '456' }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const payload = discordPayload(summarize(checks(200, 2), start, start + SEVEN_DAYS_MS), '/data/alza-mcp-verification/soak.jsonl');
  await expect(sendDiscord(webhook, payload)).resolves.toBe('456');
  const [url, init] = fetch.mock.calls[0]!;
  expect(url.searchParams.get('wait')).toBe('true');
  expect(JSON.parse(init.body)).toMatchObject({ allowed_mentions: { parse: [] }, content: expect.stringContaining('198/200') });
  expect(payload.content).toContain('CHALLENGE_UNRESOLVED: 2');
});

it('retries a temporary Discord failure and requires successful acknowledgement', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ id: '456' })));
  vi.stubGlobal('fetch', fetch);
  const sent = sendDiscord(webhook, discordPayload(summarize([], start, start), 'report'));
  await vi.advanceTimersByTimeAsync(1000);
  await expect(sent).resolves.toBe('456');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('preserves the result and records delivery failure without exposing the webhook', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alza-validation-'));
  try {
    const report = join(dir, 'soak.jsonl');
    await writeFile(report, checks(200).map(r => JSON.stringify(r)).join('\n'));
    vi.useFakeTimers(); vi.setSystemTime(start + SEVEN_DAYS_MS);
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 })); vi.stubGlobal('fetch', fetch);
    expect(await finishTrial(report, start, false, webhook)).toBe(false);
    const text = await readFile(`${report}.summary.json`, 'utf8');
    expect(JSON.parse(text)).toMatchObject({ status: 'passed', notification: { status: 'failed' } });
    expect(text).not.toContain('secret-token');
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
