export interface CacheEntry<V> {
  key: string;
  value: V;
  accessedAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}
