import { describe, it, expect } from 'vitest';
import { LRUCache } from '../src/lru.js';
import { RequestCoalescer } from '../src/coalesce.js';

describe('LRUCache', () => {
  it('evicts least-recently-used entry', () => {
    const cache = new LRUCache<string, number>({ maxSize: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('tracks hit/miss stats', () => {
    const cache = new LRUCache({ maxSize: 4 });
    cache.set('x', true);
    cache.get('x');
    cache.get('missing');
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, size: 1 });
  });
});

describe('RequestCoalescer', () => {
  it('deduplicates concurrent fetches', async () => {
    const co = new RequestCoalescer<string, number>();
    let calls = 0;
    const fetcher = () => new Promise<number>((r) => {
      calls++;
      setTimeout(() => r(42), 10);
    });
    const [a, b] = await Promise.all([
      co.getOrFetch('k', fetcher),
      co.getOrFetch('k', fetcher),
    ]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(calls).toBe(1);
  });
});
