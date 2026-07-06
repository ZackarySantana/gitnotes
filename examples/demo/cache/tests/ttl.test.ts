import { describe, it, expect, vi, afterEach } from 'vitest';
import { TTLCache } from '../src/ttl.js';

describe('TTLCache', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('expires entries lazily on get', () => {
    vi.useFakeTimers();
    const ttl = new TTLCache<string, number>(1000);
    ttl.set('a', 1);
    vi.advanceTimersByTime(1500);
    expect(ttl.get('a')).toBeUndefined();
  });

  it('prune removes all stale keys', () => {
    vi.useFakeTimers();
    const ttl = new TTLCache<string, number>(500);
    ttl.set('x', 1);
    ttl.set('y', 2);
    vi.advanceTimersByTime(600);
    expect(ttl.prune()).toBe(2);
  });
});
