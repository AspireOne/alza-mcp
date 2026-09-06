import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "../src/infra/cache.js";

describe("TtlCache", () => {
  it("returns cached values within TTL", () => {
    const c = new TtlCache<string, number>(1000);
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
  });

  it("expires entries past TTL", () => {
    vi.useFakeTimers();
    try {
      const c = new TtlCache<string, number>(100);
      c.set("a", 1);
      vi.advanceTimersByTime(150);
      expect(c.get("a")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("memoizes async loaders", async () => {
    const c = new TtlCache<string, number>(1000);
    let calls = 0;
    const loader = async () => {
      calls++;
      return 42;
    };
    expect(await c.memoize("a", loader)).toBe(42);
    expect(await c.memoize("a", loader)).toBe(42);
    expect(calls).toBe(1);
  });

  it("coalesces concurrent loads for the same key", async () => {
    const c = new TtlCache<string, number>(1000);
    let resolveLoader!: (value: number) => void;
    const loader = vi.fn(
      () => new Promise<number>((resolve) => (resolveLoader = resolve))
    );

    const first = c.memoize("a", loader);
    const second = c.memoize("a", loader);
    resolveLoader(42);

    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
    expect(loader).toHaveBeenCalledOnce();
  });

  it("does not cache failures and permits a later retry", async () => {
    const c = new TtlCache<string, number>(1000);
    const loader = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(42);

    const first = c.memoize("a", loader);
    const coalesced = c.memoize("a", loader);
    await expect(Promise.all([first, coalesced])).rejects.toThrow("temporary");
    await expect(c.memoize("a", loader)).resolves.toBe(42);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(c.get("a")).toBe(42);
  });

  it("does not repopulate a cleared cache from an older in-flight load", async () => {
    const c = new TtlCache<string, number>(1000);
    let resolveOld!: (value: number) => void;
    const oldLoad = c.memoize(
      "a",
      () => new Promise<number>((resolve) => (resolveOld = resolve))
    );

    c.clear();
    const freshLoad = c.memoize("a", async () => 2);
    resolveOld(1);

    await expect(oldLoad).resolves.toBe(1);
    await expect(freshLoad).resolves.toBe(2);
    expect(c.get("a")).toBe(2);
  });

  it("evicts oldest when over maxSize", () => {
    const c = new TtlCache<string, number>(60_000, 2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(3);
  });
});
