/** Coalesce concurrent requests for the same cache key. */
type InFlight<T> = Promise<T>;

export class RequestCoalescer<K, V> {
  private inFlight = new Map<K, InFlight<V>>();

  async getOrFetch(key: K, fetcher: () => Promise<V>): Promise<V> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    let promise: InFlight<V>;
    try {
      promise = Promise.resolve(fetcher());
    } catch (err) {
      throw err;
    }
    const tracked = promise.finally(() => {
      if (this.inFlight.get(key) === tracked) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, tracked);
    return tracked;
  }

  pendingCount(): number {
    return this.inFlight.size;
  }

  clear(): void {
    this.inFlight.clear();
  }
}
