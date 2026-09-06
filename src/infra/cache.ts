interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<K, V> {
  private readonly store = new Map<K, Entry<V>>();
  private readonly inFlight = new Map<K, Promise<V>>();
  private generation = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxSize = 500
  ) {}

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  async memoize(key: K, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const loading = this.inFlight.get(key);
    if (loading) return loading;

    const generation = this.generation;
    const promise = loader()
      .then((value) => {
        if (this.generation === generation) this.set(key, value);
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.generation++;
    this.store.clear();
    this.inFlight.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
