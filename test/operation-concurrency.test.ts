import { afterEach, describe, expect, it, vi } from 'vitest';
import { configFromEnv } from '../src/infra/config.js';
import { Operation, OperationQueue } from '../src/infra/operation.js';

const operations: Operation[] = [];
const operation = (timeout = 10_000, parent?: AbortSignal) => {
  const op = new Operation('required', timeout, parent);
  operations.push(op);
  return op;
};
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
afterEach(() => { operations.splice(0).forEach(op => op.dispose()); vi.useRealTimers(); });

describe('bounded parallel admission', () => {
  it('honors cancellation even when the shared wait is already resolved', async () => {
    const parent = new AbortController(), op = operation(10_000, parent.signal);
    parent.abort();
    await expect(op.waitFor(Promise.resolve('done'))).rejects.toMatchObject({ failure: { code: 'CANCELLED' } });
  });

  it('honors an expired primary budget even when the shared wait is already resolved', async () => {
    const op = operation();
    await expect(op.waitFor(Promise.resolve('done'), Date.now() - 1)).rejects.toMatchObject({ failure: { code: 'TIMEOUT' } });
  });
  it('bounds a shared cleanup wait without cancelling the underlying cleanup', async () => {
    vi.useFakeTimers();
    const cleanup = gate(), op = operation(10_000);
    let completed = false;
    const work = cleanup.promise.then(() => { completed = true; });
    const pending = op.waitFor(work, Date.now() + 100);
    const rejected = expect(pending).rejects.toMatchObject({ failure: { code: 'TIMEOUT' } });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(completed).toBe(false);
    cleanup.release(); await work;
    expect(completed).toBe(true);
  });
  it('runs two operations immediately and hands their slots to FIFO waiters without oversubscribing', async () => {
    const queue = new OperationQueue(2);
    const gates = Array.from({ length: 5 }, gate);
    const admitted = Array.from({ length: 5 }, gate);
    const started: number[] = [];
    const run = (id: number) => queue.run(operation(), async () => { started.push(id); admitted[id]!.release(); await gates[id]!.promise; });
    const first = run(0), second = run(1), third = run(2), fourth = run(3);
    expect(started).toEqual([0, 1]);
    expect(queue.active).toBe(2);
    expect(queue.size).toBe(4);

    gates[0]!.release();
    await first;
    const fifth = run(4);
    expect(queue.active).toBe(2);
    await admitted[2]!.promise;
    expect(started).toEqual([0, 1, 2]);
    gates[1]!.release(); await second;
    await admitted[3]!.promise;
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2]!.release(); await third;
    await admitted[4]!.promise;
    expect(started).toEqual([0, 1, 2, 3, 4]);
    gates[3]!.release(); gates[4]!.release();
    await Promise.all([fourth, fifth]);
    expect(queue.active).toBe(0);
    expect(queue.size).toBe(0);
  });

  it('releases a failing active operation exactly once and admits its next waiter', async () => {
    const queue = new OperationQueue(2), finish = gate(), fail = gate();
    const first = queue.run(operation(), () => finish.promise);
    const second = queue.run(operation(), async () => { await fail.promise; throw new Error('upstream failure'); });
    const rejected = expect(second).rejects.toThrow('upstream failure');
    const third = queue.run(operation(), async () => 'completed');
    fail.release(); await rejected;
    await expect(third).resolves.toBe('completed');
    expect(queue.active).toBe(1);
    finish.release(); await first;
    expect(queue.size).toBe(0);
  });

  it('keeps a cancelled active slot occupied until its work settles', async () => {
    const queue = new OperationQueue(2), parent = new AbortController(), finish = gate(), cancelledWork = gate();
    const op = operation(10_000, parent.signal);
    const first = queue.run(operation(), () => finish.promise);
    const second = queue.run(op, async () => { await cancelledWork.promise; op.check(); });
    const rejected = expect(second).rejects.toMatchObject({ failure: { code: 'CANCELLED' } });
    let thirdStarted = false;
    const third = queue.run(operation(), async () => { thirdStarted = true; });
    parent.abort();
    expect(queue.active).toBe(2);
    expect(thirdStarted).toBe(false);
    cancelledWork.release(); await rejected; await third;
    expect(thirdStarted).toBe(true);
    expect(queue.active).toBe(1);
    finish.release(); await first;
    expect(queue.size).toBe(0);
  });

  it('removes a cancelled waiter without releasing either active slot or reordering other waiters', async () => {
    const queue = new OperationQueue(2), finish = gate(), parent = new AbortController();
    const first = queue.run(operation(), () => finish.promise);
    const second = queue.run(operation(), () => finish.promise);
    const cancelled = queue.run(operation(10_000, parent.signal), async () => 'must not run');
    const rejected = expect(cancelled).rejects.toMatchObject({ failure: { code: 'CANCELLED' } });
    const started: number[] = [];
    const next = queue.run(operation(), async () => { started.push(1); });
    parent.abort(); await rejected;
    expect(queue.active).toBe(2);
    expect(queue.size).toBe(3);
    expect(started).toEqual([]);
    finish.release(); await Promise.all([first, second, next]);
    expect(started).toEqual([1]);
    expect(queue.size).toBe(0);
  });

  it('allows eight waiters at concurrency two and includes waiting in each operation deadline', async () => {
    vi.useFakeTimers();
    const queue = new OperationQueue(2), finish = gate();
    const active = [queue.run(operation(), () => finish.promise), queue.run(operation(), () => finish.promise)];
    const work = vi.fn(async () => 'must not run');
    const waiting = Array.from({ length: 8 }, () => queue.run(operation(100), work));
    const expired = waiting.map(promise => expect(promise).rejects.toMatchObject({ failure: { code: 'TIMEOUT' } }));
    expect(queue.size).toBe(10);
    await expect(queue.run(operation(), work)).rejects.toMatchObject({ failure: { code: 'BUSY' } });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(expired);
    expect(work).not.toHaveBeenCalled();
    expect(queue.active).toBe(2);
    expect(queue.size).toBe(2);
    finish.release(); await Promise.all(active);
    expect(queue.size).toBe(0);
  });

  it('expires a queued primary budget before its longer operation deadline without freeing the active slot', async () => {
    vi.useFakeTimers();
    const queue = new OperationQueue(1), finish = gate();
    const first = queue.run(operation(), () => finish.promise);
    const op = operation(1000), work = vi.fn(async () => 'must not run');
    const waiting = queue.run(op, work, Date.now() + 100);
    const expired = expect(waiting).rejects.toMatchObject({ failure: { code: 'TIMEOUT' } });
    await vi.advanceTimersByTimeAsync(100); await expired;
    expect(op.signal.aborted).toBe(false);
    expect(work).not.toHaveBeenCalled();
    expect(queue.active).toBe(1);
    expect(queue.size).toBe(1);
    const next = queue.run(operation(), async () => 'completed');
    finish.release(); await first;
    await expect(next).resolves.toBe('completed');
    expect(queue.size).toBe(0);
  });

  it('preserves the original operation deadline after admission from the queue', async () => {
    vi.useFakeTimers();
    const queue = new OperationQueue(1), finish = gate();
    const first = queue.run(operation(), () => finish.promise);
    const op = operation(1000);
    const second = queue.run(op, async () => op.remaining());
    await vi.advanceTimersByTimeAsync(750);
    finish.release(); await first;
    await expect(second).resolves.toBe(250);
    expect(queue.size).toBe(0);
  });
});

describe('browser concurrency configuration', () => {
  it('defaults to two operations and supports a serial rollback', () => {
    expect(configFromEnv({}).browserConcurrency).toBe(2);
    expect(configFromEnv({ ALZA_BROWSER_CONCURRENCY: '1' }).browserConcurrency).toBe(1);
    expect(configFromEnv({ ALZA_BROWSER_CONCURRENCY: '2' }).browserConcurrency).toBe(2);
    expect(new OperationQueue().concurrency).toBe(1);
  });
  it.each(['', '0', '3', '-1', '1.5', '2.0', ' 2', 'true'])('rejects unsupported concurrency %j', value => {
    expect(() => configFromEnv({ ALZA_BROWSER_CONCURRENCY: value })).toThrow('must be 1 or 2');
  });
});
