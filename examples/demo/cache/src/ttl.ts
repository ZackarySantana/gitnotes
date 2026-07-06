/** TTL wrapper — entries expire after ms milliseconds. */
export interface TTLRecord<V> {
  value: V;
  expiresAt: number;
}

export class TTLCache<K, V> {
  private store = new Map<K, TTLRecord<V>>();

  constructor(private defaultTtlMs: number) {
    if (defaultTtlMs <= 0) throw new RangeError('TTL must be positive');
  }

  set(key: K, value: V, ttlMs = this.defaultTtlMs): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  get(key: K): V | undefined {
    const rec = this.store.get(key);
    if (!rec) return undefined;
    if (Date.now() > rec.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return rec.value;
  }

  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, rec] of this.store) {
      if (now > rec.expiresAt) {
        this.store.delete(k);
        removed++;
      }
    }
    return removed;
  }
}
