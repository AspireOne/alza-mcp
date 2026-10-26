import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Research } from '../src/domain/research.js';
import { browserCatalog } from '../src/domain/browser-catalog.js';
import type { Access, Reader } from '../src/infra/reader.js';
import { configFromEnv } from '../src/infra/config.js';
import { Cursors } from '../src/infra/cursor.js';
import { Operation } from '../src/infra/operation.js';
import { withLogContext } from '../src/infra/logger.js';
import { sampleMemory, startMemoryMonitor } from '../src/infra/memory.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function capture() {
  vi.stubEnv('ALZA_LOG_LEVEL', 'info'); vi.stubEnv('ALZA_DEBUG', 'false');
  const records: Array<Record<string, any>> = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { records.push(JSON.parse(String(chunk))); return true; });
  return records;
}

it('logs one correlated terminal outcome for success, partial results, and invalid input without payloads', async () => {
  const records = capture();
  const reader: Reader = {
    provider: 'browser', canPost: true, context: 'anonymous',
    page: async url => ({ url, status: 200, headers: {}, html: '<script>var _pageData={"isUserLogged":false,"categoryId":18845887,"configurationId":3,"data":{"categoryTypeId":1,"searchTerm":"private-search"}};</script><a data-sort="0"></a>' }),
    json: async () => ({ d: { Count: 2, Page: 1, Boxes: '<div class="browsingitem" data-id="1"><a class="name" href="/disk-d1.htm">Disk</a><div class="price"><span class="js-price-box__primary-price__value">100,-</span></div></div>', PagerBottom: '' } }),
  };
  const access: Access = { run: async (op, work) => { op.meta.auth.state = 'anonymous'; return work(reader); }, status: () => ({}), close: async () => {} };
  const research = new Research(configFromEnv({}), access, browserCatalog, new Cursors('x'.repeat(64)));
  const results = await withLogContext({ http_request_id: 'transport-1' }, async () => [
    await research.call('get_session_status', {}),
    await research.call('search_products', { query: 'private-search' }),
    await research.call('get_product', { cursor: 'secret-cursor' }),
  ]);
  expect(results.map(r => r.status)).toEqual(['ok', 'partial', 'error']);
  const completed = records.filter(r => r.msg === 'request.completed');
  expect(completed).toHaveLength(3);
  for (const [index, result] of results.entries()) {
    const terminal = completed[index]!;
    expect(terminal).toMatchObject({ request_id: result.meta.request_id, http_request_id: 'transport-1', outcome: result.status, duration_ms: expect.any(Number), memory: { process_rss_bytes: expect.any(Number) } });
    expect(terminal.duration_ms).toBeGreaterThanOrEqual(0);
    expect(records.filter(r => r.msg === 'request.started' && r.request_id === result.meta.request_id)).toHaveLength(1);
  }
  expect(completed[1]!.error_codes).toContain('INCOMPLETE_RESULTS');
  expect(completed[2]!.error_codes).toEqual(['INVALID_INPUT']);
  expect(JSON.stringify(records)).not.toContain('private-search');
  expect(JSON.stringify(records)).not.toContain('secret-cursor');
});

it('times failed steps, preserves the failure, and excludes raw browser exception messages', async () => {
  const records = capture(), op = new Operation('anonymous', 10_000);
  const error = new Error('browser exception contains secret-token');
  try {
    await expect(op.step('browser.page', { provider: 'browser' }, async () => { throw error; })).rejects.toBe(error);
  } finally { op.dispose(); }
  expect(records).toMatchObject([
    { msg: 'step.started', request_id: op.id, step: 'browser.page' },
    { msg: 'step.completed', request_id: op.id, step: 'browser.page', outcome: 'error', code: 'INTERNAL_ERROR', duration_ms: expect.any(Number) },
  ]);
  expect(records[0]!.step_id).toBe(records[1]!.step_id);
  expect(JSON.stringify(records)).not.toContain('secret-token');
});

it('reports Linux available RAM, swap counters, container usage and OOM events in explicit units', async () => {
  const files: Record<string, string> = {
    '/proc/meminfo': 'MemAvailable: 1024 kB\nSwapTotal: 2048 kB\nSwapFree: 512 kB\n',
    '/proc/vmstat': 'pswpin 12\npswpout 34\n',
    '/proc/pressure/memory': 'some avg10=2.50 avg60=1.00 avg300=0.25 total=1234\n',
    '/sys/fs/cgroup/memory.current': '104857600\n', '/sys/fs/cgroup/memory.max': '209715200\n',
    '/sys/fs/cgroup/memory.swap.current': '4096\n',
    '/sys/fs/cgroup/memory.events': 'high 5\nmax 3\noom 2\noom_kill 1\n',
  };
  vi.mocked(readFile).mockImplementation(async path => {
    if (!(String(path) in files)) throw new Error('missing');
    return files[String(path)]!;
  });
  expect(await sampleMemory()).toMatchObject({
    system_available_bytes: 1048576, system_swap_total_bytes: 2097152, system_swap_free_bytes: 524288,
    swap_in_pages_total: 12, swap_out_pages_total: 34, cgroup_current_bytes: 104857600,
    cgroup_limit_bytes: 209715200, cgroup_swap_bytes: 4096, cgroup_high_total: 5, cgroup_max_total: 3,
    cgroup_oom_total: 2, cgroup_oom_kill_total: 1,
  });
  files['/sys/fs/cgroup/memory.max'] = 'max\n';
  delete files['/proc/meminfo'];
  expect(await sampleMemory()).toMatchObject({ system_available_bytes: null, cgroup_limit_bytes: null });
});

it('samples memory while idle and stops cleanly without blocking shutdown', async () => {
  const records = capture();
  vi.mocked(readFile).mockRejectedValue(new Error('unsupported platform'));
  vi.useFakeTimers();
  const stop = startMemoryMonitor();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(records.filter(r => r.msg === 'memory.sample')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(records.filter(r => r.msg === 'memory.sample')).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(records.filter(r => r.msg === 'memory.sample')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally { stop(); }
});
