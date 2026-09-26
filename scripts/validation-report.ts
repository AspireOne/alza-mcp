import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

export const SEVEN_DAYS_MS = 604_800_000;
type Check = { at: string; ok: boolean; code?: string };

export async function readChecks(report: string, start: number): Promise<Check[]> {
  let text: string;
  try { text = await readFile(report, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return text.split('\n').filter(line => line.trim()).map(line => {
    const check = JSON.parse(line) as Check;
    if (typeof check.at !== 'string' || !Number.isFinite(Date.parse(check.at)) || typeof check.ok !== 'boolean') throw new Error('Invalid validation record.');
    return check;
  }).filter(check => Date.parse(check.at) >= start);
}

export function summarize(checks: Check[], start: number, end: number, aborted = false) {
  const completed = checks.filter(check => Date.parse(check.at) <= end);
  const successes = completed.filter(check => check.ok).length;
  const rate = completed.length ? successes / completed.length : 0;
  const accepted = !aborted && end - start >= SEVEN_DAYS_MS && completed.length >= 200 && rate >= 0.99;
  const errors: Record<string, number> = {};
  for (const check of completed.filter(check => !check.ok)) {
    const code = check.code && /^[A-Z0-9_,]+$/.test(check.code) ? check.code : 'CHECK_FAILED';
    errors[code] = (errors[code] ?? 0) + 1;
  }
  return { started_at: new Date(start).toISOString(), finished_at: new Date(end).toISOString(), status: aborted ? 'aborted' : accepted ? 'passed' : 'failed', calls: completed.length, successes, failures: completed.length - successes, success_rate: rate, seven_day_acceptance: accepted, errors };
}

type Summary = ReturnType<typeof summarize>;
export function discordPayload(summary: Summary, report: string) {
  const errors = Object.entries(summary.errors).slice(0, 8).map(([code, count]) => `${code}: ${count}`).join(', ');
  return {
    username: 'Alza MCP checks',
    allowed_mentions: { parse: [] },
    content: [
      `**Alza MCP reliability test: ${summary.status.toUpperCase()}**`,
      `${summary.successes}/${summary.calls} checks succeeded (${(summary.success_rate * 100).toFixed(2)}%). Failures: ${summary.failures}.`,
      `Finished: <t:${Math.floor(Date.parse(summary.finished_at) / 1000)}:f>.`,
      errors ? `Errors: ${errors}.` : '',
      summary.status === 'aborted' ? 'The trial did not complete normally; seven-day acceptance was not achieved.' : 'Acceptance requires seven days, at least 200 checks, and at least 99% success.',
      `Report on pi5: \`${report.slice(0, 512)}\`. You can ask the assistant to review it.`,
    ].filter(Boolean).join('\n'),
  };
}

export async function sendDiscord(webhook: string, payload: ReturnType<typeof discordPayload>): Promise<string> {
  let url: URL;
  try { url = new URL(webhook); } catch { throw new Error('Invalid Discord webhook URL.'); }
  if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(url.hostname) || !/^\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.username || url.password) throw new Error('Invalid Discord webhook URL.');
  url.searchParams.set('wait', 'true');
  for (let attempt = 0; attempt < 5; attempt++) {
    let retryAfter = 1000 * 2 ** attempt;
    let permanent = false;
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (response.ok) {
        const message = await response.json() as { id?: string };
        if (typeof message.id !== 'string' || !message.id) throw new Error('Missing delivery receipt.');
        return message.id;
      }
      permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
      if (response.status === 429) {
        const body = await response.json() as { retry_after?: number };
        if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)) { permanent = body.retry_after > 60; retryAfter = Math.max(retryAfter, body.retry_after * 1000); }
      }
    } catch { /* Never expose the credential-bearing URL or response body. */ }
    if (permanent || attempt === 4) break;
    console.warn('Discord result delivery failed; retrying.');
    await setTimeout(retryAfter);
  }
  throw new Error('Discord result delivery failed; the result remains in the summary file.');
}

export async function finishTrial(report: string, start: number, aborted: boolean, webhook?: string) {
  let checks: Check[] = [];
  try { checks = await readChecks(report, start); }
  catch { aborted = true; console.error('Validation report could not be read.'); }
  const summary = summarize(checks, start, Date.now(), aborted);
  const notification: { status: string; message_id?: string } = { status: webhook ? 'pending' : 'disabled' };
  const save = () => writeFile(`${report}.summary.json`, JSON.stringify({ ...summary, notification }, null, 2) + '\n', { mode: 0o600 });
  await save();
  if (webhook) {
    try { notification.message_id = await sendDiscord(webhook, discordPayload(summary, report)); notification.status = 'sent'; }
    catch { notification.status = 'failed'; console.error('Discord result delivery failed; inspect the saved summary.'); }
    await save();
  }
  console.log(JSON.stringify({ ...summary, notification }));
  return summary.seven_day_acceptance && notification.status !== 'failed';
}
