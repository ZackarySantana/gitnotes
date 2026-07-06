/** LRU cache with O(1) get/set via Map insertion order. */
import type { CacheStats } from './types.js';

export interface LRUOptions {
  maxSize: number;
  onEvict?: (key: string, value: unknown) => void;
}

export class LRUCache<K, V> {
  private readonly maxSize: number;
  private readonly onEvict?: LRUOptions['onEvict'];
  private store = new Map<K, V>();
  private hits = 0;
  private misses = 0;

  constructor(opts: LRUOptions) {
    this.maxSize = Math.max(1, opts.maxSize);
    this.onEvict = opts.onEvict;
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.touch(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.touch(key, value);
      return;
    }
    if (this.store.size >= this.maxSize) {
      this.evictOldest();
    }
    this.store.set(key, value);
  }

  private touch(key: K, value: V): void {
    this.store.delete(key);
    this.store.set(key, value);
  }

  private evictOldest(): void {
    const oldest = this.store.keys().next().value;
    if (oldest === undefined) return;
    const evicted = this.store.get(oldest);
    this.store.delete(oldest);
    this.onEvict?.(String(oldest), evicted);
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, size: this.store.size };
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
