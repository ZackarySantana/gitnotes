/** Minimal LRU cache scaffold for demo. */
export interface LRUOptions {
  maxSize: number;
}

export class LRUCache<K, V> {
  private readonly maxSize: number;
  private store = new Map<K, V>();

  constructor(opts: LRUOptions) {
    this.maxSize = Math.max(1, opts.maxSize);
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    return this.store.get(key);
  }

  set(key: K, value: V): void {
    this.store.set(key, value);
  }

  clear(): void {
    this.store.clear();
  }
}
