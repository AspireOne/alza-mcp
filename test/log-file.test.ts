import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { LogFile } from '../src/infra/log-file.js';
import { log, startFileLogging, closeFileLogging, withLogContext } from '../src/infra/logger.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await closeFileLogging();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'alza-log-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

it('keeps the same filtered JSON records on stderr and disk and appends across restarts', async () => {
  const dir = await directory(), stderr: string[] = [];
  vi.stubEnv('ALZA_LOG_LEVEL', 'info'); vi.stubEnv('ALZA_DEBUG', 'false');
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr.push(String(chunk)); return true; });
  const stdout = vi.spyOn(process.stdout, 'write');
  await startFileLogging(dir);
  withLogContext({ request_id: 'example' }, () => {
    log.info('request.completed', { outcome: 'ok' });
    log.debug('filtered');
  });
  await closeFileLogging();
  const first = await readFile(join(dir, 'logs/alza.jsonl'), 'utf8');
  expect(first).toBe(stderr.join(''));
  expect(first).not.toContain('filtered');
  expect(first).toContain('"request_id":"example"');
  await startFileLogging(dir);
  log.warn('after.restart');
  await closeFileLogging();
  expect(await readFile(join(dir, 'logs/alza.jsonl'), 'utf8')).toBe(stderr.join(''));
  expect(await readFile(join(dir, 'logs/alza.jsonl'), 'utf8')).toContain(first);
  expect((await stat(join(dir, 'logs/alza.jsonl'))).mode & 0o777).toBe(0o600);
  expect(stdout).not.toHaveBeenCalled();
});

it('rotates whole UTF-8 records within the byte limit and retains only the newest five files', async () => {
  const dir = await directory(), report = vi.fn();
  const first = await LogFile.open(dir, report, 32);
  // Each record is 17 UTF-8 bytes; only one record fits in a 32-byte file.
  const line = (i: number) => JSON.stringify({ i, s: 'č' }) + '\n';
  expect(Buffer.byteLength(line(0))).toBe(17);
  first.write(line(0));
  await first.close();
  const second = await LogFile.open(dir, report, 32);
  for (let i = 1; i <= 6; i++) second.write(line(i));
  await second.close();
  expect((await readdir(dir)).sort()).toEqual(['alza.1.jsonl', 'alza.2.jsonl', 'alza.3.jsonl', 'alza.4.jsonl', 'alza.jsonl']);
  const history = [];
  for (const file of ['alza.4.jsonl', 'alza.3.jsonl', 'alza.2.jsonl', 'alza.1.jsonl', 'alza.jsonl']) {
    expect((await stat(join(dir, file))).size).toBeLessThanOrEqual(32);
    history.push(JSON.parse(await readFile(join(dir, file), 'utf8')).i);
  }
  expect(history).toEqual([2, 3, 4, 5, 6]);
  expect(report).not.toHaveBeenCalled();
});

it('bounds queued memory and reports dropped file records on overflow', async () => {
  const dir = await directory(), report = vi.fn();
  const sink = await LogFile.open(dir, report, 100, 20);
  sink.write('12345678901234567890');
  sink.write('dropped');
  sink.write('also dropped');
  expect(report.mock.calls).toMatchObject([['logging.file_overflow', { queue_bytes: 20 }]]);
  await sink.close();
  expect(await readFile(join(dir, 'alza.jsonl'), 'utf8')).toBe('12345678901234567890');
});

it('reports rotation failures without unhandled rejections or deleting the current history', async () => {
  const dir = await directory(), report = vi.fn();
  const sink = await LogFile.open(dir, report, 10);
  // A directory at the oldest archive path forces a real filesystem failure during rotation.
  await mkdir(join(dir, 'alza.4.jsonl'));
  sink.write('first\n');
  sink.write('second\n');
  sink.write('third\n');
  await expect(sink.close()).resolves.toBeUndefined();
  expect(report.mock.calls).toMatchObject([['logging.file_failed', { system_code: expect.any(String) }]]);
  expect(await readFile(join(dir, 'alza.jsonl'), 'utf8')).toBe('first\n');
});

it('refuses to start persistent logging when its destination cannot be opened', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'logs'), 'not a directory');
  await expect(startFileLogging(dir)).rejects.toMatchObject({ failure: { code: 'LOG_STORAGE_ERROR' } });
});

it('persists startup and shutdown logs when the actual CLI restarts on the same volume', async () => {
  const dir = await directory();
  async function run() {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      env: { ...process.env, ALZA_DATA_DIR: dir, ALZA_TRANSPORT: 'stdio', ALZA_LOG_LEVEL: 'info', ALZA_DEBUG: 'false' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
    let output = '';
    child.stderr.setEncoding('utf8');
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('CLI exited before ready')));
      child.stderr.on('data', chunk => { output += chunk; if (output.includes('"msg":"stdio.ready"')) resolve(); });
    });
    child.kill('SIGTERM');
    expect(await exited).toEqual([0, null]);
  }
  await run();
  await run();
  const records = (await readFile(join(dir, 'logs/alza.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(records.filter(r => r.msg === 'stdio.ready')).toHaveLength(2);
  expect(records.filter(r => r.msg === 'server.stopping')).toHaveLength(2);
});
